from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from visual_director import (  # noqa: E402
    VisualDirectorError,
    build_visual_recipe,
    next_recipe_id,
    validate_visual_recipe,
)


ROUTING = {
    "product_demo": {
        "evidence_mode": "screenshot_first",
        "wechat_system": "swiss",
        "xhs_system": "swiss",
        "xhs_recipes": ["S01", "S08", "S06", "S10", "S12"],
    },
    "founder_story": {
        "evidence_mode": "artifact_first",
        "wechat_system": "editorial",
        "xhs_system": "editorial",
        "xhs_recipes": ["M01", "M05", "M08", "M11", "M15"],
    },
    "research": {
        "evidence_mode": "data_first",
        "wechat_system": "editorial",
        "xhs_system": "editorial",
        "xhs_recipes": ["M01", "S10", "S06", "M10", "S12"],
    },
    "analysis": {
        "evidence_mode": "data_first",
        "wechat_system": "swiss",
        "xhs_system": "swiss",
        "xhs_recipes": ["S01", "S10", "S06", "S09", "S12"],
    },
}

BRANDS = {
    "adaptive": {
        "name": "adaptive",
        "quality_policy": {"min_density": 0.62, "require_evidence_ratio": 0.4},
    }
}


def package_with_pages(title: str, body: str) -> dict:
    pages = [
        {
            "page_id": f"P{number}",
            "title": f"页面 {number}",
            "body": f"{body} · 第 {number} 页",
            "image_prompt": "展示真实产品流程",
            "visual_hierarchy": "大标题 + 证据图",
            "layout_note": "保留截图可读区域",
        }
        for number in range(1, 6)
    ]
    return {
        "title": title,
        "wechat": {"title": title, "cover_text": "核心判断", "body": body},
        "xhs_posts": [{"index": 1, "title": title, "cover_text": "核心判断", "pages": pages}],
    }


def test_product_demo_routes_to_swiss_screenshot_recipe() -> None:
    package = package_with_pages("产品工作流演示", "录屏展示产品界面与客户操作路径")
    materials = {
        "assets": [
            {"path": "materials/screenshots/product-flow.png", "kind": "screenshot", "role": "product_ui"}
        ]
    }

    recipe = build_visual_recipe(package, materials, "product-demo", ROUTING, BRANDS)

    assert recipe["schema"] == "aifios.visual-recipe.v1"
    assert recipe["content_archetype"] == "product_demo"
    assert recipe["evidence_mode"] == "screenshot_first"
    assert recipe["platforms"]["xhs"]["system"] == "swiss"
    assert recipe["platforms"]["xhs"]["page_recipes"] == ["S01", "S08", "S06", "S10", "S12"]
    assert set(recipe["platforms"]) == {"wechat", "xhs"}
    assert recipe["platforms"]["xhs"]["platform_bindings"] == ["xiaohongshu", "moments"]
    cover_options = recipe["platforms"]["wechat"]["cover_options"]
    assert len(cover_options) == 3
    assert {item["direction"] for item in cover_options} == {
        "editorial_typography",
        "authorized_real_scene",
        "conceptual_visual",
    }
    asset_ids = {asset["id"] for asset in recipe["assets"]}
    assert not any(asset_id.startswith(("moments-", "video-")) for asset_id in asset_ids)
    assert all(
        asset["platform_bindings"] == ["xiaohongshu", "moments"]
        for asset in recipe["assets"]
        if asset["id"].startswith("xhs-")
    )
    evidence_asset = next(asset for asset in recipe["assets"] if asset["id"] == "xhs-01-p2")
    assert evidence_asset["layout_recipe"] == "S08"
    assert evidence_asset["source"] == "materials/screenshots/product-flow.png"
    assert evidence_asset["role"] == "evidence"
    assert validate_visual_recipe(recipe) == []


