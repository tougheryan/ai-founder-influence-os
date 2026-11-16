#!/usr/bin/env python3
"""Soak test a packaged Echo Founder macOS .app bundle."""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HOST = "127.0.0.1"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class Probe:
    path: str
    kind: str
    required_keys: tuple[str, ...] = ()


@dataclass
class ProbeSample:
    timestamp: str
    iteration: int
    path: str
    kind: str
    ok: bool
    status: int | None
    latency_ms: float
    response_bytes: int
    error: str | None = None


PROBES = [
    Probe("/api/status", "json", ("project", "latest")),
    Probe("/api/config", "json", ("config",)),
    Probe("/api/desktop/diagnostics", "json", ("status", "tools", "paths", "runtime")),
    Probe("/api/desktop/release-readiness", "json", ("status", "internalReady", "externalReady", "gates", "reports")),
    Probe("/api/delivery", "json"),
    Probe("/", "html"),
    Probe("/pipeline", "html"),
    Probe("/settings", "html"),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return int(sock.getsockname()[1])


def port_is_open(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=0.5):
            return True
    except OSError:
        return False


def packaged_app_env(project_dir: Path, port: int, minimal_env: bool, user_data_dir: Path | None = None) -> dict[str, str]:
    if minimal_env:
        env = {
            key: value
            for key in ["HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"]
            if (value := os.environ.get(key))
        }
        env["PATH"] = "/usr/bin:/bin"
        env["AIFIOS_DESKTOP_MINIMAL_ENV"] = "1"
    else:
        env = os.environ.copy()
    env["AIFIOS_DESKTOP_PORT"] = str(port)
    env["AIFIOS_DESKTOP_SERVER_MODE"] = "production"
    env["AIFIOS_PROJECT"] = str(project_dir)
    env["ELECTRON_ENABLE_LOGGING"] = "1"
    if user_data_dir:
        env["AIFIOS_DESKTOP_USER_DATA_DIR"] = str(user_data_dir)
    return env


def wait_for_port_closed(port: int, timeout_seconds: int = 20) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not port_is_open(port):
            return True
        time.sleep(0.5)
    return not port_is_open(port)


def app_binary(app_path: Path) -> Path:
    plist_path = app_path / "Contents" / "Info.plist"
    binary_name = app_path.stem
    if plist_path.exists():
        try:
            with plist_path.open("rb") as handle:
                binary_name = str(plistlib.load(handle).get("CFBundleExecutable") or binary_name)
        except Exception:
            pass
    return app_path / "Contents" / "MacOS" / binary_name


def fetch_json_payload(url: str, timeout_seconds: float) -> dict[str, Any]:
    try:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Echo-Founder packaged desktop soak",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                return {}
            return json.loads(response.read(MAX_RESPONSE_BYTES).decode("utf-8"))
    except Exception:
        return {}


def fetch_probe(base_url: str, probe: Probe, iteration: int, timeout_seconds: float) -> ProbeSample:
    url = f"{base_url}{probe.path}"
    started = time.monotonic()
    timestamp = now_iso()
    try:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Echo-Founder packaged desktop soak",
                "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
            },
        )
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read(MAX_RESPONSE_BYTES)
            latency_ms = (time.monotonic() - started) * 1000
            status = int(response.status)

        if status != 200:
            return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, len(body), f"http {status}")

        if probe.kind == "json":
            try:
                payload = json.loads(body.decode("utf-8"))
            except json.JSONDecodeError as exc:
                return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, len(body), f"invalid json: {exc}")
            missing = [key for key in probe.required_keys if key not in payload]
            if missing:
                return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, len(body), f"missing json key(s): {', '.join(missing)}")
            if probe.path == "/api/desktop/diagnostics":
                runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
                if runtime.get("isDesktop") is not True or runtime.get("serverMode") != "production":
                    return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, len(body), f"wrong runtime mode: {runtime}")
                missing_runtime = [key for key in ("pythonBinary", "nodeBinary", "singleInstance") if key not in runtime]
                if missing_runtime:
                    return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, len(body), f"missing runtime key(s): {', '.join(missing_runtime)}")
            if probe.path == "/api/desktop/release-readiness":
                allowed = {"external_ready", "internal_ready_external_blocked", "needs_attention", "missing_reports"}
                if payload.get("status") not in allowed:
                    return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, len(body), f"unexpected release readiness status: {payload.get('status')}")
                if not isinstance(payload.get("internalReady"), bool) or not isinstance(payload.get("externalReady"), bool):
                    return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, len(body), "release readiness booleans missing")
                if not isinstance(payload.get("gates"), list) or not isinstance(payload.get("reports"), dict):
                    return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, len(body), "release readiness structure missing")
        elif not body:
            return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, status, latency_ms, 0, "empty html response")

        return ProbeSample(timestamp, iteration, probe.path, probe.kind, True, status, latency_ms, len(body))
    except urllib.error.HTTPError as exc:
        body = exc.read(MAX_RESPONSE_BYTES)
        latency_ms = (time.monotonic() - started) * 1000
        return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, int(exc.code), latency_ms, len(body), f"http {exc.code}")
    except Exception as exc:
        latency_ms = (time.monotonic() - started) * 1000
        return ProbeSample(timestamp, iteration, probe.path, probe.kind, False, None, latency_ms, 0, str(exc))


