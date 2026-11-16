#!/usr/bin/env python3
"""Build an explainable, evidence-backed content opportunity radar.

The script reuses AIFIOS's frozen TikOmni keyword-search adapter. It never
accepts an endpoint id or API path from the caller, keeps provider facts
separate from derived scores, and never writes a snapshot when no public
evidence is available.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from market_signal import MarketSignal, market_volume_value, normalize_tikomni_payload, score_market_signal_batch
from tikomni_adapter import TikomniMarketResearchClient
from generated_language_quality import inspect_generated_language


SCHEMA = "aifios.content-radar.v5"
SUPPORTED_PLATFORMS = {"xiaohongshu": "小红书", "wechat_mp": "公众号", "wechat_channels": "视频号"}
MAX_BASE_QUERIES = 6
MAX_DYNAMIC_QUERIES = 2
MAX_SAMPLES = 30
MAX_WECHAT_STATS_ENRICHMENTS = 8
MAX_WECHAT_COMMENT_ENRICHMENTS = 3
MAX_LOCAL_MATERIAL_FILES = 200

BEAUTY_QUERIES = [
    ("美妆 护肤 成分党", "成分功效与理性护肤"),
    ("美妆 彩妆 教程", "低门槛妆容教程"),
    ("敏感肌 修护 避坑", "敏感肌修护与避坑"),
    ("抗老 精华 测评", "抗老产品实测与选择"),
    ("通勤妆 新手", "通勤场景与新手妆容"),
    ("美妆 好物 平价", "平价好物与替代方案"),
]

BEAUTY_EMERGING_TERMS = {
    "早八妆": "早八快速妆容",
    "屏障修护": "皮肤屏障修护",
    "医美后": "医美后修护",
    "精简护肤": "精简护肤",
    "以油养肤": "以油养肤",
    "伪素颜": "伪素颜妆容",
    "妈生感": "妈生感妆容",
    "水光肌": "水光肌妆效",
    "防脱妆": "持妆与防脱妆",
    "黄黑皮": "黄黑皮妆容",
    "液体腮红": "液体腮红",
    "妆前": "妆前护理与打底",
    "防晒": "防晒选择与实测",
    "油皮": "油皮护肤与底妆",
    "干皮": "干皮护肤与底妆",
}

PLATFORM_METRIC_WEIGHTS = {
    "xiaohongshu": {
        "likes": 1.0, "digg": 1.0, "collects": 1.9, "favorites": 1.9,
        "comments": 2.2, "shares": 2.6, "views": 0.015, "plays": 0.015,
    },
    "wechat_mp": {
        "reads": 0.02, "views": 0.02, "likes": 1.3, "wows": 1.5,
        "recommends": 1.5, "comments": 2.0, "shares": 3.0, "collects": 2.0,
    },
    "wechat_channels": {
        "plays": 0.015, "views": 0.015, "likes": 1.2, "digg": 1.2,
        "comments": 2.2, "shares": 2.8, "collects": 1.8,
    },
}

def compact_text(value: Any, limit: int = 180) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def redact_public_text(value: Any, limit: int = 120) -> str:
    text = compact_text(value, limit)
    text = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[已脱敏]", text)
    text = re.sub(r"(?<!\d)1[3-9]\d{9}(?!\d)", "[已脱敏]", text)
    return text


def normalize_industry(value: Any) -> str:
    industry = compact_text(value, 30)
    if not industry:
        raise ValueError("请输入行业或领域关键词。")
    if len(industry) < 2:
        raise ValueError("行业关键词至少需要 2 个字符。")
    return industry


def normalize_choice(value: Any, choices: dict[str, str], label: str) -> str:
    selected = compact_text(value, 40)
    if selected not in choices:
        raise ValueError(f"{label}不受支持。")
    return selected


def queries_for_industry(industry: str) -> list[tuple[str, str]]:
    normalized = industry.lower().replace("行业", "").strip()
    if normalized in {"美妆", "美容", "护肤", "beauty"}:
        return BEAUTY_QUERIES
    return [
        (industry, f"{industry}核心话题"),
        (f"{industry} 避坑", f"{industry}避坑与风险"),
        (f"{industry} 测评", f"{industry}测评与选择"),
        (f"{industry} 教程", f"{industry}教程与方法"),
        (f"{industry} 趋势", f"{industry}趋势判断"),
        (f"{industry} 用户痛点", f"{industry}用户问题"),
    ]


def platform_engagement_score(platform: str, metrics: dict[str, int]) -> float:
    weights = PLATFORM_METRIC_WEIGHTS.get(platform, {})
    return round(sum(max(0, int(value or 0)) * weights.get(key, 0.08) for key, value in metrics.items()), 2)


def interaction_total(metrics: dict[str, int]) -> int:
    keys = ("likes", "digg", "collects", "favorites", "comments", "shares", "wows", "recommends")
    return sum(max(0, int(metrics.get(key) or 0)) for key in keys)


def _parse_datetime(value: str) -> datetime | None:
    text = compact_text(value, 64)
    if not text:
        return None
    normalized = text.replace("年", "-").replace("月", "-").replace("日", "").replace("/", "-")
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        try:
            parsed = datetime.strptime(normalized, "%Y-%m-%d")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def freshness_details(published_at: str, now: datetime) -> tuple[int, int | None]:
    published = _parse_datetime(published_at)
    if not published:
        return 45, None
    age_days = max(0, int((now - published).total_seconds() // 86_400))
    if age_days <= 2:
        return 100, age_days
    if age_days <= 7:
        return 90, age_days
    if age_days <= 30:
        return 72, age_days
    if age_days <= 90:
        return 48, age_days
    return 24, age_days


def _percentile(value: float, values: list[float]) -> int:
    if not values:
        return 0
    if len(set(values)) == 1:
        return 65
    ordered = sorted(values)
    below = sum(1 for candidate in ordered if candidate < value)
    equal = sum(1 for candidate in ordered if candidate == value)
    return round(100 * (below + 0.5 * equal) / len(ordered))


def unique_signals(signals: list[MarketSignal]) -> list[MarketSignal]:
    result: list[MarketSignal] = []
    seen: set[str] = set()
    for signal in signals:
        identity = (signal.source_url or signal.title).strip().lower()
        if not identity or identity in seen:
            continue
        seen.add(identity)
        result.append(signal)
    return result[:MAX_SAMPLES]


def _history_snapshots(project: Path, platform: str, industry: str) -> list[dict[str, Any]]:
    history_dir = project / "materials" / "content-radar" / platform / "history"
    snapshots: list[tuple[datetime, dict[str, Any]]] = []
    for path in sorted(history_dir.glob("*.json"))[-90:]:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        captured = _parse_datetime(payload.get("capturedAt", "")) if isinstance(payload, dict) else None
        if isinstance(payload, dict) and payload.get("industry") == industry and captured:
            snapshots.append((captured, payload))
    snapshots.sort(key=lambda item: item[0])
    return [payload for _, payload in snapshots]


def _creator_history(history: list[dict[str, Any]], platform: str) -> dict[str, list[float]]:
    result: dict[str, list[float]] = defaultdict(list)
    for snapshot in history:
        for sample in snapshot.get("samples") or []:
            if not isinstance(sample, dict):
                continue
            author = compact_text(sample.get("author"), 80)
            metrics = sample.get("metrics") if isinstance(sample.get("metrics"), dict) else {}
            value = market_volume_value(platform, metrics)
            if author and value > 0:
                result[author].append(float(value))
    return result


def signal_scores(
    signals: list[MarketSignal],
    platform: str,
    now: datetime,
    history: list[dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    weighted = [platform_engagement_score(platform, signal.metrics) for signal in signals]
    historical_authors = _creator_history(history or [], platform)
    current_author_counts: dict[str, int] = defaultdict(int)
    for signal in signals:
        if signal.account:
            current_author_counts[signal.account] += 1
    score_market_signal_batch(signals, now.isoformat(timespec="seconds"), historical_authors)
    rows: dict[str, dict[str, Any]] = {}
    for signal, value in zip(signals, weighted):
        components = signal.score_components or {}
        history_count = len(historical_authors.get(signal.account, [])) if signal.account else 0
        current_count = current_author_counts.get(signal.account, 0) if signal.account else 0
        baseline_source = "creator_history" if history_count >= 3 else "current_creator" if current_count >= 4 else "current_batch"
        rows[signal.source_url or signal.title] = {
            "weightedEngagement": round(value, 2),
            "breakoutScore": signal.hit_score,
            "sampleClass": signal.sample_class,
            "classificationReason": signal.classification_reason,
            "evidenceStatus": signal.evidence_status,
            "confidence": signal.confidence,
            "metricCompleteness": signal.metric_completeness,
            "ageDays": signal.age_days,
            "scoreComponents": components,
            "creatorBaseline": signal.creator_baseline,
            "creatorLift": signal.creator_lift,
            "engagementRate": signal.engagement_rate,
            "scoreVersion": signal.score_version,
            "scoreBasis": {
                "engagement": round(float(components.get("performance") or 0)),
                "freshness": round(float(components.get("freshness") or 0)),
                "outlier": round(float(components.get("batch_percentile") or 0)),
                "evidence": round(float(components.get("evidence") or 0)),
                "ageDays": signal.age_days,
                "creatorBaseline": round(float(signal.creator_baseline or 0), 4),
                "creatorLift": round(((signal.creator_lift or 1) - 1) * 100),
                "baselineSource": baseline_source,
                "baselineSampleCount": history_count if history_count >= 3 else current_count - 1 if current_count >= 4 else len(signals),
            },
        }
    return rows


def sample_payload(
    signal: MarketSignal,
    scores: dict[str, dict[str, Any]],
    enrichment: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    score = scores.get(signal.source_url or signal.title, {})
    return {
        "title": compact_text(signal.title, 120),
        "summary": compact_text(signal.hook, 180),
        "author": compact_text(signal.account, 80),
        "sourceUrl": signal.source_url,
        "publishedAt": signal.published_at,
        "contentForm": signal.content_form,
        "mechanism": compact_text(signal.mechanism, 80),
        "audiencePain": compact_text(signal.audience_pain, 120),
        "metrics": signal.metrics,
        "query": signal.query,
        "enrichment": (enrichment or {}).get(signal.source_url, {
            "statsStatus": "not_applicable", "commentStatus": "not_attempted", "commentSignals": [],
        }),
        **score,
    }


def discover_dynamic_queries(industry: str, signals: list[MarketSignal]) -> list[tuple[str, str]]:
    text = " ".join(f"{signal.title} {signal.hook}" for signal in signals)
    normalized = industry.lower().replace("行业", "").strip()
    candidates = dict(BEAUTY_EMERGING_TERMS) if normalized in {"美妆", "美容", "护肤", "beauty"} else {}
    for tag in re.findall(r"[#＃]([A-Za-z0-9\u4e00-\u9fff]{2,12})", text):
        if tag not in candidates and tag not in industry:
            candidates[tag] = f"样本新词：{tag}"
    counts = [(term, len(re.findall(re.escape(term), text))) for term in candidates]
    ranked = sorted((item for item in counts if item[1] > 0), key=lambda item: (-item[1], item[0]))
    base = industry.replace("行业", "").strip() or industry
    return [(f"{base} {term}", candidates[term]) for term, _ in ranked[:MAX_DYNAMIC_QUERIES]]


def direction_evidence_score(items: list[MarketSignal]) -> tuple[int, list[str]]:
    authors = {item.account for item in items if item.account}
    sufficient = sum(1 for item in items if item.evidence_status == "sufficient")
    verified = sum(1 for item in items if item.sample_class == "verified_hit")
    score = min(100, 30 + min(30, len(items) * 6) + min(20, len(authors) * 5) + min(20, sufficient * 5))
    reasons = [f"覆盖 {len(items)} 条公开样本、{len(authors)} 位创作者"]
    reasons.append(f"{sufficient} 条具备完整表现证据，{verified} 条达到可验证爆款门槛")
    return score, reasons


def load_material_corpus(project: Path) -> list[str]:
    root = project / "materials"
    if not root.is_dir():
        return []
    candidates: list[tuple[float, Path]] = []
    for path in root.rglob("*"):
        if path.suffix.lower() not in {".md", ".txt"} or not path.is_file():
            continue
        relative_parts = path.relative_to(root).parts
        if relative_parts and relative_parts[0] in {"content-radar", "tikomni", "performance"}:
            continue
        try:
            candidates.append((path.stat().st_mtime, path))
        except OSError:
            continue
    corpus: list[str] = []
    for _, path in sorted(candidates, reverse=True)[:MAX_LOCAL_MATERIAL_FILES]:
        try:
            corpus.append(path.read_text(encoding="utf-8", errors="ignore")[:12_000])
        except OSError:
            continue
    return corpus


def asset_readiness(query: str, label: str, corpus: list[str]) -> dict[str, Any]:
    terms = [item for item in re.split(r"[\s、,，/]+", f"{query} {label}") if len(item) >= 2]
    matched = [text for text in corpus if any(term.lower() in text.lower() for term in terms)]
    combined = "\n".join(matched[:20])
    patterns = {
        "个人经验": r"我|亲历|经历|复盘|踩坑",
        "客户案例": r"客户|案例|用户反馈|咨询",
        "数据证据": r"数据|样本|统计|调研|报告|%|％",
        "产品关联": r"产品|配方|成分|使用|实测|测评",
        "视觉素材": r"图片|照片|截图|视频|封面|素材",
    }
    evidence_types = [name for name, pattern in patterns.items() if re.search(pattern, combined, re.IGNORECASE)]
    score = min(100, 20 + min(40, len(matched) * 10) + len(evidence_types) * 8)
    status = "ready" if score >= 68 else "partial" if score >= 42 else "gap"
    gaps = [name for name in patterns if name not in evidence_types][:3]
    return {
        "score": score,
        "status": status,
        "label": "素材充足" if status == "ready" else "可补齐" if status == "partial" else "素材缺口",
        "matchedAssetCount": len(matched),
        "evidenceTypes": evidence_types,
        "gaps": gaps,
        "privacyNote": "只在本机计算命中数量和证据类型，不向 TikOmni 发送用户素材。",
    }


def experiment_spec(platform: str, title: str, opportunity_id: str) -> dict[str, Any]:
    if platform == "xiaohongshu":
        metric, definition = "收藏与有效评论率", "72 小时收藏和具体问题型评论 ÷ 可得曝光量；无曝光量时分别记录绝对值"
    elif platform == "wechat_channels":
        metric, definition = "播放后互动率", "72 小时点赞、评论和分享 ÷ 播放量；无播放量时分别记录绝对值"
    else:
        metric, definition = "阅读后互动率", "72 小时点赞、在看、评论和分享 ÷ 阅读数"
    return {
        "id": f"experiment-{opportunity_id.removeprefix('radar-')}",
        "hypothesis": f"采用「{title}」方向后，{metric}将高于该账号最近 10 篇同平台内容的中位数。",
        "primaryMetric": metric,
        "metricDefinition": definition,
        "baseline": "账号最近 10 篇同平台、同口径内容的中位数",
        "checkpoints": ["24h", "72h", "7d"],
        "successRule": "主要指标高于基线 20%，且来源、发布时间和授权说明完整。",
        "status": "planned",
        "dataBoundary": "只接受用户自有账号、客户授权导出或人工确认的数据。",
    }


def _previous_snapshot(project: Path, platform: str, industry: str) -> dict[str, Any] | None:
    path = project / "materials" / "content-radar" / platform / "latest.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or payload.get("industry") != industry:
        return None
    return payload


def _stable_id(platform: str, industry: str, query: str) -> str:
    value = f"{platform}|{industry}|{query}".encode("utf-8")
    return f"radar-{hashlib.sha256(value).hexdigest()[:16]}"


def _direction_history(history: list[dict[str, Any]], query: str) -> list[tuple[datetime, float]]:
    result: list[tuple[datetime, float]] = []
    for snapshot in history:
        captured = _parse_datetime(snapshot.get("capturedAt", ""))
        if not captured:
            continue
        for row in snapshot.get("opportunities") or snapshot.get("hotDirections") or []:
            if isinstance(row, dict) and compact_text(row.get("query"), 100) == query and isinstance(row.get("heat"), (int, float)):
                result.append((captured, float(row["heat"])))
                break
    return sorted(result, key=lambda item: item[0])


def _window_delta(series: list[tuple[datetime, float]], current: float, now: datetime, days: int) -> int | None:
    cutoff = now.timestamp() - days * 86_400
    eligible = [item for item in series if item[0].timestamp() <= cutoff]
    if not eligible:
        return None
    return round(current - eligible[-1][1])


def _lifecycle(series: list[tuple[datetime, float]], current: float, saturation: int) -> dict[str, Any]:
    if not series:
        return {"status": "new", "label": "新出现", "observationCount": 1}
    delta = round(current - series[-1][1])
    if delta >= 10:
        status, label = "accelerating", "加速上升"
    elif delta >= 4:
        status, label = "rising", "持续上升"
    elif delta <= -4:
        status, label = "cooling", "正在降温"
    elif len(series) >= 2 and saturation >= 80:
        status, label = "saturating", "高位拥挤"
    else:
        status, label = "stable", "稳定观察"
    return {"status": status, "label": label, "observationCount": len(series) + 1}


def calibration_payload(signals: list[MarketSignal], scores: dict[str, dict[str, Any]], history: list[dict[str, Any]]) -> dict[str, Any]:
    prior_by_source: dict[str, dict[str, Any]] = {}
    for snapshot in history:
        for sample in snapshot.get("samples") or []:
            if isinstance(sample, dict) and compact_text(sample.get("sourceUrl"), 500):
                prior_by_source[compact_text(sample.get("sourceUrl"), 500)] = sample
    evaluations: list[dict[str, Any]] = []
    for signal in signals:
        key = compact_text(signal.source_url, 500)
        prior = prior_by_source.get(key)
        current = scores.get(signal.source_url or signal.title, {})
        if not prior or not isinstance(prior.get("weightedEngagement"), (int, float)):
            continue
        previous_value = float(prior["weightedEngagement"])
        current_value = float(current.get("weightedEngagement") or 0)
        growth = round(100 * (current_value - previous_value) / max(1, previous_value))
        prior_score = int(prior.get("breakoutScore") or 0)
        evaluations.append({
            "sourceUrl": key,
            "predictedBreakout": prior_score >= 80,
            "observedGrowth": growth >= 30,
            "growthPercent": growth,
        })
    predicted = [item for item in evaluations if item["predictedBreakout"]]
    hits = [item for item in predicted if item["observedGrowth"]]
    false_positives = [item for item in predicted if not item["observedGrowth"]]
    status = "calibrated" if len(evaluations) >= 10 else "tracking" if evaluations else "insufficient"
    return {
        "status": status,
        "matchedSampleCount": len(evaluations),
        "evaluatedPredictions": len(predicted),
        "hitRate": round(100 * len(hits) / len(predicted)) if status == "calibrated" and predicted else None,
        "falsePositiveRate": round(100 * len(false_positives) / len(predicted)) if status == "calibrated" and predicted else None,
        "thresholds": {"predictedScore": 80, "observedGrowthPercent": 30},
        "note": "已匹配历史样本，满 10 条后显示命中率。" if evaluations and status != "calibrated" else "回测仅验证公开互动变化，不代表因果效果。" if status == "calibrated" else "尚无同一公开样本的后续观测，暂不声称预测有效。",
    }


def _previous_direction_map(previous: dict[str, Any] | None) -> dict[str, float]:
    if not previous:
        return {}
    rows = previous.get("opportunities") or previous.get("hotDirections") or []
    if not isinstance(rows, list):
        return {}
    result: dict[str, float] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        query = compact_text(row.get("query"), 100)
        score = row.get("heat")
        if query and isinstance(score, (int, float)):
            result[query] = float(score)
    return result


def content_suggestion(label: str, mechanisms: list[str], lead: MarketSignal, tier: str) -> str:
    mechanism = mechanisms[0] if mechanisms else "具体问题开头"
    prefix = "在本周窗口内发布" if tier == "立即做" else "先做差异化验证"
    if lead.platform == "xiaohongshu":
        return f"{prefix}：用{mechanism}切入「{label}」，正文给出可保存的清单，结尾只问一个具体问题。"
    if lead.platform == "wechat_channels":
        return f"{prefix}：用{mechanism}在前三秒提出「{label}」的冲突，再用口播、镜头和字幕完成一个清晰判断。"
    return f"{prefix}：以{mechanism}提出「{label}」的核心判断，再用案例、条件和选择标准完成论证。"


def _topic_title(label: str, platform: str) -> str:
    if platform == "xiaohongshu":
        return f"{label}：先看这几个实际问题"
    if platform == "wechat_channels":
        return f"{label}：这条口播先讲清一个冲突"
    return f"{label}：这次平台数据里出现了哪些问题"


def build_opportunities(
    query_specs: list[tuple[str, str]],
    base_queries: set[str],
    signals: list[MarketSignal],
    scores: dict[str, dict[str, Any]],
    previous: dict[str, Any] | None,
    history: list[dict[str, Any]],
    platform: str,
    industry: str,
    now: datetime,
    corpus: list[str],
    enrichment: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[str, list[MarketSignal]] = defaultdict(list)
    for signal in signals:
        grouped[signal.query].append(signal)
    max_count = max((len(items) for items in grouped.values()), default=1)
    previous_scores = _previous_direction_map(previous)
    opportunities: list[dict[str, Any]] = []
    for query, label in query_specs:
        items = grouped.get(query, [])
        if not items:
            continue
        item_scores = [scores.get(item.source_url or item.title, {}) for item in items]
        heat = round(sum(int(row.get("breakoutScore") or 0) for row in item_scores) / len(item_scores))
        freshness = round(sum(int((row.get("scoreBasis") or {}).get("freshness") or 0) for row in item_scores) / len(item_scores))
        evidence = round(sum(int((row.get("scoreBasis") or {}).get("evidence") or 0) for row in item_scores) / len(item_scores))
        saturation = round(100 * len(items) / max_count)
        mechanisms = list(dict.fromkeys(item.mechanism for item in items if item.mechanism))[:3]
        coverage, evidence_reasons = direction_evidence_score(items)
        readiness = asset_readiness(query, label, corpus)
        opportunity = round(heat * 0.55 + freshness * 0.10 + evidence * 0.15 + coverage * 0.10 + (100 - saturation) * 0.10)
        opportunity = max(1, min(100, opportunity))
        if not any(item.evidence_status == "sufficient" for item in items):
            opportunity = min(49, opportunity)
        tier = "立即做" if opportunity >= 78 else "差异化切入" if opportunity >= 65 else "继续观察" if opportunity >= 50 else "暂缓"
        previous_heat = previous_scores.get(query)
        series = _direction_history(history, query)
        if previous_heat is None:
            trend = {"status": "baseline", "label": "基线建立中", "delta": None}
        else:
            delta = round(heat - previous_heat)
            status = "rising" if delta >= 8 else "falling" if delta <= -8 else "stable"
            label_map = {"rising": "升温", "falling": "降温", "stable": "持平"}
            trend = {"status": status, "label": label_map[status], "delta": delta}
        lead = max(items, key=lambda item: int(scores.get(item.source_url or item.title, {}).get("breakoutScore") or 0))
        opportunity_id = _stable_id(platform, industry, query)
        lifecycle = _lifecycle(series, heat, saturation)
        windows = {
            "3d": _window_delta(series, heat, now, 3),
            "7d": _window_delta(series, heat, now, 7),
            "28d": _window_delta(series, heat, now, 28),
        }
        why_now = [
            f"找到 {len(items)} 条有公开来源的内容，平均热门潜力 {heat}",
            f"内容新鲜度 {freshness}，样本覆盖度 {coverage}",
            f"近期变化：{trend['label']}",
        ]
        authors = {item.account for item in items if item.account}
        metric_items = sum(1 for item in items if any(isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 for value in item.metrics.values()))
        risks = []
        if len(authors) <= 1:
            risks.append("样本创作者过于集中，可能是单一账号效应")
        if metric_items < len(items):
            risks.append("部分样本缺少公开互动字段，热度判断区间已扩大")
        if saturation >= 80:
            risks.append("同类样本集中，内容拥挤度较高")
        if readiness["status"] == "gap":
            risks.append("现有素材不够，直接写容易和别人相似")
        if not series:
            risks.append("尚无历史时间序列，不能确认持续升温")
        comment_signals: list[str] = []
        for item in items:
            for comment in (enrichment.get(item.source_url) or {}).get("commentSignals") or []:
                if comment not in comment_signals:
                    comment_signals.append(comment)
        if comment_signals:
            demand = {"source": "public_comments", "label": "公开评论需求", "signals": comment_signals[:3]}
        else:
            inferred = list(dict.fromkeys(compact_text(item.audience_pain, 100) for item in items if item.audience_pain))
            demand = {"source": "sample_semantics", "label": "根据参考内容判断（不是评论事实）", "signals": inferred[:3]}
        interval_width = 5
        interval_width += 7 if len(items) < 3 else 0
        interval_width += 7 if metric_items < len(items) else 0
        interval_width += 5 if len(authors) <= 1 else 0
        interval_width += 5 if not series else 0
        opportunities.append({
            "id": opportunity_id,
            "title": label,
            "query": query,
            "sourceType": "固定领域词" if query in base_queries else "样本新词扩展",
            "heat": heat,
            "opportunityScore": opportunity,
            "tier": tier,
            "trend": trend,
            "lifecycle": lifecycle,
            "windows": windows,
            "sampleCount": len(items),
            "engagement": sum(interaction_total(item.metrics) for item in items),
            "freshnessScore": freshness,
            "coverageScore": coverage,
            "evidenceReasons": evidence_reasons,
            "saturationScore": saturation,
            "evidenceScore": evidence,
            "scoreRange": {"low": max(1, opportunity - interval_width), "high": min(100, opportunity + interval_width)},
            "risks": risks,
            "assetReadiness": readiness,
            "demandEvidence": demand,
            "experiment": experiment_spec(platform, label, opportunity_id),
            "mechanisms": mechanisms,
            "leadSample": sample_payload(lead, scores, enrichment),
            "topicTitle": _topic_title(label, lead.platform),
            "contentSuggestion": content_suggestion(label, mechanisms, lead, tier),
            "whyNow": why_now,
            "actionPlan": [
                "先看参考内容里的用户问题，再确定自己要回答哪一个",
                "加入自己的产品体验、客户问题或专业依据",
                "发布后记录收藏、评论和转发，下次查找选题时再比较",
            ],
        })
    return sorted(opportunities, key=lambda item: (item["opportunityScore"], item["heat"]), reverse=True)


def creator_watchlist(signals: list[MarketSignal], scores: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for signal in signals:
        author = compact_text(signal.account, 80)
        if not author:
            continue
        row = scores.get(signal.source_url or signal.title, {})
        current = grouped.setdefault(author, {
            "name": author, "engagement": 0, "potentialTotal": 0,
            "postCount": 0, "primaryMechanism": "", "sourceUrl": signal.source_url,
            "liftTotal": 0, "historySamples": 0,
        })
        current["engagement"] += interaction_total(signal.metrics)
        current["potentialTotal"] += int(row.get("breakoutScore") or 0)
        current["postCount"] += 1
        basis = row.get("scoreBasis") or {}
        current["liftTotal"] += int(basis.get("creatorLift") or 0)
        if basis.get("baselineSource") == "creator_history":
            current["historySamples"] = max(current["historySamples"], int(basis.get("baselineSampleCount") or 0))
        if not current["primaryMechanism"] and signal.mechanism:
            current["primaryMechanism"] = compact_text(signal.mechanism, 80)
    ranked = sorted(grouped.values(), key=lambda item: (item["potentialTotal"], item["engagement"]), reverse=True)
    return [{
        "rank": index + 1,
        "name": item["name"],
        "engagement": item["engagement"],
        "postCount": item["postCount"],
        "averagePotential": round(item["potentialTotal"] / item["postCount"]),
        "creatorLift": round(item["liftTotal"] / item["postCount"]),
        "historySampleCount": item["historySamples"],
        "baselineStatus": "historical" if item["historySamples"] else "batch_only",
        "primaryMechanism": item["primaryMechanism"] or "还没有提取到常用做法",
        "sourceUrl": item["sourceUrl"],
    } for index, item in enumerate(ranked[:5])]


def mechanism_counts(signals: list[MarketSignal]) -> list[tuple[str, int]]:
    counts: dict[str, int] = defaultdict(int)
    for signal in signals:
        parts = [item.strip() for item in signal.mechanism.split("+") if item.strip()]
        for part in parts or ["痛点开头"]:
            counts[part] += 1
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))


def report_payload(
    industry: str,
    platform_label: str,
    signals: list[MarketSignal],
    opportunities: list[dict[str, Any]],
    creators: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    mechanisms = mechanism_counts(signals)
    top_names = [item["title"] for item in opportunities[:4]]
    deep = {
        "id": "industry-deep-report",
        "title": f"{platform_label}「{industry}」选题分析",
        "summary": f"查看了 {len(signals)} 条公开内容，未按账号类型或内容目标裁剪候选池。",
        "sections": [
            {"title": "本次结果", "bullets": [
                f"优先方向：{'、'.join(top_names) or '尚未形成稳定方向'}。",
                "推荐分参考多证据表现、发布时间、样本覆盖和同类内容数量，不代表平台完整排名。",
                "这是第一次查找，还不能判断话题是在升温还是降温。再查一次后才能比较。",
            ]},
            {"title": "常见做法", "bullets": [
                f"多条内容都在用：{'、'.join(name for name, _ in mechanisms[:4]) or '暂时没有明显的共同做法'}。",
                "可以借鉴选题结构、开头方式和信息顺序，不要复制别人的标题或正文。",
                "先完整看证据与样本差异，再结合自己的内容身份决定表达角度。",
            ]},
            {"title": "接下来怎么做", "bullets": [
                "先做标为“建议现在做”的方向，再测试一个需要换角度的方向。",
                "发布后记录收藏、评论问题和转发，下次查找选题时对照结果。",
                "如果样本时间字段缺失，不把相对互动误写成增长速度。",
            ]},
        ],
    }
    specials = [
        {"id": "trend-map", "title": f"{industry}选题优先级", "summary": "按推荐分、近期变化和同类内容数量排列。", "sections": [{"title": "先做什么", "bullets": [f"{item['title']}：推荐分 {item['opportunityScore']}，{item['trend']['label']}。" for item in opportunities[:6]]}]},
        {"id": "format-playbook", "title": f"{platform_label}常用内容做法", "summary": f"这批内容里找到 {len(mechanisms)} 类重复做法。", "sections": [{"title": "多次出现的做法", "bullets": [f"{name}：在 {count} 条内容中出现。" for name, count in mechanisms[:6]]}]},
        {"id": "creator-ecosystem", "title": f"{industry}值得关注的创作者", "summary": f"这批结果中有 {len(creators)} 位创作者值得继续观察。", "sections": [{"title": "创作者", "bullets": [f"{item['name']}：样本平均热门潜力 {item['averagePotential']}。" for item in creators] or ["当前结果没有可识别的作者。"]}]},
        {"id": "topic-opportunities", "title": f"{industry}可写选题", "summary": "这些选题需要用你自己的事实和案例来完成。", "sections": [{"title": "选题", "bullets": [item["topicTitle"] for item in opportunities[:6]]}]},
    ]
    return deep, specials


def generated_radar_text(payload: dict[str, Any]) -> str:
    """Return only system-authored prose; source titles and excerpts stay out."""
    values: list[str] = []

    def add(value: Any) -> None:
        if isinstance(value, str) and value.strip():
            values.append(value.strip())

    def add_report(report: Any) -> None:
        if not isinstance(report, dict):
            return
        add(report.get("title"))
        add(report.get("summary"))
        for section in report.get("sections") or []:
            if not isinstance(section, dict):
                continue
            add(section.get("title"))
            for bullet in section.get("bullets") or []:
                add(bullet)

    add_report(payload.get("deepReport"))
    for report in payload.get("specialReports") or []:
        add_report(report)
    for opportunity in payload.get("opportunities") or []:
        if not isinstance(opportunity, dict):
            continue
        for key in ("topicTitle", "contentSuggestion"):
            add(opportunity.get(key))
        for key in ("whyNow", "evidenceReasons", "risks", "actionPlan"):
            for item in opportunity.get(key) or []:
                add(item)
        demand = opportunity.get("demandEvidence") or {}
        if isinstance(demand, dict):
            add(demand.get("label"))
        experiment = opportunity.get("experiment") or {}
        if isinstance(experiment, dict):
            for key in ("hypothesis", "primaryMetric", "metricDefinition", "baseline", "successRule", "dataBoundary"):
                add(experiment.get(key))
    for area in (payload.get("baseline") or {}, payload.get("calibration") or {}, payload.get("methodology") or {}):
        if not isinstance(area, dict):
            continue
        for value in area.values():
            if isinstance(value, list):
                for item in value:
                    add(item)
            else:
                add(value)
    return "\n".join(values)


def _fetch_batch(client: Any, platform: str, query_specs: list[tuple[str, str]]) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    if not query_specs:
        return results
    with ThreadPoolExecutor(max_workers=min(4, len(query_specs))) as executor:
        futures = {executor.submit(client.fetch, platform, query): query for query, _ in query_specs}
        for future in as_completed(futures):
            query = futures[future]
            try:
                results[query] = future.result()
            except Exception as exc:  # pragma: no cover
                results[query] = {"status": "unavailable", "reason": str(exc)}
    return results


def _normalize_results(
    platform: str,
    query_specs: list[tuple[str, str]],
    results: dict[str, dict[str, Any]],
) -> tuple[list[MarketSignal], list[str], list[dict[str, Any]], int]:
    signals: list[MarketSignal] = []
    warnings: list[str] = []
    trace: list[dict[str, Any]] = []
    successful = 0
    for query, _ in query_specs:
        response = results.get(query, {})
        status = "available" if response.get("status") == "available" else "unavailable"
        trace.append({
            "query": query,
            "status": status,
            "endpointId": compact_text(response.get("endpoint_id"), 120) or None,
            "capability": compact_text(response.get("capability"), 40) or "search",
            "requestId": compact_text(response.get("request_id"), 120) or None,
        })
        if status != "available":
            reason = compact_text(response.get("reason") or "平台返回不可用", 160)
            if "401" in reason:
                reason = "TikOmni 拒绝当前 Token（401）。凭证可能已过期或被撤销，请在系统设置中更新后重试。"
            elif "403" in reason:
                reason = "TikOmni 拒绝本次访问（403）。请确认 Token 权限和账户套餐后重试。"
            warnings.append(f"{query}：{reason}")
            continue
        raw_payload = response.get("raw_payload")
        if isinstance(raw_payload, list):
            raw_payload = {"items": raw_payload}
        if not isinstance(raw_payload, dict):
            warnings.append(f"{query}：TikOmni 未返回可解析的公开结果。")
            continue
        successful += 1
        signals.extend(normalize_tikomni_payload(platform, query, raw_payload))
    return signals, warnings, trace, successful


def _deep_metric(payload: Any, aliases: tuple[str, ...]) -> int:
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in aliases and isinstance(value, (int, float, str)):
                digits = re.sub(r"[^0-9.]", "", str(value).replace(",", ""))
                if digits:
                    try:
                        return max(0, int(float(digits)))
                    except ValueError:
                        pass
        for value in payload.values():
            found = _deep_metric(value, aliases)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _deep_metric(value, aliases)
            if found:
                return found
    return 0


def _comment_texts(payload: Any) -> list[str]:
    texts: list[str] = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in {"content", "text", "comment", "comment_text", "message"} and isinstance(value, str):
                cleaned = redact_public_text(value)
                if cleaned and cleaned not in texts:
                    texts.append(cleaned)
            elif isinstance(value, (dict, list)):
                texts.extend(item for item in _comment_texts(value) if item not in texts)
            if len(texts) >= 12:
                break
    elif isinstance(payload, list):
        for value in payload:
            texts.extend(item for item in _comment_texts(value) if item not in texts)
            if len(texts) >= 12:
                break
    return texts[:12]


def enrich_wechat_signals(client: Any, signals: list[MarketSignal]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    stats_fetcher = getattr(client, "fetch_wechat_article_stats", None)
    comments_fetcher = getattr(client, "fetch_wechat_article_comments", None)
    if not callable(stats_fetcher):
        return {}, []
    targets = [signal for signal in signals if signal.source_url.startswith(("http://", "https://"))]
    enrichment: dict[str, dict[str, Any]] = {
        signal.source_url: {"statsStatus": "not_attempted", "commentStatus": "not_attempted", "commentSignals": []}
        for signal in targets
    }
    trace: list[dict[str, Any]] = []
    def process(kind: str, signal: MarketSignal, response: Any) -> bool:
        available = isinstance(response, dict) and response.get("status") == "available"
        endpoint_id = compact_text((response or {}).get("endpoint_id"), 120) if isinstance(response, dict) else ""
        trace.append({
            "sourceUrl": signal.source_url,
            "kind": kind,
            "status": "available" if available else "unavailable",
            "endpointId": endpoint_id or None,
            "requestId": compact_text((response or {}).get("request_id"), 120) or None if isinstance(response, dict) else None,
            "reason": compact_text((response or {}).get("reason"), 160) or None if isinstance(response, dict) else None,
        })
        record = enrichment[signal.source_url]
        if not available:
            record["statsStatus" if kind == "stats" else "commentStatus"] = "unavailable"
            return False
        raw = response.get("raw_payload")
        if kind == "stats":
            mapped = {
                "reads": _deep_metric(raw, ("read_num", "read_count", "reads", "view_count")),
                "likes": _deep_metric(raw, ("like_count", "old_like_count", "likes")),
                "wows": _deep_metric(raw, ("wow_count", "wows", "recommend_count")),
                "comments": _deep_metric(raw, ("comment_count", "comments")),
                "shares": _deep_metric(raw, ("share_count", "shares")),
                "collects": _deep_metric(raw, ("collect_count", "star_num", "collects")),
            }
            signal.metrics.update({key: value for key, value in mapped.items() if value > 0})
            record["statsStatus"] = "available" if any(mapped.values()) else "empty"
            record["metricFields"] = [key for key, value in mapped.items() if value > 0]
        else:
            comments = _comment_texts(raw)
            record["commentStatus"] = "available" if comments else "empty"
            record["commentSignals"] = comments
        return True

    # Probe each optional capability once before fan-out. A token can have
    # keyword-search permission without article stats/comments permission;
    # one 403 must stop the remaining calls instead of multiplying failures.
    first = targets[0] if targets else None
    stats_available = False
    comments_available = False
    if first:
        try:
            stats_available = process("stats", first, stats_fetcher(first.source_url))
        except Exception as exc:  # pragma: no cover
            stats_available = process("stats", first, {"status": "unavailable", "reason": str(exc)})
        if callable(comments_fetcher):
            try:
                comments_available = process("comments", first, comments_fetcher(first.source_url))
            except Exception as exc:  # pragma: no cover
                comments_available = process("comments", first, {"status": "unavailable", "reason": str(exc)})

    futures: dict[Any, tuple[str, MarketSignal]] = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        if stats_available:
            for signal in targets[1:MAX_WECHAT_STATS_ENRICHMENTS]:
                futures[executor.submit(stats_fetcher, signal.source_url)] = ("stats", signal)
        if comments_available and callable(comments_fetcher):
            for signal in targets[1:MAX_WECHAT_COMMENT_ENRICHMENTS]:
                futures[executor.submit(comments_fetcher, signal.source_url)] = ("comments", signal)
        for future in as_completed(futures):
            kind, signal = futures[future]
            try:
                process(kind, signal, future.result())
            except Exception as exc:  # pragma: no cover
                process(kind, signal, {"status": "unavailable", "reason": str(exc)})
    return enrichment, trace


def _atomic_write(path: Path, content: str) -> None:
    file_descriptor, temporary = tempfile.mkstemp(prefix="content-radar-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def persist_snapshot(project: Path, platform: str, payload: dict[str, Any]) -> tuple[str, str]:
    root = project / "materials" / "content-radar" / platform
    history = root / "history"
    history.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    history_path = history / f"{stamp}.json"
    latest_path = root / "latest.json"
    latest_relative = str(latest_path.relative_to(project))
    history_relative = str(history_path.relative_to(project))
    payload["snapshotPath"] = latest_relative
    payload["historyPath"] = history_relative
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    _atomic_write(history_path, serialized)
    _atomic_write(latest_path, serialized)
    return latest_relative, history_relative


def build_snapshot(
    project: Path,
    industry: str,
    platform: str,
    *,
    fetcher: Any | None = None,
) -> dict[str, Any]:
    industry = normalize_industry(industry)
    if platform not in SUPPORTED_PLATFORMS:
        raise ValueError("内容雷达仅支持小红书、公众号和视频号。")
    base_specs = queries_for_industry(industry)[:MAX_BASE_QUERIES]
    client = fetcher or TikomniMarketResearchClient(project, timeout_ms=50_000)
    if fetcher is None and not client.health().get("available"):
        raise RuntimeError("TikOmni Token 未配置、无效或当前不可用。请先在系统设置中完成授权。")

    base_results = _fetch_batch(client, platform, base_specs)
    base_signals, warnings, trace, successful = _normalize_results(platform, base_specs, base_results)
    dynamic_specs = discover_dynamic_queries(industry, base_signals)
    dynamic_results = _fetch_batch(client, platform, dynamic_specs)
    dynamic_signals, dynamic_warnings, dynamic_trace, dynamic_successful = _normalize_results(platform, dynamic_specs, dynamic_results)
    warnings.extend(dynamic_warnings)
    trace.extend(dynamic_trace)
    successful += dynamic_successful
    signals = unique_signals([*base_signals, *dynamic_signals])
    if not signals:
        detail = warnings[0] if warnings else "本轮检索没有返回可验证公开样本。"
        raise RuntimeError(f"内容雷达暂时没有可用样本。{detail}")

    enrichment: dict[str, dict[str, Any]] = {}
    enrichment_trace: list[dict[str, Any]] = []
    if platform == "wechat_mp":
        enrichment, enrichment_trace = enrich_wechat_signals(client, signals)
        unavailable_kinds = {item.get("kind") for item in enrichment_trace if item.get("status") == "unavailable"}
        if "stats" in unavailable_kinds:
            warnings.append("公众号关键词搜索可用，但当前 Token 没有文章互动详情权限；机会区间已扩大，互动热度不参与强结论。")
        if "comments" in unavailable_kinds:
            warnings.append("公众号评论详情权限不可用；需求信号仅使用明确标注的样本语义推导，不作为评论事实。")
    now = datetime.now(timezone.utc)
    history = _history_snapshots(project, platform, industry)
    corpus = load_material_corpus(project)
    scores = signal_scores(signals, platform, now, history)
    previous = history[-1] if history else _previous_snapshot(project, platform, industry)
    all_specs = [*base_specs, *dynamic_specs]
    opportunities = build_opportunities(
        all_specs, {query for query, _ in base_specs}, signals, scores, previous,
        history, platform, industry, now, corpus, enrichment,
    )
    creators = creator_watchlist(signals, scores)
    deep_report, special_reports = report_payload(
        industry, SUPPORTED_PLATFORMS[platform], signals, opportunities, creators,
    )
    published_count = sum(1 for signal in signals if signal.published_at)
    metric_count = sum(1 for signal in signals if any(isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 for value in signal.metrics.values()))
    evidence_count = sum(1 for signal in signals if signal.source_url.startswith(("http://", "https://")))
    time_coverage = round(100 * published_count / len(signals))
    metric_coverage = round(100 * metric_count / len(signals))
    evidence_coverage = round(100 * evidence_count / len(signals))
    previous_map = _previous_direction_map(previous)
    comparison_count = sum(1 for item in opportunities if item["query"] in previous_map)
    first_captured = compact_text((history[0] if history else {}).get("capturedAt"), 64) or None
    first_date = _parse_datetime(first_captured or "")
    baseline = {
        "status": "compared" if comparison_count else "establishing",
        "previousCapturedAt": compact_text((previous or {}).get("capturedAt"), 64) or None,
        "comparisonCount": comparison_count,
        "snapshotCount": len(history) + 1,
        "firstCapturedAt": first_captured,
        "trackedDays": max(0, int((now - first_date).total_seconds() // 86_400)) if first_date else 0,
        "note": f"已有 {comparison_count} 个同口径方向可比较。" if comparison_count else "首次扫描正在建立基线，下一次同领域扫描后显示升温和降温。",
    }
    missing_fields = []
    if time_coverage < 100:
        missing_fields.append("publishedAt")
    if metric_coverage < 100:
        missing_fields.append("metrics")
    captured_at = now.isoformat(timespec="seconds")
    snapshot_id = f"snapshot-{hashlib.sha256(f'{platform}|{industry}|{captured_at}'.encode('utf-8')).hexdigest()[:16]}"
    payload: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "ready",
        "snapshotId": snapshot_id,
        "industry": industry,
        "platform": platform,
        "platformLabel": SUPPORTED_PLATFORMS[platform],
        "capturedAt": captured_at,
        "source": "TikOmni 公开内容检索",
        "profile": {"mode": "broad", "label": "不限制账号类型与内容目标"},
        "coverage": {
            "queryCount": len(all_specs),
            "baseQueryCount": len(base_specs),
            "dynamicQueryCount": len(dynamic_specs),
            "successfulQueryCount": successful,
            "queries": [query for query, _ in all_specs],
            "baseQueries": [query for query, _ in base_specs],
            "dynamicQueries": [query for query, _ in dynamic_specs],
            "warnings": warnings,
            "enrichmentAttemptCount": len(enrichment_trace),
            "enrichedArticleCount": sum(1 for item in enrichment.values() if item.get("statsStatus") == "available"),
            "commentArticleCount": sum(1 for item in enrichment.values() if item.get("commentStatus") == "available"),
        },
        "provenance": {
            "objectType": "search_snapshot",
            "platform": platform,
            "input": {"industry": industry},
            "normalized": {"sampleCount": len(signals), "queryCount": len(all_specs)},
            "completeness": "partial" if warnings or missing_fields else "complete",
            "missingFields": missing_fields,
            "errorReason": None,
            "requestId": next((item["requestId"] for item in trace if item["requestId"]), None),
            "extractTrace": trace,
            "enrichmentTrace": enrichment_trace,
        },
        "quality": {
            "evidenceCoverage": evidence_coverage,
            "timeCoverage": time_coverage,
            "metricCoverage": metric_coverage,
            "confidence": "高" if min(evidence_coverage, time_coverage, metric_coverage) >= 85 and len(signals) >= 12 else "中" if evidence_coverage >= 80 and metric_coverage >= 60 else "低",
        },
        "baseline": baseline,
        "calibration": calibration_payload(signals, scores, history),
        "methodology": {
            "scopeLabel": "本次找到的公开内容",
            "rankScope": "创作者和选题排序只在这批可核对的内容内成立",
            "freshnessLabel": "有发布时间时计算内容新鲜度；缺失时不推断增长速度",
            "formulaVersion": "echo-founder.tikomni-hit-score.v5 + radar-opportunity-v5",
            "formulaFactors": ["v5 多证据表现 55%", "内容新鲜度 10%", "证据完整度 15%", "样本覆盖度 10%", "同类内容较少 10%"],
            "scoreLegend": ["78-100 建议现在做", "65-77 换个角度再做", "50-64 继续观察", "1-49 暂缓"],
            "limitations": [
                "不是平台全量榜单",
                "不按账号类型或内容目标提前过滤候选内容",
                "零指标、缺指标、未来时间和无公开链接的样本不会被称为爆款，但仍可在指标不足区查看",
                "时间窗没有足够跨度时保持空值，不用模型推断补齐",
                "创作者历史内容不足时，只参考这次找到的内容",
                "回测验证公开互动变化，不等同于创作结果或因果证明",
                "评论不可用时，只显示根据参考内容作出的判断，不当作评论事实",
            ],
        },
        "metrics": {
            "sampleCount": len(signals),
            "totalEngagement": sum(interaction_total(signal.metrics) for signal in signals),
            "creatorCount": len({signal.account for signal in signals if signal.account}),
            "directionCount": len(opportunities),
            "highPotentialCount": sum(1 for item in opportunities if item["tier"] == "立即做"),
            "verifiedHitCount": sum(1 for signal in signals if signal.sample_class == "verified_hit"),
            "potentialSampleCount": sum(1 for signal in signals if signal.sample_class == "potential"),
            "insufficientSampleCount": sum(1 for signal in signals if signal.sample_class == "insufficient"),
            "evidenceCoverage": evidence_coverage,
        },
        "discovery": {"emergingKeywords": [{"query": query, "label": label} for query, label in dynamic_specs]},
        "deepReport": deep_report,
        "specialReports": special_reports,
        "creatorWatchlist": creators,
        "opportunities": opportunities,
        "samples": [sample_payload(signal, scores, enrichment) for signal in sorted(signals, key=lambda item: int(scores.get(item.source_url or item.title, {}).get("breakoutScore") or 0), reverse=True)],
    }
    language_quality = inspect_generated_language(generated_radar_text(payload))
    payload["quality"]["languageStatus"] = language_quality["status"]
    payload["quality"]["languageWarnings"] = [item["message"] for item in language_quality["warnings"]]
    if language_quality["blocking"]:
        raise RuntimeError("选题说明里还有敏感信息或未完成内容，本次结果没有保存。请重新查找选题。")
    persist_snapshot(project, platform, payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Build an AIFIOS content opportunity radar snapshot")
    parser.add_argument("--project", required=True)
    parser.add_argument("--industry", required=True)
    parser.add_argument("--platform", choices=sorted(SUPPORTED_PLATFORMS), required=True)
    args = parser.parse_args()
    try:
        payload = build_snapshot(
            Path(args.project).expanduser().resolve(strict=False),
            args.industry,
            args.platform,
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": compact_text(exc, 500)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "radar": payload}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
