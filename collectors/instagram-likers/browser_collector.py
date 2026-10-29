"""Read-only Instagram liker collector using a manually authenticated browser UI.

This proof of concept never automates credential entry or actions that change an
Instagram account. It prefers the Google Chrome already installed on the system
and always drives it through a dedicated persistent profile that is local-only
and ignored by Git; the personal Chrome profile is never opened or read.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse
from uuid import uuid4

from playwright.sync_api import (
    BrowserContext,
    ElementHandle,
    Error as PlaywrightError,
    Locator,
    Page,
    Playwright,
    TimeoutError,
    sync_playwright,
)


MAX_LIKERS = 20
BASE_DIR = Path(__file__).resolve().parent
PROFILE_DIR = BASE_DIR / "browser-profile"
OUTPUT_DIR = BASE_DIR / "output"
JSON_PATH = OUTPUT_DIR / "likers.json"
CSV_PATH = OUTPUT_DIR / "likers.csv"
DIAGNOSTICS_DIR = OUTPUT_DIR / "diagnostics"
SCREENSHOT_PATH = DIAGNOSTICS_DIR / "post.png"
FULL_SCREENSHOT_PATH = DIAGNOSTICS_DIR / "post-full.png"
CANDIDATES_PATH = DIAGNOSTICS_DIR / "candidates.json"
PAGE_SUMMARY_PATH = DIAGNOSTICS_DIR / "page_summary.json"
LIKE_TEXT_NODES_PATH = DIAGNOSTICS_DIR / "like_text_nodes.json"
ACTION_BAR_CANDIDATES_PATH = DIAGNOSTICS_DIR / "action_bar_candidates.json"
ENGAGEMENT_TEXT_PATH = DIAGNOSTICS_DIR / "engagement_text.txt"
TRIGGER_SELECTION_PATH = DIAGNOSTICS_DIR / "liker_trigger_selection.json"
AFTER_LIKER_CLICK_SCREENSHOT_PATH = DIAGNOSTICS_DIR / "after_liker_click.png"
AFTER_LIKER_CLICK_PATH = DIAGNOSTICS_DIR / "after_liker_click.json"
ACTION_BAR_COUNTERS_PATH = DIAGNOSTICS_DIR / "action_bar_counters.json"
SELECTED_LIKER_TRIGGER_PATH = DIAGNOSTICS_DIR / "selected_liker_trigger.json"
CSV_FIELDS = (
    "username", "full_name", "profile_url", "user_id", "is_verified",
    "is_private", "media_url", "collected_at", "collector_method",
)
INSTAGRAM_ORIGINS = {"instagram.com", "www.instagram.com"}
USERNAME_RE = re.compile(r"^[a-z0-9._]{1,30}$", re.IGNORECASE)
RESERVED_PATHS = {
    "accounts", "about", "api", "direct", "directory", "emails", "explore",
    "p", "reel", "reels", "stories", "web", "developer", "legal", "privacy",
    "terms", "challenge", "static", "favicon.ico",
}

BROWSER_UNAVAILABLE = "browser_unavailable"
# The likes UI is opened by a DOM activation on the audited node. A pointer click
# would send mousedown/mouseup separately, and Instagram can swap the DOM in
# between, so the release lands on a profile link instead of the counter.
DOM_CLICK_SCRIPT = "(element) => { element.click(); }"
ACTIVATION_METHOD = "dom_click"
POST_CLICK_WAIT_MS = 500
CHROME_LABEL = "Google Chrome"
CHROMIUM_LABEL = "Chromium (Playwright)"
# Standard Windows install roots; the personal Chrome profile is never used.
CHROME_ENV_ROOTS = ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")
CHROME_RELATIVE_PATH = Path("Google") / "Chrome" / "Application" / "chrome.exe"
DIAGNOSE_MODE = "diagnóstico de curtidores"
MAX_CANDIDATES = 100
MAX_LIKE_TEXT_NODES = 200
MAX_ACTION_BAR_CANDIDATES = 200
MAX_ENGAGEMENT_TEXT_LINES = 100
MAX_POST_CLICK_PROFILE_LINKS = 100
MAX_POST_CLICK_CONTAINERS = 50
MAX_TEXT_LENGTH = 150
CANDIDATE_SELECTOR = 'a[href], button, [role="button"], [role="link"]'
TRIGGER_SELECTOR = 'a[href], button, [role="button"], [role="link"], [tabindex]'
# Bound the DOM read so a busy feed cannot produce a huge payload.
CANDIDATE_SCAN_LIMIT = 1_000
ENGAGEMENT_TERMS = (
    "like", "likes", "liked", "curtida", "curtidas", "curtido", "pessoas",
    "others", "other", "engagement",
)
LIKE_TEXT_TERMS = ("curtida", "curtidas", "like", "likes", "liked", "outras pessoas", "others")
ACTION_BAR_TERMS = (
    "curtir", "descurtir", "comentar", "compartilhar", "salvar",
    "like", "unlike", "comment", "share", "save",
)
COMMENT_REPLY_TERMS = ("responder", "reply")
COMMENT_TIMESTAMP_RE = re.compile(
    r"(?:^|\s)\d+\s*(?:s|m|min|h|d|w|sem|semana|semanas|week|weeks|hour|hours|day|days)(?:\s|$)",
    re.IGNORECASE,
)
COMMENT_LIKE_RE = re.compile(r"^\d+(?:[.,]\d+)?\s+(?:curtida|curtidas|like|likes)$", re.IGNORECASE)
UNSAFE_LIKE_BUTTON_RE = re.compile(r"^(?:curtir|like|unlike|descurtir)$", re.IGNORECASE)
LAUNCH_FAILURE_TERMS = (
    BROWSER_UNAVAILABLE, "executable doesn't exist", "executable does not exist",
    "playwright install", "failed to launch", "no such file or directory",
    # A dead driver/event loop is a browser problem, never a missing session.
    "event loop is closed", "playwright already stopped",
)


class BrowserUnavailableError(RuntimeError):
    """No browser could be started, so Instagram was never reached."""

    def __init__(self) -> None:
        super().__init__(BROWSER_UNAVAILABLE)


class TriggerSelectionError(RuntimeError):
    """A post likes-list trigger could not be selected safely."""

    def __init__(self, code: str, diagnostics: dict[str, Any]) -> None:
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics


def candidate_chrome_paths() -> list[Path]:
    """List the standard Chrome install locations that exist on this machine."""
    candidates: list[Path] = []
    for variable in CHROME_ENV_ROOTS:
        root = os.environ.get(variable, "").strip()
        if root:
            candidates.append(Path(root) / CHROME_RELATIVE_PATH)
    return candidates


def resolve_browser_executable() -> Path | None:
    """Resolve the system Chrome binary, preferring the optional override."""
    override = os.environ.get("IG_BROWSER_EXECUTABLE", "").strip().strip('"')
    candidates = [Path(override)] if override else []
    candidates.extend(candidate_chrome_paths())
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def browser_launch_plans(executable: Path | None) -> list[tuple[str, dict[str, Any]]]:
    """Order the launch attempts: system Chrome first, bundled Chromium last."""
    plans: list[tuple[str, dict[str, Any]]] = []
    if executable:
        plans.append((CHROME_LABEL, {"executable_path": str(executable)}))
    plans.append((f"{CHROME_LABEL} (channel)", {"channel": "chrome"}))
    plans.append((CHROMIUM_LABEL, {}))
    return plans


def print_browser_diagnostics(executable: Path | None) -> None:
    """Report only whether a system browser was found; never print its path."""
    if executable:
        print(f"Browser: {CHROME_LABEL}")
        print("Executável: encontrado")
        return
    print(f"Browser: {CHROME_LABEL} (channel) / {CHROMIUM_LABEL}")
    if os.environ.get("IG_BROWSER_EXECUTABLE", "").strip():
        print("Executável: não encontrado (IG_BROWSER_EXECUTABLE não aponta para um arquivo)")
    else:
        print("Executável: não encontrado")


def launch_browser_context(playwright: Playwright, executable: Path | None) -> tuple[BrowserContext, str]:
    """Open the dedicated profile in the first browser that starts.

    Failures here happen before Instagram is reached, so they must surface as
    browser_unavailable instead of a missing login.
    """
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    for label, options in browser_launch_plans(executable):
        try:
            context = playwright.chromium.launch_persistent_context(
                str(PROFILE_DIR), headless=False, **options
            )
        except Exception:
            # A failed attempt only rules out this browser; try the next plan and
            # let the caller report browser_unavailable if none of them start.
            continue
        return context, label
    raise BrowserUnavailableError()


def get_likers_limit() -> int:
    """Return the POC limit, rejecting values above the absolute cap."""
    raw_value = os.environ.get("IG_LIKERS_LIMIT", "20").strip()
    try:
        limit = int(raw_value)
    except ValueError as error:
        raise ValueError("unknown_error") from error
    if not 1 <= limit <= MAX_LIKERS:
        raise ValueError("unknown_error")
    return limit


def get_target_media_url() -> str:
    media_url = os.environ.get("IG_TARGET_MEDIA_URL", "").strip()
    parsed = urlparse(media_url)
    path_parts = [part for part in parsed.path.split("/") if part]
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() not in INSTAGRAM_ORIGINS
        or len(path_parts) < 2
        or path_parts[0].lower() not in {"p", "reel", "reels"}
    ):
        raise ValueError("unknown_error")
    return media_url


def new_run_id() -> str:
    """Identify one execution so its diagnostics can never be read as another run's."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{uuid4().hex[:8]}"


def normalize_username(value: str | None) -> str:
    """Normalize a UI username without deriving or inventing account data."""
    normalized = (value or "").strip().lstrip("@").lower()
    return normalized if USERNAME_RE.fullmatch(normalized) else ""


def username_from_profile_href(href: str | None) -> str:
    """Accept only Instagram paths that unambiguously represent a profile."""
    if not href:
        return ""
    parsed = urlparse(urljoin("https://www.instagram.com/", href))
    if parsed.hostname and parsed.hostname.lower() not in INSTAGRAM_ORIGINS:
        return ""
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 1 or parts[0].lower() in RESERVED_PATHS:
        return ""
    return normalize_username(parts[0])


def record_key(record: dict[str, Any]) -> str:
    user_id = str(record.get("user_id") or "").strip()
    if user_id:
        return f"id:{user_id}"
    username = normalize_username(str(record.get("username") or ""))
    return f"username:{username}" if username else ""


