from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from desktop_dmg import (
    checksum_sidecar_path,
    package_manifest_binding,
    read_packaged_product_version,
    read_demo_unlock_required,
    read_distribution_mode,
    require_hosted_distribution,
    require_real_hosted_gateway,
    verify_checksum_sidecar,
    verify_dmg_manifest_traceability,
    verify_dmg_source_hygiene,
    write_checksum_sidecar,
)
from desktop_minimal_artifact_check import check_manifest
from desktop_package import runtime_tree_fingerprint, sha256_file


def write_hosted_bundle(root: Path, gateway_url: str) -> Path:
    app = root / "AIFIOS.app"
    resources = app / "Contents" / "Resources"
    (resources / "aifios").mkdir(parents=True)
    (resources / "aifios-distribution.json").write_text(
        json.dumps({"schema": "aifios.desktop-distribution.v1", "mode": "hosted-license", "deviceBinding": True}),
        encoding="utf-8",
    )
    (resources / "aifios" / "hosted-client.json").write_text(
        json.dumps({"schema": "aifios.hosted-client.v1", "gatewayUrl": gateway_url, "licenseMode": "device-bound"}),
        encoding="utf-8",
    )
    return app


def test_hosted_dmg_release_rejects_placeholder_gateway(tmp_path: Path) -> None:
    app = write_hosted_bundle(tmp_path, "https://gateway.example.com")
    assert read_distribution_mode(app) == "hosted-license"
    with pytest.raises(RuntimeError, match="placeholder"):
        require_real_hosted_gateway(app)


def test_hosted_dmg_release_accepts_real_https_origin(tmp_path: Path) -> None:
    app = write_hosted_bundle(tmp_path, "https://license.example.cn")
    require_real_hosted_gateway(app)


def test_paid_dmg_gate_rejects_local_self_config_mode() -> None:
    with pytest.raises(RuntimeError, match="hosted-license"):
        require_hosted_distribution("local-self-config")


def test_paid_dmg_gate_accepts_device_bound_mode() -> None:
    require_hosted_distribution("hosted-license")


def test_dmg_checksum_sidecar_is_named_and_bound_to_exact_artifact(tmp_path: Path) -> None:
    dmg = tmp_path / "Echo-Founder-0.2.0-beta.2-mac-arm64.dmg"
    dmg.write_bytes(b"echo-founder-dmg")

    written = write_checksum_sidecar(dmg)

    assert written["path"] == "Echo-Founder-0.2.0-beta.2-mac-arm64.dmg.sha256"
    assert checksum_sidecar_path(dmg).read_text(encoding="ascii").endswith(f"  {dmg.name}\n")
    assert verify_checksum_sidecar(dmg, written["path"])["sha256"] == sha256_file(dmg)

    dmg.write_bytes(b"tampered")
    with pytest.raises(RuntimeError, match="does not match"):
        verify_checksum_sidecar(dmg, written["path"])

    victim = tmp_path / "victim.txt"
    victim.write_text("untouched\n", encoding="utf-8")
    sidecar = checksum_sidecar_path(dmg)
    sidecar.unlink()
    sidecar.symlink_to(victim)
    with pytest.raises(RuntimeError, match="missing or unsafe"):
        verify_checksum_sidecar(dmg, written["path"])
    assert victim.read_text(encoding="utf-8") == "untouched\n"


def test_dmg_reads_full_semver_from_packaged_product_metadata(tmp_path: Path) -> None:
    app = tmp_path / "Echo Founder.app"
    package_json = app / "Contents" / "Resources" / "app" / "package.json"
    package_json.parent.mkdir(parents=True)
    package_json.write_text('{"version":"0.2.0-beta.2"}\n', encoding="utf-8")

    assert read_packaged_product_version(app) == "0.2.0-beta.2"

    package_json.write_text('{"version":"v0.2"}\n', encoding="utf-8")
    with pytest.raises(RuntimeError, match="version is invalid"):
        read_packaged_product_version(app)


def test_product_password_gate_accepts_hashed_v2_config(tmp_path: Path) -> None:
    app = write_hosted_bundle(tmp_path, "https://license.example.cn")
    config = app / "Contents" / "Resources" / "aifios" / "demo-unlock.json"
    config.write_text(
        json.dumps({
            "schema": "aifios.demo-unlock.v2",
            "algorithm": "sha256",
            "codeHashes": ["a" * 64],
        }),
        encoding="utf-8",
    )

    assert read_demo_unlock_required(app) is True


