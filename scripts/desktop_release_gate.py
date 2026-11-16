#!/usr/bin/env python3
"""Run an auditable Echo Founder desktop release gate."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT_DIR = REPO_ROOT / "quality" / "system-audits"
PASS_LABEL = "PASS desktop release gate"
FAIL_LABEL = "FAIL desktop release gate"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def run_step(label: str, command: list[str], env: dict[str, str], timeout: int | None = None) -> dict[str, Any]:
    started = time.time()
    print(f"RUN {label}: {' '.join(command)}", flush=True)
    try:
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        output = result.stdout or ""
        return {
            "label": label,
            "command": command,
            "status": "pass" if result.returncode == 0 else "fail",
            "returncode": int(result.returncode),
            "duration_seconds": round(time.time() - started, 3),
            "output_tail": output[-12000:],
        }
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        return {
            "label": label,
            "command": command,
            "status": "fail",
            "returncode": None,
            "duration_seconds": round(time.time() - started, 3),
            "output_tail": output[-12000:],
            "error": f"timeout after {timeout}s",
        }


def base_env(args: argparse.Namespace) -> dict[str, str]:
    env = os.environ.copy()
    report_dir = Path(args.report_dir).expanduser().resolve()
    env.setdefault("AIFIOS_HOME", str(REPO_ROOT))
    env["DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE"] = args.require_python_source
    env["DESKTOP_DMG_SMOKE_REQUIRE_PYTHON_SOURCE"] = args.require_python_source
    env["DESKTOP_DMG_OPEN_SMOKE_REQUIRE_PYTHON_SOURCE"] = args.require_python_source
    env["DESKTOP_PACKAGED_MINIMAL_ENV"] = "1"
    env["DESKTOP_DMG_SMOKE_MINIMAL_ENV"] = "1"
    env["DESKTOP_PACKAGED_OPEN_REPORT_DIR"] = str(report_dir)
    env["DESKTOP_PACKAGED_SINGLE_INSTANCE_REPORT_DIR"] = str(report_dir)
    env["DESKTOP_PACKAGED_RECOVERY_REPORT_DIR"] = str(report_dir)
    env["DESKTOP_PACKAGED_WATCHDOG_REPORT_DIR"] = str(report_dir)
    env["DESKTOP_DMG_OPEN_SMOKE_REPORT_DIR"] = str(report_dir)
    if args.mode in {"standard", "full"}:
        env["DESKTOP_EMBED_PYTHON_RUNTIME"] = "required"
        env["SKIP_BUILD"] = "1" if args.skip_next_build else ""
    if args.fast_soak:
        env["DESKTOP_PACKAGED_SOAK_DURATION"] = "60"
        env["DESKTOP_PACKAGED_SOAK_INTERVAL"] = "10"
    if args.mode == "full":
        env["DESKTOP_PACKAGED_SOAK_REPORT_DIR"] = str(report_dir)
    return env


def gate_steps(args: argparse.Namespace) -> list[tuple[str, list[str], int | None]]:
    steps: list[tuple[str, list[str], int | None]] = [
        ("desktop-check", ["make", "desktop-check"], 120),
        ("runtime-contracts", ["make", "runtime-contracts"], 120),
        ("content-loop-check", ["make", "content-loop-check"], 120),
    ]
    if args.mode == "quick":
        steps.extend(
            [
                ("desktop-minimal-artifact-check", ["make", "desktop-minimal-artifact-check"], 420),
                ("desktop-dmg-smoke", ["make", "desktop-dmg-smoke"], 300),
            ]
        )
        return steps

    if args.mode in {"standard", "full"}:
        steps.extend(
            [
                ("desktop-package", ["make", "desktop-package"], 1800),
                ("desktop-dmg", ["make", "desktop-dmg"], 900),
            ]
        )
    steps.extend(
        [
            ("desktop-packaged-smoke", ["make", "desktop-packaged-smoke"], 240),
            *(
                [("desktop-packaged-x64-smoke", ["make", "desktop-packaged-x64-smoke"], 360)]
                if args.mode in {"standard", "full"}
                else []
            ),
            ("desktop-packaged-open-smoke", ["make", "desktop-packaged-open-smoke"], 240),
            ("desktop-packaged-single-instance-smoke", ["make", "desktop-packaged-single-instance-smoke"], 240),
            ("desktop-packaged-recovery-smoke", ["make", "desktop-packaged-recovery-smoke"], 300),
            ("desktop-packaged-watchdog-smoke", ["make", "desktop-packaged-watchdog-smoke"], 300),
            ("desktop-dmg-verify", ["make", "desktop-dmg-verify"], 420),
            ("desktop-dmg-smoke", ["make", "desktop-dmg-smoke"], 300),
            ("desktop-dmg-open-smoke", ["make", "desktop-dmg-open-smoke"], 300),
            ("desktop-release-assessment", ["make", "desktop-release-assessment"], 300),
        ]
    )
    if args.mode == "full":
        steps.append(("desktop-packaged-soak", ["make", "desktop-packaged-soak"], None))
    if args.require_external_ready:
        steps.extend(
            [
                ("desktop-notarization-check", ["make", "desktop-notarization-check"], 120),
                ("desktop-external-verify", ["make", "desktop-external-verify"], 420),
                (
                    "desktop-release-assessment-external",
                    ["make", "desktop-release-assessment", "REQUIRE_EXTERNAL_READY=1"],
                    300,
                ),
            ]
        )
    return steps


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Echo Founder 桌面发布门禁报告",
        "",
        f"- 状态：{report['status']}",
        f"- 模式：{report['mode']}",
        f"- 外部分发硬门禁：{'yes' if report['require_external_ready'] else 'no'}",
        f"- Python 来源要求：{report['require_python_source']}",
        f"- 开始：{report['started_at']}",
        f"- 结束：{report['finished_at']}",
        f"- 耗时：{report['duration_seconds']}s",
        "",
        "## 步骤",
        "",
        "| 步骤 | 状态 | 退出码 | 耗时 |",
        "| --- | --- | ---: | ---: |",
    ]
    for step in report["steps"]:
        lines.append(
            f"| {step['label']} | `{step['status']}` | {step['returncode']} | {step['duration_seconds']}s |"
        )
    if report.get("failed_steps"):
        lines.extend(["", "## 阻断项", ""])
        lines.extend(f"- {item}" for item in report["failed_steps"])
    lines.append("")
    return "\n".join(lines)


def write_reports(args: argparse.Namespace, report: dict[str, Any]) -> tuple[Path, Path]:
    report_dir = Path(args.report_dir).expanduser().resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    json_path = report_dir / f"desktop-release-gate-{args.mode}-{stamp}.json"
    markdown_path = report_dir / f"desktop-release-gate-{args.mode}-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Echo Founder desktop release gate")
    parser.add_argument("--mode", choices=["quick", "standard", "full"], default="quick")
    parser.add_argument("--report-dir", default=str(DEFAULT_REPORT_DIR))
    parser.add_argument("--require-python-source", default="bundled-runtime")
    parser.add_argument("--require-external-ready", action="store_true")
    parser.add_argument("--skip-next-build", action="store_true", help="standard/full: reuse existing .next-desktop bundle")
    parser.add_argument("--fast-soak", action="store_true", help="full: shrink packaged soak to 60 seconds")
    parser.add_argument("--keep-going", action="store_true", help="continue after a failed step and report all failures")
    args = parser.parse_args()

    started_at = now_iso()
    started = time.time()
    env = base_env(args)
    results: list[dict[str, Any]] = []
    for label, command, timeout in gate_steps(args):
        result = run_step(label, command, env, timeout)
        results.append(result)
        if result["status"] != "pass" and not args.keep_going:
            break

    failed_steps = [str(step["label"]) for step in results if step["status"] != "pass"]
    report: dict[str, Any] = {
        "status": "pass" if not failed_steps else "fail",
        "mode": args.mode,
        "require_external_ready": bool(args.require_external_ready),
        "require_python_source": args.require_python_source,
        "started_at": started_at,
        "finished_at": now_iso(),
        "duration_seconds": round(time.time() - started, 3),
        "failed_steps": failed_steps,
        "steps": results,
    }
    json_path, markdown_path = write_reports(args, report)
    print(PASS_LABEL if report["status"] == "pass" else FAIL_LABEL)
    print(f"status={report['status']}")
    print(f"mode={args.mode}")
    print(f"failed_steps={','.join(failed_steps)}")
    print(f"report_json={json_path}")
    print(f"report_markdown={markdown_path}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
