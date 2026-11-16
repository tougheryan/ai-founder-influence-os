#!/usr/bin/env python3
"""Smoke test packaged Echo Founder recovery after the local service exits."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from desktop_packaged_smoke import (
    HOST,
    app_binary,
    fetch_json,
    find_free_port,
    packaged_app_env,
    port_is_open,
    tail,
    terminate_process,
    wait_for_port_closed,
    wait_until_ready,
)


PASS_LABEL = "PASS packaged desktop recovery smoke"
FAIL_LABEL = "FAIL packaged desktop recovery smoke"
SERVICE_STARTED_PATTERN = re.compile(
    r"Echo Founder service process started: pid=(?P<pid>\d+) restartCount=(?P<restart>\d+) startedAt=(?P<started_at>\S+)"
)


class SmokeAbort(Exception):
    """Stop the recovery flow after recording a concrete failure."""


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def launch_app(binary: Path, env: dict[str, str], log_path: Path) -> subprocess.Popen[object]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("w", encoding="utf-8")
    try:
        return subprocess.Popen(
            [str(binary)],
            cwd=binary.parent,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
            preexec_fn=None if os.name == "nt" else os.setsid,
        )
    finally:
        log_file.close()


def desktop_log_path(user_data_dir: Path) -> Path:
    return user_data_dir / "logs" / "desktop.log"


def service_start_events(path: Path) -> list[dict[str, Any]]:
    matches = SERVICE_STARTED_PATTERN.finditer(tail(path, 24000))
    return [
        {
            "pid": int(match.group("pid")),
            "restart": int(match.group("restart")),
            "started_at": match.group("started_at"),
        }
        for match in matches
    ]


def runtime_from_diagnostics(port: int) -> dict[str, Any]:
    diagnostics = fetch_json(f"http://{HOST}:{port}/api/desktop/diagnostics", timeout=3.0)
    if not isinstance(diagnostics, dict):
        return {}
    runtime = diagnostics.get("runtime")
    return runtime if isinstance(runtime, dict) else {}


def kill_service_group(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    os.killpg(pid, signal.SIGTERM)


def wait_for_recovered_runtime(port: int, previous_started_at: str, previous_restart_count: int, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_runtime: dict[str, Any] = {}
    while time.time() < deadline:
        runtime = runtime_from_diagnostics(port)
        if runtime:
            last_runtime = runtime
            restart_count = int(str(runtime.get("serviceRestartCount") or "0"))
            started_at = str(runtime.get("serviceStartedAt") or "")
            if restart_count >= previous_restart_count + 1 and started_at and started_at != previous_started_at:
                return runtime
        time.sleep(1)
    return last_runtime


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Echo Founder 打包桌面 App 服务恢复烟测报告",
        "",
        f"- 状态：{report['status']}",
        f"- App：{report['app_path']}",
        f"- 本地地址：{report['base_url']}",
        f"- 项目目录：{report['project_dir']}",
        f"- userData：{report['user_data_dir']}",
        f"- 最小环境启动：{'yes' if report['minimal_env'] else 'no'}",
        f"- Python 来源要求：{report.get('require_python_source') or 'none'}",
        f"- Electron PID：{report.get('electron_pid')}",
        f"- 被终止的服务 PID：{report.get('killed_service_pid')}",
        f"- 恢复后服务 PID：{report.get('recovered_service_pid')}",
        f"- 恢复次数：{report.get('restart_count_before')} -> {report.get('restart_count_after')}",
        f"- Electron 保持存活：{'yes' if report.get('electron_alive_after_recovery') else 'no'}",
        f"- API 恢复：{'yes' if report.get('status_endpoint_recovered') else 'no'}",
        f"- 端口释放：{'pass' if report.get('port_closed') else 'fail'}",
        f"- 开始时间：{report['started_at']}",
        f"- 结束时间：{report['ended_at']}",
        "",
        "## 结论",
        "",
        report["conclusion"],
    ]
    if report.get("failures"):
        lines.extend(["", "## 阻断项", ""])
        lines.extend(f"- {item}" for item in report["failures"])
    return "\n".join(lines) + "\n"


def write_report(report: dict[str, Any], report_dir: Path | None) -> tuple[Path | None, Path | None]:
    if not report_dir:
        return None, None
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    json_path = report_dir / f"desktop-packaged-recovery-smoke-{stamp}.json"
    markdown_path = report_dir / f"desktop-packaged-recovery-smoke-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def fail(report: dict[str, Any], message: str) -> None:
    report["failures"].append(message)


def finalize(report: dict[str, Any], report_dir: Path | None) -> int:
    report["ended_at"] = now_iso()
    report["status"] = "pass" if not report["failures"] else "fail"
    report["conclusion"] = (
        "打包桌面 App 的本地服务进程异常退出后，Electron 已自动恢复服务，API 重新可用，退出后端口释放。"
        if report["status"] == "pass"
        else "服务恢复烟测失败，不能证明桌面壳可从本地服务异常退出中自恢复。"
    )
    json_path, markdown_path = write_report(report, report_dir)
    print(PASS_LABEL if report["status"] == "pass" else FAIL_LABEL)
    print(f"status={report['status']}")
    print(f"app_path={report['app_path']}")
    print(f"url={report['base_url']}")
    print(f"electron_pid={report.get('electron_pid')}")
    print(f"killed_service_pid={report.get('killed_service_pid')}")
    print(f"recovered_service_pid={report.get('recovered_service_pid')}")
    print(f"restart_count_before={report.get('restart_count_before')}")
    print(f"restart_count_after={report.get('restart_count_after')}")
    print(f"electron_alive_after_recovery={report.get('electron_alive_after_recovery')}")
    print(f"status_endpoint_recovered={report.get('status_endpoint_recovered')}")
    print(f"port_closed={report.get('port_closed')}")
    if json_path:
        print(f"report_json={json_path}")
    if markdown_path:
        print(f"report_markdown={markdown_path}")
    if report["failures"]:
        for item in report["failures"]:
            print(f"failure={item}", file=sys.stderr)
    return 0 if report["status"] == "pass" else 1


def run_recovery_smoke(
    app_path: Path,
    project_dir: Path,
    user_data_dir: Path,
    port: int,
    timeout_seconds: int,
    recovery_timeout_seconds: int,
    minimal_env: bool,
    require_python_source: str,
    report_dir: Path | None,
) -> int:
    binary = app_binary(app_path)
    report: dict[str, Any] = {
        "status": "fail",
        "app_path": str(app_path),
        "base_url": f"http://{HOST}:{port}",
        "project_dir": str(project_dir),
        "user_data_dir": str(user_data_dir),
        "minimal_env": bool(minimal_env),
        "require_python_source": require_python_source,
        "started_at": now_iso(),
        "ended_at": "",
        "electron_pid": None,
        "killed_service_pid": None,
        "recovered_service_pid": None,
        "restart_count_before": None,
        "restart_count_after": None,
        "runtime_before": {},
        "runtime_after": {},
        "electron_alive_after_recovery": False,
        "status_endpoint_recovered": False,
        "port_closed": False,
        "failures": [],
        "conclusion": "",
    }

    proc: subprocess.Popen[object] | None = None
    app_log = Path("/tmp") / f"aifios-packaged-recovery-{port}.log"
    try:
        if not binary.exists():
            fail(report, f"app binary not found: {binary}")
            raise SmokeAbort
        project_dir.mkdir(parents=True, exist_ok=True)
        if user_data_dir.exists():
            shutil.rmtree(user_data_dir)
        user_data_dir.mkdir(parents=True, exist_ok=True)

        env = packaged_app_env(project_dir, port, minimal_env, user_data_dir)
        env["AIFIOS_DESKTOP_SERVICE_RESTART_DELAY_MS"] = "500"
        env["AIFIOS_DESKTOP_SERVICE_RESTART_MAX"] = "2"
        proc = launch_app(binary, env, app_log)
        report["electron_pid"] = proc.pid

        ready, detail = wait_until_ready(port, timeout_seconds)
        if not ready:
            fail(report, f"app did not become ready before recovery test: {detail}; log={app_log}")
            report["app_log_tail"] = tail(app_log)
            raise SmokeAbort

        runtime_before = runtime_from_diagnostics(port)
        report["runtime_before"] = runtime_before
        if require_python_source and runtime_before.get("pythonSource") != require_python_source:
            fail(report, f"unexpected Python source: expected={require_python_source} actual={runtime_before.get('pythonSource')}")
        if runtime_before.get("serviceRestartCount") not in ("0", 0, ""):
            fail(report, f"unexpected initial restart count: {runtime_before}")

        events_before = service_start_events(desktop_log_path(user_data_dir))
        if not events_before:
            fail(report, f"could not find service start event in desktop log: {desktop_log_path(user_data_dir)}")
            report["desktop_log_tail"] = tail(desktop_log_path(user_data_dir), 12000)
            raise SmokeAbort
        first_event = events_before[-1]
        service_pid = int(first_event["pid"])
        report["killed_service_pid"] = service_pid
        restart_count_before = int(str(runtime_before.get("serviceRestartCount") or first_event["restart"] or 0))
        started_at_before = str(runtime_before.get("serviceStartedAt") or first_event["started_at"] or "")
        report["restart_count_before"] = restart_count_before

        kill_service_group(service_pid)
        runtime_after = wait_for_recovered_runtime(port, started_at_before, restart_count_before, recovery_timeout_seconds)
        report["runtime_after"] = runtime_after
        report["restart_count_after"] = int(str(runtime_after.get("serviceRestartCount") or "-1")) if runtime_after else None
        report["electron_alive_after_recovery"] = proc.poll() is None
        status = fetch_json(f"http://{HOST}:{port}/api/status", timeout=3.0)
        report["status_endpoint_recovered"] = isinstance(status, dict) and bool(status.get("project"))

        events_after = service_start_events(desktop_log_path(user_data_dir))
        if events_after:
            report["recovered_service_pid"] = int(events_after[-1]["pid"])

        if not runtime_after:
            fail(report, "diagnostics endpoint did not recover after killing local service process group")
        elif report["restart_count_after"] is None or report["restart_count_after"] < restart_count_before + 1:
            fail(report, f"serviceRestartCount did not increment after recovery: before={restart_count_before} after={runtime_after}")
        if str(runtime_after.get("serviceStartedAt") or "") == started_at_before:
            fail(report, f"serviceStartedAt did not change after recovery: before={started_at_before} after={runtime_after}")
        if report["recovered_service_pid"] == service_pid:
            fail(report, f"service pid did not change after recovery: {service_pid}")
        if not report["electron_alive_after_recovery"]:
            fail(report, f"Electron exited during recovery smoke: code={proc.returncode}; log={app_log}")
            report["app_log_tail"] = tail(app_log)
        if not report["status_endpoint_recovered"]:
            fail(report, f"/api/status did not recover after service restart: {status}")
    except SmokeAbort:
        pass
    except Exception as exc:
        fail(report, f"unexpected recovery smoke error: {exc}")
        report["app_log_tail"] = tail(app_log)
        report["desktop_log_tail"] = tail(desktop_log_path(user_data_dir), 12000)
    finally:
        if proc:
            terminate_process(proc)
        report["port_closed"] = wait_for_port_closed(port)
        if not report["port_closed"]:
            fail(report, f"port did not close after app stopped: {port}")
    return finalize(report, report_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test packaged Echo Founder service auto-recovery")
    parser.add_argument("--app-path", default="dist/desktop/Echo Founder.app")
    parser.add_argument("--project-dir", default="/private/tmp/aifios-packaged-recovery-smoke")
    parser.add_argument("--user-data-dir", default="/private/tmp/aifios-packaged-recovery-user-data")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--recovery-timeout", type=int, default=60)
    parser.add_argument("--minimal-env", action="store_true", help="launch the app with a Finder-like minimal PATH")
    parser.add_argument("--require-python-source", default="", help="fail unless diagnostics runtime.pythonSource matches this value")
    parser.add_argument("--report-dir", default="", help="write JSON/Markdown audit report into this directory")
    args = parser.parse_args()

    port = args.port or find_free_port()
    if port_is_open(port):
        print(f"FAIL packaged recovery smoke: port is already in use: {port}", file=sys.stderr)
        return 1
    return run_recovery_smoke(
        Path(args.app_path).expanduser().resolve(),
        Path(args.project_dir).expanduser(),
        Path(args.user_data_dir).expanduser().resolve(),
        port,
        args.timeout,
        args.recovery_timeout,
        args.minimal_env,
        args.require_python_source,
        Path(args.report_dir).expanduser().resolve() if args.report_dir else None,
    )


if __name__ == "__main__":
    raise SystemExit(main())
