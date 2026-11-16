#!/usr/bin/env python3
"""Assess Echo Founder artifacts for internal and external macOS readiness."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import plistlib
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from desktop_package import (
    BRAND_ICON_FILENAME,
    assert_release_manifest_portable,
    portable_release_manifest,
    DESKTOP_DIST_DIR,
    electron_runtime_module_names,
    lipo_architecture_name,
    MATERIAL_OCR_BINARY_RELATIVE,
    macho_architectures,
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
)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP_PATH = REPO_ROOT / "dist" / "desktop" / "Echo Founder.app"
DEFAULT_DMG_PATH = REPO_ROOT / "dist" / "Echo-Founder-0.2.0-beta.2-mac-arm64.dmg"
DEFAULT_REPORT_DIR = REPO_ROOT / "quality" / "system-audits"
DEFAULT_BUNDLE_ID = "com.echofounder.desktop"
DEFAULT_ARCHITECTURE = "arm64"
SYSTEM_DYLIB_PREFIXES = ("/System/Library/", "/usr/lib/")
BUNDLED_DYLIB_PREFIXES = ("@rpath/", "@loader_path/", "@executable_path/")
PASS_LABEL = "PASS desktop release assessment"
FAIL_LABEL = "FAIL desktop release assessment"

BLOCKER_ACTIONS = {
    "missing-app": "执行 make desktop-package 生成 dist/desktop/Echo Founder.app。",
    "missing-dmg": "执行 make desktop-dmg 生成 dist/Echo-Founder-0.2.0-beta.2-mac-arm64.dmg。",
    "app-required-files-missing": "重新执行 make desktop-package；确认 Electron app、aifios runtime、skills 和 .next-desktop 都被复制进 App bundle。",
    "bundle-id-mismatch": "用正确 DESKTOP_DMG_BUNDLE_ID 重新打包，确保 Info.plist 的 CFBundleIdentifier 与发布配置一致。",
    "dmg-manifest-sha256-mismatch": "重新执行 make desktop-dmg，使 DMG 和 .manifest.json 的 SHA256 一致。",
    "dmg-manifest-local-path-leak": "重新执行 make desktop-dmg；交付 manifest 不得包含 /Users、/home 或构建临时目录。",
    "dmg-package-manifest-binding-invalid": "重新执行 make desktop-package 与 make desktop-dmg，确保 DMG manifest 绑定 package manifest 摘要和 runtime tree digest。",
    "source-tree-dirty": "提交并冻结全部发布源码后重新打包；正式商业门禁不接受 dirty=true 的构建。",
    "package-traceability-invalid": "重新打包并校验 Git baseline/current SHA 与 shipped runtime tree digest。",
    "codesign-verify-failed": "重新执行 make desktop-package 或 make desktop-sign；正式外部分发必须使用 Developer ID 签名。",
    "developer-id-signature-missing": "配置 DESKTOP_SIGN_IDENTITY/AIFIOS_DEVELOPER_ID_APPLICATION 后执行 make desktop-external-release。",
    "hardened-runtime-missing": "用 Developer ID 重新签名 App，并带 --options runtime；现有 desktop_notarize.py sign_app 已包含该参数。",
    "app-notarization-ticket-missing": "执行 make desktop-external-release，完成 App zip notarize 和 App staple。",
    "dmg-notarization-ticket-missing": "执行 make desktop-external-release，完成 DMG notarize 和 DMG staple。",
    "gatekeeper-app-rejected": "完成 Developer ID 签名、公证和 staple 后重新运行 make desktop-external-verify。",
    "gatekeeper-dmg-rejected": "完成 DMG Developer ID 签名、公证和 staple 后重新运行 make desktop-external-verify。",
    "quarantine-dmg-rejected": "在带 quarantine 模拟下重新验证 DMG；通过前不得对外分发。",
    "python-unavailable": "确认本机 python3 可用；打包版仍应优先依赖内置 Python runtime。",
    "python-runtime-not-embedded": "执行 DESKTOP_EMBED_PYTHON_RUNTIME=required make desktop-package，确保 App 内置 Python。",
    "embedded-python-runtime-nonportable": "检查 runtime/python 下非系统 dylib，确保 install_name 已改写为 @loader_path 或系统路径。",
    "app-architecture-invalid": "按本次交付目标重新打包，确保 Electron shell 包含要求的架构。",
    "next-native-runtime-invalid": "重新打包并确认 traced Next runtime 内含目标架构的 Sharp/SWC 运行包。",
    "playwright-runtime-invalid": "重新打包并确认 runtime/playwright 内含目标架构的 Chromium headless shell。",
    "material-ocr-runtime-invalid": "重新运行 make material-ocr-build 后执行 make desktop-package，确保内置 PDF OCR 包含目标架构。",
    "brand-icon-invalid": "重新执行 make desktop-package，确保 Info.plist 使用 EchoFounder.icns 且 App 不含 Electron 默认图标。",
    "customer-bundle-hygiene-invalid": "重新执行 make desktop-package；客户包不得包含内部文档、测试、真实项目数据或构建机绝对路径。",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def run_command(command: list[str], timeout: int = 120, env: dict[str, str] | None = None) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        return {
            "command": command,
            "returncode": int(result.returncode),
            "ok": result.returncode == 0,
            "output": result.stdout.strip(),
        }
    except Exception as exc:
        return {
            "command": command,
            "returncode": None,
            "ok": False,
            "output": str(exc),
        }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_info_plist(app_path: Path) -> dict[str, Any]:
    info_path = app_path / "Contents" / "Info.plist"
    if not info_path.exists():
        return {}
    try:
        with info_path.open("rb") as handle:
            return dict(plistlib.load(handle))
    except Exception:
        return {}


def manifest_for_dmg(dmg_path: Path) -> dict[str, Any]:
    manifest_path = dmg_path.with_suffix(".manifest.json")
    if not manifest_path.exists():
        return {"exists": False, "path": str(manifest_path)}
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"exists": True, "path": str(manifest_path), "valid_json": False, "error": str(exc)}
    actual_sha256 = sha256_file(dmg_path) if dmg_path.exists() else ""
    portable_paths = True
    portability_error = ""
    try:
        assert_release_manifest_portable(payload)
    except RuntimeError as exc:
        portable_paths = False
        portability_error = str(exc)
    return {
        "exists": True,
        "path": str(manifest_path),
        "valid_json": True,
        "declared_sha256": payload.get("sha256", ""),
        "actual_sha256": actual_sha256,
        "sha256_matches": bool(actual_sha256 and payload.get("sha256") == actual_sha256),
        "portable_paths": portable_paths,
        "portability_error": portability_error,
        "payload": payload,
    }


def tool_status(name: str, args: list[str] | None = None, required: bool = True) -> dict[str, Any]:
    binary = shutil.which(name)
    if not binary:
        return {"name": name, "path": "", "required": required, "status": "fail" if required else "warn", "version": ""}
    version = ""
    if args:
        result = run_command([binary, *args], timeout=10)
        version = result.get("output", "").splitlines()[0] if result.get("output") else ""
    return {"name": name, "path": binary, "required": required, "status": "pass", "version": version}


def first_line(value: str) -> str:
    return next((line.strip() for line in value.splitlines() if line.strip()), "")


def dylib_dependencies(binary: Path) -> list[str]:
    if not shutil.which("otool") or not binary.exists():
        return []
    result = run_command(["otool", "-L", str(binary)], timeout=15)
    if not result.get("ok"):
        return []
    dependencies: list[str] = []
    for line in str(result.get("output") or "").splitlines()[1:]:
        value = line.strip().split(" ", 1)[0]
        if value:
            dependencies.append(value)
    return dependencies


def external_dylibs(binary: Path) -> list[str]:
    external: list[str] = []
    for dep in dylib_dependencies(binary):
        if dep.startswith((*SYSTEM_DYLIB_PREFIXES, *BUNDLED_DYLIB_PREFIXES)):
            continue
        external.append(dep)
    return external


def dylib_scan(files: list[Path]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for file_path in files:
        external = external_dylibs(file_path)
        if external:
            result[str(file_path)] = external
    return result


def python_runtime_macho_files(runtime_root: Path) -> list[Path]:
    if not shutil.which("otool") or not runtime_root.exists():
        return []
    result: list[Path] = []
    seen: set[Path] = set()
    for path in runtime_root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in {".dylib", ".so"} and path.parent.name != "bin":
            continue
        try:
            actual = path.resolve()
        except OSError:
            actual = path
        if actual in seen:
            continue
        probe = run_command(["otool", "-L", str(actual)], timeout=15)
        if probe.get("ok"):
            seen.add(actual)
            result.append(actual)
    return result


def embedded_python_runtime_status(app_path: Path, package_architecture: str) -> dict[str, Any]:
    runtime_root = app_path / "Contents" / "Resources" / "aifios" / "runtime" / "python"
    host_value = platform.machine().strip().lower()
    host_architecture = "arm64" if host_value in {"arm64", "aarch64"} else "x64"
    python_env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
    content_runtime = app_path / "Contents" / "Resources" / "aifios" / "skills" / "content-runtime" / "scripts" / "content_runtime.py"
    architectures: dict[str, Any] = {}
    all_portable = True
    all_present = True
    active_runtime_ok = False

    for architecture in package_architectures(package_architecture):
        root = runtime_root / architecture
        binary = root / "bin" / "python3"
        actual_architectures = macho_architectures(binary)
        expected_architecture = lipo_architecture_name(architecture)
        exists = binary.is_file() and expected_architecture in actual_architectures
        macho_files = python_runtime_macho_files(root)
        nonportable = dylib_scan(macho_files)
        entry: dict[str, Any] = {
            "runtime_root": str(root),
            "binary": str(binary),
            "exists": exists,
            "macho_architectures": sorted(actual_architectures),
            "version": "cross-architecture-not-executed",
            "stdlib_smoke": "not-run-on-build-host",
            "content_runtime_smoke": "not-run-on-build-host",
            "portability": "review_required" if nonportable else "self_contained_or_system_only",
            "nonportable_dylibs": nonportable,
            "macho_files_checked": len(macho_files),
        }
        if architecture == host_architecture and exists:
            version = run_command([str(binary), "--version"], timeout=15, env=python_env)
            stdlib_smoke = run_command(
                [str(binary), "-c", "import json, pathlib, sqlite3, ssl, sys; print(sys.version.split()[0])"],
                timeout=15,
                env=python_env,
            )
            with tempfile.TemporaryDirectory(prefix="aifios-release-python-") as tmp_dir:
                runtime_smoke = run_command(
                    [str(binary), str(content_runtime), "--project", tmp_dir, "init"],
                    timeout=30,
                    env=python_env,
                )
            active_runtime_ok = bool(version.get("ok") and stdlib_smoke.get("ok") and runtime_smoke.get("ok"))
            entry.update(
                {
                    "version": first_line(str(version.get("output") or "")),
                    "stdlib_smoke": "pass" if stdlib_smoke.get("ok") else str(stdlib_smoke.get("output") or ""),
                    "content_runtime_smoke": "pass" if runtime_smoke.get("ok") else str(runtime_smoke.get("output") or ""),
                }
            )
        all_present = all_present and exists
        all_portable = all_portable and not nonportable
        architectures[architecture] = entry

    return {
        "status": "pass" if all_present and active_runtime_ok else ("missing" if not all_present else "fail"),
        "runtime_root": str(runtime_root),
        "host_architecture": host_architecture,
        "architectures": architectures,
        "portability": "self_contained_or_system_only" if all_portable else "review_required",
    }


def electron_runtime_status(app_path: Path, package_architecture: str) -> dict[str, Any]:
    try:
        expected = {lipo_architecture_name(item) for item in package_architectures(package_architecture)}
        verification = verify_electron_runtime_architecture(app_path, expected)
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}
    return {"status": "pass", **verification}


def next_native_runtime_status(app_path: Path, package_architecture: str) -> dict[str, Any]:
    standalone_root = next_standalone_root(
        app_path / "Contents" / "Resources" / "aifios" / "ui" / DESKTOP_DIST_DIR
    )
    try:
        verification = verify_next_native_runtime(standalone_root, package_architecture)
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}
    return {"status": "pass", **verification}


def playwright_runtime_status(app_path: Path, package_architecture: str) -> dict[str, Any]:
    resources_root = app_path / "Contents" / "Resources" / "aifios"
    try:
        verification = verify_playwright_runtime(resources_root, package_architecture)
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}
    return {"status": "pass", **verification}


def material_ocr_runtime_status(app_path: Path, package_architecture: str) -> dict[str, Any]:
    binary = app_path / "Contents" / "Resources" / "aifios" / MATERIAL_OCR_BINARY_RELATIVE
    expected = {lipo_architecture_name(item) for item in package_architectures(package_architecture)}
    actual = macho_architectures(binary)
    executable = binary.is_file() and os.access(binary, os.X_OK)
    return {
        "status": "pass" if executable and expected.issubset(actual) else ("missing" if not binary.is_file() else "fail"),
        "path": str(binary),
        "executable": executable,
        "expected_architectures": sorted(expected),
        "actual_architectures": sorted(actual),
    }


def signing_summary(app_path: Path) -> dict[str, Any]:
    if not app_path.exists():
        return {"status": "missing", "developer_id": False, "hardened_runtime": False, "output": "missing app"}
    details = run_command(["codesign", "--display", "--verbose=4", str(app_path)], timeout=120)
    output = str(details.get("output") or "")
    developer_id = "Authority=Developer ID Application:" in output
    hardened_runtime = "Runtime Version=" in output or "runtime" in output.lower()
    signature_kind = "developer-id" if developer_id else ("ad-hoc" if "Signature=adhoc" in output else "unknown")
    return {
        "status": "pass" if details.get("ok") else "fail",
        "signature_kind": signature_kind,
        "developer_id": developer_id,
        "hardened_runtime": hardened_runtime,
        "details": details,
    }


def stapler_validation(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"status": "missing", "path": str(path), "ok": False, "output": "missing artifact"}
    if not shutil.which("xcrun"):
        return {"status": "skipped", "path": str(path), "ok": False, "output": "xcrun missing"}
    result = run_command(["xcrun", "stapler", "validate", str(path)], timeout=120)
    return {
        "status": "pass" if result.get("ok") else "missing",
        "path": str(path),
        "ok": bool(result.get("ok")),
        "result": result,
    }


def required_app_files(app_path: Path, package_architecture: str) -> list[dict[str, Any]]:
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
        *(resources_root / "runtime" / "python" / architecture / "bin" / "python3" for architecture in package_architectures(package_architecture)),
        resources_root / "runtime" / "playwright" / "manifest.json",
        *(resources_root / "runtime" / "playwright" / architecture / "chrome-headless-shell" for architecture in package_architectures(package_architecture)),
    ]
    return [{"path": str(path), "exists": path.exists()} for path in required]


def brand_icon_status(app_path: Path) -> dict[str, Any]:
    try:
        return {"status": "pass", **verify_brand_icon(app_path)}
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}


def customer_bundle_hygiene_status(app_path: Path) -> dict[str, Any]:
    try:
        return {
            "status": "pass",
            **verify_customer_bundle_hygiene(app_path / "Contents" / "Resources" / "aifios"),
        }
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}


def package_traceability_status(app_path: Path) -> dict[str, Any]:
    try:
        return verify_package_traceability(
            app_path.parent / "desktop-package-manifest.json",
            app_path,
        )
    except Exception as exc:
        return {"status": "fail", "error": str(exc)}


def quarantine_assessment(dmg_path: Path) -> dict[str, Any]:
    if not dmg_path.exists() or not shutil.which("xattr"):
        return {"status": "skipped", "reason": "DMG or xattr unavailable"}
    with tempfile.TemporaryDirectory(prefix="aifios-gatekeeper-") as tmp_dir:
        tmp_dmg = Path(tmp_dir) / dmg_path.name
        shutil.copy2(dmg_path, tmp_dmg)
        quarantine_value = f"0081;{int(datetime.now().timestamp()):x};EchoFounder;EchoFounder"
        set_result = run_command(["xattr", "-w", "com.apple.quarantine", quarantine_value, str(tmp_dmg)], timeout=30)
        read_result = run_command(["xattr", "-p", "com.apple.quarantine", str(tmp_dmg)], timeout=30)
        assess_result = run_command(["spctl", "--assess", "--type", "open", "--verbose=4", str(tmp_dmg)], timeout=120)
        return {
            "status": "pass" if assess_result["ok"] else "blocked",
            "quarantine_value": quarantine_value,
            "set_xattr": set_result,
            "read_xattr": read_result,
            "spctl": assess_result,
        }


def release_blockers(report: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not report["app"]["exists"]:
        blockers.append("missing-app")
    if not report["dmg"]["exists"]:
        blockers.append("missing-dmg")
    if any(not item["exists"] for item in report["app"]["required_files"]):
        blockers.append("app-required-files-missing")
    if report["app"]["bundle_id"] != report["expected_bundle_id"]:
        blockers.append("bundle-id-mismatch")
    if not report["dmg"]["manifest"].get("sha256_matches"):
        blockers.append("dmg-manifest-sha256-mismatch")
    if not report["dmg"]["manifest"].get("portable_paths"):
        blockers.append("dmg-manifest-local-path-leak")
    dmg_binding = report["dmg"]["manifest"].get("payload", {}).get("package_manifest", {})
    if not isinstance(dmg_binding, dict) or dmg_binding.get("schema") != "echo-founder.package-manifest-binding.v1":
        blockers.append("dmg-package-manifest-binding-invalid")
    if report.get("package_traceability", {}).get("status") != "pass":
        blockers.append("package-traceability-invalid")
    elif report["package_traceability"].get("source_control", {}).get("dirty") is True:
        blockers.append("source-tree-dirty")
    if not report["signing"]["codesign_verify"].get("ok"):
        blockers.append("codesign-verify-failed")
    if not report["signing"].get("summary", {}).get("developer_id"):
        blockers.append("developer-id-signature-missing")
    if not report["signing"].get("summary", {}).get("hardened_runtime"):
        blockers.append("hardened-runtime-missing")
    if not report.get("notarization", {}).get("app_stapler", {}).get("ok"):
        blockers.append("app-notarization-ticket-missing")
    if not report.get("notarization", {}).get("dmg_stapler", {}).get("ok"):
        blockers.append("dmg-notarization-ticket-missing")
    if not report["gatekeeper"]["app_spctl"].get("ok"):
        blockers.append("gatekeeper-app-rejected")
    if not report["gatekeeper"]["dmg_spctl"].get("ok"):
        blockers.append("gatekeeper-dmg-rejected")
    if report["gatekeeper"]["quarantine"].get("status") == "blocked":
        blockers.append("quarantine-dmg-rejected")
    if report["dependencies"]["python"]["status"] != "pass":
        blockers.append("python-unavailable")
    if report.get("embedded_python_runtime", {}).get("status") != "pass":
        blockers.append("python-runtime-not-embedded")
    if report.get("embedded_python_runtime", {}).get("portability") == "review_required":
        blockers.append("embedded-python-runtime-nonportable")
    if report.get("electron_runtime", {}).get("status") != "pass":
        blockers.append("app-architecture-invalid")
    if report.get("next_native_runtime", {}).get("status") != "pass":
        blockers.append("next-native-runtime-invalid")
    if report.get("playwright_runtime", {}).get("status") != "pass":
        blockers.append("playwright-runtime-invalid")
    if report.get("material_ocr_runtime", {}).get("status") != "pass":
        blockers.append("material-ocr-runtime-invalid")
    if report.get("brand_icon", {}).get("status") != "pass":
        blockers.append("brand-icon-invalid")
    if report.get("customer_bundle_hygiene", {}).get("status") != "pass":
        blockers.append("customer-bundle-hygiene-invalid")
    return blockers


def recommended_actions_for_blockers(blockers: list[str]) -> list[dict[str, str]]:
    return [
        {
            "blocker": blocker,
            "action": BLOCKER_ACTIONS.get(blocker, "查看 JSON 报告中的对应检查输出，补齐后重新运行 make desktop-release-assessment。"),
        }
        for blocker in blockers
    ]


def render_markdown(report: dict[str, Any]) -> str:
    blockers = report["blockers"]
    lines = [
        "# Echo Founder 桌面发布验收报告",
        "",
        f"- 状态：{report['status']}",
        f"- 生成时间：{report['checked_at']}",
        f"- App：{report['app']['path']}",
        f"- DMG：{report['dmg']['path']}",
        f"- DMG SHA256：{report['dmg'].get('sha256', '')}",
        f"- 阻断项：{', '.join(blockers) if blockers else '无'}",
        "",
        "## 签名与 Gatekeeper",
        "",
        f"- codesign verify：{'pass' if report['signing']['codesign_verify'].get('ok') else 'fail'}",
        f"- 签名类型：{report['signing']['summary'].get('signature_kind', '')}",
        f"- Hardened Runtime：{'pass' if report['signing']['summary'].get('hardened_runtime') else 'missing'}",
        f"- App notarization ticket：{'pass' if report['notarization']['app_stapler'].get('ok') else 'missing'}",
        f"- DMG notarization ticket：{'pass' if report['notarization']['dmg_stapler'].get('ok') else 'missing'}",
        f"- App spctl：{'pass' if report['gatekeeper']['app_spctl'].get('ok') else 'blocked'}",
        f"- DMG spctl：{'pass' if report['gatekeeper']['dmg_spctl'].get('ok') else 'blocked'}",
        f"- Quarantine 模拟：{report['gatekeeper']['quarantine'].get('status')}",
        "",
        "## 依赖",
        "",
        f"- Python：{report['dependencies']['python']['status']} {report['dependencies']['python'].get('version', '')}",
        f"- 目标架构：{report['target_architecture']}",
        f"- Electron runtime：{report['electron_runtime'].get('status', '')}",
        f"- 品牌图标：{report['brand_icon'].get('status', '')} {report['brand_icon'].get('filename', '')}",
        f"- 客户包卫生：{report['customer_bundle_hygiene'].get('status', '')}",
        f"- 源码 dirty：{report['package_traceability'].get('source_control', {}).get('dirty', 'unknown')}",
        f"- Runtime tree SHA256：{report['package_traceability'].get('shipped_runtime', {}).get('tree_sha256', '')}",
        f"- Next 原生运行包：{report['next_native_runtime'].get('status', '')}",
        f"- Playwright Chromium：{report['playwright_runtime'].get('status', '')}",
        f"- 内置 Python：{report['embedded_python_runtime']['status']} {report['embedded_python_runtime'].get('portability', '')}",
        "",
        "## 结论",
        "",
        report["conclusion"],
    ]
    actions = report.get("recommended_actions") or []
    if actions:
        lines.extend(["", "## 建议动作", ""])
        lines.extend(f"- `{item.get('blocker')}`：{item.get('action')}" for item in actions)
    return "\n".join(lines) + "\n"


def assess(args: argparse.Namespace) -> dict[str, Any]:
    app_path = Path(args.app_path).expanduser().resolve()
    dmg_path = Path(args.dmg_path).expanduser().resolve()
    info = read_info_plist(app_path)
    app_exists = app_path.exists()
    dmg_exists = dmg_path.exists()
    app_required = required_app_files(app_path, args.arch)
    dmg_manifest = manifest_for_dmg(dmg_path)
    app_sha = ""
    dmg_sha = sha256_file(dmg_path) if dmg_exists else ""

    report: dict[str, Any] = {
        "status": "unknown",
        "checked_at": now_iso(),
        "expected_bundle_id": args.bundle_id,
        "target_architecture": args.arch,
        "app": {
            "path": str(app_path),
            "exists": app_exists,
            "bundle_id": str(info.get("CFBundleIdentifier") or ""),
            "version": str(info.get("CFBundleShortVersionString") or ""),
            "executable": str(info.get("CFBundleExecutable") or ""),
            "required_files": app_required,
        },
        "dmg": {
            "path": str(dmg_path),
            "exists": dmg_exists,
            "size_bytes": dmg_path.stat().st_size if dmg_exists else 0,
            "sha256": dmg_sha,
            "manifest": dmg_manifest,
        },
        "signing": {
            "codesign_verify": run_command(["codesign", "--verify", "--deep", "--strict", str(app_path)], timeout=120) if app_exists else {"ok": False, "output": "missing app"},
            "codesign_details": run_command(["codesign", "--display", "--verbose=4", str(app_path)], timeout=120) if app_exists else {"ok": False, "output": "missing app"},
            "summary": signing_summary(app_path) if app_exists else {"status": "missing", "developer_id": False, "hardened_runtime": False},
        },
        "notarization": {
            "app_stapler": stapler_validation(app_path) if app_exists else {"ok": False, "status": "missing"},
            "dmg_stapler": stapler_validation(dmg_path) if dmg_exists else {"ok": False, "status": "missing"},
        },
        "gatekeeper": {
            "app_spctl": run_command(["spctl", "--assess", "--type", "execute", "--verbose=4", str(app_path)], timeout=120) if app_exists else {"ok": False, "output": "missing app"},
            "dmg_spctl": run_command(["spctl", "--assess", "--type", "open", "--verbose=4", str(dmg_path)], timeout=120) if dmg_exists else {"ok": False, "output": "missing dmg"},
            "quarantine": quarantine_assessment(dmg_path),
        },
        "dependencies": {
            "python": tool_status("python3", ["--version"], required=True),
        },
        "embedded_python_runtime": embedded_python_runtime_status(app_path, args.arch) if app_exists else {"status": "missing"},
        "electron_runtime": electron_runtime_status(app_path, args.arch) if app_exists else {"status": "missing"},
        "next_native_runtime": next_native_runtime_status(app_path, args.arch) if app_exists else {"status": "missing"},
        "playwright_runtime": playwright_runtime_status(app_path, args.arch) if app_exists else {"status": "missing"},
        "material_ocr_runtime": material_ocr_runtime_status(app_path, args.arch) if app_exists else {"status": "missing"},
        "brand_icon": brand_icon_status(app_path) if app_exists else {"status": "missing"},
        "customer_bundle_hygiene": customer_bundle_hygiene_status(app_path) if app_exists else {"status": "missing"},
        "package_traceability": package_traceability_status(app_path) if app_exists else {"status": "missing"},
    }
    blockers = release_blockers(report)
    report["blockers"] = blockers
    report["recommended_actions"] = recommended_actions_for_blockers(blockers)
    report["status"] = "external_ready" if not blockers else "blocked_for_external_distribution"
    report["conclusion"] = (
        "当前桌面包满足本地内测分发的基本可复核条件，但尚未满足正式外部分发。"
        if blockers
        else "当前桌面包通过本机外部分发验收检查。"
    )
    if app_sha:
        report["app"]["sha256"] = app_sha
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Assess Echo Founder desktop release readiness")
    parser.add_argument("--app-path", default=str(DEFAULT_APP_PATH))
    parser.add_argument("--dmg-path", default=str(DEFAULT_DMG_PATH))
    parser.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID)
    parser.add_argument("--arch", choices=["arm64", "x64", "universal"], default=DEFAULT_ARCHITECTURE)
    parser.add_argument("--report-dir", default=str(DEFAULT_REPORT_DIR))
    parser.add_argument("--require-external-ready", action="store_true")
    args = parser.parse_args()

    report = assess(args)
    report_dir = Path(args.report_dir).expanduser().resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    json_path = report_dir / f"desktop-release-assessment-{stamp}.json"
    markdown_path = report_dir / f"desktop-release-assessment-{stamp}.md"
    portable_report = portable_release_manifest(
        report,
        [
            (Path(args.app_path).expanduser(), Path(args.app_path).name),
            (Path(args.dmg_path).expanduser(), Path(args.dmg_path).name),
            (REPO_ROOT, "source"),
            (Path.home(), "build-home"),
            (Path(tempfile.gettempdir()), "build-temp"),
        ],
    )
    json_path.write_text(json.dumps(portable_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(portable_report), encoding="utf-8")

    exit_code = 1 if args.require_external_ready and report["status"] != "external_ready" else 0
    print(PASS_LABEL if exit_code == 0 else FAIL_LABEL)
    print(f"status={report['status']}")
    print(f"blockers={','.join(report['blockers']) if report['blockers'] else ''}")
    print(f"report_json={json_path}")
    print(f"report_markdown={markdown_path}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
