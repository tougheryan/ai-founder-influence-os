from __future__ import annotations

import json
import inspect
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
from visual_publish import VisualOutputError, _project_material_assets, generate_publish_outputs  # noqa: E402


def test_publish_defaults_to_the_real_local_renderer() -> None:
    renderer = inspect.signature(generate_publish_outputs).parameters["renderer"]
    assert renderer.default == "local"


def test_material_scan_excludes_assets_owned_by_other_runs(tmp_path: Path) -> None:
    project = tmp_path / "run-scoped-materials"
    current = project / "materials" / "intake" / "current-note.md"
    stale = project / "materials" / "research" / "stale-benchmark.json"
    current.parent.mkdir(parents=True)
    stale.parent.mkdir(parents=True)
    current.write_text("current", encoding="utf-8")
    stale.write_text("{}", encoding="utf-8")
    session = project / "sessions" / "material-analysis" / "current-run.json"
    session.parent.mkdir(parents=True)
    session.write_text(
        json.dumps({"input": {"files": [{"sourcePath": "materials/intake/current-note.md"}]}}),
        encoding="utf-8",
    )

    assets = _project_material_assets(project, "current-run")["assets"]

    assert [asset["path"] for asset in assets] == ["materials/intake/current-note.md"]


def test_publish_builds_and_records_default_recipe_from_project_materials(tmp_path: Path) -> None:
    project = tmp_path / "default-recipe"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "product-demo", VALID_PACKAGE_BODY, source="test")
    screenshot = project / "materials" / "screenshots" / "product-flow.png"
    screenshot.parent.mkdir(parents=True)
    screenshot.write_bytes(b"fixture-image")

    result = generate_publish_outputs(
        project=project,
        slug="product-demo",
        package_path=Path(package["path"]),
        renderer="fake",
        write_runtime_record=False,
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    recipe_path = project / index["recipe_path"]
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    assert index["legacy"] is False
    assert index["revision_id"] == "r001"
    assert recipe["content_archetype"] == "product_demo"
    evidence = next(item for item in recipe["assets"] if item["id"] == "xhs-01-p2")
    assert evidence["source"] == "materials/screenshots/product-flow.png"


def test_research_default_recipe_rejects_generic_image_evidence_without_legacy_output(tmp_path: Path) -> None:
    project = tmp_path / "research-generic-image"
    runtime = ContentRuntime(project)
    runtime.init()
    research_body = VALID_PACKAGE_BODY.replace(
        "# 最终内容 · 视觉测试",
        "# 行业研究：客户留存为什么下降\n\n本研究比较多个行业的客户留存变化。",
        1,
    )
    package = runtime.write("package", "research-generic-image", research_body, source="test")
    logo = project / "materials" / "brand" / "source-logo.png"
    logo.parent.mkdir(parents=True)
    logo.write_bytes(b"generic image")

    with pytest.raises(VisualOutputError, match="visual recipe blocked: research requires source-backed evidence"):
        generate_publish_outputs(
            project=project,
            slug="research-generic-image",
            package_path=Path(package["path"]),
            renderer="fake",
            write_runtime_record=False,
        )

    visual_root = project / "pipeline" / "visual" / "research-generic-image"
    assert not (visual_root / "recipes").exists()
    assert not (visual_root / "publish").exists()


@pytest.mark.parametrize("filename", ["guide.png", "flower.png", "recordkeeping.png", "widescreen.png"])
def test_default_material_scan_requires_bounded_product_ui_signals(tmp_path: Path, filename: str) -> None:
    project = tmp_path / "research-guide-image"
    runtime = ContentRuntime(project)
    runtime.init()
    research_body = VALID_PACKAGE_BODY.replace(
        "# 最终内容 · 视觉测试",
        "# 行业研究：客户留存为什么下降\n\n本研究比较多个行业的客户留存变化。",
        1,
    )
    package = runtime.write("package", "research-guide-image", research_body, source="test")
    image = project / "materials" / filename
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"generic image")

    with pytest.raises(VisualOutputError, match="visual recipe blocked: research requires source-backed evidence"):
        generate_publish_outputs(
            project=project,
            slug="research-guide-image",
            package_path=Path(package["path"]),
            renderer="fake",
            write_runtime_record=False,
        )

    visual_root = project / "pipeline" / "visual" / "research-guide-image"
    assert not (visual_root / "recipes").exists()
    assert not (visual_root / "publish").exists()


@pytest.mark.parametrize("filename", ["retention.xls", "retention.xlsx", "findings.pdf", "interviews.docx"])
def test_default_material_scan_does_not_declare_unparsed_research_formats(
    tmp_path: Path,
    filename: str,
) -> None:
    project = tmp_path / "unsupported-research-format"
    runtime = ContentRuntime(project)
    runtime.init()
    research_body = VALID_PACKAGE_BODY.replace(
        "# 最终内容 · 视觉测试",
        "# 行业研究：客户留存为什么下降\n\n本研究比较多个行业的客户留存变化。",
        1,
    )
    package = runtime.write("package", "unsupported-research-format", research_body, source="test")
    source = project / "materials" / "research" / filename
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"unsupported evidence")

    with pytest.raises(VisualOutputError, match="research requires source-backed evidence"):
        generate_publish_outputs(
            project=project,
            slug="unsupported-research-format",
            package_path=Path(package["path"]),
            renderer="fake",
            write_runtime_record=False,
        )

    visual_root = project / "pipeline" / "visual" / "unsupported-research-format"
    assert not (visual_root / "recipes").exists()
    assert not (visual_root / "publish").exists()
