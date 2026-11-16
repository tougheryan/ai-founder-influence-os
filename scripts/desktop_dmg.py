#!/usr/bin/env python3
"""Build and verify a local macOS DMG for the packaged Echo Founder desktop app."""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from desktop_package import (
    BRAND_ICON_FILENAME,
    assert_release_manifest_portable,
    DEFAULT_APP_NAME,
    DEFAULT_BUNDLE_ID as PACKAGE_DEFAULT_BUNDLE_ID,
    DEFAULT_DESKTOP_ARCH,
    DEFAULT_PRODUCT_VERSION,
    DESKTOP_DIST_DIR,
    electron_runtime_module_names,
    lipo_architecture_name,
    MATERIAL_OCR_BINARY_RELATIVE,
    macho_architectures,
    MINIMUM_MACOS_VERSION,
    NEXT_BUILD_MANIFEST,
    next_standalone_dist_dir,
    next_standalone_root,
    package_architectures,
    REQUIRED_NEXT_ROUTE_ARTIFACTS,
    TIKOMNI_BUNDLE_FILES,
    TIKOMNI_SKILL_NAME,
    verify_electron_runtime_architecture,
    verify_brand_icon,
    verify_customer_bundle_hygiene,
    verify_next_native_runtime,
    verify_package_traceability,
    verify_playwright_runtime,
    runtime_tree_fingerprint,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP_PATH = REPO_ROOT / "dist" / "desktop" / f"{DEFAULT_APP_NAME}.app"
DEFAULT_DMG_PATH = REPO_ROOT / "dist" / f"Echo-Founder-{DEFAULT_PRODUCT_VERSION}-mac-arm64.dmg"
DEFAULT_VOLUME_NAME = DEFAULT_APP_NAME
DEFAULT_BUNDLE_ID = PACKAGE_DEFAULT_BUNDLE_ID


def run(command: list[str], timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    print(f"RUN {' '.join(command)}", flush=True)
    return subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=True)


def require_macos_tools() -> None:
    if sys.platform != "darwin":
        raise RuntimeError("desktop_dmg.py currently supports macOS only.")
    for tool in ["hdiutil", "codesign", "ditto"]:
        if not shutil.which(tool):
            raise RuntimeError(f"Required macOS tool is missing: {tool}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checksum_sidecar_path(dmg_path: Path) -> Path:
    return Path(f"{dmg_path}.sha256")


def write_checksum_sidecar(dmg_path: Path) -> dict[str, str]:
    digest = sha256_file(dmg_path)
    sidecar = checksum_sidecar_path(dmg_path)
    temporary = sidecar.with_name(f".{sidecar.name}.tmp-{os.getpid()}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temporary, flags, 0o644)
    try:
        opened_fd = fd
        fd = -1
        with os.fdopen(opened_fd, "w", encoding="ascii", closefd=True) as handle:
            handle.write(f"{digest}  {dmg_path.name}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, sidecar)
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)
    return {"path": sidecar.name, "sha256": digest}


def verify_checksum_sidecar(dmg_path: Path, expected_name: str | None = None) -> dict[str, str]:
    sidecar = checksum_sidecar_path(dmg_path)
    if expected_name is not None and expected_name != sidecar.name:
        raise RuntimeError("DMG checksum sidecar name does not match the artifact.")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(sidecar, flags)
    except OSError as exc:
        raise RuntimeError("DMG checksum sidecar is missing or unsafe.") from exc
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 256:
            raise RuntimeError("DMG checksum sidecar is missing or unsafe.")
        raw = os.read(fd, 257)
        after = os.fstat(fd)
        if len(raw) != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
        ):
            raise RuntimeError("DMG checksum sidecar changed while it was read.")
    finally:
        os.close(fd)
    try:
        parts = raw.decode("ascii").strip().split()
    except UnicodeDecodeError as exc:
        raise RuntimeError("DMG checksum sidecar has an invalid format.") from exc
    if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]) or parts[1] != dmg_path.name:
        raise RuntimeError("DMG checksum sidecar has an invalid format.")
    actual = sha256_file(dmg_path)
    if parts[0] != actual:
        raise RuntimeError("DMG checksum sidecar does not match the artifact.")
    return {"path": sidecar.name, "sha256": actual}


