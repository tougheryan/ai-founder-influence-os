#!/usr/bin/env python3
"""Install-smoke an Echo Founder DMG by copying and launching the app."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from desktop_dmg import detach_mount, mount_dmg, require_macos_tools, sha256_file
from desktop_packaged_smoke import find_free_port, port_is_open, run_smoke, wait_for_port_closed


DEFAULT_DMG_PATH = Path(__file__).resolve().parents[1] / "dist" / "Echo-Founder-0.2.0-beta.2-mac-arm64.dmg"
DEFAULT_INSTALL_DIR = Path("/private/tmp/aifios-dmg-smoke-install")
DEFAULT_PROJECT_DIR = Path("/private/tmp/aifios-dmg-smoke")
DEFAULT_USER_DATA_DIR = Path("/private/tmp/aifios-dmg-user-data")


def run_required(command: list[str], timeout: int = 300) -> subprocess.CompletedProcess[str]:
    print(f"RUN {' '.join(command)}", flush=True)
    return subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=True)


def copy_app_from_dmg(mount_point: Path, app_name: str, install_dir: Path) -> Path:
    source_app = mount_point / f"{app_name}.app"
    if not source_app.exists():
        raise RuntimeError(f"Mounted DMG does not contain {app_name}.app: {source_app}")
    install_dir.mkdir(parents=True, exist_ok=True)
    target_app = install_dir / source_app.name
    if target_app.exists():
        shutil.rmtree(target_app)
    run_required(["ditto", str(source_app), str(target_app)], timeout=600)
    binary = target_app / "Contents" / "MacOS" / app_name
    if not binary.exists():
        raise RuntimeError(f"Copied app is missing executable: {binary}")
    return target_app


def dmg_install_smoke(
    dmg_path: Path,
    app_name: str,
    install_dir: Path,
    project_dir: Path,
    port: int,
    timeout_seconds: int,
    minimal_env: bool,
    require_python_source: str,
    user_data_dir: Path,
    demo_unlock_code: str,
) -> int:
    require_macos_tools()
    if not shutil.which("ditto"):
        raise RuntimeError("Required macOS tool is missing: ditto")
    if not dmg_path.exists():
        raise RuntimeError(f"DMG not found: {dmg_path}")

    mount_point = mount_dmg(dmg_path)
    try:
        installed_app = copy_app_from_dmg(mount_point, app_name, install_dir)
    finally:
        detach_mount(mount_point)

    code = run_smoke(
        app_path=installed_app,
        project_dir=project_dir,
        port=port,
        timeout_seconds=timeout_seconds,
        minimal_env=minimal_env,
        require_python_source=require_python_source,
        user_data_dir=user_data_dir,
        demo_unlock_code=demo_unlock_code,
    )
    if code != 0:
        return code
    if not wait_for_port_closed(port):
        print(f"FAIL desktop dmg smoke: port did not close after installed app stopped: {port}", file=sys.stderr)
        return 1

    print("PASS desktop dmg smoke")
    print(f"dmg_path={dmg_path}")
    print(f"dmg_sha256={sha256_file(dmg_path)}")
    print(f"installed_app={installed_app}")
    print(f"project={project_dir}")
    print(f"user_data_dir={user_data_dir}")
    print(f"minimal_env={minimal_env}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Mount an Echo Founder DMG and smoke test the installed copy")
    parser.add_argument("--dmg-path", default=str(DEFAULT_DMG_PATH))
    parser.add_argument("--app-name", default="Echo Founder")
    parser.add_argument("--install-dir", default=str(DEFAULT_INSTALL_DIR))
    parser.add_argument("--project-dir", default=str(DEFAULT_PROJECT_DIR))
    parser.add_argument("--user-data-dir", default=str(DEFAULT_USER_DATA_DIR))
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--minimal-env", action="store_true", help="launch the copied app with a Finder-like minimal PATH")
    parser.add_argument("--require-python-source", default="", help="fail unless diagnostics runtime.pythonSource matches this value")
    parser.add_argument(
        "--demo-unlock-code",
        default=os.environ.get("AIFIOS_DEMO_UNLOCK_CODE", ""),
        help="verify and unlock a local product-password build; may also use AIFIOS_DEMO_UNLOCK_CODE",
    )
    args = parser.parse_args()

    port = args.port or find_free_port()
    if port_is_open(port):
        print(f"FAIL desktop dmg smoke: port is already in use: {port}", file=sys.stderr)
        return 1

    try:
        return dmg_install_smoke(
            dmg_path=Path(args.dmg_path).expanduser().resolve(),
            app_name=args.app_name,
            install_dir=Path(args.install_dir).expanduser().resolve(),
            project_dir=Path(args.project_dir).expanduser().resolve(),
            port=port,
            timeout_seconds=args.timeout,
            minimal_env=args.minimal_env,
            require_python_source=args.require_python_source,
            user_data_dir=Path(args.user_data_dir).expanduser().resolve(),
            demo_unlock_code=args.demo_unlock_code,
        )
    except subprocess.CalledProcessError as exc:
        print(f"FAIL desktop dmg smoke command exited with {exc.returncode}: {' '.join(exc.cmd)}", file=sys.stderr)
        print(exc.stdout or "", file=sys.stderr)
        return int(exc.returncode or 1)
    except Exception as exc:
        print(f"FAIL desktop dmg smoke: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
