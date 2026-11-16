#!/usr/bin/env python3
"""Deterministic quality audit for content-audit reports."""
from __future__ import annotations

import re
from typing import Any


BLOCK_MARK_RE = re.compile(r"(?:❌|高风险|无来源|不可发布|不能发布|不建议发布|违规|侵权|泄露|阻断|未授权|未打码)")
WARN_MARK_RE = re.compile(r"(?:⚠️|待核实|待确认|存疑|中风险|review)", re.IGNORECASE)
PASS_MARK_RE = re.compile(r"(?:✅|\bPASS\b|\bOK\b|已标注|已核对|低风险|无明显风险|通过|可发布)", re.IGNORECASE)
PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)
TABLE_HEADER_HINTS = (
    "事实/数据",
    "事实/判断",
    "声明",
    "类型",
    "原文位置",
    "来源",
    "状态",
    "处理动作",
)
SAFE_CONTEXT_RE = re.compile(r"(?:未使用|未出现|不涉及|不展示|不公开|不写|避免|弱化|删除|已删除|已替换|已核对|已匿名|已匿名化|已打码|已处理|无明显|无需)")
UNSOURCED_RE = re.compile(r"(?:无来源|未标注来源|来源不明|无出处|无法核验|未核验|未提供来源|凭空)")
OVERCLAIM_RE = re.compile(r"(?:必然成交|保证|100%|稳赚|包过|最高|第一|唯一|全网最强|永久有效|零风险)")
PRIVACY_RE = re.compile(r"(?:客户截图|聊天截图|真实姓名|手机号|微信号|公司名|身份证|肖像|未授权|未打码|泄露)")
WEAK_PASS_EVIDENCE_RE = re.compile(
    r"(?:无明显风险|已处理|已确认|口头确认|口头授权|用户确认|用户说|客户说|"
    r"后续|未来|发布前补|上线前补|再确认|人工确认|真实交付时补|默认可信|默认可用|经验判断|常识判断)"
)


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


def keyword_lines(text: str, pattern: re.Pattern[str]) -> list[str]:
    hits: list[str] = []
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line or not pattern.search(line):
            continue
        if SAFE_CONTEXT_RE.search(line):
            continue
        hits.append(line)
    return hits


def keyword_terms(text: str, pattern: re.Pattern[str]) -> list[str]:
    terms: set[str] = set()
    for line in keyword_lines(text, pattern):
        terms.update(pattern.findall(line))
    return sorted(terms)


