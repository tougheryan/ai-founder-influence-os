from __future__ import annotations

import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from market_signal import REQUIRED_MARKET_PLATFORMS, fetch_market_signals, persist_market_snapshot
from datetime import datetime

from tikomni_scheduler import (
    collect_weekly_market_signals,
    collect_weekly_market_signals_if_due,
    derive_weekly_queries,
    verify_topic_market_snapshot,
)


def _live_fetcher(platform: str, query: str) -> dict:
    return {
        "status": "available",
        "platform": platform,
        "endpoint_id": f"{platform}.fixture.search",
        "query_applied": True,
        "raw_payload": {
            "data": {
                "items": [{
                    "title": f"{platform} {query}",
                    "desc": "公开样本，用于验证选题的结构和互动机制。",
                    "url": f"https://example.test/{platform}/{query}",
                    "play_count": 5000,
                    "like_count": 90,
                }],
            },
        },
    }


def test_weekly_query_derivation_uses_materials_reviewed_performance_and_approved_learning(tmp_path: Path) -> None:
    intake = tmp_path / "pipeline" / "intake" / "weekly-source.md"
    intake.parent.mkdir(parents=True)
    intake.write_text("企业出海要先做自媒体样板。", encoding="utf-8")

    performance = tmp_path / "materials" / "performance" / "review-inputs" / "reviewed.json"
    performance.parent.mkdir(parents=True)
    performance.write_text(json.dumps({
        "review_status": "completed",
        "content_analysis": {"summary": "产品力和流量放大器是评论区最常出现的判断。"},
    }, ensure_ascii=False), encoding="utf-8")

    insights = tmp_path / "brain" / "insights.md"
    insights.parent.mkdir(parents=True)
    insights.write_text(
        "# Insights\n\n## approved\n- AI 企业转型需要先解决老板认知。\n",
        encoding="utf-8",
    )

    derived = derive_weekly_queries(tmp_path)

    assert "企业出海 自媒体" in derived["queries"]
    assert "产品力 流量 放大器" in derived["queries"]
    assert "AI 企业转型 老板认知" in derived["queries"]
    assert set(derived["source_counts"]) == {"materials", "performance", "learning"}
    assert all(derived["source_counts"].values())


def test_weekly_collection_is_live_only_and_persists_a_broad_snapshot(tmp_path: Path) -> None:
    intake = tmp_path / "pipeline" / "intake" / "weekly-source.md"
    intake.parent.mkdir(parents=True)
    intake.write_text("企业出海和自媒体需要做低成本样板。", encoding="utf-8")

    result = collect_weekly_market_signals(tmp_path, live_fetcher=_live_fetcher)

    assert result["status"] == "ready"
    assert result["snapshot_path"].startswith("materials/research/weekly/")
    assert (tmp_path / result["snapshot_path"]).is_file()
    assert result["used_cache"] is False
    assert result["used_local_samples"] is False


def test_due_scheduler_collects_once_per_week_and_retries_only_when_live_collection_is_not_ready(tmp_path: Path) -> None:
    intake = tmp_path / "pipeline" / "intake" / "weekly-source.md"
    intake.parent.mkdir(parents=True)
    intake.write_text("企业出海和自媒体需要做低成本样板。", encoding="utf-8")
    calls: list[tuple[str, str]] = []

    def fetcher(platform: str, query: str) -> dict:
        calls.append((platform, query))
        return _live_fetcher(platform, query)

    stamp = datetime.fromisoformat("2026-07-15T09:00:00+08:00")
    first = collect_weekly_market_signals_if_due(tmp_path, live_fetcher=fetcher, now=stamp)
    second = collect_weekly_market_signals_if_due(tmp_path, live_fetcher=fetcher, now=stamp)

    assert first["status"] == "ready"
    assert first["collected"] is True
    assert first["scheduler_state_path"] == "sessions/tikomni-weekly-market-state.json"
    assert second["status"] == "already_collected"
    assert second["collected"] is False
    assert len(calls) == 3


def test_candidate_topic_snapshot_verification_returns_the_bound_intake_path(tmp_path: Path) -> None:
    source_path = "pipeline/intake/topic-source.md"
    source = tmp_path / source_path
    source.parent.mkdir(parents=True)
    source.write_text("企业出海和自媒体需要做低成本样板。", encoding="utf-8")
    signals = fetch_market_signals(
        source.read_text(encoding="utf-8"),
        list(REQUIRED_MARKET_PLATFORMS),
        tmp_path,
        live_fetcher=_live_fetcher,
    )
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="topic-run",
        topic="企业出海内容",
        source_path=source_path,
        result=signals,
    )

    verification = verify_topic_market_snapshot(tmp_path, "topic-run", snapshot["manifest_path"])

    assert verification["verified"] is True
    assert verification["source_path"] == source_path
    assert verification["snapshot_sha256"] == snapshot["snapshot_sha256"]
