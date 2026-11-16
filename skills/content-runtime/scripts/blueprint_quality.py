#!/usr/bin/env python3
"""Quality audit for blueprint pipeline outputs."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_WORDS = ("无", "暂无", "待补", "待确认", "未提供", "TO" + "DO", "T" + "BD", "xxx", "...")
TITLE_HYPOTHESIS_FIELDS = ("工作标题", "候选方向", "测试理由", "不采用标题")
PROTECTIVE_COPYING_PHRASES = ("不可照搬", "不得照搬", "不能照搬", "避免照搬", "禁止照搬")
COPIED_LANGUAGE_RE = re.compile(r"照搬|复刻|直接使用|原样使用|一夜失业|稳赚|必爆", re.IGNORECASE)


def _compact(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _section(body: str, index: int, title: str) -> str:
    pattern = rf"(?ms)^##\s*{index}\.\s+{re.escape(title)}\s*(.*?)(?=^##\s*\d+\.|\Z)"
    match = re.search(pattern, body)
    return match.group(1).strip() if match else ""


def _is_placeholder(text: str) -> bool:
    plain = _compact(text)
    if not plain:
        return True
    stripped = re.sub(r"^[\-*]\s*", "", plain).strip("：: 。.")
    return stripped in PLACEHOLDER_WORDS or stripped in {"空", "略"}


def _has_substance(text: str, min_len: int = 12) -> bool:
    plain = _compact(text)
    return len(plain) >= min_len and not _is_placeholder(plain)


def _title_hypothesis_complete(text: str) -> bool:
    if not _has_substance(text):
        return False
    for field in TITLE_HYPOTHESIS_FIELDS:
        match = re.search(rf"(?mi)^\s*[-*]?\s*(?:\*\*)?{re.escape(field)}(?:\*\*)?\s*[：:]\s*(.+)$", text)
        if not match or not _has_substance(match.group(1)):
            return False
    return True


def _has_copied_language(text: str) -> bool:
    scan_text = text
    for phrase in PROTECTIVE_COPYING_PHRASES:
        scan_text = scan_text.replace(phrase, "")
    return COPIED_LANGUAGE_RE.search(scan_text) is not None


def _confirmed(text: str) -> bool:
    match = re.search(r"(?mi)^\s*[-*]?\s*确认状态\s*[：:]\s*(.+)$", text)
    if not match:
        return False
    value = _compact(match.group(1)).strip("。.;；")
    if re.search(r"未通过|未确认|不通过|否|pending|待确认|reject|rejected|no\b", value, re.IGNORECASE):
        return False
    return re.fullmatch(r"confirmed|confirm|yes|y|已确认|通过", value, re.IGNORECASE) is not None


def _status(errors: list[str], reviews: list[str]) -> str:
    if errors:
        return "blocked"
    if reviews:
        return "review_required"
    return "pass"


def audit_blueprint(body: str) -> dict[str, Any]:
    errors: list[str] = []
    reviews: list[str] = []

    benchmark = _section(body, 1, "爆款拆解吸收")
    title_hypothesis = re.search(
        r"(?ms)^##\s*1\.1\s+标题假设\s*(.*?)(?=^##\s*(?:\d+\.|\d+\.\d+)|\Z)",
        body,
    )
    title_hypothesis_text = title_hypothesis.group(1).strip() if title_hypothesis else ""
    core = _section(body, 2, "核心判断")
    skeleton = _section(body, 4, "公众号思想母版骨架")
    evidence = _section(body, 5, "证据链与素材分配")
    comments = _section(body, 8, "评论区互动预埋")
    risks = _section(body, 9, "风险边界")
    confirmation = _section(body, 10, "人工确认清单")

    if not _has_substance(core) or re.search(r"判断[：:]\s*写内容[。.]?$", _compact(core)):
        errors.append("核心判断过弱：必须给出可执行、可争辩的内容判断。")
    if not _has_substance(skeleton) or not re.search(r"开头|章节|第一节|结构|骨架|推进", skeleton):
        errors.append("公众号思想母版骨架不足：必须包含开头/章节/推进任务。")
    if not _has_substance(evidence) or not re.search(r"证据|素材|访谈|数据|案例|截图|来源|分配", evidence):
        errors.append("证据链与素材分配不足：必须说明证据或素材如何支撑章节。")
    if not _has_substance(comments) or not re.search(r"置顶评论|首评|追评|评论|互动|提问", comments):
        errors.append("评论区互动预埋不足：必须给出可直接使用的评论互动设计。")
    if not _has_substance(risks) or not re.search(r"不|避免|边界|风险|隐私|承诺|夸大|事实", risks):
        errors.append("风险边界不足：必须写清不能碰的事实、隐私或承诺边界。")
    if not _title_hypothesis_complete(title_hypothesis_text):
        errors.append("标题假设不足：blueprint 必须给出工作标题、候选方向、测试理由和不采用标题。")
    if _has_copied_language(benchmark + "\n" + title_hypothesis_text):
        errors.append("爆款拆解不可照搬：benchmark 只能作为市场证据，不能复制标题、恐慌承诺或爆款表达。")
    confirmed = _confirmed(confirmation)
    if not confirmed:
        reviews.append("人工确认清单仍为待确认；不阻断内容生成，后续编辑时再复核。")
    if _is_placeholder(benchmark):
        reviews.append("爆款拆解吸收为空或占位：建议补充 benchmark 样本和可迁移结构。")

    # Blueprint quality is editorial guidance, not a production gate. Runtime
    # schema, run binding and the immutable TikOmni snapshot remain enforced by
    # the caller; weaker titles, structure or wording should not strand a usable
    # artifact or trigger another paid model request.
    quality_issues = list(errors)
    reviews = [*quality_issues, *reviews]
    errors = []

    return {
        "status": _status(errors, reviews),
        "errors": errors,
        "reviews": reviews,
        "blocking_issues": errors,
        "review_issues": reviews,
        "checks": {
            "has_core_judgment": not any("核心判断" in item for item in quality_issues),
            "has_motherpiece_skeleton": not any("公众号思想母版骨架" in item for item in quality_issues),
            "has_comment_hooks": not any("评论区互动预埋" in item for item in quality_issues),
            "has_title_hypothesis": not any("标题假设" in item for item in quality_issues),
            "benchmark_not_copied": not any("爆款拆解不可照搬" in item for item in quality_issues),
            "confirmed": confirmed,
        },
    }
