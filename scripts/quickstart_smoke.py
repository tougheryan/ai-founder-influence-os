#!/usr/bin/env python3
"""Run the QUICKSTART-10MIN.md path against a clean release extraction."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

from smoke_release import safe_extract


REPO_ROOT = Path(__file__).resolve().parents[1]
PLATFORM_RUNS = {
    "wechat": ("wechat-demo", "公众号"),
    "xhs": ("xhs-demo", "小红书"),
    "shipinhao": ("shipinhao-demo", "视频号"),
}


def run(
    command: list[str],
    cwd: Path,
    *,
    timeout: int | None = None,
    env: dict[str, str] | None = None,
) -> None:
    print(f"+ {' '.join(command)}")
    subprocess.run(command, cwd=cwd, env=env, timeout=timeout, check=True)


def run_capture(
    command: list[str],
    cwd: Path,
    *,
    timeout: int | None = None,
    env: dict[str, str] | None = None,
) -> str:
    print(f"+ {' '.join(command)}")
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        timeout=timeout,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, command, output=result.stdout)
    return result.stdout


def build_or_resolve_archive(work_dir: Path, archive_arg: str | None) -> Path:
    if archive_arg:
        return Path(archive_arg).expanduser().resolve(strict=True)
    dist_dir = work_dir / "dist"
    run(["make", "package", f"DIST_DIR={dist_dir}"], REPO_ROOT, timeout=120)
    archives = sorted(dist_dir.glob("aifios-*.tar.gz"))
    if not archives:
        raise FileNotFoundError(f"no package created in {dist_dir}")
    return archives[-1]


def extract_archive(archive: Path, work_dir: Path) -> Path:
    with tarfile.open(archive, "r:gz") as tar:
        safe_extract(tar, work_dir)
    roots = [path for path in work_dir.iterdir() if path.is_dir() and path.name.startswith("aifios-")]
    if not roots:
        raise FileNotFoundError(f"no extracted aifios-* directory in {work_dir}")
    return roots[0]


def assert_status(output: str, run_id: str, platform: str) -> None:
    # status prints a human-readable view followed by the real runtime JSON.
    payload = json.loads(output[output.index("\n{") + 1:])
    source = payload.get("author_source") or {}
    if (payload.get("active_slug") != run_id or payload.get("target_platforms") != [platform]
            or source.get("verified") is not True or source.get("run_id") != run_id
            or source.get("research_mode") != "author_material" or payload.get("warnings")):
        raise AssertionError(f"demo runtime source/scope failed: {payload}")


def assert_delivery(output: str, run_id: str) -> None:
    from native_demo import verify_internal_delivery
    verify_internal_delivery(json.loads(output), run_id)


def run_native_demo_checks(root: Path, platform_demos: Path, env=None) -> None:
    for platform, (run_id, _label) in PLATFORM_RUNS.items():
        project = platform_demos / platform
        # Validate source hashes, approvals, current schema, exact platform
        # outputs, immutable visual selection and the internal-only boundary.
        run(["python3", "scripts/demo.py", "--project", str(project),
             "--platform", platform, "--verify"], root, env=env, timeout=30)
        status = run_capture(
            ["python3", "scripts/aifios.py", "--project", str(project), "status", "--slug", run_id],
            root, env=env, timeout=30,
        )
        assert_status(status, run_id, platform)
        delivery = run_capture(
            ["python3", "scripts/aifios.py", "--project", str(project), "delivery", "--run-id", run_id],
            root, env=env, timeout=30,
        )
        assert_delivery(delivery, run_id)


def run_quickstart(root: Path, work_dir: Path) -> None:
    env = os.environ.copy()
    env.setdefault("NEXT_TELEMETRY_DISABLED", "1")
    install_dir = work_dir / "installed-skills"
    platform_demos = work_dir / "platform-demos"
    run(["make", "doctor"], root, env=env, timeout=120)
    run(["npm", "ci"], root / "skills" / "xhs-card", env=env, timeout=300)
    run(["make", "test"], root, env=env, timeout=300)
    run(["make", "install", f"INSTALL_DIR={install_dir}", "FORCE=1"], root, env=env, timeout=60)
    run(
        [
            "make",
            "verify",
            f"INSTALL_DIR={install_dir}",
            "SKIP_DEMO=1",
            "SKIP_BROWSER_FIXTURE=1",
            "SKIP_UI=1",
        ],
        root,
        env=env,
        timeout=120,
    )
    run(["make", "demo", "PLATFORM=all", f"DEMO_PROJECT={platform_demos}"], root, env=env, timeout=120)

    run_native_demo_checks(root, platform_demos, env)

    ui_help = run_capture(["python3", "scripts/aifios.py", "ui", "--help"], root, env=env, timeout=20)
    for token in ["--install-deps", "--port", "start Next.js UI"]:
        if token not in ui_help:
            raise AssertionError(f"ui help missing {token!r}")

    run(["make", "browser-hit-fixture-check"], root, env=env, timeout=60)


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test the documented AIFIOS quickstart")
    parser.add_argument("--archive", default=None, help="release tar.gz path; builds one when omitted")
    parser.add_argument("--work-dir", default="/private/tmp/aifios-quickstart-smoke")
    args = parser.parse_args()

    work_dir = Path(args.work_dir).expanduser().resolve(strict=False)
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    archive = build_or_resolve_archive(work_dir, args.archive)
    root = extract_archive(archive, work_dir)
    run_quickstart(root, work_dir)
    print(f"PASS quickstart smoke: {archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
