#!/usr/bin/env python3
"""Smoke test a packaged Echo Founder macOS .app bundle."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import re
import signal
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


REPO_ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
REQUIRED_PAGE_ROUTES = ("/production", "/publication-desk", "/weekly-review")
REQUIRED_API_PROBES = {
    "/api/production/advance": {},
    "/api/publish/drafts": {"action": "prepare"},
}
TIKOMNI_SKILL_ROOT = Path("Contents/Resources/aifios/skills/social-media-crawl")
TIKOMNI_REQUIRED_FILES = (
    Path("SKILL.md"),
    Path("scripts/__init__.py"),
    Path("scripts/core/__init__.py"),
    Path("scripts/core/api_catalog.py"),
    Path("scripts/core/tikomni_common.py"),
    Path("scripts/core/call_tikomni_api.py"),
    Path("scripts/core/resolve_api_endpoint.py"),
    Path("references/api-catalog/aliases.json"),
    Path("references/api-catalog/operations.json"),
)
UNIVERSAL_MACHO_ARCHITECTURES = {"arm64", "x86_64"}
DEFAULT_EXPECTED_ARCHITECTURE = "arm64"
PLAYWRIGHT_RUNTIME_SCHEMA = "aifios.playwright-runtime.v1"
RUNTIME_TREE_HASH_SCHEMA = "echo-founder.runtime-tree.v1"
HOSTED_CLIENT_SCHEMA = "aifios.hosted-client.v1"
HOSTED_DISTRIBUTION_SCHEMA = "aifios.desktop-distribution.v1"


def host_architecture() -> str:
    value = platform.machine().strip().lower()
    if value in {"arm64", "aarch64"}:
        return "arm64"
    if value in {"x86_64", "amd64"}:
        return "x64"
    raise RuntimeError(f"unsupported macOS host architecture: {value or 'unknown'}")


def lipo_architecture_name(architecture: str) -> str:
    return "x86_64" if architecture == "x64" else "arm64"


def macho_architectures(path: Path) -> set[str]:
    if not path.is_file() or path.is_symlink() or not shutil.which("lipo"):
        return set()
    result = subprocess.run(
        ["lipo", "-archs", str(path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    return {item.strip() for item in result.stdout.split() if item.strip()} if result.returncode == 0 else set()


def verify_bundled_electron_architecture(app_path: Path, expected_architecture: str = DEFAULT_EXPECTED_ARCHITECTURE) -> tuple[bool, str]:
    expected = UNIVERSAL_MACHO_ARCHITECTURES if expected_architecture == "universal" else {lipo_architecture_name(expected_architecture)}
    missing: dict[str, list[str]] = {}
    checked = 0
    for root in [app_path / "Contents" / "MacOS", app_path / "Contents" / "Frameworks"]:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            actual = macho_architectures(path)
            if not actual:
                continue
            checked += 1
            absent = expected - actual
            if absent:
                missing[path.relative_to(app_path).as_posix()] = sorted(absent)
    if not checked:
        return False, "no inspectable Electron Mach-O binaries"
    if missing:
        return False, "Electron runtime is not the requested architecture: " + json.dumps(missing, ensure_ascii=False)
    return True, f"Electron architecture ok: {','.join(sorted(expected))} ({checked} Mach-O files)"


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return int(sock.getsockname()[1])


def port_is_open(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=0.5):
            return True
    except OSError:
        return False


def fetch_json(url: str, timeout: float = 2.0) -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if response.status != 200:
                return None
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def read_json_file(path: Path) -> dict[str, object] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def is_credential_free_https_origin(value: object) -> bool:
    raw = str(value or "").strip()
    try:
        parsed = urlparse(raw)
    except ValueError:
        return False
    return bool(
        parsed.scheme == "https"
        and parsed.netloc
        and not parsed.username
        and not parsed.password
        and parsed.path in {"", "/"}
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
    )


def verify_hosted_license_bundle(app_path: Path) -> tuple[bool, str]:
    resources = app_path / "Contents/Resources"
    distribution = read_json_file(resources / "aifios-distribution.json")
    bootstrap = read_json_file(resources / "aifios/hosted-client.json")
    if not distribution:
        return False, "hosted distribution marker is missing or invalid"
    if distribution.get("schema") != HOSTED_DISTRIBUTION_SCHEMA:
        return False, "hosted distribution marker schema is invalid"
    if distribution.get("mode") != "hosted-license" or distribution.get("deviceBinding") is not True:
        return False, "bundle is not marked as a device-bound hosted license"
    if not bootstrap:
        return False, "hosted client bootstrap is missing or invalid"
    if bootstrap.get("schema") != HOSTED_CLIENT_SCHEMA or bootstrap.get("licenseMode") != "device-bound":
        return False, "hosted client bootstrap does not require device-bound licensing"
    if not is_credential_free_https_origin(bootstrap.get("gatewayUrl")):
        return False, "hosted client bootstrap must contain a credential-free HTTPS gateway origin"
    forbidden = {"apiKey", "token", "adminToken", "sessionToken", "secret", "privateKey"}
    if forbidden.intersection(bootstrap):
        return False, "hosted client bootstrap contains a forbidden credential field"
    return True, "device-bound hosted bootstrap and distribution marker ok"


def verify_hosted_license_gate(port: int) -> tuple[bool, str]:
    status, content_type, body = request_response(f"http://{HOST}:{port}/api/config")
    if status != 200 or "application/json" not in content_type.lower():
        return False, f"hosted config endpoint returned HTTP {status} ({content_type!r})"
    try:
        payload = json.loads(body.decode("utf-8"))
        config = payload.get("config") if isinstance(payload, dict) else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, "hosted config endpoint returned invalid JSON"
    if not isinstance(config, dict):
        return False, "hosted config endpoint has no config object"
    if config.get("provider") != "aifios-hosted" or config.get("connectionMode") != "hosted":
        return False, "unactivated hosted bundle did not stay in hosted connection mode"
    if config.get("gatewayConnected") is not False or config.get("apiKey") not in {"", None}:
        return False, "unactivated hosted bundle unexpectedly has an active local credential"

    status, content_type, body = request_response(f"http://{HOST}:{port}/api/config/hosted/status")
    if status != 200 or "application/json" not in content_type.lower():
        return False, f"unactivated hosted status returned HTTP {status} ({content_type!r})"
    try:
        hosted_status = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, "unactivated hosted status returned invalid JSON"
    if not isinstance(hosted_status, dict) or hosted_status.get("connected") is not False:
        return False, "unactivated hosted package reported a verified gateway session"

    status, content_type, body = request_response(
        f"http://{HOST}:{port}/api/config",
        method="POST",
        body={"provider": "openai", "apiKey": "attempt-to-bypass", "model": "any"},
        follow_redirects=False,
    )
    if status != 401 or "application/json" not in content_type.lower():
        return False, f"hosted config write returned HTTP {status} ({content_type!r})"
    try:
        denied = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, "hosted config write denial returned invalid JSON"
    if not isinstance(denied, dict) or denied.get("error", {}).get("code") != "device_activation_required":
        return False, "hosted config write was not rejected by the global license gate"

    for route in ("/", "/production", "/publication-desk", "/weekly-review"):
        status, _, _ = request_response(
            f"http://{HOST}:{port}{route}",
            follow_redirects=False,
        )
        if status not in {307, 308}:
            return False, f"unactivated hosted page was not redirected: {route} returned HTTP {status}"

    for route in ("/api/status", "/api/desktop/diagnostics", "/api/production/advance"):
        status, content_type, body = request_response(
            f"http://{HOST}:{port}{route}",
            method="POST" if route == "/api/production/advance" else "GET",
            body={} if route == "/api/production/advance" else None,
            follow_redirects=False,
        )
        if status != 401 or "application/json" not in content_type.lower():
            return False, f"unactivated hosted API was not denied: {route} returned HTTP {status}"
        try:
            denied = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False, f"unactivated hosted API returned invalid denial JSON: {route}"
        if not isinstance(denied, dict) or denied.get("error", {}).get("code") != "device_activation_required":
            return False, f"unactivated hosted API bypassed the global license gate: {route}"

    return True, "unactivated hosted package redirects business pages and denies business APIs"


def verify_demo_unlock_gate(port: int, password: str) -> tuple[bool, str]:
    """Prove the packaged local password blocks access and unlocks only with the supplied value."""
    config_url = f"http://{HOST}:{port}/api/config"
    ok, detail, status, content_type, body = wait_for_route_response(
        config_url,
        predicate=lambda current_status, current_content_type, current_body: (
            current_status == 200
            and "application/json" in current_content_type.lower()
            and isinstance(json.loads(current_body.decode("utf-8")).get("config"), dict)
            and json.loads(current_body.decode("utf-8"))["config"].get("demoUnlockRequired") is True
        ),
        deadline_seconds=45,
    )
    if not ok:
        return False, f"product password config did not become ready: HTTP {status} ({content_type!r}; {detail})"
    try:
        initial_config = json.loads(body.decode("utf-8")).get("config")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, "product password config returned invalid JSON"
    if not isinstance(initial_config, dict) or initial_config.get("demoUnlocked") is not False:
        return False, "fresh product-password project was unexpectedly unlocked"
    if "demoUnlockCode" in initial_config:
        return False, "public config leaked a plaintext product password"

    status, content_type, body = request_response(
        f"http://{HOST}:{port}/api/status",
        follow_redirects=False,
    )
    if status != 401 or "application/json" not in content_type.lower():
        return False, f"protected API was not blocked before password entry: HTTP {status}"

    wrong_password = "WRONG-PRODUCT-PASSWORD"
    if wrong_password == password.strip().upper():
        wrong_password = "ANOTHER-WRONG-PASSWORD"
    status, _, _ = request_response(
        f"http://{HOST}:{port}/api/config/demo-unlock",
        method="POST",
        body={"unlockCode": wrong_password},
        follow_redirects=False,
    )
    if status != 400:
        return False, f"incorrect product password was not rejected: HTTP {status}"

    status, content_type, body = request_response(
        f"http://{HOST}:{port}/api/config/demo-unlock",
        method="POST",
        body={"unlockCode": password},
        follow_redirects=False,
    )
    if status != 200 or "application/json" not in content_type.lower():
        return False, f"configured product password was rejected: HTTP {status} ({content_type!r})"
    try:
        unlocked = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, "product password response returned invalid JSON"
    if unlocked != {"unlocked": True} or password.upper() in body.decode("utf-8", errors="ignore").upper():
        return False, "product password response leaked the credential or had an unexpected shape"

    config = fetch_json(config_url)
    public_config = config.get("config") if isinstance(config, dict) else None
    if not isinstance(public_config, dict) or public_config.get("demoUnlocked") is not True:
        return False, "product password did not persist the unlocked state"
    if "demoUnlockCode" in public_config:
        return False, "unlocked public config leaked a plaintext product password"
    return True, "wrong password rejected; configured password unlocked without plaintext leakage"


def verify_encrypted_device_identity(user_data_dir: Path) -> tuple[bool, str]:
    identity = read_json_file(user_data_dir / "device-id.json")
    if not identity:
        return False, "desktop device identity is missing or invalid"
    if identity.get("schema") != "aifios.desktop-device.v3":
        return False, "desktop device identity schema is invalid"
    if identity.get("algorithm") != "Ed25519" or identity.get("storage") != "os-keychain":
        return False, "paid device identity was not protected by the OS keychain"
    ciphertext = identity.get("privateKeyCiphertext")
    if not isinstance(ciphertext, str) or len(ciphertext) < 24:
        return False, "paid device identity has no encrypted private key"
    key_id = identity.get("keyId")
    public_key_spki = identity.get("publicKeySpki")
    if not isinstance(key_id, str) or not re.fullmatch(r"ed25519:[A-Za-z0-9_-]{43}", key_id):
        return False, "paid device identity has an invalid Ed25519 key id"
    if not isinstance(public_key_spki, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,256}", public_key_spki):
        return False, "paid device identity has an invalid public key"
    try:
        padding = "=" * (-len(public_key_spki) % 4)
        public_key_der = base64.urlsafe_b64decode(public_key_spki + padding)
        derived_key_id = "ed25519:" + base64.urlsafe_b64encode(
            hashlib.sha256(public_key_der).digest(),
        ).decode("ascii").rstrip("=")
        base64.b64decode(ciphertext, validate=True)
    except (ValueError, TypeError):
        return False, "paid device identity contains invalid key encoding"
    if derived_key_id != key_id:
        return False, "paid device identity public key does not match its key id"
    for forbidden in ("deviceId", "privateKey", "privateKeyPkcs8"):
        if forbidden in identity:
            return False, f"paid device identity contains forbidden plaintext field: {forbidden}"
    return True, "Ed25519 device private key is encrypted with the OS keychain"


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_response(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, object] | None = None,
    timeout: float = 10.0,
    follow_redirects: bool = True,
) -> tuple[int, str, bytes]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        opener = urllib.request.build_opener() if follow_redirects else urllib.request.build_opener(_NoRedirectHandler())
        with opener.open(request, timeout=timeout) as response:
            return int(response.status), str(response.headers.get("Content-Type", "")), response.read()
    except urllib.error.HTTPError as error:
        return int(error.code), str(error.headers.get("Content-Type", "")), error.read()


def retry_response(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, object] | None = None,
    deadline_seconds: float = 30.0,
) -> tuple[int | None, str, bytes, str]:
    """Wait for cold packaged Next routes without hiding persistent failures."""
    deadline = time.time() + deadline_seconds
    last_detail = "not attempted"
    last_response: tuple[int | None, str, bytes] = (None, "", b"")
    while time.time() < deadline:
        try:
            status, content_type, response = request_response(
                url,
                method=method,
                body=body,
                timeout=min(10.0, max(1.0, deadline - time.time())),
            )
            last_response = (status, content_type, response)
            return status, content_type, response, ""
        except Exception as exc:
            last_detail = str(exc)
            time.sleep(0.5)
    status, content_type, response = last_response
    return status, content_type, response, last_detail


def wait_for_route_response(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, object] | None = None,
    predicate: callable,
    deadline_seconds: float = 30.0,
) -> tuple[bool, str, int | None, str, bytes]:
    """Retry a first-hit route until its expected response is available."""
    deadline = time.time() + deadline_seconds
    last_detail = "not attempted"
    last_response: tuple[int | None, str, bytes] = (None, "", b"")
    while time.time() < deadline:
        status, content_type, response, request_error = retry_response(
            url,
            method=method,
            body=body,
            deadline_seconds=min(10.0, max(1.0, deadline - time.time())),
        )
        last_response = (status, content_type, response)
        if not request_error and status is not None:
            try:
                if predicate(status, content_type, response):
                    return True, "", status, content_type, response
            except Exception as exc:
                last_detail = str(exc)
            else:
                last_detail = f"status={status} content-type={content_type!r}"
        elif request_error:
            last_detail = request_error
        time.sleep(0.5)
    status, content_type, response = last_response
    return False, last_detail, status, content_type, response


def verify_required_production_routes(port: int) -> tuple[bool, str]:
    """Check the actual packaged Next server, including cold route activation."""
    for route in REQUIRED_PAGE_ROUTES:
        ok, detail, status, content_type, response = wait_for_route_response(
            f"http://{HOST}:{port}{route}",
            predicate=lambda current_status, current_content_type, current_body: (
                current_status == 200
                and "text/html" in current_content_type.lower()
                and b"<html" in current_body.lower()
            ),
        )
        if not ok:
            if status is None:
                return False, f"{route} request failed: {detail}"
            if status != 200:
                return False, f"{route} returned HTTP {status} after retry: {detail}"
            return False, f"{route} did not return an HTML application page (content-type={content_type!r}; {detail})"

    for route, payload in REQUIRED_API_PROBES.items():
        ok, detail, status, content_type, response = wait_for_route_response(
            f"http://{HOST}:{port}{route}",
            method="POST",
            body=payload,
            predicate=lambda current_status, current_content_type, current_body: (
                current_status == 400
                and "application/json" in current_content_type.lower()
                and isinstance(json.loads(current_body.decode("utf-8")), dict)
                and isinstance(json.loads(current_body.decode("utf-8")).get("error"), str)
                and bool(json.loads(current_body.decode("utf-8")).get("error").strip())
            ),
        )
        body = response
        if not ok:
            if status is None:
                return False, f"{route} request failed: {detail}"
        # Empty deliberately-invalid requests exercise the route module without
        # advancing a run or creating a draft queue. Both handlers must reject
        # them as structured user input errors, not 404 because an old build was
        # packaged.
        if status != 400:
            return False, f"{route} expected HTTP 400 for invalid smoke input, got {status} after retry: {detail}"
        if "application/json" not in content_type.lower():
            return False, f"{route} did not return JSON (content-type={content_type!r}; {detail})"
        try:
            response = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False, f"{route} returned invalid JSON"
        if not isinstance(response, dict) or not isinstance(response.get("error"), str) or not response["error"].strip():
            return False, f"{route} did not return the expected structured validation error"
    return True, "production pages and API routes ok"


def subprocess_architecture_prefix(architecture: str | None) -> list[str]:
    if not architecture:
        return []
    arch = shutil.which("arch")
    if not arch:
        raise RuntimeError("macOS arch is required to smoke-test a non-native desktop slice.")
    return [arch, f"-{lipo_architecture_name(architecture)}"]


def verify_bundled_tikomni_caller(app_path: Path, architecture: str | None = None) -> tuple[bool, str]:
    skill_root = app_path / TIKOMNI_SKILL_ROOT
    missing = [str(skill_root / item) for item in TIKOMNI_REQUIRED_FILES if not (skill_root / item).is_file()]
    if missing:
        return False, "bundled TikOmni social-media-crawl is incomplete: " + ", ".join(missing)
    selected_architecture = architecture or host_architecture()
    embedded_python = app_path / "Contents/Resources/aifios/runtime/python" / selected_architecture / "bin/python3"
    if not embedded_python.is_file():
        return False, f"bundled Python runtime is missing for TikOmni resolver smoke: {embedded_python}"
    python = embedded_python
    resolver = skill_root / "scripts/core/resolve_api_endpoint.py"
    # This probe executes code from the signed app bundle before the Electron
    # service starts. Never let CPython create __pycache__ inside Resources:
    # those files would invalidate the bundle signature after an otherwise
    # successful smoke test.
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    try:
        result = subprocess.run(
            [*subprocess_architecture_prefix(architecture), str(python), str(resolver), "--platform", "xiaohongshu", "--capability", "search"],
            cwd=skill_root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=20,
            check=False,
        )
        response = json.loads(result.stdout)
    except Exception as exc:
        return False, f"bundled TikOmni resolver smoke failed: {exc}"
    recommended = response.get("recommended") if isinstance(response, dict) else {}
    endpoint_id = recommended.get("endpoint_id") if isinstance(recommended, dict) else ""
    if result.returncode != 0 or not isinstance(response, dict) or response.get("ok") is not True or not endpoint_id:
        return False, f"bundled TikOmni resolver returned an invalid result: {result.stdout.strip()}"
    return True, f"bundled TikOmni caller ok: {endpoint_id}"


def directory_sha256(root: Path) -> str:
    if not root.is_dir() or root.is_symlink():
        raise OSError(f"runtime tree root is missing or unsafe: {root}")
    digest = hashlib.sha256(b"echo-founder.runtime-tree.v1\0")
    for item in sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix()):
        relative = item.relative_to(root).as_posix()
        metadata = item.lstat()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        if stat.S_ISLNK(metadata.st_mode):
            digest.update(b"link\0")
            digest.update(os.readlink(item).encode("utf-8"))
        elif stat.S_ISDIR(metadata.st_mode):
            digest.update(b"dir\0")
        elif stat.S_ISREG(metadata.st_mode):
            digest.update(b"file\0")
            digest.update(str(stat.S_IMODE(metadata.st_mode) & 0o111).encode("ascii"))
            digest.update(b"\0")
            with item.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        else:
            raise OSError(f"runtime tree contains an unsupported entry: {item}")
        digest.update(b"\0")
    return digest.hexdigest()


def read_playwright_runtime_metadata(app_path: Path, architecture: str) -> tuple[dict[str, object] | None, str]:
    runtime_root = app_path / "Contents/Resources/aifios/runtime/playwright"
    manifest_path = runtime_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, f"bundled Playwright runtime manifest is missing or invalid: {exc}"
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != PLAYWRIGHT_RUNTIME_SCHEMA
        or manifest.get("tree_hash_schema") != RUNTIME_TREE_HASH_SCHEMA
    ):
        return None, "bundled Playwright runtime manifest schema is invalid"
    entries = manifest.get("architectures") if isinstance(manifest, dict) else {}
    if not isinstance(entries, dict):
        return None, "bundled Playwright runtime has no architecture entries"
    revision_value = manifest.get("headless_shell_revision")
    revision = str(revision_value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", revision):
        return None, "bundled Playwright runtime has an invalid Chromium revision"
    entry = entries.get(architecture)
    if not isinstance(entry, dict):
        return None, f"bundled Playwright runtime has no {architecture} entry"
    if str(entry.get("source_revision") or "") != revision:
        return None, f"bundled Playwright runtime revision does not match its {architecture} entry"
    expected_hash = str(entry.get("tree_sha256") or "").lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
        return None, f"bundled Playwright runtime has no valid {architecture} integrity hash"
    relative_executable = entry.get("executable")
    if not isinstance(relative_executable, str) or not relative_executable:
        return None, f"bundled Playwright runtime has no {architecture} executable"
    parts = tuple(relative_executable.split("/"))
    if (
        not parts
        or parts[0] != architecture
        or any(not item or item in {".", ".."} or "\\" in item for item in parts)
    ):
        return None, f"bundled Playwright executable path is unsafe for {architecture}"
    source_root = runtime_root / architecture
    executable = runtime_root.joinpath(*parts)
    try:
        executable.relative_to(source_root)
    except ValueError:
        return None, f"bundled Playwright executable escapes the {architecture} runtime"
    if not executable.is_file() or executable.is_symlink() or not os.access(executable, os.X_OK):
        return None, f"bundled Playwright executable is unavailable for {architecture}: {executable}"
    try:
        actual_hash = directory_sha256(source_root)
    except OSError as exc:
        return None, f"bundled Playwright runtime cannot be hashed for {architecture}: {exc}"
    if actual_hash != expected_hash:
        return None, f"bundled Playwright integrity check failed for {architecture}"
    return {
        "architecture": architecture,
        "revision": revision,
        "expected_hash": expected_hash,
        "source_root": source_root,
        "executable_parts": parts[1:],
        "source_executable": executable,
    }, ""


def verify_bundled_playwright_runtime(app_path: Path, expected_architecture: str = DEFAULT_EXPECTED_ARCHITECTURE) -> tuple[bool, str]:
    architectures = ("arm64", "x64") if expected_architecture == "universal" else (expected_architecture,)
    revision = ""
    for architecture in architectures:
        metadata, detail = read_playwright_runtime_metadata(app_path, architecture)
        if not metadata:
            return False, detail
        executable = Path(metadata["source_executable"])
        actual = macho_architectures(executable)
        if not executable.is_file() or lipo_architecture_name(architecture) not in actual:
            return False, f"bundled Playwright chromium is invalid for {architecture}: {executable} ({sorted(actual)})"
        revision = str(metadata["revision"])
    return True, f"bundled Playwright chromium ok: revision={revision}"


def verify_materialized_playwright_runtime(
    app_path: Path,
    user_data_dir: Path,
    architecture: str,
) -> tuple[bool, str, Path | None]:
    metadata, detail = read_playwright_runtime_metadata(app_path, architecture)
    if not metadata:
        return False, detail, None
    destination = user_data_dir / "runtime/playwright" / str(metadata["revision"]) / architecture
    executable = destination.joinpath(*(str(item) for item in metadata["executable_parts"]))
    if not executable.is_file() or executable.is_symlink() or not os.access(executable, os.X_OK):
        return False, f"app did not materialize a usable Playwright executable: {executable}", None
    try:
        if directory_sha256(destination) != str(metadata["expected_hash"]):
            return False, f"app materialized a Playwright runtime with the wrong integrity hash: {destination}", None
    except OSError as exc:
        return False, f"app materialized a Playwright runtime that cannot be hashed: {exc}", None
    return True, f"materialized Playwright chromium ok: revision={metadata['revision']} architecture={architecture}", executable


def run_packaged_visual_renderer(
    app_path: Path,
    browser: Path,
    architecture: str | None = None,
) -> tuple[bool, str]:
    """Render one local HTML card through Electron Node and an external browser path."""
    if not browser.is_file() or browser.is_symlink():
        return False, f"materialized Playwright chromium is missing for this host: {browser}"
    script = app_path / "Contents/Resources/aifios/skills/content-runtime/scripts/visual_screenshot.mjs"
    electron = app_binary(app_path)
    if not script.is_file() or not electron.is_file():
        return False, "packaged visual renderer script or Electron binary is missing"
    with tempfile.TemporaryDirectory(prefix="aifios-packaged-visual-") as tmp_dir:
        root = Path(tmp_dir)
        html = root / "card.html"
        spec = root / "spec.json"
        output = root / "card.png"
        metrics = root / "metrics.json"
        html.write_text(
            "<!doctype html><html><body style='margin:0'><section id='card' data-evidence='true' "
            "style='box-sizing:border-box;width:480px;height:640px;padding:48px;background:#fff;color:#111;font:32px sans-serif'>"
            "AIFIOS packaged visual smoke</section></body></html>",
            encoding="utf-8",
        )
        spec.write_text(
            json.dumps(
                {
                    "html": str(html),
                    "metrics": str(metrics),
                    "targets": [{"id": "card", "output": str(output)}],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        env = os.environ.copy()
        env.update(
            {
                "ELECTRON_RUN_AS_NODE": "1",
                "AIFIOS_DESKTOP": "1",
                # The packaged app under test already owns Electron's normal
                # single-instance lock. This short-lived Node renderer is an
                # internal verification helper, not a second UI instance, so
                # let it run alongside the app rather than being redirected to
                # the existing process on macOS.
                "AIFIOS_DESKTOP_ALLOW_MULTI_INSTANCE": "1",
                "AIFIOS_PLAYWRIGHT_CHROMIUM_PATH": str(browser),
                # This must stay empty: success proves the materialized runtime
                # works without falling back to the builder's browser cache.
                "PLAYWRIGHT_BROWSERS_PATH": str(root / "no-browser-cache"),
            }
        )
        try:
            result = subprocess.run(
                [*subprocess_architecture_prefix(architecture), str(electron), str(script), str(spec)],
                cwd=script.parent,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=90,
                check=False,
            )
        except Exception as exc:
            return False, f"packaged visual renderer could not start: {exc}"
        if result.returncode != 0:
            return False, f"packaged visual renderer failed: {result.stdout.strip()}"
        try:
            metrics_payload = json.loads(metrics.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            return False, f"packaged visual renderer did not write metrics: {exc}"
        if not output.is_file() or output.stat().st_size < 100 or not isinstance(metrics_payload.get("targets"), dict):
            return False, "packaged visual renderer did not produce a valid PNG and metrics"
    return True, "packaged visual renderer ok"


def fetch_diagnostics_package(port: int) -> tuple[bool, str]:
    url = f"http://{HOST}:{port}/api/desktop/diagnostics/package"
    try:
        with urllib.request.urlopen(url, timeout=5.0) as response:
            if response.status != 200:
                return False, f"unexpected status: {response.status}"
            disposition = response.headers.get("Content-Disposition", "")
            payload_bytes = response.read()
            payload_text = payload_bytes.decode("utf-8")
            payload = json.loads(payload_text)
    except Exception as exc:
        return False, f"request failed: {exc}"

    if "attachment; filename=" not in disposition:
        return False, f"missing downloadable Content-Disposition: {disposition!r}"
    if not isinstance(payload, dict):
        return False, "payload is not a JSON object"
    if payload.get("packageType") != "echo-founder-desktop-diagnostics-package":
        return False, f"unexpected packageType: {payload.get('packageType')}"
    if payload.get("schema") != "echo-founder.desktop-diagnostics.v1":
        return False, f"unexpected schema: {payload.get('schema')}"
    if not isinstance(payload.get("diagnostics"), dict):
        return False, "diagnostics package missing diagnostics object"
    if not isinstance(payload.get("logs"), dict):
        return False, "diagnostics package missing logs object"
    if not isinstance(payload.get("manifests"), dict):
        return False, "diagnostics package missing manifests object"
    for forbidden in ("/Users/", "/private/tmp/", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "apiKey"):
        if forbidden in payload_text:
            return False, f"diagnostics package leaked forbidden token: {forbidden}"
    return True, "diagnostics package ok"


def fetch_release_readiness(port: int) -> tuple[bool, str]:
    url = f"http://{HOST}:{port}/api/desktop/release-readiness"
    try:
        with urllib.request.urlopen(url, timeout=5.0) as response:
            if response.status != 200:
                return False, f"unexpected status: {response.status}"
            payload_text = response.read().decode("utf-8")
            payload = json.loads(payload_text)
    except Exception as exc:
        return False, f"request failed: {exc}"

    if not isinstance(payload, dict):
        return False, "payload is not a JSON object"
    if payload.get("status") not in {
        "external_ready",
        "internal_ready_external_blocked",
        "needs_attention",
        "missing_reports",
    }:
        return False, f"unexpected release readiness status: {payload.get('status')}"
    if not isinstance(payload.get("internalReady"), bool):
        return False, "release readiness missing boolean internalReady"
    if not isinstance(payload.get("externalReady"), bool):
        return False, "release readiness missing boolean externalReady"
    if not isinstance(payload.get("gates"), list):
        return False, "release readiness missing gates list"
    if not isinstance(payload.get("reports"), dict):
        return False, "release readiness missing reports object"
    if not isinstance(payload.get("recommendedActions"), list):
        return False, "release readiness missing recommendedActions list"
    for forbidden in ("/Users/", "/private/tmp/", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "apiKey"):
        if forbidden in payload_text:
            return False, f"release readiness leaked forbidden token: {forbidden}"
    return True, f"release readiness ok: {payload.get('status')}"


def has_runtime_dependency_fields(runtime: object) -> bool:
    if not isinstance(runtime, dict):
        return False
    return all(key in runtime for key in ("pythonBinary", "nodeBinary"))


def packaged_app_env(project_dir: Path, port: int, minimal_env: bool, user_data_dir: Path | None = None) -> dict[str, str]:
    if minimal_env:
        env = {
            key: value
            for key in ["HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"]
            if (value := os.environ.get(key))
        }
        env["PATH"] = "/usr/bin:/bin"
        env["AIFIOS_DESKTOP_MINIMAL_ENV"] = "1"
    else:
        env = os.environ.copy()
    env["AIFIOS_DESKTOP_PORT"] = str(port)
    env["AIFIOS_DESKTOP_SERVER_MODE"] = "production"
    env["AIFIOS_PROJECT"] = str(project_dir)
    env["ELECTRON_ENABLE_LOGGING"] = "1"
    if user_data_dir:
        env["AIFIOS_DESKTOP_USER_DATA_DIR"] = str(user_data_dir)
    return env


def wait_until_ready(port: int, timeout_seconds: int, expect_hosted_license: bool = False) -> tuple[bool, str]:
    status_url = f"http://{HOST}:{port}/api/status"
    diagnostics_url = f"http://{HOST}:{port}/api/desktop/diagnostics"
    deadline = time.time() + timeout_seconds
    last_error = "not attempted"
    while time.time() < deadline:
        if expect_hosted_license:
            config = fetch_json(f"http://{HOST}:{port}/api/config")
            hosted_status = fetch_json(f"http://{HOST}:{port}/api/config/hosted/status")
            hosted_config = config.get("config") if isinstance(config, dict) else None
            if (
                isinstance(hosted_config, dict)
                and hosted_config.get("provider") == "aifios-hosted"
                and hosted_config.get("connectionMode") == "hosted"
                and isinstance(hosted_status, dict)
                and hosted_status.get("connected") is False
            ):
                return True, "public hosted activation bootstrap"
            last_error = "hosted activation bootstrap is not ready"
            time.sleep(1)
            continue
        status = fetch_json(status_url)
        diagnostics = fetch_json(diagnostics_url)
        if status and diagnostics:
            runtime = diagnostics.get("runtime") if isinstance(diagnostics.get("runtime"), dict) else {}
            if (
                status.get("project")
                and runtime.get("isDesktop") is True
                and runtime.get("serverMode") == "production"
                and has_runtime_dependency_fields(runtime)
            ):
                return True, diagnostics_url
            last_error = f"diagnostics not ready or wrong mode: {runtime}"
        else:
            last_error = "status or diagnostics endpoint not ready"
        time.sleep(1)
    return False, last_error


def wait_for_desktop_runtime(
    port: int,
    user_data_dir: Path | None,
    timeout_seconds: int = 20,
) -> tuple[dict[str, object], str]:
    """Avoid a transient diagnostics read while the packaged route warms up."""
    deadline = time.time() + timeout_seconds
    last_runtime: dict[str, object] = {}
    while time.time() < deadline:
        diagnostics = fetch_json(f"http://{HOST}:{port}/api/desktop/diagnostics")
        runtime = diagnostics.get("runtime") if isinstance(diagnostics, dict) and isinstance(diagnostics.get("runtime"), dict) else {}
        if runtime:
            last_runtime = runtime
            if not user_data_dir or runtime.get("desktopUserDataDir") == user_data_dir.name:
                return runtime, ""
        time.sleep(0.5)
    return last_runtime, "diagnostics did not report the requested isolated userData directory"


def terminate_process(proc: subprocess.Popen[object]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=15)


def wait_for_port_closed(port: int, timeout_seconds: int = 20) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if not port_is_open(port):
            return True
        time.sleep(0.5)
    return not port_is_open(port)


def verify_app_code_signature(app_path: Path) -> tuple[bool, str]:
    codesign = shutil.which("codesign")
    if not codesign:
        return False, "codesign is unavailable"
    try:
        result = subprocess.run(
            [codesign, "--verify", "--deep", "--strict", str(app_path)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"codesign verification could not complete: {exc}"
    if result.returncode != 0:
        return False, result.stdout.strip() or f"codesign exited {result.returncode}"
    return True, "deep strict code signature valid"


def verify_app_tree_unchanged(app_path: Path, before_sha256: str) -> tuple[bool, str]:
    try:
        after_sha256 = directory_sha256(app_path)
    except OSError as exc:
        return False, f"could not fingerprint app after launch: {exc}"
    if after_sha256 != before_sha256:
        return False, f"app tree changed after launch: before={before_sha256} after={after_sha256}"
    return True, f"app tree unchanged: {after_sha256}"


def tail(path: Path, limit: int = 6000) -> str:
    if not path.exists():
        return ""
    return path.read_bytes()[-limit:].decode("utf-8", errors="replace")


def app_binary(app_path: Path) -> Path:
    plist_path = app_path / "Contents" / "Info.plist"
    binary_name = app_path.stem
    if plist_path.exists():
        try:
            import plistlib

            with plist_path.open("rb") as handle:
                binary_name = str(plistlib.load(handle).get("CFBundleExecutable") or binary_name)
        except Exception:
            pass
    return app_path / "Contents" / "MacOS" / binary_name


def run_smoke(
    app_path: Path,
    project_dir: Path,
    port: int,
    timeout_seconds: int,
    minimal_env: bool,
    require_python_source: str,
    user_data_dir: Path | None = None,
    expected_architecture: str = DEFAULT_EXPECTED_ARCHITECTURE,
    verify_visual_renderer: bool = True,
    launch_architecture: str = "",
    expect_hosted_license: bool = False,
    demo_unlock_code: str = "",
) -> int:
    binary = app_binary(app_path)
    if not binary.exists():
        print(f"FAIL packaged smoke: app binary not found: {binary}", file=sys.stderr)
        return 1
    hosted_detail = "not requested"
    if expect_hosted_license:
        hosted_ok, hosted_detail = verify_hosted_license_bundle(app_path)
        if not hosted_ok:
            print("FAIL packaged smoke: hosted license bundle check failed", file=sys.stderr)
            print(f"detail: {hosted_detail}", file=sys.stderr)
            return 1
    electron_ok, electron_detail = verify_bundled_electron_architecture(app_path, expected_architecture)
    if not electron_ok:
        print("FAIL packaged smoke: Electron architecture check failed", file=sys.stderr)
        print(f"detail: {electron_detail}", file=sys.stderr)
        return 1
    selected_architecture = launch_architecture or host_architecture()
    tikomni_ok, tikomni_detail = verify_bundled_tikomni_caller(app_path, launch_architecture or None)
    if not tikomni_ok:
        print("FAIL packaged smoke: standalone TikOmni caller check failed", file=sys.stderr)
        print(f"detail: {tikomni_detail}", file=sys.stderr)
        return 1
    playwright_ok, playwright_detail = verify_bundled_playwright_runtime(app_path, expected_architecture)
    if not playwright_ok:
        print("FAIL packaged smoke: bundled Playwright runtime check failed", file=sys.stderr)
        print(f"detail: {playwright_detail}", file=sys.stderr)
        return 1
    project_dir.mkdir(parents=True, exist_ok=True)
    if user_data_dir:
        if user_data_dir.exists():
            shutil.rmtree(user_data_dir)
        user_data_dir.mkdir(parents=True, exist_ok=True)
    log_path = Path("/tmp") / f"aifios-packaged-smoke-{port}.log"
    env = packaged_app_env(project_dir, port, minimal_env, user_data_dir)
    with log_path.open("w", encoding="utf-8") as log_file:
        proc = subprocess.Popen(
            [*subprocess_architecture_prefix(launch_architecture or None), str(binary)],
            cwd=binary.parent,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
            preexec_fn=None if os.name == "nt" else os.setsid,
        )
        try:
            demo_unlock_detail = "not requested"
            if demo_unlock_code:
                demo_ok, demo_unlock_detail = verify_demo_unlock_gate(port, demo_unlock_code)
                if not demo_ok:
                    print("FAIL packaged smoke: product password gate check failed", file=sys.stderr)
                    print(f"detail: {demo_unlock_detail}", file=sys.stderr)
                    print(f"log: {log_path}", file=sys.stderr)
                    print(tail(log_path), file=sys.stderr)
                    return 1
            ready, detail = wait_until_ready(port, timeout_seconds, expect_hosted_license)
            if not ready:
                print("FAIL packaged smoke: app did not serve Echo Founder UI", file=sys.stderr)
                print(f"detail: {detail}", file=sys.stderr)
                print(f"log: {log_path}", file=sys.stderr)
                print(tail(log_path), file=sys.stderr)
                return 1
            runtime: dict[str, object] = {}
            runtime_detail = "protected until activation"
            if not expect_hosted_license:
                runtime, runtime_error = wait_for_desktop_runtime(port, user_data_dir)
                if user_data_dir and runtime.get("desktopUserDataDir") != user_data_dir.name:
                    print("FAIL packaged smoke: desktop runtime did not use isolated userData", file=sys.stderr)
                    print(f"expected_basename={user_data_dir.name} runtime={runtime} detail={runtime_error}", file=sys.stderr)
                    return 1
                if runtime.get("singleInstance") != "1":
                    print("FAIL packaged smoke: desktop single-instance protection is not enabled", file=sys.stderr)
                    print(f"runtime={runtime}", file=sys.stderr)
                    return 1
                if require_python_source and runtime.get("pythonSource") != require_python_source:
                    print("FAIL packaged smoke: desktop runtime selected an unexpected Python source", file=sys.stderr)
                    print(f"expected={require_python_source} actual={runtime.get('pythonSource')} runtime={runtime}", file=sys.stderr)
                    return 1
                runtime_detail = f"python={runtime.get('pythonSource')} singleInstance={runtime.get('singleInstance')}"
            if not user_data_dir:
                print("FAIL packaged smoke: an isolated desktop userData directory is required", file=sys.stderr)
                return 1
            identity_detail = "not requested"
            if expect_hosted_license:
                identity_ok, identity_detail = verify_encrypted_device_identity(user_data_dir)
                if not identity_ok:
                    print("FAIL packaged smoke: hosted device identity check failed", file=sys.stderr)
                    print(f"detail: {identity_detail}", file=sys.stderr)
                    return 1
            materialized_ok, materialized_detail, materialized_browser = verify_materialized_playwright_runtime(
                app_path,
                user_data_dir,
                selected_architecture,
            )
            if not materialized_ok or not materialized_browser:
                print("FAIL packaged smoke: app did not materialize the bundled Playwright runtime", file=sys.stderr)
                print(f"detail: {materialized_detail}", file=sys.stderr)
                return 1
            try:
                materialized_browser.resolve().relative_to((app_path / "Contents/Resources").resolve())
                print("FAIL packaged smoke: app used a Playwright executable inside the .app bundle", file=sys.stderr)
                print(f"path={materialized_browser}", file=sys.stderr)
                return 1
            except ValueError:
                pass
            visual_detail = "skipped"
            if verify_visual_renderer:
                visual_ok, visual_detail = run_packaged_visual_renderer(
                    app_path,
                    materialized_browser,
                    launch_architecture or None,
                )
                if not visual_ok:
                    print("FAIL packaged smoke: materialized visual renderer check failed", file=sys.stderr)
                    print(f"detail: {visual_detail}", file=sys.stderr)
                    return 1
            if expect_hosted_license:
                hosted_ok, hosted_detail = verify_hosted_license_gate(port)
                if not hosted_ok:
                    print("FAIL packaged smoke: hosted license gate check failed", file=sys.stderr)
                    print(f"detail: {hosted_detail}", file=sys.stderr)
                    return 1
                routes_detail = "protected until activation; redirect/API-denial behavior verified"
                package_detail = "protected until activation"
                readiness_detail = "protected until activation"
            else:
                routes_ok, routes_detail = verify_required_production_routes(port)
                if not routes_ok:
                    print("FAIL packaged smoke: packaged production routes are incomplete", file=sys.stderr)
                    print(f"detail: {routes_detail}", file=sys.stderr)
                    return 1
                package_ok, package_detail = fetch_diagnostics_package(port)
                if not package_ok:
                    print("FAIL packaged smoke: diagnostics package endpoint failed", file=sys.stderr)
                    print(f"detail: {package_detail}", file=sys.stderr)
                    return 1
                readiness_ok, readiness_detail = fetch_release_readiness(port)
                if not readiness_ok:
                    print("FAIL packaged smoke: release readiness endpoint failed", file=sys.stderr)
                    print(f"detail: {readiness_detail}", file=sys.stderr)
                    return 1
            print(f"runtime_check={runtime_detail}")
            print(f"runtime_architecture={selected_architecture}")
            print(f"electron_architecture={electron_detail}")
            print(f"tikomni_caller={tikomni_detail}")
            print(f"playwright_runtime={playwright_detail}")
            print(f"materialized_playwright={materialized_detail}")
            if verify_visual_renderer:
                print(f"visual_renderer={visual_detail}")
            print(f"production_routes={routes_detail}")
            print(f"diagnostics_package={package_detail}")
            print(f"release_readiness={readiness_detail}")
            if expect_hosted_license:
                print(f"hosted_license={hosted_detail}")
                print(f"device_identity={identity_detail}")
            if demo_unlock_code:
                print(f"product_password={demo_unlock_detail}")
            print(f"minimal_env={minimal_env}")
            return 0
        finally:
            terminate_process(proc)


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test a packaged Echo Founder macOS .app bundle")
    parser.add_argument("--app-path", default="dist/desktop/Echo Founder.app")
    parser.add_argument("--project-dir", default="/private/tmp/aifios-packaged-smoke")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--minimal-env", action="store_true", help="launch the app with a Finder-like minimal PATH")
    parser.add_argument("--require-python-source", default="", help="fail unless diagnostics runtime.pythonSource matches this value")
    parser.add_argument("--user-data-dir", default="", help="launch with an isolated Electron userData directory")
    parser.add_argument("--expected-architecture", choices=["universal", "arm64", "x64"], default=DEFAULT_EXPECTED_ARCHITECTURE)
    parser.add_argument("--skip-visual-renderer", action="store_true", help="skip the self-contained visual rendering smoke")
    parser.add_argument("--launch-architecture", choices=["arm64", "x64"], default="", help="force a Universal App slice through macOS arch")
    parser.add_argument("--expect-hosted-license", action="store_true", help="verify an unactivated device-bound hosted package cannot fall back to local API configuration")
    parser.add_argument(
        "--demo-unlock-code",
        default=os.environ.get("AIFIOS_DEMO_UNLOCK_CODE", ""),
        help="verify and unlock a local product-password build; may also use AIFIOS_DEMO_UNLOCK_CODE",
    )
    args = parser.parse_args()

    app_path = Path(args.app_path).expanduser().resolve()
    try:
        app_tree_before = directory_sha256(app_path)
    except OSError as exc:
        print(f"FAIL packaged smoke: could not fingerprint app before launch: {exc}", file=sys.stderr)
        return 1
    signature_ok, signature_detail = verify_app_code_signature(app_path)
    if not signature_ok:
        print(f"FAIL packaged smoke: app signature is invalid before launch: {signature_detail}", file=sys.stderr)
        return 1
    port = args.port or find_free_port()
    if port_is_open(port):
        print(f"FAIL packaged smoke: port is already in use: {port}", file=sys.stderr)
        return 1
    code = run_smoke(
        app_path,
        Path(args.project_dir).expanduser(),
        port,
        args.timeout,
        args.minimal_env,
        args.require_python_source,
        Path(args.user_data_dir).expanduser().resolve() if args.user_data_dir else Path(f"/private/tmp/aifios-packaged-user-data-{port}"),
        args.expected_architecture,
        not args.skip_visual_renderer,
        args.launch_architecture,
        args.expect_hosted_license,
        args.demo_unlock_code,
    )
    if code == 0 and not wait_for_port_closed(port):
        print(f"FAIL packaged smoke: port did not close after app stopped: {port}", file=sys.stderr)
        code = 1
    tree_ok, tree_detail = verify_app_tree_unchanged(app_path, app_tree_before)
    signature_ok, post_signature_detail = verify_app_code_signature(app_path)
    if not tree_ok:
        print(f"FAIL packaged smoke: {tree_detail}", file=sys.stderr)
        return 1
    if not signature_ok:
        print(f"FAIL packaged smoke: app signature is invalid after launch: {post_signature_detail}", file=sys.stderr)
        return 1
    if code != 0:
        return code
    print("PASS packaged desktop smoke")
    print(f"app_integrity={tree_detail}; {signature_detail}; {post_signature_detail}")
    print(f"app_path={app_path}")
    print(f"url=http://{HOST}:{port}")
    print(f"project={Path(args.project_dir).expanduser()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
