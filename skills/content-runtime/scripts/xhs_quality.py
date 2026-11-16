#!/usr/bin/env python3
"""Deterministic quality audit for Xiaohongshu note/card outputs."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)
OVERCLAIM_RE = re.compile(r"(?:100%|百分百|保证成交|必然成交|全网最|第一名|唯一|永久有效)")


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 2) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    return not PLACEHOLDER_RE.search(value)


def content_lines(section: str) -> list[str]:
    lines = []
    for line in (section or "").splitlines():
        stripped = line.strip().strip("-* ")
        if not stripped or stripped.startswith("|---"):
            continue
        lines.append(stripped)
    return lines


def card_count(section: str) -> int:
    count = 0
    for line in (section or "").splitlines():
        stripped = line.strip()
        if re.search(r"(?:第\s*\d+\s*[张页]|图\s*\d+|\d+[.)、])", stripped):
            count += 1
    return count


def mentions_any(text: str, needles: list[str]) -> bool:
    return any(needle in (text or "") for needle in needles)


def audit_xhs(body: str) -> dict[str, Any]:
    """Audit whether an XHS output is publishable as note/card content."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "cover": (r"^##\s*(?:\d+\.\s*)?封面三行文案", "缺少 `## 封面三行文案`。"),
        "cards": (r"^##\s*(?:\d+\.\s*)?图文卡片结构", "缺少 `## 图文卡片结构`。"),
        "note": (r"^##\s*(?:\d+\.\s*)?正文笔记", "缺少 `## 正文笔记`。"),
        "cta": (r"^##\s*(?:\d+\.\s*)?评论区承接", "缺少 `## 评论区承接`。"),
        "risk": (r"^##\s*(?:\d+\.\s*)?风险边界", "缺少 `## 风险边界`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    if not re.search(r"(?m)^#\s+\S+", body):
        blocking.append("缺少 H1 标题。")

    cover = section_text(body, r"^##\s*(?:\d+\.\s*)?封面三行文案")
    cards = section_text(body, r"^##\s*(?:\d+\.\s*)?图文卡片结构")
    note = section_text(body, r"^##\s*(?:\d+\.\s*)?正文笔记")
    cta = section_text(body, r"^##\s*(?:\d+\.\s*)?评论区承接")
    risk = section_text(body, r"^##\s*(?:\d+\.\s*)?风险边界")

    cover_lines = [line for line in content_lines(cover) if meaningful_value(line, 2)]
    if len(cover_lines) < 3:
        blocking.append("封面三行文案不足 3 行，无法形成可用封面钩子。")
    if any(len(re.sub(r"\s+", "", line)) > 24 for line in cover_lines[:3]):
        review.append("封面前三行偏长，建议控制在移动端可读长度内。")

    cards_total = card_count(cards)
    if cards_total < 5:
        blocking.append("图文卡片结构少于 5 张，无法支撑一组完整小红书卡片。")
    if not mentions_any(cards, ["第 1", "第一", "封面"]):
        review.append("图文卡片结构缺少第一张/封面入口说明。")

    if not meaningful_value(note, 80):
        blocking.append("正文笔记过薄，至少需要说明场景、判断标准和读者收益。")
    if not mentions_any(note, ["客户", "读者", "用户", "问题", "痛点", "场景"]):
        blocking.append("正文笔记缺少目标读者问题或具体场景。")
    if not mentions_any(note, ["判断", "标准", "方法", "步骤", "结构"]):
        review.append("正文笔记缺少可收藏的判断标准或方法。")

    if not meaningful_value(cta, 20):
        blocking.append("评论区承接过薄，无法形成互动和获客入口。")
    if not mentions_any(cta, ["评论", "留言", "留下", "提问", "回复"]):
        blocking.append("评论区承接没有明确互动动作。")
    if not mentions_any(cta, ["业务", "问题", "客户", "产品", "场景", "需求"]):
        review.append("评论区承接缺少可用于诊断的用户信息字段。")

    if not meaningful_value(risk, 20):
        blocking.append("风险边界过薄，无法判断隐私、版权、夸大承诺或引流风险。")
    if not mentions_any(risk, ["不", "不要", "避免", "隐私", "版权", "承诺", "客户", "截图"]):
        blocking.append("风险边界缺少具体禁用项。")

    if PLACEHOLDER_RE.search(body):
        blocking.append("小红书产物仍包含待补/待确认等占位表达。")
    if OVERCLAIM_RE.search(body):
        blocking.append("小红书产物包含绝对化或结果承诺表达。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "cover_line_count": len(cover_lines),
            "card_count": cards_total,
            "note_chars": len(re.sub(r"\s+", "", note)),
            "cta_chars": len(re.sub(r"\s+", "", cta)),
            "risk_chars": len(re.sub(r"\s+", "", risk)),
        },
    }
