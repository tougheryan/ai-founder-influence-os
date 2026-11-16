from __future__ import annotations

import json
import copy
import hashlib
import shutil
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
TESTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "tests"
for directory in (SCRIPTS_DIR, TESTS_DIR):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from content_runtime import ContentRuntime  # noqa: E402
from minimal_loop_acceptance import check_recipe_visual_release, resolve_selected_visual_index, run_acceptance  # noqa: E402
from visual_test_fixtures import write_acceptance_complete_fixture, write_acceptance_visual_publish  # noqa: E402
from visual_quality import audit_rendered_visual_index, audit_visual_golden_sample  # noqa: E402


def clean_validator_report() -> str:
    return """==== validate-social-deck ====
[PASS]  xhs-01-p1 · xhs
[PASS]  xhs-01-p2 · xhs
[PASS]  xhs-01-p3 · xhs
[PASS]  xhs-01-p4 · xhs
[PASS]  xhs-01-p5 · xhs
Legend: R1 overflow · R2 footer collision · R3 swiss bold display · R4 min font · R5 4-band density
"""


def recipe_index() -> dict:
    layouts = ["S01", "S08", "S06", "S10", "S12"]
    outputs = []
    assets = []
    for page, layout in enumerate(layouts, start=1):
        asset_id = f"xhs-01-p{page}"
        evidence = page == 2
        outputs.append({
            "id": asset_id,
            "kind": "xhs_card",
            "width": 1080,
            "height": 1440,
            "layout_recipe": layout,
            "evidence_sources": ["materials/screenshots/product-flow.png"] if evidence else [],
            "evidence_ratio": 0.45 if evidence else 0,
            "evidence_kind": "image" if evidence else "",
            "evidence_detail_score": 0.35 if evidence else None,
        })
        assets.append({
            "id": asset_id,
            "platform": "xhs",
            "role": "evidence" if evidence else "supporting",
            "layout_recipe": layout,
            "source": "materials/screenshots/product-flow.png" if evidence else "",
        })
    return {
        "legacy": False,
        "recipe_path": "pipeline/visual/demo/recipes/r001.visual-recipe.json",
        "revision_id": "r001",
        "content_archetype": "product_demo",
        "evidence_mode": "screenshot_first",
        "quality_policy": {"min_density": 0.62, "require_evidence_ratio": 0.4},
        "recipe_assets": assets,
        "outputs": outputs,
    }


def golden_sample_index() -> dict:
    outputs = []
    asset_ids = [
        "wechat-cover",
        "wechat-share",
        "wechat-cover-alt-01",
        "wechat-share-alt-01",
        "wechat-cover-alt-02",
        "wechat-share-alt-02",
        "inline-01",
        "inline-02",
        *[f"xhs-{post:02d}-p{page}" for post in range(1, 4) for page in range(1, 6)],
    ]
    for index, asset_id in enumerate(asset_ids, start=1):
        outputs.append({
            "id": asset_id,
            "kind": "inline_image" if asset_id.startswith("inline-") else ("xhs_card" if asset_id.startswith("xhs-") else "wechat_cover"),
            "format": "PNG",
            "sha256": f"render-{index:02d}",
            "evidence_sources": ["materials/customer-interview.md"] if asset_id == "xhs-01-p2" else [],
        })
    return {
        "brand_profile": "echo-founder",
        "source_assets": ["materials/customer-interview.md"],
        "quality_tools": ["skills/xhs-card/validate-social-deck.mjs"],
        "quality_summary": {"status": "pass"},
        "golden_sample_standard": {
            "schema": "echo-founder.visual-golden-sample.v1",
            "required_wechat_directions": 3,
            "required_inline_visuals_min": 2,
            "required_share_series": 3,
            "required_pages_per_series": 5,
            "require_source_backed_evidence_when_available": True,
            "require_distinct_render_hashes": True,
            "require_mobile_preview": True,
        },
        "outputs": outputs,
    }


