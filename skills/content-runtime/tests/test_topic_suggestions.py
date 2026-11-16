#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "skills" / "content-runtime" / "scripts"))

import market_signal
from market_signal import REQUIRED_MARKET_PLATFORMS, fetch_market_signals, persist_market_snapshot
from topic_suggestions import build_snapshot_topic_suggestions, load_verified_snapshot_suggestions


MATERIAL = """
我们在一次客户复盘中发现，产品增长不是先堆渠道，而是先把客户问题、服务流程和转化路径讲清楚。
这次要沉淀客户案例、产品策略和增长误区，也会提到一次具体的服务改进；AI 时代老板认知和产品力、流量放大器也值得拆开讲。
"""


def test_founder_writing_material_does_not_become_weekend_time_management() -> None:
    material = (
        "目标读者是有业务经验但没有时间持续写内容的服务型创始人。"
        "观点：一篇内容是否完成，要看作者是否愿意署名发布。"
        "期望交付一篇公众号文章，讲清从原始笔记到可发布文章需要检查事实、表达和排版。"
    )
    suggestions = build_snapshot_topic_suggestions(
        material_text=material, signals=[], queries=["内容获客"],
        material_context={
            "raw_material": material,
            "selection": {"material_type_id": "business-growth", "structure_id": "customer-solution-case-cta"},
        },
    )
    assert len(suggestions) == 1
    assert all("创始人" in item["audience"] for item in suggestions)
    assert suggestions[0]["title"] == "一篇内容是否完成，要看作者是否愿意署名发布"
    assert all("周末" not in item["title"] for item in suggestions)
    assert all("内容" in item["title"] or "成稿" in item["title"] or "文章" in item["title"] for item in suggestions)

LAW_FIRM_MATERIAL = """
一位律所创始人在病后恢复的过程中，重新回到律师事务所的组织管理问题。
这不是一篇病情记录，而是一次关于恢复与重建的管理复盘：创始人与合伙人该如何重新安排角色和责任。
"""

CONTENT_ACQUISITION_MATERIAL = """
客户访谈发现：不少创始人把内容当作发布任务，所以团队没有沉淀真实客户问题、案例和服务过程。
我们准备以一次复盘，把获客路径拆成三个可验证动作：识别高频问题、沉淀可复用案例、每周复盘转化反馈。
"""

MISLEADING_INTAKE_REPORT = """
# 素材理解报告

## 情绪
- 主情绪：希望通过复盘恢复掌控感。
"""


def live_fetcher(platform: str, query: str) -> dict:
    return {
        "status": "available",
        "query_applied": True,
        "endpoint_id": f"{platform}.fixture",
        "raw_payload": {
            "items": [{
                "title": f"{platform} {query} 公开样本",
                "desc": "从客户问题切入，再给出一个可执行的增长判断。",
                "url": f"https://example.test/{platform}",
                "author_name": f"{platform} 创作者",
                "publish_time": "2026-07-16",
                "content_type": "video" if platform == "wechat_channels" else "article",
                "read_count": 12000,
                "like_count": 320,
            }],
        },
    }


def test_snapshot_topic_suggestions_stay_bound_to_verified_normalized_evidence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "pipeline" / "intake" / "topic-intake.md"
    source.parent.mkdir(parents=True)
    source.write_text(MATERIAL, encoding="utf-8")
    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=live_fetcher)
    assert result["status"] == "ready"
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="topic-run",
        topic="",
        source_path="pipeline/intake/topic-intake.md",
        result=result,
    )
    context = tmp_path / "sessions" / "material-analysis" / "topic-run.json"
    context.parent.mkdir(parents=True)
    context.write_text(json.dumps({
        "schema": "aifios.material-analysis.v1",
        "runId": "topic-run",
        "input": {
            "rawMaterial": MATERIAL,
            "files": [],
            "links": [{"url": "https://example.test/reference", "status": "parsed", "title": "参考文章", "excerpt": "客户案例要先讲清问题。"}],
        },
        "analysis": {
            "summary": "本期以客户问题、服务流程和增长判断为主。",
            "facts": ["这次复盘涉及客户问题和服务流程。"],
            "cases": ["一个服务改进案例。"],
        },
        "selection": {"materialTypeId": "business-growth", "structureId": "growth-mistake-mechanism-list"},
    }, ensure_ascii=False), encoding="utf-8")

    def should_not_fetch(*_args, **_kwargs):
        raise AssertionError("topic suggestions must not fetch TikOmni again")

    monkeypatch.setattr(market_signal, "fetch_market_signals", should_not_fetch)
    payload = load_verified_snapshot_suggestions(
        project=tmp_path,
        run_id="topic-run",
        snapshot_path=snapshot["manifest_path"],
        snapshot_sha256=snapshot["snapshot_sha256"],
        source_path="pipeline/intake/topic-intake.md",
    )

    assert payload["suggestion_count"] == 2
    assert len(payload["suggestions"]) == 2
    assert len({item["id"] for item in payload["suggestions"]}) == 2
    assert len({item["title"] for item in payload["suggestions"]}) == 2
    assert all(item["material_type_id"] == "business-growth" for item in payload["suggestions"])
    assert "raw_payload" not in json.dumps(payload, ensure_ascii=False)


