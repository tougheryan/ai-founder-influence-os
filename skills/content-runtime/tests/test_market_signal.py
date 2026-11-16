#!/usr/bin/env python3
"""Focused checks for material-first market signal selection."""
from __future__ import annotations

import os
import sys
import tempfile
import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "skills" / "content-runtime" / "scripts"))

from market_signal import (
    REQUIRED_MARKET_PLATFORMS,
    _required_market_platforms,
    build_theme_gate_response,
    extract_market_queries,
    fetch_market_signals,
    freeze_market_snapshot,
    normalize_market_platform,
    normalize_tikomni_payload,
    persist_market_snapshot,
    score_theme_option,
    verify_frozen_market_snapshot,
    verify_market_snapshot,
)


MATERIAL = """
这段访谈反复提到企业出海、自媒体营销、老板认知差异、经销商切入路径、AI 工具和产品力。
核心判断是直接教育老板成本太高，现阶段更适合从好产品、经销商、低成本自媒体验证和样板案例切入。
素材里还说产品力是底座，自媒体流量只是放大器。如果供应链和服务跟不上，流量会给别人做嫁衣。
"""

EXCLUDED_MATERIAL = """
别谈企业出海，也别聊经销商，更不想做老板个人 IP。
这里只讨论产品力、供应链服务和流量放大的边界。
"""

LAW_FIRM_GOVERNANCE_MATERIAL = """
这份复盘讨论一家律师事务所的合伙人治理：创始人在高压阶段后，
如何恢复节奏、重建团队协作和长期判断。
"""

SENSITIVE_LAW_FIRM_GOVERNANCE_MATERIAL = """
吴总分享了一家律所的治理复盘，重点仍是创始人在高压阶段后的恢复。
"""

CONTENT_ACQUISITION_MATERIAL = """
客户访谈发现：不少创始人把内容当作发布任务，所以团队没有沉淀真实客户问题、案例和服务过程。
我们要通过复盘，把获客路径拆成三个可验证动作。
"""


def with_provider_disabled(callback):
    previous_provider = os.environ.get("AIFIOS_MARKET_SIGNAL_PROVIDER")
    previous_token = os.environ.get("TIKOMNI_API_TOKEN")
    os.environ["AIFIOS_MARKET_SIGNAL_PROVIDER"] = "none"
    os.environ.pop("TIKOMNI_API_TOKEN", None)
    try:
        return callback()
    finally:
        if previous_provider is None:
            os.environ.pop("AIFIOS_MARKET_SIGNAL_PROVIDER", None)
        else:
            os.environ["AIFIOS_MARKET_SIGNAL_PROVIDER"] = previous_provider
        if previous_token is None:
            os.environ.pop("TIKOMNI_API_TOKEN", None)
        else:
            os.environ["TIKOMNI_API_TOKEN"] = previous_token


def live_payload(platform: str, query: str, *, empty: bool = False) -> dict:
    """A public TikOmni-like response used only as a deterministic test double."""
    if empty:
        items: list[dict] = []
    else:
        metric = {
            "wechat_mp": {"read_count": 12000, "like_count": 42},
            "xiaohongshu": {"liked_count": 320, "collected_count": 86},
            "wechat_channels": {"play_count": 9400, "digg_count": 67},
        }[platform]
        items = [{
            "title": f"{platform} {query} 的公开样本",
            "desc": "从真实问题切入，并给出一个可复用的判断。",
            "url": f"https://example.test/{platform}/{query}",
            **metric,
        }]
    return {
        "status": "available",
        "platform": platform,
        "endpoint_id": f"{platform}.search.fixture",
        "query_applied": True,
        "raw_payload": {"data": {"items": items}},
    }


def wrapped_xhs_note_payload() -> dict:
    return {
        "data": {
            "code": 200,
            "data": {
                "code": 0,
                "data": {
                    "items": [{
                        "model_type": "note",
                        "note": {
                            "id": "66bec8ca000000001e01a380",
                            "title": "律所治理的关键不是制度数量",
                            "desc": "先解决合伙人协作，再谈管理制度。",
                            "liked_count": 315,
                            "collected_count": 373,
                            "comments_count": 278,
                            "shared_count": 84,
                            "timestamp": 1723779274,
                            "type": "normal",
                            "user": {"nickname": "测试作者"},
                        },
                    }],
                },
            },
        },
    }