def deduplicate_records(records: Iterable[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for record in records:
        key = record_key(record)
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(record)
        if len(unique) >= limit:
            break
    return unique


def write_file_atomic(path: Path, content: str) -> None:
    """Replace a result file in one step so no partial output is ever readable."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    with temp_path.open("w", encoding="utf-8", newline="") as file:
        file.write(content)
    os.replace(temp_path, path)


def render_likers_json(records: list[dict[str, Any]]) -> str:
    return json.dumps(records, ensure_ascii=False, indent=2) + "\n"


def render_likers_csv(records: list[dict[str, Any]]) -> str:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=CSV_FIELDS)
    writer.writeheader()
    writer.writerows(records)
    return buffer.getvalue()


def write_output(records: list[dict[str, Any]]) -> None:
    """Write only the small, explicitly collected result set of this run."""
    write_file_atomic(JSON_PATH, render_likers_json(records))
    write_file_atomic(CSV_PATH, render_likers_csv(records))


def reset_liker_outputs() -> None:
    """Empty both result files before the run starts.

    A FAIL must never leave the previous run's rows behind, so the outputs begin
    as an empty JSON list and a header-only CSV.
    """
    write_output([])


def page_has_login_form(page: Page) -> bool:
    """Check page state only; no credential values are read or supplied."""
    if "/accounts/login" in page.url.lower():
        return True
    try:
        return page.locator('input[name="username"]').count() > 0
    except PlaywrightError:
        return True


def blocked_state(page: Page) -> str | None:
    """Identify stop conditions without reporting DOM content."""
    try:
        text = page.locator("body").inner_text(timeout=2_000).lower()
    except PlaywrightError:
        return None
    if any(term in text for term in ("challenge", "checkpoint", "suspicious login", "atividade suspeita")):
        return "browser_challenge_required"
    if any(term in text for term in ("rate limit", "too many requests", "try again later", "tente novamente mais tarde")):
        return "rate_limit"
    if any(term in text for term in ("action blocked", "ação bloqueada", "acao bloqueada")):
        return "rate_limit"
    return None


def classify_browser_error(error: Exception, phase: str) -> str:
    """Map browser failures to safe codes; never echo the original error."""
    details = f"{type(error).__name__} {error}".lower()
    # A browser that never started cannot say anything about the session.
    if isinstance(error, BrowserUnavailableError) or phase == "launch":
        return BROWSER_UNAVAILABLE
    if any(term in details for term in LAUNCH_FAILURE_TERMS):
        return BROWSER_UNAVAILABLE
    if any(term in details for term in ("challenge", "checkpoint", "suspicious login")):
        return "browser_challenge_required"
    if any(term in details for term in ("rate limit", "429", "too many requests", "action blocked")):
        return "rate_limit"
    if "browser_login_required" in details:
        return "browser_login_required"
    if "likers_dialog_not_found" in details:
        return "likers_dialog_not_found"
    if "likers_dialog_unverified" in details:
        return "likers_dialog_unverified"
    if "post_action_bar_ambiguous" in details:
        return "post_action_bar_ambiguous"
    if "unsafe_like_button_candidate" in details:
        return "unsafe_like_button_candidate"
    if "unsafe_profile_navigation_trigger" in details:
        return "unsafe_profile_navigation_trigger"
    if "unsafe_profile_navigation_after_click" in details:
        return "unsafe_profile_navigation_after_click"
    if "liker_trigger_changed_before_click" in details:
        return "liker_trigger_changed_before_click"
    if "likers_unavailable" in details:
        return "likers_unavailable"
    # browser_login_required means only: the browser opened, Instagram loaded,
    # and no authenticated session exists.
    if phase == "authentication":
        return "browser_login_required"
    if phase == "dialog":
        return "likers_dialog_not_found"
    if phase == "collection":
        return "likers_unavailable"
    return "unknown_error"


def first_visible(locators: Iterable[Locator]) -> Locator | None:
    """Return the first visible semantic/accessible selector match."""
    for locator in locators:
        try:
            if locator.count() and locator.first.is_visible():
                return locator.first
        except PlaywrightError:
            continue
    return None


def select_likers_trigger(page: Page) -> tuple[Locator | None, dict[str, Any]]:
    """Select only a validated post counter/control; never a generic like label."""
    raw = page.evaluate(TRIGGER_SELECTION_SCRIPT, {"triggerSelector": TRIGGER_SELECTOR})
    selection = sanitize_trigger_selection(raw)
    status = selection.get("status")
    if status != "found":
        write_json(TRIGGER_SELECTION_PATH, selection)
        if status in {"post_action_bar_ambiguous", "unsafe_like_button_candidate"}:
            raise TriggerSelectionError(status, selection)
        return None, selection
    trigger = selection.get("trigger") or {}
    labels = [str(trigger.get(field) or "").strip() for field in ("text", "aria_label")]
    parent_text = str(trigger.get("parent_text") or "").lower()
    if COMMENT_LIKE_RE.fullmatch(str(trigger.get("text") or "").strip()) or "responder" in parent_text or "reply" in parent_text:
        selection["status"] = "not_found"
        selection["rejection_reasons"] = ["comment_like_context"]
        write_json(TRIGGER_SELECTION_PATH, selection)
        return None, selection
    if any(UNSAFE_LIKE_BUTTON_RE.fullmatch(label) for label in labels if label):
        selection["status"] = "unsafe_like_button_candidate"
        selection["rejection_reasons"] = ["trigger_matches_like_action"]
        write_json(TRIGGER_SELECTION_PATH, selection)
        raise TriggerSelectionError("unsafe_like_button_candidate", selection)
    index = selection.get("target_index")
    if not isinstance(index, int) or index < 0:
        write_json(TRIGGER_SELECTION_PATH, selection)
        return None, selection
    locator = page.locator(TRIGGER_SELECTOR).nth(index)
    try:
        return (locator if locator.is_visible() else None), selection
    except PlaywrightError:
        return None, selection


def find_likers_trigger(page: Page) -> Locator | None:
    """Compatibility wrapper for callers that only need the safe locator."""
    trigger, _ = select_likers_trigger(page)
    return trigger


def wait_for_likers_dialog(page: Page, before_snapshot: dict[str, Any] | None = None) -> Locator:
    """Find the post-click liker container: dialog, aria-modal, then safe overlay."""
    before_usernames = profile_usernames_from_snapshot(before_snapshot or {})
    invalid_container_seen = False
    modal_candidates = page.locator('[role="dialog"], [aria-modal="true"]')
    try:
        modal_candidates.last.wait_for(state="visible", timeout=5_000)
    except TimeoutError:
        pass

    # The real post-click UI is aria-modal. Check it before a role dialog so a
    # broad/background dialog can never win when the focused modal is present.
    for selector in ('[aria-modal="true"]', '[role="dialog"]'):
        try:
            containers = page.locator(selector).all()
        except PlaywrightError:
            containers = []
        for container in sorted(containers, key=likers_container_area):
            try:
                if not container.is_visible():
                    continue
                if is_likers_dialog(container, before_usernames=before_usernames):
                    return container
                invalid_container_seen = True
            except PlaywrightError:
                continue

    # The fallback is intentionally narrow: it must be a visible fixed/sticky
    # overlay with new profile-list evidence, never an arbitrary page div.
    try:
        overlays = page.locator("div").all()[:300]
    except PlaywrightError:
        overlays = []
    for overlay in reversed(overlays):
        try:
            if not overlay.is_visible():
                continue
            if is_likers_dialog(overlay, before_usernames=before_usernames, allow_overlay=True):
                return overlay
        except PlaywrightError:
            continue
    raise RuntimeError("likers_dialog_unverified" if invalid_container_seen else "likers_dialog_not_found")


def likers_container_area(container: Locator) -> float:
    """Prefer the smallest visible modal so a broad ancestor cannot win."""
    try:
        box = container.bounding_box()
        if isinstance(box, dict):
            return max(0.0, float(box.get("width") or 0)) * max(0.0, float(box.get("height") or 0))
    except (AttributeError, PlaywrightError, TypeError, ValueError):
        pass
    return float("inf")


def profile_usernames_in_dialog(dialog: Locator) -> set[str]:
    """Read only valid, visible profile hrefs from a dialog."""
    usernames: set[str] = set()
    try:
        links = dialog.locator("a[href]").all()
    except PlaywrightError:
        return usernames
    for link in links:
        try:
            if link.is_visible():
                username = username_from_profile_href(link.get_attribute("href"))
                if username:
                    usernames.add(username)
        except PlaywrightError:
            continue
    return usernames


def profile_usernames_from_snapshot(snapshot: dict[str, Any]) -> set[str]:
    """Return the normalized profile baseline visible before the counter click."""
    return {
        username for link in snapshot.get("profile_links", [])
        if isinstance(link, dict) and (username := username_from_profile_href(str(link.get("href") or "")))
    }


def new_profile_usernames(before_snapshot: dict[str, Any], after_snapshot: dict[str, Any]) -> set[str]:
    """Compute the post-click profile delta without retaining background links."""
    return profile_usernames_from_snapshot(after_snapshot) - profile_usernames_from_snapshot(before_snapshot)


def likers_container_type(container: Locator, allow_overlay: bool = False) -> str | None:
    """Describe a supported container type without making the UI interactive."""
    try:
        if container.get_attribute("role") == "dialog":
            return "role_dialog"
        if container.get_attribute("aria-modal") == "true":
            return "aria_modal"
        if allow_overlay:
            style = container.evaluate("""element => {
              const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
              return { position: style.position, zIndex: style.zIndex, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
            }""")
            try:
                isolated = (
                    isinstance(style, dict)
                    and float(style.get("width") or 0) > 0 and float(style.get("height") or 0) > 0
                    and float(style.get("width") or 0) < float(style.get("viewportWidth") or 0) * 0.95
                    and float(style.get("height") or 0) < float(style.get("viewportHeight") or 0) * 0.95
                )
            except (TypeError, ValueError):
                isolated = False
            if isinstance(style, dict) and isolated and style.get("position") in {"fixed", "sticky"} and style.get("zIndex") not in {None, "", "auto"}:
                return "overlay"
    except PlaywrightError:
        return None
    return None


def is_likers_dialog(
    dialog: Locator, before_usernames: set[str] | None = None, allow_overlay: bool = False
) -> bool:
    """Fail closed unless a new, supported container holds multiple profiles."""
    try:
        if not dialog.is_visible() or not likers_container_type(dialog, allow_overlay):
            return False
        modal_label = " ".join(
            value for value in (dialog.get_attribute("aria-label"), dialog.get_attribute("title")) if value
        ).lower()
    except PlaywrightError:
        return False
    if any(term in modal_label for term in ("login", "challenge", "share", "compartilhar", "send", "enviar")):
        return False
    usernames = profile_usernames_in_dialog(dialog)
    if len(usernames) < 2:
        return False
    # When a before-click snapshot is available, old navigation/profile widgets
    # cannot qualify; the post-click UI needs a real multi-profile delta.
    return not before_usernames or len(usernames - before_usernames) >= 2


def sanitize_full_name(value: Any, username: str) -> str | None:
    """Accept only a distinct profile-row label, never an action/control label."""
    name = truncate_text(value)
    if not name or normalize_username(name) == username:
        return None
    if name.lower() in {"seguir", "following", "follow", "remover", "remove", "verificado", "verified"}:
        return None
    return name


def full_name_from_profile_row(link: Locator, username: str, attribute_value: str | None) -> str | None:
    """Read a secondary label only from the same profile list row."""
    direct = sanitize_full_name(attribute_value, username)
    if direct:
        return direct
    try:
        value = link.evaluate(
            """(element, username) => {
              const row = element.closest('[role="listitem"], li') || element.parentElement;
              if (!row) return null;
              const blocked = new Set(['seguir', 'following', 'follow', 'remover', 'remove', 'verificado', 'verified']);
              const values = Array.from(row.querySelectorAll('span')).map((node) => (node.innerText || node.textContent || '').trim()).filter(Boolean);
              return values.find((text) => text.toLowerCase() !== username.toLowerCase() && !blocked.has(text.toLowerCase())) || null;
            }""",
            username,
        )
    except (AttributeError, PlaywrightError):
        return None
    return sanitize_full_name(value, username)


def profile_link_is_in_user_row(link: Locator) -> bool:
    """Require a bounded repeated row around a profile link inside the liker UI."""
    try:
        return bool(link.evaluate("""element => {
          const isProfileHref = (href) => {
            try { const parts = new URL(href || '', document.baseURI).pathname.split('/').filter(Boolean); return parts.length === 1 && /^[a-z0-9._]{1,30}$/i.test(parts[0]) && !['accounts','direct','explore','p','reel','reels','stories','web','api'].includes(parts[0].toLowerCase()); } catch (_) { return false; }
          };
          let row = element.closest('[role="listitem"], li') || element.parentElement;
          for (let depth = 0; row && depth < 4; depth += 1, row = row.parentElement) {
            if (row.matches('main, article, body')) return false;
            const profiles = Array.from(row.querySelectorAll('a[href]')).filter((item) => isProfileHref(item.getAttribute('href')));
            if (profiles.length === 1 && row.children.length >= 2) return true;
          }
          return false;
        }"""))
    except (AttributeError, PlaywrightError):
        return False


def record_from_profile_link(link: Locator, media_url: str, collected_at: str) -> dict[str, Any] | None:
    """Create a record only from visible profile links; unavailable data stays null."""
    try:
        username = username_from_profile_href(link.get_attribute("href"))
        if not username:
            return None
    except PlaywrightError:
        return None
    try:
        user_id = link.get_attribute("data-user-id") or link.get_attribute("data-ig-user-id")
        full_name = link.get_attribute("data-full-name") or link.get_attribute("data-full_name")
        private_value = link.get_attribute("data-is-private")
        verified_value = link.get_attribute("data-is-verified")
    except PlaywrightError:
        user_id = full_name = private_value = verified_value = None

    def optional_bool(value: str | None) -> bool | None:
        if not isinstance(value, str):
            return None
        if value.lower() in {"true", "1"}:
            return True
        if value.lower() in {"false", "0"}:
            return False
        return None

    return {
        "username": username,
        "full_name": full_name_from_profile_row(link, username, full_name),
        "profile_url": f"https://www.instagram.com/{username}/",
        "user_id": truncate_text(user_id, 80),
        "is_verified": optional_bool(verified_value),
        "is_private": optional_bool(private_value),
        "media_url": media_url,
        "collected_at": collected_at,
        "collector_method": "browser_ui",
    }


def collect_visible_likers(
    dialog: Locator, media_url: str, collected_at: str, base_usernames: set[str] | None = None
) -> list[dict[str, Any]]:
    """Read unique post-click profile hrefs; avatar/text pairs map to one user."""
    records: list[dict[str, Any]] = []
    try:
        links = dialog.locator("a[href]").all()
    except PlaywrightError:
        return records
    grouped_links: dict[str, Locator] = {}
    for link in links:
        try:
            username = username_from_profile_href(link.get_attribute("href"))
        except PlaywrightError:
            continue
        if not username or username in (base_usernames or set()):
            continue
        current = grouped_links.get(username)
        if current is None or profile_link_matches_username(link, username):
            grouped_links[username] = link
    for link in grouped_links.values():
        record = record_from_profile_link(link, media_url, collected_at)
        if record:
            records.append(record)
    return records


def profile_link_matches_username(link: Locator, username: str) -> bool:
    """Prefer the textual username link to its duplicate avatar href when present."""
    try:
        return normalize_username(link.inner_text()) == username
    except (AttributeError, PlaywrightError):
        return False


def scroll_dialog_once(dialog: Locator) -> None:
    """Perform one bounded UI scroll; no page navigation or action endpoint is used."""
    dialog.evaluate("element => element.scrollBy(0, Math.max(240, element.clientHeight * 0.8))")


def collect_likers_from_dialog(
    page: Page, dialog: Locator, media_url: str, limit: int, base_usernames: set[str] | None = None
) -> list[dict[str, Any]]:
    """Collect at most 20 visible users with bounded gradual scrolling."""
    collected_at = datetime.now(timezone.utc).isoformat()
    records: list[dict[str, Any]] = []
    idle_scrolls = 0
    max_idle_scrolls = 3

    while len(deduplicate_records(records, limit)) < limit and idle_scrolls < max_idle_scrolls:
        stop_code = blocked_state(page)
        if stop_code:
            raise RuntimeError(stop_code)
        before = len(deduplicate_records(records, limit))
        records.extend(collect_visible_likers(dialog, media_url, collected_at, base_usernames))
        records = deduplicate_records(records, limit)
        if len(records) >= limit:
            break
        if len(records) == before:
            idle_scrolls += 1
        else:
            idle_scrolls = 0
        scroll_dialog_once(dialog)
        page.wait_for_timeout(750)

    return records


def page_for_context(context: BrowserContext) -> Page:
    return context.pages[0] if context.pages else context.new_page()


def close_context_quietly(context: BrowserContext) -> None:
    """Close the browser context, reporting (never hiding) a cleanup failure.

    Must run while Playwright is still active. A browser the user already closed
    by hand must not turn an already-decided result into a traceback.
    """
    try:
        context.close()
    except PlaywrightError:
        print("Aviso: o navegador já estava encerrado durante o cleanup.")


def truncate_text(value: Any, limit: int = MAX_TEXT_LENGTH) -> str | None:
    """Collapse whitespace and hard-cap length; page HTML is never stored."""
    if not isinstance(value, str):
        return None
    collapsed = " ".join(value.split())
    return collapsed[:limit] if collapsed else None


def sanitize_href(href: Any) -> str | None:
    """Keep only the visible path/URL, dropping query strings and fragments."""
    if not isinstance(href, str) or not href.strip():
        return None
    parsed = urlparse(href.strip())
    if parsed.scheme and parsed.scheme.lower() not in {"http", "https"}:
        return None
    if parsed.netloc:
        return truncate_text(f"{parsed.scheme or 'https'}://{parsed.netloc}{parsed.path}")
    return truncate_text(parsed.path)


def summarize_box(box: Any) -> dict[str, int] | None:
    """Reduce a bounding box to rounded integers."""
    if not isinstance(box, dict):
        return None
    summary: dict[str, int] = {}
    for key in ("x", "y", "width", "height"):
        try:
            summary[key] = int(round(float(box.get(key, 0))))
        except (TypeError, ValueError):
            return None
    return summary


def media_shortcode_from_url(media_url: str) -> str | None:
    """Return the public shortcode of a validated post URL."""
    parts = [part for part in urlparse(media_url).path.split("/") if part]
    if len(parts) >= 2 and parts[0].lower() in {"p", "reel", "reels"}:
        return truncate_text(parts[1], 40)
    return None


def has_engagement_term(candidate: dict[str, Any]) -> bool:
    """Flag likely engagement controls without relying on text alone."""
    haystack = " ".join(
        str(candidate.get(field) or "")
        for field in ("aria_label", "title", "text", "href", "data_testid")
    ).lower()
    return any(term in haystack for term in ENGAGEMENT_TERMS)


def candidate_priority(candidate: dict[str, Any]) -> tuple[int, int, int, int]:
    """Rank the most likely likers controls first; lower sorts earlier."""
    href = candidate.get("href") or ""
    return (
        0 if "/liked_by/" in href.lower() else 1,
        0 if candidate.get("engagement_hint") else 1,
        0 if (candidate.get("in_article") or candidate.get("in_main")) else 1,
        0 if candidate.get("visible") else 1,
    )


def sanitize_candidate(raw: Any) -> dict[str, Any] | None:
    """Copy only the allow-listed descriptors, so nothing else can leak."""
    if not isinstance(raw, dict):
        return None
    candidate = {
        "dom_index": raw.get("dom_index") if isinstance(raw.get("dom_index"), int) else None,
        "tag": truncate_text(raw.get("tag"), 40),
        "role": truncate_text(raw.get("role"), 40),
        "aria_label": truncate_text(raw.get("aria_label")),
        "title": truncate_text(raw.get("title")),
        "text": truncate_text(raw.get("text")),
        "href": sanitize_href(raw.get("href")),
        "data_testid": truncate_text(raw.get("data_testid"), 80),
        "visible": bool(raw.get("visible")),
        "bounding_box": summarize_box(raw.get("box")),
        "in_article": bool(raw.get("in_article")),
        "in_main": bool(raw.get("in_main")),
    }
    candidate["engagement_hint"] = has_engagement_term(candidate)
    return candidate


def sanitize_trigger_descriptor(raw: Any) -> dict[str, Any] | None:
    """Allow-list a possible action bar or likes trigger for failure evidence."""
    if not isinstance(raw, dict):
        return None
    return {
        "tag": truncate_text(raw.get("tag"), 40),
        "role": truncate_text(raw.get("role"), 40),
        "text": truncate_text(raw.get("text")),
        "aria_label": truncate_text(raw.get("aria_label")),
        "href": sanitize_href(raw.get("href")),
        "bounding_box": summarize_box(raw.get("box")),
        "parent_text": truncate_text(raw.get("parent_text")),
    }


def sanitize_trigger_selection(raw: Any) -> dict[str, Any]:
    """Return only safe trigger-selection evidence; never DOM markup or state."""
    raw = raw if isinstance(raw, dict) else {}
    status = raw.get("status")
    if status not in {"found", "not_found", "post_action_bar_ambiguous", "unsafe_like_button_candidate"}:
        status = "not_found"
    reasons = raw.get("rejection_reasons")
    safe_reasons = [truncate_text(reason, 80) for reason in reasons if truncate_text(reason, 80)] if isinstance(reasons, list) else []
    return {
        "status": status,
        "selection_method": truncate_text(raw.get("selection_method"), 80),
        "action_bar": sanitize_trigger_descriptor(raw.get("action_bar")),
        "trigger": sanitize_trigger_descriptor(raw.get("trigger")),
        "target_index": raw.get("target_index") if isinstance(raw.get("target_index"), int) else None,
        "rejection_reasons": safe_reasons,
    }


def unsafe_trigger_href(href: Any) -> bool:
    """Reject profile and content-navigation routes before the only allowed click."""
    safe_href = sanitize_href(href)
    if not safe_href:
        return False
    if username_from_profile_href(safe_href):
        return True
    parts = [part.lower() for part in urlparse(safe_href).path.split("/") if part]
    return bool(parts and parts[0] in {"p", "reel", "reels", "stories", "direct"})


def is_instagram_profile_url(url: str) -> bool:
    """Identify a profile navigation outcome; it is never a liker-list route."""
    return bool(username_from_profile_href(url))


TRIGGER_INSPECTION_SCRIPT = """
element => {
  const describe = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), href: node.getAttribute('href'), text: node.innerText || node.textContent || '', aria_label: node.getAttribute('aria-label'), box: {x: rect.x, y: rect.y, width: rect.width, height: rect.height} };
  };
  const ancestors = []; let node = element;
  for (let level = 0; node && level <= 6; level += 1, node = node.parentElement) ancestors.push({ ...describe(node), level });
  return { trigger: describe(element), clickable: describe(element), ancestor_chain: ancestors };
}
"""


def sanitize_ancestor_summary(raw: Any) -> dict[str, Any] | None:
    """Keep the bounded structural chain needed to audit a safe click target."""
    if not isinstance(raw, dict):
        return None
    level = raw.get("level")
    return {
        "level": level if isinstance(level, int) and 0 <= level <= 6 else None,
        "tag": truncate_text(raw.get("tag"), 40),
        "role": truncate_text(raw.get("role"), 40),
        "href": sanitize_href(raw.get("href")),
        "text": truncate_text(raw.get("text")),
    }


def inspect_selected_liker_trigger(
    node: Locator | ElementHandle, selection: dict[str, Any]
) -> dict[str, Any]:
    """Read the actual click target and ancestors before clicking it once."""
    raw = node.evaluate(TRIGGER_INSPECTION_SCRIPT)
    raw = raw if isinstance(raw, dict) else {}
    trigger = sanitize_trigger_descriptor(raw.get("trigger")) or {}
    clickable = sanitize_trigger_descriptor(raw.get("clickable")) or {}
    ancestors = [item for item in map(sanitize_ancestor_summary, raw.get("ancestor_chain", [])) if item]
    return {
        "trigger_type": truncate_text(selection.get("selection_method"), 80),
        "selection_reason": truncate_text(selection.get("selection_method"), 80),
        "associated_action": "like" if selection.get("selection_method") == "action_bar_counter" else None,
        "tag": trigger.get("tag"), "role": trigger.get("role"), "text": trigger.get("text"),
        "aria_label": trigger.get("aria_label"), "href": trigger.get("href"), "bounding_box": trigger.get("bounding_box"),
        "clickable_tag": clickable.get("tag"), "clickable_role": clickable.get("role"),
        "clickable_text": clickable.get("text"), "clickable_href": clickable.get("href"),
        "ancestor_chain": ancestors,
        "action_bar_context": sanitize_trigger_descriptor(selection.get("action_bar")),
    }


def trigger_has_unsafe_navigation(diagnostics: dict[str, Any]) -> bool:
    """Fail closed when the target or any bounded ancestor is navigation-like."""
    hrefs = [diagnostics.get("href"), diagnostics.get("clickable_href")]
    hrefs.extend(item.get("href") for item in diagnostics.get("ancestor_chain", []) if isinstance(item, dict))
    return any(unsafe_trigger_href(href) for href in hrefs)


def trigger_fingerprint(diagnostics: dict[str, Any]) -> dict[str, Any]:
    """Reduce the audited node to the identity that must still hold at activation.

    Geometry is left out on purpose: the page may scroll between the audit and
    the activation, but the tag/role/text/href and the ancestor structure of the
    approved counter may not change.
    """
    return {
        "tag": diagnostics.get("tag"),
        "role": diagnostics.get("role"),
        "text": diagnostics.get("text"),
        "href": diagnostics.get("href"),
        "ancestor_chain": [
            {key: item.get(key) for key in ("level", "tag", "role", "href")}
            for item in diagnostics.get("ancestor_chain") or []
            if isinstance(item, dict)
        ],
    }


def trigger_element_handle(trigger: Locator) -> ElementHandle | None:
    """Pin the audited node so a lazy locator cannot later resolve to another one."""
    try:
        return trigger.element_handle(timeout=5_000)
    except PlaywrightError:
        return None


def activate_safe_liker_trigger(
    page: Page, handle: ElementHandle, selection: dict[str, Any], fingerprint: dict[str, Any]
) -> dict[str, Any]:
    """Revalidate the pinned node, then open the likes UI with one DOM activation.

    A single HTMLElement activation is the only allowed one: it dispatches one
    event on the audited node, so a DOM swap mid-gesture cannot redirect the
    interaction to a profile link.
    """
    current = inspect_selected_liker_trigger(handle, selection)
    if trigger_fingerprint(current) != fingerprint or trigger_has_unsafe_navigation(current):
        raise TriggerSelectionError("liker_trigger_changed_before_click", current)
    before_url = page.url
    handle.evaluate(DOM_CLICK_SCRIPT)
    page.wait_for_timeout(POST_CLICK_WAIT_MS)
    return {
        "activation_method": ACTIVATION_METHOD,
        "before_url": before_url,
        "after_url": page.url,
    }


def unsafe_navigation_after_click(activation: dict[str, Any]) -> bool:
    """Detect the profile navigation outcome that must abort the run."""
    after_url = str(activation.get("after_url") or "")
    return after_url != str(activation.get("before_url") or "") and is_instagram_profile_url(after_url)


def resolve_likers_dialog(page: Page, before_snapshot: dict[str, Any]) -> tuple[Locator | None, str | None]:
    """Return the container or its failure code, so evidence is saved either way."""
    try:
        return wait_for_likers_dialog(page, before_snapshot), None
    except RuntimeError as error:
        return None, str(error)


def open_likers_ui(
    page: Page,
    handle: ElementHandle,
    selection: dict[str, Any],
    fingerprint: dict[str, Any],
    before_snapshot: dict[str, Any],
    run_id: str,
) -> tuple[Locator | None, str | None, dict[str, Any]]:
    """Activate the audited counter once, then always save this run's evidence.

    Returns the validated container or the failure code together with the
    post-click diagnostics, which are written for every outcome so a navigation
    abort can never leave an older run's file in place.
    """
    activation = activate_safe_liker_trigger(page, handle, selection, fingerprint)
    if unsafe_navigation_after_click(activation):
        # Never hunt for a liker dialog on the profile page we landed on.
        dialog, error = None, "unsafe_profile_navigation_after_click"
    else:
        dialog, error = resolve_likers_dialog(page, before_snapshot)
    return dialog, error, write_post_click_diagnostics(page, before_snapshot, activation, run_id)


def clear_trigger_diagnostics() -> None:
    """Remove only stale trigger-specific evidence before a new dry-run."""
    for path in (ACTION_BAR_COUNTERS_PATH, SELECTED_LIKER_TRIGGER_PATH):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # A stale diagnostic must never broaden into a destructive cleanup.
            continue


def prepare_safe_liker_trigger(
    page: Page, run_id: str | None = None
) -> tuple[ElementHandle | None, dict[str, Any], dict[str, Any]]:
    """Run the shared, read-only selection and pre-click safety audit.

    Returns the pinned handle of the audited node (never a lazy locator), the
    selection evidence, and the fingerprint that activation must match.
    """
    action_bar_counters = inspect_action_bar_counters(page)
    write_json(ACTION_BAR_COUNTERS_PATH, action_bar_counters)
    trigger, selection = select_likers_trigger(page)
    if not trigger:
        return None, selection, {}
    handle = trigger_element_handle(trigger)
    if handle is None:
        return None, selection, {}
    diagnostics = inspect_selected_liker_trigger(handle, selection)
    if trigger_has_unsafe_navigation(diagnostics):
        raise TriggerSelectionError("unsafe_profile_navigation_trigger", diagnostics)
    write_json(SELECTED_LIKER_TRIGGER_PATH, {"run_id": run_id, **diagnostics})
    return handle, selection, trigger_fingerprint(diagnostics)


# Read-only post action-bar inspection. It selects only a counter's clickable
# ancestor; it has no click, input, hover, or scrolling API calls.
TRIGGER_SELECTION_SCRIPT = """
(args) => {
  const controls = Array.from(document.querySelectorAll(args.triggerSelector));
  const normal = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const visible = (element) => {
    const rect = element.getBoundingClientRect(); const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const describe = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect(); const parent = element.parentElement;
    return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), text: element.innerText || element.textContent || '',
      aria_label: element.getAttribute('aria-label'), href: element.getAttribute('href'),
      box: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}, parent_text: parent ? (parent.innerText || parent.textContent || '') : null };
  };
  const label = (element) => normal([element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText || element.textContent || ''].join(' ')).toLowerCase();
  const actionKind = (element) => {
    const value = label(element);
    if (/(^|\\s)(curtir|like|unlike|descurtir)(\\s|$)/.test(value)) return 'like';
    if (/(^|\\s)(comentar|comment)(\\s|$)/.test(value)) return 'comment';
    if (/(^|\\s)(compartilhar|share)(\\s|$)/.test(value)) return 'share';
    if (/(^|\\s)(salvar|save)(\\s|$)/.test(value)) return 'save';
    return null;
  };
  const isUnsafeLikeAction = (element) => [element.getAttribute('aria-label'), element.innerText || element.textContent || ''].some((value) => /^(curtir|like|unlike|descurtir)$/i.test(normal(value)));
  const actionControls = controls.filter((element) => visible(element) && actionKind(element));
  const bars = new Map();
  for (const control of actionControls) {
    let ancestor = control.parentElement;
    for (let depth = 1; ancestor && depth <= 3; depth += 1, ancestor = ancestor.parentElement) {
      const contained = actionControls.filter((item) => ancestor.contains(item));
      const kinds = new Set(contained.map(actionKind));
      if (kinds.has('like') && kinds.has('comment') && kinds.has('share')) {
        bars.set(ancestor, { element: ancestor, controls: contained, depth });
        break;
      }
    }
  }
  let barChoices = Array.from(bars.values());
  if (barChoices.length) {
    const smallestControlSet = Math.min(...barChoices.map((bar) => bar.controls.length));
    barChoices = barChoices.filter((bar) => bar.controls.length === smallestControlSet);
  }
  if (barChoices.length > 1) return { status: 'post_action_bar_ambiguous', action_bar: describe(barChoices[0].element), rejection_reasons: ['multiple_structural_action_bars'] };
  if (barChoices.length === 1) {
    const bar = barChoices[0];
    const likes = bar.controls.filter((control) => actionKind(control) === 'like');
    if (likes.length !== 1) return { status: 'post_action_bar_ambiguous', action_bar: describe(bar.element), rejection_reasons: ['multiple_like_actions_in_action_bar'] };
    const likeControl = likes[0];
    const scope = bar.element.parentElement || bar.element;
    const scopeNodes = Array.from(scope.querySelectorAll('span, div, section, a, button'));
    const numberPattern = /^\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d+)?(?:\\s*(?:mil|k))?$/i;
    const candidates = [];
    let unsafeCounterCandidate = false;
    for (let order = 0; order < scopeNodes.length; order += 1) {
      const node = scopeNodes[order]; const text = normal(node.innerText || node.textContent || '');
      if (!visible(node) || !numberPattern.test(text)) continue;
      const context = [node.parentElement, node.parentElement && node.parentElement.parentElement].map((item) => item ? (item.innerText || item.textContent || '') : '').join(' ').toLowerCase();
      if (context.includes('responder') || context.includes('reply')) continue;
      let clickable = controls.includes(node) ? node : node.parentElement;
      for (let level = 0; clickable && level < 5 && !controls.includes(clickable); level += 1, clickable = clickable.parentElement) {}
      if (!clickable || !controls.includes(clickable)) continue;
      if (clickable === likeControl || isUnsafeLikeAction(clickable)) { unsafeCounterCandidate = true; continue; }
      const nodeRect = node.getBoundingClientRect(); const likeRect = likeControl.getBoundingClientRect();
      if (Math.abs((nodeRect.top + nodeRect.height / 2) - (likeRect.top + likeRect.height / 2)) > 160) continue;
      candidates.push({ node, clickable, order, horizontalDistance: Math.abs((nodeRect.left + nodeRect.width / 2) - (likeRect.left + likeRect.width / 2)) });
    }
    if (candidates.length) {
      candidates.sort((a, b) => a.order - b.order || a.horizontalDistance - b.horizontalDistance);
      const chosen = candidates[0];
      return { status: 'found', selection_method: 'action_bar_counter', action_bar: describe(bar.element), trigger: describe(chosen.clickable), target_index: controls.indexOf(chosen.clickable), rejection_reasons: [] };
    }
    if (unsafeCounterCandidate) return { status: 'unsafe_like_button_candidate', action_bar: describe(bar.element), trigger: describe(likeControl), rejection_reasons: ['counter_resolves_to_like_action'] };
  }
  const profileListLinks = controls.filter((element) => visible(element) && (element.getAttribute('href') || '').includes('/liked_by/'));
  if (profileListLinks.length === 1 && !isUnsafeLikeAction(profileListLinks[0])) return { status: 'found', selection_method: 'liked_by_href', trigger: describe(profileListLinks[0]), target_index: controls.indexOf(profileListLinks[0]), rejection_reasons: [] };
  const semanticTotals = controls.filter((element) => {
    const value = label(element); const context = (element.parentElement ? (element.parentElement.innerText || element.parentElement.textContent || '') : '').toLowerCase();
    return visible(element) && /\\d[\\d.,]*\\s*(curtidas|likes)\\b/i.test(value) && /(outras pessoas|others|liked by)/i.test(value) && !context.includes('responder') && !context.includes('reply') && !isUnsafeLikeAction(element);
  });
  if (semanticTotals.length === 1) return { status: 'found', selection_method: 'semantic_total', trigger: describe(semanticTotals[0]), target_index: controls.indexOf(semanticTotals[0]), rejection_reasons: [] };
  return { status: 'not_found', action_bar: barChoices[0] ? describe(barChoices[0].element) : null, rejection_reasons: ['no_safe_post_like_counter'] };
}
"""


ACTION_BAR_COUNTERS_SCRIPT = """
(args) => {
  const controls = Array.from(document.querySelectorAll(args.triggerSelector));
  const normal = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const label = (element) => normal([element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText || element.textContent || ''].join(' ')).toLowerCase();
  const action = (element) => { const value = label(element); if (/(^|\\s)(curtir|like|unlike|descurtir)(\\s|$)/.test(value)) return 'like'; if (/(^|\\s)(comentar|comment)(\\s|$)/.test(value)) return 'comment'; if (/(^|\\s)(compartilhar|share)(\\s|$)/.test(value)) return 'share'; return null; };
  const actions = controls.filter((element) => visible(element) && action(element));
  let bar = null;
  for (const control of actions) {
    for (let node = control.parentElement, level = 0; node && level < 4; node = node.parentElement, level += 1) {
      const kinds = new Set(actions.filter((item) => node.contains(item)).map(action));
      if (kinds.has('like') && kinds.has('comment') && kinds.has('share')) { bar = node; break; }
    }
    if (bar) break;
  }
  if (!bar) return [];
  const describe = (element) => { if (!element) return null; return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), href: element.getAttribute('href'), text: element.innerText || element.textContent || '' }; };
  const number = /^\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d+)?(?:\\s*(?:mil|k))?$/i;
  const scope = bar.parentElement || bar;
  const results = [];
  for (const [order, node] of Array.from(scope.querySelectorAll('span, div, section, a, button')).entries()) {
    if (results.length >= args.maxResults || !visible(node)) continue;
    const text = normal(node.innerText || node.textContent || '');
    if (!number.test(text)) continue;
    let clickable = controls.includes(node) ? node : node.parentElement;
    for (let level = 0; clickable && level < 6 && !controls.includes(clickable); level += 1, clickable = clickable.parentElement) {}
    const chain = []; for (let ancestor = node, level = 0; ancestor && level <= 6; ancestor = ancestor.parentElement, level += 1) chain.push({ ...describe(ancestor), level });
    results.push({ text, tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), href: node.getAttribute('href'), clickable: Boolean(clickable), clickable_tag: clickable ? clickable.tagName.toLowerCase() : null, clickable_role: clickable ? clickable.getAttribute('role') : null, clickable_href: clickable ? clickable.getAttribute('href') : null, relative_dom_order: order, ancestor_summary: chain, inside_action_bar_container: bar.contains(node) });
  }
  return results;
}
"""


def sanitize_action_bar_counter(raw: Any) -> dict[str, Any] | None:
    """Allow-list a numeric action-bar candidate for read-only diagnosis."""
    if not isinstance(raw, dict):
        return None
    return {
        "text": truncate_text(raw.get("text")), "tag": truncate_text(raw.get("tag"), 40),
        "role": truncate_text(raw.get("role"), 40), "href": sanitize_href(raw.get("href")),
        "clickable": bool(raw.get("clickable")), "clickable_tag": truncate_text(raw.get("clickable_tag"), 40),
        "clickable_role": truncate_text(raw.get("clickable_role"), 40), "clickable_href": sanitize_href(raw.get("clickable_href")),
        "relative_dom_order": raw.get("relative_dom_order") if isinstance(raw.get("relative_dom_order"), int) else None,
        "ancestor_summary": [item for item in map(sanitize_ancestor_summary, raw.get("ancestor_summary", [])) if item],
        "inside_action_bar_container": bool(raw.get("inside_action_bar_container")),
    }


def inspect_action_bar_counters(page: Page) -> list[dict[str, Any]]:
    """Save bounded structural candidates for manual counter-target evidence."""
    raw = page.evaluate(ACTION_BAR_COUNTERS_SCRIPT, {"triggerSelector": TRIGGER_SELECTOR, "maxResults": 30})
    if not isinstance(raw, list):
        return []
    return [item for item in map(sanitize_action_bar_counter, raw[:30]) if item]


# Read-only before/after evidence for the one already-authorized counter click.
POST_CLICK_SNAPSHOT_SCRIPT = """
(args) => {
  const reserved = new Set(['accounts', 'about', 'api', 'direct', 'directory', 'emails', 'explore', 'p', 'reel', 'reels', 'stories', 'web', 'developer', 'legal', 'privacy', 'terms', 'challenge', 'static']);
  const visible = (element) => { const rect = element.getBoundingClientRect(); const style = window.getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; };
  const profileHref = (href) => {
    if (!href || href.startsWith('#') || href.startsWith('?') || /^javascript:/i.test(href)) return null;
    try {
      const url = new URL(href, document.baseURI); const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 1 || reserved.has(parts[0].toLowerCase()) || !/^[a-z0-9._]{1,30}$/i.test(parts[0])) return null;
      return parts[0].toLowerCase();
    } catch (_) { return null; }
  };
  const describeLink = (element) => { const rect = element.getBoundingClientRect(); return { href: element.getAttribute('href'), text: element.innerText || element.textContent || '', aria_label: element.getAttribute('aria-label'), visible: true, box: {x: rect.x, y: rect.y, width: rect.width, height: rect.height} }; };
  const links = Array.from(document.querySelectorAll('a[href]'));
  const profileLinks = links.filter((element) => visible(element) && profileHref(element.getAttribute('href'))).slice(0, args.profileLimit).map(describeLink);
  const result = { visible_links: links.filter(visible).length, dialog_count: document.querySelectorAll('[role="dialog"]').length, aria_modal_count: document.querySelectorAll('[aria-modal="true"]').length, profile_links: profileLinks, containers: [] };
  if (!args.includeContainers) return result;
  const candidates = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], div'));
  for (const element of candidates) {
    if (result.containers.length >= args.containerLimit || !visible(element)) continue;
    const style = window.getComputedStyle(element); const position = style.position || ''; const zIndex = style.zIndex || '';
    const profileLinkCount = Array.from(element.querySelectorAll('a[href]')).filter((link) => visible(link) && profileHref(link.getAttribute('href'))).length;
    const overlay = (position === 'fixed' || position === 'sticky') && zIndex !== 'auto' && zIndex !== '';
    if (element.getAttribute('role') !== 'dialog' && element.getAttribute('aria-modal') !== 'true' && !overlay && profileLinkCount < 2) continue;
    const rect = element.getBoundingClientRect();
    result.containers.push({ tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), aria_label: element.getAttribute('aria-label'), text: element.innerText || element.textContent || '', box: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}, position, z_index: zIndex, profile_link_count: profileLinkCount });
  }
  return result;
}
"""


def sanitize_post_click_profile_link(raw: Any) -> dict[str, Any] | None:
    """Keep only a visible, normalized Instagram-profile link descriptor."""
    if not isinstance(raw, dict):
        return None
    href = sanitize_href(raw.get("href"))
    if not username_from_profile_href(href):
        return None
    return {
        "href": href,
        "text": truncate_text(raw.get("text")),
        "aria_label": truncate_text(raw.get("aria_label")),
        "visible": bool(raw.get("visible")),
        "bounding_box": summarize_box(raw.get("box")),
    }


def sanitize_post_click_container(raw: Any) -> dict[str, Any] | None:
    """Allow-list container evidence without storing selectors, markup, or state."""
    if not isinstance(raw, dict):
        return None
    try:
        profile_link_count = max(0, int(raw.get("profile_link_count", 0)))
    except (TypeError, ValueError):
        profile_link_count = 0
    return {
        "tag": truncate_text(raw.get("tag"), 40),
        "role": truncate_text(raw.get("role"), 40),
        "aria_label": truncate_text(raw.get("aria_label")),
        "text": truncate_text(raw.get("text")),
        "bounding_box": summarize_box(raw.get("box")),
        "position": truncate_text(raw.get("position"), 40),
        "z_index": truncate_text(raw.get("z_index"), 40),
        "profile_link_count": profile_link_count,
    }


def collect_post_click_snapshot(page: Page, include_containers: bool) -> dict[str, Any]:
    """Read one bounded UI snapshot without interacting with the rendered post."""
    raw = page.evaluate(POST_CLICK_SNAPSHOT_SCRIPT, {
        "profileLimit": MAX_POST_CLICK_PROFILE_LINKS,
        "containerLimit": MAX_POST_CLICK_CONTAINERS,
        "includeContainers": include_containers,
    })
    raw = raw if isinstance(raw, dict) else {}
    links = [item for item in map(sanitize_post_click_profile_link, raw.get("profile_links", [])) if item]
    containers = [item for item in map(sanitize_post_click_container, raw.get("containers", [])) if item]
    return {
        "url": sanitize_href(page.url),
        "dialog_count": raw.get("dialog_count") if isinstance(raw.get("dialog_count"), int) else 0,
        "aria_modal_count": raw.get("aria_modal_count") if isinstance(raw.get("aria_modal_count"), int) else 0,
        "visible_links": raw.get("visible_links") if isinstance(raw.get("visible_links"), int) else 0,
        "profile_links": links[:MAX_POST_CLICK_PROFILE_LINKS],
        "containers": containers[:MAX_POST_CLICK_CONTAINERS],
    }


def profile_link_key(link: dict[str, Any]) -> str:
    """Deduplicate UI diagnostics by normalized visible profile href."""
    return username_from_profile_href(str(link.get("href") or ""))


def classify_observed_ui(before: dict[str, Any], after: dict[str, Any], new_links: list[dict[str, Any]]) -> str:
    """Classify only the observed post-click UI delta, never its semantics."""
    if before.get("url") != after.get("url"):
        return "navigation"
    containers = after.get("containers") or []
    if any(item.get("role") == "dialog" and item.get("profile_link_count", 0) > 0 for item in containers):
        return "role_dialog"
    if after.get("aria_modal_count", 0) > 0 and any(item.get("role") != "dialog" and item.get("profile_link_count", 0) > 0 for item in containers):
        return "aria_modal"
    if any(item.get("position") in {"fixed", "sticky"} and item.get("profile_link_count", 0) > 0 for item in containers):
        return "overlay"
    if (
        before.get("dialog_count") == after.get("dialog_count")
        and before.get("aria_modal_count") == after.get("aria_modal_count")
        and before.get("visible_links") == after.get("visible_links")
        and not new_links
    ):
        return "no_change"
    return "unknown"


def build_post_click_diagnostics(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Build the sanitized, bounded before/after payload for an invalid modal."""
    before_keys = {key for link in before.get("profile_links", []) if (key := profile_link_key(link))}
    new_links = [link for link in after.get("profile_links", []) if profile_link_key(link) not in before_keys]
    new_links = new_links[:MAX_POST_CLICK_PROFILE_LINKS]
    return {
        "before_url": before.get("url"),
        "after_url": after.get("url"),
        "dialog_count_before": before.get("dialog_count", 0),
        "dialog_count_after": after.get("dialog_count", 0),
        "aria_modal_count_before": before.get("aria_modal_count", 0),
        "aria_modal_count_after": after.get("aria_modal_count", 0),
        "visible_links_before": before.get("visible_links", 0),
        "visible_links_after": after.get("visible_links", 0),
        "new_visible_profile_links_count": len(new_links),
        "new_visible_profile_links": new_links,
        "containers": (after.get("containers") or [])[:MAX_POST_CLICK_CONTAINERS],
        "observed_ui_type": classify_observed_ui(before, after, new_links),
    }


