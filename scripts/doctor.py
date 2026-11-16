#!/usr/bin/env python3
"""Check whether AIFIOS is ready to run on this machine."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "skills" / "manifest.json"
UI_DIR = REPO_ROOT / "ui"

def load_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def status_line(ok: bool, level: str, message: str) -> str:
    marker = "PASS" if ok else level
    return f"{marker} {message}"


def check_status(ok: bool, level: str) -> str:
    return "pass" if ok else level.lower()


def add_check(
    checks: list[dict[str, Any]],
    ok: bool,
    level: str,
    message: str,
    *,
    resolution: str = "",
    emit_text: bool = True,
    show_resolution: bool = False,
    category: str = "runtime",
    meta: dict[str, Any] | None = None,
) -> None:
    check = {
        "category": category,
        "status": check_status(ok, level),
        "ok": ok,
        "level": "PASS" if ok else level,
        "message": message,
    }
    if resolution and not ok:
        check["resolution"] = resolution
    if meta:
        check["meta"] = meta
    checks.append(check)
    if emit_text:
        print(status_line(ok, level, message))
        if resolution and not ok and (show_resolution or level == "FAIL"):
            required_for = (meta or {}).get("required_for", [])
            if required_for:
                print(f"  used_for: {', '.join(required_for)}")
            print(f"  resolution: {resolution}")


def skill_present(base: Path, name: str) -> bool:
    return (base / name / "SKILL.md").exists()


def print_external_resolution(item: dict[str, Any]) -> None:
    print(f"  used_for: {', '.join(item.get('required_for', [])) or 'n/a'}")
    print(f"  resolution: {item.get('resolution', 'No resolution documented.')}")


def external_skill_importance(item: dict[str, Any]) -> str:
    status = str(item.get("status") or "")
    if status in {"required", "not-vendored", "required-not-vendored"}:
        return "required"
    if "recommended" in status:
        return "recommended"
    return "optional"


def run_text(command: list[str], cwd: Path | None = None) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    return result.returncode == 0, result.stdout.strip()


def command_version_label(command: str, output: str) -> str:
    first_line = next((line.strip() for line in output.splitlines() if line.strip()), "")
    if not first_line:
        return f"{command} missing"
    return first_line[:160]


def script_check_message(output: str, fallback: str) -> tuple[str, dict[str, Any]]:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    message = lines[-1] if lines else fallback
    for prefix in ("PASS ", "FAIL ", "WARN ", "INFO "):
        if message.startswith(prefix):
            message = message[len(prefix):].strip()
            break
    return message or fallback, {"output": output} if output else {}


def parse_semver(value: str) -> tuple[int, int, int] | None:
    match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", value or "")
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def required_node_version(ui_package: Path) -> tuple[int, int, int]:
    try:
        pkg = json.loads(ui_package.read_text(encoding="utf-8"))
        engine = str(pkg.get("engines", {}).get("node", ">=20.9.0"))
    except (OSError, json.JSONDecodeError):
        engine = ">=20.9.0"
    match = re.search(r">=\s*(\d+)\.(\d+)\.(\d+)", engine)
    if not match:
        return (20, 9, 0)
    return tuple(int(part) for part in match.groups())


def check_ui(
    require_ui_deps: bool,
    checks: list[dict[str, Any]],
    *,
    emit_text: bool,
    show_resolutions: bool,
) -> None:
    ui_package = UI_DIR / "package.json"
    ui_lock = UI_DIR / "package-lock.json"
    node_modules = UI_DIR / "node_modules"
    next_binary = node_modules / ".bin" / "next"

    ui_dir_ok = UI_DIR.exists()
    add_check(
        checks,
        ui_dir_ok,
        "FAIL",
        "ui directory",
        resolution="Run from the AIFIOS release root, or rebuild the package with the ui/ directory included.",
        emit_text=emit_text,
        show_resolution=show_resolutions,
        category="ui",
    )

    package_ok = ui_package.exists()
    add_check(
        checks,
        package_ok,
        "FAIL",
        "ui/package.json",
        resolution="Run from the AIFIOS release root, or rebuild the package with ui/package.json included.",
        emit_text=emit_text,
        show_resolution=show_resolutions,
        category="ui",
    )

    lock_ok = ui_lock.exists()
    add_check(
        checks,
        lock_ok,
        "FAIL",
        "ui/package-lock.json",
        resolution="Rebuild the release package from a checkout that includes ui/package-lock.json.",
        emit_text=emit_text,
        show_resolution=show_resolutions,
        category="ui",
    )

    node_ok, node_output = run_text(["node", "--version"])
    required_node = required_node_version(ui_package)
    node_version = parse_semver(node_output)
    node_version_ok = node_ok and node_version is not None and node_version >= required_node
    node_label = f"node {node_output or 'missing'} (required >= {'.'.join(map(str, required_node))})"
    add_check(
        checks,
        node_version_ok,
        "FAIL",
        node_label,
        resolution=f"Install Node.js >= {'.'.join(map(str, required_node))} and rerun doctor.",
        emit_text=emit_text,
        show_resolution=show_resolutions,
        category="ui",
        meta={"required_node": ".".join(map(str, required_node)), "detected": node_output},
    )

    npm_ok, npm_output = run_text(["npm", "--version"])
    add_check(
        checks,
        npm_ok,
        "FAIL",
        f"npm {npm_output or 'missing'}",
        resolution="Install npm with Node.js, then rerun doctor.",
        emit_text=emit_text,
        show_resolution=show_resolutions,
        category="ui",
    )

    deps_ok = node_modules.exists() and next_binary.exists()
    level = "FAIL" if require_ui_deps else "WARN"
    add_check(
        checks,
        deps_ok,
        level,
        "ui dependencies installed",
        resolution="run `python3 scripts/aifios.py ui --install-deps --port 3000`",
        emit_text=emit_text,
        show_resolution=True,
        category="ui",
    )

    presets_ok, presets_output = run_text(["python3", "scripts/check_ui_model_presets.py"], REPO_ROOT)
    presets_message, presets_meta = script_check_message(presets_output, "ui model presets")
    add_check(
        checks,
        presets_ok,
        "FAIL",
        presets_message,
        resolution="Run `python3 scripts/check_ui_model_presets.py` and fix invalid provider/model presets.",
        emit_text=emit_text,
        show_resolution=show_resolutions,
        category="ui",
        meta=presets_meta,
    )

    runtime_gates_ok, runtime_gates_output = run_text(["python3", "scripts/check_ui_runtime_gates.py"], REPO_ROOT)
    runtime_gates_message, runtime_gates_meta = script_check_message(
        runtime_gates_output,
        "ui runtime handoff gates",
    )
    add_check(
        checks,
        runtime_gates_ok,
        "FAIL",
        runtime_gates_message,
        resolution="Run `python3 scripts/check_ui_runtime_gates.py` and fix frontend runtime handoff regressions.",
        emit_text=emit_text,
        show_resolution=show_resolutions,
        category="ui",
        meta=runtime_gates_meta,
    )


def check_runtime_contracts(
    checks: list[dict[str, Any]],
    *,
    emit_text: bool,
    show_resolutions: bool,
) -> None:
    contracts_ok, contracts_output = run_text(["python3", "scripts/check_runtime_contracts.py"], REPO_ROOT)
    contracts_message, contracts_meta = script_check_message(
        contracts_output,
        "runtime contracts",
    )
    add_check(
        checks,
        contracts_ok,
        "FAIL",
        contracts_message,
        resolution="Run `python3 scripts/check_runtime_contracts.py` and fix runtime step/schema/quality wiring drift.",
        emit_text=emit_text,
        show_resolution=show_resolutions,
        category="runtime",
        meta=contracts_meta,
    )


def summarize(checks: list[dict[str, Any]], *, strict: bool) -> dict[str, Any]:
    failures = sum(1 for item in checks if item["status"] == "fail")
    warnings = sum(1 for item in checks if item["status"] == "warn")
    status = "fail" if failures or (strict and warnings) else ("warn" if warnings else "pass")
    return {
        "status": status,
        "failures": failures,
        "warnings": warnings,
        "strict": strict,
    }


def build_report(
    checks: list[dict[str, Any]],
    summary: dict[str, Any],
    *,
    install_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    return {
        "schema": "aifios.doctor.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "repo_root": str(REPO_ROOT),
        "install_dir": str(install_dir),
        "summary": summary,
        "options": {
            "strict": args.strict,
            "require_external": args.require_external,
            "require_install": args.require_install,
            "skip_ui": args.skip_ui,
            "require_ui_deps": args.require_ui_deps,
        },
        "checks": checks,
        "recommended_commands": {
            "install_skills": f"make install INSTALL_DIR={install_dir} FORCE=1",
            "ui": "python3 scripts/aifios.py ui --install-deps --port 3000",
            "runtime_contracts": "make runtime-contracts",
            "strict_external_gate": "make doctor REQUIRE_EXTERNAL=1 SHOW_RESOLUTIONS=1",
            "release_smoke": "make smoke-release",
        },
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="AIFIOS environment doctor")
    parser.add_argument("--install-dir", default="~/.agents/skills", help="target skills directory")
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    parser.add_argument("--require-install", action="store_true", help="treat missing installed bundled skills as failures")
    parser.add_argument("--require-external", action="store_true", help="treat required external skill warnings as failures")
    parser.add_argument("--skip-ui", action="store_true", help="skip Node/npm/UI dependency checks")
    parser.add_argument("--require-ui-deps", action="store_true", help="treat missing ui/node_modules as a failure")
    parser.add_argument("--show-resolutions", action="store_true", help="print resolution hints for missing external skills")
    parser.add_argument("--json", action="store_true", help="print a machine-readable doctor report")
    parser.add_argument("--report", default="", help="write machine-readable doctor report to this JSON file")
    args = parser.parse_args()

    install_dir = Path(args.install_dir).expanduser().resolve(strict=False)
    manifest = load_manifest()
    emit_text = not args.json
    checks: list[dict[str, Any]] = []

    py_ok = sys.version_info >= (3, 9)
    add_check(
        checks,
        py_ok,
        "FAIL",
        f"python {sys.version_info.major}.{sys.version_info.minor}",
        resolution="Use Python 3.9+ to run AIFIOS.",
        emit_text=emit_text,
        show_resolution=args.show_resolutions,
        category="runtime",
    )

    manifest_ok = MANIFEST.exists()
    add_check(
        checks,
        manifest_ok,
        "FAIL",
        f"manifest {MANIFEST.relative_to(REPO_ROOT)}",
        resolution="Run doctor from the AIFIOS release root, or rebuild the release package.",
        emit_text=emit_text,
        show_resolution=args.show_resolutions,
        category="skills",
    )

    for item in manifest.get("included_skills", []):
        source_ok = (REPO_ROOT / item["path"]).exists()
        add_check(
            checks,
            source_ok,
            "FAIL",
            f"source skill {item['name']}",
            resolution="Rebuild the release package; this bundled skill is missing from the source tree.",
            emit_text=emit_text,
            show_resolution=args.show_resolutions,
            category="skills",
            meta={"path": item.get("path")},
        )

    check_runtime_contracts(
        checks,
        emit_text=emit_text,
        show_resolutions=args.show_resolutions,
    )


    install_level = "FAIL" if args.require_install else "WARN"
    if install_dir.exists():
        add_check(checks, True, install_level, f"install dir {install_dir}", emit_text=emit_text, category="install")
        for item in manifest.get("included_skills", []):
            installed = skill_present(install_dir, item["name"])
            add_check(
                checks,
                installed,
                install_level,
                f"installed skill {item['name']}",
                resolution=f"Run `make install INSTALL_DIR={install_dir} FORCE=1`.",
                emit_text=emit_text,
                show_resolution=args.show_resolutions,
                category="install",
            )
    else:
        add_check(
            checks,
            False,
            install_level,
            f"install dir missing {install_dir}",
            resolution=f"Run `make install INSTALL_DIR={install_dir}`.",
            emit_text=emit_text,
            show_resolution=args.show_resolutions,
            category="install",
        )

    for item in manifest.get("external_skills", []):
        name = item["name"]
        if name.endswith("*"):
            prefix = name[:-1]
            installed = install_dir.exists() and any(p.is_dir() and p.name.startswith(prefix) for p in install_dir.iterdir())
        else:
            installed = install_dir.exists() and skill_present(install_dir, name)
        importance = external_skill_importance(item)
        if importance in {"required", "recommended"}:
            level = "FAIL" if args.require_external else "WARN"
        else:
            level = "INFO"
        add_check(
            checks,
            installed,
            level,
            f"external skill {name} ({item.get('status', 'unknown')})",
            resolution=item.get("resolution", "No resolution documented."),
            emit_text=emit_text,
            show_resolution=args.show_resolutions,
            category="external-skills",
            meta={"required_for": item.get("required_for", []), "importance": importance},
        )

    if not args.skip_ui:
        check_ui(
            args.require_ui_deps,
            checks,
            emit_text=emit_text,
            show_resolutions=args.show_resolutions,
        )

    summary = summarize(checks, strict=args.strict)
    report = build_report(checks, summary, install_dir=install_dir, args=args)

    if args.report:
        report_path = Path(args.report).expanduser().resolve(strict=False)
        write_report(report_path, report)
        if emit_text:
            print(f"PASS doctor report: {report_path}")

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))

    if summary["failures"]:
        if emit_text:
            print(f"FAIL doctor: {summary['failures']} failure(s), {summary['warnings']} warning(s)")
        return 1
    if args.strict and summary["warnings"]:
        if emit_text:
            print(f"FAIL doctor strict: {summary['warnings']} warning(s)")
        return 1
    if emit_text:
        print(f"PASS doctor: 0 failure(s), {summary['warnings']} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
