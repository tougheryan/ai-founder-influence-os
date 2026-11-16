#!/usr/bin/env python3
"""Run the Echo Founder commercial-readiness gates and emit redacted evidence.

The gate deliberately separates reproducible automated evidence from the real
account acceptance record.  A green source/build run must never be presented as
proof that WeChat, Xiaohongshu, Moments, or TikOmni credentials were exercised.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
UI_ROOT = REPO_ROOT / "ui"
DEFAULT_REPORT_DIR = REPO_ROOT / "quality" / "system-audits"
PRODUCT = "Echo Founder"
VERSION = "0.2.0-beta.2"
TARGET = "macOS 13+ / Apple Silicon"
REQUIRED_ACCEPTANCE_EVIDENCE = frozenset(
    {
        "clean-install",
        "credential-keychain-restart",
        "material-import",
        "three-platform-tikomni-research",
        "three-archetype-platform-native-production",
        "paid-image-provider-benchmark",
        "tikomni-hit-ranking-calibration",
        "visual-ai-default",
        "platform-draft-fill",
        "frozen-dmg-runtime",
        "fault-recovery",
        "backup-restore",
    }
)
REQUIRED_FAULT_SCENARIOS = frozenset(
    {
        "network-offline",
        "invalid-token",
        "browser-not-authenticated",
        "captcha-or-device-confirmation",
        "service-exit",
        "application-restart",
        "cross-run-write",
    }
)

SECRET_KEY_NAMES = (
    r"authorization(?:Header)?|proxyAuthorization|authHeader|"
    r"api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|"
    r"auth[_-]?token|authToken|bearer[_-]?token|bearerToken|pairing[_-]?token|pairingToken|"
    r"session[_-]?(?:token|secret)|sessionToken|sessionSecret|gatewaySession|"
    r"cookie(?:Header)?|setCookie|private[_-]?key|privateKey|"
    r"app[_-]?secret|appSecret|client[_-]?secret|clientSecret|signingSecret|webhookSecret|"
    r"demoUnlockCode|secret|password|passwd"
)
SAFE_REDACTION_SENTINELS = frozenset({"", "[REDACTED]", "[已脱敏]", "<REDACTED>"})
QUOTED_SECRET_PATTERNS = (
    re.compile(
        rf"((?:[\"']?)(?:{SECRET_KEY_NAMES})(?:[\"']?)\s*[:=]\s*\")([^\"\r\n]*)(\")",
        re.IGNORECASE,
    ),
    re.compile(
        rf"((?:[\"']?)(?:{SECRET_KEY_NAMES})(?:[\"']?)\s*[:=]\s*')([^'\r\n]*)(')",
        re.IGNORECASE,
    ),
)
SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"),
    re.compile(
        rf"(?i)(\b(?:{SECRET_KEY_NAMES})\b\s*[:=]\s*(?:(?:bearer|basic)\s+)?)([^\s,;\]}}]+)"
    ),
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MAX_ACCEPTANCE_EVIDENCE_BYTES = 2 * 1024 * 1024
MAX_ACCEPTANCE_ENVELOPE_BYTES = 2 * 1024 * 1024
TEXT_EVIDENCE_SUFFIXES = frozenset({".csv", ".html", ".json", ".log", ".md", ".txt", ".xml", ".yaml", ".yml"})
PRIVATE_PATH_RE = re.compile(
    r"(?<![\w:])(?:/Users/|/home/|/private/tmp(?:/|$)|/private/var/folders/|/Volumes/)"
    r"[^\r\n\"'`<>]*"
)
ACCEPTANCE_SCHEMA = "echo-founder.real-account-acceptance.v3"
EVIDENCE_SCHEMA = "echo-founder.acceptance-evidence.v3"
FAULT_EVIDENCE_SCHEMA = "echo-founder.fault-evidence.v3"
DOMAIN_ARTIFACT_SCHEMA = "echo-founder.acceptance-domain-artifact.v1"
FAULT_ARTIFACT_SCHEMA = "echo-founder.acceptance-fault-artifact.v1"
ATTESTATION_ALGORITHM = "openssl-dgst-sha256"
DMG_FILENAME = f"Echo-Founder-{VERSION}-mac-arm64.dmg"
DMG_MANIFEST_FILENAME = f"Echo-Founder-{VERSION}-mac-arm64.manifest.json"
PACKAGE_MANIFEST_FILENAME = f"Echo-Founder-{VERSION}-mac-arm64.package-manifest.json"
CHECKSUM_FILENAME = f"{DMG_FILENAME}.sha256"
TRUSTED_QA_KEY_REGISTRY = REPO_ROOT / "quality" / "acceptance" / "trusted-qa-public-keys.json"
TRUSTED_QA_KEY_REGISTRY_SCHEMA = "echo-founder.trusted-qa-public-keys.v1"
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SAFE_EVIDENCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$")
REQUIRED_ARTIFACT_ROLE_AND_PRODUCER: dict[str, tuple[str, str]] = {
    "clean-install": ("dmg-open-smoke-report", "desktop-dmg-open-smoke"),
    "credential-keychain-restart": ("credential-restart-report", "credential-vault"),
    "material-import": ("material-intake-report", "material-intake"),
    "three-platform-tikomni-research": ("tikomni-market-snapshot", "tikomni-market-gate"),
    "three-archetype-platform-native-production": ("platform-native-acceptance-manifest", "content-runtime"),
    "paid-image-provider-benchmark": ("paid-image-benchmark-manifest", "image-provider-benchmark"),
    "tikomni-hit-ranking-calibration": ("tikomni-calibration-report", "tikomni-calibration"),
    "visual-ai-default": ("visual-default-decision", "visual-workbench"),
    "platform-draft-fill": ("platform-draft-receipts", "publication-bridge"),
    "frozen-dmg-runtime": ("frozen-dmg-runtime-report", "desktop-release-assessment"),
    "fault-recovery": ("fault-recovery-summary", "fault-harness"),
    "backup-restore": ("backup-restore-report", "project-backup"),
}
REQUIRED_EVIDENCE_ASSERTIONS: dict[str, dict[str, object]] = {
    "clean-install": {
        "installed_from_dmg": True,
        "launched_without_developer_toolchain": True,
        "default_first_launch_completed": True,
    },
    "credential-keychain-restart": {
        "model_configured": True,
        "tikomni_configured": True,
        "image_credential_groups": 6,
        "restart_recovered_status": True,
        "renderer_cannot_read_raw_secret": True,
    },
    "material-import": {
        "authorized_material_used": True,
        "successful_files_preserved": True,
        "failed_file_isolated": True,
    },
    "three-platform-tikomni-research": {
        "wechat_live": True,
        "xiaohongshu_live": True,
        "shipinhao_live": True,
        "evidence_gate_passed": True,
    },
    "three-archetype-platform-native-production": {
        "archetype_runs": 3,
        "wechat_lanes": 3,
        "xiaohongshu_lanes": 3,
        "shipinhao_lanes": 3,
        "xhs_p1_p8_sets": 3,
        "shipinhao_static_visual_jobs": 0,
        "cross_platform_mother_draft_used": False,
        "quality_gate_passed": True,
    },
    "paid-image-provider-benchmark": {
        "credential_groups": 6,
        "paid_routes": 10,
        "top_three_routes": 3,
        "primary_score_at_least_85": True,
        "backup_failover_passed": True,
        "budget_cny_at_most_100": True,
    },
    "tikomni-hit-ranking-calibration": {
        "sample_count_at_least_45": True,
        "each_platform_at_least_15": True,
        "invalid_evidence_false_hits": 0,
        "verified_hit_precision_at_least_90_percent": True,
    },
    "visual-ai-default": {
        "benchmark_bound": True,
        "all_human_visual_reviews_accepted": True,
        "ai_enhanced_default": True,
        "stable_mode_available": True,
        "stable_mode_auto_fallback": True,
    },
    "platform-draft-fill": {
        "wechat_drafts": 3,
        "xiaohongshu_drafts": 3,
        "shipinhao_drafts": 3,
        "total_drafts": 9,
        "no_public_send": True,
        "payload_hashes_bound": True,
    },
    "frozen-dmg-runtime": {
        "frozen_before_real_account_acceptance": True,
        "not_rebuilt_after_acceptance": True,
        "minimal_environment_passed": True,
        "restart_and_service_recovery_passed": True,
        "single_instance_passed": True,
        "backup_restore_passed": True,
        "soak_passed": True,
    },
    "fault-recovery": {
        "all_required_scenarios_passed": True,
        "state_recovered": True,
        "no_cross_run_write": True,
    },
    "backup-restore": {
        "restored_to_new_directory": True,
        "manifest_checksums_verified": True,
        "credentials_absent": True,
        "account_sessions_absent": True,
    },
}


@dataclass(frozen=True)
class GateStep:
    label: str
    command: tuple[str, ...]
    cwd: Path = REPO_ROOT
    timeout: int | None = 600


@dataclass(frozen=True)
class VerifiedReference:
    path: Path
    content: bytes


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def redact(value: str) -> str:
    """Remove secrets and machine-specific absolute roots from report output."""
    text = value.replace(str(REPO_ROOT), "<REPO_ROOT>")
    home = str(Path.home())
    if home and home != "/":
        text = text.replace(home, "<USER_HOME>")
    for pattern in QUOTED_SECRET_PATTERNS:
        text = pattern.sub(
            lambda match: (
                match.group(0)
                if match.group(2).strip() in SAFE_REDACTION_SENTINELS
                else f"{match.group(1)}<REDACTED>{match.group(3)}"
            ),
            text,
        )
    for pattern in SECRET_PATTERNS:
        text = pattern.sub(
            lambda match: (
                match.group(0)
                if match.lastindex and match.lastindex >= 2 and match.group(2).strip() in SAFE_REDACTION_SENTINELS
                else (f"{match.group(1)}<REDACTED>" if match.lastindex else "<REDACTED>")
            ),
            text,
        )
    text = PRIVATE_PATH_RE.sub("<PRIVATE_PATH>", text)
    return text


def electron_test_files() -> tuple[str, ...]:
    return tuple(str(path.relative_to(UI_ROOT)) for path in sorted((UI_ROOT / "electron").glob("*.test.cjs")))


def source_steps() -> list[GateStep]:
    electron_tests = electron_test_files()
    steps = [
        GateStep("production-dependency-audit", ("npm", "audit", "--omit=dev", "--audit-level=high"), cwd=UI_ROOT),
        GateStep("python-tests", (sys.executable, "-m", "pytest", "-q"), timeout=1200),
        GateStep(
            "desktop-build-tests",
            (sys.executable, "-m", "pytest", "-q", "scripts/tests"),
            timeout=1200,
        ),
        GateStep("runtime-contracts", (sys.executable, "scripts/check_runtime_contracts.py")),
        GateStep("commercial-capability-matrix", (sys.executable, "scripts/check_commercial_matrix.py")),
        GateStep("content-production-loop", (sys.executable, "scripts/check_content_production_loop.py")),
        GateStep("ui-runtime-gates", (sys.executable, "scripts/check_ui_runtime_gates.py")),
        GateStep("ui-unit-tests", ("npm", "test"), cwd=UI_ROOT, timeout=1200),
        GateStep("typescript", ("npm", "exec", "tsc", "--", "--noEmit"), cwd=UI_ROOT, timeout=600),
        GateStep("eslint-zero-warnings", ("npm", "run", "lint", "--", "--max-warnings=0"), cwd=UI_ROOT, timeout=600),
        GateStep("next-production-build", ("npm", "run", "build"), cwd=UI_ROOT, timeout=1800),
        GateStep("electron-static-check", ("npm", "run", "desktop:check"), cwd=UI_ROOT),
    ]
    if electron_tests:
        steps.append(GateStep("electron-tests", ("node", "--test", *electron_tests), cwd=UI_ROOT, timeout=1200))
    return steps


def desktop_steps(
    *,
    soak_seconds: int,
    require_clean_source: bool = False,
    build_artifacts: bool = True,
) -> list[GateStep]:
    steps: list[GateStep] = []
    if build_artifacts:
        steps.append(GateStep(
            "arm64-package",
            ("make", "desktop-package", "DESKTOP_PACKAGE_ARCH=arm64", "DESKTOP_EMBED_PYTHON_RUNTIME=required"),
            timeout=3600,
        ))
    steps.extend([
        GateStep(
            "package-traceability",
            (
                "make",
                "desktop-package-traceability",
                *(("REQUIRE_CLEAN_SOURCE=1",) if require_clean_source else ()),
            ),
            timeout=180,
        ),
    ])
    if build_artifacts:
        steps.append(GateStep("arm64-dmg", ("make", "desktop-dmg", "DESKTOP_PACKAGE_ARCH=arm64"), timeout=1200))
    steps.extend([
        GateStep(
            "arm64-minimal-environment-smoke",
            (
                "make",
                "desktop-packaged-smoke",
                "DESKTOP_PACKAGED_MINIMAL_ENV=1",
                "DESKTOP_PACKAGED_EXPECTED_ARCH=arm64",
            ),
            timeout=420,
        ),
        GateStep("desktop-open-smoke", ("make", "desktop-packaged-open-smoke"), timeout=420),
        GateStep("desktop-single-instance-smoke", ("make", "desktop-packaged-single-instance-smoke"), timeout=420),
        GateStep("desktop-service-recovery-smoke", ("make", "desktop-packaged-recovery-smoke"), timeout=480),
        GateStep("desktop-backup-restore-smoke", ("make", "desktop-packaged-backup-restore-smoke"), timeout=240),
        GateStep("desktop-watchdog-smoke", ("make", "desktop-packaged-watchdog-smoke"), timeout=480),
        GateStep("dmg-verify", ("make", "desktop-dmg-verify", "DESKTOP_PACKAGE_ARCH=arm64"), timeout=600),
        GateStep("dmg-install-smoke", ("make", "desktop-dmg-smoke", "DESKTOP_PACKAGE_ARCH=arm64"), timeout=480),
        GateStep("dmg-open-smoke", ("make", "desktop-dmg-open-smoke", "DESKTOP_PACKAGE_ARCH=arm64"), timeout=480),
        GateStep(
            "desktop-soak",
            (
                "make",
                "desktop-packaged-soak",
                f"DESKTOP_PACKAGED_SOAK_DURATION={soak_seconds}",
                "DESKTOP_PACKAGED_MINIMAL_ENV=1",
            ),
            timeout=soak_seconds + 300,
        ),
        GateStep("desktop-release-assessment", ("make", "desktop-release-assessment"), timeout=600),
    ])
    return steps


def selected_steps(
    mode: str,
    soak_seconds: int,
    *,
    require_clean_source: bool = False,
    build_artifacts: bool = True,
) -> list[GateStep]:
    steps = source_steps()
    if mode == "full":
        steps.extend(desktop_steps(
            soak_seconds=soak_seconds,
            require_clean_source=require_clean_source,
            build_artifacts=build_artifacts,
        ))
    return steps


def run_step(step: GateStep, env: dict[str, str]) -> dict[str, Any]:
    started = time.monotonic()
    print(f"RUN {step.label}: {' '.join(step.command)}", flush=True)
    try:
        completed = subprocess.run(
            step.command,
            cwd=step.cwd,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=step.timeout,
            check=False,
        )
        output = completed.stdout or ""
        return {
            "label": step.label,
            "status": "pass" if completed.returncode == 0 else "fail",
            "returncode": completed.returncode,
            "duration_seconds": round(time.monotonic() - started, 3),
            "command": [redact(part) for part in step.command],
            "output_tail": redact(output[-12000:]),
        }
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout if isinstance(exc.stdout, str) else ""
        return {
            "label": step.label,
            "status": "fail",
            "returncode": None,
            "duration_seconds": round(time.monotonic() - started, 3),
            "command": [redact(part) for part in step.command],
            "output_tail": redact(output[-12000:]),
            "error": f"timeout after {step.timeout}s",
        }


def source_cleanliness_result(label: str = "formal-source-cleanliness") -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    entries = [line for line in completed.stdout.splitlines() if line.strip()]
    clean = completed.returncode == 0 and not entries
    return {
        "label": label,
        "status": "pass" if clean else "fail",
        "returncode": 0 if clean else (completed.returncode or 1),
        "duration_seconds": round(time.monotonic() - started, 3),
        "command": ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        "output_tail": (
            "clean tracked and untracked source tree"
            if clean
            else f"source tree is dirty; entry_count={len(entries)}; status_sha256="
            + hashlib.sha256(completed.stdout.encode("utf-8")).hexdigest()
        ),
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_acceptance_bytes(payload: dict[str, Any]) -> bytes:
    """Canonical bytes covered by the out-of-band QA signature."""
    unsigned = copy.deepcopy(payload)
    attestation = unsigned.get("attestation")
    if isinstance(attestation, dict):
        attestation.pop("signature_base64", None)
    return json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def verify_acceptance_signature(
    payload: dict[str, Any],
    trusted_public_key: Path | None,
    trusted_key_registry: Path | None,
    validation_errors: list[str],
) -> None:
    """Verify a QA signature against a public key supplied outside the record."""
    if trusted_public_key is None:
        validation_errors.append("an out-of-band --acceptance-public-key is required")
        return
    attestation = payload.get("attestation")
    if not isinstance(attestation, dict):
        validation_errors.append("attestation metadata is required")
        return
    if attestation.get("algorithm") != ATTESTATION_ALGORITHM:
        validation_errors.append(f"attestation.algorithm must equal {ATTESTATION_ALGORITHM}")
    signature_text = str(attestation.get("signature_base64") or "")
    try:
        signature = base64.b64decode(signature_text, validate=True)
    except (ValueError, TypeError):
        signature = b""
    if not 48 <= len(signature) <= 16 * 1024:
        validation_errors.append("attestation.signature_base64 is missing or invalid")
        return

    try:
        cursor = Path(trusted_public_key).expanduser()
        for parent in (cursor, *cursor.parents):
            if parent.exists() and parent.is_symlink():
                raise ValueError("symbolic links are not accepted for the trusted public key")
        resolved = cursor.resolve(strict=True)
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 64 <= info.st_size <= 64 * 1024:
            raise ValueError("trusted public key must be a small single-link regular file")
        key_bytes = resolved.read_bytes()
    except (OSError, ValueError) as exc:
        validation_errors.append(f"trusted public key is invalid: {exc}")
        return

    key_sha256 = hashlib.sha256(key_bytes).hexdigest()
    if attestation.get("trusted_public_key_sha256") != key_sha256:
        validation_errors.append("attestation is not bound to the supplied trusted public key")
        return
    key_id = str(attestation.get("key_id") or "")
    registry_path = trusted_key_registry or TRUSTED_QA_KEY_REGISTRY
    try:
        if registry_path.is_symlink():
            raise ValueError("symbolic links are not accepted for the QA key registry")
        registry_info = registry_path.stat()
        if not stat.S_ISREG(registry_info.st_mode) or registry_info.st_nlink != 1 or registry_info.st_size > 256 * 1024:
            raise ValueError("QA key registry must be a small single-link regular file")
        registry_bytes = registry_path.read_bytes()
        registry = json.loads(registry_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        validation_errors.append(f"trusted QA key registry is invalid: {exc}")
        return
    registry_sha256 = hashlib.sha256(registry_bytes).hexdigest()
    if attestation.get("registry_sha256") != registry_sha256:
        validation_errors.append("attestation is not bound to the trusted QA key registry")
        return
    try:
        is_production_registry = registry_path.resolve(strict=True) == TRUSTED_QA_KEY_REGISTRY.resolve(strict=True)
    except OSError:
        is_production_registry = False
    if is_production_registry:
        relative_registry = TRUSTED_QA_KEY_REGISTRY.relative_to(REPO_ROOT).as_posix()
        tracked = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", relative_registry],
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        committed = subprocess.run(
            ["git", "show", f"HEAD:{relative_registry}"],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if tracked.returncode != 0 or committed.returncode != 0 or committed.stdout != registry_bytes:
            validation_errors.append("trusted QA key registry must exactly match its tracked HEAD blob")
            return
    registry_keys = registry.get("keys") if isinstance(registry, dict) else None
    approved = [
        row for row in (registry_keys if isinstance(registry_keys, list) else []) if isinstance(row, dict)
        and row.get("status") == "active"
        and row.get("key_id") == key_id
        and row.get("public_key_sha256") == key_sha256
        and str(row.get("organization") or "").strip()
    ]
    if registry.get("schema") != TRUSTED_QA_KEY_REGISTRY_SCHEMA or len(approved) != 1:
        validation_errors.append("acceptance public key is not an active pre-approved QA trust anchor")
        return
    openssl = shutil.which("openssl")
    if not openssl:
        validation_errors.append("openssl is required to verify the acceptance signature")
        return
    try:
        with tempfile.TemporaryDirectory(prefix="echo-founder-acceptance-signature-") as temporary:
            temporary_root = Path(temporary)
            copied_key = temporary_root / "trusted-public-key.pem"
            signature_path = temporary_root / "acceptance.sig"
            copied_key.write_bytes(key_bytes)
            signature_path.write_bytes(signature)
            copied_key.chmod(0o600)
            signature_path.chmod(0o600)
            completed = subprocess.run(
                [openssl, "dgst", "-sha256", "-verify", str(copied_key), "-signature", str(signature_path)],
                input=canonical_acceptance_bytes(payload),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=30,
                check=False,
            )
    except (OSError, subprocess.SubprocessError) as exc:
        validation_errors.append(f"acceptance signature verification could not run: {exc}")
        return
    if completed.returncode != 0:
        validation_errors.append("acceptance signature verification failed")


def verify_release_binding(
    payload: dict[str, Any],
    release_root: Path,
    validation_errors: list[str],
    current_source_sha: str | None = None,
) -> dict[str, str]:
    """Bind human evidence to the exact clean package and DMG under test."""
    build = payload.get("build")
    if not isinstance(build, dict):
        validation_errors.append("build binding is required")
        return {}
    expected_fields = {
        "source_git_sha": GIT_SHA_RE,
        "package_manifest_sha256": SHA256_RE,
        "dmg_manifest_sha256": SHA256_RE,
        "dmg_sha256": SHA256_RE,
        "qa_key_registry_sha256": SHA256_RE,
    }
    for field, pattern in expected_fields.items():
        if not pattern.fullmatch(str(build.get(field) or "")):
            validation_errors.append(f"build.{field} is invalid")

    release_root = release_root.expanduser().resolve()
    package_path = release_root / PACKAGE_MANIFEST_FILENAME
    dmg_manifest_path = release_root / DMG_MANIFEST_FILENAME
    dmg_path = release_root / DMG_FILENAME
    checksum_path = release_root / CHECKSUM_FILENAME
    try:
        for candidate in (package_path, dmg_manifest_path, dmg_path, checksum_path):
            if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_nlink != 1:
                raise ValueError(f"release artifact is missing or unsafe: {candidate.name}")
        package_bytes = package_path.read_bytes()
        dmg_manifest_bytes = dmg_manifest_path.read_bytes()
        package = json.loads(package_bytes)
        dmg_manifest = json.loads(dmg_manifest_bytes)
        actual_dmg_sha256 = sha256_file(dmg_path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        validation_errors.append(f"release binding is invalid: {exc}")
        return {}
    if not isinstance(package, dict) or not isinstance(dmg_manifest, dict):
        validation_errors.append("release manifests must be JSON objects")
        return {}

    package_sha256 = hashlib.sha256(package_bytes).hexdigest()
    dmg_manifest_sha256 = hashlib.sha256(dmg_manifest_bytes).hexdigest()
    if build.get("package_manifest_sha256") != package_sha256:
        validation_errors.append("build.package_manifest_sha256 does not match the release package manifest")
    if build.get("dmg_manifest_sha256") != dmg_manifest_sha256:
        validation_errors.append("build.dmg_manifest_sha256 does not match the release DMG manifest")
    if build.get("dmg_sha256") != actual_dmg_sha256:
        validation_errors.append("build.dmg_sha256 does not match the release DMG")

    source = package.get("source_control")
    if (
        not isinstance(source, dict)
        or source.get("schema") != "echo-founder.source-control-trace.v1"
        or source.get("dirty") is not False
        or source.get("current_sha") != build.get("source_git_sha")
    ):
        validation_errors.append("release package manifest is not bound to the declared clean Git commit")
    if current_source_sha is not None and build.get("source_git_sha") != current_source_sha:
        validation_errors.append("accepted release Git commit does not match the source running the formal gate")
    if package.get("product") != PRODUCT or package.get("version") != VERSION:
        validation_errors.append("release package manifest product or version does not match")
    packaged_registry = package.get("trusted_qa_key_registry")
    if (
        not isinstance(packaged_registry, dict)
        or packaged_registry.get("schema") != TRUSTED_QA_KEY_REGISTRY_SCHEMA
        or packaged_registry.get("path") != "quality/acceptance/trusted-qa-public-keys.json"
        or packaged_registry.get("sha256") != build.get("qa_key_registry_sha256")
        or not isinstance(packaged_registry.get("key_count"), int)
    ):
        validation_errors.append("release package manifest is not bound to the pre-approved QA key registry")

    binding = dmg_manifest.get("package_manifest")
    if (
        dmg_manifest.get("status") != "packed"
        or dmg_manifest.get("artifact") != "dmg"
        or dmg_manifest.get("product") != PRODUCT
        or dmg_manifest.get("version") != VERSION
        or dmg_manifest.get("architecture") != "arm64"
        or dmg_manifest.get("sha256") != actual_dmg_sha256
        or not isinstance(binding, dict)
        or binding.get("schema") != "echo-founder.package-manifest-binding.v1"
        or binding.get("sha256") != package_sha256
    ):
        validation_errors.append("release DMG manifest is not bound to the current arm64 package and DMG")
    try:
        checksum_parts = checksum_path.read_text(encoding="ascii").strip().split()
    except (OSError, UnicodeDecodeError):
        checksum_parts = []
    if checksum_parts != [actual_dmg_sha256, DMG_FILENAME]:
        validation_errors.append("release DMG checksum sidecar does not match")
    return {
        "source_git_sha": str(build.get("source_git_sha") or ""),
        "package_manifest_sha256": package_sha256,
        "dmg_manifest_sha256": dmg_manifest_sha256,
        "dmg_sha256": actual_dmg_sha256,
    }


def load_acceptance(
    path: Path | None,
    *,
    trusted_public_key: Path | None = None,
    trusted_key_registry: Path | None = None,
    release_root: Path | None = None,
    current_source_sha: str | None = None,
) -> dict[str, Any]:
    """Validate historical v3 evidence; this is not current release eligibility."""
    if path is None:
        return {"status": "pending", "reason": "real-account acceptance record not supplied"}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"status": "invalid", "reason": redact(str(exc))}
    if not isinstance(payload, dict):
        return {"status": "invalid", "reason": "acceptance record must be an object"}
    if isinstance(payload, dict) and payload.get("schema") == "echo-founder.real-account-acceptance.v2":
        return {
            "status": "legacy_read_only",
            "reason": "v2 验收记录可读取归档，但不能通过 0.2.0-beta.2 正式商业门禁",
            "record": redact(str(path.resolve())),
        }
    required = {
        "schema": ACCEPTANCE_SCHEMA,
        "status": "pass",
        "product_version": VERSION,
        "target": TARGET,
    }
    mismatches = [key for key, value in required.items() if payload.get(key) != value]
    evidence = payload.get("evidence")
    evidence_items = evidence if isinstance(evidence, list) else []
    evidence_kinds = {
        str(item.get("kind"))
        for item in evidence_items
        if isinstance(item, dict) and item.get("result") == "pass"
    }
    kind_counts: dict[str, int] = {}
    for item in evidence_items:
        if isinstance(item, dict):
            kind = str(item.get("kind") or "")
            kind_counts[kind] = kind_counts.get(kind, 0) + 1
    missing_evidence = sorted(REQUIRED_ACCEPTANCE_EVIDENCE - evidence_kinds)
    duplicate_evidence = sorted(kind for kind, count in kind_counts.items() if kind and count != 1)
    fault_scenarios: set[str] = set()
    for item in evidence_items:
        if not isinstance(item, dict) or item.get("kind") != "fault-recovery":
            continue
        scenarios = item.get("scenarios")
        if isinstance(scenarios, list):
            fault_scenarios.update(
                str(scenario.get("name"))
                for scenario in scenarios
                if isinstance(scenario, dict) and scenario.get("result") == "pass"
            )
    missing_fault_scenarios = sorted(REQUIRED_FAULT_SCENARIOS - fault_scenarios)
    reviewer = payload.get("reviewer")
    machine = payload.get("machine")
    run = payload.get("run")
    accepted_at = payload.get("accepted_at")
    validation_errors: list[str] = []
    release_binding = verify_release_binding(
        payload,
        release_root or (REPO_ROOT / "dist"),
        validation_errors,
        current_source_sha=current_source_sha,
    )
    verify_acceptance_signature(payload, trusted_public_key, trusted_key_registry, validation_errors)
    attestation = payload.get("attestation")
    build_binding = payload.get("build")
    if (
        not isinstance(attestation, dict)
        or not isinstance(build_binding, dict)
        or attestation.get("registry_sha256") != build_binding.get("qa_key_registry_sha256")
    ):
        validation_errors.append("acceptance signature registry does not match the registry frozen into the release build")
    try:
        accepted_timestamp = datetime.fromisoformat(str(accepted_at).replace("Z", "+00:00"))
        if accepted_timestamp.tzinfo is None:
            raise ValueError("timezone is required")
    except (TypeError, ValueError):
        validation_errors.append("accepted_at must be a timezone-aware ISO-8601 timestamp")

    if not isinstance(reviewer, dict) or not str(reviewer.get("name") or "").strip():
        validation_errors.append("reviewer.name is required")
    else:
        if not str(reviewer.get("organization") or "").strip():
            validation_errors.append("reviewer.organization is required")
        if not SAFE_EVIDENCE_ID_RE.fullmatch(str(reviewer.get("review_id") or "")):
            validation_errors.append("reviewer.review_id is required")
        if reviewer.get("independent_from_implementation") is not True:
            validation_errors.append("reviewer.independent_from_implementation must be true")
        if reviewer.get("confirmed_no_secrets") is not True:
            validation_errors.append("reviewer.confirmed_no_secrets must be true")
        if reviewer.get("confirmed_no_public_send") is not True:
            validation_errors.append("reviewer.confirmed_no_public_send must be true")

    try:
        macos_major = int(machine.get("macos_major", 0) or 0) if isinstance(machine, dict) else 0
    except (TypeError, ValueError):
        macos_major = 0
    if not isinstance(machine, dict):
        validation_errors.append("machine metadata is required")
    else:
        if machine.get("architecture") != "arm64" or macos_major < 13:
            validation_errors.append("machine must be macOS 13+ on arm64")
        if not str(machine.get("model") or "").strip() or not str(machine.get("macos_version") or "").strip():
            validation_errors.append("machine model and full macOS version are required")
        if machine.get("clean_machine") is not True:
            validation_errors.append("machine.clean_machine must be true")
        if not SAFE_EVIDENCE_ID_RE.fullmatch(str(machine.get("acceptance_machine_id") or "")):
            validation_errors.append("machine.acceptance_machine_id is required")
        for field in ("node_preinstalled", "python_preinstalled", "homebrew_preinstalled"):
            if machine.get(field) is not False:
                validation_errors.append(f"machine.{field} must be false")

    if not isinstance(run, dict):
        validation_errors.append("run binding is required")
    else:
        for field in ("run_id", "slug"):
            value = str(run.get(field) or "")
            if not SAFE_RUN_ID_RE.fullmatch(value):
                validation_errors.append(f"run.{field} is missing or unsafe")
        if not SHA256_RE.fullmatch(str(run.get("project_backup_sha256") or "")):
            validation_errors.append("run.project_backup_sha256 must be a SHA-256 digest")
        archetype_run_ids = run.get("archetype_run_ids")
        for archetype in ("methodology", "founder_story", "research_analysis"):
            if not isinstance(archetype_run_ids, dict) or not SAFE_RUN_ID_RE.fullmatch(str(archetype_run_ids.get(archetype) or "")):
                validation_errors.append(f"run.archetype_run_ids.{archetype} is missing or unsafe")

    evidence_root = path.resolve().parent
    referenced_paths: set[str] = set()

    def verify_reference(item: dict[str, Any], label: str) -> VerifiedReference | None:
        digest = str(item.get("sha256") or "").lower()
        relative = item.get("path")
        if not SHA256_RE.fullmatch(digest):
            validation_errors.append(f"{label}.sha256 must be a lowercase SHA-256 digest")
            return None
        if not isinstance(relative, str) or not relative or "\\" in relative:
            validation_errors.append(f"{label}.path must be a safe relative path")
            return None
        relative_path = Path(relative)
        if relative_path.is_absolute() or any(part in ("", ".", "..") for part in relative_path.parts):
            validation_errors.append(f"{label}.path must be a safe relative path")
            return None
        key = relative_path.as_posix().casefold()
        if key in referenced_paths:
            validation_errors.append(f"{label}.path is duplicated")
            return None
        referenced_paths.add(key)
        candidate = evidence_root.joinpath(*relative_path.parts)
        cursor = evidence_root
        try:
            for part in relative_path.parts:
                cursor = cursor / part
                if cursor.is_symlink():
                    raise ValueError("symbolic links are not accepted")
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(evidence_root)
            flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(candidate, flags)
            try:
                before = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or before.st_nlink != 1
                    or before.st_uid != os.getuid()
                    or before.st_size <= 0
                    or before.st_size > MAX_ACCEPTANCE_EVIDENCE_BYTES
                ):
                    raise ValueError("evidence must be an owned single-link regular file within the size limit")
                chunks: list[bytes] = []
                remaining = before.st_size
                while remaining:
                    chunk = os.read(descriptor, min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                raw = b"".join(chunks)
                after = os.fstat(descriptor)
                before_identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_nlink)
                after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_nlink)
                if before_identity != after_identity or len(raw) != before.st_size:
                    raise ValueError("evidence changed while it was being verified")
            finally:
                os.close(descriptor)
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError("evidence checksum does not match")
            if resolved.suffix.lower() in TEXT_EVIDENCE_SUFFIXES:
                text_content = raw.decode("utf-8", errors="replace")
                if redact(text_content) != text_content or PRIVATE_PATH_RE.search(text_content):
                    raise ValueError("text evidence contains an unredacted secret or private local path")
            return VerifiedReference(resolved, raw)
        except (OSError, RuntimeError, ValueError) as exc:
            validation_errors.append(f"{label} is invalid: {exc}")
            return None

    def aware_evidence_time(value: object, label: str) -> None:
        try:
            timestamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                raise ValueError("timezone is required")
        except (TypeError, ValueError):
            validation_errors.append(f"{label}.captured_at must be a timezone-aware ISO-8601 timestamp")

    def verify_domain_artifact(resolved: VerifiedReference | None, kind: str, expected_role: str, label: str) -> None:
        if resolved is None:
            return
        try:
            if resolved.path.suffix.lower() != ".json" or len(resolved.content) > MAX_ACCEPTANCE_ENVELOPE_BYTES:
                raise ValueError("domain artifact must be a small JSON file")
            artifact = json.loads(resolved.content)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            validation_errors.append(f"{label} domain artifact is invalid: {exc}")
            return
        expected_producer = REQUIRED_ARTIFACT_ROLE_AND_PRODUCER[kind][1]
        if not isinstance(artifact, dict):
            validation_errors.append(f"{label} domain artifact must be an object")
            return
        if (
            artifact.get("schema") != DOMAIN_ARTIFACT_SCHEMA
            or artifact.get("kind") != kind
            or artifact.get("role") != expected_role
            or artifact.get("producer") != expected_producer
            or artifact.get("result") != "pass"
        ):
            validation_errors.append(f"{label} domain schema, role, producer, kind, or result does not match")
        aware_evidence_time(artifact.get("captured_at"), label)
        if not isinstance(run, dict) or artifact.get("run_id") != run.get("run_id") or artifact.get("slug") != run.get("slug"):
            validation_errors.append(f"{label} domain artifact is not bound to the accepted run and slug")
        if not SAFE_EVIDENCE_ID_RE.fullmatch(str(artifact.get("evidence_id") or "")):
            validation_errors.append(f"{label}.evidence_id is missing or unsafe")
        if not SHA256_RE.fullmatch(str(artifact.get("source_sha256") or "")):
            validation_errors.append(f"{label}.source_sha256 is required")
        facts = artifact.get("facts")
        if not isinstance(facts, dict):
            validation_errors.append(f"{label}.facts must be an object")
            facts = {}
        for assertion, expected in REQUIRED_EVIDENCE_ASSERTIONS[kind].items():
            if facts.get(assertion) != expected:
                validation_errors.append(f"{label}.facts.{assertion} must equal {expected!r}")

        if kind == "clean-install" and facts.get("dmg_sha256") != release_binding.get("dmg_sha256"):
            validation_errors.append(f"{label}.facts.dmg_sha256 must match the accepted DMG")
        if kind == "three-platform-tikomni-research":
            samples = artifact.get("platform_samples")
            for platform in ("wechat", "xiaohongshu", "shipinhao"):
                rows = samples.get(platform) if isinstance(samples, dict) else None
                if not isinstance(rows, list) or not rows:
                    validation_errors.append(f"{label}.platform_samples.{platform} must contain live evidence")
                    continue
                for row in rows:
                    url = str(row.get("url") or "") if isinstance(row, dict) else ""
                    if not url.startswith("https://") or not SHA256_RE.fullmatch(str(row.get("raw_sha256") or "")):
                        validation_errors.append(f"{label}.platform_samples.{platform} contains an invalid sample")
                        break
        if kind == "three-archetype-platform-native-production":
            runs = artifact.get("archetype_runs")
            expected_archetypes = {"methodology", "founder_story", "research_analysis"}
            seen_archetypes = set()
            for row in runs if isinstance(runs, list) else []:
                if not isinstance(row, dict):
                    continue
                archetype = str(row.get("archetype") or "")
                platforms = row.get("platforms") if isinstance(row.get("platforms"), dict) else {}
                valid_platforms = all(
                    isinstance(platforms.get(platform), dict)
                    and SHA256_RE.fullmatch(str(platforms[platform].get("content_sha256") or ""))
                    for platform in ("wechat", "xiaohongshu", "shipinhao")
                )
                if archetype in expected_archetypes and valid_platforms:
                    seen_archetypes.add(archetype)
            if seen_archetypes != expected_archetypes:
                validation_errors.append(f"{label}.archetype_runs must bind three independent three-platform productions")
        if kind == "paid-image-provider-benchmark":
            benchmark = artifact.get("benchmark")
            if not isinstance(benchmark, dict) or benchmark.get("schema_version") != "echo-founder.image-provider-benchmark.v1":
                validation_errors.append(f"{label}.benchmark must bind image-provider-benchmark.v1")
            else:
                selection = benchmark.get("selection") if isinstance(benchmark.get("selection"), dict) else {}
                budget = benchmark.get("budget_cny") if isinstance(benchmark.get("budget_cny"), dict) else {}
                if len(benchmark.get("routes") or []) != 10 or len(selection.get("top_three") or []) != 3:
                    validation_errors.append(f"{label}.benchmark must bind ten paid routes and three finalists")
                if not selection.get("primary") or not selection.get("backup") or selection.get("ai_enhanced_default_eligible") is not True:
                    validation_errors.append(f"{label}.benchmark must freeze an eligible primary and backup")
                if float(budget.get("actual") or budget.get("reserved") or 0) > 100:
                    validation_errors.append(f"{label}.benchmark exceeds the RMB 100 hard budget")
        if kind == "tikomni-hit-ranking-calibration":
            calibration = artifact.get("calibration")
            if not isinstance(calibration, dict) or calibration.get("score_version") != "echo-founder.tikomni-hit-score.v5":
                validation_errors.append(f"{label}.calibration must bind TikOmni hit-score v5")
            else:
                platform_counts = calibration.get("platform_counts")
                invalid_false_hits = calibration.get("invalid_evidence_false_hit_count")
                if (
                    int(calibration.get("sample_count") or 0) < 45
                    or not isinstance(platform_counts, dict)
                    or any(int(platform_counts.get(platform) or 0) < 15 for platform in ("wechat_mp", "xiaohongshu", "wechat_channels"))
                    or not isinstance(invalid_false_hits, int)
                    or isinstance(invalid_false_hits, bool)
                    or invalid_false_hits != 0
                    or float(calibration.get("verified_hit_precision") or 0) < 0.90
                    or calibration.get("passed") is not True
                ):
                    validation_errors.append(f"{label}.calibration does not meet the 45-sample precision gate")
        if kind == "visual-ai-default":
            if artifact.get("stable_fallback_verified") is not True or not SHA256_RE.fullmatch(str(artifact.get("benchmark_sha256") or "")):
                validation_errors.append(f"{label} must bind the benchmark and stable fallback evidence")
        if kind == "platform-draft-fill":
            platform_results = artifact.get("platform_results")
            for platform in ("wechat", "xiaohongshu", "shipinhao"):
                rows = platform_results.get(platform) if isinstance(platform_results, dict) else None
                if not isinstance(rows, list) or len(rows) != 3 or not all(
                    isinstance(row, dict)
                    and SAFE_EVIDENCE_ID_RE.fullmatch(str(row.get("attempt_id") or ""))
                    and SHA256_RE.fullmatch(str(row.get("payload_sha256") or ""))
                    and row.get("public_send") is False
                    for row in rows
                ):
                    validation_errors.append(f"{label}.platform_results.{platform} must bind three unpublished drafts")
        if kind == "frozen-dmg-runtime":
            if artifact.get("dmg_sha256") != release_binding.get("dmg_sha256") or artifact.get("rebuilt_after_acceptance") is not False:
                validation_errors.append(f"{label} must bind the unchanged frozen DMG")
        if kind == "backup-restore":
            if not isinstance(run, dict) or facts.get("backup_sha256") != run.get("project_backup_sha256"):
                validation_errors.append(f"{label}.facts.backup_sha256 must match the accepted project backup")

    def verify_artifacts(envelope: dict[str, Any], kind: str, label: str) -> None:
        artifacts = envelope.get("artifacts")
        expected_role = REQUIRED_ARTIFACT_ROLE_AND_PRODUCER[kind][0]
        if not isinstance(artifacts, list) or len(artifacts) != 1:
            validation_errors.append(f"{label}.artifacts must contain exactly one signed domain artifact")
            return
        for artifact_index, artifact in enumerate(artifacts):
            artifact_label = f"{label}.artifacts[{artifact_index}]"
            if not isinstance(artifact, dict) or artifact.get("role") != expected_role:
                validation_errors.append(f"{artifact_label}.role must equal {expected_role}")
                continue
            resolved = verify_reference(artifact, artifact_label)
            verify_domain_artifact(resolved, kind, expected_role, artifact_label)

    def verify_evidence_envelope(resolved: VerifiedReference | None, kind: str) -> None:
        if resolved is None:
            return
        label = f"evidence[{kind}]"
        try:
            if resolved.path.suffix.lower() != ".json" or len(resolved.content) > MAX_ACCEPTANCE_ENVELOPE_BYTES:
                raise ValueError("evidence envelope must be a small JSON file")
            envelope = json.loads(resolved.content)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            validation_errors.append(f"{label} envelope is invalid: {exc}")
            return
        if not isinstance(envelope, dict):
            validation_errors.append(f"{label} envelope must be an object")
            return
        if envelope.get("schema") != EVIDENCE_SCHEMA or envelope.get("kind") != kind or envelope.get("result") != "pass":
            validation_errors.append(f"{label} envelope schema, kind, or result does not match")
        aware_evidence_time(envelope.get("captured_at"), label)
        if not isinstance(run, dict) or envelope.get("run_id") != run.get("run_id") or envelope.get("slug") != run.get("slug"):
            validation_errors.append(f"{label} envelope is not bound to the accepted run and slug")
        if not SAFE_EVIDENCE_ID_RE.fullmatch(str(envelope.get("evidence_id") or "")):
            validation_errors.append(f"{label}.evidence_id is missing or unsafe")
        if len(str(envelope.get("observation") or "").strip()) < 12:
            validation_errors.append(f"{label}.observation must describe what was actually observed")
        assertions = envelope.get("assertions")
        if not isinstance(assertions, dict):
            validation_errors.append(f"{label}.assertions must be an object")
        else:
            for assertion, expected in REQUIRED_EVIDENCE_ASSERTIONS[kind].items():
                if assertions.get(assertion) != expected:
                    validation_errors.append(f"{label}.assertions.{assertion} must equal {expected!r}")
            if kind == "backup-restore" and isinstance(run, dict):
                if assertions.get("backup_sha256") != run.get("project_backup_sha256"):
                    validation_errors.append(f"{label}.assertions.backup_sha256 must match the accepted project backup")
        verify_artifacts(envelope, kind, label)

    def verify_fault_artifact(resolved: VerifiedReference | None, scenario_name: str, label: str) -> None:
        if resolved is None:
            return
        try:
            if resolved.path.suffix.lower() != ".json" or len(resolved.content) > MAX_ACCEPTANCE_ENVELOPE_BYTES:
                raise ValueError("fault artifact must be a small JSON file")
            artifact = json.loads(resolved.content)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            validation_errors.append(f"{label} fault artifact is invalid: {exc}")
            return
        if not isinstance(artifact, dict):
            validation_errors.append(f"{label} fault artifact must be an object")
            return
        if (
            artifact.get("schema") != FAULT_ARTIFACT_SCHEMA
            or artifact.get("scenario") != scenario_name
            or artifact.get("role") != "fault-state-transition"
            or artifact.get("producer") != "fault-harness"
            or artifact.get("result") != "pass"
        ):
            validation_errors.append(f"{label} fault artifact schema, scenario, producer, or result does not match")
        aware_evidence_time(artifact.get("captured_at"), label)
        if not isinstance(run, dict) or artifact.get("run_id") != run.get("run_id") or artifact.get("slug") != run.get("slug"):
            validation_errors.append(f"{label} fault artifact is not bound to the accepted run and slug")
        if not SAFE_EVIDENCE_ID_RE.fullmatch(str(artifact.get("event_id") or "")):
            validation_errors.append(f"{label}.event_id is required")
        for field in ("before_state_sha256", "after_state_sha256", "source_log_sha256"):
            if not SHA256_RE.fullmatch(str(artifact.get(field) or "")):
                validation_errors.append(f"{label}.{field} is required")
        if artifact.get("safe_outcome_observed") is not True or len(str(artifact.get("observation") or "").strip()) < 12:
            validation_errors.append(f"{label} must describe a safely observed state transition")

    def verify_fault_envelope(resolved: VerifiedReference | None, scenario_name: str) -> None:
        if resolved is None:
            return
        label = f"fault[{scenario_name}]"
        try:
            if resolved.path.suffix.lower() != ".json" or len(resolved.content) > MAX_ACCEPTANCE_ENVELOPE_BYTES:
                raise ValueError("fault envelope must be a small JSON file")
            envelope = json.loads(resolved.content)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            validation_errors.append(f"{label} envelope is invalid: {exc}")
            return
        if not isinstance(envelope, dict):
            validation_errors.append(f"{label} envelope must be an object")
            return
        if envelope.get("schema") != FAULT_EVIDENCE_SCHEMA or envelope.get("name") != scenario_name or envelope.get("result") != "pass":
            validation_errors.append(f"{label} envelope schema, name, or result does not match")
        aware_evidence_time(envelope.get("captured_at"), label)
        if not isinstance(run, dict) or envelope.get("run_id") != run.get("run_id") or envelope.get("slug") != run.get("slug"):
            validation_errors.append(f"{label} envelope is not bound to the accepted run and slug")
        if not SAFE_EVIDENCE_ID_RE.fullmatch(str(envelope.get("evidence_id") or "")):
            validation_errors.append(f"{label}.evidence_id is missing or unsafe")
        if envelope.get("safe_outcome_observed") is not True or len(str(envelope.get("observation") or "").strip()) < 12:
            validation_errors.append(f"{label} must record the observed safe recovery outcome")
        artifacts = envelope.get("artifacts")
        if not isinstance(artifacts, list) or len(artifacts) != 1:
            validation_errors.append(f"{label}.artifacts must contain exactly one fault state transition")
            return
        artifact = artifacts[0]
        if not isinstance(artifact, dict) or artifact.get("role") != "fault-state-transition":
            validation_errors.append(f"{label}.artifacts[0].role must equal fault-state-transition")
            return
        artifact_path = verify_reference(artifact, f"{label}.artifacts[0]")
        verify_fault_artifact(artifact_path, scenario_name, f"{label}.artifacts[0]")

    for index, item in enumerate(evidence_items):
        if not isinstance(item, dict):
            validation_errors.append(f"evidence[{index}] must be an object")
            continue
        kind = str(item.get("kind") or "")
        if kind in REQUIRED_ACCEPTANCE_EVIDENCE:
            if item.get("result") != "pass":
                validation_errors.append(f"evidence[{kind}].result must be pass")
            resolved = verify_reference(item, f"evidence[{kind}]")
            verify_evidence_envelope(resolved, kind)
        if kind == "fault-recovery":
            scenarios = item.get("scenarios") if isinstance(item.get("scenarios"), list) else []
            for scenario in scenarios:
                if isinstance(scenario, dict) and str(scenario.get("name") or "") in REQUIRED_FAULT_SCENARIOS:
                    scenario_name = str(scenario.get("name"))
                    resolved = verify_reference(scenario, f"fault[{scenario_name}]")
                    verify_fault_envelope(resolved, scenario_name)

    if (
        mismatches
        or missing_evidence
        or duplicate_evidence
        or missing_fault_scenarios
        or validation_errors
    ):
        return {
            "status": "invalid",
            "reason": "acceptance record is missing required pass metadata, environment, or evidence",
            "mismatches": mismatches,
            "missing_evidence": missing_evidence,
            "duplicate_evidence": duplicate_evidence,
            "missing_fault_scenarios": missing_fault_scenarios,
            "validation_errors": validation_errors,
        }
    return {
        "status": "pass",
        "record": redact(str(path.resolve())),
        "evidence_count": len(evidence),
        "accepted_at": accepted_at,
        "run_id": run.get("run_id"),
        "slug": run.get("slug"),
        "release_binding": release_binding,
    }


def load_current_acceptance(path: Path | None) -> dict[str, Any]:
    """Apply the current stable-layout release policy, not historical v3 rules.

    RELEASE.md requires an independently reviewed replacement before any
    current candidate can pass. No existing schema grants that permission.
    The historical collector retains load_acceptance for archive validation.
    """
    reason = "当前固定排版流程的正式验收契约尚待独立评审；旧生图验收和内部验收不能用于本次商业交付。"
    if path is None:
        return {"status": "pending_contract_review", "reason": reason, "commercial_ready": False}
    try:
        if path.stat().st_size > MAX_ACCEPTANCE_ENVELOPE_BYTES:
            raise ValueError("acceptance record is too large")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("acceptance record must be an object")
    except (OSError, UnicodeError, ValueError) as exc:
        return {"status": "invalid", "reason": redact(str(exc)), "commercial_ready": False}
    schema = payload.get("schema")
    if not isinstance(schema, str):
        return {"status": "invalid", "reason": "acceptance schema must be a string", "commercial_ready": False}
    if schema in {"echo-founder.real-account-acceptance.v2", ACCEPTANCE_SCHEMA}:
        status = "legacy_read_only"
    elif schema in {"echo-founder.internal-release-acceptance.v1", "echo-founder.internal-release-acceptance.v2"}:
        status = "internal_only"
    else:
        status = "pending_contract_review"
    return {"status": status, "reason": reason, "commercial_ready": False}


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# {PRODUCT} 商业交付门禁报告",
        "",
        f"- 版本：`{VERSION}`",
        f"- 目标平台：{TARGET}",
        f"- 自动化状态：`{report['automated_status']}`",
        f"- 真实账号验收：`{report['real_account_acceptance']['status']}`",
        f"- 总体交付状态：`{report['commercial_status']}`",
        f"- 生成时间：{report['finished_at']}",
        "",
        "## 自动化证据",
        "",
        "| 门禁 | 状态 | 退出码 | 耗时 |",
        "| --- | --- | ---: | ---: |",
    ]
    for step in report["steps"]:
        lines.append(
            f"| {step['label']} | `{step['status']}` | {step['returncode']} | {step['duration_seconds']}s |"
        )
    if report["failed_steps"]:
        lines.extend(["", "## 自动化阻断", ""])
        lines.extend(f"- {label}" for label in report["failed_steps"])
    if report["real_account_acceptance"]["status"] != "pass":
        lines.extend(
            [
                "",
                "## 人工验收阻断",
                "",
                "- 真实模型、TikOmni 与平台测试账号闭环尚未由验收记录证明；不得将自动化通过等同于商业验收通过。",
                f"- {report['real_account_acceptance'].get('reason', '请核对真实账号验收记录与当前版本的对应关系。')}",
            ]
        )
    lines.append("")
    return "\n".join(lines)


def write_report(report_dir: Path, report: dict[str, Any]) -> tuple[Path, Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    json_path = report_dir / f"echo-founder-commercial-gate-{stamp}.json"
    markdown_path = report_dir / f"echo-founder-commercial-gate-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def labels(steps: Iterable[GateStep]) -> list[str]:
    return [step.label for step in steps]


def gate_exit_code(automated_status: str, commercial_status: str, automated_only: bool) -> int:
    if automated_status != "pass":
        return 1
    if commercial_status == "pass" or automated_only:
        return 0
    return 2


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Run {PRODUCT} commercial-readiness gates")
    parser.add_argument("--mode", choices=("source", "full"), default="source")
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    parser.add_argument("--acceptance-record", type=Path)
    parser.add_argument(
        "--acceptance-public-key",
        type=Path,
        help="out-of-band trusted QA public key used to verify the acceptance record signature",
    )
    parser.add_argument("--soak-seconds", type=int, default=1800)
    parser.add_argument("--keep-going", action="store_true")
    parser.add_argument(
        "--verify-frozen-artifacts",
        action="store_true",
        help="verify and smoke the already QA-tested App/DMG without rebuilding them",
    )
    parser.add_argument(
        "--automated-only",
        action="store_true",
        help="Return success for green automated gates even when real-account acceptance is pending. Never use for commercial handoff.",
    )
    args = parser.parse_args()
    if args.soak_seconds < 60:
        parser.error("--soak-seconds must be at least 60")
    if args.verify_frozen_artifacts and args.mode != "full":
        parser.error("--verify-frozen-artifacts requires --mode full")
    if args.acceptance_record and not args.automated_only and not args.verify_frozen_artifacts:
        parser.error("formal signed acceptance must verify the frozen QA-tested App/DMG instead of rebuilding it")

    started_at = now_iso()
    started = time.monotonic()
    env = os.environ.copy()
    env.setdefault("AIFIOS_HOME", str(REPO_ROOT))
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["DESKTOP_PACKAGE_ARCH"] = "arm64"
    env["DESKTOP_PACKAGED_EXPECTED_ARCH"] = "arm64"
    env["DESKTOP_PACKAGED_MINIMAL_ENV"] = "1"

    results: list[dict[str, Any]] = []
    if not args.automated_only:
        results.append(source_cleanliness_result())
    if not results or results[-1]["status"] == "pass" or args.keep_going:
        for step in selected_steps(
            args.mode,
            args.soak_seconds,
            require_clean_source=not args.automated_only,
            build_artifacts=not args.verify_frozen_artifacts,
        ):
            result = run_step(step, env)
            results.append(result)
            if result["status"] != "pass" and not args.keep_going:
                break

    # A formal full gate can run for well over thirty minutes.  Re-check the
    # complete tracked + untracked tree after every smoke/soak has finished so
    # a release can never be attested against a HEAD that changed mid-gate.
    if not args.automated_only:
        results.append(source_cleanliness_result("formal-source-cleanliness-final"))

    failed_steps = [step["label"] for step in results if step["status"] != "pass"]
    acceptance = load_current_acceptance(args.acceptance_record)
    automated_status = "pass" if not failed_steps else "fail"
    commercial_status = (
        "pass"
        if (
            automated_status == "pass"
            and acceptance["status"] == "pass"
            and args.mode == "full"
            and not args.automated_only
            and args.verify_frozen_artifacts
        )
        else "blocked"
    )
    report: dict[str, Any] = {
        "schema": "echo-founder.commercial-readiness-report.v1",
        "product": PRODUCT,
        "product_version": VERSION,
        "target": TARGET,
        "mode": args.mode,
        "started_at": started_at,
        "finished_at": now_iso(),
        "duration_seconds": round(time.monotonic() - started, 3),
        "automated_status": automated_status,
        "commercial_status": commercial_status,
        "exit_policy": "automated-only" if args.automated_only else "commercial-pass-required",
        "real_account_acceptance": acceptance,
        "failed_steps": failed_steps,
        "steps": results,
    }
    json_path, markdown_path = write_report(args.report_dir.resolve(), report)
    print(f"automated_status={automated_status}")
    print(f"commercial_status={commercial_status}")
    print(f"report_json={redact(str(json_path))}")
    print(f"report_markdown={redact(str(markdown_path))}")
    return gate_exit_code(automated_status, commercial_status, args.automated_only)


if __name__ == "__main__":
    raise SystemExit(main())