def write_post_click_diagnostics(
    page: Page,
    before: dict[str, Any],
    activation: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Persist the current post-activation evidence, whatever the outcome was.

    Every DOM activation must leave this file describing the run that produced
    it, including a navigation abort, so no stale evidence can be read as fresh.
    """
    DIAGNOSTICS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(AFTER_LIKER_CLICK_SCREENSHOT_PATH))
        screenshot: Path | None = AFTER_LIKER_CLICK_SCREENSHOT_PATH
    except PlaywrightError:
        screenshot = None
    payload = {
        "run_id": run_id,
        "activation_method": (activation or {}).get("activation_method"),
        **build_post_click_diagnostics(before, collect_post_click_snapshot(page, include_containers=True)),
    }
    write_json(AFTER_LIKER_CLICK_PATH, payload)
    return {"path": AFTER_LIKER_CLICK_PATH, "screenshot": screenshot, **payload}


# Read-only DOM inspection: reads attributes and geometry, clicks nothing.
CANDIDATE_SCRIPT = """
(args) => {
  const nodes = Array.from(document.querySelectorAll(args.selector)).slice(0, args.scanLimit);
  return nodes.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      dom_index: index,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      aria_label: element.getAttribute('aria-label'),
      title: element.getAttribute('title'),
      text: element.innerText || element.textContent || '',
      href: element.getAttribute('href'),
      data_testid: element.getAttribute('data-testid'),
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && style.opacity !== '0',
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      in_article: element.closest('article') !== null,
      in_main: element.closest('main') !== null,
    };
  });
}
"""


def collect_candidates(page: Page) -> tuple[list[dict[str, Any]], int]:
    """Describe clickable elements without clicking or opening any of them."""
    raw_items = page.evaluate(
        CANDIDATE_SCRIPT,
        {"selector": CANDIDATE_SELECTOR, "scanLimit": CANDIDATE_SCAN_LIMIT},
    )
    if not isinstance(raw_items, list):
        return [], 0
    candidates = [item for item in map(sanitize_candidate, raw_items) if item]
    ranked = sorted(candidates, key=candidate_priority)
    return ranked[:MAX_CANDIDATES], len(candidates)


def text_has_term(value: Any, terms: tuple[str, ...]) -> bool:
    """Return whether a collapsed UI label contains one of the allowed terms."""
    return any(term in str(value or "").lower() for term in terms)


def classify_like_scope(raw: dict[str, Any]) -> str:
    """Classify diagnostic evidence only; this result is never used to click."""
    text = truncate_text(raw.get("text")) or ""
    # The post action bar is stronger structural evidence than a numeric label:
    # a global counter can use the same "N curtidas" wording as a comment.
    if bool(raw.get("near_action_bar")):
        return "post"
    if (
        bool(raw.get("is_comment_like"))
        or bool(COMMENT_LIKE_RE.fullmatch(text))
        or bool(raw.get("has_reply_context"))
        or bool(raw.get("has_timestamp_context"))
        or bool(raw.get("repeated_text"))
    ):
        return "comment"
    if text_has_term(text, ("outras pessoas", "others")):
        return "post"
    return "unknown"


def sanitize_clickable_ancestor(raw: Any) -> dict[str, Any] | None:
    """Keep only an allow-listed, non-interactive ancestor description."""
    if not isinstance(raw, dict):
        return None
    level = raw.get("level")
    if not isinstance(level, int) or not 1 <= level <= 5:
        return None
    return {
        "tag": truncate_text(raw.get("tag"), 40),
        "role": truncate_text(raw.get("role"), 40),
        "href": sanitize_href(raw.get("href")),
        "text": truncate_text(raw.get("text")),
        "aria_label": truncate_text(raw.get("aria_label")),
        "level": level,
    }


def sanitize_like_text_node(raw: Any) -> dict[str, Any] | None:
    """Copy only requested like-text evidence and its bounded DOM context."""
    if not isinstance(raw, dict):
        return None
    return {
        "dom_index": raw.get("dom_index") if isinstance(raw.get("dom_index"), int) else None,
        "tag": truncate_text(raw.get("tag"), 40),
        "role": truncate_text(raw.get("role"), 40),
        "text": truncate_text(raw.get("text")),
        "aria_label": truncate_text(raw.get("aria_label")),
        "href": sanitize_href(raw.get("href")),
        "visible": bool(raw.get("visible")),
        "bounding_box": summarize_box(raw.get("box")),
        "parent_tag": truncate_text(raw.get("parent_tag"), 40),
        "parent_role": truncate_text(raw.get("parent_role"), 40),
        "parent_text": truncate_text(raw.get("parent_text")),
        "parent_href": sanitize_href(raw.get("parent_href")),
        "grandparent_tag": truncate_text(raw.get("grandparent_tag"), 40),
        "grandparent_role": truncate_text(raw.get("grandparent_role"), 40),
        "grandparent_text": truncate_text(raw.get("grandparent_text")),
        "grandparent_href": sanitize_href(raw.get("grandparent_href")),
        "in_main": bool(raw.get("in_main")),
        "in_article": bool(raw.get("in_article")),
        "clickable_ancestor": sanitize_clickable_ancestor(raw.get("clickable_ancestor")),
        "likely_scope": classify_like_scope(raw),
    }


def sanitize_action_bar_candidate(raw: Any) -> dict[str, Any] | None:
    """Copy only requested action-bar evidence."""
    if not isinstance(raw, dict):
        return None
    return {
        "tag": truncate_text(raw.get("tag"), 40),
        "role": truncate_text(raw.get("role"), 40),
        "aria_label": truncate_text(raw.get("aria_label")),
        "title": truncate_text(raw.get("title")),
        "text": truncate_text(raw.get("text")),
        "href": sanitize_href(raw.get("href")),
        "bounding_box": summarize_box(raw.get("box")),
        "parent_text": truncate_text(raw.get("parent_text")),
        "in_main": bool(raw.get("in_main")),
    }


# Read-only DOM inspection for post-like text. This script contains no event API.
LIKE_TEXT_NODES_SCRIPT = """
(args) => {
  const termMatches = (value, terms) => terms.some((term) => value.toLowerCase().includes(term));
  const commentLikePattern = new RegExp(args.commentLikePattern, 'i');
  const timestampPattern = new RegExp(args.timestampPattern, 'i');
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
      && style.display !== 'none' && style.opacity !== '0';
  };
  const describe = (element) => element ? {
    tag: element.tagName.toLowerCase(), role: element.getAttribute('role'),
    text: element.innerText || element.textContent || '', href: element.getAttribute('href'),
    aria_label: element.getAttribute('aria-label')
  } : {};
  const actionElements = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]'));
  const actionBoxes = actionElements.map((element) => ({
    element, text: [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText || element.textContent || ''].join(' ').toLowerCase(),
    rect: element.getBoundingClientRect()
  })).filter((item) => termMatches(item.text, args.actionTerms) && visible(item.element));
  const nodes = Array.from(document.querySelectorAll(args.selector));
  const results = [];
  for (let index = 0; index < nodes.length && results.length < args.maxResults; index += 1) {
    const element = nodes[index];
    const text = element.innerText || element.textContent || '';
    if (!visible(element) || !termMatches(text, args.likeTerms)) continue;
    const parent = element.parentElement;
    const grandparent = parent && parent.parentElement;
    const context = [parent, grandparent].map((node) => node ? (node.innerText || node.textContent || '') : '').join(' ').toLowerCase();
    const ownText = text.trim().toLowerCase();
    const siblings = parent ? Array.from(parent.children) : [];
    const repeatedText = siblings.filter((node) => (node.innerText || node.textContent || '').trim().toLowerCase() === ownText).length > 1;
    const rect = element.getBoundingClientRect();
    const nearActionBar = actionBoxes.some((item) => Math.abs(item.rect.bottom - rect.top) <= 180 && Math.abs(item.rect.left - rect.left) <= 500);
    let clickableAncestor = null;
    let ancestor = parent;
    for (let level = 1; ancestor && level <= 5; level += 1, ancestor = ancestor.parentElement) {
      const tabindex = ancestor.getAttribute('tabindex');
      const tabindexClickable = tabindex !== null && Number(tabindex) >= 0;
      if (ancestor.matches('a[href], button, [role="button"], [role="link"]') || tabindexClickable) {
        clickableAncestor = { ...describe(ancestor), level };
        break;
      }
    }
    results.push({
      dom_index: index, ...describe(element), visible: true,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      parent_tag: parent ? parent.tagName.toLowerCase() : null, parent_role: parent ? parent.getAttribute('role') : null,
      parent_text: parent ? (parent.innerText || parent.textContent || '') : null, parent_href: parent ? parent.getAttribute('href') : null,
      grandparent_tag: grandparent ? grandparent.tagName.toLowerCase() : null, grandparent_role: grandparent ? grandparent.getAttribute('role') : null,
      grandparent_text: grandparent ? (grandparent.innerText || grandparent.textContent || '') : null, grandparent_href: grandparent ? grandparent.getAttribute('href') : null,
      in_main: element.closest('main') !== null, in_article: element.closest('article') !== null,
      clickable_ancestor: clickableAncestor,
      is_comment_like: commentLikePattern.test(ownText),
      has_reply_context: termMatches(context, args.replyTerms),
      has_timestamp_context: timestampPattern.test(context),
      repeated_text: repeatedText,
      near_action_bar: nearActionBar
    });
  }
  return results;
}
"""


ACTION_BAR_SCRIPT = """
(args) => {
  const terms = args.terms;
  const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], div, span'));
  const results = [];
  for (const element of nodes) {
    if (results.length >= args.maxResults) break;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    const text = element.innerText || element.textContent || '';
    const haystack = [element.getAttribute('aria-label'), element.getAttribute('title'), text].join(' ').toLowerCase();
    if (!visible || !terms.some((term) => haystack.includes(term))) continue;
    const parent = element.parentElement;
    results.push({ tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), aria_label: element.getAttribute('aria-label'), title: element.getAttribute('title'), text,
      href: element.getAttribute('href'), box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      parent_text: parent ? (parent.innerText || parent.textContent || '') : null, in_main: element.closest('main') !== null });
  }
  return results;
}
"""


ENGAGEMENT_TEXT_SCRIPT = """
(args) => {
  const body = document.body ? (document.body.innerText || '') : '';
  return body.split(/\\r?\\n/).filter((line) => args.terms.some((term) => line.toLowerCase().includes(term))).slice(0, args.maxLines);
}
"""


def collect_like_text_nodes(page: Page) -> list[dict[str, Any]]:
    """Read bounded post-like text evidence without interacting with the page."""
    raw_items = page.evaluate(LIKE_TEXT_NODES_SCRIPT, {
        "selector": "span, div, section, a, button", "maxResults": MAX_LIKE_TEXT_NODES,
        "likeTerms": LIKE_TEXT_TERMS, "actionTerms": ACTION_BAR_TERMS,
        "replyTerms": COMMENT_REPLY_TERMS, "commentLikePattern": COMMENT_LIKE_RE.pattern,
        "timestampPattern": COMMENT_TIMESTAMP_RE.pattern,
    })
    if not isinstance(raw_items, list):
        return []
    return [item for item in map(sanitize_like_text_node, raw_items) if item]


def collect_action_bar_candidates(page: Page) -> list[dict[str, Any]]:
    """Read visible action-bar labels and geometry without activating controls."""
    raw_items = page.evaluate(ACTION_BAR_SCRIPT, {"terms": ACTION_BAR_TERMS, "maxResults": MAX_ACTION_BAR_CANDIDATES})
    if not isinstance(raw_items, list):
        return []
    return [item for item in map(sanitize_action_bar_candidate, raw_items) if item]


def collect_engagement_text(page: Page) -> list[str]:
    """Read only relevant visible body-text lines, never the full body payload."""
    raw_lines = page.evaluate(ENGAGEMENT_TEXT_SCRIPT, {"terms": ACTION_BAR_TERMS + ("curtid",), "maxLines": MAX_ENGAGEMENT_TEXT_LINES})
    if not isinstance(raw_lines, list):
        return []
    return [text for line in raw_lines if (text := truncate_text(line))]


def safe_count(page: Page, selector: str) -> int | None:
    """Count matches, reporting None instead of guessing when unreadable."""
    try:
        return page.locator(selector).count()
    except PlaywrightError:
        return None


def build_page_summary(
    page: Page,
    media_url: str,
    login_detected: bool,
    stop_code: str | None,
    candidate_total: int,
    candidate_saved: int,
    like_text_nodes: list[dict[str, Any]] | None = None,
    action_bar_candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Summarize page structure only: no HTML, cookies, storage or headers."""
    like_text_nodes = like_text_nodes or []
    action_bar_candidates = action_bar_candidates or []
    return {
        "current_url": sanitize_href(page.url),
        "title": truncate_text(page.title()),
        "article_count": safe_count(page, "article"),
        "dialog_count": safe_count(page, '[role="dialog"]'),
        "button_count": safe_count(page, "button"),
        "link_count": safe_count(page, "a[href]"),
        "login_form_detected": login_detected,
        "blocked_state": stop_code,
        "media_shortcode": media_shortcode_from_url(media_url),
        "candidate_total": candidate_total,
        "candidate_saved": candidate_saved,
        "like_text_nodes_total": len(like_text_nodes),
        "like_text_nodes_saved": len(like_text_nodes),
        "post_like_candidates": sum(item.get("likely_scope") == "post" for item in like_text_nodes),
        "comment_like_candidates": sum(item.get("likely_scope") == "comment" for item in like_text_nodes),
        "unknown_like_candidates": sum(item.get("likely_scope") == "unknown" for item in like_text_nodes),
        "action_bar_candidates": len(action_bar_candidates),
        "collected_at": datetime.now(timezone.utc).isoformat(),
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def wait_for_dom_settle(page: Page) -> None:
    """Let the SPA finish rendering; a slow feed must not fail the run."""
    try:
        page.wait_for_load_state("networkidle", timeout=8_000)
    except TimeoutError:
        pass
    page.wait_for_timeout(1_500)


def write_diagnostics(
    page: Page, media_url: str, login_detected: bool, stop_code: str | None
) -> dict[str, Any]:
    """Persist screenshots plus sanitized structure for the current page only."""
    DIAGNOSTICS_DIR.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SCREENSHOT_PATH))
    full_screenshot: Path | None = FULL_SCREENSHOT_PATH
    try:
        page.screenshot(path=str(FULL_SCREENSHOT_PATH), full_page=True)
    except PlaywrightError:
        full_screenshot = None
    candidates, candidate_total = collect_candidates(page)
    like_text_nodes = collect_like_text_nodes(page)
    action_bar_candidates = collect_action_bar_candidates(page)
    engagement_text = collect_engagement_text(page)
    write_json(CANDIDATES_PATH, candidates)
    write_json(LIKE_TEXT_NODES_PATH, like_text_nodes)
    write_json(ACTION_BAR_CANDIDATES_PATH, action_bar_candidates)
    ENGAGEMENT_TEXT_PATH.write_text(
        "\n".join(engagement_text) + ("\n" if engagement_text else ""), encoding="utf-8"
    )
    write_json(
        PAGE_SUMMARY_PATH,
        build_page_summary(
            page, media_url, login_detected, stop_code, candidate_total, len(candidates),
            like_text_nodes, action_bar_candidates,
        ),
    )
    return {
        "media_url": media_url,
        "screenshot": SCREENSHOT_PATH,
        "full_screenshot": full_screenshot,
        "candidates_path": CANDIDATES_PATH,
        "candidates_saved": len(candidates),
        "candidates_total": candidate_total,
        "like_text_nodes_path": LIKE_TEXT_NODES_PATH,
        "like_text_nodes_saved": len(like_text_nodes),
        "action_bar_candidates_path": ACTION_BAR_CANDIDATES_PATH,
        "action_bar_candidates_saved": len(action_bar_candidates),
        "engagement_text_path": ENGAGEMENT_TEXT_PATH,
        "summary_path": PAGE_SUMMARY_PATH,
    }


