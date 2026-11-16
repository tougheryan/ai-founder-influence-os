#!/usr/bin/env python3
"""Deterministic quality audit for content-compliance reports."""
from __future__ import annotations

import re
from typing import Any


BLOCK_MARK_RE = re.compile(r"(?:❌|高风险|风险等级[：:]\s*高|不通过|不可发布|不能发布|必须修改|违规|侵权|阻断)")
WARN_MARK_RE = re.compile(r"(?:⚠️|中风险|风险等级[：:]\s*中|待确认|待复核|建议修改|review)", re.IGNORECASE)
PASS_MARK_RE = re.compile(r"(?:✅|\bPASS\b|\bOK\b|低风险|风险等级[：:]\s*低|无命中|未发现|通过|可发布)", re.IGNORECASE)
PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)
TABLE_HEADER_HINTS = (
    "风险词",
    "敏感词",
    "检查项",
    "证据项",
    "类别",
    "状态",
    "出现位置",
    "风险等级",
    "建议",
    "说明",
)
SAFE_KEYWORD_CONTEXT_RE = re.compile(r"(?:无命中|未出现|未涉及|未诱导|未使用|未展示|不含|无直接|无需|已删除|已替换|已修复|已打码)")
AD_LAW_RE = re.compile(r"(?:全网最强|行业第一|第一|唯一|顶级|国家级|最高级|最佳|最强|保证|100%|稳赚|必然成交|包过|永久有效|零风险|无副作用)")
TRAFFIC_RE = re.compile(r"(?:加我微信|加微信|微信号|VX|v信|私信我|评论区扣\s*1|扣\s*1|扫码|二维码|手机号|主页领取|进群)", re.IGNORECASE)
COPYRIGHT_BLOCK_RE = re.compile(r"(?:未授权|未经授权|未获授权|未取得授权|无授权记录|未打码|未标注来源|无出处|素材来源不明|版权不明)")
WEAK_PASS_EVIDENCE_RE = re.compile(
    r"(?:无明显风险|已处理|已确认|没问题|默认合规|暂按|暂未发现|机器扫描未发现|"
    r"后续|上线前|发布前补|可补|待用户|待客户|口头确认|口头授权|内部确认)"
)


def keyword_lines(text: str, pattern: re.Pattern[str]) -> list[str]:
    hits: list[str] = []
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line or not pattern.search(line):
            continue
        if SAFE_KEYWORD_CONTEXT_RE.search(line):
            continue
        hits.append(line)
    return hits


def keyword_terms(text: str, pattern: re.Pattern[str]) -> list[str]:
    terms: set[str] = set()
    for line in keyword_lines(text, pattern):
        terms.update(pattern.findall(line))
    return sorted(terms)


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
            if any(hint in stripped for hint in TABLE_HEADER_HINTS):
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


def status_counts(text: str, ignore_checked: bool = False) -> dict[str, int]:
    if ignore_checked:
        text = "\n".join(
            line
            for line in (text or "").splitlines()
            if not re.match(r"^\s*[-*]\s*\[[xX]\]\s+", line)
        )
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
            if not line.startswith("|") or "---" in line:
                continue
            if any(hint in line for hint in TABLE_HEADER_HINTS):
                continue
            if PASS_MARK_RE.search(line) and WEAK_PASS_EVIDENCE_RE.search(line):
                rows.append(f"{label}: {line}")
    return rows


def extract_overall(section: str) -> dict[str, str]:
    risk = line_value(section, r"\*\*?风险等级\*\*?|风险等级|综合风险")
    can_publish = line_value(section, r"\*\*?是否可发布\*\*?|是否可发布|是否可以发布|发布判断")
    next_step = line_value(section, r"\*\*?下一步\*\*?|下一步")
    return {"risk": risk, "can_publish": can_publish, "next_step": next_step}


