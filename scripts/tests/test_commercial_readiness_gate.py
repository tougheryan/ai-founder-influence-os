from __future__ import annotations

import base64
import importlib.util
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "commercial_readiness_gate.py"


def load_module():
    spec = importlib.util.spec_from_file_location("commercial_readiness_gate", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def init_git_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    (path / "tracked.txt").write_text("frozen\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=path, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Echo Founder Test",
            "-c",
            "user.email=qa@example.invalid",
            "commit",
            "-q",
            "-m",
            "freeze fixture",
        ],
        cwd=path,
        check=True,
    )


def write_release_fixture(root: Path, module, registry: Path | None = None) -> tuple[Path, dict[str, str]]:
    release = root / "dist"
    release.mkdir(parents=True)
    if registry is None:
        registry = root / "fixture-qa-registry.json"
        registry.write_text(json.dumps({"schema": module.TRUSTED_QA_KEY_REGISTRY_SCHEMA, "keys": []}), encoding="utf-8")
    registry_sha = hashlib.sha256(registry.read_bytes()).hexdigest()
    source_sha = "a" * 40
    dmg_path = release / module.DMG_FILENAME
    dmg_path.write_bytes(b"synthetic test DMG bytes")
    dmg_sha = hashlib.sha256(dmg_path.read_bytes()).hexdigest()
    package = {
        "status": "packed",
        "product": module.PRODUCT,
        "version": module.VERSION,
        "source_control": {
            "schema": "echo-founder.source-control-trace.v1",
            "current_sha": source_sha,
            "dirty": False,
        },
        "trusted_qa_key_registry": {
            "schema": module.TRUSTED_QA_KEY_REGISTRY_SCHEMA,
            "path": "quality/acceptance/trusted-qa-public-keys.json",
            "sha256": registry_sha,
            "key_count": len(json.loads(registry.read_text(encoding="utf-8"))["keys"]),
        },
    }
    package_path = release / module.PACKAGE_MANIFEST_FILENAME
    package_path.write_text(json.dumps(package), encoding="utf-8")
    package_sha = hashlib.sha256(package_path.read_bytes()).hexdigest()
    dmg_manifest = {
        "status": "packed",
        "artifact": "dmg",
        "product": module.PRODUCT,
        "version": module.VERSION,
        "architecture": "arm64",
        "sha256": dmg_sha,
        "package_manifest": {
            "schema": "echo-founder.package-manifest-binding.v1",
            "sha256": package_sha,
        },
    }
    dmg_manifest_path = release / module.DMG_MANIFEST_FILENAME
    dmg_manifest_path.write_text(json.dumps(dmg_manifest), encoding="utf-8")
    (release / module.CHECKSUM_FILENAME).write_text(f"{dmg_sha}  {module.DMG_FILENAME}\n", encoding="ascii")
    return release, {
        "source_git_sha": source_sha,
        "package_manifest_sha256": package_sha,
        "dmg_manifest_sha256": hashlib.sha256(dmg_manifest_path.read_bytes()).hexdigest(),
        "dmg_sha256": dmg_sha,
        "qa_key_registry_sha256": registry_sha,
    }


