#!/usr/bin/env python3
"""AIFIOS hit collector.

Collects public-facing hit content samples into materials/hit-library and
generates lightweight benchmark reports for content planning.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


PLATFORMS = ["wechat", "xhs"]
PLATFORM_ALIASES = {
    "公众号": "wechat",
    "wechat": "wechat",
    "weixin": "wechat",
    "微信": "wechat",
    "小红书": "xhs",
    "rednote": "xhs",
    "xiaohongshu": "xhs",
    "xhs": "xhs",
}

PLATFORM_FIELDS = {
    "wechat": ["reads", "likes", "wows", "comments", "shares"],
    "xhs": ["likes", "collects", "comments", "shares"],
}


@dataclass
class HitSample:
    platform: str
    title: str
    url: str = ""
    author: str = ""
    account_id: str = ""
    keyword: str = ""
    topic: str = ""
    content_type: str = ""
    publish_date: str = ""
    captured_at: str = ""
    cover_text: str = ""
    hook: str = ""
    summary: str = ""
    audience_pain: str = ""
    commercial_angle: str = ""
    why_it_worked: str = ""
    tags: list[str] = None
    metrics: dict[str, int] = None
    score: float = 0.0
    confidence_score: float = 0.0
    confidence_reasons: list[str] = None
    quality_status: str = ""
    quality_issues: list[str] = None
    quality_reviews: list[str] = None
    duplicate_of: str = ""
    sample_id: str = ""
    source_type: str = "manual"

    def __post_init__(self) -> None:
        self.platform = normalize_platform(self.platform)
        self.title = str(self.title or "").strip()
        self.url = str(self.url or "").strip()
        self.author = str(self.author or "").strip()
        self.account_id = str(self.account_id or "").strip()
        self.keyword = str(self.keyword or "").strip()
        self.topic = str(self.topic or "").strip()
        self.content_type = str(self.content_type or "").strip()
        self.publish_date = str(self.publish_date or "").strip()
        self.captured_at = self.captured_at or datetime.now().isoformat()
        self.cover_text = str(self.cover_text or "").strip()
        self.hook = str(self.hook or "").strip()
        self.summary = str(self.summary or "").strip()
        self.audience_pain = str(self.audience_pain or "").strip()
        self.commercial_angle = str(self.commercial_angle or "").strip()
        self.why_it_worked = str(self.why_it_worked or "").strip()
        self.tags = normalize_tags(self.tags)
        self.metrics = normalize_metrics(self.metrics)
        self.score = round(float(self.score or score_sample(self.platform, self.metrics)), 2)
        self.confidence_reasons = normalize_tags(self.confidence_reasons)
        if not self.confidence_score:
            confidence = confidence_for_sample(self)
            self.confidence_score = confidence["score"]
            self.confidence_reasons = confidence["reasons"]
        else:
            self.confidence_score = round(float(self.confidence_score), 2)
        self.quality_issues = normalize_tags(self.quality_issues)
        self.quality_reviews = normalize_tags(self.quality_reviews)
        if not self.quality_status:
            quality = sample_quality_audit(self)
            self.quality_status = quality["status"]
            self.quality_issues = quality["issues"]
            self.quality_reviews = quality["reviews"]
        self.duplicate_of = str(self.duplicate_of or "").strip()
        self.sample_id = self.sample_id or sample_id(self)


def normalize_platform(value: str) -> str:
    key = str(value or "").strip().lower()
    platform = PLATFORM_ALIASES.get(key, key)
    if platform not in PLATFORMS:
        raise ValueError(f"未知平台: {value}，可用: {', '.join(PLATFORMS)}")
    return platform


def normalize_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    text = str(value).replace("，", ",")
    return [v.strip() for v in text.split(",") if v.strip()]


def parse_number(value: Any) -> int:
    if value in (None, ""):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().lower().replace(",", "")
    multiplier = 1
    if text.endswith("w") or text.endswith("万"):
        multiplier = 10000
        text = text[:-1]
    elif text.endswith("k"):
        multiplier = 1000
        text = text[:-1]
    try:
        return int(float(text) * multiplier)
    except ValueError:
        digits = re.sub(r"[^0-9.]", "", text)
        return int(float(digits) * multiplier) if digits else 0


def normalize_metrics(value: Any) -> dict[str, int]:
    if value is None:
        return {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {}
    return {str(k): parse_number(v) for k, v in dict(value).items() if parse_number(v) >= 0}


def score_sample(platform: str, metrics: dict[str, int]) -> float:
    fields = PLATFORM_FIELDS.get(platform, [])
    weights = {
        "reads": 0.18,
        "likes": 1.0,
        "collects": 1.7,
        "comments": 2.0,
        "shares": 2.3,
        "wows": 1.4,
        "recommends": 1.5,
    }
    score = 0.0
    for field in fields:
        score += metrics.get(field, 0) * weights.get(field, 1.0)
    return score


def sample_id(sample: HitSample) -> str:
    seed = "|".join([
        sample.platform,
        sample.url,
        sample.title,
        sample.author,
        sample.keyword,
    ])
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]


def normalize_text_key(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().lower())


PLACEHOLDER_PATTERN = re.compile(
    r"^(?:无|暂无|待补|待补充|待确认|未提供|未知|空|none|null|nil|n/a|na|todo|tbd|xxx|x{2,}|-)+$",
    re.IGNORECASE,
)


def is_placeholder(value: Any) -> bool:
    text = str(value or "").strip()
    if not text:
        return True
    normalized = re.sub(r"[\s。！？!?,，；;：:]+", "", text).lower()
    return bool(PLACEHOLDER_PATTERN.match(normalized))


def meaningful_text(value: Any, min_len: int = 1) -> bool:
    text = str(value or "").strip()
    return len(text) >= min_len and not is_placeholder(text)


def positive_metric_fields(sample: HitSample) -> list[str]:
    fields = PLATFORM_FIELDS.get(sample.platform, [])
    return [field for field in fields if sample.metrics.get(field, 0) > 0]


def has_metric_signal(sample: HitSample) -> bool:
    return any(value > 0 for value in sample.metrics.values())


def has_mechanism_signal(sample: HitSample) -> bool:
    return any(
        meaningful_text(value, 4)
        for value in [sample.cover_text, sample.hook, sample.why_it_worked]
    )


def has_demand_or_business_signal(sample: HitSample) -> bool:
    return any(
        meaningful_text(value, 4)
        for value in [sample.audience_pain, sample.commercial_angle, sample.why_it_worked]
    )


def sample_breakdown_ready(sample: HitSample) -> bool:
    return (
        sample.quality_status != "blocked"
        and sample.confidence_score >= 0.5
        and meaningful_text(sample.title, 6)
        and has_metric_signal(sample)
        and has_mechanism_signal(sample)
        and has_demand_or_business_signal(sample)
    )


def sample_quality_audit(sample: HitSample) -> dict[str, Any]:
    issues: list[str] = []
    reviews: list[str] = []

    if not meaningful_text(sample.title, 6):
        issues.append("标题缺失、过短或仍是占位文本")
    elif len(normalize_text_key(sample.title)) < 8:
        reviews.append("标题信息密度偏低，建议补充人群、冲突或利益点")

    if not has_metric_signal(sample):
        issues.append("缺少可验证的表现指标，无法证明这是爆款样本")
    elif len(positive_metric_fields(sample)) < 2:
        reviews.append("指标维度偏薄，建议至少补点赞、收藏/推荐、评论、分享中的两类")

    if not meaningful_text(sample.url, 8) and not meaningful_text(sample.author, 2):
        reviews.append("缺少链接或作者，来源可追溯性不足")

    if not has_mechanism_signal(sample):
        reviews.append("缺少封面/开头钩子/可借鉴机制，后续拆解容易变成猜测")

    if not has_demand_or_business_signal(sample):
        reviews.append("缺少评论需求、商业角度或可迁移理由，商业承接不足")

    placeholder_fields = []
    for field, label in [
        ("cover_text", "封面文字"),
        ("hook", "开头钩子"),
        ("summary", "摘要"),
        ("audience_pain", "用户痛点"),
        ("commercial_angle", "商业角度"),
        ("why_it_worked", "可借鉴点"),
    ]:
        value = getattr(sample, field)
        if str(value or "").strip() and is_placeholder(value):
            placeholder_fields.append(label)
    if placeholder_fields:
        reviews.append("存在占位字段：" + "、".join(placeholder_fields))

    status = "blocked" if issues else "review_required" if reviews else "pass"
    return {"status": status, "issues": issues, "reviews": reviews}


def confidence_for_sample(sample: HitSample) -> dict[str, Any]:
    score = 0.0
    reasons: list[str] = []
    if meaningful_text(sample.title, 6):
        score += 0.25
        reasons.append("title")
    if meaningful_text(sample.url, 8) and sample.url.startswith(("http://", "https://", "file://")):
        score += 0.18
        reasons.append("url")
    if meaningful_text(sample.author, 2):
        score += 0.10
        reasons.append("author")
    if has_metric_signal(sample):
        score += 0.18
        reasons.append("metrics")
    if meaningful_text(sample.cover_text, 4):
        score += 0.08
        reasons.append("cover_text")
    if meaningful_text(sample.hook, 4):
        score += 0.10
        reasons.append("hook")
    if meaningful_text(sample.summary, 6):
        score += 0.06
        reasons.append("summary")
    if meaningful_text(sample.keyword, 2) or meaningful_text(sample.topic, 2):
        score += 0.05
        reasons.append("keyword")
    return {"score": round(min(score, 1.0), 2), "reasons": reasons}


class HitLibrary:
    def __init__(self, project: Path | str):
        self.project = Path(project).expanduser().resolve(strict=False)
        self.root = self.project / "materials" / "hit-library"
        self.queue_root = self.root / "pending"

    def init(self) -> dict[str, Any]:
        for platform in PLATFORMS:
            (self.root / platform).mkdir(parents=True, exist_ok=True)
        (self.root / "benchmark").mkdir(parents=True, exist_ok=True)
        self.queue_root.mkdir(parents=True, exist_ok=True)
        readme = self.root / "README.md"
        if not readme.exists():
            readme.write_text(self._readme(), encoding="utf-8")
        return {"status": "initialized", "path": str(self.root)}

    def _readme(self) -> str:
        return """# Hit Library

