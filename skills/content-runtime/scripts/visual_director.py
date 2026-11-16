#!/usr/bin/env python3
"""Deterministic topic and evidence routing for AIFI-OS visual assets."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

from visual_quality import native_page_evidence


_REVISION_ID_RE = re.compile(r"r[0-9]{3,}$")
_SAFE_SLUG_RE = re.compile(r"[A-Za-z0-9\u4e00-\u9fff-]{1,80}$")
_CONTENT_ARCHETYPES = {
    "tutorial",
    "analysis",
    "founder_story",
    "concept",
    "product_demo",
    "research",
    "campaign",
}
_EVIDENCE_MODES = {
    "screenshot_first",
    "data_first",
    "artifact_first",
    "illustration_allowed",
    "hybrid",
}
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_SCREENSHOT_TYPES = {"screenshot", "ui_screenshot", "screen_capture", "product_ui"}
_RESEARCH_DATA_TYPES = {"dataset", "data", "data_table", "survey", "benchmark"}
_RESEARCH_DOCUMENT_TYPES = {"report", "document", "research_source"}
_DATA_EXTENSIONS = {".csv", ".tsv", ".json"}
_DOCUMENT_EXTENSIONS = {".md", ".txt"}
_MATERIAL_PATH_RE = re.compile(r"materials/[^\s|\"'`<>，。；：！？（）【】]+")
_MD2WECHAT_THEME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_COVER_STRATEGIES = {
    "evidence_led",
    "data_led",
    "editorial_quote",
    "typographic_judgment",
    "structured_metaphor",
}
_COVER_DIRECTIONS = {
    "editorial_typography",
    "authorized_real_scene",
    "conceptual_visual",
}
_SHARE_FORMATS = {"contrast", "framework", "story"}
_INLINE_STRUCTURES = {"inline-contrast", "inline-steps", "inline-story", "inline-insight"}
_BRAND_COLOR_KEYS = {
    "paper",
    "paper_2",
    "ink",
    "muted",
    "line",
    "grey_1",
    "grey_2",
    "grey_3",
    "accent",
    "accent_soft",
    "accent_on",
}
_HEX_COLOR_RE = re.compile(r"#[0-9A-Fa-f]{6}$")
_VISUAL_MODES = {"ai_enhanced", "stable"}

# Legacy packages may contain three deliberately different P1-P5 share posts.
# Keep their old recipes readable; native XHS tasks use their own P1-P8 recipe.
_SHARE_RECIPES = {
    "contrast": {"system": "swiss", "page_recipes": ["S01", "S09", "S06", "S10", "S12"]},
    "framework": {"system": "swiss", "page_recipes": ["S01", "S10", "S06", "S08", "S12"]},
    "story": {"system": "editorial", "page_recipes": ["M01", "M03", "M08", "M11", "M15"]},
}
_MOMENTS_PAGE_NUMBERS = (1, 3, 5)
_MOMENTS_UPLOAD_MODE = "square_triptych"
_NARRATIVE_STAGES = {
    "contrast": [
        ("hook", "先看问题", "用一句反差判断建立阅读动机"),
        ("tension", "旧做法", "呈现用户熟悉但无效的旧路径"),
        ("reframe", "换个判断", "给出内容的核心认知转折"),
        ("proof", "怎么验证", "用证据、清单或边界把判断落地"),
        ("action", "轮到你", "给出低压力的自检或评论动作"),
    ],
    "framework": [
        ("promise", "先看方法", "先说明方法解决的具体问题"),
        ("principle", "第一步", "建立方法成立的首要原则"),
        ("method", "第二步", "展开最关键的执行动作"),
        ("application", "第三步", "把方法放回真实使用场景"),
        ("action", "现在自检", "给出能立刻完成的检查动作"),
    ],
    "story": [
        ("scene", "事情发生时", "用可感知的现场细节进入故事"),
        ("conflict", "真正的冲突", "呈现人物当时面对的阻力"),
        ("turning_point", "转折出现", "展示判断或行动如何发生变化"),
        ("boundary", "后来怎么做", "说明变化后的动作和边界"),
        ("reflection", "留下什么", "把案例沉淀成可复用的观察"),
    ],
}


class VisualDirectorError(ValueError):
    """Raised when source content cannot support a publishable visual recipe."""


def _selected_brand_profile(brand_profiles: dict[str, Any]) -> dict[str, Any]:
    """Prefer the product's fixed identity while keeping legacy test profiles valid."""
    profile = brand_profiles.get("echo_founder") or brand_profiles.get("adaptive")
    if not isinstance(profile, dict):
        profile = next((item for item in brand_profiles.values() if isinstance(item, dict)), None)
    if not isinstance(profile, dict):
        raise VisualDirectorError("missing visual brand profile")
    return profile


def _brand_system(profile: dict[str, Any]) -> dict[str, Any]:
    tokens = profile.get("tokens") if isinstance(profile.get("tokens"), dict) else {}
    colors = tokens.get("colors") if isinstance(tokens.get("colors"), dict) else {}
    typography = tokens.get("typography") if isinstance(tokens.get("typography"), dict) else {}
    composition = tokens.get("composition") if isinstance(tokens.get("composition"), dict) else {}
    if not colors:
        return {}
    return {
        "name": str(profile.get("name") or "adaptive"),
        "version": str(profile.get("version") or "legacy"),
        "tokens": {
            "colors": dict(colors),
            "typography": dict(typography),
            "composition": dict(composition),
        },
        "principles": [str(item) for item in profile.get("principles", []) if str(item).strip()],
    }


def _cover_scorecard(profile: dict[str, Any]) -> dict[str, Any]:
    value = profile.get("cover_scorecard") if isinstance(profile.get("cover_scorecard"), dict) else {}
    if not value:
        return {}
    return {
        **value,
        "criteria": [dict(item) for item in value.get("criteria", []) if isinstance(item, dict)],
    }


def _visual_preferences(value: dict[str, Any] | None) -> dict[str, Any]:
    supplied = value if isinstance(value, dict) else {}
    # Direct library calls without a run contract stay deterministic for
    # compatibility. AI enhanced stays explicit until the paid benchmark,
    # three real-account runs and frozen-DMG acceptance all pass.
    mode = str(supplied.get("mode") or "stable")
    if mode not in _VISUAL_MODES:
        raise VisualDirectorError("visual mode must be ai_enhanced or stable")
    if int(supplied.get("direction_count") or 2) != 2:
        raise VisualDirectorError("visual direction_count must be 2")
    if str(supplied.get("provider_policy") or "auto") != "auto":
        raise VisualDirectorError("visual provider_policy must be auto")
    return {"mode": mode, "direction_count": 2, "provider_policy": "auto"}


def _art_directions(archetype: str, brand_system: dict[str, Any]) -> list[dict[str, Any]]:
    colors = dict(((brand_system.get("tokens") or {}).get("colors") or {}))
    primary_composition = "evidence-led editorial grid" if archetype in {"research", "analysis", "product_demo"} else "narrative editorial grid"
    return [
        {
            "id": "direction-a",
            "label": "品牌叙事",
            "style_tokens": ["editorial", "restrained", "high-legibility"],
            "palette": colors,
            "composition": primary_composition,
            "negative_rules": ["no generated readable text", "no fabricated evidence", "no logo or watermark"],
        },
        {
            "id": "direction-b",
            "label": "概念场景",
            "style_tokens": ["conceptual", "cinematic-spacing", "single-accent"],
            "palette": colors,
            "composition": "asymmetric concept-led composition with deterministic text zones",
            "negative_rules": ["no generated readable text", "no fake interface", "no fabricated data", "no logo or watermark"],
        },
    ]


