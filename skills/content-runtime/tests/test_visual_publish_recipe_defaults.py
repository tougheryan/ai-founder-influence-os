from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
TESTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "tests"
for directory in (SCRIPTS_DIR, TESTS_DIR):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from content_runtime import ContentRuntime  # noqa: E402
from visual_test_fixtures import VALID_PACKAGE_BODY  # noqa: E402
from visual_publish import VisualOutputError, generate_publish_outputs  # noqa: E402


def test_publish_builds_and_records_r001_recipe_from_project_materials(tmp_path: Path) -> None:
    project = tmp_path / "recipe-default"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "recipe-default", VALID_PACKAGE_BODY, source="test")
    screenshot = project / "materials" / "screenshots" / "product-flow.png"
    screenshot.parent.mkdir(parents=True)
    screenshot.write_bytes(b"evidence")

    result = generate_publish_outputs(
        project=project,
        slug="recipe-default",
        package_path=Path(package["path"]),
        renderer="fake",
        write_runtime_record=False,
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    recipe_path = project / index["recipe_path"]
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))

    assert index["legacy"] is False
    assert index["revision_id"] == "r001"
    assert index["quality_summary"]["status"] == "blocked"
    assert index["quality_summary"]["checks"]["density"] == "blocked"
    assert index["quality_policy"]["min_density"] == 0.68
    assert recipe["brand_profile"] == "echo-founder"
    assert recipe["brand_system"]["tokens"]["colors"]["accent"] == "#E85D4C"
    assert recipe["platforms"]["wechat"]["selection_scorecard"]["minimum_score"] == 80
    assert index["golden_sample_readiness"]["status"] in {"ready", "not_ready"}
    assert not (project / "pipeline" / "visual" / "recipe-default" / "selected-revision.json").exists()
    assert recipe_path.name == "r001.visual-recipe.json"
    assert recipe["revision_id"] == "r001"
    assert recipe["source_assets"] == ["materials/screenshots/product-flow.png"]
    evidence = next(item for item in index["outputs"] if item["id"] == "xhs-01-p2")
    assert evidence["evidence_sources"] == ["materials/screenshots/product-flow.png"]


def test_publish_allows_founder_story_with_explicit_non_factual_pages_without_material_evidence(tmp_path: Path) -> None:
    project = tmp_path / "recipe-legacy"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "recipe-legacy", VALID_PACKAGE_BODY, source="test")

    result = generate_publish_outputs(
        project=project,
        slug="recipe-legacy",
        package_path=Path(package["path"]),
        renderer="fake",
        write_runtime_record=False,
    )

    visual_root = project / "pipeline" / "visual" / "recipe-legacy"
    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    recipe = json.loads((project / index["recipe_path"]).read_text(encoding="utf-8"))
    assert recipe["content_archetype"] == "founder_story"
    assert recipe["evidence_mode"] == "artifact_first"
    assert recipe["source_assets"] == []
    assert (visual_root / "publish" / "r001").exists()
    assert (visual_root / "recipes" / "r001.visual-recipe.json").exists()
    assert any(output["id"] == "inline-01" for output in index["outputs"])
    assert not (visual_root / "selected-revision.json").exists()


def test_default_recipe_never_writes_through_an_external_recipe_directory_symlink(tmp_path: Path) -> None:
    project = tmp_path / "recipe-symlink-boundary"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "recipe-symlink-boundary", VALID_PACKAGE_BODY, source="test")
    screenshot = project / "materials" / "screenshots" / "product-flow.png"
    screenshot.parent.mkdir(parents=True)
    screenshot.write_bytes(b"evidence")
    outside = tmp_path / "outside"
    outside.mkdir()
    recipes = project / "pipeline" / "visual" / "recipe-symlink-boundary" / "recipes"
    recipes.parent.mkdir(parents=True)
    recipes.symlink_to(outside, target_is_directory=True)

    with pytest.raises(VisualOutputError, match="boundary must be inside the project"):
        generate_publish_outputs(
            project=project,
            slug="recipe-symlink-boundary",
            package_path=Path(package["path"]),
            renderer="fake",
            write_runtime_record=False,
        )

    assert not (outside / "r001.visual-recipe.json").exists()


def test_default_recipe_rejects_an_external_selected_revision_pointer_before_reading_it(tmp_path: Path) -> None:
    project = tmp_path / "selection-symlink-boundary"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "selection-symlink-boundary", VALID_PACKAGE_BODY, source="test")
    screenshot = project / "materials" / "screenshots" / "product-flow.png"
    screenshot.parent.mkdir(parents=True)
    screenshot.write_bytes(b"evidence")
    recipes = project / "pipeline" / "visual" / "selection-symlink-boundary" / "recipes"
    recipes.mkdir(parents=True)
    outside_selection = tmp_path / "outside-selected-revision.json"
    outside_selection.write_text(json.dumps({"revision_id": "r001"}), encoding="utf-8")
    selection = recipes.parent / "selected-revision.json"
    selection.symlink_to(outside_selection)

    with pytest.raises(VisualOutputError, match="selected revision pointer boundary"):
        generate_publish_outputs(
            project=project,
            slug="selection-symlink-boundary",
            package_path=Path(package["path"]),
            renderer="fake",
            write_runtime_record=False,
        )

    assert json.loads(outside_selection.read_text(encoding="utf-8")) == {"revision_id": "r001"}
    assert not list(recipes.glob("*.visual-recipe.json"))


