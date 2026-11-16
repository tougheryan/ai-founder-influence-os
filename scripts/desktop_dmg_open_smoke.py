#!/usr/bin/env python3
"""Install-smoke an Echo Founder DMG through macOS LaunchServices."""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from desktop_dmg import detach_mount, mount_dmg, require_macos_tools, sha256_file
from desktop_dmg_smoke import copy_app_from_dmg
from desktop_packaged_open_smoke import run_open_smoke


PASS_LABEL = "PASS desktop dmg open smoke"
FAIL_LABEL = "FAIL desktop dmg open smoke"
DEFAULT_DMG_PATH = Path(__file__).resolve().parents[1] / "dist" / "Echo-Founder-0.2.0-beta.2-mac-arm64.dmg"
DEFAULT_INSTALL_DIR = Path("/private/tmp/aifios-dmg-open-install")
DEFAULT_PROJECT_DIR = Path("/private/tmp/aifios-dmg-open-smoke")
DEFAULT_USER_DATA_DIR = Path("/private/tmp/aifios-dmg-open-user-data")
DEFAULT_REPORT_DIR = Path(__file__).resolve().parents[1] / "quality" / "system-audits"


def dmg_open_smoke(
    dmg_path: Path,
    app_name: str,
    install_dir: Path,
    project_dir: Path,
    user_data_dir: Path,
    port: int,
    timeout_seconds: int,
    require_python_source: str,
    report_dir: Path | None,
    default_first_launch: bool = True,
    isolated_home: Path | None = None,
) -> int:
    require_macos_tools()
    if not shutil.which("ditto"):
        raise RuntimeError("Required macOS tool is missing: ditto")
    if not dmg_path.exists():
        raise RuntimeError(f"DMG not found: {dmg_path}")

    dmg_sha256 = sha256_file(dmg_path)
    mount_point = mount_dmg(dmg_path)
    try:
        installed_app = copy_app_from_dmg(mount_point, app_name, install_dir)
    finally:
        detach_mount(mount_point)

    return run_open_smoke(
        app_path=installed_app,
        project_dir=project_dir,
        user_data_dir=user_data_dir,
        port=port,
        timeout_seconds=timeout_seconds,
        require_python_source=require_python_source,
        report_dir=report_dir,
        report_extra={
            "dmg_path": str(dmg_path),
            "dmg_sha256": dmg_sha256,
            "installed_app": str(installed_app),
        },
        report_prefix="desktop-dmg-open-smoke",
        report_title="Echo Founder DMG 安装后 open 启动烟测报告",
        pass_label=PASS_LABEL,
        fail_label=FAIL_LABEL,
        pass_conclusion="DMG 内 App 复制安装后可通过 macOS open/LaunchServices 路径启动，诊断接口可访问，内置 runtime 生效，退出后端口释放。",
        fail_conclusion="DMG 安装后 open 启动烟测失败，不能证明用户从 DMG 安装后双击打开路径可稳定运行。",
        default_first_launch=default_first_launch,
        isolated_home=isolated_home,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Mount an Echo Founder DMG and launch the installed copy through macOS open")
    parser.add_argument("--dmg-path", default=str(DEFAULT_DMG_PATH))
    parser.add_argument("--app-name", default="Echo Founder")
    parser.add_argument("--install-dir", default=str(DEFAULT_INSTALL_DIR))
    parser.add_argument("--project-dir", default=str(DEFAULT_PROJECT_DIR))
    parser.add_argument("--user-data-dir", default=str(DEFAULT_USER_DATA_DIR))
    parser.add_argument(
        "--default-first-launch",
        action="store_true",
        default=True,
        help="launch the installed app with an isolated HOME, dynamic port, empty PATH, and zero AIFIOS_* overrides",
    )
    parser.add_argument("--isolated-home", default="")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--require-python-source", default="", help="fail unless diagnostics runtime.pythonSource matches this value")
    parser.add_argument("--report-dir", default=str(DEFAULT_REPORT_DIR), help="write JSON/Markdown audit report into this directory")
    args = parser.parse_args()

    if args.port:
        parser.error("desktop DMG open smoke chooses its own dynamic port; do not pass --port")
    port = 0

    def execute(isolated_home: Path | None = None) -> int:
        return dmg_open_smoke(
            dmg_path=Path(args.dmg_path).expanduser().resolve(),
            app_name=args.app_name,
            install_dir=Path(args.install_dir).expanduser().resolve(),
            project_dir=Path(args.project_dir).expanduser().resolve(),
            user_data_dir=Path(args.user_data_dir).expanduser().resolve(),
            port=port,
            timeout_seconds=args.timeout,
            require_python_source=args.require_python_source,
            report_dir=Path(args.report_dir).expanduser().resolve() if args.report_dir else None,
            default_first_launch=args.default_first_launch,
            isolated_home=isolated_home,
        )

    try:
        if args.isolated_home:
            isolated_home = Path(args.isolated_home).expanduser().resolve()
            isolated_home.mkdir(parents=True, exist_ok=True)
            return execute(isolated_home)
        with tempfile.TemporaryDirectory(prefix="echo-founder-dmg-default-first-launch-") as temporary_home:
            return execute(Path(temporary_home))
    except subprocess.CalledProcessError as exc:
        print(f"FAIL desktop dmg open smoke command exited with {exc.returncode}: {' '.join(exc.cmd)}", file=sys.stderr)
        print(exc.stdout or "", file=sys.stderr)
        return int(exc.returncode or 1)
    except Exception as exc:
        print(f"FAIL desktop dmg open smoke: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
