#!/usr/bin/env python3
"""Deterministic quality audit for cross-platform publish-ready adaptations."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)

PLATFORM_ALIASES = {
    "wechat": ["公众号", "微信", "wechat"],
    "xhs": ["小红书", "xhs", "rednote"],
    "shipinhao": ["视频号", "微信视频号", "shipinhao"],
    "douyin": ["抖音", "douyin", "tiktok china"],
    "moments": ["朋友圈", "微信朋友圈", "moments"],
    "multi": ["多平台", "最终内容", "package"],
}

PLATFORM_SPECS = {
    "wechat": {
        "label": "公众号",
        "heading": r"^##\s*1\.\s+公众号(?:发布稿|改编)",
        "execution_heading": r"^###\s*(?:改编结构|文章结构)",
        "execution_label": "改编结构",
        "fields": [
            ("发布标题", ["发布标题", "主标题"]),
            ("标题备选", ["标题备选", "备选标题"]),
            ("摘要", ["摘要"]),
            ("封面字", ["封面字"]),
            ("首图策略", ["首图策略", "封面策略"]),
            ("HTML 排版选择", ["HTML 排版选择", "排版选择", "排版风格"]),
        ],
        "minimum_execution_items": 3,
    },
    "xhs": {
        "label": "小红书",
        "heading": r"^##\s*2\.\s+小红书(?:图文)?(?:发布稿|改编)",
        "execution_heading": r"^###\s*(?:页卡结构|图文结构|卡片结构)",
        "execution_label": "页卡结构",
        "fields": [
            ("发布标题", ["发布标题", "标题"]),
            ("封面第一行", ["封面第一行"]),
            ("封面第二行", ["封面第二行"]),
            ("封面第三行", ["封面第三行"]),
            ("正文笔记", ["正文笔记", "正文文案"]),
            ("标签", ["标签", "话题"]),
            ("置顶评论", ["置顶评论"]),
        ],
        "minimum_execution_items": 5,
    },
    "shipinhao": {
        "label": "视频号",
        "heading": r"^##\s*3\.\s+(?:微信)?视频号(?:发布稿|改编)",
        "execution_heading": r"^###\s*(?:拍摄执行|脚本执行)",
        "execution_label": "拍摄执行",
        "fields": [
            ("标题", ["标题", "发布标题"]),
            ("发布文案", ["发布文案", "简介"]),
            ("话题", ["话题", "标签"]),
            ("封面字", ["封面字"]),
            ("封面画面", ["封面画面"]),
            ("置顶评论", ["置顶评论"]),
        ],
        "minimum_execution_items": 5,
    },
    "douyin": {
        "label": "抖音",
        "heading": r"^##\s*4\.\s+抖音(?:发布稿|改编)",
        "execution_heading": r"^###\s*(?:拍摄执行|脚本执行)",
        "execution_label": "拍摄执行",
        "fields": [
            ("标题", ["标题", "发布标题"]),
            ("发布文案", ["发布文案", "描述"]),
            ("话题", ["话题", "标签"]),
            ("封面字", ["封面字"]),
            ("封面画面", ["封面画面"]),
            ("置顶评论", ["置顶评论"]),
        ],
        "minimum_execution_items": 5,
    },
    "moments": {
        "label": "朋友圈",
        "heading": r"^##\s*5\.\s+(?:微信)?朋友圈(?:发布稿|改编)",
        "execution_heading": r"^###\s*(?:发布字段|发布安排)",
        "execution_label": "发布字段",
        "fields": [
            ("选图顺序", ["选图顺序", "图序"]),
            ("短文案", ["短文案", "发布文案"]),
            ("互动句", ["互动句", "互动问题"]),
            ("发布时机", ["发布时机", "发布节奏"]),
        ],
        "minimum_execution_items": 4,
    },
}


def compact(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms)(?:{heading_pattern})(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def subsection_text(section: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms)(?:{heading_pattern})(.*?)(?=^###\s+|\Z)", section or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, labels: list[str]) -> str:
    for label in labels:
        match = re.search(
            rf"(?m)^\s*[-*]\s*(?:\*\*)?\s*{re.escape(label)}\s*(?:\*\*)?\s*[：:]\s*(.+?)\s*$",
            section or "",
        )
        if match:
            return match.group(1).strip()
    return ""


def meaningful_value(value: str, min_chars: int = 4) -> bool:
    normalized = compact(value)
    return len(normalized) >= min_chars and not PLACEHOLDER_RE.search(normalized)


def markdown_item_count(section: str) -> int:
    return len(re.findall(r"(?m)^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+", section or ""))


def table_rows(section: str) -> int:
    return len([
        line for line in (section or "").splitlines()
        if line.strip().startswith("|") and "---" not in line
    ])


def platform_from_text(text: str) -> str | None:
    lowered = (text or "").lower()
    for platform, aliases in PLATFORM_ALIASES.items():
        if any(alias.lower() in lowered for alias in aliases):
            return platform
    return None


def present_target_platforms(body: str, source_platform: str | None) -> list[str]:
    present = []
    for platform, spec in PLATFORM_SPECS.items():
        if source_platform == platform:
            continue
        if re.search(spec["heading"], body or "", re.MULTILINE):
            present.append(platform)
    return present


def platform_section_errors(platform: str, section: str) -> list[str]:
    spec = PLATFORM_SPECS[platform]
    label = spec["label"]
    issues: list[str] = []

    fields = subsection_text(section, r"^###\s*发布字段")
    if not fields:
        return [f"{label}发布稿缺少 `### 发布字段`。"]
    missing = [name for name, aliases in spec["fields"] if not meaningful_value(line_value(fields, aliases))]
    if missing:
        issues.append(f"{label}发布字段缺少：{', '.join(missing)}。")

    execution = subsection_text(section, spec["execution_heading"])
    if not execution:
        issues.append(f"{label}发布稿缺少 `### {spec['execution_label']}`。")
    elif markdown_item_count(execution) < spec["minimum_execution_items"]:
        issues.append(f"{label}{spec['execution_label']}过薄，至少需要 {spec['minimum_execution_items']} 条可执行内容。")

    supplements = subsection_text(section, r"^###\s*需要补充的素材")
    if not supplements:
        issues.append(f"{label}发布稿缺少 `### 需要补充的素材`。")
    elif markdown_item_count(supplements) < 1:
        issues.append(f"{label}需要补充的素材至少要说明现有素材是否足够。")
    elif PLACEHOLDER_RE.search(supplements):
        issues.append(f"{label}需要补充的素材仍含占位表达。")
    return issues


def audit_platform_adapt(body: str) -> dict[str, Any]:
    """Audit whether a cross-platform brief is directly usable by publishing work."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    meta = section_text(body, r"^##\s*0\.\s+原文信息")
    if not meta:
        blocking.append("缺少 `## 0. 原文信息`。")

    source_platform_raw = line_value(meta, ["原文平台", "来源平台", "主平台"])
    source_path = line_value(meta, ["原文路径", "来源路径", "成稿路径", "文件路径"])
    topic = line_value(meta, ["核心选题", "选题"])
    thesis = line_value(meta, ["核心观点", "主观点", "题眼"])
    audience = line_value(meta, ["目标人群", "目标读者", "目标用户"])
    target_platforms_raw = line_value(meta, ["本次目标平台", "目标平台"])
    source_platform = platform_from_text(source_platform_raw)

    if not source_platform:
        blocking.append("原文信息缺少可识别的原文平台。")
    if not meaningful_value(source_path, 4):
        blocking.append("原文信息缺少可追溯的原文路径。")
    if not meaningful_value(topic, 4):
        blocking.append("原文信息缺少核心选题。")
    if not meaningful_value(thesis, 6):
        blocking.append("原文信息缺少核心观点。")
    if not meaningful_value(audience, 4):
        blocking.append("原文信息缺少目标人群。")

    targets = present_target_platforms(body, source_platform)
    if not targets:
        blocking.append("没有识别到任何目标平台发布稿。")

    platform_checks: dict[str, Any] = {}
    for platform in targets:
        spec = PLATFORM_SPECS[platform]
        section = section_text(body, spec["heading"])
        issues = platform_section_errors(platform, section)
        blocking.extend(issues)
        platform_checks[platform] = {
            "label": spec["label"],
            "issues": issues,
        }
        if target_platforms_raw and platform not in {"multi", platform_from_text(target_platforms_raw)}:
            aliases = PLATFORM_ALIASES[platform]
            if not any(alias.lower() in target_platforms_raw.lower() for alias in aliases):
                review.append(f"原文信息中的本次目标平台未明确写入 `{spec['label']}`。")

    comparison = section_text(body, r"^##\s*6\.\s+平台差异对照")
    if not comparison:
        blocking.append("缺少 `## 6. 平台差异对照`。")
    elif table_rows(comparison) < 4:
        blocking.append("平台差异对照过薄，至少需要四个平台或四个发布维度。")
    else:
        for platform in targets:
            if not any(alias in comparison for alias in PLATFORM_ALIASES[platform]):
                review.append(f"平台差异对照未覆盖 `{PLATFORM_SPECS[platform]['label']}`。")

    next_section = section_text(body, r"^##\s*7\.\s+(?:下一步执行指令|下游执行指令|下一步)")
    if not next_section:
        blocking.append("缺少 `## 7. 下一步执行指令`。")
    elif not any(command in next_section for command in ["content-package", "content-visual", "content-prelaunch"]):
        blocking.append("下一步执行指令缺少可执行的 content-package/content-visual/content-prelaunch 交接。")

    placeholder_hits = len(PLACEHOLDER_RE.findall(body))
    if placeholder_hits >= 3:
        blocking.append("跨平台发布改编中占位表达过多，不能交给下游生产。")
    elif placeholder_hits:
        review.append("跨平台发布改编中仍有少量占位表达，下游生产前需补齐。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "source_platform": source_platform,
            "source_path": source_path,
            "topic": topic,
            "thesis": thesis,
            "audience": audience,
            "target_platforms": targets,
            "platform_checks": platform_checks,
            "comparison_rows": table_rows(comparison),
            "placeholder_hits": placeholder_hits,
        },
    }
