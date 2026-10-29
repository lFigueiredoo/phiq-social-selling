"""Read-only proof of concept for collecting Instagram media likers."""

from __future__ import annotations

import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

from instagrapi import Client


MAX_LIKERS = 20
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
SESSION_PATH = Path(__file__).resolve().parent / "session.json"
JSON_PATH = OUTPUT_DIR / "likers.json"
CSV_PATH = OUTPUT_DIR / "likers.csv"
CSV_FIELDS = (
    "user_id", "username", "full_name", "is_private", "is_verified",
    "media_id", "media_url", "collected_at", "collector_method",
)


def get_required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"missing_{name.lower()}")
    return value


def get_likers_limit() -> int:
    raw_value = os.environ.get("IG_LIKERS_LIMIT", "20").strip()
    try:
        limit = int(raw_value)
    except ValueError as error:
        raise ValueError("invalid_ig_likers_limit") from error
    if limit < 1 or limit > MAX_LIKERS:
        raise ValueError("invalid_ig_likers_limit")
    return limit


def validate_media_url(media_url: str) -> str:
    parsed = urlparse(media_url)
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or hostname not in {"instagram.com", "www.instagram.com"}:
        raise ValueError("invalid_media_url")
    if not parsed.path or parsed.path == "/":
        raise ValueError("invalid_media_url")
    return media_url


def classify_error(error: Exception, phase: str) -> str:
    """Map library failures to safe result codes without echoing data."""
    details = f"{type(error).__name__} {error}".lower()
    if "challenge" in details:
        return "challenge_required"
    if "checkpoint" in details:
        return "checkpoint_required"
    if "rate" in details or "429" in details or "please wait" in details:
        return "rate_limit"
    if phase == "login" or "loginrequired" in details or "login required" in details:
        return "login_required"
    if phase == "media" and ("not found" in details or "notfound" in details or "404" in details):
        return "media_not_found"
    if phase == "likers":
        return "likers_unavailable"
    return "unknown_error"


def collect_likers(client: Client, media_id: str) -> tuple[Iterable[Any], str]:
    """Use exposed instagrapi methods only; never construct endpoints."""
    primary = getattr(client, "media_likers", None)
    if callable(primary):
        return primary(media_id), "media_likers"
    fallback = getattr(client, "media_likers_v1", None)
    if callable(fallback):
        return fallback(media_id), "media_likers_v1"
    raise RuntimeError("likers_method_unavailable")


def login_with_session(client: Client, username: str, password: str) -> str:
    """Load one local session when available, then perform one login attempt."""
    session_exists = SESSION_PATH.exists()

    if session_exists:
        client.load_settings(SESSION_PATH)

    client.login(username, password)
    client.dump_settings(SESSION_PATH)

    return "reutilizada" if session_exists else "criada"


def get_user_value(user: Any, field: str, default: Any = None) -> Any:
    if isinstance(user, dict):
        return user.get(field, default)
    return getattr(user, field, default)


def normalize_likers(
    users: Iterable[Any], limit: int, media_id: str, media_url: str, collector_method: str,
) -> list[dict[str, Any]]:
    collected_at = datetime.now(timezone.utc).isoformat()
    records: list[dict[str, Any]] = []
    seen_user_ids: set[str] = set()
    for user in users:
        user_id = str(get_user_value(user, "pk", "")).strip()
        if not user_id or user_id in seen_user_ids:
            continue
        seen_user_ids.add(user_id)
        records.append({
            "user_id": user_id,
            "username": str(get_user_value(user, "username", "") or ""),
            "full_name": str(get_user_value(user, "full_name", "") or ""),
            "is_private": bool(get_user_value(user, "is_private", False)),
            "is_verified": bool(get_user_value(user, "is_verified", False)),
            "media_id": media_id,
            "media_url": media_url,
            "collected_at": collected_at,
            "collector_method": collector_method,
        })
        if len(records) >= limit:
            break
    return records


def write_output(records: list[dict[str, Any]]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with JSON_PATH.open("w", encoding="utf-8", newline="") as file:
        json.dump(records, file, ensure_ascii=False, indent=2)
        file.write("\n")
    with CSV_PATH.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(records)


def print_summary(
    media_url: str,
    collector_method: str,
    records: list[dict[str, Any]],
    result: str,
    session_status: str = "não disponível",
    error_code: str | None = None,
) -> None:
    print("=== INSTAGRAM LIKER COLLECTOR ===")
    print(f"Media: {media_url or 'N/A'}")
    print(f"Método: {collector_method or 'N/A'}")
    print(f"Curtidores coletados: {len(records)}")
    print(f"Curtidores únicos: {len({record['user_id'] for record in records})}")
    print(f"Sessão: {session_status}")
    print(f"JSON: {JSON_PATH if records else 'N/A'}")
    print(f"CSV: {CSV_PATH if records else 'N/A'}")
    if error_code:
        print(f"Erro: {error_code}")
    if error_code in {"challenge_required", "checkpoint_required"}:
        print("Ação necessária: conclua a verificação manualmente no Instagram oficial e tente novamente depois.")
    print(f"Resultado: {result}")


def main() -> int:
    media_url = ""
    try:
        username = get_required_env("IG_COLLECTOR_USERNAME")
        password = get_required_env("IG_COLLECTOR_PASSWORD")
        media_url = validate_media_url(get_required_env("IG_TARGET_MEDIA_URL"))
        limit = get_likers_limit()
    except ValueError as error:
        print_summary(media_url, "", [], "FAIL", error_code=str(error))
        return 1

    client = Client()
    try:
        session_status = login_with_session(client, username, password)
    except Exception as error:  # instagrapi exposes version-specific errors
        print_summary(
            media_url,
            "",
            [],
            "FAIL",
            error_code=classify_error(error, "login"),
        )
        return 1

    try:
        media_pk = str(client.media_pk_from_url(media_url))
        media_id = str(client.media_id(media_pk))
    except Exception as error:
        print_summary(
            media_url,
            "",
            [],
            "FAIL",
            session_status,
            classify_error(error, "media"),
        )
        return 1

    try:
        users, collector_method = collect_likers(client, media_id)
        records = normalize_likers(users, limit, media_id, media_url, collector_method)
        write_output(records)
    except Exception as error:
        print_summary(
            media_url,
            "",
            [],
            "FAIL",
            session_status,
            classify_error(error, "likers"),
        )
        return 1

    print_summary(media_url, collector_method, records, "PASS", session_status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
