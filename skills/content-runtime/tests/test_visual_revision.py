from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from visual_revision import create_recipe_revision, validate_revision_request  # noqa: E402
import visual_revision  # noqa: E402


def recipe(revision_id: str = "r001") -> dict:
    assets = [
        {
            "id": "wechat-html",
            "platform": "wechat",
            "role": "article",
            "layout_recipe": "html",
            "renderer": "dbs-wechat-html",
            "status": "planned",
        },
        {
            "id": "wechat-cover",
            "platform": "wechat",
            "role": "cover",
            "layout_recipe": "S01",
            "renderer": "xhs-card",
            "status": "planned",
        },
        {
            "id": "wechat-share",
            "platform": "wechat",
            "role": "share",
            "layout_recipe": "S01",
            "renderer": "xhs-card",
            "status": "planned",
        },
    ]
    for page in range(1, 6):
        assets.append(
            {
                "id": f"xhs-01-p{page}",
                "platform": "xhs",
                "role": "evidence" if page == 2 else ("cover" if page == 1 else "supporting"),
                "layout_recipe": ["S01", "S08", "S06", "S10", "S12"][page - 1],
                "renderer": "xhs-card",
                "status": "planned",
                "copy": {"headline": f"Page {page}", "supporting": "Source-backed visual guidance."},
                **({"source": "materials/screenshots/product-flow.png"} if page == 2 else {}),
            }
        )
    return {
        "schema": "aifios.visual-recipe.v1",
        "revision_id": revision_id,
        "slug": "product-demo",
        "source_package": "pipeline/package/product-demo-package.md",
        "source_assets": ["materials/screenshots/product-flow.png"],
        "content_archetype": "product_demo",
        "evidence_mode": "screenshot_first",
        "brand_profile": "adaptive",
        "platforms": {
            "wechat": {
                "system": "swiss",
                "cover_recipe": "S01",
                "asset_ids": ["wechat-html", "wechat-cover", "wechat-share"],
            },
            "xhs": {
                "system": "swiss",
                "page_recipes": ["S01", "S08", "S06", "S10", "S12"],
                "asset_ids": [f"xhs-01-p{page}" for page in range(1, 6)],
            },
        },
        "assets": assets,
        "quality_policy": {"min_density": 0.62, "require_evidence_ratio": 0.4},
    }