def healthy_live_fetcher(platform: str, query: str) -> dict:
    return live_payload(platform, query)


def write_source(project: Path, relative_path: str) -> None:
    path = project / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(MATERIAL, encoding="utf-8")


def test_extract_market_queries_respects_explicit_exclusions() -> None:
    queries = extract_market_queries(MATERIAL)
    excluded = extract_market_queries(EXCLUDED_MATERIAL)

    assert queries == [
        "企业出海 自媒体",
        "经销商 内容营销",
        "AI 企业转型 老板认知",
        "产品力 流量 放大器",
    ]
    assert "企业出海 自媒体" not in excluded
    assert "经销商 内容营销" not in excluded
    assert "老板 个人IP GTM" not in excluded


def test_extract_market_queries_covers_ai_trust_material() -> None:
    queries = extract_market_queries("AI 越强，越要重视人的信任、判断和连接。")

    assert queries == ["AI 人的价值 信任"]


def test_extract_market_queries_uses_narrow_material_fallback_for_law_firm_governance() -> None:
    queries = extract_market_queries(LAW_FIRM_GOVERNANCE_MATERIAL)

    assert queries == ["律所 治理", "创始人 恢复"]
    result = fetch_market_signals(
        LAW_FIRM_GOVERNANCE_MATERIAL,
        list(REQUIRED_MARKET_PLATFORMS),
        live_fetcher=healthy_live_fetcher,
    )
    assert result["status"] == "ready"
    assert result["queries"] == ["律所 治理"]
    assert not any(blocker["code"] == "query_missing" for blocker in result.get("blockers", []))


def test_extract_market_queries_prefers_content_acquisition_evidence_over_generic_founder_terms() -> None:
    queries = extract_market_queries(CONTENT_ACQUISITION_MATERIAL)

    assert queries == ["内容获客 客户案例", "客户问题 内容选题"]


def test_opinion_only_content_can_research_customer_questions_without_a_case() -> None:
    queries = extract_market_queries("我的观点：写内容之前，先收集客户反复问的问题。")
    assert queries == ["客户问题 内容选题"]
    assert extract_market_queries("不讨论客户问题，只谈绘画。") == []


def test_service_scope_queries_require_both_change_and_delivery_concepts() -> None:
    for material in [
        '我的观点：客户说“顺便改一下”时，不急着答应，也不要马上拒绝，先把改动写清楚。我的做法：记录这次修改影响哪项交付、增加多少工作、是否改变原定时间。',
        '客户临时增加需求，先确认服务范围和排期，再决定追加修改。',
        '讨论需求变更如何影响工作量。',
    ]:
        assert extract_market_queries(material) == ["需求变更 交付范围"]
    assert extract_market_queries('只讨论需求变更，不讨论交付范围。') == []
    assert extract_market_queries('不讨论需求变更，只谈交付范围。') == []
    assert extract_market_queries('只记录交付日期。') == []
    assert extract_market_queries('私人客户吴总说顺便改一下，双方再确认交付范围。') == ["需求变更 交付范围"]


def test_material_fallback_never_copies_sensitive_terms_or_explicitly_excluded_topics() -> None:
    sensitive_queries = extract_market_queries(SENSITIVE_LAW_FIRM_GOVERNANCE_MATERIAL)
    excluded_queries = extract_market_queries("不讨论律所治理，也不谈创始人恢复。")

    assert sensitive_queries == ["律所 治理", "创始人 恢复"]
    assert all(term not in query for query in sensitive_queries for term in ["吴总", "CEO", "董事长"])
    assert excluded_queries == []


