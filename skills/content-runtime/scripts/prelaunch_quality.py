#!/usr/bin/env python3
"""Deterministic quality audit for content-prelaunch checklists."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待修复|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)

BLOCK_MARK_RE = re.compile(r"(?:❌|不通过|高风险|先修复|不能发|不可发布|不建议发布|阻断)")
WARN_MARK_RE = re.compile(r"(?:⚠️|警告|中风险|待确认|待复核|建议先修|review)", re.IGNORECASE)
PASS_MARK_RE = re.compile(r"(?:✅|\bPASS\b|\bOK\b|通过|低风险|可以通过|可进入|可发布)", re.IGNORECASE)
ASSET_BLOCK_RE = re.compile(r"(?:❌|missing|未生成|未找到|不存在|未打包|未完成|缺失|阻断|不可发布|不能发)", re.IGNORECASE)
ASSET_REVIEW_RE = re.compile(r"(?:⚠️|review|待确认|待复核|人工确认|建议|planned|pending)", re.IGNORECASE)
ASSET_FUTURE_RE = re.compile(r"(?:可生成|可打包|可复现|待生成|待打包|已列入交付|路径已列入|输出路径已列入)", re.IGNORECASE)
ASSET_BARE_DIRECTORY_RE = re.compile(r"(?:quality/reports/|deliveries/)\s*(?:\||$)", re.IGNORECASE)


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


def weak_pass_asset_rows(section: str) -> list[str]:
    rows: list[str] = []
    for line in (section or "").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or "---" in stripped:
            continue
        if not PASS_MARK_RE.search(stripped):
            continue
        if ASSET_FUTURE_RE.search(stripped) or ASSET_BARE_DIRECTORY_RE.search(stripped):
            rows.append(stripped[:240])
    return rows


def extract_overall(section: str) -> dict[str, str]:
    can_audit = line_value(section, r"\*\*?是否可以通过 content-audit\*\*?|是否可以通过 content-audit|是否可进入 audit|是否可发布|是否可以发布")
    risk = line_value(section, r"\*\*?风险等级\*\*?|风险等级|综合风险")
    next_step = line_value(section, r"\*\*?下一步\*\*?|下一步")
    return {"can_audit": can_audit, "risk": risk, "next_step": next_step}


def audit_prelaunch(body: str) -> dict[str, Any]:
    """Audit whether a prelaunch checklist is safe to pass downstream.

    Blocking issues mean the checklist itself is not trustworthy enough to enter
    content-audit/compliance. Review issues can proceed but must be surfaced.
    """
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "target": (r"^##\s*0\.\s+检查对象", "缺少 `## 0. 检查对象`，无法追溯成稿、平台和内容类型。"),
        "facts": (r"^##\s*1\.\s+事实层检查", "缺少 `## 1. 事实层检查`。"),
        "style": (r"^##\s*2\.\s+风格层检查", "缺少 `## 2. 风格层检查`。"),
        "platform": (r"^##\s*3\.\s+平台规则层检查", "缺少 `## 3. 平台规则层检查`。"),
        "business": (r"^##\s*4\.\s+商业闭环检查", "缺少 `## 4. 商业闭环检查`。"),
        "resonance": (r"^##\s*5\.\s+共鸣诊断", "缺少 `## 5. 共鸣诊断`，请先用 `/dbs-resonate` 检查成稿是否打中受众。"),
        "fixes": (r"^##\s*6\.\s+待修复清单", "缺少 `## 6. 待修复清单`。"),
        "overall": (r"^##\s*7\.\s+综合判断", "缺少 `## 7. 综合判断`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    target = section_text(body, r"^##\s*0\.\s+检查对象")
    facts = section_text(body, r"^##\s*1\.\s+事实层检查")
    style = section_text(body, r"^##\s*2\.\s+风格层检查")
    platform = section_text(body, r"^##\s*3\.\s+平台规则层检查")
    business = section_text(body, r"^##\s*4\.\s+商业闭环检查")
    resonance = section_text(body, r"^##\s*5\.\s+共鸣诊断")
    consistency = section_text(body, r"^##\s*(?:5\.\d+|8\.)\s+与\s*breakdown\s*方案一致性检查")
    assets_ready = section_text(body, r"^##\s*5\.2\s+(?:发布资产准备度检查|交付资产准备度检查|资产准备度检查|发布准备度检查)")
    fixes = section_text(body, r"^##\s*6\.\s+待修复清单")
    overall_section = section_text(body, r"^##\s*7\.\s+综合判断")

    draft_path = line_value(target, r"成稿路径|稿件路径|文件路径")
    platform_value = line_value(target, r"目标平台|目标阵地|平台")
    content_type = line_value(target, r"内容类型|类型")
    if not meaningful_value(draft_path, 4):
        blocking.append("检查对象缺少可追溯的成稿路径。")
    if not meaningful_value(platform_value, 2):
        blocking.append("检查对象缺少目标平台。")
    if not meaningful_value(content_type, 2):
        review.append("检查对象缺少内容类型，建议标明长文或图文。")

    layer_sections = {
        "facts": ("事实层", facts),
        "style": ("风格层", style),
        "platform": ("平台规则层", platform),
        "business": ("商业闭环层", business),
    }
    layer_counts: dict[str, dict[str, int]] = {}
    for key, (label, section) in layer_sections.items():
        row_count = table_or_list_rows(section)
        counts = status_counts(section)
        layer_counts[key] = {"rows": row_count, **counts}
        if row_count < 3:
            blocking.append(f"{label}检查项不足，至少需要 3 个可核对检查项。")
        if counts["pass"] + counts["warn"] + counts["block"] == 0:
            blocking.append(f"{label}没有明确状态标记，无法判断是否通过。")
        if counts["block"]:
            blocking.append(f"{label}仍存在阻断风险。")
        elif counts["warn"]:
            review.append(f"{label}仍有复核项，进入 audit 前需人工确认。")

    fix_open = checkbox_count(fixes, checked=False)
    fix_done = checkbox_count(fixes, checked=True)
    fix_total = checkbox_count(fixes, checked=None)
    fix_counts = status_counts(fixes)
    if fix_open > 0:
        blocking.append(f"待修复清单仍有 {fix_open} 项未完成。")
    if fix_total == 0 and any(counts["block"] or counts["warn"] for counts in layer_counts.values()):
        blocking.append("存在风险标记，但待修复清单没有对应 checkbox。")
    if fix_counts["block"]:
        blocking.append("待修复清单仍包含阻断风险描述。")

    resonance_terms = {
        "核心机制": ["核心机制", "真正的核心", "核心问题"],
        "沉默解除": ["沉默解除", "沉默的螺旋", "受众憋着"],
        "满足动机": ["满足动机", "使用与满足", "身份认同", "情绪宣泄", "社交资本", "信息价值"],
        "立场框架": ["立场框架", "框架理论", "站在"],
        "传播入口": ["传播入口", "两级传播", "第一批传播者"],
        "信念结构": ["信念结构", "认知一致", "确认了受众", "行动冲动"],
        "具体改法": ["删掉", "缩短为支撑细节", "强化", "保持不动", "改完之后"],
    }
    missing_resonance = [
        label for label, aliases in resonance_terms.items()
        if not any(re.search(re.escape(alias), resonance or "", re.IGNORECASE) for alias in aliases)
    ]
    if missing_resonance:
        blocking.append("共鸣诊断缺少关键维度：" + "、".join(missing_resonance) + "。")
    if "dbs-resonate" not in resonance and "/dbs-resonate" not in resonance:
        review.append("共鸣诊断建议标注来源为 `/dbs-resonate`，方便追溯成稿返修判断。")
    if len(resonance.strip()) < 100:
        blocking.append("共鸣诊断过薄，不能判断成稿是否真正打中受众。")
    if re.search(r"核心不明确|核心被稀释|无效|立场漂移|沉默解除弱", resonance or "") and fix_open == 0:
        blocking.append("共鸣诊断发现核心/立场/沉默解除问题，但待修复清单没有对应未完成修复项。")

    overall = extract_overall(overall_section)
    can_audit = overall["can_audit"]
    risk = overall["risk"]
    next_step = overall["next_step"]
    if not meaningful_value(can_audit, 1):
        blocking.append("综合判断缺少 `是否可以通过 content-audit`。")
    if re.search(r"是|可以|可进入|通过|可发布", can_audit or "") and blocking:
        blocking.append("综合判断允许进入下一步，但前文仍有阻断项，结论自相矛盾。")
    if re.search(r"否|不能|不通过|先修", can_audit or "") and not blocking:
        review.append("综合判断不允许进入下一步，但未列出阻断原因，请补充修复项。")
    if not meaningful_value(risk, 1):
        review.append("综合判断缺少风险等级。")
    elif re.search(r"高", risk) and re.search(r"是|可以|可发布|可进入", can_audit or ""):
        blocking.append("风险等级为高，却允许进入下一步。")
    if not meaningful_value(next_step, 3):
        blocking.append("综合判断缺少明确下一步命令或处理动作。")

    if consistency and table_or_list_rows(consistency) < 2:
        review.append("breakdown 一致性检查过薄，建议核对标题、开头、关键词和平台适配。")
    elif not consistency:
        review.append("未提供 breakdown 一致性检查；如有上游 brief，建议补充核对。")

    asset_counts = {"rows": table_or_list_rows(assets_ready), "pass": 0, "warn": 0, "block": 0}
    asset_missing_terms: list[str] = []
    asset_weak_pass_rows: list[str] = []
    if assets_ready:
        asset_counts = {"rows": table_or_list_rows(assets_ready), **status_counts(assets_ready)}
        asset_counts["block"] += len(ASSET_BLOCK_RE.findall(assets_ready or ""))
        asset_counts["warn"] += len(ASSET_REVIEW_RE.findall(assets_ready or ""))
        asset_weak_pass_rows = weak_pass_asset_rows(assets_ready)
        asset_counts["warn"] += len(asset_weak_pass_rows)
        if asset_counts["rows"] < 4:
            blocking.append("发布资产准备度检查过薄，至少需要成稿、视觉资产/封面、HTML/排版、质量报告/交付包四类状态。")
        required_asset_terms = {
            "成稿": ["成稿", "正文", "稿件"],
            "视觉资产": ["视觉", "封面", "配图", "pipeline/visual"],
            "HTML排版": ["HTML", "公众号HTML", "dbs-wechat-html", "排版"],
            "质量报告": ["quality", "质量报告", "quality-check", "验收报告"],
            "合规报告": ["compliance", "合规", "平台规则"],
            "交付包": ["delivery-pack", "交付包", "deliveries/", "zip"],
        }
        asset_missing_terms = [
            label for label, aliases in required_asset_terms.items()
            if not any(re.search(re.escape(alias), assets_ready, re.IGNORECASE) for alias in aliases)
        ]
        if asset_missing_terms:
            review.append("发布资产准备度检查建议补充：" + "、".join(asset_missing_terms) + "。")
        if asset_counts["block"]:
            blocking.append("发布资产准备度检查仍存在未生成、缺失或未打包资产。")
        elif asset_counts["warn"]:
            review.append("发布资产准备度检查仍有待复核资产，发布前需人工确认。")
        if asset_weak_pass_rows:
            review.append("发布资产准备度存在 PASS/✅ 但证据仍是目录、模板路径或未来动作，请改为具体已生成文件/报告路径，或降级为 ⚠️。")
    else:
        review.append("未提供 `## 5.2 发布资产准备度检查`，建议核对成稿、视觉资产、HTML 排版、质量报告、合规报告和交付包。")

    if re.search(r"是|可以|可进入|通过|可发布", can_audit or "") and assets_ready and asset_counts["block"]:
        blocking.append("发布资产仍有缺失或未生成，但综合判断允许进入下一步，结论自相矛盾。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "draft_path": draft_path,
            "target_platform": platform_value,
            "content_type": content_type,
            "layer_counts": layer_counts,
            "fix_open": fix_open,
            "fix_done": fix_done,
            "resonance_missing": missing_resonance,
            "asset_counts": asset_counts,
            "asset_missing_terms": asset_missing_terms,
            "asset_weak_pass_rows": asset_weak_pass_rows,
            "can_audit": can_audit,
            "risk": risk,
            "next_step": next_step,
        },
    }