def test_snapshot_topic_suggestions_reject_a_digest_or_intake_mismatch(tmp_path: Path) -> None:
    source = tmp_path / "pipeline" / "intake" / "topic-intake.md"
    source.parent.mkdir(parents=True)
    source.write_text(MATERIAL, encoding="utf-8")
    result = fetch_market_signals(MATERIAL, list(REQUIRED_MARKET_PLATFORMS), live_fetcher=live_fetcher)
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="topic-run",
        topic="",
        source_path="pipeline/intake/topic-intake.md",
        result=result,
    )

    with pytest.raises(ValueError, match="摘要"):
        load_verified_snapshot_suggestions(
            project=tmp_path,
            run_id="topic-run",
            snapshot_path=snapshot["manifest_path"],
            snapshot_sha256="b" * 64,
            source_path="pipeline/intake/topic-intake.md",
        )
    with pytest.raises(ValueError, match="绑定的 intake"):
        load_verified_snapshot_suggestions(
            project=tmp_path,
            run_id="topic-run",
            snapshot_path=snapshot["manifest_path"],
            snapshot_sha256=snapshot["snapshot_sha256"],
            source_path="pipeline/intake/other.md",
        )


def test_law_firm_recovery_material_uses_anchored_topics_without_refetching_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "pipeline" / "intake" / "law-firm-intake.md"
    source.parent.mkdir(parents=True)
    source.write_text(LAW_FIRM_MATERIAL, encoding="utf-8")
    fetch_calls: list[tuple[str, str]] = []

    def tracking_fetcher(platform: str, query: str) -> dict:
        fetch_calls.append((platform, query))
        return live_fetcher(platform, query)

    result = fetch_market_signals(
        LAW_FIRM_MATERIAL,
        list(REQUIRED_MARKET_PLATFORMS),
        live_fetcher=tracking_fetcher,
    )
    assert result["status"] == "ready"
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="law-firm-run",
        topic="",
        source_path="pipeline/intake/law-firm-intake.md",
        result=result,
    )
    context = tmp_path / "sessions" / "material-analysis" / "law-firm-run.json"
    context.parent.mkdir(parents=True)
    context.write_text(json.dumps({
        "schema": "aifios.material-analysis.v1",
        "runId": "law-firm-run",
        "input": {"rawMaterial": LAW_FIRM_MATERIAL, "files": [], "links": []},
        "analysis": {
            "summary": "围绕律所创始人的恢复与重建，梳理律师事务所组织管理中的角色安排。",
            "facts": ["素材明确讨论律师事务所的组织管理。"],
            "cases": ["一位创始人在恢复期间重新讨论团队责任。"],
        },
        "selection": {"materialTypeId": "personal-growth", "structureId": "pressure-repair-longterm"},
    }, ensure_ascii=False), encoding="utf-8")

    fetch_count_before_suggestions = len(fetch_calls)

    def should_not_fetch(*_args, **_kwargs):
        raise AssertionError("material-anchored suggestions must not fetch TikOmni again")

    monkeypatch.setattr(market_signal, "fetch_market_signals", should_not_fetch)
    payload = load_verified_snapshot_suggestions(
        project=tmp_path,
        run_id="law-firm-run",
        snapshot_path=snapshot["manifest_path"],
        snapshot_sha256=snapshot["snapshot_sha256"],
        source_path="pipeline/intake/law-firm-intake.md",
    )

    titles = [item["title"] for item in payload["suggestions"]]
    assert len(titles) == 3
    assert len(set(titles)) == 3
    assert sum(
        any(anchor in title for anchor in ("律所", "律师事务所", "治理", "创始人"))
        for title in titles
    ) >= 3
    assert sum("律所治理" in title for title in titles) >= 3
    assert all("重建与重建" not in title and "恢复与恢复" not in title for title in titles)
    assert all("素材锚点：" in item["material_evidence"] for item in payload["suggestions"])
    assert all("需人工确认" not in item["material_evidence"] for item in payload["suggestions"])
    assert all("律所创始人" in item["audience"] for item in payload["suggestions"])
    assert len(fetch_calls) == fetch_count_before_suggestions


