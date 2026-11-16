#!/usr/bin/env python3
"""Weekly live TikOmni market collection for AIFIOS.

This is deliberately a scheduler-friendly script rather than a second topic
flow. It derives broad queries from local first-party production history, then
uses the same strict three-platform TikOmni gate as a topic run. It never turns
last week's snapshot or local hit-library rows into a live research fallback.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from market_signal import (
    MARKET_SNAPSHOT_SCHEMA_VERSION,
    REQUIRED_MARKET_PLATFORMS,
    _canonical_json_bytes,
    _safe_filename,
    _sha256_bytes,
    _write_new_bytes,
    extract_market_queries,
    fetch_market_signals,
    freeze_market_snapshot,
    verify_market_snapshot,
    verify_frozen_market_snapshot,
)


WEEKLY_COLLECTION_STATE_RELATIVE_PATH = "sessions/tikomni-weekly-market-state.json"
WEEKLY_COLLECTION_STATE_SCHEMA = "aifios.tikomni.weekly-market-state.v1"


def derive_weekly_queries(project: Path | str, limit: int = 12) -> dict[str, Any]:
    """Derive broad, traceable queries from three first-party input classes."""
    project_path = Path(project).expanduser().resolve(strict=False)
    source_texts: dict[str, list[str]] = {
        "materials": _recent_material_texts(project_path),
        "performance": _reviewed_performance_texts(project_path),
        "learning": _approved_learning_texts(project_path),
    }
    queries: list[str] = []
    query_sources: dict[str, list[str]] = {}
    for source, texts in source_texts.items():
        for text in texts:
            for query in extract_market_queries(text, limit=limit):
                if query not in queries:
                    queries.append(query)
                query_sources.setdefault(query, [])
                if source not in query_sources[query]:
                    query_sources[query].append(source)
                if len(queries) >= limit:
                    break
            if len(queries) >= limit:
                break
        if len(queries) >= limit:
            break
    return {
        "queries": queries[:limit],
        "query_sources": {query: query_sources.get(query, []) for query in queries[:limit]},
        "source_counts": {source: len(texts) for source, texts in source_texts.items()},
        "derived_at": datetime.now().astimezone().isoformat(),
    }


def collect_weekly_market_signals(
    project: Path | str,
    *,
    live_fetcher: Callable[[str, str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run a broad weekly live collection and persist an immutable snapshot."""
    project_path = Path(project).expanduser().resolve(strict=False)
    derived = derive_weekly_queries(project_path)
    result = fetch_market_signals(
        "\n".join(derived["queries"]),
        list(REQUIRED_MARKET_PLATFORMS),
        project_path,
        queries=derived["queries"],
        mode="weekly",
        live_fetcher=live_fetcher,
    )
    if result.get("status") != "ready":
        return {
            "status": "blocked",
            "queries": derived["queries"],
            "query_sources": derived["query_sources"],
            "source_counts": derived["source_counts"],
            "blockers": result.get("blockers") or [],
            "used_cache": False,
            "used_local_samples": False,
        }
    snapshot = persist_weekly_market_snapshot(project_path, result, derived)
    return {
        "status": "ready",
        "queries": derived["queries"],
        "query_sources": derived["query_sources"],
        "source_counts": derived["source_counts"],
        "snapshot_path": snapshot["manifest_path"],
        "snapshot_sha256": snapshot["snapshot_sha256"],
        "sample_count": result.get("sufficiency", {}).get("sample_count", 0),
        "used_cache": False,
        "used_local_samples": False,
    }


def _iso_week(value: datetime | None = None) -> str:
    stamp = value or datetime.now().astimezone()
    return stamp.strftime("%G-W%V")


def _state_path(project: Path) -> Path:
    return project / WEEKLY_COLLECTION_STATE_RELATIVE_PATH


def _read_weekly_collection_state(project: Path) -> dict[str, Any]:
    path = _state_path(project)
    try:
        if path.is_symlink() or not path.is_file():
            raise OSError("missing")
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        payload = {}
    if not isinstance(payload, dict) or payload.get("schema") != WEEKLY_COLLECTION_STATE_SCHEMA:
        return {
            "schema": WEEKLY_COLLECTION_STATE_SCHEMA,
            "last_attempt_at": "",
            "last_attempt_week": "",
            "last_success_week": "",
            "last_status": "",
            "snapshot_path": "",
            "snapshot_sha256": "",
        }
    return {
        "schema": WEEKLY_COLLECTION_STATE_SCHEMA,
        "last_attempt_at": str(payload.get("last_attempt_at") or ""),
        "last_attempt_week": str(payload.get("last_attempt_week") or ""),
        "last_success_week": str(payload.get("last_success_week") or ""),
        "last_status": str(payload.get("last_status") or ""),
        "snapshot_path": str(payload.get("snapshot_path") or ""),
        "snapshot_sha256": str(payload.get("snapshot_sha256") or ""),
    }


