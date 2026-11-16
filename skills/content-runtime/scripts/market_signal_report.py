#!/usr/bin/env python3
"""Build a run-bound, fail-closed TikOmni topic-research report."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from market_signal import (
    MARKET_PLATFORM_LABELS,
    REQUIRED_MARKET_PLATFORMS,
    extract_market_queries,
    fetch_market_signals,
    normalize_market_platform,
    persist_market_snapshot,
    verify_market_snapshot,
)
from generated_language_quality import inspect_generated_language


PLATFORM_LABELS = {
    **MARKET_PLATFORM_LABELS,
}

QUERY_CONTEXT_MAX_FILES = 8
QUERY_CONTEXT_MAX_CHARS = 20_000
QUERY_CONTEXT_TEXT_SUFFIXES = {".md", ".txt", ".text", ".json"}
QUERY_CONTEXT_EXCLUDED_PARTS = {
    "advisors",
    "hit-library",
    "performance",
    "publication",
    "tikomni",
    "weekly-review",
}
QUERY_CONTEXT_WEIGHTS = {
    "current_material": 6,
    "recent_material": 2,
    "historical_performance": 4,
    "approved_weekly_learning": 3,
}


class HostedMarketResearchFetcher:
    """Replay a verified gateway envelope through the existing strict gate.

    The Next route verifies the Ed25519 signature, request nonce, and expiry
    before this object is constructed. This class only constrains the data to
    the exact platform/query rows returned by that verified envelope; it never
    makes a local TikOmni request or reads a local TikOmni credential.
    """

    def __init__(self, envelope: dict[str, Any]):
        payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
        self.responses: dict[tuple[str, str], dict[str, Any]] = {}
        for item in payload.get("responses") if isinstance(payload.get("responses"), list) else []:
            if not isinstance(item, dict):
                continue
            platform = str(item.get("platform") or "").strip()
            query = str(item.get("query") or "").strip()
            if platform in REQUIRED_MARKET_PLATFORMS and query:
                self.responses[(platform, query)] = item

    def fetch(self, platform: str, query: str) -> dict[str, Any]:
        item = self.responses.get((platform, query))
        if not item:
            return {
                "status": "unavailable",
                "platform": platform,
                "code": "hosted_research_response_missing",
                "reason": "托管研究响应未包含当前平台检索结果。",
            }
        if item.get("status") != "available":
            return {
                "status": "unavailable",
                "platform": platform,
                "code": str(item.get("code") or "tikomni_platform_unavailable"),
                "reason": str(item.get("reason") or "TikOmni 平台返回不可用。"),
            }
        payload = item.get("payload")
        if not isinstance(payload, (dict, list)):
            return {
                "status": "unavailable",
                "platform": platform,
                "code": "hosted_research_payload_invalid",
                "reason": "托管研究响应缺少可验证的公开数据。",
            }
        return {
            "status": "available",
            "platform": platform,
            "endpoint_id": str(item.get("endpointId") or ""),
            "query_applied": True,
            "query_mode": "platform-search",
            "raw_payload": payload,
        }


def load_hosted_market_envelope(path: Path | str) -> dict[str, Any]:
    """Read a route-verified, bounded hosted-research envelope from disk."""
    candidate = Path(path).expanduser().resolve(strict=True)
    if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_size > 2_000_000:
        raise ValueError("托管研究响应不可安全读取")
    try:
        envelope = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("托管研究响应格式无效") from exc
    if not isinstance(envelope, dict):
        raise ValueError("托管研究响应格式无效")
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    if payload.get("schema") != "aifios.hosted-market-research.v1":
        raise ValueError("托管研究响应契约无效")
    required_platforms = list(payload.get("requiredPlatforms") or [])
    if (
        not required_platforms
        or len(set(required_platforms)) != len(required_platforms)
        or any(platform not in REQUIRED_MARKET_PLATFORMS for platform in required_platforms)
    ):
        raise ValueError("托管研究响应缺少有效的已选平台契约")
    return envelope


def _strip_frontmatter(text: str) -> str:
    return re.sub(r"^---\n[\s\S]*?\n---\n?", "", text or "").strip()


def _query_material_text(text: str) -> str:
    """Use source evidence, not generated report language, for TikOmni queries."""
    evidence = re.findall(
        r"^- (?:核心判断句|明确观点|可用事实|核心案例|支撑细节|最值得深挖的点)：(.+)$",
        text or "",
        flags=re.MULTILINE,
    )
    return "\n".join(item.strip() for item in evidence if item.strip()) or text


def _compact(value: Any, limit: int = 80) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] + ("..." if len(text) > limit else "")


def _metric_text(metrics: dict[str, Any]) -> str:
    rows = []
    labels = (("reads", "阅读/播放"), ("likes", "点赞"), ("collects", "收藏"), ("comments", "评论"), ("shares", "转发"))
    for key, label in labels:
        value = metrics.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            rows.append(f"{label} {int(value)}")
    return "；".join(rows) or "公开指标未提供"


def _safe_text_file(project: Path, path: Path, limit: int) -> str:
    try:
        if path.is_symlink():
            return ""
        resolved = path.resolve(strict=True)
        resolved.relative_to(project)
        if not resolved.is_file() or resolved.stat().st_size > 2_000_000:
            return ""
        return resolved.read_text(encoding="utf-8", errors="ignore")[:limit]
    except (OSError, ValueError):
        return ""


def _relative(project: Path, path: Path) -> str:
    try:
        return path.resolve(strict=True).relative_to(project).as_posix()
    except (OSError, ValueError):
        return ""


def _recent_material_sources(project: Path, source_path: str) -> list[tuple[str, str]]:
    candidates: list[tuple[float, Path]] = []
    for root in [project / "materials", project / "pipeline" / "intake"]:
        if not root.is_dir() or root.is_symlink():
            continue
        for path in root.rglob("*"):
            try:
                relative = path.relative_to(project)
                if path.is_symlink() or not path.is_file() or path.suffix.lower() not in QUERY_CONTEXT_TEXT_SUFFIXES:
                    continue
                if set(relative.parts).intersection(QUERY_CONTEXT_EXCLUDED_PARTS):
                    continue
                if relative.as_posix() == source_path or path.stat().st_size > 2_000_000:
                    continue
                candidates.append((path.stat().st_mtime, path))
            except OSError:
                continue
    sources: list[tuple[str, str]] = []
    remaining = QUERY_CONTEXT_MAX_CHARS
    for _, path in sorted(candidates, key=lambda item: item[0], reverse=True)[:QUERY_CONTEXT_MAX_FILES]:
        text = _safe_text_file(project, path, min(4_000, remaining))
        if not text:
            continue
        sources.append((_relative(project, path), text))
        remaining -= len(text)
        if remaining <= 0:
            break
    return sources


def _historical_performance_sources(project: Path) -> list[tuple[str, str]]:
    root = project / "materials" / "performance" / "review-inputs"
    if not root.is_dir() or root.is_symlink():
        return []
    sources: list[tuple[str, str]] = []
    candidates = sorted((path for path in root.glob("*.json") if path.is_file() and not path.is_symlink()), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in candidates[:QUERY_CONTEXT_MAX_FILES]:
        raw = _safe_text_file(project, path, 12_000)
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict) or payload.get("review_status") not in {"review-ready", "completed"}:
            continue
        if payload.get("evidence_status") not in {"bound", "legacy"}:
            continue
        content = payload.get("content_analysis") if isinstance(payload.get("content_analysis"), dict) else {}
        performance = payload.get("performance") if isinstance(payload.get("performance"), dict) else {}
        text = "\n".join(str(value) for value in [
            content.get("title", ""), content.get("hook", ""), content.get("summary", ""),
            performance.get("title", ""),
        ] if str(value or "").strip())
        if text:
            sources.append((_relative(project, path), text[:4_000]))
    return sources


def _approved_learning_sources(project: Path) -> list[tuple[str, str]]:
    root = project / "materials" / "weekly-review"
    if not root.is_dir() or root.is_symlink():
        return []
    sources: list[tuple[str, str]] = []
    records = sorted((path for path in root.glob("*/learning-record.json") if path.is_file() and not path.is_symlink()), key=lambda path: path.stat().st_mtime, reverse=True)
    for record_path in records[:QUERY_CONTEXT_MAX_FILES]:
        raw = _safe_text_file(project, record_path, 40_000)
        if not raw:
            continue
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict) or record.get("status") != "memory_applied":
            continue
        report_relative = str(record.get("report_path") or "")
        report_digest = str(record.get("report_sha256") or "")
        if not report_relative or not re.fullmatch(r"materials/weekly-review/\d{4}-W\d{2}/weekly-review\.md", report_relative):
            continue
        report_path = project / report_relative
        report = _safe_text_file(project, report_path, 6_000)
        if not report or hashlib.sha256(report_path.read_bytes()).hexdigest() != report_digest:
            continue
        sources.append((report_relative, report))
    return sources


def build_topic_query_context(
    project: Path | str,
    source_path: str,
    material_text: str,
    *,
    include_historical_context: bool = False,
) -> dict[str, Any]:
    """Rank TikOmni query candidates from this run's intake by default.

    Historical materials can be useful for a deliberately requested trend
    study, but must never steer a new production run away from its current
    source. They are therefore opt-in and cannot soften the mandatory
    three-platform TikOmni gate.
    """
    root = Path(project).expanduser().resolve(strict=False)
    sources: list[tuple[str, str, str]] = [("current_material", source_path, material_text)]
    if include_historical_context:
        sources.extend(("recent_material", path, text) for path, text in _recent_material_sources(root, source_path))
        sources.extend(("historical_performance", path, text) for path, text in _historical_performance_sources(root))
        sources.extend(("approved_weekly_learning", path, text) for path, text in _approved_learning_sources(root))

    ranking: dict[str, dict[str, Any]] = {}
    order = 0
    summary: list[dict[str, Any]] = []
    for kind, path, text in sources:
        queries = extract_market_queries(text)
        summary.append({"kind": kind, "path": path, "query_count": len(queries)})
        for query in queries:
            entry = ranking.setdefault(query, {"query": query, "score": 0, "first_seen": order, "sources": []})
            if kind not in entry["sources"]:
                # One query appearing in several old documents is corroboration,
                # not permission to outweigh the current material repeatedly.
                entry["score"] += QUERY_CONTEXT_WEIGHTS[kind]
                entry["sources"].append(kind)
            order += 1
    ordered = sorted(ranking.values(), key=lambda item: (-int(item["score"]), int(item["first_seen"]), str(item["query"])))[:5]
    return {
        "schema": "aifios.tikomni.query-context.v1",
        "queries": [str(item["query"]) for item in ordered],
        "query_provenance": [{"query": item["query"], "score": item["score"], "sources": item["sources"]} for item in ordered],
        "sources": summary,
    }


def _normalize_platforms(platforms: list[str] | None) -> list[str]:
    """Normalize the user-selected production lanes into TikOmni source IDs."""
    if not platforms:
        return list(REQUIRED_MARKET_PLATFORMS)
    selected: list[str] = []
    for value in platforms:
        platform = normalize_market_platform(value)
        if platform not in selected:
            selected.append(platform)
    return [platform for platform in REQUIRED_MARKET_PLATFORMS if platform in selected]


def _render_market_signal_report(
    *,
    topic: str,
    source_path: str,
    normalized_platforms: list[str],
    selected_run_id: str,
    signal_result: dict[str, Any],
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Render a report from an already resolved signal result and snapshot."""
    query_context = signal_result.get("query_context") if isinstance(signal_result.get("query_context"), dict) else {}
    signals = signal_result.get("signals") if isinstance(signal_result.get("signals"), list) else []
    queries = [str(item) for item in signal_result.get("queries", []) if str(item).strip()]
    rows = []
    for signal in signals[:20]:
        if not isinstance(signal, dict):
            continue
        rows.append({
            "platform": str(signal.get("platform") or ""),
            "title": str(signal.get("title") or ""),
            "url": str(signal.get("source_url") or ""),
            "metrics": signal.get("metrics") if isinstance(signal.get("metrics"), dict) else {},
            "sample_class": str(signal.get("sample_class") or "related"),
            "hit_score": int(signal.get("hit_score") or 0),
            "classification_reason": str(signal.get("classification_reason") or ""),
            "hook": str(signal.get("hook") or ""),
            "mechanism": str(signal.get("mechanism") or ""),
            "risk": "平台上的公开内容只用于比较写法，不照搬原文，也不把别人的数据当成自己的结果。",
            "source": "TikOmni 平台数据",
        })
    creator_mode = bool(signal_result.get("creator_mode"))
    status = str(signal_result.get("status") or "unknown")
    if creator_mode:
        # Legacy providers used to return a ready zero-sample snapshot. The
        # commercial workflow must never treat that state as stage-2 evidence.
        status = "blocked"
        existing_blockers = signal_result.get("blockers") if isinstance(signal_result.get("blockers"), list) else []
        signal_result["blockers"] = [
            *existing_blockers,
            {
                "code": "creator_mode_not_permitted",
                "platform": "all",
                "message": "已选平台缺少可验证样本；商业工作流不允许用创作模式绕过研究门禁。",
            },
        ]
    status_note = str(signal_result.get("note") or "未获得实时公开样本。")
    source_labels = " / ".join(PLATFORM_LABELS.get(item, item) for item in normalized_platforms)
    actual_count = len(rows)

    blockers = signal_result.get("blockers") if isinstance(signal_result.get("blockers"), list) else []
    blocker_lines = "\n".join(
        f"- {str(item.get('message') or item.get('code') or '未知阻断')}"
        for item in blockers if isinstance(item, dict)
    ) or "- 已选平台暂未返回可用的 TikOmni 研究证据。"

    sample_table = "\n".join(
        "| {platform} | {level} | {title} | {metrics} | {reason} | {source} |".format(
            platform=PLATFORM_LABELS.get(str(item["platform"]), str(item["platform"]) or "未标注"),
            level={
                "verified_hit": "可验证爆款",
                "potential": "高潜样本",
                "related": "相关样本",
                "insufficient": "指标不足",
            }.get(str(item["sample_class"]), "指标不足"),
            title=_compact(item["title"], 48) or "标题未提供",
            metrics=_metric_text(item["metrics"]),
            reason=_compact(item["classification_reason"], 56) or "需人工核验",
            source=item["source"],
        )
        for item in rows
    ) or "| - | - | 当前没有可核对的平台内容 | 未知 | 不补写不存在的结论 | - |"

    mechanisms = []
    for item in rows:
        value = _compact(item.get("mechanism"), 80)
        if value and value not in mechanisms:
            mechanisms.append(value)
    mechanism_lines = "\n".join(f"- {item}" for item in mechanisms[:5]) or "- 当前没有可以参考的写法，不用历史内容或推测结果代替。"
    query_lines = "、".join(queries) or "从本期素材、近期材料、已确认表现与已批准复盘中未提取到稳定检索词。"
    context_lines = "；".join(
        f"{str(item.get('kind') or 'context')} {int(item.get('query_count') or 0)} 条"
        for item in query_context.get("sources", []) if isinstance(item, dict)
    ) or "没有可读取的本地查询上下文。"
    ready = status == "ready" and bool(snapshot)
    report_signal_status = "blocked" if creator_mode else status
    gate_label = "通过" if ready else "阻断"
    recommendation = (
        "可以确认已就绪平台的选题。负责人确认后，本次平台研究证据不再变化。"
        if ready else
        "暂时不能确认选题：请检查已选平台的数据后重试。"
    )
    markdown = f"""# 平台样本与爆款分级报告 · {topic or '待确认选题'}

## 0. 研究范围
- 上游素材：{source_path}
- runtime run：{selected_run_id or '缺失'}
- 目标平台：{source_labels}
- 检索词：{query_lines}
- 检索上下文：{context_lines}
- 实时信号状态：{report_signal_status}
- 样本数量：{actual_count}
- 说明：{status_note}
- 创作模式：{'是' if creator_mode else '否'}
- TikOmni 门禁：{gate_label}
- 研究快照：{snapshot.get('manifest_path') or '未生成'}
- 快照 SHA-256：{snapshot.get('snapshot_sha256') or '未生成'}
- 快照状态：{'待选题与模板人工确认后冻结' if ready else '不可用'}

## 1. 同类内容与爆款分级
| 平台 | 分级 | 标题/入口 | 公开指标 | 判断依据 | 数据来源 |
|---|---|---|---|---|---|
{sample_table}

## 2. 参考内容比较
| 比较项目 | 可以参考的做法 | 本次内容怎么使用 | 不能照搬的部分 |
|---|---|---|---|
| 标题入口 | 具体对象 + 反差/问题 | 用一手场景承载主题，不只写抽象概念 | 不复制第三方标题原句 |
| 开场钩子 | 先给现场、代价或反直觉判断 | 前三段回答“谁在什么场景卡住” | 不杜撰数据、客户或结果 |
| 结构推进 | 冲突 -> 解释 -> 方法 -> 互动 | 文章和图文卡片沿用同一条判断线 | 不把别人的故事写成自己的经历 |
| 互动需求 | 用可回答的场景问题承接评论 | 结尾收集读者的真实场景 | 不诱导私信、承诺诊断结果 |

## 3. 可以参考的写法
{mechanism_lines}

## 4. 选题建议
- 建议：{recommendation}
- 推荐动作：{'负责人确认选题和排版后，再进入内容制作。' if ready else '检查未就绪平台的数据后重新获取，不能跳过这一步。'}
- 使用边界：这些公开内容只用于比较写法，不能当成自己的内容表现、事实或商业结果。

## 4.1 门禁状态
{blocker_lines if not ready else '- 已就绪的平台均有可独立核验的公开样本；平台间互不替代。'}

## 5. 版权与事实边界
- 仅保留公开数据、链接和人工查看结果；不得绕过登录、验证码或访问控制。
- 不复制标题、正文、图卡、镜头或评论原文；只参考能说清来源的写法。
- 没有可核对的内容时，明确标记为“待采集”，不能把检索词或推测写成结论。
"""
    language_quality = inspect_generated_language(markdown)
    return {
        "markdown": markdown,
        "status": "ready" if ready else "blocked",
        "signal_status": report_signal_status,
        "queries": queries,
        "query_context": query_context,
        "sample_count": actual_count if ready else 0,
        "realtime_count": actual_count if ready else 0,
        "local_count": 0,
        "snapshot_path": snapshot.get("manifest_path", ""),
        "snapshot_sha256": snapshot.get("snapshot_sha256", ""),
        "creator_mode": bool(signal_result.get("creator_mode")),
        "blockers": blockers,
        "platform_checks": signal_result.get("platform_checks")
        if isinstance(signal_result.get("platform_checks"), dict)
        else {},
        "sufficiency": signal_result.get("sufficiency")
        if isinstance(signal_result.get("sufficiency"), dict)
        else {},
        "required_platforms": normalized_platforms,
        "ready_platforms": signal_result.get("ready_platforms")
        if isinstance(signal_result.get("ready_platforms"), list)
        else [],
        "platform_lanes": signal_result.get("platform_lanes")
        if isinstance(signal_result.get("platform_lanes"), dict)
        else {},
        "partial": bool(signal_result.get("partial")),
        "language_quality": language_quality,
        "language_warnings": language_quality["warnings"],
    }


