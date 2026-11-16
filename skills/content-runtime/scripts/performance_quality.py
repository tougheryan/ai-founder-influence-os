#!/usr/bin/env python3
"""Quality audit for performance pipeline outputs."""
from __future__ import annotations

import re
from typing import Any


def _compact(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _section(body: str, index: int, title: str) -> str:
    pattern = rf"(?ms)^##\s*{index}\.\s+{re.escape(title)}\s*(.*?)(?=^##\s*\d+\.|\Z)"
    match = re.search(pattern, body)
    return match.group(1).strip() if match else ""


def _has_value(section: str, field: str) -> bool:
    match = re.search(rf"(?mi)^\s*[-*]\s*{re.escape(field)}\s*[：:]\s*(.+)$", section)
    if not match:
        return False
    value = _compact(match.group(1)).strip("。.")
    return bool(value) and value not in {"无", "暂无", "待补", "待确认", "未提供", "xxx", "..."}


def _field_value(section: str, field: str) -> str:
    match = re.search(rf"(?mi)^\s*[-*]\s*{re.escape(field)}\s*[：:]\s*(.+)$", section)
    return _compact(match.group(1)) if match else ""


def _status(errors: list[str], reviews: list[str]) -> str:
    if errors:
        return "blocked"
    if reviews:
        return "review_required"
    return "pass"


def audit_performance(body: str) -> dict[str, Any]:
    errors: list[str] = []
    reviews: list[str] = []

    target = _section(body, 0, "采集对象")
    source = _section(body, 1, "授权与数据源")
    raw = _section(body, 2, "原始快照")
    metrics = _section(body, 3, "归一化指标")
    comments = _section(body, 4, "评论样本")
    review_input = _section(body, 5, "Review 输入包")

    evidence_match = re.search(r"(?m)^\s*-\s*同 slug 发布证据状态：(.+?)\s*$", body)
    evidence_status = _compact(evidence_match.group(1)) if evidence_match else "legacy"
    if evidence_status == "blocked":
        errors.append("同 slug 发布证据缺失或无效，不能进入结论型复盘。")

    if not re.search(r"wechat|公众号|微信|xhs|xiaohongshu|小红书", target, re.IGNORECASE):
        errors.append("采集对象必须声明 WeChat 或 XHS 支持的 adapter 或平台。")
    missing_source_fields = [
        field for field in ["授权模式", "数据源", "采集时间"]
        if not _has_value(source, field)
    ]
    if missing_source_fields:
        errors.append(f"授权与数据源不完整：必须提供{ '、'.join(missing_source_fields) }。")

    raw_path = _field_value(raw, "raw_path")
    if not raw_path.startswith("materials/performance/raw/"):
        errors.append("原始快照 raw_path 必须位于 materials/performance/raw/。")
    elif not re.match(r"^materials/performance/raw/[^/]+-\d{8}-\d{6}-\d{6}-[0-9A-Za-z]{8,}\.json$", raw_path):
        errors.append("原始快照 raw_path 必须使用 materials/performance/raw/{slug}-{timestamp}-{uuid}.json 格式。")

    has_metric_table = bool(re.search(r"(?m)^\|.+\|\s*$", metrics)) and re.search(
        r"reads|views|plays|collects|recommends|wows|shares|comments|likes|播放|阅读|收藏|推荐|在看|点赞|评论|分享",
        metrics,
        re.IGNORECASE,
    )
    if not has_metric_table:
        errors.append("归一化指标必须提供包含关键指标的 markdown 表格。")
    if not re.search(r"materials/performance/(wechat-official-account|xhs)/", metrics):
        errors.append("归一化指标必须声明 normalized_path，并写入 materials/performance/wechat-official-account 或 xhs。")

    review_path = _field_value(review_input, "path")
    if not review_path.startswith("materials/performance/review-inputs/"):
        errors.append("Review 输入包 path 必须位于 materials/performance/review-inputs/。")

    comment_count = len(re.findall(r"(?m)^\s*[-*]\s*评论\s*\d+", comments))
    if comment_count == 0:
        reviews.append("评论样本为空：建议补充真实评论样本后再做 review。")

    return {
        "status": _status(errors, reviews),
        "errors": errors,
        "reviews": reviews,
        "blocking_issues": errors,
        "review_issues": reviews,
        "checks": {
            "evidence_status": evidence_status,
            "has_supported_target": not any("采集对象" in item for item in errors),
            "has_authorized_source": not any("授权与数据源" in item for item in errors),
            "has_raw_snapshot": not any("原始快照" in item for item in errors),
            "has_review_input": not any("Review 输入包" in item for item in errors),
        },
    }
