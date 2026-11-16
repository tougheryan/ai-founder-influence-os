from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from market_signal_report import HostedMarketResearchFetcher, _query_material_text, build_market_signal_report, build_topic_query_context, recover_market_signal_report


MATERIAL = "企业出海要通过自媒体跑一个低成本样板，产品力才是流量放大器的底座。"


def test_query_material_text_ignores_generated_analysis_language() -> None:
    report = """# 素材理解报告
- 核心判断句：创始人把内容当作发布任务，团队没有沉淀客户问题和案例。
- 主情绪：希望通过复盘恢复掌控感。
- 最值得深挖的点：客户问题、案例和服务过程没有沉淀。
"""

    query_text = _query_material_text(report)

    assert "恢复掌控感" not in query_text
    assert "内容当作发布任务" in query_text
    assert "客户问题、案例和服务过程" in query_text


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
                    "desc": "公开可验证样本。",
                    "url": f"https://example.test/{platform}/{query}",
                    "play_count": 2000,
                    "like_count": 20,
                }],
            },
        },
    }


def test_report_requires_a_run_bound_live_snapshot_and_never_uses_local_samples(tmp_path: Path) -> None:
    source = tmp_path / "pipeline" / "intake" / "market.md"
    source.parent.mkdir(parents=True)
    source.write_text(MATERIAL, encoding="utf-8")
    result = build_market_signal_report(
        topic="出海内容",
        source_path="pipeline/intake/market.md",
        material_text=MATERIAL,
        platforms=["wechat", "xhs"],
        project=tmp_path,
        run_id="market-run",
        live_fetcher=_live_fetcher,
    )

    assert result["status"] == "ready"
    assert result["local_count"] == 0
    assert result["realtime_count"] == 2
    assert result["snapshot_path"].startswith("runs/market-run/market-research/")
    assert result["snapshot_sha256"]
    assert "目标平台：公众号 / 小红书" in result["markdown"]
    assert "视频号" not in result["markdown"].split("## 1. 同类内容与爆款分级", 1)[0]
    assert "本地公开样本库" not in result["markdown"]
    assert result["language_quality"]["blocking"] == []
    assert result["language_warnings"] == result["language_quality"]["warnings"]


def test_report_recovers_from_verified_snapshot_without_fetching_again(tmp_path: Path) -> None:
    source_path = "pipeline/intake/market.md"
    source = tmp_path / source_path
    source.parent.mkdir(parents=True)
    source.write_text(MATERIAL, encoding="utf-8")
    initial = build_market_signal_report(
        topic="出海内容",
        source_path=source_path,
        material_text=MATERIAL,
        platforms=None,
        project=tmp_path,
        run_id="recover-run",
        live_fetcher=_live_fetcher,
    )
    snapshot_root = tmp_path / "runs" / "recover-run" / "market-research"
    before = sorted(path.name for path in snapshot_root.iterdir())

    recovered = recover_market_signal_report(
        project=tmp_path,
        run_id="recover-run",
        source_path=source_path,
        snapshot_path=initial["snapshot_path"],
    )

    assert recovered["status"] == "ready"
    assert recovered["sample_count"] == 3
    assert recovered["snapshot_path"] == initial["snapshot_path"]
    assert recovered["snapshot_sha256"] == initial["snapshot_sha256"]
    assert "未重新调用外部服务" in recovered["markdown"]
    assert sorted(path.name for path in snapshot_root.iterdir()) == before