def wait_until_ready(port: int, timeout_seconds: int, request_timeout: float) -> tuple[bool, str]:
    base_url = f"http://{HOST}:{port}"
    deadline = time.monotonic() + timeout_seconds
    diagnostics_probe = Probe("/api/desktop/diagnostics", "json", ("status", "runtime"))
    last_error = "not attempted"
    while time.monotonic() < deadline:
        sample = fetch_probe(base_url, diagnostics_probe, 0, request_timeout)
        if sample.ok:
            return True, base_url
        last_error = sample.error or "diagnostics endpoint not ready"
        time.sleep(1)
    return False, last_error


def terminate_process(proc: subprocess.Popen[object]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=15)


def tail(path: Path, limit: int = 6000) -> str:
    if not path.exists():
        return ""
    return path.read_bytes()[-limit:].decode("utf-8", errors="replace")


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((pct / 100) * (len(ordered) - 1))))
    return ordered[index]


def summarize_samples(samples: list[ProbeSample]) -> dict[str, dict[str, Any]]:
    summary: dict[str, dict[str, Any]] = {}
    for probe in PROBES:
        rows = [sample for sample in samples if sample.path == probe.path]
        latencies = [sample.latency_ms for sample in rows if sample.ok]
        failures = [sample for sample in rows if not sample.ok]
        summary[probe.path] = {
            "kind": probe.kind,
            "checks": len(rows),
            "ok": len(rows) - len(failures),
            "failures": len(failures),
            "avg_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else None,
            "p95_latency_ms": round(percentile(latencies, 95) or 0, 1) if latencies else None,
            "max_latency_ms": round(max(latencies), 1) if latencies else None,
            "last_error": failures[-1].error if failures else None,
        }
    return summary


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Echo Founder 打包桌面 App 长稳测试报告",
        "",
        f"- 状态：{report['status']}",
        f"- App：{report['app_path']}",
        f"- Server 模式：{report['server_mode']}",
        f"- 最小环境启动：{'yes' if report['minimal_env'] else 'no'}",
        f"- userData：{report.get('user_data_dir', '')}",
        f"- Python 来源：{report['startup_runtime'].get('pythonSource', '')}",
        f"- 开始时间：{report['started_at']}",
        f"- 结束时间：{report['ended_at']}",
        f"- 配置时长：{report['configured_duration_seconds']} 秒",
        f"- 实际时长：{report['actual_duration_seconds']} 秒",
        f"- 探测间隔：{report['interval_seconds']} 秒",
        f"- 探测轮次：{report['iterations']}",
        f"- 本地地址：{report['base_url']}",
        f"- 端口释放：{'pass' if report['port_closed'] else 'fail'}",
        "",
        "## 探测结果",
        "",
        "| 路径 | 类型 | 检查次数 | 失败次数 | 平均延迟 | P95 延迟 | 最大延迟 | 最近错误 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for path, row in report["probe_summary"].items():
        lines.append(
            "| {path} | {kind} | {checks} | {failures} | {avg} | {p95} | {max_latency} | {error} |".format(
                path=path,
                kind=row["kind"],
                checks=row["checks"],
                failures=row["failures"],
                avg="" if row["avg_latency_ms"] is None else f"{row['avg_latency_ms']}ms",
                p95="" if row["p95_latency_ms"] is None else f"{row['p95_latency_ms']}ms",
                max_latency="" if row["max_latency_ms"] is None else f"{row['max_latency_ms']}ms",
                error=row["last_error"] or "",
            )
        )
    if report["failures"]:
        lines.extend(["", "## 失败样本", ""])
        for item in report["failures"][-10:]:
            lines.append(f"- 第 {item['iteration']} 轮 `{item['path']}`：{item.get('error') or 'unknown'}")
    lines.extend(["", "## 结论", "", report["conclusion"]])
    return "\n".join(lines) + "\n"


