from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import plistlib
import stat
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "desktop_package.py"


def load_module():
    spec = importlib.util.spec_from_file_location("desktop_package_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_minimal_xhs_card(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text("# xhs-card\n", encoding="utf-8")
    (root / "LICENSE").write_text("GNU AFFERO GENERAL PUBLIC LICENSE Version 3\n", encoding="utf-8")
    (root / "README.md").write_text("# xhs-card\nAGPL-3.0-only\nLICENSE is authoritative.\n", encoding="utf-8")
    (root / "README.en.md").write_text(
        "# xhs-card\nAGPL-3.0-only\nLICENSE is authoritative.\n",
        encoding="utf-8",
    )
    (root / "MODIFICATIONS.md").write_text(
        "AGPL-3.0-only source snapshot; review remote network interaction.\n",
        encoding="utf-8",
    )
    (root / "package.json").write_text(
        json.dumps({"name": "xhs-card", "version": "1.0.0", "license": "AGPL-3.0-only"}) + "\n",
        encoding="utf-8",
    )
    (root / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "xhs-card",
                "version": "1.0.0",
                "lockfileVersion": 3,
                "packages": {
                    "": {
                        "name": "xhs-card",
                        "version": "1.0.0",
                        "license": "AGPL-3.0-only",
                        "dependencies": {"playwright": "1.60.0"},
                    },
                    "node_modules/fsevents": {"version": "2.3.2", "optional": True},
                    "node_modules/playwright": {"version": "1.60.0", "license": "Apache-2.0"},
                    "node_modules/playwright-core": {"version": "1.60.0"},
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )


def write_approved_tikomni_fixture(module, root: Path, monkeypatch) -> None:
    for relative in module.TIKOMNI_BUNDLE_FILES:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if relative == module.TIKOMNI_RESOLVER_RELATIVE_PATH:
            path.write_text(
                "import json\n"
                "print(json.dumps({'ok': True, 'recommended': {'endpoint_id': 'fixture.search'}}))\n",
                encoding="utf-8",
            )
        else:
            path.write_text(f"# {relative.as_posix()}\n", encoding="utf-8")
    file_hashes = {
        relative.as_posix(): module.sha256_file(root / relative)
        for relative in module.TIKOMNI_BUNDLE_FILES
    }
    monkeypatch.setattr(module, "TIKOMNI_APPROVED_FILE_SHA256", file_hashes)
    monkeypatch.setattr(
        module,
        "TIKOMNI_APPROVED_SNAPSHOT_SHA256",
        module.tikomni_snapshot_sha256(file_hashes),
    )


def write_inventory_fixture(module, tmp_path: Path, monkeypatch) -> Path:
    app = tmp_path / "Echo Founder.app"
    resources = app / "Contents" / "Resources"
    runtime = resources / "aifios"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "Frameworks" / "Electron Framework.framework").mkdir(parents=True)
    (runtime / "docs").mkdir(parents=True)
    (runtime / "docs" / "third-party-notices.md").write_text("# notices\n", encoding="utf-8")

    standalone = module.next_standalone_root(runtime / "ui" / module.DESKTOP_DIST_DIR)
    for name, version, license_expression in (
        ("next", "16.3.2", "MIT"),
        ("react", "19.2.4", "MIT"),
    ):
        package = standalone / "node_modules" / name
        package.mkdir(parents=True)
        (package / "package.json").write_text(
            json.dumps(
                {
                    "name": name,
                    "version": version,
                    "license": license_expression,
                    "repository": f"https://example.test/{name}",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (package / "LICENSE").write_text(f"{name} test license\n", encoding="utf-8")
    compiled = standalone / "node_modules" / "next" / "dist" / "compiled" / "incomplete"
    compiled.mkdir(parents=True)
    (compiled / "package.json").write_text(
        json.dumps({"name": "compiled-with-incomplete-metadata"}) + "\n",
        encoding="utf-8",
    )

    xhs = runtime / "skills" / "xhs-card"
    write_minimal_xhs_card(xhs)
    for package_name, version, license_expression in (
        ("fsevents", "2.3.2", "MIT"),
        ("playwright", "1.60.0", "Apache-2.0"),
        ("playwright-core", "1.60.0", "Apache-2.0"),
    ):
        package = xhs / "node_modules" / package_name
        package.mkdir(parents=True)
        (package / "package.json").write_text(
            json.dumps({"name": package_name, "version": version, "license": license_expression}) + "\n",
            encoding="utf-8",
        )
        (package / "LICENSE").write_text(f"{license_expression} license\n", encoding="utf-8")
        if package_name != "fsevents":
            (package / "NOTICE").write_text(f"{package_name} notice\n", encoding="utf-8")
            (package / "ThirdPartyNotices.txt").write_text("third-party notices\n", encoding="utf-8")
            bundled_license = package / "lib" / "bundle.js.LICENSE"
            bundled_license.parent.mkdir()
            bundled_license.write_text("bundled dependency license\n", encoding="utf-8")

    tikomni = runtime / "skills" / module.TIKOMNI_SKILL_NAME
    write_approved_tikomni_fixture(module, tikomni, monkeypatch)

    python_license = runtime / "runtime" / "python" / "arm64" / "lib" / "python3.11" / "LICENSE.txt"
    python_license.parent.mkdir(parents=True)
    python_license.write_text("Python Software Foundation License Version 2\n", encoding="utf-8")
    site_packages = python_license.parent / "site-packages"
    for relative, name, version, license_expression in (
        (Path("pip-26.1.1.dist-info"), "pip", "26.1.1", "MIT"),
        (Path("setuptools-82.0.1.dist-info"), "setuptools", "82.0.1", "MIT"),
        (
            Path("setuptools/_vendor/jaraco.text-4.0.0.dist-info"),
            "jaraco.text",
            "4.0.0",
            "",
        ),
    ):
        dist_info = site_packages / relative
        licenses = dist_info / "licenses"
        licenses.mkdir(parents=True)
        metadata_lines = [f"Name: {name}", f"Version: {version}"]
        if license_expression:
            metadata_lines.append(f"License-Expression: {license_expression}")
        (dist_info / "METADATA").write_text("\n".join(metadata_lines) + "\n\n", encoding="utf-8")
        (licenses / "LICENSE").write_text(f"{name} license evidence\n", encoding="utf-8")

    playwright_runtime = runtime / "runtime" / "playwright"
    browser = playwright_runtime / "arm64"
    browser.mkdir(parents=True)
    (browser / "LICENSE.headless_shell").write_text("Chromium and third-party notices\n", encoding="utf-8")
    (playwright_runtime / "manifest.json").write_text(
        json.dumps(
            {
                "schema": module.PLAYWRIGHT_RUNTIME_SCHEMA,
                "tree_hash_schema": module.RUNTIME_TREE_HASH_SCHEMA,
                "playwright_version": "1.60.0",
                "headless_shell_revision": "1223",
                "architectures": {"arm64": {"source_revision": "1223"}},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    # Formal builds copy notices out of the verified Electron release archive.
    # The inventory must never reach back into the builder's UI node_modules.
    (resources / module.ELECTRON_ARCHIVE_LICENSE_RESOURCE).write_text(
        "Electron MIT license\n",
        encoding="utf-8",
    )
    (resources / module.CHROMIUM_ARCHIVE_LICENSE_RESOURCE).write_text(
        "<html>Chromium notices</html>\n",
        encoding="utf-8",
    )
    return app


def write_minimal_ui_source(module, root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for relative in module.REQUIRED_NEXT_ROUTE_SOURCES:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("export {};\n", encoding="utf-8")
    (root / "package.json").write_text(
        json.dumps({"name": "echo-founder-ui", "private": True}) + "\n",
        encoding="utf-8",
    )
    (root / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "echo-founder-ui",
                "lockfileVersion": 3,
                "packages": {
                    "": {"name": "echo-founder-ui"},
                    "node_modules/next": {"version": "16.3.2", "license": "MIT"},
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )


def formal_runtime_args(module, **overrides):
    values = {
        "arch": "arm64",
        "embed_python_runtime": "required",
        "python_version": module.DEFAULT_PYTHON_VERSION,
        "electron_arm64_archive": None,
        "electron_arm64_sha256": None,
        "electron_x64_archive": None,
        "electron_x64_sha256": None,
        "playwright_arm64_archive": None,
        "playwright_arm64_sha256": None,
        "playwright_x64_archive": None,
        "playwright_x64_sha256": None,
        "python_runtime_archive": None,
        "python_runtime_sha256": None,
        "python_runtime_arm64_archive": None,
        "python_runtime_arm64_sha256": None,
        "python_runtime_x64_archive": None,
        "python_runtime_x64_sha256": None,
    }
    values.update(overrides)
    return module.argparse.Namespace(**values)


def enable_runtime_supply_chain_fixture(module, app: Path, monkeypatch):
    resources = app / "Contents" / "Resources"
    runtime = resources / "aifios"
    electron_binary = app / "Contents" / "MacOS" / "Echo Founder"
    electron_binary.parent.mkdir(parents=True, exist_ok=True)
    electron_binary.write_bytes(b"fixture electron shell\n")
    electron_framework = app / "Contents" / "Frameworks" / "Electron Framework.framework" / "Electron Framework"
    electron_framework.parent.mkdir(parents=True, exist_ok=True)
    electron_framework.write_bytes(b"fixture electron framework\n")
    next_dist = runtime / "ui" / module.DESKTOP_DIST_DIR
    dependency_provenance = {
        "mode": "isolated-npm-ci-ignore-scripts",
        "package_lock_sha256": "1" * 64,
        "next_version": "16.3.2",
        "node_modules_tree_sha256": "2" * 64,
        "node_modules_file_count": 2,
        "cache_seed": {"mode": "empty-isolated-cache", "seed_file_count": 0},
    }
    module.write_next_build_manifest(
        next_dist,
        {
            "schema": "aifios.desktop-next-source.v1",
            "source_tree_sha256": "3" * 64,
            "source_file_count": 1,
            "source_bytes": 1,
            "required_route_sources": [item.as_posix() for item in module.REQUIRED_NEXT_ROUTE_SOURCES],
            "required_route_artifacts": [item.as_posix() for item in module.REQUIRED_NEXT_ROUTE_ARTIFACTS],
        },
        dependency_provenance,
    )

    playwright_runtime = runtime / "runtime" / "playwright"
    browser = playwright_runtime / "arm64"
    executable = browser / "chrome-headless-shell"
    executable.write_bytes(b"fixture arm64 executable")
    browser_tree = module.runtime_tree_fingerprint(browser)
    approved_playwright = module.APPROVED_PLAYWRIGHT_RELEASES[("1.60.0", "1223", "148.0.7778.96")][
        "arm64"
    ]
    playwright_manifest = {
        "schema": module.PLAYWRIGHT_RUNTIME_SCHEMA,
        "tree_hash_schema": module.RUNTIME_TREE_HASH_SCHEMA,
        "playwright_version": "1.60.0",
        "headless_shell_revision": "1223",
        "browser_version": "148.0.7778.96",
        "architectures": {
            "arm64": {
                "executable": "arm64/chrome-headless-shell",
                "source_revision": "1223",
                "source_extracted_tree_sha256": browser_tree["tree_sha256"],
                "source": {
                    "method": "explicit-verified-archive-isolated-extract",
                    "archive_sha256": approved_playwright["sha256"],
                    "source_url": approved_playwright["url"],
                    "revision": "1223",
                    "version": "1.60.0",
                    "browser_version": "148.0.7778.96",
                },
                "tree_sha256": browser_tree["tree_sha256"],
            }
        },
    }
    (playwright_runtime / "manifest.json").write_text(
        json.dumps(playwright_manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        module,
        "macho_architectures",
        lambda path: {"arm64"} if path.name == "chrome-headless-shell" else set(),
    )

    electron_archive_name = "electron-v43.0.0-darwin-arm64.zip"
    electron_runtime = {
        "supply_chain": {
            "assembled_tree_sha256": "4" * 64,
            "architectures": {
                "arm64": {
                    "version": "43.0.0",
                    "architecture": "arm64",
                    "source_url": (
                        "https://github.com/electron/electron/releases/download/v43.0.0/"
                        + electron_archive_name
                    ),
                    "archive_sha256": module.electron_checksum(electron_archive_name),
                    "archive_source": "explicit-verified-archive",
                    "rebuild_mode": "isolated-extract-every-build",
                    "extracted_tree_sha256": "5" * 64,
                    "notice_sha256": {
                        "electron": module.sha256_file(
                            resources / module.ELECTRON_ARCHIVE_LICENSE_RESOURCE
                        ),
                        "chromium": module.sha256_file(
                            resources / module.CHROMIUM_ARCHIVE_LICENSE_RESOURCE
                        ),
                    },
                }
            },
        }
    }
    approved_python = module.APPROVED_PYTHON_RELEASES[module.DEFAULT_PYTHON_VERSION]["arm64"]
    embedded_python_runtime = {
        "architectures": {
            "arm64": {
                "source_extracted_tree_sha256": "6" * 64,
                "source": {
                    "version": module.DEFAULT_PYTHON_VERSION,
                    "architecture": "arm64",
                    "source_url": approved_python["url"],
                    "archive_sha256": approved_python["sha256"],
                    "archive_source": "explicit-verified-archive",
                    "rebuild_mode": "isolated-extract-every-build",
                },
            }
        }
    }
    xhs_card_runtime = {"status": "staged-clean-install"}
    monkeypatch.setattr(module, "APPROVED_UI_PACKAGE_LOCK_SHA256", "1" * 64)
    monkeypatch.setattr(
        module,
        "APPROVED_XHS_CARD_PACKAGE_LOCK_SHA256",
        module.sha256_file(runtime / "skills" / "xhs-card" / "package-lock.json"),
    )
    return electron_runtime, xhs_card_runtime, embedded_python_runtime


def test_npm_ci_retry_is_bounded_and_accepts_only_allowlisted_network_failures(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    command = ["/usr/local/bin/npm", "ci", "--ignore-scripts"]
    responses = iter(
        [
            module.subprocess.CompletedProcess(command, 1, stdout="npm error code ECONNRESET\n"),
            module.subprocess.CompletedProcess(command, 1, stdout="npm error code EAI_AGAIN\n"),
            module.subprocess.CompletedProcess(command, 0, stdout="added audited packages\n"),
        ]
    )
    calls: list[list[str]] = []
    delays: list[int] = []

    def fake_run(invocation, **_kwargs):
        calls.append(invocation)
        return next(responses)

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    monkeypatch.setattr(module.time, "sleep", delays.append)
    module.run_npm_ci_with_network_retry(
        command,
        cwd=tmp_path,
        env={"PATH": "/usr/bin"},
        timeout=30,
    )

    assert calls == [command, command, command]
    assert delays == [2, 4]

    calls.clear()
    delays.clear()
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda invocation, **_kwargs: (
            calls.append(invocation)
            or module.subprocess.CompletedProcess(invocation, 1, stdout="npm error code EUSAGE\nlock mismatch\n")
        ),
    )
    with pytest.raises(module.subprocess.CalledProcessError):
        module.run_npm_ci_with_network_retry(
            command,
            cwd=tmp_path,
            env={"PATH": "/usr/bin"},
            timeout=30,
        )
    assert calls == [command]
    assert delays == []

    with pytest.raises(ValueError, match="only an explicit npm ci"):
        module.run_npm_ci_with_network_retry(
            ["/usr/local/bin/npm", "install"],
            cwd=tmp_path,
            env={"PATH": "/usr/bin"},
            timeout=30,
        )
    with pytest.raises(ValueError, match="lifecycle scripts"):
        module.run_npm_ci_with_network_retry(
            ["/usr/local/bin/npm", "ci"],
            cwd=tmp_path,
            env={"PATH": "/usr/bin"},
            timeout=30,
        )


def test_npm_ci_retry_stops_after_three_transient_failures(tmp_path, monkeypatch) -> None:
    module = load_module()
    command = ["npm", "ci", "--ignore-scripts"]
    calls = 0
    delays: list[int] = []

    def fail_with_timeout(invocation, **_kwargs):
        nonlocal calls
        calls += 1
        return module.subprocess.CompletedProcess(invocation, 1, stdout="npm error code ETIMEDOUT\n")

    monkeypatch.setattr(module.subprocess, "run", fail_with_timeout)
    monkeypatch.setattr(module.time, "sleep", delays.append)
    with pytest.raises(module.subprocess.CalledProcessError):
        module.run_npm_ci_with_network_retry(
            command,
            cwd=tmp_path,
            env={"PATH": "/usr/bin"},
            timeout=30,
        )

    assert calls == 3
    assert delays == [2, 4]


def test_npm_ci_retry_uses_final_canonical_error_code(tmp_path, monkeypatch) -> None:
    module = load_module()
    command = ["npm", "ci", "--ignore-scripts"]
    calls = 0
    delays: list[int] = []

    def fail_with_final_deterministic_error(invocation, **_kwargs):
        nonlocal calls
        calls += 1
        return module.subprocess.CompletedProcess(
            invocation,
            1,
            stdout=(
                "npm warn fetch retry after ECONNRESET\n"
                "npm error code ECONNRESET\n"
                "npm error lockfile validation failed\n"
                "npm error code EUSAGE\n"
            ),
        )

    monkeypatch.setattr(module.subprocess, "run", fail_with_final_deterministic_error)
    monkeypatch.setattr(module.time, "sleep", delays.append)

    with pytest.raises(module.subprocess.CalledProcessError):
        module.run_npm_ci_with_network_retry(
            command,
            cwd=tmp_path,
            env={"PATH": "/usr/bin"},
            timeout=30,
        )

    assert calls == 1
    assert delays == []


def test_desktop_download_cache_root_honors_explicit_environment(monkeypatch) -> None:
    monkeypatch.setenv("AIFIOS_DESKTOP_CACHE_DIR", "/private/tmp/aifios-cache-test")
    module = load_module()

    assert module.desktop_download_cache_root() == Path("/private/tmp/aifios-cache-test")
    assert module.DESKTOP_DOWNLOAD_CACHE == Path("/private/tmp/aifios-cache-test")


def test_desktop_download_cache_root_defaults_to_macos_library_cache(monkeypatch) -> None:
    monkeypatch.delenv("AIFIOS_DESKTOP_CACHE_DIR", raising=False)
    module = load_module()

    assert module.desktop_download_cache_root() == Path.home() / "Library" / "Caches" / "AIFIOS"


def test_ui_source_fingerprint_ignores_transient_next_output_directories(tmp_path, monkeypatch) -> None:
    module = load_module()
    monkeypatch.setattr(module, "UI_DIR", tmp_path)

    for relative in module.REQUIRED_NEXT_ROUTE_SOURCES:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("export {};\n", encoding="utf-8")

    baseline = module.ui_source_fingerprint()["source_tree_sha256"]
    transient = tmp_path / ".next-media-validation" / "server" / "generated.js"
    transient.parent.mkdir(parents=True)
    transient.write_text("generated during dev server run\n", encoding="utf-8")

    assert module.ui_source_fingerprint()["source_tree_sha256"] == baseline


def test_formal_ui_staging_uses_clean_lock_install_and_isolated_environment(tmp_path, monkeypatch) -> None:
    module = load_module()
    ui = tmp_path / "ui"
    write_minimal_ui_source(module, ui)
    fixture = ui / "electron" / "fixtures" / "publication-fixture.cjs"
    fixture.parent.mkdir(parents=True)
    fixture.write_text("module.exports = { fixture: true };\n", encoding="utf-8")
    poisoned_cli = ui / "node_modules" / "next" / "dist" / "bin" / "next"
    poisoned_cli.parent.mkdir(parents=True)
    poisoned_cli.write_text("POISONED LOCAL NEXT\n", encoding="utf-8")
    poisoned_next = ui / ".next-desktop" / "server" / "poisoned.js"
    poisoned_next.parent.mkdir(parents=True)
    poisoned_next.write_text("POISONED LOCAL BUILD\n", encoding="utf-8")

    download_cache = tmp_path / "download-cache"
    seed = download_cache / "npm" / "_cacache" / "seed"
    seed.parent.mkdir(parents=True)
    seed.write_text("untrusted cache bytes validated by npm integrity\n", encoding="utf-8")
    monkeypatch.setattr(module, "UI_DIR", ui)
    monkeypatch.setattr(module, "DESKTOP_DOWNLOAD_CACHE", download_cache)
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/local/bin/npm" if name == "npm" else None)
    poisoned_home = tmp_path / "poisoned-home"
    monkeypatch.setenv("HOME", str(poisoned_home))
    monkeypatch.setenv("NPM_CONFIG_REGISTRY", "https://poisoned.invalid/")
    monkeypatch.setenv("npm_config_userconfig", str(tmp_path / "poisoned.npmrc"))
    monkeypatch.setenv("NODE_OPTIONS", "--require=/tmp/poisoned.js")
    monkeypatch.setenv("NODE_PATH", "/tmp/poisoned-node-path")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "poisoned-browser-cache"))
    monkeypatch.setenv("NEXT_PUBLIC_POISON", "secret-build-input")
    monkeypatch.setenv("AIFIOS_MODEL_API_KEY", "secret")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-secret")
    monkeypatch.setenv("TIKOMNI_API_KEY", "tikomni-secret")
    monkeypatch.setenv("CUSTOM_VENDOR_TOKEN", "vendor-secret")
    monkeypatch.setenv("HTTP_PROXY", "http://builder:secret@proxy.invalid")
    calls: list[tuple[list[str], Path, dict[str, str]]] = []

    def fake_run(command, cwd, env, timeout):
        calls.append((command, cwd, env))
        package = cwd / "node_modules" / "next"
        cli = package / "dist" / "bin" / "next"
        cli.parent.mkdir(parents=True)
        (package / "package.json").write_text(
            json.dumps({"name": "next", "version": "16.3.2", "license": "MIT"}) + "\n",
            encoding="utf-8",
        )
        cli.write_text("CLEAN LOCK-BOUND NEXT\n", encoding="utf-8")

    monkeypatch.setattr(module, "run_npm_ci_with_network_retry", fake_run)
    staging = tmp_path / "isolated" / "ui"

    result = module.prepare_isolated_ui_build_tree(staging)

    assert (staging / fixture.relative_to(ui)).read_bytes() == fixture.read_bytes()
    assert module.ui_source_fingerprint(staging) == module.ui_source_fingerprint(ui)
    assert result["mode"] == "isolated-npm-ci-ignore-scripts"
    assert result["next_version"] == "16.3.2"
    assert result["cache_seed"] == {"mode": "copied-to-isolated-cache", "seed_file_count": 1}
    assert not (staging / ".next-desktop").exists()
    assert (staging / "node_modules" / "next" / "dist" / "bin" / "next").read_text(
        encoding="utf-8"
    ) == "CLEAN LOCK-BOUND NEXT\n"
    assert poisoned_cli.read_text(encoding="utf-8") == "POISONED LOCAL NEXT\n"
    assert calls and calls[0][0][1:] == ["ci", "--ignore-scripts", "--prefer-offline"]
    env = calls[0][2]
    assert Path(env["HOME"]).parent == staging.parent
    assert Path(env["npm_config_cache"]).parent == staging.parent
    user_config = Path(env["npm_config_userconfig"])
    global_config = Path(env["npm_config_globalconfig"])
    assert user_config != global_config
    assert user_config.is_relative_to(staging.parent)
    assert global_config.is_relative_to(staging.parent)
    assert user_config.read_text(encoding="utf-8") == ""
    assert global_config.read_text(encoding="utf-8") == ""
    assert env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] == "1"
    assert Path(env["TMPDIR"]).parent == staging.parent / ".build-home"
    assert env["TMP"] == env["TMPDIR"]
    assert env["TEMP"] == env["TMPDIR"]
    for name in (
        "NPM_CONFIG_REGISTRY",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PLAYWRIGHT_BROWSERS_PATH",
        "NEXT_PUBLIC_POISON",
        "AIFIOS_MODEL_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "TIKOMNI_API_KEY",
        "CUSTOM_VENDOR_TOKEN",
        "HTTP_PROXY",
    ):
        assert name not in env


def test_node_runtime_staging_uses_bounded_isolated_npm_ci(tmp_path, monkeypatch) -> None:
    module = load_module()
    ui = tmp_path / "ui"
    write_minimal_ui_source(module, ui)
    monkeypatch.setattr(module, "UI_DIR", ui)
    monkeypatch.setattr(module, "DESKTOP_DOWNLOAD_CACHE", tmp_path / "download-cache")
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/local/bin/npm" if name == "npm" else None)
    calls: list[tuple[list[str], Path, dict[str, str], int]] = []

    def fake_npm_ci(command, *, cwd, env, timeout):
        calls.append((command, cwd, env, timeout))
        (cwd / "node_modules").mkdir(parents=True)

    monkeypatch.setattr(module, "run_npm_ci_with_network_retry", fake_npm_ci)
    staging_root = tmp_path / "native-staging"

    node_modules = module.install_node_runtime_staging(staging_root, "arm64")

    assert node_modules == staging_root / "arm64" / "node_modules"
    assert calls and calls[0][0] == [
        "/usr/local/bin/npm",
        "ci",
        "--omit=dev",
        "--include=optional",
        "--ignore-scripts",
        "--os=darwin",
        "--cpu=arm64",
    ]
    assert calls[0][1] == staging_root / "arm64"
    assert calls[0][3] == 600
    env = calls[0][2]
    assert env["npm_config_os"] == "darwin"
    assert env["npm_config_cpu"] == "arm64"
    assert env["npm_config_ignore_scripts"] == "true"
    assert Path(env["npm_config_userconfig"]).is_relative_to(staging_root)
    assert Path(env["npm_config_globalconfig"]).is_relative_to(staging_root)


@pytest.mark.parametrize("unsafe_kind", ["dotenv", "symlink"])
def test_formal_ui_staging_rejects_machine_local_or_linked_inputs(
    tmp_path,
    monkeypatch,
    unsafe_kind: str,
) -> None:
    module = load_module()
    ui = tmp_path / "ui"
    write_minimal_ui_source(module, ui)
    if unsafe_kind == "dotenv":
        (ui / ".env.production").write_text("NEXT_PUBLIC_POISON=1\n", encoding="utf-8")
    else:
        (ui / "linked-package.json").symlink_to("package.json")
    monkeypatch.setattr(module, "UI_DIR", ui)

    with pytest.raises(RuntimeError, match="machine-local configuration input"):
        module.prepare_isolated_ui_build_tree(tmp_path / "isolated" / "ui")


def test_customer_bundle_excludes_test_fixtures_and_single_author_history() -> None:
    module = load_module()

    runtime_ignored = module.bundle_ignore(
        str(module.REPO_ROOT / "skills" / "content-runtime"),
        ["fixtures", "scripts", "SKILL.md"],
    )
    writer_ignored = module.bundle_ignore(
        str(module.REPO_ROOT / "skills" / "wechat-writer"),
        ["style-adaptive.md", "style-changhuan.md", "SKILL.md", "references"],
    )
    references_ignored = module.bundle_ignore(
        str(module.REPO_ROOT / "skills" / "wechat-writer" / "references"),
        ["style_examples.md", "style-matrix.md"],
    )

    assert "fixtures" in runtime_ignored
    assert "style-changhuan.md" in writer_ignored
    assert "style-adaptive.md" not in writer_ignored
    assert "style_examples.md" in references_ignored
    assert "style-matrix.md" not in references_ignored


def test_desktop_source_inventory_requires_node_runtime_license_proxy() -> None:
    module = load_module()

    assert Path("proxy.ts") in module.REQUIRED_NEXT_ROUTE_SOURCES
    assert Path("middleware.ts") not in module.REQUIRED_NEXT_ROUTE_SOURCES


def test_formal_runtime_arguments_accept_only_the_required_lock_bound_python() -> None:
    module = load_module()

    module.validate_formal_runtime_arguments(formal_runtime_args(module))
    for mode in ("off", "auto"):
        with pytest.raises(RuntimeError, match="requires the approved embedded Python runtime"):
            module.validate_formal_runtime_arguments(
                formal_runtime_args(module, embed_python_runtime=mode)
            )
    with pytest.raises(RuntimeError, match="pins CPython"):
        module.validate_formal_runtime_arguments(
            formal_runtime_args(module, python_version="3.11.14")
        )


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"electron_arm64_archive": "/tmp/electron.zip"}, "electron-arm64-archive"),
        ({"playwright_arm64_archive": "/tmp/headless-shell.zip"}, "playwright-arm64-archive"),
        ({"python_runtime_archive": "/tmp/python.tar.gz"}, "python-runtime-archive"),
        ({"python_runtime_arm64_archive": "/tmp/python-arm64.tar.gz"}, "python-runtime-arm64-archive"),
    ],
)
def test_formal_runtime_arguments_reject_unpaired_archives(overrides, message: str) -> None:
    module = load_module()

    with pytest.raises(RuntimeError, match=message):
        module.validate_formal_runtime_arguments(formal_runtime_args(module, **overrides))


@pytest.mark.parametrize(
    "overrides",
    [
        {
            "electron_x64_archive": "/tmp/electron-x64.zip",
            "electron_x64_sha256": "1" * 64,
        },
        {
            "playwright_x64_archive": "/tmp/headless-shell-x64.zip",
            "playwright_x64_sha256": "2" * 64,
        },
        {
            "python_runtime_x64_archive": "/tmp/python-x64.tar.gz",
            "python_runtime_x64_sha256": "3" * 64,
        },
    ],
)
def test_formal_runtime_arguments_reject_options_for_an_unselected_architecture(overrides) -> None:
    module = load_module()

    with pytest.raises(RuntimeError, match="does not apply to --arch=arm64"):
        module.validate_formal_runtime_arguments(formal_runtime_args(module, **overrides))


def test_python_runtime_copy_preserves_the_complete_approved_extraction(tmp_path) -> None:
    module = load_module()
    source = tmp_path / "source-python"
    python = source / "bin" / "python3"
    python.parent.mkdir(parents=True)
    python.write_bytes(b"approved python binary\n")
    python.chmod(0o755)
    cached_bytecode = source / "lib" / "python3.11" / "encodings" / "__pycache__" / "utf_8.pyc"
    cached_bytecode.parent.mkdir(parents=True)
    cached_bytecode.write_bytes(b"approved archive bytecode\n")
    (source / "LICENSE").write_text("approved license\n", encoding="utf-8")
    (source / "bin" / "python").symlink_to("python3")

    copied = module.copy_python_runtime(source, tmp_path / "bundle", "3.11.15", "arm64")

    assert (copied / cached_bytecode.relative_to(source)).read_bytes() == b"approved archive bytecode\n"
    assert module.runtime_tree_fingerprint(copied)["tree_sha256"] == module.runtime_tree_fingerprint(source)[
        "tree_sha256"
    ]


def test_formal_dependency_locks_are_bound_to_approved_reviewed_digests(tmp_path, monkeypatch) -> None:
    module = load_module()
    ui = tmp_path / "ui"
    xhs = tmp_path / "skills" / "xhs-card"
    ui.mkdir()
    xhs.mkdir(parents=True)
    ui_lock = ui / "package-lock.json"
    xhs_lock = xhs / "package-lock.json"
    ui_lock.write_text('{"lockfileVersion":3}\n', encoding="utf-8")
    xhs_lock.write_text('{"lockfileVersion":3}\n', encoding="utf-8")
    monkeypatch.setattr(module, "UI_DIR", ui)
    monkeypatch.setattr(module, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(module, "APPROVED_UI_PACKAGE_LOCK_SHA256", module.sha256_file(ui_lock))
    monkeypatch.setattr(module, "APPROVED_XHS_CARD_PACKAGE_LOCK_SHA256", module.sha256_file(xhs_lock))

    module.validate_approved_dependency_locks()

    ui_lock.write_text('{"lockfileVersion":3,"poisoned":true}\n', encoding="utf-8")
    with pytest.raises(RuntimeError, match="not the approved reviewed snapshot"):
        module.validate_approved_dependency_locks()


def test_verified_archive_snapshot_rehashes_and_detaches_from_mutable_source(tmp_path) -> None:
    module = load_module()
    source = tmp_path / "shared-cache.zip"
    source.write_bytes(b"approved archive bytes")
    expected = hashlib.sha256(source.read_bytes()).hexdigest()
    snapshot = module.snapshot_verified_archive(
        source,
        tmp_path / "private" / "archive.zip",
        expected,
        "fixture",
    )

    source.write_bytes(b"poisoned after resolution")
    assert snapshot.read_bytes() == b"approved archive bytes"
    assert stat.S_IMODE(snapshot.stat().st_mode) == 0o400
    module.verify_archive_snapshot_unchanged(snapshot, expected, "fixture")

    with pytest.raises(RuntimeError, match="changed before isolated extraction"):
        module.snapshot_verified_archive(
            source,
            tmp_path / "private" / "rejected.zip",
            expected,
            "fixture",
        )


def test_electron_release_archive_requires_approved_fixed_digest(tmp_path, monkeypatch) -> None:
    module = load_module()
    archive = tmp_path / "electron.zip"
    archive.write_bytes(b"reviewed electron release archive")
    approved_sha256 = module.sha256_file(archive)
    monkeypatch.setattr(module, "electron_version", lambda: "99.1.2")
    monkeypatch.setattr(
        module,
        "APPROVED_ELECTRON_RELEASES",
        {"99.1.2": {"arm64": approved_sha256}},
    )

    with pytest.raises(RuntimeError, match="requires a fixed"):
        module.resolve_electron_archive("arm64", str(archive))
    with pytest.raises(RuntimeError, match="not the approved checksum"):
        module.resolve_electron_archive("arm64", str(archive), "0" * 64)
    extracted = tmp_path / "Electron.app"
    extracted.mkdir()
    with pytest.raises(RuntimeError, match="not an extracted directory"):
        module.resolve_electron_archive("arm64", str(extracted), approved_sha256)
    tampered = tmp_path / "tampered-electron.zip"
    tampered.write_bytes(b"tampered")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        module.resolve_electron_archive("arm64", str(tampered), approved_sha256)

    resolved, evidence = module.resolve_electron_archive("arm64", str(archive), approved_sha256)

    assert resolved == archive.resolve()
    assert evidence["archive_sha256"] == approved_sha256
    assert evidence["archive_source"] == "explicit-verified-archive"
    assert evidence["rebuild_mode"] == "isolated-extract-every-build"


def test_electron_default_archive_cache_is_hash_gated_and_replaced(tmp_path, monkeypatch) -> None:
    module = load_module()
    approved_bytes = b"approved electron archive"
    approved_sha256 = hashlib.sha256(approved_bytes).hexdigest()
    monkeypatch.setattr(module, "electron_version", lambda: "99.1.2")
    monkeypatch.setattr(module, "APPROVED_ELECTRON_RELEASES", {"99.1.2": {"arm64": approved_sha256}})
    monkeypatch.setattr(module, "ELECTRON_DOWNLOAD_CACHE", tmp_path / "electron-cache")
    archive = module.ELECTRON_DOWNLOAD_CACHE / "99.1.2" / "arm64" / "electron-v99.1.2-darwin-arm64.zip"
    archive.parent.mkdir(parents=True)
    archive.write_bytes(b"poisoned same-name cache entry")
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        Path(command[command.index("--output") + 1]).write_bytes(approved_bytes)

    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/curl" if name == "curl" else None)
    monkeypatch.setattr(module, "run", fake_run)

    resolved, evidence = module.resolve_electron_archive("arm64")

    assert calls and resolved.read_bytes() == approved_bytes
    assert evidence["archive_source"] == "approved-download"
    assert evidence["archive_sha256"] == approved_sha256


def test_electron_runtime_rejects_legacy_extracted_app_input(tmp_path) -> None:
    module = load_module()
    extracted = tmp_path / "Electron.app"
    extracted.mkdir()
    args = type(
        "Args",
        (),
        {"arch": "arm64", "electron_arm64_app": str(extracted), "electron_x64_app": None},
    )()

    with pytest.raises(RuntimeError, match="rejects extracted Electron.app"):
        module.create_electron_runtime(args, tmp_path / "Output.app")


def test_python_release_archive_requires_approved_fixed_digest(tmp_path, monkeypatch) -> None:
    module = load_module()
    archive = tmp_path / "python-runtime.tar.gz"
    archive.write_bytes(b"reviewed python release archive")
    approved_sha256 = module.sha256_file(archive)
    monkeypatch.setattr(
        module,
        "APPROVED_PYTHON_RELEASES",
        {
            "9.9.9": {
                "arm64": {
                    "url": "https://downloads.example.test/python-runtime.tar.gz",
                    "sha256": approved_sha256,
                }
            }
        },
    )

    with pytest.raises(RuntimeError, match="requires a fixed"):
        module.resolve_python_archive("arm64", "9.9.9", str(archive))
    with pytest.raises(RuntimeError, match="not approved"):
        module.resolve_python_archive("arm64", "9.9.9", str(archive), "0" * 64)
    extracted = tmp_path / "python-runtime"
    extracted.mkdir()
    with pytest.raises(RuntimeError, match="not an extracted directory"):
        module.resolve_python_archive("arm64", "9.9.9", str(extracted), approved_sha256)
    tampered = tmp_path / "tampered-python.tar.gz"
    tampered.write_bytes(b"tampered")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        module.resolve_python_archive("arm64", "9.9.9", str(tampered), approved_sha256)

    resolved, evidence = module.resolve_python_archive("arm64", "9.9.9", str(archive), approved_sha256)

    assert resolved == archive.resolve()
    assert evidence["archive_sha256"] == approved_sha256
    assert evidence["archive_source"] == "explicit-verified-archive"
    assert evidence["rebuild_mode"] == "isolated-extract-every-build"


def test_python_default_archive_cache_is_hash_gated_and_replaced(tmp_path, monkeypatch) -> None:
    module = load_module()
    approved_bytes = b"approved python archive"
    approved_sha256 = hashlib.sha256(approved_bytes).hexdigest()
    url = "https://downloads.example.test/python-runtime.tar.gz"
    monkeypatch.setattr(
        module,
        "APPROVED_PYTHON_RELEASES",
        {"9.9.9": {"arm64": {"url": url, "sha256": approved_sha256}}},
    )
    monkeypatch.setattr(module, "PYTHON_DOWNLOAD_CACHE", tmp_path / "python-cache")
    archive = module.PYTHON_DOWNLOAD_CACHE / "9.9.9" / "arm64" / "python-runtime.tar.gz"
    archive.parent.mkdir(parents=True)
    archive.write_bytes(b"poisoned same-name cache entry")
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        Path(command[command.index("--output") + 1]).write_bytes(approved_bytes)

    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/curl" if name == "curl" else None)
    monkeypatch.setattr(module, "run", fake_run)

    resolved, evidence = module.resolve_python_archive("arm64", "9.9.9")

    assert calls and resolved.read_bytes() == approved_bytes
    assert evidence["archive_source"] == "approved-download"
    assert evidence["archive_sha256"] == approved_sha256


def test_playwright_release_archive_is_extracted_only_inside_supplied_isolation_root(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    archive = tmp_path / "headless-shell.zip"
    archive.write_bytes(b"reviewed Playwright browser archive")
    approved_sha256 = module.sha256_file(archive)
    key = ("9.8.7", "4321", "155.0.1.2")
    monkeypatch.setattr(
        module,
        "APPROVED_PLAYWRIGHT_RELEASES",
        {
            key: {
                "arm64": {
                    "url": "https://downloads.example.test/headless-shell.zip",
                    "sha256": approved_sha256,
                }
            }
        },
    )
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "poisoned-global-cache"))
    monkeypatch.setenv("PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT", "1")

    def fake_extract(_archive: Path, destination: Path) -> None:
        executable = destination / "chrome-headless-shell-mac-arm64" / "chrome-headless-shell"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"fake arm64 Mach-O")

    monkeypatch.setattr(module, "safe_extract_electron_zip", fake_extract)
    monkeypatch.setattr(
        module,
        "macho_architectures",
        lambda path: {"arm64"} if path.name == "chrome-headless-shell" else set(),
    )
    cache_root = tmp_path / "per-build-extraction"
    args = ("arm64", *key, cache_root)

    with pytest.raises(RuntimeError, match="requires a fixed"):
        module.prepare_playwright_headless_shell(*args, explicit_archive=str(archive))
    with pytest.raises(RuntimeError, match="not approved"):
        module.prepare_playwright_headless_shell(
            *args,
            explicit_archive=str(archive),
            explicit_sha256="0" * 64,
        )
    extracted = tmp_path / "headless-shell-extracted"
    extracted.mkdir()
    with pytest.raises(RuntimeError, match="regular browser archive"):
        module.prepare_playwright_headless_shell(
            *args,
            explicit_archive=str(extracted),
            explicit_sha256=approved_sha256,
        )
    tampered = tmp_path / "tampered-headless-shell.zip"
    tampered.write_bytes(b"tampered")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        module.prepare_playwright_headless_shell(
            *args,
            explicit_archive=str(tampered),
            explicit_sha256=approved_sha256,
        )

    source, evidence = module.prepare_playwright_headless_shell(
        *args,
        explicit_archive=str(archive),
        explicit_sha256=approved_sha256,
    )

    assert source.is_relative_to(cache_root)
    assert not source.is_relative_to(tmp_path / "poisoned-global-cache")
    assert evidence["method"] == "explicit-verified-archive-isolated-extract"
    assert evidence["archive_sha256"] == approved_sha256
    assert evidence["source_url"] == "https://downloads.example.test/headless-shell.zip"


def test_playwright_default_cache_and_environment_cannot_replace_approved_archive(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    approved_bytes = b"approved Playwright browser archive"
    approved_sha256 = hashlib.sha256(approved_bytes).hexdigest()
    key = ("9.8.7", "4321", "155.0.1.2")
    url = "https://downloads.example.test/headless-shell.zip"
    monkeypatch.setattr(
        module,
        "APPROVED_PLAYWRIGHT_RELEASES",
        {key: {"arm64": {"url": url, "sha256": approved_sha256}}},
    )
    monkeypatch.setattr(module, "DESKTOP_DOWNLOAD_CACHE", tmp_path / "download-cache")
    archive = (
        module.DESKTOP_DOWNLOAD_CACHE
        / "playwright"
        / key[0]
        / key[1]
        / "arm64"
        / "headless-shell.zip"
    )
    archive.parent.mkdir(parents=True)
    archive.write_bytes(b"poisoned same-name cache entry")
    monkeypatch.setenv("PLAYWRIGHT_DOWNLOAD_HOST", "https://poisoned.invalid")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "poisoned-global-browser"))
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        Path(command[command.index("--output") + 1]).write_bytes(approved_bytes)

    def fake_extract(resolved_archive: Path, destination: Path) -> None:
        assert resolved_archive.read_bytes() == approved_bytes
        executable = destination / "chrome-headless-shell-mac-arm64" / "chrome-headless-shell"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"fake arm64 Mach-O")

    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/curl" if name == "curl" else None)
    monkeypatch.setattr(module, "run", fake_run)
    monkeypatch.setattr(module, "safe_extract_electron_zip", fake_extract)
    monkeypatch.setattr(
        module,
        "macho_architectures",
        lambda path: {"arm64"} if path.name == "chrome-headless-shell" else set(),
    )
    isolation_root = tmp_path / "per-build-extraction"

    source, evidence = module.prepare_playwright_headless_shell("arm64", *key, isolation_root)

    assert calls and calls[0][-1] == url
    assert source.is_relative_to(isolation_root)
    assert not source.is_relative_to(tmp_path / "poisoned-global-browser")
    assert evidence["archive_source"] == "approved-download"
    assert evidence["archive_sha256"] == approved_sha256