def test_report_preserves_ready_platforms_when_one_selected_lane_is_unavailable(tmp_path: Path) -> None:
    def failed_fetcher(platform: str, query: str) -> dict:
        if platform == "wechat_channels":
            return {"status": "unavailable", "reason": "endpoint down"}
        return _live_fetcher(platform, query)

    source = tmp_path / "pipeline" / "intake" / "market.md"
    source.parent.mkdir(parents=True)
    source.write_text(MATERIAL, encoding="utf-8")
    result = build_market_signal_report(
        topic="出海内容",
        source_path="pipeline/intake/market.md",
        material_text=MATERIAL,
        platforms=["wechat_mp", "xiaohongshu", "wechat_channels"],
        project=tmp_path,
        run_id="market-run",
        live_fetcher=failed_fetcher,
    )

    assert result["status"] == "ready"
    assert result["creator_mode"] is False
    assert result["sample_count"] == 2
    assert result["partial"] is True
    assert result["ready_platforms"] == ["wechat_mp", "xiaohongshu"]
    assert result["platform_lanes"]["wechat_channels"]["status"] == "blocked"
    assert result["snapshot_path"].startswith("runs/market-run/market-research/")
    assert "TikOmni 门禁：通过" in result["markdown"]


def test_report_keeps_provider_only_prose_out_of_the_operator_projection(tmp_path: Path) -> None:
    def unsafe_fetcher(platform: str, query: str) -> dict:
        result = _live_fetcher(platform, query)
        result["raw_payload"]["data"]["items"][0]["desc"] = (
            "作为 AI，我读取 /Users/example/private.md 后填写 {{待补充}}。"
        )
        return result

    source = tmp_path / "pipeline" / "intake" / "market.md"
    source.parent.mkdir(parents=True)
    source.write_text(MATERIAL, encoding="utf-8")

    result = build_market_signal_report(
        topic="出海内容",
        source_path="pipeline/intake/market.md",
        material_text=MATERIAL,
        platforms=None,
        project=tmp_path,
        run_id="unsafe-run",
        live_fetcher=unsafe_fetcher,
    )

    assert result["status"] == "ready"
    assert result["snapshot_path"].startswith("runs/unsafe-run/market-research/")
    assert "作为 AI" not in result["markdown"]
    assert "/Users/example/private.md" not in result["markdown"]


def test_report_ignores_provider_only_signed_url_tokens(tmp_path: Path) -> None:
    def signed_asset_fetcher(platform: str, query: str) -> dict:
        result = _live_fetcher(platform, query)
        result["raw_payload"]["data"]["items"][0]["image"] = (
            "https://cdn.example.test/cover.jpg?token=public-cdn-signature"
        )
        return result

    source = tmp_path / "pipeline" / "intake" / "market.md"
    source.parent.mkdir(parents=True)
    source.write_text(MATERIAL, encoding="utf-8")

    result = build_market_signal_report(
        topic="出海内容",
        source_path="pipeline/intake/market.md",
        material_text=MATERIAL,
        platforms=None,
        project=tmp_path,
        run_id="signed-url-run",
        live_fetcher=signed_asset_fetcher,
    )

    assert result["status"] == "ready"
    assert result["language_quality"]["blocking"] == []
    assert all(check["status"] == "available" for check in result["platform_checks"].values())
    assert result["snapshot_path"].startswith("runs/signed-url-run/market-research/")


def test_report_can_replay_a_verified_hosted_envelope_without_local_tikomni_credentials(tmp_path: Path) -> None:
    source = tmp_path / "pipeline" / "intake" / "market.md"
    source.parent.mkdir(parents=True)
    source.write_text(MATERIAL, encoding="utf-8")
    query = "企业出海 自媒体"
    envelope = {
        "keyId": "market-v1",
        "payload": {
            "schema": "aifios.hosted-market-research.v1",
            "requiredPlatforms": ["wechat_mp", "xiaohongshu", "wechat_channels"],
            "responses": [{
                "platform": platform,
                "query": query,
                "endpointId": f"{platform}.frozen.search",
                "status": "available",
                "payload": {
                    "data": {
                        "items": [{
                            "title": f"{platform} {query}",
                            "desc": "托管公开样本。",
                            "url": f"https://example.test/{platform}/hosted",
                            "like_count": 20,
                        }],
                    },
                },
            } for platform in ["wechat_mp", "xiaohongshu", "wechat_channels"]],
        },
        "signature": "verified-by-next-route",
    }

    result = build_market_signal_report(
        topic="出海内容",
        source_path="pipeline/intake/market.md",
        material_text=MATERIAL,
        platforms=None,
        project=tmp_path,
        run_id="hosted-run",
        live_fetcher=HostedMarketResearchFetcher(envelope).fetch,
    )

    assert result["status"] == "ready"
    assert result["snapshot_path"].startswith("runs/hosted-run/market-research/")
    assert result["sample_count"] == 3