def _annotate_v2_assets(
    assets: list[dict[str, Any]],
    preferences: dict[str, Any],
    selected_direction: str,
) -> list[dict[str, Any]]:
    annotated: list[dict[str, Any]] = []
    for asset in assets:
        item = dict(asset)
        copy = item.get("copy") if isinstance(item.get("copy"), dict) else {}
        expected_text = " ".join(
            str(copy.get(field) or "").strip() for field in ("headline", "supporting") if str(copy.get(field) or "").strip()
        )
        if item.get("id") == "wechat-html":
            # The approved article is the authorized source; this output is a
            # deterministic document transform, not a generated concept image.
            source_type = "authorized_source"
        elif item.get("role") == "evidence" or item.get("source"):
            source_type = "evidence" if item.get("role") == "evidence" else "authorized_source"
        else:
            source_type = "ai_concept"
        item.update({
            "source_type": source_type,
            "consistency_group": "wechat-article" if item.get("platform") == "wechat" else "xhs-post-01",
            "art_direction_id": selected_direction,
            "text_overlay": {"renderer": "html-playwright", "expected_text": expected_text},
            "generation": {
                "provider_policy": preferences["provider_policy"],
                "provider_task": str(item.get("renderer") or "local"),
                "prompt_hash": "",
                "reference_asset_ids": [str(item.get("source"))] if item.get("source") else [],
            },
        })
        annotated.append(item)
    return annotated


def _five_stage_index(page_number: int, page_count: int) -> int:
    if page_count <= 5:
        return max(0, min(4, page_number - 1))
    # Preserve opening and closing roles while distributing a longer native
    # Xiaohongshu carousel across the three middle narrative stages.
    return round((page_number - 1) * 4 / max(1, page_count - 1))


def _narrative_stage(share_format: str, page_number: int, page_count: int = 5) -> dict[str, str]:
    key, label, goal = _NARRATIVE_STAGES.get(share_format, _NARRATIVE_STAGES["contrast"])[
        _five_stage_index(page_number, page_count)
    ]
    return {"key": key, "label": label, "goal": goal}