Public-facing benchmark samples for AIFIOS.

Directories:

- `wechat/`: WeChat official account articles
- `xhs/`: Xiaohongshu/Rednote notes
- `benchmark/`: generated benchmark reports

Store only public metadata and your own notes. Do not store private user data.
"""

    def add(self, sample: HitSample) -> dict[str, Any]:
        self.init()
        if sample.quality_status == "blocked":
            return {
                "status": "blocked",
                "sample_id": sample.sample_id,
                "score": sample.score,
                "confidence_score": sample.confidence_score,
                "quality_issues": sample.quality_issues,
                "quality_reviews": sample.quality_reviews,
            }
        if sample.confidence_score < 0.5:
            return {
                "status": "low_confidence",
                "sample_id": sample.sample_id,
                "score": sample.score,
                "confidence_score": sample.confidence_score,
                "confidence_reasons": sample.confidence_reasons,
                "quality_status": sample.quality_status,
                "quality_reviews": sample.quality_reviews,
            }
        duplicates = self.duplicate_candidates(sample)
        if duplicates:
            return {
                "status": "duplicate",
                "path": str(self.root / sample.platform / f"{sample.sample_id}.json"),
                "sample_id": sample.sample_id,
                "score": sample.score,
                "confidence_score": sample.confidence_score,
                "quality_status": sample.quality_status,
                "duplicate_candidates": duplicates,
            }
        path = self.root / sample.platform / f"{sample.sample_id}.json"
        path.write_text(json.dumps(asdict(sample), ensure_ascii=False, indent=2), encoding="utf-8")
        return {
            "status": "saved",
            "path": str(path),
            "sample_id": sample.sample_id,
            "score": sample.score,
            "confidence_score": sample.confidence_score,
            "quality_status": sample.quality_status,
        }

    def load(self, platform: str | None = None) -> list[HitSample]:
        self.init()
        platforms = [normalize_platform(platform)] if platform else PLATFORMS
        samples: list[HitSample] = []
        for p in platforms:
            for path in sorted((self.root / p).glob("*.json")):
                data = json.loads(path.read_text(encoding="utf-8"))
                samples.append(HitSample(**data))
        return samples

    def query(self, platform: str | None = None, keyword: str | None = None, limit: int = 20) -> list[HitSample]:
        samples = self.load(platform)
        if keyword:
            key = keyword.lower()
            samples = [
                s for s in samples
                if key in " ".join([
                    s.title, s.author, s.keyword, s.topic, s.cover_text,
                    s.hook, s.summary, s.audience_pain, s.commercial_angle,
                    " ".join(s.tags),
                ]).lower()
            ]
        return sorted(samples, key=lambda s: (s.score, s.captured_at), reverse=True)[:limit]

    def duplicate_candidates(self, sample: HitSample) -> list[dict[str, Any]]:
        self.init()
        candidates = []
        platform_dir = self.root / sample.platform
        title_key = normalize_text_key(sample.title)
        author_key = normalize_text_key(sample.author)
        for path in sorted(platform_dir.glob("*.json")):
            try:
                existing = HitSample(**json.loads(path.read_text(encoding="utf-8")))
            except Exception:
                continue
            reasons = []
            if existing.sample_id == sample.sample_id:
                reasons.append("sample_id")
            if sample.url and existing.url == sample.url:
                reasons.append("url")
            existing_title_key = normalize_text_key(existing.title)
            existing_author_key = normalize_text_key(existing.author)
            if title_key and existing_title_key == title_key:
                reasons.append("title")
                if author_key and existing_author_key == author_key:
                    reasons.append("author")
            if reasons:
                candidates.append({
                    "sample_id": existing.sample_id,
                    "path": str(path),
                    "title": existing.title,
                    "author": existing.author,
                    "reasons": sorted(set(reasons)),
                })
        return candidates

    def import_diff(self, samples: list[HitSample]) -> dict[str, Any]:
        seen_batch: dict[str, HitSample] = {}
        rows = []
        duplicates = 0
        blocked = 0
        review_required = 0
        low_confidence = 0
        new_count = 0
        for sample in samples:
            key = "|".join([
                sample.platform,
                sample.url or "",
                normalize_text_key(sample.title),
                normalize_text_key(sample.author),
            ])
            candidates = self.duplicate_candidates(sample)
            if key in seen_batch:
                candidates.append({
                    "sample_id": seen_batch[key].sample_id,
                    "path": "current-import-batch",
                    "title": seen_batch[key].title,
                    "author": seen_batch[key].author,
                    "reasons": ["same_batch"],
                })
            status = "new"
            if candidates:
                status = "duplicate"
                duplicates += 1
            elif sample.quality_status == "blocked":
                status = "blocked"
                blocked += 1
            elif sample.confidence_score < 0.5:
                status = "low_confidence"
                low_confidence += 1
            elif sample.quality_status == "review_required":
                status = "review_required"
                review_required += 1
                new_count += 1
            else:
                new_count += 1
            rows.append({
                "sample_id": sample.sample_id,
                "title": sample.title,
                "author": sample.author,
                "url": sample.url,
                "status": status,
                "confidence_score": sample.confidence_score,
                "confidence_reasons": sample.confidence_reasons,
                "quality_status": sample.quality_status,
                "quality_issues": sample.quality_issues,
                "quality_reviews": sample.quality_reviews,
                "duplicate_candidates": candidates,
            })
            seen_batch[key] = sample
        return {
            "total": len(samples),
            "new": new_count,
            "duplicates": duplicates,
            "blocked": blocked,
            "review_required": review_required,
            "low_confidence": low_confidence,
            "rows": rows,
        }

    def report(self, platform: str | None = None, keyword: str | None = None, limit: int = 12) -> dict[str, Any]:
        samples = self.query(platform, keyword, limit)
        markdown = render_report(samples, platform, keyword)
        ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        safe_platform = platform or "all"
        safe_keyword = slugify(keyword or "all")
        path = self.root / "benchmark" / f"{ts}-{safe_platform}-{safe_keyword}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(markdown, encoding="utf-8")
        audit = benchmark_quality_audit(samples)
        return {"status": "reported", "path": str(path), "count": len(samples), "audit": audit, "body": markdown}

    def queue(self, samples: list[HitSample], source_file: str = "") -> dict[str, Any]:
        self.init()
        stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        platform = samples[0].platform if samples else "empty"
        path = self.queue_root / f"{stamp}-{platform}.json"
        diff = self.import_diff(samples)
        payload = {
            "status": "pending",
            "created_at": datetime.now().isoformat(),
            "source_file": source_file,
            "count": len(samples),
            "import_diff": diff,
            "samples": [asdict(sample) for sample in samples],
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"status": "queued", "path": str(path), "count": len(samples), "preview": preview_samples(samples), "import_diff": diff}

    def list_queue(self) -> list[dict[str, Any]]:
        self.init()
        items = []
        for path in sorted(self.queue_root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            items.append({
                "path": str(path),
                "status": payload.get("status", "pending"),
                "created_at": payload.get("created_at"),
                "count": payload.get("count", len(payload.get("samples", []))),
                "import_diff": payload.get("import_diff", {}),
                "source_file": payload.get("source_file", ""),
                "preview": preview_samples([HitSample(**sample) for sample in payload.get("samples", [])[:3]]),
            })
        return items

    def import_queue(self, queue_file: str, confirm: bool = False) -> dict[str, Any]:
        self.init()
        path = Path(queue_file).expanduser()
        if not path.is_absolute():
            path = self.queue_root / path
        path = path.resolve(strict=True)
        payload = json.loads(path.read_text(encoding="utf-8"))
        samples = [HitSample(**sample) for sample in payload.get("samples", [])]
        pre_import_diff = payload.get("import_diff") or self.import_diff(samples)
        if confirm and not confirm_import(samples):
            return {"status": "cancelled", "path": str(path), "count": len(samples)}
        saved = []
        skipped_duplicates = []
        skipped_low_confidence = []
        skipped_blocked = []
        for sample in samples:
            if sample.quality_status == "blocked":
                skipped_blocked.append({
                    "status": "blocked",
                    "sample_id": sample.sample_id,
                    "title": sample.title,
                    "quality_issues": sample.quality_issues,
                    "quality_reviews": sample.quality_reviews,
                })
                continue
            if sample.confidence_score < 0.5:
                skipped_low_confidence.append({
                    "status": "low_confidence",
                    "sample_id": sample.sample_id,
                    "title": sample.title,
                    "confidence_score": sample.confidence_score,
                    "confidence_reasons": sample.confidence_reasons,
                })
                continue
            result = self.add(sample)
            if result["status"] == "saved":
                saved.append(result)
            elif result["status"] == "duplicate":
                skipped_duplicates.append(result)
        payload["status"] = "imported"
        payload["imported_at"] = datetime.now().isoformat()
        payload["import_diff"] = pre_import_diff
        payload["post_import_diff"] = self.import_diff(samples)
        payload["saved"] = saved
        payload["skipped_duplicates"] = skipped_duplicates
        payload["skipped_blocked"] = skipped_blocked
        payload["skipped_low_confidence"] = skipped_low_confidence
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        imported_dir = self.queue_root / "imported"
        imported_dir.mkdir(parents=True, exist_ok=True)
        archived = imported_dir / path.name
        os_replace(path, archived)
        return {
            "status": "imported",
            "path": str(archived),
            "count": len(saved),
            "samples": saved,
            "skipped_duplicates": skipped_duplicates,
            "skipped_blocked": skipped_blocked,
            "skipped_low_confidence": skipped_low_confidence,
        }

    def reject_queue(self, queue_file: str, reason: str = "") -> dict[str, Any]:
        self.init()
        path = Path(queue_file).expanduser()
        if not path.is_absolute():
            path = self.queue_root / path
        path = path.resolve(strict=True)
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["status"] = "rejected"
        payload["rejected_at"] = datetime.now().isoformat()
        payload["reason"] = reason
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        rejected_dir = self.queue_root / "rejected"
        rejected_dir.mkdir(parents=True, exist_ok=True)
        archived = rejected_dir / path.name
        os_replace(path, archived)
        return {"status": "rejected", "path": str(archived), "reason": reason}


def slugify(text: str) -> str:
    safe = re.sub(r"[^0-9A-Za-z._\-\u4e00-\u9fff]+", "-", str(text).strip())
    return safe.strip(".-") or "untitled"


def os_replace(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, target)


def render_report(samples: list[HitSample], platform: str | None, keyword: str | None) -> str:
    audit = benchmark_quality_audit(samples)
    title = f"{platform or 'all'} 爆款对标报告"
    if keyword:
        title += f" · {keyword}"
    lines = [
        f"# {title}",
        "",
        f"> 生成时间：{datetime.now().isoformat()} | 样本数：{len(samples)}",
        "",
        "## 0. 对标质量审计",
        "",
        f"- 审计结论：{audit['status']}",
        f"- 审计分：{audit['score']}/{audit['max_score']}",
        "",
        "| 维度 | 结果 | 说明 | 修改建议 |",
        "|---|---|---|---|",
    ]
    for item in audit["items"]:
        mark = item["level"].upper() if item["level"] != "pass" else "PASS"
        lines.append(f"| {item['label']} | {mark} | {escape_cell(item['evidence'])} | {escape_cell(item['recommendation'])} |")
    if audit["status"] == "blocked":
        lines.extend([
            "",
            "> 阻断：这份对标报告暂不建议进入 `content-angle/content-breakdown`。先补齐同平台同主题样本、指标、钩子机制和可借鉴理由。",
        ])
    elif audit["status"] == "review_required":
        lines.extend([
            "",
            "> 复核：可以用于启发，但进入正式拆解前需要人工确认样本来源、指标和可迁移机制。",
        ])
    lines.extend([
        "",
        "## 1. 高分样本",
        "",
        "| 平台 | 标题 | 作者 | 分数 | 样本质检 | 关键指标 | 可借鉴点 |",
        "|---|---|---|---:|---|---|---|",
    ])
    for s in samples:
        metrics = ", ".join(f"{k}:{v}" for k, v in sorted(s.metrics.items())) or "无"
        why = s.why_it_worked or s.hook or s.cover_text or s.audience_pain or "待补充"
        quality = s.quality_status
        if s.quality_issues:
            quality += "：" + "；".join(s.quality_issues[:2])
        elif s.quality_reviews:
            quality += "：" + "；".join(s.quality_reviews[:2])
        lines.append(f"| {s.platform} | {escape_cell(s.title)} | {escape_cell(s.author)} | {s.score:.2f} | {escape_cell(quality)} | {escape_cell(metrics)} | {escape_cell(why)} |")
    lines.extend([
        "",
        "## 2. 标题/封面/开头模式",
        "",
    ])
    for s in samples[:8]:
        lines.extend([
            f"### {s.title or s.sample_id}",
            f"- 平台：{s.platform}",
            f"- 标题：{s.title or '待补充'}",
            f"- 封面文字：{s.cover_text or '待补充'}",
            f"- 开头钩子：{s.hook or '待补充'}",
            f"- 用户痛点：{s.audience_pain or '待补充'}",
            f"- 商业角度：{s.commercial_angle or '待补充'}",
            f"- 可借鉴点：{s.why_it_worked or '待补充'}",
            "",
        ])
    lines.extend([
        "## 3. 给 content-breakdown 的输入",
        "",
        "可复制到 `## 爆款档案参考`：",
        "",
    ])
    for s in samples[:6]:
        rel = f"materials/hit-library/{s.platform}/{s.sample_id}.json"
        lines.append(f"- `{rel}` — {s.title or s.sample_id}；可借鉴点：{s.why_it_worked or s.hook or s.cover_text or '待补充'}")
    lines.append("")
    return "\n".join(lines)


def benchmark_quality_audit(samples: list[HitSample]) -> dict[str, Any]:
    total = len(samples)
    usable = [s for s in samples if s.quality_status != "blocked" and s.confidence_score >= 0.5]
    blocked_samples = [s for s in samples if s.quality_status == "blocked"]
    high_conf = [s for s in usable if s.confidence_score >= 0.7]
    with_hook = [s for s in usable if has_mechanism_signal(s)]
    with_pain = [s for s in usable if meaningful_text(s.audience_pain, 4)]
    with_business = [s for s in usable if meaningful_text(s.commercial_angle, 4) or meaningful_text(s.why_it_worked, 4)]
    with_metrics = [s for s in usable if has_metric_signal(s)]
    breakdown_ready = [s for s in usable if sample_breakdown_ready(s)]
    distinct_authors = {s.author for s in samples if s.author}
    usable_authors = {s.author for s in usable if s.author}
    items = [
        {
            "id": "sample_count",
            "label": "样本数量足够",
            "passed": len(usable) >= 3,
            "level": "pass" if len(usable) >= 3 else "blocked",
            "points": 15 if len(usable) >= 3 else 0,
            "max_points": 15,
            "evidence": f"当前样本数 {total}，可用样本 {len(usable)}，阻断样本 {len(blocked_samples)}",
            "recommendation": "至少补 3 条同平台同主题样本，正式项目建议 8-12 条。",
        },
        {
            "id": "confidence",
            "label": "高置信样本占比足够",
            "passed": len(usable) > 0 and len(high_conf) / len(usable) >= 0.6,
            "level": "pass" if len(usable) > 0 and len(high_conf) / len(usable) >= 0.6 else "review_required",
            "points": 15 if len(usable) > 0 and len(high_conf) / len(usable) >= 0.6 else 0,
            "max_points": 15,
            "evidence": f"高置信样本 {len(high_conf)}/{len(usable)}",
            "recommendation": "低置信样本需要补标题、链接、作者、指标、封面/钩子或摘要后再入库。",
        },
        {
            "id": "metrics",
            "label": "有可比较的表现指标",
            "passed": len(usable) > 0 and len(with_metrics) / len(usable) >= 0.6,
            "level": "pass" if len(usable) > 0 and len(with_metrics) / len(usable) >= 0.6 else "blocked",
            "points": 12 if len(usable) > 0 and len(with_metrics) / len(usable) >= 0.6 else 0,
            "max_points": 12,
            "evidence": f"带指标样本 {len(with_metrics)}/{len(usable)}",
            "recommendation": "至少补点赞、收藏/推荐、评论、分享等核心指标，否则无法判断是否真是爆款。",
        },
        {
            "id": "hook_signal",
            "label": "标题/封面/开头机制可复用",
            "passed": len(usable) > 0 and len(with_hook) / len(usable) >= 0.6,
            "level": "pass" if len(usable) > 0 and len(with_hook) / len(usable) >= 0.6 else "blocked",
            "points": 14 if len(usable) > 0 and len(with_hook) / len(usable) >= 0.6 else 0,
            "max_points": 14,
            "evidence": f"带封面/钩子/机制样本 {len(with_hook)}/{len(usable)}",
            "recommendation": "补每条样本的封面第一眼信号、前 3 行或前 3 秒钩子。",
        },
        {
            "id": "comment_demand",
            "label": "评论需求清晰",
            "passed": len(usable) > 0 and len(with_pain) / len(usable) >= 0.4,
            "level": "pass" if len(usable) > 0 and len(with_pain) / len(usable) >= 0.4 else "review_required",
            "points": 12 if len(usable) > 0 and len(with_pain) / len(usable) >= 0.4 else 0,
            "max_points": 12,
            "evidence": f"带用户痛点样本 {len(with_pain)}/{len(usable)}",
            "recommendation": "补评论区高频问题，如求教程、多少钱、适合我吗、怎么开始。",
        },
        {
            "id": "commercial_angle",
            "label": "商业角度可迁移",
            "passed": len(usable) > 0 and len(with_business) / len(usable) >= 0.5,
            "level": "pass" if len(usable) > 0 and len(with_business) / len(usable) >= 0.5 else "review_required",
            "points": 14 if len(usable) > 0 and len(with_business) / len(usable) >= 0.5 else 0,
            "max_points": 14,
            "evidence": f"带商业角度/可借鉴点样本 {len(with_business)}/{len(usable)}",
            "recommendation": "补每条样本如何导向信任、咨询、购买或私域，不只记录流量指标。",
        },
        {
            "id": "source_diversity",
            "label": "来源不过度集中",
            "passed": len(usable_authors) >= min(3, len(usable)) if usable else False,
            "level": "pass" if (len(usable_authors) >= min(3, len(usable)) if usable else False) else "review_required",
            "points": 8 if (len(usable_authors) >= min(3, len(usable)) if usable else False) else 0,
            "max_points": 8,
            "evidence": f"不同作者 {len(distinct_authors)} 个，可用样本不同作者 {len(usable_authors)} 个",
            "recommendation": "同一账号样本不要占满对标报告，至少补 3 个不同账号。",
        },
        {
            "id": "breakdown_ready",
            "label": "可直接输入 content-breakdown",
            "passed": len(breakdown_ready) >= 2,
            "level": "pass" if len(breakdown_ready) >= 2 else "blocked",
            "points": 10 if len(breakdown_ready) >= 2 else 0,
            "max_points": 10,
            "evidence": f"可直接拆解样本 {len(breakdown_ready)}，钩子样本 {len(with_hook)}，商业样本 {len(with_business)}",
            "recommendation": "至少准备 2 条可复制到 breakdown 的样本，每条含可借鉴点。",
        },
    ]
    score = sum(item["points"] for item in items)
    max_score = sum(item["max_points"] for item in items)
    percent = round(score / max_score * 100) if max_score else 0
    blocking_items = [item for item in items if item["level"] == "blocked" and not item["passed"]]
    review_items = [item for item in items if item["level"] == "review_required" and not item["passed"]]
    status = "pass"
    if blocking_items:
        status = "blocked"
    elif percent < 72 or review_items:
        status = "review_required"
    return {
        "status": status,
        "score": percent,
        "raw_score": score,
        "max_score": max_score,
        "usable_count": len(usable),
        "blocked_count": len(blocked_samples),
        "blocking_items": [item["id"] for item in blocking_items],
        "review_items": [item["id"] for item in review_items],
        "items": items,
    }


def escape_cell(text: str) -> str:
    return str(text or "").replace("|", "\\|").replace("\n", " ")


def sample_from_mapping(data: dict[str, Any], defaults: dict[str, Any]) -> HitSample:
    merged = {**defaults, **{k: v for k, v in data.items() if v not in (None, "")}}
    metrics = merged.get("metrics") or {}
    for key in ["reads", "likes", "collects", "comments", "shares", "wows", "recommends"]:
        if key in merged:
            raw = merged.pop(key)
            if raw not in (None, ""):
                metrics[key] = raw
    merged["metrics"] = metrics
    return HitSample(**merged)


def import_json(path: Path, defaults: dict[str, Any]) -> list[HitSample]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("samples"), list):
        rows = data["samples"]
    else:
        rows = data if isinstance(data, list) else [data]
    return [sample_from_mapping(dict(row), defaults) for row in rows]


def import_csv(path: Path, defaults: dict[str, Any]) -> list[HitSample]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return [sample_from_mapping(row, defaults) for row in csv.DictReader(f)]


def import_text(path: Path, defaults: dict[str, Any]) -> list[HitSample]:
    text = path.read_text(encoding="utf-8")
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    samples = []
    for block in blocks:
        row: dict[str, Any] = {"summary": block}
        for line in block.splitlines():
            if "：" in line:
                key, value = line.split("：", 1)
            elif ":" in line:
                key, value = line.split(":", 1)
            else:
                continue
            normalized = {
                "标题": "title",
                "title": "title",
                "作者": "author",
                "author": "author",
                "链接": "url",
                "url": "url",
                "点赞": "likes",
                "收藏": "collects",
                "评论": "comments",
                "转发": "shares",
                "阅读": "reads",
                "在看": "wows",
                "推荐": "recommends",
                "封面": "cover_text",
                "开头": "hook",
                "痛点": "audience_pain",
                "商业角度": "commercial_angle",
                "可借鉴点": "why_it_worked",
            }.get(key.strip().lower(), key.strip())
            row[normalized] = value.strip()
        samples.append(sample_from_mapping(row, defaults))
    return samples


def preview_samples(samples: list[HitSample], limit: int = 10) -> list[dict[str, Any]]:
    return [
        {
            "platform": sample.platform,
            "title": sample.title,
            "author": sample.author,
            "keyword": sample.keyword,
            "metrics": sample.metrics,
            "score": sample.score,
            "confidence_score": sample.confidence_score,
            "confidence_reasons": sample.confidence_reasons,
            "quality_status": sample.quality_status,
            "quality_issues": sample.quality_issues,
            "quality_reviews": sample.quality_reviews,
            "url": sample.url,
        }
        for sample in samples[:limit]
    ]


def confirm_import(samples: list[HitSample]) -> bool:
    print(json.dumps({
        "status": "preview",
        "count": len(samples),
        "samples": preview_samples(samples),
    }, ensure_ascii=False, indent=2))
    answer = input("确认导入这些样本？输入 yes 继续：").strip().lower()
    return answer in {"yes", "y"}


def main() -> int:
    parser = argparse.ArgumentParser(description="AIFIOS hit collector")
    parser.add_argument("--project", required=True, help="AIFIOS project root")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="initialize hit library")

    p_add = sub.add_parser("add", help="add one hit sample")
    p_add.add_argument("--platform", required=True, choices=PLATFORMS)
    p_add.add_argument("--title", required=True)
    p_add.add_argument("--url", default="")
    p_add.add_argument("--author", default="")
    p_add.add_argument("--keyword", default="")
    p_add.add_argument("--topic", default="")
    p_add.add_argument("--cover-text", default="")
    p_add.add_argument("--hook", default="")
    p_add.add_argument("--audience-pain", default="")
    p_add.add_argument("--commercial-angle", default="")
    p_add.add_argument("--why-it-worked", default="")
    p_add.add_argument("--tags", default="")
    for metric in ["reads", "likes", "collects", "comments", "shares", "wows", "recommends"]:
        p_add.add_argument(f"--{metric}", default=0)

    p_import = sub.add_parser("import", help="import hit samples from json/csv/text")
    p_import.add_argument("--file", required=True)
    p_import.add_argument("--format", choices=["json", "csv", "text"], default=None)
    p_import.add_argument("--platform", required=True, choices=PLATFORMS)
    p_import.add_argument("--keyword", default="")
    p_import.add_argument("--topic", default="")
    p_import.add_argument("--source-type", default="manual")
    p_import.add_argument("--preview", action="store_true", help="只预览解析结果，不写入样本库")
    p_import.add_argument("--confirm", action="store_true", help="导入前要求人工确认")

    p_queue = sub.add_parser("queue", help="parse samples and put them into pending queue")
    p_queue.add_argument("--file", required=True)
    p_queue.add_argument("--format", choices=["json", "csv", "text"], default=None)
    p_queue.add_argument("--platform", required=True, choices=PLATFORMS)
    p_queue.add_argument("--keyword", default="")
    p_queue.add_argument("--topic", default="")
    p_queue.add_argument("--source-type", default="browser-visible")

    sub.add_parser("queue-list", help="list pending browser/import queues")

    p_queue_import = sub.add_parser("queue-import", help="import a pending queue file")
    p_queue_import.add_argument("--file", required=True)
    p_queue_import.add_argument("--confirm", action="store_true")

    p_queue_reject = sub.add_parser("queue-reject", help="reject a pending queue file")
    p_queue_reject.add_argument("--file", required=True)
    p_queue_reject.add_argument("--reason", default="")

    p_list = sub.add_parser("list", help="list top samples")
    p_list.add_argument("--platform", choices=PLATFORMS, default=None)
    p_list.add_argument("--keyword", default=None)
    p_list.add_argument("--limit", type=int, default=20)

    p_report = sub.add_parser("report", help="generate benchmark report")
    p_report.add_argument("--platform", choices=PLATFORMS, default=None)
    p_report.add_argument("--keyword", default=None)
    p_report.add_argument("--limit", type=int, default=12)

    args = parser.parse_args()
    library = HitLibrary(args.project)

    try:
        if args.command == "init":
            result = library.init()
        elif args.command == "add":
            data = vars(args).copy()
            data.pop("command")
            data.pop("project")
            data["cover_text"] = data.pop("cover_text")
            data["audience_pain"] = data.pop("audience_pain")
            data["commercial_angle"] = data.pop("commercial_angle")
            data["why_it_worked"] = data.pop("why_it_worked")
            data["tags"] = data.get("tags")
            result = library.add(sample_from_mapping(data, {"source_type": "manual"}))
        elif args.command == "import":
            path = Path(args.file).expanduser().resolve(strict=True)
            fmt = args.format or path.suffix.lstrip(".").lower()
            defaults = {
                "platform": args.platform,
                "keyword": args.keyword,
                "topic": args.topic,
                "source_type": args.source_type,
            }
            if fmt == "json":
                samples = import_json(path, defaults)
            elif fmt == "csv":
                samples = import_csv(path, defaults)
            else:
                samples = import_text(path, defaults)
            if args.preview:
                import_diff = library.import_diff(samples)
                result = {
                    "status": "preview",
                    "count": len(samples),
                    "samples": preview_samples(samples),
                    "import_diff": import_diff,
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0
            if args.confirm and not confirm_import(samples):
                result = {"status": "cancelled", "count": len(samples)}
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0
            import_diff = library.import_diff(samples)
            saved = []
            skipped_duplicates = []
            skipped_blocked = []
            skipped_low_confidence = []
            for sample in samples:
                if sample.quality_status == "blocked":
                    skipped_blocked.append({
                        "status": "blocked",
                        "sample_id": sample.sample_id,
                        "title": sample.title,
                        "quality_issues": sample.quality_issues,
                        "quality_reviews": sample.quality_reviews,
                    })
                    continue
                if sample.confidence_score < 0.5:
                    skipped_low_confidence.append({
                        "status": "low_confidence",
                        "sample_id": sample.sample_id,
                        "title": sample.title,
                        "confidence_score": sample.confidence_score,
                        "confidence_reasons": sample.confidence_reasons,
                    })
                    continue
                add_result = library.add(sample)
                if add_result["status"] == "saved":
                    saved.append(add_result)
                elif add_result["status"] == "duplicate":
                    skipped_duplicates.append(add_result)
            result = {
                "status": "imported",
                "count": len(saved),
                "samples": saved,
                "skipped_duplicates": skipped_duplicates,
                "skipped_blocked": skipped_blocked,
                "skipped_low_confidence": skipped_low_confidence,
                "import_diff": import_diff,
                "post_import_diff": library.import_diff(samples),
            }
        elif args.command == "queue":
            path = Path(args.file).expanduser().resolve(strict=True)
            fmt = args.format or path.suffix.lstrip(".").lower()
            defaults = {
                "platform": args.platform,
                "keyword": args.keyword,
                "topic": args.topic,
                "source_type": args.source_type,
            }
            if fmt == "json":
                samples = import_json(path, defaults)
            elif fmt == "csv":
                samples = import_csv(path, defaults)
            else:
                samples = import_text(path, defaults)
            result = library.queue(samples, str(path))
        elif args.command == "queue-list":
            result = {"status": "listed", "queues": library.list_queue()}
        elif args.command == "queue-import":
            result = library.import_queue(args.file, args.confirm)
        elif args.command == "queue-reject":
            result = library.reject_queue(args.file, args.reason)
        elif args.command == "list":
            result = {"samples": [asdict(s) for s in library.query(args.platform, args.keyword, args.limit)]}
        elif args.command == "report":
            result = library.report(args.platform, args.keyword, args.limit)
        else:
            raise ValueError(f"unknown command: {args.command}")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
