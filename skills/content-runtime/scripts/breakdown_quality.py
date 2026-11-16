#!/usr/bin/env python3
"""Deterministic quality audit for content-breakdown briefs."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|缺失|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)

PLATFORM_ALIASES = {
    "wechat": ["公众号", "微信", "wechat"],
    "xhs": ["小红书", "xhs", "rednote"],
}

NEXT_COMMANDS = {
    "wechat": ["/content-write", "写公众号", "wechat-writer", "公众号"],
    "xhs": ["/content-xhs", "小红书", "xhs-card"],
}


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    match = re.search(rf"(?m)^\s*[-*]\s*(?:{label_pattern})\s*[：:]\s*(.+?)\s*$", section or "")
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 6) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    return not PLACEHOLDER_RE.search(value)


def markdown_item_count(section: str) -> int:
    return len(re.findall(r"(?m)^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+", section or ""))


def normalized_targets(target_platforms: list[str] | None) -> list[str]:
    if not target_platforms:
        return []
    normalized = []
    for item in target_platforms:
        raw = (item or "").strip().lower()
        matched = None
        for key, aliases in PLATFORM_ALIASES.items():
            if raw == key or any(alias.lower() in raw for alias in aliases):
                matched = key
                break
        if matched and matched not in normalized:
            normalized.append(matched)
    return normalized


def text_mentions_platform(text: str, platform: str) -> bool:
    aliases = PLATFORM_ALIASES.get(platform, [platform])
    return any(re.search(re.escape(alias), text or "", re.IGNORECASE) for alias in aliases)


def text_mentions_any(text: str, needles: list[str]) -> bool:
    return any(re.search(re.escape(needle), text or "", re.IGNORECASE) for needle in needles)


def _required_platforms(target_platforms: list[str] | None) -> list[str]:
    targets = normalized_targets(target_platforms)
    return targets or ["wechat", "xhs"]


def audit_breakdown(body: str, target_platforms: list[str] | None = None) -> dict[str, Any]:
    """Audit whether a breakdown body is a production-ready brief.

    Blocking issues make downstream writing unsafe. Review issues can proceed but
    should be surfaced in task cards and final self-checks.
    """
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "upstream": (r"^##\s*0\.\s+上游约束", "缺少 `## 0. 上游约束`。"),
        "keywords": (r"^##\s*关键词矩阵", "缺少 `## 关键词矩阵`。"),
        "benchmark": (r"^##\s*爆款档案参考", "缺少 `## 爆款档案参考`。"),
        "spread": (r"^##\s*传播心理假设", "缺少 `## 传播心理假设`，请先用 `/dbs-spread` 解码受众为什么会在意。"),
        "titles": (r"^##\s*标题方案", "缺少 `## 标题方案`。"),
        "hooks": (r"^##\s*开场钩子库", "缺少 `## 开场钩子库`。"),
        "platform_fit": (r"^##\s*阵地适配建议", "缺少 `## 阵地适配建议`。"),
        "supplements": (r"^##\s*素材补充清单", "缺少 `## 素材补充清单`。"),
        "next": (r"^##\s*下一步执行指令", "缺少 `## 下一步执行指令`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    upstream = section_text(body, r"^##\s*0\.\s+上游约束")
    keywords = section_text(body, r"^##\s*关键词矩阵")
    benchmark = section_text(body, r"^##\s*爆款档案参考")
    spread = section_text(body, r"^##\s*传播心理假设")
    titles = section_text(body, r"^##\s*标题方案")
    hooks = section_text(body, r"^##\s*开场钩子库")
    platform_fit = section_text(body, r"^##\s*阵地适配建议")
    supplements = section_text(body, r"^##\s*素材补充清单")
    next_section = section_text(body, r"^##\s*下一步执行指令")

    selected_angle = line_value(upstream, r"选定角度")
    first_platform = line_value(upstream, r"首发平台|推荐首发平台")
    required_evidence = line_value(upstream, r"(?:必须使用的)?素材证据|必用素材证据|必须使用的素材证据")
    risk_boundary = line_value(upstream, r"不可触碰的风险边界|风险边界")

    if not meaningful_value(selected_angle):
        blocking.append("上游约束缺少可执行的 `选定角度`。")
    if not meaningful_value(first_platform, min_chars=2):
        blocking.append("上游约束缺少明确 `首发平台`。")
    if not meaningful_value(required_evidence):
        blocking.append("上游约束缺少可写入正文的具体素材证据。")
    if not meaningful_value(risk_boundary):
        blocking.append("上游约束缺少可执行的风险边界。")

    required_platforms = _required_platforms(target_platforms)
    if target_platforms and len(required_platforms) == 1 and first_platform and not text_mentions_platform(first_platform, required_platforms[0]):
        review.append(f"首发平台 `{first_platform}` 与当前目标阵地 `{required_platforms[0]}` 不完全一致，进入下游前建议人工确认。")

    if not text_mentions_any(keywords, ["|", "核心关键词", "长尾关键词", "标签"]):
        blocking.append("关键词矩阵缺少核心词、长尾词或标签结构。")
    for platform in required_platforms:
        if not text_mentions_platform(keywords, platform):
            review.append(f"关键词矩阵未覆盖 `{platform}` 阵地。")

    title_count = markdown_item_count(titles)
    if title_count < 1:
        blocking.append("标题方案没有可用标题。")
    elif title_count < max(2, len(required_platforms)):
        review.append("标题方案数量偏少，建议至少为目标阵地准备主标题和备选标题。")

    hook_count = markdown_item_count(hooks)
    if hook_count < 1:
        blocking.append("开场钩子库没有可用钩子。")
    elif hook_count < 2:
        review.append("开场钩子少于 2 个，建议补足反常识型/场景型开头。")

    for platform in required_platforms:
        if not text_mentions_platform(platform_fit, platform):
            blocking.append(f"阵地适配建议没有说明 `{platform}` 的执行方式。")
        if not text_mentions_any(next_section, NEXT_COMMANDS[platform]):
            blocking.append(f"下一步执行指令缺少 `{platform}` 对应命令。")

    if not text_mentions_any(benchmark, ["materials/hit-library", "benchmark", "对标", "爆款", "样本", "可借鉴点"]):
        review.append("爆款档案参考缺少真实样本或可借鉴机制。")
    elif re.search(r"暂无真实对标|暂无|未采集|没有对标", benchmark):
        review.append("爆款档案参考仍是占位说明，成稿需要标记 review 或补采样本。")

    spread_terms = {
        "沉默解除": ["沉默解除", "沉默的螺旋", "受众憋着"],
        "满足动机": ["满足动机", "使用与满足", "身份认同", "情绪宣泄", "社交资本", "信息价值"],
        "立场框架": ["立场框架", "框架理论", "站在"],
        "传播入口": ["传播入口", "两级传播", "第一批传播者"],
        "信念结构": ["信念结构", "认知一致", "确认了受众", "挑战了"],
        "受众情绪底层": ["受众情绪底层", "核心情绪"],
        "受众还想听什么": ["受众还想听什么", "还想听", "延展选题"],
    }
    missing_spread = [
        label for label, aliases in spread_terms.items()
        if not text_mentions_any(spread, aliases)
    ]
    if missing_spread:
        blocking.append("传播心理假设缺少关键维度：" + "、".join(missing_spread) + "。")
    if "dbs-spread" not in spread and "/dbs-spread" not in spread:
        review.append("传播心理假设建议标注来源为 `/dbs-spread`，方便追溯写前判断。")
    if len(spread.strip()) < 80:
        blocking.append("传播心理假设过薄，不能指导标题、钩子和平台适配。")

    open_supplements = [
        line.strip()
        for line in supplements.splitlines()
        if re.match(r"\s*[-*]\s*\[\s*\]\s+", line)
    ]
    if open_supplements:
        review.append(f"素材补充清单仍有 {len(open_supplements)} 项未完成。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "selected_angle": selected_angle,
            "first_platform": first_platform,
            "required_evidence": required_evidence,
            "risk_boundary": risk_boundary,
            "title_count": title_count,
            "hook_count": hook_count,
            "spread_missing": missing_spread,
            "open_supplements": len(open_supplements),
            "required_platforms": required_platforms,
        },
    }
