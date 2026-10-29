"""Unit tests for the read-only post-like diagnostics."""

from __future__ import annotations

import csv
import importlib.util
import inspect
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).with_name("browser_collector.py")
# The diagnostics tests do not launch a browser. Provide import-time type stubs
# when Playwright is not installed in the local test interpreter.
if "playwright.sync_api" not in sys.modules:
    playwright = types.ModuleType("playwright")
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.BrowserContext = object
    sync_api.ElementHandle = object
    sync_api.Error = Exception
    sync_api.Locator = object
    sync_api.Page = object
    sync_api.Playwright = object
    sync_api.TimeoutError = TimeoutError
    sync_api.sync_playwright = lambda: None
    sys.modules["playwright"] = playwright
    sys.modules["playwright.sync_api"] = sync_api
SPEC = importlib.util.spec_from_file_location("browser_collector", MODULE_PATH)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)

POST_URL = "https://www.instagram.com/p/example/"
PROFILE_URL = "https://www.instagram.com/thaysecarlab/"
# The real approved trigger: the post counter span, with no href of its own.
APPROVED_SELECTION = {"selection_method": "action_bar_counter", "action_bar": {"tag": "div", "text": "161 25 8"}}
APPROVED_INSPECTION = {
    "trigger": {"tag": "span", "role": "button", "text": "161", "box": {}},
    "clickable": {"tag": "span", "role": "button", "text": "161", "box": {}},
    "ancestor_chain": [
        {"level": 0, "tag": "span", "role": "button", "text": "161"},
        {"level": 1, "tag": "div", "text": "161 25 8"},
    ],
}


def executable_source(function: object) -> str:
    """Return a function's source without its docstring, so prose cannot pass a check."""
    source = inspect.getsource(function)
    docstring = getattr(function, "__doc__", None)
    return source.replace(docstring, "") if docstring else source


class FakePage:
    """Minimal page double that records DOM reads but exposes no action methods."""

    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.scripts: list[str] = []

    def evaluate(self, script: str, _args: object) -> object:
        self.scripts.append(script)
        return self.responses[script]


class FakeLocator:
    def __init__(self, visible: bool = True, href: str | None = None, text: str | None = None, evaluation: object = None) -> None:
        self.visible = visible
        self.href = href
        self.text = text
        self.evaluation = evaluation

    def is_visible(self) -> bool:
        return self.visible

    def get_attribute(self, name: str) -> str | None:
        return self.href if name == "href" else None

    def inner_text(self) -> str:
        return self.text or ""

    def evaluate(self, _script: str) -> object:
        return self.evaluation

    def element_handle(self, **_kwargs: object) -> "FakeLocator":
        # The audited node and the activated node must be the same object.
        return self

    def click(self, **_kwargs: object) -> None:
        raise AssertionError("pointer click is forbidden on the liker trigger")


class FakeLocatorList:
    def __init__(self, items: list[FakeLocator]) -> None:
        self.items = items

    def nth(self, index: int) -> FakeLocator:
        return self.items[index]

    def all(self) -> list[FakeLocator]:
        return self.items

    @property
    def last(self) -> FakeLocator:
        return self.items[-1]


class FakeSelectionPage(FakePage):
    def __init__(self, response: dict[str, object]) -> None:
        super().__init__({collector.TRIGGER_SELECTION_SCRIPT: response})

    def locator(self, _selector: str) -> FakeLocatorList:
        return FakeLocatorList([FakeLocator(), FakeLocator(), FakeLocator()])


class FakePreparedPage:
    def __init__(self, selection: dict[str, object], inspection: dict[str, object]) -> None:
        self.selection = selection
        self.inspection = inspection
        self.scripts: list[str] = []

    def evaluate(self, script: str, _args: object) -> object:
        self.scripts.append(script)
        if script == collector.ACTION_BAR_COUNTERS_SCRIPT:
            return [{"text": "161", "tag": "span", "clickable": True}]
        assert script == collector.TRIGGER_SELECTION_SCRIPT
        return self.selection

    def locator(self, _selector: str) -> FakeLocatorList:
        return FakeLocatorList([FakeLocator(evaluation=self.inspection), FakeLocator(evaluation=self.inspection)])


class FakeDialog:
    def __init__(self, hrefs: list[str], role: str | None = "dialog", aria_modal: str | None = None, label: str | None = None, style: dict[str, str] | None = None) -> None:
        self.links = FakeLocatorList([
            FakeLocator(href=item[0], text=item[1]) if isinstance(item, tuple) else FakeLocator(href=item)
            for item in hrefs
        ])
        self.role = role
        self.aria_modal = aria_modal
        self.label = label
        self.style = style

    def locator(self, _selector: str) -> FakeLocatorList:
        return self.links

    def is_visible(self) -> bool:
        return True

    def get_attribute(self, name: str) -> str | None:
        return {"role": self.role, "aria-modal": self.aria_modal, "aria-label": self.label, "title": None}.get(name)

    def wait_for(self, **_kwargs: object) -> None:
        return None

    def evaluate(self, _script: str) -> dict[str, str] | None:
        return self.style