def test_python_embedding_rejects_legacy_extracted_runtime_inputs(tmp_path) -> None:
    module = load_module()
    extracted = tmp_path / "python-runtime"
    extracted.mkdir()

    with pytest.raises(RuntimeError, match="rejects extracted Python runtime paths"):
        module.embed_python_runtime(
            tmp_path / "packaged-runtime",
            "auto",
            str(extracted),
            None,
            None,
            module.DEFAULT_PYTHON_VERSION,
            "arm64",
        )



def test_brand_icon_verifier_requires_echo_founder_plist_and_rejects_electron_default(tmp_path) -> None:
    module = load_module()
    app = tmp_path / "Echo Founder.app"
    resources = app / "Contents" / "Resources"
    resources.mkdir(parents=True)
    plist_path = app / "Contents" / "Info.plist"
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    with plist_path.open("wb") as handle:
        plistlib.dump({"CFBundleIconFile": module.BRAND_ICON_FILENAME}, handle)
    icon = resources / module.BRAND_ICON_FILENAME
    icon.write_bytes(b"icns" + (b"echo-founder" * 128))

    result = module.verify_brand_icon(app)

    assert result["filename"] == "EchoFounder.icns"
    (resources / "electron.icns").write_bytes(b"icns" + (b"electron" * 128))
    try:
        module.verify_brand_icon(app)
    except RuntimeError as exc:
        assert "Electron's default" in str(exc)
    else:
        raise AssertionError("Electron default icon must block package verification")