def read_packaged_product_version(app_path: Path) -> str:
    package_json = app_path / "Contents" / "Resources" / "app" / "package.json"
    try:
        payload = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Packaged App product metadata is missing or invalid.") from exc
    version = str(payload.get("version") or "").strip() if isinstance(payload, dict) else ""
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?", version):
        raise RuntimeError("Packaged App product version is invalid.")
    return version


def package_manifest_binding(app_path: Path, delivery_manifest_path: Path) -> dict[str, Any]:
    source_manifest_path = app_path.parent / "desktop-package-manifest.json"
    trace = verify_package_traceability(source_manifest_path, app_path)
    delivery_manifest_path.write_bytes(source_manifest_path.read_bytes())
    if sha256_file(delivery_manifest_path) != trace["manifest_sha256"]:
        raise RuntimeError("Delivery package manifest copy does not match the verified build manifest.")
    return {
        "schema": "echo-founder.package-manifest-binding.v1",
        "path": delivery_manifest_path.name,
        "sha256": trace["manifest_sha256"],
        "source_control": trace["source_control"],
        "shipped_runtime": trace["shipped_runtime"],
    }


def verify_dmg_manifest_traceability(dmg_path: Path, app_path: Path) -> dict[str, Any]:
    manifest_path = dmg_path.with_suffix(".manifest.json")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"DMG manifest is missing or invalid: {manifest_path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("DMG manifest must be a JSON object.")
    assert_release_manifest_portable(payload)
    actual_dmg_sha256 = sha256_file(dmg_path)
    if payload.get("sha256") != actual_dmg_sha256:
        raise RuntimeError("DMG manifest SHA-256 does not match the artifact.")
    checksum = verify_checksum_sidecar(dmg_path, str(payload.get("checksum_file") or ""))
    binding = payload.get("package_manifest")
    if not isinstance(binding, dict) or binding.get("schema") != "echo-founder.package-manifest-binding.v1":
        raise RuntimeError("DMG manifest has no versioned package-manifest binding.")
    if not re.fullmatch(r"[0-9a-f]{64}", str(binding.get("sha256") or "")):
        raise RuntimeError("DMG package-manifest binding has an invalid SHA-256.")
    source = binding.get("source_control")
    runtime = binding.get("shipped_runtime")
    if not isinstance(source, dict) or not isinstance(source.get("dirty"), bool):
        raise RuntimeError("DMG package-manifest binding does not preserve explicit source dirty state.")
    if not isinstance(runtime, dict):
        raise RuntimeError("DMG package-manifest binding does not preserve the shipped-runtime digest.")
    actual_runtime = runtime_tree_fingerprint(app_path / "Contents" / "Resources" / "aifios")
    for field in ("tree_sha256", "file_count", "directory_count", "symlink_count", "size_bytes"):
        if runtime.get(field) != actual_runtime[field]:
            raise RuntimeError(f"DMG package-manifest binding runtime {field} does not match the mounted App.")

    relative_manifest = Path(str(binding.get("path") or ""))
    if relative_manifest.is_absolute() or ".." in relative_manifest.parts:
        raise RuntimeError("DMG package-manifest binding path is not portable.")
    source_manifest = dmg_path.parent / relative_manifest
    source_manifest_verified = False
    if source_manifest.is_file():
        if sha256_file(source_manifest) != binding["sha256"]:
            raise RuntimeError("DMG manifest is not bound to the current package manifest SHA-256.")
        source_manifest_verified = True
    return {
        "status": "pass",
        "package_manifest_sha256": binding["sha256"],
        "source_manifest_verified": source_manifest_verified,
        "source_dirty": source["dirty"],
        "runtime_tree_sha256": actual_runtime["tree_sha256"],
        "dmg_sha256": actual_dmg_sha256,
        "checksum_file": checksum["path"],
    }


