from __future__ import annotations

import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
TESTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "tests"
for directory in (SCRIPTS_DIR, TESTS_DIR):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from content_runtime import ContentRuntime  # noqa: E402
from visual_director import build_visual_recipe  # noqa: E402
from visual_publish import generate_publish_outputs, parse_package_body  # noqa: E402
from visual_test_fixtures import VALID_PACKAGE_BODY  # noqa: E402


def _routing() -> dict:
    return json.loads((REPO_ROOT / "skills" / "content-runtime" / "config" / "visual-routing.json").read_text(encoding="utf-8"))


def _brands() -> dict:
    return json.loads((REPO_ROOT / "skills" / "content-runtime" / "config" / "visual-brand-profiles.json").read_text(encoding="utf-8"))


def test_recipe_turns_three_share_posts_into_distinct_visual_arguments() -> None:
    parsed = parse_package_body(VALID_PACKAGE_BODY)
    recipe = build_visual_recipe(
        parsed,
        {"assets": [{"path": "materials/screenshots/product-flow.png", "kind": "screenshot"}]},
        "multiplatform",
        _routing(),
        _brands(),
    )

    assert recipe["platforms"]["wechat"]["layout_selection"]["selected"]
    assert recipe["brand_profile"] == "echo-founder"
    assert recipe["brand_system"]["tokens"]["colors"] == {
        "paper": "#FDF8F3",
        "paper_2": "#F5EDE4",
        "ink": "#1A1A1A",
        "muted": "#6B6B6B",
        "line": "#D8CEC5",
        "grey_1": "#F5EDE4",
        "grey_2": "#D8CEC5",
        "grey_3": "#6B6B6B",
        "accent": "#E85D4C",
        "accent_soft": "#F7D8D2",
        "accent_on": "#FFFFFF",
    }
    scorecard = recipe["platforms"]["wechat"]["selection_scorecard"]
    assert scorecard["human_confirmation_required"] is True
    assert sum(item["weight"] for item in scorecard["criteria"]) == 1
    assert len(recipe["platforms"]["wechat"]["cover_options"]) == 3
    assert {item["direction"] for item in recipe["platforms"]["wechat"]["cover_options"]} == {
        "editorial_typography",
        "authorized_real_scene",
        "conceptual_visual",
    }
    by_id = {asset["id"]: asset for asset in recipe["assets"]}
    assert by_id["wechat-cover-alt-01"]["cover_strategy"] != ""
    assert by_id["xhs-01-p2"]["card_structure"] == "old-new-comparison"
    assert by_id["xhs-02-p2"]["card_structure"] == "step-one"
    assert by_id["xhs-03-p2"]["card_structure"] == "conflict"
    assert by_id["xhs-01-p1"]["narrative_stage"]["key"] == "hook"
    assert by_id["xhs-02-p3"]["narrative_stage"]["label"] == "第二步"
    assert by_id["xhs-03-p4"]["narrative_stage"]["key"] == "boundary"
    assert by_id["inline-01"]["insert_after"]
    assert set(recipe["platforms"]) == {"wechat", "xhs"}
    assert recipe["platforms"]["xhs"]["platform_bindings"] == ["xiaohongshu", "moments"]
    assert all(
        series["platform_bindings"] == ["xiaohongshu", "moments"]
        for series in recipe["platforms"]["xhs"]["series"]
    )
    assert not any(asset_id.startswith(("moments-", "video-")) for asset_id in by_id)


def test_package_parser_accepts_share_copy_field() -> None:
    parsed = parse_package_body(VALID_PACKAGE_BODY.replace("- 正文文案：", "- 分享文案："))

    assert len(parsed["xhs_posts"]) == 3
    assert all(post["body"] for post in parsed["xhs_posts"])


def test_fake_publish_writes_platform_delivery_manifest(tmp_path: Path) -> None:
    project = tmp_path / "multiplatform"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "multiplatform", VALID_PACKAGE_BODY, source="test")
    screenshot = project / "materials" / "screenshots" / "product-flow.png"
    screenshot.parent.mkdir(parents=True)
    screenshot.write_bytes(b"fixture-image")

    result = generate_publish_outputs(
        project,
        "multiplatform",
        Path(package["path"]),
        renderer="fake",
        write_runtime_record=False,
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    manifest = json.loads((project / index["platform_delivery_manifest"]).read_text(encoding="utf-8"))
    assert len(manifest["wechat"]["cover_options"]) == 3
    assert manifest["brand_profile"] == "echo-founder"
    assert manifest["wechat"]["selection_scorecard"]["schema"] == "echo-founder.cover-scorecard.v1"
    assert {item["direction"] for item in manifest["wechat"]["cover_options"]} == {
        "editorial_typography",
        "authorized_real_scene",
        "conceptual_visual",
    }
    assert len(manifest["xiaohongshu"]["posts"]) == 3
    assert manifest["xiaohongshu"]["posts"][0]["pages"][0]["narrative_stage"]["label"] == "先看问题"
    assert len(manifest["moments"]["posts"]) == 3
    assert manifest["moments"]["posts"][0]["image_order"] == ["P1", "P2", "P3", "P4", "P5"]
    assert manifest["moments"]["posts"][0]["upload_mode"] == "shared_carousel"
    assert all(
        moments_page["path"] == xhs_page["path"]
        for moments_post, xhs_post in zip(manifest["moments"]["posts"], manifest["xiaohongshu"]["posts"])
        for moments_page, xhs_page in zip(moments_post["pages"], xhs_post["pages"])
    )
    assert manifest["video"] == {"items": [], "visuals_required": False}
    assert not any(output["id"].startswith(("moments-", "video-")) for output in index["outputs"])