def domain_artifact(module, kind: str, run_id: str, slug: str, backup_sha: str, dmg_sha: str) -> dict:
    role, producer = module.REQUIRED_ARTIFACT_ROLE_AND_PRODUCER[kind]
    facts = dict(module.REQUIRED_EVIDENCE_ASSERTIONS[kind])
    if kind == "backup-restore":
        facts["backup_sha256"] = backup_sha
    if kind == "clean-install":
        facts["dmg_sha256"] = dmg_sha
    payload = {
        "schema": module.DOMAIN_ARTIFACT_SCHEMA,
        "kind": kind,
        "role": role,
        "producer": producer,
        "result": "pass",
        "captured_at": "2026-08-24T11:25:00+08:00",
        "run_id": run_id,
        "slug": slug,
        "evidence_id": f"evidence-{kind}",
        "source_sha256": hashlib.sha256(f"source:{kind}".encode()).hexdigest(),
        "facts": facts,
    }
    digest = lambda value: hashlib.sha256(value.encode()).hexdigest()
    if kind == "three-platform-tikomni-research":
        payload["platform_samples"] = {
            platform: [{"url": f"https://example.test/{platform}/1", "raw_sha256": digest(platform)}]
            for platform in ("wechat", "xiaohongshu", "shipinhao")
        }
    elif kind == "three-archetype-platform-native-production":
        payload["archetype_runs"] = [
            {
                "archetype": archetype,
                "platforms": {
                    platform: {"content_sha256": digest(f"{archetype}-{platform}")}
                    for platform in ("wechat", "xiaohongshu", "shipinhao")
                },
            }
            for archetype in ("methodology", "founder_story", "research_analysis")
        ]
    elif kind == "paid-image-provider-benchmark":
        payload["benchmark"] = {
            "schema_version": "echo-founder.image-provider-benchmark.v1",
            "routes": [{"route_id": f"route-{index}"} for index in range(10)],
            "selection": {
                "top_three": ["route-0", "route-1", "route-2"],
                "primary": "route-0",
                "backup": "route-1",
                "ai_enhanced_default_eligible": True,
            },
            "budget_cny": {"actual": 99.0, "reserved": 100.0},
        }
    elif kind == "tikomni-hit-ranking-calibration":
        payload["calibration"] = {
            "score_version": "echo-founder.tikomni-hit-score.v5",
            "sample_count": 45,
            "platform_counts": {"wechat_mp": 15, "xiaohongshu": 15, "wechat_channels": 15},
            "invalid_evidence_false_hit_count": 0,
            "verified_hit_precision": 0.90,
            "passed": True,
        }
    elif kind == "visual-ai-default":
        payload.update({"stable_fallback_verified": True, "benchmark_sha256": digest("benchmark")})
    elif kind == "platform-draft-fill":
        payload["platform_results"] = {
            platform: [
                {
                    "attempt_id": f"attempt-{platform}-{index}",
                    "payload_sha256": digest(f"payload-{platform}-{index}"),
                    "public_send": False,
                }
                for index in range(3)
            ]
            for platform in ("wechat", "xiaohongshu", "shipinhao")
        }
    elif kind == "frozen-dmg-runtime":
        payload.update({"dmg_sha256": dmg_sha, "rebuilt_after_acceptance": False})
    return payload


def create_qa_trust(module, root: Path) -> tuple[Path, Path, Path]:
    private_key = root / "qa-private.pem"
    public_key = root / "qa-public.pem"
    subprocess.run(
        ["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(private_key)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["openssl", "pkey", "-in", str(private_key), "-pubout", "-out", str(public_key)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    registry = root / "trusted-qa-public-keys.json"
    registry.write_text(json.dumps({
        "schema": module.TRUSTED_QA_KEY_REGISTRY_SCHEMA,
        "keys": [{
            "key_id": "independent-qa-test-key",
            "public_key_sha256": hashlib.sha256(public_key.read_bytes()).hexdigest(),
            "organization": "Independent QA",
            "status": "active",
        }],
    }), encoding="utf-8")
    return private_key, public_key, registry


def sign_acceptance(
    module,
    payload: dict,
    root: Path,
    trust: tuple[Path, Path, Path] | None = None,
) -> tuple[Path, Path]:
    private_key, public_key, registry = trust or create_qa_trust(module, root)
    signature = root / "acceptance.sig"
    payload["attestation"] = {
        "algorithm": module.ATTESTATION_ALGORITHM,
        "key_id": "independent-qa-test-key",
        "trusted_public_key_sha256": hashlib.sha256(public_key.read_bytes()).hexdigest(),
        "registry_sha256": hashlib.sha256(registry.read_bytes()).hexdigest(),
        "signature_base64": "",
    }
    subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(private_key), "-out", str(signature)],
        input=module.canonical_acceptance_bytes(payload),
        check=True,
    )
    payload["attestation"]["signature_base64"] = base64.b64encode(signature.read_bytes()).decode("ascii")
    private_key.unlink()
    signature.unlink()
    return public_key, registry


def test_source_gate_contains_every_source_release_family() -> None:
    module = load_module()
    labels = module.labels(module.source_steps())

    assert labels[:7] == [
        "production-dependency-audit",
        "python-tests",
        "desktop-build-tests",
        "runtime-contracts",
        "commercial-capability-matrix",
        "content-production-loop",
        "ui-runtime-gates",
    ]
    desktop_build_step = next(step for step in module.source_steps() if step.label == "desktop-build-tests")
    assert desktop_build_step.command[-2:] == ("-q", "scripts/tests")
    assert "ui-unit-tests" in labels
    assert "typescript" in labels
    assert "eslint-zero-warnings" in labels
    assert "next-production-build" in labels
    assert "production-dependency-audit" in labels
    assert "electron-static-check" in labels
    assert "electron-tests" in labels