def print_summary(
    mode: str,
    session_status: str,
    records: list[dict[str, Any]],
    result: str,
    error_code: str | None = None,
    diagnostics: dict[str, Any] | None = None,
    collection_details: dict[str, str] | None = None,
    post_click_diagnostics: dict[str, Any] | None = None,
) -> None:
    print("=== INSTAGRAM BROWSER COLLECTOR ===")
    print(f"Modo: {mode}")
    print(f"Sessão do navegador: {session_status}")
    if mode == "coleta":
        print("Método: browser_ui")
        print(f"Curtidores coletados: {len(records)}")
        print(f"Curtidores únicos: {len(deduplicate_records(records, MAX_LIKERS))}")
        print(f"JSON: {JSON_PATH}")
        print(f"CSV: {CSV_PATH}")
        if collection_details:
            if collection_details.get("run_id"):
                print(f"Run ID: {collection_details['run_id']}")
            print(f"Action bar: {collection_details.get('action_bar', 'não encontrada')}")
            print(f"Trigger de curtidas: {collection_details.get('trigger', 'não encontrado')}")
            if collection_details.get("activation_method"):
                print(f"Activation method: {collection_details['activation_method']}")
            print(f"Dialog de likers: {collection_details.get('dialog', 'não validado')}")
            if collection_details.get("likers_ui"):
                print(f"Likers UI: {collection_details['likers_ui']}")
            count_labels = {
                "profile_links_before_count": "Profile links before",
                "profile_links_after_count": "Profile links after",
                "new_profile_links_raw_count": "New profile links raw",
                "new_profile_usernames_unique_count": "New profile usernames unique",
                "validated_modal_usernames_count": "Validated modal usernames",
                "final_likers_count": "Final likers",
            }
            for key, label in count_labels.items():
                if key in collection_details:
                    print(f"{label}: {collection_details[key]}")
        if post_click_diagnostics:
            print("Post-click diagnostics: saved")
            print(f"Observed UI: {post_click_diagnostics.get('observed_ui_type', 'unknown')}")
            print(f"New profile links: {post_click_diagnostics.get('new_visible_profile_links_count', 0)}")
    if diagnostics:
        print(f"Media: {diagnostics['media_url']}")
        print(f"Screenshot: {diagnostics['screenshot']}")
        if diagnostics.get("full_screenshot"):
            print(f"Screenshot (página inteira): {diagnostics['full_screenshot']}")
        print(
            f"Candidatos encontrados: {diagnostics['candidates_saved']}"
            f" (de {diagnostics['candidates_total']} inspecionados)"
        )
        print(f"Candidatos: {diagnostics['candidates_path']}")
        print(f"Textos de curtida: {diagnostics['like_text_nodes_path']} ({diagnostics['like_text_nodes_saved']})")
        print(f"Barra de ações: {diagnostics['action_bar_candidates_path']} ({diagnostics['action_bar_candidates_saved']})")
        print(f"Texto de engajamento: {diagnostics['engagement_text_path']}")
        print(f"Resumo da página: {diagnostics['summary_path']}")
    if error_code:
        print(f"Erro: {error_code}")
    if error_code == "browser_challenge_required":
        print("Ação necessária: conclua a verificação manualmente no Instagram oficial e tente novamente depois.")
    if error_code == BROWSER_UNAVAILABLE:
        print("Ação necessária: instale o Google Chrome ou defina IG_BROWSER_EXECUTABLE.")
        print("Alternativa opcional: python -m playwright install chromium")
    print(f"Resultado: {result}")


