#!/usr/bin/env python3
"""Deterministic quality audit for self-archive records."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)
UNPUBLISHED_RE = re.compile(r"(?:未真实发布|未发布|demo|示例项目|模拟发布|内部演示)", re.IGNORECASE)
DEMO_MODE_RE = re.compile(r"(?:demo|示例项目|流程演示|演示样例|内部演示)", re.IGNORECASE)
SIMULATED_DATA_RE = re.compile(
    r"(?:非真实数据|模拟数据|样例数据|demo\s*预设|demo|示例|无真实数据|未真实发布|不作为真实发布反馈|不写入真实洞察)",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:w|万|k|千|%|次|条|个)?", re.IGNORECASE)
METRIC_KEYWORD_RE = re.compile(
    r"(?:阅读|播放|互动|点赞|在看|收藏|转发|评论|转化|线索|数据表现|表现数据|命中率|留存)",
    re.IGNORECASE,
)
ASSET_FILES = [
    "brain/style-evolution.md",
    "brain/case-library.md",
    "brain/no-fly-zone.md",
    "brain/insights.md",
]
DOWNSTREAM_HINTS = [
    "wechat-writer",
    "content-angle",
    "content-breakdown",
    "content-twin",
    "content-review",
]


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    match = re.search(rf"(?m)^\s*[-*]\s*(?:{label_pattern})\s*[：:]\s*(.+?)\s*$", section or "")
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 2) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    return not PLACEHOLDER_RE.search(value)


def table_or_list_rows(section: str) -> int:
    rows = 0
    for line in (section or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("|") and "---" not in stripped:
            rows += 1
        elif re.match(r"^(?:[-*]|\d+[.)])\s+", stripped):
            rows += 1
    return rows


def mentions_any(text: str, needles: list[str]) -> bool:
    return any(needle in (text or "") for needle in needles)


def numeric_metric_lines(section: str) -> list[str]:
    lines: list[str] = []
    previous_metric_header = False
    for raw_line in (section or "").splitlines():
        line = raw_line.strip()
        if not line or "---" in line or line.startswith("#"):
            continue
        is_table = line.startswith("|")
        has_metric_keyword = bool(METRIC_KEYWORD_RE.search(line))
        if is_table and has_metric_keyword:
            previous_metric_header = True
        if NUMBER_RE.search(line) and (has_metric_keyword or (is_table and previous_metric_header)):
            lines.append(line)
        if not is_table:
            previous_metric_header = False
    return lines


def simulated_context_present(*sections: str) -> bool:
    return bool(SIMULATED_DATA_RE.search("\n".join(section or "" for section in sections)))


def audit_archive(body: str) -> dict[str, Any]:
    """Audit whether an archive record creates reusable assets."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "topic": (r"^##\s*1\.\s+选题资产", "缺少 `## 1. 选题资产`。"),
        "draft": (r"^##\s*2\.\s+成稿资产", "缺少 `## 2. 成稿资产`。"),
        "feedback": (r"^##\s*3\.\s+数据与反馈资产", "缺少 `## 3. 数据与反馈资产`。"),
        "style": (r"^##\s*4\.\s+风格资产更新", "缺少 `## 4. 风格资产更新`。"),
        "case": (r"^##\s*5\.\s+案例库更新", "缺少 `## 5. 案例库更新`。"),
        "nofly": (r"^##\s*6\.\s+禁区更新", "缺少 `## 6. 禁区更新`。"),
        "reuse": (r"^##\s*7\.\s+可复用模式", "缺少 `## 7. 可复用模式`。"),
        "writes": (r"^##\s*8\.\s+写入确认", "缺少 `## 8. 写入确认`。"),
        "index": (r"^##\s*8\.1\s+资产索引", "缺少 `## 8.1 资产索引`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    topic = section_text(body, r"^##\s*1\.\s+选题资产")
    draft = section_text(body, r"^##\s*2\.\s+成稿资产")
    feedback = section_text(body, r"^##\s*3\.\s+数据与反馈资产")
    style = section_text(body, r"^##\s*4\.\s+风格资产更新")
    case = section_text(body, r"^##\s*5\.\s+案例库更新")
    nofly = section_text(body, r"^##\s*6\.\s+禁区更新")
    reuse = section_text(body, r"^##\s*7\.\s+可复用模式")
    writes = section_text(body, r"^##\s*8\.\s+写入确认")
    index = section_text(body, r"^##\s*8\.1\s+资产索引")
    unpublished = bool(UNPUBLISHED_RE.search("\n".join([body, draft, feedback, case, index])))
    demo_mode = bool(DEMO_MODE_RE.search(body))

    title = line_value(topic, r"标题|选题")
    angle = line_value(topic, r"角度|选题角度")
    if not meaningful_value(title, 4):
        blocking.append("选题资产缺少可复用标题/选题。")
    if not meaningful_value(angle, 4):
        review.append("选题资产缺少可复用角度说明。")
    if table_or_list_rows(topic) < 3:
        review.append("选题资产记录过薄，建议补目标读者、关键词或命中原因。")

    if not mentions_any(draft, ["pipeline/final", "公众号", "小红书"]):
        blocking.append("成稿资产缺少成稿路径或发布阵地。")
    if table_or_list_rows(draft) < 2:
        review.append("成稿资产缺少多平台版本或最终链接记录。")

    archive_fake_metric_lines = numeric_metric_lines(feedback) + numeric_metric_lines(case) + numeric_metric_lines(index)
    if unpublished:
        if not demo_mode:
            blocking.append("未真实发布的非 demo 内容不能沉淀为有效数据资产；请先补真实发布数据或只归档为草稿资产。")
        if archive_fake_metric_lines:
            blocking.append("未真实发布/demo 归档不能沉淀看似真实的阅读、评论、转化数字。")
        if not simulated_context_present(feedback, case, index):
            blocking.append("未真实发布/demo 归档必须在数据、案例和资产索引中声明无真实数据或模拟口径。")
    elif not re.search(r"\d", feedback):
        blocking.append("数据与反馈资产缺少阅读/播放/互动/评论/转化等数字信号。")
    if not mentions_any(feedback, ["评论", "反馈", "高频", "问题"]):
        blocking.append("数据与反馈资产缺少用户反馈或评论语言。")

    if table_or_list_rows(style) < 2 or not mentions_any(style, ["词", "句", "结构", "节奏", "声纹"]):
        blocking.append("风格资产更新不够具体，需写到词、句、结构或节奏。")
    if "brain/style-evolution.md" not in writes and "style-evolution.md" not in style:
        review.append("风格更新未明确写入 `brain/style-evolution.md`。")

    if table_or_list_rows(case) < 1 or not mentions_any(case, ["使用场景", "数据表现", "可复用", "案例"]):
        blocking.append("案例库更新缺少使用场景、数据表现或可复用说明。")
    if unpublished and re.search(r"新增有效洞察|真实用户洞察|真实表现|更新选题命中率", case + index) and not re.search(
        r"demo|示例|模拟|非真实|不写入真实|流程样例|待验证", case + index, re.IGNORECASE
    ):
        blocking.append("未真实发布/demo 不能把模拟反馈写成真实案例表现或真实洞察。")
    if "brain/case-library.md" not in writes and "case-library.md" not in case:
        review.append("案例更新未明确写入 `brain/case-library.md`。")

    if table_or_list_rows(nofly) < 1 or not mentions_any(nofly, ["原因", "触发场景", "避免", "不要"]):
        blocking.append("禁区更新缺少原因或触发场景。")
    if "brain/no-fly-zone.md" not in writes and "no-fly-zone.md" not in nofly:
        review.append("禁区更新未明确写入 `brain/no-fly-zone.md`。")

    if table_or_list_rows(reuse) < 2:
        blocking.append("可复用模式不足，至少需要结构模式和下一次使用场景。")
    if not mentions_any(reuse, ["下一次", "适合", "迁移", "复用"]):
        review.append("可复用模式缺少迁移条件。")

    missing_assets = [asset for asset in ASSET_FILES if asset not in writes]
    if missing_assets:
        blocking.append("写入确认缺少：" + "、".join(missing_assets) + "。")

    index_missing_assets = [asset for asset in ASSET_FILES if asset not in index]
    if index_missing_assets:
        blocking.append("资产索引缺少：" + "、".join(index_missing_assets) + "。")
    if table_or_list_rows(index) < 4:
        blocking.append("资产索引过薄，四类 brain 资产都要写明新增条目、来源证据和下游调用。")
    if not mentions_any(index, ["新增条目", "条目", "新增"]):
        blocking.append("资产索引缺少新增条目说明。")
    if not mentions_any(index, ["来源", "证据", "review", "archive", "原文"]):
        blocking.append("资产索引缺少来源证据。")
    if not mentions_any(index, DOWNSTREAM_HINTS):
        blocking.append("资产索引缺少下游调用 skill。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "title": title,
            "angle": angle,
            "topic_rows": table_or_list_rows(topic),
            "draft_rows": table_or_list_rows(draft),
            "feedback_rows": table_or_list_rows(feedback),
            "style_rows": table_or_list_rows(style),
            "case_rows": table_or_list_rows(case),
            "nofly_rows": table_or_list_rows(nofly),
            "reuse_rows": table_or_list_rows(reuse),
            "index_rows": table_or_list_rows(index),
            "index_missing_assets": index_missing_assets,
            "missing_assets": missing_assets,
            "unpublished": unpublished,
            "demo_mode": demo_mode,
            "archive_fake_metric_lines": archive_fake_metric_lines,
        },
    }