def test_full_gate_is_arm64_only_and_has_recovery_and_thirty_minute_soak() -> None:
    module = load_module()
    steps = module.desktop_steps(soak_seconds=1800)
    labels = module.labels(steps)
    commands = [part for step in steps for part in step.command]

    assert "arm64-package" in labels
    assert "package-traceability" in labels
    assert "desktop-service-recovery-smoke" in labels
    assert "desktop-backup-restore-smoke" in labels
    assert "desktop-watchdog-smoke" in labels
    assert "desktop-soak" in labels
    assert "DESKTOP_PACKAGED_SOAK_DURATION=1800" in commands
    assert "DESKTOP_PACKAGE_ARCH=arm64" in commands
    assert not any("x64" in part or "universal" in part for part in commands)
    assert "REQUIRE_CLEAN_SOURCE=1" not in commands

    formal_commands = [
        part
        for step in module.desktop_steps(soak_seconds=1800, require_clean_source=True)
        for part in step.command
    ]
    assert "REQUIRE_CLEAN_SOURCE=1" in formal_commands

    frozen = module.desktop_steps(
        soak_seconds=1800,
        require_clean_source=True,
        build_artifacts=False,
    )
    frozen_labels = module.labels(frozen)
    assert "arm64-package" not in frozen_labels
    assert "arm64-dmg" not in frozen_labels
    assert "package-traceability" in frozen_labels
    assert "dmg-verify" in frozen_labels
    assert "desktop-soak" in frozen_labels


def test_formal_source_cleanliness_rejects_tracked_and_untracked_changes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = load_module()
    repo = tmp_path / "repo"
    init_git_repo(repo)
    monkeypatch.setattr(module, "REPO_ROOT", repo)

    assert module.source_cleanliness_result()["status"] == "pass"

    (repo / "tracked.txt").write_text("changed\n", encoding="utf-8")
    tracked = module.source_cleanliness_result()
    assert tracked["status"] == "fail"
    assert "entry_count=1" in tracked["output_tail"]
    assert "tracked.txt" not in tracked["output_tail"]

    subprocess.run(["git", "restore", "tracked.txt"], cwd=repo, check=True)
    (repo / "untracked.txt").write_text("new\n", encoding="utf-8")
    untracked = module.source_cleanliness_result("formal-source-cleanliness-final")
    assert untracked["label"] == "formal-source-cleanliness-final"
    assert untracked["status"] == "fail"
    assert "entry_count=1" in untracked["output_tail"]
    assert "untracked.txt" not in untracked["output_tail"]