def test_golden_sample_readiness_requires_the_complete_echo_founder_reference_set() -> None:
    index = golden_sample_index()

    ready = audit_visual_golden_sample(index)
    index["outputs"] = [output for output in index["outputs"] if output["id"] != "inline-02"]
    incomplete = audit_visual_golden_sample(index)

    assert ready["status"] == "ready"
    assert ready["standard_schema"] == "echo-founder.visual-golden-sample.v1"
    assert incomplete["status"] == "not_ready"
    assert incomplete["checks"]["inline_semantics"] == "blocked"


def test_native_golden_sample_uses_wechat_html_and_one_p1_to_p8_series() -> None:
    outputs = [{"id": "wechat-html", "format": "HTML", "sha256": "wechat-html"}]
    outputs.extend({
        "id": f"xhs-01-p{page}",
        "format": "PNG",
        "sha256": f"page-{page}",
        "evidence_sources": ["materials/source.md"] if page == 2 else [],
    } for page in range(1, 9))
    index = {
        "brand_profile": "echo-founder",
        "source_assets": ["materials/source.md"],
        "quality_tools": ["skills/xhs-card/validate-social-deck.mjs"],
        "quality_summary": {"status": "pass"},
        "golden_sample_standard": golden_sample_index()["golden_sample_standard"],
        "platforms": {
            "wechat": {"asset_ids": ["wechat-html"]},
            "xhs": {"platform_bindings": ["xiaohongshu"]},
        },
        "outputs": outputs,
    }

    result = audit_visual_golden_sample(index)

    assert result["status"] == "ready"
    assert result["checks"]["wechat_directions"] == "not_applicable"
    assert result["checks"]["inline_semantics"] == "not_applicable"


def test_low_density_r5_warning_blocks_recipe_visual_release() -> None:
    result = audit_rendered_visual_index(
        recipe_index(),
        "[WARN] xhs-01-p2 · xhs\n  WARN · R5 density 36% (bands 20% / 36% / 48% / 40%)",
    )

    assert result["status"] == "blocked"
    assert result["checks"]["density"] == "blocked"
    assert "density 36% is below 62%" in result["errors"][0]


def test_native_density_replacement_requires_bound_measurements_and_keeps_other_assets_blocked() -> None:
    index = recipe_index()
    index['recipe_schema'] = 'aifios.visual-recipe.v2'
    output = index['outputs'][0]
    output['expected_text'] = '确认范围 先确认范围，再讨论费用。'
    output['copy_fidelity'] = {'status': 'pass', 'field_count': 2, 'errors': []}
    output['native_layout'] = {
        'schema': 'echo-founder.native-card-layout.v1', 'status': 'pass', 'errors': [],
        'mode': 'text', 'overlapping': False, 'short_copy': True,
        'width': 1080, 'height': 1440, 'field_count': 2,
        'text_span': 420, 'safe_margin': 76,
        'copy_sha256': hashlib.sha256(output['expected_text'].encode()).hexdigest(),
        'fields': [
            {'role': 'title', 'font_size': 60, 'contrast': 5.2, 'opacity': 1},
            {'role': 'body', 'font_size': 112, 'contrast': 16, 'opacity': 1},
        ],
    }
    report = clean_validator_report().replace('[PASS]  xhs-01-p1 · xhs', '[WARN] xhs-01-p1 · xhs\n WARN · R5 density 32% (bands 0% / 40% / 80% / 8%)')
    measured = audit_rendered_visual_index(index, report)
    assert measured['checks']['native_text_layout'] == 'pass'
    assert not any('xhs-01-p1 density' in error for error in measured['errors'])
    other = audit_rendered_visual_index(index, report.replace('[PASS]  xhs-01-p2 · xhs', '[WARN] xhs-01-p2 · xhs\n WARN · R5 density 10%'))
    assert other['checks']['density'] == 'blocked'
    assert any('xhs-01-p2 density' in error for error in other['errors'])
    for mutation in ['copy', 'size', 'margin', 'overlap', 'status-only', 'non-native']:
        changed = copy.deepcopy(index)
        item = changed['outputs'][0]
        if mutation == 'copy': item['expected_text'] += '未经检查的新文字'
        elif mutation == 'size': item['native_layout']['fields'][1]['font_size'] = 10
        elif mutation == 'margin': item['native_layout']['safe_margin'] = 0
        elif mutation == 'overlap': item['native_layout']['overlapping'] = True
        elif mutation == 'status-only': item['native_layout'] = {'mode': 'text', 'status': 'pass'}
        else: changed['recipe_schema'] = 'aifios.visual-recipe.v1'
        rejected = audit_rendered_visual_index(changed, report)
        assert rejected['checks']['native_text_layout'] == 'blocked', mutation
        assert rejected['checks']['density'] == 'blocked', mutation