def _is_safe_project_relative_path(value: Any) -> bool:
    """Return whether a recipe path is an unambiguous local project path."""
    if not isinstance(value, str) or not value or value != value.strip():
        return False
    if "\\" in value or "\x00" in value or any(ord(char) < 32 for char in value):
        return False
    if value.startswith(("/", "~")) or re.match(r"^[A-Za-z]:", value):
        return False
    parts = value.split("/")
    return bool(parts) and all(part not in {"", ".", ".."} for part in parts)


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(_text(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_text(item) for item in value)
    return ""


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _sentence_fragments(value: Any, limit: int = 4) -> list[str]:
    fragments = [
        _clean_text(part).strip("-• ")
        for part in re.split(r"[。！？；;\n]", _clean_text(value))
        if _clean_text(part).strip("-• ")
    ]
    return [fragment[:72] for fragment in fragments[:limit]]


def _article_sections(package: dict[str, Any]) -> list[dict[str, str]]:
    """Extract reader-facing section anchors for semantic inline visuals."""
    wechat = package.get("wechat") if isinstance(package.get("wechat"), dict) else {}
    body = str(wechat.get("body") or "")
    matches = list(re.finditer(r"(?m)^#{3,6}\s+(.+?)\s*$", body))
    sections: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        heading = _clean_text(match.group(1))
        if not heading:
            continue
        next_start = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        content = _clean_text(body[match.end():next_start])
        if content:
            sections.append({"heading": heading[:48], "body": content[:240]})
    if sections:
        return sections

    fallback = _clean_text(body)
    if fallback:
        return [{"heading": "核心判断", "body": fallback[:240]}]
    return []


def _inline_structure(section: dict[str, str]) -> str:
    signal = _text(section)
    if any(token in signal for token in ("不是", "而是", "对比", "误区", "旧做法", "新做法")):
        return "inline-contrast"
    if any(token in signal for token in ("步骤", "先", "再", "最后", "流程", "方法", "清单")):
        return "inline-steps"
    if any(token in signal for token in ("现场", "客户", "第一次", "那天", "故事", "复盘", "冲突")):
        return "inline-story"
    return "inline-insight"


def _semantic_inline_assets(
    package: dict[str, Any],
    archetype: str,
    source: str,
) -> list[dict[str, Any]]:
    """Plan concrete section-bound visuals instead of a generic article poster.

    The local infographic renderer keeps the default path publishable without
    an image-generation credential or an extra desktop runtime. A concept
    raster is an explicit enhancement, never an implicit dependency of the
    normal platform-native delivery path.
    """
    sections = _article_sections(package)
    if not sections:
        return []
    target_count = 3 if len(sections) >= 3 else (2 if len(sections) >= 2 or len(_text(sections)) >= 100 else 1)
    planned: list[dict[str, Any]] = []
    for index, section in enumerate(sections[:target_count], start=1):
        structure = _inline_structure(section)
        renderer = "baoyu-infographic"
        role = "inline_visual"
        layout_recipe = structure
        item_source = ""
        if archetype == "research" and index == 1 and source:
            renderer = "baoyu-diagram"
            role = "diagram"
            layout_recipe = "evidence-diagram"
            item_source = source
        elif archetype == "concept" and index == 1 and package.get("enable_ai_raster_illustrations") is True:
            renderer = "ian-xiaohei-illustrations"
            role = "illustration"
            layout_recipe = "inline-illustration"

        caption_prefix = "概念图解（非事实证据）" if renderer == "ian-xiaohei-illustrations" else "图解"
        item: dict[str, Any] = {
            "id": f"inline-{index:02d}",
            "platform": "wechat",
            "role": role,
            "layout_recipe": layout_recipe,
            "renderer": renderer,
            "status": "planned",
            "insert_after": section["heading"],
            "caption": f"{caption_prefix}：{section['heading']}",
            "semantic_brief": f"{section['heading']}：{section['body'][:120]}",
            "inline_order": index,
            "inline_structure": structure,
        }
        if item_source:
            item["source"] = item_source
        planned.append(item)
    return planned


def _layout_selection(
    package: dict[str, Any],
    archetype: str,
    selected_template: str | None = None,
) -> dict[str, Any]:
    """Choose a md2wechat theme without maintaining a second product catalog."""
    wechat = package.get("wechat") if isinstance(package.get("wechat"), dict) else {}
    hint = _clean_text(wechat.get("公众号排版提示"))
    signal = f"{hint} {_text(wechat)}".lower()
    aliases = {
        "wechat-native": ("原生", "稳妥"),
        "minimal-green": ("极简", "简洁"),
        "nyt-classic": ("财经", "商业分析", "对标", "报道", "调查"),
        "coffee-house": ("专栏", "随笔", "手记", "人物稿"),
        "github-readme": ("教程", "产品", "操作指南"),
        "focus-green": ("课程", "讲义"),
        "bold-green": ("活动", "公告"),
    }
    selected = ""
    reason = ""
    if selected_template:
        if not _MD2WECHAT_THEME_RE.fullmatch(selected_template):
            raise VisualDirectorError(f"unsupported selected md2wechat theme: {selected_template}")
        selected = selected_template
        reason = f"采用本轮已确认 md2wechat 主题 {selected_template}"
    else:
        for style, keywords in aliases.items():
            if any(keyword.lower() in signal for keyword in keywords):
                selected = style
                reason = f"根据公众号排版提示匹配 {style}"
                break
    if not selected:
        defaults = {
            "product_demo": "github-readme",
            "analysis": "nyt-classic",
            "research": "nyt-classic",
            "founder_story": "coffee-house",
            "concept": "minimal-blue",
            "tutorial": "focus-green",
            "campaign": "bold-green",
        }
        selected = defaults.get(archetype, "wechat-native")
        reason = f"根据内容题材 {archetype} 自动选择 {selected}"
    alternatives_by_style = {
        "github-readme": ["minimal-blue", "sspai-red"],
        "nyt-classic": ["ink-minimal", "coffee-house"],
        "coffee-house": ["ink-minimal", "lavender-dream"],
        "focus-green": ["wechat-native", "minimal-green"],
        "bold-green": ["wechat-native", "bold-orange"],
        "wechat-native": ["minimal-green", "ink-minimal"],
    }
    candidates = [selected, *alternatives_by_style.get(selected, ["wechat-native", "minimal-green"])]
    candidates = [style for index, style in enumerate(candidates) if _MD2WECHAT_THEME_RE.fullmatch(style) and style not in candidates[:index]]
    return {"selected": selected, "candidates": candidates[:3], "reason": reason, "hint": hint}


def _material_assets(materials: dict[str, Any]) -> list[dict[str, Any]]:
    assets = materials.get("assets", [])
    if not isinstance(assets, list):
        raise VisualDirectorError("materials.assets must be a list")
    return [asset for asset in assets if isinstance(asset, dict) and str(asset.get("path") or "").strip()]


def _asset_type_values(asset: dict[str, Any]) -> set[str]:
    return {
        str(asset.get(field) or "").strip().lower().replace("-", "_")
        for field in ("kind", "role")
        if str(asset.get(field) or "").strip()
    }


def _asset_extension(asset: dict[str, Any]) -> str:
    return Path(str(asset.get("path") or "")).suffix.lower()


def _is_screenshot(asset: dict[str, Any]) -> bool:
    types = _asset_type_values(asset)
    suffix = _asset_extension(asset)
    if types & _SCREENSHOT_TYPES:
        return suffix in _IMAGE_EXTENSIONS
    name = Path(str(asset.get("path") or "")).stem.lower()
    return suffix in _IMAGE_EXTENSIONS and bool(
        re.search(r"(?:^|[-_])(screenshot|screen-capture|product-ui)(?:$|[-_])", name)
    )


def _is_research_evidence(asset: dict[str, Any]) -> bool:
    types = _asset_type_values(asset)
    suffix = _asset_extension(asset)
    if types & _RESEARCH_DATA_TYPES:
        return suffix in _DATA_EXTENSIONS
    if types & _RESEARCH_DOCUMENT_TYPES:
        return suffix in (_DATA_EXTENSIONS | _DOCUMENT_EXTENSIONS)
    return False


def _is_strong_research_signal(asset: dict[str, Any]) -> bool:
    types = _asset_type_values(asset)
    return bool(types & (_RESEARCH_DATA_TYPES | {"research_source", "report"})) and _is_research_evidence(asset)


def _has_source_backed_evidence(assets: list[dict[str, Any]]) -> bool:
    return any(_is_research_evidence(asset) for asset in assets)


def _classify(package: dict[str, Any], assets: list[dict[str, Any]], routing: dict[str, Any]) -> str:
    text = _text(package).lower()
    if _is_screenshot(next((asset for asset in assets if _is_screenshot(asset)), {})) or any(
        token in text for token in ("产品界面", "产品演示", "工作流演示", "产品工作流", "产品录屏")
    ):
        return "product_demo"
    research_source = any(_is_strong_research_signal(asset) for asset in assets)
    if research_source or any(token in text for token in ("行业研究", "本研究", "调研报告", "对标研究", "留存数据")):
        return "research"
    if any(token in text for token in ("我在", "第一次", "复盘", "客户会议", "创业", "那天")):
        return "founder_story"
    if any(token in text for token in ("方法", "框架", "步骤", "模型", "流程")) and "analysis" in routing:
        return "analysis"
    if any(token in text for token in ("概念", "隐喻", "认知", "理解")) and "concept" in routing:
        return "concept"
    # An ordinary article must still be publishable without a visual keyword or
    # image account. Fall back to the most neutral deterministic route instead
    # of turning classification uncertainty into a stage blocker. Explicit
    # research and product-demo claims above remain fail-closed on evidence.
    if "concept" in routing:
        return "concept"
    if "analysis" in routing:
        return "analysis"
    raise VisualDirectorError("visual routing has no general-purpose deterministic route")


def _post_pages(package: dict[str, Any]) -> list[dict[str, Any]]:
    posts = package.get("xhs_posts", [])
    if not isinstance(posts, list) or not posts:
        return []
    first_post = posts[0] if isinstance(posts[0], dict) else {}
    pages = first_post.get("pages", [])
    return [page for page in pages if isinstance(page, dict)] if isinstance(pages, list) else []


def _asset_source(assets: list[dict[str, Any]], evidence_mode: str) -> str:
    if evidence_mode == "screenshot_first":
        screenshot = next((asset for asset in assets if _is_screenshot(asset)), None)
        return str((screenshot or {}).get("path") or "")
    source = next((asset for asset in assets if _has_source_backed_evidence([asset])), None)
    return str((source or {}).get("path") or "")


def _cover_source(assets: list[dict[str, Any]], evidence_mode: str) -> str:
    """Find a legitimate visual source for an evidence-led WeChat cover."""
    screenshot = next((asset for asset in assets if _is_screenshot(asset)), None)
    if screenshot:
        return str(screenshot.get("path") or "")
    if evidence_mode in {"data_first", "artifact_first"}:
        evidence = next((asset for asset in assets if _is_research_evidence(asset)), None)
        if evidence:
            return str(evidence.get("path") or "")
    image = next(
        (
            asset for asset in assets
            if _asset_extension(asset) in _IMAGE_EXTENSIONS
            and "logo" not in _asset_type_values(asset)
        ),
        None,
    )
    return str((image or {}).get("path") or "")


def _cover_strategy(archetype: str, assets: list[dict[str, Any]], evidence_mode: str) -> str:
    if any(_is_screenshot(asset) for asset in assets):
        return "evidence_led"
    if evidence_mode == "data_first" and any(_is_research_evidence(asset) for asset in assets):
        return "data_led"
    if archetype in {"founder_story", "concept"}:
        return "editorial_quote"
    if archetype in {"analysis", "tutorial", "product_demo"}:
        return "structured_metaphor"
    return "typographic_judgment"


def _alternative_cover_strategy(primary: str) -> str:
    if primary in {"evidence_led", "data_led"}:
        return "typographic_judgment"
    if primary == "typographic_judgment":
        return "editorial_quote"
    return "structured_metaphor"


def _share_format(post: dict[str, Any], post_index: int) -> str:
    signal = _text(post)
    if any(token in signal for token in ("方法", "清单", "步骤", "自检", "框架", "流程")):
        return "framework"
    if any(token in signal for token in ("案例", "故事", "现场", "客户原话", "复盘", "第一次")):
        return "story"
    if any(token in signal for token in ("不是", "反常识", "误区", "对比", "别先")):
        return "contrast"
    # The package contract intentionally emits contrast / framework / story in
    # this order. Keep an explicit fallback for concise titles without cues.
    return ("contrast", "framework", "story")[(post_index - 1) % 3]


def _share_recipe(route: dict[str, Any], share_format: str) -> dict[str, Any]:
    configured = route.get("share_formats")
    candidate = configured.get(share_format) if isinstance(configured, dict) else None
    if isinstance(candidate, dict) and isinstance(candidate.get("page_recipes"), list) and len(candidate["page_recipes"]) == 5:
        return {
            "system": str(candidate.get("system") or route.get("xhs_system") or "swiss"),
            "page_recipes": list(candidate["page_recipes"]),
        }
    return dict(_SHARE_RECIPES.get(share_format, {
        "system": str(route.get("xhs_system") or "swiss"),
        "page_recipes": list(route["xhs_recipes"]),
    }))


def _card_structure(share_format: str, page_number: int, page_count: int = 5) -> str:
    structures = {
        "contrast": ["hook", "old-new-comparison", "reframe", "decision-checklist", "comment-cta"],
        "framework": ["method-hook", "step-one", "step-two", "step-three", "self-check-cta"],
        "story": ["scene-hook", "conflict", "turning-point", "action-boundary", "reflection-cta"],
    }
    return structures.get(share_format, structures["contrast"])[_five_stage_index(page_number, page_count)]


def _prompt_material_path(image_prompt: Any) -> str:
    matches = {
        match.group(0).rstrip(".,;:)]}")
        for match in _MATERIAL_PATH_RE.finditer(str(image_prompt or ""))
    }
    if not matches:
        return ""
    if len(matches) != 1:
        raise VisualDirectorError("page image_prompt must reference exactly one materials path")
    path = next(iter(matches))
    if not _is_safe_project_relative_path(path):
        raise VisualDirectorError(f"page image_prompt contains an unsafe materials path: {path}")
    return path


def _page_material_source(
    page: dict[str, Any],
    assets_by_path: dict[str, dict[str, Any]],
    evidence_mode: str,
) -> str:
    path = _prompt_material_path(page.get("image_prompt"))
    if not path:
        return ""
    asset = assets_by_path.get(path)
    if asset is None:
        raise VisualDirectorError(f"page image_prompt source is not present in materials.assets: {path}")
    screenshot = _is_screenshot(asset)
    research = _is_research_evidence(asset)
    compatible = (
        (evidence_mode == "screenshot_first" and screenshot)
        or (evidence_mode in {"data_first", "artifact_first"} and research)
        or (evidence_mode in {"hybrid", "illustration_allowed"} and (screenshot or research))
    )
    if not compatible:
        raise VisualDirectorError(f"page image_prompt source is incompatible with {evidence_mode}: {path}")
    return path


def _has_explicit_concept_boundary(page: dict[str, Any]) -> bool:
    """A page without a source may only render as a labeled non-factual visual."""
    prompt = _clean_text(page.get("image_prompt") or "")
    return ("概念插图" in prompt or "概念图解" in prompt) and "非事实证据" in prompt


def _recipe_assets(
    package: dict[str, Any],
    route: dict[str, Any],
    assets: list[dict[str, Any]],
    archetype: str,
    layout_selection: dict[str, Any],
    include_native_wechat_images: bool = False,
) -> list[dict[str, Any]]:
    evidence_mode = str(route["evidence_mode"])
    source = _asset_source(assets, evidence_mode)
    cover_source = _cover_source(assets, evidence_mode)
    primary_cover_strategy = _cover_strategy(archetype, assets, evidence_mode)
    alternative_cover_strategy = _alternative_cover_strategy(primary_cover_strategy)
    assets_by_path = {str(asset.get("path") or ""): asset for asset in assets}
    xhs_recipes = list(route["xhs_recipes"])
    wechat = package.get("wechat") if isinstance(package.get("wechat"), dict) else {}
    wechat_title = str(wechat.get("title") or package.get("title") or "公众号内容")
    native_package = package.get("schema") == "echo-founder.platform-native-package.v2"
    wechat_layout_assets: list[dict[str, Any]] = [
        {
            "id": "wechat-html",
            "platform": "wechat",
            "role": "article",
            "layout_recipe": "html",
            "layout_style": str(layout_selection["selected"]),
            "renderer": "md2wechat",
            "status": "planned",
            "copy": {"headline": wechat_title},
        },
    ]
    legacy_wechat_image_assets: list[dict[str, Any]] = [
        {
            "id": "wechat-cover",
            "platform": "wechat",
            "role": "cover",
            "layout_recipe": xhs_recipes[0],
            "cover_direction": "editorial_typography",
            "cover_strategy": "typographic_judgment",
            "renderer": "xhs-card",
            "status": "planned",
            "copy": {"headline": wechat_title},
        },
        {
            "id": "wechat-share",
            "platform": "wechat",
            "role": "share",
            "layout_recipe": xhs_recipes[0],
            "cover_direction": "editorial_typography",
            "cover_strategy": "typographic_judgment",
            "renderer": "xhs-card",
            "status": "planned",
            "copy": {"headline": wechat_title},
        },
        {
            "id": "wechat-cover-alt-01",
            "platform": "wechat",
            "role": "cover_alternative",
            "layout_recipe": xhs_recipes[0],
            "cover_direction": "authorized_real_scene",
            "cover_strategy": "evidence_led" if cover_source else alternative_cover_strategy,
            "renderer": "xhs-card",
            "status": "planned" if cover_source else "review_required",
            "requires_authorized_source": not bool(cover_source),
            "copy": {"headline": wechat_title},
        },
        {
            "id": "wechat-share-alt-01",
            "platform": "wechat",
            "role": "share_alternative",
            "layout_recipe": xhs_recipes[0],
            "cover_direction": "authorized_real_scene",
            "cover_strategy": "evidence_led" if cover_source else alternative_cover_strategy,
            "renderer": "xhs-card",
            "status": "planned" if cover_source else "review_required",
            "requires_authorized_source": not bool(cover_source),
            "copy": {"headline": wechat_title},
        },
        {
            "id": "wechat-cover-alt-02",
            "platform": "wechat",
            "role": "cover_alternative",
            "layout_recipe": xhs_recipes[0],
            "cover_direction": "conceptual_visual",
            "cover_strategy": "structured_metaphor",
            "renderer": "xhs-card",
            "status": "planned",
            "concept_boundary": "non_factual",
            "copy": {"headline": wechat_title},
        },
        {
            "id": "wechat-share-alt-02",
            "platform": "wechat",
            "role": "share_alternative",
            "layout_recipe": xhs_recipes[0],
            "cover_direction": "conceptual_visual",
            "cover_strategy": "structured_metaphor",
            "renderer": "xhs-card",
            "status": "planned",
            "concept_boundary": "non_factual",
            "copy": {"headline": wechat_title},
        },
    ]
    # A current platform-native article has only one recommended image suite:
    # one backend cover plus semantic inline visuals.  It deliberately omits
    # the historical three-direction cover comparison and the extra share
    # card so an operator can accept the whole article in one action.  Stable
    # mode remains a layout-only escape hatch; historical packages retain the
    # original image suite for read-only compatibility.
    native_wechat_image_assets = (
        [legacy_wechat_image_assets[0], *_semantic_inline_assets(package, archetype, source)]
        if wechat and native_package and include_native_wechat_images
        else []
    )
    built: list[dict[str, Any]] = (
        [*wechat_layout_assets, *native_wechat_image_assets]
        if wechat and native_package
        else [*wechat_layout_assets, *legacy_wechat_image_assets] if wechat else []
    )
    if cover_source and wechat and not native_package:
        built[3]["source"] = cover_source
        built[4]["source"] = cover_source
    posts = package.get("xhs_posts") if isinstance(package.get("xhs_posts"), list) else []
    # Platform selection is authoritative. A WeChat-only package must not
    # silently fabricate an empty five-page Xiaohongshu deck just because the
    # visual recipe supports both platforms.
    use_share_variants = len(posts) >= 3
    for post_number, post in enumerate(posts, start=1):
        post_index = int(post.get("index") or post_number)
        share_format = _share_format(post, post_index)
        series_recipe = _share_recipe(route, share_format) if use_share_variants else {
            "system": str(route.get("xhs_system") or "swiss"),
            "page_recipes": list(route["xhs_recipes"]),
        }
        series_recipes = list(series_recipe["page_recipes"])
        pages = post.get("pages") if isinstance(post, dict) and isinstance(post.get("pages"), list) else []
        page_count = len(pages) if pages else 5
        for index in range(page_count):
            page = pages[index] if index < len(pages) and isinstance(pages[index], dict) else {}
            page_id = str(page.get("page_id") or f"P{index + 1}")
            page_source = _page_material_source(page, assets_by_path, evidence_mode)
            role = "cover" if index == 0 else ("cta" if index == page_count - 1 else "supporting")
            page_copy = {
                "headline": str(page.get("title") or post.get("cover_text") or package.get("title") or "核心判断"),
                "supporting": str(page.get("body") or ""),
            }
            if native_package and index == 0:
                page_copy["cover"] = "\n".join(str(line) for line in post.get("cover_lines", []))
            page_evidence = native_page_evidence(page_copy, page_source) if native_package else None
            needs_evidence = page_evidence["status"] == "required" if page_evidence else index == 1 and evidence_mode in {"screenshot_first", "data_first", "artifact_first"}
            if native_package and needs_evidence and not page_source:
                raise VisualDirectorError(f"page {page_id} requires a page-specific materials evidence source；请为本页事实绑定来源")
            if needs_evidence and (page_source or source):
                role = "evidence"
            elif needs_evidence and not _has_explicit_concept_boundary(page):
                raise VisualDirectorError(
                    f"page {page_id} requires a materials evidence source or an explicit 概念插图（非事实证据） boundary"
                )
            item = {
                "id": f"xhs-{post_index:02d}-p{index + 1}",
                "platform": "xhs",
                "platform_bindings": ["xiaohongshu"] if package.get("schema") == "echo-founder.platform-native-package.v2" else ["xiaohongshu", "moments"],
                "role": role,
                "page_id": page_id,
                "layout_recipe": series_recipes[index % len(series_recipes)],
                "renderer": "xhs-card",
                "status": "planned",
                "share_format": share_format,
                "series_system": str(series_recipe["system"]),
                "card_structure": _card_structure(share_format, index + 1, page_count),
                "narrative_stage": _narrative_stage(share_format, index + 1, page_count),
                "copy": page_copy,
                "image_prompt": str(page.get("image_prompt") or ""),
                "visual_hierarchy": str(page.get("visual_hierarchy") or ""),
                "layout_note": str(page.get("layout_note") or ""),
            }
            if page_evidence:
                item["page_evidence"] = page_evidence
            selected_source = page_source or (source if role == "evidence" else "")
            if selected_source:
                item["source"] = selected_source
            elif needs_evidence:
                item["concept_boundary"] = "non_factual"
            built.append(item)
    if wechat and not native_package:
        built.extend(_semantic_inline_assets(package, archetype, source))
    return built


def build_visual_recipe(
    package: dict[str, Any],
    materials: dict[str, Any],
    slug: str,
    routing: dict[str, Any],
    brand_profiles: dict[str, Any],
    revision_id: str = "r001",
    selected_template: str | None = None,
    visual_preferences: dict[str, Any] | None = None,
    selected_direction: str = "direction-a",
) -> dict[str, Any]:
    """Return a reproducible recipe chosen from content and real source assets."""
    assets = _material_assets(materials)
    archetype = _classify(package, assets, routing)
    if archetype not in routing:
        raise VisualDirectorError(f"missing visual route for archetype: {archetype}")
    route = routing[archetype]
    if not isinstance(route.get("xhs_recipes"), list) or len(route["xhs_recipes"]) != 5:
        raise VisualDirectorError(f"{archetype} route requires five xhs recipes")
    evidence_mode = str(route.get("evidence_mode") or "")
    if archetype == "research" and not _has_source_backed_evidence(assets):
        raise VisualDirectorError("research requires source-backed evidence")
    if evidence_mode == "screenshot_first" and not any(_is_screenshot(asset) for asset in assets):
        raise VisualDirectorError("product demo requires a screenshot image evidence asset in a supported format")
    brand_profile = _selected_brand_profile(brand_profiles)
    brand_system = _brand_system(brand_profile)
    # Calls made by the current desktop/runtime always pass visual preferences and
    # therefore create v2 recipes.  Keeping the argument optional preserves the
    # read-only/direct-call compatibility contract for historical v1 packages.
    use_v2_recipe = visual_preferences is not None or package.get("schema") == "echo-founder.platform-native-package.v2"
    preferences = _visual_preferences(visual_preferences)
    directions = _art_directions(archetype, brand_system)
    if selected_direction not in {item["id"] for item in directions}:
        raise VisualDirectorError("selected visual direction is unsupported")
    cover_scorecard = _cover_scorecard(brand_profile)
    golden_sample_standard = dict(brand_profile.get("golden_sample_standard") or {})
    source_assets = [str(asset["path"]) for asset in assets]
    layout_selection = _layout_selection(package, archetype, selected_template)
    recipe_assets = _recipe_assets(
        package,
        route,
        assets,
        archetype,
        layout_selection,
        include_native_wechat_images=preferences["mode"] == "ai_enhanced",
    )
    if use_v2_recipe:
        recipe_assets = _annotate_v2_assets(
            recipe_assets,
            preferences,
            selected_direction,
        )
    xhs_asset_ids = [
        str(asset["id"])
        for asset in recipe_assets
        if asset.get("platform") == "xhs"
    ]
    wechat_asset_ids = [
        str(asset["id"])
        for asset in recipe_assets
        if asset.get("platform") == "wechat"
    ]
    cover_options = [
        {
            "id": "primary",
            "label": "编辑排版首图",
            "direction": "editorial_typography",
            "strategy": next(
                (asset.get("cover_strategy") for asset in recipe_assets if asset.get("id") == "wechat-cover"),
                "typographic_judgment",
            ),
            "asset_ids": ["wechat-cover", "wechat-share"],
        },
        {
            "id": "authorized-scene",
            "label": "授权实景首图",
            "direction": "authorized_real_scene",
            "strategy": next(
                (asset.get("cover_strategy") for asset in recipe_assets if asset.get("id") == "wechat-cover-alt-01"),
                "editorial_quote",
            ),
            "asset_ids": ["wechat-cover-alt-01", "wechat-share-alt-01"],
        },
        {
            "id": "conceptual",
            "label": "概念视觉首图",
            "direction": "conceptual_visual",
            "strategy": next(
                (asset.get("cover_strategy") for asset in recipe_assets if asset.get("id") == "wechat-cover-alt-02"),
                "structured_metaphor",
            ),
            "asset_ids": ["wechat-cover-alt-02", "wechat-share-alt-02"],
        },
    ] if not use_v2_recipe and any(asset_id.startswith("wechat-cover") for asset_id in wechat_asset_ids) else []
    posts = package.get("xhs_posts") if isinstance(package.get("xhs_posts"), list) else []
    use_share_variants = len(posts) >= 3
    series: list[dict[str, Any]] = []
    for post_number, post in enumerate(posts, start=1):
        if not isinstance(post, dict):
            continue
        post_index = int(post.get("index") or post_number)
        share_format = _share_format(post, post_index)
        series_recipe = _share_recipe(route, share_format) if use_share_variants else {
            "system": str(route.get("xhs_system") or "swiss"),
            "page_recipes": list(route["xhs_recipes"]),
        }
        page_count = len(post.get("pages") or []) or 5
        series.append({
            "post_index": post_index,
            "share_format": share_format,
            "system": series_recipe["system"],
            "page_recipes": list(series_recipe["page_recipes"]),
            "narrative_chain": [
                _narrative_stage(share_format, page_number, page_count)
                for page_number in range(1, page_count + 1)
            ],
            "asset_ids": [f"xhs-{post_index:02d}-p{page}" for page in range(1, page_count + 1)],
            "platform_bindings": ["xiaohongshu"] if package.get("schema") == "echo-founder.platform-native-package.v2" else ["xiaohongshu", "moments"],
        })
    platform_recipes: dict[str, Any] = {}
    if wechat_asset_ids:
        platform_recipes["wechat"] = {
            "system": str(route.get("wechat_system") or "swiss"),
            "text_renderer": "md2wechat",
            "fallback_renderer": "dbs-wechat-html",
            "layout_selection": layout_selection,
            **({"cover_recipe": str(route["xhs_recipes"][0])} if cover_options else {}),
            **({"cover_options": cover_options} if cover_options else {}),
            **({"selection_scorecard": cover_scorecard} if cover_options and cover_scorecard else {}),
            "asset_ids": wechat_asset_ids,
        }
    if xhs_asset_ids:
        native_xhs = package.get("schema") == "echo-founder.platform-native-package.v2"
        base_page_recipes = list(route["xhs_recipes"])
        platform_recipes["xhs"] = {
            "system": str(route.get("xhs_system") or route.get("wechat_system") or "swiss"),
            "platform_bindings": ["xiaohongshu"] if package.get("schema") == "echo-founder.platform-native-package.v2" else ["xiaohongshu", "moments"],
            "page_recipes": [base_page_recipes[index % len(base_page_recipes)] for index in range(8)] if use_v2_recipe else base_page_recipes,
            "series": series,
            "asset_ids": xhs_asset_ids,
        }
    recipe = {
        "schema": "aifios.visual-recipe.v2" if use_v2_recipe else "aifios.visual-recipe.v1",
        "revision_id": revision_id,
        "slug": slug,
        "source_package": str(package.get("source_package") or f"pipeline/package/{slug}-package.md"),
        "source_assets": source_assets,
        "content_archetype": archetype,
        "evidence_mode": evidence_mode,
        "brand_profile": str(brand_profile.get("name") or "adaptive"),
        **({
            "visual_preferences": preferences,
            "art_directions": directions,
            "selected_direction": selected_direction,
            "generation_policy": {
                "text_renderer": "html-playwright",
                "provider_policy": "auto",
                "fallback_mode": "stable",
            },
        } if use_v2_recipe else {}),
        **({"brand_system": brand_system} if brand_system else {}),
        **({"golden_sample_standard": golden_sample_standard} if golden_sample_standard else {}),
        "platforms": platform_recipes,
        "assets": recipe_assets,
        "quality_policy": dict(brand_profile.get("quality_policy") or {"min_density": 0.62, "require_evidence_ratio": 0.4}),
    }
    errors = validate_visual_recipe(recipe)
    if errors:
        raise VisualDirectorError("; ".join(errors))
    return recipe


def validate_visual_recipe(recipe: dict[str, Any]) -> list[str]:
    if not isinstance(recipe, dict):
        return ["visual recipe must be an object"]

    required = ["schema", "revision_id", "slug", "source_package", "content_archetype", "evidence_mode", "platforms", "assets", "quality_policy"]
    errors = [f"missing recipe field: {field}" for field in required if not recipe.get(field)]
    recipe_schema = recipe.get("schema")
    if recipe_schema not in {"aifios.visual-recipe.v1", "aifios.visual-recipe.v2"}:
        errors.append("unsupported visual recipe schema")
    if recipe_schema == "aifios.visual-recipe.v2":
        preferences = recipe.get("visual_preferences")
        if not isinstance(preferences, dict):
            errors.append("visual recipe v2 requires visual_preferences")
        else:
            if preferences.get("mode") not in _VISUAL_MODES:
                errors.append("visual_preferences.mode must be ai_enhanced or stable")
            if preferences.get("direction_count") != 2:
                errors.append("visual_preferences.direction_count must be 2")
            if preferences.get("provider_policy") != "auto":
                errors.append("visual_preferences.provider_policy must be auto")
        directions = recipe.get("art_directions")
        direction_ids = {
            str(item.get("id")) for item in directions or []
            if isinstance(item, dict) and item.get("id")
        } if isinstance(directions, list) else set()
        if not isinstance(directions, list) or len(directions) != 2 or len(direction_ids) != 2:
            errors.append("visual recipe v2 requires two unique art_directions")
        if recipe.get("selected_direction") not in direction_ids:
            errors.append("selected_direction must reference an art_direction")
        policy = recipe.get("generation_policy")
        if not isinstance(policy, dict) or policy.get("text_renderer") != "html-playwright" or policy.get("provider_policy") != "auto" or policy.get("fallback_mode") != "stable":
            errors.append("visual recipe v2 generation_policy is invalid")

    revision_id = recipe.get("revision_id")
    if not isinstance(revision_id, str) or not _REVISION_ID_RE.fullmatch(revision_id):
        errors.append("revision_id must match ^r[0-9]{3,}$")
    parent_revision_id = recipe.get("parent_revision_id")
    if parent_revision_id is not None and (
        not isinstance(parent_revision_id, str) or not _REVISION_ID_RE.fullmatch(parent_revision_id)
    ):
        errors.append("parent_revision_id must match ^r[0-9]{3,}$")

    slug = recipe.get("slug")
    if not isinstance(slug, str) or not _SAFE_SLUG_RE.fullmatch(slug):
        errors.append("slug contains unsafe path characters")

    if not _is_safe_project_relative_path(recipe.get("source_package")):
        errors.append("source_package must be a safe project-relative path")
    if "recipe_path" in recipe and not _is_safe_project_relative_path(recipe.get("recipe_path")):
        errors.append("recipe_path must be a safe project-relative path")

    source_assets = recipe.get("source_assets", [])
    if not isinstance(source_assets, list):
        errors.append("source_assets must be a list")
    else:
        for index, source_path in enumerate(source_assets):
            if not _is_safe_project_relative_path(source_path):
                errors.append(f"source_assets[{index}] must be a safe project-relative path")

    if recipe.get("content_archetype") not in _CONTENT_ARCHETYPES:
        errors.append("unsupported content_archetype")
    if recipe.get("evidence_mode") not in _EVIDENCE_MODES:
        errors.append("unsupported evidence_mode")

    brand_system = recipe.get("brand_system")
    if brand_system is not None:
        if not isinstance(brand_system, dict) or not isinstance(brand_system.get("name"), str) or not brand_system.get("name"):
            errors.append("brand_system requires a name")
        else:
            tokens = brand_system.get("tokens")
            colors = tokens.get("colors") if isinstance(tokens, dict) else None
            if not isinstance(colors, dict) or not colors:
                errors.append("brand_system.tokens.colors must be a non-empty object")
            else:
                unsupported = sorted(set(colors) - _BRAND_COLOR_KEYS)
                if unsupported:
                    errors.append("brand_system.tokens.colors contains unsupported keys: " + ", ".join(unsupported))
                for key, value in colors.items():
                    if not isinstance(value, str) or not _HEX_COLOR_RE.fullmatch(value):
                        errors.append(f"brand_system.tokens.colors.{key} must be a six-digit hex color")

    golden_standard = recipe.get("golden_sample_standard")
    if golden_standard is not None and not isinstance(golden_standard, dict):
        errors.append("golden_sample_standard must be an object")

    platforms = recipe.get("platforms")
    allowed_platform_sets = (
        ({"wechat"}, {"xhs"}, {"wechat", "xhs"})
        if recipe_schema == "aifios.visual-recipe.v2"
        else ({"wechat"}, {"xhs"}, {"wechat", "xhs"}, {"wechat", "xhs", "moments"})
    )
    if not isinstance(platforms, dict) or set(platforms) not in allowed_platform_sets:
        errors.append("recipe must define only wechat, xhs, and optional moments platforms; v2 may use any non-empty wechat/xhs subset")
    wechat = platforms.get("wechat") if isinstance(platforms, dict) else None
    xhs = platforms.get("xhs") if isinstance(platforms, dict) else None
    moments = platforms.get("moments") if isinstance(platforms, dict) else None
    if "wechat" in (platforms or {}) and (
        not isinstance(wechat, dict) or not isinstance(wechat.get("system"), str) or not wechat.get("system")
    ):
        errors.append("wechat platform requires a system")
    page_recipes = xhs.get("page_recipes") if isinstance(xhs, dict) else None
    if "xhs" in (platforms or {}) and (
        not isinstance(xhs, dict) or not isinstance(xhs.get("system"), str) or not xhs.get("system")
    ):
        errors.append("xhs platform requires a system")
    expected_page_recipe_count = 8 if recipe_schema == "aifios.visual-recipe.v2" else 5
    if "xhs" in (platforms or {}) and (not isinstance(page_recipes, list) or len(page_recipes) != expected_page_recipe_count):
        errors.append(f"xhs platform requires {expected_page_recipe_count} page recipes")
    # Recipes created before shared social suites did not carry binding
    # metadata. Keep them readable, while validating the field whenever a
    # current recipe declares it.
    if moments is None and isinstance(xhs, dict):
        bindings = xhs.get("platform_bindings")
        allowed_bindings = (["xiaohongshu"],) if recipe_schema == "aifios.visual-recipe.v2" else (["xiaohongshu"], ["xiaohongshu", "moments"])
        if bindings is not None and bindings not in allowed_bindings:
            errors.append("xhs visual suites must bind only xiaohongshu in visual-recipe.v2")

    if moments is not None:
        if not isinstance(moments, dict) or not isinstance(moments.get("system"), str) or not moments.get("system"):
            errors.append("moments platform requires a system")
        elif moments.get("format") != _MOMENTS_UPLOAD_MODE:
            errors.append("moments platform requires square_triptych format")
        else:
            moment_series = moments.get("series")
            if not isinstance(moment_series, list) or not moment_series:
                errors.append("moments platform requires at least one square triptych series")
            else:
                for item in moment_series:
                    if not isinstance(item, dict):
                        errors.append("moments platform series entries must be objects")
                        continue
                    if not isinstance(item.get("post_index"), int) or item.get("post_index") < 1:
                        errors.append("moments platform series requires a positive post_index")
                    if item.get("upload_mode") != _MOMENTS_UPLOAD_MODE:
                        errors.append("moments platform series requires square_triptych upload_mode")
                    if item.get("page_ids") != [f"P{page}" for page in _MOMENTS_PAGE_NUMBERS]:
                        errors.append("moments platform series must use P1, P3, P5")
                    asset_ids = item.get("asset_ids")
                    if not isinstance(asset_ids, list) or len(asset_ids) != len(_MOMENTS_PAGE_NUMBERS):
                        errors.append("moments platform series requires three square asset_ids")

    layout_selection = wechat.get("layout_selection") if isinstance(wechat, dict) else None
    if layout_selection is not None:
        if not isinstance(layout_selection, dict):
            errors.append("wechat layout_selection must be an object")
        else:
            selected = layout_selection.get("selected")
            candidates = layout_selection.get("candidates")
            if not isinstance(selected, str) or not _MD2WECHAT_THEME_RE.fullmatch(selected):
                errors.append("wechat layout_selection.selected is unsupported")
            if not isinstance(candidates, list) or not candidates or any(not isinstance(style, str) or not _MD2WECHAT_THEME_RE.fullmatch(style) for style in candidates):
                errors.append("wechat layout_selection.candidates must contain supported styles")
            elif selected not in candidates:
                errors.append("wechat layout_selection.candidates must include selected")
    if isinstance(wechat, dict) and "wechat_layout" in wechat:
        from wechat_layout_refinement import validate_wechat_layout

        layout_options = wechat["wechat_layout"]
        layout_errors = validate_wechat_layout(layout_options)
        errors.extend(layout_errors)
        if not layout_errors:
            if not isinstance(layout_selection, dict) or layout_options["theme"] != layout_selection.get("selected"):
                errors.append("wechat_layout.theme must match the selected theme")
            article = next((asset for asset in recipe.get("assets", []) if isinstance(asset, dict) and asset.get("id") == "wechat-html"), None)
            if not article or article.get("renderer") != "md2wechat" or article.get("layout_style") != layout_options["theme"]:
                errors.append("wechat_layout requires a matching md2wechat article asset")
    cover_options = wechat.get("cover_options") if isinstance(wechat, dict) else None
    if cover_options is not None:
        if not isinstance(cover_options, list) or len(cover_options) != 3:
            errors.append("wechat cover_options must contain exactly three directions")
        else:
            directions: set[str] = set()
            for option in cover_options:
                if not isinstance(option, dict):
                    errors.append("wechat cover_options entries must be objects")
                    continue
                if option.get("strategy") not in _COVER_STRATEGIES:
                    errors.append("wechat cover_options entry has an unsupported strategy")
                direction = option.get("direction")
                if direction not in _COVER_DIRECTIONS:
                    errors.append("wechat cover_options entry has an unsupported direction")
                elif direction in directions:
                    errors.append("wechat cover_options directions must be unique")
                else:
                    directions.add(direction)
                asset_ids = option.get("asset_ids")
                if not isinstance(asset_ids, list) or len(asset_ids) != 2 or not all(isinstance(asset_id, str) for asset_id in asset_ids):
                    errors.append("wechat cover_options entry must contain two asset_ids")
            if directions != _COVER_DIRECTIONS:
                errors.append("wechat cover_options must cover editorial, authorized scene, and conceptual directions")
    selection_scorecard = wechat.get("selection_scorecard") if isinstance(wechat, dict) else None
    if selection_scorecard is not None:
        if not isinstance(selection_scorecard, dict):
            errors.append("wechat selection_scorecard must be an object")
        else:
            criteria = selection_scorecard.get("criteria")
            minimum_score = selection_scorecard.get("minimum_score")
            if not isinstance(minimum_score, (int, float)) or isinstance(minimum_score, bool) or not 0 <= minimum_score <= 100:
                errors.append("wechat selection_scorecard.minimum_score must be between 0 and 100")
            if not isinstance(criteria, list) or len(criteria) != 4:
                errors.append("wechat selection_scorecard requires four criteria")
            else:
                weights = []
                criterion_ids: set[str] = set()
                for criterion in criteria:
                    if not isinstance(criterion, dict):
                        errors.append("wechat selection_scorecard criteria must be objects")
                        continue
                    criterion_id = criterion.get("id")
                    weight = criterion.get("weight")
                    if not isinstance(criterion_id, str) or not criterion_id or criterion_id in criterion_ids:
                        errors.append("wechat selection_scorecard criterion ids must be unique strings")
                    else:
                        criterion_ids.add(criterion_id)
                    if not isinstance(weight, (int, float)) or isinstance(weight, bool) or not 0 < weight <= 1:
                        errors.append("wechat selection_scorecard criterion weights must be between 0 and 1")
                    else:
                        weights.append(float(weight))
                if weights and abs(sum(weights) - 1.0) > 1e-9:
                    errors.append("wechat selection_scorecard criterion weights must sum to 1")

    assets = recipe.get("assets", [])
    if not isinstance(assets, list):
        return errors + ["assets must be a list"]
    if not assets:
        errors.append("assets must contain at least one asset")
    seen_asset_ids: set[str] = set()
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            errors.append("asset must be an object")
            continue
        for field in ("id", "role", "layout_recipe", "renderer", "status"):
            if not isinstance(asset.get(field), str) or not asset.get(field):
                errors.append(f"asset missing {field}")
        asset_id = asset.get("id")
        if isinstance(asset_id, str):
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", asset_id):
                errors.append(f"asset {asset_id or index} has an unsafe id")
            if asset_id in seen_asset_ids:
                errors.append(f"duplicate asset id: {asset_id}")
            else:
                seen_asset_ids.add(asset_id)
        platform = asset.get("platform")
        if platform is not None and platform not in {"wechat", "xhs", "moments", "video"}:
            errors.append(f"asset {asset.get('id') or index} has an unsupported platform")
        if recipe_schema == "aifios.visual-recipe.v2":
            if asset.get("source_type") not in {"evidence", "authorized_source", "ai_concept"}:
                errors.append(f"asset {asset.get('id') or index} has an invalid source_type")
            if asset.get("art_direction_id") != recipe.get("selected_direction"):
                errors.append(f"asset {asset.get('id') or index} must bind selected_direction")
            if not isinstance(asset.get("consistency_group"), str) or not asset.get("consistency_group"):
                errors.append(f"asset {asset.get('id') or index} requires consistency_group")
            overlay = asset.get("text_overlay")
            if not isinstance(overlay, dict) or overlay.get("renderer") != "html-playwright" or not isinstance(overlay.get("expected_text"), str):
                errors.append(f"asset {asset.get('id') or index} requires deterministic text_overlay")
        if platform == "moments":
            if not re.fullmatch(r"moments-\d+-p[135]", str(asset_id or ""), re.IGNORECASE):
                errors.append(f"moments asset {asset.get('id') or index} must use moments-NN-p1/p3/p5 id")
            if asset.get("role") != "moments_square":
                errors.append(f"moments asset {asset.get('id') or index} must use moments_square role")
            if asset.get("upload_format") != "1:1":
                errors.append(f"moments asset {asset.get('id') or index} must declare 1:1 upload_format")
            if not isinstance(asset.get("upload_order"), int) or not 1 <= asset.get("upload_order") <= 3:
                errors.append(f"moments asset {asset.get('id') or index} must declare upload_order 1-3")
        if asset.get("role") == "evidence" and not asset.get("source"):
            errors.append(f"evidence asset {asset.get('id') or '<unknown>'} is missing source")
        if "source" in asset and not _is_safe_project_relative_path(asset.get("source")):
            errors.append(f"asset {asset.get('id') or index} source must be a safe project-relative path")
        if "output" in asset and not _is_safe_project_relative_path(asset.get("output")):
            errors.append(f"asset {asset.get('id') or index} output must be a safe project-relative path")
        if "layout_style" in asset and (not isinstance(asset.get("layout_style"), str) or not _MD2WECHAT_THEME_RE.fullmatch(str(asset.get("layout_style")))):
            errors.append(f"asset {asset.get('id') or index} has an unsupported layout_style")
        if "cover_strategy" in asset and asset.get("cover_strategy") not in _COVER_STRATEGIES:
            errors.append(f"asset {asset.get('id') or index} has an unsupported cover_strategy")
        if "cover_direction" in asset and asset.get("cover_direction") not in _COVER_DIRECTIONS:
            errors.append(f"asset {asset.get('id') or index} has an unsupported cover_direction")
        if "share_format" in asset and asset.get("share_format") not in _SHARE_FORMATS:
            errors.append(f"asset {asset.get('id') or index} has an unsupported share_format")
        if "narrative_stage" in asset:
            stage = asset.get("narrative_stage")
            if not isinstance(stage, dict) or any(not _clean_text(stage.get(field)) for field in ("key", "label", "goal")):
                errors.append(f"asset {asset.get('id') or index} narrative_stage requires key, label, and goal")
        if "insert_after" in asset and (not isinstance(asset.get("insert_after"), str) or not _clean_text(asset.get("insert_after"))):
            errors.append(f"asset {asset.get('id') or index} insert_after must be a non-empty string")
        if "caption" in asset and (not isinstance(asset.get("caption"), str) or not _clean_text(asset.get("caption"))):
            errors.append(f"asset {asset.get('id') or index} caption must be a non-empty string")
        if "semantic_brief" in asset and (not isinstance(asset.get("semantic_brief"), str) or not _clean_text(asset.get("semantic_brief"))):
            errors.append(f"asset {asset.get('id') or index} semantic_brief must be a non-empty string")
        if "inline_structure" in asset and asset.get("inline_structure") not in _INLINE_STRUCTURES:
            errors.append(f"asset {asset.get('id') or index} has an unsupported inline_structure")

    if isinstance(cover_options, list):
        known_ids = {
            str(asset.get("id"))
            for asset in assets
            if isinstance(asset, dict) and isinstance(asset.get("id"), str)
        }
        for option in cover_options:
            if isinstance(option, dict):
                for asset_id in option.get("asset_ids", []):
                    if isinstance(asset_id, str) and asset_id not in known_ids:
                        errors.append(f"wechat cover option references missing asset: {asset_id}")

    xhs_posts = {
        int(match.group(1))
        for asset_id in seen_asset_ids
        if (match := re.fullmatch(r"xhs-(\d+)-p[1-8]", asset_id, re.IGNORECASE))
    }
    if len(xhs_posts) >= 3:
        if isinstance(moments, dict):
            expected_moments_ids = {
                f"moments-{post:02d}-p{page}"
                for post in xhs_posts
                for page in _MOMENTS_PAGE_NUMBERS
            }
            missing_moments = sorted(expected_moments_ids - seen_asset_ids)
            if missing_moments:
                errors.append("three-share recipe is missing moments square assets: " + ", ".join(missing_moments))
            declared_moments_ids = {
                asset_id
                for item in moments.get("series", []) if isinstance(item, dict)
                for asset_id in item.get("asset_ids", []) if isinstance(asset_id, str)
            }
            if not expected_moments_ids.issubset(declared_moments_ids):
                errors.append("moments platform series does not declare every square asset")
        elif isinstance(xhs, dict):
            for item in xhs.get("series", []):
                if (
                    isinstance(item, dict)
                    and item.get("platform_bindings") is not None
                    and item.get("platform_bindings") not in (["xiaohongshu"], ["xiaohongshu", "moments"])
                ):
                    errors.append("xhs series must bind xiaohongshu; legacy series may also bind moments")

    quality_policy = recipe.get("quality_policy")
    if not isinstance(quality_policy, dict):
        errors.append("quality_policy must be an object")
    else:
        for field in ("min_density", "require_evidence_ratio"):
            value = quality_policy.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= 1:
                errors.append(f"quality_policy.{field} must be a number between 0 and 1")
        if "min_evidence_detail" in quality_policy:
            value = quality_policy.get("min_evidence_detail")
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= 1:
                errors.append("quality_policy.min_evidence_detail must be a number between 0 and 1")
    return errors


def next_recipe_id(existing_recipe_paths: Iterable[Path]) -> str:
    highest = 0
    for path in existing_recipe_paths:
        match = re.fullmatch(r"r(\d+)\.visual-recipe\.json", path.name)
        if match:
            highest = max(highest, int(match.group(1)))
    return f"r{highest + 1:03d}"
