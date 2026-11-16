#!/usr/bin/env python3
"""Deterministic quality audit for content-review reports."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待统计|待回填|未发布|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:w|万|k|千|%|次|条|个)?", re.IGNORECASE)
UNPUBLISHED_RE = re.compile(r"(?:未真实发布|未发布|demo|示例项目|模拟发布|内部演示)", re.IGNORECASE)
DEMO_MODE_RE = re.compile(r"(?:demo|示例项目|流程演示|演示样例|内部演示)", re.IGNORECASE)
SIMULATED_DATA_RE = re.compile(
    r"(?:非真实数据|模拟数据|样例数据|demo\s*预设|demo|示例|无真实数据|未真实发布|不作为真实发布反馈|不写入真实洞察)",
    re.IGNORECASE,
)
METRIC_KEYWORD_RE = re.compile(
    r"(?:阅读|播放|互动|点赞|在看|收藏|转发|评论|转化|线索|打开率|完播率|命中率|留存)",
    re.IGNORECASE,
)
METRIC_SOURCE_RE = re.compile(r"(?:后台|平台后台|发布记录|截图|导出|手工记录|用户提供|publish|analytics|数据源)")
COLLECTION_TIME_RE = re.compile(r"(?:采集时间|统计时间|截至|截止|发布后|观察窗口|时间窗口|日期)")
SAMPLE_SCOPE_RE = re.compile(r"(?:样本|范围|平台|账号|内容|评论|有效评论|剔除|纳入)")
METRIC_DEFINITION_RE = re.compile(r"(?:口径|阅读|播放|互动|收藏|转发|评论|转化|线索|打开率|完播率)")


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


def markdown_item_count(section: str) -> int:
    return len(re.findall(r"(?m)^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+", section or ""))


def has_number_signal(section: str) -> bool:
    return bool(numeric_metric_lines(section))


def has_placeholder(section: str) -> bool:
    return bool(PLACEHOLDER_RE.search(section or ""))


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


def audit_review(body: str) -> dict[str, Any]:
    """Audit whether a review report can feed the next content cycle."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "meta": (r"^##\s*0\.\s+内容元信息", "缺少 `## 0. 内容元信息`。"),
        "performance": (r"^##\s*1\.\s+表现记录", "缺少 `## 1. 表现记录`。"),
        "metric_source": (r"^###\s*1\.3\s+数据来源与口径", "缺少 `### 1.3 数据来源与口径`，无法判断复盘数据是否可沉淀。"),
        "attribution": (r"^##\s*2\.\s+跨平台归因", "缺少 `## 2. 跨平台归因`。"),
        "comments": (r"^##\s*3\.\s+评论洞察", "缺少 `## 3. 评论洞察`。"),
        "questions": (r"^##\s*4\.\s+用户问题归类", "缺少 `## 4. 用户问题归类`。"),
        "hit_rate": (r"^##\s*5\.\s+选题命中率", "缺少 `## 5. 选题命中率`。"),
        "optimization": (r"^##\s*6\.\s+选题优化", "缺少 `## 6. 选题优化`。"),
        "next": (r"^##\s*7\.\s+下一条建议", "缺少 `## 7. 下一条建议`。"),
        "insights": (r"^##\s*8\.\s+洞察沉淀", "缺少 `## 8. 洞察沉淀`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    meta = section_text(body, r"^##\s*0\.\s+内容元信息")
    performance = section_text(body, r"^##\s*1\.\s+表现记录")
    metric_source = section_text(body, r"^###\s*1\.3\s+数据来源与口径")
    attribution = section_text(body, r"^##\s*2\.\s+跨平台归因")
    comments = section_text(body, r"^##\s*3\.\s+评论洞察")
    questions = section_text(body, r"^##\s*4\.\s+用户问题归类")
    hit_rate = section_text(body, r"^##\s*5\.\s+选题命中率")
    optimization = section_text(body, r"^##\s*6\.\s+选题优化")
    next_section = section_text(body, r"^##\s*7\.\s+下一条建议")
    insights = section_text(body, r"^##\s*8\.\s+洞察沉淀")
    unpublished = bool(UNPUBLISHED_RE.search("\n".join([body, meta, performance, metric_source])))
    demo_mode = bool(DEMO_MODE_RE.search(body))

    original_path = line_value(meta, r"原文路径|内容路径|成稿路径")
    platform = line_value(meta, r"发布平台|目标阵地|平台")
    publish_date = line_value(meta, r"发布日期|发布时间")
    topic_angle = line_value(meta, r"选题角度|角度")
    if not meaningful_value(original_path, 4):
        review.append("内容元信息缺少原文路径。")
    if not meaningful_value(platform, 2):
        blocking.append("内容元信息缺少发布平台。")
    if not meaningful_value(publish_date, 4):
        review.append("内容元信息缺少发布日期。")
    if not meaningful_value(topic_angle, 2):
        review.append("内容元信息缺少选题角度。")

    performance_rows = table_or_list_rows(performance)
    performance_metric_lines = numeric_metric_lines(performance)
    if performance_rows < 2:
        blocking.append("表现记录过薄，至少需要平台数据表和关键指标说明。")
    if unpublished:
        if performance_metric_lines:
            blocking.append("未真实发布/demo 复盘不能填写看似真实的表现数据；如需演示，只能写无真实数据口径。")
        if not simulated_context_present(performance, metric_source):
            blocking.append("未真实发布/demo 复盘必须在表现记录和数据口径中声明无真实数据或模拟口径。")
    elif not has_number_signal(performance):
        blocking.append("表现记录缺少阅读/播放、互动、评论、转化等数字信号。")
    placeholder_hits = len(PLACEHOLDER_RE.findall(performance or ""))
    if placeholder_hits >= 3 and not unpublished:
        blocking.append("表现记录多数核心数据仍是待统计/未发布/待回填。")
    elif placeholder_hits and not unpublished:
        review.append("表现记录仍有少量待统计数据，建议发布后补齐。")

    metric_source_checks = {
        "source": bool(METRIC_SOURCE_RE.search(metric_source or "")),
        "collection_time": bool(COLLECTION_TIME_RE.search(metric_source or "")),
        "sample_scope": bool(SAMPLE_SCOPE_RE.search(metric_source or "")),
        "metric_definition": bool(METRIC_DEFINITION_RE.search(metric_source or "")),
    }
    missing_metric_source = [label for label, ok in metric_source_checks.items() if not ok]
    if table_or_list_rows(metric_source) < 2:
        blocking.append("数据来源与口径过薄，至少需要数据源、采集时间、样本范围和指标口径。")
    if missing_metric_source:
        blocking.append("数据来源与口径缺少：" + "、".join(missing_metric_source) + "。")
    if has_placeholder(metric_source):
        if not unpublished:
            blocking.append("数据来源与口径仍包含待统计/待回填占位，不能沉淀为有效复盘。")
        elif not simulated_context_present(metric_source):
            blocking.append("未真实发布/demo 的数据来源与口径必须明确无真实数据或模拟口径。")

    if table_or_list_rows(attribution) < 2:
        review.append("跨平台归因过薄，建议记录平台表现、可能原因和可迁移经验。")

    comment_items = markdown_item_count(comments)
    if comment_items < 4:
        blocking.append("评论洞察过薄，至少需要高频词、提问方式、情绪/问题和争议点。")
    if has_placeholder(comments):
        review.append("评论洞察仍包含占位信息，建议补真实评论语言。")

    if table_or_list_rows(questions) < 2:
        blocking.append("用户问题归类不足，无法转化为下一轮选题。")
    if not re.search(r"值得|成题|下一篇|单独", questions):
        review.append("用户问题归类缺少是否值得单独成题的判断。")

    if table_or_list_rows(hit_rate) < 2:
        review.append("选题命中率缺少与历史基准或临时观察的对比。")
    if not re.search(r"提升|持平|下降|临时观察|历史基准", hit_rate):
        review.append("选题命中率缺少趋势判断。")
    hit_rate_metric_lines = numeric_metric_lines(hit_rate)
    review_fake_metric_lines = performance_metric_lines + hit_rate_metric_lines
    if unpublished and hit_rate_metric_lines:
        blocking.append("未真实发布/demo 复盘不能计算选题命中率趋势；只能标注不计算真实命中率。")

    required_optimization_labels = ["命中点", "失误点", "可复用", "避开"]
    missing_labels = [label for label in required_optimization_labels if label not in optimization]
    if missing_labels:
        blocking.append("选题优化缺少：" + "、".join(missing_labels) + "。")

    recommendations = re.findall(r"(?m)^\s*[-*]\s*推荐选题\s*\d*\s*[：:]\s*(.+?)\s*$", next_section)
    if len([item for item in recommendations if meaningful_value(item, 6)]) < 2:
        blocking.append("下一条建议少于 2 个可执行选题。")
    if not re.search(r"优先级|先写|首选", next_section):
        blocking.append("下一条建议缺少优先级判断。")

    if "brain/insights.md" not in insights:
        blocking.append("洞察沉淀未说明写入 `brain/insights.md`。")
    if not re.search(r"reader-profile|no-fly-zone|brain/twin|禁区", insights):
        review.append("洞察沉淀未说明是否更新读者画像或禁区。")
    if unpublished:
        if not demo_mode:
            blocking.append("未真实发布的非 demo 内容不能进入复盘沉淀；请先补真实发布数据。")
        if not simulated_context_present(comments, questions, next_section, insights):
            blocking.append("未真实发布/demo 的评论洞察、下一条建议和洞察沉淀必须标注 demo 预设或模拟口径。")
        if re.search(r"新增有效洞察|真实用户洞察|更新选题命中率", insights) and not re.search(
            r"demo|示例|模拟|非真实|不写入真实|流程样例", insights, re.IGNORECASE
        ):
            blocking.append("未真实发布/demo 不能把模拟反馈写成真实有效洞察。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "original_path": original_path,
            "platform": platform,
            "publish_date": publish_date,
            "topic_angle": topic_angle,
            "performance_rows": performance_rows,
            "performance_placeholder_hits": placeholder_hits,
            "unpublished": unpublished,
            "demo_mode": demo_mode,
            "review_fake_metric_lines": review_fake_metric_lines,
            "metric_source_rows": table_or_list_rows(metric_source),
            "metric_source_checks": metric_source_checks,
            "comment_items": comment_items,
            "question_rows": table_or_list_rows(questions),
            "recommendation_count": len(recommendations),
        },
    }