def table_or_list_rows(section: str) -> int:
    rows = 0
    for line in (section or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("|") and "---" not in stripped:
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            header_like_cells = sum(1 for cell in cells if any(hint == cell or hint in cell for hint in TABLE_HEADER_HINTS))
            if header_like_cells >= max(3, len(cells) - 1):
                continue
            rows += 1
        elif re.match(r"^(?:[-*]|\d+[.)])\s+", stripped):
            rows += 1
    return rows


def checkbox_count(section: str, checked: bool | None = None) -> int:
    if checked is None:
        pattern = r"(?m)^\s*[-*]\s*\[[ xX]\]\s+"
    elif checked:
        pattern = r"(?m)^\s*[-*]\s*\[[xX]\]\s+"
    else:
        pattern = r"(?m)^\s*[-*]\s*\[\s\]\s+"
    return len(re.findall(pattern, section or ""))


def status_counts(text: str) -> dict[str, int]:
    return {
        "pass": len(PASS_MARK_RE.findall(text or "")),
        "warn": len(WARN_MARK_RE.findall(text or "")),
        "block": len(BLOCK_MARK_RE.findall(text or "")),
    }


def weak_pass_evidence_rows(sections: dict[str, str]) -> list[str]:
    rows: list[str] = []
    for label, section in sections.items():
        for raw_line in (section or "").splitlines():
            line = raw_line.strip()
            if not line:
                continue
            is_row = line.startswith("|") or bool(re.match(r"^(?:[-*]|\d+[.)])\s+", line))
            if not is_row or "---" in line:
                continue
            if line.startswith("|"):
                cells = [cell.strip() for cell in line.strip("|").split("|")]
                header_like_cells = sum(1 for cell in cells if any(hint == cell or hint in cell for hint in TABLE_HEADER_HINTS))
                if header_like_cells >= max(3, len(cells) - 1):
                    continue
            if PASS_MARK_RE.search(line) and WEAK_PASS_EVIDENCE_RE.search(line):
                rows.append(f"{label}: {line}")
    return rows


def extract_overall(section: str) -> dict[str, str]:
    can_publish = line_value(section, r"是否可发布|是否可以发布|发布判断")
    residual = line_value(section, r"遗留风险|剩余风险")
    next_step = line_value(section, r"下一步|后续动作")
    return {"can_publish": can_publish, "residual": residual, "next_step": next_step}


def audit_audit(body: str) -> dict[str, Any]:
    """Audit whether a trusted review report is actionable and self-consistent."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "target": (r"^##\s*0\.\s+检查对象", "缺少 `## 0. 检查对象`，无法追溯审核对象。"),
        "sources": (r"^##\s*1\.\s+来源追溯", "缺少 `## 1. 来源追溯`。"),
        "facts": (r"^##\s*2\.\s+事实校验", "缺少 `## 2. 事实校验`。"),
        "ledger": (r"^##\s*2\.1\s+事实声明台账", "缺少 `## 2.1 事实声明台账`。"),
        "privacy": (r"^##\s*3\.\s+隐私提醒", "缺少 `## 3. 隐私提醒`。"),
        "platform": (r"^##\s*4\.\s+平台风险", "缺少 `## 4. 平台风险`。"),
        "fixes": (r"^##\s*5\.\s+修改建议", "缺少 `## 5. 修改建议`。"),
        "overall": (r"^##\s*7\.\s+总体结论", "缺少 `## 7. 总体结论`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    target = section_text(body, r"^##\s*0\.\s+检查对象")
    sources = section_text(body, r"^##\s*1\.\s+来源追溯")
    facts = section_text(body, r"^##\s*2\.\s+事实校验")
    ledger = section_text(body, r"^##\s*2\.1\s+事实声明台账")
    privacy = section_text(body, r"^##\s*3\.\s+隐私提醒")
    platform = section_text(body, r"^##\s*4\.\s+平台风险")
    fixes = section_text(body, r"^##\s*5\.\s+修改建议")
    humanizer = section_text(body, r"^##\s*6\.\s+humanizer\s*润色摘要")
    overall_section = section_text(body, r"^##\s*7\.\s+总体结论")

    draft_path = line_value(target, r"成稿路径|稿件路径|文件路径")
    prelaunch_path = line_value(target, r"发布前检查路径|prelaunchPath|prelaunch")
    compliance_path = line_value(target, r"合规报告路径|compliancePath|compliance")
    platform_value = line_value(target, r"目标平台|目标阵地|平台")
    content_type = line_value(target, r"内容类型|类型")
    if not meaningful_value(draft_path, 4):
        blocking.append("检查对象缺少可追溯的成稿路径。")
    elif not re.search(r"^pipeline/(?:final|xhs)/", draft_path):
        blocking.append("成稿路径必须指向当前项目内的 pipeline/final 或 pipeline/xhs。")
    if not meaningful_value(platform_value, 2):
        blocking.append("检查对象缺少目标平台。")
    if not meaningful_value(content_type, 2):
        review.append("检查对象缺少内容类型，建议标明长文或图文。")
    if not meaningful_value(prelaunch_path, 4):
        review.append("检查对象缺少发布前检查路径，建议读取当前 run 的 prelaunch 报告。")
    if not meaningful_value(compliance_path, 4):
        review.append("检查对象缺少合规报告路径，建议读取当前 run 的 compliance 报告。")

    section_counts: dict[str, dict[str, int]] = {}
    for key, label, section, minimum in [
        ("sources", "来源追溯", sources, 2),
        ("facts", "事实校验", facts, 2),
        ("ledger", "事实声明台账", ledger, 3),
        ("privacy", "隐私提醒", privacy, 1),
        ("platform", "平台风险", platform, 1),
        ("fixes", "修改建议", fixes, 1),
    ]:
        row_count = table_or_list_rows(section)
        counts = status_counts(section)
        section_counts[key] = {"rows": row_count, **counts}
        if row_count < minimum:
            blocking.append(f"{label}内容过薄，至少需要 {minimum} 条可复核记录。")
        if counts["block"]:
            blocking.append(f"{label}仍存在阻断风险或 P0 问题。")
        elif counts["warn"]:
            review.append(f"{label}仍有待核实或建议修改项。")

    ledger_coverage = {
        "hard_numbers": bool(re.search(r"硬数字|数据|金额|百分比|时间口径|统计周期|截至", ledger or "")),
        "public_facts": bool(re.search(r"公开事实|产品|公司|人物|平台|政策|行业", ledger or "")),
        "case_claims": bool(re.search(r"案例|客户|访谈|经历|截图", ledger or "")),
        "quotes": bool(re.search(r"引用|原话|转述|出处", ledger or "")),
    }
    missing_ledger = [label for label, ok in ledger_coverage.items() if not ok]
    if missing_ledger:
        blocking.append("事实声明台账覆盖不足，缺少：" + "、".join(missing_ledger) + "。")

    unsourced_hits = keyword_terms("\n".join([sources, facts, ledger]), UNSOURCED_RE)
    overclaim_hits = keyword_terms("\n".join([sources, facts, ledger, platform]), OVERCLAIM_RE)
    privacy_hits = keyword_terms("\n".join([privacy, ledger]), PRIVACY_RE)
    if unsourced_hits:
        blocking.append("仍存在未解决的无来源/未核验事实声明。")
    if overclaim_hits:
        blocking.append("仍存在未修复的绝对化承诺或过度事实断言。")
    if privacy_hits:
        blocking.append("仍存在未解决的隐私、肖像或客户信息风险。")

    weak_pass_rows = weak_pass_evidence_rows(
        {
            "来源追溯": sources,
            "事实校验": facts,
            "事实声明台账": ledger,
            "隐私提醒": privacy,
            "平台风险": platform,
            "修改建议": fixes,
        }
    )
    if weak_pass_rows:
        review.append(f"存在 {len(weak_pass_rows)} 行弱证据 PASS，请补来源、授权、截图打码或核验记录。")

    if "P0" not in fixes:
        review.append("修改建议缺少 P0/P1/P2 优先级分层，正式交付建议补齐。")
    p0_match = re.search(r"(?ms)^###\s*P0[^\n]*\n(.*?)(?=^###\s+|\Z)", fixes)
    p0_section = p0_match.group(1).strip() if p0_match else ""
    p0_open = checkbox_count(p0_section, checked=False)
    if p0_open:
        blocking.append(f"P0 修改建议仍有 {p0_open} 项未完成。")

    all_open = checkbox_count(fixes, checked=False)
    if all_open and not p0_open:
        review.append(f"修改建议仍有 {all_open} 项未完成，进入发布前需人工确认。")

    if not humanizer:
        review.append("缺少 humanizer 润色摘要；如未润色，应说明未发现明显 AI 味。")
    elif table_or_list_rows(humanizer) < 1:
        review.append("humanizer 润色摘要过薄。")

    overall = extract_overall(overall_section)
    can_publish = overall["can_publish"]
    residual = overall["residual"]
    next_step = overall["next_step"]
    if not meaningful_value(can_publish, 1):
        blocking.append("总体结论缺少 `是否可发布`。")
    if not meaningful_value(residual, 1):
        review.append("总体结论缺少遗留风险说明。")
    if not meaningful_value(next_step, 3):
        review.append("总体结论缺少下一步动作。")
    if re.search(r"是|可以|可发布", can_publish or "") and blocking:
        blocking.append("总体结论允许发布，但前文仍有阻断项，结论自相矛盾。")
    if re.search(r"否|不能|不可|先修改|不建议", can_publish or "") and not blocking:
        review.append("总体结论不允许发布，但未列出阻断原因，请补充 P0 修改项。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "draft_path": draft_path,
            "prelaunch_path": prelaunch_path,
            "compliance_path": compliance_path,
            "target_platform": platform_value,
            "content_type": content_type,
            "section_counts": section_counts,
            "ledger_coverage": ledger_coverage,
            "unsourced_hits": unsourced_hits,
            "overclaim_hits": overclaim_hits,
            "privacy_hits": privacy_hits,
            "audit_weak_pass_rows": weak_pass_rows,
            "p0_open": p0_open,
            "open_fixes": all_open,
            "can_publish": can_publish,
            "residual_risk": residual,
            "next_step": next_step,
            "has_humanizer": bool(humanizer),
        },
    }