def _write_weekly_collection_state(project: Path, payload: dict[str, Any]) -> None:
    path = _state_path(project)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def collect_weekly_market_signals_if_due(
    project: Path | str,
    *,
    live_fetcher: Callable[[str, str], dict[str, Any]] | None = None,
    now: datetime | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Run at most one successful broad collection per local ISO week.

    A failed live request is deliberately retried on the next desktop timer
    tick rather than being turned into a stale-data substitute. This optional
    scheduler never participates in the per-topic hard gate.
    """
    project_path = Path(project).expanduser().resolve(strict=False)
    current = now or datetime.now().astimezone()
    week = _iso_week(current)
    state = _read_weekly_collection_state(project_path)
    if not force and state.get("last_success_week") == week:
        return {
            "status": "already_collected",
            "collected": False,
            "week": week,
            "snapshot_path": state.get("snapshot_path") or "",
            "snapshot_sha256": state.get("snapshot_sha256") or "",
            "last_attempt_at": state.get("last_attempt_at") or "",
        }

    result = collect_weekly_market_signals(project_path, live_fetcher=live_fetcher)
    state.update({
        "last_attempt_at": current.isoformat(timespec="seconds"),
        "last_attempt_week": week,
        "last_status": str(result.get("status") or "blocked"),
    })
    if result.get("status") == "ready":
        state.update({
            "last_success_week": week,
            "snapshot_path": str(result.get("snapshot_path") or ""),
            "snapshot_sha256": str(result.get("snapshot_sha256") or ""),
        })
    _write_weekly_collection_state(project_path, state)
    return {
        **result,
        "collected": result.get("status") == "ready",
        "week": week,
        "scheduler_state_path": WEEKLY_COLLECTION_STATE_RELATIVE_PATH,
    }


def verify_topic_market_snapshot(
    project: Path | str,
    run_id: str,
    snapshot_path: str,
) -> dict[str, Any]:
    """Verify a candidate live snapshot before the topic/template approval.

    This is intentionally separate from ``topic-verify``. A candidate must be
    intact and bound to the current intake before a human can approve the
    topic; only the approved candidate is later checked through the frozen
    pointer.
    """
    return verify_market_snapshot(project, run_id, snapshot_path)


def persist_weekly_market_snapshot(
    project: Path | str,
    result: dict[str, Any],
    derived: dict[str, Any],
) -> dict[str, Any]:
    """Store one write-once weekly snapshot under materials/research/weekly."""
    if result.get("status") != "ready":
        raise ValueError("只有通过实时三平台门禁的结果可以写入周度快照")
    project_path = Path(project).expanduser().resolve(strict=False)
    week = datetime.now().astimezone().strftime("%G-W%V")
    root = project_path / "materials" / "research" / "weekly" / week
    root.mkdir(parents=True, exist_ok=True)
    seed = _canonical_json_bytes({
        "queries": result.get("queries") or [],
        "raw_payloads": result.get("raw_payloads") or [],
        "derived": derived,
        "created_at": datetime.now().astimezone().isoformat(),
    })
    snapshot_id = f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S-%f')}-{_sha256_bytes(seed)[:12]}"
    snapshot_dir = root / snapshot_id
    snapshot_dir.mkdir(mode=0o700)
    raw_dir = snapshot_dir / "raw"
    raw_dir.mkdir(mode=0o700)
    raw_entries: list[dict[str, Any]] = []
    for index, item in enumerate(result.get("raw_payloads") or [], start=1):
        if not isinstance(item, dict) or not isinstance(item.get("payload"), (dict, list)):
            raise ValueError("周度 TikOmni 原始数据无效")
        platform = str(item.get("platform") or "")
        query = str(item.get("query") or "")
        raw_path = raw_dir / f"{index:02d}-{platform}-{_safe_filename(query)}.json"
        raw_bytes = _canonical_json_bytes(item["payload"])
        _write_new_bytes(raw_path, raw_bytes)
        raw_entries.append({
            "platform": platform,
            "query": query,
            "endpoint_id": str(item.get("endpoint_id") or ""),
            "path": raw_path.relative_to(project_path).as_posix(),
            "sha256": _sha256_bytes(raw_bytes),
        })
    normalized_path = snapshot_dir / "normalized-samples.json"
    normalized_bytes = _canonical_json_bytes({
        "signals": result.get("signals") or [],
        "platform_checks": result.get("platform_checks") or {},
        "sufficiency": result.get("sufficiency") or {},
    })
    _write_new_bytes(normalized_path, normalized_bytes)
    manifest_without_digest = {
        "schema_version": MARKET_SNAPSHOT_SCHEMA_VERSION,
        "kind": "aifios.tikomni.weekly-market-snapshot",
        "snapshot_id": snapshot_id,
        "week": week,
        "created_at": datetime.now().astimezone().isoformat(),
        "required_platforms": list(REQUIRED_MARKET_PLATFORMS),
        "queries": result.get("queries") or [],
        "query_sources": derived.get("query_sources") or {},
        "source_counts": derived.get("source_counts") or {},
        "platform_checks": result.get("platform_checks") or {},
        "sufficiency": result.get("sufficiency") or {},
        "raw_entries": raw_entries,
        "normalized_path": normalized_path.relative_to(project_path).as_posix(),
        "normalized_sha256": _sha256_bytes(normalized_bytes),
        "no_fallback": True,
        "used_cache": False,
        "used_local_samples": False,
    }
    digest = _sha256_bytes(_canonical_json_bytes(manifest_without_digest))
    manifest_path = snapshot_dir / "snapshot.json"
    _write_new_bytes(manifest_path, _canonical_json_bytes({**manifest_without_digest, "sha256": digest}))
    return {
        "manifest_path": manifest_path.relative_to(project_path).as_posix(),
        "snapshot_sha256": digest,
    }


def _recent_material_texts(project: Path) -> list[str]:
    root = project / "pipeline" / "intake"
    if not root.is_dir():
        return []
    files = sorted((path for path in root.glob("*.md") if path.is_file() and not path.is_symlink()), key=lambda path: path.stat().st_mtime, reverse=True)
    return [_strip_frontmatter(path.read_text(encoding="utf-8")) for path in files[:20]]


def _reviewed_performance_texts(project: Path) -> list[str]:
    root = project / "materials" / "performance" / "review-inputs"
    if not root.is_dir():
        return []
    texts: list[str] = []
    for path in sorted(root.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)[:50]:
        if path.is_symlink():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict) or str(payload.get("review_status") or "").lower() not in {"completed", "reviewed", "review-ready"}:
            continue
        texts.append(_json_text(payload))
    return texts


def _approved_learning_texts(project: Path) -> list[str]:
    path = project / "brain" / "insights.md"
    if not path.is_file() or path.is_symlink():
        return []
    text = path.read_text(encoding="utf-8")
    lines: list[str] = []
    approved_section = False
    for line in text.splitlines():
        heading = re.match(r"^#{1,6}\s*(.+?)\s*$", line)
        if heading:
            approved_section = bool(re.search(r"\bapproved\b|已确认|已批准", heading.group(1), re.IGNORECASE))
            continue
        if approved_section or re.search(r"\bapproved\b|状态\s*[:：]\s*已确认", line, re.IGNORECASE):
            lines.append(line)
    return ["\n".join(lines)] if lines else []


def _strip_frontmatter(text: str) -> str:
    return re.sub(r"^---\n[\s\S]*?\n---\n?", "", text or "").strip()


def _json_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_json_text(item) for item in value)
    if isinstance(value, dict):
        return "\n".join(_json_text(item) for item in value.values())
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Run AIFIOS weekly TikOmni market collection")
    parser.add_argument("--project", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("derive")
    sub.add_parser("collect")
    due = sub.add_parser("collect-if-due")
    due.add_argument("--force", action="store_true")
    freeze = sub.add_parser("topic-freeze", help="Freeze the verified topic snapshot after human approval")
    freeze.add_argument("--run-id", required=True)
    freeze.add_argument("--snapshot", required=True)
    candidate = sub.add_parser("topic-snapshot-verify", help="Verify a candidate topic snapshot before approval")
    candidate.add_argument("--run-id", required=True)
    candidate.add_argument("--snapshot", required=True)
    verify = sub.add_parser("topic-verify", help="Verify the frozen topic snapshot before downstream generation")
    verify.add_argument("--run-id", required=True)
    args = parser.parse_args()
    project = Path(args.project).expanduser().resolve(strict=False)
    if args.command == "derive":
        result = derive_weekly_queries(project)
    elif args.command == "collect":
        result = collect_weekly_market_signals(project)
    elif args.command == "collect-if-due":
        result = collect_weekly_market_signals_if_due(project, force=bool(args.force))
    elif args.command == "topic-freeze":
        result = freeze_market_snapshot(project, args.run_id, args.snapshot)
    elif args.command == "topic-snapshot-verify":
        result = verify_topic_market_snapshot(project, args.run_id, args.snapshot)
    else:
        result = verify_frozen_market_snapshot(project, args.run_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") == "blocked" or result.get("verified") is False:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
