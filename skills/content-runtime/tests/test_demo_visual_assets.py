from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "scripts"
RUNTIME_SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
for directory in (SCRIPTS_DIR, RUNTIME_SCRIPTS):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from content_runtime import ContentRuntime  # noqa: E402
from demo import write_demo_visual_assets  # noqa: E402
from demo_data import DEMO_SAMPLES  # noqa: E402
from delivery_pack import copy_visual_assets  # noqa: E402
from smoke_release import assert_selected_visual_releases  # noqa: E402
from visual_release import build_visual_selection_manifest  # noqa: E402
from visual_test_fixtures import VALID_PACKAGE_BODY, write_acceptance_visual_publish  # noqa: E402


def _write_selected_r002(project: Path, slug: str) -> Path:
    runtime = ContentRuntime(project)
    runtime.init()
    runtime.write("package", slug, VALID_PACKAGE_BODY, source="test")
    write_acceptance_visual_publish(project, runtime, slug)

    visual_root = project / "pipeline" / "visual" / slug
    shutil.copytree(visual_root / "publish" / "r001", visual_root / "publish" / "r002")

    r001_recipe = json.loads((visual_root / "recipes" / "r001.visual-recipe.json").read_text(encoding="utf-8"))
    r001_recipe.update({"revision_id": "r002", "parent_revision_id": "r001"})
    r002_recipe = visual_root / "recipes" / "r002.visual-recipe.json"
    r002_recipe.write_text(json.dumps(r001_recipe, ensure_ascii=False, indent=2), encoding="utf-8")

    index = json.loads((visual_root / "revisions" / "r001.index.json").read_text(encoding="utf-8"))
    recipe_rel = f"pipeline/visual/{slug}/recipes/r002.visual-recipe.json"
    index.update({
        "revision_id": "r002",
        "recipe_path": recipe_rel,
        "revision_index_path": f"pipeline/visual/{slug}/revisions/r002.index.json",
    })
    for output in index["outputs"]:
        output["revision_id"] = "r002"
        output["recipe_path"] = recipe_rel
        for field in ("output", "render_html", "source_svg"):
            if isinstance(output.get(field), str):
                output[field] = output[field].replace("/publish/r001/", "/publish/r002/")
    r002_index = visual_root / "revisions" / "r002.index.json"
    r002_index.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    (visual_root / "selected-revision.json").write_text(
        json.dumps(build_visual_selection_manifest(project, slug, "r002"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return visual_root


def test_demo_visual_assets_use_a_selected_passing_recipe(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    runtime.write("package", "demo-visual", DEMO_SAMPLES["package"], source="test")

    result = write_demo_visual_assets(tmp_path, "demo-visual")

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    selection = json.loads(
        (tmp_path / "pipeline" / "visual" / "demo-visual" / "selected-revision.json").read_text(encoding="utf-8")
    )
    assert index["legacy"] is False
    assert index["quality_summary"]["status"] == "pass"
    assert selection["revision_id"] == index["revision_id"]
    assert selection["slug"] == "demo-visual"
    assert selection["integrity"]["algorithm"] == "sha256"
    # The selected revision binds its recipe, immutable index, and the
    # platform-delivery manifest in addition to every rendered output.
    assert len(selection["integrity"]["files"]) == len(index["outputs"]) + 3
    assert {item["role"] for item in selection["integrity"]["files"]} >= {
        "recipe", "index", "platform_delivery", "output",
    }
    assert all(output["renderer"] == "local" for output in index["outputs"])
    assert assert_selected_visual_releases(tmp_path) == 1
    copied = copy_visual_assets(tmp_path, "demo-visual", tmp_path / "delivery-visual")
    assert len(copied) >= len(index["outputs"]) + 3
    for relative in [
        "pipeline/visual/demo-visual/cover.png",
        "pipeline/visual/demo-visual/share-card.png",
        "pipeline/visual/demo-visual/inline-xiaohei.png",
    ]:
        assert (tmp_path / relative).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


@pytest.mark.parametrize("mutable_index", ["stale-r001", "missing"])
def test_smoke_release_uses_selected_immutable_revision_not_mutable_publish_index(
    tmp_path: Path,
    mutable_index: str,
) -> None:
    visual_root = _write_selected_r002(tmp_path, "selected-r002")
    mutable_path = visual_root / "publish" / "index.json"
    if mutable_index == "missing":
        mutable_path.unlink()
    else:
        assert json.loads(mutable_path.read_text(encoding="utf-8"))["revision_id"] == "r001"

    assert assert_selected_visual_releases(tmp_path) == 1


def test_smoke_release_revalidates_selected_revision_integrity(tmp_path: Path) -> None:
    visual_root = _write_selected_r002(tmp_path, "selected-r002-integrity")
    selection_path = visual_root / "selected-revision.json"
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    selection["integrity"]["files"][0]["sha256"] = "0" * 64
    selection_path.write_text(json.dumps(selection, ensure_ascii=False, indent=2), encoding="utf-8")

    with pytest.raises(RuntimeError, match="failed integrity verification"):
        assert_selected_visual_releases(tmp_path)