def test_normalize_tikomni_payload_preserves_supported_signal_fields() -> None:
    payload = {
        "data": {
            "items": [{
                "title": "客户问题比自我介绍更重要",
                "desc": "先说清客户卡点，再解释服务如何承接。",
                "url": "https://mp.weixin.qq.com/s/fixture",
                "author_name": "内容观察者",
                "publish_time": "2026-07-16 09:30",
                "content_type": "article",
                "read_count": "1.2w",
                "digg_count": 23,
                "comment_count": 7,
            }],
        },
    }
    signals = normalize_tikomni_payload("wechat", "内容获客", payload)

    assert len(signals) == 1
    assert signals[0].platform == "wechat"
    assert signals[0].metrics["reads"] == 12000
    assert signals[0].metrics["likes"] == 23
    assert signals[0].source_url.startswith("https://")
    assert signals[0].account == "内容观察者"
    assert signals[0].published_at == "2026-07-16 09:30"
    assert signals[0].content_form == "文章"


def test_normalize_tikomni_payload_keeps_wider_internal_ranking_pool() -> None:
    payload = {
        "data": {
            "items": [{
                "title": f"爆款样本 {index}",
                "desc": f"第 {index} 条公开样本。",
                "url": f"https://example.test/wechat/{index}",
            } for index in range(5)],
        },
    }

    signals = normalize_tikomni_payload("wechat_mp", "内容增长", payload)

    assert len(signals) == 5
    assert all(signal.sample_class == "insufficient" for signal in signals)


def test_normalize_tikomni_payload_unwraps_xhs_note_results() -> None:
    signals = normalize_tikomni_payload("xiaohongshu", "律所 治理", wrapped_xhs_note_payload())

    assert len(signals) == 1
    signal = signals[0]
    assert signal.platform == "xiaohongshu"
    assert signal.title == "律所治理的关键不是制度数量"
    assert signal.hook == "先解决合伙人协作，再谈管理制度。"
    assert signal.metrics["likes"] == 315
    assert signal.metrics["collects"] == 373
    assert signal.metrics["comments"] == 278
    assert signal.metrics["shares"] == 84
    assert signal.source_url == "https://www.xiaohongshu.com/explore/66bec8ca000000001e01a380"
    assert signal.account == "测试作者"
    assert signal.published_at
    assert signal.content_form == "图文/视频"


def test_v5_never_ranks_future_zero_or_single_metric_rows_as_hits() -> None:
    payload = {
        "data": {
            "items": [
                {
                    "title": "内容增长的未来案例",
                    "desc": "内容增长方法",
                    "url": "https://example.test/future",
                    "author_name": "测试账号",
                    "publish_time": "2099-01-01T00:00:00+08:00",
                    "read_count": 999999,
                    "digg_count": 99999,
                },
                {
                    "title": "内容增长零指标",
                    "desc": "内容增长方法",
                    "url": "https://example.test/zero",
                    "author_name": "测试账号",
                    "publish_time": "2026-08-20T00:00:00+08:00",
                    "read_count": 0,
                    "digg_count": 0,
                },
                {
                    "title": "内容增长单指标",
                    "desc": "内容增长方法",
                    "url": "https://example.test/one",
                    "author_name": "测试账号",
                    "publish_time": "2026-08-20T00:00:00+08:00",
                    "read_count": 999999,
                },
            ]
        }
    }

    signals = normalize_tikomni_payload("wechat_mp", "内容增长", payload)

    assert {signal.sample_class for signal in signals} == {"insufficient"}
    assert all(signal.evidence_status == "insufficient" for signal in signals)
    assert all(signal.score_version == "echo-founder.tikomni-hit-score.v5" for signal in signals)


def test_v5_verified_hit_requires_multi_evidence_and_strong_batch_comparison() -> None:
    rows = []
    for index, multiplier in enumerate([30, 4, 3, 2, 1]):
        rows.append({
            "title": f"内容增长方法 {index}",
            "desc": "内容增长方法与实战案例",
            "url": f"https://example.test/ranked/{index}",
            "author_name": f"测试账号 {index}",
            "publish_time": "2026-08-20T00:00:00+08:00",
            "read_count": 10000 * multiplier,
            "digg_count": 100 * multiplier,
            "comment_count": 30 * multiplier,
            "share_count": 20 * multiplier,
            "collect_count": 10 * multiplier,
        })

    signals = normalize_tikomni_payload("wechat_mp", "内容增长", {"data": {"items": rows}})

    assert signals[0].sample_class == "verified_hit"
    assert signals[0].score_components["evidence"] >= 80
    assert signals[0].score_components["performance"] >= 75
    assert signals[0].score_components["relevance"] >= 60
    assert signals[0].hit_score >= 80
    assert all(signal.hit_score < 80 for signal in signals if signal.sample_class == "potential")
    assert all(signal.hit_score >= 80 for signal in signals if signal.sample_class == "verified_hit")