def test_evidence_required_asset_without_rendered_source_blocks_release() -> None:
    index = recipe_index()
    evidence = next(item for item in index["outputs"] if item["id"] == "xhs-01-p2")
    evidence["evidence_sources"] = []

    result = audit_rendered_visual_index(index, clean_validator_report())

    assert result["status"] == "blocked"
    assert result["checks"]["evidence"] == "blocked"
    assert "xhs-01-p2" in result["errors"][0]
    assert "evidence" in result["errors"][0]


def test_evidence_visual_area_below_recipe_ratio_blocks_release() -> None:
    index = recipe_index()
    evidence = next(item for item in index["outputs"] if item["id"] == "xhs-01-p2")
    evidence["evidence_ratio"] = 0.25

    result = audit_rendered_visual_index(index, clean_validator_report())

    assert result["status"] == "blocked"
    assert result["checks"]["evidence"] == "blocked"
    assert "25%" in " ".join(result["errors"])
    assert "40%" in " ".join(result["errors"])


def test_near_blank_image_evidence_blocks_release_even_when_its_area_is_large() -> None:
    index = recipe_index()
    evidence = next(item for item in index["outputs"] if item["id"] == "xhs-01-p2")
    evidence["evidence_ratio"] = 0.72
    evidence["evidence_detail_score"] = 0.01

    result = audit_rendered_visual_index(index, clean_validator_report())

    assert result["status"] == "blocked"
    assert result["checks"]["evidence"] == "pass"
    assert result["checks"]["evidence_detail"] == "blocked"
    assert "visual detail 1% < 8%" in " ".join(result["errors"])


def test_ai_raster_ocr_mismatch_blocks_but_svg_text_layer_is_allowed() -> None:
    index = recipe_index()
    raster = {
        "id": "inline-ai",
        "kind": "inline_image",
        "provider": "baoyu-comic",
        "format": "PNG",
        "ai_generated": True,
        "ocr_text": "客户增长 99%",
        "expected_text": "客户增长 42%",
        "evidence_sources": [],
    }
    index["outputs"].append(raster)

    blocked = audit_rendered_visual_index(index, clean_validator_report())

    assert blocked["status"] == "blocked"
    assert blocked["checks"]["ocr_text"] == "blocked"
    assert "99" in " ".join(blocked["errors"])

    raster["source_svg"] = "pipeline/visual/demo/inline/inline-ai.svg"
    allowed = audit_rendered_visual_index(index, clean_validator_report())
    assert allowed["checks"]["ocr_text"] == "pass"


def test_density_requires_a_complete_validator_report() -> None:
    index = recipe_index()
    index["density_warnings"] = []

    missing = audit_rendered_visual_index(index, "")
    partial = audit_rendered_visual_index(index, "[PASS] xhs-01-p1 · xhs")

    assert missing["checks"]["density"] == "blocked"
    assert partial["checks"]["density"] == "blocked"
    assert "complete" in " ".join(missing["errors"] + partial["errors"]).lower()