def test_formal_gate_rechecks_cleanliness_after_all_steps(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = load_module()
    repo = tmp_path / "repo"
    init_git_repo(repo)
    monkeypatch.setattr(module, "REPO_ROOT", repo)
    monkeypatch.setattr(module, "DEFAULT_REPORT_DIR", tmp_path / "reports")
    monkeypatch.setattr(module, "selected_steps", lambda *args, **kwargs: [object()])

    def mutate_during_gate(step, env):
        (repo / "changed-during-soak.txt").write_text("race\n", encoding="utf-8")
        return {
            "label": "desktop-soak",
            "status": "pass",
            "returncode": 0,
            "duration_seconds": 0.01,
            "command": ["synthetic-soak"],
            "output_tail": "pass",
        }

    captured: dict = {}

    def capture_report(report_dir, report):
        captured.update(report)
        return tmp_path / "report.json", tmp_path / "report.md"

    monkeypatch.setattr(module, "run_step", mutate_during_gate)
    monkeypatch.setattr(module, "write_report", capture_report)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--mode", "source"])

    assert module.main() == 1
    assert captured["automated_status"] == "fail"
    assert captured["commercial_status"] == "blocked"
    assert captured["failed_steps"] == ["formal-source-cleanliness-final"]


@pytest.mark.parametrize('schema,status', [
    ('echo-founder.real-account-acceptance.v2', 'legacy_read_only'),
    ('echo-founder.real-account-acceptance.v3', 'legacy_read_only'),
    ('echo-founder.internal-release-acceptance.v1', 'internal_only'),
    ('echo-founder.internal-release-acceptance.v2', 'internal_only'),
    ('echo-founder.real-account-acceptance.v4', 'pending_contract_review'),
])
def test_current_release_never_accepts_old_or_self_declared_new_contract(tmp_path, schema, status):
    module = load_module(); record = tmp_path / 'record.json'
    record.write_text(json.dumps({'schema': schema, 'status': 'pass', 'commercial_ready': True}))
    result = module.load_current_acceptance(record)
    assert result['status'] == status and result['commercial_ready'] is False


@pytest.mark.parametrize('payload', [[], None, {'schema': {}}, {'schema': []}])
def test_current_acceptance_malformed_input_is_structured_failure(tmp_path, payload):
    module = load_module(); record = tmp_path / 'record.json'; record.write_text(json.dumps(payload))
    assert module.load_current_acceptance(record)['status'] == 'invalid'


def test_green_automated_full_run_plus_passing_legacy_validator_cannot_certify_current_release(tmp_path, monkeypatch):
    module = load_module(); record = tmp_path / 'record.json'
    record.write_text(json.dumps({'schema': module.ACCEPTANCE_SCHEMA, 'status': 'pass'}))
    monkeypatch.setattr(module, 'selected_steps', lambda *args, **kwargs: [])
    monkeypatch.setattr(module, 'source_cleanliness_result', lambda label='formal-source-cleanliness': {'status': 'pass', 'label': label})
    legacy_calls = []
    def historical_validator(*args, **kwargs):
        legacy_calls.append(True); return {'status': 'pass'}
    monkeypatch.setattr(module, 'load_acceptance', historical_validator)
    captured = {}
    def report(path, data):
        captured.update(data); return tmp_path / 'report.json', tmp_path / 'report.md'
    monkeypatch.setattr(module, 'write_report', report)
    monkeypatch.setattr(sys, 'argv', [str(SCRIPT), '--mode', 'full', '--verify-frozen-artifacts', '--acceptance-record', str(record)])
    assert module.main() == 2
    assert captured['automated_status'] == 'pass' and captured['commercial_status'] == 'blocked'
    assert captured['real_account_acceptance']['status'] == 'legacy_read_only'
    assert legacy_calls == []


def test_report_redaction_removes_secrets_and_absolute_user_path() -> None:
    module = load_module()
    raw = f'{Path.home()}/project Authorization: Bearer abc api_key=xyz "cookie":"session" sk-standalonesecret12345'
    cleaned = module.redact(raw)

    assert str(Path.home()) not in cleaned
    assert "abc" not in cleaned
    assert "xyz" not in cleaned
    assert "session" not in cleaned
    assert "sk-standalonesecret12345" not in cleaned
    assert cleaned.count("<REDACTED>") == 4


def test_report_redaction_covers_quoted_camel_case_mobile_secrets_and_mount_paths() -> None:
    module = load_module()
    raw = "\n".join([
        '"authorization": "Bearer quoted-auth-canary"',
        "authorizationHeader='Basic header-auth-canary'",
        "pairingToken=pairing-canary",
        '"pairingToken":"json-pairing-canary"',
        "/private/tmp/echo-private/customer.json",
        "/Volumes/Customer Disk/Echo Founder/data.json",
        "/Users/alice/private/project.json",
        "The pairingToken field is required, but no value was logged.",
    ])

    cleaned = module.redact(raw)

    for canary in (
        "quoted-auth-canary",
        "header-auth-canary",
        "pairing-canary",
        "json-pairing-canary",
        "/private/tmp",
        "/Volumes/",
        "/Users/alice",
    ):
        assert canary not in cleaned
    assert cleaned.count("<REDACTED>") == 4
    assert cleaned.count("<PRIVATE_PATH>") == 3
    assert "The pairingToken field is required, but no value was logged." in cleaned


def test_report_redaction_is_idempotent_for_empty_and_explicitly_redacted_fields() -> None:
    module = load_module()
    safe = "\n".join([
        '"authorization": ""',
        '"pairingToken": "[REDACTED]"',
        '"token": "[已脱敏]"',
        "cookie=<REDACTED>",
        "A security guide can mention pairingToken without logging a value.",
    ])

    assert module.redact(safe) == safe


def test_real_account_acceptance_is_pending_without_evidence() -> None:
    module = load_module()

    assert module.load_acceptance(None)["status"] == "pending"


def test_commercial_gate_fails_closed_unless_automated_only_is_explicit() -> None:
    module = load_module()

    assert module.gate_exit_code("fail", "blocked", True) == 1
    assert module.gate_exit_code("pass", "blocked", False) == 2
    assert module.gate_exit_code("pass", "blocked", True) == 0
    assert module.gate_exit_code("pass", "pass", False) == 0


def test_acceptance_attestation_rejects_post_signature_edits(tmp_path: Path) -> None:
    module = load_module()
    payload = {"schema": module.ACCEPTANCE_SCHEMA, "status": "pass", "reviewer": {"review_id": "review-001"}}
    public_key, registry = sign_acceptance(module, payload, tmp_path)
    errors: list[str] = []
    module.verify_acceptance_signature(payload, public_key, registry, errors)
    assert errors == []

    unapproved_registry = tmp_path / "unapproved-qa-keys.json"
    unapproved_registry.write_text(json.dumps({
        "schema": module.TRUSTED_QA_KEY_REGISTRY_SCHEMA,
        "keys": [],
    }), encoding="utf-8")
    errors = []
    module.verify_acceptance_signature(payload, public_key, unapproved_registry, errors)
    assert errors == ["attestation is not bound to the trusted QA key registry"]

    payload["status"] = "pending"
    errors = []
    module.verify_acceptance_signature(payload, public_key, registry, errors)
    assert errors == ["acceptance signature verification failed"]


def test_release_binding_rejects_a_replaced_dmg(tmp_path: Path) -> None:
    module = load_module()
    release_root, build = write_release_fixture(tmp_path, module)
    payload = {"build": build}
    errors: list[str] = []
    verified = module.verify_release_binding(payload, release_root, errors)
    assert errors == []
    assert verified["dmg_sha256"] == build["dmg_sha256"]

    (release_root / module.DMG_FILENAME).write_bytes(b"replaced after QA acceptance")
    errors = []
    module.verify_release_binding(payload, release_root, errors)
    assert any("dmg_sha256 does not match" in error for error in errors)


def test_real_account_acceptance_requires_versioned_evidence(tmp_path: Path) -> None:
    module = load_module()
    record = tmp_path / "acceptance.json"
    run_id = "acceptance-run-001"
    slug = "acceptance-topic"
    backup_sha256 = "b" * 64
    trust = create_qa_trust(module, tmp_path)
    release_root, build = write_release_fixture(tmp_path, module, trust[2])
    evidence = []
    for kind in sorted(module.REQUIRED_ACCEPTANCE_EVIDENCE):
        role = module.REQUIRED_ARTIFACT_ROLE_AND_PRODUCER[kind][0]
        artifact_path = tmp_path / "artifacts" / f"{kind}.json"
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text(
            json.dumps(domain_artifact(module, kind, run_id, slug, backup_sha256, build["dmg_sha256"])),
            encoding="utf-8",
        )
        assertions = dict(module.REQUIRED_EVIDENCE_ASSERTIONS[kind])
        if kind == "backup-restore":
            assertions["backup_sha256"] = backup_sha256
        evidence_path = tmp_path / "evidence" / f"{kind}.json"
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps({
            "schema": module.EVIDENCE_SCHEMA,
            "kind": kind,
            "result": "pass",
            "captured_at": "2026-08-24T11:30:00+08:00",
            "run_id": run_id,
            "slug": slug,
            "evidence_id": f"envelope-{kind}",
            "observation": f"QA observed the complete {kind} acceptance behavior.",
            "assertions": assertions,
            "artifacts": [{
                "role": role,
                "path": str(artifact_path.relative_to(tmp_path)),
                "sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
            }],
        }), encoding="utf-8")
        evidence.append({
            "kind": kind,
            "result": "pass",
            "path": str(evidence_path.relative_to(tmp_path)),
            "sha256": hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
        })
    fault = next(item for item in evidence if item["kind"] == "fault-recovery")
    fault["scenarios"] = []
    for name in sorted(module.REQUIRED_FAULT_SCENARIOS):
        artifact_path = tmp_path / "artifacts" / "faults" / f"{name}.json"
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text(json.dumps({
            "schema": module.FAULT_ARTIFACT_SCHEMA,
            "scenario": name,
            "role": "fault-state-transition",
            "producer": "fault-harness",
            "result": "pass",
            "captured_at": "2026-08-24T11:40:00+08:00",
            "run_id": run_id,
            "slug": slug,
            "event_id": f"fault-event-{name}",
            "before_state_sha256": hashlib.sha256(f"before:{name}".encode()).hexdigest(),
            "after_state_sha256": hashlib.sha256(f"after:{name}".encode()).hexdigest(),
            "source_log_sha256": hashlib.sha256(f"log:{name}".encode()).hexdigest(),
            "safe_outcome_observed": True,
            "observation": f"QA observed safe recovery for {name} without cross-run writes.",
        }), encoding="utf-8")
        scenario_path = tmp_path / "evidence" / "faults" / f"{name}.json"
        scenario_path.parent.mkdir(parents=True, exist_ok=True)
        scenario_path.write_text(json.dumps({
            "schema": module.FAULT_EVIDENCE_SCHEMA,
            "name": name,
            "result": "pass",
            "captured_at": "2026-08-24T11:45:00+08:00",
            "run_id": run_id,
            "slug": slug,
            "evidence_id": f"fault-envelope-{name}",
            "safe_outcome_observed": True,
            "observation": f"QA observed safe recovery for {name} without cross-run writes.",
            "artifacts": [{
                "role": "fault-state-transition",
                "path": str(artifact_path.relative_to(tmp_path)),
                "sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
            }],
        }), encoding="utf-8")
        fault["scenarios"].append({
            "name": name,
            "result": "pass",
            "path": str(scenario_path.relative_to(tmp_path)),
            "sha256": hashlib.sha256(scenario_path.read_bytes()).hexdigest(),
        })
    payload = {
        "schema": module.ACCEPTANCE_SCHEMA,
        "status": "pass",
        "product_version": module.VERSION,
        "target": module.TARGET,
        "accepted_at": "2026-08-24T12:00:00+08:00",
        "reviewer": {
            "name": "QA",
            "organization": "Independent QA",
            "review_id": "review-acceptance-001",
            "independent_from_implementation": True,
            "confirmed_no_secrets": True,
            "confirmed_no_public_send": True,
        },
        "machine": {
            "model": "Mac mini",
            "acceptance_machine_id": "acceptance-mac-001",
            "architecture": "arm64",
            "macos_version": "13.6.9",
            "macos_major": 13,
            "clean_machine": True,
            "node_preinstalled": False,
            "python_preinstalled": False,
            "homebrew_preinstalled": False,
        },
        "build": build,
        "run": {
            "run_id": run_id,
            "slug": slug,
            "project_backup_sha256": backup_sha256,
            "archetype_run_ids": {"methodology": "run-methodology", "founder_story": "run-founder-story", "research_analysis": "run-research-analysis"},
        },
        "evidence": evidence,
    }
    public_key, registry = sign_acceptance(module, payload, tmp_path, trust)
    record.write_text(json.dumps(payload), encoding="utf-8")

    result = module.load_acceptance(
        record,
        trusted_public_key=public_key,
        trusted_key_registry=registry,
        release_root=release_root,
    )

    assert result["status"] == "pass"
    assert result["evidence_count"] == len(module.REQUIRED_ACCEPTANCE_EVIDENCE)