def test_market_platforms_are_canonical_for_the_three_primary_product_lanes() -> None:
    assert REQUIRED_MARKET_PLATFORMS == ("wechat_mp", "xiaohongshu", "wechat_channels")
    assert normalize_market_platform("公众号") == "wechat_mp"
    assert normalize_market_platform("xhs") == "xiaohongshu"
    assert normalize_market_platform("视频号") == "wechat_channels"
    assert normalize_market_platform("douyin") == "wechat_channels"


def test_required_platforms_cannot_be_narrowed_via_env(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = ("wechat_mp", "xiaohongshu", "wechat_channels")
    monkeypatch.delenv("AIFIOS_REQUIRED_MARKET_PLATFORMS", raising=False)
    assert _required_market_platforms() == expected

    for attempted_override in (
        "xiaohongshu",
        "小红书,wechat_mp,公众号",
        "nope,also-not-a-platform",
        "",
    ):
        monkeypatch.setenv("AIFIOS_REQUIRED_MARKET_PLATFORMS", attempted_override)
        assert _required_market_platforms() == expected


def test_missing_token_blocks_topic_research(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("TIKOMNI_API_KEY", raising=False)
    monkeypatch.delenv("TIKOMNI_API_TOKEN", raising=False)
    monkeypatch.setenv("AIFIOS_MARKET_SIGNAL_PROVIDER", "tikomni")
    monkeypatch.setenv("AIFIOS_TIKOMNI_ENV_FILE", str(tmp_path / "missing.env"))

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), tmp_path)

    assert result["status"] == "blocked"
    assert result["blockers"][0]["code"] == "tikomni_token_missing"
    assert result["signals"] == []
    assert result["no_fallback"] is True


def test_disabled_provider_blocks_topic_research(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AIFIOS_MARKET_SIGNAL_PROVIDER", "none")

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), tmp_path)

    assert result["status"] == "blocked"
    assert result["blockers"][0]["code"] == "tikomni_provider_disabled"


def test_mandatory_market_gate_checks_all_three_platforms_live() -> None:
    calls: list[tuple[str, str]] = []

    def fetcher(platform: str, query: str) -> dict:
        calls.append((platform, query))
        return healthy_live_fetcher(platform, query)

    result = fetch_market_signals(MATERIAL, ["wechat", "xhs", "shipinhao"], live_fetcher=fetcher)

    assert result["status"] == "ready"
    assert {platform for platform, _ in calls} == set(REQUIRED_MARKET_PLATFORMS)
    assert len({query for _, query in calls}) == 1
    assert result["queries"] == [calls[0][1]]
    assert result["required_platforms"] == list(REQUIRED_MARKET_PLATFORMS)
    assert all(check["status"] == "available" for check in result["platform_checks"].values())
    assert result["sufficiency"]["sufficient"] is True


def test_single_selected_platform_only_queries_and_gates_that_lane() -> None:
    calls: list[str] = []

    def fetcher(platform: str, query: str) -> dict:
        calls.append(platform)
        return healthy_live_fetcher(platform, query)

    result = fetch_market_signals(MATERIAL, ["xhs"], live_fetcher=fetcher)

    assert result["status"] == "ready"
    assert result["required_platforms"] == ["xiaohongshu"]
    assert result["ready_platforms"] == ["xiaohongshu"]
    assert calls == ["xiaohongshu"]


def test_missing_metrics_stay_unknown_and_cannot_be_called_a_hit() -> None:
    def fetcher(platform: str, query: str) -> dict:
        payload = healthy_live_fetcher(platform, query)
        item = payload["raw_payload"]["data"]["items"][0]
        for key in list(item):
            if any(token in key for token in ("count", "likes", "reads", "shares", "collect")):
                item.pop(key)
        return payload

    result = fetch_market_signals(MATERIAL, ["wechat"], live_fetcher=fetcher)
    signal = result["signals"][0]

    assert signal["sample_class"] == "insufficient"
    assert signal["hit_score"] == 0
    assert all(value is None for value in signal["metrics"].values())


