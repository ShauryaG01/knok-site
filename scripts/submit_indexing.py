#!/usr/bin/env python3
"""Submit knok URLs to search engines for faster indexing.

Two channels (matches the proven Flash pipeline, corrected for knok):
  - IndexNow  → Bing + Yandex (one POST, whole batch). Needs a key file
                served at the site root; this script creates it in output/.
  - Google Indexing API → Google direct, one POST per URL, 200/day quota.
                Needs GOOGLE_INDEXING_KEY_JSON (service-account JSON string).

Differences from Flash's publish.py, on purpose:
  - knok URLs are real files ("/collection/foo.html"), not "/cat/slug/" dirs.
  - IndexNow key is a random per-site key persisted to data/indexnow_key.txt,
    not a hardcoded string.
  - Google's sitemap-ping endpoint (deprecated 2023) is dropped — it was dead
    code in Flash too.

Usage:
  submit_indexing.py --urls https://knok.work/a.html,https://knok.work/b.html
  submit_indexing.py --from-file urls.txt        # one URL per line
  submit_indexing.py --from-sitemap              # every indexable URL in sitemap.xml
  submit_indexing.py --from-sitemap --dry-run    # print, submit nothing
  submit_indexing.py --newly-published           # URLs added since last submit_log entry
Env:
  GOOGLE_INDEXING_KEY_JSON   raw service-account JSON (optional; skipped if unset)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = PROJECT_ROOT / "output"
DATA_DIR = PROJECT_ROOT / "data"
KEY_FILE = DATA_DIR / "indexnow_key.txt"
SUBMIT_LOG = DATA_DIR / "indexing_submit_log.json"

DOMAIN = "https://knok.work"          # canonical prefix (scheme + host)
HOST = "knok.work"                    # bare host for the IndexNow body
GOOGLE_DAILY_QUOTA = 200


# ── IndexNow (Bing + Yandex) ────────────────────────────────────────────────

def _indexnow_key() -> str:
    """Load or mint the site's IndexNow key (persisted, must stay stable)."""
    if KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip()
        if key:
            return key
    key = secrets.token_hex(16)        # 32 hex chars, within IndexNow's 8-128
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_text(key, encoding="utf-8")
    return key