def test_signed_acceptance_rejects_hashed_placeholder_artifacts(tmp_path: Path) -> None:
    module = load_module()
    trust = create_qa_trust(module, tmp_path)
    release_root, build = write_release_fixture(tmp_path, module, trust[2])
    run_id, slug, backup_sha = "acceptance-run-001", "acceptance-topic", "b" * 64
    evidence: list[dict] = []
    for kind in sorted(module.REQUIRED_ACCEPTANCE_EVIDENCE):
        role = module.REQUIRED_ARTIFACT_ROLE_AND_PRODUCER[kind][0]
        placeholder = tmp_path / "artifacts" / f"{kind}.txt"
        placeholder.parent.mkdir(parents=True, exist_ok=True)
        placeholder.write_text(f"QA says {kind} passed\n", encoding="utf-8")
        assertions = dict(module.REQUIRED_EVIDENCE_ASSERTIONS[kind])
        if kind == "backup-restore":
            assertions["backup_sha256"] = backup_sha
        envelope = tmp_path / "evidence" / f"{kind}.json"
        envelope.parent.mkdir(parents=True, exist_ok=True)
        envelope.write_text(json.dumps({
            "schema": module.EVIDENCE_SCHEMA,
            "kind": kind,
            "result": "pass",
            "captured_at": "2026-08-24T11:30:00+08:00",
            "run_id": run_id,
            "slug": slug,
            "evidence_id": f"envelope-{kind}",
            "observation": f"QA observed complete {kind} acceptance behavior.",
            "assertions": assertions,
            "artifacts": [{
                "role": role,
                "path": str(placeholder.relative_to(tmp_path)),
                "sha256": hashlib.sha256(placeholder.read_bytes()).hexdigest(),
            }],
        }), encoding="utf-8")
        evidence.append({
            "kind": kind,
            "result": "pass",
            "path": str(envelope.relative_to(tmp_path)),
            "sha256": hashlib.sha256(envelope.read_bytes()).hexdigest(),
        })
    fault = next(row for row in evidence if row["kind"] == "fault-recovery")
    fault["scenarios"] = []
    for name in sorted(module.REQUIRED_FAULT_SCENARIOS):
        placeholder = tmp_path / "artifacts" / "faults" / f"{name}.txt"
        placeholder.parent.mkdir(parents=True, exist_ok=True)
        placeholder.write_text(f"safe {name}\n", encoding="utf-8")
        envelope = tmp_path / "evidence" / "faults" / f"{name}.json"
        envelope.parent.mkdir(parents=True, exist_ok=True)
        envelope.write_text(json.dumps({
            "schema": module.FAULT_EVIDENCE_SCHEMA,
            "name": name,
            "result": "pass",
            "captured_at": "2026-08-24T11:45:00+08:00",
            "run_id": run_id,
            "slug": slug,
            "evidence_id": f"fault-envelope-{name}",
            "safe_outcome_observed": True,
            "observation": f"QA observed safe recovery for {name}.",
            "artifacts": [{
                "role": "fault-state-transition",
                "path": str(placeholder.relative_to(tmp_path)),
                "sha256": hashlib.sha256(placeholder.read_bytes()).hexdigest(),
            }],
        }), encoding="utf-8")
        fault["scenarios"].append({
            "name": name,
            "result": "pass",
            "path": str(envelope.relative_to(tmp_path)),
            "sha256": hashlib.sha256(envelope.read_bytes()).hexdigest(),
        })
    payload = {
        "schema": module.ACCEPTANCE_SCHEMA,
        "status": "pass",
        "product_version": module.VERSION,
        "target": module.TARGET,
        "accepted_at": "2026-08-24T12:00:00+08:00",
        "reviewer": {
            "name": "QA", "organization": "Independent QA", "review_id": "review-placeholder-001",
            "independent_from_implementation": True, "confirmed_no_secrets": True,
            "confirmed_no_public_send": True,
        },
        "machine": {
            "model": "Mac mini", "acceptance_machine_id": "acceptance-mac-001", "architecture": "arm64",
            "macos_version": "13.6.9", "macos_major": 13, "clean_machine": True,
            "node_preinstalled": False, "python_preinstalled": False, "homebrew_preinstalled": False,
        },
        "build": build,
        "run": {
            "run_id": run_id,
            "slug": slug,
            "project_backup_sha256": backup_sha,
            "archetype_run_ids": {"methodology": "run-methodology", "founder_story": "run-founder-story", "research_analysis": "run-research-analysis"},
        },
        "evidence": evidence,
    }
    public_key, registry = sign_acceptance(module, payload, tmp_path, trust)
    record = tmp_path / "acceptance.json"
    record.write_text(json.dumps(payload), encoding="utf-8")

    result = module.load_acceptance(
        record,
        trusted_public_key=public_key,
        trusted_key_registry=registry,
        release_root=release_root,
    )

    assert result["status"] == "invalid"
    assert any("domain artifact must be a small JSON file" in error for error in result["validation_errors"])
    assert any("fault artifact must be a small JSON file" in error for error in result["validation_errors"])