def write_recipe(project: Path, revision_id: str = "r001") -> Path:
    path = project / "pipeline" / "visual" / "product-demo" / "recipes" / f"{revision_id}.visual-recipe.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(recipe(revision_id), ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_verified_base_release(project: Path, base: Path) -> Path:
    from visual_publish import _render_html, parse_package_body, _check_wechat_output
    from visual_test_fixtures import VALID_PACKAGE_BODY

    visual_root = base.parents[1]
    revisions = visual_root / "revisions"
    revisions.mkdir(parents=True, exist_ok=True)
    recipe_rel = str(base.relative_to(project))
    outputs = []
    base_recipe = json.loads(base.read_text(encoding="utf-8"))
    package = project / base_recipe['source_package']
    package.parent.mkdir(parents=True, exist_ok=True)
    if not package.exists():
        package.write_text(VALID_PACKAGE_BODY, encoding='utf-8')
    article = parse_package_body(package.read_text(encoding='utf-8'))['wechat']
    for asset in base_recipe["assets"]:
        asset_id = str(asset["id"])
        if asset_id == "wechat-html":
            relative = "wechat/article.html"
            kind = "wechat_html"
        elif asset_id == "wechat-cover":
            relative = "wechat/cover.png"
            kind = "wechat_cover"
        elif asset_id == "wechat-share":
            relative = "wechat/share.png"
            kind = "wechat_cover"
        else:
            relative = f"xhs/{asset_id}.png"
            kind = "xhs_card"
        output_path = visual_root / "publish" / "r001" / relative
        output_path.parent.mkdir(parents=True, exist_ok=True)
        payload = f"base-{asset_id}".encode()
        output_path.write_bytes(payload)
        if kind == 'wechat_html':
            _render_html(output_path, article['title'], article['body'])
            payload = output_path.read_bytes()
        output = {
            "id": asset_id,
            "kind": kind,
            "format": "HTML" if kind == "wechat_html" else "PNG",
            "renderer": "local",
            "recipe_path": recipe_rel,
            "revision_id": "r001",
            "output": str(output_path.relative_to(project)),
            "status": "generated",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "layout_recipe": asset["layout_recipe"],
            "evidence_sources": [],
        }
        if kind == 'wechat_html':
            output['wechat_fidelity'] = _check_wechat_output(project, base_recipe, output)
        if kind == "xhs_card":
            output.update({"width": 1080, "height": 1440, "role": asset["role"]})
        elif asset_id == "wechat-cover":
            output.update({"width": 2100, "height": 900})
        elif asset_id == "wechat-share":
            output.update({"width": 1080, "height": 1080})
        if asset_id == "xhs-01-p2":
            output.update({
                "evidence_sources": ["materials/screenshots/product-flow.png"],
                "evidence_ratio": 0.5,
                "evidence_kind": "image",
                "evidence_detail_score": 0.35,
            })
        outputs.append(output)
    index_path = revisions / "r001.index.json"
    index_path.write_text(
        json.dumps(
            {
                "schema": "aifios.visual-publish.v1",
                "slug": "product-demo",
                "revision_id": "r001",
                "source_package": base_recipe['source_package'],
                "recipe_path": recipe_rel,
                "revision_index_path": str(index_path.relative_to(project)),
                "renderer": "local",
                "status": "generated",
                "legacy": False,
                "quality_summary": {"status": "pass", "errors": []},
                "render_quality_report": "\n".join(
                    f"[PASS] {output['id']} · xhs" for output in outputs if output["kind"] == "xhs_card"
                ),
                "outputs": outputs,
                "errors": [],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    evidence = project / "materials" / "screenshots" / "product-flow.png"
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_bytes(b"source-evidence")
    return index_path


@pytest.mark.parametrize("base_failure", ["tampered-output", "failed-quality"])
def test_consumer_rejects_an_unverified_explicit_base_before_creating_a_candidate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    base_failure: str,
) -> None:
    base = write_recipe(tmp_path)
    index_path = write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if base_failure == "tampered-output":
        (tmp_path / index["outputs"][0]["output"]).write_bytes(b"tampered")
    else:
        index["quality_summary"] = {"status": "blocked", "errors": ["base quality failed"]}
        index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    publish_calls: list[bool] = []

    import visual_publish

    def unexpected_publish(*_args, **_kwargs):
        publish_calls.append(True)
        raise AssertionError("renderer must not run for an unverified request-bound base")

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", unexpected_publish)

    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    record = json.loads(request_path.read_text(encoding="utf-8"))
    assert result["status"] == "blocked"
    assert record["status"] == "blocked"
    assert "base visual revision" in result["reason"]
    assert publish_calls == []
    assert not (base.parent / "r002.visual-recipe.json").exists()
    assert not list((tmp_path / "pipeline" / "visual" / "product-demo" / "revisions").glob("*.pending.json"))


def write_revision_request(project: Path, request_id: str = "r001-request") -> Path:
    request_path = project / "pipeline" / "visual" / "product-demo" / "revisions" / f"{request_id}.json"
    request_path.parent.mkdir(parents=True, exist_ok=True)
    request_path.write_text(
        json.dumps(
            {
                "schema": "aifios.visual-revision-request.v1",
                "base_revision_id": "r001",
                "request": "换成杂志风",
                "operations": ["change_system"],
                "constraints": ["保留原文事实", "不修改既有配方文件"],
                "status": "queued",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return request_path


def test_atomic_json_write_does_not_follow_a_precreated_temp_symlink(tmp_path: Path) -> None:
    destination = tmp_path / "request.json"
    victim = tmp_path / "outside-victim.txt"
    victim.write_text("keep-me", encoding="utf-8")
    (tmp_path / ".request.json.tmp").symlink_to(victim)

    visual_revision._write_json_atomic(destination, {"status": "queued"})

    assert victim.read_text(encoding="utf-8") == "keep-me"
    assert json.loads(destination.read_text(encoding="utf-8")) == {"status": "queued"}


def test_recovery_never_deletes_the_selected_revision_from_an_untrusted_marker(tmp_path: Path) -> None:
    base = write_recipe(tmp_path)
    index = write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)
    visual_root = tmp_path / "pipeline" / "visual" / "product-demo"
    selected_output_root = visual_root / "publish" / "r001"
    before_recipe = base.read_bytes()
    before_index = index.read_bytes()
    before_outputs = {
        path.relative_to(selected_output_root): path.read_bytes()
        for path in selected_output_root.rglob("*")
        if path.is_file()
    }
    marker = visual_root / "revisions" / ".r001-request.visual-revision-transaction.json"
    marker.write_text(json.dumps({
        "schema": "aifios.visual-revision-transaction.v1",
        "slug": "product-demo",
        "request_id": "r001-request",
        "base_revision_id": "r001",
        "revision_id": "r001",
        "phase": "rendering",
        "publish_current_index": False,
    }), encoding="utf-8")

    visual_revision._recover_incomplete_transactions(
        tmp_path,
        "product-demo",
        "r001-request",
    )

    assert base.read_bytes() == before_recipe
    assert index.read_bytes() == before_index
    assert {
        path.relative_to(selected_output_root): path.read_bytes()
        for path in selected_output_root.rglob("*")
        if path.is_file()
    } == before_outputs
    request = json.loads(request_path.read_text(encoding="utf-8"))
    assert request["status"] == "blocked"


def test_revision_candidate_keeps_r001_and_does_not_persist_r002(tmp_path: Path) -> None:
    base = write_recipe(tmp_path)
    original = base.read_bytes()
    request = {
        "base_revision_id": "r001",
        "operations": ["change_system"],
        "request": "换成杂志风",
    }

    revised = create_recipe_revision(tmp_path, base, request)

    revised_path = tmp_path / "pipeline" / "visual" / "product-demo" / "recipes" / "r002.visual-recipe.json"
    assert revised["revision_id"] == "r002"
    assert revised["parent_revision_id"] == "r001"
    assert revised["platforms"]["xhs"]["system"] == "editorial"
    assert base.read_bytes() == original
    assert not revised_path.exists()


@pytest.mark.parametrize(
    ("request_text", "expected_theme"),
    [
        ("换一个公众号排版主题", "minimal-blue"),
        ("改用 sspai-red 主题", "sspai-red"),
    ],
)
def test_wechat_layout_revision_changes_the_real_md2wechat_theme(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    request_text: str,
    expected_theme: str,
) -> None:
    monkeypatch.setattr(visual_revision, "_available_md2wechat_themes", lambda: {"github-readme", "minimal-blue", "sspai-red"})
    base = recipe()
    base["platforms"]["wechat"]["layout_selection"] = {
        "selected": "github-readme",
        "candidates": ["github-readme", "minimal-blue", "sspai-red"],
        "reason": "initial selection",
        "hint": "",
    }
    wechat_html = next(asset for asset in base["assets"] if asset["id"] == "wechat-html")
    wechat_html.update({"renderer": "md2wechat", "layout_style": "github-readme"})
    base_path = write_recipe(tmp_path)
    base_path.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")
    request = {
        "base_revision_id": "r001",
        "operations": ["change_layout"],
        "request": request_text,
        "target_asset_ids": ["wechat-html"],
    }

    revised = create_recipe_revision(tmp_path, base_path, request)
    revised_article = next(asset for asset in revised["assets"] if asset["id"] == "wechat-html")

    assert revised["platforms"]["wechat"]["layout_selection"]["selected"] == expected_theme
    assert revised_article["layout_style"] == expected_theme
    assert revised_article["layout_recipe"] == "html"


def test_validate_revision_request_rejects_unbounded_or_invalid_changes() -> None:
    base = recipe()

    errors = validate_revision_request(
        base,
        {
            "base_revision_id": "r001",
            "operations": ["change_system", "rewrite_recipe"],
            "request": "Make it editorial",
            "target_asset_ids": ["xhs-01-p2", "../escape"],
            "recipe_patch": {"platforms": {"xhs": {"system": "editorial"}}},
        },
    )

    assert any("unsupported revision operation: rewrite_recipe" in error for error in errors)
    assert any("unknown target asset id: ../escape" in error for error in errors)
    assert any("raw recipe patches are not allowed" in error for error in errors)


def test_persisted_request_requires_fields_that_compact_builder_requests_may_omit() -> None:
    base = recipe()
    compact = {
        "base_revision_id": "r001",
        "operations": ["change_system"],
        "request": "换成杂志风",
    }

    assert validate_revision_request(base, compact) == []
    persisted_errors = visual_revision.validate_persisted_revision_request(base, compact)

    assert any("canonical schema" in error for error in persisted_errors)
    assert any("non-empty constraints" in error for error in persisted_errors)
    assert any("requires a status" in error for error in persisted_errors)


def test_revision_candidate_builder_never_writes_a_recipe(tmp_path: Path) -> None:
    base = write_recipe(tmp_path)
    request = {"base_revision_id": "r001", "operations": ["change_system"], "request": "换成杂志风"}

    first = create_recipe_revision(tmp_path, base, request)
    second = create_recipe_revision(tmp_path, base, request)

    assert first["revision_id"] == "r002"
    assert second["revision_id"] == "r002"
    assert second["parent_revision_id"] == "r001"
    assert sorted(path.name for path in base.parent.glob("*.visual-recipe.json")) == ["r001.visual-recipe.json"]


def test_create_recipe_revision_rejects_paths_outside_the_project(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside.visual-recipe.json"
    outside.write_text(json.dumps(recipe()), encoding="utf-8")

    with pytest.raises(ValueError, match="inside the project"):
        create_recipe_revision(
            tmp_path,
            outside,
            {"base_revision_id": "r001", "operations": ["change_system"], "request": "换成杂志风"},
        )


def test_consumer_renders_locally_before_committing_r002(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = write_recipe(tmp_path)
    original = base.read_bytes()
    write_verified_base_release(tmp_path, base)
    assert not (base.parents[1] / "selected-revision.json").exists()
    assert not (base.parents[1] / "selected-assets.json").exists()
    request_path = write_revision_request(tmp_path)
    publish_index = tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "index.json"
    original_publish_index = b'{"slug":"product-demo","revision_id":"r001","status":"generated"}'
    publish_index.write_bytes(original_publish_index)
    calls: list[dict] = []

    def publish(
        project,
        slug,
        package_path=None,
        recipe_path=None,
        renderer=None,
        write_runtime_record=True,
        publish_current_index=True,
    ):
        staged = Path(recipe_path)
        staged_recipe = json.loads(staged.read_text(encoding="utf-8"))
        calls.append({
            "renderer": renderer,
            "recipe": staged_recipe,
            "package": Path(package_path),
            "write_runtime_record": write_runtime_record,
            "publish_current_index": publish_current_index,
        })
        assert not (tmp_path / "pipeline" / "visual" / "product-demo" / "recipes" / "r002.visual-recipe.json").exists()
        output_path = tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "r002" / "wechat" / "article.html"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("<html>candidate</html>", encoding="utf-8")
        revision_index = tmp_path / "pipeline" / "visual" / "product-demo" / "revisions" / "r002.index.json"
        payload = {
            "schema": "aifios.visual-publish.v1",
            "slug": slug,
            "revision_id": "r002",
            "recipe_path": str(staged.relative_to(tmp_path)),
            "status": "generated",
            "legacy": False,
            "quality_summary": {"status": "pass", "errors": []},
            "outputs": [{
                "id": "wechat-html",
                "renderer": "local",
                "recipe_path": str(staged.relative_to(tmp_path)),
                "output": str(output_path.relative_to(tmp_path)),
            }],
        }
        revision_index.write_text(json.dumps(payload), encoding="utf-8")
        return {"status": "generated", "index_path": str(revision_index), "quality_summary": payload["quality_summary"]}

    import visual_publish

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", publish)
    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    revised_path = tmp_path / "pipeline" / "visual" / "product-demo" / "recipes" / "r002.visual-recipe.json"
    revised = json.loads(revised_path.read_text(encoding="utf-8"))
    request_record = json.loads(request_path.read_text(encoding="utf-8"))
    assert calls == [{
        "renderer": "local",
        "recipe": calls[0]["recipe"],
        "package": tmp_path / "pipeline" / "package" / "product-demo-package.md",
        "write_runtime_record": False,
        "publish_current_index": False,
    }]
    assert calls[0]["recipe"]["revision_id"] == "r002"
    assert calls[0]["recipe"]["parent_revision_id"] == "r001"
    assert revised["platforms"]["xhs"]["system"] == "editorial"
    assert base.read_bytes() == original
    assert publish_index.read_bytes() == original_publish_index
    assert request_record["status"] == "rendered"
    assert request_record["revision_id"] == "r002"
    assert request_record["index_path"] == "pipeline/visual/product-demo/revisions/r002.index.json"
    revision_index = json.loads((tmp_path / request_record["index_path"]).read_text(encoding="utf-8"))
    assert revision_index["outputs"][0]["recipe_path"] == str(revised_path.relative_to(tmp_path))
    assert result == {
        "status": "rendered",
        "revision_id": "r002",
        "index_path": "pipeline/visual/product-demo/revisions/r002.index.json",
        "request_path": "pipeline/visual/product-demo/revisions/r001-request.json",
    }


def test_consumer_blocks_request_and_never_commits_recipe_when_renderer_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)

    import visual_publish

    def fail_publish(*args, **kwargs):
        assert kwargs["renderer"] == "local"
        raise RuntimeError("renderer exploded while capturing xhs deck")

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", fail_publish)
    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    record = json.loads(request_path.read_text(encoding="utf-8"))
    assert result["status"] == "blocked"
    assert "renderer exploded" in result["reason"]
    assert record["status"] == "blocked"
    assert "renderer exploded" in record["diagnostic_reason"]
    assert not (base.parent / "r002.visual-recipe.json").exists()
    assert base.exists()


def test_consumer_blocks_quality_failure_without_committing_recipe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)

    import visual_publish

    def blocked_publish(
        project, slug, package_path=None, recipe_path=None, renderer=None,
        write_runtime_record=True, publish_current_index=True,
    ):
        revision_index = tmp_path / "pipeline" / "visual" / "product-demo" / "revisions" / "r002.index.json"
        payload = {
            "slug": slug,
            "revision_id": "r002",
            "status": "generated",
            "quality_summary": {"status": "blocked", "errors": ["xhs-01-p2 density below 62%"]},
        }
        revision_index.write_text(json.dumps(payload), encoding="utf-8")
        return {"status": "generated", "index_path": str(revision_index), "quality_summary": payload["quality_summary"]}

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", blocked_publish)
    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    record = json.loads(request_path.read_text(encoding="utf-8"))
    assert result["status"] == "blocked"
    assert "density below 62%" in result["reason"]
    assert record["status"] == "blocked"
    assert not (base.parent / "r002.visual-recipe.json").exists()


def test_consumer_rejects_fake_outputs_even_when_quality_summary_claims_pass(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)

    import visual_publish

    def fake_publish(
        project, slug, package_path=None, recipe_path=None, renderer=None,
        write_runtime_record=True, publish_current_index=True,
    ):
        revision_index = tmp_path / "pipeline" / "visual" / "product-demo" / "revisions" / "r002.index.json"
        payload = {
            "slug": slug,
            "revision_id": "r002",
            "status": "generated",
            "quality_summary": {"status": "pass", "errors": []},
            "outputs": [{"id": "xhs-01-p1", "renderer": "fake"}],
        }
        revision_index.write_text(json.dumps(payload), encoding="utf-8")
        return {"status": "generated", "index_path": str(revision_index), "quality_summary": payload["quality_summary"]}

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", fake_publish)
    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    record = json.loads(request_path.read_text(encoding="utf-8"))
    assert result["status"] == "blocked"
    assert "local renderer" in result["reason"]
    assert record["status"] == "blocked"
    assert not (base.parent / "r002.visual-recipe.json").exists()


def test_consumer_keeps_current_publish_state_untouched_and_removes_failed_candidate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    write_revision_request(tmp_path)
    publish_index = tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "index.json"
    publish_index.parent.mkdir(parents=True, exist_ok=True)
    original_publish = b'{"revision_id":"r001","status":"generated"}'
    publish_index.write_bytes(original_publish)

    import visual_publish

    def blocked_publish(
        project, slug, package_path=None, recipe_path=None, renderer=None,
        write_runtime_record=True, publish_current_index=True,
    ):
        assert publish_current_index is False
        revision_index = tmp_path / "pipeline" / "visual" / "product-demo" / "revisions" / "r002.index.json"
        candidate_output = tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "r002" / "xhs" / "cover.png"
        candidate_render = tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "render" / "r002" / "index.html"
        candidate_output.parent.mkdir(parents=True, exist_ok=True)
        candidate_render.parent.mkdir(parents=True, exist_ok=True)
        candidate_output.write_bytes(b"candidate")
        candidate_render.write_text("candidate", encoding="utf-8")
        payload = {
            "slug": slug,
            "revision_id": "r002",
            "status": "generated",
            "quality_summary": {"status": "blocked", "errors": ["density below threshold"]},
            "outputs": [{"renderer": "local"}],
        }
        revision_index.write_text(json.dumps(payload), encoding="utf-8")
        return {"status": "generated", "index_path": str(revision_index), "quality_summary": payload["quality_summary"]}

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", blocked_publish)
    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    assert result["status"] == "blocked"
    assert publish_index.read_bytes() == original_publish
    assert not (tmp_path / "pipeline" / "visual" / "product-demo" / "revisions" / "r002.index.json").exists()
    assert not (tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "r002").exists()
    assert not (tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "render" / "r002").exists()


def test_consumer_rejects_client_controlled_request_paths(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="request id"):
        visual_revision.consume_revision_request(tmp_path, "product-demo", "../r001-request")


def test_terminal_rendered_request_is_revalidated_before_return(tmp_path: Path) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)
    record = json.loads(request_path.read_text(encoding="utf-8"))
    record.update({
        "status": "rendered",
        "revision_id": "r002",
        "index_path": "pipeline/visual/product-demo/revisions/r002.index.json",
    })
    request_path.write_text(json.dumps(record), encoding="utf-8")

    with pytest.raises(ValueError, match="terminal rendered"):
        visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")


def test_terminal_blocked_request_must_still_validate_the_request_contract(tmp_path: Path) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)
    record = json.loads(request_path.read_text(encoding="utf-8"))
    record.update({"status": "blocked", "diagnostic_reason": "renderer failed", "recipe_patch": {}})
    request_path.write_text(json.dumps(record), encoding="utf-8")

    with pytest.raises(ValueError, match="terminal blocked"):
        visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")


def test_historical_review_required_request_is_read_only_and_never_promoted(tmp_path: Path) -> None:
    base = write_recipe(tmp_path)
    revised = recipe("r002")
    revised["parent_revision_id"] = "r001"
    revised_path = base.parent / "r002.visual-recipe.json"
    revised_path.write_text(json.dumps(revised, ensure_ascii=False, indent=2), encoding="utf-8")
    output_path = tmp_path / "pipeline/visual/product-demo/publish/r002/wechat/article.html"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("historical candidate", encoding="utf-8")
    recipe_relative = str(revised_path.relative_to(tmp_path))
    index_relative = "pipeline/visual/product-demo/revisions/r002.index.json"
    index_path = tmp_path / index_relative
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps({
        "slug": "product-demo",
        "revision_id": "r002",
        "recipe_path": recipe_relative,
        "status": "generated",
        "quality_summary": {"status": "review_required"},
        "outputs": [{
            "renderer": "local",
            "recipe_path": recipe_relative,
            "output": str(output_path.relative_to(tmp_path)),
        }],
    }), encoding="utf-8")
    request_path = write_revision_request(tmp_path)
    historical = json.loads(request_path.read_text(encoding="utf-8"))
    historical.update({
        "request": "旧任务重新生成插画",
        "operations": ["regenerate_illustration"],
        "status": "review_required",
        "revision_id": "r002",
        "index_path": index_relative,
    })
    request_path.write_text(json.dumps(historical, ensure_ascii=False, indent=2), encoding="utf-8")
    before = request_path.read_bytes()

    result = visual_revision.consume_revision_request(
        tmp_path,
        "product-demo",
        "r001-request",
    )

    assert result == {
        "status": "review_required",
        "revision_id": "r002",
        "index_path": index_relative,
        "request_path": "pipeline/visual/product-demo/revisions/r001-request.json",
        "read_only": True,
    }
    assert request_path.read_bytes() == before


def test_non_consumable_operations_are_rejected_before_candidate_creation() -> None:
    base = recipe()
    reduce_errors = validate_revision_request(base, {
        "base_revision_id": "r001",
        "request": "精简文案",
        "operations": ["reduce_copy"],
        "target_asset_ids": ["wechat-cover"],
    })
    evidence_errors = validate_revision_request(base, {
        "base_revision_id": "r001",
        "request": "替换成真实截图",
        "operations": ["replace_evidence"],
        "target_asset_ids": ["wechat-cover"],
    })

    assert any("reducible copy" in error for error in reduce_errors)
    assert any("not evidence assets" in error for error in evidence_errors)


@pytest.mark.parametrize("operation", ["change_palette", "regenerate_illustration"])
def test_removed_visual_operations_are_rejected_before_candidate_creation(
    tmp_path: Path,
    operation: str,
) -> None:
    base_path = write_recipe(tmp_path)
    base = json.loads(base_path.read_text(encoding="utf-8"))
    request = {
        "base_revision_id": "r001",
        "request": "修改视觉",
        "operations": [operation],
    }

    errors = validate_revision_request(base, request)

    assert f"unsupported revision operation: {operation}" in errors
    with pytest.raises(ValueError, match="unsupported revision operation"):
        create_recipe_revision(tmp_path, base_path, request)
    assert not (base_path.parent / "r002.visual-recipe.json").exists()


def test_new_revision_request_rejects_an_ai_enhanced_recipe() -> None:
    base = recipe()
    base["visual_preferences"] = {
        "mode": "ai_enhanced",
        "direction_count": 2,
        "provider_policy": "auto",
    }

    errors = validate_revision_request(base, {
        "base_revision_id": "r001",
        "request": "换成杂志风",
        "operations": ["change_system"],
    })

    assert "visual revisions require stable visual mode" in errors


def test_screenshot_evidence_request_rejects_a_data_only_alternative() -> None:
    base = recipe()
    base["source_assets"] = [
        "materials/screenshots/product-flow.png",
        "materials/data/metrics.csv",
    ]
    request = {
        "base_revision_id": "r001",
        "request": "第二张改成真实截图",
        "operations": ["replace_evidence"],
        "target_asset_ids": ["xhs-01-p2"],
    }

    errors = validate_revision_request(base, request)

    assert any("matching alternative evidence source" in error for error in errors)
    with pytest.raises(ValueError, match="matching alternative evidence source"):
        visual_revision._select_evidence_source(
            base,
            next(asset for asset in base["assets"] if asset["id"] == "xhs-01-p2"),
            request["request"],
        )


@pytest.mark.parametrize(
    ("source", "intent"),
    [
        ("materials/data/metrics.xlsx", "data"),
        ("materials/research/report.pdf", "data"),
        ("materials/recordings/demo.mp4", "screenshot"),
        ("materials/screenshots/mock.svg", "screenshot"),
    ],
)
def test_revision_evidence_rejects_formats_the_renderer_cannot_parse(source: str, intent: str) -> None:
    assert visual_revision._evidence_source_matches_intent(source, intent) is False


@pytest.mark.parametrize(
    "output_value",
    [
        "pipeline/visual/product-demo/publish/r001/wechat/article.html",
        "pipeline/visual/product-demo/publish/r002/../r001/wechat/article.html",
        "pipeline/visual/product-demo/publish/r002/./wechat/article.html",
        "pipeline/visual/product-demo/publish/r002//wechat/article.html",
        "pipeline\\visual\\product-demo\\publish\\r002\\wechat\\article.html",
    ],
)
def test_quality_gate_rejects_outputs_outside_the_exact_revision_root(
    tmp_path: Path,
    output_value: str,
) -> None:
    resolved_output = (tmp_path / output_value).resolve(strict=False)
    resolved_output.parent.mkdir(parents=True, exist_ok=True)
    resolved_output.write_text("candidate", encoding="utf-8")
    recipe_path = "pipeline/visual/product-demo/recipes/r002.visual-recipe.json"
    index = {
        "slug": "product-demo",
        "revision_id": "r002",
        "recipe_path": recipe_path,
        "status": "generated",
        "quality_summary": {"status": "pass"},
        "outputs": [{
            "renderer": "local",
            "recipe_path": recipe_path,
            "output": output_value,
        }],
    }

    error = visual_revision._quality_gate_error(
        index,
        "product-demo",
        "r002",
        recipe_path,
        tmp_path,
    )

    assert error is not None
    assert "revision output root" in error


@pytest.mark.parametrize(
    ("quality_summary", "expected_reason"),
    [
        (
            {"status": "review_required", "errors": [], "review_issues": ["image review required"]},
            "image review required",
        ),
        ({"status": "pass", "errors": []}, "must not contain AI-generated outputs"),
    ],
)
def test_consumer_never_promotes_an_ai_candidate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    quality_summary: dict,
    expected_reason: str,
) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)

    import visual_publish

    def publish(
        project, slug, package_path=None, recipe_path=None, renderer=None,
        write_runtime_record=True, publish_current_index=True,
    ):
        staged = Path(recipe_path)
        output_path = tmp_path / "pipeline/visual/product-demo/publish/r002/wechat/article.html"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("candidate", encoding="utf-8")
        index_path = tmp_path / "pipeline/visual/product-demo/revisions/r002.index.json"
        index_path.write_text(json.dumps({
            "slug": slug,
            "revision_id": "r002",
            "recipe_path": str(staged.relative_to(tmp_path)),
            "status": "generated",
            "quality_summary": quality_summary,
            "outputs": [{
                "renderer": "local",
                "recipe_path": str(staged.relative_to(tmp_path)),
                "output": str(output_path.relative_to(tmp_path)),
                "ai_generated": True,
            }],
        }), encoding="utf-8")

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", publish)

    result = visual_revision.consume_revision_request(
        tmp_path,
        "product-demo",
        "r001-request",
    )

    record = json.loads(request_path.read_text(encoding="utf-8"))
    assert result["status"] == "blocked"
    assert record["status"] == "blocked"
    assert expected_reason in result["reason"]
    assert not (base.parent / "r002.visual-recipe.json").exists()


