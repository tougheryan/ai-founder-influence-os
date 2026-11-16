from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path
from typing import Any

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import delivery_pack as delivery_pack_module  # noqa: E402
from delivery_audit import audit_visual_asset_realization, inspect_delivery_package_integrity  # noqa: E402
from delivery_pack import copy_if_exists, copy_visual_assets, is_sensitive_path  # noqa: E402
from visual_release import build_visual_selection_manifest, resolve_selected_visual_release  # noqa: E402


class RuntimeStub:
    def __init__(self, project: Path, slug: str) -> None:
        self.project = project
        self.slug = slug

    def read(self, _step: str, file: str) -> dict[str, str]:
        assert file == f"pipeline/visual/{self.slug}.md"
        proof = f"pipeline/visual/{self.slug}/publish/record-proof.png"
        return {"body": f"## 6. 交付 Manifest\n| asset | {proof} | generated |\n"}

    def validate(self, _step: str, file: str) -> dict[str, Any]:
        assert file == f"pipeline/visual/{self.slug}.md"
        proof = f"pipeline/visual/{self.slug}/publish/record-proof.png"
        return {"valid": True, "checks": {"visual_output_paths": [proof]}}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _integrity_file(project: Path, role: str, relative: str, asset_id: str | None = None) -> dict[str, Any]:
    payload = (project / relative).read_bytes()
    result: dict[str, Any] = {
        "role": role,
        "path": relative,
        "size": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }
    if asset_id:
        result["id"] = asset_id
    return result


def _selection_payload(project: Path, slug: str, index: dict[str, Any]) -> dict[str, Any]:
    files = [
        _integrity_file(project, "recipe", index["recipe_path"]),
        _integrity_file(project, "index", index["revision_index_path"]),
    ]
    files.extend(
        _integrity_file(project, "output", output["output"], str(output["id"]))
        for output in index["outputs"]
    )
    platform_delivery_manifest = index.get("platform_delivery_manifest")
    if isinstance(platform_delivery_manifest, str):
        files.append(_integrity_file(project, "platform_delivery", platform_delivery_manifest))
    return {
        "schema": "aifios.visual-selection.v1",
        "slug": slug,
        "revision_id": index["revision_id"],
        "integrity": {"algorithm": "sha256", "files": files},
    }