def run_bootstrap() -> int:
    """Open Instagram for a user-performed login, then preserve the local profile."""
    executable = resolve_browser_executable()
    print_browser_diagnostics(executable)
    phase = "launch"
    try:
        with sync_playwright() as playwright:
            context: BrowserContext | None = None
            try:
                context, browser_label = launch_browser_context(playwright, executable)
                print(f"Browser em uso: {browser_label}")
                phase = "navigation"
                page = page_for_context(context)
                page.goto("https://www.instagram.com/", wait_until="domcontentloaded")
                phase = "authentication"
                print("Faça login manualmente na conta coletora no navegador.")
                input("Após concluir, pressione Enter para validar a sessão: ")
                stop_code = blocked_state(page)
                if stop_code:
                    print_summary("bootstrap", "não disponível", [], "FAIL", stop_code)
                    return 1
                if page_has_login_form(page):
                    print_summary("bootstrap", "não disponível", [], "FAIL", "browser_login_required")
                    return 1
                print_summary("bootstrap", "pronta", [], "PASS")
                return 0
            finally:
                # Inside the with block on purpose: closing after Playwright has
                # stopped raises "Event loop is closed" and can lose the profile.
                if context is not None:
                    close_context_quietly(context)
    except Exception as error:
        print_summary("bootstrap", "não disponível", [], "FAIL", classify_browser_error(error, phase))
        return 1