def audit_compliance(body: str) -> dict[str, Any]:
    """Audit whether a compliance report is safe to pass downstream."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "target": (r"^##\s*0\.\s+检查对象", "缺少 `## 0. 检查对象`，无法追溯成稿和平台。"),
        "forbidden": (r"^##\s*1\.\s+违禁词扫描", "缺少 `## 1. 违禁词扫描`。"),
        "adlaw": (r"^##\s*2\.\s+广告法敏感词", "缺少 `## 2. 广告法敏感词`。"),
        "platform": (r"^##\s*3\.\s+平台规则风险", "缺少 `## 3. 平台规则风险`。"),
        "copyright": (r"^##\s*4\.\s+版权风险", "缺少 `## 4. 版权风险`。"),
        "ledger": (r"^##\s*4\.1\s+授权与引流证据台账", "缺少 `## 4.1 授权与引流证据台账`。"),
        "fixes": (r"^##\s*5\.\s+修改清单", "缺少 `## 5. 修改清单`。"),
        "overall": (r"^##\s*6\.\s+综合判断", "缺少 `## 6. 综合判断`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    target = section_text(body, r"^##\s*0\.\s+检查对象")
    forbidden = section_text(body, r"^##\s*1\.\s+违禁词扫描")
    adlaw = section_text(body, r"^##\s*2\.\s+广告法敏感词")
    platform = section_text(body, r"^##\s*3\.\s+平台规则风险")
    copyright = section_text(body, r"^##\s*4\.\s+版权风险")
    ledger = section_text(body, r"^##\s*4\.1\s+授权与引流证据台账")
    fixes = section_text(body, r"^##\s*5\.\s+修改清单")
    overall_section = section_text(body, r"^##\s*6\.\s+综合判断")

    draft_path = line_value(target, r"成稿路径|稿件路径|文件路径")
    platform_value = line_value(target, r"目标平台|目标阵地|平台")
    content_type = line_value(target, r"内容类型|类型")
    if not meaningful_value(draft_path, 4):
        blocking.append("检查对象缺少可追溯的成稿路径。")
    if not meaningful_value(platform_value, 2):
        blocking.append("检查对象缺少目标平台。")
    if not meaningful_value(content_type, 2):
        review.append("检查对象缺少内容类型，建议标明长文或图文。")

    risk_sections = {
        "forbidden": ("违禁词扫描", forbidden),
        "adlaw": ("广告法敏感词", adlaw),
        "platform": ("平台规则风险", platform),
        "copyright": ("版权风险", copyright),
    }
    risk_counts: dict[str, dict[str, int]] = {}
    for key, (label, section) in risk_sections.items():
        row_count = table_or_list_rows(section)
        counts = status_counts(section)
        risk_counts[key] = {"rows": row_count, **counts}
        if row_count == 0:
            blocking.append(f"{label}没有任何扫描结果或说明。")
        if counts["pass"] + counts["warn"] + counts["block"] == 0:
            blocking.append(f"{label}没有明确风险状态。")
        if counts["block"]:
            blocking.append(f"{label}仍存在高风险或违规项。")
        elif counts["warn"]:
            review.append(f"{label}仍有中风险或待确认项。")

    adlaw_keyword_lines = keyword_lines(adlaw, AD_LAW_RE)
    traffic_keyword_lines = keyword_lines("\n".join([forbidden, platform, ledger]), TRAFFIC_RE)
    copyright_keyword_lines = keyword_lines("\n".join([copyright, ledger]), COPYRIGHT_BLOCK_RE)
    if adlaw_keyword_lines:
        blocking.append("广告法敏感词存在未修复的绝对化或承诺型表达。")
    if traffic_keyword_lines:
        blocking.append("平台引流检查存在未修复的私域/诱导互动风险。")
    if copyright_keyword_lines:
        blocking.append("版权/授权检查存在未授权、未打码或来源不明风险。")

    weak_pass_rows = weak_pass_evidence_rows(
        {
            "违禁词扫描": forbidden,
            "广告法敏感词": adlaw,
            "平台规则风险": platform,
            "版权风险": copyright,
            "授权与引流证据台账": ledger,
        }
    )
    if weak_pass_rows:
        review.append(f"存在 {len(weak_pass_rows)} 行弱证据 PASS，请补具体修改、授权、来源或扫描记录。")

    ledger_rows = table_or_list_rows(ledger)
    ledger_counts = status_counts(ledger)
    ledger_coverage = {
        "adlaw": bool(re.search(r"广告法|绝对化|敏感词", ledger or "")),
        "traffic": bool(re.search(r"引流|微信|私信|二维码|评论区", ledger or "")),
        "copyright": bool(re.search(r"版权|素材|图片|引用", ledger or "")),
        "authorization": bool(re.search(r"授权|肖像|聊天|截图|打码", ledger or "")),
    }
    if ledger_rows == 0:
        blocking.append("授权与引流证据台账没有任何可复核记录。")
    if ledger_counts["pass"] + ledger_counts["warn"] + ledger_counts["block"] == 0:
        blocking.append("授权与引流证据台账没有明确风险状态。")
    if ledger_counts["block"]:
        blocking.append("授权与引流证据台账仍存在阻断项。")
    elif ledger_counts["warn"]:
        review.append("授权与引流证据台账仍有待确认项。")
    missing_ledger = [label for label, ok in ledger_coverage.items() if not ok]
    if missing_ledger:
        blocking.append("授权与引流证据台账覆盖不足，缺少：" + "、".join(missing_ledger) + "。")

    fix_open = checkbox_count(fixes, checked=False)
    fix_done = checkbox_count(fixes, checked=True)
    fix_total = checkbox_count(fixes, checked=None)
    fix_counts = status_counts(fixes, ignore_checked=True)
    if fix_open > 0:
        blocking.append(f"修改清单仍有 {fix_open} 项未完成。")
    if fix_counts["block"]:
        blocking.append("修改清单仍包含高风险或必须修改项。")
    if fix_total == 0 and any(counts["block"] or counts["warn"] for counts in risk_counts.values()):
        blocking.append("存在风险项，但修改清单没有对应 checkbox。")

    overall = extract_overall(overall_section)
    risk = overall["risk"]
    can_publish = overall["can_publish"]
    next_step = overall["next_step"]
    if not meaningful_value(risk, 1):
        blocking.append("综合判断缺少风险等级。")
    if not meaningful_value(can_publish, 1):
        blocking.append("综合判断缺少 `是否可发布`。")
    if not meaningful_value(next_step, 3):
        blocking.append("综合判断缺少明确下一步命令或处理动作。")
    if re.search(r"高", risk or "") and re.search(r"是|可以|可发布", can_publish or ""):
        blocking.append("风险等级为高，却允许发布。")
    if re.search(r"是|可以|可发布", can_publish or "") and blocking:
        blocking.append("综合判断允许发布，但前文仍有阻断项，结论自相矛盾。")
    if re.search(r"否|不能|不可|先修改|不建议", can_publish or "") and not blocking:
        review.append("综合判断不允许发布，但未列出阻断原因，请补充修改清单。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "draft_path": draft_path,
            "target_platform": platform_value,
            "content_type": content_type,
            "risk_counts": risk_counts,
            "ledger_rows": ledger_rows,
            "ledger_status": ledger_counts,
            "ledger_coverage": ledger_coverage,
            "adlaw_hits": keyword_terms(adlaw, AD_LAW_RE),
            "traffic_risk_hits": keyword_terms("\n".join([forbidden, platform, ledger]), TRAFFIC_RE),
            "copyright_risk_hits": keyword_terms("\n".join([copyright, ledger]), COPYRIGHT_BLOCK_RE),
            "compliance_weak_pass_rows": weak_pass_rows,
            "fix_open": fix_open,
            "fix_done": fix_done,
            "risk": risk,
            "can_publish": can_publish,
            "next_step": next_step,
        },
    }