def test_concurrent_publish_index_update_is_untouched_during_isolated_render(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    write_revision_request(tmp_path)
    publish_index = tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "index.json"
    publish_index.write_text('{"revision_id":"r001"}', encoding="utf-8")

    import visual_publish

    def publish(
        project, slug, package_path=None, recipe_path=None, renderer=None,
        write_runtime_record=True, publish_current_index=True,
    ):
        assert publish_current_index is False
        staged = Path(recipe_path)
        output_path = tmp_path / "pipeline" / "visual" / "product-demo" / "publish" / "r002" / "wechat" / "article.html"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("candidate", encoding="utf-8")
        payload = {
            "slug": slug,
            "revision_id": "r002",
            "recipe_path": str(staged.relative_to(tmp_path)),
            "status": "generated",
            "quality_summary": {"status": "pass"},
            "outputs": [{
                "renderer": "local",
                "recipe_path": str(staged.relative_to(tmp_path)),
                "output": str(output_path.relative_to(tmp_path)),
            }],
        }
        revision_index = tmp_path / "pipeline" / "visual" / "product-demo" / "revisions" / "r002.index.json"
        revision_index.write_text(json.dumps(payload), encoding="utf-8")
        publish_index.write_text(json.dumps({"slug": slug, "revision_id": "r999", "status": "generated"}), encoding="utf-8")
        return {"status": "generated"}

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", publish)
    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    assert result["status"] == "rendered"
    assert json.loads(publish_index.read_text(encoding="utf-8"))["revision_id"] == "r999"


def test_consumer_preserves_orphaned_revision_when_transaction_ownership_is_unproven(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    write_revision_request(tmp_path)
    visual_root = tmp_path / "pipeline" / "visual" / "product-demo"
    orphan_recipe = recipe("r002")
    orphan_recipe["parent_revision_id"] = "r001"
    (base.parent / "r002.visual-recipe.json").write_text(json.dumps(orphan_recipe), encoding="utf-8")
    orphan_output = visual_root / "publish" / "r002" / "wechat" / "article.html"
    orphan_output.parent.mkdir(parents=True, exist_ok=True)
    orphan_output.write_text("orphan", encoding="utf-8")
    (visual_root / "revisions" / "r002.index.json").write_text(json.dumps({
        "slug": "product-demo", "revision_id": "r002", "status": "generated",
    }), encoding="utf-8")
    marker = visual_root / "revisions" / ".r001-request.visual-revision-transaction.json"
    marker.write_text(json.dumps({
        "schema": "aifios.visual-revision-transaction.v1",
        "slug": "product-demo",
        "request_id": "r001-request",
        "revision_id": "r002",
        "phase": "recipe_promoted",
        "publish_index_existed": False,
    }), encoding="utf-8")

    import visual_publish

    publish_calls: list[bool] = []
    monkeypatch.setattr(
        visual_publish,
        "generate_publish_outputs",
        lambda *_args, **_kwargs: publish_calls.append(True),
    )
    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    assert result["status"] == "blocked"
    assert "untrusted visual revision transaction marker" in result["reason"]
    assert publish_calls == []
    assert (base.parent / "r002.visual-recipe.json").is_file()
    assert (visual_root / "revisions" / "r002.index.json").is_file()
    assert orphan_output.read_text(encoding="utf-8") == "orphan"
    assert not marker.exists()


def test_committed_transaction_recovery_preserves_current_index_then_removes_marker(
    tmp_path: Path,
) -> None:
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    request_path = write_revision_request(tmp_path)
    visual_root = tmp_path / "pipeline" / "visual" / "product-demo"
    revised = recipe("r002")
    revised["parent_revision_id"] = "r001"
    revised_path = base.parent / "r002.visual-recipe.json"
    revised_path.write_text(json.dumps(revised), encoding="utf-8")
    output_path = visual_root / "publish" / "r002" / "wechat" / "article.html"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("committed", encoding="utf-8")
    recipe_relative = str(revised_path.relative_to(tmp_path))
    index_relative = "pipeline/visual/product-demo/revisions/r002.index.json"
    (tmp_path / index_relative).write_text(json.dumps({
        "slug": "product-demo",
        "revision_id": "r002",
        "recipe_path": recipe_relative,
        "status": "generated",
        "quality_summary": {"status": "pass"},
        "outputs": [{
            "renderer": "local",
            "recipe_path": recipe_relative,
            "output": str(output_path.relative_to(tmp_path)),
        }],
    }), encoding="utf-8")
    request_record = json.loads(request_path.read_text(encoding="utf-8"))
    request_record.update({
        "status": "rendered",
        "revision_id": "r002",
        "index_path": index_relative,
    })
    request_path.write_text(json.dumps(request_record), encoding="utf-8")
    publish_index = visual_root / "publish" / "index.json"
    concurrent_index = b'{"slug":"product-demo","revision_id":"r999","status":"generated"}'
    publish_index.write_bytes(concurrent_index)
    marker = visual_root / "revisions" / ".r001-request.visual-revision-transaction.json"
    marker.write_text(json.dumps({
        "schema": "aifios.visual-revision-transaction.v1",
        "slug": "product-demo",
        "request_id": "r001-request",
        "revision_id": "r002",
        "phase": "committed",
        "publish_current_index": False,
    }), encoding="utf-8")
    legacy_snapshot = visual_root / "revisions" / ".r001-request.publish-index.before"
    legacy_snapshot.write_bytes(b'{"revision_id":"r001"}')

    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")

    assert result["status"] == "rendered"
    assert result["revision_id"] == "r002"
    assert publish_index.read_bytes() == concurrent_index
    assert not marker.exists()
    assert not legacy_snapshot.exists()


def test_consumer_cli_commits_a_revision_rendered_by_the_real_local_pipeline(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from content_runtime import ContentRuntime
    from visual_test_fixtures import VALID_PACKAGE_BODY

    ContentRuntime(tmp_path).init()
    base = write_recipe(tmp_path)
    write_verified_base_release(tmp_path, base)
    package = tmp_path / "pipeline" / "package" / "product-demo-package.md"
    package.write_text(VALID_PACKAGE_BODY, encoding="utf-8")
    screenshot = tmp_path / "materials" / "screenshots" / "product-flow.png"
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(
        REPO_ROOT / "skills" / "content-runtime" / "fixtures" / "visual-director" / "product-flow.png",
        screenshot,
    )
    request_path = write_revision_request(tmp_path)
    request_record = json.loads(request_path.read_text(encoding="utf-8"))
    request_record.update({"request": "调整版式", "operations": ["change_layout"]})
    request_path.write_text(json.dumps(request_record, ensure_ascii=False, indent=2), encoding="utf-8")

    exit_code = visual_revision.main([
        "--project", str(tmp_path),
        "consume",
        "--slug", "product-demo",
        "--request-id", "r001-request",
    ])
    result = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert result["status"] == "rendered", result
    recipe_path = tmp_path / "pipeline" / "visual" / "product-demo" / "recipes" / "r002.visual-recipe.json"
    index_path = tmp_path / result["index_path"]
    index = json.loads(index_path.read_text(encoding="utf-8"))
    assert recipe_path.is_file()
    assert json.loads(recipe_path.read_text(encoding="utf-8"))["platforms"]["xhs"]["page_recipes"] == [
        "S08", "S06", "S10", "S12", "S01",
    ]
    assert index["quality_summary"]["status"] == "pass"
    assert index["aesthetic_status"] == "pass"
    assert index["outputs"]
    assert {output["renderer"] for output in index["outputs"]} == {"local"}
    assert {output["recipe_path"] for output in index["outputs"]} == {str(recipe_path.relative_to(tmp_path))}


@pytest.mark.parametrize(
    ('rendered_theme', 'fallback_reason', 'expected_status'),
    [
        ('minimal-blue', '', 'rendered'),
        ('echo-basic', 'provider unavailable', 'blocked'),
        ('github-readme', '', 'blocked'),
        ('', '', 'blocked'),
    ],
)
@pytest.mark.parametrize('wechat_only', [True, False])
def test_wechat_theme_revision_requires_the_requested_rendered_style(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    rendered_theme: str,
    fallback_reason: str,
    expected_status: str,
    wechat_only: bool,
) -> None:
    monkeypatch.setattr(visual_revision, "_available_md2wechat_themes", lambda: {"github-readme", "minimal-blue"})
    base_path = write_recipe(tmp_path)
    base = json.loads(base_path.read_text())
    base['platforms']['wechat']['layout_selection'] = {
        'selected': 'github-readme', 'candidates': ['github-readme', 'minimal-blue'],
    }
    article = next(asset for asset in base['assets'] if asset['id'] == 'wechat-html')
    article.update({'renderer': 'md2wechat', 'layout_style': 'github-readme'})
    if wechat_only:
        base['platforms'] = {'wechat': base['platforms']['wechat']}
        base['platforms']['wechat']['asset_ids'] = ['wechat-html']
        base['assets'] = [article]
    base_path.write_text(json.dumps(base), encoding='utf-8')
    base_index_path = write_verified_base_release(tmp_path, base_path)
    request_path = write_revision_request(tmp_path)
    request = json.loads(request_path.read_text())
    request.update({'operations': ['change_layout'], 'request': '将公众号排版主题改为 minimal-blue，保持文章正文不变。', 'target_asset_ids': ['wechat-html']})
    request_path.write_text(json.dumps(request), encoding='utf-8')
    visual_root = base_path.parents[1]
    current_path = visual_root / 'publish' / 'index.json'
    current_path.write_bytes(base_index_path.read_bytes())
    selected_path = visual_root / 'selected-assets.json'
    selected_path.write_text('{"unchanged":"original selection"}', encoding='utf-8')
    protected_paths = [base_path, base_index_path, current_path, selected_path, tmp_path / base['source_package']]
    protected = {path: path.read_bytes() for path in protected_paths}

    def offline_publish(project, slug, package_path=None, recipe_path=None, **_kwargs):
        staged = Path(recipe_path)
        candidate = json.loads(staged.read_text())
        assert candidate['platforms']['wechat']['layout_selection']['selected'] == 'minimal-blue'
        # The layout operation must not mutate any source article or other platform recipe.
        assert candidate['platforms'].get('xhs') == base['platforms'].get('xhs')
        assert [asset for asset in candidate['assets'] if asset['platform'] == 'xhs'] == [asset for asset in base['assets'] if asset['platform'] == 'xhs']
        output_path = visual_root / 'publish' / 'r002' / 'wechat' / 'article.html'
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text('<html>offline synthetic article</html>', encoding='utf-8')
        index = {
            'schema': 'aifios.visual-publish.v1', 'slug': slug, 'revision_id': 'r002',
            'recipe_path': str(staged.relative_to(tmp_path)), 'status': 'generated', 'legacy': False,
            'quality_summary': {'status': 'pass', 'errors': []},
            'outputs': [{'id': 'wechat-html', 'renderer': 'local', 'recipe_path': str(staged.relative_to(tmp_path)),
                         'output': str(output_path.relative_to(tmp_path)), 'renderer_theme': rendered_theme,
                         'layout_fallback_reason': fallback_reason}],
        }
        (visual_root / 'revisions' / 'r002.index.json').write_text(json.dumps(index), encoding='utf-8')

    import visual_publish
    monkeypatch.setattr(visual_publish, 'generate_publish_outputs', offline_publish)
    result = visual_revision.consume_revision_request(tmp_path, 'product-demo', 'r001-request')
    assert result['status'] == expected_status
    assert all(path.read_bytes() == before for path, before in protected.items())
    if expected_status == 'blocked':
        assert '所选排版样式未应用' in result['reason']
        assert not (base_path.parent / 'r002.visual-recipe.json').exists()
        assert not (visual_root / 'revisions' / 'r002.index.json').exists()
        assert not (visual_root / 'publish' / 'r002').exists()
    else:
        assert (base_path.parent / 'r002.visual-recipe.json').exists()


def _bound_wechat_revision(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from visual_test_fixtures import VALID_PACKAGE_BODY

    monkeypatch.setattr(visual_revision, "_available_md2wechat_themes", lambda: {"minimal-blue", "wechat-native", "elegant-blue"})
    path = write_recipe(tmp_path)
    base = json.loads(path.read_text())
    base["platforms"]["wechat"]["layout_selection"] = {
        "selected": "minimal-blue", "candidates": ["minimal-blue", "wechat-native"], "reason": "initial",
    }
    article = next(asset for asset in base["assets"] if asset["id"] == "wechat-html")
    article.update({"renderer": "md2wechat", "layout_style": "minimal-blue"})
    path.write_text(json.dumps(base), encoding="utf-8")
    package = tmp_path / base["source_package"]
    package.parent.mkdir(parents=True, exist_ok=True)
    package.write_text(VALID_PACKAGE_BODY, encoding="utf-8")
    request = {
        "base_revision_id": "r001", "operations": ["change_layout"],
        "request": "使用已经确认的公众号排版", "target_asset_ids": ["wechat-html"],
        "wechat_layout": {"theme": "elegant-blue", "source_package_sha256": hashlib.sha256(package.read_bytes()).hexdigest()},
    }
    return path, base, package, request


def test_explicit_catalog_theme_outside_old_shortlist_creates_bound_candidate(tmp_path, monkeypatch):
    path, base, package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    protected = {path: path.read_bytes(), package: package.read_bytes()}
    revised = create_recipe_revision(tmp_path, path, request)

    assert revised["platforms"]["wechat"]["wechat_layout"] == request["wechat_layout"]
    assert revised["platforms"]["wechat"]["layout_selection"]["selected"] == "elegant-blue"
    assert revised["platforms"]["wechat"]["layout_selection"]["candidates"] == ["minimal-blue", "wechat-native", "elegant-blue"]
    assert revised["platforms"]["xhs"] == base["platforms"]["xhs"]
    assert all(p.read_bytes() == content for p, content in protected.items())
    assert not (path.parent / "r002.visual-recipe.json").exists()


@pytest.mark.parametrize("structured", [True, False])
def test_explicit_unknown_theme_cannot_rotate_to_another_theme(tmp_path, monkeypatch, structured):
    path, _base, _package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    if structured:
        request["wechat_layout"]["theme"] = "not-a-real-theme"
    else:
        request.pop("wechat_layout")
        request["request"] = "将公众号排版改为 not-a-real-theme，保留正文。"
    original = path.read_bytes()
    with pytest.raises(ValueError, match="不存在或不可用"):
        create_recipe_revision(tmp_path, path, request)
    assert path.read_bytes() == original
    assert not (path.parent / "r002.visual-recipe.json").exists()


def test_explicit_natural_theme_outside_old_shortlist_is_used(tmp_path, monkeypatch):
    path, _base, _package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    request.pop("wechat_layout")
    request["request"] = "将公众号排版改为 elegant-blue，保留正文。"
    revised = create_recipe_revision(tmp_path, path, request)
    assert revised["platforms"]["wechat"]["layout_selection"]["selected"] == "elegant-blue"


@pytest.mark.parametrize("text", ["从 minimal-blue 换成 elegant-blue", "主题 elegant-blue 和 wechat-native"])
def test_ambiguous_theme_request_is_rejected_before_catalog_lookup(tmp_path, monkeypatch, text):
    path, _base, _package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    request.pop("wechat_layout")
    request["request"] = text
    monkeypatch.setattr(visual_revision, "_available_md2wechat_themes", lambda: pytest.fail("ambiguous request must fail before catalog lookup"))
    with pytest.raises(ValueError, match="多个主题"):
        create_recipe_revision(tmp_path, path, request)


def test_structured_theme_and_text_must_agree(tmp_path, monkeypatch):
    path, _base, _package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    request["request"] = "将公众号主题改为 wechat-native"
    with pytest.raises(ValueError, match="指定主题不一致"):
        create_recipe_revision(tmp_path, path, request)


def test_explicit_layout_rejects_changed_source_package(tmp_path, monkeypatch):
    path, _base, package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    package.write_text(package.read_text() + "\n后续改动\n")
    with pytest.raises(ValueError, match="内容包已变化"):
        create_recipe_revision(tmp_path, path, request)


def test_same_theme_can_add_explicit_source_bound_refinement(tmp_path, monkeypatch):
    from visual_publish import parse_package_body

    path, _base, package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    parsed = parse_package_body(package.read_text())
    title = parsed["wechat"].get("title") or parsed["title"]
    request["wechat_layout"].update({"theme": "minimal-blue", "refinement": {"profile": "title-spacing-v1", "title_lines": [title], "heading_blocks": []}})
    revised = create_recipe_revision(tmp_path, path, request)
    assert revised["platforms"]["wechat"]["wechat_layout"]["refinement"]["title_lines"] == [title]


def test_wechat_layout_is_scoped_to_one_article_operation(tmp_path, monkeypatch):
    _path, base, _package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    request["target_asset_ids"].append("xhs-01-p1")
    assert "wechat_layout requires only change_layout targeting wechat-html" in validate_revision_request(base, request)


def test_recipe_validator_rejects_disagreeing_recorded_theme(tmp_path, monkeypatch):
    from visual_director import validate_visual_recipe

    path, _base, _package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    revised = create_recipe_revision(tmp_path, path, request)
    revised["platforms"]["wechat"]["wechat_layout"]["theme"] = "wechat-native"
    assert "wechat_layout.theme must match the selected theme" in validate_visual_recipe(revised)


def test_catalog_discovery_only_accepts_selectable_api_themes(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.delenv("MD2WECHAT_BINARY", raising=False)
    monkeypatch.setattr(visual_revision.shutil, "which", lambda _name: "/synthetic/md2wechat")
    def discover(args, **kwargs):
        assert args == ["/synthetic/md2wechat", "themes", "list", "--json"]
        assert kwargs["timeout"] == 8
        return SimpleNamespace(returncode=0, stdout=json.dumps({"success": True, "data": {"themes": [
            {"name": "elegant-blue", "type": "api", "selectable": True},
            {"name": "api-collection", "type": "api", "selectable": False},
            {"name": "custom", "type": "ai", "selectable": True},
            {"name": "../../bad", "type": "api", "selectable": True},
        ]}}))
    monkeypatch.setattr(visual_revision.subprocess, "run", discover)
    assert visual_revision._available_md2wechat_themes() == {"elegant-blue"}


@pytest.mark.parametrize("payload", [{"success": False}, {"success": True, "data": {"themes": []}}, {"success": True, "data": []}])
def test_catalog_failure_does_not_fall_back_to_old_candidates(monkeypatch, payload):
    from types import SimpleNamespace

    monkeypatch.setenv("MD2WECHAT_BINARY", "/synthetic/md2wechat")
    monkeypatch.setattr(visual_revision.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=json.dumps(payload)))
    with pytest.raises(ValueError, match="无法读取可用"):
        visual_revision._available_md2wechat_themes()


@pytest.mark.parametrize("metadata_change", [
    {},
    {"local_refinements": None},
    {"local_refinements": {"profile": "title-spacing-v1", "title_lines": ["其他标题"], "heading_blocks": []}},
    {"base_renderer": "bundled"},
    {"base_theme": "minimal-blue"},
    {"output_is_raw_api_result": True},
    {"raw_html_sha256": "invalid"},
    {"raw_html_sha256": None},
])
def test_consumer_requires_requested_refinement_metadata(tmp_path, monkeypatch, metadata_change):
    import visual_publish

    base_path, base, package, request = _bound_wechat_revision(tmp_path, monkeypatch)
    parsed = visual_publish.parse_package_body(package.read_text())
    title = parsed["wechat"].get("title") or parsed["title"]
    refinement = {"profile": "title-spacing-v1", "title_lines": [title], "heading_blocks": []}
    request["wechat_layout"]["refinement"] = refinement
    base_index = write_verified_base_release(tmp_path, base_path)
    request_path = write_revision_request(tmp_path)
    persisted = json.loads(request_path.read_text())
    persisted.update(request)
    request_path.write_text(json.dumps(persisted), encoding="utf-8")
    visual_root = base_path.parents[1]
    protected = {path: path.read_bytes() for path in (base_path, base_index, package)}

    def offline_publish(project, slug, package_path=None, recipe_path=None, **_kwargs):
        # Synthetic renderer output isolates the transaction's provenance gate;
        # renderer fidelity itself has separate real-HTML tests.
        staged = Path(recipe_path)
        candidate = json.loads(staged.read_text())
        assert candidate["platforms"]["wechat"]["wechat_layout"]["refinement"] == refinement
        output_path = visual_root / "publish" / "r002" / "wechat" / "article.html"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("<html>synthetic transaction output</html>", encoding="utf-8")
        relative_recipe = str(staged.relative_to(tmp_path))
        output = {
            "id": "wechat-html", "renderer": "local", "recipe_path": relative_recipe,
            "output": str(output_path.relative_to(tmp_path)), "renderer_theme": "elegant-blue",
            "base_renderer": "md2wechat-cli", "base_theme": "elegant-blue",
            "local_refinements": refinement, "output_is_raw_api_result": False,
            "raw_html_sha256": "a" * 64,
        }
        output.update(metadata_change)
        index = {
            "schema": "aifios.visual-publish.v1", "slug": slug, "revision_id": "r002",
            "recipe_path": relative_recipe, "status": "generated", "legacy": False,
            "quality_summary": {"status": "pass", "errors": []}, "outputs": [output],
        }
        (visual_root / "revisions" / "r002.index.json").write_text(json.dumps(index), encoding="utf-8")

    monkeypatch.setattr(visual_publish, "generate_publish_outputs", offline_publish)
    result = visual_revision.consume_revision_request(tmp_path, "product-demo", "r001-request")
    assert result["status"] == ("blocked" if metadata_change else "rendered")
    assert all(path.read_bytes() == before for path, before in protected.items())
    if metadata_change:
        assert "标题和间距调整未完整应用" in result["reason"]
        assert not (base_path.parent / "r002.visual-recipe.json").exists()
        assert not (visual_root / "revisions" / "r002.index.json").exists()
        assert not (visual_root / "publish" / "r002").exists()