def run_collection() -> int:
    """Collect likers only through the visible likes-list UI of one media URL."""
    run_id = new_run_id()
    try:
        # Before any navigation: a run that fails must not keep old rows around.
        reset_liker_outputs()
        media_url = get_target_media_url()
        limit = get_likers_limit()
    except ValueError as error:
        print_summary("coleta", "não disponível", [], "FAIL", str(error))
        return 1
    except OSError:
        print_summary("coleta", "não disponível", [], "FAIL", "unknown_error")
        return 1

    # "não disponível" is reserved for: browser did not open, login required, or
    # challenge/checkpoint. A UI failure after that keeps the verified session.
    session_status = "não disponível"
    phase = "launch"
    collection_details = {
        "run_id": run_id, "action_bar": "not found", "trigger": "not found", "dialog": "not validated",
    }
    try:
        with sync_playwright() as playwright:
            context: BrowserContext | None = None
            try:
                context, _ = launch_browser_context(playwright, resolve_browser_executable())
                phase = "navigation"
                page = page_for_context(context)
                page.goto(media_url, wait_until="domcontentloaded")
                phase = "authentication"
                stop_code = blocked_state(page)
                if stop_code:
                    print_summary("coleta", session_status, [], "FAIL", stop_code)
                    return 1
                if page_has_login_form(page):
                    print_summary("coleta", session_status, [], "FAIL", "browser_login_required")
                    return 1
                session_status = "pronta"
                phase = "dialog"
                try:
                    trigger, selection, fingerprint = prepare_safe_liker_trigger(page, run_id)
                except TriggerSelectionError as error:
                    if error.diagnostics.get("action_bar") or error.diagnostics.get("action_bar_context"):
                        collection_details["action_bar"] = "ambiguous"
                    print_summary("coleta", session_status, [], "FAIL", error.code, collection_details=collection_details)
                    return 1
                if selection.get("action_bar"):
                    collection_details["action_bar"] = "found"
                if trigger and selection.get("selection_method") == "action_bar_counter":
                    collection_details["trigger"] = "counter"
                elif trigger:
                    collection_details["trigger"] = "control"
                if not trigger:
                    print_summary("coleta", session_status, [], "FAIL", "likers_dialog_not_found", collection_details=collection_details)
                    return 1
                before_liker_click = collect_post_click_snapshot(page, include_containers=False)
                try:
                    dialog, dialog_error, post_click_diagnostics = open_likers_ui(
                        page, trigger, selection, fingerprint, before_liker_click, run_id
                    )
                except TriggerSelectionError as error:
                    # The audited node changed, so nothing was activated at all.
                    print_summary("coleta", session_status, [], "FAIL", error.code, collection_details=collection_details)
                    return 1
                collection_details["activation_method"] = post_click_diagnostics["activation_method"]
                if dialog_error:
                    print_summary(
                        "coleta", session_status, [], "FAIL", dialog_error,
                        collection_details=collection_details, post_click_diagnostics=post_click_diagnostics,
                    )
                    return 1
                container_type = likers_container_type(dialog, allow_overlay=True) or "unknown"
                collection_details["dialog"] = f"validated ({container_type})"
                collection_details["likers_ui"] = container_type
                after_liker_click = collect_post_click_snapshot(page, include_containers=False)
                base_usernames = profile_usernames_from_snapshot(before_liker_click)
                modal_usernames = profile_usernames_in_dialog(dialog)
                raw_new_links = sum(
                    1 for link in after_liker_click.get("profile_links", [])
                    if isinstance(link, dict) and (username := username_from_profile_href(str(link.get("href") or ""))) and username not in base_usernames
                )
                collection_details["profile_links_before_count"] = str(len(before_liker_click.get("profile_links", [])))
                collection_details["profile_links_after_count"] = str(len(after_liker_click.get("profile_links", [])))
                collection_details["new_profile_links_raw_count"] = str(raw_new_links)
                collection_details["new_profile_usernames_unique_count"] = str(len(new_profile_usernames(before_liker_click, after_liker_click)))
                collection_details["validated_modal_usernames_count"] = str(len(modal_usernames - base_usernames))
                phase = "collection"
                records = collect_likers_from_dialog(page, dialog, media_url, limit, base_usernames)
                collection_details["final_likers_count"] = str(len(records))
                if len(records) < 2:
                    print_summary(
                        "coleta", session_status, [], "FAIL", "likers_dialog_unverified",
                        collection_details=collection_details, post_click_diagnostics=post_click_diagnostics,
                    )
                    return 1
                write_output(records)
                print_summary(
                    "coleta", session_status, records, "PASS",
                    collection_details=collection_details, post_click_diagnostics=post_click_diagnostics,
                )
                return 0
            finally:
                # Inside the with block on purpose: closing after Playwright has
                # stopped raises "Event loop is closed" and can lose the profile.
                if context is not None:
                    close_context_quietly(context)
    except Exception as error:
        print_summary("coleta", session_status, [], "FAIL", classify_browser_error(error, phase))
        return 1


