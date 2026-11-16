from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "desktop_packaged_smoke.py"
OPEN_SCRIPT = REPO_ROOT / "scripts" / "desktop_packaged_open_smoke.py"
PACKAGE_SCRIPT = REPO_ROOT / "scripts" / "desktop_package.py"
MAKEFILE = REPO_ROOT / "Makefile"


def load_module():
    spec = importlib.util.spec_from_file_location("desktop_packaged_smoke_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_open_module():
    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("desktop_packaged_open_smoke_under_test", OPEN_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_package_module():
    spec = importlib.util.spec_from_file_location("desktop_package_for_smoke_digest_test", PACKAGE_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_playwright_runtime_digest_matches_packager_tree_contract(tmp_path) -> None:
    smoke = load_module()
    package = load_package_module()
    root = tmp_path / "runtime"
    (root / "bin").mkdir(parents=True)
    (root / "empty").mkdir()
    (root / "bin" / "tool").write_text("tool\n", encoding="utf-8")
    (root / "bin" / "tool").chmod(0o755)
    (root / "data.txt").write_text("data\n", encoding="utf-8")
    (root / "data.txt").chmod(0o644)
    (root / "tool-link").symlink_to("bin/tool")

    expected = "9261c074bbf33c354662ffbefad0b8e153b9731bb4c8bd6646bd8f0768ddbc2f"
    assert smoke.directory_sha256(root) == expected
    assert package.runtime_tree_fingerprint(root)["tree_sha256"] == expected


def test_diagnostics_smoke_contract_uses_echo_founder_identity(monkeypatch) -> None:
    module = load_module()
    payload = {
        "packageType": "echo-founder-desktop-diagnostics-package",
        "schema": "echo-founder.desktop-diagnostics.v1",
        "diagnostics": {},
        "logs": {},
        "manifests": {},
    }

    class FakeResponse:
        status = 200
        headers = {"Content-Disposition": 'attachment; filename="echo-founder-diagnostics.json"'}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(payload).encode("utf-8")

    monkeypatch.setattr(module.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse())

    assert module.fetch_diagnostics_package(31820) == (True, "diagnostics package ok")

    payload["schema"] = "aifios.desktop-diagnostics.v1"
    ok, detail = module.fetch_diagnostics_package(31820)
    assert ok is False
    assert detail == "unexpected schema: aifios.desktop-diagnostics.v1"


def test_app_tree_integrity_allows_approved_bytecode_and_detects_runtime_writes(tmp_path) -> None:
    module = load_module()
    app = tmp_path / "Echo Founder.app"
    approved_bytecode = app / "Contents/Resources/runtime/python/__pycache__/encodings.pyc"
    approved_bytecode.parent.mkdir(parents=True)
    approved_bytecode.write_bytes(b"approved signed runtime bytecode\n")
    before = module.directory_sha256(app)

    assert module.verify_app_tree_unchanged(app, before) == (
        True,
        f"app tree unchanged: {before}",
    )

    (approved_bytecode.parent / "runtime-created.pyc").write_bytes(b"unexpected runtime write\n")
    ok, detail = module.verify_app_tree_unchanged(app, before)
    assert ok is False
    assert f"before={before}" in detail
    assert "after=" in detail


def test_app_signature_verifier_requires_deep_strict_codesign(tmp_path, monkeypatch) -> None:
    module = load_module()
    app = tmp_path / "Echo Founder.app"
    app.mkdir()
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        return module.subprocess.CompletedProcess(command, 0, stdout="")

    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/codesign" if name == "codesign" else None)
    monkeypatch.setattr(module.subprocess, "run", fake_run)

    assert module.verify_app_code_signature(app) == (True, "deep strict code signature valid")
    assert calls == [["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)]]


def test_arm64_delivery_architecture_reaches_local_and_hosted_packaged_smoke() -> None:
    module = load_module()
    makefile = MAKEFILE.read_text(encoding="utf-8")

    assert module.DEFAULT_EXPECTED_ARCHITECTURE == "arm64"
    assert "DESKTOP_PACKAGED_EXPECTED_ARCH ?= $(DESKTOP_PACKAGE_ARCH)" in makefile
    assert makefile.count('--expected-architecture "$(DESKTOP_PACKAGED_EXPECTED_ARCH)"') == 2


def test_open_smokes_exercise_a_true_default_first_launch_without_product_overrides(tmp_path) -> None:
    module = load_open_module()
    makefile = MAKEFILE.read_text(encoding="utf-8")

    project, user_data = module.default_first_launch_paths(tmp_path)
    environment = module.default_first_launch_environment(tmp_path)

    assert project == tmp_path / "Echo Founder"
    assert user_data == tmp_path / "Library" / "Application Support" / "Echo Founder"
    assert not any(key.startswith("AIFIOS_") for key in environment)
    assert environment["PATH"] == str(tmp_path / "empty-path")
    assert makefile.count("--default-first-launch") == 2
    assert '/usr/bin/env", "-i"' in OPEN_SCRIPT.read_text(encoding="utf-8")


def test_open_launch_uses_standard_isolated_user_data_and_no_product_override(tmp_path, monkeypatch) -> None:
    module = load_open_module()
    app = tmp_path / "Echo Founder.app"
    user_data = tmp_path / "Library" / "Application Support" / "Echo Founder"
    log = tmp_path / "launch" / "open.log"
    environment = module.default_first_launch_environment(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        return module.subprocess.CompletedProcess(command, 0, stdout="")

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    module.launch_with_open(app, environment, log, user_data, clear_parent_environment=True)

    command = calls[0]
    assert command[:3] == ["/usr/bin/env", "-i", "/usr/bin/open"]
    assert "--args" in command
    assert f"--user-data-dir={user_data}" in command
    assert not any("AIFIOS_" in part for part in command)
    assert "--stdout" in command
    assert "--stderr" in command


def test_opened_app_pid_lookup_matches_only_the_exact_main_binary_and_user_data(tmp_path, monkeypatch) -> None:
    module = load_open_module()
    app = tmp_path / "Echo Founder.app"
    binary = app / "Contents" / "MacOS" / "Echo Founder"
    user_data = tmp_path / "isolated-user-data"
    output = "\n".join(
        [
            f"101 {binary} --user-data-dir=/tmp/wrong",
            f"102 {app}/Contents/Frameworks/Electron Helper --user-data-dir={user_data}",
            f"104 {binary} --user-data-dir={user_data}-prefix-collision",
            f"103 {binary} --user-data-dir={user_data}",
        ]
    )
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda command, **_kwargs: module.subprocess.CompletedProcess(command, 0, stdout=output),
    )

    assert module.find_opened_app_pid(app, user_data) == 103


def test_opened_app_pid_query_uses_anchored_pgrep_fallback(tmp_path, monkeypatch) -> None:
    module = load_open_module()
    app = tmp_path / "Echo Founder.app"
    user_data = tmp_path / "isolated-user-data"
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        if command[0] == "/bin/ps":
            return module.subprocess.CompletedProcess(command, 2, stdout="")
        return module.subprocess.CompletedProcess(command, 0, stdout="301\n")

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    assert module.query_opened_app_pids(app, user_data) == ([301], True)
    assert calls[1][:2] == ["/usr/bin/pgrep", "-f"]
    assert calls[1][2].startswith("^")
    assert "(?:" not in calls[1][2]
    assert "[[:space:]]" in calls[1][2]
    assert module.re.escape(str(app / "Contents" / "MacOS" / "Echo Founder")) in calls[1][2]


def test_process_exists_uses_signal_zero_for_positive_pid(monkeypatch) -> None:
    module = load_open_module()
    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(module.os, "kill", lambda pid, signal: calls.append((pid, signal)))

    assert module.process_exists(42) is True
    assert module.process_exists(0) is False
    assert calls == [(42, 0)]


def test_failed_open_cleanup_rediscovers_and_terminates_the_isolated_process(tmp_path, monkeypatch) -> None:
    module = load_open_module()
    app = tmp_path / "Echo Founder.app"
    user_data = tmp_path / "isolated-user-data"
    query_results = iter([([321], True), ([], True), ([], True), ([], True)])
    terminated: list[int] = []

    monkeypatch.setattr(module, "query_opened_app_pids", lambda *_args: next(query_results))
    monkeypatch.setattr(module, "terminate_opened_app", terminated.append)
    monkeypatch.setattr(module.time, "sleep", lambda _seconds: None)

    assert module.cleanup_isolated_opened_apps(app, user_data, 0) == (True, [])
    assert terminated == [321]


def test_failed_open_cleanup_fails_closed_when_process_query_is_unavailable(tmp_path, monkeypatch) -> None:
    module = load_open_module()
    monkeypatch.setattr(module, "query_opened_app_pids", lambda *_args: ([], False))

    assert module.cleanup_isolated_opened_apps(
        tmp_path / "Echo Founder.app",
        tmp_path / "isolated-user-data",
    ) == (False, [])


def test_stale_known_pid_is_never_signaled_without_an_exact_process_match(tmp_path, monkeypatch) -> None:
    module = load_open_module()
    terminated: list[int] = []
    monkeypatch.setattr(module, "query_opened_app_pids", lambda *_args: ([], True))
    monkeypatch.setattr(module, "terminate_opened_app", terminated.append)
    monkeypatch.setattr(module.time, "sleep", lambda _seconds: None)

    assert module.cleanup_isolated_opened_apps(
        tmp_path / "Echo Founder.app",
        tmp_path / "isolated-user-data",
        known_pid=999,
    ) == (True, [])
    assert terminated == []


def test_cleanup_catches_a_process_that_appears_after_the_first_empty_snapshot(tmp_path, monkeypatch) -> None:
    module = load_open_module()
    query_results = iter(
        [
            ([], True),
            ([654], True),
            ([], True),
            ([], True),
            ([], True),
        ]
    )
    terminated: list[int] = []
    monkeypatch.setattr(module, "query_opened_app_pids", lambda *_args: next(query_results))
    monkeypatch.setattr(module, "terminate_opened_app", terminated.append)
    monkeypatch.setattr(module.time, "sleep", lambda _seconds: None)

    assert module.cleanup_isolated_opened_apps(
        tmp_path / "Echo Founder.app",
        tmp_path / "isolated-user-data",
    ) == (True, [])
    assert terminated == [654]


def test_dirty_home_preflight_never_terminates_a_process_it_did_not_launch(tmp_path, monkeypatch) -> None:
    module = load_open_module()
    app = tmp_path / "Echo Founder.app"
    app.mkdir()
    isolated_home = tmp_path / "isolated-home"
    project, user_data = module.default_first_launch_paths(isolated_home)
    project.mkdir(parents=True)
    cleanup_calls: list[tuple[object, ...]] = []
    monkeypatch.setattr(
        module,
        "cleanup_isolated_opened_apps",
        lambda *args, **_kwargs: cleanup_calls.append(args) or (True, []),
    )
    monkeypatch.setattr(
        module,
        "launch_with_open",
        lambda *_args, **_kwargs: pytest.fail("preflight failure must not invoke open"),
    )

    result = module.run_open_smoke(
        app,
        project,
        user_data,
        0,
        10,
        "bundled-runtime",
        None,
        default_first_launch=True,
        isolated_home=isolated_home,
    )

    assert result == 1
    assert cleanup_calls == []


def write_hosted_bundle(root: Path, gateway_url: str = "https://gateway.example.com") -> None:
    resources = root / "Contents" / "Resources"
    runtime = resources / "aifios"
    runtime.mkdir(parents=True)
    (resources / "aifios-distribution.json").write_text(
        '{"schema":"aifios.desktop-distribution.v1","mode":"hosted-license","deviceBinding":true}\n',
        encoding="utf-8",
    )
    runtime.joinpath("hosted-client.json").write_text(
        '{"schema":"aifios.hosted-client.v1","gatewayUrl":"' + gateway_url + '","licenseMode":"device-bound"}\n',
        encoding="utf-8",
    )


def test_hosted_bundle_verifier_accepts_public_https_metadata(tmp_path) -> None:
    module = load_module()
    app = tmp_path / "AIFIOS.app"
    write_hosted_bundle(app)

    ok, detail = module.verify_hosted_license_bundle(app)

    assert ok is True
    assert "device-bound" in detail


def test_hosted_bundle_verifier_rejects_insecure_or_credential_bearing_gateway(tmp_path) -> None:
    module = load_module()
    app = tmp_path / "AIFIOS.app"
    write_hosted_bundle(app, "https://buyer:secret@gateway.example.com")

    ok, detail = module.verify_hosted_license_bundle(app)

    assert ok is False
    assert "HTTPS gateway origin" in detail


def test_paid_device_identity_verifier_requires_keychain_ciphertext(tmp_path) -> None:
    module = load_module()
    tmp_path.joinpath("device-id.json").write_text(
        '{"schema":"aifios.desktop-device.v3","algorithm":"Ed25519","storage":"os-keychain",'
        '"keyId":"ed25519:BuP9j9opu2CrWVV95h7bCuzbIxE0vjDnW0Vfjht5L6k",'
        '"publicKeySpki":"MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",'
        '"privateKeyCiphertext":"YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU="}\n',
        encoding="utf-8",
    )

    ok, detail = module.verify_encrypted_device_identity(tmp_path)

    assert ok is True
    assert "encrypted" in detail


def test_paid_device_identity_verifier_rejects_plaintext_fallback(tmp_path) -> None:
    module = load_module()
    tmp_path.joinpath("device-id.json").write_text(
        '{"schema":"aifios.desktop-device.v3","algorithm":"Ed25519","storage":"file-fallback",'
        '"deviceId":"plain-device"}\n',
        encoding="utf-8",
    )

    ok, detail = module.verify_encrypted_device_identity(tmp_path)

    assert ok is False
    assert "OS keychain" in detail