def test_endpoint_failure_blocks_without_local_or_cached_fallback() -> None:
    def failed_fetcher(platform: str, query: str) -> dict:
        if platform == "wechat_channels":
            raise RuntimeError("endpoint unavailable")
        return healthy_live_fetcher(platform, query)

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=failed_fetcher)

    assert result["status"] == "ready"
    assert result["partial"] is True
    assert result["platform_checks"]["wechat_channels"]["status"] == "unavailable"
    assert result["ready_platforms"] == ["wechat_mp", "xiaohongshu"]
    assert result["used_cache"] is False
    assert result["used_local_samples"] is False


def test_transient_platform_failure_retries_only_the_failed_live_source() -> None:
    calls: dict[str, int] = {platform: 0 for platform in REQUIRED_MARKET_PLATFORMS}

    def flaky_fetcher(platform: str, query: str) -> dict:
        calls[platform] += 1
        if platform == "wechat_channels" and calls[platform] == 1:
            return {
                "status": "unavailable",
                "code": "tikomni_platform_unavailable",
                "reason": "temporary upstream failure",
            }
        return healthy_live_fetcher(platform, query)

    result = fetch_market_signals(
        MATERIAL,
        list(REQUIRED_MARKET_PLATFORMS),
        live_fetcher=flaky_fetcher,
    )

    assert result["status"] == "ready"
    assert calls == {
        "wechat_mp": 1,
        "xiaohongshu": 1,
        "wechat_channels": 2,
    }


def test_permission_failure_is_not_retried() -> None:
    calls: dict[str, int] = {platform: 0 for platform in REQUIRED_MARKET_PLATFORMS}

    def forbidden_fetcher(platform: str, query: str) -> dict:
        calls[platform] += 1
        if platform == "wechat_mp":
            return {
                "status": "unavailable",
                "code": "tikomni_permission_denied",
                "reason": "forbidden",
            }
        return healthy_live_fetcher(platform, query)

    result = fetch_market_signals(
        MATERIAL,
        list(REQUIRED_MARKET_PLATFORMS),
        live_fetcher=forbidden_fetcher,
    )

    assert result["status"] == "ready"
    assert result["platform_lanes"]["wechat_mp"]["status"] == "blocked"
    assert calls["wechat_mp"] == 1


def test_malformed_platform_payload_blocks_without_fake_samples() -> None:
    def malformed_fetcher(platform: str, query: str) -> dict:
        if platform == "xiaohongshu":
            return {
                "status": "available",
                "platform": platform,
                "endpoint_id": "xiaohongshu.fixture",
                "query_applied": True,
                "raw_payload": {"data": {"unexpected": "shape"}},
            }
        return healthy_live_fetcher(platform, query)

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=malformed_fetcher)

    assert result["status"] == "ready"
    assert result["partial"] is True
    assert result["platform_checks"]["xiaohongshu"]["status"] == "unavailable"


def test_endpoint_available_with_zero_samples_blocks_required_platform() -> None:
    def fetcher(platform: str, query: str) -> dict:
        return live_payload(platform, query, empty=platform == "wechat_channels")

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=fetcher)

    assert result["status"] == "ready"
    assert result["partial"] is True
    assert result["platform_checks"]["wechat_channels"]["sample_count"] == 0
    assert result["platform_checks"]["wechat_channels"]["status"] == "insufficient"
    assert result["platform_checks"]["wechat_channels"]["code"] == "tikomni_platform_sample_missing"
    assert {signal["platform"] for signal in result["signals"]} == {"wechat_mp", "xiaohongshu"}
    assert result["sufficiency"]["sufficient"] is False
    assert result["sufficiency"]["sample_platform_count"] == 2
    assert result["sufficiency"]["missing_platforms"] == ["wechat_channels"]