def run_diagnose_likers() -> int:
    """Record read-only evidence about the real post UI; clicks nothing."""
    run_id = new_run_id()
    try:
        media_url = get_target_media_url()
    except ValueError as error:
        print_summary(DIAGNOSE_MODE, "não disponível", [], "FAIL", str(error))
        return 1

    session_status = "não disponível"
    phase = "launch"
    try:
        with sync_playwright() as playwright:
            context: BrowserContext | None = None
            try:
                context, _ = launch_browser_context(playwright, resolve_browser_executable())
                phase = "navigation"
                page = page_for_context(context)
                page.goto(media_url, wait_until="domcontentloaded")
                wait_for_dom_settle(page)
                phase = "authentication"
                stop_code = blocked_state(page)
                if stop_code:
                    print_summary(DIAGNOSE_MODE, session_status, [], "FAIL", stop_code)
                    return 1
                login_detected = page_has_login_form(page)
                if login_detected:
                    print_summary(DIAGNOSE_MODE, session_status, [], "FAIL", "browser_login_required")
                    return 1
                session_status = "pronta"
                phase = "diagnostics"
                clear_trigger_diagnostics()
                print(f"Run ID: {run_id}")
                diagnostics = write_diagnostics(page, media_url, login_detected, stop_code)
                try:
                    trigger, selection, _ = prepare_safe_liker_trigger(page, run_id)
                except TriggerSelectionError as error:
                    print(f"Action bar: {'found' if (error.diagnostics.get('action_bar') or error.diagnostics.get('action_bar_context')) else 'not found'}")
                    print("Safe liker trigger: not selected")
                    print("Dry run: no click")
                    print_summary(DIAGNOSE_MODE, session_status, [], "FAIL", error.code, diagnostics)
                    return 1
                print(f"Action bar: {'found' if selection.get('action_bar') else 'not found'}")
                if not trigger:
                    reasons = selection.get("rejection_reasons") or ["likers_dialog_not_found"]
                    print("Safe liker trigger: not selected")
                    print("Dry run: no click")
                    print_summary(DIAGNOSE_MODE, session_status, [], "FAIL", str(reasons[0]), diagnostics)
                    return 1
                print("Safe liker trigger: selected")
                print(f"Trigger type: {'counter' if selection.get('selection_method') == 'action_bar_counter' else 'control'}")
                print("Dry run: no click")
                print_summary(DIAGNOSE_MODE, session_status, [], "PASS", None, diagnostics)
                return 0
            finally:
                if context is not None:
                    close_context_quietly(context)
    except Exception as error:
        print_summary(DIAGNOSE_MODE, session_status, [], "FAIL", classify_browser_error(error, phase))
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Instagram browser liker collector.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--bootstrap", action="store_true", help="Open the browser for a manual collector-account login.")
    mode.add_argument(
        "--diagnose-likers",
        action="store_true",
        help="Save read-only evidence about the post UI without clicking anything.",
    )
    args = parser.parse_args()
    if args.bootstrap:
        return run_bootstrap()
    if args.diagnose_likers:
        return run_diagnose_likers()
    return run_collection()


if __name__ == "__main__":
    sys.exit(main())