def write_report(
    project_dir: Path,
    report_dir: Path | None,
    app_path: Path,
    port: int,
    log_path: Path,
    configured_duration_seconds: int,
    interval_seconds: int,
    started_at: str,
    started_monotonic: float,
    status: str,
    conclusion: str,
    port_closed: bool,
    samples: list[ProbeSample],
    failures: list[dict[str, Any]],
    minimal_env: bool,
    require_python_source: str,
    user_data_dir: Path | None,
    startup_runtime: dict[str, Any],
) -> tuple[Path, Path, dict[str, Any]]:
    ended_at = now_iso()
    actual_duration_seconds = round(time.monotonic() - started_monotonic, 1)
    resolved_report_dir = report_dir or (project_dir / "quality" / "system-audits")
    resolved_report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    json_path = resolved_report_dir / f"desktop-packaged-soak-{stamp}.json"
    markdown_path = resolved_report_dir / f"desktop-packaged-soak-{stamp}.md"
    report: dict[str, Any] = {
        "status": status,
        "app_path": str(app_path),
        "started_at": started_at,
        "ended_at": ended_at,
        "configured_duration_seconds": configured_duration_seconds,
        "actual_duration_seconds": actual_duration_seconds,
        "interval_seconds": interval_seconds,
        "base_url": f"http://{HOST}:{port}",
        "project_dir": str(project_dir),
        "report_dir": str(resolved_report_dir),
        "log_path": str(log_path),
        "port": port,
        "server_mode": "production",
        "minimal_env": minimal_env,
        "user_data_dir": str(user_data_dir) if user_data_dir else "",
        "require_python_source": require_python_source,
        "startup_runtime": startup_runtime,
        "port_closed": port_closed,
        "iterations": max([sample.iteration for sample in samples], default=0),
        "probe_summary": summarize_samples(samples),
        "failures": failures,
        "samples": [asdict(sample) for sample in samples],
        "conclusion": conclusion,
    }
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path, report