def test_duplicate_density_report_is_counted_once_with_the_correct_asset() -> None:
    index = recipe_index()
    report = "[WARN] xhs-01-p2 · xhs\n  WARN · R5 density 36% (bands 20% / 36% / 48% / 40%)"
    index["render_quality_report"] = report
    index["density_warnings"] = ["WARN · R5 density 36% (bands 20% / 36% / 48% / 40%)"]

    result = audit_rendered_visual_index(index, report)

    density_errors = [item for item in result["errors"] if "density" in item]
    assert density_errors == ["xhs-01-p2 density 36% is below 62%"]


def test_duplicate_xhs_layouts_require_explicit_repeated_series() -> None:
    index = recipe_index()
    for item in index["outputs"]:
        item["layout_recipe"] = "S01"

    result = audit_rendered_visual_index(index, clean_validator_report())

    assert result["status"] == "blocked"
    assert result["checks"]["layout_diversity"] == "blocked"
    assert "S01" in result["errors"][0]
    assert "repeated series" in result["errors"][0]


def test_explicit_repeated_series_is_allowed() -> None:
    index = recipe_index()
    for item in index["outputs"]:
        item["layout_recipe"] = "S01"
    index["platforms"] = {"xhs": {"repeated_series": True}}

    result = audit_rendered_visual_index(index, clean_validator_report())

    assert result["status"] == "pass", result
    assert result["checks"]["layout_diversity"] == "pass"


def test_identical_wechat_share_directions_block_release() -> None:
    index = recipe_index()
    for asset_id in ("wechat-share", "wechat-share-alt-01", "wechat-share-alt-02"):
        index["outputs"].append({
            "id": asset_id,
            "kind": "wechat_cover",
            "width": 1080,
            "height": 1080,
            "output": f"pipeline/visual/demo/{asset_id}.png",
            "sha256": "same-rendered-image",
        })

    result = audit_rendered_visual_index(index, clean_validator_report())

    assert result["status"] == "blocked"
    assert result["checks"]["asset_differentiation"] == "blocked"
    assert "wechat share directions" in " ".join(result["errors"])


def test_selected_recipe_release_requires_metadata_and_persisted_quality_summary(tmp_path: Path) -> None:
    index = recipe_index()
    index.pop("recipe_path")
    index.pop("revision_id")

    missing_metadata = check_recipe_visual_release(tmp_path, index)

    assert missing_metadata["status"] == "blocked"
    assert any("recipe_path" in error for error in missing_metadata["errors"])
    assert any("revision_id" in error for error in missing_metadata["errors"])

    index = recipe_index()
    recipe_path = tmp_path / index["recipe_path"]
    recipe_path.parent.mkdir(parents=True)
    recipe_path.write_text(
        json.dumps({
            "revision_id": "r001",
            "quality_policy": index["quality_policy"],
            "assets": index["recipe_assets"],
            "platforms": {"xhs": {"page_recipes": [item["layout_recipe"] for item in index["outputs"]]}},
            "content_archetype": "product_demo",
            "evidence_mode": "screenshot_first",
        }),
        encoding="utf-8",
    )
    index["render_quality_report"] = clean_validator_report()

    missing_summary = check_recipe_visual_release(tmp_path, index)

    assert missing_summary["status"] == "blocked"
    assert any("quality_summary" in error for error in missing_summary["errors"])

    index["quality_summary"] = audit_rendered_visual_index(index, clean_validator_report())
    accepted = check_recipe_visual_release(tmp_path, index)

    assert accepted["status"] == "pass", accepted
    assert accepted["checks"]["quality_summary"] == "pass"


def test_legacy_visual_index_stays_reviewable_without_recipe_requirements(tmp_path: Path) -> None:
    result = check_recipe_visual_release(tmp_path, {"outputs": []})

    assert result["status"] == "review_required"
    assert result["legacy"] is True
    assert result["checks"]["recipe"] == "legacy"