def _selected_release(project: Path, slug: str = "delivery-visual") -> tuple[Path, dict[str, Any]]:
    from visual_publish import _render_html, parse_package_body, _check_wechat_output
    from visual_test_fixtures import VALID_PACKAGE_BODY

    root = project / "pipeline" / "visual" / slug
    revision_id = "r001"
    recipe_rel = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
    index_rel = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
    recipe = {
        "schema": "aifios.visual-recipe.v1",
        "slug": slug,
        "revision_id": revision_id,
        "source_package": f"pipeline/package/{slug}.md",
        "content_archetype": "concept",
        "evidence_mode": "data_first",
        "quality_policy": {"min_density": 0.62, "require_evidence_ratio": 0.4},
        "platforms": {
            "wechat": {"system": "swiss"},
            "xhs": {"system": "swiss", "page_recipes": ["S01", "S08", "S06", "S10", "S12"]},
        },
        "assets": [
            {
                "id": "wechat-html", "platform": "wechat", "role": "article",
                "layout_recipe": "html", "renderer": "dbs-wechat-html", "status": "planned",
            },
            {
                "id": "xhs-01-p1", "platform": "xhs", "role": "evidence",
                "layout_recipe": "S01", "renderer": "xhs-card", "status": "planned",
                "source": "materials/evidence.png",
            },
            {
                "id": "inline-01", "platform": "wechat", "role": "supporting",
                "layout_recipe": "M01", "renderer": "baoyu-diagram", "status": "planned",
            },
        ],
    }
    _write_json(project / recipe_rel, recipe)
    package = project / recipe['source_package']
    package.parent.mkdir(parents=True, exist_ok=True)
    package.write_text(VALID_PACKAGE_BODY, encoding='utf-8')
    article = parse_package_body(VALID_PACKAGE_BODY)['wechat']

    outputs: list[dict[str, Any]] = []
    for output_id, kind, relative, layout in (
        ("wechat-html", "wechat_html", "wechat/article.html", None),
        ("xhs-01-p1", "xhs_card", "xhs/post-01/01-cover.png", "S01"),
        ("inline-01", "inline_image", "inline/diagram.png", None),
    ):
        output_rel = f"pipeline/visual/{slug}/publish/{revision_id}/{relative}"
        output_path = project / output_rel
        output_path.parent.mkdir(parents=True, exist_ok=True)
        payload = f"selected-{output_id}".encode()
        output_path.write_bytes(payload)
        if kind == 'wechat_html':
            _render_html(output_path, article['title'], article['body'])
            payload = output_path.read_bytes()
        output = {
            "id": output_id,
            "kind": kind,
            "format": "HTML" if kind == "wechat_html" else "PNG",
            "renderer": "local",
            "recipe_path": recipe_rel,
            "revision_id": revision_id,
            "output": output_rel,
            "status": "generated",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        if kind == 'wechat_html':
            output['wechat_fidelity'] = _check_wechat_output(project, recipe, output)
        if layout:
            output.update({
                "layout_recipe": layout,
                "render_html": f"pipeline/visual/{slug}/publish/{revision_id}/render/index.html",
                "role": "evidence",
                "evidence_sources": ["materials/evidence.png"],
                "evidence_ratio": 0.5,
                "evidence_kind": "image",
                "evidence_detail_score": 0.35,
            })
        outputs.append(output)

    render_path = root / "publish" / revision_id / "render" / "index.html"
    render_path.parent.mkdir(parents=True, exist_ok=True)
    render_path.write_text("<html><body>selected render provenance</body></html>", encoding="utf-8")
    (render_path.parent / "provenance.html").write_text("selected provenance", encoding="utf-8")
    proof_path = root / "publish" / "record-proof.png"
    proof_path.write_bytes(b"markdown-only-proof")

    index = {
        "schema": "aifios.visual-publish.v1",
        "slug": slug,
        "revision_id": revision_id,
        "revision_index_path": index_rel,
        "recipe_path": recipe_rel,
        "source_package": recipe['source_package'],
        "legacy": False,
        "renderer": "local",
        "status": "generated",
        "quality_summary": {"status": "pass", "checks": {}, "errors": []},
        "render_quality_report": "[PASS] xhs-01-p1 · xhs",
        "outputs": outputs,
        "errors": [],
    }
    _write_json(project / index_rel, index)
    _write_json(
        root / "selected-revision.json",
        _selection_payload(project, slug, index),
    )
    return root, index


def _audit(project: Path, slug: str = "delivery-visual") -> list[dict[str, Any]]:
    runtime = RuntimeStub(project, slug)
    run = {
        "slug": slug,
        "steps": {"visual": {"latest": f"pipeline/visual/{slug}.md"}},
    }
    return audit_visual_asset_realization(runtime, run)  # type: ignore[arg-type]


def _rewrite_selected_index(project: Path, slug: str, index: dict[str, Any]) -> None:
    _write_json(project / "pipeline" / "visual" / slug / "revisions" / "r001.index.json", index)


def _write_delivery_zip(
    delivery: Path,
    zip_path: Path,
    *,
    tampered_member: str | None = None,
) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(delivery.rglob("*")):
            if not path.is_file():
                continue
            member = str(path.relative_to(delivery)).replace("\\", "/")
            payload = path.read_bytes()
            if member == tampered_member:
                payload = b"X" * len(payload)
            archive.writestr(member, payload)


def _rewrite_delivery_selection_revision(
    delivery: Path,
    revision_id: str,
    *,
    rename_members: bool,
) -> None:
    visual_root = delivery / "artifacts" / "visual-assets"
    pointer_path = visual_root / "selected-revision.json"
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    original_revision = str(pointer["revision_id"])
    pointer["revision_id"] = revision_id
    if rename_members:
        slug = str(pointer["slug"])
        source_root = Path("pipeline") / "visual" / slug
        for record in pointer["integrity"]["files"]:
            source = Path(str(record["path"]))
            delivery_source = visual_root / source.relative_to(source_root)
            record["path"] = str(record["path"]).replace(original_revision, revision_id)
            renamed_source = Path(str(record["path"]))
            delivery_target = visual_root / renamed_source.relative_to(source_root)
            delivery_target.parent.mkdir(parents=True, exist_ok=True)
            delivery_source.rename(delivery_target)
    _write_json(pointer_path, pointer)


def _delivery_fixture(
    project: Path,
    index: dict[str, Any],
    *,
    tampered_zip_member: str | None = None,
) -> tuple[Path, Path, Path]:
    slug = str(index["slug"])
    delivery = project / "delivery"
    visual_destination = delivery / "artifacts" / "visual-assets"
    copy_visual_assets(project, slug, visual_destination)
    manifest = {
        "status": "packed",
        "slug": slug,
        "artifacts": [
            {
                "step": "visual-assets",
                "source": f"pipeline/visual/{slug}",
                "copied_to": "artifacts/visual-assets",
            }
        ],
        "reports": [],
        "delivery_gate": {},
    }
    for name in (
        "README.md",
        "客户交付说明.md",
        "客户成果报告.md",
        "修改意见回填.md",
        "隐私检查清单.md",
    ):
        (delivery / name).parent.mkdir(parents=True, exist_ok=True)
        (delivery / name).write_text("delivery fixture", encoding="utf-8")
    _write_json(delivery / "manifest.json", manifest)

    source_output = Path(str(index["outputs"][0]["output"]))
    visual_root = Path("pipeline") / "visual" / slug
    delivery_output = visual_destination / source_output.relative_to(visual_root)
    zip_path = project / "delivery.zip"
    _write_delivery_zip(delivery, zip_path, tampered_member=tampered_zip_member)
    return delivery, zip_path, delivery_output


def test_delivery_audit_accepts_a_selected_passing_local_release(tmp_path: Path) -> None:
    _selected_release(tmp_path)

    assert _audit(tmp_path) == []


def test_delivery_preserves_and_checks_selected_platform_delivery_manifest(tmp_path: Path) -> None:
    root, index = _selected_release(tmp_path)
    slug = str(index["slug"])
    revision_id = str(index["revision_id"])
    platform_delivery_rel = f"pipeline/visual/{slug}/publish/{revision_id}/platform-delivery.json"
    _write_json(tmp_path / platform_delivery_rel, {
        "schema": "aifios.platform-visual-delivery.v1",
        "slug": slug,
        "revision_id": revision_id,
        "platforms": ["wechat", "xiaohongshu", "shipinhao", "douyin", "moments"],
    })
    index["platform_delivery_manifest"] = platform_delivery_rel
    _rewrite_selected_index(tmp_path, slug, index)
    _write_json(root / "selected-revision.json", _selection_payload(tmp_path, slug, index))

    release = resolve_selected_visual_release(tmp_path, slug)
    assert release["status"] == "pass"
    assert platform_delivery_rel in release["copy_paths"]

    delivery, zip_path, _delivery_output = _delivery_fixture(tmp_path, index)
    delivery_manifest = delivery / "artifacts" / "visual-assets" / Path(platform_delivery_rel).relative_to(
        Path("pipeline") / "visual" / slug
    )
    assert delivery_manifest.is_file()
    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    assert not [
        item for item in inspect_delivery_package_integrity(manifest, delivery, str(zip_path))
        if item["code"] in {"delivery-visual-integrity-mismatch", "delivery-zip-visual-integrity-mismatch"}
    ]

    delivery_manifest.write_bytes(b"X" * delivery_manifest.stat().st_size)
    _write_delivery_zip(delivery, zip_path)
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))
    assert {item["code"] for item in issues} >= {
        "delivery-visual-integrity-mismatch",
        "delivery-zip-visual-integrity-mismatch",
    }