def test_generated_intake_report_cannot_inject_recovery_into_content_acquisition_topics(tmp_path: Path) -> None:
    source = tmp_path / "pipeline" / "intake" / "content-acquisition-intake.md"
    source.parent.mkdir(parents=True)
    source.write_text(MISLEADING_INTAKE_REPORT, encoding="utf-8")
    result = fetch_market_signals(
        CONTENT_ACQUISITION_MATERIAL,
        list(REQUIRED_MARKET_PLATFORMS),
        live_fetcher=live_fetcher,
    )
    assert result["status"] == "ready"
    snapshot = persist_market_snapshot(
        project=tmp_path,
        run_id="content-acquisition-run",
        topic="",
        source_path="pipeline/intake/content-acquisition-intake.md",
        result=result,
    )
    context = tmp_path / "sessions" / "material-analysis" / "content-acquisition-run.json"
    context.parent.mkdir(parents=True)
    context.write_text(json.dumps({
        "schema": "aifios.material-analysis.v1",
        "runId": "content-acquisition-run",
        "input": {"rawMaterial": CONTENT_ACQUISITION_MATERIAL, "files": [], "links": []},
        "analysis": {
            "summary": "希望通过复盘恢复掌控感。",
            "facts": ["客户访谈发现内容没有沉淀真实客户问题、案例和服务过程。"],
            "cases": ["用每周复盘转化反馈，沉淀可复用案例。"],
        },
        "selection": {"materialTypeId": "business-growth", "structureId": "customer-solution-case-cta"},
    }, ensure_ascii=False), encoding="utf-8")

    payload = load_verified_snapshot_suggestions(
        project=tmp_path,
        run_id="content-acquisition-run",
        snapshot_path=snapshot["manifest_path"],
        snapshot_sha256=snapshot["snapshot_sha256"],
        source_path="pipeline/intake/content-acquisition-intake.md",
    )

    titles = [item["title"] for item in payload["suggestions"]]
    assert len(titles) == 3
    assert all("恢复" not in title and "重建" not in title for title in titles)
    assert any("获客" in title for title in titles)
    assert any("问题" in title or "案例" in title for title in titles)
    assert all("恢复" not in item["material_evidence"] for item in payload["suggestions"])


def test_service_method_topics_keep_author_point_and_ignore_test_labels_and_popular_samples():
    raw = (
        '【产品体验用模拟素材，不是真实客户案例，不得对外当作经营成果】\n'
        '我经营一个三人的服务团队。这次只想把处理需求变更的方法写给其他小团队负责人。\n'
        '我的观点：客户说“顺便改一下”时，不急着答应，也不要马上拒绝，先把改动写清楚。\n'
        '我的做法：记录这次修改影响哪项交付、增加多少工作、是否改变原定时间；超出原约定时列明方案，请对方确认后再开始。\n'
        '我希望读者记住：把变化讲清楚，双方才能知道下一步做什么。\n'
        '要求：700到1000字，平实直接。不要“赋能、闭环、破局”。不引导私信、购买或预约。'
    )
    result = build_snapshot_topic_suggestions(material_text=raw, queries=['美妆行业'], signals=[],
        material_context={'raw_material': raw, 'selection': {'material_type_id': 'business-growth', 'structure_id': 'customer-question-method'}})
    assert len(result) == 2
    assert result[0]['title'] == '客户说“顺便改一下”时，先把改动写清楚'
    assert result[1]['title'] == '记录这次修改影响哪项交付、增加多少工作、是否改变原定时间'
    assert all(item['audience'] == '其他小团队负责人' for item in result)
    assert all(item['material_evidence'].removeprefix('原文：') in raw for item in result)
    assert all(not any(word in item['title'] for word in ['产品体验', '美妆', '获客', '赋能']) for item in result)


def test_unfamiliar_material_is_not_padded_with_business_or_writing_advice():
    raw = '观点：给阳台薄荷浇水前，先摸一下盆里的土，不要每天照表浇水。'
    result = build_snapshot_topic_suggestions(material_text=raw, signals=[], queries=['内容获客'])
    assert len(result) == 1
    assert '薄荷' in result[0]['title'] and '不要每天照表浇水' in result[0]['title']
    assert '原文：' in result[0]['material_evidence']
    assert build_snapshot_topic_suggestions(material_text='要求：平实直接。结尾不要引导购买。', signals=[], queries=['流量']) == []