def test_single_live_source_with_verifiable_sample_is_still_blocked() -> None:
    def fetcher(platform: str, query: str) -> dict:
        if platform != "xiaohongshu":
            return live_payload(platform, query, empty=True)
        return {
            "status": "available",
            "platform": platform,
            "endpoint_id": "xiaohongshu.search.fixture",
            "query_applied": True,
            "raw_payload": {"data": {"items": [
                {
                    "title": "客户问题比产品介绍更重要",
                    "desc": "先说清客户卡点，再介绍服务如何承接。",
                    "url": "https://example.test/xiaohongshu/one",
                    "liked_count": 320,
                },
            ]}},
        }

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=fetcher)

    assert result["status"] == "ready"
    assert result["ready_platforms"] == ["xiaohongshu"]
    assert result["sufficiency"]["sample_count"] == 1
    assert result["sufficiency"]["sample_platform_count"] == 1
    assert result["sufficiency"]["missing_platforms"] == ["wechat_mp", "wechat_channels"]
    assert {blocker["platform"] for blocker in result["blockers"]} == {
        "wechat_mp",
        "wechat_channels",
    }


def test_topic_research_retries_empty_sources_with_more_material_queries() -> None:
    queries = extract_market_queries(MATERIAL)
    calls: list[tuple[str, str]] = []

    def fetcher(platform: str, query: str) -> dict:
        calls.append((platform, query))
        # The primary query only finds an XHS sample. Each zero-hit platform
        # must independently find a live public sample in supplemental queries.
        empty = not (
            (platform == "xiaohongshu" and query == queries[0])
            or (platform == "wechat_mp" and query == queries[1])
            or (platform == "wechat_channels" and query == queries[2])
        )
        return live_payload(platform, query, empty=empty)

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=fetcher)

    assert result["status"] == "ready"
    assert result["queries"] == queries[:3]
    assert result["platform_checks"]["xiaohongshu"]["sample_count"] == 1
    assert result["platform_checks"]["wechat_mp"]["sample_count"] == 1
    assert result["platform_checks"]["wechat_channels"]["sample_count"] == 1
    assert ("wechat_mp", queries[1]) in calls
    assert ("wechat_channels", queries[2]) in calls


def test_single_public_sample_cannot_replace_missing_platform_evidence() -> None:
    def fetcher(platform: str, query: str) -> dict:
        return live_payload(platform, query, empty=platform != "xiaohongshu")

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=fetcher)

    assert result["status"] == "ready"
    assert result["ready_platforms"] == ["xiaohongshu"]
    assert result["sufficiency"]["sample_count"] == 1
    assert result["sufficiency"]["sample_platform_count"] == 1
    assert set(result["sufficiency"]["missing_platforms"]) == {"wechat_mp", "wechat_channels"}


def test_zero_public_samples_block_even_when_all_endpoints_are_available() -> None:
    def fetcher(platform: str, query: str) -> dict:
        return live_payload(platform, query, empty=True)

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=fetcher)

    assert result["status"] == "blocked"
    assert result["sufficiency"]["sample_count"] == 0
    assert result["sufficiency"]["live_platform_count"] == len(REQUIRED_MARKET_PLATFORMS)
    assert result["sufficiency"]["missing_platforms"] == list(REQUIRED_MARKET_PLATFORMS)
    assert all(
        result["platform_checks"][platform]["status"] == "insufficient"
        for platform in REQUIRED_MARKET_PLATFORMS
    )


def test_unverifiable_title_only_rows_do_not_satisfy_platform_evidence() -> None:
    def fetcher(platform: str, query: str) -> dict:
        if platform != "wechat_mp":
            return live_payload(platform, query)
        return {
            "status": "available",
            "platform": platform,
            "endpoint_id": "wechat_mp.search.fixture",
            "query_applied": True,
            "raw_payload": {
                "data": {
                    "items": [{
                        "title": "只有标题、没有公开链接的结果不能作为证据",
                        "read_count": 12000,
                    }],
                },
            },
        }

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=fetcher)

    assert result["status"] == "ready"
    assert result["partial"] is True
    assert result["platform_checks"]["wechat_mp"]["code"] == "tikomni_platform_sample_missing"
    assert result["sufficiency"]["missing_platforms"] == ["wechat_mp"]