def setup_indexnow_key_file(key: str) -> Path:
    """Write <key>.txt into the served site root so engines can verify it."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    key_path = OUTPUT_DIR / f"{key}.txt"
    key_path.write_text(key, encoding="utf-8")
    return key_path


def submit_indexnow(urls: list[str], *, dry_run: bool = False) -> int:
    """POST the whole batch to the shared IndexNow endpoint (Bing/Yandex)."""
    if not urls:
        return 0
    key = _indexnow_key()
    key_path = setup_indexnow_key_file(key)
    payload = {
        "host": HOST,
        "key": key,
        "keyLocation": f"{DOMAIN}/{key}.txt",
        "urlList": urls,
    }
    if dry_run:
        print(f"[dry-run] IndexNow: would submit {len(urls)} URLs "
              f"(key file {key_path}, keyLocation {payload['keyLocation']})")
        return 0
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.indexnow.org/indexnow",
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        print(f"IndexNow: submitted {len(urls)} URLs (status {resp.status}) "
              f"→ Bing + Yandex")
        return len(urls)
    except urllib.error.HTTPError as e:
        # 422 = key/host mismatch (key file not live yet); surface it loudly.
        print(f"IndexNow: HTTP {e.code} — {e.reason}. "
              f"Ensure {payload['keyLocation']} is publicly reachable.")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"IndexNow: failed — {e}")
        return 0


# ── Google Indexing API ─────────────────────────────────────────────────────

def submit_google(urls: list[str], *, dry_run: bool = False) -> int:
    """One POST per URL to the Google Indexing API (URL_UPDATED), 200/day."""
    if not urls:
        return 0
    key_json = os.environ.get("GOOGLE_INDEXING_KEY_JSON", "").strip()
    if not key_json:
        print("Google Indexing API: GOOGLE_INDEXING_KEY_JSON unset — skipping.")
        return 0
    batch = urls[:GOOGLE_DAILY_QUOTA]
    if len(urls) > GOOGLE_DAILY_QUOTA:
        print(f"Google Indexing API: {len(urls)} URLs exceeds daily quota "
              f"{GOOGLE_DAILY_QUOTA}; submitting first {GOOGLE_DAILY_QUOTA}, "
              f"{len(urls) - GOOGLE_DAILY_QUOTA} deferred.")
    if dry_run:
        print(f"[dry-run] Google Indexing API: would submit {len(batch)} URLs")
        return 0
    try:
        import google.auth.transport.requests as tr
        import google.oauth2.service_account as sa
    except ImportError:
        print("Google Indexing API: google-auth not installed "
              "(pip install -e '.[gsc]') — skipping.")
        return 0
    try:
        creds = sa.Credentials.from_service_account_info(
            json.loads(key_json),
            scopes=["https://www.googleapis.com/auth/indexing"],
        )
        creds.refresh(tr.Request())
    except Exception as e:  # noqa: BLE001
        print(f"Google Indexing API: auth failed — {e}")
        return 0

    submitted = 0
    for url in batch:
        body = json.dumps({"url": url, "type": "URL_UPDATED"}).encode("utf-8")
        req = urllib.request.Request(
            "https://indexing.googleapis.com/v3/urlNotifications:publish",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {creds.token}",
            },
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=10)
            submitted += 1
        except urllib.error.HTTPError as e:
            print(f"  google: {e.code} for {url} — {e.reason}")
        except Exception as e:  # noqa: BLE001
            print(f"  google: failed for {url} — {e}")
    print(f"Google Indexing API: submitted {submitted}/{len(batch)} URLs")
    return submitted


# ── URL sourcing ────────────────────────────────────────────────────────────

def urls_from_sitemap() -> list[str]:
    sm = OUTPUT_DIR / "sitemap.xml"
    if not sm.exists():
        sys.exit(f"error: {sm} not found — build the site first")
    root = ET.fromstring(sm.read_text(encoding="utf-8"))
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    return [loc.text.strip() for loc in root.findall(".//s:loc", ns) if loc.text]


def urls_from_file(path: str) -> list[str]:
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.startswith("#")]


def _load_submit_log() -> dict:
    if SUBMIT_LOG.exists():
        try:
            return json.loads(SUBMIT_LOG.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"submitted": [], "runs": []}


def _save_submit_log(log: dict, urls: list[str], stamp: str) -> None:
    seen = set(log.get("submitted", []))
    seen.update(urls)
    log["submitted"] = sorted(seen)
    log.setdefault("runs", []).append({"at": stamp, "count": len(urls)})
    SUBMIT_LOG.write_text(json.dumps(log, indent=1), encoding="utf-8")


# ── main ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Submit knok URLs to IndexNow + Google.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--urls", help="comma-separated URLs")
    src.add_argument("--from-file", help="file with one URL per line")
    src.add_argument("--from-sitemap", action="store_true",
                     help="every URL in output/sitemap.xml")
    src.add_argument("--newly-published", action="store_true",
                     help="sitemap URLs not seen in indexing_submit_log.json")
    ap.add_argument("--indexnow-only", action="store_true")
    ap.add_argument("--google-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.urls:
        urls = [u.strip() for u in args.urls.split(",") if u.strip()]
    elif args.from_file:
        urls = urls_from_file(args.from_file)
    else:
        urls = urls_from_sitemap()

    log = _load_submit_log()
    if args.newly_published:
        already = set(log.get("submitted", []))
        urls = [u for u in urls if u not in already]

    if not urls:
        print("No URLs to submit.")
        return 0

    # All URLs must be absolute https://knok.work/... — guard against relative.
    bad = [u for u in urls if not u.startswith(DOMAIN)]
    if bad:
        sys.exit(f"error: {len(bad)} URLs not under {DOMAIN}, e.g. {bad[0]}")

    print(f"Submitting {len(urls)} URL(s){' [dry-run]' if args.dry_run else ''}:")
    for u in urls[:8]:
        print(f"  {u}")
    if len(urls) > 8:
        print(f"  … +{len(urls) - 8} more")

    if not args.google_only:
        submit_indexnow(urls, dry_run=args.dry_run)
    if not args.indexnow_only:
        submit_google(urls, dry_run=args.dry_run)

    if not args.dry_run:
        _save_submit_log(log, urls, datetime.now(UTC).isoformat(timespec="seconds"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