def test_native_xhs_package_builds_v2_recipe_with_exact_p1_to_p8_contract() -> None:
    package = package_with_pages("八页原生图文方法", "每个平台从共享事实底稿独立生成")
    package["schema"] = "echo-founder.platform-native-package.v2"
    package["xhs_posts"][0]["pages"] = [
        {
            "page_id": f"P{number}",
            "title": f"页面 {number}",
            "body": f"第 {number} 页独立内容",
            "image_prompt": "生成无文字概念视觉",
            "visual_hierarchy": "准确文字覆盖层 + 概念视觉",
            "layout_note": "保持跨页一致",
        }
        for number in range(1, 9)
    ]

    recipe = build_visual_recipe(
        package,
        {"assets": [{"path": "materials/notes/source.md", "kind": "document"}]},
        "native-eight-pages",
        ROUTING,
        BRANDS,
        visual_preferences={
            "mode": "ai_enhanced",
            "direction_count": 2,
            "provider_policy": "auto",
        },
    )

    assert recipe["schema"] == "aifios.visual-recipe.v2"
    assert len(recipe["art_directions"]) == 2
    assert recipe["selected_direction"] == "direction-a"
    assert len(recipe["platforms"]["xhs"]["page_recipes"]) == 8
    wechat_assets = [asset for asset in recipe["assets"] if asset["platform"] == "wechat"]
    assert [asset["id"] for asset in wechat_assets] == ["wechat-html", "wechat-cover", "inline-01"]
    assert wechat_assets[0]["renderer"] == "md2wechat"
    assert wechat_assets[1]["role"] == "cover"
    assert wechat_assets[2]["insert_after"] == "核心判断"
    assert recipe["platforms"]["wechat"]["asset_ids"] == ["wechat-html", "wechat-cover", "inline-01"]
    assert "cover_options" not in recipe["platforms"]["wechat"]
    xhs_assets = [asset for asset in recipe["assets"] if asset["platform"] == "xhs"]
    assert [asset["id"] for asset in xhs_assets] == [f"xhs-01-p{number}" for number in range(1, 9)]
    assert {asset["consistency_group"] for asset in xhs_assets} == {"xhs-post-01"}
    assert all(asset["text_overlay"]["renderer"] == "html-playwright" for asset in xhs_assets)
    assert all(asset["source_type"] in {"evidence", "authorized_source", "ai_concept"} for asset in xhs_assets)
    assert validate_visual_recipe(recipe) == []


def test_native_wechat_stable_mode_remains_layout_only() -> None:
    package = package_with_pages("只做稳定排版", "保持原文图片，不自动生成公众号新图片")
    package["schema"] = "echo-founder.platform-native-package.v2"
    package["xhs_posts"] = []

    recipe = build_visual_recipe(
        package,
        {"assets": []},
        "native-layout-only",
        ROUTING,
        BRANDS,
        visual_preferences={
            "mode": "stable",
            "direction_count": 2,
            "provider_policy": "auto",
        },
    )

    assert [asset["id"] for asset in recipe["assets"]] == ["wechat-html"]
    assert recipe["platforms"]["wechat"]["asset_ids"] == ["wechat-html"]
    assert validate_visual_recipe(recipe) == []


def test_generic_screen_recording_broll_does_not_require_product_screenshot() -> None:
    """A filming suggestion is not evidence that the article demos a product."""
    package = package_with_pages(
        "把内容获客拆成动作",
        "记录客户问题、沉淀案例、每周复盘。B-roll 可用电脑录屏打开一张四栏概念表。",
    )

    recipe = build_visual_recipe(
        package,
        {"assets": [{"path": "materials/notes/interview.md", "kind": "document"}]},
        "content-growth",
        ROUTING,
        BRANDS,
    )

    assert recipe["content_archetype"] == "founder_story"
    assert recipe["evidence_mode"] == "artifact_first"


def test_selected_brand_layout_template_overrides_the_automatic_wechat_layout() -> None:
    package = package_with_pages("产品工作流演示", "录屏展示产品界面与客户操作路径")
    materials = {
        "assets": [{"path": "materials/screenshots/product-flow.png", "kind": "screenshot", "role": "product_ui"}]
    }

    recipe = build_visual_recipe(
        package,
        materials,
        "product-demo",
        ROUTING,
        BRANDS,
        selected_template="coffee-house",
    )

    assert recipe["platforms"]["wechat"]["layout_selection"]["selected"] == "coffee-house"
    assert "已确认 md2wechat 主题" in recipe["platforms"]["wechat"]["layout_selection"]["reason"]