def test_topic_query_keeps_live_research_bound_to_current_material(tmp_path: Path) -> None:
    source_path = "pipeline/intake/current.md"
    source = tmp_path / source_path
    source.parent.mkdir(parents=True)
    current = "AI 工具要先让老板看到具体业务场景，再谈转型。"
    source.write_text(current, encoding="utf-8")

    recent = tmp_path / "materials/inbox/recent.md"
    recent.parent.mkdir(parents=True)
    recent.write_text("经销商需要用内容营销解释新产品的切入路径。", encoding="utf-8")
    performance = tmp_path / "materials/performance/review-inputs/dealer.json"
    performance.parent.mkdir(parents=True)
    performance.write_text(json.dumps({
        "review_status": "completed",
        "evidence_status": "bound",
        "content_analysis": {"title": "经销商的内容营销不是教育，而是降低第一次合作阻力"},
        "performance": {"title": "经销商内容营销"},
    }, ensure_ascii=False), encoding="utf-8")
    report_path = tmp_path / "materials/weekly-review/2026-W29/weekly-review.md"
    report_path.parent.mkdir(parents=True)
    report = "# 已确认复盘\n经销商 内容营销的真实用户问题需要继续验证。\n"
    report_path.write_text(report, encoding="utf-8")
    record_path = report_path.with_name("learning-record.json")
    record_path.write_text(json.dumps({
        "status": "memory_applied",
        "report_path": "materials/weekly-review/2026-W29/weekly-review.md",
        "report_sha256": hashlib.sha256(report.encode("utf-8")).hexdigest(),
    }, ensure_ascii=False), encoding="utf-8")

    context = build_topic_query_context(tmp_path, source_path, current, include_historical_context=True)
    assert context["queries"][0] == "经销商 内容营销"
    assert {item["kind"] for item in context["sources"]} >= {
        "current_material", "recent_material", "historical_performance", "approved_weekly_learning",
    }

    default_context = build_topic_query_context(tmp_path, source_path, current)
    assert {item["kind"] for item in default_context["sources"]} == {"current_material"}
    assert "经销商 内容营销" not in default_context["queries"]

    result = build_market_signal_report(
        topic="经销商内容切入",
        source_path=source_path,
        material_text=current,
        platforms=None,
        project=tmp_path,
        run_id="context-run",
        live_fetcher=_live_fetcher,
    )

    assert result["status"] == "ready"
    assert result["queries"] == ["AI 企业转型 老板认知"]
    assert result["query_context"]["queries"][0] == "AI 企业转型 老板认知"
    assert "检索上下文" in result["markdown"]
    manifest = json.loads((tmp_path / result["snapshot_path"]).read_text(encoding="utf-8"))
    assert manifest["query_context"]["queries"][0] == "AI 企业转型 老板认知"


def test_topic_query_does_not_count_repeated_old_material_more_than_once(tmp_path: Path) -> None:
    source_path = "pipeline/intake/current.md"
    source = tmp_path / source_path
    source.parent.mkdir(parents=True)
    current = "AI 越强，越要把人的信任和判断讲清楚。"
    source.write_text(current, encoding="utf-8")

    inbox = tmp_path / "materials/inbox"
    inbox.mkdir(parents=True)
    for index in range(4):
        (inbox / f"old-{index}.md").write_text("律所治理和合伙人治理需要长期复盘。", encoding="utf-8")

    context = build_topic_query_context(tmp_path, source_path, current, include_historical_context=True)

    assert context["queries"][0] == "AI 人的价值 信任"
    provenance = {item["query"]: item for item in context["query_provenance"]}
    assert provenance["AI 人的价值 信任"]["score"] == 6
    assert provenance["律所 治理"]["score"] == 2