def test_delivery_audit_requires_digest_bound_explicit_adoption(tmp_path: Path) -> None:
    root, _index = _selected_release(tmp_path)
    _write_json(root / "selected-revision.json", {
        "schema": "aifios.visual-selection.v1",
        "slug": "delivery-visual",
        "revision_id": "r001",
    })

    release = resolve_selected_visual_release(tmp_path, "delivery-visual")

    assert release["status"] == "blocked"
    assert "integrity" in " ".join(release["errors"]).lower()


def test_first_adoption_rejects_output_changed_after_render_index(tmp_path: Path) -> None:
    root, index = _selected_release(tmp_path)
    (root / "selected-revision.json").unlink()
    output = tmp_path / index["outputs"][0]["output"]
    payload = output.read_bytes()
    output.write_bytes(b"Q" * len(payload))

    with pytest.raises(ValueError, match="sha256"):
        build_visual_selection_manifest(tmp_path, "delivery-visual", "r001")


def test_delivery_audit_blocks_an_unselected_recipe_release(tmp_path: Path) -> None:
    root, _index = _selected_release(tmp_path)
    (root / "selected-revision.json").unlink()
    _write_json(root / "publish" / "index.json", {"legacy": True, "outputs": []})

    issues = _audit(tmp_path)

    assert any(item["severity"] == "blocked" for item in issues)
    assert any(item["code"] == "visual-release-unselected" for item in issues)


def test_delivery_audit_blocks_failed_quality_fake_renderer_and_missing_output(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)

    index["quality_summary"]["status"] = "blocked"
    _rewrite_selected_index(tmp_path, "delivery-visual", index)
    assert any(item["code"] == "visual-release-invalid" for item in _audit(tmp_path))

    index["quality_summary"]["status"] = "pass"
    index["outputs"][0]["renderer"] = "fake"
    _rewrite_selected_index(tmp_path, "delivery-visual", index)
    assert any(item["code"] == "visual-release-invalid" for item in _audit(tmp_path))

    index["outputs"][0]["renderer"] = "local"
    missing = tmp_path / index["outputs"][0]["output"]
    missing.unlink()
    _rewrite_selected_index(tmp_path, "delivery-visual", index)
    issues = _audit(tmp_path)
    assert any(item["code"] == "visual-release-invalid" for item in issues)
    assert str(index["outputs"][0]["output"]) in " ".join(item["message"] for item in issues)


