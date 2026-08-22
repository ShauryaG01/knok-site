#!/usr/bin/env python3
"""Build the CDN-served hiring snapshots consumed by knok.work/map."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "map" / "data"
UPSTREAM = os.environ.get("KNOK_MAP_JOBS_UPSTREAM", "https://hey.knok.work/api/jobs")
ROLES = {
    "all-roles": None,
    "product-manager": "Product Manager",
    "growth-marketing": "Growth Marketing",
    "software-engineer": "Software Engineer",
    "data-analyst": "Data Analyst",
    "designer": "Designer",
    "program-manager": "Program Manager",
    "finance": "Finance",
}
FIELDS = (
    "id",
    "title",
    "company",
    "company_canonical_id",
    "location",
    "posted_at",
    "posted_date",
    "url",
)


def fetch_json(url: str) -> dict:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(
                url,
                headers={"Accept": "application/json", "User-Agent": "KnokMapSnapshot/1.0"},
            )
            with urllib.request.urlopen(request, timeout=45) as response:
                if response.status != 200:
                    raise RuntimeError(f"unexpected status {response.status}")
                payload = json.load(response)
                if not isinstance(payload, dict) or not isinstance(payload.get("jobs"), list):
                    raise RuntimeError("invalid jobs payload")
                return payload
        except (OSError, RuntimeError, ValueError, urllib.error.URLError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"map snapshot request failed: {url}: {last_error}")


def role_snapshot(search: str | None) -> dict:
    page_size = 2000 if search is None else 500
    jobs_by_id: dict[str, dict] = {}
    total = 0
    page = 1
    while page <= 20:
        query = {
            "location": "Bengaluru",
            "page": str(page),
            "per_page": str(page_size),
            "sort": "posted_date",
            "order": "desc",
            "exclude_junk": "true",
        }
        if search:
            query["search"] = search
        payload = fetch_json(f"{UPSTREAM}?{urllib.parse.urlencode(query)}")
        total = max(total, int(payload.get("total") or 0))
        batch = payload["jobs"]
        for raw in batch:
            if not isinstance(raw, dict):
                continue
            job = {field: raw.get(field) for field in FIELDS}
            job["id"] = str(job.get("id") or "")
            job["title"] = str(job.get("title") or "")
            job["company"] = str(job.get("company") or "")
            job["url"] = str(job.get("url") or "")
            if job["id"] and job["company"] and job["url"]:
                jobs_by_id[job["id"]] = job
        if not batch or len(jobs_by_id) >= total or len(batch) < page_size:
            break
        page += 1
    if total and len(jobs_by_id) < min(total, page_size):
        raise RuntimeError(f"incomplete snapshot: expected {total}, collected {len(jobs_by_id)}")
    return {"jobs": list(jobs_by_id.values()), "total": total or len(jobs_by_id)}


def atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".new")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if temporary.stat().st_size < 50:
        raise RuntimeError(f"refusing empty snapshot: {path}")
    temporary.replace(path)


def main() -> None:
    generated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest: dict[str, dict] = {}
    for filename, search in ROLES.items():
        snapshot = role_snapshot(search)
        snapshot["generated_at"] = generated_at
        destination = OUTPUT / f"{filename}.json"
        atomic_write(destination, snapshot)
        manifest[filename] = {
            "jobs": len(snapshot["jobs"]),
            "total": snapshot["total"],
            "bytes": destination.stat().st_size,
        }
        print(f"{filename}: {len(snapshot['jobs'])}/{snapshot['total']} jobs")
    atomic_write(OUTPUT / "manifest.json", {"generated_at": generated_at, "snapshots": manifest})


if __name__ == "__main__":
    main()