def run_soak(
    app_path: Path,
    project_dir: Path,
    report_dir: Path | None,
    port: int,
    duration_seconds: int,
    interval_seconds: int,
    startup_timeout_seconds: int,
    request_timeout_seconds: float,
    failure_threshold: int,
    minimal_env: bool,
    require_python_source: str,
    user_data_dir: Path | None = None,
) -> int:
    binary = app_binary(app_path)
    if not binary.exists():
        print(f"FAIL packaged desktop soak: app binary not found: {binary}", file=sys.stderr)
        return 1

    project_dir.mkdir(parents=True, exist_ok=True)
    if user_data_dir:
        if user_data_dir.exists():
            shutil.rmtree(user_data_dir)
        user_data_dir.mkdir(parents=True, exist_ok=True)
    log_path = Path("/tmp") / f"aifios-packaged-soak-{port}.log"
    env = packaged_app_env(project_dir, port, minimal_env, user_data_dir)

    started_at = now_iso()
    started_monotonic = time.monotonic()
    samples: list[ProbeSample] = []
    failures: list[dict[str, Any]] = []
    startup_runtime: dict[str, Any] = {}
    status = "pass"
    conclusion = "打包桌面 App 在配置时长内通过核心 API 与页面周期性探测，退出后端口已释放。"
    proc: subprocess.Popen[object] | None = None
    port_closed = False

    with log_path.open("w", encoding="utf-8") as log_file:
        proc = subprocess.Popen(
            [str(binary)],
            cwd=binary.parent,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
            preexec_fn=None if os.name == "nt" else os.setsid,
        )

        try:
            ready, detail = wait_until_ready(port, startup_timeout_seconds, request_timeout_seconds)
            if not ready:
                status = "fail"
                conclusion = f"打包桌面 App 未在启动窗口内提供桌面诊断：{detail}"
                failures.append({"iteration": 0, "path": "/api/desktop/diagnostics", "error": detail})
            else:
                base_url = f"http://{HOST}:{port}"
                diagnostics_probe = Probe("/api/desktop/diagnostics", "json", ("status", "runtime"))
                diagnostics_sample = fetch_probe(base_url, diagnostics_probe, 0, request_timeout_seconds)
                samples.append(diagnostics_sample)
                diagnostics_payload = fetch_json_payload(f"{base_url}/api/desktop/diagnostics", request_timeout_seconds)
                startup_runtime = diagnostics_payload.get("runtime") if isinstance(diagnostics_payload.get("runtime"), dict) else {}
                if user_data_dir and startup_runtime.get("desktopUserDataDir") != user_data_dir.name:
                    status = "fail"
                    conclusion = "打包桌面 App 未使用隔离 userData 目录。"
                    failures.append(
                        {
                            "iteration": 0,
                            "path": "/api/desktop/diagnostics",
                            "error": conclusion,
                            "expected_basename": user_data_dir.name,
                            "runtime": startup_runtime,
                        }
                    )
                if status == "pass" and startup_runtime.get("singleInstance") != "1":
                    status = "fail"
                    conclusion = "打包桌面 App 未启用单实例保护。"
                    failures.append({"iteration": 0, "path": "/api/desktop/diagnostics", "error": conclusion, "runtime": startup_runtime})
                if require_python_source and startup_runtime.get("pythonSource") != require_python_source:
                    status = "fail"
                    conclusion = "打包桌面 App 选择了非预期 Python 来源。"
                    failures.append(
                        {
                            "iteration": 0,
                            "path": "/api/desktop/diagnostics",
                            "error": conclusion,
                            "expected": require_python_source,
                            "actual": startup_runtime.get("pythonSource"),
                            "runtime": startup_runtime,
                        }
                    )
                if status == "pass":
                    deadline = time.monotonic() + duration_seconds
                else:
                    deadline = time.monotonic()
                consecutive_failures = {probe.path: 0 for probe in PROBES}
                iteration = 0
                while time.monotonic() < deadline:
                    iteration += 1
                    loop_started = time.monotonic()
                    if proc.poll() is not None:
                        status = "fail"
                        conclusion = f"打包桌面 App 进程提前退出，返回码：{proc.returncode}"
                        failures.append({"iteration": iteration, "path": "process", "error": conclusion})
                        break

                    for probe in PROBES:
                        sample = fetch_probe(base_url, probe, iteration, request_timeout_seconds)
                        samples.append(sample)
                        if sample.ok:
                            consecutive_failures[probe.path] = 0
                            continue
                        consecutive_failures[probe.path] += 1
                        failures.append(asdict(sample))
                        if consecutive_failures[probe.path] >= failure_threshold:
                            status = "fail"
                            conclusion = (
                                f"{probe.path} 连续 {consecutive_failures[probe.path]} 次探测失败，"
                                f"最近错误：{sample.error or 'unknown'}"
                            )
                            break
                    if status != "pass":
                        break

                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    sleep_for = min(interval_seconds, max(0.0, interval_seconds - (time.monotonic() - loop_started)), remaining)
                    time.sleep(sleep_for)
        finally:
            if proc is not None:
                terminate_process(proc)
            port_closed = wait_for_port_closed(port)

    if not port_closed and status == "pass":
        status = "fail"
        conclusion = f"打包桌面 App 结束后端口未释放：{port}"
        failures.append({"iteration": max([sample.iteration for sample in samples], default=0), "path": "port", "error": conclusion})

    json_path, markdown_path, _report = write_report(
        project_dir=project_dir,
        report_dir=report_dir,
        app_path=app_path,
        port=port,
        log_path=log_path,
        configured_duration_seconds=duration_seconds,
        interval_seconds=interval_seconds,
        started_at=started_at,
        started_monotonic=started_monotonic,
        status=status,
        conclusion=conclusion,
        port_closed=port_closed,
        samples=samples,
        failures=failures,
        minimal_env=minimal_env,
        require_python_source=require_python_source,
        user_data_dir=user_data_dir,
        startup_runtime=startup_runtime,
    )

    if status == "pass":
        print("PASS packaged desktop soak")
        print(f"app_path={app_path}")
        print(f"url=http://{HOST}:{port}")
        print(f"project={project_dir}")
        print(f"duration_seconds={duration_seconds}")
        print(f"iterations={max([sample.iteration for sample in samples], default=0)}")
        print(f"minimal_env={minimal_env}")
        print(f"user_data_dir={user_data_dir or ''}")
        print(f"python_source={startup_runtime.get('pythonSource', '')}")
        print(f"report_json={json_path}")
        print(f"report_markdown={markdown_path}")
        return 0

    print("FAIL packaged desktop soak", file=sys.stderr)
    print(conclusion, file=sys.stderr)
    print(f"log={log_path}", file=sys.stderr)
    print(f"report_json={json_path}", file=sys.stderr)
    print(f"report_markdown={markdown_path}", file=sys.stderr)
    print(tail(log_path), file=sys.stderr)
    return 1


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description="Soak test a packaged Echo Founder macOS .app bundle")
    parser.add_argument("--app-path", default="dist/desktop/Echo Founder.app")
    parser.add_argument("--project-dir", default="/private/tmp/aifios-packaged-soak")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--duration-seconds", type=positive_int, default=1800)
    parser.add_argument("--interval-seconds", type=positive_int, default=30)
    parser.add_argument("--startup-timeout", type=positive_int, default=120)
    parser.add_argument("--request-timeout", type=float, default=30.0)
    parser.add_argument("--failure-threshold", type=positive_int, default=3)
    parser.add_argument("--minimal-env", action="store_true", help="launch the app with a Finder-like minimal PATH")
    parser.add_argument("--require-python-source", default="", help="fail unless diagnostics runtime.pythonSource matches this value")
    parser.add_argument("--user-data-dir", default="", help="launch with an isolated Electron userData directory")
    parser.add_argument("--report-dir", default="", help="write soak reports to this directory instead of project/quality/system-audits")
    args = parser.parse_args()

    app_path = Path(args.app_path).expanduser().resolve()
    port = args.port or find_free_port()
    if port_is_open(port):
        print(f"FAIL packaged desktop soak: port is already in use: {port}", file=sys.stderr)
        return 1

    return run_soak(
        app_path=app_path,
        project_dir=Path(args.project_dir).expanduser(),
        report_dir=Path(args.report_dir).expanduser().resolve() if args.report_dir else None,
        port=port,
        duration_seconds=args.duration_seconds,
        interval_seconds=args.interval_seconds,
        startup_timeout_seconds=args.startup_timeout,
        request_timeout_seconds=args.request_timeout,
        failure_threshold=args.failure_threshold,
        minimal_env=args.minimal_env,
        require_python_source=args.require_python_source,
        user_data_dir=Path(args.user_data_dir).expanduser().resolve() if args.user_data_dir else Path(f"/private/tmp/aifios-packaged-soak-user-data-{port}"),
    )


if __name__ == "__main__":
    raise SystemExit(main())