def read_distribution_mode(app_path: Path) -> str:
    """Read the package mode that controls the DMG's user-facing setup notes."""
    marker_path = app_path / "Contents" / "Resources" / "aifios-distribution.json"
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Packaged app is missing a valid distribution marker: {marker_path}") from exc
    if not isinstance(marker, dict):
        raise RuntimeError(f"Packaged app distribution marker is not an object: {marker_path}")
    mode = str(marker.get("mode") or "")
    if mode not in {"hosted-license", "local-self-config"}:
        raise RuntimeError(f"Packaged app has an unsupported distribution mode: {mode!r}")
    if mode == "hosted-license" and marker.get("deviceBinding") is not True:
        raise RuntimeError("Hosted package is missing its device-binding marker")
    return mode


def read_demo_unlock_required(app_path: Path) -> bool:
    """Return whether a local bundle contains a valid product-password gate."""
    config_path = app_path / "Contents" / "Resources" / "aifios" / "demo-unlock.json"
    if not config_path.exists():
        return False
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Packaged app has an invalid product password config: {config_path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"Packaged app product password config is not an object: {config_path}")
    if payload.get("schema") == "aifios.demo-unlock.v2":
        hashes = payload.get("codeHashes")
        valid = (
            payload.get("algorithm") == "sha256"
            and isinstance(hashes, list)
            and bool(hashes)
            and all(isinstance(item, str) and re.fullmatch(r"[a-f0-9]{64}", item) for item in hashes)
        )
        if valid:
            return True
    elif payload.get("schema") == "aifios.demo-unlock.v1":
        codes = payload.get("codes")
        if isinstance(codes, list) and any(isinstance(item, str) and item.strip() for item in codes):
            return True
    raise RuntimeError(f"Packaged app has an unsupported or empty product password config: {config_path}")


def require_hosted_distribution(mode: str) -> None:
    """Refuse to turn a local self-config app into a paid release artifact."""
    if mode != "hosted-license":
        raise RuntimeError(
            "Paid distribution requires a hosted-license app with device binding; "
            "the supplied app is local-self-config"
        )


def require_real_hosted_gateway(app_path: Path) -> None:
    """Never produce a distributable DMG that points at a documentation host."""
    bootstrap_path = app_path / "Contents" / "Resources" / "aifios" / "hosted-client.json"
    try:
        bootstrap = json.loads(bootstrap_path.read_text(encoding="utf-8"))
        origin = str(bootstrap.get("gatewayUrl") or "").strip()
        parsed = urlparse(origin)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError(f"Hosted package is missing a valid gateway bootstrap: {bootstrap_path}") from exc
    placeholder_hosts = {"example.com", "www.example.com", "gateway.example.com", "localhost", "127.0.0.1", "0.0.0.0"}
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.hostname.lower() in placeholder_hosts
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("Refusing to build a distributable hosted DMG with a placeholder or non-HTTPS gateway URL")


