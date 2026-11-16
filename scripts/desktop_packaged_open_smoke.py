#!/usr/bin/env python3
"""Smoke test launching packaged Echo Founder through macOS LaunchServices."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from desktop_packaged_smoke import (
    HOST,
    fetch_json,
    tail,
    verify_required_production_routes,
    wait_for_port_closed,
    wait_until_ready,
)
from desktop_packaged_watchdog_smoke import child_process_tree_pids, signal_posix_pid_or_group


PASS_LABEL = "PASS packaged desktop open smoke"
FAIL_LABEL = "FAIL packaged desktop open smoke"


class SmokeAbort(Exception):
    """Stop the open smoke after recording a concrete failure."""


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def desktop_log_path(user_data_dir: Path) -> Path:
    return user_data_dir / "logs" / "desktop.log"


def app_bundle_name(app_path: Path) -> str:
    return app_path.stem


def launch_with_open(
    app_path: Path,
    env_values: dict[str, str],
    log_path: Path,
    user_data_dir: Path,
    *,
    clear_parent_environment: bool = False,
) -> subprocess.CompletedProcess[str]:
    app_stdout_path = log_path.with_name(f"{log_path.stem}-app.stdout.log")
    app_stderr_path = log_path.with_name(f"{log_path.stem}-app.stderr.log")
    open_command = [
        "/usr/bin/open",
        "-n",
        "-g",
        *[item for key, value in env_values.items() for item in ("--env", f"{key}={value}")],
        "--stdout",
        str(app_stdout_path),
        "--stderr",
        str(app_stderr_path),
        str(app_path),
        "--args",
        f"--user-data-dir={user_data_dir}",
    ]
    # LaunchServices normally inherits the caller's environment. The clean
    # first-launch gate deliberately starts `open` under `env -i`, then passes
    # only non-product bootstrap values. This proves the packaged app does not
    # depend on any AIFIOS_* override from the build machine.
    command = ["/usr/bin/env", "-i", *open_command] if clear_parent_environment else open_command
    log_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=30,
        check=False,
    )
    log_path.write_text(result.stdout or "", encoding="utf-8")
    return result


def launch_log_tail(log_path: Path, limit: int = 12000) -> str:
    paths = (
        log_path,
        log_path.with_name(f"{log_path.stem}-app.stdout.log"),
        log_path.with_name(f"{log_path.stem}-app.stderr.log"),
    )
    return "\n".join(f"{path.name}:\n{tail(path, limit)}" for path in paths if path.exists())


def default_first_launch_paths(isolated_home: Path, app_name: str = "Echo Founder") -> tuple[Path, Path]:
    return (
        isolated_home / app_name,
        isolated_home / "Library" / "Application Support" / app_name,
    )


def default_first_launch_environment(isolated_home: Path) -> dict[str, str]:
    empty_path = isolated_home / "empty-path"
    temporary = isolated_home / "tmp"
    empty_path.mkdir(parents=True, exist_ok=True)
    temporary.mkdir(parents=True, exist_ok=True)
    environment = {
        "HOME": str(isolated_home),
        "PATH": str(empty_path),
        "TMPDIR": str(temporary),
        "ELECTRON_ENABLE_LOGGING": "1",
    }
    if any(key.startswith("AIFIOS_") for key in environment):
        raise RuntimeError("default first-launch environment must not contain AIFIOS_* overrides")
    return environment


def wait_for_dynamic_port(log_path: Path, timeout_seconds: int) -> tuple[int, str]:
    deadline = time.time() + timeout_seconds
    pattern = re.compile(r"Echo Founder service ready: http://127\.0\.0\.1:(\d+)")
    last_tail = ""
    while time.time() < deadline:
        last_tail = tail(log_path, 12000)
        match = pattern.search(last_tail)
        if match:
            port = int(match.group(1))
            if 1 <= port <= 65535:
                return port, "ready port discovered from the isolated desktop log"
        time.sleep(0.25)
    return 0, f"dynamic port was not recorded in {log_path}; tail={last_tail}"


def runtime_from_diagnostics(port: int) -> dict[str, Any]:
    diagnostics = fetch_json(f"http://{HOST}:{port}/api/desktop/diagnostics", timeout=3.0)
    if not isinstance(diagnostics, dict):
        return {}
    runtime = diagnostics.get("runtime")
    return runtime if isinstance(runtime, dict) else {}


def process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def query_opened_app_pids(app_path: Path, user_data_dir: Path) -> tuple[list[int], bool]:
    binary = app_path / "Contents" / "MacOS" / app_bundle_name(app_path)
    marker = f"--user-data-dir={user_data_dir}"
    python_pattern = rf"^{re.escape(str(binary))}(?:\s|$).*{re.escape(marker)}(?:\s|$)"
    pgrep_pattern = rf"^{re.escape(str(binary))}([[:space:]]|$).*{re.escape(marker)}([[:space:]]|$)"
    try:
        result = subprocess.run(
            ["/bin/ps", "-axo", "pid=,command="],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result is not None and result.returncode == 0:
        pids = []
        for line in result.stdout.splitlines():
            match = re.match(r"\s*(\d+)\s+(.*)", line)
            if match and re.search(python_pattern, match.group(2)):
                pids.append(int(match.group(1)))
        return sorted(set(pids)), True

    try:
        fallback = subprocess.run(
            ["/usr/bin/pgrep", "-f", pgrep_pattern],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return [], False
    if fallback.returncode not in {0, 1}:
        return [], False
    return sorted({int(value) for value in fallback.stdout.split() if value.isdigit()}), True


def find_opened_app_pid(app_path: Path, user_data_dir: Path) -> int:
    pids, _query_ok = query_opened_app_pids(app_path, user_data_dir)
    return pids[0] if pids else 0


def wait_for_opened_app_pid(app_path: Path, user_data_dir: Path, timeout_seconds: int = 15) -> int:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        pid = find_opened_app_pid(app_path, user_data_dir)
        if pid:
            return pid
        time.sleep(0.2)
    return find_opened_app_pid(app_path, user_data_dir)


def terminate_opened_app(pid: int) -> None:
    if pid <= 0 or not process_exists(pid):
        return
    targets = list(dict.fromkeys([*reversed(child_process_tree_pids(pid)), pid]))
    for target_pid in targets:
        signal_posix_pid_or_group(target_pid, signal.SIGTERM)
    deadline = time.time() + 15
    while time.time() < deadline:
        if not any(process_exists(target_pid) for target_pid in targets):
            return
        time.sleep(0.3)
    for target_pid in targets:
        if process_exists(target_pid):
            signal_posix_pid_or_group(target_pid, signal.SIGKILL)


def cleanup_isolated_opened_apps(
    app_path: Path,
    user_data_dir: Path,
    known_pid: int = 0,
    *,
    stable_checks: int = 3,
    stable_interval_seconds: float = 0.2,
    max_cleanup_rounds: int = 12,
) -> tuple[bool, list[int]]:
    discovered, initial_query_ok = query_opened_app_pids(app_path, user_data_dir)
    if not initial_query_ok:
        return False, []
    # A remembered PID is never sufficient authority to send a signal: it may
    # have exited and been reused. Only processes that still match both the
    # exact app binary and this smoke's unique userData marker are owned here.
    candidates = sorted(set(discovered))
    if known_pid in candidates:
        candidates.remove(known_pid)
        candidates.insert(0, known_pid)
    for pid in candidates:
        terminate_opened_app(pid)

    clean_snapshots = 0
    remaining: list[int] = []
    for _round in range(max_cleanup_rounds):
        remaining, verification_ok = query_opened_app_pids(app_path, user_data_dir)
        if not verification_ok:
            return False, []
        if remaining:
            clean_snapshots = 0
            for pid in remaining:
                terminate_opened_app(pid)
        else:
            clean_snapshots += 1
            if clean_snapshots >= stable_checks:
                return True, []
        time.sleep(stable_interval_seconds)
    remaining, verification_ok = query_opened_app_pids(app_path, user_data_dir)
    return False, remaining if verification_ok else []


def parse_pid(value: Any) -> int:
    try:
        return int(str(value or "0"))
    except (TypeError, ValueError):
        return 0


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# {report.get('report_title') or 'Echo Founder 打包桌面 App open 启动烟测报告'}",
        "",
        f"- 状态：{report['status']}",
        f"- App：{report['app_path']}",
        f"- 本地地址：{report['base_url']}",
        f"- 项目目录：{report['project_dir']}",
        f"- userData：{report['user_data_dir']}",
        f"- Python 来源要求：{report.get('require_python_source') or 'none'}",
        f"- open 退出码：{report.get('open_returncode')}",
        f"- Electron PID：{report.get('electron_pid')}",
        f"- 运行模式：{report.get('server_mode')}",
        f"- Python 来源：{report.get('python_source')}",
        f"- 生产路由：{report.get('production_routes') or '未检查'}",
        f"- 隔离进程清理：{'pass' if report.get('process_cleanup_verified') else 'fail'}",
        f"- 端口释放：{'pass' if report.get('port_closed') else 'fail'}",
        f"- 开始时间：{report['started_at']}",
        f"- 结束时间：{report['ended_at']}",
    ]
    if report.get("dmg_path"):
        lines.extend([
            f"- DMG：{report.get('dmg_path')}",
            f"- DMG SHA256：{report.get('dmg_sha256')}",
            f"- 安装后 App：{report.get('installed_app')}",
        ])
    lines.extend(["", "## 结论", "", report["conclusion"]])
    if report.get("failures"):
        lines.extend(["", "## 阻断项", ""])
        lines.extend(f"- {item}" for item in report["failures"])
    return "\n".join(lines) + "\n"


def write_report(report: dict[str, Any], report_dir: Path | None, report_prefix: str = "desktop-packaged-open-smoke") -> tuple[Path | None, Path | None]:
    if not report_dir:
        return None, None
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    json_path = report_dir / f"{report_prefix}-{stamp}.json"
    markdown_path = report_dir / f"{report_prefix}-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def fail(report: dict[str, Any], message: str) -> None:
    report["failures"].append(message)


def finalize(
    report: dict[str, Any],
    report_dir: Path | None,
    report_prefix: str = "desktop-packaged-open-smoke",
    pass_label: str = PASS_LABEL,
    fail_label: str = FAIL_LABEL,
    pass_conclusion: str = "打包桌面 App 可通过 macOS open/LaunchServices 路径启动，诊断接口可访问，退出后端口释放。",
    fail_conclusion: str = "open 启动烟测失败，不能证明用户双击/LaunchServices 路径可稳定启动桌面 App。",
) -> int:
    report["ended_at"] = now_iso()
    report["status"] = "pass" if not report["failures"] else "fail"
    report["conclusion"] = pass_conclusion if report["status"] == "pass" else fail_conclusion
    json_path, markdown_path = write_report(report, report_dir, report_prefix)
    print(pass_label if report["status"] == "pass" else fail_label)
    print(f"status={report['status']}")
    print(f"app_path={report['app_path']}")
    print(f"url={report['base_url']}")
    print(f"open_returncode={report.get('open_returncode')}")
    print(f"electron_pid={report.get('electron_pid')}")
    print(f"server_mode={report.get('server_mode')}")
    print(f"python_source={report.get('python_source')}")
    print(f"process_cleanup_verified={report.get('process_cleanup_verified')}")
    print(f"port_closed={report.get('port_closed')}")
    if json_path:
        print(f"report_json={json_path}")
    if markdown_path:
        print(f"report_markdown={markdown_path}")
    if report["failures"]:
        for item in report["failures"]:
            print(f"failure={item}", file=sys.stderr)
    return 0 if report["status"] == "pass" else 1


def run_open_smoke(
    app_path: Path,
    project_dir: Path,
    user_data_dir: Path,
    port: int,
    timeout_seconds: int,
    require_python_source: str,
    report_dir: Path | None,
    report_extra: dict[str, Any] | None = None,
    report_prefix: str = "desktop-packaged-open-smoke",
    report_title: str = "Echo Founder 打包桌面 App open 启动烟测报告",
    pass_label: str = PASS_LABEL,
    fail_label: str = FAIL_LABEL,
    pass_conclusion: str = "打包桌面 App 可通过 macOS open/LaunchServices 路径启动，诊断接口可访问，退出后端口释放。",
    fail_conclusion: str = "open 启动烟测失败，不能证明用户双击/LaunchServices 路径可稳定启动桌面 App。",
    default_first_launch: bool = True,
    isolated_home: Path | None = None,
) -> int:
    if not default_first_launch or isolated_home is None:
        raise ValueError("packaged open smoke only supports a clean default first launch in an isolated HOME")
    project_dir, user_data_dir = default_first_launch_paths(isolated_home, app_bundle_name(app_path))
    port = 0
    report: dict[str, Any] = {
        "status": "fail",
        "report_title": report_title,
        "app_path": str(app_path),
        "base_url": f"http://{HOST}:{port}" if port else "dynamic",
        "project_dir": str(project_dir),
        "user_data_dir": str(user_data_dir),
        "require_python_source": require_python_source,
        "started_at": now_iso(),
        "ended_at": "",
        "open_returncode": None,
        "electron_pid": None,
        "server_mode": "",
        "python_source": "",
        "runtime": {},
        "production_routes": "",
        "default_first_launch": default_first_launch,
        "isolated_home": str(isolated_home) if isolated_home else "",
        "launch_environment": {},
        "process_cleanup_verified": False,
        "port_closed": False,
        "failures": [],
        "conclusion": "",
    }
    if report_extra:
        report.update(report_extra)
    electron_pid = 0
    launch_attempted = False
    open_log = isolated_home / "launch" / f"echo-founder-packaged-open-{port or os.getpid()}.log"
    try:
        if os.name == "nt" or sys.platform != "darwin":
            fail(report, "open smoke requires macOS LaunchServices")
            raise SmokeAbort
        if not app_path.exists():
            fail(report, f"app bundle not found: {app_path}")
            raise SmokeAbort
        if project_dir.exists() or user_data_dir.exists():
            fail(report, "isolated HOME is not clean before first launch")
            raise SmokeAbort
        env_values = default_first_launch_environment(isolated_home)
        report["launch_environment"] = {
            "clear_parent_environment": True,
            "aifios_keys": sorted(key for key in env_values if key.startswith("AIFIOS_")),
            "user_data_isolation": "electron-standard-command-line",
            "external_toolchain_available": {
                tool: bool(shutil.which(tool, path=env_values["PATH"]))
                for tool in ("node", "npm", "python", "python3", "brew")
            },
        }
        launch_attempted = True
        result = launch_with_open(
            app_path,
            env_values,
            open_log,
            user_data_dir,
            clear_parent_environment=default_first_launch,
        )
        report["open_returncode"] = result.returncode
        if result.returncode != 0:
            fail(report, f"open command failed with {result.returncode}: {launch_log_tail(open_log)}")
            raise SmokeAbort

        electron_pid = wait_for_opened_app_pid(app_path, user_data_dir, min(timeout_seconds, 15))
        report["electron_pid"] = electron_pid or None
        if not electron_pid:
            fail(report, f"open returned success but no isolated Echo Founder process was found: {launch_log_tail(open_log)}")
            raise SmokeAbort

        port, detail = wait_for_dynamic_port(desktop_log_path(user_data_dir), timeout_seconds)
        if not port:
            fail(report, detail)
            report["open_log_tail"] = launch_log_tail(open_log)
            report["desktop_log_tail"] = tail(desktop_log_path(user_data_dir), 12000)
            raise SmokeAbort
        report["base_url"] = f"http://{HOST}:{port}"
        report["dynamic_port"] = port
        ready, detail = wait_until_ready(port, timeout_seconds)
        if not ready:
            fail(report, f"app did not become ready through open: {detail}; open_log={open_log}")
            report["open_log_tail"] = launch_log_tail(open_log)
            report["desktop_log_tail"] = tail(desktop_log_path(user_data_dir), 12000)
            raise SmokeAbort

        runtime = runtime_from_diagnostics(port)
        report["runtime"] = runtime
        runtime_parent_pid = parse_pid(runtime.get("desktopParentPid"))
        if runtime_parent_pid != electron_pid:
            fail(report, f"runtime desktopParentPid does not match the isolated opened process: expected={electron_pid} actual={runtime_parent_pid}")
        report["server_mode"] = str(runtime.get("serverMode") or "")
        report["python_source"] = str(runtime.get("pythonSource") or "")

        if runtime.get("isDesktop") is not True:
            fail(report, f"runtime is not desktop: {runtime}")
        if runtime.get("serverMode") != "production":
            fail(report, f"runtime serverMode is not production: {runtime}")
        if runtime.get("singleInstance") != "1":
            fail(report, f"singleInstance is not enabled: {runtime}")
        if runtime.get("desktopUserDataDir") != user_data_dir.name:
            fail(report, f"isolated userData mismatch: expected={user_data_dir.name} runtime={runtime}")
        if runtime.get("projectSource") != "default":
            fail(report, f"clean launch did not select the branded default project: {runtime}")
        if report["launch_environment"].get("aifios_keys"):
            fail(report, "clean launch environment unexpectedly contains AIFIOS_* keys")
        unavailable = report["launch_environment"].get("external_toolchain_available") or {}
        if any(unavailable.values()):
            fail(report, f"clean launch PATH exposes a developer toolchain: {unavailable}")
        if not project_dir.is_dir():
            fail(report, f"branded default project was not created: {project_dir}")
        if require_python_source and runtime.get("pythonSource") != require_python_source:
            fail(report, f"unexpected Python source: expected={require_python_source} actual={runtime.get('pythonSource')}")
        if not electron_pid or not process_exists(electron_pid):
            fail(report, f"desktopParentPid is not a live process: {runtime}")
        status = fetch_json(f"http://{HOST}:{port}/api/status", timeout=3.0)
        if not isinstance(status, dict) or not status.get("project"):
            fail(report, f"/api/status unavailable after open launch: {status}")
        elif status.get("project") != project_dir.name:
            fail(report, f"/api/status did not bind the branded default project: {status}")
        routes_ok, routes_detail = verify_required_production_routes(port)
        report["production_routes"] = routes_detail
        if not routes_ok:
            fail(report, f"packaged production routes failed after open launch: {routes_detail}")
    except SmokeAbort:
        pass
    except Exception as exc:
        fail(report, f"unexpected open smoke error: {exc}")
        report["open_log_tail"] = launch_log_tail(open_log)
        report["desktop_log_tail"] = tail(desktop_log_path(user_data_dir), 12000)
    finally:
        if launch_attempted:
            if not electron_pid:
                electron_pid = wait_for_opened_app_pid(app_path, user_data_dir, 3)
                if electron_pid:
                    report["electron_pid"] = electron_pid
            cleanup_verified, remaining_pids = cleanup_isolated_opened_apps(
                app_path,
                user_data_dir,
                electron_pid,
            )
            report["process_cleanup_verified"] = cleanup_verified
            if not cleanup_verified:
                fail(report, f"isolated opened process cleanup could not be verified; remaining_pids={remaining_pids}")
        else:
            report["process_cleanup_verified"] = True
        report["port_closed"] = wait_for_port_closed(port) if port else True
        if not report["port_closed"]:
            fail(report, f"port did not close after opened app stopped: {port}")
    return finalize(
        report,
        report_dir,
        report_prefix=report_prefix,
        pass_label=pass_label,
        fail_label=fail_label,
        pass_conclusion=pass_conclusion,
        fail_conclusion=fail_conclusion,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test packaged Echo Founder .app launch through macOS open")
    parser.add_argument("--app-path", default="dist/desktop/Echo Founder.app")
    parser.add_argument("--project-dir", default="/private/tmp/aifios-packaged-open-smoke")
    parser.add_argument("--user-data-dir", default="/private/tmp/aifios-packaged-open-user-data")
    parser.add_argument(
        "--default-first-launch",
        action="store_true",
        default=True,
        help="launch with an isolated HOME, a dynamic port, an empty PATH, and zero AIFIOS_* overrides",
    )
    parser.add_argument(
        "--isolated-home",
        default="",
        help="retain/use this clean HOME for --default-first-launch; otherwise a temporary HOME is removed after the smoke",
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--require-python-source", default="", help="fail unless diagnostics runtime.pythonSource matches this value")
    parser.add_argument("--report-dir", default="", help="write JSON/Markdown audit report into this directory")
    args = parser.parse_args()

    if args.port:
        parser.error("packaged open smoke chooses its own dynamic port; do not pass --port")

    def execute(isolated_home: Path | None = None) -> int:
        return run_open_smoke(
            Path(args.app_path).expanduser().resolve(),
            Path(args.project_dir).expanduser().resolve(),
            Path(args.user_data_dir).expanduser().resolve(),
            0,
            args.timeout,
            args.require_python_source,
            Path(args.report_dir).expanduser().resolve() if args.report_dir else None,
            default_first_launch=args.default_first_launch,
            isolated_home=isolated_home,
        )

    if args.isolated_home:
        isolated_home = Path(args.isolated_home).expanduser().resolve()
        isolated_home.mkdir(parents=True, exist_ok=True)
        return execute(isolated_home)
    with tempfile.TemporaryDirectory(prefix="echo-founder-default-first-launch-") as temporary_home:
        return execute(Path(temporary_home))


if __name__ == "__main__":
    raise SystemExit(main())
