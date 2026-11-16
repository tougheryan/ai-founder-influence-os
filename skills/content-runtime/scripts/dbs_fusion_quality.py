#!/usr/bin/env python3
"""Deterministic quality audit for content-dbs-fusion reports."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)
SELF_CLAIMED_APPLIED_RE = re.compile(
    r"(?:已写回|已应用|已完成|写回完成|\b(?:applied|done|completed|pass)\b)",
    re.IGNORECASE,
)

SUPPORTED_MODES = [
    "选题诊断",
    "爆款标题",
    "商业表达诊断",
    "关键决策",
    "跨会话状态",
    "传播心理解码",
    "共鸣诊断",
    "公众号排版",
]

SUPPORTED_SKILLS = [
    "dbs-goal",
    "dbs-diagnosis",
    "dbs-benchmark",
    "dbs-content",
    "dbs-xhs-title",
    "dbs-ai-check",
    "dbs-good-question",
    "dbs-deconstruct",
    "dbs-decision",
    "dbs-save",
    "dbs-restore",
    "dbs-report",
    "dbs-spread",
    "dbs-resonate",
    "dbs-wechat-html",
]

WRITEBACK_TARGETS = [
    "pipeline/validate",
    "pipeline/breakdown",
    "pipeline/prelaunch",
    "pipeline/visual",
    "pipeline/audit",
    "brain/",
    "sessions/",
]

DOWNSTREAM_SIGNALS = [
    "/content-validate",
    "/content-angle",
    "/content-breakdown",
    "/content-write",
    "/content-visual",
    "/content-prelaunch",
    "/content-audit",
    "content-validate",
    "content-angle",
    "content-breakdown",
    "wechat-writer",
    "content-visual",
    "content-prelaunch",
    "content-audit",
]


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    match = re.search(rf"(?m)^\s*[-*]\s*(?:\*\*)?(?:{label_pattern})(?:\*\*)?\s*[：:]\s*(.+?)\s*$", section or "")
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 4) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    return not PLACEHOLDER_RE.search(value)


def text_mentions_any(text: str, needles: list[str]) -> bool:
    return any(re.search(re.escape(needle), text or "", re.IGNORECASE) for needle in needles)


def table_or_list_rows(section: str) -> int:
    rows = 0
    for line in (section or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("|") and "---" not in stripped:
            rows += 1
        elif re.match(r"^(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+", stripped):
            rows += 1
    return rows


def split_markdown_row(line: str) -> list[str]:
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|"):
        text = text[:-1]
    cells: list[str] = []
    current: list[str] = []
    escaped = False
    for char in text:
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "|":
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    cells.append("".join(current).strip())
    return cells


def is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells if cell.strip())


def normalize_header(value: str) -> str:
    return re.sub(r"[\s`*_]+", "", value or "")


def writeback_state_values(section: str) -> list[str]:
    states: list[str] = []
    headers: list[str] | None = None
    state_index: int | None = None
    for line in (section or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("|"):
            cells = split_markdown_row(stripped)
            if is_separator_row(cells):
                continue
            if headers is None:
                headers = [normalize_header(cell) for cell in cells]
                for index, header in enumerate(headers):
                    if header in {"状态", "state", "写回状态"}:
                        state_index = index
                        break
                continue
            if state_index is not None and state_index < len(cells):
                states.append(cells[state_index].strip())
            continue
        match = re.search(r"(?:状态|写回状态)\s*[：:]\s*(.+)$", stripped)
        if match:
            states.append(match.group(1).strip())
    return states


def used_skills(text: str) -> list[str]:
    found: list[str] = []
    for skill in SUPPORTED_SKILLS:
        if re.search(rf"(?:/)?{re.escape(skill)}\b", text or "", re.IGNORECASE):
            found.append(skill)
    return found


def audit_dbs_fusion(body: str) -> dict[str, Any]:
    """Audit whether a dbskill result can safely enter AIFIOS pipeline state."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "task": (r"^##\s*0\.\s+融合任务", "缺少 `## 0. 融合任务`。"),
        "chain": (r"^##\s*1\.\s+调用链", "缺少 `## 1. 调用链`。"),
        "conclusions": (r"^##\s*2\.\s+关键结论", "缺少 `## 2. 关键结论`。"),
        "evidence": (r"^##\s*3\.\s+证据与风险", "缺少 `## 3. 证据与风险`。"),
        "writeback": (r"^##\s*4\.\s+写回计划", "缺少 `## 4. 写回计划`。"),
        "next": (r"^##\s*5\.\s+下一步动作", "缺少 `## 5. 下一步动作`。"),
        "review": (r"^##\s*6\.\s+人工复核", "缺少 `## 6. 人工复核`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    task = section_text(body, r"^##\s*0\.\s+融合任务")
    chain = section_text(body, r"^##\s*1\.\s+调用链")
    conclusions = section_text(body, r"^##\s*2\.\s+关键结论")
    evidence = section_text(body, r"^##\s*3\.\s+证据与风险")
    writeback = section_text(body, r"^##\s*4\.\s+写回计划")
    next_section = section_text(body, r"^##\s*5\.\s+下一步动作")
    review_section = section_text(body, r"^##\s*6\.\s+人工复核")

    mode = line_value(task, r"模式|融合模式|任务模式")
    trigger = line_value(task, r"触发问题|用户问题|原始问题")
    upstream = line_value(task, r"上游输入|输入来源|输入产物")
    target = line_value(task, r"目标写回|写回目标|落点")
    if not meaningful_value(mode, 4) or not text_mentions_any(mode, SUPPORTED_MODES):
        blocking.append("融合任务缺少明确模式，或模式不在支持范围内。")
    if not meaningful_value(trigger, 6):
        blocking.append("融合任务缺少可追溯的触发问题。")
    if not meaningful_value(upstream, 6):
        blocking.append("融合任务缺少上游输入来源。")
    if not meaningful_value(target, 6) or not text_mentions_any(target, WRITEBACK_TARGETS + DOWNSTREAM_SIGNALS):
        blocking.append("融合任务缺少明确写回目标，无法进入流水线。")

    skills = used_skills(chain)
    if not skills:
        blocking.append("调用链没有标注实际调用的 dbskill。")
    if table_or_list_rows(chain) < 2:
        blocking.append("调用链过薄，请至少列出 skill、目的、输入证据、输出摘要和状态。")
    if not text_mentions_any(chain, ["输入证据", "证据", "输出摘要", "状态", "pass", "review", "blocked", "完成"]):
        blocking.append("调用链缺少输入证据、输出摘要或状态。")

    conclusion_value = line_value(conclusions, r"结论|核心结论|诊断结论")
    confidence = line_value(conclusions, r"置信度|把握度")
    if not meaningful_value(conclusion_value, 8):
        blocking.append("关键结论缺少可执行诊断结论。")
    if not meaningful_value(confidence, 1) or not re.search(r"高|中|低|[0-9]{1,3}%", confidence):
        review.append("关键结论建议标注高/中/低或百分比置信度。")
    if not text_mentions_any(conclusions, ["证据", "依据", "因为", "来源"]):
        blocking.append("关键结论没有说明证据依据。")

    if table_or_list_rows(evidence) < 2:
        blocking.append("证据与风险缺少证据台账。")
    if not text_mentions_any(evidence, ["来源", "风险", "处理", "待核验", "授权", "隐私", "事实"]):
        blocking.append("证据与风险没有覆盖来源、风险和处理方式。")

    if table_or_list_rows(writeback) < 2:
        blocking.append("写回计划缺少结构化写回行。")
    if not text_mentions_any(writeback, WRITEBACK_TARGETS):
        blocking.append("写回计划没有指向 pipeline/、brain/ 或 sessions/ 的具体位置。")
    if not text_mentions_any(writeback, DOWNSTREAM_SIGNALS):
        blocking.append("写回计划没有说明下游由哪个 content skill 使用。")
    writeback_states = writeback_state_values(writeback)
    self_claimed_applied_rows = [state for state in writeback_states if SELF_CLAIMED_APPLIED_RE.search(state)]
    if self_claimed_applied_rows:
        blocking.append("DBS 融合报告不能自称已写回；完成状态必须来自 dbs-fusion-apply 报告和目标资产写回标记。")
    if not text_mentions_any(writeback, ["待写回", "需要人工", "review", "blocked"]):
        review.append("写回计划建议标注待写回、需要人工、review 或 blocked，方便交付审计追踪。")

    if not text_mentions_any(next_section, ["/content-", "content-", "make ", "python3 "]):
        blocking.append("下一步动作缺少可执行命令或下游 skill。")
    if not meaningful_value(review_section, 6):
        review.append("人工复核部分过薄，建议说明需要复核的事实、授权或商业判断。")

    if "dbs-spread" in skills:
        spread_terms = ["沉默解除", "满足动机", "立场框架", "传播入口", "信念结构", "受众情绪底层"]
        missing_spread = [term for term in spread_terms if term not in body]
        if missing_spread:
            blocking.append("dbs-spread 结果缺少传播心理关键维度：" + "、".join(missing_spread) + "。")
        if "pipeline/breakdown" not in body and "content-breakdown" not in body:
            blocking.append("dbs-spread 结果没有写回 breakdown，后续标题/钩子无法复用。")

    if "dbs-resonate" in skills:
        if not text_mentions_any(body, ["共鸣", "返修", "删改", "打中", "没打中"]):
            blocking.append("dbs-resonate 结果缺少共鸣诊断和返修判断。")
        if "pipeline/prelaunch" not in body and "content-prelaunch" not in body:
            blocking.append("dbs-resonate 结果没有写回 prelaunch，发布前闸门无法追溯。")

    if "dbs-wechat-html" in skills:
        if not text_mentions_any(body, ["HTML", "公众号HTML输出", "微信后台", "pipeline/visual"]):
            blocking.append("dbs-wechat-html 结果缺少 HTML 产物路径或 visual 写回位置。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "mode": mode,
            "trigger": trigger,
            "upstream": upstream,
            "target": target,
            "skills": skills,
            "chain_rows": table_or_list_rows(chain),
            "evidence_rows": table_or_list_rows(evidence),
            "writeback_rows": table_or_list_rows(writeback),
            "writeback_states": writeback_states,
            "self_claimed_applied_rows": self_claimed_applied_rows,
        },
    }
