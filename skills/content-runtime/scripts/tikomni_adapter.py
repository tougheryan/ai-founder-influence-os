#!/usr/bin/env python3
"""Import TikOmni structured JSON into AIFIOS hit assets."""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from hit_collector import HitLibrary, HitSample, confidence_for_sample, sample_quality_audit
from performance_collector import atomic_write_json, captured_at, raw_snapshot_name, safe_slug
from content_runtime import ContentRuntime


PLATFORM_ALIASES = {
    "xhs": "xhs",
    "xiaohongshu": "xhs",
    "rednote": "xhs",
    "小红书": "xhs",
    "wechat": "wechat",
    "wechat_mp": "wechat",
    "mp.weixin.qq.com": "wechat",
    "公众号": "wechat",
    "微信公众号": "wechat",
    "shipinhao": "shipinhao",
    "wechat_channels": "shipinhao",
    "wechat-channels": "shipinhao",
    "视频号": "shipinhao",
    "微信视频号": "shipinhao",
    "douyin": "douyin",
    "dy": "douyin",
    "抖音": "douyin",
}

PERFORMANCE_DIRS = {
    "xhs": "xhs",
    "wechat": "wechat-official-account",
    "shipinhao": "wechat-channels",
    "douyin": "douyin",
}

# These identifiers intentionally stay separate from legacy AIFIOS asset
# storage names (wechat/xhs/shipinhao). Topic research must prove that each
# source platform itself is available before an operator can choose a topic.
REQUIRED_MARKET_PLATFORMS = ("wechat_mp", "xiaohongshu", "wechat_channels")
MARKET_PLATFORM_ALIASES = {
    "wechat_mp": "wechat_mp",
    "wechat": "wechat_mp",
    "mp.weixin.qq.com": "wechat_mp",
    "公众号": "wechat_mp",
    "微信公众号": "wechat_mp",
    "xiaohongshu": "xiaohongshu",
    "xhs": "xiaohongshu",
    "rednote": "xiaohongshu",
    "小红书": "xiaohongshu",
    "wechat_channels": "wechat_channels",
    "wechat-channels": "wechat_channels",
    "shipinhao": "wechat_channels",
    "channels": "wechat_channels",
    "视频号": "wechat_channels",
    "微信视频号": "wechat_channels",
    # Douyin has no separate mandatory research fetch in this release. Video
    # trends are deliberately anchored on WeChat Channels for both scripts.
    "douyin": "wechat_channels",
    "dy": "wechat_channels",
    "抖音": "wechat_channels",
    "抖音号": "wechat_channels",
}
MARKET_PLATFORM_LABELS = {
    "wechat_mp": "公众号",
    "xiaohongshu": "小红书",
    "wechat_channels": "视频号",
}

TRANSIENT_MARKET_ERROR_RE = re.compile(
    r"(?:UNEXPECTED_EOF_WHILE_READING|EOF occurred in violation of protocol|TLSV1_ALERT_INTERNAL_ERROR|"
    r"timed?\s*out|timeout|connection (?:reset|aborted|closed)|temporarily unavailable|"
    r"TikOmni API call failed:\s*5\d\d)",
    re.IGNORECASE,
)

COMMENT_CONTAINER_KEYS = ["comments", "comment_samples", "comment_list"]

SENSITIVE_RE = re.compile(
    r"(?:(?:\+?86[-\s]?)?1[3-9]\d{9}|微信(?:号)?[:：]?\s*[A-Za-z0-9_-]{5,}|"
    r"weixin[:：]?\s*[A-Za-z0-9_-]{5,}|wx[:：]?\s*[A-Za-z0-9_-]{5,}|"
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|订单号?[:：]?\s*[A-Za-z0-9_-]{6,})",
    re.IGNORECASE,
)


def normalize_tikomni_platform(value: str) -> str:
    key = str(value or "").strip().lower()
    platform = PLATFORM_ALIASES.get(key, key)
    if platform not in {"wechat", "xhs", "shipinhao", "douyin"}:
        raise ValueError(f"未知 TikOmni 平台: {value}")
    return platform


def normalize_market_platform(value: str) -> str:
    """Normalize the strict three-source market research contract.

    This mapping is intentionally not used by legacy hit/performance import:
    keeping the two contracts separate prevents a local cached sample from
    masquerading as a successful live topic-research source.
    """
    key = str(value or "").strip().lower()
    platform = MARKET_PLATFORM_ALIASES.get(key, key)
    if platform not in REQUIRED_MARKET_PLATFORMS:
        raise ValueError(f"未知 TikOmni 市场研究平台: {value}")
    return platform


def load_json(path: Path | str) -> dict[str, Any] | list[Any]:
    return json.loads(Path(path).expanduser().resolve(strict=True).read_text(encoding="utf-8"))


def parse_number(value: Any) -> int:
    if value in (None, ""):
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().lower().replace(",", "")
    multiplier = 1
    if text.endswith(("w", "万")):
        multiplier = 10000
        text = text[:-1]
    elif text.endswith(("k", "千")):
        multiplier = 1000
        text = text[:-1]
    digits = re.sub(r"[^0-9.]", "", text)
    return int(float(digits) * multiplier) if digits else 0