@pytest.mark.parametrize(
    ("field", "value", "expected_error"),
    [
        ("revision_id", "r01", "revision_id must match"),
        ("revision_id", "../../outside", "revision_id must match"),
        ("slug", "../other-topic", "slug contains unsafe"),
        ("slug", "other/topic", "slug contains unsafe"),
        ("source_package", "../../outside.md", "source_package must be a safe project-relative path"),
        ("source_package", "/tmp/outside.md", "source_package must be a safe project-relative path"),
    ],
)
def test_recipe_validator_rejects_unsafe_identity_and_package_paths(
    field: str,
    value: str,
    expected_error: str,
) -> None:
    recipe = build_visual_recipe(
        package_with_pages("产品工作流演示", "录屏展示产品界面"),
        {"assets": [{"path": "materials/screenshots/product-flow.png", "kind": "screenshot"}]},
        "product-demo",
        ROUTING,
        BRANDS,
    )
    recipe[field] = value

    assert any(expected_error in error for error in validate_visual_recipe(recipe))


def test_recipe_validator_rejects_duplicate_asset_ids() -> None:
    recipe = build_visual_recipe(
        package_with_pages("产品工作流演示", "录屏展示产品界面"),
        {"assets": [{"path": "materials/screenshots/product-flow.png", "kind": "screenshot"}]},
        "product-demo",
        ROUTING,
        BRANDS,
    )
    recipe = copy.deepcopy(recipe)
    recipe["assets"][1]["id"] = recipe["assets"][0]["id"]

    assert any("duplicate asset id" in error for error in validate_visual_recipe(recipe))


def test_recipe_validator_rejects_platforms_outside_the_active_scope() -> None:
    recipe = build_visual_recipe(
        package_with_pages("产品工作流演示", "录屏展示产品界面"),
        {"assets": [{"path": "materials/screenshots/product-flow.png", "kind": "screenshot"}]},
        "product-demo",
        ROUTING,
        BRANDS,
    )
    recipe = copy.deepcopy(recipe)
    recipe["platforms"]["vi" + "deo"] = {"system": "unsupported"}

    assert any("only wechat, xhs, and optional moments" in error for error in validate_visual_recipe(recipe))


@pytest.mark.parametrize(
    ("path_field", "unsafe_path"),
    [
        ("source_assets", "../../outside.png"),
        ("source_assets", "/tmp/outside.png"),
        ("asset.source", "../../outside.png"),
        ("asset.source", "/tmp/outside.png"),
        ("asset.output", "../../outside.png"),
        ("asset.output", "/tmp/outside.png"),
        ("recipe_path", "pipeline/visual/../other/recipes/r001.visual-recipe.json"),
    ],
)
def test_recipe_validator_rejects_unsafe_asset_and_output_paths(path_field: str, unsafe_path: str) -> None:
    recipe = build_visual_recipe(
        package_with_pages("产品工作流演示", "录屏展示产品界面"),
        {"assets": [{"path": "materials/screenshots/product-flow.png", "kind": "screenshot"}]},
        "product-demo",
        ROUTING,
        BRANDS,
    )
    recipe = copy.deepcopy(recipe)
    if path_field == "source_assets":
        recipe["source_assets"] = [unsafe_path]
    elif path_field == "recipe_path":
        recipe["recipe_path"] = unsafe_path
    else:
        _, field = path_field.split(".", 1)
        recipe["assets"][0][field] = unsafe_path

    assert any("safe project-relative path" in error for error in validate_visual_recipe(recipe))


def test_founder_story_routes_to_editorial_recipe() -> None:
    package = package_with_pages("第一次拿到客户拒绝后的复盘", "我在客户会议结束后，把现场笔记写成了这篇复盘。")
    materials = {"assets": [{"path": "materials/notes/meeting.md", "kind": "document", "role": "source_note"}]}

    recipe = build_visual_recipe(package, materials, "founder-story", ROUTING, BRANDS)

    assert recipe["content_archetype"] == "founder_story"
    assert recipe["platforms"]["wechat"]["system"] == "editorial"
    assert recipe["platforms"]["xhs"]["system"] == "editorial"
    assert recipe["platforms"]["xhs"]["page_recipes"][0] == "M01"


