#!/usr/bin/env python3
"""Deterministic quality audit for publish records."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)
UNPUBLISHED_RE = re.compile(r"(?:未真实发布|未发布|demo|示例项目|模拟发布|内部演示)", re.IGNORECASE)
STRICT_FINAL_PATH_RE = re.compile(r"^pipeline/(?:final|xhs|package)/[^\s`|，。；;)\]]+")
LOCAL_ABS_RE = re.compile(r"^(?:/Users/|/private/|/tmp/|~|\w:\\)")
TRAVERSAL_RE = re.compile(r"(?:^|/)\.\.(?:/|$)")
URL_RE = re.compile(r"^https?://[^\s`|，。；;)\]]+$", re.IGNORECASE)
MOMENTS_PLATFORM_RE = re.compile(r"(?:朋友圈|微信朋友圈|moments)", re.IGNORECASE)
PUBLISH_PROOF_PATH_RE = re.compile(
    r"^materials/(?:publish-proof|publish-evidence)/[A-Za-z0-9._\-\u4e00-\u9fff]+\.(?:png|jpe?g|webp|pdf)$",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:w|万|k|千|%|次|条|个)?", re.IGNORECASE)
SIMULATED_DATA_RE = re.compile(r"(?:非真实数据|模拟数据|样例数据|占位数据|无真实数据|未真实发布，无平台数据)", re.IGNORECASE)


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    match = re.search(rf"(?m)^\s*[-*]\s*(?:{label_pattern})\s*[：:]\s*(.+?)\s*$", section or "")
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 2, *, allow_unpublished: bool = False) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    if allow_unpublished and UNPUBLISHED_RE.search(value):
        return True
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


def numeric_metric_lines(section: str) -> list[str]:
    lines: list[str] = []
    for raw_line in (section or "").splitlines():
        line = raw_line.strip()
        if not line or "---" in line:
            continue
        if NUMBER_RE.search(line):
            lines.append(line)
    return lines


def audit_publish(body: str) -> dict[str, Any]:
    """Audit whether a publish record can bind a run to a platform result."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "final": (r"^##\s*0\.\s+最终版", "缺少 `## 0. 最终版`。"),
        "metrics": (r"^##\s*1\.\s+表现数据", "缺少 `## 1. 表现数据`。"),
        "notes": (r"^##\s*2\.\s+发布备注", "缺少 `## 2. 发布备注`。"),
        "snapshot": (r"^##\s*3\.\s+最终版正文快照", "缺少 `## 3. 最终版正文快照`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    if not re.search(r"(?m)^#\s+\S+", body):
        blocking.append("缺少 H1 发布记录标题。")

    final = section_text(body, r"^##\s*0\.\s+最终版")
    metrics = section_text(body, r"^##\s*1\.\s+表现数据")
    notes = section_text(body, r"^##\s*2\.\s+发布备注")
    snapshot = section_text(body, r"^##\s*3\.\s+最终版正文快照")

    final_path = line_value(final, r"最终版路径|成稿路径|原文路径|内容路径")
    platform = line_value(final, r"发布平台|目标阵地|平台")
    published_at = line_value(final, r"发布时间|发布日期|发布时间点")
    publish_link = line_value(final, r"发布链接|链接|URL")
    publish_proof = line_value(final, r"发布凭证|凭证路径|截图凭证|发布截图")
    publish_status = line_value(final, r"发布状态|是否已发布|状态")

    final_path_value = final_path.strip()
    final_path_ok = bool(STRICT_FINAL_PATH_RE.search(final_path_value))
    if not final_path_ok:
        blocking.append("最终版缺少可追溯的 pipeline/final、pipeline/xhs 或 pipeline/package 成稿路径。")
    if LOCAL_ABS_RE.search(final_path_value) or TRAVERSAL_RE.search(final_path_value):
        blocking.append("最终版路径不能使用本机绝对路径或路径穿越。")
    if not meaningful_value(platform, 2):
        blocking.append("最终版缺少发布平台。")
    if not meaningful_value(published_at, 4, allow_unpublished=True):
        blocking.append("最终版缺少发布时间或明确的未发布/demo 状态。")

    is_moments = bool(MOMENTS_PLATFORM_RE.search(platform or ""))
    proof_path_ok = bool(PUBLISH_PROOF_PATH_RE.fullmatch(publish_proof.strip()))
    unpublished = bool(UNPUBLISHED_RE.search("\n".join([final, notes, publish_status, publish_link])))
    link_ok = meaningful_value(publish_link, 4, allow_unpublished=True)
    if is_moments:
        if not proof_path_ok:
            blocking.append(
                "朋友圈真实发布记录必须提供发布凭证：使用 materials/publish-proof/ 或 "
                "materials/publish-evidence/ 下的 png/jpg/webp/pdf 相对路径。"
            )
        if link_ok and not URL_RE.search(publish_link or "") and not re.search(r"无公开链接|不适用|朋友圈", publish_link):
            blocking.append("朋友圈发布链接若不使用 http/https，必须明确写“无公开链接”或“不适用”。")
    elif not link_ok and not unpublished:
        blocking.append("发布链接缺失；如果尚未真实发布，需要明确写为 demo/未真实发布。")
    elif not unpublished and link_ok and not URL_RE.search(publish_link or ""):
        blocking.append("真实发布记录必须提供 http/https 发布链接。")
    if unpublished and link_ok and URL_RE.search(publish_link or ""):
        blocking.append("记录为未真实发布，却填写了真实链接格式，发布状态和链接矛盾。")
    if re.search(r"已发布|是|published", publish_status or "", re.IGNORECASE) and unpublished:
        blocking.append("发布状态写已发布，但链接或备注又声明未真实发布，结论矛盾。")

    metric_rows = table_or_list_rows(metrics)
    metric_number_lines = numeric_metric_lines(metrics)
    has_number = bool(metric_number_lines)
    if metric_rows < 2:
        blocking.append("表现数据过薄，至少需要指标表或指标清单。")
    if not has_number and not unpublished:
        blocking.append("表现数据缺少阅读/播放、互动、评论、转化等数字信号。")
    if not re.search(r"阅读|播放|点赞|互动|评论|收藏|转发|转化|线索", metrics or ""):
        blocking.append("表现数据缺少关键指标字段。")
    if unpublished and has_number and not SIMULATED_DATA_RE.search("\n".join([metrics, notes])):
        blocking.append("未真实发布记录不能填写看似真实的表现数据；如仅为演示，必须明确写为非真实/模拟/占位数据。")

    if not meaningful_value(notes, 10, allow_unpublished=True):
        blocking.append("发布备注过薄，无法说明发布状态、口径或异常情况。")
    if unpublished and not re.search(r"demo|示例|未真实发布|模拟", notes, re.IGNORECASE):
        review.append("未真实发布状态建议在发布备注中再次说明。")

    if not meaningful_value(snapshot, 10):
        blocking.append("最终版正文快照过薄，至少需要保留标题、摘要或路径说明。")
    if not re.search(r"正文|标题|摘要|快照|路径|pipeline/", snapshot or ""):
        blocking.append("最终版正文快照缺少正文摘要或路径。")

    if PLACEHOLDER_RE.search(body):
        blocking.append("发布记录仍包含待补/待确认等占位表达。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    evidence_status = "blocked" if blocking else ("unpublished" if unpublished else "bound")
    return {
        "status": status,
        "evidence_status": evidence_status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "final_path": final_path,
            "final_path_ok": final_path_ok,
            "platform": platform,
            "published_at": published_at,
            "publish_link": publish_link,
            "publish_status": publish_status,
            "publish_proof": publish_proof,
            "publish_proof_path_ok": proof_path_ok,
            "is_moments": is_moments,
            "unpublished": unpublished,
            "metric_rows": metric_rows,
            "has_number_signal": has_number,
            "metric_number_lines": metric_number_lines,
            "notes_chars": len(re.sub(r"\s+", "", notes)),
            "snapshot_chars": len(re.sub(r"\s+", "", snapshot)),
        },
    }
