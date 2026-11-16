#!/usr/bin/env python3
"""Smoke test packaged Echo Founder single-instance behavior."""
from __future__ import annotations

import argparse
import json
import os
import shutil
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


PASS_LABEL = "PASS packaged desktop single-instance smoke"
FAIL_LABEL = "FAIL packaged desktop single-instance smoke"


class SmokeAbort(Exception):
    """Stop the smoke flow after recording a concrete failure."""


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


def wait_for_log_token(path: Path, token: str, timeout_seconds: int) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if token in tail(path, 12000):
            return True
        time.sleep(0.5)
    return token in tail(path, 12000)


def runtime_from_diagnostics(port: int) -> dict[str, Any]:
    diagnostics = fetch_json(f"http://{HOST}:{port}/api/desktop/diagnostics")
    if not isinstance(diagnostics, dict):
        return {}
    runtime = diagnostics.get("runtime")
    return runtime if isinstance(runtime, dict) else {}


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Echo Founder 打包桌面 App 单实例烟测报告",
        "",
        f"- 状态：{report['status']}",
        f"- App：{report['app_path']}",
        f"- 本地地址：{report['base_url']}",
        f"- 项目目录：{report['project_dir']}",
        f"- userData：{report['user_data_dir']}",
        f"- 最小环境启动：{'yes' if report['minimal_env'] else 'no'}",
        f"- Python 来源要求：{report.get('require_python_source') or 'none'}",
        f"- 第一个实例 PID：{report.get('first_pid')}",
        f"- 第二个实例 PID：{report.get('second_pid')}",
        f"- 第二个实例退出码：{report.get('second_returncode')}",
        f"- 首实例保持存活：{'yes' if report.get('first_alive_after_duplicate') else 'no'}",
        f"- runtime parent pid 未变化：{'yes' if report.get('parent_pid_stable') else 'no'}",
        f"- second-instance 日志事件：{'yes' if report.get('second_instance_log_seen') else 'no'}",
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
    json_path = report_dir / f"desktop-packaged-single-instance-smoke-{stamp}.json"
    markdown_path = report_dir / f"desktop-packaged-single-instance-smoke-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def fail(report: dict[str, Any], message: str) -> None:
    report["failures"].append(message)


def run_single_instance_smoke(
    app_path: Path,
    project_dir: Path,
    user_data_dir: Path,
    port: int,
    timeout_seconds: int,
    duplicate_exit_timeout: int,
    minimal_env: bool,
    require_python_source: str,
    report_dir: Path | None,
) -> int:
    started_at = now_iso()
    binary = app_binary(app_path)
    report: dict[str, Any] = {
        "status": "fail",
        "app_path": str(app_path),
        "base_url": f"http://{HOST}:{port}",
        "project_dir": str(project_dir),
        "user_data_dir": str(user_data_dir),
        "minimal_env": bool(minimal_env),
        "require_python_source": require_python_source,
        "started_at": started_at,
        "ended_at": "",
        "first_pid": None,
        "second_pid": None,
        "second_returncode": None,
        "first_alive_after_duplicate": False,
        "parent_pid_stable": False,
        "second_instance_log_seen": False,
        "port_closed": False,
        "runtime_before": {},
        "runtime_after": {},
        "failures": [],
        "conclusion": "",
    }

    first_proc: subprocess.Popen[object] | None = None
    second_proc: subprocess.Popen[object] | None = None
    first_log = Path("/tmp") / f"aifios-packaged-single-instance-first-{port}.log"
    second_log = Path("/tmp") / f"aifios-packaged-single-instance-second-{port}.log"
    try:
        if not binary.exists():
            fail(report, f"app binary not found: {binary}")
            raise SmokeAbort
        project_dir.mkdir(parents=True, exist_ok=True)
        if user_data_dir.exists():
            shutil.rmtree(user_data_dir)
        user_data_dir.mkdir(parents=True, exist_ok=True)

        env = packaged_app_env(project_dir, port, minimal_env, user_data_dir)
        env.pop("AIFIOS_DESKTOP_ALLOW_MULTI_INSTANCE", None)
        first_proc = launch_app(binary, env, first_log)
        report["first_pid"] = first_proc.pid

        ready, detail = wait_until_ready(port, timeout_seconds)
        if not ready:
            fail(report, f"first instance did not become ready: {detail}; log={first_log}")
            report["first_log_tail"] = tail(first_log)
            raise SmokeAbort

        runtime_before = runtime_from_diagnostics(port)
        report["runtime_before"] = runtime_before
        if runtime_before.get("singleInstance") != "1":
            fail(report, f"singleInstance is not enabled: {runtime_before}")
        if runtime_before.get("desktopParentPid") != str(first_proc.pid):
            fail(report, f"desktopParentPid mismatch before duplicate: expected={first_proc.pid} runtime={runtime_before}")
        if runtime_before.get("desktopUserDataDir") != user_data_dir.name:
            fail(report, f"isolated userData mismatch: expected={user_data_dir.name} runtime={runtime_before}")
        if require_python_source and runtime_before.get("pythonSource") != require_python_source:
            fail(
                report,
                f"unexpected Python source: expected={require_python_source} actual={runtime_before.get('pythonSource')}",
            )

        second_proc = launch_app(binary, env, second_log)
        report["second_pid"] = second_proc.pid
        try:
            report["second_returncode"] = second_proc.wait(timeout=duplicate_exit_timeout)
        except subprocess.TimeoutExpired:
            fail(report, f"duplicate instance did not exit within {duplicate_exit_timeout}s")
            terminate_process(second_proc)
            report["second_returncode"] = second_proc.returncode

        if report["second_returncode"] != 0:
            fail(report, f"duplicate instance exited with non-zero code: {report['second_returncode']}; log={second_log}")
            report["second_log_tail"] = tail(second_log)

        time.sleep(1)
        runtime_after = runtime_from_diagnostics(port)
        report["runtime_after"] = runtime_after
        report["first_alive_after_duplicate"] = first_proc.poll() is None
        report["parent_pid_stable"] = (
            runtime_before.get("desktopParentPid") == str(first_proc.pid)
            and runtime_after.get("desktopParentPid") == str(first_proc.pid)
        )
        report["second_instance_log_seen"] = wait_for_log_token(
            desktop_log_path(user_data_dir),
            "Second Echo Founder desktop instance requested",
            8,
        )

        if not report["first_alive_after_duplicate"]:
            fail(report, f"first instance exited after duplicate launch: code={first_proc.returncode}; log={first_log}")
            report["first_log_tail"] = tail(first_log)
        if not report["parent_pid_stable"]:
            fail(report, f"desktop parent pid changed after duplicate launch: before={runtime_before} after={runtime_after}")
        if runtime_after.get("singleInstance") != "1":
            fail(report, f"singleInstance missing after duplicate launch: {runtime_after}")
        if not report["second_instance_log_seen"]:
            fail(report, f"first instance did not log second-instance event: {desktop_log_path(user_data_dir)}")
        status = fetch_json(f"http://{HOST}:{port}/api/status")
        if not isinstance(status, dict) or not status.get("project"):
            fail(report, f"first instance status endpoint unavailable after duplicate launch: {status}")
    except SmokeAbort:
        pass
    except Exception as exc:
        fail(report, f"unexpected single-instance smoke error: {exc}")
    finally:
        if second_proc and second_proc.poll() is None:
            terminate_process(second_proc)
        if first_proc:
            terminate_process(first_proc)
        report["port_closed"] = wait_for_port_closed(port)
        if not report["port_closed"]:
            fail(report, f"port did not close after first instance stopped: {port}")
    return finalize(report, report_dir)