def test_founder_story_allows_explicit_non_factual_concept_pages_without_materials() -> None:
    package = package_with_pages("创始人第一次写内容的复盘", "我把一次客户会议后的判断整理成了内容资产。")
    for page in package["xhs_posts"][0]["pages"]:
        page["image_prompt"] = "概念插图（非事实证据）：用流程图解释判断如何从会议进入内容资产。"

    recipe = build_visual_recipe(package, {"assets": []}, "founder-concept", ROUTING, BRANDS)

    second_page = next(asset for asset in recipe["assets"] if asset["id"] == "xhs-01-p2")
    assert second_page["role"] == "supporting"
    assert second_page["concept_boundary"] == "non_factual"
    assert "source" not in second_page
    assert validate_visual_recipe(recipe) == []


def test_concept_inline_visuals_default_to_the_local_infographic_renderer() -> None:
    routing = {
        "concept": {
            "evidence_mode": "illustration_allowed",
            "wechat_system": "editorial",
            "xhs_system": "editorial",
            "xhs_recipes": ["M01", "M03", "M08", "M11", "M15"],
        },
    }
    package = package_with_pages("一个概念如何变成可执行判断", "这个概念帮助团队理解复杂问题，而不是制造更多术语。")

    recipe = build_visual_recipe(package, {"assets": []}, "concept-local", routing, BRANDS)

    inline = [asset for asset in recipe["assets"] if str(asset.get("id", "")).startswith("inline-")]
    assert inline
    assert all(asset["renderer"] == "baoyu-infographic" for asset in inline)
    assert all(asset["role"] == "inline_visual" for asset in inline)
    assert validate_visual_recipe(recipe) == []


def test_concept_ai_raster_is_an_explicit_optional_enhancement() -> None:
    routing = {
        "concept": {
            "evidence_mode": "illustration_allowed",
            "wechat_system": "editorial",
            "xhs_system": "editorial",
            "xhs_recipes": ["M01", "M03", "M08", "M11", "M15"],
        },
    }
    package = package_with_pages("一个概念如何变成可执行判断", "这个概念帮助团队理解复杂问题，而不是制造更多术语。")
    package["enable_ai_raster_illustrations"] = True

    recipe = build_visual_recipe(package, {"assets": []}, "concept-raster", routing, BRANDS)

    first_inline = next(asset for asset in recipe["assets"] if asset["id"] == "inline-01")
    assert first_inline["renderer"] == "ian-xiaohei-illustrations"
    assert first_inline["role"] == "illustration"


def test_research_recipe_blocks_without_source_backed_evidence() -> None:
    package = package_with_pages("行业研究：客户留存为什么下降", "本研究比较了多个行业的留存变化和竞争对手。")

    with pytest.raises(VisualDirectorError, match="research requires source-backed evidence"):
        build_visual_recipe(package, {"assets": []}, "research", ROUTING, BRANDS)


@pytest.mark.parametrize(
    "asset",
    [
        {"path": "materials/guide.png"},
        {"path": "materials/database.csv"},
        {"path": "materials/brand/guide.png", "kind": "image", "role": "logo"},
    ],
)
def test_bare_path_substrings_do_not_determine_evidence_type(asset: dict) -> None:
    package = {
        "title": "一次内容更新",
        "wechat": {"title": "一次内容更新", "cover_text": "内容更新", "body": "普通说明，没有产品或研究线索。"},
        "xhs_posts": [],
    }

    recipe = build_visual_recipe(package, {"assets": [asset]}, "ambiguous", ROUTING, BRANDS)

    assert recipe["content_archetype"] == "analysis"
    assert not any(item.get("role") == "evidence" for item in recipe["assets"])


@pytest.mark.parametrize(
    "asset",
    [
        {"path": "materials/brand/source-logo.png", "kind": "image", "role": "source_image"},
        {"path": "materials/brand/research-logo.png", "kind": "image", "role": "logo"},
    ],
)
def test_generic_images_do_not_satisfy_research_evidence(asset: dict) -> None:
    package = package_with_pages("行业研究：客户留存为什么下降", "本研究比较多个行业的留存变化。")

    with pytest.raises(VisualDirectorError, match="research requires source-backed evidence"):
        build_visual_recipe(package, {"assets": [asset]}, "research", ROUTING, BRANDS)


