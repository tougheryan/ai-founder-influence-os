#!/usr/bin/env python3
"""Run the full pre-release gate against one exact Echo Founder archive."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_report(report_path: Path, payload: dict[str, object]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def default_markdown_report_path(report_path: Path) -> Path:
    if report_path.suffix:
        return report_path.with_suffix(".md")
    return Path(f"{report_path}.md")


def render_markdown_report(payload: dict[str, object]) -> str:
    steps = payload.get("steps") if isinstance(payload.get("steps"), list) else []
    archive_check = payload.get("archive_check") if isinstance(payload.get("archive_check"), dict) else {}
    sidecar_check = payload.get("archive_sidecar_check") if isinstance(payload.get("archive_sidecar_check"), dict) else {}
    manifest_check = payload.get("archive_manifest_check") if isinstance(payload.get("archive_manifest_check"), dict) else {}
    lines = [
        "# Echo Founder Release Gate Report",
        "",
        f"- Status: `{payload.get('status') or 'unknown'}`",
        f"- Archive: `{payload.get('archive') or 'not-recorded'}`",
        f"- Archive SHA256: `{payload.get('archive_sha256') or 'not-recorded'}`",
        f"- Started: {payload.get('started_at') or 'not-recorded'}",
        f"- Finished: {payload.get('finished_at') or 'not-recorded'}",
        f"- Quickstart work dir: `{payload.get('quickstart_work_dir') or 'not-recorded'}`",
        f"- Smoke work dir: `{payload.get('smoke_work_dir') or 'not-recorded'}`",
    ]
    if payload.get("error"):
        lines.append(f"- Error: `{payload.get('error')}`")
    if archive_check:
        lines.extend([
            "",
            "## Archive Verification",
            "",
            "| Check | Value |",
            "| --- | --- |",
            f"| File exists | `{'yes' if archive_check.get('exists') else 'no'}` |",
            f"| Expected SHA256 | `{archive_check.get('expected_sha256') or 'not-recorded'}` |",
            f"| Actual SHA256 | `{archive_check.get('actual_sha256') or 'not-recorded'}` |",
            f"| SHA256 match | `{'yes' if archive_check.get('matches') else 'no'}` |",
        ])
    if sidecar_check:
        lines.extend([
            "",
            "## SHA256 Sidecar Verification",
            "",
            "| Check | Value |",
            "| --- | --- |",
            f"| Sidecar | `{sidecar_check.get('path') or 'not-recorded'}` |",
            f"| File exists | `{'yes' if sidecar_check.get('exists') else 'no'}` |",
            f"| Expected SHA256 | `{sidecar_check.get('expected_sha256') or 'not-recorded'}` |",
            f"| Actual SHA256 | `{sidecar_check.get('actual_sha256') or 'not-recorded'}` |",
            f"| Filename match | `{'yes' if sidecar_check.get('filename_matches') else 'no'}` |",
            f"| SHA256 match | `{'yes' if sidecar_check.get('matches') else 'no'}` |",
        ])
    if manifest_check:
        lines.extend([
            "",
            "## Package Manifest Verification",
            "",
            "| Check | Value |",
            "| --- | --- |",
            f"| Manifest | `{manifest_check.get('path') or 'not-recorded'}` |",
            f"| File exists | `{'yes' if manifest_check.get('exists') else 'no'}` |",
            f"| Archive filename match | `{'yes' if manifest_check.get('archive_filename_matches') else 'no'}` |",
            f"| Archive SHA256 match | `{'yes' if manifest_check.get('archive_sha256_matches') else 'no'}` |",
            f"| Entry count | `{manifest_check.get('manifest_entry_count')}/{manifest_check.get('entry_count')}` |",
            f"| Entry count match | `{'yes' if manifest_check.get('entry_count_matches') else 'no'}` |",
            f"| Total size match | `{'yes' if manifest_check.get('total_size_matches') else 'no'}` |",
            f"| Entries match | `{'yes' if manifest_check.get('entries_match') else 'no'}` |",
            f"| Error | `{manifest_check.get('error') or 'none'}` |",
        ])
    lines.extend([
        "",
        "## Gate Steps",
        "",
        "| Step | Status | Return Code | Duration |",
        "| --- | --- | ---: | ---: |",
    ])
    for step in steps:
        if not isinstance(step, dict):
            continue
        lines.append(
            "| "
            + str(step.get("label") or "unknown")
            + " | `"
            + str(step.get("status") or "unknown")
            + "` | "
            + str(step.get("returncode"))
            + " | "
            + str(step.get("duration_seconds"))
            + "s |"
        )
    lines.append("")
    return "\n".join(lines)


def write_markdown_report(markdown_path: Path, payload: dict[str, object]) -> None:
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.write_text(render_markdown_report(payload), encoding="utf-8")


def refresh_archive_check(payload: dict[str, object]) -> None:
    archive = str(payload.get("archive") or "")
    expected_sha256 = str(payload.get("archive_sha256") or "")
    actual_sha256 = ""
    exists = False
    if archive:
        archive_path = Path(archive).expanduser().resolve(strict=False)
        exists = archive_path.is_file()
        if exists:
            actual_sha256 = sha256_file(archive_path)
    payload["archive_check"] = {
        "exists": exists,
        "expected_sha256": expected_sha256,
        "actual_sha256": actual_sha256,
        "matches": bool(expected_sha256 and actual_sha256 == expected_sha256),
    }


def refresh_sidecar_check(payload: dict[str, object]) -> None:
    archive = str(payload.get("archive") or "")
    sidecar_path = f"{archive}.sha256" if archive else ""
    actual_sha256 = str(payload.get("archive_check", {}).get("actual_sha256") or "")
    exists = False
    expected_sha256 = ""
    filename = ""
    filename_matches = False
    matches = False
    if sidecar_path:
        sidecar = Path(sidecar_path).expanduser().resolve(strict=False)
        exists = sidecar.is_file()
        if exists:
            parts = sidecar.read_text(encoding="utf-8").strip().split()
            if parts:
                expected_sha256 = parts[0]
            if len(parts) >= 2:
                filename = parts[1]
            filename_matches = bool(archive and filename == Path(archive).name)
            matches = bool(expected_sha256 and actual_sha256 and expected_sha256 == actual_sha256)
    payload["archive_sidecar_check"] = {
        "path": sidecar_path,
        "exists": exists,
        "expected_sha256": expected_sha256,
        "actual_sha256": actual_sha256,
        "filename": filename,
        "filename_matches": filename_matches,
        "matches": matches,
    }


def archive_file_index(archive: Path) -> dict[str, dict[str, object]]:
    entries: dict[str, dict[str, object]] = {}
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            if member.name in entries:
                raise RuntimeError(f"duplicate archive file entry: {member.name}")
            fh = tar.extractfile(member)
            if fh is None:
                raise RuntimeError(f"unable to read archive file entry: {member.name}")
            digest = hashlib.sha256()
            size = 0
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
            entries[member.name] = {
                "size": size,
                "sha256": digest.hexdigest(),
            }
    return entries


def refresh_manifest_check(payload: dict[str, object]) -> None:
    archive = str(payload.get("archive") or "")
    manifest_path = f"{archive}.manifest.json" if archive else ""
    archive_check = payload.get("archive_check") if isinstance(payload.get("archive_check"), dict) else {}
    actual_archive_sha256 = str(archive_check.get("actual_sha256") or "")
    check: dict[str, object] = {
        "path": manifest_path,
        "exists": False,
        "archive": "",
        "archive_filename_matches": False,
        "expected_archive_sha256": "",
        "actual_archive_sha256": actual_archive_sha256,
        "archive_sha256_matches": False,
        "entry_count": 0,
        "manifest_entry_count": 0,
        "entry_count_matches": False,
        "total_uncompressed_bytes": 0,
        "total_size_matches": False,
        "entries_match": False,
        "error": "",
    }
    if not manifest_path:
        payload["archive_manifest_check"] = check
        return
    sidecar = Path(manifest_path).expanduser().resolve(strict=False)
    check["exists"] = sidecar.is_file()
    if not sidecar.is_file():
        payload["archive_manifest_check"] = check
        return
    try:
        manifest = json.loads(sidecar.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise RuntimeError("manifest JSON root is not an object")
        rows = manifest.get("entries")
        if not isinstance(rows, list):
            raise RuntimeError("manifest entries is not a list")
        archive_entries = archive_file_index(Path(archive).expanduser().resolve(strict=False))
        manifest_entries: dict[str, dict[str, object]] = {}
        total_size = 0
        for row in rows:
            if not isinstance(row, dict):
                raise RuntimeError("manifest entry is not an object")
            path = str(row.get("path") or "")
            if not path or path.startswith("/") or ".." in Path(path).parts:
                raise RuntimeError(f"unsafe manifest entry path: {path}")
            size = row.get("size")
            digest = row.get("sha256")
            if not isinstance(size, int) or not isinstance(digest, str):
                raise RuntimeError(f"invalid manifest entry for {path}")
            total_size += size
            manifest_entries[path] = {"size": size, "sha256": digest}
        check["archive"] = str(manifest.get("archive") or "")
        check["archive_filename_matches"] = bool(archive and manifest.get("archive") == Path(archive).name)
        check["expected_archive_sha256"] = str(manifest.get("archive_sha256") or "")
        check["archive_sha256_matches"] = bool(actual_archive_sha256 and manifest.get("archive_sha256") == actual_archive_sha256)
        check["entry_count"] = len(archive_entries)
        check["manifest_entry_count"] = len(manifest_entries)
        check["entry_count_matches"] = manifest.get("entry_count") == len(manifest_entries) == len(archive_entries)
        check["total_uncompressed_bytes"] = total_size
        check["total_size_matches"] = manifest.get("total_uncompressed_bytes") == total_size
        check["entries_match"] = manifest_entries == archive_entries and set(manifest_entries) == set(archive_entries)
    except Exception as exc:
        check["error"] = str(exc)
    payload["archive_manifest_check"] = check


def archive_check_error(payload: dict[str, object]) -> str | None:
    archive = str(payload.get("archive") or "")
    archive_check = payload.get("archive_check") if isinstance(payload.get("archive_check"), dict) else {}
    if not archive:
        return "release gate did not record an archive path"
    if not archive_check.get("exists"):
        return "archive file recorded by release gate no longer exists"
    if not archive_check.get("matches"):
        return "archive SHA256 changed during release gate"
    return None


def sidecar_check_error(payload: dict[str, object]) -> str | None:
    sidecar_check = payload.get("archive_sidecar_check") if isinstance(payload.get("archive_sidecar_check"), dict) else {}
    if not sidecar_check.get("exists"):
        return "release archive SHA256 sidecar is missing"
    if not sidecar_check.get("filename_matches"):
        return "release archive SHA256 sidecar filename does not match archive"
    if not sidecar_check.get("matches"):
        return "release archive SHA256 sidecar does not match archive"
    return None


def manifest_check_error(payload: dict[str, object]) -> str | None:
    manifest_check = payload.get("archive_manifest_check") if isinstance(payload.get("archive_manifest_check"), dict) else {}
    if not manifest_check.get("exists"):
        return "release archive manifest sidecar is missing"
    if manifest_check.get("error"):
        return f"release archive manifest sidecar could not be verified: {manifest_check.get('error')}"
    if not manifest_check.get("archive_filename_matches"):
        return "release archive manifest sidecar filename does not match archive"
    if not manifest_check.get("archive_sha256_matches"):
        return "release archive manifest sidecar archive SHA256 does not match archive"
    if not manifest_check.get("entry_count_matches"):
        return "release archive manifest sidecar entry count does not match archive"
    if not manifest_check.get("total_size_matches"):
        return "release archive manifest sidecar total size does not match archive"
    if not manifest_check.get("entries_match"):
        return "release archive manifest sidecar does not match archive"
    return None


def run_step(label: str, command: list[str], *, cwd: Path, timeout: int | None = None) -> dict[str, object]:
    started_at = utc_now()
    started = time.monotonic()
    print(f"\n== {label} ==", flush=True)
    print("+ " + " ".join(command), flush=True)
    result = subprocess.run(command, cwd=cwd, timeout=timeout, check=False)
    finished_at = utc_now()
    duration = round(time.monotonic() - started, 3)
    record: dict[str, object] = {
        "label": label,
        "command": command,
        "cwd": str(cwd),
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": duration,
        "returncode": result.returncode,
        "status": "pass" if result.returncode == 0 else "fail",
    }
    return record


def latest_archive(dist_dir: Path) -> Path:
    archives = sorted(dist_dir.glob("aifios-*.tar.gz"))
    if not archives:
        raise FileNotFoundError(f"no package created in {dist_dir}")
    return archives[-1].resolve(strict=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the Echo Founder release gate and write an audit report")
    parser.add_argument("--archive", default=None, help="existing release tar.gz path; builds one when omitted")
    parser.add_argument("--dist-dir", default="/private/tmp/aifios-release-gate-dist", help="package output directory when --archive is omitted")
    parser.add_argument("--quickstart-work-dir", default="/private/tmp/aifios-release-gate-quickstart")
    parser.add_argument("--smoke-work-dir", default="/private/tmp/aifios-release-gate-smoke")
    parser.add_argument("--report", default="/private/tmp/aifios-release-gate-report.json")
    parser.add_argument("--markdown-report", default="", help="markdown summary path; defaults to --report with .md suffix")
    args = parser.parse_args()

    report_path = Path(args.report).expanduser().resolve(strict=False)
    markdown_report_path = (
        Path(args.markdown_report).expanduser().resolve(strict=False)
        if args.markdown_report
        else default_markdown_report_path(report_path)
    )
    quickstart_work_dir = Path(args.quickstart_work_dir).expanduser().resolve(strict=False)
    smoke_work_dir = Path(args.smoke_work_dir).expanduser().resolve(strict=False)
    dist_dir = Path(args.dist_dir).expanduser().resolve(strict=False)

    report: dict[str, object] = {
        "schema_version": 1,
        "tool": "aifios-release-gate",
        "status": "running",
        "started_at": utc_now(),
        "finished_at": None,
        "repo_root": str(REPO_ROOT),
        "archive": None,
        "archive_sha256": None,
        "archive_check": {
            "exists": False,
            "expected_sha256": None,
            "actual_sha256": None,
            "matches": False,
        },
        "archive_sidecar_check": {
            "path": None,
            "exists": False,
            "expected_sha256": None,
            "actual_sha256": None,
            "filename": None,
            "filename_matches": False,
            "matches": False,
        },
        "archive_manifest_check": {
            "path": None,
            "exists": False,
            "archive": None,
            "archive_filename_matches": False,
            "expected_archive_sha256": None,
            "actual_archive_sha256": None,
            "archive_sha256_matches": False,
            "entry_count": 0,
            "manifest_entry_count": 0,
            "entry_count_matches": False,
            "total_uncompressed_bytes": 0,
            "total_size_matches": False,
            "entries_match": False,
            "error": None,
        },
        "markdown_report": str(markdown_report_path),
        "quickstart_work_dir": str(quickstart_work_dir),
        "smoke_work_dir": str(smoke_work_dir),
        "steps": [],
    }

    exit_code = 0
    try:
        if args.archive:
            archive = Path(args.archive).expanduser().resolve(strict=True)
        else:
            package_step = run_step(
                "package",
                ["make", "package", f"DIST_DIR={dist_dir}"],
                cwd=REPO_ROOT,
                timeout=120,
            )
            report["steps"].append(package_step)
            if package_step["returncode"] != 0:
                raise subprocess.CalledProcessError(int(package_step["returncode"]), package_step["command"])
            archive = latest_archive(dist_dir)

        report["archive"] = str(archive)
        archive_sha256 = sha256_file(archive)
        report["archive_sha256"] = archive_sha256
        report["archive_check"] = {
            "exists": archive.is_file(),
            "expected_sha256": archive_sha256,
            "actual_sha256": archive_sha256,
            "matches": True,
        }
        refresh_sidecar_check(report)
        refresh_manifest_check(report)

        quickstart_step = run_step(
            "quickstart-smoke",
            [
                sys.executable,
                "scripts/quickstart_smoke.py",
                "--archive",
                str(archive),
                "--work-dir",
                str(quickstart_work_dir),
            ],
            cwd=REPO_ROOT,
            timeout=900,
        )
        report["steps"].append(quickstart_step)
        if quickstart_step["returncode"] != 0:
            raise subprocess.CalledProcessError(int(quickstart_step["returncode"]), quickstart_step["command"])

        smoke_step = run_step(
            "smoke-release",
            [
                sys.executable,
                "scripts/smoke_release.py",
                "--archive",
                str(archive),
                "--work-dir",
                str(smoke_work_dir),
            ],
            cwd=REPO_ROOT,
            timeout=1200,
        )
        report["steps"].append(smoke_step)
        if smoke_step["returncode"] != 0:
            raise subprocess.CalledProcessError(int(smoke_step["returncode"]), smoke_step["command"])
        report["status"] = "pass"
    except Exception as exc:
        exit_code = getattr(exc, "returncode", 1) or 1
        report["status"] = "fail"
        report["error"] = str(exc)
    finally:
        report["finished_at"] = utc_now()
        refresh_archive_check(report)
        refresh_sidecar_check(report)
        refresh_manifest_check(report)
        final_archive_error = archive_check_error(report)
        final_sidecar_error = sidecar_check_error(report) if not final_archive_error else None
        final_manifest_error = manifest_check_error(report) if not (final_archive_error or final_sidecar_error) else None
        if exit_code == 0 and (final_archive_error or final_sidecar_error or final_manifest_error):
            exit_code = 1
            report["status"] = "fail"
            report["error"] = final_archive_error or final_sidecar_error or final_manifest_error
        write_report(report_path, report)
        write_markdown_report(markdown_report_path, report)
        print(f"\nrelease_gate_report={report_path}", flush=True)
        print(f"release_gate_markdown_report={markdown_report_path}", flush=True)

    if exit_code == 0:
        print(f"PASS release gate: {report.get('archive')}", flush=True)
    return int(exit_code)


if __name__ == "__main__":
    raise SystemExit(main())