def build_market_signal_report(
    *,
    topic: str,
    source_path: str,
    material_text: str,
    platforms: list[str] | None,
    project: Path | str,
    run_id: str = "",
    live_fetcher: Any = None,
) -> dict[str, Any]:
    """Return a run-bound report suitable for the topic/template gate."""
    project_path = Path(project).expanduser().resolve(strict=False)
    normalized_platforms = _normalize_platforms(platforms)
    selected_run_id = str(run_id or "").strip()
    query_material_text = _query_material_text(material_text)
    query_context = build_topic_query_context(project_path, source_path, query_material_text)
    if not selected_run_id:
        signal_result = {
            "status": "blocked",
            "queries": [],
            "signals": [],
            "blockers": [{"code": "run_required", "message": "选题实时研究必须绑定当前 runtime run。"}],
            "note": "没有 run，不能生成可确认的 TikOmni 研究快照。",
        }
    else:
        signal_result = fetch_market_signals(
            query_material_text,
            normalized_platforms,
            project_path,
            queries=query_context["queries"],
            live_fetcher=live_fetcher,
        )
    signal_result["query_context"] = query_context
    snapshot: dict[str, Any] = {}
    # Provider payloads contain non-editorial metadata such as signed CDN URLs
    # whose query parameters may legitimately be named ``token``. Scanning the
    # entire raw response with the generated-copy checker mistakes those URLs
    # for leaked credentials and blocks an otherwise healthy three-platform
    # result. Preflight only the report projection that can reach the operator;
    # raw provider fields remain outside the generated-language scope.
    report_preview = _render_market_signal_report(
        topic=topic,
        source_path=source_path,
        normalized_platforms=normalized_platforms,
        selected_run_id=selected_run_id,
        signal_result=signal_result,
        snapshot={},
    )
    language_preflight = report_preview["language_quality"]
    if language_preflight["blocking"]:
        signal_result["status"] = "blocked"
        signal_result["blockers"] = [
            *(signal_result.get("blockers") if isinstance(signal_result.get("blockers"), list) else []),
            {
                "code": "generated_language_blocked",
                "platform": "all",
                "message": "平台数据里有未处理的占位内容或敏感信息，请重新获取。",
            },
        ]
    if signal_result.get("status") == "ready" and not signal_result.get("creator_mode"):
        snapshot = persist_market_snapshot(
            project=project_path,
            run_id=selected_run_id,
            topic=topic,
            source_path=source_path,
            result=signal_result,
        )
    return _render_market_signal_report(
        topic=topic,
        source_path=source_path,
        normalized_platforms=normalized_platforms,
        selected_run_id=selected_run_id,
        signal_result=signal_result,
        snapshot=snapshot,
    )