def test_real_account_acceptance_rejects_semantically_empty_hashed_envelopes(tmp_path: Path) -> None:
    module = load_module()
    envelope = tmp_path / "evidence" / "clean-install.json"
    envelope.parent.mkdir(parents=True)
    envelope.write_text(json.dumps({"kind": "clean-install", "verified": True}), encoding="utf-8")

    item = {
        "kind": "clean-install",
        "result": "pass",
        "path": str(envelope.relative_to(tmp_path)),
        "sha256": hashlib.sha256(envelope.read_bytes()).hexdigest(),
    }
    record = tmp_path / "acceptance.json"
    record.write_text(json.dumps({
        "schema": "echo-founder.real-account-acceptance.v1",
        "status": "pass",
        "product_version": "0.2.0-beta.2",
        "target": "macOS 13+ / Apple Silicon",
        "accepted_at": "2026-08-24T12:00:00+08:00",
        "reviewer": {"name": "QA", "confirmed_no_secrets": True, "confirmed_no_public_send": True},
        "machine": {
            "model": "Mac mini", "architecture": "arm64", "macos_version": "13.6.9", "macos_major": 13,
            "clean_machine": True, "node_preinstalled": False, "python_preinstalled": False, "homebrew_preinstalled": False,
        },
        "run": {"run_id": "acceptance-run-001", "slug": "acceptance-topic", "project_backup_sha256": "d" * 64},
        "evidence": [item],
    }), encoding="utf-8")

    result = module.load_acceptance(record)

    assert result["status"] == "invalid"
    assert any("envelope schema" in error for error in result["validation_errors"])