class FakeContainerPage:
    def __init__(self, container: FakeDialog) -> None:
        self.container = container

    def locator(self, selector: str) -> FakeLocatorList:
        if selector == '[role="dialog"]':
            return FakeLocatorList([self.container] if self.container.role == "dialog" else [])
        if selector == '[aria-modal="true"]':
            return FakeLocatorList([self.container] if self.container.aria_modal == "true" else [])
        if selector == '[role="dialog"], [aria-modal="true"]':
            return FakeLocatorList([self.container])
        if selector == "div":
            return FakeLocatorList([self.container] if self.container.style else [])
        return FakeLocatorList([])


class FakePrioritizedContainerPage:
    def __init__(self, aria_modal: FakeDialog, role_dialog: FakeDialog) -> None:
        self.aria_modal = aria_modal
        self.role_dialog = role_dialog

    def locator(self, selector: str) -> FakeLocatorList:
        if selector == '[role="dialog"], [aria-modal="true"]':
            return FakeLocatorList([self.role_dialog, self.aria_modal])
        if selector == '[aria-modal="true"]':
            return FakeLocatorList([self.aria_modal])
        if selector == '[role="dialog"]':
            return FakeLocatorList([self.role_dialog])
        return FakeLocatorList([])


class FakeCollectionPage:
    def wait_for_timeout(self, _milliseconds: int) -> None:
        return None


class FakePostClickPage:
    def __init__(self, after: dict[str, object], url: str = POST_URL) -> None:
        self.url = url
        self.after = after
        self.screenshots: list[str] = []

    def evaluate(self, script: str, _args: object) -> dict[str, object]:
        assert script == collector.POST_CLICK_SNAPSHOT_SCRIPT
        return self.after

    def screenshot(self, path: str) -> None:
        self.screenshots.append(path)


class FakeTriggerHandle:
    """Pinned-node double: counts DOM activations and rejects pointer input."""

    def __init__(self, inspections: list[dict[str, object]]) -> None:
        self.inspections = inspections
        self.inspections_read = 0
        self.dom_clicks = 0

    def evaluate(self, script: str, *_args: object) -> object:
        if script == collector.DOM_CLICK_SCRIPT:
            self.dom_clicks += 1
            return None
        assert script == collector.TRIGGER_INSPECTION_SCRIPT
        self.inspections_read += 1
        return self.inspections[min(self.inspections_read - 1, len(self.inspections) - 1)]

    def click(self, **_kwargs: object) -> None:
        raise AssertionError("pointer click is forbidden on the liker trigger")


class FakeActivationPage:
    """Page double with no pointer API: reading page.mouse fails the test."""

    def __init__(self, urls: list[str]) -> None:
        self.urls = urls
        self.waits: list[int] = []

    @property
    def url(self) -> str:
        return self.urls[min(len(self.waits), len(self.urls) - 1)]

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.waits.append(milliseconds)

    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"forbidden page API: {name}")


def approved_activation_setup(urls: list[str]) -> tuple[FakeActivationPage, FakeTriggerHandle, dict[str, object]]:
    """Build the audited-node fixture exactly as prepare/activate would see it."""
    handle = FakeTriggerHandle([APPROVED_INSPECTION])
    fingerprint = collector.trigger_fingerprint(
        collector.inspect_selected_liker_trigger(handle, APPROVED_SELECTION)
    )
    return FakeActivationPage(urls), handle, fingerprint


class LikeDiagnosticsTests(unittest.TestCase):
    def test_repeated_comment_like_is_never_automatically_post(self) -> None:
        self.assertEqual(
            collector.classify_like_scope({"text": "1 curtida", "repeated_text": True}),
            "comment",
        )
        self.assertEqual(collector.classify_like_scope({"text": "1 curtida"}), "comment")

    def test_unique_counter_near_action_bar_can_be_post(self) -> None:
        self.assertEqual(
            collector.classify_like_scope({"text": "42 curtidas", "near_action_bar": True}),
            "post",
        )

    def test_clickable_ancestor_is_bounded_to_five_levels(self) -> None:
        raw = {"tag": "a", "role": "link", "href": "/p/example/?secret=discard", "text": "42 curtidas", "aria_label": "Curtidas", "level": 5}
        self.assertEqual(collector.sanitize_clickable_ancestor(raw)["level"], 5)
        self.assertIsNone(collector.sanitize_clickable_ancestor({**raw, "level": 6}))

    def test_like_text_sanitizer_caps_text_and_excludes_sensitive_fields(self) -> None:
        node = collector.sanitize_like_text_node({
            "dom_index": 3, "tag": "span", "text": "x" * 200, "visible": True,
            "box": {"x": 1, "y": 2, "width": 3, "height": 4}, "cookie": "secret",
            "storage": "secret", "token": "secret", "near_action_bar": False,
        })
        assert node is not None
        self.assertEqual(len(node["text"]), 150)
        self.assertNotIn("cookie", node)
        self.assertNotIn("storage", node)
        self.assertNotIn("token", node)

    def test_collectors_use_only_evaluate_and_never_action_methods(self) -> None:
        raw_like = {"dom_index": 0, "tag": "span", "text": "1 curtida", "visible": True, "box": {}}
        raw_action = {"tag": "button", "aria_label": "Curtir", "visible": True, "box": {}}
        page = FakePage({
            collector.LIKE_TEXT_NODES_SCRIPT: [raw_like],
            collector.ACTION_BAR_SCRIPT: [raw_action],
            collector.ENGAGEMENT_TEXT_SCRIPT: ["42 curtidas", "Comentar"],
        })
        self.assertEqual(len(collector.collect_like_text_nodes(page)), 1)
        self.assertEqual(len(collector.collect_action_bar_candidates(page)), 1)
        self.assertEqual(collector.collect_engagement_text(page), ["42 curtidas", "Comentar"])
        self.assertEqual(len(page.scripts), 3)
        for script in page.scripts:
            self.assertNotIn(".click(", script)
            self.assertNotIn(".fill(", script)
            self.assertNotIn(".press(", script)