@pytest.mark.parametrize(
    ("kind", "role", "path"),
    [
        ("screenshot", "", "materials/evidence/product.png"),
        ("ui_screenshot", "", "materials/evidence/workbench.webp"),
        ("image", "product_ui", "materials/evidence/workflow.jpg"),
    ],
)
def test_explicit_screenshot_types_with_safe_extensions_are_accepted(
    kind: str,
    role: str,
    path: str,
) -> None:
    package = package_with_pages("产品工作流演示", "录屏展示产品界面与客户操作路径")
    asset = {"path": path, "kind": kind, "role": role}

    recipe = build_visual_recipe(package, {"assets": [asset]}, "product-demo", ROUTING, BRANDS)

    assert recipe["content_archetype"] == "product_demo"
    evidence = next(item for item in recipe["assets"] if item["id"] == "xhs-01-p2")
    assert evidence["source"] == path


@pytest.mark.parametrize(
    ("kind", "role", "path"),
    [
        ("dataset", "", "materials/research/retention.csv"),
        ("data_table", "", "materials/research/cohorts.tsv"),
        ("document", "", "materials/research/interviews.md"),
        ("survey", "", "materials/research/responses.json"),
        ("report", "research_source", "materials/research/findings.txt"),
    ],
)
def test_explicit_research_types_with_safe_extensions_are_accepted(
    kind: str,
    role: str,
    path: str,
) -> None:
    package = package_with_pages("行业研究：客户留存为什么下降", "本研究比较多个行业的留存变化。")

    recipe = build_visual_recipe(
        package,
        {"assets": [{"path": path, "kind": kind, "role": role}]},
        "research",
        ROUTING,
        BRANDS,
    )

    assert recipe["content_archetype"] == "research"
    evidence = next(item for item in recipe["assets"] if item["id"] == "xhs-01-p2")
    assert evidence["source"] == path


@pytest.mark.parametrize(
    "asset",
    [
        {"path": "materials/evidence/not-an-image.csv", "kind": "screenshot"},
        {"path": "materials/evidence/not-a-recording.txt", "kind": "recording"},
        {"path": "materials/evidence/demo.mp4", "kind": "screen_recording"},
    ],
)
def test_screenshot_types_reject_unsafe_extensions(asset: dict) -> None:
    package = package_with_pages("产品工作流演示", "录屏展示产品界面与客户操作路径")

    with pytest.raises(VisualDirectorError, match="product demo requires a screenshot"):
        build_visual_recipe(package, {"assets": [asset]}, "product-demo", ROUTING, BRANDS)


@pytest.mark.parametrize(
    "asset",
    [
        {"path": "materials/research/chart.png", "kind": "dataset"},
        {"path": "materials/research/payload.exe", "role": "research_source"},
        {"path": "materials/research/retention.xls", "kind": "dataset"},
        {"path": "materials/research/benchmarks.xlsx", "kind": "benchmark"},
        {"path": "materials/research/findings.pdf", "kind": "report"},
        {"path": "materials/research/interviews.docx", "kind": "document"},
    ],
)
def test_research_types_reject_unsafe_extensions(asset: dict) -> None:
    package = package_with_pages("行业研究：客户留存为什么下降", "本研究比较多个行业的留存变化。")

    with pytest.raises(VisualDirectorError, match="research requires source-backed evidence"):
        build_visual_recipe(package, {"assets": [asset]}, "research", ROUTING, BRANDS)


def test_ambiguous_content_uses_the_general_deterministic_layout_route() -> None:
    package = {
        "title": "一次内容更新",
        "wechat": {"title": "一次内容更新", "cover_text": "内容更新", "body": "这是一段普通说明，没有明确线索。"},
        "xhs_posts": [],
    }

    recipe = build_visual_recipe(package, {"assets": []}, "ambiguous", ROUTING, BRANDS)

    assert recipe["content_archetype"] == "analysis"
    assert next(item for item in recipe["assets"] if item["id"] == "wechat-html")["layout_style"] == "nyt-classic"