def test_real_account_acceptance_rejects_secret_canaries_inside_hashed_evidence(tmp_path: Path) -> None:
    module = load_module()
    secret_file = tmp_path / "evidence" / "secret.log"
    secret_file.parent.mkdir(parents=True)
    secret_file.write_text("Authorization: Bearer should-never-enter-acceptance\n", encoding="utf-8")
    item = {
        "path": str(secret_file.relative_to(tmp_path)),
        "sha256": hashlib.sha256(secret_file.read_bytes()).hexdigest(),
    }

    # Exercise the production acceptance loader through a minimal invalid
    # record and ensure its reference validator catches content, not only SHA.
    envelope = tmp_path / "evidence" / "clean-install.json"
    envelope.write_text(json.dumps({
        "schema": module.EVIDENCE_SCHEMA,
        "kind": "clean-install",
        "result": "pass",
        "captured_at": "2026-08-24T12:00:00+08:00",
        "run_id": "acceptance-run-001",
        "slug": "acceptance-topic",
        "evidence_id": "envelope-clean-install-secret",
        "observation": "A complete clean installation was observed.",
        "assertions": module.REQUIRED_EVIDENCE_ASSERTIONS["clean-install"],
        "artifacts": [{"role": "dmg-open-smoke-report", **item}],
    }), encoding="utf-8")
    record = tmp_path / "acceptance.json"
    record.write_text(json.dumps({
        "schema": "echo-founder.real-account-acceptance.v1", "status": "pass",
        "product_version": "0.2.0-beta.2", "target": "macOS 13+ / Apple Silicon",
        "accepted_at": "2026-08-24T12:00:00+08:00",
        "reviewer": {"name": "QA", "confirmed_no_secrets": True, "confirmed_no_public_send": True},
        "machine": {"model": "Mac mini", "architecture": "arm64", "macos_version": "13.6.9", "macos_major": 13,
                    "clean_machine": True, "node_preinstalled": False, "python_preinstalled": False, "homebrew_preinstalled": False},
        "run": {"run_id": "acceptance-run-001", "slug": "acceptance-topic", "project_backup_sha256": "e" * 64},
        "evidence": [{"kind": "clean-install", "result": "pass", "path": str(envelope.relative_to(tmp_path)),
                      "sha256": hashlib.sha256(envelope.read_bytes()).hexdigest()}],
    }), encoding="utf-8")

    result = module.load_acceptance(record)

    assert result["status"] == "invalid"
    assert any("unredacted secret" in error for error in result["validation_errors"])