def test_default_product_version_maps_to_apple_compliant_plist_versions(tmp_path) -> None:
    module = load_module()
    app = tmp_path / "Echo Founder.app"
    plist_path = app / "Contents" / "Info.plist"
    plist_path.parent.mkdir(parents=True)
    with plist_path.open("wb") as handle:
        plistlib.dump({"UnrelatedElectronKey": "preserved"}, handle)

    module.update_info_plist(
        app,
        module.DEFAULT_APP_NAME,
        module.DEFAULT_BUNDLE_ID,
        module.DEFAULT_PRODUCT_VERSION,
    )

    with plist_path.open("rb") as handle:
        payload = plistlib.load(handle)
    assert module.DEFAULT_PRODUCT_VERSION == "0.2.0-beta.2"
    assert payload["CFBundleShortVersionString"] == "0.2.0"
    assert payload["CFBundleVersion"] == "3002"
    assert payload["UnrelatedElectronKey"] == "preserved"


@pytest.mark.parametrize(
    ("product_version", "marketing_version", "build_version"),
    [
        ("1.4.2-alpha.1", "1.4.2", "1001"),
        ("1.4.2-beta.27", "1.4.2", "3027"),
        ("1.4.2-rc.3", "1.4.2", "6003"),
        ("1.4.2", "1.4.2", "9000"),
        ("2.0.0-beta.1", "2.0.0", "3001"),
    ],
)
def test_apple_bundle_version_mapping_is_stable_for_future_releases(
    product_version: str,
    marketing_version: str,
    build_version: str,
) -> None:
    module = load_module()

    assert module.apple_bundle_versions(product_version) == (marketing_version, build_version)
    assert build_version.isdecimal()