def test_delivery_pack_copies_only_the_selected_release_and_provenance(tmp_path: Path) -> None:
    root, _index = _selected_release(tmp_path)
    r002_recipe = root / "recipes" / "r002.visual-recipe.json"
    _write_json(r002_recipe, {"slug": "delivery-visual", "revision_id": "r002"})
    _write_json(root / "revisions" / "r002.index.json", {"slug": "delivery-visual", "revision_id": "r002"})
    _write_json(root / "revisions" / "r001-request.json", {"status": "queued"})
    _write_json(root / "revisions" / ".r002.pending.json", {"status": "pending"})
    (root / "publish" / "r002" / "xhs").mkdir(parents=True)
    (root / "publish" / "r002" / "xhs" / "candidate.png").write_bytes(b"failed-candidate")
    (root / "publish" / "render" / "r002").mkdir(parents=True)
    (root / "publish" / "render" / "r002" / "index.html").write_text("candidate", encoding="utf-8")

    destination = tmp_path / "delivery-assets"
    copied = copy_visual_assets(tmp_path, "delivery-visual", destination)
    copied_rel = {str(Path(path).relative_to(destination)) for path in copied}

    assert copied_rel == {
        "selected-revision.json",
        "recipes/r001.visual-recipe.json",
        "revisions/r001.index.json",
        "publish/r001/wechat/article.html",
        "publish/r001/xhs/post-01/01-cover.png",
        "publish/r001/inline/diagram.png",
    }
    assert not any("r002" in path or "request" in path or "pending" in path for path in copied_rel)
    assert not any("/render/" in f"/{path}/" for path in copied_rel)
    assert not (destination / "publish" / "record-proof.png").exists()


def test_delivery_pack_raises_if_selected_release_is_tampered_before_copy(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    (tmp_path / index["outputs"][0]["output"]).unlink()

    with pytest.raises(RuntimeError, match="selected visual release is not deliverable"):
        copy_visual_assets(tmp_path, "delivery-visual", tmp_path / "delivery-assets")


def test_delivery_rejects_same_size_output_tampering_after_adoption(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    output = tmp_path / index["outputs"][1]["output"]
    original = output.read_bytes()
    output.write_bytes(b"X" * len(original))

    release = resolve_selected_visual_release(tmp_path, "delivery-visual")

    assert release["status"] == "blocked"
    assert "sha256" in " ".join(release["errors"]).lower()
    with pytest.raises(RuntimeError, match="selected visual release is not deliverable"):
        copy_visual_assets(tmp_path, "delivery-visual", tmp_path / "delivery-assets")


def test_delivery_revalidates_selected_digests_after_copy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _root, index = _selected_release(tmp_path)
    selected_output = tmp_path / index["outputs"][0]["output"]
    original_copy = delivery_pack_module.copy_delivery_file
    mutated = False

    def mutate_after_copy(source: Path, target: Path, project: Path | None = None) -> None:
        nonlocal mutated
        original_copy(source, target, project)
        if source == selected_output and not mutated:
            payload = source.read_bytes()
            source.write_bytes(b"Z" * len(payload))
            mutated = True

    monkeypatch.setattr(delivery_pack_module, "copy_delivery_file", mutate_after_copy)
    destination = tmp_path / "delivery-assets"

    with pytest.raises(RuntimeError, match="changed during packaging"):
        copy_visual_assets(tmp_path, "delivery-visual", destination)
    assert not destination.exists()


def test_delivery_audit_blocks_tampered_selected_output_in_delivery_directory(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    delivery, zip_path, delivery_output = _delivery_fixture(tmp_path, index)
    delivery_output.write_bytes(b"X" * delivery_output.stat().st_size)

    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))

    assert any(
        item["severity"] == "blocked" and item["code"] == "delivery-visual-integrity-mismatch"
        for item in issues
    )


def test_delivery_audit_blocks_tampered_selected_recipe_in_delivery_directory(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    delivery, zip_path, _delivery_output = _delivery_fixture(tmp_path, index)
    slug = str(index["slug"])
    recipe_rel = Path(str(index["recipe_path"])).relative_to(
        Path("pipeline") / "visual" / slug
    )
    delivery_recipe = delivery / "artifacts" / "visual-assets" / recipe_rel
    delivery_recipe.write_bytes(b"X" * delivery_recipe.stat().st_size)

    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))

    assert any(
        item["severity"] == "blocked"
        and item["code"] == "delivery-visual-integrity-mismatch"
        and "recipe" in str(item.get("artifact") or "")
        for item in issues
    )


def test_delivery_audit_blocks_tampered_selected_output_in_zip(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    slug = str(index["slug"])
    output_rel = Path(str(index["outputs"][0]["output"])).relative_to(
        Path("pipeline") / "visual" / slug
    )
    zip_member = str(Path("artifacts") / "visual-assets" / output_rel).replace("\\", "/")
    delivery, zip_path, _delivery_output = _delivery_fixture(
        tmp_path,
        index,
        tampered_zip_member=zip_member,
    )

    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))

    assert any(
        item["severity"] == "blocked" and item["code"] == "delivery-zip-visual-integrity-mismatch"
        for item in issues
    )


