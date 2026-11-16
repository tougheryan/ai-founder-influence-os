#!/usr/bin/env python3
"""Maintain historical v3 image-workflow acceptance archives.

These records cannot certify the current stable-layout release. Use the
current internal acceptance entry point while the replacement formal contract
is awaiting independent review.

This collector never manufactures a passing observation. ``capture`` only
accepts a domain artifact already emitted by the named runtime producer.
``finalize`` refuses incomplete evidence and emits the exact canonical bytes
that an independent QA reviewer must sign out of band.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import stat
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import commercial_readiness_gate as gate  # noqa: E402


STATE_SCHEMA = "echo-founder.real-account-acceptance-workspace.v1"
STATE_FILE = "acceptance-state.json"
RECORD_FILE = "real-account-acceptance.json"
SIGNING_FILE = "acceptance-to-sign.bin"
MAX_FILE_BYTES = 2 * 1024 * 1024
REQUIRED_FAULT_SCENARIOS = frozenset(gate.REQUIRED_FAULT_SCENARIOS)


class AcceptanceWorkspaceError(RuntimeError):
    """Raised when evidence cannot be trusted or the frozen binding changed."""


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    raw = read_owned_regular_file(path)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AcceptanceWorkspaceError(f"invalid JSON: {path.name}") from exc
    if not isinstance(value, dict):
        raise AcceptanceWorkspaceError(f"JSON root must be an object: {path.name}")
    return value


def read_owned_regular_file(path: Path, *, max_bytes: int = MAX_FILE_BYTES) -> bytes:
    try:
        info = path.lstat()
    except OSError as exc:
        raise AcceptanceWorkspaceError(f"file is missing: {path}") from exc
    if (
        not stat.S_ISREG(info.st_mode)
        or path.is_symlink()
        or info.st_nlink != 1
        or info.st_uid != os.getuid()
        or info.st_size <= 0
        or info.st_size > max_bytes
    ):
        raise AcceptanceWorkspaceError(f"file is not a safe owned regular file: {path}")
    return path.read_bytes()


def atomic_write(path: Path, value: bytes, *, replace: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and not replace:
        raise AcceptanceWorkspaceError(f"refusing to replace existing file: {path.name}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_json(path: Path, value: dict[str, Any], *, replace: bool = True) -> None:
    atomic_write(
        path,
        (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        replace=replace,
    )


def safe_workspace(path: Path, *, create: bool = False) -> Path:
    workspace = path.expanduser().resolve()
    if workspace in {Path("/"), REPO_ROOT.resolve(), Path.home().resolve()}:
        raise AcceptanceWorkspaceError("workspace must be a dedicated directory")
    if workspace.exists() and workspace.is_symlink():
        raise AcceptanceWorkspaceError("workspace cannot be a symbolic link")
    if create:
        workspace.mkdir(parents=True, exist_ok=False, mode=0o700)
    if not workspace.is_dir():
        raise AcceptanceWorkspaceError("workspace directory does not exist")
    return workspace


def require_safe_id(value: str, label: str, *, run_id: bool = False) -> str:
    pattern = gate.SAFE_RUN_ID_RE if run_id else gate.SAFE_EVIDENCE_ID_RE
    if not pattern.fullmatch(value):
        raise AcceptanceWorkspaceError(f"{label} is missing or unsafe")
    return value


def git_binding() -> tuple[str, int]:
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    status_result = subprocess.run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if sha.returncode or status_result.returncode:
        raise AcceptanceWorkspaceError("Git source status is unavailable")
    entries = [line for line in status_result.stdout.splitlines() if line.strip()]
    return sha.stdout.strip(), len(entries)


def active_qa_keys(registry: dict[str, Any]) -> list[dict[str, Any]]:
    keys = registry.get("keys") if isinstance(registry.get("keys"), list) else []
    return [row for row in keys if isinstance(row, dict) and row.get("status") == "active"]


def build_binding(release_root: Path, source_sha: str) -> dict[str, str]:
    registry_path = gate.TRUSTED_QA_KEY_REGISTRY
    registry = read_json(registry_path)
    if registry.get("schema") != gate.TRUSTED_QA_KEY_REGISTRY_SCHEMA or not active_qa_keys(registry):
        raise AcceptanceWorkspaceError("an active independent QA public key must be registered before build")
    package_path = release_root / gate.PACKAGE_MANIFEST_FILENAME
    dmg_manifest_path = release_root / gate.DMG_MANIFEST_FILENAME
    dmg_path = release_root / gate.DMG_FILENAME
    values = {
        "source_git_sha": source_sha,
        "package_manifest_sha256": sha256_file(package_path),
        "dmg_manifest_sha256": sha256_file(dmg_manifest_path),
        "dmg_sha256": sha256_file(dmg_path),
        "qa_key_registry_sha256": sha256_file(registry_path),
    }
    errors: list[str] = []
    gate.verify_release_binding(
        {"build": values},
        release_root,
        errors,
        current_source_sha=source_sha,
    )
    if errors:
        raise AcceptanceWorkspaceError("frozen release binding failed: " + "; ".join(errors))
    return values


def init_workspace(args: argparse.Namespace) -> dict[str, Any]:
    if not args.confirm_clean_machine or not args.confirm_no_preinstalled_toolchain:
        raise AcceptanceWorkspaceError(
            "init requires explicit clean-machine and no-preinstalled-toolchain confirmations"
        )
    source_sha, dirty_count = git_binding()
    if dirty_count:
        raise AcceptanceWorkspaceError(f"source tree is dirty; entry_count={dirty_count}")
    release_root = args.release_root.expanduser().resolve()
    build = build_binding(release_root, source_sha)
    run_id = require_safe_id(args.run_id, "run_id", run_id=True)
    slug = require_safe_id(args.slug, "slug", run_id=True)
    machine_id = require_safe_id(args.machine_id, "machine_id")
    macos_version = platform.mac_ver()[0] or args.macos_version
    if not macos_version:
        raise AcceptanceWorkspaceError("macOS version is required")
    machine_model = args.machine_model or platform.platform()
    workspace = safe_workspace(args.workspace, create=True)
    state = {
        "schema": STATE_SCHEMA,
        "created_at": now_iso(),
        "product_version": gate.VERSION,
        "workspace_id": require_safe_id(args.workspace_id, "workspace_id"),
        "release_root": release_root.name,
        "build": build,
        "run_id": run_id,
        "slug": slug,
    }
    template = read_json(REPO_ROOT / "quality" / "acceptance" / "real-account-acceptance.template.json")
    template["status"] = "pending"
    template["accepted_at"] = None
    template["build"] = build
    template["machine"] = {
        "model": machine_model,
        "acceptance_machine_id": machine_id,
        "architecture": "arm64",
        "macos_version": macos_version,
        "macos_major": int(macos_version.split(".", 1)[0]),
        "clean_machine": True,
        "node_preinstalled": False,
        "python_preinstalled": False,
        "homebrew_preinstalled": False,
    }
    template["run"] = {
        "run_id": run_id,
        "slug": slug,
        "project_backup_sha256": "",
        "archetype_run_ids": {"methodology": "", "founder_story": "", "research_analysis": ""},
    }
    for item in template.get("evidence", []):
        if isinstance(item, dict):
            item["result"] = "pending"
            item["sha256"] = ""
    write_json(workspace / STATE_FILE, state, replace=False)
    write_json(workspace / RECORD_FILE, template, replace=False)
    return status_workspace(workspace, release_root=release_root)


def load_workspace(workspace: Path) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    root = safe_workspace(workspace)
    state = read_json(root / STATE_FILE)
    record = read_json(root / RECORD_FILE)
    if state.get("schema") != STATE_SCHEMA:
        raise AcceptanceWorkspaceError("unsupported acceptance workspace schema")
    if record.get("schema") != gate.ACCEPTANCE_SCHEMA:
        raise AcceptanceWorkspaceError("unsupported acceptance record schema")
    return root, state, record


def binding_status(state: dict[str, Any], release_root: Path) -> tuple[bool, list[str]]:
    errors: list[str] = []
    try:
        current_sha, dirty_count = git_binding()
    except AcceptanceWorkspaceError as exc:
        return False, [str(exc)]
    if current_sha != state.get("build", {}).get("source_git_sha"):
        errors.append("source Git SHA changed after acceptance init")
    if dirty_count:
        errors.append(f"source tree changed after acceptance init; entry_count={dirty_count}")
    gate.verify_release_binding(
        {"build": state.get("build", {})},
        release_root,
        errors,
        current_source_sha=current_sha,
    )
    return not errors, errors


def evidence_progress(record: dict[str, Any]) -> tuple[set[str], set[str]]:
    rows = record.get("evidence") if isinstance(record.get("evidence"), list) else []
    passed = {
        str(row.get("kind"))
        for row in rows
        if isinstance(row, dict) and row.get("result") == "pass"
    }
    return passed, set(gate.REQUIRED_ACCEPTANCE_EVIDENCE) - passed


def fault_progress(record: dict[str, Any]) -> tuple[set[str], set[str]]:
    rows = record.get("evidence") if isinstance(record.get("evidence"), list) else []
    fault = next((row for row in rows if isinstance(row, dict) and row.get("kind") == "fault-recovery"), {})
    scenarios = fault.get("scenarios") if isinstance(fault.get("scenarios"), list) else []
    passed = {
        str(row.get("name"))
        for row in scenarios
        if isinstance(row, dict) and row.get("result") == "pass"
    }
    return passed, set(REQUIRED_FAULT_SCENARIOS) - passed


def status_workspace(workspace: Path, *, release_root: Path | None = None) -> dict[str, Any]:
    root, state, record = load_workspace(workspace)
    actual_release_root = release_root or (REPO_ROOT / "dist")
    binding_valid, binding_errors = binding_status(state, actual_release_root)
    passed, missing = evidence_progress(record)
    fault_passed, fault_missing = fault_progress(record)
    signed = bool(record.get("attestation", {}).get("signature_base64"))
    complete = not missing and not fault_missing
    return {
        "schema": STATE_SCHEMA,
        "status": (
            "invalidated" if not binding_valid else
            "historical_record_complete" if record.get("status") == "pass" and signed and complete else
            "awaiting_signature" if record.get("status") == "pass" and complete else
            "collecting"
        ),
        "product_version": state.get("product_version"),
        "current_release_eligible": False,
        "commercial_ready": False,
        "release_scope": "legacy_paid_image_v3",
        "workspace_id": state.get("workspace_id"),
        "run_id": state.get("run_id"),
        "slug": state.get("slug"),
        "binding_valid": binding_valid,
        "binding_errors": binding_errors,
        "passed_evidence": sorted(passed),
        "missing_evidence": sorted(missing),
        "passed_fault_scenarios": sorted(fault_passed),
        "missing_fault_scenarios": sorted(fault_missing),
        "signed": signed,
        "record": (root / RECORD_FILE).name,
    }


def validate_domain_artifact(
    payload: dict[str, Any],
    *,
    kind: str,
    state: dict[str, Any],
) -> None:
    expected_role, expected_producer = gate.REQUIRED_ARTIFACT_ROLE_AND_PRODUCER[kind]
    required = {
        "schema": gate.DOMAIN_ARTIFACT_SCHEMA,
        "kind": kind,
        "role": expected_role,
        "producer": expected_producer,
        "result": "pass",
        "run_id": state["run_id"],
        "slug": state["slug"],
    }
    for key, expected in required.items():
        if payload.get(key) != expected:
            raise AcceptanceWorkspaceError(f"artifact.{key} must equal {expected!r}")
    require_safe_id(str(payload.get("evidence_id") or ""), "artifact.evidence_id")
    if not gate.SHA256_RE.fullmatch(str(payload.get("source_sha256") or "")):
        raise AcceptanceWorkspaceError("artifact.source_sha256 is required")
    facts = payload.get("facts") if isinstance(payload.get("facts"), dict) else {}
    for assertion, expected in gate.REQUIRED_EVIDENCE_ASSERTIONS[kind].items():
        if facts.get(assertion) != expected:
            raise AcceptanceWorkspaceError(f"artifact.facts.{assertion} must equal {expected!r}")


def validate_fault_artifact(payload: dict[str, Any], *, scenario: str, state: dict[str, Any]) -> None:
    if scenario not in REQUIRED_FAULT_SCENARIOS:
        raise AcceptanceWorkspaceError("unsupported fault scenario")
    expected = {
        "schema": gate.FAULT_ARTIFACT_SCHEMA,
        "scenario": scenario,
        "role": "fault-state-transition",
        "producer": "fault-harness",
        "result": "pass",
        "run_id": state["run_id"],
        "slug": state["slug"],
        "safe_outcome_observed": True,
    }
    for key, value in expected.items():
        if payload.get(key) != value:
            raise AcceptanceWorkspaceError(f"fault artifact.{key} must equal {value!r}")
    require_safe_id(str(payload.get("event_id") or ""), "fault artifact.event_id")
    for key in ("before_state_sha256", "after_state_sha256", "source_log_sha256"):
        if not gate.SHA256_RE.fullmatch(str(payload.get(key) or "")):
            raise AcceptanceWorkspaceError(f"fault artifact.{key} is required")


def assert_redacted_text(raw: bytes) -> None:
    text = raw.decode("utf-8", errors="replace")
    if gate.redact(text) != text or gate.PRIVATE_PATH_RE.search(text):
        raise AcceptanceWorkspaceError("evidence contains a secret or private local path")


def replace_record_evidence(record: dict[str, Any], kind: str, row: dict[str, Any]) -> None:
    evidence = record.get("evidence") if isinstance(record.get("evidence"), list) else []
    for index, item in enumerate(evidence):
        if isinstance(item, dict) and item.get("kind") == kind:
            evidence[index] = row
            record["evidence"] = evidence
            return
    raise AcceptanceWorkspaceError(f"acceptance template does not contain evidence kind: {kind}")


def capture(args: argparse.Namespace) -> dict[str, Any]:
    root, state, record = load_workspace(args.workspace)
    release_root = args.release_root.expanduser().resolve()
    binding_valid, errors = binding_status(state, release_root)
    if not binding_valid:
        raise AcceptanceWorkspaceError("frozen binding changed: " + "; ".join(errors))
    observation = args.observation.strip()
    if len(observation) < 12:
        raise AcceptanceWorkspaceError("observation must describe what QA actually observed")
    source = args.artifact.expanduser().resolve()
    raw = read_owned_regular_file(source)
    assert_redacted_text(raw)
    payload = read_json(source)

    if args.scenario:
        scenario = args.scenario
        validate_fault_artifact(payload, scenario=scenario, state=state)
        artifact_relative = Path("artifacts") / "faults" / f"{scenario}.json"
        envelope_relative = Path("evidence") / "faults" / f"{scenario}.json"
        artifact_target = root / artifact_relative
        envelope_target = root / envelope_relative
        atomic_write(artifact_target, raw, replace=args.replace)
        envelope = {
            "schema": gate.FAULT_EVIDENCE_SCHEMA,
            "name": scenario,
            "result": "pass",
            "captured_at": now_iso(),
            "run_id": state["run_id"],
            "slug": state["slug"],
            "evidence_id": f"fault-envelope-{scenario}",
            "safe_outcome_observed": True,
            "observation": observation,
            "artifacts": [{
                "role": "fault-state-transition",
                "path": artifact_relative.as_posix(),
                "sha256": sha256_file(artifact_target),
            }],
        }
        write_json(envelope_target, envelope, replace=args.replace)
        evidence = record.get("evidence") if isinstance(record.get("evidence"), list) else []
        fault = next((item for item in evidence if isinstance(item, dict) and item.get("kind") == "fault-recovery"), None)
        if not isinstance(fault, dict):
            raise AcceptanceWorkspaceError("fault-recovery evidence row is missing")
        scenarios = fault.get("scenarios") if isinstance(fault.get("scenarios"), list) else []
        replacement = {
            "name": scenario,
            "result": "pass",
            "path": envelope_relative.as_posix(),
            "sha256": sha256_file(envelope_target),
        }
        replaced = False
        for index, row in enumerate(scenarios):
            if isinstance(row, dict) and row.get("name") == scenario:
                scenarios[index] = replacement
                replaced = True
        if not replaced:
            scenarios.append(replacement)
        fault["scenarios"] = scenarios
    else:
        kind = args.kind
        if kind not in gate.REQUIRED_ACCEPTANCE_EVIDENCE:
            raise AcceptanceWorkspaceError("unsupported evidence kind")
        validate_domain_artifact(payload, kind=kind, state=state)
        artifact_relative = Path("artifacts") / f"{kind}.json"
        envelope_relative = Path("evidence") / f"{kind}.json"
        artifact_target = root / artifact_relative
        envelope_target = root / envelope_relative
        atomic_write(artifact_target, raw, replace=args.replace)
        assertions = dict(gate.REQUIRED_EVIDENCE_ASSERTIONS[kind])
        if kind == "backup-restore":
            assertions["backup_sha256"] = payload.get("facts", {}).get("backup_sha256")
        envelope = {
            "schema": gate.EVIDENCE_SCHEMA,
            "kind": kind,
            "result": "pass",
            "captured_at": now_iso(),
            "run_id": state["run_id"],
            "slug": state["slug"],
            "evidence_id": f"envelope-{kind}",
            "observation": observation,
            "assertions": assertions,
            "artifacts": [{
                "role": gate.REQUIRED_ARTIFACT_ROLE_AND_PRODUCER[kind][0],
                "path": artifact_relative.as_posix(),
                "sha256": sha256_file(artifact_target),
            }],
        }
        write_json(envelope_target, envelope, replace=args.replace)
        replacement = {
            "kind": kind,
            "result": "pass",
            "path": envelope_relative.as_posix(),
            "sha256": sha256_file(envelope_target),
        }
        if kind == "fault-recovery":
            existing = next(
                (row for row in record.get("evidence", []) if isinstance(row, dict) and row.get("kind") == kind),
                {},
            )
            replacement["scenarios"] = existing.get("scenarios", [])
        replace_record_evidence(record, kind, replacement)
    write_json(root / RECORD_FILE, record)
    return status_workspace(root, release_root=release_root)


def validate_reviewer(path: Path) -> dict[str, Any]:
    reviewer = read_json(path)
    for field in ("name", "organization", "review_id"):
        if not str(reviewer.get(field) or "").strip():
            raise AcceptanceWorkspaceError(f"reviewer.{field} is required")
    require_safe_id(str(reviewer["review_id"]), "reviewer.review_id")
    for field in ("independent_from_implementation", "confirmed_no_secrets", "confirmed_no_public_send"):
        if reviewer.get(field) is not True:
            raise AcceptanceWorkspaceError(f"reviewer.{field} must be true")
    return reviewer


def verify_qa_key(public_key: Path, key_id: str) -> tuple[str, str]:
    raw = read_owned_regular_file(public_key)
    fingerprint = sha256_bytes(raw)
    registry = read_json(gate.TRUSTED_QA_KEY_REGISTRY)
    matches = [
        row for row in active_qa_keys(registry)
        if row.get("key_id") == key_id and row.get("public_key_sha256") == fingerprint
    ]
    if len(matches) != 1:
        raise AcceptanceWorkspaceError("QA public key is not an active pre-approved trust anchor")
    return fingerprint, sha256_file(gate.TRUSTED_QA_KEY_REGISTRY)


def finalize(args: argparse.Namespace) -> dict[str, Any]:
    root, state, record = load_workspace(args.workspace)
    release_root = args.release_root.expanduser().resolve()
    current_status = status_workspace(root, release_root=release_root)
    if not current_status["binding_valid"]:
        raise AcceptanceWorkspaceError("frozen binding changed: " + "; ".join(current_status["binding_errors"]))
    if current_status["missing_evidence"] or current_status["missing_fault_scenarios"]:
        raise AcceptanceWorkspaceError("all main evidence and fault scenarios must pass before finalize")
    reviewer = validate_reviewer(args.reviewer)
    backup_sha = args.project_backup_sha.lower()
    if not gate.SHA256_RE.fullmatch(backup_sha):
        raise AcceptanceWorkspaceError("project_backup_sha must be a lowercase SHA-256 digest")
    archetypes = {
        "methodology": require_safe_id(args.methodology_run_id, "methodology_run_id", run_id=True),
        "founder_story": require_safe_id(args.founder_story_run_id, "founder_story_run_id", run_id=True),
        "research_analysis": require_safe_id(args.research_analysis_run_id, "research_analysis_run_id", run_id=True),
    }
    backup_evidence = read_json(root / "evidence" / "backup-restore.json")
    if backup_evidence.get("assertions", {}).get("backup_sha256") != backup_sha:
        raise AcceptanceWorkspaceError("project backup SHA does not match backup-restore evidence")
    key_id = require_safe_id(args.key_id, "key_id")
    public_key_sha, registry_sha = verify_qa_key(args.public_key, key_id)
    record["status"] = "pass"
    record["accepted_at"] = record.get("accepted_at") or now_iso()
    record["reviewer"] = reviewer
    record["run"]["project_backup_sha256"] = backup_sha
    record["run"]["archetype_run_ids"] = archetypes
    record["attestation"] = {
        "algorithm": gate.ATTESTATION_ALGORITHM,
        "key_id": key_id,
        "trusted_public_key_sha256": public_key_sha,
        "registry_sha256": registry_sha,
        "signature_base64": "",
    }
    record["build"]["qa_key_registry_sha256"] = registry_sha
    canonical = gate.canonical_acceptance_bytes(record)
    atomic_write(root / SIGNING_FILE, canonical)
    if args.signature:
        signature = read_owned_regular_file(args.signature, max_bytes=1024 * 1024)
        verified = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(args.public_key), "-signature", str(args.signature)],
            input=canonical,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if verified.returncode != 0:
            raise AcceptanceWorkspaceError("QA signature does not verify against the canonical acceptance bytes")
        record["attestation"]["signature_base64"] = base64.b64encode(signature).decode("ascii")
    write_json(root / RECORD_FILE, record)
    return status_workspace(root, release_root=release_root)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Create a workspace bound to a clean frozen candidate")
    init.add_argument("--workspace", type=Path, required=True)
    init.add_argument("--workspace-id", required=True)
    init.add_argument("--run-id", required=True)
    init.add_argument("--slug", required=True)
    init.add_argument("--machine-id", required=True)
    init.add_argument("--machine-model", default="")
    init.add_argument("--macos-version", default="")
    init.add_argument("--release-root", type=Path, default=REPO_ROOT / "dist")
    init.add_argument("--confirm-clean-machine", action="store_true")
    init.add_argument("--confirm-no-preinstalled-toolchain", action="store_true")

    status = commands.add_parser("status", help="Check frozen binding and evidence progress")
    status.add_argument("--workspace", type=Path, required=True)
    status.add_argument("--release-root", type=Path, default=REPO_ROOT / "dist")

    capture_parser = commands.add_parser("capture", help="Capture one real producer artifact")
    capture_parser.add_argument("--workspace", type=Path, required=True)
    capture_parser.add_argument("--release-root", type=Path, default=REPO_ROOT / "dist")
    capture_parser.add_argument("--kind", choices=sorted(gate.REQUIRED_ACCEPTANCE_EVIDENCE))
    capture_parser.add_argument("--scenario", choices=sorted(REQUIRED_FAULT_SCENARIOS))
    capture_parser.add_argument("--artifact", type=Path, required=True)
    capture_parser.add_argument("--observation", required=True)
    capture_parser.add_argument("--replace", action="store_true")

    final = commands.add_parser("finalize", help="Create canonical bytes and attach an optional QA signature")
    final.add_argument("--workspace", type=Path, required=True)
    final.add_argument("--release-root", type=Path, default=REPO_ROOT / "dist")
    final.add_argument("--reviewer", type=Path, required=True)
    final.add_argument("--project-backup-sha", required=True)
    final.add_argument("--methodology-run-id", required=True)
    final.add_argument("--founder-story-run-id", required=True)
    final.add_argument("--research-analysis-run-id", required=True)
    final.add_argument("--key-id", required=True)
    final.add_argument("--public-key", type=Path, required=True)
    final.add_argument("--signature", type=Path)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "init":
            result = init_workspace(args)
        elif args.command == "status":
            result = status_workspace(args.workspace, release_root=args.release_root.expanduser().resolve())
        elif args.command == "capture":
            if bool(args.kind) == bool(args.scenario):
                raise AcceptanceWorkspaceError("capture requires exactly one of --kind or --scenario")
            result = capture(args)
        else:
            result = finalize(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except AcceptanceWorkspaceError as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