def test_apple_bundle_version_mapping_orders_a_release_train() -> None:
    module = load_module()
    versions = [
        "3.1.0-alpha.1",
        "3.1.0-alpha.999",
        "3.1.0-beta.1",
        "3.1.0-beta.999",
        "3.1.0-rc.1",
        "3.1.0-rc.999",
        "3.1.0",
    ]

    builds = [int(module.apple_bundle_versions(version)[1]) for version in versions]

    assert builds == sorted(builds)
    assert len(set(builds)) == len(builds)
    assert all(0 < build <= 9999 for build in builds)


@pytest.mark.parametrize(
    "product_version",
    [
        "",
        "v0.2.0",
        "0.2",
        "0.2.0.1",
        "00.2.0",
        "0.02.0",
        "0.2.0-beta",
        "0.2.0-beta.0",
        "0.2.0-beta.1000",
        "0.2.0-preview.1",
        "0.2.0-beta.2+local",
        " 0.2.0-beta.2",
    ],
)
def test_apple_bundle_version_mapping_rejects_ambiguous_or_illegal_input(product_version: str) -> None:
    module = load_module()

    with pytest.raises(ValueError, match="Product version must be"):
        module.apple_bundle_versions(product_version)


def test_release_manifest_rewrites_builder_paths_and_rejects_unsanitized_paths() -> None:
    module = load_module()
    app = Path("/Users/release/Documents/AIFI-OS/dist/desktop/Echo Founder.app")
    payload = {
        "app_path": str(app),
        "binary": str(app / "Contents" / "MacOS" / "Echo Founder"),
        "source": "/Users/release/.local/share/python/bin/python3",
    }

    portable = module.portable_release_manifest(
        payload,
        [(app, app.name), (Path("/Users/release"), "build-home")],
    )

    assert portable["app_path"] == "Echo Founder.app"
    assert portable["binary"].startswith("Echo Founder.app/")
    assert portable["source"].startswith("build-home/")
    try:
        module.assert_release_manifest_portable(payload)
    except RuntimeError as exc:
        assert "build-machine absolute path" in str(exc)
    else:
        raise AssertionError("Unsanitized customer manifests must be rejected")