def recover_market_signal_report(
    *,
    project: Path | str,
    run_id: str,
    source_path: str,
    snapshot_path: str,
) -> dict[str, Any]:
    """Rebuild the report from a verified immutable snapshot without fetching."""
    project_path = Path(project).expanduser().resolve(strict=False)
    selected_run_id = str(run_id or "").strip()
    verification = verify_market_snapshot(project_path, selected_run_id, snapshot_path)
    if not verification.get("verified"):
        raise ValueError(f"TikOmni 快照不能恢复：{verification.get('reason') or '完整性校验失败'}")
    manifest_file = _safe_project_file(project_path, str(verification["manifest_path"]))
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    manifest_source = str(manifest.get("source_path") or "")
    if manifest_source != source_path:
        raise ValueError("TikOmni 快照与当前素材不匹配")
    normalized_file = _safe_project_file(project_path, str(manifest.get("normalized_path") or ""))
    normalized = json.loads(normalized_file.read_text(encoding="utf-8"))
    if not isinstance(normalized, dict):
        raise ValueError("TikOmni 标准化快照格式无效")
    signal_result = {
        "status": "ready",
        "mode": str(manifest.get("mode") or "topic"),
        "queries": manifest.get("queries") if isinstance(manifest.get("queries"), list) else [],
        "signals": normalized.get("signals") if isinstance(normalized.get("signals"), list) else [],
        "platform_checks": normalized.get("platform_checks") if isinstance(normalized.get("platform_checks"), dict) else {},
        "sufficiency": normalized.get("sufficiency") if isinstance(normalized.get("sufficiency"), dict) else {},
        "platform_lanes": normalized.get("platform_lanes") if isinstance(normalized.get("platform_lanes"), dict) else {},
        "ready_platforms": normalized.get("ready_platforms") if isinstance(normalized.get("ready_platforms"), list) else [],
        "partial": len(manifest.get("ready_platforms") or []) != len(manifest.get("required_platforms") or []),
        "query_context": normalized.get("query_context") if isinstance(normalized.get("query_context"), dict) else {},
        "creator_mode": False,
        "blockers": normalized.get("blockers") if isinstance(normalized.get("blockers"), list) else [],
        "note": "已核验并复用本次 operation 保存的平台研究快照，未重新调用外部服务。",
    }
    return _render_market_signal_report(
        topic=str(manifest.get("topic") or ""),
        source_path=manifest_source,
        normalized_platforms=[
            str(item) for item in manifest.get("required_platforms", [])
            if str(item) in REQUIRED_MARKET_PLATFORMS
        ] or list(REQUIRED_MARKET_PLATFORMS),
        selected_run_id=selected_run_id,
        signal_result=signal_result,
        snapshot={
            "manifest_path": str(verification["manifest_path"]),
            "snapshot_sha256": str(verification["snapshot_sha256"]),
        },
    )