def test_acceptance_rejects_legacy_visual_index(tmp_path: Path) -> None:
    runtime = write_acceptance_complete_fixture(tmp_path, slug="legacy-release")
    visual_root = tmp_path / "pipeline" / "visual" / "legacy-release"
    shutil.rmtree(visual_root / "revisions")
    (visual_root / "selected-revision.json").unlink()
    write_acceptance_visual_publish(tmp_path, runtime, "legacy-release", recipe_release=False)

    result = run_acceptance(tmp_path, "legacy-release")

    assert result["status"] == "blocked"
    assert result["blocked_step"] == "visual"
    assert "recipe" in result["reason"].lower()


def test_selected_recipe_pointer_overrides_latest_publish_index(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    write_acceptance_visual_publish(tmp_path, runtime, "demo", recipe_release=True)
    r001 = json.loads(
        (tmp_path / "pipeline" / "visual" / "demo" / "revisions" / "r001.index.json").read_text(encoding="utf-8")
    )
    r002 = {"slug": "demo", "revision_id": "r002", "outputs": []}

    result = resolve_selected_visual_index(
        tmp_path,
        "demo",
        "pipeline/visual/demo/publish/index.json",
        r002,
    )

    assert result == ("pipeline/visual/demo/revisions/r001.index.json", r001)


def test_recipe_release_requires_an_explicit_adopted_revision(tmp_path: Path) -> None:
    fallback = {"slug": "demo", "revision_id": "r002", "outputs": []}

    result = resolve_selected_visual_index(
        tmp_path,
        "demo",
        "pipeline/visual/demo/publish/index.json",
        fallback,
    )

    assert isinstance(result, dict)
    assert result["status"] == "blocked"
    assert "采用" in result["reason"]


def test_minimal_gate_rejects_an_unbound_selection_pointer(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    write_acceptance_visual_publish(tmp_path, runtime, "demo", recipe_release=True)
    pointer = tmp_path / "pipeline" / "visual" / "demo" / "selected-revision.json"
    pointer.write_text(json.dumps({
        "schema": "aifios.visual-selection.v1",
        "slug": "demo",
        "revision_id": "r001",
    }), encoding="utf-8")
    fallback = json.loads(
        (tmp_path / "pipeline" / "visual" / "demo" / "revisions" / "r001.index.json").read_text(encoding="utf-8")
    )

    result = resolve_selected_visual_index(
        tmp_path,
        "demo",
        "pipeline/visual/demo/publish/index.json",
        fallback,
    )

    assert isinstance(result, dict)
    assert result["status"] == "blocked"
    assert "integrity" in result["reason"]


def test_wechat_only_layout_does_not_require_an_unselected_xhs_evidence_page() -> None:
    index = recipe_index()
    index['platforms'] = {'wechat': {'asset_ids': ['wechat-html']}}
    index['recipe_assets'] = [{'id': 'wechat-html', 'platform': 'wechat', 'role': 'article'}]
    index['outputs'] = [{'id': 'wechat-html', 'kind': 'wechat_html'}]
    result = audit_rendered_visual_index(index, render_html="")
    assert result['checks']['evidence'] == 'pass'
    assert not any('XHS evidence page' in error for error in result['errors'])

    # Declared WeChat evidence is still mandatory even without Xiaohongshu.
    index['recipe_assets'].append({'id': 'inline-proof', 'platform': 'wechat', 'role': 'evidence'})
    result = audit_rendered_visual_index(index, render_html="")
    assert result['checks']['evidence'] == 'blocked'
    assert 'evidence-required asset inline-proof was not rendered' in result['errors']


def test_dual_platform_or_unknown_scope_still_requires_xhs_evidence() -> None:
    for platforms in ({'wechat': {}, 'xhs': {}}, {}):
        index = recipe_index()
        index['platforms'] = platforms
        index['recipe_assets'] = [{'id': 'wechat-html', 'platform': 'wechat', 'role': 'article'}]
        index['outputs'] = [{'id': 'wechat-html', 'kind': 'wechat_html'}]
        result = audit_rendered_visual_index(index, render_html="")
        assert result['checks']['evidence'] == 'blocked'
        assert 'recipe requires an evidence asset but no XHS evidence page was rendered' in result['errors']