def test_wrapped_xhs_note_counts_toward_cross_platform_sufficiency() -> None:
    def fetcher(platform: str, query: str) -> dict:
        if platform == "xiaohongshu":
            return {
                "status": "available",
                "platform": platform,
                "endpoint_id": "xiaohongshu.search.fixture",
                "query_applied": True,
                "raw_payload": wrapped_xhs_note_payload(),
            }
        return live_payload(platform, query)

    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=fetcher)

    assert result["status"] == "ready"
    assert result["platform_checks"]["xiaohongshu"]["sample_count"] == 1
    assert result["platform_checks"]["wechat_channels"]["sample_count"] == 1
    assert result["sufficiency"]["sufficient"] is True
    assert result["sufficiency"]["sample_count"] == 3
    assert result["sufficiency"]["sample_platform_count"] == 3


def test_snapshot_persists_raw_normalized_metadata_and_freezes_for_a_run(tmp_path: Path) -> None:
    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=healthy_live_fetcher)
    write_source(tmp_path, "pipeline/intake/market-freeze.md")
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="market-freeze",
        topic="企业内容增长",
        source_path="pipeline/intake/market-freeze.md",
        result=result,
    )

    manifest_path = tmp_path / snapshot["manifest_path"]
    assert manifest_path.is_file()
    assert (manifest_path.parent / "normalized-samples.json").is_file()
    assert len(list((manifest_path.parent / "raw").glob("*.json"))) == 3
    assert verify_market_snapshot(tmp_path, "market-freeze", snapshot["manifest_path"])["verified"] is True

    frozen = freeze_market_snapshot(tmp_path, "market-freeze", snapshot["manifest_path"])
    assert frozen["frozen"] is True
    assert verify_frozen_market_snapshot(tmp_path, "market-freeze")["verified"] is True

    raw_path = next((manifest_path.parent / "raw").glob("*.json"))
    raw_path.write_text(json.dumps({"tampered": True}), encoding="utf-8")
    verification = verify_frozen_market_snapshot(tmp_path, "market-freeze")
    assert verification["verified"] is False
    assert verification["reason"] == "snapshot_integrity_failed"


def test_snapshot_preserves_partial_success_for_selected_platform_lanes(tmp_path: Path) -> None:
    def fetcher(platform: str, query: str) -> dict:
        if platform == "wechat_channels":
            return {"status": "unavailable", "platform": platform, "reason": "temporary outage"}
        return healthy_live_fetcher(platform, query)

    result = fetch_market_signals(MATERIAL, ["wechat", "xhs", "shipinhao"], live_fetcher=fetcher)
    write_source(tmp_path, "pipeline/intake/partial.md")
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="partial-run",
        topic="企业内容增长",
        source_path="pipeline/intake/partial.md",
        result=result,
    )

    verification = verify_market_snapshot(tmp_path, "partial-run", snapshot["manifest_path"])
    manifest = json.loads((tmp_path / snapshot["manifest_path"]).read_text(encoding="utf-8"))
    assert verification["verified"] is True
    assert verification["required_platforms"] == ["wechat_mp", "xiaohongshu", "wechat_channels"]
    assert verification["ready_platforms"] == ["wechat_mp", "xiaohongshu"]
    assert manifest["platform_lanes"]["wechat_channels"]["status"] == "blocked"


def test_frozen_snapshot_cannot_be_replaced_by_later_topic_research(tmp_path: Path) -> None:
    write_source(tmp_path, "pipeline/intake/immutable.md")
    first = persist_market_snapshot(
        project=tmp_path,
        run_id="immutable-run",
        topic="第一个选题",
        source_path="pipeline/intake/immutable.md",
        result=fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=healthy_live_fetcher),
    )
    freeze_market_snapshot(tmp_path, "immutable-run", first["manifest_path"])
    second = persist_market_snapshot(
        project=tmp_path,
        run_id="immutable-run",
        topic="第二个选题",
        source_path="pipeline/intake/immutable.md",
        result=fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=healthy_live_fetcher),
    )

    with pytest.raises(ValueError, match="已冻结"):
        freeze_market_snapshot(tmp_path, "immutable-run", second["manifest_path"])