class LikerCollectionTests(unittest.TestCase):
    def test_action_bar_counter_is_selected_and_comment_likes_are_excluded(self) -> None:
        selected = {
            "status": "found", "selection_method": "action_bar_counter",
            "action_bar": {"tag": "div", "text": "161 25 8"},
            "trigger": {"tag": "a", "text": "161", "parent_text": "161 25 8"},
            "target_index": 1, "rejection_reasons": [],
        }
        with patch.object(collector, "write_json"):
            trigger, selection = collector.select_likers_trigger(FakeSelectionPage(selected))
            self.assertIsNotNone(trigger)
            self.assertEqual(selection["selection_method"], "action_bar_counter")

            comment = {**selected, "trigger": {"tag": "a", "text": "1 curtida", "parent_text": "1 curtida Responder"}}
            trigger, selection = collector.select_likers_trigger(FakeSelectionPage(comment))
            self.assertIsNone(trigger)
            self.assertEqual(selection["rejection_reasons"], ["comment_like_context"])

    def test_like_button_and_ambiguous_action_bar_fail_closed(self) -> None:
        unsafe = {"status": "found", "trigger": {"tag": "button", "aria_label": "Curtir"}, "target_index": 0}
        ambiguous = {"status": "post_action_bar_ambiguous", "rejection_reasons": ["multiple_structural_action_bars"]}
        with patch.object(collector, "write_json"):
            with self.assertRaisesRegex(collector.TriggerSelectionError, "unsafe_like_button_candidate"):
                collector.select_likers_trigger(FakeSelectionPage(unsafe))
            with self.assertRaisesRegex(collector.TriggerSelectionError, "post_action_bar_ambiguous"):
                collector.select_likers_trigger(FakeSelectionPage(ambiguous))

    def test_likers_dialog_requires_multiple_profile_links(self) -> None:
        self.assertFalse(collector.is_likers_dialog(FakeDialog(["/not-a-profile/", "/accounts/login/"])))
        self.assertFalse(collector.is_likers_dialog(FakeDialog(["/alice/"])))
        self.assertTrue(collector.is_likers_dialog(FakeDialog(["/alice/", "/bob/"])))

    def test_aria_modal_supports_new_profile_delta_but_rejects_generic_or_old_ui(self) -> None:
        aria_modal = FakeDialog(["/alice/", "/bob/", "/carol/"], role=None, aria_modal="true")
        self.assertTrue(collector.is_likers_dialog(aria_modal, before_usernames={"nav"}))
        self.assertFalse(collector.is_likers_dialog(FakeDialog(["/alice/"], role=None, aria_modal="true")))
        self.assertFalse(collector.is_likers_dialog(FakeDialog(["/alice/", "/bob/"], role=None, aria_modal="true", label="Compartilhar")))
        self.assertFalse(collector.is_likers_dialog(aria_modal, before_usernames={"alice", "bob", "carol"}))

    def test_wait_prefers_supported_aria_modal_after_click(self) -> None:
        aria_modal = FakeDialog(["/alice/", "/bob/", "/carol/"], role=None, aria_modal="true")
        before = {"profile_links": [{"href": "/alice/"}]}
        self.assertIs(collector.wait_for_likers_dialog(FakeContainerPage(aria_modal), before), aria_modal)

    def test_wait_accepts_only_a_profile_backed_fixed_overlay_fallback(self) -> None:
        overlay = FakeDialog(["/alice/", "/bob/", "/carol/"], role=None, style={"position": "fixed", "zIndex": "100", "width": "600", "height": "500", "viewportWidth": "1200", "viewportHeight": "900"})
        before = {"profile_links": [{"href": "/alice/"}]}
        self.assertIs(collector.wait_for_likers_dialog(FakeContainerPage(overlay), before), overlay)

    def test_aria_modal_always_wins_over_a_valid_role_dialog(self) -> None:
        aria_modal = FakeDialog(["/liker1/", "/liker2/", "/liker3/"], role=None, aria_modal="true")
        role_dialog = FakeDialog(["/other1/", "/other2/", "/other3/"])
        before = {"profile_links": [{"href": "/existing/"}]}
        self.assertIs(collector.wait_for_likers_dialog(FakePrioritizedContainerPage(aria_modal, role_dialog), before), aria_modal)

    def test_baseline_excludes_background_and_comment_profiles_from_final_rows(self) -> None:
        background = ["automacaolikess", "phiq.oficial", "ssombra68", "simonedamascen", "inacelly_silvestre", "_sue.len", "daniel.epa"]
        dialog = FakeDialog([f"/{username}/" for username in [*background, "liker1", "liker2", "liker3"]])
        with patch.object(collector, "profile_link_is_in_user_row", return_value=True), \
             patch.object(collector, "record_from_profile_link", side_effect=lambda link, *_: {"username": collector.username_from_profile_href(link.get_attribute("href"))}):
            records = collector.collect_visible_likers(dialog, "https://www.instagram.com/p/example/", "now", set(background))
        self.assertEqual([record["username"] for record in records], ["liker1", "liker2", "liker3"])

    def test_overlay_that_covers_the_viewport_fails_closed(self) -> None:
        broad_overlay = FakeDialog(["/liker1/", "/liker2/", "/liker3/"], role=None, style={"position": "fixed", "zIndex": "100", "width": "1200", "height": "900", "viewportWidth": "1200", "viewportHeight": "900"})
        self.assertFalse(collector.is_likers_dialog(broad_overlay, before_usernames={"existing"}, allow_overlay=True))

    def test_modal_delta_deduplicates_avatar_and_username_links_without_rows(self) -> None:
        dialog = FakeDialog([
            ("/liker1/", ""), ("/liker1/", "liker1"),
            ("/liker2/", ""), ("/liker2/", "liker2"),
            ("/phiq.oficial/", "phiq.oficial"),
        ], role=None, aria_modal="true")
        with patch.object(collector, "record_from_profile_link", side_effect=lambda link, *_: {"username": collector.username_from_profile_href(link.get_attribute("href"))}):
            records = collector.collect_visible_likers(dialog, "https://www.instagram.com/p/example/", "now", {"phiq.oficial", "commenter1"})
        self.assertEqual([record["username"] for record in records], ["liker1", "liker2"])

    def test_duplicate_href_pairs_do_not_satisfy_two_unique_modal_users(self) -> None:
        duplicate_only = FakeDialog(["/liker1/", "/liker1/"], role=None, aria_modal="true")
        self.assertFalse(collector.is_likers_dialog(duplicate_only, before_usernames={"existing"}))

    def test_trigger_profile_navigation_is_rejected_before_click(self) -> None:
        inspection = {
            "trigger": {"tag": "div", "text": "161", "box": {}},
            "clickable": {"tag": "a", "href": "/thaysecarlab/", "text": "161", "box": {}},
            "ancestor_chain": [{"level": 0, "tag": "div", "text": "161"}, {"level": 1, "tag": "a", "href": "/thaysecarlab/", "text": "161"}],
        }
        diagnostics = collector.inspect_selected_liker_trigger(FakeLocator(evaluation=inspection), {"selection_method": "action_bar_counter", "action_bar": {"tag": "div", "text": "161 25 8"}})
        self.assertTrue(collector.trigger_has_unsafe_navigation(diagnostics))
        self.assertEqual(diagnostics["trigger_type"], "action_bar_counter")

    def test_safe_counter_and_post_url_guard(self) -> None:
        inspection = {
            "trigger": {"tag": "div", "text": "161", "box": {}},
            "clickable": {"tag": "button", "role": "button", "text": "161", "box": {}},
            "ancestor_chain": [{"level": 0, "tag": "button", "role": "button", "text": "161"}],
        }
        diagnostics = collector.inspect_selected_liker_trigger(FakeLocator(evaluation=inspection), {"selection_method": "action_bar_counter"})
        self.assertFalse(collector.trigger_has_unsafe_navigation(diagnostics))
        self.assertTrue(collector.is_instagram_profile_url("https://www.instagram.com/thaysecarlab/"))
        self.assertFalse(collector.is_instagram_profile_url("https://www.instagram.com/p/example/"))

    def test_trigger_and_counter_diagnostics_are_sanitized(self) -> None:
        counter = collector.sanitize_action_bar_counter({"text": "161", "tag": "span", "clickable": True, "clickable_href": "/liked_by/", "relative_dom_order": 1, "ancestor_summary": [{"level": 0, "tag": "span", "token": "secret"}], "cookie": "secret"})
        assert counter is not None
        self.assertEqual(counter["text"], "161")
        self.assertNotIn("cookie", counter)
        self.assertNotIn("token", counter["ancestor_summary"][0])

    def test_shared_prepare_writes_dry_run_diagnostics_without_click(self) -> None:
        selection = {"status": "found", "selection_method": "action_bar_counter", "action_bar": {"tag": "div", "text": "161 25 8"}, "trigger": {"tag": "button", "text": "161"}, "target_index": 0}
        inspection = {"trigger": {"tag": "button", "text": "161", "box": {}}, "clickable": {"tag": "button", "text": "161", "box": {}}, "ancestor_chain": [{"level": 0, "tag": "button", "text": "161"}]}
        page = FakePreparedPage(selection, inspection)
        with patch.object(collector, "write_json") as write_json:
            trigger, returned_selection, fingerprint = collector.prepare_safe_liker_trigger(page)
        self.assertIsNotNone(trigger)
        self.assertEqual(returned_selection["selection_method"], "action_bar_counter")
        self.assertEqual(fingerprint["text"], "161")
        self.assertEqual(write_json.call_count, 2)
        self.assertNotIn(".click(", "\n".join(page.scripts))

    def test_shared_prepare_rejects_profile_target_without_selected_file(self) -> None:
        selection = {"status": "found", "selection_method": "action_bar_counter", "trigger": {"tag": "a", "text": "161"}, "target_index": 0}
        inspection = {"trigger": {"tag": "a", "href": "/profile/", "text": "161", "box": {}}, "clickable": {"tag": "a", "href": "/profile/", "text": "161", "box": {}}, "ancestor_chain": [{"level": 0, "tag": "a", "href": "/profile/", "text": "161"}]}
        with patch.object(collector, "write_json") as write_json:
            with self.assertRaisesRegex(collector.TriggerSelectionError, "unsafe_profile_navigation_trigger"):
                collector.prepare_safe_liker_trigger(FakePreparedPage(selection, inspection))
        written_paths = [call.args[0] for call in write_json.call_args_list]
        self.assertIn(collector.ACTION_BAR_COUNTERS_PATH, written_paths)
        self.assertNotIn(collector.SELECTED_LIKER_TRIGGER_PATH, written_paths)

    def test_dry_run_clears_only_stale_trigger_diagnostics(self) -> None:
        counters = MagicMock()
        selected = MagicMock()
        with patch.object(collector, "ACTION_BAR_COUNTERS_PATH", counters), patch.object(collector, "SELECTED_LIKER_TRIGGER_PATH", selected):
            collector.clear_trigger_diagnostics()
        counters.unlink.assert_called_once_with(missing_ok=True)
        selected.unlink.assert_called_once_with(missing_ok=True)
        source = inspect.getsource(collector.run_diagnose_likers)
        self.assertIn("prepare_safe_liker_trigger(page, run_id)", source)
        self.assertNotIn("trigger.click()", source)
        self.assertNotIn("activate_safe_liker_trigger", source)

    def test_baseline_delta_remains_fixed_across_new_modal_profiles(self) -> None:
        before = {"profile_links": [{"href": "/phiq.oficial/"}, {"href": "/commenter1/"}]}
        after = {"profile_links": [{"href": "/phiq.oficial/"}, {"href": "/commenter1/"}, {"href": "/liker1/"}, {"href": "/liker2/"}]}
        self.assertEqual(collector.new_profile_usernames(before, after), {"liker1", "liker2"})

    def test_full_name_never_uses_profile_action_text(self) -> None:
        self.assertIsNone(collector.sanitize_full_name("Seguir", "alice"))
        self.assertIsNone(collector.sanitize_full_name("Following", "alice"))
        self.assertEqual(collector.sanitize_full_name("Alice Silva", "alice"), "Alice Silva")

    def test_deduplication_and_absolute_limit(self) -> None:
        records = [
            {"username": f"user{index}", "user_id": str(index // 2)}
            for index in range(50)
        ]
        deduplicated = collector.deduplicate_records(records, collector.MAX_LIKERS)
        self.assertEqual(len(deduplicated), 20)
        self.assertEqual(deduplicated[0]["user_id"], "0")

    def test_modal_scroll_stops_after_reaching_limit(self) -> None:
        batches = [
            [{"username": f"user{index}", "user_id": str(index)} for index in range(10)],
            [{"username": f"user{index}", "user_id": str(index)} for index in range(10, 21)],
        ]
        with patch.object(collector, "blocked_state", return_value=None), \
             patch.object(collector, "collect_visible_likers", side_effect=batches), \
             patch.object(collector, "scroll_dialog_once") as scroll:
            records = collector.collect_likers_from_dialog(FakeCollectionPage(), object(), "https://www.instagram.com/p/example/", 20)
        self.assertEqual(len(records), 20)
        self.assertEqual(scroll.call_count, 1)

    def test_selection_script_has_no_write_actions(self) -> None:
        for method in (".click(", ".fill(", ".press(", ".hover("):
            self.assertNotIn(method, collector.TRIGGER_SELECTION_SCRIPT)


class PostClickDiagnosticsTests(unittest.TestCase):
    @staticmethod
    def snapshot(url: str = "/p/example/", **overrides: object) -> dict[str, object]:
        snapshot: dict[str, object] = {
            "url": url, "dialog_count": 0, "aria_modal_count": 0,
            "visible_links": 5, "profile_links": [], "containers": [],
        }
        snapshot.update(overrides)
        return snapshot

    @staticmethod
    def profile(username: str) -> dict[str, object]:
        return {"href": f"/{username}/", "text": username, "aria_label": None, "visible": True, "bounding_box": None}

    def test_ui_classifications_cover_dialog_modal_overlay_navigation_and_no_change(self) -> None:
        before = self.snapshot()
        dialog = self.snapshot(dialog_count=1, profile_links=[self.profile("alice")], containers=[{"role": "dialog", "profile_link_count": 2}])
        modal = self.snapshot(aria_modal_count=1, profile_links=[self.profile("alice")], containers=[{"role": None, "profile_link_count": 2}])
        overlay = self.snapshot(profile_links=[self.profile("alice")], containers=[{"role": None, "position": "fixed", "profile_link_count": 2}])
        navigation = self.snapshot(url="/p/other/")
        self.assertEqual(collector.build_post_click_diagnostics(before, dialog)["observed_ui_type"], "role_dialog")
        self.assertEqual(collector.build_post_click_diagnostics(before, modal)["observed_ui_type"], "aria_modal")
        self.assertEqual(collector.build_post_click_diagnostics(before, overlay)["observed_ui_type"], "overlay")
        self.assertEqual(collector.build_post_click_diagnostics(before, navigation)["observed_ui_type"], "navigation")
        self.assertEqual(collector.build_post_click_diagnostics(before, self.snapshot())["observed_ui_type"], "no_change")

    def test_non_profile_routes_are_not_saved_as_profiles(self) -> None:
        for href in ("/p/example/", "/reel/example/", "/reels/example/", "/direct/", "#", "javascript:void(0)", "?next=/alice/"):
            self.assertIsNone(collector.sanitize_post_click_profile_link({"href": href, "visible": True}))
        self.assertIsNotNone(collector.sanitize_post_click_profile_link({"href": "/alice/", "visible": True}))

    def test_post_click_output_is_bounded_and_contains_no_sensitive_input(self) -> None:
        profiles = [self.profile(f"user{index}") for index in range(150)]
        containers = [{"tag": "div", "text": "x", "profile_link_count": 2} for _ in range(75)]
        payload = collector.build_post_click_diagnostics(self.snapshot(), self.snapshot(profile_links=profiles, containers=containers))
        self.assertEqual(len(payload["new_visible_profile_links"]), 100)
        self.assertEqual(len(payload["containers"]), 50)
        sanitized = collector.sanitize_post_click_container({"tag": "div", "text": "x", "token": "secret", "cookie": "secret"})
        assert sanitized is not None
        self.assertNotIn("token", sanitized)
        self.assertNotIn("cookie", sanitized)

    def test_post_click_read_is_action_free_and_collection_has_one_activation(self) -> None:
        for method in (".click(", ".fill(", ".press(", ".hover("):
            self.assertNotIn(method, collector.POST_CLICK_SNAPSHOT_SCRIPT)
        self.assertEqual(inspect.getsource(collector.run_collection).count("open_likers_ui("), 1)
        self.assertEqual(executable_source(collector.open_likers_ui).count("activate_safe_liker_trigger("), 1)

    def test_resolve_likers_dialog_reports_both_dialog_failure_codes(self) -> None:
        for code in ("likers_dialog_not_found", "likers_dialog_unverified"):
            with patch.object(collector, "wait_for_likers_dialog", side_effect=RuntimeError(code)):
                dialog, error = collector.resolve_likers_dialog(object(), {})
            self.assertIsNone(dialog)
            self.assertEqual(error, code)
        source = inspect.getsource(collector.open_likers_ui)
        self.assertEqual(source.count("resolve_likers_dialog(page, before_snapshot)"), 1)

    def test_every_post_click_outcome_saves_current_evidence(self) -> None:
        raw_after = {
            "dialog_count": 0, "aria_modal_count": 0, "visible_links": 6,
            "profile_links": [{"href": "/alice/", "text": "Alice", "visible": True, "box": {}}],
            "containers": [{"tag": "div", "position": "fixed", "z_index": "10", "profile_link_count": 1}],
        }
        before = self.snapshot()
        activation = {"activation_method": "dom_click", "before_url": POST_URL, "after_url": POST_URL}
        with patch.object(collector, "write_json") as write_json:
            for url in (POST_URL, PROFILE_URL):
                page = FakePostClickPage(raw_after, url=url)
                payload = collector.write_post_click_diagnostics(page, before, activation, "run-1")
                self.assertEqual(len(page.screenshots), 1)
                self.assertEqual(payload["new_visible_profile_links_count"], 1)
                self.assertEqual(payload["activation_method"], "dom_click")
                self.assertEqual(payload["run_id"], "run-1")
        self.assertEqual(write_json.call_count, 2)
        self.assertEqual(write_json.call_args.args[0], collector.AFTER_LIKER_CLICK_PATH)


class SafeDomActivationTests(unittest.TestCase):
    def test_approved_trigger_is_activated_by_exactly_one_dom_click(self) -> None:
        page, handle, fingerprint = approved_activation_setup([POST_URL])
        activation = collector.activate_safe_liker_trigger(page, handle, APPROVED_SELECTION, fingerprint)
        self.assertEqual(handle.dom_clicks, 1)
        self.assertEqual(activation["activation_method"], "dom_click")
        self.assertEqual(page.waits, [collector.POST_CLICK_WAIT_MS])
        self.assertEqual(collector.DOM_CLICK_SCRIPT, "(element) => { element.click(); }")

    def test_pointer_click_and_mouse_api_never_reach_the_trigger(self) -> None:
        page, handle, fingerprint = approved_activation_setup([POST_URL])
        collector.activate_safe_liker_trigger(page, handle, APPROVED_SELECTION, fingerprint)
        with self.assertRaises(AssertionError):
            handle.click()
        with self.assertRaises(AssertionError):
            page.mouse  # noqa: B018 - proves the collector never touches this API
        activation_source = executable_source(collector.activate_safe_liker_trigger)
        for source in (executable_source(collector.run_collection), activation_source):
            for forbidden in (".click(", ".fill(", ".press(", ".type(", ".hover(", "mouse", "keyboard"):
                self.assertNotIn(forbidden, source)
        self.assertEqual(activation_source.count("DOM_CLICK_SCRIPT"), 1)

    def test_changed_fingerprint_blocks_the_activation_without_clicking(self) -> None:
        navigating = {
            "trigger": {"tag": "a", "text": "161", "href": "/thaysecarlab/", "box": {}},
            "clickable": {"tag": "a", "text": "161", "href": "/thaysecarlab/", "box": {}},
            "ancestor_chain": [{"level": 0, "tag": "a", "href": "/thaysecarlab/", "text": "161"}],
        }
        renumbered = {
            **APPROVED_INSPECTION,
            "trigger": {"tag": "span", "role": "button", "text": "162", "box": {}},
            "clickable": {"tag": "span", "role": "button", "text": "162", "box": {}},
        }
        for changed in (navigating, renumbered):
            handle = FakeTriggerHandle([APPROVED_INSPECTION, changed])
            fingerprint = collector.trigger_fingerprint(
                collector.inspect_selected_liker_trigger(handle, APPROVED_SELECTION)
            )
            page = FakeActivationPage([POST_URL])
            with self.assertRaisesRegex(collector.TriggerSelectionError, "liker_trigger_changed_before_click"):
                collector.activate_safe_liker_trigger(page, handle, APPROVED_SELECTION, fingerprint)
            self.assertEqual(handle.dom_clicks, 0)
            self.assertEqual(page.waits, [])

    def test_revalidation_compares_the_same_node_without_hardcoded_counts(self) -> None:
        page = FakePreparedPage(
            {"status": "found", "selection_method": "action_bar_counter", "action_bar": {"tag": "div", "text": "161 25 8"},
             "trigger": {"tag": "span", "text": "161"}, "target_index": 0},
            APPROVED_INSPECTION,
        )
        with patch.object(collector, "write_json"):
            _, _, fingerprint = collector.prepare_safe_liker_trigger(page, "run-7")
        # prepare must audit and return the pinned handle, never the lazy locator.
        prepare_source = executable_source(collector.prepare_safe_liker_trigger)
        self.assertIn("handle = trigger_element_handle(trigger)", prepare_source)
        self.assertIn("inspect_selected_liker_trigger(handle, selection)", prepare_source)
        self.assertNotIn("inspect_selected_liker_trigger(trigger", prepare_source)
        self.assertIn("return handle, selection, trigger_fingerprint(diagnostics)", prepare_source)
        self.assertEqual(fingerprint["tag"], "span")
        self.assertEqual(fingerprint["role"], "button")
        self.assertEqual(fingerprint["text"], "161")
        self.assertIsNone(fingerprint["href"])
        self.assertEqual([item["level"] for item in fingerprint["ancestor_chain"]], [0, 1])
        for function in (collector.trigger_fingerprint, collector.activate_safe_liker_trigger):
            self.assertNotIn("161", inspect.getsource(function))

    def test_dom_click_that_opens_an_aria_modal_continues_to_collection(self) -> None:
        aria_modal = FakeDialog(["/liker1/", "/liker2/", "/liker3/"], role=None, aria_modal="true")
        dialog, error = collector.resolve_likers_dialog(
            FakeContainerPage(aria_modal), {"profile_links": [{"href": "/phiq.oficial/"}]}
        )
        self.assertIs(dialog, aria_modal)
        self.assertIsNone(error)

    def test_dom_click_that_keeps_the_post_url_is_never_unsafe(self) -> None:
        page, handle, fingerprint = approved_activation_setup([POST_URL])
        activation = collector.activate_safe_liker_trigger(page, handle, APPROVED_SELECTION, fingerprint)
        self.assertEqual(activation["before_url"], POST_URL)
        self.assertEqual(activation["after_url"], POST_URL)
        self.assertFalse(collector.unsafe_navigation_after_click(activation))

    def test_every_post_click_outcome_writes_this_runs_evidence_exactly_once(self) -> None:
        outcomes = (
            ([POST_URL, PROFILE_URL], (None, None), "unsafe_profile_navigation_after_click", 0),
            ([POST_URL], (None, "likers_dialog_not_found"), "likers_dialog_not_found", 1),
            ([POST_URL], (None, "likers_dialog_unverified"), "likers_dialog_unverified", 1),
            ([POST_URL], ("validated-dialog", None), None, 1),
        )
        for urls, resolved, expected_error, resolve_calls in outcomes:
            page, handle, fingerprint = approved_activation_setup(urls)
            with patch.object(collector, "resolve_likers_dialog", return_value=resolved) as resolve, \
                 patch.object(collector, "write_post_click_diagnostics", return_value={"activation_method": "dom_click"}) as write:
                dialog, error, diagnostics = collector.open_likers_ui(
                    page, handle, APPROVED_SELECTION, fingerprint, {"url": POST_URL}, "run-1"
                )
            self.assertEqual(error, expected_error)
            self.assertEqual(dialog, resolved[0] if expected_error != "unsafe_profile_navigation_after_click" else None)
            self.assertEqual(handle.dom_clicks, 1)
            # Saved for every outcome, and never on a page we only navigated to.
            self.assertEqual(write.call_count, 1)
            self.assertEqual(write.call_args.args[3], "run-1")
            self.assertEqual(diagnostics["activation_method"], "dom_click")
            self.assertEqual(resolve.call_count, resolve_calls)

    def test_dom_click_that_navigates_to_a_profile_is_reported_as_unsafe(self) -> None:
        page, handle, fingerprint = approved_activation_setup([POST_URL, PROFILE_URL])
        activation = collector.activate_safe_liker_trigger(page, handle, APPROVED_SELECTION, fingerprint)
        self.assertEqual(handle.dom_clicks, 1)
        self.assertEqual(activation["after_url"], PROFILE_URL)
        self.assertTrue(collector.unsafe_navigation_after_click(activation))
        self.assertIn(
            'dialog, error = None, "unsafe_profile_navigation_after_click"',
            executable_source(collector.open_likers_ui),
        )
        self.assertEqual(
            collector.classify_browser_error(RuntimeError("liker_trigger_changed_before_click"), "dialog"),
            "liker_trigger_changed_before_click",
        )

    def test_terminal_summary_reports_the_activation_method(self) -> None:
        source = inspect.getsource(collector.print_summary)
        self.assertIn("Activation method: {collection_details['activation_method']}", source)
        self.assertIn("Run ID: {collection_details['run_id']}", source)
        collection_source = inspect.getsource(collector.run_collection)
        self.assertIn(
            'collection_details["activation_method"] = post_click_diagnostics["activation_method"]',
            collection_source,
        )


class StaleOutputTests(unittest.TestCase):
    @staticmethod
    def csv_rows(path: Path) -> list[list[str]]:
        return list(csv.reader(io.StringIO(path.read_text(encoding="utf-8"))))

    @staticmethod
    def record(username: str) -> dict[str, object]:
        return {field: None for field in collector.CSV_FIELDS} | {"username": username}

    def test_new_run_resets_json_to_an_empty_list(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            json_path, csv_path = Path(name) / "likers.json", Path(name) / "likers.csv"
            json_path.write_text(json.dumps([self.record(f"old{index}") for index in range(19)]), encoding="utf-8")
            with patch.object(collector, "JSON_PATH", json_path), patch.object(collector, "CSV_PATH", csv_path):
                collector.reset_liker_outputs()
            self.assertEqual(json.loads(json_path.read_text(encoding="utf-8")), [])

    def test_new_run_resets_csv_to_the_header_only(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            json_path, csv_path = Path(name) / "likers.json", Path(name) / "likers.csv"
            csv_path.write_text("username\nold\n", encoding="utf-8")
            with patch.object(collector, "JSON_PATH", json_path), patch.object(collector, "CSV_PATH", csv_path):
                collector.reset_liker_outputs()
            self.assertEqual(self.csv_rows(csv_path), [list(collector.CSV_FIELDS)])

    def test_reset_runs_before_any_navigation_so_a_fail_keeps_no_old_rows(self) -> None:
        source = inspect.getsource(collector.run_collection)
        self.assertIn("reset_liker_outputs()", source)
        self.assertLess(source.index("reset_liker_outputs()"), source.index("launch_browser_context("))
        self.assertLess(source.index("reset_liker_outputs()"), source.index("page.goto("))
        # A FAIL path must never write results, so write_output stays single-use.
        self.assertEqual(source.count("write_output(records)"), 1)
        self.assertLess(source.index("if len(records) < 2:"), source.index("write_output(records)"))

    def test_pass_output_replaces_the_reset_files_with_current_records(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            json_path, csv_path = Path(name) / "likers.json", Path(name) / "likers.csv"
            with patch.object(collector, "JSON_PATH", json_path), patch.object(collector, "CSV_PATH", csv_path):
                collector.reset_liker_outputs()
                collector.write_output([self.record("liker1"), self.record("liker2")])
            self.assertEqual(
                [item["username"] for item in json.loads(json_path.read_text(encoding="utf-8"))],
                ["liker1", "liker2"],
            )
            rows = self.csv_rows(csv_path)
            self.assertEqual(rows[0], list(collector.CSV_FIELDS))
            self.assertEqual([row[0] for row in rows[1:]], ["liker1", "liker2"])
            self.assertEqual(list(Path(name).glob("*.tmp")), [])

    def test_final_output_is_written_through_an_atomic_replace(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            json_path = Path(name) / "likers.json"
            with patch.object(collector.os, "replace") as replace:
                collector.write_file_atomic(json_path, "[]\n")
            self.assertEqual(replace.call_count, 1)
            temp_path, target = replace.call_args.args
            self.assertEqual(str(temp_path), f"{json_path}.tmp")
            self.assertEqual(target, json_path)
            # Without the replace the target never appears, so no partial file leaks.
            self.assertFalse(json_path.exists())

    def test_selected_trigger_and_after_click_share_one_run_id(self) -> None:
        page = FakePreparedPage(
            {"status": "found", "selection_method": "action_bar_counter", "trigger": {"tag": "span", "text": "161"}, "target_index": 0},
            APPROVED_INSPECTION,
        )
        with patch.object(collector, "write_json") as write_json:
            collector.prepare_safe_liker_trigger(page, "run-42")
        selected = next(
            call.args[1] for call in write_json.call_args_list
            if call.args[0] == collector.SELECTED_LIKER_TRIGGER_PATH
        )
        self.assertEqual(selected["run_id"], "run-42")
        with patch.object(collector, "write_json"):
            payload = collector.write_post_click_diagnostics(
                FakePostClickPage({"profile_links": [], "containers": []}),
                {"url": POST_URL, "profile_links": []},
                {"activation_method": "dom_click"},
                "run-42",
            )
        self.assertEqual(payload["run_id"], "run-42")
        self.assertNotEqual(collector.new_run_id(), collector.new_run_id())
        source = inspect.getsource(collector.run_collection)
        self.assertEqual(source.count("run_id = new_run_id()"), 1)
        self.assertIn("prepare_safe_liker_trigger(page, run_id)", source)
        self.assertIn("fingerprint, before_liker_click, run_id", source)
        self.assertIn(
            "write_post_click_diagnostics(page, before_snapshot, activation, run_id)",
            executable_source(collector.open_likers_ui),
        )


if __name__ == "__main__":
    unittest.main()
