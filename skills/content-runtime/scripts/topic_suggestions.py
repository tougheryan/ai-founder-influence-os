#!/usr/bin/env python3
"""Build deterministic topic suggestions from one verified TikOmni snapshot.

This utility deliberately never calls TikOmni. It reads only the immutable
normalized sample file named by a verified per-run snapshot, then combines it
with the current intake and the session-scoped material analysis context.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from market_signal import (
    REQUIRED_MARKET_PLATFORMS,
    _best_mechanism,
    _coerce_signals,
    _material_evidence,
    _theme_audience,
    score_theme_option,
    verify_market_snapshot,
)
from generated_language_quality import inspect_generated_language


SUGGESTION_COUNT = 3
MATERIAL_CONTEXT_SCHEMA = "aifios.material-analysis.v1"
MAX_CONTEXT_CHARS = 30_000

# Topic suggestions are normally selected from the established theme library.
# These are the deliberately small exceptions that deserve a material-led
# direction even when they do not fit one of those libraries.  The values are
# not open-ended keywords: every visible title term below comes from this
# reviewable list, rather than from a free-form extract of the intake or a
# TikOmni sample.
MATERIAL_ANCHOR_RULES: tuple[dict[str, Any], ...] = (
    {
        "id": "law_firm",
        "label": "律所",
        "aliases": ("律师事务所", "律所", "law firm"),
    },
    {
        "id": "partner_governance",
        "label": "合伙人治理",
        "aliases": ("合伙人治理", "合伙人机制", "合伙人制", "合伙人管理"),
    },
    {
        "id": "founder",
        "label": "创始人",
        "aliases": ("创始人", "创办人", "founder"),
    },
    {
        "id": "content_production",
        "label": "内容创作",
        "aliases": ("内容创作", "写内容", "写作", "可发布文章", "公众号文章"),
    },
    {
        "id": "recovery_rebuild",
        "label": "恢复与重建",
        "aliases": ("恢复", "重建", "修复", "复原", "recovery", "rebuild"),
    },
    {
        "id": "content_acquisition",
        "label": "内容获客",
        "aliases": ("内容获客", "获客路径", "内容转化"),
    },
    {
        "id": "customer_problem",
        "label": "客户问题",
        "aliases": ("客户问题", "高频问题"),
    },
    {
        "id": "case_accumulation",
        "label": "案例整理",
        "aliases": ("案例整理", "案例沉淀", "沉淀可复用案例", "客户案例"),
    },
    {
        "id": "weekly_review",
        "label": "每周复盘",
        "aliases": ("每周复盘", "复盘转化反馈", "转化反馈"),
    },
)
MATERIAL_ANCHOR_NEGATION_RE = re.compile(
    r"(?:不讨论|不涉及|不谈|不做|不写|不聊|不是|并非|没有|没|无|未)"
    r"[^，。；;,.!?！？\n]{0,16}$",
    re.IGNORECASE,
)
LAW_FIRM_GOVERNANCE_ALIASES = (
    "律师事务所治理",
    "律所治理",
    "组织治理",
    "组织管理",
    "合伙人治理",
    "合伙人管理",
    "治理",
    "管理",
)

STRUCTURE_INTENTS = {
    "experience-turn-method": "经历转折与方法总结",
    "review-decision-principle": "问题复盘与关键判断",
    "judgement-case-action": "专业判断与行动建议",
    "difficulty-turn-choice": "具体困境与新选择",
    "pressure-repair-longterm": "自我修复与长期选择",
    "life-question-story-resonance": "个人经验与读者共鸣",
    "customer-solution-case-cta": "客户问题与解决路径",
    "business-product-conversion": "业务判断与策略路径",
    "growth-mistake-mechanism-list": "增长判断与行动清单",
}


def _safe_run_id(value: str) -> str:
    run_id = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}", run_id):
        raise ValueError("run ID 格式不正确")
    return run_id


def _project_file(project: Path, value: str) -> Path:
    relative = str(value or "").replace("\\", "/").lstrip("/")
    if not relative or ".." in relative.split("/"):
        raise ValueError("文件路径不合法")
    candidate = (project / relative).resolve(strict=False)
    try:
        candidate.relative_to(project.resolve(strict=False))
    except ValueError as exc:
        raise ValueError("文件路径超出项目范围") from exc
    if not candidate.is_file() or candidate.is_symlink():
        raise ValueError("文件不存在或不是普通文件")
    return candidate


def _compact(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] + ("..." if len(text) > limit else "")


def _string_list(value: Any, *, limit: int = 8, item_limit: int = 300) -> list[str]:
    if not isinstance(value, list):
        return []
    rows: list[str] = []
    for item in value:
        text = _compact(item, item_limit)
        if text and text not in rows:
            rows.append(text)
        if len(rows) >= limit:
            break
    return rows


def _material_context(project: Path, run_id: str) -> dict[str, Any]:
    """Read a narrow, non-persistent view of the current material context."""
    path = project / "sessions" / "material-analysis" / f"{run_id}.json"
    try:
        if not path.is_file() or path.is_symlink():
            return {}
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    if payload.get("schema") != MATERIAL_CONTEXT_SCHEMA or payload.get("runId") != run_id:
        return {}
    analysis = payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
    selection = payload.get("selection") if isinstance(payload.get("selection"), dict) else {}
    input_value = payload.get("input") if isinstance(payload.get("input"), dict) else {}
    links = input_value.get("links") if isinstance(input_value.get("links"), list) else []
    link_context: list[str] = []
    for item in links[:5]:
        if not isinstance(item, dict) or item.get("status") != "parsed":
            continue
        link_context.extend([_compact(item.get("title"), 300), _compact(item.get("excerpt"), 900)])
    return {
        "raw_material": _compact(input_value.get("rawMaterial"), 30_000),
        "summary": _compact(analysis.get("summary"), 5_000),
        "facts": _string_list(analysis.get("facts")),
        "cases": _string_list(analysis.get("cases")),
        "viewpoints": _string_list(analysis.get("viewpoints")),
        "selection": {
            "material_type_id": _compact(selection.get("materialTypeId"), 80),
            "structure_id": _compact(selection.get("structureId"), 120),
        },
        "link_context": [item for item in link_context if item],
    }


def _context_text(context: dict[str, Any]) -> str:
    values = [
        # The report summary is a model/template interpretation. It is useful
        # in the material panel, but must not seed a public topic direction.
        str(context.get("raw_material") or ""),
        *[str(item) for item in context.get("facts") or []],
        *[str(item) for item in context.get("cases") or []],
        *[str(item) for item in context.get("link_context") or []],
    ]
    return "\n".join(item for item in values if item)[:MAX_CONTEXT_CHARS]


def _material_anchor_corpus(material_text: str, context: dict[str, Any]) -> str:
    """Use only the user's original material and first-party evidence fields.

    Link excerpts are intentionally not used as topic anchors. They are useful
    reading aids, but an external reference should not silently become this
    period's first-party content claim.
    """
    values = [
        # ``material_text`` may be a generated intake report. Prefer the
        # captured user input so report boilerplate such as "恢复掌控感" cannot
        # become a content topic that the user never supplied.
        _content_corpus(str(context.get("raw_material") or material_text or "")),
        *[str(item) for item in context.get("facts") or []],
        *[str(item) for item in context.get("cases") or []],
    ]
    return "\n".join(item for item in values if item)[:MAX_CONTEXT_CHARS]


def _snapshot_signal_text(signals: list[Any]) -> str:
    """Return the non-identifying fields available in the verified snapshot."""
    rows: list[str] = []
    for signal in signals:
        rows.extend([
            str(getattr(signal, "query", "") or ""),
            str(getattr(signal, "title", "") or ""),
            str(getattr(signal, "hook", "") or ""),
            str(getattr(signal, "audience_pain", "") or ""),
            str(getattr(signal, "mechanism", "") or ""),
        ])
    return "\n".join(item for item in rows if item)[:MAX_CONTEXT_CHARS]


def _positive_anchor_aliases(text: str, aliases: tuple[str, ...]) -> list[str]:
    """Find direct, non-negated aliases without extracting arbitrary text."""
    lowered = str(text or "").lower()
    matches: list[str] = []
    for alias in aliases:
        normalized = str(alias or "").strip()
        if not normalized:
            continue
        for match in re.finditer(re.escape(normalized.lower()), lowered):
            prefix = lowered[max(0, match.start() - 24):match.start()]
            # Resource scarcity does not negate the subject: "没有时间写内容
            # 的创始人" still explicitly names both writing and founders.
            prefix = re.sub(r"(?:没有|没|无)(?:足够|充足)?时间", "时间不足", prefix)
            if MATERIAL_ANCHOR_NEGATION_RE.search(prefix):
                continue
            if normalized not in matches:
                matches.append(normalized)
            break
    return matches


def _law_firm_governance_supported(text: str, law_aliases: list[str]) -> list[str]:
    """Allow a governance term only when it is genuinely in a law-firm context.

    Words such as ``管理`` are intentionally too broad to become an anchor on
    their own. They qualify only when they occur in the same paragraph and
    close to an already-supported law-firm alias in the verified material.
    """
    lowered = str(text or "").lower()
    governance_aliases = _positive_anchor_aliases(lowered, LAW_FIRM_GOVERNANCE_ALIASES)
    if not law_aliases or not governance_aliases:
        return []
    for law_alias in law_aliases:
        for law_match in re.finditer(re.escape(law_alias.lower()), lowered):
            paragraph_start = lowered.rfind("\n\n", 0, law_match.start()) + 2
            paragraph_end = lowered.find("\n\n", law_match.end())
            if paragraph_end == -1:
                paragraph_end = len(lowered)
            paragraph = lowered[paragraph_start:paragraph_end]
            law_start = law_match.start() - paragraph_start
            for governance_alias in governance_aliases:
                for governance_match in re.finditer(re.escape(governance_alias.lower()), paragraph):
                    if abs(governance_match.start() - law_start) <= 180:
                        return governance_aliases
    return []


def _anchor_display(rule: dict[str, Any], material_aliases: list[str]) -> str:
    """Choose a safe visible term from the whitelist, never from raw text."""
    anchor_id = str(rule.get("id") or "")
    if anchor_id == "case_accumulation":
        return str(rule.get("label") or "案例整理")
    if anchor_id == "recovery_rebuild":
        lowered = {item.lower() for item in material_aliases}
        recovery_terms = {"恢复", "修复", "复原", "recovery"}
        rebuild_terms = {"重建", "rebuild"}
        if lowered.intersection(recovery_terms) and lowered.intersection(rebuild_terms):
            return "恢复与重建"
    return material_aliases[0] if material_aliases else str(rule.get("label") or "")


def _extract_material_anchors(
    *,
    material_text: str,
    context: dict[str, Any],
    signals: list[Any],
) -> dict[str, dict[str, Any]]:
    """Collect a minimal, explainable set of supported material anchors.

    A snapshot can reinforce an anchor, but it cannot introduce a topic term
    absent from the verified material. That keeps every candidate tied to this
    period's actual intake rather than a popular-but-unrelated sample.
    """
    material_corpus = _material_anchor_corpus(material_text, context)
    snapshot_corpus = _snapshot_signal_text(signals)
    anchors: dict[str, dict[str, Any]] = {}
    for rule in MATERIAL_ANCHOR_RULES:
        anchor_id = str(rule["id"])
        aliases = tuple(str(item) for item in rule["aliases"])
        material_aliases = _positive_anchor_aliases(material_corpus, aliases)
        snapshot_aliases = _positive_anchor_aliases(snapshot_corpus, aliases)
        if not material_aliases:
            continue
        anchors[anchor_id] = {
            "id": anchor_id,
            "display": _anchor_display(rule, material_aliases),
            "material_aliases": material_aliases,
            "snapshot_supported": bool(snapshot_aliases),
        }
    law_firm = anchors.get("law_firm")
    if law_firm:
        material_governance = _law_firm_governance_supported(
            material_corpus,
            list(law_firm.get("material_aliases") or []),
        )
        snapshot_law = _positive_anchor_aliases(
            snapshot_corpus,
            tuple(str(item) for item in MATERIAL_ANCHOR_RULES[0]["aliases"]),
        )
        snapshot_governance = _law_firm_governance_supported(snapshot_corpus, snapshot_law)
        if material_governance:
            anchors["law_firm_governance"] = {
                "id": "law_firm_governance",
                "display": "律所治理",
                "material_aliases": [*law_firm.get("material_aliases", []), *material_governance],
                "snapshot_supported": bool(snapshot_governance),
            }
    return anchors


def _material_anchor_evidence(anchors: dict[str, dict[str, Any]]) -> str:
    ordered = [
        str(anchors[key].get("display") or "")
        for key in (
            "law_firm", "law_firm_governance", "partner_governance", "founder", "recovery_rebuild",
            "content_production", "content_acquisition", "customer_problem", "case_accumulation", "weekly_review",
        )
        if key in anchors and str(anchors[key].get("display") or "")
    ]
    if not ordered:
        return ""
    snapshot_supported = [
        str(anchors[key].get("display") or "")
        for key in (
            "law_firm", "law_firm_governance", "partner_governance", "founder", "recovery_rebuild",
            "content_production", "content_acquisition", "customer_problem", "case_accumulation", "weekly_review",
        )
        if key in anchors and anchors[key].get("snapshot_supported")
    ]
    evidence = f"素材锚点：{'、'.join(ordered)}"
    if snapshot_supported:
        evidence += f"；TikOmni 快照同样出现：{'、'.join(snapshot_supported)}"
    return evidence


def _direction_style(direction: dict[str, Any]) -> str:
    material_type = str(direction.get("material_type_id") or "")
    structure_id = str(direction.get("structure_id") or "")
    if material_type == "personal-growth" or structure_id in {
        "difficulty-turn-choice", "pressure-repair-longterm", "life-question-story-resonance",
    }:
        return "recovery"
    if material_type == "business-growth" or structure_id in {
        "customer-solution-case-cta", "business-product-conversion", "growth-mistake-mechanism-list",
    }:
        return "business"
    if material_type == "personal-experience" or structure_id in {
        "experience-turn-method", "review-decision-principle", "judgement-case-action",
    }:
        return "experience"
    return "balanced"


def _title_repeats_material_anchor(title: str, anchors: dict[str, dict[str, Any]]) -> bool:
    """Reject titles such as ``重建：重建`` before they reach the operator."""
    lowered = str(title or "").lower()
    aliases: set[str] = set()
    for anchor in anchors.values():
        for alias in anchor.get("material_aliases") or []:
            value = str(alias or "").strip().lower()
            if len(value) >= 2:
                aliases.add(value)
    return any(lowered.count(alias) > 1 for alias in aliases)


def _generic_anchored_titles(anchors: dict[str, dict[str, Any]]) -> list[str]:
    labels: list[str] = []
    # ``律所治理`` already carries the law-firm context, so do not add a
    # second bare ``律所`` token to the same fallback title.
    keys = ("law_firm_governance", "partner_governance", "founder", "recovery_rebuild")
    if "law_firm_governance" not in anchors:
        keys = ("law_firm", *keys)
    for key in keys:
        label = str(anchors.get(key, {}).get("display") or "")
        if label and label not in labels:
            labels.append(label)
    anchor_line = "、".join(labels)
    if not anchor_line:
        return []
    return [
        f"围绕{anchor_line}，本期最值得先回答什么？",
        f"从{anchor_line}出发，怎样讲清一个关键问题？",
        f"{anchor_line}之间，哪些判断需要重新讨论？",
        f"把{anchor_line}放在一起，先看清什么？",
        f"面对{anchor_line}，应该先提出哪一个问题？",
        f"{anchor_line}，如何形成一条有边界的判断？",
    ]


def _law_firm_recovery_titles(style: str, anchors: dict[str, dict[str, Any]]) -> list[str]:
    """Use distinct, question-led skeletons for the verified law-firm profile."""
    governance = str(anchors.get("law_firm_governance", {}).get("display") or "律所治理")
    founder = str(anchors.get("founder", {}).get("display") or "创始人")
    recovery = str(anchors.get("recovery_rebuild", {}).get("display") or "恢复与重建")
    if style == "business":
        return [
            f"{governance}中的{founder}：{recovery}阶段该先判断什么？",
            f"{recovery}发生时，{founder}如何重新安排{governance}？",
            f"面对{governance}，{founder}该怎样把{recovery}纳入判断？",
            f"{recovery}与{governance}：{founder}需要先讲清哪一层问题？",
            f"{founder}如何在{recovery}阶段重新理解{governance}？",
            f"{governance}的{founder}角色：{recovery}期间该怎样安排？",
        ]
    if style == "experience":
        return [
            f"从{recovery}出发，{founder}如何重新理解{governance}？",
            f"{governance}中的{founder}：{recovery}带来了什么新问题？",
            f"面对{recovery}，{founder}该怎样重新讨论{governance}？",
            f"{recovery}与{governance}：{founder}需要重新判断什么？",
            f"{founder}如何把{recovery}写成关于{governance}的真实经验？",
            f"{governance}的创始人视角：{recovery}该怎样被讲清？",
        ]
    # Personal-growth structures use the recovery process as the narrative
    # entry, while keeping the organisational question explicit.
    return [
        f"{governance}中的{founder}：{recovery}该从哪里重新展开？",
        f"从恢复到重建，{founder}如何重新理解{governance}？",
        f"当{founder}进入{recovery}阶段，{governance}要先回答什么问题？",
        f"{recovery}与{governance}：{founder}为什么值得把两者放在一起讨论？",
        f"面对{recovery}，{founder}如何把{governance}讲清楚？",
        f"{governance}的{founder}角色：{recovery}期间该怎样重新安排？",
    ]


def _content_acquisition_titles(anchors: dict[str, dict[str, Any]]) -> list[str]:
    """Use controlled, business-specific skeletons for content-led acquisition."""
    acquisition = str(anchors.get("content_acquisition", {}).get("display") or "内容获客")
    problem = str(anchors.get("customer_problem", {}).get("display") or "客户问题")
    cases = str(anchors.get("case_accumulation", {}).get("display") or "案例整理")
    review = str(anchors.get("weekly_review", {}).get("display") or "每周复盘")
    return [
        f"{acquisition}为什么不能只剩下发布任务？",
        f"先识别{problem}，再决定内容该怎么写",
        f"{cases}如何从一次服务过程里被留下来？",
        f"{review}转化反馈，该看哪些可验证动作？",
        f"把{acquisition}拆成动作：{problem}、{cases}与{review}",
        f"团队没有{cases}时，{acquisition}的问题常出在哪一步？",
    ]


def _anchored_titles(style: str, anchors: dict[str, dict[str, Any]]) -> list[str]:
    """Produce material-led titles without repeating a matched anchor."""
    has_law_firm_profile = all(
        key in anchors for key in ("law_firm", "law_firm_governance", "founder", "recovery_rebuild")
    )
    if has_law_firm_profile:
        titles = _law_firm_recovery_titles(style, anchors)
    elif "content_acquisition" in anchors and (
        "customer_problem" in anchors or "case_accumulation" in anchors or "weekly_review" in anchors
    ):
        titles = _content_acquisition_titles(anchors)
    elif "founder" in anchors and "content_production" in anchors:
        titles = [
            "创始人写内容，发布前需要确认哪些事实？",
            "从原始素材到成稿，创始人需要保留哪些判断？",
            "创始人怎样判断一篇文章是否表达了自己的观点？",
            "创始人时间有限，怎样缩小一次内容创作的范围？",
            "创始人检查成稿时，哪些修改应该优先处理？",
            "创始人的内容创作，怎样从一份可核对的素材开始？",
        ]
    else:
        titles = _generic_anchored_titles(anchors)
    return [title for title in titles if not _title_repeats_material_anchor(title, anchors)]


def _anchored_audience(anchors: dict[str, dict[str, Any]]) -> str:
    if "law_firm" in anchors and ("law_firm_governance" in anchors or "partner_governance" in anchors):
        return "律所创始人 / 合伙人 / 专业服务机构管理者"
    if "founder" in anchors and "recovery_rebuild" in anchors:
        return "处在组织转折期的创始人 / 合伙人"
    return "需要把真实经历写成专业判断的创始人或内容负责人"


def _anchored_mechanism(style: str) -> str:
    return {
        "recovery": "案例叙事",
        "business": "方法论清单",
        "experience": "案例叙事",
        "balanced": "痛点开头",
    }.get(style, "痛点开头")


def _material_anchored_candidates(
    *,
    material_text: str,
    context: dict[str, Any],
    signals: list[Any],
) -> list[dict[str, Any]]:
    direction = context.get("selection") if isinstance(context.get("selection"), dict) else {}
    if not str(direction.get("material_type_id") or "") or not str(direction.get("structure_id") or ""):
        return []
    anchors = _extract_material_anchors(material_text=material_text, context=context, signals=signals)
    # One broad noun is not enough to displace the existing, tested theme
    # libraries. Two direct terms make the direction both specific and easy
    # for an operator to audit in the material panel.
    if len(anchors) < 2:
        return []

    style = _direction_style(direction)
    evidence = _material_anchor_evidence(anchors)
    if not evidence:
        return []
    structure_id = str(direction.get("structure_id") or "")
    structure_intent = STRUCTURE_INTENTS.get(structure_id, "已确认的行文结构")
    keywords = [
        str(anchors[key].get("display") or "")
        for key in (
            "law_firm", "law_firm_governance", "partner_governance", "founder", "recovery_rebuild",
            "content_production", "content_acquisition", "customer_problem", "case_accumulation", "weekly_review",
        )
        if key in anchors and str(anchors[key].get("display") or "")
    ]
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw_title in enumerate(_anchored_titles(style, anchors), start=1):
        title = _compact(raw_title, 120)
        if not title or title in seen:
            continue
        seen.add(title)
        result.append({
            "title": title,
            "keywords": keywords,
            "reason": f"按已确认的{structure_intent}组织，只围绕{evidence.replace('素材锚点：', '').split('；', 1)[0]}展开。",
            "audience": _anchored_audience(anchors),
            "risk": "不补写病情、个人身份、组织内部细节、因果关系或结果。",
            "platforms": ["公众号", "小红书"],
            "mechanism": _anchored_mechanism(style),
            "material_evidence": evidence,
            "material_anchored": True,
            "anchor_rank": index,
        })
        if len(result) >= SUGGESTION_COUNT:
            break
    return result


def _content_sentences(text: str) -> list[tuple[str, bool]]:
    """Separate publication instructions from actual source claims.

    These are extractive directions, not invented case studies. Preserve whole
    statements (including negation); never clip half a claim to fit a title.
    """
    text = re.sub(r"【[^】]*(?:模拟素材|测试素材|产品体验用)[^】]*】", "", text)
    result: list[tuple[str, bool]] = []
    for raw in re.split(r"[。！？\n]+", text):
        row = raw.strip(" \t-#")
        labelled = bool(re.match(r"(?:我的)?(?:观点|做法|判断|经验|建议|方法)[：:]", row))
        if re.match(r"(?:要求[：:]|结尾|语气|篇幅|禁写|公开边界|写作限制|目标读者|期望交付|这次只想|本次只想|不引导|不能编造|不要[“\"])" , row):
            continue
        if re.search(r"(?:不得对外|不是真实客户案例|不能公开|不要公开|不得公开|请勿公开|不可公开|禁止公开)", row):
            continue
        row = re.sub(r"^(?:我的)?(?:观点|做法|判断|经验|建议|方法)[：:]\s*", "", row)
        if row.startswith("我希望读者记住："):
            row = row.removeprefix("我希望读者记住：")
        if len(row) >= 8 and not re.match(r"(?:schema|run_id|source|created|status|step)[：:]", row):
            result.append((row, labelled))
    return result


def _content_corpus(text: str) -> str:
    return "。\n".join(row for row, _ in _content_sentences(text))


def _direct_material_candidates(material_text: str, context: dict[str, Any]) -> list[dict[str, Any]]:
    raw = str(context.get("raw_material") or material_text or "")
    sentences = _content_sentences(raw)
    # Explicit author judgements and methods outrank biographical background.
    labelled = [(row, True) for row, marked in sentences if marked]
    rows = labelled or sentences
    audience_match = re.search(r"(?:写给|目标读者(?:是|为|[：:]))([^，。；\n]{2,60})", raw)
    audience = audience_match.group(1).strip() if audience_match else "关心这段经历或方法的读者（请核对）"
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row, _ in rows:
        if len(row) > 100 or row in seen:
            continue
        seen.add(row)
        title = row
        clauses = re.split(r"[，；;]", row)
        if len(clauses) > 2 and clauses[0].endswith("时") and clauses[-1].startswith("先"):
            title = f"{clauses[0]}，{clauses[-1]}"
        elif "；" in row and len(row.split("；", 1)[0]) >= 8:
            title = row.split("；", 1)[0]
        result.append({
            "title": title,
            "reason": "直接保留原文中的判断或做法，可以改成你自己的标题。",
            "audience": audience,
            "material_evidence": f"原文：{row}",
            "keywords": [],
            "risk": "不补写原文没有的客户经历、数字或效果。",
            "platforms": ["公众号", "小红书"],
            "mechanism": "作者观点与具体做法",
            "anchor_rank": len(result) + 1,
        })
        if len(result) == SUGGESTION_COUNT:
            break
    return result


def build_snapshot_topic_suggestions(
    *,
    material_text: str,
    signals: list[dict[str, Any]],
    queries: list[str],
    material_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return up to three supported directions, without padding or new requests."""
    context = material_context or {}
    combined_material = _content_corpus(str(context.get("raw_material") or material_text))
    coerced_signals = _coerce_signals(signals)
    material_candidates = _material_anchored_candidates(
        material_text=material_text,
        context=context,
        signals=coerced_signals,
    )
    # Known profiles remain material-bound; all other input uses actual author
    # statements. Broad theme libraries and unrelated search queries cannot
    # manufacture extra choices when the material supports fewer directions.
    candidates = material_candidates or _direct_material_candidates(material_text, context)

    ranked: list[tuple[dict[str, Any], dict[str, Any], str]] = []
    seen_titles: set[str] = set()
    for theme in candidates:
        title = _compact(theme.get("title"), 120)
        if not title or title in seen_titles:
            continue
        seen_titles.add(title)
        score = score_theme_option(
            title,
            combined_material,
            coerced_signals,
            list(REQUIRED_MARKET_PLATFORMS),
            realtime_available=bool(coerced_signals),
        )
        mechanism = _compact(_best_mechanism(theme, coerced_signals) or str(theme.get("mechanism") or ""), 80)
        ranked.append((theme, score, mechanism))

    ranked.sort(key=lambda item: (
        int(item[0].get("anchor_rank") or SUGGESTION_COUNT + 1),
        -int(item[1].get("total") or 0),
        _compact(item[0].get("title"), 120),
    ))

    direction = context.get("selection") if isinstance(context.get("selection"), dict) else {}
    result: list[dict[str, Any]] = []
    for index, (theme, score, mechanism) in enumerate(ranked[:SUGGESTION_COUNT], start=1):
        title = _compact(theme.get("title"), 120)
        result.append({
            "id": f"topic-{index}",
            "title": title,
            "reason": _compact(theme.get("reason"), 220),
            "audience": _compact(theme.get("audience") or _theme_audience(theme, combined_material), 140),
            "score": int(score.get("total") or 0),
            "market_mechanism": mechanism or "痛点开头",
            "material_evidence": _compact(
                theme.get("material_evidence") or _material_evidence(theme, combined_material),
                180,
            ),
            "risk": _compact(theme.get("risk"), 180),
            "material_type_id": _compact(direction.get("material_type_id"), 80),
            "structure_id": _compact(direction.get("structure_id"), 120),
        })
    quality_text = "\n".join(
        str(item.get(key) or "")
        for item in result
        for key in ("title", "reason", "audience", "risk")
    )
    quality = inspect_generated_language(quality_text)
    if quality["blocking"]:
        raise ValueError("选题建议里还有敏感信息或未完成内容，本次结果没有保存")
    return result