def test_frozen_pointer_integrity_is_verified_before_downstream_use(tmp_path: Path) -> None:
    write_source(tmp_path, "pipeline/intake/frozen.md")
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="frozen-pointer",
        topic="选题",
        source_path="pipeline/intake/frozen.md",
        result=fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=healthy_live_fetcher),
    )
    freeze_market_snapshot(tmp_path, "frozen-pointer", snapshot["manifest_path"])
    pointer = tmp_path / "runs" / "frozen-pointer" / "market-research" / "frozen-snapshot.json"
    payload = json.loads(pointer.read_text(encoding="utf-8"))
    payload["snapshot_sha256"] = "0" * 64
    pointer.write_text(json.dumps(payload), encoding="utf-8")

    assert verify_frozen_market_snapshot(tmp_path, "frozen-pointer") == {
        "verified": False,
        "reason": "frozen_snapshot_sha256_mismatch",
    }


def test_frozen_snapshot_is_invalidated_when_its_bound_intake_bytes_change(tmp_path: Path) -> None:
    source_path = "pipeline/intake/changed-source.md"
    write_source(tmp_path, source_path)
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="source-bound",
        topic="选题",
        source_path=source_path,
        result=fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=healthy_live_fetcher),
    )
    freeze_market_snapshot(tmp_path, "source-bound", snapshot["manifest_path"])
    (tmp_path / source_path).write_text("素材发生改变，必须重新实时查询。", encoding="utf-8")

    result = verify_frozen_market_snapshot(tmp_path, "source-bound")

    assert result["verified"] is False
    assert result["reason"] == "snapshot_integrity_failed"
    assert result["detail"] == "source_material_sha256_mismatch"


def test_theme_gate_renders_six_scored_active_platform_options() -> None:
    with tempfile.TemporaryDirectory(prefix="aifios-market-signal-") as directory:
        response = build_theme_gate_response(
            MATERIAL,
            target_platforms=list(REQUIRED_MARKET_PLATFORMS),
            project=Path(directory),
            live_fetcher=healthy_live_fetcher,
        )

    scores = [option["score"] for option in response["options"]]
    platforms = {platform for option in response["options"] for platform in option["platforms"]}

    assert response["choice_count"] == 6
    assert [option["choice"] for option in response["options"]] == list("ABCDEF")
    assert response["recommended"] == response["options"][0]["choice"]
    assert scores == sorted(scores, reverse=True)
    assert platforms <= {"公众号", "小红书"}
    assert "回复 A-F" in response["body"]
    assert "| G |" not in response["body"]


def test_theme_gate_removes_explicitly_excluded_directions() -> None:
    with tempfile.TemporaryDirectory(prefix="aifios-market-signal-") as directory:
        response = build_theme_gate_response(
            EXCLUDED_MATERIAL,
            target_platforms=list(REQUIRED_MARKET_PLATFORMS),
            project=Path(directory),
            live_fetcher=healthy_live_fetcher,
        )

    titles = {option["title"] for option in response["options"]}
    assert "别再教育老板了，先从经销商切进去" not in titles
    assert "传统企业出海，先别谈战略，先跑一个低成本样板" not in titles


def test_score_theme_option_uses_material_and_platform_fit() -> None:
    score = score_theme_option(
        "产品力是底座，流量只是放大器",
        MATERIAL,
        [],
        ["wechat", "xhs"],
        realtime_available=False,
    )

    assert score["total"] >= 40
    assert score["breakdown"]["素材支撑"] > 0
    assert score["breakdown"]["平台适配"] > 0


def main() -> int:
    cases = [
        test_extract_market_queries_respects_explicit_exclusions,
        test_extract_market_queries_uses_narrow_material_fallback_for_law_firm_governance,
        test_material_fallback_never_copies_sensitive_terms_or_explicitly_excluded_topics,
        test_normalize_tikomni_payload_preserves_supported_signal_fields,
        test_market_platforms_are_canonical_and_channels_is_douyin_proxy,
        test_theme_gate_renders_six_scored_active_platform_options,
        test_theme_gate_removes_explicitly_excluded_directions,
        test_score_theme_option_uses_material_and_platform_fit,
    ]
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as exc:
            print(f"FAIL {case.__name__}: {exc}")
            failures += 1
        else:
            print(f"PASS {case.__name__}")
    return failures


if __name__ == "__main__":
    raise SystemExit(main())
