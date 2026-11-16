#!/usr/bin/env python3
"""Exercise project backup/restore with the code and Node runtime shipped in the App."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA = "echo-founder.packaged-backup-restore-smoke.v1"
DEFAULT_APP = Path("dist/desktop/Echo Founder.app")
DEFAULT_REPORT_DIR = Path("quality/system-audits")


HARNESS = r"""
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const [modulePath, workRoot] = process.argv.slice(2);
const backup = require(modulePath);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const project = path.join(workRoot, "source-project");
const automaticBackupRoot = path.join(workRoot, "automatic-backups");
const restored = path.join(workRoot, "restored-project");
fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(project, "materials"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(project, "materials", "tikomni", "raw"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(project, "config"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(project, "logs"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(project, "credentials"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(project, "sessions", "browser-profiles", "xiaohongshu", "Default", "Network"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(project, "materials", "note.txt"), "packaged restore payload\n", { mode: 0o600 });
fs.writeFileSync(path.join(project, "materials", "tikomni", "raw", "wechat.json"), JSON.stringify({
  platform: "wechat",
  token: "[已脱敏]",
  authorization: "[REDACTED]",
  items: [{ title: "verified public sample" }],
}) + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(project, "config", "llm-config.json"), JSON.stringify({
  provider: "openai",
  model: "test-model",
  apiKey: "must-not-enter-backup",
}) + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(project, "logs", "desktop.log"), "private log\n", { mode: 0o600 });
fs.writeFileSync(path.join(project, "credentials", "session.json"), "{}\n", { mode: 0o600 });
fs.writeFileSync(
  path.join(project, "sessions", "browser-profiles", "xiaohongshu", "Default", "Network", "Cookies"),
  Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.from("packaged-cookie-canary")]),
  { mode: 0o600 },
);
fs.writeFileSync(path.join(project, "materials", "storage_state.json"), JSON.stringify({ cookies: ["packaged-cookie-canary"] }), { mode: 0o600 });

const migration = backup.ensureProjectSchema({
  projectDir: project,
  appVersion: "0.2.0-beta.2",
  backupRoot: automaticBackupRoot,
  now: new Date("2026-08-24T00:00:00.000Z"),
});
assert(migration.migrated === true && migration.backup, "legacy schema migration did not create an automatic backup");
const backupNames = fs.readdirSync(automaticBackupRoot);
assert(backupNames.length === 1, "schema migration created an unexpected backup set");
const backupPath = path.join(automaticBackupRoot, backupNames[0]);
const exported = migration.backup;
const verified = backup.parseAndVerifyManifest(backupPath);
const imported = backup.importProjectBackup({
  backupPath,
  destinationPath: restored,
  appVersion: "0.2.0-beta.2",
  now: new Date("2026-08-24T00:01:00.000Z"),
});

assert(fs.readFileSync(path.join(restored, "materials", "note.txt"), "utf8") === "packaged restore payload\n", "restored payload differs");
const restoredConfig = JSON.parse(fs.readFileSync(path.join(restored, "config", "llm-config.json"), "utf8"));
assert(restoredConfig.provider === "openai" && restoredConfig.model === "test-model", "safe config fields were not restored");
assert(!Object.prototype.hasOwnProperty.call(restoredConfig, "apiKey"), "API key entered restored project");
assert(!fs.existsSync(path.join(restored, "logs")), "logs entered restored project");
assert(!fs.existsSync(path.join(restored, "credentials")), "credentials entered restored project");
assert(!fs.existsSync(path.join(restored, "sessions", "browser-profiles")), "browser Cookies database entered restored project");
assert(!fs.existsSync(path.join(restored, "materials", "storage_state.json")), "browser storage state entered restored project");
const restoredRaw = JSON.parse(fs.readFileSync(path.join(restored, "materials", "tikomni", "raw", "wechat.json"), "utf8"));
assert(restoredRaw.token === "[已脱敏]" && restoredRaw.authorization === "[REDACTED]", "redacted TikOmni raw data was not preserved");
assert(exported.manifestSha256 === imported.manifestSha256, "backup lineage digest differs");
assert(verified.manifest.schema === backup.PROJECT_BACKUP_SCHEMA, "backup schema differs");
assert(verified.manifest.projectSchema === backup.LEGACY_PROJECT_SCHEMA, "automatic backup lost pre-migration schema lineage");

const corruptBackupPath = path.join(workRoot, "corrupt.aifios-backup");
fs.cpSync(backupPath, corruptBackupPath, { recursive: true, errorOnExist: true });
const tamperedFile = path.join(corruptBackupPath, backup.DATA_DIRECTORY, "materials", "note.txt");
fs.appendFileSync(tamperedFile, "tampered\n");
let corruptionRejected = false;
try {
  backup.importProjectBackup({
    backupPath: corruptBackupPath,
    destinationPath: path.join(workRoot, "corrupt-restore"),
    appVersion: "0.2.0-beta.2",
  });
} catch {
  corruptionRejected = true;
}
assert(corruptionRejected, "tampered backup was accepted");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const maliciousBackupPath = path.join(workRoot, "rehashed-malicious.aifios-backup");
fs.cpSync(backupPath, maliciousBackupPath, { recursive: true, errorOnExist: true });
const rawRelativePath = "materials/tikomni/raw/wechat.json";
const maliciousRaw = Buffer.from(JSON.stringify({ platform: "wechat", token: "live-import-secret" }) + "\n");
fs.writeFileSync(path.join(maliciousBackupPath, backup.DATA_DIRECTORY, ...rawRelativePath.split("/")), maliciousRaw);
const maliciousManifestPath = path.join(maliciousBackupPath, backup.MANIFEST_FILE);
const maliciousManifest = JSON.parse(fs.readFileSync(maliciousManifestPath, "utf8"));
const maliciousRow = maliciousManifest.files.find((item) => item.path === rawRelativePath);
assert(maliciousRow, "TikOmni raw row is missing from automatic backup");
maliciousRow.size = maliciousRaw.length;
maliciousRow.sha256 = sha256(maliciousRaw);
maliciousManifest.totalBytes = maliciousManifest.files.reduce((total, item) => total + item.size, 0);
delete maliciousManifest.manifestSha256;
maliciousManifest.manifestSha256 = sha256(Buffer.from(backup.canonicalJson(maliciousManifest), "utf8"));
fs.writeFileSync(maliciousManifestPath, JSON.stringify(maliciousManifest, null, 2) + "\n", { mode: 0o600 });
let recomputedManifestAttackRejected = false;
try {
  backup.importProjectBackup({
    backupPath: maliciousBackupPath,
    destinationPath: path.join(workRoot, "malicious-restore"),
    appVersion: "0.2.0-beta.2",
  });
} catch {
  recomputedManifestAttackRejected = true;
}
assert(recomputedManifestAttackRejected, "rehashed secret-bearing backup was accepted");

process.stdout.write(JSON.stringify({
  status: "pass",
  schema: backup.PROJECT_BACKUP_SCHEMA,
  fileCount: imported.fileCount,
  manifestSha256: imported.manifestSha256,
  secretsExcluded: true,
  transientDataExcluded: true,
  cookiesDatabaseExcluded: true,
  redactedTikomniRawPreserved: true,
  schemaMigrationBackupCreated: true,
  corruptionRejected,
  recomputedManifestAttackRejected,
}) + "\n");
"""


class PackagedSmokeFailure(RuntimeError):
    """A stable, report-safe packaged smoke failure."""

    def __init__(self, code: str, summary: str) -> None:
        super().__init__(summary)
        self.code = code
        self.summary = summary


def packaged_paths(app_path: Path) -> tuple[Path, Path]:
    app = app_path.expanduser().resolve()
    plist_path = app / "Contents" / "Info.plist"
    try:
        with plist_path.open("rb") as handle:
            info = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException) as exc:
        raise PackagedSmokeFailure("app_metadata_unavailable", "Packaged App metadata is unavailable or invalid.") from exc
    executable_name = str(info.get("CFBundleExecutable") or "").strip()
    if not executable_name or "/" in executable_name or executable_name in {".", ".."}:
        raise PackagedSmokeFailure("app_executable_invalid", "Packaged App executable metadata is invalid.")
    executable = app / "Contents" / "MacOS" / executable_name
    module = app / "Contents" / "Resources" / "app" / "electron" / "project-backup.cjs"
    if not executable.is_file():
        raise PackagedSmokeFailure("app_executable_missing", "Packaged Electron executable is missing.")
    if not module.is_file():
        raise PackagedSmokeFailure("backup_module_missing", "Packaged project backup module is missing.")
    return executable, module


def run_packaged_smoke(app_path: Path, timeout: int = 120) -> dict[str, Any]:
    executable, module = packaged_paths(app_path)
    with tempfile.TemporaryDirectory(prefix="echo-founder-backup-restore-") as temporary:
        root = Path(temporary)
        harness = root / "harness.cjs"
        harness.write_text(HARNESS, encoding="utf-8")
        isolated_home = root / "home"
        isolated_home.mkdir(mode=0o700)
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("AIFIOS_") and key not in {"NODE_OPTIONS", "NODE_PATH"}
        }
        environment.update({
            "ELECTRON_RUN_AS_NODE": "1",
            "HOME": str(isolated_home),
            "TMPDIR": str(root),
        })
        try:
            completed = subprocess.run(
                [str(executable), str(harness), str(module), str(root / "work")],
                env=environment,
                text=True,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise PackagedSmokeFailure("backup_harness_timeout", "Packaged backup harness timed out.") from exc
        if completed.returncode != 0:
            raise PackagedSmokeFailure("backup_harness_failed", "Packaged backup harness failed.")
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        if not lines:
            raise PackagedSmokeFailure("backup_harness_no_result", "Packaged backup harness returned no result.")
        try:
            result = json.loads(lines[-1])
        except json.JSONDecodeError as exc:
            raise PackagedSmokeFailure("backup_harness_invalid_result", "Packaged backup harness returned an invalid result.") from exc
        required = {
            "status": "pass",
            "schema": "aifios.project-backup.v1",
            "secretsExcluded": True,
            "transientDataExcluded": True,
            "cookiesDatabaseExcluded": True,
            "redactedTikomniRawPreserved": True,
            "schemaMigrationBackupCreated": True,
            "corruptionRejected": True,
            "recomputedManifestAttackRejected": True,
        }
        if not isinstance(result, dict) or any(result.get(key) != value for key, value in required.items()):
            raise PackagedSmokeFailure("backup_contract_failed", "Packaged backup harness did not satisfy the restore contract.")
        if not isinstance(result.get("fileCount"), int) or result["fileCount"] < 2:
            raise PackagedSmokeFailure("backup_restore_incomplete", "Packaged backup harness restored an incomplete project.")
        if not isinstance(result.get("manifestSha256"), str) or len(result["manifestSha256"]) != 64:
            raise PackagedSmokeFailure("backup_manifest_invalid", "Packaged backup harness returned an invalid manifest digest.")
        return result


def safe_failure_record(exc: BaseException) -> dict[str, str]:
    if isinstance(exc, PackagedSmokeFailure):
        return {"error_code": exc.code, "error_summary": exc.summary}
    return {
        "error_code": "packaged_backup_restore_smoke_failed",
        "error_summary": "Packaged backup/restore smoke failed.",
    }


def render_markdown(report: dict[str, Any]) -> str:
    checks = report.get("checks") if isinstance(report.get("checks"), dict) else {}
    return "\n".join([
        "# Echo Founder 打包态项目备份/恢复 Smoke",
        "",
        f"- 状态：`{report.get('status', 'failed')}`",
        f"- App：`{report.get('app', 'Echo Founder.app')}`",
        f"- 备份 schema：`{checks.get('schema', 'unknown')}`",
        f"- 恢复文件数：`{checks.get('fileCount', 0)}`",
        f"- 凭据剔除：`{checks.get('secretsExcluded', False)}`",
        f"- 临时数据剔除：`{checks.get('transientDataExcluded', False)}`",
        f"- Chromium Cookies 剔除：`{checks.get('cookiesDatabaseExcluded', False)}`",
        f"- 已脱敏 TikOmni raw 保留：`{checks.get('redactedTikomniRawPreserved', False)}`",
        f"- schema 迁移自动备份：`{checks.get('schemaMigrationBackupCreated', False)}`",
        f"- 损坏包拒绝：`{checks.get('corruptionRejected', False)}`",
        f"- 重算 manifest 攻击拒绝：`{checks.get('recomputedManifestAttackRejected', False)}`",
        f"- 错误代码：`{report.get('error_code', 'none')}`",
        "",
    ])


def write_report(report_dir: Path, report: dict[str, Any]) -> tuple[Path, Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    json_path = report_dir / "echo-founder-packaged-backup-restore-smoke.json"
    markdown_path = report_dir / "echo-founder-packaged-backup-restore-smoke.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify packaged Echo Founder project backup and restore")
    parser.add_argument("--app-path", type=Path, default=DEFAULT_APP)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()

    report: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "failed",
        "app": args.app_path.name,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        report["checks"] = run_packaged_smoke(args.app_path, args.timeout)
        report["status"] = "pass"
    except Exception as exc:  # pragma: no cover - exercised by package gate
        report.update(safe_failure_record(exc))
    json_path, markdown_path = write_report(args.report_dir, report)
    print(f"status={report['status']}")
    print(f"report_json={json_path}")
    print(f"report_markdown={markdown_path}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
