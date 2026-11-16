#!/usr/bin/env python3
"""Smoke test packaged Echo Founder watchdog recovery after a service hang."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from desktop_packaged_recovery_smoke import (
    SmokeAbort,
    desktop_log_path,
    launch_app,
    runtime_from_diagnostics,
    service_start_events,
)
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


PASS_LABEL = "PASS packaged desktop watchdog smoke"
FAIL_LABEL = "FAIL packaged desktop watchdog smoke"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def int_value(value: Any, default: int = 0) -> int:
    try:
        return int(str(value or default))
    except (TypeError, ValueError):
        return default


def pid_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def child_process_tree_pids(root_pid: int) -> list[int]:
    if os.name == "nt" or root_pid <= 0:
        return []
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid="],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return []
    children: dict[int, list[int]] = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split()
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
        except ValueError:
            continue
        children.setdefault(ppid, []).append(pid)

    descendants: list[int] = []
    stack = [root_pid]
    while stack:
        parent = stack.pop()
        for pid in children.get(parent, []):
            descendants.append(pid)
            stack.append(pid)
    return descendants


def signal_posix_pid_or_group(pid: int, sig: signal.Signals) -> None:
    try:
        os.killpg(pid, sig)
        return
    except OSError:
        pass
    try:
        os.kill(pid, sig)
    except OSError:
        pass


def signal_service_tree(pid: int, sig: signal.Signals) -> None:
    for target_pid in [*reversed(child_process_tree_pids(pid)), pid]:
        signal_posix_pid_or_group(target_pid, sig)


def stop_service_group(pid: int) -> None:
    if os.name == "nt":
        raise RuntimeError("watchdog hang smoke is only supported on POSIX platforms")
    signal_service_tree(pid, signal.SIGSTOP)


def cleanup_stopped_service_group(pid: int) -> None:
    if os.name == "nt" or pid <= 0 or not pid_exists(pid):
        return
    signal_service_tree(pid, signal.SIGCONT)
    signal_service_tree(pid, signal.SIGTERM)
    deadline = time.time() + 5
    while time.time() < deadline:
        if not pid_exists(pid):
            return
        time.sleep(0.2)
    signal_service_tree(pid, signal.SIGKILL)


def wait_for_watchdog_recovered_runtime(
    port: int,
    previous_started_at: str,
    previous_restart_count: int,
    previous_watchdog_count: int,
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_runtime: dict[str, Any] = {}
    while time.time() < deadline:
        runtime = runtime_from_diagnostics(port)
        if runtime:
            last_runtime = runtime
            restart_count = int_value(runtime.get("serviceRestartCount"))
            watchdog_count = int_value(runtime.get("serviceWatchdogRestartCount"))
            started_at = str(runtime.get("serviceStartedAt") or "")
            if (
                restart_count >= previous_restart_count + 1
                and watchdog_count >= previous_watchdog_count + 1
                and started_at
                and started_at != previous_started_at
            ):
                return runtime
        time.sleep(1)
    return last_runtime


def wait_for_watchdog_started(path: Path, timeout_seconds: int = 30) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if "Echo Founder service watchdog started" in tail(path, 12000):
            return True
        time.sleep(0.5)
    return "Echo Founder service watchdog started" in tail(path, 12000)


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Echo Founder 打包桌面 App Watchdog 无响应恢复烟测报告",
        "",
        f"- 状态：{report['status']}",
        f"- App：{report['app_path']}",
        f"- 本地地址：{report['base_url']}",
        f"- 项目目录：{report['project_dir']}",
        f"- userData：{report['user_data_dir']}",
        f"- 最小环境启动：{'yes' if report['minimal_env'] else 'no'}",
        f"- Python 来源要求：{report.get('require_python_source') or 'none'}",
        f"- Electron PID：{report.get('electron_pid')}",
        f"- 被暂停的服务 PID：{report.get('stopped_service_pid')}",
        f"- 恢复后服务 PID：{report.get('recovered_service_pid')}",
        f"- 服务恢复次数：{report.get('restart_count_before')} -> {report.get('restart_count_after')}",
        f"- Watchdog 恢复次数：{report.get('watchdog_restart_count_before')} -> {report.get('watchdog_restart_count_after')}",
        f"- Electron 保持存活：{'yes' if report.get('electron_alive_after_recovery') else 'no'}",
        f"- API 恢复：{'yes' if report.get('status_endpoint_recovered') else 'no'}",
        f"- 原服务已结束：{'yes' if report.get('stopped_service_gone') else 'no'}",
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
    json_path = report_dir / f"desktop-packaged-watchdog-smoke-{stamp}.json"
    markdown_path = report_dir / f"desktop-packaged-watchdog-smoke-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def fail(report: dict[str, Any], message: str) -> None:
    report["failures"].append(message)


def finalize(report: dict[str, Any], report_dir: Path | None) -> int:
    report["ended_at"] = now_iso()
    report["status"] = "pass" if not report["failures"] else "fail"
    report["conclusion"] = (
        "打包桌面 App 的本地服务无响应后，watchdog 已终止旧服务并自动恢复，API 重新可用，退出后端口释放。"
        if report["status"] == "pass"
        else "watchdog 无响应恢复烟测失败，不能证明桌面壳可从服务卡死中自恢复。"
    )
    json_path, markdown_path = write_report(report, report_dir)
    print(PASS_LABEL if report["status"] == "pass" else FAIL_LABEL)
    print(f"status={report['status']}")
    print(f"app_path={report['app_path']}")
    print(f"url={report['base_url']}")
    print(f"electron_pid={report.get('electron_pid')}")
    print(f"stopped_service_pid={report.get('stopped_service_pid')}")
    print(f"recovered_service_pid={report.get('recovered_service_pid')}")
    print(f"restart_count_before={report.get('restart_count_before')}")
    print(f"restart_count_after={report.get('restart_count_after')}")
    print(f"watchdog_restart_count_before={report.get('watchdog_restart_count_before')}")
    print(f"watchdog_restart_count_after={report.get('watchdog_restart_count_after')}")
    print(f"electron_alive_after_recovery={report.get('electron_alive_after_recovery')}")
    print(f"status_endpoint_recovered={report.get('status_endpoint_recovered')}")
    print(f"stopped_service_gone={report.get('stopped_service_gone')}")
    print(f"port_closed={report.get('port_closed')}")
    if json_path:
        print(f"report_json={json_path}")
    if markdown_path:
        print(f"report_markdown={markdown_path}")
    if report["failures"]:
        for item in report["failures"]:
            print(f"failure={item}", file=sys.stderr)
    return 0 if report["status"] == "pass" else 1


def run_watchdog_smoke(
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
        "stopped_service_pid": None,
        "recovered_service_pid": None,
        "restart_count_before": None,
        "restart_count_after": None,
        "watchdog_restart_count_before": None,
        "watchdog_restart_count_after": None,
        "runtime_before": {},
        "runtime_after": {},
        "electron_alive_after_recovery": False,
        "status_endpoint_recovered": False,
        "stopped_service_gone": False,
        "port_closed": False,
        "failures": [],
        "conclusion": "",
    }

    proc: subprocess.Popen[object] | None = None
    app_log = Path("/tmp") / f"aifios-packaged-watchdog-{port}.log"
    stopped_pid = 0
    try:
        if not binary.exists():
            fail(report, f"app binary not found: {binary}")
            raise SmokeAbort
        project_dir.mkdir(parents=True, exist_ok=True)
        if user_data_dir.exists():
            shutil.rmtree(user_data_dir)
        user_data_dir.mkdir(parents=True, exist_ok=True)

        env = packaged_app_env(project_dir, port, minimal_env, user_data_dir)
        env["AIFIOS_DESKTOP_SERVICE_WATCHDOG"] = "1"
        env["AIFIOS_DESKTOP_SERVICE_WATCHDOG_INTERVAL_MS"] = "1000"
        env["AIFIOS_DESKTOP_SERVICE_WATCHDOG_TIMEOUT_MS"] = "500"
        env["AIFIOS_DESKTOP_SERVICE_WATCHDOG_FAILURES"] = "2"
        env["AIFIOS_DESKTOP_SERVICE_RESTART_DELAY_MS"] = "500"
        env["AIFIOS_DESKTOP_SERVICE_RESTART_MAX"] = "2"
        proc = launch_app(binary, env, app_log)
        report["electron_pid"] = proc.pid

        ready, detail = wait_until_ready(port, timeout_seconds)
        if not ready:
            fail(report, f"app did not become ready before watchdog test: {detail}; log={app_log}")
            report["app_log_tail"] = tail(app_log)
            raise SmokeAbort

        runtime_before = runtime_from_diagnostics(port)
        report["runtime_before"] = runtime_before
        if require_python_source and runtime_before.get("pythonSource") != require_python_source:
            fail(report, f"unexpected Python source: expected={require_python_source} actual={runtime_before.get('pythonSource')}")
        if runtime_before.get("serviceWatchdogEnabled") != "1":
            fail(report, f"watchdog is not enabled in diagnostics: {runtime_before}")
        if runtime_before.get("serviceRestartCount") not in ("0", 0, ""):
            fail(report, f"unexpected initial restart count: {runtime_before}")

        log_path = desktop_log_path(user_data_dir)
        if not wait_for_watchdog_started(log_path):
            fail(report, f"watchdog did not start before hang simulation: {log_path}")
            report["desktop_log_tail"] = tail(log_path, 12000)
            raise SmokeAbort

        events_before = service_start_events(desktop_log_path(user_data_dir))
        if not events_before:
            fail(report, f"could not find service start event in desktop log: {log_path}")
            report["desktop_log_tail"] = tail(log_path, 12000)
            raise SmokeAbort
        first_event = events_before[-1]
        stopped_pid = int(first_event["pid"])
        report["stopped_service_pid"] = stopped_pid
        restart_count_before = int_value(runtime_before.get("serviceRestartCount"), int_value(first_event.get("restart")))
        watchdog_count_before = int_value(runtime_before.get("serviceWatchdogRestartCount"))
        started_at_before = str(runtime_before.get("serviceStartedAt") or first_event["started_at"] or "")
        report["restart_count_before"] = restart_count_before
        report["watchdog_restart_count_before"] = watchdog_count_before

        stop_service_group(stopped_pid)
        runtime_after = wait_for_watchdog_recovered_runtime(
            port,
            started_at_before,
            restart_count_before,
            watchdog_count_before,
            recovery_timeout_seconds,
        )
        report["runtime_after"] = runtime_after
        report["restart_count_after"] = int_value(runtime_after.get("serviceRestartCount"), -1) if runtime_after else None
        report["watchdog_restart_count_after"] = int_value(runtime_after.get("serviceWatchdogRestartCount"), -1) if runtime_after else None
        report["electron_alive_after_recovery"] = proc.poll() is None
        status = fetch_json(f"http://{HOST}:{port}/api/status", timeout=3.0)
        report["status_endpoint_recovered"] = isinstance(status, dict) and bool(status.get("project"))

        events_after = service_start_events(desktop_log_path(user_data_dir))
        if events_after:
            report["recovered_service_pid"] = int(events_after[-1]["pid"])
        report["stopped_service_gone"] = not pid_exists(stopped_pid)

        if not runtime_after:
            fail(report, "diagnostics endpoint did not recover after stopping local service process group")
        elif report["restart_count_after"] is None or report["restart_count_after"] < restart_count_before + 1:
            fail(report, f"serviceRestartCount did not increment after watchdog recovery: before={restart_count_before} after={runtime_after}")
        if runtime_after and report["watchdog_restart_count_after"] is not None and report["watchdog_restart_count_after"] < watchdog_count_before + 1:
            fail(report, f"serviceWatchdogRestartCount did not increment: before={watchdog_count_before} after={runtime_after}")
        if str(runtime_after.get("serviceStartedAt") or "") == started_at_before:
            fail(report, f"serviceStartedAt did not change after watchdog recovery: before={started_at_before} after={runtime_after}")
        if report["recovered_service_pid"] == stopped_pid:
            fail(report, f"service pid did not change after watchdog recovery: {stopped_pid}")
        if not report["stopped_service_gone"]:
            fail(report, f"stopped service process still exists after watchdog recovery: {stopped_pid}")
        if not report["electron_alive_after_recovery"]:
            fail(report, f"Electron exited during watchdog smoke: code={proc.returncode}; log={app_log}")
            report["app_log_tail"] = tail(app_log)
        if not report["status_endpoint_recovered"]:
            fail(report, f"/api/status did not recover after watchdog restart: {status}")
    except SmokeAbort:
        pass
    except Exception as exc:
        fail(report, f"unexpected watchdog smoke error: {exc}")
        report["app_log_tail"] = tail(app_log)
        report["desktop_log_tail"] = tail(desktop_log_path(user_data_dir), 12000)
    finally:
        if stopped_pid and pid_exists(stopped_pid):
            cleanup_stopped_service_group(stopped_pid)
        if proc:
            terminate_process(proc)
        report["port_closed"] = wait_for_port_closed(port)
        if not report["port_closed"]:
            fail(report, f"port did not close after app stopped: {port}")
    return finalize(report, report_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test packaged Echo Founder service watchdog recovery")
    parser.add_argument("--app-path", default="dist/desktop/Echo Founder.app")
    parser.add_argument("--project-dir", default="/private/tmp/aifios-packaged-watchdog-smoke")
    parser.add_argument("--user-data-dir", default="/private/tmp/aifios-packaged-watchdog-user-data")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--recovery-timeout", type=int, default=60)
    parser.add_argument("--minimal-env", action="store_true", help="launch the app with a Finder-like minimal PATH")
    parser.add_argument("--require-python-source", default="", help="fail unless diagnostics runtime.pythonSource matches this value")
    parser.add_argument("--report-dir", default="", help="write JSON/Markdown audit report into this directory")
    args = parser.parse_args()

    port = args.port or find_free_port()
    if port_is_open(port):
        print(f"FAIL packaged watchdog smoke: port is already in use: {port}", file=sys.stderr)
        return 1
    return run_watchdog_smoke(
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
