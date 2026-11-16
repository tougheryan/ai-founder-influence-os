#!/usr/bin/env python3
"""Developer ID signing, notarization, and Gatekeeper checks for Echo Founder."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from desktop_package import assert_release_manifest_portable


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP_PATH = REPO_ROOT / "dist" / "desktop" / "Echo Founder.app"
DEFAULT_DMG_PATH = REPO_ROOT / "dist" / "Echo-Founder-0.2.0-beta.2-mac-arm64.dmg"
DEFAULT_APP_ZIP_PATH = REPO_ROOT / "dist" / "Echo-Founder-0.2.0-beta.2-mac-arm64-app.zip"
DEFAULT_REPORT_DIR = REPO_ROOT / "quality" / "system-audits"
DEFAULT_BUNDLE_ID = "com.echofounder.desktop"
DEFAULT_VOLUME_NAME = "Echo Founder"
SENSITIVE_KEYS = {"password", "notary_password", "key", "notary_key"}
SENSITIVE_FLAGS = {"--password", "--key"}

BLOCKER_ACTIONS = {
    "not-macos": "在 macOS 机器上执行正式签名、公证和 Gatekeeper 验收；Linux/Windows 只能做源码和产物静态检查。",
    "required-apple-tools-missing": "安装 Xcode Command Line Tools，并确认 codesign、security、spctl、hdiutil、ditto、xcrun notarytool 和 xcrun stapler 可用。",
    "developer-id-identity-missing": "在钥匙串安装 Apple Developer ID Application 证书，并设置 AIFIOS_DEVELOPER_ID_APPLICATION 或传 DESKTOP_SIGN_IDENTITY。",
    "notary-auth-missing": "配置 notarytool 凭证：优先执行 xcrun notarytool store-credentials 并传 DESKTOP_NOTARY_PROFILE，也可使用 Apple ID 或 App Store Connect API Key 三元组。",
    "missing-app": "先执行 make desktop-package，生成 dist/desktop/Echo Founder.app。",
    "bundle-id-mismatch": "用预期 bundle id 重新打包，或修正 DESKTOP_DMG_BUNDLE_ID，确保 App Info.plist 与发布配置一致。",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def redact_command(command: list[str]) -> list[str]:
    redacted: list[str] = []
    hide_next = False
    for item in command:
        if hide_next:
            redacted.append("***")
            hide_next = False
            continue
        redacted.append(item)
        if item in SENSITIVE_FLAGS:
            hide_next = True
    return redacted


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: ("***" if key.lower() in SENSITIVE_KEYS else redact(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        if all(isinstance(item, str) for item in value):
            return redact_command(value)
        return [redact(item) for item in value]
    return value


def run_command(command: list[str], timeout: int = 120) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        return {
            "command": redact(command),
            "returncode": int(result.returncode),
            "ok": result.returncode == 0,
            "output": result.stdout.strip(),
        }
    except Exception as exc:
        return {
            "command": redact(command),
            "returncode": None,
            "ok": False,
            "output": str(exc),
        }


def tool_status(name: str, command: list[str] | None = None) -> dict[str, Any]:
    path = shutil.which(name)
    if not path:
        return {"name": name, "path": "", "status": "missing", "version": ""}
    version = ""
    if command:
        result = run_command([path, *command], timeout=20)
        version = str(result.get("output") or "").splitlines()[0] if result.get("output") else ""
    return {"name": name, "path": path, "status": "pass", "version": version}


def xcrun_tool_status(tool: str) -> dict[str, Any]:
    xcrun = shutil.which("xcrun")
    if not xcrun:
        return {"name": tool, "path": "", "status": "missing", "version": "xcrun missing"}
    result = run_command([xcrun, "-f", tool], timeout=20)
    return {
        "name": tool,
        "path": str(result.get("output") or "").strip() if result.get("ok") else "",
        "status": "pass" if result.get("ok") else "missing",
        "version": "",
        "probe": result,
    }


def read_info_plist(app_path: Path) -> dict[str, Any]:
    info_path = app_path / "Contents" / "Info.plist"
    if not info_path.exists():
        return {}
    try:
        with info_path.open("rb") as handle:
            return dict(plistlib.load(handle))
    except Exception:
        return {}


def app_metadata(app_path: Path) -> dict[str, Any]:
    info = read_info_plist(app_path)
    return {
        "path": str(app_path),
        "exists": app_path.exists(),
        "bundle_id": str(info.get("CFBundleIdentifier") or ""),
        "version": str(info.get("CFBundleShortVersionString") or ""),
        "executable": str(info.get("CFBundleExecutable") or ""),
    }


def identity_from_args(args: argparse.Namespace) -> str:
    return str(args.identity or os.environ.get("AIFIOS_DEVELOPER_ID_APPLICATION") or "").strip()


def notary_auth_from_args(args: argparse.Namespace) -> dict[str, Any]:
    profile = str(args.notary_profile or os.environ.get("AIFIOS_NOTARY_PROFILE") or "").strip()
    if profile:
        return {
            "mode": "keychain-profile",
            "configured": True,
            "profile": profile,
            "args": ["--keychain-profile", profile],
        }

    apple_id = str(args.apple_id or os.environ.get("AIFIOS_NOTARY_APPLE_ID") or "").strip()
    team_id = str(args.team_id or os.environ.get("AIFIOS_NOTARY_TEAM_ID") or "").strip()
    password = str(args.password or os.environ.get("AIFIOS_NOTARY_PASSWORD") or "").strip()
    if apple_id or team_id or password:
        complete = bool(apple_id and team_id and password)
        return {
            "mode": "apple-id",
            "configured": complete,
            "apple_id": apple_id,
            "team_id": team_id,
            "password": password,
            "missing": [name for name, value in [("apple_id", apple_id), ("team_id", team_id), ("password", password)] if not value],
            "args": ["--apple-id", apple_id, "--team-id", team_id, "--password", password] if complete else [],
        }

    key_path = str(args.key or os.environ.get("AIFIOS_NOTARY_KEY") or "").strip()
    key_id = str(args.key_id or os.environ.get("AIFIOS_NOTARY_KEY_ID") or "").strip()
    issuer = str(args.issuer or os.environ.get("AIFIOS_NOTARY_ISSUER") or "").strip()
    if key_path or key_id or issuer:
        complete = bool(key_path and key_id and issuer)
        return {
            "mode": "api-key",
            "configured": complete,
            "key": key_path,
            "key_id": key_id,
            "issuer": issuer,
            "missing": [name for name, value in [("key", key_path), ("key_id", key_id), ("issuer", issuer)] if not value],
            "args": ["--key", key_path, "--key-id", key_id, "--issuer", issuer] if complete else [],
        }

    return {"mode": "missing", "configured": False, "args": [], "missing": ["notary authentication"]}


def signing_identity_status(identity: str) -> dict[str, Any]:
    if not identity:
        return {"status": "missing", "identity": "", "reason": "AIFIOS_DEVELOPER_ID_APPLICATION or --identity is required"}
    result = run_command(["security", "find-identity", "-v", "-p", "codesigning"], timeout=30)
    output = str(result.get("output") or "")
    return {
        "status": "pass" if result.get("ok") and identity in output else "missing",
        "identity": identity,
        "probe": result,
    }


def build_config_report(args: argparse.Namespace) -> dict[str, Any]:
    app_path = Path(args.app_path).expanduser().resolve()
    dmg_path = Path(args.dmg_path).expanduser().resolve()
    identity = identity_from_args(args)
    notary = notary_auth_from_args(args)
    tools = {
        "codesign": tool_status("codesign"),
        "security": tool_status("security"),
        "spctl": tool_status("spctl"),
        "hdiutil": tool_status("hdiutil"),
        "ditto": tool_status("ditto"),
        "xcrun": tool_status("xcrun"),
        "notarytool": xcrun_tool_status("notarytool"),
        "stapler": xcrun_tool_status("stapler"),
    }
    missing_tools = [name for name, payload in tools.items() if payload["status"] != "pass"]
    identity_status = signing_identity_status(identity)
    blockers: list[str] = []
    if sys.platform != "darwin":
        blockers.append("not-macos")
    if missing_tools:
        blockers.append("required-apple-tools-missing")
    if identity_status["status"] != "pass":
        blockers.append("developer-id-identity-missing")
    if not notary.get("configured"):
        blockers.append("notary-auth-missing")
    if not app_path.exists():
        blockers.append("missing-app")
    app = app_metadata(app_path)
    if app_path.exists() and app.get("bundle_id") != args.bundle_id:
        blockers.append("bundle-id-mismatch")

    report = {
        "status": "ready" if not blockers else "blocked",
        "checked_at": now_iso(),
        "blockers": blockers,
        "app": app,
        "dmg": {
            "path": str(dmg_path),
            "exists": dmg_path.exists(),
            "size_bytes": dmg_path.stat().st_size if dmg_path.exists() else 0,
            "sha256": sha256_file(dmg_path) if dmg_path.exists() else "",
        },
        "identity": identity_status,
        "notary": redact(notary),
        "tools": tools,
    }
    report["readiness_checklist"] = build_readiness_checklist(report, args.bundle_id)
    report["recommended_actions"] = recommended_actions_for_blockers(blockers, notary)
    return report


def checklist_item(item_id: str, label: str, ready: bool, detail: str, next_action: str = "") -> dict[str, Any]:
    return {
        "id": item_id,
        "label": label,
        "status": "pass" if ready else "blocked",
        "detail": detail,
        "next_action": "" if ready else next_action,
    }


def build_readiness_checklist(report: dict[str, Any], expected_bundle_id: str) -> list[dict[str, Any]]:
    tools = report.get("tools", {})
    missing_tools = [name for name, payload in tools.items() if payload.get("status") != "pass"]
    app = report.get("app", {})
    dmg = report.get("dmg", {})
    identity = report.get("identity", {})
    notary = report.get("notary", {})
    return [
        checklist_item(
            "macos-toolchain",
            "macOS 签名工具链",
            sys.platform == "darwin" and not missing_tools,
            "Apple 签名、公证和 Gatekeeper 工具均可用。" if not missing_tools else f"缺少：{', '.join(missing_tools)}",
            BLOCKER_ACTIONS["required-apple-tools-missing"],
        ),
        checklist_item(
            "desktop-app-artifact",
            "桌面 App 产物",
            bool(app.get("exists")),
            str(app.get("path") or ""),
            BLOCKER_ACTIONS["missing-app"],
        ),
        checklist_item(
            "bundle-id",
            "Bundle ID",
            bool(app.get("exists")) and app.get("bundle_id") == expected_bundle_id,
            f"actual={app.get('bundle_id') or '-'} expected={expected_bundle_id}",
            BLOCKER_ACTIONS["bundle-id-mismatch"],
        ),
        checklist_item(
            "developer-id",
            "Developer ID Application 证书",
            identity.get("status") == "pass",
            str(identity.get("identity") or "未配置"),
            BLOCKER_ACTIONS["developer-id-identity-missing"],
        ),
        checklist_item(
            "notary-auth",
            "notarytool 凭证",
            bool(notary.get("configured")),
            f"mode={notary.get('mode') or 'missing'}",
            BLOCKER_ACTIONS["notary-auth-missing"],
        ),
        checklist_item(
            "dmg-artifact",
            "DMG 产物",
            bool(dmg.get("exists")),
            str(dmg.get("path") or ""),
            "执行 make desktop-dmg。注意：make desktop-external-release 会在签名后重建并重新签名 DMG。",
        ),
    ]


def recommended_actions_for_blockers(blockers: list[str], notary: dict[str, Any]) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    for blocker in blockers:
        action = BLOCKER_ACTIONS.get(blocker)
        if action:
            actions.append({"blocker": blocker, "action": action})
    if notary.get("mode") == "missing":
        actions.append(
            {
                "blocker": "notary-auth-missing",
                "action": "推荐使用 keychain profile：xcrun notarytool store-credentials aifios-notary --apple-id <AppleID> --team-id <TEAMID> --password <app-specific-password>，之后传 DESKTOP_NOTARY_PROFILE=aifios-notary。",
            }
        )
    return actions


def require_ready_config(args: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    config = build_config_report(args)
    if config["status"] != "ready":
        raise RuntimeError("Desktop notarization config is blocked: " + ", ".join(config["blockers"]))
    return str(config["identity"]["identity"]), config


def require_signing_config(args: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    config = build_config_report(args)
    blockers = [
        blocker
        for blocker in config["blockers"]
        if blocker
        in {
            "not-macos",
            "required-apple-tools-missing",
            "developer-id-identity-missing",
            "missing-app",
        }
    ]
    if blockers:
        raise RuntimeError("Desktop signing config is blocked: " + ", ".join(blockers))
    return str(config["identity"]["identity"]), {**config, "status": "ready_for_signing", "blockers": []}


def require_staple_config(args: argparse.Namespace) -> dict[str, Any]:
    config = build_config_report(args)
    blockers = [
        blocker
        for blocker in config["blockers"]
        if blocker in {"not-macos", "required-apple-tools-missing", "missing-app"}
    ]
    if blockers:
        raise RuntimeError("Desktop stapling config is blocked: " + ", ".join(blockers))
    return {**config, "status": "ready_for_stapling", "blockers": []}


def run_required(command: list[str], timeout: int = 120) -> dict[str, Any]:
    result = run_command(command, timeout=timeout)
    if not result.get("ok"):
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{result.get('output') or ''}")
    return result


def resource_macho_files(app_path: Path) -> list[Path]:
    """Find executable payloads that codesign --deep skips under Resources."""
    root = app_path / "Contents" / "Resources" / "aifios"
    if not root.exists() or not shutil.which("lipo"):
        return []
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if path.suffix not in {".dylib", ".so", ".node"} and path.parent.name != "bin" and path.name != "chrome-headless-shell":
            continue
        probe = run_command(["lipo", "-archs", str(path)], timeout=20)
        if probe.get("ok"):
            files.append(path)
    return files


def sign_resource_macho_files(app_path: Path, identity: str) -> dict[str, Any]:
    files = resource_macho_files(app_path)
    signed: list[str] = []
    for path in files:
        run_required(
            [
                "codesign",
                "--force",
                "--options",
                "runtime",
                "--timestamp",
                "--sign",
                identity,
                str(path),
            ],
            timeout=180,
        )
        run_required(["codesign", "--verify", "--strict", str(path)], timeout=60)
        signed.append(str(path))
    return {"count": len(signed), "files": signed}


def sign_app(app_path: Path, identity: str) -> dict[str, Any]:
    resource_components = sign_resource_macho_files(app_path, identity)
    command = [
        "codesign",
        "--force",
        "--deep",
        "--options",
        "runtime",
        "--timestamp",
        "--sign",
        identity,
        str(app_path),
    ]
    sign = run_required(command, timeout=600)
    verify = run_required(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app_path)], timeout=180)
    details = run_command(["codesign", "--display", "--verbose=4", str(app_path)], timeout=120)
    return {"sign": sign, "verify": verify, "details": details, "resource_components": resource_components}


def sign_dmg(dmg_path: Path, identity: str) -> dict[str, Any]:
    sign = run_required(["codesign", "--force", "--timestamp", "--sign", identity, str(dmg_path)], timeout=300)
    verify = run_required(["codesign", "--verify", "--verbose=2", str(dmg_path)], timeout=120)
    return {"sign": sign, "verify": verify, "sha256": sha256_file(dmg_path)}


def rebuild_dmg(app_path: Path, dmg_path: Path, volume_name: str, bundle_id: str) -> dict[str, Any]:
    script = REPO_ROOT / "scripts" / "desktop_dmg.py"
    return run_required(
        [
            sys.executable,
            str(script),
            "build",
            "--app-path",
            str(app_path),
            "--dmg-path",
            str(dmg_path),
            "--volume-name",
            volume_name,
            "--bundle-id",
            bundle_id,
        ],
        timeout=900,
    )


def create_app_zip(app_path: Path, zip_path: Path) -> dict[str, Any]:
    if zip_path.exists():
        zip_path.unlink()
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    result = run_required(
        [
            "ditto",
            "-c",
            "-k",
            "--keepParent",
            str(app_path),
            str(zip_path),
        ],
        timeout=600,
    )
    return {"zip": result, "zip_path": str(zip_path), "sha256": sha256_file(zip_path), "size_bytes": zip_path.stat().st_size}


def notarize_artifact(path: Path, notary: dict[str, Any]) -> dict[str, Any]:
    auth_args = list(notary.get("args") or [])
    if not auth_args:
        raise RuntimeError("Missing notarytool authentication arguments")
    command = ["xcrun", "notarytool", "submit", str(path), "--wait", "--output-format", "json", *auth_args]
    result = run_required(command, timeout=7200)
    parsed: dict[str, Any] = {}
    try:
        parsed = json.loads(str(result.get("output") or "{}"))
    except json.JSONDecodeError:
        parsed = {}
    if str(parsed.get("status") or "").lower() != "accepted":
        raise RuntimeError(f"Notarization was not accepted: {parsed}")
    return {"submit": redact(result), "payload": parsed}


def staple_artifact(path: Path) -> dict[str, Any]:
    staple = run_required(["xcrun", "stapler", "staple", str(path)], timeout=300)
    validate = run_required(["xcrun", "stapler", "validate", str(path)], timeout=120)
    return {"staple": staple, "validate": validate}


def verify_release(app_path: Path, dmg_path: Path) -> dict[str, Any]:
    return {
        "codesign_app": run_command(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app_path)], timeout=180),
        "codesign_dmg": run_command(["codesign", "--verify", "--verbose=2", str(dmg_path)], timeout=120) if dmg_path.exists() else {"ok": False, "output": "missing dmg"},
        "stapler_app": run_command(["xcrun", "stapler", "validate", str(app_path)], timeout=120),
        "stapler_dmg": run_command(["xcrun", "stapler", "validate", str(dmg_path)], timeout=120) if dmg_path.exists() else {"ok": False, "output": "missing dmg"},
        "spctl_app": run_command(["spctl", "--assess", "--type", "execute", "--verbose=4", str(app_path)], timeout=180),
        "spctl_dmg": run_command(["spctl", "--assess", "--type", "open", "--verbose=4", str(dmg_path)], timeout=180) if dmg_path.exists() else {"ok": False, "output": "missing dmg"},
    }


def update_dmg_manifest(dmg_path: Path, app_path: Path, bundle_id: str, volume_name: str, status: str) -> Path:
    manifest_path = dmg_path.with_suffix(".manifest.json")
    try:
        existing = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        existing = {}
    manifest = {
        **(existing if isinstance(existing, dict) else {}),
        "status": status,
        "artifact": "dmg",
        "dmg_path": dmg_path.name,
        "app_name": app_path.name,
        "source_app_path": app_path.name,
        "app_path": app_path.name,
        "mounted_app_path": f"/Volumes/{volume_name}/{app_path.name}",
        "volume_name": volume_name,
        "bundle_id": bundle_id,
        "updated_at": now_iso(),
        "size_bytes": dmg_path.stat().st_size,
        "sha256": sha256_file(dmg_path),
        "format": "UDZO",
    }
    assert_release_manifest_portable(manifest)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Echo Founder 桌面签名与公证报告",
        "",
        f"- 状态：{report['status']}",
        f"- 命令：{report['command']}",
        f"- 生成时间：{report['checked_at']}",
        f"- App：{report['app']['path']}",
        f"- DMG：{report['dmg']['path']}",
        f"- 阻断项：{', '.join(report.get('blockers') or []) if report.get('blockers') else '无'}",
        f"- Developer ID：{report.get('identity', {}).get('identity', '') or '未配置'}",
        f"- Notary 模式：{report.get('notary', {}).get('mode', '')}",
        "",
        "## 结果",
        "",
        report.get("conclusion", ""),
    ]
    checklist = report.get("readiness_checklist") or []
    if checklist:
        lines.extend(["", "## 前置检查", "", "| 项目 | 状态 | 说明 | 下一步 |", "| --- | --- | --- | --- |"])
        for item in checklist:
            lines.append(
                f"| {item.get('label', '')} | `{item.get('status', '')}` | {item.get('detail', '')} | {item.get('next_action', '') or '-'} |"
            )
    actions = report.get("recommended_actions") or []
    if actions:
        lines.extend(["", "## 建议动作", ""])
        lines.extend(f"- `{item.get('blocker')}`：{item.get('action')}" for item in actions)
    return "\n".join(lines) + "\n"


def write_report(args: argparse.Namespace, report: dict[str, Any]) -> tuple[Path, Path]:
    report_dir = Path(args.report_dir).expanduser().resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    json_path = report_dir / f"desktop-notarization-{report['command']}-{stamp}.json"
    markdown_path = report_dir / f"desktop-notarization-{report['command']}-{stamp}.md"
    json_path.write_text(json.dumps(redact(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(redact(report)), encoding="utf-8")
    return json_path, markdown_path


def command_check_config(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    report = build_config_report(args)
    report.update(
        {
            "command": "check-config",
            "conclusion": "签名/公证配置可用。" if report["status"] == "ready" else "签名/公证配置不完整，不能进行正式外部分发。",
        }
    )
    return (0 if report["status"] == "ready" else 1), report


def command_sign(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    app_path = Path(args.app_path).expanduser().resolve()
    dmg_path = Path(args.dmg_path).expanduser().resolve()
    identity, config = require_signing_config(args)
    steps = {"app": sign_app(app_path, identity)}
    if dmg_path.exists():
        steps["dmg"] = sign_dmg(dmg_path, identity)
        update_dmg_manifest(dmg_path, app_path, args.bundle_id, args.volume_name, "signed")
    report = {**config, "command": "sign", "status": "pass", "steps": steps, "conclusion": "Developer ID 签名完成。"}
    return 0, report


def command_notarize(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    app_path = Path(args.app_path).expanduser().resolve()
    dmg_path = Path(args.dmg_path).expanduser().resolve()
    _identity, config = require_ready_config(args)
    if not dmg_path.exists():
        raise RuntimeError(f"Missing DMG for notarization: {dmg_path}")
    notary = notary_auth_from_args(args)
    steps = {"notarize": notarize_artifact(dmg_path, notary)}
    update_dmg_manifest(dmg_path, app_path, args.bundle_id, args.volume_name, "notarized")
    report = {**config, "command": "notarize", "status": "pass", "steps": steps, "conclusion": "DMG 公证提交完成并被 Apple 接受。"}
    return 0, report


def command_staple(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    app_path = Path(args.app_path).expanduser().resolve()
    dmg_path = Path(args.dmg_path).expanduser().resolve()
    config = require_staple_config(args)
    steps = {"app": staple_artifact(app_path)}
    if dmg_path.exists():
        steps["dmg"] = staple_artifact(dmg_path)
        update_dmg_manifest(dmg_path, app_path, args.bundle_id, args.volume_name, "notarized_stapled")
    report = {**config, "command": "staple", "status": "pass", "steps": steps, "conclusion": "公证票据 staple 完成。"}
    return 0, report


def command_verify(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    app_path = Path(args.app_path).expanduser().resolve()
    dmg_path = Path(args.dmg_path).expanduser().resolve()
    config = build_config_report(args)
    verification = verify_release(app_path, dmg_path)
    blockers = [name for name, payload in verification.items() if not payload.get("ok")]
    report = {
        **config,
        "command": "verify",
        "status": "pass" if not blockers else "blocked",
        "blockers": blockers,
        "verification": verification,
        "conclusion": "Gatekeeper 验收通过。" if not blockers else "Gatekeeper / staple / 签名验收未通过。",
    }
    return (0 if not blockers else 1), report


def command_release(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    app_path = Path(args.app_path).expanduser().resolve()
    dmg_path = Path(args.dmg_path).expanduser().resolve()
    app_zip_path = Path(args.app_zip_path).expanduser().resolve()
    identity, config = require_ready_config(args)
    notary = notary_auth_from_args(args)
    steps: dict[str, Any] = {}
    steps["sign_app"] = sign_app(app_path, identity)
    steps["zip_app"] = create_app_zip(app_path, app_zip_path)
    steps["notarize_app_zip"] = notarize_artifact(app_zip_path, notary)
    steps["staple_app"] = staple_artifact(app_path)
    steps["rebuild_dmg"] = rebuild_dmg(app_path, dmg_path, args.volume_name, args.bundle_id)
    steps["sign_dmg"] = sign_dmg(dmg_path, identity)
    steps["notarize_dmg"] = notarize_artifact(dmg_path, notary)
    steps["staple_dmg"] = staple_artifact(dmg_path)
    update_dmg_manifest(dmg_path, app_path, args.bundle_id, args.volume_name, "external_ready_candidate")
    verification = verify_release(app_path, dmg_path)
    blockers = [name for name, payload in verification.items() if not payload.get("ok")]
    report = {
        **config,
        "command": "release",
        "status": "pass" if not blockers else "blocked",
        "blockers": blockers,
        "steps": steps,
        "verification": verification,
        "conclusion": "正式外部分发候选包已签名、公证、staple 并通过 Gatekeeper 验收。" if not blockers else "签名/公证流程完成但最终验收未通过。",
    }
    return (0 if not blockers else 1), report


COMMANDS = {
    "check-config": command_check_config,
    "sign": command_sign,
    "notarize": command_notarize,
    "staple": command_staple,
    "verify": command_verify,
    "release": command_release,
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Sign, notarize, staple, and verify Echo Founder desktop artifacts")
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument("--app-path", default=str(DEFAULT_APP_PATH))
    parser.add_argument("--dmg-path", default=str(DEFAULT_DMG_PATH))
    parser.add_argument("--app-zip-path", default=str(DEFAULT_APP_ZIP_PATH))
    parser.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID)
    parser.add_argument("--volume-name", default=DEFAULT_VOLUME_NAME)
    parser.add_argument("--report-dir", default=str(DEFAULT_REPORT_DIR))
    parser.add_argument("--identity", help="Developer ID Application identity; env: AIFIOS_DEVELOPER_ID_APPLICATION")
    parser.add_argument("--notary-profile", help="notarytool keychain profile; env: AIFIOS_NOTARY_PROFILE")
    parser.add_argument("--apple-id", help="Apple ID for notarytool; env: AIFIOS_NOTARY_APPLE_ID")
    parser.add_argument("--team-id", help="Apple Developer Team ID; env: AIFIOS_NOTARY_TEAM_ID")
    parser.add_argument("--password", help="app-specific password; env: AIFIOS_NOTARY_PASSWORD")
    parser.add_argument("--key", help="App Store Connect API key path; env: AIFIOS_NOTARY_KEY")
    parser.add_argument("--key-id", help="App Store Connect API key id; env: AIFIOS_NOTARY_KEY_ID")
    parser.add_argument("--issuer", help="App Store Connect issuer id; env: AIFIOS_NOTARY_ISSUER")
    args = parser.parse_args()

    try:
        exit_code, report = COMMANDS[args.command](args)
    except Exception as exc:
        notary = redact(notary_auth_from_args(args))
        report = {
            "status": "fail",
            "command": args.command,
            "checked_at": now_iso(),
            "blockers": ["desktop-notarization-command-failed"],
            "app": app_metadata(Path(args.app_path).expanduser().resolve()),
            "dmg": {"path": str(Path(args.dmg_path).expanduser().resolve()), "exists": Path(args.dmg_path).expanduser().exists()},
            "identity": {"identity": identity_from_args(args)},
            "notary": notary,
            "recommended_actions": [
                {
                    "blocker": "desktop-notarization-command-failed",
                    "action": "查看 error 字段和命令输出；若是配置问题，先运行 make desktop-notarization-check。",
                }
            ],
            "error": str(exc),
            "conclusion": str(exc),
        }
        exit_code = 1

    report.setdefault("checked_at", now_iso())
    report.setdefault("app", app_metadata(Path(args.app_path).expanduser().resolve()))
    report.setdefault("dmg", {"path": str(Path(args.dmg_path).expanduser().resolve())})
    json_path, markdown_path = write_report(args, report)

    label = "PASS" if exit_code == 0 else "FAIL"
    print(f"{label} desktop notarization {args.command}")
    print(f"status={report['status']}")
    print(f"blockers={','.join(report.get('blockers') or [])}")
    print(f"report_json={json_path}")
    print(f"report_markdown={markdown_path}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