def test_delivery_audit_blocks_tampered_selected_index_in_zip(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    slug = str(index["slug"])
    index_rel = Path(str(index["revision_index_path"])).relative_to(
        Path("pipeline") / "visual" / slug
    )
    zip_member = str(Path("artifacts") / "visual-assets" / index_rel).replace("\\", "/")
    delivery, zip_path, _delivery_output = _delivery_fixture(
        tmp_path,
        index,
        tampered_zip_member=zip_member,
    )

    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))

    assert any(
        item["severity"] == "blocked"
        and item["code"] == "delivery-zip-visual-integrity-mismatch"
        and "index" in str(item.get("artifact") or "")
        for item in issues
    )


def test_delivery_audit_binds_pointer_revision_to_canonical_integrity_paths(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    delivery, zip_path, _delivery_output = _delivery_fixture(tmp_path, index)
    pointer_path = delivery / "artifacts" / "visual-assets" / "selected-revision.json"
    original_size = pointer_path.stat().st_size
    _rewrite_delivery_selection_revision(delivery, "r999", rename_members=False)
    assert pointer_path.stat().st_size == original_size
    _write_delivery_zip(delivery, zip_path)

    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))
    details = " ".join(str(item.get("artifact") or "") for item in issues)

    assert {item["code"] for item in issues} >= {
        "delivery-visual-integrity-mismatch",
        "delivery-zip-visual-integrity-mismatch",
    }
    assert "canonical" in details


def test_delivery_audit_rejects_self_consistent_revision_member_renaming(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    delivery, zip_path, _delivery_output = _delivery_fixture(tmp_path, index)
    pointer_path = delivery / "artifacts" / "visual-assets" / "selected-revision.json"
    original_size = pointer_path.stat().st_size
    _rewrite_delivery_selection_revision(delivery, "r999", rename_members=True)
    assert pointer_path.stat().st_size == original_size
    _write_delivery_zip(delivery, zip_path)

    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))
    details = " ".join(str(item.get("artifact") or "") for item in issues)

    assert {item["code"] for item in issues} >= {
        "delivery-visual-integrity-mismatch",
        "delivery-zip-visual-integrity-mismatch",
    }
    assert "revision_id" in details


def test_delivery_audit_rejects_invalid_pointer_revision_id(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    delivery, zip_path, _delivery_output = _delivery_fixture(tmp_path, index)
    _rewrite_delivery_selection_revision(delivery, "latest", rename_members=False)
    _write_delivery_zip(delivery, zip_path)

    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))

    assert any(
        item["code"] == "delivery-visual-integrity-mismatch"
        and "invalid revision_id" in str(item.get("artifact") or "")
        for item in issues
    )


def test_delivery_audit_binds_pointer_output_ids_to_selected_index(tmp_path: Path) -> None:
    _root, index = _selected_release(tmp_path)
    delivery, zip_path, _delivery_output = _delivery_fixture(tmp_path, index)
    pointer_path = delivery / "artifacts" / "visual-assets" / "selected-revision.json"
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    output_record = next(
        record for record in pointer["integrity"]["files"] if record.get("role") == "output"
    )
    output_record["id"] = f"{output_record['id']}-changed"
    _write_json(pointer_path, pointer)
    _write_delivery_zip(delivery, zip_path)

    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))
    details = " ".join(str(item.get("artifact") or "") for item in issues)

    assert {item["code"] for item in issues} >= {
        "delivery-visual-integrity-mismatch",
        "delivery-zip-visual-integrity-mismatch",
    }
    assert "exactly match" in details


def test_delivery_pack_rejects_destination_directory_symlink_escape(tmp_path: Path) -> None:
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    _selected_release(project)
    destination = project / "delivery-assets"
    destination.symlink_to(outside, target_is_directory=True)

    with pytest.raises(RuntimeError, match="destination.*symlink"):
        copy_visual_assets(project, "delivery-visual", destination)

    assert list(outside.iterdir()) == []