def first_non_empty(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def clean_text(value: Any) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def mask_sensitive(value: Any) -> str:
    return SENSITIVE_RE.sub("[已脱敏]", clean_text(value))


def payload_platform(payload: dict[str, Any], explicit_platform: str = "") -> str:
    if explicit_platform:
        return normalize_tikomni_platform(explicit_platform)
    for candidate in [
        payload.get("platform"),
        (payload.get("normalized") or {}).get("platform") if isinstance(payload.get("normalized"), dict) else "",
    ]:
        if candidate:
            return normalize_tikomni_platform(str(candidate))
    raise ValueError("--platform is required when TikOmni payload has no platform")


def normalized_items(payload: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [dict(item) for item in payload if isinstance(item, dict)]
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict):
        for key in ["items", "works", "notes", "articles", "list"]:
            value = data.get(key)
            if isinstance(value, list):
                return [dict(item) for item in value if isinstance(item, dict)]
        business_data = data.get("business_data")
        if isinstance(business_data, list):
            return [dict(item) for item in business_data if isinstance(item, dict)]
        nested = data.get("data")
        if isinstance(nested, dict):
            business_data = nested.get("business_data")
            if isinstance(business_data, list):
                return [dict(item) for item in business_data if isinstance(item, dict)]
            for key in ["items", "works", "notes", "articles", "list"]:
                value = nested.get(key)
                if isinstance(value, list):
                    return [dict(item) for item in value if isinstance(item, dict)]
        if any(key in data for key in ["title", "nickname", "like_count", "comment_count", "id", "doc_url"]):
            return [dict(data)]
    normalized = payload.get("normalized") if isinstance(payload, dict) else None
    if isinstance(normalized, dict):
        for key in ["items", "works", "notes", "articles", "data", "list"]:
            value = normalized.get(key)
            if isinstance(value, list):
                return [dict(item) for item in value if isinstance(item, dict)]
        return [normalized]
    if isinstance(payload, dict) and isinstance(payload.get("samples"), list):
        return [dict(item) for item in payload["samples"] if isinstance(item, dict)]
    return [payload] if isinstance(payload, dict) else []


def mutable_tikomni_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
        nested = data.get("data")
        if isinstance(nested, dict) and isinstance(nested.get("items"), list):
            return [item for item in nested["items"] if isinstance(item, dict)]
    normalized = payload.get("normalized") if isinstance(payload.get("normalized"), dict) else None
    if isinstance(normalized, dict) and isinstance(normalized.get("items"), list):
        return [item for item in normalized["items"] if isinstance(item, dict)]
    return []


def tikomni_inner_data(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    return dict(data)


def metric(item: dict[str, Any], *keys: str) -> int:
    for key in keys:
        if key in item and item.get(key) not in (None, ""):
            return parse_number(item.get(key))
    stats = item.get("stats") if isinstance(item.get("stats"), dict) else {}
    metrics = item.get("metrics") if isinstance(item.get("metrics"), dict) else {}
    for source in [stats, metrics]:
        for key in keys:
            if key in source and source.get(key) not in (None, ""):
                return parse_number(source.get(key))
    return 0


def xhs_note_url(note_id: str) -> str:
    return f"https://www.xiaohongshu.com/explore/{note_id}" if note_id else ""


def flatten_xhs_note_item(item: dict[str, Any]) -> dict[str, Any]:
    note = item.get("note") if isinstance(item.get("note"), dict) else None
    if not note:
        return item
    user = note.get("user") if isinstance(note.get("user"), dict) else {}
    flattened = dict(item)
    flattened.update(note)
    flattened["platform"] = first_non_empty(item.get("platform"), note.get("platform"), "xiaohongshu")
    flattened["author"] = first_non_empty(note.get("author"), note.get("nickname"), user.get("nickname"))
    flattened["nickname"] = flattened["author"]
    flattened["platform_author_id"] = first_non_empty(
        note.get("platform_author_id"),
        note.get("author_id"),
        user.get("userid"),
        user.get("user_id"),
        user.get("red_id"),
    )
    note_id = first_non_empty(note.get("id"), note.get("note_id"), item.get("note_id"))
    flattened["source_url"] = first_non_empty(note.get("source_url"), note.get("share_url"), note.get("url"), xhs_note_url(note_id))
    images = note.get("images_list") if isinstance(note.get("images_list"), list) else []
    if images and isinstance(images[0], dict):
        flattened["cover_image"] = first_non_empty(images[0].get("url"), images[0].get("url_size_large"), images[0].get("original"))
    return flattened



def normalize_hit_item(item: dict[str, Any]) -> dict[str, Any]:
    return flatten_xhs_note_item(item)


def text_lines(value: str) -> list[str]:
    return [line.strip() for line in str(value or "").splitlines() if line.strip()]


def infer_cover_text(item: dict[str, Any]) -> str:
    return clean_text(first_non_empty(item.get("cover_text"), item.get("cover_title"), item.get("cover_ocr")))


def infer_hook(item: dict[str, Any]) -> str:
    text = clean_text(first_non_empty(
        item.get("hook"),
        item.get("primary_text"),
        item.get("caption_raw"),
        item.get("subtitle_raw"),
        item.get("asr_clean"),
        item.get("desc"),
        item.get("title"),
    ))
    lines = text_lines(text)
    return lines[0][:120] if lines else text[:120]


def infer_summary(item: dict[str, Any]) -> str:
    text = clean_text(first_non_empty(
        item.get("summary"),
        item.get("primary_text"),
        item.get("caption_raw"),
        item.get("asr_clean"),
        item.get("desc"),
    ))
    return text[:240]


def source_field(item: dict[str, Any], key: str) -> str:
    source = item.get("source")
    return first_non_empty(source.get(key)) if isinstance(source, dict) else ""


def infer_url(platform: str, item: dict[str, Any]) -> str:
    url = first_non_empty(item.get("source_url"), item.get("share_url"), item.get("url"), item.get("link"), item.get("doc_url"))
    if url:
        return url
    return ""


def infer_content_type(platform: str, item: dict[str, Any]) -> str:
    declared = first_non_empty(item.get("work_modality"), item.get("content_type"))
    if declared:
        return declared
    if platform == "wechat":
        return "article"
    return ""


def infer_metrics(platform: str, item: dict[str, Any]) -> dict[str, int]:
    metrics: dict[str, int] = {}
    if platform == "wechat":
        metrics["reads"] = metric(item, "reads", "read_count", "read_num", "view_count", "play_count")
        metrics["likes"] = metric(item, "likes", "like_count", "old_like_count", "digg_count", "likeNum")
        metrics["wows"] = metric(item, "wows", "wow_count")
        metrics["comments"] = metric(item, "comments", "comment_count")
        metrics["shares"] = metric(item, "shares", "share_count", "repost_count")
        metrics["collects"] = metric(item, "collects", "collect_count", "bookmark_count")
    else:
        metrics["plays"] = metric(item, "plays", "play_count", "view_count")
        metrics["likes"] = metric(item, "likes", "like_count", "liked_count", "digg_count")
        metrics["collects"] = metric(item, "collects", "collect_count", "collected_count", "bookmark_count")
        metrics["comments"] = metric(item, "comments", "comment_count", "comments_count")
        metrics["shares"] = metric(item, "shares", "share_count", "shared_count", "repost_count")
    return {key: value for key, value in metrics.items() if value > 0}


def infer_audience_pain_from_sample(sample: HitSample) -> str:
    text = clean_text(" ".join([sample.title, sample.hook, sample.summary]))
    if re.search(r"不会|不懂|小白|普通人|门槛|一个人|一人公司|OPC|超级个体", text, re.IGNORECASE):
        return "普通人或个体创业者想用 AI 降低创业门槛，但不知道从哪里开始、如何验证机会。"
    if re.search(r"赚钱|赚到|接单|首单|变现|营收|订单", text, re.IGNORECASE):
        return "用户关心 AI 是否能带来真实收入、接单机会和可复制的变现路径。"
    if re.search(r"工具|代码|编程|小程序|Agent|智能体|自动化", text, re.IGNORECASE):
        return "缺少技术团队或开发能力的人，希望用 AI 工具把想法快速做成可用产品。"
    return "目标用户正在寻找可复制的 AI 创业切入点、低成本行动路径和避坑经验。"


def infer_commercial_angle_from_sample(sample: HitSample) -> str:
    text = clean_text(" ".join([sample.title, sample.hook, sample.summary]))
    if re.search(r"工具|代码|编程|小程序|Agent|智能体|自动化", text, re.IGNORECASE):
        return "可承接到 AI 工具清单、自动化方案、技术咨询、实操课或项目陪跑。"
    if re.search(r"赚钱|赚到|接单|首单|变现|营收|订单", text, re.IGNORECASE):
        return "可承接到案例拆解、变现路径诊断、获客咨询、训练营或陪跑服务。"
    if re.search(r"一个人|一人公司|OPC|超级个体|个人", text, re.IGNORECASE):
        return "可承接到一人公司方法论、个人 IP 咨询、效率系统搭建或私域转化。"
    return "可承接到选题诊断、方法论拆解、行业案例库或 AI 创业咨询。"


def infer_why_it_worked_from_sample(sample: HitSample) -> str:
    metric_text = ""
    if sample.metrics:
        top_metrics = sorted(sample.metrics.items(), key=lambda item: item[1], reverse=True)[:2]
        metric_text = "；可验证指标：" + "、".join(f"{key}={value}" for key, value in top_metrics)
    hook = sample.hook or sample.summary or sample.title
    return f"用“{hook[:80]}”呈现明确人群、结果或反常识冲突，降低理解成本，便于用户代入和转发{metric_text}。"


def apply_inferred_insights(sample: HitSample) -> HitSample:
    if not sample.audience_pain:
        sample.audience_pain = infer_audience_pain_from_sample(sample)
    if not sample.commercial_angle:
        sample.commercial_angle = infer_commercial_angle_from_sample(sample)
    if not sample.why_it_worked:
        sample.why_it_worked = infer_why_it_worked_from_sample(sample)
    if "aifios-inferred-insight" not in sample.tags:
        sample.tags.append("aifios-inferred-insight")
    confidence = confidence_for_sample(sample)
    sample.confidence_score = confidence["score"]
    sample.confidence_reasons = confidence["reasons"]
    quality = sample_quality_audit(sample)
    sample.quality_status = quality["status"]
    sample.quality_issues = quality["issues"]
    sample.quality_reviews = quality["reviews"]
    return sample


def map_hit_samples(
    payload: dict[str, Any] | list[Any],
    platform: str = "",
    keyword: str = "",
    topic: str = "",
    infer_insights: bool = False,
) -> list[HitSample]:
    root_platform = payload_platform(payload, platform) if isinstance(payload, dict) else normalize_tikomni_platform(platform)
    root_keyword = ""
    if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
        root_keyword = first_non_empty(payload["input"].get("keyword"))
    if isinstance(payload, dict) and not root_keyword:
        params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        root_keyword = first_non_empty(params.get("keyword"), params.get("keywords"), data.get("keyword"))

    samples: list[HitSample] = []
    for item in normalized_items(payload):
        item = normalize_hit_item(item)
        item_platform = normalize_tikomni_platform(first_non_empty(item.get("platform"), root_platform))
        title = clean_text(first_non_empty(item.get("title"), item.get("desc"), item.get("caption_raw"), item.get("primary_text")))
        url = infer_url(item_platform, item)
        author = clean_text(first_non_empty(item.get("author"), item.get("nickname"), item.get("author_name"), source_field(item, "title")))
        sample = HitSample(
            platform=item_platform,
            title=title,
            url=url,
            author=author,
            account_id=first_non_empty(item.get("platform_author_id"), item.get("author_id"), item.get("user_id")),
            keyword=keyword or root_keyword,
            topic=topic,
            content_type=infer_content_type(item_platform, item),
            publish_date=first_non_empty(item.get("published_date"), item.get("publish_date"), item.get("created_at"), source_field(item, "dateTime"), item.get("dateTime")),
            cover_text=infer_cover_text(item),
            hook=infer_hook(item),
            summary=infer_summary(item),
            audience_pain=first_non_empty(item.get("audience_pain"), item.get("comment_needs")),
            commercial_angle=first_non_empty(item.get("commercial_angle"), item.get("cta")),
            why_it_worked=first_non_empty(item.get("why_it_worked"), item.get("imitation_value")),
            tags=item.get("tags") or [],
            metrics=infer_metrics(item_platform, item),
            source_type="tikomni",
        )
        if infer_insights:
            sample = apply_inferred_insights(sample)
        samples.append(sample)
    return samples


def map_comments(payload: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
    raw_comments: list[Any] = []
    if isinstance(payload, dict):
        normalized = payload.get("normalized") if isinstance(payload.get("normalized"), dict) else {}
        for container in [payload, normalized]:
            for key in COMMENT_CONTAINER_KEYS:
                value = container.get(key) if isinstance(container, dict) else None
                if isinstance(value, list):
                    raw_comments.extend(value)
    comments: list[dict[str, Any]] = []
    for item in raw_comments:
        if isinstance(item, dict):
            content = first_non_empty(item.get("content"), item.get("text"), item.get("comment"))
            if content:
                comments.append({
                    "content": mask_sensitive(content),
                    "likes": metric(item, "likes", "like_count", "digg_count"),
                    "type": first_non_empty(item.get("type"), item.get("category"), "sample"),
                })
    return comments[:100]


def performance_normalized_directory(platform: str) -> str:
    return PERFORMANCE_DIRS[normalize_tikomni_platform(platform)]


def parse_env_file(path: Path | str | None) -> dict[str, str]:
    if not path:
        return {}
    env_path = Path(path).expanduser().resolve(strict=False)
    if not env_path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class TikomniApiBridge:
    """Thin bridge to TikOmni's official social-media-crawl API caller."""

    def __init__(
        self,
        project: Path | str,
        skill_dir: Path | str | None = None,
        env_file: Path | str | None = None,
    ):
        self.project = Path(project).expanduser().resolve(strict=False)
        self.skill_dir = self.resolve_skill_dir(skill_dir)
        self.env_file = Path(env_file).expanduser().resolve(strict=False) if env_file else self.default_env_file()
        self.raw_dir = self.project / "materials" / "tikomni" / "raw"

    def default_env_file(self) -> Path:
        configured = os.getenv("AIFIOS_TIKOMNI_ENV_FILE", "").strip()
        if configured:
            return Path(configured).expanduser().resolve(strict=False)
        repo_root = Path(__file__).resolve().parents[3]
        return repo_root / ".env.local"

    def resolve_skill_dir(self, explicit: Path | str | None = None) -> Path:
        candidates: list[Path] = []
        if explicit:
            candidates.append(Path(explicit).expanduser())
        env_value = os.getenv("TIKOMNI_SOCIAL_MEDIA_CRAWL_DIR") or os.getenv("TIKOMNI_SKILL_DIR")
        if env_value:
            candidates.append(Path(env_value).expanduser())
        # Desktop releases vendor the TikOmni caller alongside the production
        # skills. Prefer that bundled copy before probing a developer's Codex
        # or Agents home directory so installed users need no extra Skill.
        repo_root = Path(__file__).resolve().parents[3]
        candidates.append(repo_root / "skills" / "social-media-crawl")
        for root in [
            Path.home() / ".codex" / "skills",
            Path.home() / ".agents" / "skills",
            Path("/private/tmp/tikomni-skill-inspect"),
        ]:
            candidates.append(root / "social-media-crawl")
        for candidate in candidates:
            caller = candidate / "scripts" / "core" / "call_tikomni_api.py"
            if caller.is_file():
                return candidate.resolve(strict=False)
        raise FileNotFoundError(
            "TikOmni social-media-crawl skill not found. Install it with "
            "`npx @tikomni/skills install codex social-media-crawl` or set TIKOMNI_SOCIAL_MEDIA_CRAWL_DIR."
        )

    def relative(self, path: Path) -> str:
        return str(path.resolve(strict=False).relative_to(self.project.resolve(strict=False)))

    def credential_status(self) -> dict[str, Any]:
        """Report whether an API key is available without returning a secret."""
        env_values = parse_env_file(self.env_file)
        has_process_key = bool(os.getenv("TIKOMNI_API_KEY") or os.getenv("TIKOMNI_API_TOKEN"))
        has_file_key = bool(env_values.get("TIKOMNI_API_KEY") or env_values.get("TIKOMNI_API_TOKEN"))
        return {
            "available": has_process_key or has_file_key,
            "source": "process" if has_process_key else ("env_file" if has_file_key else "missing"),
        }

    def resolve_endpoint_options(self, platform: str, capability: str) -> dict[str, Any]:
        """Resolve all supported endpoint options through social-media-crawl.

        Callers that need an account-specific public-object request can select
        only from this resolver result after matching its documented input
        schema. This avoids guessing a TikOmni endpoint or passing an
        arbitrary API route.
        """
        canonical_platform = normalize_market_platform(platform)
        resolver = self.skill_dir / "scripts" / "core" / "resolve_api_endpoint.py"
        command = [
            sys.executable,
            str(resolver),
            "--platform",
            canonical_platform,
            "--capability",
            capability,
        ]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"TikOmni endpoint resolver returned non-JSON output: {result.stdout.strip()}") from exc
        if result.returncode != 0 or not payload.get("ok"):
            reason = payload.get("message") or payload.get("code") or result.stdout.strip()
            raise RuntimeError(f"TikOmni endpoint unresolved: {reason}")
        recommended = payload.get("recommended") if isinstance(payload.get("recommended"), dict) else {}
        endpoint_id = str(recommended.get("endpoint_id") or "").strip()
        if not endpoint_id:
            raise RuntimeError("TikOmni endpoint resolver did not return an endpoint_id")
        alternatives = [
            item for item in payload.get("alternatives", [])
            if isinstance(item, dict) and str(item.get("endpoint_id") or "").strip()
        ]
        return {
            "platform": canonical_platform,
            "capability": str(payload.get("capability") or capability),
            "recommended": recommended,
            "alternatives": alternatives,
        }

    def endpoint_input_schema(self, endpoint_id: str) -> dict[str, Any]:
        """Return the catalogued input schema for a resolver-returned endpoint."""
        catalog = self.skill_dir / "references" / "api-catalog" / "operations.json"
        try:
            operations = json.loads(catalog.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("TikOmni API catalog is unavailable") from exc
        if not isinstance(operations, list):
            raise RuntimeError("TikOmni API catalog is invalid")
        for operation in operations:
            if isinstance(operation, dict) and operation.get("endpoint_id") == endpoint_id:
                schema = operation.get("input_schema")
                return schema if isinstance(schema, dict) else {}
        raise RuntimeError("TikOmni resolver returned an endpoint absent from its API catalog")

    def resolve_endpoint(self, platform: str, capability: str) -> dict[str, Any]:
        """Resolve the preferred endpoint through social-media-crawl."""
        options = self.resolve_endpoint_options(platform, capability)
        recommended = options["recommended"]
        endpoint_id = str(recommended.get("endpoint_id") or "").strip()
        return {
            "platform": options["platform"],
            "capability": options["capability"],
            "endpoint_id": endpoint_id,
            "method": str(recommended.get("method") or ""),
            "summary": str(recommended.get("summary") or ""),
        }

    def raw_target(self, kind: str, platform: str, endpoint_id: str) -> Path:
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
        endpoint_slug = safe_slug(endpoint_id.replace(".", "-"))[:80]
        return self.raw_dir / f"{stamp}-api-{kind}-{platform}-{endpoint_slug}-{uuid.uuid4().hex[:8]}.json"

    def fetch(
        self,
        endpoint_id: str,
        params: dict[str, Any],
        platform: str,
        kind: str = "raw",
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        # API routing operates on TikOmni's canonical platform identifiers;
        # legacy hit/performance storage still receives its own normalized name.
        try:
            canonical_platform = normalize_market_platform(platform)
        except ValueError:
            canonical_platform = ""
        normalized_platform = normalize_tikomni_platform(platform)
        caller = self.skill_dir / "scripts" / "core" / "call_tikomni_api.py"
        env_values = parse_env_file(self.env_file)
        base_url = (
            env_values.get("TIKOMNI_API_BASE")
            or env_values.get("TIKOMNI_BASE_URL")
            or os.getenv("TIKOMNI_API_BASE")
            or os.getenv("TIKOMNI_BASE_URL")
            or ""
        )
        command = [
            sys.executable,
            str(caller),
            "--endpoint-id",
            endpoint_id,
            "--params",
            json.dumps(params or {}, ensure_ascii=False),
            "--env-file",
            str(self.env_file),
        ]
        process_env = os.environ.copy()
        # Older local installs used TIKOMNI_API_TOKEN. Keep compatibility in
        # process memory only; no token is written into project files or logs.
        if not process_env.get("TIKOMNI_API_KEY"):
            legacy_token = (
                process_env.get("TIKOMNI_API_TOKEN")
                or env_values.get("TIKOMNI_API_KEY")
                or env_values.get("TIKOMNI_API_TOKEN")
            )
            if legacy_token:
                process_env["TIKOMNI_API_KEY"] = legacy_token
        if process_env.get("TIKOMNI_API_KEY"):
            command.append("--allow-process-env")
        if base_url:
            command.extend(["--base-url", base_url])
        if timeout_ms:
            command.extend(["--timeout-ms", str(timeout_ms)])
        run_options: dict[str, Any] = {
            "text": True,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "check": False,
            "env": process_env,
        }
        # The API caller has its own network deadline, but it cannot protect
        # this parent process if a DNS, TLS, or child-process edge stalls.
        # Enforce the same deadline here so one slow platform returns a clear
        # platform-level blocker instead of holding the whole research task.
        if timeout_ms:
            run_options["timeout"] = max(0.1, float(timeout_ms) / 1000)
        result = subprocess.run(command, **run_options)
        try:
            response = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"TikOmni API caller returned non-JSON output: {result.stdout.strip()}") from exc
        if result.returncode != 0 or not response.get("ok"):
            reason = response.get("error_reason") or response.get("message") or result.stdout.strip()
            raise RuntimeError(f"TikOmni API call failed: {reason}")
        raw_path = self.raw_target(kind, normalized_platform, endpoint_id)
        raw_payload = {
            "source": "tikomni-api",
            "endpoint_id": endpoint_id,
            "platform": canonical_platform or normalized_platform,
            "params": params or {},
            "data": response.get("data", {}),
            "request_id": response.get("request_id"),
            "status_code": response.get("status_code"),
        }
        atomic_write_json(raw_path, raw_payload)
        return {
            "status": "fetched",
            "endpoint_id": endpoint_id,
            "platform": normalized_platform,
            "market_platform": canonical_platform or None,
            "raw_path": self.relative(raw_path),
            "request_id": response.get("request_id"),
            "status_code": response.get("status_code"),
        }

    def payload_for_import(self, raw_path: Path | str) -> dict[str, Any]:
        raw = load_json(raw_path)
        if not isinstance(raw, dict):
            raise ValueError("TikOmni API raw payload must be a JSON object")
        data = raw.get("data")
        return data if isinstance(data, dict) else raw


class TikomniMarketResearchClient:
    """Live-only TikOmni source for the mandatory topic research gate.

    It deliberately owns no cache and never reads AIFIOS's hit library. A
    valid response may contain zero relevant samples, but a missing token,
    unresolved endpoint, failed request, or malformed response is surfaced as
    an unavailable platform so the topic gate can block honestly.
    """

    def __init__(
        self,
        project: Path | str,
        *,
        skill_dir: Path | str | None = None,
        env_file: Path | str | None = None,
        timeout_ms: int | None = None,
    ):
        self.project = Path(project).expanduser().resolve(strict=False)
        self.bridge = TikomniApiBridge(self.project, skill_dir=skill_dir, env_file=env_file)
        self.timeout_ms = timeout_ms

    def health(self) -> dict[str, Any]:
        return self.bridge.credential_status()

    def _fetch_wechat_article_object(
        self,
        endpoint_id: str,
        capability: str,
        url: str,
        *,
        kind: str,
    ) -> dict[str, Any]:
        """Fetch one catalogued WeChat article object without guessing a route."""
        try:
            fetched = self.bridge.fetch(
                endpoint_id,
                {"url": url, "raw": False},
                "wechat_mp",
                kind=kind,
                timeout_ms=self.timeout_ms,
            )
            raw_path = self.project / str(fetched["raw_path"])
            raw_payload = load_json(raw_path)
            if not isinstance(raw_payload, dict):
                raise RuntimeError("TikOmni 公众号文章补全结果不是对象")
            return {
                "status": "available",
                "platform": "wechat_mp",
                "endpoint_id": endpoint_id,
                "capability": capability,
                "request_id": fetched.get("request_id"),
                "raw_path": str(fetched["raw_path"]),
                "raw_payload": raw_payload,
            }
        except Exception as exc:
            return {
                "status": "unavailable",
                "platform": "wechat_mp",
                "endpoint_id": endpoint_id,
                "capability": capability,
                "reason": str(exc),
            }

    def fetch_wechat_article_stats(self, url: str) -> dict[str, Any]:
        return self._fetch_wechat_article_object(
            "wechat_mp.article_detail.v2.fetch_article_stats",
            "article_stats",
            url,
            kind="content-radar-stats",
        )

    def fetch_wechat_article_comments(self, url: str) -> dict[str, Any]:
        return self._fetch_wechat_article_object(
            "wechat_mp.comments.v2.fetch_article_comments",
            "comments",
            url,
            kind="content-radar-comments",
        )

    # Topic research is deliberately pinned to catalogued keyword-search
    # endpoints. The generic resolver currently selects obsolete operations
    # for WeChat public accounts and Channels, which produces a 404 before a
    # generated research term reaches TikOmni.
    MARKET_ENDPOINTS: dict[str, tuple[str, str]] = {
        "wechat_mp": ("wechat_search.search.v2.fetch_search", "search"),
        "xiaohongshu": ("xiaohongshu.search.app_v2.search_notes", "search"),
        "wechat_channels": ("wechat_search.video_search.v2.fetch_search_videos", "video_search"),
    }

    @staticmethod
    def _params(platform: str, query: str) -> dict[str, Any]:
        if platform == "wechat_mp":
            return {"keyword": query, "business_type": "article", "raw": False}
        if platform == "wechat_channels":
            return {"keyword": query, "raw": False}
        return {"keyword": query, "page": 1}

    def fetch(self, platform: str, query: str) -> dict[str, Any]:
        canonical_platform = normalize_market_platform(platform)
        health = self.health()
        if not health.get("available"):
            return {
                "status": "unavailable",
                "platform": canonical_platform,
                "code": "tikomni_token_missing",
                "reason": "TikOmni Token 未配置或不可读。",
            }
        try:
            endpoint_id, capability = self.MARKET_ENDPOINTS[canonical_platform]
            params = self._params(canonical_platform, query)
            for attempt in range(3):
                try:
                    fetched = self.bridge.fetch(
                        endpoint_id,
                        params,
                        canonical_platform,
                        kind="market-research",
                        timeout_ms=self.timeout_ms,
                    )
                    break
                except RuntimeError as exc:
                    # The three public-search endpoints occasionally time out,
                    # reset a connection, or return a transient 5xx response
                    # independently. Retry only those failures; authorization
                    # and endpoint-contract errors still fail immediately.
                    if attempt < 2 and TRANSIENT_MARKET_ERROR_RE.search(str(exc)):
                        time.sleep(0.4 * (attempt + 1))
                        continue
                    raise
            raw_path = self.project / str(fetched["raw_path"])
            raw_payload = load_json(raw_path)
            if not isinstance(raw_payload, dict) or not isinstance(raw_payload.get("data"), (dict, list)):
                raise RuntimeError("TikOmni 返回的数据不符合公开研究结构")
            return {
                "status": "available",
                "platform": canonical_platform,
                "endpoint_id": endpoint_id,
                "capability": capability,
                "query_applied": True,
                "query_mode": "platform-search",
                "raw_path": str(fetched["raw_path"]),
                "raw_payload": raw_payload,
            }
        except Exception as exc:
            reason = str(exc)
            if re.search(r"(?:^|\D)403(?:\D|$)", reason):
                return {
                    "status": "unavailable",
                    "platform": canonical_platform,
                    "code": "tikomni_permission_denied",
                    "reason": "TikOmni 拒绝访问（403）：当前 Token 没有该平台检索接口的权限。请在 TikOmni 控制台为 Token 开通微信公众号和视频号检索权限后重试。",
                }
            return {
                "status": "unavailable",
                "platform": canonical_platform,
                "code": "tikomni_platform_unavailable",
                "reason": reason,
            }


def map_performance_payload(
    payload: dict[str, Any] | list[Any],
    platform: str,
    slug: str,
    authorization_mode: str = "public-visible",
    captured_by: str = "",
) -> dict[str, Any]:
    normalized_platform = normalize_tikomni_platform(platform)
    items = normalized_items(payload)
    if not items:
        raise ValueError("TikOmni performance payload has no normalized item")
    item = items[0]
    declared_platforms = []
    if isinstance(payload, dict) and payload.get("platform"):
        declared_platforms.append(("payload.platform", payload.get("platform")))
    if isinstance(payload, dict) and isinstance(payload.get("normalized"), dict) and payload["normalized"].get("platform"):
        declared_platforms.append(("payload.normalized.platform", payload["normalized"].get("platform")))
    if item.get("platform"):
        declared_platforms.append(("item.platform", item.get("platform")))
    for field, declared in declared_platforms:
        declared_normalized = normalize_tikomni_platform(str(declared))
        if declared_normalized != normalized_platform:
            raise ValueError(
                f"TikOmni platform mismatch: {field}={declared_normalized}, explicit platform={normalized_platform}"
            )
    source_platform = first_non_empty(
        item.get("platform"),
        payload.get("platform") if isinstance(payload, dict) else "",
        normalized_platform,
    )
    title = mask_sensitive(first_non_empty(item.get("title"), item.get("desc"), item.get("caption_raw"), item.get("primary_text"), slug))
    url = first_non_empty(item.get("source_url"), item.get("share_url"), item.get("url"), item.get("link"))
    metrics = infer_metrics(normalized_platform, item)
    platform_metrics = item.get("metrics") if isinstance(item.get("metrics"), dict) else {}
    comments = map_comments(payload)
    missing_fields = []
    for field, value in {"title": title, "url": url, "metrics": metrics}.items():
        if not value:
            missing_fields.append(field)
    now = captured_at()
    return {
        "slug": safe_slug(slug),
        "platform": normalized_platform,
        "normalized_directory": performance_normalized_directory(normalized_platform),
        "content": {
            "content_id": first_non_empty(item.get("platform_work_id"), item.get("id"), item.get("aweme_id"), item.get("note_id")),
            "title": title,
            "url": url,
            "published_at": first_non_empty(item.get("published_date"), item.get("publish_date"), item.get("created_at")),
            "content_type": first_non_empty(item.get("work_modality"), item.get("content_type")),
            "source_asset_path": "",
        },
        "source": {
            "source_type": "tikomni",
            "tikomni_platform": source_platform,
            "captured_at": now,
            "captured_by": captured_by or "tikomni-adapter",
            "authorization_mode": authorization_mode,
            "raw_snapshot_path": "",
        },
        "metrics": metrics,
        "platform_metrics": platform_metrics,
        "unsupported_metrics": [],
        "missing_fields": missing_fields,
        "comments": comments,
        "content_analysis": {
            "title": title,
            "cover_text": mask_sensitive(infer_cover_text(item)),
            "hook": mask_sensitive(infer_hook(item)),
            "primary_text": mask_sensitive(first_non_empty(item.get("primary_text"), item.get("caption_raw"), item.get("asr_clean"))),
            "summary": mask_sensitive(infer_summary(item)),
        },
    }


class TikomniAdapter:
    def __init__(self, project: Path | str):
        self.project = Path(project).expanduser().resolve(strict=False)
        self.tikomni_raw_dir = self.project / "materials" / "tikomni" / "raw"
        self.performance_root = self.project / "materials" / "performance"
        self.performance_raw_dir = self.performance_root / "raw"
        self.review_inputs_dir = self.performance_root / "review-inputs"

    def fetch_api(
        self,
        endpoint_id: str,
        params: dict[str, Any],
        platform: str,
        kind: str = "raw",
        skill_dir: Path | str | None = None,
        env_file: Path | str | None = None,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        bridge = TikomniApiBridge(self.project, skill_dir=skill_dir, env_file=env_file)
        return bridge.fetch(endpoint_id, params, platform, kind=kind, timeout_ms=timeout_ms)

    def fetch_hits(
        self,
        endpoint_id: str,
        params: dict[str, Any],
        platform: str,
        keyword: str = "",
        topic: str = "",
        queue: bool = False,
        skill_dir: Path | str | None = None,
        env_file: Path | str | None = None,
        timeout_ms: int | None = None,
        enrich_details: bool = False,
        enrich_limit: int = 5,
        infer_insights: bool = False,
    ) -> dict[str, Any]:
        fetched = self.fetch_api(endpoint_id, params, platform, kind="hit", skill_dir=skill_dir, env_file=env_file, timeout_ms=timeout_ms)
        raw_abs = self.project / fetched["raw_path"]
        bridge = TikomniApiBridge(self.project, skill_dir=skill_dir, env_file=env_file)
        payload = bridge.payload_for_import(raw_abs)
        normalized_platform = normalize_tikomni_platform(platform)
        enrichment = {"enriched_count": 0, "enrichment_raw_paths": []}
        if enrich_details:
            enrichment = self.enrich_hit_payload(
                payload,
                platform=normalized_platform,
                bridge=bridge,
                limit=enrich_limit,
                timeout_ms=timeout_ms,
            )
        samples = map_hit_samples(
            payload,
            platform=normalized_platform,
            keyword=keyword,
            topic=topic,
            infer_insights=infer_insights,
        )
        inferred_count = sum(1 for sample in samples if "aifios-inferred-insight" in sample.tags)
        library = HitLibrary(self.project)
        if queue:
            result = library.queue(samples, source_file=fetched["raw_path"])
            result["api_raw_path"] = fetched["raw_path"]
            result["endpoint_id"] = endpoint_id
            result["inferred_insights_count"] = inferred_count
            result.update(enrichment)
            return result
        saved: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for sample in samples:
            result = library.add(sample)
            if result.get("status") == "saved":
                saved.append(result)
            else:
                skipped.append(result)
        return {
            "status": "imported",
            "platform": normalized_platform,
            "count": len(samples),
            "saved_count": len(saved),
            "skipped_count": len(skipped),
            "api_raw_path": fetched["raw_path"],
            "endpoint_id": endpoint_id,
            "inferred_insights_count": inferred_count,
            **enrichment,
            "saved": saved,
            "skipped": skipped,
        }

    def enrich_hit_payload(
        self,
        payload: dict[str, Any],
        platform: str,
        bridge: TikomniApiBridge,
        limit: int = 5,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        enriched_count = 0
        raw_paths: list[str] = []
        for item in mutable_tikomni_items(payload)[: max(0, int(limit or 0))]:
            try:
                if platform == "wechat":
                    url = infer_url(platform, item)
                    if not url:
                        continue
                    fetched = bridge.fetch(
                        "wechat_mp.article_detail.v2.fetch_article_stats",
                        {"url": url, "raw": False},
                        platform,
                        kind="hit-enrich",
                        timeout_ms=timeout_ms,
                    )
                    stats_payload = bridge.payload_for_import(self.project / fetched["raw_path"])
                    stats = tikomni_inner_data(stats_payload)
                    for source_key, target_key in [
                        ("read_num", "read_count"),
                        ("like_count", "like_count"),
                        ("old_like_count", "old_like_count"),
                        ("comment_count", "comment_count"),
                        ("share_count", "share_count"),
                        ("collect_count", "collect_count"),
                        ("star_num", "collect_count"),
                    ]:
                        if source_key in stats and stats.get(source_key) not in (None, ""):
                            item[target_key] = stats.get(source_key)
                else:
                    continue
                enriched_count += 1
                raw_paths.append(fetched["raw_path"])
            except Exception as exc:
                item["enrichment_error"] = str(exc)
        return {"enriched_count": enriched_count, "enrichment_raw_paths": raw_paths}

    def copy_tikomni_raw(self, file_path: Path, kind: str, platform: str) -> str:
        self.tikomni_raw_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
        target = self.tikomni_raw_dir / f"{stamp}-{kind}-{platform}-{uuid.uuid4().hex[:8]}.json"
        shutil.copyfile(file_path, target)
        return self.relative(target)

    def relative(self, path: Path) -> str:
        return str(path.resolve(strict=False).relative_to(self.project.resolve(strict=False)))

    def source_reference(self, path: Path) -> str:
        try:
            return self.relative(path)
        except ValueError:
            return path.name

    def import_hits(
        self,
        file_path: Path | str,
        platform: str,
        keyword: str = "",
        topic: str = "",
        queue: bool = False,
    ) -> dict[str, Any]:
        source = Path(file_path).expanduser().resolve(strict=True)
        payload = load_json(source)
        normalized_platform = normalize_tikomni_platform(platform)
        samples = map_hit_samples(payload, platform=normalized_platform, keyword=keyword, topic=topic)
        raw_copy = self.copy_tikomni_raw(source, "hit", normalized_platform)
        library = HitLibrary(self.project)
        if queue:
            result = library.queue(samples, source_file=raw_copy)
            result["raw_copy_path"] = raw_copy
            return result

        saved: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for sample in samples:
            result = library.add(sample)
            if result.get("status") == "saved":
                saved.append(result)
            else:
                skipped.append(result)
        return {
            "status": "imported",
            "platform": normalized_platform,
            "count": len(samples),
            "saved_count": len(saved),
            "skipped_count": len(skipped),
            "raw_copy_path": raw_copy,
            "saved": saved,
            "skipped": skipped,
        }

    def performance_normalized_dir(self, platform: str) -> Path:
        return self.performance_root / performance_normalized_directory(platform)

    def write_runtime_report(self, slug: str, body: str, source: str) -> dict[str, Any]:
        runtime = Path(__file__).resolve().with_name("content_runtime.py")
        managed_run_id = ContentRuntime(self.project).active_managed_run_for_slug(slug)
        command = [
            sys.executable,
            str(runtime),
            "--project",
            str(self.project),
            "write",
            "--step",
            "performance",
            "--slug",
            slug,
            "--content",
            body,
            "--source",
            source,
        ]
        if managed_run_id:
            command.extend(["--run-id", managed_run_id])
        else:
            # Imported TikOmni evidence cannot silently attach to an unrelated
            # production run or become releasable historical content.
            command.append("--unbound-report")
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stdout.strip())
        return json.loads(result.stdout)

    def validate_runtime_report(self, rel_path: str) -> dict[str, Any]:
        runtime = Path(__file__).resolve().with_name("content_runtime.py")
        command = [
            sys.executable,
            str(runtime),
            "--project",
            str(self.project),
            "validate",
            "--step",
            "performance",
            "--file",
            rel_path,
        ]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stdout.strip())
        return json.loads(result.stdout)

    def render_performance_report(
        self,
        mapped: dict[str, Any],
        raw_path: str,
        normalized_path: str,
        review_input_path: str,
        evidence_status: str = "legacy",
        publish_record_path: str = "",
    ) -> str:
        content = mapped["content"]
        source = mapped["source"]
        metrics = mapped["metrics"]
        rows = []
        for key, value in metrics.items():
            rows.append(f"| {key} | {value} | TikOmni normalized | {source['captured_at']} |")
        if not rows:
            rows.append(f"| no_visible_metric | 0 | TikOmni 未返回公开指标 | {source['captured_at']} |")
        comment_lines = []
        for index, item in enumerate(mapped.get("comments", [])[:20], start=1):
            comment_lines.append(f"- 评论 {index}：{item.get('content', '')}（likes={item.get('likes', 0)}，type={item.get('type', 'sample')}）")
        if not comment_lines:
            comment_lines.append("- 评论样本：本次 TikOmni 输出未包含评论样本")
        return "\n".join([
            "## 0. 采集对象",
            f"- slug：{mapped['slug']}",
            f"- 平台：{mapped['platform']}",
            f"- 作品 ID：{content.get('content_id', '')}",
            f"- 发布时间：{content.get('published_at', '')}",
            f"- 发布链接：{content.get('url', '')}",
            f"- 内容类型：{content.get('content_type', '')}",
            "",
            "## 1. 授权与数据源",
            f"- 授权模式：{source['authorization_mode']}",
            "- 数据源：TikOmni 结构化 JSON 导入",
            f"- 采集时间：{source['captured_at']}",
            f"- 采集人：{source['captured_by']}",
            "- 授权证明或授权记录路径：本地 TikOmni JSON 文件导入记录",
            "- 合规声明：不绕过平台授权，不伪造不可见后台指标",
            "",
            "## 2. 原始快照",
            f"- raw_path：{raw_path}",
            f"- 原始字段摘要：TikOmni platform={source['tikomni_platform']}，title={content.get('title', '')}",
            "- 保留策略：不清洗、不覆盖，保留原始 TikOmni 输出和映射结果",
            "",
            "## 3. 归一化指标",
            f"- normalized_path：{normalized_path}",
            "",
            "| 指标 | 数值 | 口径 | 采集时间 |",
            "|---|---:|---|---|",
            *rows,
            "",
            "## 4. 评论样本",
            *comment_lines,
            "",
            "## 5. Review 输入包",
            f"- path：{review_input_path}",
            "- 内容来源：TikOmni JSON",
            "- 异常说明：缺失字段已写入 missing_fields，平台不可见指标不猜测",
            "- 建议复盘问题：标题/开头是否解释了播放或阅读，评论区需求是否能变成下一条选题",
            "",
            "## 6. 写回与下一步",
            "- 写回状态：已写入 performance 报告",
            f"- 同 slug 发布证据状态：{evidence_status}",
            f"- 发布记录路径：{publish_record_path or '未找到同 slug 发布记录'}",
            "- 下一步：进入 `/content-review`",
            "- 数据完整性：若评论或指标不足，content-review 中标记为 review_required",
            "",
        ])

    def import_performance(
        self,
        file_path: Path | str,
        platform: str,
        slug: str,
        authorization_mode: str = "public-visible",
        captured_by: str = "",
    ) -> dict[str, Any]:
        source_file = Path(file_path).expanduser().resolve(strict=True)
        payload = load_json(source_file)
        mapped = map_performance_payload(payload, platform, slug, authorization_mode=authorization_mode, captured_by=captured_by)
        normalized_dir = self.performance_normalized_dir(mapped["platform"])
        for directory in [self.performance_raw_dir, normalized_dir, self.review_inputs_dir]:
            directory.mkdir(parents=True, exist_ok=True)
        raw_path_abs = self.performance_raw_dir / raw_snapshot_name(mapped["slug"])
        normalized_path_abs = normalized_dir / f"{mapped['slug']}.json"
        review_input_path_abs = self.review_inputs_dir / f"{mapped['slug']}.json"
        evidence = ContentRuntime(self.project).find_publish_evidence(mapped["slug"])
        publish_evidence_status = evidence["evidence_status"]
        evidence_status = "bound" if publish_evidence_status == "bound" else "blocked"
        review_status = "review-ready" if evidence_status == "bound" else "blocked"
        raw_payload = {
            "source": "tikomni",
            "source_file": self.source_reference(source_file),
            "mapped": mapped,
            "input_payload": payload,
        }
        raw_rel = self.relative(raw_path_abs)
        normalized_rel = self.relative(normalized_path_abs)
        review_rel = self.relative(review_input_path_abs)
        mapped["source"]["raw_snapshot_path"] = raw_rel
        normalized_payload = dict(mapped)
        normalized_payload["raw_path"] = raw_rel
        normalized_payload["evidence_status"] = evidence_status
        normalized_payload["publish_evidence_status"] = publish_evidence_status
        normalized_payload["publish_record_path"] = evidence.get("path", "")
        normalized_payload["review_status"] = review_status
        review_input = {
            "step": "review",
            "slug": mapped["slug"],
            "title": mapped["content"]["title"],
            "platform": mapped["platform"],
            "content_source": mapped["content"]["source_asset_path"],
            "publish_asset": mapped["content"]["source_asset_path"],
            "publish_url": mapped["content"]["url"],
            "published_at": mapped["content"]["published_at"],
            "captured_at": mapped["source"]["captured_at"],
            "performance": normalized_payload,
            "raw_path": raw_rel,
            "normalized_path": normalized_rel,
            "comment_samples": mapped["comments"],
            "content_analysis": mapped["content_analysis"],
            "missing_fields": mapped["missing_fields"],
            "evidence_status": evidence_status,
            "publish_evidence_status": publish_evidence_status,
            "publish_record_path": evidence.get("path", ""),
            "review_status": review_status,
            "suggested_review_questions": [
                "本内容的标题、封面或前 3 秒是否解释了主要表现？",
                "评论中的问题能否直接变成下一条选题？",
                "收藏、分享、评论哪个动作最值得优化？",
            ],
        }
        atomic_write_json(raw_path_abs, raw_payload)
        atomic_write_json(normalized_path_abs, normalized_payload)
        atomic_write_json(review_input_path_abs, review_input)
        body = self.render_performance_report(
            mapped,
            raw_rel,
            normalized_rel,
            review_rel,
            evidence_status=evidence_status,
            publish_record_path=evidence.get("path", ""),
        )
        write_result = self.write_runtime_report(mapped["slug"], body, f"tikomni:{mapped['platform']}:{source_file.name}")
        report_rel = self.relative(Path(write_result["path"]))
        validation = self.validate_runtime_report(report_rel)
        return {
            "status": "collected" if evidence_status == "bound" else "blocked",
            "evidence_status": evidence_status,
            "slug": mapped["slug"],
            "platform": mapped["platform"],
            "raw_path": raw_rel,
            "normalized_path": normalized_rel,
            "review_input_path": review_rel,
            "performance_report_path": write_result["path"],
            "quality_status": validation.get("quality_status"),
            "quality_errors": validation.get("quality_errors", []),
            "quality_reviews": validation.get("quality_reviews", []),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Import TikOmni JSON into AIFIOS assets")
    parser.add_argument("--project", required=True)
    sub = parser.add_subparsers(dest="command", required=True)

    p_hit = sub.add_parser("hit-import")
    p_hit.add_argument("--platform", required=True)
    p_hit.add_argument("--file", required=True)
    p_hit.add_argument("--keyword", default="")
    p_hit.add_argument("--topic", default="")
    p_hit.add_argument("--queue", action="store_true")

    p_perf = sub.add_parser("performance-import")
    p_perf.add_argument("--platform", required=True)
    p_perf.add_argument("--file", required=True)
    p_perf.add_argument("--slug", required=True)
    p_perf.add_argument("--authorization-mode", default="public-visible")
    p_perf.add_argument("--captured-by", default="")

    p_api = sub.add_parser("api-fetch")
    p_api.add_argument("--platform", required=True)
    p_api.add_argument("--endpoint-id", required=True)
    p_api.add_argument("--params", default="{}")
    p_api.add_argument("--kind", default="raw")
    p_api.add_argument("--skill-dir", default="")
    p_api.add_argument("--env-file", default="")
    p_api.add_argument("--timeout-ms", type=int, default=None)

    p_hit_fetch = sub.add_parser("hit-fetch")
    p_hit_fetch.add_argument("--platform", required=True)
    p_hit_fetch.add_argument("--endpoint-id", required=True)
    p_hit_fetch.add_argument("--params", default="{}")
    p_hit_fetch.add_argument("--keyword", default="")
    p_hit_fetch.add_argument("--topic", default="")
    p_hit_fetch.add_argument("--queue", action="store_true")
    p_hit_fetch.add_argument("--skill-dir", default="")
    p_hit_fetch.add_argument("--env-file", default="")
    p_hit_fetch.add_argument("--timeout-ms", type=int, default=None)
    p_hit_fetch.add_argument("--enrich-details", action="store_true")
    p_hit_fetch.add_argument("--enrich-limit", type=int, default=5)
    p_hit_fetch.add_argument("--infer-insights", action="store_true")

    args = parser.parse_args()
    adapter = TikomniAdapter(args.project)
    if args.command == "hit-import":
        result = adapter.import_hits(args.file, args.platform, keyword=args.keyword, topic=args.topic, queue=args.queue)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "performance-import":
        result = adapter.import_performance(
            args.file,
            args.platform,
            args.slug,
            authorization_mode=args.authorization_mode,
            captured_by=args.captured_by,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "api-fetch":
        params = json.loads(args.params or "{}")
        result = adapter.fetch_api(
            args.endpoint_id,
            params,
            args.platform,
            kind=args.kind,
            skill_dir=args.skill_dir or None,
            env_file=args.env_file or None,
            timeout_ms=args.timeout_ms,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "hit-fetch":
        params = json.loads(args.params or "{}")
        result = adapter.fetch_hits(
            args.endpoint_id,
            params,
            args.platform,
            keyword=args.keyword,
            topic=args.topic,
            queue=args.queue,
            skill_dir=args.skill_dir or None,
            env_file=args.env_file or None,
            timeout_ms=args.timeout_ms,
            enrich_details=args.enrich_details,
            enrich_limit=args.enrich_limit,
            infer_insights=args.infer_insights,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    raise RuntimeError(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