def test_page_image_prompts_bind_each_declared_material_before_global_fallback() -> None:
    package = package_with_pages("产品工作流演示", "录屏展示产品界面与客户操作路径")
    pages = package["xhs_posts"][0]["pages"]
    pages[1]["image_prompt"] = "使用 materials/screenshots/detail.png 展示设置页"
    pages[2]["image_prompt"] = "使用 materials/screenshots/result.webp 展示结果页"
    materials = {
        "assets": [
            {"path": "materials/screenshots/overview.png", "kind": "screenshot"},
            {"path": "materials/screenshots/detail.png", "kind": "ui_screenshot"},
            {"path": "materials/screenshots/result.webp", "role": "product_ui"},
        ]
    }

    recipe = build_visual_recipe(package, materials, "product-demo", ROUTING, BRANDS)

    by_id = {asset["id"]: asset for asset in recipe["assets"]}
    assert by_id["xhs-01-p2"]["source"] == "materials/screenshots/detail.png"
    assert by_id["xhs-01-p3"]["source"] == "materials/screenshots/result.webp"
    assert by_id["xhs-01-p4"].get("source") is None


@pytest.mark.parametrize(
    ("prompt", "expected_error"),
    [
        ("使用 materials/screenshots/missing.png 展示结果", "not present in materials.assets"),
        ("使用 materials/research/retention.csv 展示产品", "incompatible with screenshot_first"),
    ],
)
def test_page_image_prompt_rejects_unknown_or_wrong_type_material(
    prompt: str,
    expected_error: str,
) -> None:
    package = package_with_pages("产品工作流演示", "录屏展示产品界面与客户操作路径")
    package["xhs_posts"][0]["pages"][1]["image_prompt"] = prompt
    materials = {
        "assets": [
            {"path": "materials/screenshots/overview.png", "kind": "screenshot"},
            {"path": "materials/research/retention.csv", "kind": "dataset"},
        ]
    }

    with pytest.raises(VisualDirectorError, match=expected_error):
        build_visual_recipe(package, materials, "product-demo", ROUTING, BRANDS)


def test_recipe_ids_advance_without_overwriting_existing_revisions(tmp_path: Path) -> None:
    recipes = tmp_path / "recipes"
    recipes.mkdir()
    (recipes / "r001.visual-recipe.json").write_text("{}", encoding="utf-8")
    (recipes / "r009.visual-recipe.json").write_text("{}", encoding="utf-8")

    assert next_recipe_id(recipes.glob("*.visual-recipe.json")) == "r010"


def test_recipe_builder_does_not_add_a_wall_clock_value() -> None:
    package = package_with_pages("产品工作流演示", "录屏展示产品界面与客户操作路径")
    materials = {
        "assets": [
            {"path": "materials/screenshots/product-flow.png", "kind": "screenshot", "role": "product_ui"}
        ]
    }

    recipe = build_visual_recipe(package, materials, "product-demo", ROUTING, BRANDS)

    assert "created_at" not in recipe


def test_recipe_is_deterministic_for_the_same_package_materials_and_profile() -> None:
    package = package_with_pages("产品工作流演示", "录屏展示产品界面与客户操作路径")
    materials = {
        "assets": [
            {"path": "materials/screenshots/product-flow.png", "kind": "screenshot", "role": "product_ui"}
        ]
    }

    first = build_visual_recipe(package, materials, "product-demo", ROUTING, BRANDS)
    second = build_visual_recipe(package, materials, "product-demo", ROUTING, BRANDS)

    assert first == second


def test_canonical_archetypes_choose_three_distinct_recipe_sequences() -> None:
    product = build_visual_recipe(
        package_with_pages("产品工作流演示", "录屏展示产品界面"),
        {"assets": [{"path": "materials/screenshots/product-flow.png", "kind": "screenshot"}]},
        "product-demo", ROUTING, BRANDS,
    )
    founder = build_visual_recipe(
        package_with_pages("第一次客户会议复盘", "我在客户会议后整理现场笔记"),
        {"assets": [{"path": "materials/notes/meeting.md", "kind": "document"}]},
        "founder-story", ROUTING, BRANDS,
    )
    research = build_visual_recipe(
        package_with_pages("行业研究：留存为什么下降", "本研究比较了行业留存数据"),
        {"assets": [{"path": "materials/research/retention.csv", "kind": "dataset"}]},
        "research", ROUTING, BRANDS,
    )

    sequences = {
        tuple(product["platforms"]["xhs"]["page_recipes"]),
        tuple(founder["platforms"]["xhs"]["page_recipes"]),
        tuple(research["platforms"]["xhs"]["page_recipes"]),
    }
    assert len(sequences) == 3