def test_real_account_acceptance_rejects_flags_without_real_evidence_files(tmp_path: Path) -> None:
    module = load_module()
    record = tmp_path / "acceptance.json"
    evidence = [
        {
            "kind": kind,
            "result": "pass",
            "path": f"evidence/{kind}.json",
            "sha256": "a" * 64,
        }
        for kind in sorted(module.REQUIRED_ACCEPTANCE_EVIDENCE)
    ]
    fault = next(item for item in evidence if item["kind"] == "fault-recovery")
    fault["scenarios"] = [
        {
            "name": name,
            "result": "pass",
            "path": f"evidence/faults/{name}.json",
            "sha256": "b" * 64,
        }
        for name in sorted(module.REQUIRED_FAULT_SCENARIOS)
    ]
    record.write_text(json.dumps({
        "schema": "echo-founder.real-account-acceptance.v1",
        "status": "pass",
        "product_version": "0.2.0-beta.2",
        "target": "macOS 13+ / Apple Silicon",
        "accepted_at": "2026-08-24T12:00:00+08:00",
        "reviewer": {
            "name": "QA",
            "confirmed_no_secrets": True,
            "confirmed_no_public_send": True,
        },
        "machine": {
            "model": "Mac mini",
            "architecture": "arm64",
            "macos_version": "13.6.9",
            "macos_major": 13,
            "clean_machine": True,
            "node_preinstalled": False,
            "python_preinstalled": False,
            "homebrew_preinstalled": False,
        },
        "run": {
            "run_id": "acceptance-run-001",
            "slug": "acceptance-topic",
            "project_backup_sha256": "c" * 64,
        },
        "evidence": evidence,
    }), encoding="utf-8")

    result = module.load_acceptance(record)

    assert result["status"] == "invalid"
    assert any("No such file" in error for error in result["validation_errors"])


def test_real_account_acceptance_cannot_pass_with_partial_evidence(tmp_path: Path) -> None:
    module = load_module()
    record = tmp_path / "partial.json"
    record.write_text(
        json.dumps(
            {
                "schema": "echo-founder.real-account-acceptance.v1",
                "status": "pass",
                "product_version": "0.2.0-beta.2",
                "reviewer": {"name": "QA"},
                "machine": {"architecture": "arm64", "macos_major": 14},
                "evidence": [{"kind": "clean-install", "result": "pass"}],
            }
        ),
        encoding="utf-8",
    )

    result = module.load_acceptance(record)

    assert result["status"] == "invalid"
    assert "paid-image-provider-benchmark" in result["missing_evidence"]