def test_explicit_final_recipe_symlink_is_rejected_before_json_is_read(tmp_path: Path) -> None:
    project = tmp_path / "final-recipe-symlink-boundary"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "final-recipe-symlink-boundary", VALID_PACKAGE_BODY, source="test")
    borrowed = project / "materials" / "borrowed-recipe.json"
    borrowed.parent.mkdir(parents=True, exist_ok=True)
    borrowed.write_text("{not-json", encoding="utf-8")
    recipe_path = project / "pipeline" / "visual" / "final-recipe-symlink-boundary" / "recipes" / "r001.visual-recipe.json"
    recipe_path.parent.mkdir(parents=True)
    recipe_path.symlink_to(borrowed)

    with pytest.raises(VisualOutputError, match="recipe path must be inside"):
        generate_publish_outputs(
            project=project,
            slug="final-recipe-symlink-boundary",
            package_path=Path(package["path"]),
            recipe_path=recipe_path,
            renderer="fake",
            write_runtime_record=False,
        )

    assert not (project / "pipeline" / "visual" / "final-recipe-symlink-boundary" / "publish").exists()


def test_recipe_revisions_keep_isolated_output_and_index_records(tmp_path: Path) -> None:
    project = tmp_path / "versioned-render"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "versioned-render", VALID_PACKAGE_BODY, source="test")
    source = project / "materials" / "screenshots" / "product-flow.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"evidence")

    def recipe(revision_id: str, parent_revision_id: str | None = None) -> dict:
        assets = [
            {"id": "wechat-html", "platform": "wechat", "role": "article", "layout_recipe": "html", "renderer": "dbs-wechat-html", "status": "planned"},
            {"id": "wechat-cover", "platform": "wechat", "role": "cover", "layout_recipe": "S01", "renderer": "xhs-card", "status": "planned"},
            {"id": "wechat-share", "platform": "wechat", "role": "share", "layout_recipe": "S01", "renderer": "xhs-card", "status": "planned"},
        ]
        for page in range(1, 6):
            assets.append({
                "id": f"xhs-01-p{page}",
                "platform": "xhs",
                "role": "evidence" if page == 2 else ("cover" if page == 1 else "supporting"),
                "layout_recipe": ["S01", "S08", "S06", "S10", "S12"][page - 1],
                "renderer": "xhs-card",
                "status": "planned",
                **({"source": "materials/screenshots/product-flow.png"} if page == 2 else {}),
            })
        value = {
            "schema": "aifios.visual-recipe.v1",
            "revision_id": revision_id,
            "slug": "versioned-render",
            "source_package": "pipeline/package/versioned-render.md",
            "content_archetype": "product_demo",
            "evidence_mode": "screenshot_first",
            "platforms": {
                "wechat": {"system": "swiss", "asset_ids": ["wechat-html", "wechat-cover", "wechat-share"]},
                "xhs": {"system": "swiss", "page_recipes": ["S01", "S08", "S06", "S10", "S12"], "asset_ids": [f"xhs-01-p{page}" for page in range(1, 6)]},
            },
            "assets": assets,
            "quality_policy": {"min_density": 0.62, "require_evidence_ratio": 0.4},
        }
        if parent_revision_id:
            value["parent_revision_id"] = parent_revision_id
        return value

    recipes = project / "pipeline" / "visual" / "versioned-render" / "recipes"
    recipes.mkdir(parents=True)
    r001 = recipes / "r001.visual-recipe.json"
    r002 = recipes / "r002.visual-recipe.json"
    r001.write_text(json.dumps(recipe("r001"), ensure_ascii=False), encoding="utf-8")
    r002.write_text(json.dumps(recipe("r002", "r001"), ensure_ascii=False), encoding="utf-8")

    first = generate_publish_outputs(project, "versioned-render", Path(package["path"]), r001, renderer="fake", write_runtime_record=False)
    second = generate_publish_outputs(project, "versioned-render", Path(package["path"]), r002, renderer="fake", write_runtime_record=False)

    first_index = json.loads((project / "pipeline" / "visual" / "versioned-render" / "revisions" / "r001.index.json").read_text(encoding="utf-8"))
    second_index = json.loads((project / "pipeline" / "visual" / "versioned-render" / "revisions" / "r002.index.json").read_text(encoding="utf-8"))
    assert first_index["revision_id"] == "r001"
    assert second_index["revision_id"] == "r002"
    assert first_index["outputs"][1]["output"].startswith("pipeline/visual/versioned-render/publish/r001/")
    assert second_index["outputs"][1]["output"].startswith("pipeline/visual/versioned-render/publish/r002/")
    assert (project / first_index["outputs"][1]["output"]).exists()
    assert Path(second["index_path"]).exists()
    assert Path(first["index_path"]).exists()