def finalize(report: dict[str, Any], report_dir: Path | None) -> int:
    report["ended_at"] = now_iso()
    report["status"] = "pass" if not report["failures"] else "fail"
    report["conclusion"] = (
        "重复启动打包桌面 App 时，第二个实例快速退出，首实例继续服务，runtime parent pid 未变化。"
        if report["status"] == "pass"
        else "重复启动单实例验证失败，不能证明桌面 App 会稳定收敛到唯一运行实例。"
    )
    json_path, markdown_path = write_report(report, report_dir)
    print(PASS_LABEL if report["status"] == "pass" else FAIL_LABEL)
    print(f"status={report['status']}")
    print(f"app_path={report['app_path']}")
    print(f"url={report['base_url']}")
    print(f"first_pid={report.get('first_pid')}")
    print(f"second_pid={report.get('second_pid')}")
    print(f"second_returncode={report.get('second_returncode')}")
    print(f"parent_pid_stable={report.get('parent_pid_stable')}")
    print(f"second_instance_log_seen={report.get('second_instance_log_seen')}")
    print(f"port_closed={report.get('port_closed')}")
    if json_path:
        print(f"report_json={json_path}")
    if markdown_path:
        print(f"report_markdown={markdown_path}")
    if report["failures"]:
        for item in report["failures"]:
            print(f"failure={item}", file=sys.stderr)
    return 0 if report["status"] == "pass" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test packaged Echo Founder single-instance behavior")
    parser.add_argument("--app-path", default="dist/desktop/Echo Founder.app")
    parser.add_argument("--project-dir", default="/private/tmp/aifios-packaged-single-instance-smoke")
    parser.add_argument("--user-data-dir", default="/private/tmp/aifios-packaged-single-instance-user-data")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--duplicate-exit-timeout", type=int, default=20)
    parser.add_argument("--minimal-env", action="store_true", help="launch the app with a Finder-like minimal PATH")
    parser.add_argument("--require-python-source", default="", help="fail unless diagnostics runtime.pythonSource matches this value")
    parser.add_argument("--report-dir", default="", help="write JSON/Markdown audit report into this directory")
    args = parser.parse_args()

    port = args.port or find_free_port()
    if port_is_open(port):
        print(f"FAIL packaged single-instance smoke: port is already in use: {port}", file=sys.stderr)
        return 1
    return run_single_instance_smoke(
        Path(args.app_path).expanduser().resolve(),
        Path(args.project_dir).expanduser(),
        Path(args.user_data_dir).expanduser().resolve(),
        port,
        args.timeout,
        args.duplicate_exit_timeout,
        args.minimal_env,
        args.require_python_source,
        Path(args.report_dir).expanduser().resolve() if args.report_dir else None,
    )


if __name__ == "__main__":
    raise SystemExit(main())