def load_verified_snapshot_suggestions(
    *,
    project: Path | str,
    run_id: str,
    snapshot_path: str,
    snapshot_sha256: str,
    source_path: str,
) -> dict[str, Any]:
    root = Path(project).expanduser().resolve(strict=False)
    selected_run_id = _safe_run_id(run_id)
    verification = verify_market_snapshot(root, selected_run_id, snapshot_path)
    if not verification.get("verified"):
        raise ValueError(f"TikOmni 研究快照校验未通过：{verification.get('reason') or '未知错误'}")
    bound_source = str(verification.get("source_path") or "")
    verified_digest = str(verification.get("snapshot_sha256") or "").lower()
    if not re.fullmatch(r"[a-f0-9]{64}", str(snapshot_sha256 or "").lower()) or verified_digest != str(snapshot_sha256).lower():
        raise ValueError("主题建议绑定的 TikOmni 快照摘要与当前存档不一致")
    if bound_source != source_path:
        raise ValueError("主题建议只能读取当前快照绑定的 intake 素材")

    manifest_file = _project_file(root, str(verification.get("manifest_path") or ""))
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("TikOmni 研究快照清单不可读取")
    normalized_file = _project_file(root, str(manifest.get("normalized_path") or ""))
    normalized = json.loads(normalized_file.read_text(encoding="utf-8"))
    if not isinstance(normalized, dict) or not isinstance(normalized.get("signals"), list):
        raise ValueError("TikOmni 研究快照缺少规范化样本")

    source_file = _project_file(root, bound_source)
    context = _material_context(root, selected_run_id)
    material_text = str(context.get("raw_material") or "").strip()
    if not material_text:
        # Older projects may predate the stored raw material field. The
        # verified intake remains a conservative compatibility fallback.
        material_text = source_file.read_text(encoding="utf-8", errors="ignore")[:60_000]
    suggestions = build_snapshot_topic_suggestions(
        material_text=material_text,
        signals=[item for item in normalized.get("signals") or [] if isinstance(item, dict)],
        queries=[str(item) for item in manifest.get("queries") or []],
        material_context=context,
    )
    return {
        "ok": True,
        "run_id": selected_run_id,
        "snapshot_path": str(verification.get("manifest_path") or ""),
        "snapshot_sha256": str(verification.get("snapshot_sha256") or ""),
        "source_path": bound_source,
        "suggestion_count": len(suggestions),
        "suggestions": suggestions,
        "material_direction": context.get("selection") or {},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build up to three material-supported topic suggestions from a verified TikOmni snapshot")
    parser.add_argument("--project", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--snapshot-sha256", required=True)
    parser.add_argument("--source", required=True)
    args = parser.parse_args()
    try:
        result = load_verified_snapshot_suggestions(
            project=args.project,
            run_id=args.run_id,
            snapshot_path=args.snapshot,
            snapshot_sha256=args.snapshot_sha256,
            source_path=args.source,
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