def test_package_traceability_records_git_boundary_and_honest_dirty_state() -> None:
    module = load_module()

    trace = module.release_source_control()

    assert trace["schema"] == "echo-founder.source-control-trace.v1"
    assert len(trace["baseline_sha"]) == 40
    assert len(trace["current_sha"]) == 40
    assert isinstance(trace["dirty"], bool)
    assert trace["dirty_entry_count"] >= 0
    assert len(trace["dirty_status_sha256"]) == 64


def test_trusted_qa_key_registry_evidence_binds_current_bytes_schema_and_key_count(tmp_path) -> None:
    module = load_module()
    registry = tmp_path / module.TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH
    registry.parent.mkdir(parents=True)
    registry.write_text(
        json.dumps(
            {
                "schema": module.TRUSTED_QA_KEY_REGISTRY_SCHEMA,
                "keys": [
                    {
                        "key_id": "qa-1",
                        "public_key_sha256": "1" * 64,
                        "status": "active",
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )

    evidence = module.trusted_qa_key_registry_evidence(tmp_path)

    assert evidence == {
        "schema": module.TRUSTED_QA_KEY_REGISTRY_SCHEMA,
        "path": module.TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH.as_posix(),
        "sha256": hashlib.sha256(registry.read_bytes()).hexdigest(),
        "key_count": 1,
    }
    registry.write_text('{"schema":"wrong","keys":[]}\n', encoding="utf-8")
    with pytest.raises(RuntimeError, match="schema or keys array"):
        module.trusted_qa_key_registry_evidence(tmp_path)


def _write_trusted_qa_registry(module, root: Path) -> Path:
    registry = root / module.TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH
    registry.parent.mkdir(parents=True, exist_ok=True)
    registry.write_text(
        json.dumps({"schema": module.TRUSTED_QA_KEY_REGISTRY_SCHEMA, "keys": []}) + "\n",
        encoding="utf-8",
    )
    return registry


def test_trusted_qa_key_registry_rejects_symlink_and_hardlink_inputs(tmp_path) -> None:
    module = load_module()
    outside = tmp_path / "outside.json"
    outside.write_text(
        json.dumps({"schema": module.TRUSTED_QA_KEY_REGISTRY_SCHEMA, "keys": []}) + "\n",
        encoding="utf-8",
    )
    registry = tmp_path / module.TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH
    registry.parent.mkdir(parents=True)
    registry.symlink_to(outside)
    with pytest.raises(RuntimeError, match="missing or unsafe"):
        module.trusted_qa_key_registry_evidence(tmp_path)

    registry.unlink()
    registry = _write_trusted_qa_registry(module, tmp_path)
    os.link(registry, registry.with_name("registry-hardlink.json"))
    with pytest.raises(RuntimeError, match="single-link regular file"):
        module.trusted_qa_key_registry_evidence(tmp_path)


def test_trusted_qa_key_registry_rejects_file_replacement_during_same_fd_read(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    registry = _write_trusted_qa_registry(module, tmp_path)
    replacement = registry.with_name("replacement.json")
    replacement.write_text(registry.read_text(encoding="utf-8"), encoding="utf-8")
    original_read = module.os.read
    replaced = False

    def replace_after_read(descriptor: int, count: int) -> bytes:
        nonlocal replaced
        chunk = original_read(descriptor, count)
        if not replaced:
            replaced = True
            os.replace(replacement, registry)
        return chunk

    monkeypatch.setattr(module.os, "read", replace_after_read)
    with pytest.raises(RuntimeError, match="single-link regular file|changed while being read"):
        module.trusted_qa_key_registry_evidence(tmp_path)


def test_trusted_qa_key_registry_rejects_parent_replacement_during_read(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    registry = _write_trusted_qa_registry(module, tmp_path)
    acceptance = registry.parent
    moved_acceptance = acceptance.with_name("acceptance-before-swap")
    original_read = module.os.read
    replaced = False

    def replace_parent_after_read(descriptor: int, count: int) -> bytes:
        nonlocal replaced
        chunk = original_read(descriptor, count)
        if not replaced:
            replaced = True
            acceptance.rename(moved_acceptance)
            _write_trusted_qa_registry(module, tmp_path)
        return chunk

    monkeypatch.setattr(module.os, "read", replace_parent_after_read)
    with pytest.raises(RuntimeError, match="parent path changed while being read"):
        module.trusted_qa_key_registry_evidence(tmp_path)


def test_shipped_runtime_digest_and_package_manifest_verification_are_complete(tmp_path, monkeypatch) -> None:
    module = load_module()
    app = tmp_path / "Echo Founder.app"
    runtime = app / "Contents" / "Resources" / "aifios"
    executable = runtime / "scripts" / "aifios.py"
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    executable.chmod(0o755)
    (runtime / "empty-dir").mkdir()
    (runtime / "aifios-link").symlink_to("scripts/aifios.py")
    fingerprint = module.runtime_tree_fingerprint(runtime)
    source = {
        "schema": "echo-founder.source-control-trace.v1",
        "baseline_sha": "a" * 40,
        "baseline_source": "test",
        "current_sha": "b" * 40,
        "dirty": True,
        "dirty_entry_count": 1,
        "dirty_status_sha256": "c" * 64,
    }
    qa_registry = module.trusted_qa_key_registry_evidence()
    dependency_inventory = {
        "schema": module.SHIPPED_DEPENDENCY_INVENTORY_SCHEMA,
        "inventory_path": "aifios/third-party-notices/shipped-dependencies.json",
        "inventory_sha256": "d" * 64,
        "component_count": 9,
        "npm_package_count": 2,
        "xhs_card_npm_package_count": 3,
        "xhs_card_package_lock_sha256": "f" * 64,
        "python_distribution_count": 2,
        "tikomni_snapshot_id": "approved-test-snapshot",
        "tikomni_snapshot_sha256": "1" * 64,
        "tikomni_file_sha256": {"SKILL.md": "2" * 64},
        "key_notice_hashes": {"aifios/notices.txt": "e" * 64},
        "review_boundaries": ["tikomni-connector-license-and-service-terms", "xhs-card-agpl"],
        "status": "pass-with-declared-review-boundaries",
    }
    build_supply_chain = {
        "schema": module.RUNTIME_SUPPLY_CHAIN_SCHEMA,
        "evidence": {
            "path": "aifios/third-party-notices/runtime-supply-chain.json",
            "sha256": "9" * 64,
            "size_bytes": 123,
        },
        "payload": {"schema": module.RUNTIME_SUPPLY_CHAIN_SCHEMA},
    }
    dependency_inventory["runtime_supply_chain"] = build_supply_chain
    monkeypatch.setattr(module, "verify_shipped_dependency_inventory", lambda _app: dependency_inventory)
    monkeypatch.setattr(module, "verify_runtime_supply_chain_evidence", lambda _app: build_supply_chain)
    manifest_path = tmp_path / "desktop-package-manifest.json"
    manifest_path.write_text(json.dumps({
        "app_name": "Echo Founder",
        "source_control": source,
        "trusted_qa_key_registry": qa_registry,
        "shipped_runtime": fingerprint,
        "shipped_dependency_inventory": dependency_inventory,
        "build_supply_chain": build_supply_chain,
    }), encoding="utf-8")

    result = module.verify_package_traceability(manifest_path, app)

    assert result["source_control"]["dirty"] is True
    assert result["trusted_qa_key_registry"] == qa_registry
    assert result["shipped_runtime"]["tree_sha256"] == fingerprint["tree_sha256"]
    with pytest.raises(RuntimeError, match="dirty source tree"):
        module.verify_package_traceability(manifest_path, app, require_clean_source=True)

    pristine_manifest = manifest_path.read_text(encoding="utf-8")
    tampered_registry = json.loads(pristine_manifest)
    tampered_registry["trusted_qa_key_registry"]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(tampered_registry), encoding="utf-8")
    with pytest.raises(RuntimeError, match="does not match the current source worktree"):
        module.verify_package_traceability(manifest_path, app)
    manifest_path.write_text(pristine_manifest, encoding="utf-8")

    executable.write_text("changed\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="does not match"):
        module.verify_package_traceability(manifest_path, app)


def test_runtime_supply_chain_evidence_binds_modes_archives_and_live_trees(tmp_path, monkeypatch) -> None:
    module = load_module()
    app = write_inventory_fixture(module, tmp_path, monkeypatch)
    electron_runtime, xhs_card_runtime, embedded_python_runtime = enable_runtime_supply_chain_fixture(
        module,
        app,
        monkeypatch,
    )
    payload = module.build_runtime_supply_chain_evidence(
        app,
        package_architecture="arm64",
        electron_runtime=electron_runtime,
        xhs_card_runtime=xhs_card_runtime,
        embedded_python_runtime=embedded_python_runtime,
    )

    result = module.write_runtime_supply_chain_evidence(app, payload)

    assert result["schema"] == module.RUNTIME_SUPPLY_CHAIN_SCHEMA
    assert result["payload"] == payload
    assert result["evidence"]["path"].endswith("runtime-supply-chain.json")
    evidence_path = (
        app / "Contents" / "Resources" / "aifios" / module.RUNTIME_SUPPLY_CHAIN_RELATIVE_PATH
    )
    pristine = evidence_path.read_text(encoding="utf-8")

    tampered_mode = json.loads(pristine)
    tampered_mode["electron"]["rebuild_mode"] = "reuse-builder-app"
    evidence_path.write_text(json.dumps(tampered_mode) + "\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="Electron runtime supply-chain projection"):
        module.verify_runtime_supply_chain_evidence(app)

    tampered_hash = json.loads(pristine)
    tampered_hash["python"]["architectures"]["arm64"]["source"]["archive_sha256"] = "0" * 64
    evidence_path.write_text(json.dumps(tampered_hash) + "\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="Python arm64 archive provenance"):
        module.verify_runtime_supply_chain_evidence(app)

    tampered_tree = json.loads(pristine)
    tampered_tree["ui"]["packaged_standalone_tree"]["tree_sha256"] = "0" * 64
    evidence_path.write_text(json.dumps(tampered_tree) + "\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="UI isolated-build supply-chain projection"):
        module.verify_runtime_supply_chain_evidence(app)

    evidence_path.write_text(pristine, encoding="utf-8")
    assert module.verify_runtime_supply_chain_evidence(app)["payload"] == payload
    electron_binary = app / "Contents" / "MacOS" / "Echo Founder"
    pristine_electron = electron_binary.read_bytes()
    electron_binary.write_bytes(b"tampered electron shell\n")
    with pytest.raises(RuntimeError, match="Electron runtime supply-chain projection"):
        module.verify_runtime_supply_chain_evidence(app)
    electron_binary.write_bytes(pristine_electron)
    assert module.verify_runtime_supply_chain_evidence(app)["payload"] == payload
    evidence_path.unlink()
    with pytest.raises(RuntimeError, match="missing or invalid"):
        module.verify_runtime_supply_chain_evidence(app)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS codesign behavior")
def test_electron_macos_projection_is_stable_across_ad_hoc_resigning(tmp_path) -> None:
    module = load_module()
    codesign = module.shutil.which("codesign")
    if not codesign:
        pytest.skip("codesign is unavailable")
    source = Path(sys.executable).resolve()
    if not module.macho_architectures(source):
        pytest.skip("test Python executable is not Mach-O")

    macos_root = tmp_path / "Echo Founder.app" / "Contents" / "MacOS"
    macos_root.mkdir(parents=True)
    executable = macos_root / "Echo Founder"
    module.shutil.copy2(source, executable)
    initially_signed, initial_output = module.run_capture(
        [
            codesign,
            "--force",
            "--sign",
            "-",
            "--identifier",
            "com.echofounder.signature-probe.before",
            str(executable),
        ],
        timeout=60,
    )
    assert initially_signed, initial_output
    before_raw = module.sha256_file(executable)
    before = module._runtime_tree_projection(
        macos_root,
        neutralize_macho_code_signatures=True,
    )

    signed, output = module.run_capture(
        [
            codesign,
            "--force",
            "--sign",
            "-",
            "--identifier",
            "com.echofounder.signature-probe.after",
            str(executable),
        ],
        timeout=60,
    )
    assert signed, output
    after_raw = module.sha256_file(executable)
    after = module._runtime_tree_projection(
        macos_root,
        neutralize_macho_code_signatures=True,
    )

    assert after_raw != before_raw
    assert after == before


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS codesign behavior")
def test_runtime_supply_chain_survives_resigning_but_rejects_resigned_code_tampering(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    codesign = module.shutil.which("codesign")
    if not codesign:
        pytest.skip("codesign is unavailable")
    source = Path(sys.executable).resolve()
    real_macho_architectures = module.macho_architectures
    if not real_macho_architectures(source):
        pytest.skip("test Python executable is not Mach-O")

    app = write_inventory_fixture(module, tmp_path, monkeypatch)
    electron_runtime, xhs_card_runtime, embedded_python_runtime = enable_runtime_supply_chain_fixture(
        module,
        app,
        monkeypatch,
    )
    monkeypatch.setattr(
        module,
        "macho_architectures",
        lambda path: {"arm64"}
        if path.name == "chrome-headless-shell"
        else real_macho_architectures(path),
    )
    executable = app / "Contents" / "MacOS" / "Echo Founder"
    module.shutil.copy2(source, executable)

    def sign(identifier: str) -> None:
        staged = tmp_path / f"{identifier}.macho"
        module.shutil.copy2(executable, staged)
        signed, output = module.run_capture(
            [
                codesign,
                "--force",
                "--sign",
                "-",
                "--identifier",
                identifier,
                str(staged),
            ],
            timeout=60,
        )
        assert signed, output
        module.shutil.copy2(staged, executable)

    sign("com.echofounder.supply-chain.before")
    payload = module.build_runtime_supply_chain_evidence(
        app,
        package_architecture="arm64",
        electron_runtime=electron_runtime,
        xhs_card_runtime=xhs_card_runtime,
        embedded_python_runtime=embedded_python_runtime,
    )
    written = module.write_runtime_supply_chain_evidence(app, payload)

    sign("com.echofounder.supply-chain.after")
    assert module.verify_runtime_supply_chain_evidence(app) == written

    replacement = Path("/bin/echo").resolve()
    if not real_macho_architectures(replacement):
        pytest.skip("replacement test executable is not Mach-O")
    module.shutil.copyfile(replacement, executable)
    executable.chmod(0o755)
    sign("com.echofounder.supply-chain.tampered")
    with pytest.raises(RuntimeError, match="Electron runtime supply-chain projection"):
        module.verify_runtime_supply_chain_evidence(app)


def test_dependency_inventory_binds_and_reverifies_runtime_supply_chain_evidence(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    app = write_inventory_fixture(module, tmp_path, monkeypatch)
    electron_runtime, xhs_card_runtime, embedded_python_runtime = enable_runtime_supply_chain_fixture(
        module,
        app,
        monkeypatch,
    )
    payload = module.build_runtime_supply_chain_evidence(
        app,
        package_architecture="arm64",
        electron_runtime=electron_runtime,
        xhs_card_runtime=xhs_card_runtime,
        embedded_python_runtime=embedded_python_runtime,
    )
    supply_chain = module.write_runtime_supply_chain_evidence(app, payload)

    result = module.write_shipped_dependency_inventory(
        app,
        product_version=module.DEFAULT_PRODUCT_VERSION,
        python_version=module.DEFAULT_PYTHON_VERSION,
        package_architecture="arm64",
        electron_versions={"electron": "43.0.0", "chrome": "150.0.7871.46", "node": "24.17.0"},
        runtime_supply_chain=supply_chain,
    )

    runtime_root = app / "Contents" / "Resources" / "aifios"
    evidence_path = runtime_root / module.RUNTIME_SUPPLY_CHAIN_RELATIVE_PATH
    inventory_path = runtime_root / module.SHIPPED_DEPENDENCY_INVENTORY_RELATIVE_PATH
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    evidence_key = supply_chain["evidence"]["path"]
    assert inventory["runtime_supply_chain"] == supply_chain
    assert inventory["key_notices"][evidence_key] == supply_chain["evidence"]["sha256"]
    assert result["runtime_supply_chain"] == supply_chain
    assert result["key_notice_hashes"][evidence_key] == supply_chain["evidence"]["sha256"]

    pristine_evidence = evidence_path.read_text(encoding="utf-8")
    tampered_evidence = json.loads(pristine_evidence)
    tampered_evidence["electron"]["rebuild_mode"] = "reuse-builder-app"
    evidence_path.write_text(json.dumps(tampered_evidence) + "\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="Electron runtime supply-chain projection"):
        module.verify_shipped_dependency_inventory(app)

    evidence_path.write_text(pristine_evidence, encoding="utf-8")
    evidence_path.unlink()
    with pytest.raises(RuntimeError, match="runtime supply-chain evidence is missing or invalid"):
        module.verify_shipped_dependency_inventory(app)

    evidence_path.write_text(pristine_evidence, encoding="utf-8")
    forged_inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    forged_inventory["runtime_supply_chain"]["payload"]["python"]["rebuild_mode"] = "reuse-cache"
    inventory_path.write_text(json.dumps(forged_inventory, indent=2) + "\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="projection is stale or forged"):
        module.verify_shipped_dependency_inventory(app)


def test_next_standalone_inventory_covers_roots_compiled_and_incomplete_physical_manifests(tmp_path) -> None:
    module = load_module()
    node_modules = tmp_path / "node_modules"
    package = node_modules / "next"
    package.mkdir(parents=True)
    (package / "package.json").write_text(
        json.dumps({"name": "next", "version": "16.3.2", "license": "MIT"}) + "\n",
        encoding="utf-8",
    )
    compiled = package / "dist" / "compiled" / "example"
    compiled.mkdir(parents=True)
    (compiled / "package.json").write_text(
        json.dumps({"name": "compiled-example", "license": "BSD-3-Clause"}) + "\n",
        encoding="utf-8",
    )
    nested = package / "node_modules" / "postcss"
    nested.mkdir(parents=True)
    (nested / "package.json").write_text(
        json.dumps({"name": "postcss", "version": "8.4.31", "license": "MIT"}) + "\n",
        encoding="utf-8",
    )

    inventory = module.discover_next_standalone_packages(tmp_path)

    assert {item["name"] for item in inventory} == {"compiled-example", "postcss", "next"}
    compiled_record = next(item for item in inventory if item["name"] == "compiled-example")
    assert compiled_record["manifest_scope"] == "embedded-package-metadata"
    assert compiled_record["version"] == "NOASSERTION"
    assert compiled_record["license"] == "BSD-3-Clause"
    assert compiled_record["metadata_missing"] == ["version"]


def test_shipped_dependency_inventory_copies_notices_and_fails_closed_on_tampering(tmp_path, monkeypatch) -> None:
    module = load_module()
    app = write_inventory_fixture(module, tmp_path, monkeypatch)

    result = module.write_shipped_dependency_inventory(
        app,
        product_version=module.DEFAULT_PRODUCT_VERSION,
        python_version=module.DEFAULT_PYTHON_VERSION,
        package_architecture="arm64",
        electron_versions={"electron": "43.0.0", "chrome": "150.0.7871.46", "node": "24.17.0"},
    )

    inventory_path = (
        app
        / "Contents"
        / "Resources"
        / "aifios"
        / module.SHIPPED_DEPENDENCY_INVENTORY_RELATIVE_PATH
    )
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    component_ids = {item["id"] for item in inventory["components"]}
    assert result["status"] == "pass-with-declared-review-boundaries"
    assert {"electron", "chromium-electron", "next-standalone", "cpython:arm64"}.issubset(component_ids)
    assert "chromium-headless-shell:arm64" in component_ids
    assert {item["name"] for item in inventory["xhs_card_npm_packages"]} == {
        "fsevents",
        "playwright",
        "playwright-core",
    }
    assert all(
        any("LICENSE" in evidence["path"] for evidence in item["license_evidence"])
        for item in inventory["xhs_card_npm_packages"]
    )
    playwright_core = next(
        item for item in inventory["xhs_card_npm_packages"] if item["name"] == "playwright-core"
    )
    assert any("ThirdPartyNotices.txt" in evidence["path"] for evidence in playwright_core["license_evidence"])
    assert any("bundle.js.LICENSE" in evidence["path"] for evidence in playwright_core["license_evidence"])
    assert {item["name"] for item in inventory["python_distributions"]} == {
        "pip",
        "setuptools",
        "jaraco.text",
    }
    assert inventory["next_standalone_npm_packages"]
    assert all(item["name"] and item["version"] and item["license"] for item in inventory["next_standalone_npm_packages"])
    incomplete = next(
        item
        for item in inventory["next_standalone_npm_packages"]
        if item["name"] == "compiled-with-incomplete-metadata"
    )
    assert incomplete["license"] == "NOASSERTION"
    assert incomplete["license_evidence_mode"] == "metadata-only-review-required"
    assert incomplete["license_text_sha256"] == []
    tikomni = next(item for item in inventory["components"] if item["id"] == "tikomni-connector")
    assert tikomni["license"] == "NOASSERTION"
    assert tikomni["version"] == module.TIKOMNI_APPROVED_SNAPSHOT_ID
    assert tikomni["approved_snapshot_sha256"] == module.TIKOMNI_APPROVED_SNAPSHOT_SHA256
    assert tikomni["service_shipped"] is False
    assert "tikomni-connector-license-and-service-terms" in result["review_boundaries"]
    assert "aifios/skills/xhs-card/README.en.md" in inventory["key_notices"]

    chromium_notice = (
        app / "Contents" / "Resources" / "aifios" / module.CHROMIUM_LICENSE_NOTICE
    )
    chromium_notice.write_text("tampered\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="hash/size mismatch"):
        module.verify_shipped_dependency_inventory(app)


def test_shipped_dependency_inventory_detects_live_npm_manifest_drift(tmp_path, monkeypatch) -> None:
    module = load_module()
    app = write_inventory_fixture(module, tmp_path, monkeypatch)
    module.write_shipped_dependency_inventory(
        app,
        product_version=module.DEFAULT_PRODUCT_VERSION,
        python_version=module.DEFAULT_PYTHON_VERSION,
        package_architecture="arm64",
        electron_versions={"electron": "43.0.0", "chrome": "150.0.7871.46", "node": "24.17.0"},
    )
    next_package = (
        module.next_standalone_root(app / "Contents" / "Resources" / "aifios" / "ui" / module.DESKTOP_DIST_DIR)
        / "node_modules"
        / "next"
        / "package.json"
    )
    payload = json.loads(next_package.read_text(encoding="utf-8"))
    payload["version"] = "99.0.0"
    next_package.write_text(json.dumps(payload) + "\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="does not match the live Next standalone npm tree"):
        module.verify_shipped_dependency_inventory(app)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("forge-mode", "does not match the live Next standalone npm tree"),
        ("clear-full-text-hashes", "does not match the live Next standalone npm tree"),
        ("delete-boundary", "omits matching manual-review boundaries"),
    ],
)
def test_shipped_dependency_inventory_recomputes_evidence_and_boundaries(
    tmp_path,
    monkeypatch,
    mutation: str,
    message: str,
) -> None:
    module = load_module()
    app = write_inventory_fixture(module, tmp_path, monkeypatch)
    module.write_shipped_dependency_inventory(
        app,
        product_version=module.DEFAULT_PRODUCT_VERSION,
        python_version=module.DEFAULT_PYTHON_VERSION,
        package_architecture="arm64",
        electron_versions={"electron": "43.0.0", "chrome": "150.0.7871.46", "node": "24.17.0"},
    )
    inventory_path = (
        app / "Contents" / "Resources" / "aifios" / module.SHIPPED_DEPENDENCY_INVENTORY_RELATIVE_PATH
    )
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    incomplete = next(
        item
        for item in inventory["next_standalone_npm_packages"]
        if item["name"] == "compiled-with-incomplete-metadata"
    )
    if mutation == "forge-mode":
        incomplete["license_evidence_mode"] = "full-text-aggregate"
        incomplete["license_text_sha256"] = ["0" * 64]
    elif mutation == "clear-full-text-hashes":
        full_text = next(
            item
            for item in inventory["next_standalone_npm_packages"]
            if item["license_evidence_mode"] == "full-text-aggregate"
        )
        full_text["license_text_sha256"] = []
    else:
        boundary_id = module._npm_review_boundary_id("license-text", incomplete)
        inventory["review_boundaries"] = [
            item for item in inventory["review_boundaries"] if item.get("id") != boundary_id
        ]
    inventory_path.write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match=message):
        module.verify_shipped_dependency_inventory(app)


def test_python_dist_info_and_license_evidence_tampering_is_detected(tmp_path, monkeypatch) -> None:
    module = load_module()
    app = write_inventory_fixture(module, tmp_path, monkeypatch)
    module.write_shipped_dependency_inventory(
        app,
        product_version=module.DEFAULT_PRODUCT_VERSION,
        python_version=module.DEFAULT_PYTHON_VERSION,
        package_architecture="arm64",
        electron_versions={"electron": "43.0.0", "chrome": "150.0.7871.46", "node": "24.17.0"},
    )
    inventory_path = (
        app / "Contents" / "Resources" / "aifios" / module.SHIPPED_DEPENDENCY_INVENTORY_RELATIVE_PATH
    )
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    pip = next(item for item in inventory["python_distributions"] if item["name"] == "pip")
    evidence_path = app / "Contents" / "Resources" / pip["license_evidence"][0]["path"]
    evidence_path.write_text("tampered pip license\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="Python dist-info inventory does not match"):
        module.verify_shipped_dependency_inventory(app)


def test_tikomni_requires_explicit_approved_snapshot_and_rejects_tampering(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    fake_home = tmp_path / "home"
    fallback = fake_home / ".codex" / "skills" / module.TIKOMNI_SKILL_NAME
    write_approved_tikomni_fixture(module, fallback, monkeypatch)
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("TIKOMNI_SOCIAL_MEDIA_CRAWL_DIR", str(fallback))

    with pytest.raises(RuntimeError, match="explicit --social-media-crawl-dir"):
        module.resolve_tikomni_social_media_crawl_source()

    assert module.resolve_tikomni_social_media_crawl_source(str(fallback)) == fallback.resolve()
    verification = module.verify_tikomni_social_media_crawl(fallback)
    assert verification["snapshot_sha256"] == module.TIKOMNI_APPROVED_SNAPSHOT_SHA256
    (fallback / module.TIKOMNI_CALLER_RELATIVE_PATH).write_text("# tampered\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="does not match the approved connector snapshot"):
        module.verify_tikomni_social_media_crawl(fallback)


def test_xhs_card_runtime_is_always_staged_and_ignores_poisoned_source_node_modules(
    tmp_path,
    monkeypatch,
) -> None:
    module = load_module()
    xhs = tmp_path / "xhs-card"
    write_minimal_xhs_card(xhs)
    poisoned_cli = xhs / "node_modules" / "playwright" / "cli.js"
    poisoned_cli.parent.mkdir(parents=True)
    poisoned_cli.write_text("POISONED LOCAL CLI\n", encoding="utf-8")
    (poisoned_cli.parent / "package.json").write_text(
        json.dumps({"name": "playwright", "version": "1.60.0", "license": "Apache-2.0"}) + "\n",
        encoding="utf-8",
    )
    (poisoned_cli.parent / "LICENSE").write_text("poisoned license\n", encoding="utf-8")
    packaged = tmp_path / "packaged-xhs-card"
    module.shutil.copytree(xhs, packaged, ignore=module.bundle_ignore)
    assert not (packaged / "node_modules").exists()
    calls: list[tuple[list[str], dict[str, str]]] = []
    staging_roots: list[Path] = []

    def fake_run(command, cwd, env, timeout):
        calls.append((command, env))
        staging_roots.append(cwd)
        user_config = Path(env["npm_config_userconfig"])
        global_config = Path(env["npm_config_globalconfig"])
        assert user_config != global_config
        assert user_config.is_relative_to(cwd.parent)
        assert global_config.is_relative_to(cwd.parent)
        assert user_config.read_text(encoding="utf-8") == ""
        assert global_config.read_text(encoding="utf-8") == ""
        packages = {
            "node_modules/fsevents": ("fsevents", "2.3.2", "MIT"),
            "node_modules/playwright": ("playwright", "1.60.0", "Apache-2.0"),
            "node_modules/playwright-core": ("playwright-core", "1.60.0", "Apache-2.0"),
        }
        for relative, (name, version, license_expression) in packages.items():
            package = cwd / relative
            package.mkdir(parents=True, exist_ok=True)
            (package / "package.json").write_text(
                json.dumps({"name": name, "version": version, "license": license_expression}) + "\n",
                encoding="utf-8",
            )
            (package / "LICENSE").write_text(f"clean {name} license\n", encoding="utf-8")
        (cwd / "node_modules" / "playwright" / "cli.js").write_text("CLEAN STAGED CLI\n", encoding="utf-8")
        (cwd / "node_modules" / "playwright-core" / "browsers.json").write_text(
            json.dumps({"browsers": [{"name": "chromium-headless-shell", "revision": "1223"}]}) + "\n",
            encoding="utf-8",
        )

    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/local/bin/npm" if name == "npm" else None)
    monkeypatch.setattr(module, "run_npm_ci_with_network_retry", fake_run)
    monkeypatch.setattr(module, "DESKTOP_DOWNLOAD_CACHE", tmp_path / "download-cache")
    monkeypatch.setenv("HOME", str(tmp_path / "poisoned-home"))
    monkeypatch.setenv("NPM_CONFIG_REGISTRY", "https://poisoned.invalid/")
    monkeypatch.setenv("NODE_OPTIONS", "--require=/tmp/poisoned.js")
    monkeypatch.setenv("NODE_PATH", "/tmp/poisoned-node-path")
    monkeypatch.setenv("NEXT_PUBLIC_POISON", "secret-build-input")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "poisoned-browser-cache"))

    result = module.prepare_xhs_card_runtime_dependencies(xhs, packaged)

    assert result["status"] == "staged-clean-install"
    assert result["package_count"] == 3
    assert len(result["node_modules_tree_sha256"]) == 64
    assert calls[0][0][1:] == ["ci", "--omit=dev", "--ignore-scripts"]
    assert calls[0][1]["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] == "1"
    assert (packaged / "node_modules" / "playwright" / "cli.js").read_text(encoding="utf-8") == "CLEAN STAGED CLI\n"
    assert poisoned_cli.read_text(encoding="utf-8") == "POISONED LOCAL CLI\n"
    npm_env = calls[0][1]
    assert Path(npm_env["HOME"]).parent == staging_roots[0].parent
    assert Path(npm_env["npm_config_cache"]).parent == staging_roots[0].parent
    assert npm_env["npm_config_userconfig"] != npm_env["npm_config_globalconfig"]
    for name in (
        "NPM_CONFIG_REGISTRY",
        "NODE_OPTIONS",
        "NODE_PATH",
        "NEXT_PUBLIC_POISON",
        "PLAYWRIGHT_BROWSERS_PATH",
    ):
        assert name not in npm_env
    assert staging_roots and all(not path.exists() for path in staging_roots)


def test_local_self_config_bundle_never_copies_a_hosted_client_bootstrap(tmp_path, monkeypatch) -> None:
    module = load_module()
    monkeypatch.setattr(module, "REPO_ROOT", tmp_path)
    (tmp_path / "hosted-client.json").write_text('{"gatewayUrl":"https://gateway.example.com"}\n', encoding="utf-8")
    (tmp_path / "scripts").mkdir()
    for name in module.RUNTIME_SCRIPT_FILES:
        (tmp_path / "scripts" / name).write_text("# runtime\n", encoding="utf-8")
    (tmp_path / "skills").mkdir()
    write_minimal_xhs_card(tmp_path / "skills" / "xhs-card")
    (tmp_path / "skills" / "manifest.json").write_text(
        json.dumps(
            {
                "runtime": {"entrypoints": {}},
                "included_skills": [{"name": "xhs-card", "path": "skills/xhs-card/SKILL.md", "required": True}],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (tmp_path / "docs").mkdir()
    for name in module.CUSTOMER_DOCUMENTS:
        (tmp_path / "docs" / name).write_text(f"# {name}\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("internal build readme\n", encoding="utf-8")
    (tmp_path / "VERSION").write_text(module.DEFAULT_PRODUCT_VERSION + "\n", encoding="utf-8")

    target = tmp_path / "bundle"
    module.copy_aifios_runtime(target)

    assert (target / "VERSION").read_text(encoding="utf-8").strip() == module.DEFAULT_PRODUCT_VERSION
    assert not (target / "hosted-client.json").exists()
    assert not (target / "README.md").exists()
    assert (target / "scripts" / "aifios.py").is_file()
    assert (target / "docs" / "echo-founder-installation.md").is_file()
    assert (target / "skills" / "xhs-card" / "README.md").is_file()
    assert (target / "skills" / "xhs-card" / "README.en.md").is_file()
    assert (target / "skills" / "xhs-card" / "MODIFICATIONS.md").is_file()
    assert module.verify_customer_bundle_hygiene(target)["status"] == "pass"


def test_customer_bundle_hygiene_rejects_internal_docs_project_data_and_builder_paths(tmp_path, monkeypatch) -> None:
    module = load_module()
    source = tmp_path / "source"
    monkeypatch.setattr(module, "REPO_ROOT", source)
    target = tmp_path / "bundle"
    for relative in [
        *(Path("scripts") / name for name in module.RUNTIME_SCRIPT_FILES),
        *(Path("docs") / name for name in module.CUSTOMER_DOCUMENTS),
    ]:
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("customer runtime\n", encoding="utf-8")
    skills = target / "skills"
    skills.mkdir()
    write_minimal_xhs_card(skills / "xhs-card")
    (skills / "manifest.json").write_text(
        '{"included_skills": [{"name": "xhs-card"}]}\n',
        encoding="utf-8",
    )

    (target / "AGENTS.md").write_text("internal\n", encoding="utf-8")
    try:
        module.verify_customer_bundle_hygiene(target)
    except RuntimeError as exc:
        assert "internal or project-data" in str(exc)
    else:
        raise AssertionError("Internal handoff files must block customer packaging")

    (target / "AGENTS.md").unlink()
    leaked = target / "docs" / "echo-founder-installation.md"
    leaked.write_text(f"builder={source.resolve()}\n", encoding="utf-8")
    try:
        module.verify_customer_bundle_hygiene(target)
    except RuntimeError as exc:
        assert "build-machine absolute path" in str(exc)
    else:
        raise AssertionError("Build-machine paths must block customer packaging")

    leaked.write_text("# Echo Founder 安装说明\n", encoding="utf-8")
    identity_leak = target / "skills" / "xhs-card" / "SKILL.md"
    identity_leak.write_text("默认作者：常欢\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="single-author identity"):
        module.verify_customer_bundle_hygiene(target)


def test_hosted_client_bootstrap_contains_only_public_device_bound_metadata(tmp_path) -> None:
    module = load_module()
    result = module.write_hosted_client_config(tmp_path, "https://gateway.example.com", None)

    assert result is not None
    payload = (tmp_path / "hosted-client.json").read_text(encoding="utf-8")
    assert "gateway.example.com" in payload
    assert "device-bound" in payload
    assert "apiKey" not in payload
    assert "token" not in payload.lower()


def test_distribution_marker_keeps_hosted_license_mode_outside_project_runtime(tmp_path) -> None:
    module = load_module()
    runtime_root = tmp_path / "aifios"
    runtime_root.mkdir()
    hosted = module.write_hosted_client_config(runtime_root, "https://gateway.example.com", None)

    marker = module.write_distribution_config(tmp_path / "resources", hosted)

    assert marker["mode"] == "hosted-license"
    assert marker["deviceBinding"] is True
    payload = (tmp_path / "resources" / "aifios-distribution.json").read_text(encoding="utf-8")
    assert "gateway.example.com" not in payload
    assert "token" not in payload.lower()


def test_legacy_demo_unlock_option_does_not_embed_a_password_gate(tmp_path) -> None:
    module = load_module()
    password = "FRIEND-7X9K-P4DM-R8VQ"

    result = module.write_demo_unlock_config(tmp_path, password)
    assert result is None
    assert not (tmp_path / "demo-unlock.json").exists()
