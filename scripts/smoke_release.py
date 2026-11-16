#!/usr/bin/env python3
"""Smoke test an AIFIOS release package from a clean extraction directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_ARCHIVE_OWNER = "aifios"
EXPECTED_ARCHIVE_MTIME = 0
SMOKE_PROVIDER_TOKEN = "aifios-release-smoke-provider-token"
SECRET_FIXTURES = {
    "ui/.env.local": "OPENAI_API_KEY=sk-proj-release-smoke-secret\n",
    "ui/.npmrc": "//registry.npmjs.org/:_authToken=npm_release_smoke_secret\n",
    "config/llm-config.json": '{"apiKey":"sk-proj-release-smoke-secret"}\n',
    "docs/debug.log": "local debug output should not ship\n",
    "scripts/local.tmp": "temporary scratch file should not ship\n",
    "skills/content-runtime/scripts/local-session.trace": "browser trace should not ship\n",
    "skills/content-runtime/scripts/local-debug.zip": "local archive should not ship\n",
    "skills/content-runtime/.pytest_cache/README": "pytest cache should not ship\n",
    "ui/test-results/report.json": '{"local":"test result should not ship"}\n',
    "ui/playwright-report/index.html": "<html>local report should not ship</html>\n",
}
SECRET_FILE_NAMES = {
    ".env",
    ".envrc",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    ".npmrc",
    ".yarnrc",
    "llm-config.json",
}
SECRET_FILE_SUFFIXES = (
    ".pem",
    ".key",
    ".p12",
    ".pfx",
)
SECRET_NAME_PATTERNS = (
    "service-account",
    "credentials",
    "secret",
    "token",
)
LOCAL_ARTIFACT_DIR_NAMES = {
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".cache",
    ".next",
    ".turbo",
    ".vercel",
    ".git",
    "__pycache__",
    "node_modules",
    "playwright-report",
    "test-results",
    "traces",
    "screenshots",
    "browser-profile",
    "browser-profiles",
    "dist",
}
LOCAL_ARTIFACT_FILE_NAMES = {
    ".coverage",
    "coverage.xml",
    "npm-debug.log",
    "pnpm-debug.log",
    "yarn-debug.log",
    "yarn-error.log",
    "tsconfig.tsbuildinfo",
}
LOCAL_ARTIFACT_FILE_SUFFIXES = (
    ".log",
    ".tmp",
    ".temp",
    ".bak",
    ".orig",
    ".rej",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".db-shm",
    ".db-wal",
    ".trace",
    ".har",
    ".zip",
    ".tar",
    ".tar.gz",
    ".tgz",
    ".7z",
    ".rar",
    ".mp4",
    ".mov",
    ".webm",
    ".m4a",
    ".wav",
    ".aac",
    ".mp3",
)


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None, timeout: int | None = None) -> None:
    print(f"+ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, env=env, timeout=timeout, check=True)


def run_capture(cmd: list[str], cwd: Path, env: dict[str, str] | None = None, timeout: int | None = None) -> str:
    print(f"+ {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
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
        raise subprocess.CalledProcessError(result.returncode, cmd, output=result.stdout)
    return result.stdout


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_archive_sha256_sidecar(archive: Path, *, require: bool) -> None:
    sidecar = Path(f"{archive}.sha256")
    if not sidecar.exists():
        if require:
            raise FileNotFoundError(f"release package is missing SHA256 sidecar: {sidecar}")
        return
    parts = sidecar.read_text(encoding="utf-8").strip().split()
    if not parts:
        raise RuntimeError(f"release package SHA256 sidecar is empty: {sidecar}")
    expected_sha256 = parts[0]
    if len(expected_sha256) != 64:
        raise RuntimeError(f"release package SHA256 sidecar has invalid digest: {sidecar}")
    if len(parts) >= 2 and parts[1] != archive.name:
        raise RuntimeError(f"release package SHA256 sidecar filename mismatch: {parts[1]} != {archive.name}")
    actual_sha256 = sha256_file(archive)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(f"release package SHA256 sidecar mismatch: {sidecar}")


def archive_file_index(archive: Path) -> dict[str, dict[str, object]]:
    entries: dict[str, dict[str, object]] = {}
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            if member.name in entries:
                raise RuntimeError(f"release archive contains duplicate file entry: {member.name}")
            fh = tar.extractfile(member)
            if fh is None:
                raise RuntimeError(f"unable to read archive file entry: {member.name}")
            digest = hashlib.sha256()
            size = 0
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
            if size != member.size:
                raise RuntimeError(f"archive file size mismatch while reading {member.name}: {size} != {member.size}")
            entries[member.name] = {
                "size": member.size,
                "sha256": digest.hexdigest(),
            }
    return entries


def assert_archive_manifest_sidecar(archive: Path, *, require: bool) -> None:
    sidecar = Path(f"{archive}.manifest.json")
    if not sidecar.exists():
        if require:
            raise FileNotFoundError(f"release package is missing manifest sidecar: {sidecar}")
        return
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"release package manifest sidecar is not an object: {sidecar}")
    if payload.get("schema_version") != 1:
        raise RuntimeError(f"release package manifest sidecar has unsupported schema_version: {sidecar}")
    if payload.get("archive") != archive.name:
        raise RuntimeError(f"release package manifest sidecar filename mismatch: {payload.get('archive')} != {archive.name}")
    actual_archive_sha256 = sha256_file(archive)
    if payload.get("archive_sha256") != actual_archive_sha256:
        raise RuntimeError(f"release package manifest sidecar archive SHA256 mismatch: {sidecar}")
    rows = payload.get("entries")
    if not isinstance(rows, list) or not rows:
        raise RuntimeError(f"release package manifest sidecar has no entries: {sidecar}")

    manifest_entries: dict[str, dict[str, object]] = {}
    total_size = 0
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError(f"release package manifest sidecar has a non-object entry: {sidecar}")
        path = str(row.get("path") or "")
        if not path or path.startswith("/") or ".." in Path(path).parts:
            raise RuntimeError(f"release package manifest sidecar has unsafe path: {path}")
        if path in manifest_entries:
            raise RuntimeError(f"release package manifest sidecar has duplicate path: {path}")
        size = row.get("size")
        digest = row.get("sha256")
        if not isinstance(size, int) or size < 0:
            raise RuntimeError(f"release package manifest sidecar has invalid size for {path}: {size}")
        if not isinstance(digest, str) or len(digest) != 64:
            raise RuntimeError(f"release package manifest sidecar has invalid sha256 for {path}: {digest}")
        total_size += size
        manifest_entries[path] = {"size": size, "sha256": digest}

    if payload.get("entry_count") != len(manifest_entries):
        raise RuntimeError(f"release package manifest sidecar entry_count mismatch: {sidecar}")
    if payload.get("total_uncompressed_bytes") != total_size:
        raise RuntimeError(f"release package manifest sidecar total size mismatch: {sidecar}")

    archive_entries = archive_file_index(archive)
    if set(manifest_entries) != set(archive_entries):
        missing = sorted(set(archive_entries) - set(manifest_entries))[:10]
        extra = sorted(set(manifest_entries) - set(archive_entries))[:10]
        raise RuntimeError(f"release package manifest sidecar path mismatch: missing={missing} extra={extra}")
    for path, expected in manifest_entries.items():
        actual = archive_entries[path]
        if expected != actual:
            raise RuntimeError(f"release package manifest sidecar entry mismatch for {path}: {expected} != {actual}")


def assert_no_duplicate_status_prefix(output: str, label: str) -> None:
    duplicate_lines = [
        line
        for line in output.splitlines()
        if line.startswith(("PASS PASS", "FAIL FAIL", "WARN WARN", "INFO INFO"))
    ]
    if duplicate_lines:
        raise RuntimeError(f"{label} output contains duplicated status prefixes: {duplicate_lines[:5]}")


def run_doctor_clean(cmd: list[str], cwd: Path, env: dict[str, str] | None = None, timeout: int | None = None) -> None:
    output = run_capture(cmd, cwd, env=env, timeout=timeout)
    assert_no_duplicate_status_prefix(output, "doctor")


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_http(base_url: str, process: subprocess.Popen[str], timeout: int = 90) -> None:
    deadline = time.time() + timeout
    request = Request(base_url, headers={"User-Agent": "aifios-release-smoke/1.0"})
    # The dynamically allocated server is local; OS proxy settings must not
    # route readiness probes through an unrelated external proxy.
    opener = build_opener(ProxyHandler({}))

    while time.time() < deadline:
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise RuntimeError(f"UI server exited early with code {process.returncode}\n{output}")
        try:
            with opener.open(request, timeout=3) as response:
                if 200 <= response.status < 500:
                    return
        except (OSError, URLError, TimeoutError):
            time.sleep(1)

    raise TimeoutError(f"UI server did not become ready at {base_url}")


def stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def run_ui_smoke(root: Path, project: Path) -> None:
    ui_dir = root / "ui"
    if not ui_dir.exists():
        raise FileNotFoundError(f"release package is missing UI directory: {ui_dir}")

    env = os.environ.copy()
    env["AIFIOS_HOME"] = str(root)
    env["AIFIOS_PROJECT"] = str(project)
    env["AIFIOS_SKILLS_DIR"] = str(root / "skills")
    env["AIFIOS_ENABLE_SMOKE_PROVIDER"] = "1"
    env["AIFIOS_SMOKE_PROVIDER_TOKEN"] = SMOKE_PROVIDER_TOKEN
    env.setdefault("NEXT_TELEMETRY_DISABLED", "1")
    bypass = ",".join(filter(None, [env.get("no_proxy", ""), env.get("NO_PROXY", ""), "127.0.0.1,localhost"]))
    env["NO_PROXY"] = env["no_proxy"] = bypass

    install_cmd = ["npm", "ci"] if (ui_dir / "package-lock.json").exists() else ["npm", "install"]
    run(install_cmd, ui_dir, env=env, timeout=300)
    run_doctor_clean(
        ["python3", "scripts/doctor.py", "--install-dir", str(root / "skills"), "--require-ui-deps"],
        root,
        env=env,
        timeout=120,
    )
    run(["npm", "audit", "--omit=dev", "--audit-level=high"], ui_dir, env=env, timeout=120)
    run(["npm", "run", "test:unit"], ui_dir, env=env, timeout=120)
    run(["npm", "run", "lint"], ui_dir, env=env, timeout=120)
    run(["npm", "run", "build"], ui_dir, env=env, timeout=300)

    port = find_free_port()
    env["PORT"] = str(port)
    env["HOSTNAME"] = "127.0.0.1"
    base_url = f"http://127.0.0.1:{port}"

    print(f"+ npm run start -- --hostname 127.0.0.1 --port {port}")
    process = subprocess.Popen(
        ["npm", "run", "start", "--", "--hostname", "127.0.0.1", "--port", str(port)],
        cwd=ui_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        wait_for_http(base_url, process)
        run([
            "python3",
            "scripts/ui_smoke.py",
            "--base-url",
            base_url,
            "--exercise-writes",
            "--project-dir",
            str(project),
            "--smoke-provider-token",
            SMOKE_PROVIDER_TOKEN,
            "--timeout",
            "60",
        ], root, env=env, timeout=300)
    finally:
        stop_process(process)


def create_secret_fixtures() -> tuple[list[Path], list[Path]]:
    created_files = []
    created_dirs = []
    for relative, content in SECRET_FIXTURES.items():
        path = REPO_ROOT / relative
        if path.exists():
            continue
        missing_dirs = []
        parent = path.parent
        while parent != REPO_ROOT and not parent.exists():
            missing_dirs.append(parent)
            parent = parent.parent
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        created_files.append(path)
        created_dirs.extend(missing_dirs)
    return created_files, created_dirs


def remove_secret_fixtures(files: list[Path], dirs: list[Path]) -> None:
    for path in files:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    for path in sorted(set(dirs), key=lambda item: len(item.parts), reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass


def safe_extract(tar: tarfile.TarFile, destination: Path) -> None:
    destination = destination.resolve(strict=False)
    members = tar.getmembers()
    names = [member.name for member in members]
    if names != sorted(names):
        raise RuntimeError("archive members are not sorted deterministically")

    for member in members:
        if not (member.isdir() or member.isfile()):
            raise RuntimeError(f"unsupported archive member type: {member.name}")
        if member.uid != 0 or member.gid != 0:
            raise RuntimeError(f"non-normalized archive owner id for {member.name}: {member.uid}:{member.gid}")
        if member.uname != EXPECTED_ARCHIVE_OWNER or member.gname != EXPECTED_ARCHIVE_OWNER:
            raise RuntimeError(f"non-normalized archive owner name for {member.name}: {member.uname}:{member.gname}")
        if int(member.mtime) != EXPECTED_ARCHIVE_MTIME:
            raise RuntimeError(f"non-normalized archive mtime for {member.name}: {member.mtime}")
        target = (destination / member.name).resolve(strict=False)
        try:
            target.relative_to(destination)
        except ValueError as exc:
            raise RuntimeError(f"unsafe archive member path: {member.name}") from exc
    tar.extractall(destination)


def assert_package_layout(root: Path) -> None:
    required_paths = [
        "README.md",
        "QUICKSTART-10MIN.md",
        "RELEASE.md",
        "Makefile",
        "scripts/aifios.py",
        "scripts/check_runtime_contracts.py",
        "scripts/check_ui_runtime_gates.py",
        "scripts/check_ui_model_presets.py",
        "scripts/doctor.py",
        "scripts/release_gate.py",
        "scripts/quickstart_smoke.py",
        "scripts/ui_smoke.py",
        "docs/third-party-notices.md",
        "skills/content-runtime/SKILL.md",
        "skills/content-runtime/config/visual-routing.json",
        "skills/content-runtime/config/visual-brand-profiles.json",
        "skills/content-runtime/config/runtime-image-routes.json",
        "skills/content-runtime/schemas/visual-recipe.schema.json",
        "skills/content-runtime/schemas/visual-revision-request.schema.json",
        "skills/content-runtime/schemas/runtime-image-route-catalog.schema.json",
        "skills/content-runtime/scripts/content_runtime.py",
        "skills/content-runtime/scripts/visual_director.py",
        "skills/content-runtime/scripts/visual_publish.py",
        "skills/content-runtime/scripts/visual_revision.py",
        "skills/content-runtime/scripts/visual_release.py",
        "skills/content-runtime/fixtures/visual-director/product-flow.png",
        "skills/baoyu-diagram/SKILL.md",
        "skills/baoyu-comic/SKILL.md",
        "skills/manifest.json",
        "ui/package.json",
        "ui/package-lock.json",
        "ui/app/api/status/route.ts",
        "ui/app/api/visual/revise/route.ts",
        "ui/app/api/visual/select/route.ts",
        "ui/components/VisualWorkbench.tsx",
        "ui/lib/visual-workbench.ts",
        "quality/golden-cases/README.md",
        "quality/acceptance/real-account-acceptance.template.json",
        "quality/acceptance/internal-release-acceptance.template.json",
        "quality/acceptance/trusted-qa-public-keys.json",
        "quality/acceptance/README.md",
    ]
    forbidden_paths = [
        ".git",
        "node_modules",
        "ui/node_modules",
        "ui/.next",
        "dist",
        "pipeline",
        "sessions",
        "brain",
        "assets",
        "runs",
        "materials",
        "uploads",
        "deliveries",
        "backups",
        "exports",
        ".aifios-project",
        "ai-content-system",
        "quality/reports",
        "quality/system-audits",
        ".env",
        ".env.local",
        "ui/.env",
        "ui/.env.local",
        "ui/.npmrc",
        "config/llm-config.json",
    ]

    missing = [path for path in required_paths if not (root / path).exists()]
    if missing:
        raise FileNotFoundError(f"release package is missing required paths: {missing}")

    leaked = [path for path in forbidden_paths if (root / path).exists()]
    if leaked:
        raise RuntimeError(f"release package contains generated/local paths: {leaked}")

    contamination = find_package_contamination(root)
    if contamination:
        sample = contamination[:20]
        suffix = "" if len(contamination) <= 20 else f" ... +{len(contamination) - 20} more"
        raise RuntimeError(f"release package contains local/debug/private artifacts: {sample}{suffix}")


def assert_selected_visual_releases(project: Path) -> int:
    """Require every recipe-backed visual root to have a valid immutable adoption."""
    runtime_scripts = REPO_ROOT / "skills" / "content-runtime" / "scripts"
    if str(runtime_scripts) not in sys.path:
        sys.path.insert(0, str(runtime_scripts))
    from visual_release import resolve_selected_visual_release

    checked = 0
    visual_dirs = sorted(project.rglob("pipeline/visual")) if project.exists() else []
    for visual_dir in visual_dirs:
        if not visual_dir.is_dir():
            continue
        release_project = visual_dir.parents[1]
        for root in sorted(path for path in visual_dir.iterdir() if path.is_dir()):
            slug = root.name
            resolved_release = resolve_selected_visual_release(release_project, slug)
            if resolved_release.get("status") == "legacy":
                continue
            revision_id = str(resolved_release.get("revision_id") or "<unselected>")
            if resolved_release.get("status") != "pass":
                details = "; ".join(str(item) for item in resolved_release.get("errors", [])[:5])
                raise RuntimeError(
                    f"selected visual release failed integrity verification: {slug}/{revision_id}: {details}"
                )
            index = resolved_release.get("index")
            expected_recipe = str(resolved_release.get("recipe_path") or "")
            outputs = index.get("outputs") if isinstance(index, dict) else None
            if not isinstance(outputs, list) or not outputs:
                raise RuntimeError(f"selected visual release has no outputs: {slug}/{revision_id}")
            for output in outputs:
                if (
                    not isinstance(output, dict)
                    or output.get("renderer") != "local"
                    or output.get("recipe_path") != expected_recipe
                ):
                    raise RuntimeError(f"selected visual output lacks local renderer provenance: {slug}/{revision_id}")
            checked += 1
    if checked == 0:
        raise RuntimeError(f"project has no selected recipe-backed visual releases: {project}")
    return checked


def contamination_reason(path: Path, root: Path) -> str | None:
    rel = path.relative_to(root)
    parts = rel.parts
    lowered_parts = {part.lower() for part in parts}
    lower_name = path.name.lower()
    if any(part in LOCAL_ARTIFACT_DIR_NAMES for part in lowered_parts):
        return "local artifact directory"
    if path.is_file() and lower_name in SECRET_FILE_NAMES:
        return "secret file name"
    if path.is_file() and lower_name.endswith(SECRET_FILE_SUFFIXES):
        return "secret file suffix"
    if path.is_file() and any(pattern in lower_name for pattern in SECRET_NAME_PATTERNS):
        return "secret-like file name"
    if path.is_file() and lower_name in LOCAL_ARTIFACT_FILE_NAMES:
        return "local artifact file name"
    if path.is_file() and lower_name.endswith(LOCAL_ARTIFACT_FILE_SUFFIXES):
        return "local artifact file suffix"
    if path.name == ".DS_Store":
        return "macOS metadata"
    return None


def find_package_contamination(root: Path) -> list[str]:
    issues = []
    for path in sorted(root.rglob("*")):
        reason = contamination_reason(path, root)
        if reason:
            issues.append(f"{path.relative_to(root).as_posix()} ({reason})")
    return issues


def run_release_gate_custom_markdown_failure(root: Path, work_dir: Path) -> None:
    missing_archive = work_dir / "missing-release-gate-archive.tar.gz"
    report = work_dir / "invalid-release-gate-report.json"
    markdown_report = work_dir / "invalid-release-gate-report.md"
    for path in [report, markdown_report]:
        try:
            path.unlink()
        except FileNotFoundError:
            pass

    command = [
        "python3",
        "scripts/aifios.py",
        "release-gate",
        "--archive",
        str(missing_archive),
        "--report",
        str(report),
        "--markdown-report",
        str(markdown_report),
        "--quickstart-work-dir",
        str(work_dir / "invalid-release-gate-quickstart"),
        "--smoke-work-dir",
        str(work_dir / "invalid-release-gate-smoke"),
    ]
    print(f"+ {' '.join(command)}")
    result = subprocess.run(
        command,
        cwd=root,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=120,
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.returncode == 0:
        raise RuntimeError("release-gate accepted an invalid archive")
    if not report.is_file():
        raise FileNotFoundError(f"release-gate did not write custom JSON report: {report}")
    if not markdown_report.is_file():
        raise FileNotFoundError(f"release-gate did not write custom Markdown report: {markdown_report}")

    payload = json.loads(report.read_text(encoding="utf-8"))
    if payload.get("status") != "fail":
        raise RuntimeError(f"invalid archive report should be fail, got {payload.get('status')}")
    if payload.get("markdown_report") != str(markdown_report):
        raise RuntimeError("release-gate report did not preserve the custom markdown_report path")
    markdown = markdown_report.read_text(encoding="utf-8")
    for token in ["# Echo Founder Release Gate Report", "## Archive Verification", "## Gate Steps"]:
        if token not in markdown:
            raise RuntimeError(f"custom release-gate Markdown report missing {token}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test an AIFIOS release package")
    parser.add_argument("--archive", default=None, help="release tar.gz path; builds one when omitted")
    parser.add_argument("--work-dir", default="/private/tmp/aifios-release-smoke", help="temporary extraction directory")
    args = parser.parse_args()

    work_dir = Path(args.work_dir).expanduser().resolve(strict=False)
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    archive = Path(args.archive).expanduser().resolve(strict=True) if args.archive else None
    archive_built_by_smoke = archive is None
    if archive is None:
        dist_dir = work_dir / "dist"
        secret_files, secret_dirs = create_secret_fixtures()
        try:
            run(["make", "package", f"DIST_DIR={dist_dir}"], REPO_ROOT)
        finally:
            remove_secret_fixtures(secret_files, secret_dirs)
        archives = sorted(dist_dir.glob("aifios-*.tar.gz"))
        if not archives:
            raise FileNotFoundError(f"no package created in {dist_dir}")
        archive = archives[-1]
    assert_archive_sha256_sidecar(archive, require=archive_built_by_smoke)
    assert_archive_manifest_sidecar(archive, require=archive_built_by_smoke)

    with tarfile.open(archive, "r:gz") as tar:
        safe_extract(tar, work_dir)

    roots = [p for p in work_dir.iterdir() if p.is_dir() and p.name.startswith("aifios-")]
    if not roots:
        raise FileNotFoundError(f"no extracted aifios-* directory in {work_dir}")
    root = roots[0]
    assert_package_layout(root)

    install_dir = work_dir / "installed-skills"
    demo_project = work_dir / "demo-project"
    platform_demo_project = work_dir / "platform-demos"
    run(["npm", "ci"], root / "skills" / "xhs-card", timeout=300)
    run(["make", "test"], root)
    run(["make", "pytest"], root)
    run(["make", "runtime-contracts"], root)
    run(["make", "ui-runtime-gates"], root)
    run(["make", "install", f"INSTALL_DIR={install_dir}", "FORCE=1"], root)
    run_doctor_clean(["make", "doctor", f"INSTALL_DIR={install_dir}"], root)
    run_doctor_clean(
        [
            "make",
            "doctor",
            f"INSTALL_DIR={install_dir}",
            "REQUIRE_EXTERNAL=1",
            "SKIP_UI=1",
            "SHOW_RESOLUTIONS=1",
        ],
        root,
    )
    run(["make", "demo", f"DEMO_PROJECT={demo_project}"], root)
    run(["make", "demo", "PLATFORM=all", f"DEMO_PROJECT={platform_demo_project}"], root)
    assert_selected_visual_releases(demo_project)
    assert_selected_visual_releases(platform_demo_project)
    from quickstart_smoke import run_native_demo_checks
    run_native_demo_checks(root, platform_demo_project)
    run(["make", "browser-hit-fixture-check"], root)
    run(["make", "status", f"PROJECT={demo_project}", "SLUG=codex-demo"], root)
    run(["python3", "scripts/aifios.py", "--help"], root)
    run(["python3", "scripts/aifios.py", "release-gate", "--help"], root)
    run(["python3", "scripts/aifios.py", "release-report", "--help"], root)
    run(["python3", "scripts/aifios.py", "install-cli", "--bin-dir", str(work_dir / "bin"), "--dry-run"], root)
    run(["python3", "scripts/aifios.py", "--project", str(demo_project), "run", "list"], root)
    run(["python3", "scripts/aifios.py", "--project", str(demo_project), "status", "--slug", "codex-demo"], root)
    run([
        "make",
        "verify",
        f"INSTALL_DIR={install_dir}",
        "SKIP_DEMO=1",
        "SKIP_BROWSER_FIXTURE=1",
        "SKIP_UI=1",
    ], root)
    run_release_gate_custom_markdown_failure(root, work_dir)
    run_ui_smoke(root, demo_project)
    print(f"PASS release smoke: {archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
