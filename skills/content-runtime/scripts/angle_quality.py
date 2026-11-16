#!/usr/bin/env python3
"""Deterministic quality audit for content-angle reports."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|缺失|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)

ANGLE_REQUIRED_FIELDS = {
    "positioning": ["一句话定位", "定位"],
    "audience": ["目标用户", "读者"],
    "evidence": ["素材证据", "证据"],
    "commercial": ["商业承接", "商业"],
    "platform": ["适合平台", "平台适配", "平台"],
    "risk": ["风险点", "风险"],
}


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    match = re.search(rf"(?m)^\s*[-*]\s*(?:\*\*)?(?:{label_pattern})(?:\*\*)?\s*[：:]\s*(.+?)\s*$", section or "")
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 6) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    return not PLACEHOLDER_RE.search(value)


def text_mentions_any(text: str, needles: list[str]) -> bool:
    return any(re.search(re.escape(needle), text or "", re.IGNORECASE) for needle in needles)


def angle_blocks(recommendation_section: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"(?m)^###\s+角度\s*\d+[：:]\s*(.+?)\s*$", recommendation_section or ""))
    blocks: list[tuple[str, str]] = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(recommendation_section)
        blocks.append((match.group(1).strip(), recommendation_section[start:end].strip()))
    return blocks


def _angle_field_value(block: str, aliases: list[str]) -> str:
    label_pattern = "|".join(re.escape(alias) for alias in aliases)
    return line_value(block, label_pattern)


def audit_angle(body: str) -> dict[str, Any]:
    """Audit whether an angle report can safely feed content-breakdown."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "constraints": (r"^##\s*0\.\s+立项约束", "缺少 `## 0. 立项约束`。"),
        "recommendations": (r"^##\s*推荐角度", "缺少 `## 推荐角度`。"),
        "comparison": (r"^##\s*角度对比表", "缺少 `## 角度对比表`。"),
        "suggestion": (r"^##\s*建议", "缺少 `## 建议`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    constraints = section_text(body, r"^##\s*0\.\s+立项约束")
    recommendations = section_text(body, r"^##\s*推荐角度")
    comparison = section_text(body, r"^##\s*角度对比表")
    suggestion = section_text(body, r"^##\s*建议")

    decision = line_value(constraints, r"立项结论|决策")
    first_platform = line_value(constraints, r"首发平台|推荐首发平台")
    required_evidence = line_value(constraints, r"(?:必须使用的)?素材证据|必用素材证据|必须使用的素材证据")
    risk_boundary = line_value(constraints, r"不可触碰的风险边界|风险边界")

    if "有条件通过" in decision or "不通过" in decision:
        # A low-evidence decision still has a usable editorial direction. Keep
        # the boundary visible for the operator, but let content-angle produce
        # a constrained angle report instead of forcing a second round trip.
        review.append(f"立项结论为 `{decision}`，按低证据创作继续；缺口与风险需原样保留。")
    elif "通过" not in decision:
        blocking.append("立项约束缺少明确 `立项结论：通过`。")
    if not meaningful_value(first_platform, min_chars=2):
        blocking.append("立项约束缺少明确 `首发平台`。")
    if not meaningful_value(required_evidence):
        blocking.append("立项约束缺少可复用的素材证据。")
    if not meaningful_value(risk_boundary):
        blocking.append("立项约束缺少可执行的风险边界。")

    blocks = angle_blocks(recommendations)
    if not blocks:
        blocking.append("推荐角度没有按 `### 角度 N：...` 输出可解析角度。")
    elif len(blocks) < 2:
        review.append("推荐角度少于 2 个，建议至少给首选角度和备选角度。")

    angle_summaries: list[dict[str, Any]] = []
    for idx, (name, block) in enumerate(blocks, start=1):
        missing_fields = []
        weak_fields = []
        values: dict[str, str] = {}
        for field, aliases in ANGLE_REQUIRED_FIELDS.items():
            value = _angle_field_value(block, aliases)
            values[field] = value
            if not value:
                missing_fields.append(field)
            elif not meaningful_value(value, min_chars=4):
                weak_fields.append(field)
        if missing_fields:
            blocking.append(f"角度 {idx} `{name}` 缺少字段：{', '.join(missing_fields)}。")
        if weak_fields:
            blocking.append(f"角度 {idx} `{name}` 存在占位或过短字段：{', '.join(weak_fields)}。")
        angle_summaries.append({
            "index": idx,
            "name": name,
            "missing_fields": missing_fields,
            "weak_fields": weak_fields,
            "platform": values.get("platform", ""),
            "evidence": values.get("evidence", ""),
            "commercial": values.get("commercial", ""),
            "risk": values.get("risk", ""),
        })

    if not text_mentions_any(comparison, ["素材支撑", "平台适配", "传播潜力", "商业承接", "风险"]):
        blocking.append("角度对比表缺少素材支撑、平台适配、传播潜力、商业承接或风险维度。")

    if not text_mentions_any(suggestion, ["首选角度", "进入 content-breakdown", "进入 breakdown"]):
        blocking.append("建议部分缺少首选角度或进入 content-breakdown 的约束。")
    if not re.search(r"(?m)^\s*[-*]\s*首选角度\s*[：:]\s*(.+?)\s*$", suggestion or ""):
        review.append("建议部分未用明确列表项写出 `首选角度`，下游可能难以抽取。")
    if not re.search(r"(?m)^\s*[-*]\s*进入\s*(?:content-)?breakdown\s*的约束\s*[：:]\s*(.+?)\s*$", suggestion or "", re.IGNORECASE):
        review.append("建议部分未用明确列表项写出 `进入 content-breakdown 的约束`。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "decision": decision,
            "first_platform": first_platform,
            "required_evidence": required_evidence,
            "risk_boundary": risk_boundary,
            "angle_count": len(blocks),
            "angles": angle_summaries,
        },
    }