def test_delivery_pack_rejects_destination_outside_project(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    _selected_release(project)
    destination = tmp_path / "outside-delivery"

    with pytest.raises(RuntimeError, match="destination.*inside the project"):
        copy_visual_assets(project, "delivery-visual", destination)

    assert not destination.exists()


def test_delivery_pack_rejects_symlink_in_destination_target_path(tmp_path: Path) -> None:
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    _selected_release(project)
    destination = project / "delivery-assets"
    destination.mkdir()
    (destination / "publish").symlink_to(outside, target_is_directory=True)

    with pytest.raises(RuntimeError, match="destination.*symlink"):
        copy_visual_assets(project, "delivery-visual", destination)

    assert list(outside.iterdir()) == []


def test_delivery_pack_binds_the_original_selection_pointer_bytes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, _index = _selected_release(tmp_path)
    selection_path = root / "selected-revision.json"
    original_selection = selection_path.read_bytes()
    original_copy = delivery_pack_module.copy_delivery_file
    mutated = False

    def mutate_before_selection_copy(source: Path, target: Path, project: Path | None = None) -> None:
        nonlocal mutated
        original_copy(source, target, project)
        if source != selection_path and not mutated:
            selection_path.write_bytes(original_selection + b"\n")
            mutated = True

    monkeypatch.setattr(delivery_pack_module, "copy_delivery_file", mutate_before_selection_copy)
    destination = tmp_path / "delivery-assets"

    with pytest.raises(RuntimeError, match="selection pointer changed"):
        copy_visual_assets(tmp_path, "delivery-visual", destination)
    assert not destination.exists()


def test_selected_render_symlink_cannot_escape_the_project(tmp_path: Path) -> None:
    root, _index = _selected_release(tmp_path)
    leak = root / "publish" / "r001" / "render" / "host-copy.txt"
    leak.symlink_to("/etc/hosts")

    release = resolve_selected_visual_release(tmp_path, "delivery-visual")

    assert release["status"] == "blocked"
    assert "symlink" in " ".join(release["errors"]).lower()
    with pytest.raises(RuntimeError, match="selected visual release is not deliverable"):
        copy_visual_assets(tmp_path, "delivery-visual", tmp_path / "delivery-assets")


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda recipe, index: recipe.pop("source_package"), "missing recipe field"),
        (lambda recipe, index: index.update({"schema": "wrong"}), "schema"),
        (lambda recipe, index: index.pop("revision_index_path"), "revision_index_path"),
        (lambda recipe, index: index["outputs"][0].pop("revision_id"), "revision_id"),
        (lambda recipe, index: index["outputs"][0].pop("sha256"), "sha256"),
    ],
)
def test_selected_release_requires_strict_recipe_and_index_contracts(
    tmp_path: Path,
    mutate: Any,
    expected: str,
) -> None:
    root, index = _selected_release(tmp_path)
    recipe_path = tmp_path / index["recipe_path"]
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    mutate(recipe, index)
    _write_json(recipe_path, recipe)
    _rewrite_selected_index(tmp_path, "delivery-visual", index)

    release = resolve_selected_visual_release(tmp_path, "delivery-visual")

    assert release["status"] == "blocked"
    assert expected in " ".join(release["errors"])


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda index: index["outputs"][0].update({"id": "   "}), "requires a non-empty id"),
        (lambda index: index["outputs"][1].update({"id": index["outputs"][0]["id"]}), "duplicates asset id"),
        (lambda index: index["outputs"][2].update({"id": "foreign-asset"}), "does not belong to selected recipe.assets"),
        (lambda index: index["outputs"].pop(0), "do not cover recipe.assets"),
    ],
)
def test_selected_release_binds_unique_nonempty_output_ids_to_recipe_assets(
    tmp_path: Path,
    mutate: Any,
    expected: str,
) -> None:
    root, index = _selected_release(tmp_path)
    mutate(index)
    _rewrite_selected_index(tmp_path, "delivery-visual", index)
    _write_json(root / "selected-revision.json", _selection_payload(tmp_path, "delivery-visual", index))

    release = resolve_selected_visual_release(tmp_path, "delivery-visual")

    assert release["status"] == "blocked"
    assert expected in " ".join(release["errors"])


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda index: index["outputs"][0].update({"id": "   "}), "requires a non-empty id"),
        (lambda index: index["outputs"][1].update({"id": index["outputs"][0]["id"]}), "duplicates asset id"),
        (lambda index: index["outputs"][2].update({"id": "foreign-asset"}), "does not belong to selected recipe.assets"),
        (lambda index: index["outputs"].pop(0), "do not cover recipe.assets"),
    ],
)
def test_first_adoption_binds_output_ids_to_recipe_assets(
    tmp_path: Path,
    mutate: Any,
    expected: str,
) -> None:
    root, index = _selected_release(tmp_path)
    (root / "selected-revision.json").unlink()
    mutate(index)
    _rewrite_selected_index(tmp_path, "delivery-visual", index)

    with pytest.raises(ValueError, match=expected):
        build_visual_selection_manifest(tmp_path, "delivery-visual", "r001")