def _safe_project_file(project: Path, value: str) -> Path:
    candidate = (project / value).resolve(strict=False)
    try:
        candidate.relative_to(project.resolve(strict=False))
    except ValueError as exc:
        raise ValueError("source path must stay within project") from exc
    if not candidate.is_file() or candidate.is_symlink():
        raise ValueError("source path must reference a regular project file")
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a topic market-signal report")
    parser.add_argument("--project", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--topic", default="")
    parser.add_argument("--platforms", default="wechat_mp,xiaohongshu,wechat_channels")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--derive-query-context", action="store_true")
    parser.add_argument("--hosted-envelope", help="route-verified hosted research envelope; never contains a TikOmni credential")
    parser.add_argument("--recover-snapshot", help="verified run snapshot to replay locally without a TikOmni request")
    args = parser.parse_args()
    project = Path(args.project).expanduser().resolve(strict=False)
    source = _safe_project_file(project, args.source)
    material_text = _strip_frontmatter(source.read_text(encoding="utf-8"))
    if args.derive_query_context:
        query_context = build_topic_query_context(project, args.source, _query_material_text(material_text))
        print(json.dumps(query_context, ensure_ascii=False))
        return 0
    if args.recover_snapshot:
        if args.hosted_envelope:
            parser.error("--recover-snapshot cannot be combined with --hosted-envelope")
        result = recover_market_signal_report(
            project=project,
            run_id=args.run_id,
            source_path=args.source,
            snapshot_path=args.recover_snapshot,
        )
    else:
        platforms = [item for item in re.split(r"[,，/、\s]+", args.platforms) if item]
        hosted_envelope = load_hosted_market_envelope(args.hosted_envelope) if args.hosted_envelope else None
        result = build_market_signal_report(
            topic=args.topic,
            source_path=args.source,
            material_text=material_text,
            platforms=platforms,
            project=project,
            run_id=args.run_id,
            live_fetcher=HostedMarketResearchFetcher(hosted_envelope).fetch if hosted_envelope else None,
        )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
