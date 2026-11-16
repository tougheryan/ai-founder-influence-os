#!/usr/bin/env python3
"""Smoke test the AIFIOS Electron desktop shell.

This checks the source-run desktop contract: Electron starts, launches the local
Next.js workbench on an isolated port, serves /api/status, and releases the port
after the desktop process is stopped.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return int(sock.getsockname()[1])


def url_json(url: str, timeout: float = 1.0) -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if not (200 <= response.status < 500):
                return None
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def port_is_open(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=0.5):
            return True
    except OSError:
        return False


def has_runtime_dependency_fields(runtime: object) -> bool:
    if not isinstance(runtime, dict):
        return False
    return all(key in runtime for key in ("pythonBinary", "nodeBinary"))


def wait_until_ready(port: int, timeout_seconds: int) -> tuple[bool, str]:
    status_url = f"http://{HOST}:{port}/api/status"
    diagnostics_url = f"http://{HOST}:{port}/api/desktop/diagnostics"
    deadline = time.time() + timeout_seconds
    last_error = "not attempted"
    while time.time() < deadline:
        status = url_json(status_url)
        diagnostics = url_json(diagnostics_url)
        runtime = diagnostics.get("runtime") if isinstance(diagnostics, dict) else {}
        if (
            status
            and "latest" in status
            and "project" in status
            and isinstance(runtime, dict)
            and runtime.get("isDesktop") is True
            and has_runtime_dependency_fields(runtime)
        ):
            return True, diagnostics_url
        last_error = f"status or diagnostics endpoint not ready: {runtime}"
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


def tail(path: Path, limit: int = 5000) -> str:
    if not path.exists():
        return ""
    data = path.read_bytes()
    return data[-limit:].decode("utf-8", errors="replace")


def run_smoke(project_dir: Path, port: int, timeout_seconds: int) -> int:
    project_dir.mkdir(parents=True, exist_ok=True)
    log_path = Path(tempfile.gettempdir()) / f"aifios-desktop-smoke-{port}.log"
    env = os.environ.copy()
    env["AIFIOS_DESKTOP_SERVER_MODE"] = os.environ.get("AIFIOS_DESKTOP_SERVER_MODE", "production")
    env["AIFIOS_DESKTOP_PORT"] = str(port)
    env["ELECTRON_ENABLE_LOGGING"] = "1"

    with log_path.open("w", encoding="utf-8") as log_file:
        proc = subprocess.Popen(
            ["make", "desktop", f"PROJECT={project_dir}"],
            cwd=REPO_ROOT,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
            preexec_fn=None if os.name == "nt" else os.setsid,
        )

        ready = False
        detail = ""
        try:
            ready, detail = wait_until_ready(port, timeout_seconds)
            if not ready:
                print("FAIL desktop smoke: Electron did not serve AIFIOS UI", file=sys.stderr)
                print(f"detail: {detail}", file=sys.stderr)
                print(f"log: {log_path}", file=sys.stderr)
                print(tail(log_path), file=sys.stderr)
                return 1
            return 0
        finally:
            terminate_process(proc)

    # Unreachable, but keeps type checkers happy.
    return 1


def wait_for_port_closed(port: int, timeout_seconds: int = 20) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if not port_is_open(port):
            return True
        time.sleep(0.5)
    return not port_is_open(port)


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test the AIFIOS Electron desktop shell")
    parser.add_argument("--project-dir", default="/private/tmp/aifios-desktop-smoke")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()

    port = args.port or find_free_port()
    if port_is_open(port):
        print(f"FAIL desktop smoke: port is already in use: {port}", file=sys.stderr)
        return 1

    code = run_smoke(Path(args.project_dir).expanduser(), port, args.timeout)
    if code != 0:
        return code
    if not wait_for_port_closed(port):
        print(f"FAIL desktop smoke: port did not close after Electron stopped: {port}", file=sys.stderr)
        return 1

    print("PASS desktop smoke")
    print(f"url=http://{HOST}:{port}")
    print(f"project={Path(args.project_dir).expanduser()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