def test_copy_if_exists_rejects_external_and_traversal_artifacts(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("outside", encoding="utf-8")

    for value in ("/etc/hosts", str(outside), "../outside.md"):
        with pytest.raises(RuntimeError, match="project-relative"):
            copy_if_exists(project, value, tmp_path / "delivery")

    link = project / "pipeline" / "escape.md"
    link.parent.mkdir(parents=True)
    link.symlink_to(outside)
    with pytest.raises(RuntimeError, match="symlink"):
        copy_if_exists(project, "pipeline/escape.md", tmp_path / "delivery")
    assert not (tmp_path / "delivery" / "outside.md").exists()


def test_sensitive_path_matching_does_not_reject_legitimate_screenshot_names() -> None:
    assert not is_sensitive_path(
        "pipeline/visual/product-screenshot/publish/r001/xhs/selected-screenshot.png"
    )
    assert is_sensitive_path("browser-profile/storage_state.json")


def test_selected_release_with_screenshot_slug_is_not_silently_skipped(tmp_path: Path) -> None:
    _selected_release(tmp_path, slug="product-screenshot")

    copied = copy_visual_assets(tmp_path, "product-screenshot", tmp_path / "delivery-assets")

    assert copied
    assert any(path.endswith("selected-revision.json") for path in copied)


def _selected_asset_manifest_release(project: Path, slug: str = "mixed-assets") -> dict[str, Any]:
    """Create two independently rendered revisions with a mixed asset adoption."""
    package_rel = f"pipeline/package/{slug}.md"
    package_path = project / package_rel
    package_path.parent.mkdir(parents=True, exist_ok=True)
    package_path.write_text("# 已确认内容包\n", encoding="utf-8")
    package_hash = hashlib.sha256(package_path.read_bytes()).hexdigest()
    selections: dict[str, dict[str, Any]] = {}
    for revision_id, asset_id, role, content in (
        ("r001", "wechat-cover", "wechat_cover", b"r001-cover"),
        ("r001", "inline-01", "inline-01", b"r001-inline"),
        ("r002", "xhs-01-p1", "xhs-01-p1", b"r002-card"),
        ("r002", "xhs-01-p2", "xhs-01-p2", b"r002-unselected"),
    ):
        root = project / "pipeline" / "visual" / slug
        recipe_rel = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
        index_rel = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
        recipe_path = project / recipe_rel
        index_path = project / index_rel
        existing_recipe = json.loads(recipe_path.read_text(encoding="utf-8")) if recipe_path.exists() else {
            "schema": "aifios.visual-recipe.v1",
            "slug": slug,
            "revision_id": revision_id,
            "source_package": package_rel,
            "assets": [],
        }
        existing_index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {
            "schema": "aifios.visual-publish.v1",
            "slug": slug,
            "revision_id": revision_id,
            "recipe_path": recipe_rel,
            "revision_index_path": index_rel,
            "legacy": False,
            "status": "generated",
            "quality_summary": {"status": "pass", "errors": []},
            "outputs": [],
        }
        output_rel = f"pipeline/visual/{slug}/publish/{revision_id}/{asset_id}.png"
        output_path = project / output_rel
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        existing_recipe["assets"].append({"id": asset_id, "platform": "xhs" if asset_id.startswith("xhs") else "wechat"})
        existing_index["outputs"].append({
            "id": asset_id,
            "output": output_rel,
            "sha256": digest,
            "size": len(content),
            "revision_id": revision_id,
            "recipe_path": recipe_rel,
            "status": "generated",
            "renderer": "local",
        })
        _write_json(recipe_path, existing_recipe)
        _write_json(index_path, existing_index)
        if asset_id in {"wechat-cover", "xhs-01-p1"}:
            selections[role] = {
                "assetId": asset_id,
                "semanticRole": role,
                "revisionId": revision_id,
                "path": output_rel,
                "sha256": digest,
                "platformBindings": ["xiaohongshu"] if asset_id.startswith("xhs") else ["wechat"],
            }
    _write_json(project / "pipeline" / "visual" / slug / "selected-assets.json", {
        "schema": "aifios.visual-asset-manifest.v1",
        "slug": slug,
        "sourceContentHash": package_hash,
        "requiredRoles": ["wechat_cover", "xhs-01-p1"],
        "selections": selections,
    })
    return {
        "slug": slug,
        "selected_paths": [selection["path"] for selection in selections.values()],
        "unselected_paths": [
            f"pipeline/visual/{slug}/publish/r001/inline-01.png",
            f"pipeline/visual/{slug}/publish/r002/xhs-01-p2.png",
        ],
    }


def _asset_manifest_delivery_fixture(project: Path, selection: dict[str, Any]) -> tuple[Path, Path]:
    delivery = project / "asset-manifest-delivery"
    visual_destination = delivery / "artifacts" / "visual-assets"
    copied = copy_visual_assets(project, str(selection["slug"]), visual_destination)
    assert copied
    manifest = {
        "status": "packed",
        "slug": selection["slug"],
        "artifacts": [{
            "step": "visual-assets",
            "source": f"pipeline/visual/{selection['slug']}",
            "copied_to": "artifacts/visual-assets",
            "files": copied,
        }],
        "reports": [],
        "delivery_gate": {},
    }
    for name in (
        "README.md",
        "客户交付说明.md",
        "客户成果报告.md",
        "修改意见回填.md",
        "隐私检查清单.md",
    ):
        (delivery / name).write_text("delivery fixture", encoding="utf-8")
    _write_json(delivery / "manifest.json", manifest)
    zip_path = project / "asset-manifest-delivery.zip"
    _write_delivery_zip(delivery, zip_path)
    return delivery, zip_path


def test_asset_manifest_is_authoritative_and_packages_only_mixed_selected_assets(tmp_path: Path) -> None:
    selection = _selected_asset_manifest_release(tmp_path)
    root = tmp_path / "pipeline" / "visual" / str(selection["slug"])
    # A stale whole-revision pointer must not override the per-asset choices.
    _write_json(root / "selected-revision.json", {"schema": "not-used", "revision_id": "r001"})

    release = resolve_selected_visual_release(tmp_path, str(selection["slug"]))

    assert release["status"] == "pass", release
    assert release["kind"] == "asset_manifest"
    assert release["selection_path"].endswith("selected-assets.json")
    destination = tmp_path / "asset-manifest-assets"
    copied = copy_visual_assets(tmp_path, str(selection["slug"]), destination)
    copied_rel = {str(Path(path).relative_to(destination)) for path in copied}
    assert "selected-assets.json" in copied_rel
    assert "selected-assets.provenance.json" in copied_rel
    assert "recipes/r001.visual-recipe.json" in copied_rel
    assert "recipes/r002.visual-recipe.json" in copied_rel
    assert "revisions/r001.index.json" in copied_rel
    assert "revisions/r002.index.json" in copied_rel
    for source_path in selection["selected_paths"]:
        relative = Path(source_path).relative_to(Path("pipeline") / "visual" / str(selection["slug"]))
        assert str(relative) in copied_rel
    for source_path in selection["unselected_paths"]:
        relative = Path(source_path).relative_to(Path("pipeline") / "visual" / str(selection["slug"]))
        assert str(relative) not in copied_rel
    assert "selected-revision.json" not in copied_rel


def test_asset_manifest_delivery_audit_validates_mixed_assets_without_revision_pointer(tmp_path: Path) -> None:
    selection = _selected_asset_manifest_release(tmp_path)
    assert _audit(tmp_path, str(selection["slug"])) == []
    delivery, zip_path = _asset_manifest_delivery_fixture(tmp_path, selection)
    manifest = json.loads((delivery / "manifest.json").read_text(encoding="utf-8"))

    assert not [
        item for item in inspect_delivery_package_integrity(manifest, delivery, str(zip_path))
        if item["code"] in {"delivery-visual-integrity-mismatch", "delivery-zip-visual-integrity-mismatch"}
    ]

    selected_relative = Path(str(selection["selected_paths"][1])).relative_to(
        Path("pipeline") / "visual" / str(selection["slug"])
    )
    selected_asset = delivery / "artifacts" / "visual-assets" / selected_relative
    selected_asset.write_bytes(b"tampered-card")
    _write_delivery_zip(delivery, zip_path)
    issues = inspect_delivery_package_integrity(manifest, delivery, str(zip_path))

    assert {item["code"] for item in issues} >= {
        "delivery-visual-integrity-mismatch",
        "delivery-zip-visual-integrity-mismatch",
    }


def test_invalid_asset_manifest_never_falls_back_to_a_whole_revision_pointer(tmp_path: Path) -> None:
    selection = _selected_asset_manifest_release(tmp_path)
    root = tmp_path / "pipeline" / "visual" / str(selection["slug"])
    (root / "selected-assets.json").write_text("{}", encoding="utf-8")
    _write_json(root / "selected-revision.json", {"schema": "aifios.visual-selection.v1", "slug": selection["slug"], "revision_id": "r001"})

    release = resolve_selected_visual_release(tmp_path, str(selection["slug"]))

    assert release["kind"] == "asset_manifest"
    assert release["status"] == "blocked"


def test_legacy_visual_copy_excludes_recipe_candidates(tmp_path: Path) -> None:
    root = tmp_path / "pipeline" / "visual" / "legacy"
    _write_json(root / "publish" / "index.json", {"legacy": True, "outputs": []})
    (root / "publish" / "cover.png").write_bytes(b"legacy-cover")
    _write_json(root / "recipes" / "r001.visual-recipe.json", {"revision_id": "r001"})
    _write_json(root / "revisions" / "r001-request.json", {"status": "queued"})

    destination = tmp_path / "legacy-delivery"
    copied = copy_visual_assets(tmp_path, "legacy", destination)
    copied_rel = {str(Path(path).relative_to(destination)) for path in copied}

    assert copied_rel == {"publish/index.json", "publish/cover.png"}