def test_product_password_gate_rejects_empty_config(tmp_path: Path) -> None:
    app = write_hosted_bundle(tmp_path, "https://license.example.cn")
    config = app / "Contents" / "Resources" / "aifios" / "demo-unlock.json"
    config.write_text(
        json.dumps({"schema": "aifios.demo-unlock.v2", "algorithm": "sha256", "codeHashes": []}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="unsupported or empty"):
        read_demo_unlock_required(app)


def test_minimal_artifact_gate_rejects_builder_paths_in_customer_manifest(tmp_path: Path) -> None:
    dmg = tmp_path / "Echo-Founder-0.2.0-beta.2-mac-arm64.dmg"
    dmg.write_bytes(b"echo-founder-dmg")
    manifest = {
        "artifact": "dmg",
        "app_name": "Echo Founder.app",
        "mounted_app_path": "/Volumes/Echo Founder/Echo Founder.app",
        "bundle_id": "com.echofounder.desktop",
        "size_bytes": dmg.stat().st_size,
        "sha256": sha256_file(dmg),
        "source_app_path": "/Users/release/build/Echo Founder.app",
    }
    dmg.with_suffix(".manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    _checks, failures = check_manifest(
        dmg,
        "Echo Founder",
        "Echo Founder",
        "com.echofounder.desktop",
    )

    assert any("build-machine absolute path" in failure for failure in failures)


def test_dmg_staging_allowlist_rejects_stale_apps_and_build_outputs(tmp_path: Path) -> None:
    (tmp_path / "Echo Founder.app").mkdir()
    (tmp_path / "Applications").symlink_to("/Applications")
    (tmp_path / "README-INSTALL.txt").write_text("install\n", encoding="utf-8")
    (tmp_path / "README-安装说明.txt").write_text("安装\n", encoding="utf-8")

    result = verify_dmg_source_hygiene(tmp_path, "Echo Founder.app")
    assert result["status"] == "pass"

    (tmp_path / "AIFIOS.previous.app").mkdir()
    with pytest.raises(RuntimeError, match="unexpected"):
        verify_dmg_source_hygiene(tmp_path, "Echo Founder.app")


def test_dmg_manifest_binds_package_manifest_and_mounted_runtime(tmp_path: Path) -> None:
    dmg = tmp_path / "Echo-Founder-0.2.0-beta.2-mac-arm64.dmg"
    dmg.write_bytes(b"dmg")
    app = tmp_path / "mounted" / "Echo Founder.app"
    runtime = app / "Contents" / "Resources" / "aifios"
    runtime.mkdir(parents=True)
    runtime.joinpath("runtime.txt").write_text("customer runtime\n", encoding="utf-8")
    package_manifest = tmp_path / "desktop" / "desktop-package-manifest.json"
    package_manifest.parent.mkdir()
    package_manifest.write_text('{"package":"trace"}\n', encoding="utf-8")
    checksum = write_checksum_sidecar(dmg)
    source_control = {
        "schema": "echo-founder.source-control-trace.v1",
        "baseline_sha": "a" * 40,
        "current_sha": "b" * 40,
        "dirty": True,
        "dirty_status_sha256": "c" * 64,
    }
    binding = {
        "schema": "echo-founder.package-manifest-binding.v1",
        "path": "desktop/desktop-package-manifest.json",
        "sha256": sha256_file(package_manifest),
        "source_control": source_control,
        "shipped_runtime": runtime_tree_fingerprint(runtime),
    }
    dmg.with_suffix(".manifest.json").write_text(
        json.dumps({
            "artifact": "dmg",
            "sha256": checksum["sha256"],
            "checksum_file": checksum["path"],
            "package_manifest": binding,
        }),
        encoding="utf-8",
    )

    result = verify_dmg_manifest_traceability(dmg, app)

    assert result["status"] == "pass"
    assert result["source_manifest_verified"] is True
    assert result["source_dirty"] is True

    package_manifest.write_text('{"package":"different"}\n', encoding="utf-8")
    with pytest.raises(RuntimeError, match="not bound"):
        verify_dmg_manifest_traceability(dmg, app)


def test_dmg_build_copies_a_portable_customer_package_manifest(tmp_path: Path, monkeypatch) -> None:
    app = tmp_path / "desktop" / "Echo Founder.app"
    runtime = app / "Contents" / "Resources" / "aifios"
    runtime.mkdir(parents=True)
    runtime.joinpath("runtime.txt").write_text("customer runtime\n", encoding="utf-8")
    source_control = {
        "schema": "echo-founder.source-control-trace.v1",
        "baseline_sha": "a" * 40,
        "current_sha": "b" * 40,
        "dirty": False,
        "dirty_status_sha256": "c" * 64,
    }
    source_manifest = app.parent / "desktop-package-manifest.json"
    source_manifest.write_text(json.dumps({
        "source_control": source_control,
        "shipped_runtime": runtime_tree_fingerprint(runtime),
    }), encoding="utf-8")
    delivery_manifest = tmp_path / "Echo-Founder-0.2.0-beta.2-mac-arm64.package-manifest.json"
    monkeypatch.setattr(
        "desktop_dmg.verify_package_traceability",
        lambda manifest_path, app_path: {
            "manifest_sha256": sha256_file(manifest_path),
            "source_control": source_control,
            "shipped_runtime": runtime_tree_fingerprint(runtime),
        },
    )

    binding = package_manifest_binding(app, delivery_manifest)

    assert delivery_manifest.read_bytes() == source_manifest.read_bytes()
    assert binding["path"] == delivery_manifest.name
    assert binding["sha256"] == sha256_file(source_manifest)
