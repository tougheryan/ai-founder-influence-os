#!/usr/bin/env python3
"""Build a versioned AIFIOS release package."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import tarfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "skills" / "manifest.json"
FIXED_MTIME = 0
FIXED_OWNER = "aifios"
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
DEFAULT_INCLUDE = [
    "LICENSE",
    "OPEN_SOURCE.md",
    "VERSION",
    "README.md",
    "QUICKSTART-10MIN.md",
    "RELEASE.md",
    "AGENTS.md",
    "Makefile",
    "pyproject.toml",
    "docs",
    "scripts",
    "skills",
    "ui",
    "quality/golden-cases",
    "quality/commercial-readiness-matrix.json",
    "quality/commercial-readiness-matrix.md",
    "quality/acceptance/real-account-acceptance.template.json",
    "quality/acceptance/internal-release-acceptance.template.json",
    "quality/acceptance/trusted-qa-public-keys.json",
    "quality/acceptance/README.md",
]


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def should_skip(path: Path) -> bool:
    parts = set(path.parts)
    name = path.name
    lower_name = name.lower()
    try:
        rel_parts = path.relative_to(REPO_ROOT).parts
    except ValueError:
        rel_parts = path.parts
    return (
        any(part in LOCAL_ARTIFACT_DIR_NAMES for part in parts)
        or any(part.startswith(".next") for part in rel_parts)
        or rel_parts[:2] in {("quality", "reports"), ("quality", "system-audits")}
        or lower_name in SECRET_FILE_NAMES
        or lower_name.endswith(SECRET_FILE_SUFFIXES)
        or any(pattern in lower_name for pattern in SECRET_NAME_PATTERNS)
        or "coverage" in parts
        or name == ".DS_Store"
        or lower_name in LOCAL_ARTIFACT_FILE_NAMES
        or lower_name.endswith(LOCAL_ARTIFACT_FILE_SUFFIXES)
        or lower_name.endswith((".pyc", ".pyo"))
    )


def iter_files(source: Path) -> list[Path]:
    if not source.exists():
        return []
    if source.is_file():
        return [] if should_skip(source) else [source]
    return sorted(
        (path for path in source.rglob("*") if path.is_file() and not should_skip(path)),
        key=lambda path: path.relative_to(REPO_ROOT).as_posix(),
    )


def add_file(tar: tarfile.TarFile, source: Path, arcname: str) -> None:
    info = tar.gettarinfo(str(source), arcname=arcname)
    info.uid = 0
    info.gid = 0
    info.uname = FIXED_OWNER
    info.gname = FIXED_OWNER
    info.mtime = FIXED_MTIME
    with source.open("rb") as fh:
        tar.addfile(info, fh)


def collect_package_entries(package_name: str) -> dict[str, Path]:
    entries: dict[str, Path] = {}
    for rel in DEFAULT_INCLUDE:
        for path in iter_files(REPO_ROOT / rel):
            arcname = f"{package_name}/{path.relative_to(REPO_ROOT)}"
            entries[arcname] = path
    return entries


def build_tar_bytes(package_name: str, entries: dict[str, Path]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for arcname in sorted(entries):
            add_file(tar, entries[arcname], arcname)
    return buffer.getvalue()


def write_reproducible_targz(archive: Path, package_name: str) -> dict[str, Path]:
    entries = collect_package_entries(package_name)
    tar_bytes = build_tar_bytes(package_name, entries)
    tmp = archive.with_suffix(archive.suffix + ".tmp")
    with tmp.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=FIXED_MTIME) as gz:
            gz.write(tar_bytes)
    os.replace(tmp, archive)
    return entries


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_sha256_sidecar(archive: Path) -> Path:
    sidecar = Path(f"{archive}.sha256")
    sidecar.write_text(f"{sha256_file(archive)}  {archive.name}\n", encoding="utf-8")
    return sidecar


def write_manifest_sidecar(archive: Path, package_name: str, entries: dict[str, Path]) -> Path:
    rows = []
    total_size = 0
    for arcname in sorted(entries):
        source = entries[arcname]
        size = source.stat().st_size
        total_size += size
        rows.append({
            "path": arcname,
            "size": size,
            "sha256": sha256_file(source),
        })
    sidecar = Path(f"{archive}.manifest.json")
    payload = {
        "schema_version": 1,
        "tool": "aifios-package-manifest",
        "package": package_name,
        "archive": archive.name,
        "archive_sha256": sha256_file(archive),
        "entry_count": len(rows),
        "total_uncompressed_bytes": total_size,
        "entries": rows,
    }
    sidecar.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return sidecar


def main() -> int:
    parser = argparse.ArgumentParser(description="Package AIFIOS")
    parser.add_argument("--dist-dir", default="dist", help="output directory")
    parser.add_argument("--name", default=None, help="override package name")
    args = parser.parse_args()

    from version_status import read_version
    version = read_version(REPO_ROOT)
    package_name = args.name or f"aifios-{version}"
    dist_dir = (REPO_ROOT / args.dist_dir).resolve(strict=False)
    dist_dir.mkdir(parents=True, exist_ok=True)
    archive = dist_dir / f"{package_name}.tar.gz"

    entries = write_reproducible_targz(archive, package_name)
    sidecar = write_sha256_sidecar(archive)
    manifest_sidecar = write_manifest_sidecar(archive, package_name, entries)

    print(f"PASS package: {archive}")
    print(f"PASS package sha256: {sidecar}")
    print(f"PASS package manifest: {manifest_sidecar}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