def verify_packaged_app(app_path: Path, bundle_id: str, package_architecture: str = DEFAULT_DESKTOP_ARCH) -> dict[str, Any]:
    resources_root = app_path / "Contents" / "Resources" / "aifios"
    next_dist = resources_root / "ui" / DESKTOP_DIST_DIR
    standalone_dist = next_standalone_dist_dir(next_dist)
    required = [
        app_path / "Contents" / "Info.plist",
        app_path / "Contents" / "MacOS" / app_path.stem,
        app_path / "Contents" / "Resources" / BRAND_ICON_FILENAME,
        app_path / "Contents" / "Resources" / "app" / "package.json",
        *(app_path / "Contents" / "Resources" / "app" / "electron" / name for name in electron_runtime_module_names()),
        resources_root / "scripts" / "aifios.py",
        resources_root / "skills" / "content-runtime" / "scripts" / "content_runtime.py",
        resources_root / MATERIAL_OCR_BINARY_RELATIVE,
        next_dist / "BUILD_ID",
        next_dist / NEXT_BUILD_MANIFEST,
        next_standalone_root(next_dist) / "server.js",
        standalone_dist / "BUILD_ID",
        next_standalone_root(next_dist) / "node_modules" / "next" / "package.json",
        *(standalone_dist / item for item in REQUIRED_NEXT_ROUTE_ARTIFACTS),
        *(resources_root / "skills" / TIKOMNI_SKILL_NAME / item for item in TIKOMNI_BUNDLE_FILES),
        resources_root / "runtime" / "playwright" / "manifest.json",
        *(resources_root / "runtime" / "python" / architecture / "bin" / "python3" for architecture in package_architectures(package_architecture)),
        *(resources_root / "runtime" / "playwright" / architecture / "chrome-headless-shell" for architecture in package_architectures(package_architecture)),
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("Packaged app is missing required file(s):\n" + "\n".join(missing))
    material_ocr = resources_root / MATERIAL_OCR_BINARY_RELATIVE
    if not material_ocr.is_file() or not os.access(material_ocr, os.X_OK):
        raise RuntimeError(f"Packaged macOS PDF OCR helper is not executable: {material_ocr}")
    if (resources_root / "ui" / "node_modules").exists():
        raise RuntimeError("Packaged app includes full UI node_modules instead of the traced standalone runtime")

    for architecture in package_architectures(package_architecture):
        python = resources_root / "runtime" / "python" / architecture / "bin" / "python3"
        actual = macho_architectures(python)
        expected = lipo_architecture_name(architecture)
        if expected not in actual:
            raise RuntimeError(f"Packaged Python runtime has the wrong architecture for {architecture}: {python} ({sorted(actual)})")
    electron_architecture = verify_electron_runtime_architecture(
        app_path,
        {lipo_architecture_name(architecture) for architecture in package_architectures(package_architecture)},
    )
    next_native_runtime = verify_next_native_runtime(next_standalone_root(next_dist), package_architecture)
    playwright_runtime = verify_playwright_runtime(resources_root, package_architecture)
    brand_icon = verify_brand_icon(app_path)
    customer_bundle_hygiene = verify_customer_bundle_hygiene(resources_root)

    with (app_path / "Contents" / "Info.plist").open("rb") as handle:
        info = plistlib.load(handle)
    actual_bundle_id = str(info.get("CFBundleIdentifier") or "")
    if actual_bundle_id != bundle_id:
        raise RuntimeError(f"Unexpected bundle id: {actual_bundle_id} != {bundle_id}")
    minimum_macos_version = str(info.get("LSMinimumSystemVersion") or "")
    if minimum_macos_version != MINIMUM_MACOS_VERSION:
        raise RuntimeError(
            f"Unexpected minimum macOS version: {minimum_macos_version or 'missing'} != {MINIMUM_MACOS_VERSION}"
        )

    run(["codesign", "--verify", "--deep", "--strict", str(app_path)], timeout=120)
    distribution_mode = read_distribution_mode(app_path)
    demo_unlock_required = read_demo_unlock_required(app_path)
    if distribution_mode == "hosted-license" and demo_unlock_required:
        raise RuntimeError("Hosted package cannot also contain a local product password config")
    return {
        "bundle_id": actual_bundle_id,
        "version": str(info.get("CFBundleShortVersionString") or ""),
        "minimum_macos_version": minimum_macos_version,
        "architecture": package_architecture,
        "executable": str(info.get("CFBundleExecutable") or ""),
        "electron_architecture": electron_architecture,
        "next_native_runtime": next_native_runtime,
        "playwright_runtime": playwright_runtime,
        "brand_icon": brand_icon,
        "customer_bundle_hygiene": customer_bundle_hygiene,
        "distribution_mode": distribution_mode,
        "demo_unlock_required": demo_unlock_required,
    }


def ensure_dmg_source(
    app_path: Path,
    bundle_id: str,
    package_architecture: str = DEFAULT_DESKTOP_ARCH,
    require_hosted: bool = False,
    source_dir: Path | None = None,
) -> Path:
    app_info = verify_packaged_app(app_path, bundle_id, package_architecture)
    distribution_mode = app_info["distribution_mode"]
    if require_hosted:
        require_hosted_distribution(distribution_mode)
    hosted = distribution_mode == "hosted-license"
    demo_unlock_required = bool(app_info["demo_unlock_required"])
    if hosted:
        require_real_hosted_gateway(app_path)
    source_dir = source_dir or app_path.parent
    source_dir.mkdir(parents=True, exist_ok=True)
    staged_app = source_dir / app_path.name
    if staged_app.resolve(strict=False) != app_path.resolve(strict=False):
        if staged_app.exists() or staged_app.is_symlink():
            raise RuntimeError(f"Refusing to overwrite an existing staged app: {staged_app}")
        run(["ditto", str(app_path), str(staged_app)], timeout=600)
    applications_link = source_dir / "Applications"
    if applications_link.exists() or applications_link.is_symlink():
        if not applications_link.is_symlink() or os.readlink(applications_link) != "/Applications":
            if applications_link.is_dir() and not applications_link.is_symlink():
                raise RuntimeError(f"Refusing to replace non-symlink Applications directory: {applications_link}")
            applications_link.unlink()
    if not applications_link.exists():
        applications_link.symlink_to("/Applications")

    app_display_name = app_path.stem
    app_bundle_name = app_path.name
    if hosted:
        english_setup = [
            "On first launch, enter the unique activation code supplied after purchase. The code binds this device and is required before use.",
            "Do not share the activation code. Model and research requests are checked by the hosted gateway.",
        ]
        chinese_setup = [
            "4. 首次进入后，在“设置”输入购买后获得的唯一授权码；授权码首次使用会绑定当前设备，未激活不能进入工作台。",
            "5. 不要转发授权码。模型与研究请求由托管网关按授权额度校验。",
            "6. 安装包已经内置运行环境，使用者不需要安装 Node.js、Python 或其他开发工具。",
            f"7. 安装包架构：{app_info['architecture']}。",
        ]
    elif demo_unlock_required:
        english_setup = [
            "On first launch, enter the product usage password supplied separately by the product owner.",
            "Configure your own model API key in Settings after the product is unlocked.",
        ]
        chinese_setup = [
            "4. 首次进入后，输入产品所有者单独提供的产品使用密码。",
            "5. 解锁后，在“设置”填写自己的模型 API Key；需要公开样本研究时，再填写自己的 TikOmni 凭证。",
            "6. 安装包已经内置运行环境，使用者不需要安装 Node.js、Python 或其他开发工具。",
            f"7. 安装包架构：{app_info['architecture']}。",
        ]
    else:
        english_setup = [
            "On first launch, configure your own model API key in Settings.",
            "Configure TikOmni locally only when you need public-sample research.",
        ]
        chinese_setup = [
            "4. 首次进入后，在“设置”填写自己的模型 API Key；需要公开样本研究时，再填写自己的 TikOmni 凭证。",
            "5. 安装包已经内置运行环境，使用者不需要安装 Node.js、Python 或其他开发工具。",
            f"6. 安装包架构：{app_info['architecture']}。",
        ]

    install_note = source_dir / "README-INSTALL.txt"
    install_note.write_text(
        "\n".join(
            [
                f"{app_display_name} desktop app",
                "",
                f"Drag {app_bundle_name} into Applications.",
                *english_setup,
                f"Architecture: {app_info['architecture']}",
                "This is an internal unsigned/ad-hoc signed build, not a notarized public installer.",
                f"Bundle: {app_info['bundle_id']}",
                f"Version: {app_info['version']}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    chinese_install_note = source_dir / "README-安装说明.txt"
    chinese_install_note.write_text(
        "\n".join(
            [
                f"{app_display_name} 桌面安装说明",
                "",
                f"1. 将 {app_bundle_name} 拖入 Applications（应用程序）文件夹。",
                f"2. 首次打开时，若 macOS 显示安全提示，请按住 Control 键点按 {app_bundle_name}，选择“打开”，再确认“打开”。",
                f"3. 如仍被拦截：前往“系统设置 > 隐私与安全性”，在 {app_display_name} 提示下选择“仍要打开”。",
                *chinese_setup,
                "",
                "此版本用于本地内测，采用 ad-hoc 签名；正式外部分发版将在完成 Apple Developer ID 签名与公证后提供。",
                f"Bundle: {app_info['bundle_id']}",
                f"Version: {app_info['version']}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    verify_dmg_source_hygiene(source_dir, app_path.name)
    return source_dir


def verify_dmg_source_hygiene(source_dir: Path, app_name: str) -> dict[str, Any]:
    allowed = {app_name, "Applications", "README-INSTALL.txt", "README-安装说明.txt"}
    actual = {path.name for path in source_dir.iterdir()}
    unexpected = sorted(actual - allowed)
    missing = sorted(allowed - actual)
    if unexpected or missing:
        raise RuntimeError(
            "DMG staging tree is not the customer allowlist: "
            f"missing={missing}, unexpected={unexpected}"
        )
    applications = source_dir / "Applications"
    if not applications.is_symlink() or os.readlink(applications) != "/Applications":
        raise RuntimeError("DMG staging tree has an invalid Applications link")
    if not (source_dir / app_name).is_dir():
        raise RuntimeError(f"DMG staging tree is missing the app bundle: {app_name}")
    return {"status": "pass", "items": sorted(actual)}


def create_dmg(
    app_path: Path,
    dmg_path: Path,
    volume_name: str,
    bundle_id: str,
    package_architecture: str = DEFAULT_DESKTOP_ARCH,
    require_hosted: bool = False,
) -> dict[str, Any]:
    require_macos_tools()
    dmg_path.parent.mkdir(parents=True, exist_ok=True)
    if dmg_path.exists():
        dmg_path.unlink()
    with tempfile.TemporaryDirectory(prefix=".echo-founder-dmg-source-", dir=dmg_path.parent) as tmp_dir:
        source_dir = ensure_dmg_source(
            app_path,
            bundle_id,
            package_architecture,
            require_hosted,
            Path(tmp_dir),
        )
        staging_hygiene = verify_dmg_source_hygiene(source_dir, app_path.name)
        run(
            [
                "hdiutil",
                "create",
                "-volname",
                volume_name,
                "-srcfolder",
                str(source_dir),
                "-format",
                "UDZO",
                "-ov",
                str(dmg_path),
            ],
            timeout=600,
        )
    run(["hdiutil", "verify", str(dmg_path)], timeout=300)

    with (app_path / "Contents" / "Info.plist").open("rb") as handle:
        packaged_plist = plistlib.load(handle)
    delivery_package_manifest = dmg_path.with_suffix(".package-manifest.json")
    package_traceability = package_manifest_binding(app_path, delivery_package_manifest)

    checksum = write_checksum_sidecar(dmg_path)
    manifest = {
        "status": "packed",
        "artifact": "dmg",
        "dmg_path": dmg_path.name,
        "app_name": app_path.name,
        "product": DEFAULT_APP_NAME,
        "version": read_packaged_product_version(app_path),
        "apple_bundle_short_version": str(packaged_plist.get("CFBundleShortVersionString") or ""),
        "apple_bundle_build_version": str(packaged_plist.get("CFBundleVersion") or ""),
        "source_app_path": app_path.name,
        "mounted_app_path": f"/Volumes/{volume_name}/{app_path.name}",
        # Backwards-compatible build input path. Minimal DMG-only release
        # layouts may prune this expanded app after the DMG has been verified.
        "app_path": app_path.name,
        "volume_name": volume_name,
        "bundle_id": bundle_id,
        "minimum_macos_version": MINIMUM_MACOS_VERSION,
        "architecture": package_architecture,
        "created_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "size_bytes": dmg_path.stat().st_size,
        "sha256": checksum["sha256"],
        "checksum_file": checksum["path"],
        "format": "UDZO",
        "distribution_mode": read_distribution_mode(app_path),
        "demo_unlock_required": read_demo_unlock_required(app_path),
        "staging_hygiene": staging_hygiene,
        "package_manifest": package_traceability,
    }
    manifest_path = dmg_path.with_suffix(".manifest.json")
    assert_release_manifest_portable(manifest)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def mount_dmg(dmg_path: Path) -> Path:
    result = run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noverify", "-plist", str(dmg_path)], timeout=120)
    payload = plistlib.loads(result.stdout.encode("utf-8"))
    entities = payload.get("system-entities", [])
    for entity in entities:
        mount_point = entity.get("mount-point")
        if mount_point:
            return Path(str(mount_point))
    raise RuntimeError(f"Unable to find mount point for DMG: {dmg_path}")


def detach_mount(mount_point: Path) -> None:
    run(["hdiutil", "detach", str(mount_point)], timeout=120)


def verify_dmg(
    dmg_path: Path,
    app_name: str,
    volume_name: str,
    bundle_id: str,
    package_architecture: str = DEFAULT_DESKTOP_ARCH,
    require_hosted: bool = False,
) -> dict[str, Any]:
    require_macos_tools()
    run(["hdiutil", "verify", str(dmg_path)], timeout=300)
    mount_point = mount_dmg(dmg_path)
    try:
        if mount_point.name != volume_name:
            raise RuntimeError(f"Unexpected mounted volume name: {mount_point.name} != {volume_name}")
        app_path = mount_point / f"{app_name}.app"
        if not app_path.exists():
            raise RuntimeError(f"Mounted DMG does not contain app: {app_path}")
        mounted_hygiene = verify_dmg_source_hygiene(mount_point, app_path.name)
        app_info = verify_packaged_app(app_path, bundle_id, package_architecture)
        traceability = verify_dmg_manifest_traceability(dmg_path, app_path)
        if require_hosted:
            require_hosted_distribution(app_info["distribution_mode"])
        if app_info["distribution_mode"] == "hosted-license":
            require_real_hosted_gateway(app_path)
        applications_link = mount_point / "Applications"
        install_note = mount_point / "README-INSTALL.txt"
        chinese_install_note = mount_point / "README-安装说明.txt"
        if not applications_link.is_symlink() or os.readlink(applications_link) != "/Applications":
            raise RuntimeError("Mounted DMG is missing Applications symlink")
        if not install_note.is_file():
            raise RuntimeError("Mounted DMG is missing README-INSTALL.txt")
        if not chinese_install_note.is_file():
            raise RuntimeError("Mounted DMG is missing README-安装说明.txt")
        install_text = install_note.read_text(encoding="utf-8")
        chinese_install_text = chinese_install_note.read_text(encoding="utf-8")
        if app_info["distribution_mode"] == "hosted-license":
            if "activation code" not in install_text.lower() or "授权码" not in chinese_install_text:
                raise RuntimeError("Hosted DMG install notes do not require device activation")
        elif app_info["demo_unlock_required"]:
            if "usage password" not in install_text.lower() or "使用密码" not in chinese_install_text:
                raise RuntimeError("Product-password DMG install notes do not explain the usage password")
        elif (
            "activation code" in install_text.lower()
            or "usage password" in install_text.lower()
            or "授权码" in chinese_install_text
            or "使用密码" in chinese_install_text
        ):
            raise RuntimeError("Local self-config DMG install notes unexpectedly require an access credential")
        return {
            "status": "verified",
            "dmg_path": str(dmg_path),
            "mount_point": str(mount_point),
            "app_path": str(app_path),
            "app": app_info,
            "mounted_hygiene": mounted_hygiene,
            "traceability": traceability,
            "distribution_mode": app_info["distribution_mode"],
            "size_bytes": dmg_path.stat().st_size,
            "sha256": sha256_file(dmg_path),
        }
    finally:
        detach_mount(mount_point)


def build_command(args: argparse.Namespace) -> int:
    manifest = create_dmg(
        app_path=Path(args.app_path).expanduser().resolve(),
        dmg_path=Path(args.dmg_path).expanduser().resolve(),
        volume_name=args.volume_name,
        bundle_id=args.bundle_id,
        package_architecture=args.arch,
        require_hosted=args.require_hosted_license,
    )
    print("PASS desktop dmg")
    print(f"dmg_path={manifest['dmg_path']}")
    print(f"manifest_path={manifest['manifest_path']}")
    print(f"sha256={manifest['sha256']}")
    print(f"size_bytes={manifest['size_bytes']}")
    return 0


def verify_command(args: argparse.Namespace) -> int:
    result = verify_dmg(
        dmg_path=Path(args.dmg_path).expanduser().resolve(),
        app_name=args.app_name,
        volume_name=args.volume_name,
        bundle_id=args.bundle_id,
        package_architecture=args.arch,
        require_hosted=args.require_hosted_license,
    )
    print("PASS desktop dmg verify")
    print(f"dmg_path={result['dmg_path']}")
    print(f"sha256={result['sha256']}")
    print(f"size_bytes={result['size_bytes']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and verify a local Echo Founder macOS DMG")
    sub = parser.add_subparsers(dest="command", required=True)

    common: dict[str, Any] = {
        "app_name": DEFAULT_APP_PATH.stem,
        "volume_name": DEFAULT_VOLUME_NAME,
        "bundle_id": DEFAULT_BUNDLE_ID,
    }

    p_build = sub.add_parser("build", help="create a compressed DMG from dist/desktop/Echo Founder.app")
    p_build.add_argument("--app-path", default=str(DEFAULT_APP_PATH))
    p_build.add_argument("--dmg-path", default=str(DEFAULT_DMG_PATH))
    p_build.add_argument("--volume-name", default=common["volume_name"])
    p_build.add_argument("--bundle-id", default=common["bundle_id"])
    p_build.add_argument("--arch", choices=["universal", "arm64", "x64"], default=DEFAULT_DESKTOP_ARCH)
    p_build.add_argument(
        "--require-hosted-license",
        action="store_true",
        help="refuse to create a paid DMG from a local-self-config app",
    )
    p_build.set_defaults(func=build_command)

    p_verify = sub.add_parser("verify", help="mount and verify a generated DMG")
    p_verify.add_argument("--dmg-path", default=str(DEFAULT_DMG_PATH))
    p_verify.add_argument("--app-name", default=common["app_name"])
    p_verify.add_argument("--volume-name", default=common["volume_name"])
    p_verify.add_argument("--bundle-id", default=common["bundle_id"])
    p_verify.add_argument("--arch", choices=["universal", "arm64", "x64"], default=DEFAULT_DESKTOP_ARCH)
    p_verify.add_argument(
        "--require-hosted-license",
        action="store_true",
        help="refuse to verify a local-self-config DMG as a paid artifact",
    )
    p_verify.set_defaults(func=verify_command)

    args = parser.parse_args()
    try:
        return int(args.func(args))
    except subprocess.CalledProcessError as exc:
        print(f"FAIL desktop dmg command exited with {exc.returncode}: {' '.join(exc.cmd)}", file=sys.stderr)
        print(exc.stdout or "", file=sys.stderr)
        return int(exc.returncode or 1)
    except Exception as exc:
        print(f"FAIL desktop dmg: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
