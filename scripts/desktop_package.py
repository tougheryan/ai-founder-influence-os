#!/usr/bin/env python3
"""Build an unsigned macOS desktop app bundle for Echo Founder.

The package is intentionally local and conservative: it bundles the customer
runtime allowlist, active skills, embedded dependencies, and a prebuilt Next
production bundle.
Formal notarized installers remain a later productization step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import plistlib
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
UI_DIR = REPO_ROOT / "ui"
DESKTOP_DIST_DIR = ".next-desktop"
NEXT_BUILD_MANIFEST = ".aifios-desktop-build.json"
NEXT_STANDALONE_DIR = "standalone"
SYSTEM_DYLIB_PREFIXES = ("/System/Library/", "/usr/lib/")
BUNDLED_DYLIB_PREFIXES = ("@rpath/", "@loader_path/", "@executable_path/")
# Keep default desktop bundles reproducible. Callers can still explicitly pass
# a different version, but a minor-only selector would silently change the
# embedded interpreter and archive digest on a later build.
DEFAULT_PYTHON_VERSION = "3.11.15"
DEFAULT_DESKTOP_ARCH = "arm64"
DEFAULT_APP_NAME = "Echo Founder"
DEFAULT_BUNDLE_ID = "com.echofounder.desktop"
DEFAULT_PRODUCT_VERSION = "0.2.0-beta.2"
MINIMUM_MACOS_VERSION = "13.0"
APPLE_PRODUCT_VERSION_RE = re.compile(
    r"(?P<major>0|[1-9]\d*)\."
    r"(?P<minor>0|[1-9]\d*)\."
    r"(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<phase>alpha|beta|rc)\.(?P<sequence>[1-9]\d{0,2}))?"
)
APPLE_PRERELEASE_BUILD_BASE = {
    "alpha": 1000,
    "beta": 3000,
    "rc": 6000,
}
APPLE_RELEASE_BUILD_VERSION = 9000
BRAND_ICON_SOURCE = UI_DIR / "app" / "icon.svg"
BRAND_ICON_FILENAME = "EchoFounder.icns"
BRAND_ICONSET_SIZES = (
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
)
MACOS_UNIVERSAL_ARCHITECTURES = {"arm64", "x86_64"}
NODE_RUNTIME_ARCHITECTURES = ("arm64", "x64")
def desktop_download_cache_root() -> Path:
    """Return the writable cache root used while assembling a desktop bundle.

    macOS builds normally use the user's Library cache. CI, sandboxed runners,
    and release builders can set ``AIFIOS_DESKTOP_CACHE_DIR`` to an isolated
    writable location without changing the final app contents.
    """
    configured = os.getenv("AIFIOS_DESKTOP_CACHE_DIR", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / "Library" / "Caches" / "AIFIOS"


DESKTOP_DOWNLOAD_CACHE = desktop_download_cache_root()
ELECTRON_DOWNLOAD_CACHE = DESKTOP_DOWNLOAD_CACHE / "electron"
PYTHON_DOWNLOAD_CACHE = DESKTOP_DOWNLOAD_CACHE / "python"
TIKOMNI_SKILL_NAME = "social-media-crawl"
MATERIAL_OCR_BINARY_RELATIVE = Path("skills/content-runtime/bin/aifios-material-ocr")
PLAYWRIGHT_RUNTIME_SCHEMA = "aifios.playwright-runtime.v1"
RUNTIME_TREE_HASH_SCHEMA = "echo-founder.runtime-tree.v1"
SHIPPED_DEPENDENCY_INVENTORY_SCHEMA = "echo-founder.shipped-dependency-inventory.v2"
RUNTIME_SUPPLY_CHAIN_SCHEMA = "echo-founder.runtime-supply-chain.v2"
SHIPPED_NOTICE_DIR = Path("third-party-notices")
SHIPPED_DEPENDENCY_INVENTORY_RELATIVE_PATH = SHIPPED_NOTICE_DIR / "shipped-dependencies.json"
RUNTIME_SUPPLY_CHAIN_RELATIVE_PATH = SHIPPED_NOTICE_DIR / "runtime-supply-chain.json"
TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH = Path("quality/acceptance/trusted-qa-public-keys.json")
TRUSTED_QA_KEY_REGISTRY_SCHEMA = "echo-founder.trusted-qa-public-keys.v1"
ELECTRON_LICENSE_NOTICE = SHIPPED_NOTICE_DIR / "Electron-LICENSE.txt"
CHROMIUM_LICENSE_NOTICE = SHIPPED_NOTICE_DIR / "Chromium-LICENSES.html"
NEXT_STANDALONE_NOTICE = SHIPPED_NOTICE_DIR / "Next-standalone-NOTICES.txt"
TIKOMNI_CONNECTOR_NOTICE = SHIPPED_NOTICE_DIR / "TikOmni-Connector-NOTICE.txt"
ELECTRON_ARCHIVE_LICENSE_RESOURCE = "Electron-distribution-LICENSE.txt"
CHROMIUM_ARCHIVE_LICENSE_RESOURCE = "Electron-distribution-LICENSES.chromium.html"
TIKOMNI_CALLER_RELATIVE_PATH = Path("scripts/core/call_tikomni_api.py")
TIKOMNI_RESOLVER_RELATIVE_PATH = Path("scripts/core/resolve_api_endpoint.py")
TIKOMNI_CATALOG_RELATIVE_PATHS = (
    Path("references/api-catalog/aliases.json"),
    Path("references/api-catalog/operations.json"),
)
TIKOMNI_BUNDLE_FILES = (
    Path("SKILL.md"),
    Path("scripts/__init__.py"),
    Path("scripts/core/__init__.py"),
    Path("scripts/core/api_catalog.py"),
    Path("scripts/core/tikomni_common.py"),
    TIKOMNI_CALLER_RELATIVE_PATH,
    TIKOMNI_RESOLVER_RELATIVE_PATH,
    *TIKOMNI_CATALOG_RELATIVE_PATHS,
)
TIKOMNI_APPROVED_SNAPSHOT_ID = "echo-founder-tikomni-connector-2026-08-24"
TIKOMNI_APPROVED_FILE_SHA256 = {
    "SKILL.md": "184403835a89b42d136f528c07eb5c2c1339691321d937696c21bbe8b17d1da9",
    "scripts/__init__.py": "62fcb9573db65633d9693ed7af95326f2206cc8f16f3249d502f16c78a32ad18",
    "scripts/core/__init__.py": "4bccddcfca502f459b1c6183aad6b53c51cba0b81433589593ca2052e73578cd",
    "scripts/core/api_catalog.py": "711d689ef49fed9d74305b5bb6bae4b170fdb83ad13f40fec408bcb57e78dc0e",
    "scripts/core/tikomni_common.py": "89e690b20d32d11b5fb76812f89044cecf1b3972495095ef6c8b46d4d6578316",
    "scripts/core/call_tikomni_api.py": "ba361cc5f2bacc993962fff23ebe5fdddb26504a40f15dde12688cc013f09992",
    "scripts/core/resolve_api_endpoint.py": "ef6ea975f8dfb21dd72c3d5ad942df6d924804a76549eda84b88e1944ecf3247",
    "references/api-catalog/aliases.json": "adf6b604594967dc37ef4ef4b6b6ca464a9c6115608a5d49fe7777ca684c781c",
    "references/api-catalog/operations.json": "c983f19bf29f5ddfb0054ddd0096d6ad0aedd20f92a2b3e38d23188498876160",
}
TIKOMNI_APPROVED_SNAPSHOT_SHA256 = "ede66e4298e5ac2b5384eeac297ac6c30001f4b11390e7dcb0ec2873bbd06320"
APPROVED_ELECTRON_RELEASES = {
    "43.0.0": {
        "arm64": "e6994f68dba65a6371577eaf68ac69a5858d2c52371869837c64affc6157eca5",
        "x64": "c0102711ff41d8329426e2ca7378fa13a467775e721b69ebe413c0898da14f6e",
    }
}
APPROVED_PYTHON_RELEASES = {
    "3.11.15": {
        "arm64": {
            "url": "https://releases.astral.sh/github/python-build-standalone/releases/download/20260510/cpython-3.11.15%2B20260510-aarch64-apple-darwin-install_only_stripped.tar.gz",
            "sha256": "fdfc363b538662eb7441a14e06f72c4a992c56af7f401f5730ea5081f8f8ad6e",
        },
        "x64": {
            "url": "https://releases.astral.sh/github/python-build-standalone/releases/download/20260510/cpython-3.11.15%2B20260510-x86_64-apple-darwin-install_only_stripped.tar.gz",
            "sha256": "5f1eb247cbca2c0ad5ccbf6d299a4f54b31b5c63b492d74c3531dc4344a42f88",
        },
    }
}
APPROVED_PLAYWRIGHT_RELEASES: dict[tuple[str, str, str], dict[str, dict[str, str]]] = {
    ("1.60.0", "1223", "148.0.7778.96"): {
        "arm64": {
            "url": "https://cdn.playwright.dev/builds/cft/148.0.7778.96/mac-arm64/chrome-headless-shell-mac-arm64.zip",
            "sha256": "d9014195871a583b0978001a23000aa2cff22e3bb951a92919b7c7775cd14e01",
        },
        "x64": {
            "url": "https://cdn.playwright.dev/builds/cft/148.0.7778.96/mac-x64/chrome-headless-shell-mac-x64.zip",
            "sha256": "1dabfd7b4ecc5759d3fe90dd3e782ae41659f5dc7c756cf403db104e93c918f0",
        },
    }
}
# Updating either production dependency closure requires an explicit review of
# this approved lock digest.  Formal packaging must not silently accept a
# locally replaced lockfile merely because ``npm ci`` can install it.
# Reviewed public-source closure: Next 16.4.6, fast-uri 3.1.9, Zod 4.6.7.
APPROVED_UI_PACKAGE_LOCK_SHA256 = "5095fae1a7f10549cf4443593f6e8583a3a8b3ef86117931a2c413aa130da8eb"
APPROVED_XHS_CARD_PACKAGE_LOCK_SHA256 = "ccb37c106235754dab30f825511bc411c3cfe658734ba107166cb2975a14e1b7"

# These are customer-facing routes. A successful `/api/status` response alone
# is not proof that a packaged build contains the production workbench.
REQUIRED_NEXT_ROUTE_ARTIFACTS = (
    Path("server/app/production/page.js"),
    Path("server/app/publication-desk/page.js"),
    Path("server/app/weekly-review/page.js"),
    Path("server/app/api/production/advance/route.js"),
    Path("server/app/api/publish/drafts/route.js"),
)
REQUIRED_NEXT_ROUTE_SOURCES = (
    # The paid desktop authorization gate runs through Next's Node-runtime
    # proxy. Treat it as a required package source alongside product routes.
    Path("proxy.ts"),
    Path("app/production/page.tsx"),
    Path("app/publication-desk/page.tsx"),
    Path("app/weekly-review/page.tsx"),
    Path("app/api/production/advance/route.ts"),
    Path("app/api/publish/drafts/route.ts"),
)
UI_SOURCE_IGNORED_DIRS = {
    ".git",
    ".next",
    DESKTOP_DIST_DIR,
    "node_modules",
    ".playwright-cli",
    "coverage",
    "test-results",
}
# Next updates these generated TypeScript artifacts during every production
# build. They are not authored UI input and must not invalidate a bundle that
# was otherwise built from an unchanged source tree.
UI_SOURCE_IGNORED_FILES = {
    "next-env.d.ts",
    "tsconfig.tsbuildinfo",
}

RUNTIME_SCRIPT_FILES = ("aifios.py", "release_gate.py")
RUNTIME_ROOT_FILES = ("VERSION", "LICENSE", "OPEN_SOURCE.md")
CUSTOMER_DOCUMENTS = (
    "echo-founder-installation.md",
    "echo-founder-api-platform-setup.md",
    "echo-founder-backup-upgrade.md",
    "third-party-notices.md",
)
FORBIDDEN_CUSTOMER_IDENTITY_MARKERS = ("常欢", "changhuan", "作者：常欢")
FORBIDDEN_CUSTOMER_BUNDLE_PATHS = (
    "AGENTS.md",
    "Makefile",
    "README.md",
    "QUICKSTART-10MIN.md",
    "RELEASE.md",
    "docs/" + "super" + "powers",
    "scripts/tests",
)
FORBIDDEN_CUSTOMER_FILE_NAMES = {
    "HANDOFF.md",
    "PRODUCT.md",
}
FORBIDDEN_PROJECT_DATA_DIR_NAMES = {
    ".aifios-demo",
    "backups",
    "project-backups",
    "projects",
    "user-data",
}


def run(command: list[str], cwd: Path = REPO_ROOT, env: dict[str, str] | None = None, timeout: int | None = None) -> None:
    print(f"RUN {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, env=env, timeout=timeout, check=True)


def run_capture(command: list[str], timeout: int = 15, env: dict[str, str] | None = None) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
    except Exception as exc:
        return False, str(exc)
    return result.returncode == 0, result.stdout.strip()


NPM_CI_TRANSIENT_ERROR_CODES = frozenset(
    {
        "ECONNRESET",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENETUNREACH",
        "ECONNREFUSED",
        "EHOSTUNREACH",
        "ENOTFOUND",
        "E502",
        "E503",
        "E504",
    }
)
NPM_ERROR_CODE_RE = re.compile(r"(?im)^npm (?:error|ERR!) code ([A-Z0-9_]+)\s*$")
NPM_CI_MAX_ATTEMPTS = 3


def run_npm_ci_with_network_retry(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: int,
    max_attempts: int = NPM_CI_MAX_ATTEMPTS,
) -> None:
    """Retry only an isolated lockfile install that failed for an allowlisted network reason."""
    if len(command) < 2 or Path(command[0]).name not in {"npm", "npm.cmd"} or command[1] != "ci":
        raise ValueError("bounded npm retry accepts only an explicit npm ci command")
    if "--ignore-scripts" not in command:
        raise ValueError("bounded npm retry requires npm lifecycle scripts to remain disabled")
    if max_attempts < 1 or max_attempts > NPM_CI_MAX_ATTEMPTS:
        raise ValueError(f"npm ci retry attempts must be between 1 and {NPM_CI_MAX_ATTEMPTS}")

    for attempt in range(1, max_attempts + 1):
        print(f"RUN {' '.join(command)} (attempt {attempt}/{max_attempts})", flush=True)
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        output = result.stdout or ""
        if output:
            print(output, end="" if output.endswith("\n") else "\n", flush=True)
        if result.returncode == 0:
            return
        error_codes = NPM_ERROR_CODE_RE.findall(output)
        transient_network_failure = bool(
            error_codes and error_codes[-1].upper() in NPM_CI_TRANSIENT_ERROR_CODES
        )
        if not transient_network_failure or attempt == max_attempts:
            raise subprocess.CalledProcessError(result.returncode, command, output=output)
        delay_seconds = 2 ** attempt
        print(
            f"RETRY npm ci after allowlisted transient network failure in {delay_seconds}s",
            flush=True,
        )
        time.sleep(delay_seconds)


def ensure_prerequisites() -> None:
    if sys.platform != "darwin":
        raise SystemExit("desktop_package.py currently builds macOS .app bundles only.")
    missing = [
        str(path)
        for path in [
            UI_DIR / "package.json",
            UI_DIR / "package-lock.json",
            BRAND_ICON_SOURCE,
            REPO_ROOT / "scripts" / "aifios.py",
            REPO_ROOT / MATERIAL_OCR_BINARY_RELATIVE,
        ]
        if not path.exists()
    ]
    if missing:
        raise SystemExit("Missing desktop package prerequisite(s):\n" + "\n".join(missing))
    missing_tools = [name for name in ("npm", "sips", "iconutil", "ditto") if not shutil.which(name)]
    if missing_tools:
        raise SystemExit("Missing macOS icon build tool(s): " + ", ".join(missing_tools))
    material_ocr = REPO_ROOT / MATERIAL_OCR_BINARY_RELATIVE
    if not material_ocr.is_file() or not os.access(material_ocr, os.X_OK):
        raise SystemExit(f"Bundled macOS PDF OCR helper is not executable: {material_ocr}")


def macho_architectures(path: Path) -> set[str]:
    if not shutil.which("lipo") or not path.is_file():
        return set()
    try:
        inspected = path.resolve(strict=True) if path.is_symlink() else path
    except OSError:
        return set()
    result = subprocess.run(
        ["lipo", "-archs", str(inspected)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return set()
    return {item.strip() for item in result.stdout.split() if item.strip()}


def host_macos_architecture() -> str:
    value = platform.machine().strip().lower()
    if value in {"arm64", "aarch64"}:
        return "arm64"
    if value in {"x86_64", "amd64"}:
        return "x64"
    raise RuntimeError(f"Unsupported macOS build host architecture: {value or 'unknown'}")


def lipo_architecture_name(architecture: str) -> str:
    return "x86_64" if architecture == "x64" else "arm64"


def electron_version() -> str:
    try:
        lock = json.loads((UI_DIR / "package-lock.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Unable to read the lock-bound Electron version.") from exc
    packages = lock.get("packages") if isinstance(lock, dict) else None
    electron = packages.get("node_modules/electron") if isinstance(packages, dict) else None
    version = str(electron.get("version") or "").strip() if isinstance(electron, dict) else ""
    if not version or version not in APPROVED_ELECTRON_RELEASES:
        raise RuntimeError(f"UI package-lock Electron version is not in the approved release map: {version or 'missing'}")
    return version


def electron_checksum(filename: str) -> str:
    match = re.fullmatch(r"electron-v([0-9.]+)-darwin-(arm64|x64)\.zip", filename)
    checksum = (
        str(APPROVED_ELECTRON_RELEASES.get(match.group(1), {}).get(match.group(2)) or "")
        if match
        else ""
    )
    if not re.fullmatch(r"[0-9a-f]{64}", checksum):
        raise RuntimeError(f"Electron checksum is unavailable for {filename}.")
    return checksum


def safe_extract_electron_zip(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as payload:
        normalized: dict[str, zipfile.ZipInfo] = {}
        symlink_paths: set[str] = set()
        for member in payload.infolist():
            name = posixpath.normpath(member.filename.replace("\\", "/"))
            if name in {"", "."} or name.startswith("/") or name == ".." or name.startswith("../"):
                raise RuntimeError(f"Refusing unsafe ZIP archive entry: {member.filename}")
            if name in normalized:
                raise RuntimeError(f"Refusing duplicate ZIP archive entry: {member.filename}")
            normalized[name] = member
            mode = (member.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                symlink_paths.add(name)
        for name, member in normalized.items():
            prefix = ""
            for part in name.split("/")[:-1]:
                prefix = f"{prefix}/{part}" if prefix else part
                if prefix in symlink_paths:
                    raise RuntimeError(f"Refusing ZIP archive entry below a symlink: {member.filename}")
            if name in symlink_paths:
                try:
                    raw_target = payload.read(member).decode("utf-8")
                except (UnicodeDecodeError, OSError) as exc:
                    raise RuntimeError(f"Refusing unreadable ZIP archive symlink: {member.filename}") from exc
                link_name = posixpath.normpath(posixpath.join(posixpath.dirname(name), raw_target))
                if link_name == ".." or link_name.startswith("../") or link_name.startswith("/"):
                    raise RuntimeError(f"Refusing unsafe ZIP archive symlink: {member.filename}")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    if not shutil.which("ditto"):
        raise RuntimeError("macOS ditto is required to extract the Electron runtime.")
    run(["ditto", "-x", "-k", str(archive), str(destination)], timeout=300)


def resolve_electron_archive(
    architecture: str,
    explicit_archive: str | None = None,
    explicit_sha256: str | None = None,
) -> tuple[Path, dict[str, str]]:
    version = electron_version()
    archive_name = f"electron-v{version}-darwin-{architecture}.zip"
    approved_checksum = electron_checksum(archive_name)
    url = f"https://github.com/electron/electron/releases/download/v{version}/{archive_name}"
    if explicit_archive:
        archive = Path(explicit_archive).expanduser().resolve(strict=True)
        if not archive.is_file() or archive.is_symlink():
            raise RuntimeError("Explicit Electron input must be a regular release archive, not an extracted directory.")
        expected = str(explicit_sha256 or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise RuntimeError("Explicit Electron archive requires a fixed --electron-*-sha256 value.")
        if expected != approved_checksum:
            raise RuntimeError("Explicit Electron archive digest is not the approved checksum for the lock-bound release.")
        actual = sha256_file(archive)
        if actual != expected:
            raise RuntimeError(f"Explicit Electron archive checksum mismatch: expected {expected}, got {actual}")
        return archive, {
            "version": version,
            "architecture": architecture,
            "source_url": url,
            "archive_sha256": actual,
            "archive_source": "explicit-verified-archive",
            "rebuild_mode": "isolated-extract-every-build",
        }
    if explicit_sha256:
        raise RuntimeError("--electron-*-sha256 is valid only with an explicit Electron archive.")

    cache_dir = ELECTRON_DOWNLOAD_CACHE / version / architecture
    archive = cache_dir / archive_name
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_hit = archive.is_file() and not archive.is_symlink() and sha256_file(archive) == approved_checksum
    if not cache_hit:
        temporary = archive.with_name(f".{archive.name}.{os.getpid()}.tmp")
        print(f"Downloading Electron {architecture} runtime: {url}", flush=True)
        try:
            curl = shutil.which("curl")
            if curl:
                # GitHub release downloads occasionally stall when streamed
                # through urllib on macOS. curl gives the desktop build the
                # same retryable transfer behavior as Python runtime downloads.
                run(
                    [
                        curl,
                        "--fail",
                        "--location",
                        "--retry",
                        "3",
                        "--connect-timeout",
                        "30",
                        "--output",
                        str(temporary),
                        url,
                    ],
                    timeout=300,
                )
            else:
                with urllib.request.urlopen(url, timeout=180) as response, temporary.open("wb") as output:
                    shutil.copyfileobj(response, output)
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"Failed to download Electron {architecture} runtime: {exc}") from exc
        actual_checksum = sha256_file(temporary)
        if actual_checksum != approved_checksum:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(
                f"Electron {architecture} checksum mismatch: expected {approved_checksum}, got {actual_checksum}"
            )
        os.replace(temporary, archive)
    return archive, {
        "version": version,
        "architecture": architecture,
        "source_url": url,
        "archive_sha256": approved_checksum,
        "archive_source": "approved-verified-cache" if cache_hit else "approved-download",
        "rebuild_mode": "isolated-extract-every-build",
    }


def regular_files(root: Path) -> dict[Path, Path]:
    result: dict[Path, Path] = {}
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        result[path.relative_to(root)] = path
    return result


def verify_electron_runtime_architecture(app_path: Path, architectures: set[str]) -> dict[str, Any]:
    missing_arches: dict[str, list[str]] = {}
    macho_count = 0
    # App resources deliberately contain architecture-specific Python and Node
    # add-ons. Electron itself must be universal, but those runtime payloads
    # are selected by the active Electron slice and must not make this check
    # reject an otherwise valid shell.
    for root in [app_path / "Contents" / "MacOS", app_path / "Contents" / "Frameworks"]:
        if not root.exists():
            continue
        for relative, path in regular_files(root).items():
            actual = macho_architectures(path)
            if not actual:
                continue
            macho_count += 1
            missing = architectures - actual
            if missing:
                key = (root.relative_to(app_path) / relative).as_posix()
                missing_arches[key] = sorted(missing)
    if not macho_count:
        raise RuntimeError(f"Electron app contains no inspectable Mach-O binaries: {app_path}")
    if missing_arches:
        raise RuntimeError(
            "Electron app architecture verification failed:\n"
            + json.dumps(missing_arches, ensure_ascii=False, indent=2)
        )
    resources = app_path / "Contents" / "Frameworks" / "Electron Framework.framework" / "Versions" / "A" / "Resources"
    snapshot_names = {
        "arm64": "v8_context_snapshot.arm64.bin",
        "x86_64": "v8_context_snapshot.x86_64.bin",
    }
    missing_snapshots = [snapshot_names[architecture] for architecture in architectures if not (resources / snapshot_names[architecture]).is_file()]
    if missing_snapshots:
        raise RuntimeError(
            "Electron runtime is missing V8 startup snapshot resource(s): "
            + ", ".join(sorted(missing_snapshots))
        )
    return {
        "architectures": sorted(architectures),
        "macho_files_checked": macho_count,
        "v8_snapshots": sorted(snapshot_names[architecture] for architecture in architectures),
    }


def merge_universal_electron_runtime(arm64_app: Path, x64_app: Path, target_app: Path) -> dict[str, Any]:
    if target_app.exists():
        shutil.rmtree(target_app)
    shutil.copytree(arm64_app, target_app, symlinks=True)
    arm_files = regular_files(arm64_app)
    x64_files = regular_files(x64_app)
    merged = 0
    x64_only_macho = [
        relative.as_posix()
        for relative, x64_file in x64_files.items()
        if relative not in arm_files and macho_architectures(x64_file)
    ]
    if x64_only_macho:
        raise RuntimeError(
            "x64 Electron runtime has Mach-O files missing from arm64 runtime:\n"
            + "\n".join(sorted(x64_only_macho))
        )
    # Electron keeps an architecture-specific V8 startup snapshot beside its
    # framework binary. Lipo only merges Mach-O files, so copy non-Mach-O
    # assets which exist solely in the x64 distribution into the universal app.
    x64_only_assets = [
        (relative, x64_file)
        for relative, x64_file in x64_files.items()
        if relative not in arm_files and not macho_architectures(x64_file)
    ]
    for relative, x64_file in x64_only_assets:
        target_file = target_app / relative
        target_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(x64_file, target_file, follow_symlinks=False)
    for relative, arm_file in arm_files.items():
        x64_file = x64_files.get(relative)
        arm_arches = macho_architectures(arm_file)
        if not arm_arches:
            continue
        if not x64_file:
            raise RuntimeError(f"x64 Electron runtime is missing Mach-O file: {relative}")
        x64_arches = macho_architectures(x64_file)
        if "arm64" not in arm_arches or "x86_64" not in x64_arches:
            raise RuntimeError(f"Electron architecture mismatch for {relative}: arm64={sorted(arm_arches)} x64={sorted(x64_arches)}")
        target_file = target_app / relative
        temporary = target_file.with_name(f".{target_file.name}.{os.getpid()}.universal")
        run(["lipo", "-create", str(arm_file), str(x64_file), "-output", str(temporary)], timeout=120)
        temporary.chmod(target_file.stat().st_mode)
        os.replace(temporary, target_file)
        merged += 1
    verification = verify_electron_runtime_architecture(target_app, MACOS_UNIVERSAL_ARCHITECTURES)
    return {
        "mode": "universal",
        "macho_files_merged": merged,
        "x64_only_assets_copied": [relative.as_posix() for relative, _path in x64_only_assets],
        **verification,
    }


def create_electron_runtime(args: argparse.Namespace, app_path: Path) -> dict[str, Any]:
    if getattr(args, "electron_arm64_app", None) or getattr(args, "electron_x64_app", None):
        raise RuntimeError(
            "Formal packaging rejects extracted Electron.app inputs; pass a release archive and fixed SHA-256."
        )
    architectures = package_architectures(args.arch)
    archive_args = {
        "arm64": (
            getattr(args, "electron_arm64_archive", None),
            getattr(args, "electron_arm64_sha256", None),
        ),
        "x64": (
            getattr(args, "electron_x64_archive", None),
            getattr(args, "electron_x64_sha256", None),
        ),
    }
    with tempfile.TemporaryDirectory(prefix="echo-founder-electron-extract-") as tmp_dir:
        staging = Path(tmp_dir)
        extracted: dict[str, Path] = {}
        provenance: dict[str, Any] = {}
        for architecture in architectures:
            archive, evidence = resolve_electron_archive(architecture, *archive_args[architecture])
            archive_snapshot = snapshot_verified_archive(
                archive,
                staging / f"electron-{architecture}.zip",
                str(evidence["archive_sha256"]),
                f"Electron {architecture}",
            )
            destination = staging / architecture
            safe_extract_electron_zip(archive_snapshot, destination)
            verify_archive_snapshot_unchanged(
                archive_snapshot,
                str(evidence["archive_sha256"]),
                f"Electron {architecture}",
            )
            source_app = destination / "Electron.app"
            binary = source_app / "Contents" / "MacOS" / "Electron"
            if not source_app.is_dir() or lipo_architecture_name(architecture) not in macho_architectures(binary):
                raise RuntimeError(f"Verified Electron archive is not a macOS {architecture} runtime.")
            archive_notices = {
                "electron": destination / "LICENSE",
                "chromium": destination / "LICENSES.chromium.html",
            }
            if any(not path.is_file() or path.is_symlink() for path in archive_notices.values()):
                raise RuntimeError(f"Verified Electron {architecture} archive lacks distribution notices.")
            extracted[architecture] = source_app
            evidence["extracted_tree_sha256"] = runtime_tree_fingerprint(source_app)["tree_sha256"]
            evidence["notice_sha256"] = {
                name: sha256_file(path)
                for name, path in archive_notices.items()
            }
            provenance[architecture] = evidence

        if args.arch == "universal":
            runtime = merge_universal_electron_runtime(extracted["arm64"], extracted["x64"], app_path)
        else:
            source = extracted[args.arch]
            if app_path.exists():
                shutil.rmtree(app_path)
            shutil.copytree(source, app_path, symlinks=True)
            source_tree = runtime_tree_fingerprint(source)
            copied_tree = runtime_tree_fingerprint(app_path)
            if any(
                source_tree[field] != copied_tree[field]
                for field in ("tree_sha256", "file_count", "directory_count", "symlink_count", "size_bytes")
            ):
                raise RuntimeError("Copied Electron runtime differs from its isolated verified extraction.")
            runtime = {
                "mode": args.arch,
                **verify_electron_runtime_architecture(app_path, {lipo_architecture_name(args.arch)}),
            }
        notice_hashes = {json.dumps(item["notice_sha256"], sort_keys=True) for item in provenance.values()}
        if len(notice_hashes) != 1:
            raise RuntimeError("Electron architecture archives contain different distribution notices.")
        notice_source = staging / architectures[0]
        shutil.copy2(
            notice_source / "LICENSE",
            app_path / "Contents" / "Resources" / ELECTRON_ARCHIVE_LICENSE_RESOURCE,
        )
        shutil.copy2(
            notice_source / "LICENSES.chromium.html",
            app_path / "Contents" / "Resources" / CHROMIUM_ARCHIVE_LICENSE_RESOURCE,
        )
    return {
        **runtime,
        "supply_chain": {
            "rebuild_mode": "verified-archive-isolated-extract",
            "architectures": provenance,
            "assembled_tree_sha256": runtime_tree_fingerprint(app_path)["tree_sha256"],
        },
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_verified_archive(source: Path, destination: Path, expected_sha256: str, label: str) -> Path:
    """Copy a checked archive into a private, per-build immutable input path.

    Resolvers may return an explicit file or a shared download-cache path.  A
    second digest while copying closes the pathname replacement window between
    initial approval and extraction; callers also recheck this snapshot after
    extraction before accepting any bytes.
    """
    expected = str(expected_sha256 or "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise RuntimeError(f"{label} has no approved archive SHA-256.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        raise RuntimeError(f"Refusing to replace an existing private {label} archive snapshot.")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    source_fd = os.open(source, flags)
    try:
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise RuntimeError(f"{label} archive source is not a regular file.")
        output_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        output_fd = os.open(destination, output_flags, 0o400)
        try:
            digest = hashlib.sha256()
            with os.fdopen(source_fd, "rb", closefd=False) as source_handle, os.fdopen(
                output_fd,
                "wb",
                closefd=False,
            ) as output_handle:
                for chunk in iter(lambda: source_handle.read(1024 * 1024), b""):
                    digest.update(chunk)
                    output_handle.write(chunk)
                output_handle.flush()
                os.fsync(output_handle.fileno())
        finally:
            os.close(output_fd)
    finally:
        os.close(source_fd)
    actual = digest.hexdigest()
    if actual != expected:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"{label} archive changed before isolated extraction: expected {expected}, got {actual}")
    destination.chmod(0o400)
    return destination


def verify_archive_snapshot_unchanged(snapshot: Path, expected_sha256: str, label: str) -> None:
    actual = sha256_file(snapshot)
    if actual != expected_sha256:
        raise RuntimeError(
            f"Private {label} archive changed during isolated extraction: "
            f"expected {expected_sha256}, got {actual}"
        )


PRIVATE_BUILD_PATH_MARKERS = ("/Users/", "/home/", "/private/var/folders/", "/var/folders/")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def portable_release_manifest(payload: Any, aliases: list[tuple[Path, str]]) -> Any:
    """Replace builder-local roots before a manifest is persisted for customers."""
    raw_replacements = {
        (candidate, alias.strip("/"))
        for path, alias in aliases
        for candidate in {
            str(path.expanduser()),
            str(path.expanduser().resolve(strict=False)),
        }
        if candidate
    }
    replacements = sorted(
        raw_replacements,
        key=lambda item: len(item[0]),
        reverse=True,
    )

    def convert(value: Any) -> Any:
        if isinstance(value, dict):
            return {str(key): convert(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [convert(item) for item in value]
        if isinstance(value, Path):
            value = str(value)
        if not isinstance(value, str):
            return value
        result = value
        for source, alias in replacements:
            if source:
                result = result.replace(source, alias)
        return result

    portable = convert(payload)
    assert_release_manifest_portable(portable)
    return portable


def assert_release_manifest_portable(payload: Any) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    leaked = [marker for marker in PRIVATE_BUILD_PATH_MARKERS if marker in rendered]
    if leaked:
        raise RuntimeError(
            "Release manifest contains a build-machine absolute path marker: " + ", ".join(leaked)
        )


def _owned_directory_identity(metadata: os.stat_result, label: str) -> tuple[int, int, int]:
    expected_uid = os.getuid()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != expected_uid:
        raise RuntimeError(f"{label} contains an unsafe or unowned parent directory.")
    return metadata.st_dev, metadata.st_ino, metadata.st_uid


def _owned_regular_file_identity(
    metadata: os.stat_result,
    label: str,
    max_bytes: int,
) -> tuple[int, int, int, int, int, int]:
    expected_uid = os.getuid()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != expected_uid
        or metadata.st_nlink != 1
        or metadata.st_size > max_bytes
    ):
        raise RuntimeError(f"{label} is not an owned single-link regular file within the size limit.")
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_uid,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
    )


def secure_read_owned_relative_file(
    root: Path,
    relative: Path,
    *,
    label: str,
    max_bytes: int,
) -> bytes:
    """Read a trust anchor through a same-FD, no-follow openat chain."""
    if relative.is_absolute() or not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise RuntimeError(f"{label} path is unsafe.")
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    file_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    opened_directories: list[int] = []
    file_descriptor = -1
    parent_parts = relative.parts[:-1]
    parent_identities: list[tuple[str | None, tuple[int, int, int]]] = []
    try:
        root_descriptor = os.open(root, directory_flags)
        opened_directories.append(root_descriptor)
        parent_identities.append((None, _owned_directory_identity(os.fstat(root_descriptor), label)))
        current_descriptor = root_descriptor
        for part in parent_parts:
            current_descriptor = os.open(part, directory_flags, dir_fd=current_descriptor)
            opened_directories.append(current_descriptor)
            parent_identities.append((part, _owned_directory_identity(os.fstat(current_descriptor), label)))

        file_descriptor = os.open(relative.name, file_flags, dir_fd=current_descriptor)
        before = os.fstat(file_descriptor)
        before_identity = _owned_regular_file_identity(before, label, max_bytes)
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(file_descriptor, min(64 * 1024, max_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError(f"{label} exceeds the size limit while being read.")
        raw = b"".join(chunks)
        after = os.fstat(file_descriptor)
        after_identity = _owned_regular_file_identity(after, label, max_bytes)
        if before_identity != after_identity or len(raw) != after.st_size:
            raise RuntimeError(f"{label} changed while being read.")
        path_after = os.stat(relative.name, dir_fd=current_descriptor, follow_symlinks=False)
        if _owned_regular_file_identity(path_after, label, max_bytes) != after_identity:
            raise RuntimeError(f"{label} path was replaced while being read.")

        # Re-open the root-to-parent path after the read.  Holding the original
        # directory descriptors is not sufficient: a renamed parent would keep
        # those descriptors valid while changing what the release path names.
        verification_descriptor = os.open(root, directory_flags)
        try:
            if _owned_directory_identity(os.fstat(verification_descriptor), label) != parent_identities[0][1]:
                raise RuntimeError(f"{label} root changed while being read.")
            for index, part in enumerate(parent_parts, start=1):
                next_descriptor = os.open(part, directory_flags, dir_fd=verification_descriptor)
                os.close(verification_descriptor)
                verification_descriptor = next_descriptor
                if _owned_directory_identity(os.fstat(verification_descriptor), label) != parent_identities[index][1]:
                    raise RuntimeError(f"{label} parent path changed while being read.")
            verified_path = os.stat(relative.name, dir_fd=verification_descriptor, follow_symlinks=False)
            if _owned_regular_file_identity(verified_path, label, max_bytes) != after_identity:
                raise RuntimeError(f"{label} final path changed while being read.")
        finally:
            os.close(verification_descriptor)
        return raw
    except OSError as exc:
        raise RuntimeError(f"{label} is missing or unsafe.") from exc
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        for descriptor in reversed(opened_directories):
            os.close(descriptor)


def trusted_qa_key_registry_evidence(repo_root: Path | None = None) -> dict[str, Any]:
    """Bind the current worktree's reviewed QA public-key registry by bytes."""
    root = repo_root or REPO_ROOT
    path = root / TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH
    try:
        raw = secure_read_owned_relative_file(
            root,
            TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH,
            label="Trusted QA public-key registry",
            max_bytes=256 * 1024,
        )
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Trusted QA public-key registry is invalid: {path}") from exc
    keys = payload.get("keys") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != TRUSTED_QA_KEY_REGISTRY_SCHEMA
        or not isinstance(keys, list)
    ):
        raise RuntimeError("Trusted QA public-key registry schema or keys array is invalid.")
    return {
        "schema": TRUSTED_QA_KEY_REGISTRY_SCHEMA,
        "path": TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH.as_posix(),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "key_count": len(keys),
    }


def verify_trusted_qa_key_registry_evidence(recorded: Any) -> dict[str, Any]:
    if not isinstance(recorded, dict):
        raise RuntimeError("Package manifest has no trusted QA public-key registry binding.")
    if set(recorded) != {"schema", "path", "sha256", "key_count"}:
        raise RuntimeError("Package manifest trusted QA public-key registry binding is not an exact projection.")
    expected_shape = {
        "schema": TRUSTED_QA_KEY_REGISTRY_SCHEMA,
        "path": TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH.as_posix(),
    }
    if any(recorded.get(field) != value for field, value in expected_shape.items()):
        raise RuntimeError("Package manifest trusted QA public-key registry schema or path is invalid.")
    if not re.fullmatch(r"[0-9a-f]{64}", str(recorded.get("sha256") or "")):
        raise RuntimeError("Package manifest trusted QA public-key registry SHA-256 is invalid.")
    if type(recorded.get("key_count")) is not int or recorded["key_count"] < 0:
        raise RuntimeError("Package manifest trusted QA public-key registry key count is invalid.")
    live_path = REPO_ROOT / TRUSTED_QA_KEY_REGISTRY_RELATIVE_PATH
    if live_path.exists() or live_path.is_symlink():
        live = trusted_qa_key_registry_evidence()
        if recorded != live:
            raise RuntimeError(
                "Package manifest trusted QA public-key registry does not match the current source worktree."
            )
    return dict(recorded)


def release_source_control(baseline_sha: str = "") -> dict[str, Any]:
    """Capture the immutable Git boundary without leaking local changed paths."""
    ok, current_sha = run_capture(["git", "rev-parse", "--verify", "HEAD^{commit}"])
    current_sha = current_sha.strip().lower()
    if not ok or not GIT_SHA_RE.fullmatch(current_sha):
        raise RuntimeError("Cannot build a traceable desktop artifact without a valid Git HEAD commit.")

    configured = (baseline_sha or os.environ.get("ECHO_FOUNDER_RELEASE_BASELINE_SHA", "")).strip().lower()
    baseline_source = "argument-or-environment"
    if not configured:
        found, checkpoint = run_capture(
            ["git", "log", "--format=%H", "--grep=^chore: checkpoint commercial readiness baseline$", "-1"]
        )
        configured = checkpoint.strip().lower() if found else ""
        baseline_source = "commercial-readiness-checkpoint"
    if not configured:
        configured = current_sha
        baseline_source = "current-head-fallback"
    resolved, resolved_baseline = run_capture(["git", "rev-parse", "--verify", f"{configured}^{{commit}}"])
    resolved_baseline = resolved_baseline.strip().lower()
    if not resolved or not GIT_SHA_RE.fullmatch(resolved_baseline):
        raise RuntimeError(f"Release baseline is not a valid Git commit: {configured}")
    ancestor, _detail = run_capture(["git", "merge-base", "--is-ancestor", resolved_baseline, current_sha])
    if not ancestor:
        raise RuntimeError("Release baseline must be an ancestor of the current source commit.")

    status_ok, status_output = run_capture(["git", "status", "--porcelain=v1", "--untracked-files=all"])
    if not status_ok:
        raise RuntimeError("Cannot determine whether the release source tree is dirty.")
    changed_entries = [line for line in status_output.splitlines() if line.strip()]
    return {
        "schema": "echo-founder.source-control-trace.v1",
        "baseline_sha": resolved_baseline,
        "baseline_source": baseline_source,
        "current_sha": current_sha,
        "dirty": bool(changed_entries),
        "dirty_entry_count": len(changed_entries),
        # Changed path names can reveal customer/build-machine details. The
        # digest proves which status set was observed without persisting it.
        "dirty_status_sha256": hashlib.sha256(status_output.encode("utf-8")).hexdigest(),
    }


def ui_source_fingerprint(ui_root: Path | None = None) -> dict[str, Any]:
    """Fingerprint exactly the UI source that a desktop Next build consumes.

    Next's generated `.next*` directories are deliberately excluded. This makes an explicit
    `--skip-build` fail rather than quietly reusing an output from another
    branch or an older source tree.
    """
    root = ui_root or UI_DIR
    missing_sources = [str(root / item) for item in REQUIRED_NEXT_ROUTE_SOURCES if not (root / item).is_file()]
    if missing_sources:
        raise RuntimeError("Required desktop route source file(s) are missing:\n" + "\n".join(missing_sources))

    digest = hashlib.sha256()
    file_count = 0
    total_bytes = 0
    for path in sorted(root.rglob("*")):
        try:
            relative = path.relative_to(root)
        except ValueError:
            continue
        # A validation server may use its own `.next-*` directory while this
        # production bundle is built. Those generated artifacts must never
        # make a stable source tree look like it changed mid-build.
        if any(part in UI_SOURCE_IGNORED_DIRS or part.startswith(".next") for part in relative.parts):
            continue
        if relative.name in UI_SOURCE_IGNORED_FILES:
            continue
        if not path.is_file() or path.is_symlink():
            continue
        content = path.read_bytes()
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(content).digest())
        digest.update(b"\0")
        file_count += 1
        total_bytes += len(content)
    return {
        "schema": "aifios.desktop-next-source.v1",
        "source_tree_sha256": digest.hexdigest(),
        "source_file_count": file_count,
        "source_bytes": total_bytes,
        "required_route_sources": [item.as_posix() for item in REQUIRED_NEXT_ROUTE_SOURCES],
        "required_route_artifacts": [item.as_posix() for item in REQUIRED_NEXT_ROUTE_ARTIFACTS],
    }


def next_build_manifest_path(dist: Path | None = None) -> Path:
    return (dist or UI_DIR / DESKTOP_DIST_DIR) / NEXT_BUILD_MANIFEST


def next_standalone_root(dist: Path) -> Path:
    return dist / NEXT_STANDALONE_DIR


def next_standalone_dist_dir(dist: Path) -> Path:
    return next_standalone_root(dist) / DESKTOP_DIST_DIR


def prepare_next_standalone_runtime(dist: Path, ui_root: Path | None = None) -> None:
    """Add the static/public assets Next intentionally leaves beside standalone."""
    standalone_root = next_standalone_root(dist)
    standalone_dist = next_standalone_dist_dir(dist)
    required = [standalone_root / "server.js", standalone_dist / "BUILD_ID"]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("Next standalone runtime is incomplete:\n" + "\n".join(missing))

    source_static = dist / "static"
    if source_static.is_dir():
        target_static = standalone_dist / "static"
        if target_static.exists():
            shutil.rmtree(target_static)
        shutil.copytree(source_static, target_static, symlinks=True, ignore=bundle_ignore)

    source_public = (ui_root or UI_DIR) / "public"
    if source_public.is_dir():
        target_public = standalone_root / "public"
        if target_public.exists():
            shutil.rmtree(target_public)
        shutil.copytree(source_public, target_public, symlinks=True, ignore=bundle_ignore)


def write_next_build_manifest(
    dist: Path,
    fingerprint: dict[str, Any],
    dependency_provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = {
        **fingerprint,
        "built_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "next_dist_dir": DESKTOP_DIST_DIR,
        **({"dependency_provenance": dependency_provenance} if dependency_provenance else {}),
    }
    next_build_manifest_path(dist).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def read_next_build_manifest(dist: Path) -> dict[str, Any]:
    path = next_build_manifest_path(dist)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Desktop Next source manifest is missing or invalid: {path}") from exc
    if not isinstance(payload, dict) or payload.get("schema") != "aifios.desktop-next-source.v1":
        raise RuntimeError(f"Desktop Next source manifest schema is invalid: {path}")
    return payload


def assert_next_bundle_matches_current_sources(dist: Path, ui_root: Path | None = None) -> dict[str, Any]:
    expected = ui_source_fingerprint(ui_root)
    manifest = read_next_build_manifest(dist)
    if manifest.get("source_tree_sha256") != expected["source_tree_sha256"]:
        raise RuntimeError(
            "Desktop Next build does not match current UI sources. "
            "Run desktop_package.py without --skip-build so stale .next-desktop output cannot be packaged."
        )
    if manifest.get("required_route_artifacts") != expected["required_route_artifacts"]:
        raise RuntimeError("Desktop Next source manifest does not contain the required production route inventory.")
    return manifest


def isolated_npm_environment(cache_root: Path, home_root: Path | None = None) -> dict[str, str]:
    """Return an npm/Node environment detached from builder-local state.

    The release packager deliberately keeps only ordinary process settings
    such as PATH and locale.  npm configuration, Node injection hooks,
    Playwright mirrors/caches, application secrets, and Next public build-time
    variables must not be able to change a formal bundle.
    """
    cache_root.mkdir(parents=True, exist_ok=True)
    isolated_home = home_root or cache_root.parent / ".build-home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    isolated_tmp = isolated_home / "tmp"
    isolated_tmp.mkdir(mode=0o700, exist_ok=True)
    user_config = isolated_home / "npm-user.conf"
    global_config = isolated_home / "npm-global.conf"
    user_config.write_text("", encoding="utf-8")
    global_config.write_text("", encoding="utf-8")
    # Formal builds use an allowlist rather than trying to enumerate every
    # possible secret name.  In particular, generic provider variables such as
    # OPENAI_API_KEY / ANTHROPIC_API_KEY / TIKOMNI_API_KEY must never reach
    # Next.js or dependency code where they could be inlined into output.
    allowed_host_variables = {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"}
    env = {
        name: os.environ[name]
        for name in allowed_host_variables
        if os.environ.get(name)
    }
    env.update(
        {
            "HOME": str(isolated_home),
            "TMPDIR": str(isolated_tmp),
            "TMP": str(isolated_tmp),
            "TEMP": str(isolated_tmp),
            "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
            "npm_config_ignore_scripts": "true",
            "npm_config_audit": "false",
            "npm_config_fund": "false",
            "npm_config_cache": str(cache_root),
            "npm_config_userconfig": str(user_config),
            "npm_config_globalconfig": str(global_config),
        }
    )
    return env


def seed_isolated_npm_cache(destination: Path) -> dict[str, Any]:
    """Copy an optional download cache without trusting it as build output.

    npm still validates every package against package-lock integrity.  The
    copied cache only preserves offline/retry behavior and is destroyed with
    the per-build staging directory.
    """
    source = DESKTOP_DOWNLOAD_CACHE / "npm"
    destination.mkdir(parents=True, exist_ok=True)
    if not source.is_dir() or source.is_symlink():
        return {"mode": "empty-isolated-cache", "seed_file_count": 0}
    seed_file_count = 0
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        metadata = path.lstat()
        target = destination / relative
        if stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError(f"Refusing symlink in reusable npm download cache: {relative}")
        if stat.S_ISDIR(metadata.st_mode):
            target.mkdir(parents=True, exist_ok=True)
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError(f"Refusing unsupported entry in reusable npm download cache: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        seed_file_count += 1
    return {"mode": "copied-to-isolated-cache", "seed_file_count": seed_file_count}


def validate_ui_build_inputs(root: Path) -> None:
    """Reject local-only inputs which Next/npm would otherwise consume."""
    forbidden: list[str] = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part in UI_SOURCE_IGNORED_DIRS or part.startswith(".next") for part in relative.parts):
            continue
        if path.is_symlink() or relative.name == ".npmrc" or relative.name.startswith(".env"):
            forbidden.append(relative.as_posix())
    if forbidden:
        raise RuntimeError(
            "Formal UI build contains a symlink or machine-local configuration input:\n"
            + "\n".join(sorted(forbidden))
        )


def prepare_isolated_ui_build_tree(staging_ui: Path) -> dict[str, Any]:
    """Copy tracked UI inputs and install the lockfile closure without local node_modules."""
    validate_ui_build_inputs(UI_DIR)
    source_fingerprint = ui_source_fingerprint(UI_DIR)
    # Build staging must contain the same inputs the fingerprint covers,
    # including test fixtures. Customer-runtime filtering happens after build.
    shutil.copytree(
        UI_DIR, staging_ui, symlinks=True,
        ignore=lambda _src, names: {
            name for name in names
            if name in UI_SOURCE_IGNORED_DIRS or name in UI_SOURCE_IGNORED_FILES or name.startswith(".next")
        },
    )
    if (staging_ui / "node_modules").exists() or any(staging_ui.glob(".next*")):
        raise RuntimeError("Isolated UI staging copied a local node_modules or generated Next tree.")
    staged_fingerprint = ui_source_fingerprint(staging_ui)
    if staged_fingerprint["source_tree_sha256"] != source_fingerprint["source_tree_sha256"]:
        raise RuntimeError("Isolated UI staging does not match the reviewed source fingerprint.")
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm is required for the isolated UI package-lock install.")
    lock_sha256 = sha256_file(staging_ui / "package-lock.json")
    isolated_cache = staging_ui.parent / ".npm-cache"
    cache_seed = seed_isolated_npm_cache(isolated_cache)
    run_npm_ci_with_network_retry(
        [npm, "ci", "--ignore-scripts", "--prefer-offline"],
        cwd=staging_ui,
        env=isolated_npm_environment(isolated_cache, staging_ui.parent / ".build-home"),
        timeout=600,
    )
    next_package = _load_json_object(
        staging_ui / "node_modules" / "next" / "package.json",
        "isolated Next package metadata",
    )
    lock = _load_json_object(staging_ui / "package-lock.json", "isolated UI package lock")
    lock_packages = lock.get("packages")
    locked_next = lock_packages.get("node_modules/next") if isinstance(lock_packages, dict) else None
    if (
        not isinstance(locked_next, dict)
        or str(next_package.get("version") or "") != str(locked_next.get("version") or "")
        or not (staging_ui / "node_modules" / "next" / "dist" / "bin" / "next").is_file()
    ):
        raise RuntimeError("Isolated UI npm closure does not contain the lock-bound Next CLI.")
    node_modules_tree = runtime_tree_fingerprint(staging_ui / "node_modules")
    return {
        "mode": "isolated-npm-ci-ignore-scripts",
        "package_lock_sha256": lock_sha256,
        "next_version": str(next_package["version"]),
        "node_modules_tree_sha256": node_modules_tree["tree_sha256"],
        "node_modules_file_count": node_modules_tree["file_count"],
        "cache_seed": cache_seed,
    }


def build_next_bundle(target_root: Path, electron_node: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build Next in a disposable npm-ci tree and copy only its standalone output."""
    with tempfile.TemporaryDirectory(prefix="echo-founder-ui-npm-ci-") as tmp_dir:
        staging_ui = Path(tmp_dir) / "ui"
        # next.config.ts reads the product version from ../VERSION. Preserve
        # that reviewed root input in the isolated tree instead of making the
        # build depend on the repository's absolute location.
        shutil.copy2(REPO_ROOT / "VERSION", Path(tmp_dir) / "VERSION")
        dependency_provenance = prepare_isolated_ui_build_tree(staging_ui)
        dist = staging_ui / DESKTOP_DIST_DIR
        env = isolated_npm_environment(Path(tmp_dir) / ".npm-cache", Path(tmp_dir) / ".build-home")
        env.update(
            {
                "AIFIOS_NEXT_DIST_DIR": DESKTOP_DIST_DIR,
                "NEXT_TELEMETRY_DISABLED": "1",
                "ELECTRON_RUN_AS_NODE": "1",
            }
        )
        next_cli = staging_ui / "node_modules" / "next" / "dist" / "bin" / "next"
        run([str(electron_node), str(next_cli), "build", "--webpack"], cwd=staging_ui, env=env, timeout=600)
        fingerprint_after_build = ui_source_fingerprint(staging_ui)
        if fingerprint_after_build["source_tree_sha256"] != ui_source_fingerprint(UI_DIR)["source_tree_sha256"]:
            raise RuntimeError("UI sources changed during the isolated desktop Next build.")
        prepare_next_standalone_runtime(dist, staging_ui)
        dependency_provenance["standalone_tree_sha256"] = runtime_tree_fingerprint(
            next_standalone_root(dist)
        )["tree_sha256"]
        next_manifest = write_next_build_manifest(dist, fingerprint_after_build, dependency_provenance)
        verify_next_bundle(staging_ui)
        ui_runtime = copy_ui_runtime(target_root, staging_ui)
        packaged_standalone = next_standalone_root(target_root / "ui" / DESKTOP_DIST_DIR)
        packaged_tree = runtime_tree_fingerprint(packaged_standalone)["tree_sha256"]
        if packaged_tree != dependency_provenance["standalone_tree_sha256"]:
            raise RuntimeError("Packaged Next standalone tree differs from its isolated build output.")
        ui_runtime["dependency_provenance"] = dependency_provenance
        ui_runtime["packaged_tree_sha256"] = packaged_tree
        return next_manifest, ui_runtime


def verify_next_bundle(ui_root: Path | None = None) -> dict[str, Any]:
    root = ui_root or UI_DIR
    dist = root / DESKTOP_DIST_DIR
    standalone_dist = next_standalone_dist_dir(dist)
    required = [
        dist / "BUILD_ID",
        dist / "server",
        next_standalone_root(dist) / "server.js",
        standalone_dist / "BUILD_ID",
        *(dist / item for item in REQUIRED_NEXT_ROUTE_ARTIFACTS),
        *(standalone_dist / item for item in REQUIRED_NEXT_ROUTE_ARTIFACTS),
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise SystemExit("Next production bundle is incomplete:\n" + "\n".join(missing))
    return assert_next_bundle_matches_current_sources(dist, root)


def first_line(value: str) -> str:
    return next((line.strip() for line in value.splitlines() if line.strip()), "")


def dylib_dependencies(binary: Path) -> list[str]:
    if sys.platform != "darwin" or not shutil.which("otool"):
        return []
    ok, output = run_capture(["otool", "-L", str(binary)], timeout=15)
    if not ok:
        return []
    dependencies: list[str] = []
    for line in output.splitlines()[1:]:
        value = line.strip().split(" ", 1)[0]
        if value:
            dependencies.append(value)
    return dependencies


def external_dylibs(binary: Path) -> list[str]:
    external: list[str] = []
    for dep in dylib_dependencies(binary):
        if dep.startswith((*SYSTEM_DYLIB_PREFIXES, *BUNDLED_DYLIB_PREFIXES)):
            continue
        external.append(dep)
    return external


def install_name_tool_available() -> bool:
    return bool(shutil.which("install_name_tool"))


def run_install_name_tool(args: list[str]) -> None:
    run(["install_name_tool", *args], timeout=120)


def ad_hoc_codesign_files(files: Iterable[Path]) -> str:
    if not shutil.which("codesign"):
        return "unavailable"
    signed = False
    for file_path in files:
        if not file_path.exists():
            continue
        run(["codesign", "--force", "--sign", "-", str(file_path)], timeout=120)
        signed = True
    return "ad-hoc" if signed else "skipped"


def dylib_scan(files: Iterable[Path]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for file_path in files:
        external = external_dylibs(file_path)
        if external:
            result[str(file_path)] = external
    return result


def candidate_python_binaries(runtime_root: Path, version: str) -> list[Path]:
    candidates = [
        runtime_root / "bin" / "python3",
        runtime_root / "bin" / f"python{version}",
        runtime_root / "bin" / "python",
    ]
    seen: set[Path] = set()
    result: list[Path] = []
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        result.append(path)
    return result


def python_binary_path_for_runtime(runtime_root: Path, version: str) -> Path | None:
    return next((binary for binary in candidate_python_binaries(runtime_root, version) if binary.exists()), None)


def python_binary_for_runtime(runtime_root: Path, version: str) -> Path | None:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
    for binary in candidate_python_binaries(runtime_root, version):
        if not binary.exists():
            continue
        ok, _output = run_capture([str(binary), "--version"], timeout=10, env=env)
        if ok:
            return binary
    return None


def runtime_root_from_python_path(path: Path, version: str) -> Path | None:
    if path.is_file():
        parent = path.parent
        if parent.name == "bin":
            return parent.parent
        return parent
    if path.is_dir():
        if path.name == "bin" and python_binary_for_runtime(path.parent, version):
            return path.parent
        if python_binary_for_runtime(path, version):
            return path
    return None


def find_python_runtime_root(root: Path, version: str) -> Path | None:
    direct = python_binary_path_for_runtime(root, version)
    if direct:
        return root
    for binary in root.rglob("python3"):
        if binary.parent.name == "bin" and binary.is_file():
            return binary.parent.parent
    return None


def safe_extract_python_archive(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, "r:*") as payload:
        members = payload.getmembers()
        normalized: dict[str, tarfile.TarInfo] = {}
        symlink_paths: set[str] = set()
        for member in members:
            name = posixpath.normpath(member.name.replace("\\", "/"))
            if name in {"", "."} or name.startswith("/") or name == ".." or name.startswith("../"):
                raise RuntimeError(f"Refusing unsafe Python archive entry: {member.name}")
            if name in normalized:
                raise RuntimeError(f"Refusing duplicate Python archive entry: {member.name}")
            if member.isdev() or member.isfifo():
                raise RuntimeError(f"Refusing special Python archive entry: {member.name}")
            normalized[name] = member
            if member.issym():
                symlink_paths.add(name)

        for name, member in normalized.items():
            parents = name.split("/")[:-1]
            prefix = ""
            for part in parents:
                prefix = f"{prefix}/{part}" if prefix else part
                if prefix in symlink_paths:
                    raise RuntimeError(f"Refusing Python archive entry below a symlink: {member.name}")
            if member.issym():
                link_name = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                if link_name == ".." or link_name.startswith("../") or link_name.startswith("/"):
                    raise RuntimeError(f"Refusing unsafe Python archive symlink: {member.name}")
            elif member.islnk():
                link_name = posixpath.normpath(member.linkname)
                if link_name == ".." or link_name.startswith("../") or link_name.startswith("/"):
                    raise RuntimeError(f"Refusing unsafe Python archive hardlink: {member.name}")
                if link_name not in normalized:
                    raise RuntimeError(f"Refusing unresolved Python archive hardlink: {member.name}")

        destination.mkdir(parents=True, exist_ok=True)
        payload.extractall(destination)


def python_download_record(architecture: str, version: str) -> dict[str, Any]:
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError(
            f"Cannot download the {architecture} Python runtime because uv is unavailable. "
            "Pass the matching approved --python-runtime-*-archive and --python-runtime-*-sha256 pair."
        )
    result = subprocess.run(
        [
            uv,
            "python",
            "list",
            version,
            "--all-versions",
            "--all-platforms",
            "--all-arches",
            "--only-downloads",
            "--show-urls",
            "--output-format",
            "json",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=60,
        check=False,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"uv Python catalog returned invalid JSON: {result.stdout.strip()}") from exc
    wanted_arch = "aarch64" if architecture == "arm64" else "x86_64"
    candidates = [
        item
        for item in payload if isinstance(item, dict)
        and item.get("implementation") == "cpython"
        and item.get("os") == "macos"
        and item.get("arch") == wanted_arch
        and str(item.get("url") or "")
    ]
    if result.returncode != 0 or not candidates:
        raise RuntimeError(f"uv has no downloadable macOS {architecture} CPython matching {version}.")
    candidates.sort(key=lambda item: tuple(int(part) for part in str(item.get("version") or "0.0.0").split(".")[:3]), reverse=True)
    record = dict(candidates[0])
    record["archive_sha256"] = python_archive_sha256(record)
    return record


def python_archive_sha256(record: dict[str, Any]) -> str:
    """Resolve the immutable GitHub release digest for an uv catalog entry."""
    archive_url = str(record.get("url") or "")
    parsed = urllib.parse.urlsplit(archive_url)
    match = re.match(r"^/[^/]+/[^/]+/releases/download/([^/]+)/([^/]+)$", parsed.path)
    if not match:
        raise RuntimeError(f"Cannot resolve the release digest for Python archive URL: {archive_url}")
    tag = urllib.parse.unquote(match.group(1))
    asset_name = urllib.parse.unquote(match.group(2))
    api_url = (
        "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/"
        + urllib.parse.quote(tag, safe="")
    )
    request = urllib.request.Request(
        api_url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "AIFIOS-Desktop-Packager/1.0",
        },
    )
    try:
        curl = shutil.which("curl")
        if curl:
            ok, output = run_capture(
                [
                    curl,
                    "--fail",
                    "--location",
                    "--retry",
                    "3",
                    "--connect-timeout",
                    "30",
                    "--silent",
                    "--show-error",
                    "-H",
                    "Accept: application/vnd.github+json",
                    "-H",
                    "User-Agent: AIFIOS-Desktop-Packager/1.0",
                    api_url,
                ],
                timeout=90,
            )
            if not ok:
                raise RuntimeError(output or "curl returned a non-zero exit status")
            payload = json.loads(output)
        else:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Unable to fetch the pinned digest for Python archive {asset_name}: {exc}") from exc
    assets = payload.get("assets") if isinstance(payload, dict) else []
    for asset in assets if isinstance(assets, list) else []:
        if not isinstance(asset, dict) or asset.get("name") != asset_name:
            continue
        digest = str(asset.get("digest") or "")
        match = re.fullmatch(r"sha256:([0-9a-fA-F]{64})", digest)
        if match:
            return match.group(1).lower()
        break
    raise RuntimeError(f"GitHub release metadata has no SHA-256 digest for Python archive: {asset_name}")


def download_python_runtime(architecture: str, version: str) -> Path:
    record = python_download_record(architecture, version)
    resolved_version = str(record.get("version") or version)
    expected_archive_sha256 = str(record.get("archive_sha256") or "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_archive_sha256):
        raise RuntimeError(f"Python archive digest is invalid for macOS {architecture} CPython {resolved_version}.")
    cache_dir = PYTHON_DOWNLOAD_CACHE / f"cpython-{resolved_version}-macos-{architecture}"
    marker = cache_dir / "aifios-runtime-source.json"
    if marker.exists():
        try:
            cached_marker = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            cached_marker = {}
        root = find_python_runtime_root(cache_dir, version)
        binary = python_binary_path_for_runtime(root, version) if root else None
        if (
            cached_marker.get("url") == record.get("url")
            and cached_marker.get("version") == resolved_version
            and cached_marker.get("architecture") == architecture
            and cached_marker.get("archive_sha256") == expected_archive_sha256
            and binary
            and lipo_architecture_name(architecture) in macho_architectures(binary)
        ):
            return root

    archive_url = str(record["url"])
    archive_name = Path(archive_url.split("?", 1)[0]).name or f"python-{resolved_version}-{architecture}.tar.gz"
    temporary_parent = Path(tempfile.mkdtemp(prefix="aifios-python-download-"))
    archive = temporary_parent / archive_name
    try:
        print(f"Downloading Python {architecture} runtime: {archive_url}", flush=True)
        curl = shutil.which("curl")
        if curl:
            # Astral's large standalone archives are served behind a CDN that
            # can truncate Python urllib streams on some macOS networks. curl
            # is present in supported macOS releases and gives retryable,
            # checked downloads for this release artifact.
            run(
                [
                    curl,
                    "--fail",
                    "--location",
                    "--retry",
                    "3",
                    "--connect-timeout",
                    "30",
                    "--output",
                    str(archive),
                    archive_url,
                ],
                timeout=300,
            )
        else:
            request = urllib.request.Request(
                archive_url,
                headers={"User-Agent": "AIFIOS-Desktop-Packager/1.0 (+https://github.com/astral-sh/python-build-standalone)"},
            )
            with urllib.request.urlopen(request, timeout=240) as response, archive.open("wb") as output:
                shutil.copyfileobj(response, output)
        actual_archive_sha256 = sha256_file(archive)
        if actual_archive_sha256 != expected_archive_sha256:
            raise RuntimeError(
                f"Python {architecture} archive checksum mismatch: "
                f"expected {expected_archive_sha256}, got {actual_archive_sha256}"
            )
        extracted = temporary_parent / "extracted"
        extracted.mkdir()
        safe_extract_python_archive(archive, extracted)
        source_root = find_python_runtime_root(extracted, version)
        binary = python_binary_path_for_runtime(source_root, version) if source_root else None
        if not source_root or not binary or lipo_architecture_name(architecture) not in macho_architectures(binary):
            raise RuntimeError(f"Downloaded Python runtime is not a valid macOS {architecture} CPython installation.")
        if cache_dir.exists():
            shutil.rmtree(cache_dir)
        cache_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_root, cache_dir, symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
        marker.write_text(
            json.dumps(
                {
                    "url": archive_url,
                    "version": resolved_version,
                    "architecture": architecture,
                    "archive_sha256": expected_archive_sha256,
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
    finally:
        shutil.rmtree(temporary_parent, ignore_errors=True)
    root = find_python_runtime_root(cache_dir, version)
    if not root:
        raise RuntimeError(f"Cached Python runtime is incomplete: {cache_dir}")
    return root


def resolve_python_runtime_for_architecture(architecture: str, explicit: str | None, version: str) -> Path | None:
    environment_name = "AIFIOS_PYTHON_RUNTIME_ARM64" if architecture == "arm64" else "AIFIOS_PYTHON_RUNTIME_X64"
    candidates = [value for value in [explicit, os.getenv(environment_name)] if value]
    if architecture == host_macos_architecture():
        candidates.append(os.getenv("AIFIOS_PYTHON_RUNTIME", ""))
        source = resolve_python_runtime(next((item for item in candidates if item), None), version)
        if source:
            binary = python_binary_path_for_runtime(source, version)
            if binary and lipo_architecture_name(architecture) in macho_architectures(binary):
                return source
    for raw in candidates:
        root = find_python_runtime_root(Path(raw).expanduser().resolve(strict=False), version)
        binary = python_binary_path_for_runtime(root, version) if root else None
        if root and binary and lipo_architecture_name(architecture) in macho_architectures(binary):
            return root
    return download_python_runtime(architecture, version)


def resolve_python_archive(
    architecture: str,
    version: str,
    explicit_archive: str | None = None,
    explicit_sha256: str | None = None,
) -> tuple[Path, dict[str, str]]:
    """Resolve only an approved immutable CPython release archive.

    Extracted directories, uv-managed interpreters, HOME fallbacks, and
    environment-selected runtimes are intentionally outside the formal
    packaging boundary.  A cache is only an archive download cache and is
    checksum-verified before every use.
    """
    approved = APPROVED_PYTHON_RELEASES.get(version, {}).get(architecture)
    if not isinstance(approved, dict):
        raise RuntimeError(f"CPython {version} macOS {architecture} is not in the approved release map.")
    url = str(approved.get("url") or "")
    approved_sha256 = str(approved.get("sha256") or "").lower()
    if not url.startswith("https://") or not re.fullmatch(r"[0-9a-f]{64}", approved_sha256):
        raise RuntimeError(f"Approved CPython release metadata is incomplete for {version} {architecture}.")

    if explicit_archive:
        archive = Path(explicit_archive).expanduser().resolve(strict=True)
        expected = str(explicit_sha256 or "").strip().lower()
        if not archive.is_file() or archive.is_symlink():
            raise RuntimeError("Explicit Python input must be a regular release archive, not an extracted directory.")
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise RuntimeError("Explicit Python archive requires a fixed --python-*-sha256 value.")
        if expected != approved_sha256:
            raise RuntimeError("Explicit Python archive digest is not approved for the selected version/architecture.")
        actual = sha256_file(archive)
        if actual != expected:
            raise RuntimeError(f"Explicit Python archive checksum mismatch: expected {expected}, got {actual}")
        return archive, {
            "version": version,
            "architecture": architecture,
            "source_url": url,
            "archive_sha256": actual,
            "archive_source": "explicit-verified-archive",
            "rebuild_mode": "isolated-extract-every-build",
        }
    if explicit_sha256:
        raise RuntimeError("--python-*-sha256 is valid only with an explicit Python archive.")

    archive_name = urllib.parse.unquote(Path(urllib.parse.urlsplit(url).path).name)
    cache_dir = PYTHON_DOWNLOAD_CACHE / version / architecture
    archive = cache_dir / archive_name
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_hit = archive.is_file() and not archive.is_symlink() and sha256_file(archive) == approved_sha256
    if not cache_hit:
        temporary = archive.with_name(f".{archive.name}.{os.getpid()}.tmp")
        print(f"Downloading Python {architecture} runtime: {url}", flush=True)
        try:
            curl = shutil.which("curl")
            if curl:
                run(
                    [
                        curl,
                        "--fail",
                        "--location",
                        "--retry",
                        "3",
                        "--connect-timeout",
                        "30",
                        "--output",
                        str(temporary),
                        url,
                    ],
                    timeout=300,
                )
            else:
                request = urllib.request.Request(
                    url,
                    headers={"User-Agent": "Echo-Founder-Desktop-Packager/0.2"},
                )
                with urllib.request.urlopen(request, timeout=240) as response, temporary.open("wb") as output:
                    shutil.copyfileobj(response, output)
            actual = sha256_file(temporary)
            if actual != approved_sha256:
                raise RuntimeError(
                    f"Python {architecture} archive checksum mismatch: expected {approved_sha256}, got {actual}"
                )
            os.replace(temporary, archive)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    return archive, {
        "version": version,
        "architecture": architecture,
        "source_url": url,
        "archive_sha256": approved_sha256,
        "archive_source": "approved-verified-cache" if cache_hit else "approved-download",
        "rebuild_mode": "isolated-extract-every-build",
    }


def copy_python_runtime(source_root: Path, target_root: Path, version: str, architecture: str) -> Path:
    runtime_root = target_root / "runtime" / "python" / architecture
    if runtime_root.exists():
        shutil.rmtree(runtime_root)
    shutil.copytree(
        source_root,
        runtime_root,
        symlinks=True,
    )
    python3 = runtime_root / "bin" / "python3"
    if not python3.exists():
        versioned = runtime_root / "bin" / f"python{version}"
        if not versioned.exists():
            versioned = runtime_root / "bin" / "python"
        if not versioned.exists():
            raise RuntimeError(f"copied Python runtime is missing a python binary: {runtime_root}")
        python3.symlink_to(versioned.name)
    return runtime_root


def python_runtime_macho_files(runtime_root: Path) -> list[Path]:
    if not shutil.which("otool") or not runtime_root.exists():
        return []
    result: list[Path] = []
    seen: set[Path] = set()
    for path in runtime_root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in {".dylib", ".so"} and path.parent.name != "bin":
            continue
        try:
            actual = path.resolve()
        except OSError:
            actual = path
        if actual in seen:
            continue
        ok, _output = run_capture(["otool", "-L", str(actual)], timeout=15)
        if ok:
            seen.add(actual)
            result.append(actual)
    return result


def loader_path_reference(consumer: Path, dependency: Path) -> str:
    relative = os.path.relpath(dependency, consumer.parent)
    return "@loader_path/" + Path(relative).as_posix()


def relocated_python_dependency(dep: str, source_roots: list[Path], runtime_root: Path) -> Path | None:
    if not dep.startswith("/"):
        return None
    dep_path = Path(dep)
    for source_root in source_roots:
        try:
            relative = dep_path.relative_to(source_root)
        except ValueError:
            continue
        return runtime_root / relative
    return None


def rewrite_python_runtime_references(source_root: Path, runtime_root: Path) -> dict[str, object]:
    macho_files = python_runtime_macho_files(runtime_root)
    if not macho_files:
        return {
            "status": "skipped_no_macho_files",
            "rewritten_dylibs": [],
            "remaining_external_dylibs": {},
        }
    if not install_name_tool_available():
        return {
            "status": "skipped_install_name_tool_unavailable",
            "rewritten_dylibs": [],
            "remaining_external_dylibs": dylib_scan(macho_files),
        }

    source_roots = [source_root]
    try:
        resolved = source_root.resolve(strict=True)
        if resolved not in source_roots:
            source_roots.append(resolved)
    except OSError:
        pass
    rewritten: list[dict[str, str]] = []

    for file_path in macho_files:
        if file_path.suffix == ".dylib":
            dylib_id = f"@loader_path/{file_path.name}"
            run_install_name_tool(["-id", dylib_id, str(file_path)])
            rewritten.append({"binary": str(file_path), "from": "install-name", "to": dylib_id})
        for dep in dylib_dependencies(file_path):
            replacement_target = relocated_python_dependency(dep, source_roots, runtime_root)
            if not replacement_target or not replacement_target.exists():
                continue
            replacement = loader_path_reference(file_path, replacement_target)
            if dep == replacement:
                continue
            run_install_name_tool(["-change", dep, replacement, str(file_path)])
            rewritten.append({"binary": str(file_path), "from": dep, "to": replacement})

    remaining_external = dylib_scan(macho_files)
    return {
        "status": "rewritten" if not remaining_external else "review_required",
        "rewritten_dylibs": rewritten,
        "remaining_external_dylibs": remaining_external,
    }


def verify_python_runtime(runtime_root: Path, resources_root: Path) -> dict[str, str]:
    python = runtime_root / "bin" / "python3"
    if not python.exists():
        raise RuntimeError(f"embedded Python runtime is missing python3: {python}")
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
    ok, version = run_capture([str(python), "--version"], timeout=15, env=env)
    if not ok:
        raise RuntimeError(f"embedded Python runtime failed --version: {python}\n{version}")
    smoke = "import json, pathlib, sqlite3, ssl, sys; print(sys.version.split()[0])"
    ok, import_output = run_capture([str(python), "-c", smoke], timeout=15, env=env)
    if not ok:
        raise RuntimeError(f"embedded Python runtime failed stdlib import smoke:\n{import_output}")
    content_runtime = resources_root / "skills" / "content-runtime" / "scripts" / "content_runtime.py"
    with tempfile.TemporaryDirectory(prefix="aifios-python-runtime-") as tmp_dir:
        ok, runtime_output = run_capture([str(python), str(content_runtime), "--project", tmp_dir, "init"], timeout=30, env=env)
    if not ok:
        raise RuntimeError(f"embedded Python runtime failed content-runtime init:\n{runtime_output}")
    return {
        "binary": str(python),
        "version": first_line(version),
        "stdlib_smoke": first_line(import_output),
        "content_runtime_smoke": "pass",
    }


def embed_python_runtime(
    target_root: Path,
    mode: str,
    explicit: str | None,
    explicit_arm64: str | None,
    explicit_x64: str | None,
    version: str,
    package_architecture: str,
    *,
    explicit_archive: str | None = None,
    explicit_arm64_archive: str | None = None,
    explicit_x64_archive: str | None = None,
    explicit_sha256: str | None = None,
    explicit_arm64_sha256: str | None = None,
    explicit_x64_sha256: str | None = None,
) -> dict[str, object]:
    if explicit or explicit_arm64 or explicit_x64:
        raise RuntimeError(
            "Formal packaging rejects extracted Python runtime paths; pass an approved release archive and SHA-256."
        )
    if mode == "off":
        if any(
            value
            for value in (
                explicit_archive,
                explicit_arm64_archive,
                explicit_x64_archive,
                explicit_sha256,
                explicit_arm64_sha256,
                explicit_x64_sha256,
            )
        ):
            raise RuntimeError("Python archive options cannot be combined with --embed-python-runtime=off.")
        return {"status": "skipped", "mode": mode}

    architectures = ["arm64", "x64"] if package_architecture == "universal" else [package_architecture]
    archives_by_architecture = {
        "arm64": explicit_arm64_archive or (explicit_archive if package_architecture == "arm64" else None),
        "x64": explicit_x64_archive or (explicit_archive if package_architecture == "x64" else None),
    }
    sha256_by_architecture = {
        "arm64": explicit_arm64_sha256 or (explicit_sha256 if package_architecture == "arm64" else None),
        "x64": explicit_x64_sha256 or (explicit_sha256 if package_architecture == "x64" else None),
    }
    embedded: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="echo-founder-python-extract-") as tmp_dir:
        staging_root = Path(tmp_dir)
        for architecture in architectures:
            archive, source_evidence = resolve_python_archive(
                architecture,
                version,
                archives_by_architecture[architecture],
                sha256_by_architecture[architecture],
            )
            archive_snapshot = snapshot_verified_archive(
                archive,
                staging_root / f"python-{architecture}.archive",
                str(source_evidence["archive_sha256"]),
                f"CPython {architecture}",
            )
            extracted = staging_root / architecture
            safe_extract_python_archive(archive_snapshot, extracted)
            verify_archive_snapshot_unchanged(
                archive_snapshot,
                str(source_evidence["archive_sha256"]),
                f"CPython {architecture}",
            )
            source_root = find_python_runtime_root(extracted, version)
            source_binary = python_binary_path_for_runtime(source_root, version) if source_root else None
            if (
                not source_root
                or not source_binary
                or lipo_architecture_name(architecture) not in macho_architectures(source_binary)
            ):
                raise RuntimeError(f"Approved Python archive is not a macOS {architecture} CPython runtime.")
            source_tree = runtime_tree_fingerprint(source_root)
            runtime_root = copy_python_runtime(source_root, target_root, version, architecture)
            copied_tree = runtime_tree_fingerprint(runtime_root)
            if (source_root / "bin" / "python3").exists() and any(
                source_tree[field] != copied_tree[field]
                for field in ("tree_sha256", "file_count", "directory_count", "symlink_count", "size_bytes")
            ):
                raise RuntimeError("Copied Python runtime differs from its isolated verified extraction.")

            rewrite = rewrite_python_runtime_references(source_root, runtime_root)
            macho_files = python_runtime_macho_files(runtime_root)
            component_signature = ad_hoc_codesign_files(macho_files)
            binary = python_binary_path_for_runtime(runtime_root, version)
            if not binary or lipo_architecture_name(architecture) not in macho_architectures(binary):
                raise RuntimeError(f"embedded Python runtime has the wrong architecture: {runtime_root}")
            native = architecture == host_macos_architecture()
            verification = verify_python_runtime(runtime_root, target_root) if native else {
                "binary": str(binary),
                "version": "cross-architecture-not-executed",
                "stdlib_smoke": "not-run-on-build-host",
                "content_runtime_smoke": "not-run-on-build-host",
            }
            remaining_external = dylib_scan(macho_files)
            final_tree = runtime_tree_fingerprint(runtime_root)
            embedded[architecture] = {
                "runtime_root": str(runtime_root),
                "binary": verification["binary"],
                "version": verification["version"],
                "stdlib_smoke": verification["stdlib_smoke"],
                "content_runtime_smoke": verification["content_runtime_smoke"],
                "rewritten_dylibs": rewrite.get("rewritten_dylibs", []),
                "rewrite_status": rewrite.get("status"),
                "component_signature": component_signature,
                "macho_files_checked": len(macho_files),
                "size_bytes": directory_size(runtime_root),
                "tree_sha256": final_tree["tree_sha256"],
                "source_extracted_tree_sha256": source_tree["tree_sha256"],
                "source": source_evidence,
                "portability": "review_required" if remaining_external else "self_contained_or_system_only",
                "nonportable_dylibs": remaining_external,
            }
    if not embedded:
        return {"status": "skipped_missing", "mode": mode, "version": version}
    return {
        "status": "embedded",
        "mode": mode,
        "architectures": embedded,
    }


def tikomni_required_files(skill_dir: Path) -> list[Path]:
    return [skill_dir / item for item in TIKOMNI_BUNDLE_FILES]


def tikomni_snapshot_sha256(file_hashes: dict[str, str]) -> str:
    digest = hashlib.sha256(b"echo-founder.tikomni-approved-snapshot.v1\0")
    for relative in TIKOMNI_BUNDLE_FILES:
        key = relative.as_posix()
        digest.update(key.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(file_hashes.get(key) or "").encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def verify_tikomni_social_media_crawl(
    skill_dir: Path,
    python_binary: str | Path = sys.executable,
) -> dict[str, Any]:
    """Verify the approved vendored API snapshot without making a network request."""
    missing = [str(path) for path in tikomni_required_files(skill_dir) if not path.is_file() or path.is_symlink()]
    if missing:
        raise RuntimeError("TikOmni social-media-crawl files are incomplete:\n" + "\n".join(missing))

    file_hashes = {
        relative.as_posix(): sha256_file(skill_dir / relative)
        for relative in TIKOMNI_BUNDLE_FILES
    }
    if file_hashes != TIKOMNI_APPROVED_FILE_SHA256:
        changed = sorted(
            key
            for key in set(file_hashes) | set(TIKOMNI_APPROVED_FILE_SHA256)
            if file_hashes.get(key) != TIKOMNI_APPROVED_FILE_SHA256.get(key)
        )
        raise RuntimeError(
            "TikOmni social-media-crawl does not match the approved connector snapshot: "
            + ", ".join(changed)
        )
    snapshot_sha256 = tikomni_snapshot_sha256(file_hashes)
    if snapshot_sha256 != TIKOMNI_APPROVED_SNAPSHOT_SHA256:
        raise RuntimeError("TikOmni approved connector snapshot digest is inconsistent with its file allowlist.")

    resolver = skill_dir / TIKOMNI_RESOLVER_RELATIVE_PATH
    # This probe can run against the future app bundle. Keep bytecode caches
    # out of signed Resources so a validation pass never mutates its payload.
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
    try:
        result = subprocess.run(
            [str(python_binary), str(resolver), "--platform", "xiaohongshu", "--capability", "search"],
            cwd=skill_dir,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=20,
            check=False,
        )
    except Exception as exc:
        raise RuntimeError(f"TikOmni social-media-crawl resolver could not start: {exc}") from exc
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"TikOmni social-media-crawl resolver returned invalid JSON: {result.stdout.strip()}") from exc
    recommended = payload.get("recommended") if isinstance(payload, dict) else {}
    endpoint_id = recommended.get("endpoint_id") if isinstance(recommended, dict) else ""
    if result.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True or not endpoint_id:
        raise RuntimeError(
            "TikOmni social-media-crawl resolver failed its offline catalog smoke: "
            f"{result.stdout.strip()}"
        )
    return {
        "snapshot_id": TIKOMNI_APPROVED_SNAPSHOT_ID,
        "snapshot_sha256": snapshot_sha256,
        "file_sha256": dict(sorted(file_hashes.items())),
        "caller": TIKOMNI_CALLER_RELATIVE_PATH.as_posix(),
        "resolver": TIKOMNI_RESOLVER_RELATIVE_PATH.as_posix(),
        "catalog_endpoint": str(endpoint_id),
        "caller_sha256": sha256_file(skill_dir / TIKOMNI_CALLER_RELATIVE_PATH),
    }


def resolve_tikomni_social_media_crawl_source(explicit: str | None = None) -> Path:
    if not explicit:
        raise RuntimeError(
            "A formal desktop package requires an explicit --social-media-crawl-dir; "
            "home-directory and environment fallback discovery is prohibited."
        )
    try:
        resolved = Path(explicit).expanduser().resolve(strict=True)
    except OSError as exc:
        raise RuntimeError(f"Explicit TikOmni social-media-crawl source is unavailable: {explicit}") from exc
    if not resolved.is_dir() or resolved.is_symlink():
        raise RuntimeError(f"Explicit TikOmni social-media-crawl source is unsafe: {resolved}")
    verify_tikomni_social_media_crawl(resolved)
    return resolved


def embed_tikomni_social_media_crawl(target_root: Path, explicit_source: str | None = None) -> dict[str, Any]:
    """Vendor only the caller/resolver runtime, not unrelated crawl pipelines.

    The API catalog is intentionally retained because TikOmni endpoint ids must
    be resolved from that catalog at runtime. Tests, agents and media pipelines
    are not required by AIFIOS' content-research path and stay out of the app.
    """
    source = resolve_tikomni_social_media_crawl_source(explicit_source)
    target = target_root / "skills" / TIKOMNI_SKILL_NAME
    if target.exists():
        shutil.rmtree(target)
    for relative in TIKOMNI_BUNDLE_FILES:
        source_path = source / relative
        target_path = target / relative
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path)
    verification = verify_tikomni_social_media_crawl(target)
    return {
        "status": "embedded",
        "target_path": (Path("skills") / TIKOMNI_SKILL_NAME).as_posix(),
        "file_count": len(TIKOMNI_BUNDLE_FILES),
        "size_bytes": directory_size(target),
        "verification": verification,
    }


def bundle_ignore(src: str, names: list[str]) -> set[str]:
    source = Path(src)
    ignored = {
        ".git",
        ".github",
        ".DS_Store",
        ".pytest_cache",
        "__pycache__",
        "fixtures",
        "tests",
        "test-results",
        "HANDOFF.md",
        "Makefile",
        "PRODUCT.md",
        "tsconfig.tsbuildinfo",
    }
    if source.name == "ui":
        ignored.add("node_modules")
        ignored.update(name for name in names if name.startswith(".next"))
    if source.name == "xhs-card":
        # The source checkout's gitignored node_modules is never a package
        # input. A clean npm-ci closure is staged and copied separately.
        ignored.add("node_modules")
    if source.name == "wechat-writer":
        # Historical single-author style material is retained only in the
        # internal source repository. Customer runtimes are identity-neutral
        # and resolve voice solely from the active project's approved profile.
        ignored.add("style-changhuan.md")
    if source.name == "references" and source.parent.name == "wechat-writer":
        ignored.add("style_examples.md")
    if source.name == DESKTOP_DIST_DIR:
        ignored.update({"cache"})
    return {name for name in names if name in ignored}


def copy_bundle_item(name: str, target_root: Path) -> None:
    source = REPO_ROOT / name
    if not source.exists():
        return
    target = target_root / name
    if source.is_dir():
        shutil.copytree(source, target, symlinks=True, ignore=bundle_ignore)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def copy_customer_skills(target_root: Path) -> list[str]:
    """Copy only skills declared as customer-visible core/optional capabilities."""
    source_manifest = REPO_ROOT / "skills" / "manifest.json"
    try:
        payload = json.loads(source_manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read skill manifest for customer packaging: {source_manifest}") from exc
    included = payload.get("included_skills") if isinstance(payload, dict) else None
    if not isinstance(included, list):
        raise RuntimeError("Skill manifest included_skills must be a list for customer packaging.")
    names: list[str] = []
    for item in included:
        name = str(item.get("name") or "").strip() if isinstance(item, dict) else ""
        if not name or not re.fullmatch(r"[a-z0-9-]+", name) or name in names:
            raise RuntimeError(f"Skill manifest has an invalid or duplicate customer skill name: {name!r}")
        source = REPO_ROOT / "skills" / name
        if not (source / "SKILL.md").is_file():
            raise RuntimeError(f"Customer skill is missing SKILL.md: {source}")
        names.append(name)

    skills_target = target_root / "skills"
    skills_target.mkdir(parents=True, exist_ok=True)
    for name in names:
        shutil.copytree(
            REPO_ROOT / "skills" / name,
            skills_target / name,
            symlinks=True,
            ignore=bundle_ignore,
        )

    runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    entrypoints = runtime.get("entrypoints") if isinstance(runtime.get("entrypoints"), dict) else {}
    customer_entrypoints = {
        key: value
        for key, value in entrypoints.items()
        if isinstance(value, str) and value.startswith("skills/content-runtime/")
    }
    customer_manifest = {
        **payload,
        "name": "echo-founder-skills",
        "version": DEFAULT_PRODUCT_VERSION,
        "description": "Echo Founder customer runtime skill manifest",
        "runtime": {**runtime, "entrypoints": customer_entrypoints},
        "project_state": {
            **(payload.get("project_state") if isinstance(payload.get("project_state"), dict) else {}),
            "default_project": "~/Echo Founder",
        },
    }
    customer_manifest.pop("quality_gates", None)
    (skills_target / "manifest.json").write_text(
        json.dumps(customer_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return names


def copy_aifios_runtime(target_root: Path) -> None:
    if target_root.exists():
        shutil.rmtree(target_root)
    target_root.mkdir(parents=True)
    for name in RUNTIME_ROOT_FILES:
        shutil.copy2(REPO_ROOT / name, target_root / name)
    copy_customer_skills(target_root)
    scripts_target = target_root / "scripts"
    scripts_target.mkdir(parents=True, exist_ok=True)
    for name in RUNTIME_SCRIPT_FILES:
        shutil.copy2(REPO_ROOT / "scripts" / name, scripts_target / name)
    docs_target = target_root / "docs"
    docs_target.mkdir(parents=True, exist_ok=True)
    for name in CUSTOMER_DOCUMENTS:
        shutil.copy2(REPO_ROOT / "docs" / name, docs_target / name)


def verify_customer_bundle_hygiene(target_root: Path) -> dict[str, Any]:
    """Reject build-only files, project data, and build-host paths in the customer runtime."""
    required = [
        *(target_root / name for name in RUNTIME_ROOT_FILES),
        target_root / "skills" / "manifest.json",
        *(target_root / "scripts" / name for name in RUNTIME_SCRIPT_FILES),
        *(target_root / "docs" / name for name in CUSTOMER_DOCUMENTS),
        target_root / "skills" / "xhs-card" / "LICENSE",
        target_root / "skills" / "xhs-card" / "README.md",
        target_root / "skills" / "xhs-card" / "README.en.md",
        target_root / "skills" / "xhs-card" / "MODIFICATIONS.md",
    ]
    missing = [path.relative_to(target_root).as_posix() for path in required if not path.is_file()]
    if missing:
        raise RuntimeError("Customer bundle is missing required runtime/manual file(s):\n" + "\n".join(missing))

    forbidden = [
        path
        for relative in FORBIDDEN_CUSTOMER_BUNDLE_PATHS
        if (path := target_root / relative).exists() or path.is_symlink()
    ]
    forbidden.extend(
        path for path in target_root.rglob("*") if path.name in FORBIDDEN_CUSTOMER_FILE_NAMES
    )
    forbidden.extend(
        path
        for path in target_root.iterdir()
        if path.is_dir() and (path.name in FORBIDDEN_PROJECT_DATA_DIR_NAMES or path.name.startswith(".aifios-"))
    )
    allowed_script_paths = {f"scripts/{name}" for name in RUNTIME_SCRIPT_FILES}
    allowed_doc_paths = {f"docs/{name}" for name in CUSTOMER_DOCUMENTS}
    forbidden.extend(
        path
        for path in (target_root / "scripts").rglob("*")
        if path.is_file() and path.relative_to(target_root).as_posix() not in allowed_script_paths
    )
    forbidden.extend(
        path
        for path in (target_root / "docs").rglob("*")
        if path.is_file() and path.relative_to(target_root).as_posix() not in allowed_doc_paths
    )
    skill_manifest_path = target_root / "skills" / "manifest.json"
    try:
        skill_manifest = json.loads(skill_manifest_path.read_text(encoding="utf-8"))
        included_skills = skill_manifest.get("included_skills")
        allowed_skills = {
            str(item.get("name") or "")
            for item in included_skills
            if isinstance(item, dict) and item.get("name")
        } if isinstance(included_skills, list) else set()
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        allowed_skills = set()
    if not allowed_skills and any((target_root / "skills").glob("*/SKILL.md")):
        raise RuntimeError("Customer bundle has no valid included_skills allowlist.")
    allowed_skills.add(TIKOMNI_SKILL_NAME)
    skills_root = target_root / "skills"
    if skills_root.is_dir():
        forbidden.extend(
            path
            for path in skills_root.iterdir()
            if path.is_dir() and path.name not in allowed_skills
        )
    if forbidden:
        rendered = sorted({path.relative_to(target_root).as_posix() for path in forbidden})
        raise RuntimeError("Customer bundle contains internal or project-data path(s):\n" + "\n".join(rendered))

    private_roots = {
        str(REPO_ROOT.resolve()),
        str(Path.home().resolve()),
    }
    leaks: list[str] = []
    identity_leaks: list[str] = []
    scanned = 0
    for path in target_root.rglob("*"):
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 5 * 1024 * 1024:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        scanned += 1
        if any(root and root in content for root in private_roots):
            leaks.append(path.relative_to(target_root).as_posix())
        if any(marker.casefold() in content.casefold() for marker in FORBIDDEN_CUSTOMER_IDENTITY_MARKERS):
            identity_leaks.append(path.relative_to(target_root).as_posix())
    if leaks:
        raise RuntimeError("Customer bundle leaks a build-machine absolute path in:\n" + "\n".join(sorted(leaks)))
    if identity_leaks:
        raise RuntimeError(
            "Customer bundle contains a bundled single-author identity in:\n"
            + "\n".join(sorted(identity_leaks))
        )
    return {
        "status": "pass",
        "customer_manuals": list(CUSTOMER_DOCUMENTS),
        "runtime_scripts": list(RUNTIME_SCRIPT_FILES),
        "customer_skills": sorted(allowed_skills - {TIKOMNI_SKILL_NAME}),
        "text_files_scanned": scanned,
    }


def write_hosted_client_config(
    target_root: Path,
    gateway_url: str | None,
    research_public_key: str | None = None,
    research_key_id: str | None = None,
) -> dict[str, str] | None:
    """Embed only public hosted-client bootstrap data for a paid build."""
    raw = (gateway_url or "").strip()
    public_key = (research_public_key or "").strip()
    key_id = (research_key_id or "market-v1").strip()
    if public_key and not raw:
        raise RuntimeError("--hosted-research-public-key requires --hosted-gateway-url")
    if public_key and not re.fullmatch(r"[A-Za-z0-9_-]{40,4096}", public_key):
        raise RuntimeError("--hosted-research-public-key must be a base64url SPKI DER public key")
    if public_key and not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", key_id):
        raise RuntimeError("--hosted-research-key-id must use letters, digits, dot, underscore, or hyphen")
    if not raw:
        return None
    parsed = urllib.parse.urlparse(raw)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("--hosted-gateway-url must be a credential-free HTTPS origin without a path")
    normalized = raw.rstrip("/")
    path = target_root / "hosted-client.json"
    payload = {
        "schema": "aifios.hosted-client.v1",
        "gatewayUrl": normalized,
        "licenseMode": "device-bound",
        **({"researchPublicKey": public_key, "researchKeyId": key_id} if public_key else {}),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "path": str(path),
        "gateway_url": normalized,
        "license_mode": "device-bound",
        "research_signing_enabled": "true" if public_key else "false",
        **({"research_key_id": key_id} if public_key else {}),
    }


def write_distribution_config(resources_root: Path, hosted_client: dict[str, str] | None) -> dict[str, object]:
    """Write a public, code-signed mode marker outside the mutable project data."""
    resources_root.mkdir(parents=True, exist_ok=True)
    path = resources_root / "aifios-distribution.json"
    payload = {
        "schema": "aifios.desktop-distribution.v1",
        "mode": "hosted-license" if hosted_client else "local-self-config",
        "deviceBinding": bool(hosted_client),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"path": str(path), **payload}


def write_demo_unlock_config(target_root: Path, demo_unlock_codes: str | None) -> dict[str, object] | None:
    """Compatibility no-op: new local packages never require a product password."""
    del target_root, demo_unlock_codes
    return None


def copy_ui_runtime(target_root: Path, source_ui: Path | None = None) -> dict[str, Any]:
    """Copy only the traced Next standalone server into the customer bundle."""
    ui_root = source_ui or UI_DIR
    source_dist = ui_root / DESKTOP_DIST_DIR
    source_standalone = next_standalone_root(source_dist)
    target_ui = target_root / "ui"
    target_dist = target_ui / DESKTOP_DIST_DIR
    if target_ui.exists():
        shutil.rmtree(target_ui)
    target_dist.mkdir(parents=True)

    shutil.copy2(ui_root / "package.json", target_ui / "package.json")
    for source in [source_dist / "BUILD_ID", source_dist / NEXT_BUILD_MANIFEST]:
        if not source.is_file():
            raise RuntimeError(f"Desktop Next runtime source is missing: {source}")
        shutil.copy2(source, target_dist / source.name)
    if not source_standalone.is_dir():
        raise RuntimeError(f"Desktop Next standalone server is missing: {source_standalone}")
    shutil.copytree(source_standalone, target_dist / NEXT_STANDALONE_DIR, symlinks=True, ignore=bundle_ignore)

    target_standalone = next_standalone_root(target_dist)
    required = [target_standalone / "server.js", next_standalone_dist_dir(target_dist) / "BUILD_ID"]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError("Packaged standalone Next runtime is incomplete:\n" + "\n".join(missing))
    return {
        "mode": "next-standalone",
        "path": f"ui/{DESKTOP_DIST_DIR}/{NEXT_STANDALONE_DIR}",
        "size_bytes": directory_size(target_standalone),
        "root_node_modules_included": (target_ui / "node_modules").exists(),
    }


def package_architectures(package_architecture: str) -> tuple[str, ...]:
    if package_architecture == "universal":
        return NODE_RUNTIME_ARCHITECTURES
    if package_architecture in NODE_RUNTIME_ARCHITECTURES:
        return (package_architecture,)
    raise RuntimeError(f"Unsupported desktop package architecture: {package_architecture}")


def node_package_architecture(package_name: str) -> str | None:
    match = re.search(r"-darwin-(arm64|x64)$", package_name)
    return match.group(1) if match else None


def node_package_architecture_base(package_name: str) -> str | None:
    match = re.search(r"^(.*-darwin-)(arm64|x64)$", package_name)
    return match.group(1) if match else None


def node_package_directory(node_modules: Path, package_name: str) -> Path | None:
    direct = node_modules.joinpath(*package_name.split("/"))
    if (direct / "package.json").is_file():
        return direct
    # A traced production bundle can nest a dependency beneath another package.
    # Prefer the direct resolution path but support that valid Node layout too.
    for candidate in node_modules.rglob("package.json"):
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if payload.get("name") == package_name:
            return candidate.parent
    return None


def native_node_package_directories(node_modules: Path) -> dict[str, Path]:
    """Return runtime packages carrying a Mach-O Node add-on or dylib."""
    result: dict[str, Path] = {}
    if not node_modules.is_dir():
        return result
    for package_json in node_modules.rglob("package.json"):
        package_dir = package_json.parent
        try:
            payload = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        package_name = str(payload.get("name") or "").strip()
        if not package_name or package_name in result:
            continue
        contains_native_binary = any(
            path.is_file()
            and not path.is_symlink()
            and path.suffix in {".node", ".dylib"}
            and bool(macho_architectures(path))
            for path in package_dir.rglob("*")
        )
        if contains_native_binary:
            result[package_name] = package_dir
    return result


def next_optional_native_packages(node_modules: Path, architectures: Iterable[str]) -> set[str]:
    next_package = node_modules / "next" / "package.json"
    try:
        payload = json.loads(next_package.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Next standalone runtime has an invalid package manifest: {next_package}") from exc
    optional = payload.get("optionalDependencies")
    if not isinstance(optional, dict):
        return set()
    allowed = set(architectures)
    return {
        str(package_name)
        for package_name in optional
        if node_package_architecture(str(package_name)) in allowed
    }


def install_node_runtime_staging(staging_root: Path, architecture: str) -> Path:
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm is required to assemble the traced Next runtime native dependencies.")
    package_dir = staging_root / architecture
    package_dir.mkdir(parents=True)
    shutil.copy2(UI_DIR / "package.json", package_dir / "package.json")
    lockfile = UI_DIR / "package-lock.json"
    if not lockfile.is_file():
        raise RuntimeError("ui/package-lock.json is required for deterministic desktop native dependency packaging.")
    shutil.copy2(lockfile, package_dir / "package-lock.json")
    cache_root = staging_root / ".npm-cache" / architecture
    seed_isolated_npm_cache(cache_root)
    env = isolated_npm_environment(cache_root, staging_root / ".build-home")
    env.update(
        {
            "npm_config_os": "darwin",
            "npm_config_cpu": architecture,
            "npm_config_ignore_scripts": "true",
        }
    )
    run_npm_ci_with_network_retry(
        [npm, "ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--os=darwin", f"--cpu={architecture}"],
        cwd=package_dir,
        env=env,
        timeout=600,
    )
    node_modules = package_dir / "node_modules"
    if not node_modules.is_dir():
        raise RuntimeError(f"npm did not create a runtime dependency tree for {architecture}.")
    return node_modules


def copy_node_package(source: Path, target: Path) -> None:
    if target.exists() or target.is_symlink():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target, symlinks=True, ignore=bundle_ignore)


def merge_native_node_package(arm64_source: Path, x64_source: Path, target: Path) -> int:
    """Copy a package once and fatten matching native binaries in place."""
    copy_node_package(arm64_source, target)
    merged = 0
    for x64_file in x64_source.rglob("*"):
        if not x64_file.is_file() or x64_file.is_symlink():
            continue
        relative = x64_file.relative_to(x64_source)
        target_file = target / relative
        if not target_file.exists():
            target_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(x64_file, target_file)
            continue
        if x64_file.suffix not in {".node", ".dylib"}:
            continue
        arm64_architectures = macho_architectures(target_file)
        x64_architectures = macho_architectures(x64_file)
        if "arm64" not in arm64_architectures or "x86_64" not in x64_architectures:
            continue
        temporary = target_file.with_name(f".{target_file.name}.{os.getpid()}.universal")
        run(["lipo", "-create", str(target_file), str(x64_file), "-output", str(temporary)], timeout=120)
        temporary.chmod(target_file.stat().st_mode)
        os.replace(temporary, target_file)
        merged += 1
    return merged


def verify_next_native_runtime(standalone_root: Path, package_architecture: str) -> dict[str, Any]:
    node_modules = standalone_root / "node_modules"
    architectures = package_architectures(package_architecture)
    native_packages = native_node_package_directories(node_modules)
    expected_packages = next_optional_native_packages(node_modules, architectures)
    expected_packages.update(
        f"{base}{architecture}"
        for package_name in native_packages
        if (base := node_package_architecture_base(package_name))
        for architecture in architectures
    )

    missing_packages: list[str] = []
    wrong_architecture: dict[str, dict[str, list[str]]] = {}
    for package_name in sorted(expected_packages):
        package_dir = node_package_directory(node_modules, package_name)
        if not package_dir:
            missing_packages.append(package_name)
            continue
        required_architecture = lipo_architecture_name(node_package_architecture(package_name) or architectures[0])
        package_machos = [
            path
            for path in package_dir.rglob("*")
            if path.is_file() and not path.is_symlink() and path.suffix in {".node", ".dylib"} and macho_architectures(path)
        ]
        if not package_machos:
            missing_packages.append(f"{package_name} (no native binary)")
            continue
        for binary in package_machos:
            actual = macho_architectures(binary)
            if required_architecture not in actual:
                wrong_architecture.setdefault(package_name, {})[binary.relative_to(package_dir).as_posix()] = sorted(actual)

    generic_failures: dict[str, dict[str, list[str]]] = {}
    for package_name, package_dir in native_packages.items():
        if node_package_architecture(package_name):
            continue
        for binary in package_dir.rglob("*"):
            if not binary.is_file() or binary.is_symlink() or binary.suffix not in {".node", ".dylib"}:
                continue
            actual = macho_architectures(binary)
            if not actual:
                continue
            missing = set(lipo_architecture_name(architecture) for architecture in architectures) - actual
            if missing:
                generic_failures.setdefault(package_name, {})[binary.relative_to(package_dir).as_posix()] = sorted(actual)

    if missing_packages or wrong_architecture or generic_failures:
        raise RuntimeError(
            "Next standalone native runtime architecture verification failed:\n"
            + json.dumps(
                {
                    "missing_packages": missing_packages,
                    "wrong_architecture": wrong_architecture,
                    "generic_package_architecture_failures": generic_failures,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return {
        "architectures": list(architectures),
        "native_packages": sorted(native_node_package_directories(node_modules)),
        "expected_packages": sorted(expected_packages),
    }


def embed_next_native_runtime(standalone_root: Path, package_architecture: str) -> dict[str, Any]:
    """Add only native production dependencies omitted by Next's host trace.

    Next tracing follows the build host and therefore retains the current
    architecture's Sharp package. A universal Electron shell still needs the
    alternate Sharp and SWC optional packages when it is launched on Intel.
    This creates two temporary production-only npm trees and copies just the
    runtime packages required by the traced server, never the full UI tree.
    """
    node_modules = standalone_root / "node_modules"
    if not node_modules.is_dir():
        raise RuntimeError(f"Next standalone runtime is missing node_modules: {node_modules}")
    architectures = package_architectures(package_architecture)
    existing_native = native_node_package_directories(node_modules)
    platform_groups = {
        base
        for package_name in existing_native
        if (base := node_package_architecture_base(package_name))
    }
    platform_groups.update(
        base
        for package_name in next_optional_native_packages(node_modules, NODE_RUNTIME_ARCHITECTURES)
        if (base := node_package_architecture_base(package_name))
    )
    generic_packages = {
        package_name
        for package_name in existing_native
        if not node_package_architecture(package_name)
    }
    copied_packages: list[str] = []
    merged_generic_binaries = 0

    with tempfile.TemporaryDirectory(prefix="aifios-next-native-") as tmp_dir:
        staging_root = Path(tmp_dir)
        # Generic native packages need both slices to become a single fat
        # binary. Platform-named packages instead coexist at their normal Node
        # resolution paths, so only the requested package slices are copied.
        staging_architectures = NODE_RUNTIME_ARCHITECTURES if package_architecture == "universal" else architectures
        staging = {
            architecture: install_node_runtime_staging(staging_root, architecture)
            for architecture in staging_architectures
        }
        for base in sorted(platform_groups):
            for architecture in architectures:
                package_name = f"{base}{architecture}"
                source = node_package_directory(staging[architecture], package_name)
                if not source:
                    raise RuntimeError(f"npm runtime staging is missing {package_name} for {architecture}.")
                target = node_modules.joinpath(*package_name.split("/"))
                copy_node_package(source, target)
                copied_packages.append(package_name)
        for package_name in sorted(generic_packages):
            target = node_package_directory(node_modules, package_name)
            if not target:
                raise RuntimeError(f"Traced Next native package disappeared: {package_name}")
            if package_architecture == "universal":
                arm64_source = node_package_directory(staging["arm64"], package_name)
                x64_source = node_package_directory(staging["x64"], package_name)
                if not arm64_source or not x64_source:
                    raise RuntimeError(f"npm runtime staging is missing generic native package: {package_name}")
                merged_generic_binaries += merge_native_node_package(arm64_source, x64_source, target)
            else:
                source = node_package_directory(staging[architectures[0]], package_name)
                if not source:
                    raise RuntimeError(f"npm runtime staging is missing {package_name} for {architectures[0]}.")
                copy_node_package(source, target)
            copied_packages.append(package_name)

    verification = verify_next_native_runtime(standalone_root, package_architecture)
    return {
        "status": "embedded",
        "architectures": list(architectures),
        "copied_packages": sorted(set(copied_packages)),
        "merged_generic_binaries": merged_generic_binaries,
        "verification": verification,
    }


def _xhs_lock_expected_packages(xhs_root: Path) -> dict[str, str]:
    lock = _load_json_object(xhs_root / "package-lock.json", "xhs-card package lock")
    packages = lock.get("packages")
    root = packages.get("") if isinstance(packages, dict) else None
    if (
        not isinstance(root, dict)
        or root.get("license") != "AGPL-3.0-only"
        or int(lock.get("lockfileVersion") or 0) != 3
    ):
        raise RuntimeError("xhs-card package-lock must be lockfile v3 and declare AGPL-3.0-only at its root.")
    expected: dict[str, str] = {}
    for package_path, metadata in packages.items():
        if not package_path.startswith("node_modules/") or not isinstance(metadata, dict):
            continue
        if metadata.get("dev") is True or metadata.get("link") is True:
            continue
        version = str(metadata.get("version") or "").strip()
        if not version:
            raise RuntimeError(f"xhs-card lock entry has no version: {package_path}")
        expected[package_path] = version
    required = {"node_modules/fsevents", "node_modules/playwright", "node_modules/playwright-core"}
    if not required.issubset(expected):
        raise RuntimeError("xhs-card package-lock lacks the required Playwright/fsevents production closure.")
    return dict(sorted(expected.items()))


def _xhs_installed_matches_lock(xhs_root: Path, expected: dict[str, str]) -> bool:
    node_modules = xhs_root / "node_modules"
    if not node_modules.is_dir() or node_modules.is_symlink():
        return False
    installed: dict[str, str] = {}
    for package_json in sorted(node_modules.rglob("package.json")):
        relative = package_json.relative_to(node_modules)
        if not _is_node_package_manifest(relative) or package_json.is_symlink():
            continue
        try:
            payload = _load_json_object(package_json, "xhs-card installed package metadata")
        except RuntimeError:
            return False
        package_path = (Path("node_modules") / relative.parent).as_posix()
        installed[package_path] = str(payload.get("version") or "").strip()
    return installed == expected


def _verify_xhs_runtime_closure(xhs_root: Path, expected: dict[str, str]) -> dict[str, Any]:
    if not _xhs_installed_matches_lock(xhs_root, expected):
        raise RuntimeError("xhs-card node_modules does not match its exact production package-lock closure.")
    node_modules = xhs_root / "node_modules"
    evidence_count = 0
    for package_path in expected:
        package_root = xhs_root / package_path
        package = _load_json_object(package_root / "package.json", "xhs-card staged npm package metadata")
        if not all(
            (
                str(package.get("name") or "").strip(),
                str(package.get("version") or "").strip(),
                _license_expression(package),
            )
        ):
            raise RuntimeError(f"xhs-card staged npm package metadata is incomplete: {package_path}")
        evidence = _recursive_license_notice_files(package_root)
        if not evidence:
            raise RuntimeError(f"xhs-card staged npm package lacks LICENSE/NOTICE evidence: {package_path}")
        evidence_count += len(evidence)
    required_runtime_files = (
        node_modules / "playwright" / "cli.js",
        node_modules / "playwright-core" / "browsers.json",
    )
    missing = [path.relative_to(xhs_root).as_posix() for path in required_runtime_files if not path.is_file()]
    if missing:
        raise RuntimeError("xhs-card staged runtime is missing required Playwright files: " + ", ".join(missing))
    for path in node_modules.rglob("*"):
        if not path.is_symlink():
            continue
        try:
            path.resolve(strict=True).relative_to(node_modules.resolve(strict=True))
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"xhs-card staged runtime contains an escaping or broken symlink: {path}") from exc
    return {
        "package_count": len(expected),
        "license_evidence_count": evidence_count,
    }


def prepare_xhs_card_runtime_dependencies(
    source_root: Path | None,
    packaged_root: Path,
) -> dict[str, Any]:
    """Install from lock in an isolated directory, then copy only that clean closure."""
    source = source_root or (REPO_ROOT / "skills" / "xhs-card")
    expected = _xhs_lock_expected_packages(source)
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm is required to stage xhs-card runtime dependencies from package-lock.json.")
    for name in ("package.json", "package-lock.json"):
        path = source / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"xhs-card deterministic staging input is missing or unsafe: {path}")
    if sha256_file(source / "package-lock.json") != sha256_file(packaged_root / "package-lock.json"):
        raise RuntimeError("Packaged xhs-card package-lock does not match the reviewed source lockfile.")
    packaged_node_modules = packaged_root / "node_modules"
    if packaged_node_modules.exists() or packaged_node_modules.is_symlink():
        raise RuntimeError("Packaged xhs-card unexpectedly contains source node_modules before clean staging.")

    with tempfile.TemporaryDirectory(prefix="echo-founder-xhs-card-npm-ci-") as tmp_dir:
        temporary_root = Path(tmp_dir)
        staging_root = temporary_root / "xhs-card"
        staging_root.mkdir()
        for name in ("package.json", "package-lock.json"):
            shutil.copy2(source / name, staging_root / name)
        isolated_cache = temporary_root / ".npm-cache"
        cache_seed = seed_isolated_npm_cache(isolated_cache)
        run_npm_ci_with_network_retry(
            [npm, "ci", "--omit=dev", "--ignore-scripts"],
            cwd=staging_root,
            env=isolated_npm_environment(isolated_cache, temporary_root / ".build-home"),
            timeout=300,
        )
        staged_verification = _verify_xhs_runtime_closure(staging_root, expected)
        staged_tree = runtime_tree_fingerprint(staging_root / "node_modules")
        shutil.copytree(staging_root / "node_modules", packaged_node_modules, symlinks=True)
        packaged_verification = _verify_xhs_runtime_closure(packaged_root, expected)
        packaged_tree = runtime_tree_fingerprint(packaged_node_modules)
        compared_fields = ("tree_sha256", "file_count", "directory_count", "symlink_count", "size_bytes")
        if any(staged_tree[field] != packaged_tree[field] for field in compared_fields):
            raise RuntimeError("Copied xhs-card runtime differs from the isolated npm-ci staging closure.")

    return {
        "status": "staged-clean-install",
        "package_lock_sha256": sha256_file(source / "package-lock.json"),
        "package_count": len(expected),
        "packages": expected,
        "license_evidence_count": staged_verification["license_evidence_count"],
        "packaged_license_evidence_count": packaged_verification["license_evidence_count"],
        "node_modules_tree_sha256": packaged_tree["tree_sha256"],
        "cache_seed": cache_seed,
    }


def playwright_browser_metadata(node_modules: Path) -> tuple[str, str, str]:
    # visual_screenshot.mjs resolves Playwright from xhs-card's package scope,
    # so the bundled browser revision must match that runtime rather than the
    # UI's incidental Playwright development dependency.
    package_json = node_modules / "playwright-core" / "package.json"
    browsers_json = node_modules / "playwright-core" / "browsers.json"
    try:
        version = str(json.loads(package_json.read_text(encoding="utf-8")).get("version") or "").strip()
        browsers = json.loads(browsers_json.read_text(encoding="utf-8")).get("browsers")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Unable to read xhs-card's Playwright browser metadata.") from exc
    if not version or not isinstance(browsers, list):
        raise RuntimeError("xhs-card Playwright browser metadata is incomplete.")
    for browser in browsers:
        if isinstance(browser, dict) and browser.get("name") == "chromium-headless-shell":
            revision = str(browser.get("revision") or "").strip()
            browser_version = str(browser.get("browserVersion") or "").strip()
            if revision and browser_version:
                return version, revision, browser_version
    raise RuntimeError("xhs-card Playwright does not define a chromium-headless-shell revision.")


def playwright_headless_shell_directory(root: Path, revision: str, architecture: str) -> Path | None:
    cache_root = root / f"chromium_headless_shell-{revision}"
    if not cache_root.is_dir():
        return None
    wanted = lipo_architecture_name(architecture)
    for executable in cache_root.rglob("chrome-headless-shell"):
        if executable.is_file() and not executable.is_symlink() and wanted in macho_architectures(executable):
            return executable.parent
    return None


def prepare_playwright_headless_shell(
    architecture: str,
    version: str,
    revision: str,
    browser_version: str,
    cache_root: Path,
    explicit_archive: str | None = None,
    explicit_sha256: str | None = None,
) -> tuple[Path, dict[str, Any]]:
    approved = APPROVED_PLAYWRIGHT_RELEASES.get((version, revision, browser_version), {}).get(architecture)
    if not isinstance(approved, dict):
        raise RuntimeError(
            f"Playwright {version} headless shell {revision}/{browser_version} {architecture} is not approved."
        )
    url = str(approved.get("url") or "")
    approved_sha256 = str(approved.get("sha256") or "").lower()
    if not url.startswith("https://") or not re.fullmatch(r"[0-9a-f]{64}", approved_sha256):
        raise RuntimeError("Approved Playwright browser archive metadata is incomplete.")

    if explicit_archive:
        archive = Path(explicit_archive).expanduser().resolve(strict=True)
        expected = str(explicit_sha256 or "").strip().lower()
        if not archive.is_file() or archive.is_symlink():
            raise RuntimeError("Explicit Playwright input must be a regular browser archive.")
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise RuntimeError("Explicit Playwright archive requires a fixed SHA-256.")
        if expected != approved_sha256:
            raise RuntimeError("Explicit Playwright archive digest is not approved for the lock-bound browser.")
        actual = sha256_file(archive)
        if actual != expected:
            raise RuntimeError(f"Explicit Playwright archive checksum mismatch: expected {expected}, got {actual}")
        archive_snapshot = snapshot_verified_archive(
            archive,
            cache_root / "approved-archive.zip",
            approved_sha256,
            f"Playwright {architecture}",
        )
        extracted = cache_root / "explicit-extracted"
        safe_extract_electron_zip(archive_snapshot, extracted)
        verify_archive_snapshot_unchanged(
            archive_snapshot,
            approved_sha256,
            f"Playwright {architecture}",
        )
        wanted = lipo_architecture_name(architecture)
        source = next(
            (
                executable.parent
                for executable in extracted.rglob("chrome-headless-shell")
                if executable.is_file() and not executable.is_symlink() and wanted in macho_architectures(executable)
            ),
            None,
        )
        if not source:
            raise RuntimeError(f"Explicit Playwright archive has no macOS {architecture} headless shell.")
        return source, {
            "method": "explicit-verified-archive-isolated-extract",
            "archive_sha256": actual,
            "source_url": url,
            "revision": revision,
            "version": version,
            "browser_version": browser_version,
        }
    if explicit_sha256:
        raise RuntimeError("Playwright archive SHA-256 is valid only with an explicit archive.")

    archive_name = urllib.parse.unquote(Path(urllib.parse.urlsplit(url).path).name)
    download_cache = DESKTOP_DOWNLOAD_CACHE / "playwright" / version / revision / architecture
    archive = download_cache / archive_name
    download_cache.mkdir(parents=True, exist_ok=True)
    cache_hit = archive.is_file() and not archive.is_symlink() and sha256_file(archive) == approved_sha256
    if not cache_hit:
        temporary = archive.with_name(f".{archive.name}.{os.getpid()}.tmp")
        print(f"Downloading Playwright {architecture} headless shell: {url}", flush=True)
        try:
            curl = shutil.which("curl")
            if curl:
                run(
                    [
                        curl,
                        "--fail",
                        "--location",
                        "--retry",
                        "3",
                        "--connect-timeout",
                        "30",
                        "--output",
                        str(temporary),
                        url,
                    ],
                    timeout=900,
                )
            else:
                request = urllib.request.Request(
                    url,
                    headers={"User-Agent": "Echo-Founder-Desktop-Packager/0.2"},
                )
                with urllib.request.urlopen(request, timeout=900) as response, temporary.open("wb") as output:
                    shutil.copyfileobj(response, output)
            actual = sha256_file(temporary)
            if actual != approved_sha256:
                raise RuntimeError(
                    f"Playwright {architecture} archive checksum mismatch: expected {approved_sha256}, got {actual}"
                )
            os.replace(temporary, archive)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    archive_snapshot = snapshot_verified_archive(
        archive,
        cache_root / "approved-archive.zip",
        approved_sha256,
        f"Playwright {architecture}",
    )
    extracted = cache_root / "extracted"
    safe_extract_electron_zip(archive_snapshot, extracted)
    verify_archive_snapshot_unchanged(
        archive_snapshot,
        approved_sha256,
        f"Playwright {architecture}",
    )
    wanted = lipo_architecture_name(architecture)
    source = next(
        (
            executable.parent
            for executable in extracted.rglob("chrome-headless-shell")
            if executable.is_file() and not executable.is_symlink() and wanted in macho_architectures(executable)
        ),
        None,
    )
    if not source:
        raise RuntimeError(f"Approved Playwright archive has no macOS {architecture} headless shell.")
    return source, {
        "method": "approved-archive-isolated-extract",
        "archive_source": "approved-verified-cache" if cache_hit else "approved-download",
        "archive_sha256": approved_sha256,
        "source_url": url,
        "revision": revision,
        "version": version,
        "browser_version": browser_version,
    }


def verify_playwright_runtime(resources_root: Path, package_architecture: str) -> dict[str, Any]:
    runtime_root = resources_root / "runtime" / "playwright"
    manifest_path = runtime_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Packaged Playwright runtime manifest is missing or invalid: {manifest_path}") from exc
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != PLAYWRIGHT_RUNTIME_SCHEMA
        or manifest.get("tree_hash_schema") != RUNTIME_TREE_HASH_SCHEMA
    ):
        raise RuntimeError(f"Packaged Playwright runtime manifest has an invalid schema: {manifest_path}")
    entries = manifest.get("architectures") if isinstance(manifest, dict) else {}
    if not isinstance(entries, dict):
        raise RuntimeError(f"Packaged Playwright runtime manifest has no architecture entries: {manifest_path}")
    revision = str(manifest.get("headless_shell_revision") or "").strip()
    version = str(manifest.get("playwright_version") or "").strip()
    browser_version = str(manifest.get("browser_version") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", revision):
        raise RuntimeError(f"Packaged Playwright runtime has an invalid Chromium revision: {manifest_path}")
    if set(entries) != set(package_architectures(package_architecture)):
        raise RuntimeError("Packaged Playwright runtime architecture projection is not exact.")
    verified: dict[str, Any] = {}
    for architecture in package_architectures(package_architecture):
        entry = entries.get(architecture)
        if not isinstance(entry, dict):
            raise RuntimeError(f"Packaged Playwright runtime has no {architecture} entry: {manifest_path}")
        if str(entry.get("source_revision") or "") != revision:
            raise RuntimeError(f"Packaged Playwright runtime revision does not match its {architecture} entry.")
        source = entry.get("source")
        approved = APPROVED_PLAYWRIGHT_RELEASES.get((version, revision, browser_version), {}).get(architecture)
        if not isinstance(source, dict) or not isinstance(approved, dict):
            raise RuntimeError(f"Packaged Playwright {architecture} lacks approved archive provenance.")
        if source.get("method") not in {
            "approved-archive-isolated-extract",
            "explicit-verified-archive-isolated-extract",
        }:
            raise RuntimeError(f"Packaged Playwright {architecture} was not rebuilt from an isolated archive.")
        for field, expected_value in (
            ("archive_sha256", approved.get("sha256")),
            ("source_url", approved.get("url")),
            ("version", version),
            ("revision", revision),
            ("browser_version", browser_version),
        ):
            if source.get(field) != expected_value:
                raise RuntimeError(f"Packaged Playwright {architecture} provenance {field} is invalid.")
        if not re.fullmatch(r"[a-f0-9]{64}", str(entry.get("source_extracted_tree_sha256") or "")):
            raise RuntimeError(f"Packaged Playwright {architecture} lacks an extracted-tree digest.")
        expected_hash = str(entry.get("tree_sha256") or "").lower()
        if not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
            raise RuntimeError(f"Packaged Playwright runtime has no valid {architecture} integrity hash.")
        relative_executable = entry.get("executable")
        if not isinstance(relative_executable, str) or not relative_executable:
            raise RuntimeError(f"Packaged Playwright runtime has no {architecture} executable path.")
        parts = tuple(relative_executable.split("/"))
        if (
            not parts
            or parts[0] != architecture
            or any(not item or item in {".", ".."} or "\\" in item for item in parts)
        ):
            raise RuntimeError(f"Packaged Playwright runtime executable path is unsafe for {architecture}.")
        runtime_directory = runtime_root / architecture
        executable = runtime_root.joinpath(*parts)
        try:
            executable.relative_to(runtime_directory)
        except ValueError as exc:
            raise RuntimeError(f"Packaged Playwright runtime executable escapes {architecture}.") from exc
        expected = lipo_architecture_name(architecture)
        actual = macho_architectures(executable)
        if not executable.is_file() or executable.is_symlink() or expected not in actual:
            raise RuntimeError(
                f"Packaged Playwright chromium headless shell is invalid for {architecture}: "
                f"{executable} ({sorted(actual)})"
            )
        actual_hash = runtime_tree_fingerprint(runtime_directory)["tree_sha256"]
        if actual_hash != expected_hash:
            raise RuntimeError(f"Packaged Playwright runtime integrity check failed for {architecture}.")
        binaries = [
            path
            for path in runtime_directory.rglob("*")
            if path.is_file() and not path.is_symlink() and macho_architectures(path)
        ]
        wrong_architecture = {
            path.relative_to(runtime_directory).as_posix(): sorted(macho_architectures(path))
            for path in binaries
            if expected not in macho_architectures(path)
        }
        if wrong_architecture:
            raise RuntimeError(
                f"Packaged Playwright runtime contains wrong-architecture binaries ({architecture}):\n"
                + json.dumps(wrong_architecture, ensure_ascii=False, indent=2)
            )
        verified[architecture] = {
            "executable": str(executable),
            "macho_files_checked": len(binaries),
            "tree_sha256": actual_hash,
        }
    return {
        "status": "pass",
        "version": version,
        "revision": revision,
        "browser_version": browser_version,
        "architectures": verified,
    }


def playwright_runtime_macho_files(runtime_root: Path) -> list[Path]:
    return [
        path
        for path in runtime_root.rglob("*")
        if path.is_file() and not path.is_symlink() and macho_architectures(path)
    ]


def directory_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    for file_path in sorted(item for item in path.rglob("*") if item.is_file() and not item.is_symlink()):
        relative = file_path.relative_to(path).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        with file_path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _load_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{label} is missing or invalid: {path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label} must be a JSON object: {path}")
    return payload


def _license_expression(payload: dict[str, Any]) -> str:
    declared = payload.get("license")
    if isinstance(declared, str):
        return declared.strip()
    if isinstance(declared, dict):
        return str(declared.get("type") or "").strip()
    return ""


def _repository_reference(payload: dict[str, Any]) -> str:
    repository = payload.get("repository")
    if isinstance(repository, dict):
        repository = repository.get("url")
    value = str(repository or payload.get("homepage") or "").strip()
    return value if not value.startswith(("file:", "/")) else ""


def _is_node_package_manifest(relative: Path) -> bool:
    """Return true only for npm package roots, not package-owned subpath manifests."""
    if relative.name != "package.json":
        return False
    parts = relative.parent.parts
    if len(parts) == 1:
        return True
    if len(parts) == 2 and parts[0].startswith("@"):
        return True
    if "node_modules" not in parts:
        return False
    suffix = parts[max(index for index, item in enumerate(parts) if item == "node_modules") + 1 :]
    return len(suffix) == 1 or (len(suffix) == 2 and suffix[0].startswith("@"))


def discover_next_standalone_packages(standalone_root: Path) -> list[dict[str, Any]]:
    """Inventory every physical package.json in Next's shipped node_modules.

    Next vendors a large dependency closure below ``next/dist/compiled``. Those
    manifests are separate auditable metadata records; they must never be
    silently collapsed into, or licensed as, the top-level Next package.
    """
    node_modules = standalone_root / "node_modules"
    if not node_modules.is_dir() or node_modules.is_symlink():
        raise RuntimeError(f"Next standalone node_modules is missing or unsafe: {node_modules}")
    packages: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for package_json in sorted(node_modules.rglob("package.json")):
        relative = package_json.relative_to(node_modules)
        ancestors = [package_json]
        ancestors.extend(package_json.parents[index] for index in range(len(relative.parts)))
        if any(path.is_symlink() for path in ancestors):
            raise RuntimeError(f"Next standalone package manifest is a symlink: {relative}")
        payload = _load_json_object(package_json, "Next standalone npm package manifest")
        declared_name = str(payload.get("name") or "").strip()
        declared_version = str(payload.get("version") or "").strip()
        declared_license = _license_expression(payload)
        package_path = (Path("node_modules") / relative.parent).as_posix()
        metadata_missing = [
            field
            for field, value in (
                ("name", declared_name),
                ("version", declared_version),
                ("license", declared_license),
            )
            if not value
        ]
        if package_path in seen_paths:
            raise RuntimeError(f"Next standalone npm inventory duplicates {package_path}")
        seen_paths.add(package_path)
        packages.append(
            {
                "package_path": package_path,
                "manifest_scope": (
                    "npm-package-root"
                    if _is_node_package_manifest(relative)
                    else "embedded-package-metadata"
                ),
                "name": declared_name or f"undeclared:{package_path}",
                "version": declared_version or "NOASSERTION",
                "license": declared_license or "NOASSERTION",
                "metadata_missing": metadata_missing,
                "metadata_status": (
                    "manual-review-required-incomplete-package-metadata"
                    if metadata_missing
                    else "complete"
                ),
                "repository": _repository_reference(payload),
                "package_json_sha256": sha256_file(package_json),
            }
        )
    if not packages or not any(
        item["package_path"] == "node_modules/next" and item["name"] == "next"
        for item in packages
    ):
        raise RuntimeError("Next standalone npm inventory is empty or lacks the shipped next package.")
    return packages


def _license_files(package_dir: Path) -> list[Path]:
    if not package_dir.is_dir() or package_dir.is_symlink():
        return []
    markers = ("license", "licence", "copying", "notice", "copyright")
    return sorted(
        path
        for path in package_dir.iterdir()
        if path.is_file()
        and not path.is_symlink()
        and any(marker in path.name.lower() for marker in markers)
    )


def _package_license_texts(
    package: dict[str, Any],
    standalone_root: Path,
) -> list[tuple[str, str, str]]:
    """Return license text physically colocated with this shipped manifest."""
    package_dir = standalone_root / str(package["package_path"])
    candidates: list[tuple[str, Path]] = [("shipped-package", path) for path in _license_files(package_dir)]
    result: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for source_kind, path in candidates:
        content = path.read_text(encoding="utf-8", errors="replace").strip()
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if not content or digest in seen:
            continue
        seen.add(digest)
        result.append((f"{source_kind}:{path.name}", content, digest))
    return result


def _npm_review_boundary_id(kind: str, package: dict[str, Any]) -> str:
    return f"npm-{kind}:{package['package_path']}"


def render_next_standalone_notice(
    standalone_root: Path,
) -> tuple[list[dict[str, Any]], str]:
    packages = discover_next_standalone_packages(standalone_root)
    lines = [
        "Echo Founder — Next standalone npm dependency notices",
        "",
        "This aggregate is generated from every package.json physically shipped in",
        "the Next standalone node_modules tree, including next/dist/compiled metadata.",
        "Missing metadata and missing discrete license text are explicit manual-review",
        "boundaries; neither is inherited from the top-level Next.js MIT declaration.",
        "",
    ]
    for index, package in enumerate(packages, start=1):
        texts = _package_license_texts(package, standalone_root)
        package["notice_path"] = (Path("aifios") / NEXT_STANDALONE_NOTICE).as_posix()
        package["notice_section"] = index
        package["license_evidence_mode"] = "full-text-aggregate" if texts else "metadata-only-review-required"
        package["license_text_sha256"] = [item[2] for item in texts]
        lines.extend(
            [
                "=" * 78,
                f"[{index}] {package['name']}@{package['version']}",
                f"Shipped path: {package['package_path']}",
                f"Manifest scope: {package['manifest_scope']}",
                f"Declared license: {package['license']}",
                f"Metadata status: {package['metadata_status']}",
                "Missing declared metadata: " + (", ".join(package["metadata_missing"]) or "none"),
                f"Repository: {package['repository'] or 'not declared in package metadata'}",
                f"package.json SHA-256: {package['package_json_sha256']}",
                f"Evidence mode: {package['license_evidence_mode']}",
            ]
        )
        if not texts:
            lines.extend(
                [
                    "",
                    "No discrete LICENSE/NOTICE text was physically colocated with this",
                    "manifest. Preserve this exact manifest as a manual review boundary.",
                ]
            )
        for source_label, content, digest in texts:
            lines.extend(
                [
                    "",
                    f"--- license text ({source_label}; sha256={digest}) ---",
                    content,
                ]
            )
        lines.append("")
    return packages, "\n".join(lines).rstrip() + "\n"


def write_next_standalone_notice(
    standalone_root: Path,
    notice_path: Path,
) -> list[dict[str, Any]]:
    packages, rendered = render_next_standalone_notice(standalone_root)
    notice_path.parent.mkdir(parents=True, exist_ok=True)
    notice_path.write_text(rendered, encoding="utf-8")
    return packages


def electron_process_versions(app_path: Path) -> dict[str, str]:
    candidates = [
        app_path / "Contents" / "MacOS" / "Electron",
        *(path for path in (app_path / "Contents" / "MacOS").glob("*") if path.is_file()),
    ]
    executable = next((path for path in candidates if path.is_file() and os.access(path, os.X_OK)), None)
    if not executable:
        raise RuntimeError(f"Cannot inspect Electron/Chromium versions in {app_path}")
    ok, output = run_capture(
        [str(executable), "-p", "JSON.stringify(process.versions)"],
        timeout=30,
        env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"},
    )
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Electron runtime returned invalid process.versions JSON: {output}") from exc
    versions = {
        name: str(payload.get(name) or "").strip()
        for name in ("electron", "chrome", "node")
    } if isinstance(payload, dict) else {}
    if not ok or any(not versions.get(name) for name in ("electron", "chrome", "node")):
        raise RuntimeError(f"Electron runtime did not disclose electron/chrome/node versions: {output}")
    return versions


def _resource_evidence(app_path: Path, path: Path) -> dict[str, Any]:
    resources = app_path / "Contents" / "Resources"
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(f"Shipped dependency evidence is missing or unsafe: {path}")
    try:
        relative = path.relative_to(resources)
        path.resolve(strict=True).relative_to(resources.resolve(strict=True))
    except ValueError as exc:
        raise RuntimeError(f"Shipped dependency evidence escapes App Resources: {path}") from exc
    if any(part in {"", ".", ".."} for part in relative.parts):
        raise RuntimeError(f"Shipped dependency evidence has an unsafe path: {relative}")
    return {
        "path": relative.as_posix(),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
    }


def _recursive_license_notice_files(root: Path) -> list[Path]:
    markers = ("license", "licence", "copying", "notice", "copyright")
    result: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative_parts = tuple(part.lower() for part in path.relative_to(root).parts)
        if any(marker in path.name.lower() for marker in markers) or "licenses" in relative_parts[:-1]:
            result.append(path)
    return result


def _python_metadata_headers(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"Python distribution metadata is missing or invalid: {path}") from exc
    headers: dict[str, str] = {}
    for line in text.splitlines():
        if not line:
            break
        if line[:1].isspace() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers.setdefault(key.strip().lower(), value.strip())
    return headers


def discover_python_distributions(
    app_path: Path,
    runtime_root: Path,
    architecture: str,
) -> list[dict[str, Any]]:
    """Enumerate every shipped dist-info and every bundled license/notice file."""
    resources = app_path / "Contents" / "Resources"
    records: list[dict[str, Any]] = []
    for dist_info in sorted(runtime_root.rglob("*.dist-info")):
        if not dist_info.is_dir() or dist_info.is_symlink():
            raise RuntimeError(f"Embedded Python dist-info is missing or unsafe: {dist_info}")
        metadata = dist_info / "METADATA"
        if not metadata.is_file() or metadata.is_symlink():
            raise RuntimeError(f"Embedded Python dist-info lacks safe METADATA: {dist_info}")
        headers = _python_metadata_headers(metadata)
        name = str(headers.get("name") or "").strip()
        version = str(headers.get("version") or "").strip()
        license_expression = str(
            headers.get("license-expression") or headers.get("license") or ""
        ).strip()
        if not name or not version:
            raise RuntimeError(f"Embedded Python dist-info lacks Name/Version metadata: {dist_info}")
        evidence_files = _recursive_license_notice_files(dist_info)
        if not evidence_files:
            raise RuntimeError(f"Embedded Python dist-info lacks bundled license/NOTICE evidence: {dist_info}")
        relative = dist_info.relative_to(runtime_root).as_posix()
        records.append(
            {
                "component_id": f"python-dist:{architecture}:{relative}",
                "architecture": architecture,
                "dist_info_path": (
                    runtime_root.relative_to(resources) / dist_info.relative_to(runtime_root)
                ).as_posix(),
                "name": name,
                "version": version,
                "license": license_expression or "NOASSERTION",
                "metadata_status": (
                    "complete" if license_expression else "manual-review-required-no-declared-license"
                ),
                "metadata_sha256": sha256_file(metadata),
                "license_evidence": [
                    _resource_evidence(app_path, path)
                    for path in evidence_files
                ],
            }
        )
    names = {record["name"].lower() for record in records}
    if not {"pip", "setuptools"}.issubset(names):
        raise RuntimeError(
            f"Embedded Python {architecture} must inventory at least pip and setuptools dist-info metadata."
        )
    return records


def discover_xhs_card_npm_packages(app_path: Path, xhs_root: Path) -> list[dict[str, Any]]:
    """Enumerate the complete lock-bound xhs-card production node_modules tree."""
    expected = _xhs_lock_expected_packages(xhs_root)
    if not _xhs_installed_matches_lock(xhs_root, expected):
        raise RuntimeError("Packaged xhs-card node_modules does not match its package-lock production closure.")
    node_modules = xhs_root / "node_modules"
    package_lock_sha256 = sha256_file(xhs_root / "package-lock.json")
    records: list[dict[str, Any]] = []
    for package_json in sorted(node_modules.rglob("package.json")):
        relative = package_json.relative_to(node_modules)
        if not _is_node_package_manifest(relative):
            continue
        if package_json.is_symlink() or package_json.parent.is_symlink():
            raise RuntimeError(f"Packaged xhs-card npm manifest is unsafe: {relative}")
        payload = _load_json_object(package_json, "xhs-card shipped npm package metadata")
        name = str(payload.get("name") or "").strip()
        version = str(payload.get("version") or "").strip()
        license_expression = _license_expression(payload)
        if not name or not version or not license_expression:
            raise RuntimeError(
                "Packaged xhs-card npm package lacks auditable name/version/license metadata: "
                + relative.parent.as_posix()
            )
        package_root = package_json.parent
        evidence_files = _recursive_license_notice_files(package_root)
        if not evidence_files:
            raise RuntimeError(f"Packaged xhs-card npm package lacks LICENSE/NOTICE evidence: {name}")
        package_path = (Path("node_modules") / relative.parent).as_posix()
        records.append(
            {
                "component_id": f"xhs-card-npm:{package_path}",
                "package_path": package_path,
                "name": name,
                "version": version,
                "license": license_expression,
                "package_json_sha256": sha256_file(package_json),
                "package_lock_sha256": package_lock_sha256,
                "license_evidence": [
                    _resource_evidence(app_path, path)
                    for path in evidence_files
                ],
            }
        )
    if {record["package_path"] for record in records} != set(expected):
        raise RuntimeError("Packaged xhs-card npm inventory does not cover its exact lockfile closure.")
    return records


TIKOMNI_CONNECTOR_NOTICE_TEXT = """Echo Founder — TikOmni connector notice

The App ships a client-side caller/resolver/catalog subset, not the TikOmni
service, accounts, credentials, returned data, or platform sessions.

The official upstream @tikomni/skills 1.0.7 declares MIT at:
https://github.com/mark-ly-wang/TikOmni-Skills/tree/253c98e267e1444aca33ccfea51661cc5a28076c
Its complete copyright and permission notice is preserved below.

The local approved snapshot echo-founder-tikomni-connector-2026-08-24 has nine
hash-bound files. Six match that upstream release. Three differ:
- scripts/core/tikomni_common.py
- references/api-catalog/aliases.json
- references/api-catalog/operations.json

The complete local snapshot remains NOASSERTION pending provenance review of
those differences. This does not remove the upstream MIT rights. Public or
broader redistribution still requires that review and compliance with the
separate provider service terms. No account or paid service is licensed by
including a connector. This notice does not certify release eligibility.

--- Upstream license, reproduced verbatim ---

MIT License

Copyright (c) 2026 TikOmni

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


ELECTRON_MACOS_MEASUREMENT = "code-signature-neutral-tree.v1"
ELECTRON_FRAMEWORKS_MEASUREMENT = "byte-exact-tree.v1"


def _runtime_tree_projection(
    root: Path,
    *,
    neutralize_macho_code_signatures: bool = False,
) -> dict[str, Any]:
    tree = runtime_tree_fingerprint(
        root,
        neutralize_macho_code_signatures=neutralize_macho_code_signatures,
    )
    return {
        field: tree[field]
        for field in ("tree_sha256", "file_count", "directory_count", "symlink_count", "size_bytes")
    }


def build_runtime_supply_chain_evidence(
    app_path: Path,
    *,
    package_architecture: str,
    electron_runtime: dict[str, Any],
    xhs_card_runtime: dict[str, Any],
    embedded_python_runtime: dict[str, Any],
) -> dict[str, Any]:
    """Project formal build inputs onto live, independently hashable payloads."""
    resources = app_path / "Contents" / "Resources"
    aifios_root = resources / "aifios"
    selected = package_architectures(package_architecture)
    next_dist = aifios_root / "ui" / DESKTOP_DIST_DIR
    next_manifest = read_next_build_manifest(next_dist)
    next_dependencies = next_manifest.get("dependency_provenance")
    if not isinstance(next_dependencies, dict):
        raise RuntimeError("Packaged Next build lacks isolated dependency provenance.")
    playwright_manifest_path = aifios_root / "runtime" / "playwright" / "manifest.json"
    playwright_manifest = _load_json_object(playwright_manifest_path, "packaged Playwright provenance")

    electron_supply = electron_runtime.get("supply_chain")
    electron_architectures = electron_supply.get("architectures") if isinstance(electron_supply, dict) else None
    if not isinstance(electron_architectures, dict):
        raise RuntimeError("Electron runtime lacks verified archive provenance.")
    projected_electron: dict[str, Any] = {}
    for architecture in selected:
        item = electron_architectures.get(architecture)
        if not isinstance(item, dict):
            raise RuntimeError(f"Electron runtime lacks {architecture} archive provenance.")
        projected_electron[architecture] = {
            field: item.get(field)
            for field in (
                "version",
                "architecture",
                "source_url",
                "archive_sha256",
                "archive_source",
                "rebuild_mode",
                "extracted_tree_sha256",
                "notice_sha256",
            )
        }

    python_architectures = embedded_python_runtime.get("architectures")
    if not isinstance(python_architectures, dict):
        raise RuntimeError("Embedded Python runtime lacks architecture provenance.")
    projected_python: dict[str, Any] = {}
    for architecture in selected:
        item = python_architectures.get(architecture)
        source = item.get("source") if isinstance(item, dict) else None
        if not isinstance(item, dict) or not isinstance(source, dict):
            raise RuntimeError(f"Embedded Python runtime lacks {architecture} archive provenance.")
        runtime_root = aifios_root / "runtime" / "python" / architecture
        projected_python[architecture] = {
            "source": {
                field: source.get(field)
                for field in (
                    "version",
                    "architecture",
                    "source_url",
                    "archive_sha256",
                    "archive_source",
                    "rebuild_mode",
                )
            },
            "source_extracted_tree_sha256": item.get("source_extracted_tree_sha256"),
            "packaged_tree": _runtime_tree_projection(runtime_root),
        }

    xhs_root = aifios_root / "skills" / "xhs-card"
    payload = {
        "schema": RUNTIME_SUPPLY_CHAIN_SCHEMA,
        "package_architecture": package_architecture,
        "architectures": list(selected),
        "electron": {
            "rebuild_mode": "verified-archive-isolated-extract",
            "architectures": projected_electron,
            "archive_assembly_tree_sha256": electron_supply.get("assembled_tree_sha256"),
            "packaged_runtime": {
                "macos": {
                    "measurement": ELECTRON_MACOS_MEASUREMENT,
                    **_runtime_tree_projection(
                        app_path / "Contents" / "MacOS",
                        neutralize_macho_code_signatures=True,
                    ),
                },
                "frameworks": {
                    "measurement": ELECTRON_FRAMEWORKS_MEASUREMENT,
                    **_runtime_tree_projection(app_path / "Contents" / "Frameworks"),
                },
            },
        },
        "ui": {
            "rebuild_mode": "isolated-npm-ci-ignore-scripts-next-build",
            "dependency_provenance": next_dependencies,
            "packaged_standalone_tree": _runtime_tree_projection(next_standalone_root(next_dist)),
        },
        "xhs_card": {
            "rebuild_mode": xhs_card_runtime.get("status"),
            "package_lock_sha256": sha256_file(xhs_root / "package-lock.json"),
            "node_modules_tree": _runtime_tree_projection(xhs_root / "node_modules"),
        },
        "playwright": {
            "rebuild_mode": "approved-archive-isolated-extract",
            "manifest_sha256": sha256_file(playwright_manifest_path),
            "manifest": playwright_manifest,
        },
        "python": {
            "rebuild_mode": "approved-archive-isolated-extract",
            "version": DEFAULT_PYTHON_VERSION,
            "architectures": projected_python,
        },
    }
    assert_release_manifest_portable(payload)
    verify_runtime_supply_chain_payload(payload, app_path)
    return payload


def verify_runtime_supply_chain_payload(payload: dict[str, Any], app_path: Path) -> None:
    if payload.get("schema") != RUNTIME_SUPPLY_CHAIN_SCHEMA:
        raise RuntimeError("Runtime supply-chain evidence has an invalid schema.")
    package_architecture = str(payload.get("package_architecture") or "")
    selected = package_architectures(package_architecture)
    if payload.get("architectures") != list(selected):
        raise RuntimeError("Runtime supply-chain architecture projection is not exact.")
    resources = app_path / "Contents" / "Resources"
    aifios_root = resources / "aifios"

    electron = payload.get("electron")
    electron_items = electron.get("architectures") if isinstance(electron, dict) else None
    packaged_electron_runtime = electron.get("packaged_runtime") if isinstance(electron, dict) else None
    live_electron_runtime = {
        "macos": {
            "measurement": ELECTRON_MACOS_MEASUREMENT,
            **_runtime_tree_projection(
                app_path / "Contents" / "MacOS",
                neutralize_macho_code_signatures=True,
            ),
        },
        "frameworks": {
            "measurement": ELECTRON_FRAMEWORKS_MEASUREMENT,
            **_runtime_tree_projection(app_path / "Contents" / "Frameworks"),
        },
    }
    if (
        not isinstance(electron, dict)
        or electron.get("rebuild_mode") != "verified-archive-isolated-extract"
        or not isinstance(electron_items, dict)
        or set(electron_items) != set(selected)
        or not re.fullmatch(r"[a-f0-9]{64}", str(electron.get("archive_assembly_tree_sha256") or ""))
        or packaged_electron_runtime != live_electron_runtime
    ):
        raise RuntimeError("Electron runtime supply-chain projection is incomplete.")
    for architecture in selected:
        item = electron_items[architecture]
        version = str(item.get("version") or "") if isinstance(item, dict) else ""
        archive_name = f"electron-v{version}-darwin-{architecture}.zip"
        expected_sha = electron_checksum(archive_name)
        expected_url = f"https://github.com/electron/electron/releases/download/v{version}/{archive_name}"
        if (
            not isinstance(item, dict)
            or item.get("architecture") != architecture
            or item.get("source_url") != expected_url
            or item.get("archive_sha256") != expected_sha
            or item.get("rebuild_mode") != "isolated-extract-every-build"
            or item.get("archive_source") not in {
                "approved-download",
                "approved-verified-cache",
                "explicit-verified-archive",
            }
            or not re.fullmatch(r"[a-f0-9]{64}", str(item.get("extracted_tree_sha256") or ""))
        ):
            raise RuntimeError(f"Electron {architecture} archive provenance is invalid.")
        notice_hashes = item.get("notice_sha256")
        expected_notice_hashes = {
            "electron": sha256_file(resources / ELECTRON_ARCHIVE_LICENSE_RESOURCE),
            "chromium": sha256_file(resources / CHROMIUM_ARCHIVE_LICENSE_RESOURCE),
        }
        if notice_hashes != expected_notice_hashes:
            raise RuntimeError(f"Electron {architecture} notice provenance is invalid.")

    ui = payload.get("ui")
    next_dist = aifios_root / "ui" / DESKTOP_DIST_DIR
    next_manifest = read_next_build_manifest(next_dist)
    dependency_provenance = ui.get("dependency_provenance") if isinstance(ui, dict) else None
    if (
        not isinstance(ui, dict)
        or ui.get("rebuild_mode") != "isolated-npm-ci-ignore-scripts-next-build"
        or dependency_provenance != next_manifest.get("dependency_provenance")
        or not isinstance(dependency_provenance, dict)
        or dependency_provenance.get("mode") != "isolated-npm-ci-ignore-scripts"
        or dependency_provenance.get("package_lock_sha256") != APPROVED_UI_PACKAGE_LOCK_SHA256
        or not re.fullmatch(r"[a-f0-9]{64}", str(dependency_provenance.get("node_modules_tree_sha256") or ""))
        or ui.get("packaged_standalone_tree") != _runtime_tree_projection(next_standalone_root(next_dist))
    ):
        raise RuntimeError("UI isolated-build supply-chain projection does not match the packaged standalone tree.")

    xhs = payload.get("xhs_card")
    xhs_root = aifios_root / "skills" / "xhs-card"
    if (
        not isinstance(xhs, dict)
        or xhs.get("rebuild_mode") != "staged-clean-install"
        or xhs.get("package_lock_sha256") != APPROVED_XHS_CARD_PACKAGE_LOCK_SHA256
        or sha256_file(xhs_root / "package-lock.json") != APPROVED_XHS_CARD_PACKAGE_LOCK_SHA256
        or xhs.get("node_modules_tree") != _runtime_tree_projection(xhs_root / "node_modules")
    ):
        raise RuntimeError("xhs-card isolated npm closure provenance is invalid.")

    playwright = payload.get("playwright")
    playwright_manifest_path = aifios_root / "runtime" / "playwright" / "manifest.json"
    playwright_manifest = _load_json_object(playwright_manifest_path, "packaged Playwright provenance")
    if (
        not isinstance(playwright, dict)
        or playwright.get("rebuild_mode") != "approved-archive-isolated-extract"
        or playwright.get("manifest_sha256") != sha256_file(playwright_manifest_path)
        or playwright.get("manifest") != playwright_manifest
    ):
        raise RuntimeError("Playwright archive provenance does not match the packaged manifest.")
    verify_playwright_runtime(aifios_root, package_architecture)

    python = payload.get("python")
    python_items = python.get("architectures") if isinstance(python, dict) else None
    if (
        not isinstance(python, dict)
        or python.get("rebuild_mode") != "approved-archive-isolated-extract"
        or python.get("version") != DEFAULT_PYTHON_VERSION
        or not isinstance(python_items, dict)
        or set(python_items) != set(selected)
    ):
        raise RuntimeError("Python runtime supply-chain projection is incomplete.")
    for architecture in selected:
        item = python_items[architecture]
        source = item.get("source") if isinstance(item, dict) else None
        approved = APPROVED_PYTHON_RELEASES.get(DEFAULT_PYTHON_VERSION, {}).get(architecture)
        if (
            not isinstance(item, dict)
            or not isinstance(source, dict)
            or not isinstance(approved, dict)
            or source.get("version") != DEFAULT_PYTHON_VERSION
            or source.get("architecture") != architecture
            or source.get("source_url") != approved.get("url")
            or source.get("archive_sha256") != approved.get("sha256")
            or source.get("rebuild_mode") != "isolated-extract-every-build"
            or source.get("archive_source") not in {
                "approved-download",
                "approved-verified-cache",
                "explicit-verified-archive",
            }
            or not re.fullmatch(r"[a-f0-9]{64}", str(item.get("source_extracted_tree_sha256") or ""))
            or item.get("packaged_tree")
            != _runtime_tree_projection(aifios_root / "runtime" / "python" / architecture)
        ):
            raise RuntimeError(f"Python {architecture} archive provenance is invalid.")


def write_runtime_supply_chain_evidence(app_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    path = app_path / "Contents" / "Resources" / "aifios" / RUNTIME_SUPPLY_CHAIN_RELATIVE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return verify_runtime_supply_chain_evidence(app_path)


def verify_runtime_supply_chain_evidence(app_path: Path) -> dict[str, Any]:
    path = app_path / "Contents" / "Resources" / "aifios" / RUNTIME_SUPPLY_CHAIN_RELATIVE_PATH
    payload = _load_json_object(path, "runtime supply-chain evidence")
    assert_release_manifest_portable(payload)
    verify_runtime_supply_chain_payload(payload, app_path)
    return {
        "schema": RUNTIME_SUPPLY_CHAIN_SCHEMA,
        "evidence": _resource_evidence(app_path, path),
        "payload": payload,
    }


def write_shipped_dependency_inventory(
    app_path: Path,
    *,
    product_version: str,
    python_version: str,
    package_architecture: str,
    electron_versions: dict[str, str] | None = None,
    runtime_supply_chain: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a machine-readable inventory from the files actually in the App."""
    resources = app_path / "Contents" / "Resources"
    aifios_root = resources / "aifios"
    notices = aifios_root / SHIPPED_NOTICE_DIR
    notices.mkdir(parents=True, exist_ok=True)
    live_runtime_supply_chain: dict[str, Any] | None = None
    if runtime_supply_chain is not None:
        live_runtime_supply_chain = verify_runtime_supply_chain_evidence(app_path)
        if runtime_supply_chain != live_runtime_supply_chain:
            raise RuntimeError("Runtime supply-chain evidence changed before dependency inventory generation.")
    electron_license = aifios_root / ELECTRON_LICENSE_NOTICE
    chromium_licenses = aifios_root / CHROMIUM_LICENSE_NOTICE
    for source, target in (
        (resources / ELECTRON_ARCHIVE_LICENSE_RESOURCE, electron_license),
        (resources / CHROMIUM_ARCHIVE_LICENSE_RESOURCE, chromium_licenses),
    ):
        if not source.is_file() or source.is_symlink():
            raise RuntimeError(f"Required Electron distribution notice is missing: {source}")
        shutil.copy2(source, target)

    standalone_root = next_standalone_root(aifios_root / "ui" / DESKTOP_DIST_DIR)
    next_notice = aifios_root / NEXT_STANDALONE_NOTICE
    npm_packages = write_next_standalone_notice(standalone_root, next_notice)
    tikomni_notice = aifios_root / TIKOMNI_CONNECTOR_NOTICE
    tikomni_notice.write_text(TIKOMNI_CONNECTOR_NOTICE_TEXT, encoding="utf-8")

    versions = electron_versions or electron_process_versions(app_path)
    for field in ("electron", "chrome", "node"):
        if not str(versions.get(field) or "").strip():
            raise RuntimeError(f"Shipped dependency inventory lacks Electron process version: {field}")

    components: list[dict[str, Any]] = [
        {
            "id": "electron",
            "name": "Electron",
            "version": versions["electron"],
            "kind": "desktop-runtime",
            "license": "MIT",
            "shipped_path": "Contents/MacOS",
            "evidence": [_resource_evidence(app_path, electron_license)],
            "review_status": "notice-bundled",
        },
        {
            "id": "chromium-electron",
            "name": "Chromium embedded by Electron",
            "version": versions["chrome"],
            "kind": "browser-runtime",
            "license": "BSD-3-Clause AND bundled-third-party-licenses",
            "shipped_path": "Contents/Frameworks/Electron Framework.framework",
            "evidence": [_resource_evidence(app_path, chromium_licenses)],
            "review_status": "notice-bundled",
        },
        {
            "id": "node-electron",
            "name": "Node.js embedded by Electron",
            "version": versions["node"],
            "kind": "javascript-runtime",
            "license": "MIT",
            "shipped_path": "Contents/Frameworks/Electron Framework.framework",
            "evidence": [_resource_evidence(app_path, electron_license), _resource_evidence(app_path, chromium_licenses)],
            "review_status": "covered-by-electron-distribution-notices",
        },
    ]

    next_package = next(
        item
        for item in npm_packages
        if item["package_path"] == "node_modules/next" and item["name"] == "next"
    )
    components.append(
        {
            "id": "next-standalone",
            "name": "Next.js standalone production runtime",
            "version": next_package["version"],
            "kind": "web-application-runtime",
            "license": next_package["license"],
            "shipped_path": "Contents/Resources/aifios/ui/.next-desktop/standalone",
            "evidence": [_resource_evidence(app_path, next_notice)],
            "review_status": "package-inventory-bundled",
        }
    )

    python_root = aifios_root / "runtime" / "python"
    python_distributions: list[dict[str, Any]] = []
    for architecture in package_architectures(package_architecture):
        runtime_root = python_root / architecture
        if not runtime_root.is_dir():
            continue
        license_files = sorted(runtime_root.glob("lib/python*/LICENSE.txt"))
        if len(license_files) != 1:
            raise RuntimeError(f"Embedded Python {architecture} lacks one unambiguous LICENSE.txt: {runtime_root}")
        components.append(
            {
                "id": f"cpython:{architecture}",
                "name": f"CPython ({architecture})",
                "version": python_version,
                "kind": "python-runtime",
                "license": "Python-2.0",
                "shipped_path": (Path("Contents/Resources") / runtime_root.relative_to(resources)).as_posix(),
                "evidence": [_resource_evidence(app_path, license_files[0])],
                "review_status": "runtime-license-bundled",
            }
        )
        architecture_distributions = discover_python_distributions(app_path, runtime_root, architecture)
        python_distributions.extend(architecture_distributions)
        for distribution in architecture_distributions:
            components.append(
                {
                    "id": distribution["component_id"],
                    "name": distribution["name"],
                    "version": distribution["version"],
                    "kind": "python-distribution",
                    "license": distribution["license"],
                    "shipped_path": "Contents/Resources/" + distribution["dist_info_path"],
                    "evidence": distribution["license_evidence"],
                    "metadata_sha256": distribution["metadata_sha256"],
                    "review_status": (
                        "dist-info-license-evidence-bundled"
                        if distribution["metadata_status"] == "complete"
                        else distribution["metadata_status"]
                    ),
                }
            )

    xhs_root = aifios_root / "skills" / "xhs-card"
    xhs_package = _load_json_object(xhs_root / "package.json", "xhs-card package metadata")
    xhs_evidence = [
        _resource_evidence(app_path, xhs_root / name)
        for name in ("LICENSE", "README.md", "README.en.md", "MODIFICATIONS.md", "package-lock.json")
    ]
    xhs_package_lock_sha256 = sha256_file(xhs_root / "package-lock.json")
    components.append(
        {
            "id": "xhs-card",
            "name": str(xhs_package.get("name") or "xhs-card"),
            "version": str(xhs_package.get("version") or "").strip(),
            "kind": "visual-rendering-source",
            "license": _license_expression(xhs_package),
            "shipped_path": (Path("Contents/Resources") / xhs_root.relative_to(resources)).as_posix(),
            "evidence": xhs_evidence,
            "source_availability": "complete packaged source is in shipped_path; bundled evidence includes LICENSE, both READMEs and MODIFICATIONS",
            "package_lock_sha256": xhs_package_lock_sha256,
            "review_status": "agpl-source-bundled-commercial-and-network-use-review-required",
        }
    )
    if not components[-1]["version"] or components[-1]["license"] != "AGPL-3.0-only":
        raise RuntimeError("xhs-card shipped source must declare version and AGPL-3.0-only.")
    xhs_card_npm_packages = discover_xhs_card_npm_packages(app_path, xhs_root)
    for package in xhs_card_npm_packages:
        components.append(
            {
                "id": package["component_id"],
                "name": package["name"],
                "version": package["version"],
                "kind": "xhs-card-browser-automation-runtime",
                "license": package["license"],
                "shipped_path": (
                    Path("Contents/Resources") / xhs_root.relative_to(resources) / package["package_path"]
                ).as_posix(),
                "evidence": package["license_evidence"],
                "package_json_sha256": package["package_json_sha256"],
                "package_lock_sha256": package["package_lock_sha256"],
                "review_status": "lock-bound-license-and-notice-bundled",
            }
        )

    shipped_baoyu_skills = [
        name
        for name in ("baoyu-diagram", "baoyu-comic")
        if (aifios_root / "skills" / name).is_dir()
    ]
    providers_by_id: dict[str, Any] = {}
    if shipped_baoyu_skills:
        visual_providers_path = aifios_root / "skills" / "content-runtime" / "config" / "visual_providers.json"
        try:
            visual_providers = json.loads(visual_providers_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Packaged visual provider registry is missing or invalid: {visual_providers_path}") from exc
        if not isinstance(visual_providers, list):
            raise RuntimeError("Packaged visual provider registry must be a list.")
        providers_by_id = {
            str(item.get("id") or ""): item
            for item in visual_providers
            if isinstance(item, dict) and item.get("id")
        }
    for skill_name in shipped_baoyu_skills:
        skill_root = aifios_root / "skills" / skill_name
        provider = providers_by_id.get(skill_name)
        if not isinstance(provider, dict):
            raise RuntimeError(f"Shipped third-party skill lacks provider provenance: {skill_name}")
        revision = str(provider.get("pinned_revision") or "").strip()
        license_expression = str(provider.get("license") or "").strip()
        if not revision or license_expression != "MIT":
            raise RuntimeError(f"Shipped third-party skill has incomplete version/license metadata: {skill_name}")
        components.append(
            {
                "id": skill_name,
                "name": skill_name,
                "version": revision,
                "kind": "visual-skill-source",
                "license": license_expression,
                "shipped_path": (Path("Contents/Resources") / skill_root.relative_to(resources)).as_posix(),
                "evidence": [_resource_evidence(app_path, skill_root / "LICENSE")],
                "review_status": "vendored-license-bundled",
            }
        )

    playwright_manifest = _load_json_object(
        aifios_root / "runtime" / "playwright" / "manifest.json",
        "Playwright headless-shell manifest",
    )
    revision = str(playwright_manifest.get("headless_shell_revision") or "").strip()
    entries = playwright_manifest.get("architectures")
    if not revision or not isinstance(entries, dict):
        raise RuntimeError("Playwright headless-shell manifest lacks revision/architectures.")
    for architecture in package_architectures(package_architecture):
        if not isinstance(entries.get(architecture), dict):
            raise RuntimeError(f"Playwright headless-shell inventory lacks {architecture}.")
        runtime_dir = aifios_root / "runtime" / "playwright" / architecture
        license_path = runtime_dir / "LICENSE.headless_shell"
        components.append(
            {
                "id": f"chromium-headless-shell:{architecture}",
                "name": f"Chromium headless shell ({architecture})",
                "version": f"playwright-revision-{revision}",
                "kind": "headless-browser-runtime",
                "license": "BSD-3-Clause AND bundled-third-party-licenses",
                "shipped_path": (Path("Contents/Resources") / runtime_dir.relative_to(resources)).as_posix(),
                "evidence": [_resource_evidence(app_path, license_path)],
                "review_status": "headless-shell-notice-bundled",
            }
        )

    tikomni_root = aifios_root / "skills" / TIKOMNI_SKILL_NAME
    tikomni_snapshot = verify_tikomni_social_media_crawl(tikomni_root)
    tikomni_evidence = [_resource_evidence(app_path, tikomni_notice)]
    tikomni_evidence.extend(_resource_evidence(app_path, tikomni_root / item) for item in TIKOMNI_BUNDLE_FILES)
    components.append(
        {
            "id": "tikomni-connector",
            "name": "TikOmni API connector subset",
            "version": tikomni_snapshot["snapshot_id"],
            "kind": "external-service-connector",
            "license": "NOASSERTION",
            "shipped_path": (Path("Contents/Resources") / tikomni_root.relative_to(resources)).as_posix(),
            "evidence": tikomni_evidence,
            "service_shipped": False,
            "credentials_shipped": False,
            "approved_snapshot_sha256": tikomni_snapshot["snapshot_sha256"],
            "approved_file_sha256": tikomni_snapshot["file_sha256"],
            "review_status": "manual-review-required-local-snapshot-provenance",
        }
    )

    review_boundaries: list[dict[str, str]] = [
        {
            "id": "xhs-card-agpl",
            "status": "manual-review-required",
            "reason": "Preserve AGPL source availability and assess modified network-service use before distribution changes.",
        },
        {
            "id": "tikomni-connector-license-and-service-terms",
            "status": "manual-review-required",
            "reason": "Upstream MIT notice is bundled; three changed local snapshot files and external service terms still require provenance and authorization review.",
        },
    ]
    for package in npm_packages:
        if package["metadata_missing"]:
            review_boundaries.append(
                {
                    "id": _npm_review_boundary_id("package-metadata", package),
                    "status": "manual-review-required",
                    "reason": (
                        "Physical package.json has incomplete declared metadata: "
                        + ", ".join(package["metadata_missing"])
                        + "."
                    ),
                }
            )
        if package["license_evidence_mode"] == "metadata-only-review-required":
            review_boundaries.append(
                {
                    "id": _npm_review_boundary_id("license-text", package),
                    "status": "manual-review-required",
                    "reason": "The physical manifest directory contains no discrete LICENSE/NOTICE text.",
                }
            )
    for distribution in python_distributions:
        if distribution["metadata_status"] != "complete":
            review_boundaries.append(
                {
                    "id": f"python-license-metadata:{distribution['architecture']}:{distribution['dist_info_path']}",
                    "status": "manual-review-required",
                    "reason": "Python dist-info ships license evidence but declares no machine-readable license expression.",
                }
            )

    key_notice_paths = [
        electron_license,
        chromium_licenses,
        next_notice,
        tikomni_notice,
        aifios_root / "docs" / "third-party-notices.md",
        xhs_root / "LICENSE",
        xhs_root / "README.md",
        xhs_root / "README.en.md",
        xhs_root / "MODIFICATIONS.md",
        xhs_root / "package-lock.json",
        *(aifios_root / "skills" / name / "LICENSE" for name in ("baoyu-diagram", "baoyu-comic") if (aifios_root / "skills" / name).is_dir()),
        *(
            resources / evidence["path"]
            for package in xhs_card_npm_packages
            for evidence in package["license_evidence"]
        ),
        *(
            resources / evidence["path"]
            for distribution in python_distributions
            for evidence in distribution["license_evidence"]
        ),
        *(
            [aifios_root / RUNTIME_SUPPLY_CHAIN_RELATIVE_PATH]
            if live_runtime_supply_chain is not None
            else []
        ),
    ]
    key_notices = {
        evidence["path"]: evidence["sha256"]
        for evidence in (_resource_evidence(app_path, path) for path in key_notice_paths)
    }
    inventory = {
        "schema": SHIPPED_DEPENDENCY_INVENTORY_SCHEMA,
        "product": DEFAULT_APP_NAME,
        "product_version": product_version,
        "distribution_scope": "internal-beta",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "components": components,
        "next_standalone_npm_packages": npm_packages,
        "xhs_card_package_lock_sha256": xhs_package_lock_sha256,
        "xhs_card_npm_packages": xhs_card_npm_packages,
        "python_distributions": python_distributions,
        "tikomni_approved_snapshot": {
            "snapshot_id": tikomni_snapshot["snapshot_id"],
            "snapshot_sha256": tikomni_snapshot["snapshot_sha256"],
            "file_sha256": tikomni_snapshot["file_sha256"],
        },
        **(
            {"runtime_supply_chain": live_runtime_supply_chain}
            if live_runtime_supply_chain is not None
            else {}
        ),
        "key_notices": key_notices,
        "review_boundaries": review_boundaries,
        "not_shipped": [
            "TikOmni service/backend, customer account, token, API data and platform sessions",
            "model-provider services and customer API keys",
            "Node/npm development dependency tree outside the traced Next standalone runtime",
            "motion-media engine or automatic public-posting service",
        ],
        "legal_note": "Inventory and notices are audit artifacts, not legal advice or a grant of rights.",
    }
    assert_release_manifest_portable(inventory)
    inventory_path = aifios_root / SHIPPED_DEPENDENCY_INVENTORY_RELATIVE_PATH
    inventory_path.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return verify_shipped_dependency_inventory(app_path)


def _verified_inventory_evidence(app_path: Path, evidence: Any) -> dict[str, Any]:
    if not isinstance(evidence, dict):
        raise RuntimeError("Shipped dependency inventory contains an invalid evidence record.")
    relative = str(evidence.get("path") or "")
    parts = tuple(relative.split("/"))
    if not parts or any(not part or part in {".", ".."} or "\\" in part for part in parts):
        raise RuntimeError(f"Shipped dependency inventory contains an unsafe evidence path: {relative!r}")
    resources = app_path / "Contents" / "Resources"
    path = resources.joinpath(*parts)
    actual = _resource_evidence(app_path, path)
    if evidence.get("sha256") != actual["sha256"] or evidence.get("size_bytes") != actual["size_bytes"]:
        raise RuntimeError(f"Shipped dependency evidence hash/size mismatch: {relative}")
    return actual


def verify_shipped_dependency_inventory(app_path: Path) -> dict[str, Any]:
    resources = app_path / "Contents" / "Resources"
    aifios_root = resources / "aifios"
    inventory_path = aifios_root / SHIPPED_DEPENDENCY_INVENTORY_RELATIVE_PATH
    if inventory_path.is_symlink():
        raise RuntimeError("Shipped dependency inventory must not be a symlink.")
    inventory = _load_json_object(inventory_path, "Shipped dependency inventory")
    assert_release_manifest_portable(inventory)
    if inventory.get("schema") != SHIPPED_DEPENDENCY_INVENTORY_SCHEMA:
        raise RuntimeError("Shipped dependency inventory schema is unsupported.")
    recorded_runtime_supply_chain = inventory.get("runtime_supply_chain")
    live_runtime_supply_chain: dict[str, Any] | None = None
    if recorded_runtime_supply_chain is not None:
        live_runtime_supply_chain = verify_runtime_supply_chain_evidence(app_path)
        if recorded_runtime_supply_chain != live_runtime_supply_chain:
            raise RuntimeError("Shipped dependency inventory runtime supply-chain projection is stale or forged.")
    components = inventory.get("components")
    if not isinstance(components, list) or not all(isinstance(item, dict) for item in components):
        raise RuntimeError("Shipped dependency inventory components must be objects.")
    component_ids = [str(item.get("id") or "") for item in components]
    if not all(component_ids) or len(component_ids) != len(set(component_ids)):
        raise RuntimeError("Shipped dependency inventory component ids are missing or duplicated.")
    required = {
        "electron",
        "chromium-electron",
        "node-electron",
        "next-standalone",
        "xhs-card",
        "tikomni-connector",
    }
    required.update(
        name
        for name in ("baoyu-diagram", "baoyu-comic")
        if (aifios_root / "skills" / name).is_dir()
    )
    playwright_manifest = _load_json_object(
        aifios_root / "runtime" / "playwright" / "manifest.json",
        "Playwright headless-shell manifest",
    )
    entries = playwright_manifest.get("architectures")
    if not isinstance(entries, dict) or not entries:
        raise RuntimeError("Playwright headless-shell manifest has no shipped architectures.")
    required.update(f"chromium-headless-shell:{architecture}" for architecture in entries)
    python_root = aifios_root / "runtime" / "python"
    live_python_distributions: list[dict[str, Any]] = []
    if python_root.is_dir():
        for path in sorted(item for item in python_root.iterdir() if item.is_dir()):
            required.add(f"cpython:{path.name}")
            distributions = discover_python_distributions(app_path, path, path.name)
            live_python_distributions.extend(distributions)
            required.update(item["component_id"] for item in distributions)
    recorded_python_distributions = inventory.get("python_distributions")
    if recorded_python_distributions != live_python_distributions:
        raise RuntimeError("Shipped Python dist-info inventory does not match the live embedded runtime.")

    xhs_root = aifios_root / "skills" / "xhs-card"
    live_xhs_packages = discover_xhs_card_npm_packages(app_path, xhs_root)
    if inventory.get("xhs_card_npm_packages") != live_xhs_packages:
        raise RuntimeError("Shipped xhs-card npm inventory does not match the live lock-bound tree.")
    live_xhs_lock_sha256 = sha256_file(xhs_root / "package-lock.json")
    if inventory.get("xhs_card_package_lock_sha256") != live_xhs_lock_sha256:
        raise RuntimeError("Shipped xhs-card package-lock digest does not match the live tree.")
    required.update(item["component_id"] for item in live_xhs_packages)
    missing = sorted(required - set(component_ids))
    if missing:
        raise RuntimeError("Shipped dependency inventory lacks required components: " + ", ".join(missing))
    for component in components:
        if not all(str(component.get(field) or "").strip() for field in ("name", "version", "kind", "license", "shipped_path", "review_status")):
            raise RuntimeError(f"Shipped dependency component metadata is incomplete: {component.get('id')}")
        shipped_path = str(component["shipped_path"])
        shipped_parts = tuple(shipped_path.split("/"))
        if not shipped_parts or any(
            not part or part in {".", ".."} or "\\" in part
            for part in shipped_parts
        ):
            raise RuntimeError(f"Shipped dependency component has an unsafe shipped_path: {component.get('id')}")
        shipped_target = app_path.joinpath(*shipped_parts)
        try:
            shipped_target.resolve(strict=True).relative_to(app_path.resolve(strict=True))
        except (OSError, ValueError) as exc:
            raise RuntimeError(
                f"Shipped dependency component path is absent or escapes the App: {component.get('id')}"
            ) from exc
        evidence = component.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            raise RuntimeError(f"Shipped dependency component lacks evidence: {component.get('id')}")
        for record in evidence:
            _verified_inventory_evidence(app_path, record)

    components_by_id = {str(item["id"]): item for item in components}
    for package in live_xhs_packages:
        component = components_by_id[package["component_id"]]
        expected = {
            "name": package["name"],
            "version": package["version"],
            "license": package["license"],
            "package_json_sha256": package["package_json_sha256"],
            "package_lock_sha256": package["package_lock_sha256"],
            "evidence": package["license_evidence"],
        }
        if any(component.get(field) != value for field, value in expected.items()):
            raise RuntimeError(f"xhs-card npm component metadata drifted from its live package: {package['name']}")
    for distribution in live_python_distributions:
        component = components_by_id[distribution["component_id"]]
        expected = {
            "name": distribution["name"],
            "version": distribution["version"],
            "license": distribution["license"],
            "metadata_sha256": distribution["metadata_sha256"],
            "evidence": distribution["license_evidence"],
        }
        if any(component.get(field) != value for field, value in expected.items()):
            raise RuntimeError(
                f"Python distribution component metadata drifted from live dist-info: {distribution['name']}"
            )

    tikomni = next(item for item in components if item["id"] == "tikomni-connector")
    live_tikomni = verify_tikomni_social_media_crawl(aifios_root / "skills" / TIKOMNI_SKILL_NAME)
    if (
        tikomni.get("license") != "NOASSERTION"
        or tikomni.get("version") != live_tikomni["snapshot_id"]
        or tikomni.get("approved_snapshot_sha256") != live_tikomni["snapshot_sha256"]
        or tikomni.get("approved_file_sha256") != live_tikomni["file_sha256"]
        or tikomni.get("service_shipped") is not False
        or tikomni.get("credentials_shipped") is not False
        or "manual-review-required" not in str(tikomni.get("review_status"))
    ):
        raise RuntimeError("TikOmni connector must retain its no-license-assertion/service boundary.")
    if inventory.get("tikomni_approved_snapshot") != {
        "snapshot_id": live_tikomni["snapshot_id"],
        "snapshot_sha256": live_tikomni["snapshot_sha256"],
        "file_sha256": live_tikomni["file_sha256"],
    }:
        raise RuntimeError("TikOmni approved snapshot inventory does not match the live connector bytes.")
    xhs = next(item for item in components if item["id"] == "xhs-card")
    if (
        xhs.get("license") != "AGPL-3.0-only"
        or xhs.get("package_lock_sha256") != live_xhs_lock_sha256
        or "complete packaged source" not in str(xhs.get("source_availability"))
    ):
        raise RuntimeError("xhs-card must retain AGPL source-availability metadata.")

    recorded_packages = inventory.get("next_standalone_npm_packages")
    if not isinstance(recorded_packages, list):
        raise RuntimeError("Shipped dependency inventory has no Next npm package inventory.")
    live_packages, expected_next_notice = render_next_standalone_notice(
        next_standalone_root(aifios_root / "ui" / DESKTOP_DIST_DIR)
    )
    if recorded_packages != live_packages:
        raise RuntimeError("Shipped dependency inventory does not match the live Next standalone npm tree.")
    next_notice_path = aifios_root / NEXT_STANDALONE_NOTICE
    try:
        actual_next_notice = next_notice_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise RuntimeError("Shipped Next notice aggregate is missing or invalid.") from exc
    if actual_next_notice != expected_next_notice:
        raise RuntimeError("Shipped Next notice aggregate does not match live package evidence sections.")
    for item in recorded_packages:
        if item.get("license_evidence_mode") not in {"full-text-aggregate", "metadata-only-review-required"}:
            raise RuntimeError(f"Next npm package has no auditable license evidence mode: {item.get('name')}")
        if item.get("notice_path") != (Path("aifios") / NEXT_STANDALONE_NOTICE).as_posix():
            raise RuntimeError(f"Next npm package is not linked to the shipped notice aggregate: {item.get('name')}")
        hashes = item.get("license_text_sha256")
        if item["license_evidence_mode"] == "full-text-aggregate":
            if not isinstance(hashes, list) or not hashes or not all(
                isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)
                for value in hashes
            ):
                raise RuntimeError(f"Next npm full-text evidence has no non-empty hashes: {item.get('name')}")
        elif hashes != []:
            raise RuntimeError(f"Next npm metadata-only evidence must have an empty hash list: {item.get('name')}")

    key_notices = inventory.get("key_notices")
    if not isinstance(key_notices, dict):
        raise RuntimeError("Shipped dependency inventory key_notices must be an object.")
    required_notice_paths = {
        (Path("aifios") / ELECTRON_LICENSE_NOTICE).as_posix(),
        (Path("aifios") / CHROMIUM_LICENSE_NOTICE).as_posix(),
        (Path("aifios") / NEXT_STANDALONE_NOTICE).as_posix(),
        (Path("aifios") / TIKOMNI_CONNECTOR_NOTICE).as_posix(),
        "aifios/docs/third-party-notices.md",
        "aifios/skills/xhs-card/LICENSE",
        "aifios/skills/xhs-card/README.md",
        "aifios/skills/xhs-card/README.en.md",
        "aifios/skills/xhs-card/MODIFICATIONS.md",
        "aifios/skills/xhs-card/package-lock.json",
    }
    if live_runtime_supply_chain is not None:
        required_notice_paths.add((Path("aifios") / RUNTIME_SUPPLY_CHAIN_RELATIVE_PATH).as_posix())
    required_notice_paths.update(
        evidence["path"]
        for package in live_xhs_packages
        for evidence in package["license_evidence"]
    )
    required_notice_paths.update(
        evidence["path"]
        for distribution in live_python_distributions
        for evidence in distribution["license_evidence"]
    )
    if not required_notice_paths.issubset(key_notices):
        raise RuntimeError(
            "Shipped dependency inventory lacks key notice hashes: "
            + ", ".join(sorted(required_notice_paths - set(key_notices)))
        )
    for relative, expected_hash in key_notices.items():
        parts = tuple(str(relative).split("/"))
        if not parts or any(not part or part in {".", ".."} or "\\" in part for part in parts):
            raise RuntimeError(f"Shipped dependency inventory contains an unsafe key notice path: {relative!r}")
        actual = _resource_evidence(app_path, resources.joinpath(*parts))
        if actual["sha256"] != expected_hash:
            raise RuntimeError(f"Shipped key notice digest mismatch: {relative}")

    boundaries = inventory.get("review_boundaries")
    boundary_ids = {
        str(item.get("id") or "")
        for item in boundaries
        if isinstance(item, dict) and item.get("status") == "manual-review-required"
    } if isinstance(boundaries, list) else set()
    required_boundary_ids = {"xhs-card-agpl", "tikomni-connector-license-and-service-terms"}
    for package in live_packages:
        if package["metadata_missing"]:
            required_boundary_ids.add(_npm_review_boundary_id("package-metadata", package))
        if package["license_evidence_mode"] == "metadata-only-review-required":
            required_boundary_ids.add(_npm_review_boundary_id("license-text", package))
    for distribution in live_python_distributions:
        if distribution["metadata_status"] != "complete":
            required_boundary_ids.add(
                f"python-license-metadata:{distribution['architecture']}:{distribution['dist_info_path']}"
            )
    if not required_boundary_ids.issubset(boundary_ids):
        raise RuntimeError(
            "Shipped dependency inventory omits matching manual-review boundaries: "
            + ", ".join(sorted(required_boundary_ids - boundary_ids))
        )
    return {
        "schema": SHIPPED_DEPENDENCY_INVENTORY_SCHEMA,
        "inventory_path": (Path("aifios") / SHIPPED_DEPENDENCY_INVENTORY_RELATIVE_PATH).as_posix(),
        "inventory_sha256": sha256_file(inventory_path),
        "component_count": len(components),
        "npm_package_count": len(recorded_packages),
        "xhs_card_npm_package_count": len(live_xhs_packages),
        "xhs_card_package_lock_sha256": live_xhs_lock_sha256,
        "python_distribution_count": len(live_python_distributions),
        "tikomni_snapshot_id": live_tikomni["snapshot_id"],
        "tikomni_snapshot_sha256": live_tikomni["snapshot_sha256"],
        "tikomni_file_sha256": live_tikomni["file_sha256"],
        "runtime_supply_chain": live_runtime_supply_chain,
        "key_notice_hashes": dict(sorted(key_notices.items())),
        "review_boundaries": sorted(boundary_ids),
        "status": "pass-with-declared-review-boundaries",
    }


def _code_signature_neutral_macho_bytes(path: Path) -> bytes:
    """Return Mach-O code bytes without the mutable embedded signature blob."""
    if not macho_architectures(path):
        return path.read_bytes()
    codesign = shutil.which("codesign")
    if not codesign:
        raise RuntimeError("Mach-O supply-chain measurement requires codesign.")
    with tempfile.TemporaryDirectory(prefix="echo-founder-neutral-macho-") as temporary_dir:
        staged = Path(temporary_dir) / path.name
        shutil.copy2(path, staged, follow_symlinks=False)
        if sha256_file(staged) != sha256_file(path):
            raise RuntimeError(
                f"Mach-O changed while its supply-chain snapshot was captured: {path.name}"
            )
        signature_present, signature_output = run_capture([codesign, "-d", str(staged)], timeout=60)
        if not signature_present:
            if "not signed at all" in signature_output.lower():
                return staged.read_bytes()
            raise RuntimeError(
                f"Unable to inspect the Mach-O signature before supply-chain measurement: {path.name}"
            )
        removed, _remove_output = run_capture(
            [codesign, "--remove-signature", str(staged)],
            timeout=60,
        )
        if not removed:
            raise RuntimeError(
                f"Unable to normalize the Mach-O signature for supply-chain measurement: {path.name}"
            )
        return staged.read_bytes()


def runtime_tree_fingerprint(
    root: Path,
    *,
    neutralize_macho_code_signatures: bool = False,
) -> dict[str, Any]:
    """Digest every shipped runtime entry, including links and executable bits."""
    if not root.is_dir() or root.is_symlink():
        raise RuntimeError(f"Shipped runtime root is missing or unsafe: {root}")
    digest = hashlib.sha256(b"echo-founder.runtime-tree.v1\0")
    file_count = 0
    directory_count = 0
    symlink_count = 0
    total_bytes = 0
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        if stat.S_ISLNK(metadata.st_mode):
            symlink_count += 1
            digest.update(b"link\0")
            digest.update(os.readlink(path).encode("utf-8"))
        elif stat.S_ISDIR(metadata.st_mode):
            directory_count += 1
            digest.update(b"dir\0")
        elif stat.S_ISREG(metadata.st_mode):
            file_count += 1
            digest.update(b"file\0")
            digest.update(str(stat.S_IMODE(metadata.st_mode) & 0o111).encode("ascii"))
            digest.update(b"\0")
            if neutralize_macho_code_signatures:
                measured_bytes = _code_signature_neutral_macho_bytes(path)
                total_bytes += len(measured_bytes)
                digest.update(measured_bytes)
            else:
                total_bytes += metadata.st_size
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
        else:
            raise RuntimeError(f"Shipped runtime contains an unsupported file type: {path}")
        digest.update(b"\0")
    app_bundle = root.parents[2].name if len(root.parents) >= 3 and root.parents[2].suffix == ".app" else f"{DEFAULT_APP_NAME}.app"
    return {
        "schema": "echo-founder.shipped-runtime-tree.v1",
        "root": f"{app_bundle}/Contents/Resources/aifios",
        "tree_sha256": digest.hexdigest(),
        "file_count": file_count,
        "directory_count": directory_count,
        "symlink_count": symlink_count,
        "size_bytes": total_bytes,
    }


def verify_package_traceability(
    manifest_path: Path,
    app_path: Path,
    *,
    require_clean_source: bool = False,
) -> dict[str, Any]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Package traceability manifest is missing or invalid: {manifest_path}") from exc
    if not isinstance(manifest, dict):
        raise RuntimeError("Package traceability manifest must be a JSON object.")
    assert_release_manifest_portable(manifest)
    source = manifest.get("source_control")
    recorded_qa_registry = manifest.get("trusted_qa_key_registry")
    runtime = manifest.get("shipped_runtime")
    recorded_inventory = manifest.get("shipped_dependency_inventory")
    recorded_supply_chain = manifest.get("build_supply_chain")
    if not isinstance(source, dict) or source.get("schema") != "echo-founder.source-control-trace.v1":
        raise RuntimeError("Package manifest has no versioned source-control trace.")
    for field in ("baseline_sha", "current_sha"):
        if not GIT_SHA_RE.fullmatch(str(source.get(field) or "")):
            raise RuntimeError(f"Package manifest source_control.{field} is invalid.")
    if not isinstance(source.get("dirty"), bool):
        raise RuntimeError("Package manifest source_control.dirty must be an explicit boolean.")
    if not re.fullmatch(r"[0-9a-f]{64}", str(source.get("dirty_status_sha256") or "")):
        raise RuntimeError("Package manifest source-control status digest is invalid.")
    if require_clean_source and source["dirty"]:
        raise RuntimeError(
            "Formal commercial delivery refuses a dirty source tree; commit the release source and rebuild."
        )
    qa_registry = verify_trusted_qa_key_registry_evidence(recorded_qa_registry)
    if not isinstance(runtime, dict) or runtime.get("schema") != "echo-founder.shipped-runtime-tree.v1":
        raise RuntimeError("Package manifest has no versioned shipped-runtime trace.")
    actual_runtime = runtime_tree_fingerprint(app_path / "Contents" / "Resources" / "aifios")
    for field in ("tree_sha256", "file_count", "directory_count", "symlink_count", "size_bytes"):
        if runtime.get(field) != actual_runtime[field]:
            raise RuntimeError(
                f"Package manifest shipped_runtime.{field} does not match the packaged App."
            )
    if not isinstance(recorded_inventory, dict) or recorded_inventory.get("schema") != SHIPPED_DEPENDENCY_INVENTORY_SCHEMA:
        raise RuntimeError("Package manifest has no versioned shipped-dependency inventory trace.")
    actual_inventory = verify_shipped_dependency_inventory(app_path)
    actual_supply_chain = verify_runtime_supply_chain_evidence(app_path)
    if recorded_supply_chain != actual_supply_chain:
        raise RuntimeError("Package manifest build_supply_chain does not match the packaged App evidence.")
    if actual_inventory.get("runtime_supply_chain") != actual_supply_chain:
        raise RuntimeError("Package inventory does not bind the verified runtime supply-chain evidence.")
    for field in (
        "schema",
        "inventory_path",
        "inventory_sha256",
        "component_count",
        "npm_package_count",
        "xhs_card_npm_package_count",
        "xhs_card_package_lock_sha256",
        "python_distribution_count",
        "tikomni_snapshot_id",
        "tikomni_snapshot_sha256",
        "tikomni_file_sha256",
        "runtime_supply_chain",
        "key_notice_hashes",
        "review_boundaries",
        "status",
    ):
        if recorded_inventory.get(field) != actual_inventory[field]:
            raise RuntimeError(
                f"Package manifest shipped_dependency_inventory.{field} does not match the packaged App."
            )
    return {
        "status": "pass",
        "manifest": manifest_path.name,
        "manifest_sha256": sha256_file(manifest_path),
        "source_control": source,
        "trusted_qa_key_registry": qa_registry,
        "shipped_runtime": actual_runtime,
        "shipped_dependency_inventory": actual_inventory,
        "build_supply_chain": actual_supply_chain,
    }


def refresh_playwright_runtime_manifest(resources_root: Path, package_architecture: str) -> dict[str, Any]:
    """Refresh integrity hashes after any code-signing pass touches Chromium."""
    runtime_root = resources_root / "runtime" / "playwright"
    manifest_path = runtime_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot refresh packaged Playwright runtime manifest: {manifest_path}") from exc
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != PLAYWRIGHT_RUNTIME_SCHEMA
        or manifest.get("tree_hash_schema") != RUNTIME_TREE_HASH_SCHEMA
    ):
        raise RuntimeError(f"Cannot refresh an invalid Playwright runtime manifest: {manifest_path}")
    entries = manifest.get("architectures")
    if not isinstance(entries, dict):
        raise RuntimeError(f"Cannot refresh Playwright runtime without architecture entries: {manifest_path}")
    for architecture in package_architectures(package_architecture):
        entry = entries.get(architecture)
        if not isinstance(entry, dict):
            raise RuntimeError(f"Cannot refresh missing Playwright runtime entry: {architecture}")
        runtime_directory = runtime_root / architecture
        executable = runtime_directory / "chrome-headless-shell"
        if not runtime_directory.is_dir() or not executable.is_file() or executable.is_symlink():
            raise RuntimeError(f"Cannot refresh incomplete Playwright runtime: {runtime_directory}")
        entry["size_bytes"] = directory_size(runtime_directory)
        entry["tree_sha256"] = runtime_tree_fingerprint(runtime_directory)["tree_sha256"]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return verify_playwright_runtime(resources_root, package_architecture)


def verify_component_code_signatures(files: Iterable[Path], label: str) -> None:
    if not shutil.which("codesign"):
        return
    failures: dict[str, str] = {}
    for path in files:
        ok, output = run_capture(["codesign", "--verify", "--strict", str(path)], timeout=60)
        if not ok:
            failures[str(path)] = output
    if failures:
        raise RuntimeError(
            f"{label} contains unsigned or invalid executable components:\n"
            + json.dumps(failures, ensure_ascii=False, indent=2)
        )


def aifios_resource_macho_files(resources_root: Path) -> list[Path]:
    return [
        path
        for path in resources_root.rglob("*")
        if path.is_file()
        and not path.is_symlink()
        and (path.suffix in {".dylib", ".so", ".node"} or path.parent.name == "bin" or path.name == "chrome-headless-shell")
        and macho_architectures(path)
    ]


def sign_aifios_resource_components(resources_root: Path) -> dict[str, Any]:
    """Sign Resource binaries that macOS `--deep` does not discover itself."""
    files = aifios_resource_macho_files(resources_root)
    signature = ad_hoc_codesign_files(files)
    verify_component_code_signatures(files, "AIFIOS bundled resource runtime")
    return {
        "signature": signature,
        "macho_files_signed": len(files),
    }


def embed_playwright_runtime(
    target_root: Path,
    package_architecture: str,
    *,
    arm64_archive: str | None = None,
    arm64_sha256: str | None = None,
    x64_archive: str | None = None,
    x64_sha256: str | None = None,
) -> dict[str, Any]:
    """Bundle a compact Chromium headless shell for offline visual rendering."""
    node_modules = target_root / "skills" / "xhs-card" / "node_modules"
    version, revision, browser_version = playwright_browser_metadata(node_modules)
    runtime_root = target_root / "runtime" / "playwright"
    if runtime_root.exists():
        shutil.rmtree(runtime_root)
    runtime_root.mkdir(parents=True)
    entries: dict[str, Any] = {}
    archive_args = {
        "arm64": (arm64_archive, arm64_sha256),
        "x64": (x64_archive, x64_sha256),
    }
    with tempfile.TemporaryDirectory(prefix="echo-founder-playwright-extract-") as tmp_dir:
        staging_root = Path(tmp_dir)
        for architecture in package_architectures(package_architecture):
            source, provenance = prepare_playwright_headless_shell(
                architecture,
                version,
                revision,
                browser_version,
                staging_root / architecture,
                *archive_args[architecture],
            )
            source_tree = runtime_tree_fingerprint(source)
            destination = runtime_root / architecture
            shutil.copytree(source, destination, symlinks=True, ignore=shutil.ignore_patterns(".DS_Store"))
            copied_tree = runtime_tree_fingerprint(destination)
            if any(
                source_tree[field] != copied_tree[field]
                for field in ("tree_sha256", "file_count", "directory_count", "symlink_count", "size_bytes")
            ):
                raise RuntimeError("Copied Playwright runtime differs from its isolated verified extraction.")
            executable = destination / "chrome-headless-shell"
            if not executable.is_file() or executable.is_symlink():
                raise RuntimeError(f"Copied Playwright headless shell lacks a safe executable: {executable}")
            entries[architecture] = {
                "executable": executable.relative_to(runtime_root).as_posix(),
                "source_revision": revision,
                "source_extracted_tree_sha256": source_tree["tree_sha256"],
                "source": provenance,
            }
    # `codesign --deep` does not reliably discover arbitrary executable files
    # kept under Resources. Sign the Chromium launcher and its dylibs before
    # signing the outer app so both arm64 and x64 slices remain launchable from
    # a quarantined app bundle.
    component_files = playwright_runtime_macho_files(runtime_root)
    component_signature = ad_hoc_codesign_files(component_files)
    verify_component_code_signatures(component_files, "Bundled Playwright runtime")
    for architecture in package_architectures(package_architecture):
        destination = runtime_root / architecture
        entries[architecture]["size_bytes"] = directory_size(destination)
        entries[architecture]["tree_sha256"] = runtime_tree_fingerprint(destination)["tree_sha256"]
    manifest = {
        "schema": PLAYWRIGHT_RUNTIME_SCHEMA,
        "tree_hash_schema": RUNTIME_TREE_HASH_SCHEMA,
        "playwright_version": version,
        "headless_shell_revision": revision,
        "browser_version": browser_version,
        "architectures": entries,
    }
    (runtime_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verification = verify_playwright_runtime(target_root, package_architecture)
    return {
        "status": "embedded",
        "version": version,
        "revision": revision,
        "architectures": entries,
        "component_signature": component_signature,
        "macho_files_signed": len(component_files),
        "verification": verification,
    }


def electron_runtime_module_names() -> list[str]:
    return [
        source.name
        for source in sorted((UI_DIR / "electron").glob("*.cjs"))
        if not source.name.endswith(".test.cjs")
    ]


def write_electron_app_entry(app_resources: Path, app_name: str, version: str) -> None:
    app_dir = app_resources / "app"
    if app_dir.exists():
        shutil.rmtree(app_dir)
    electron_target = app_dir / "electron"
    electron_target.mkdir(parents=True)
    # The main process has local CommonJS helpers (publication bridge, startup
    # routing, etc.). Copy the complete runtime module set instead of a
    # hard-coded main/preload pair so a new helper cannot work in source mode
    # yet disappear from Contents/Resources/app.
    for name in electron_runtime_module_names():
        shutil.copy2(UI_DIR / "electron" / name, electron_target / name)
    (app_dir / "package.json").write_text(
        json.dumps(
            {
                "name": "echo-founder-desktop-shell",
                "version": version,
                "private": True,
                "main": "electron/main.cjs",
                "productName": app_name,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def build_brand_icon(app_resources: Path) -> dict[str, Any]:
    """Render the checked-in Echo Founder SVG into a deterministic macOS iconset."""
    destination = app_resources / BRAND_ICON_FILENAME
    electron_default = app_resources / "electron.icns"
    default_hash = sha256_file(electron_default) if electron_default.is_file() else ""
    with tempfile.TemporaryDirectory(prefix="echo-founder-icon-") as tmp_dir:
        temp_root = Path(tmp_dir)
        base_png = temp_root / "icon-1024.png"
        iconset = temp_root / "EchoFounder.iconset"
        iconset.mkdir()
        run(
            [
                "sips",
                "-s",
                "format",
                "png",
                "--resampleHeightWidth",
                "1024",
                "1024",
                str(BRAND_ICON_SOURCE),
                "--out",
                str(base_png),
            ],
            timeout=120,
        )
        for filename, size in BRAND_ICONSET_SIZES:
            run(
                ["sips", "-z", str(size), str(size), str(base_png), "--out", str(iconset / filename)],
                timeout=120,
            )
        run(["iconutil", "-c", "icns", str(iconset), "-o", str(destination)], timeout=120)

    if not destination.is_file() or destination.stat().st_size < 1024:
        raise RuntimeError("Echo Founder macOS icon was not generated correctly.")
    if destination.read_bytes()[:4] != b"icns":
        raise RuntimeError("Echo Founder macOS icon has an invalid ICNS header.")
    icon_hash = sha256_file(destination)
    if default_hash and icon_hash == default_hash:
        raise RuntimeError("Echo Founder macOS icon must not reuse Electron's default icon.")
    if electron_default.is_file():
        electron_default.unlink()
    return {
        "filename": BRAND_ICON_FILENAME,
        "source": BRAND_ICON_SOURCE.relative_to(REPO_ROOT).as_posix(),
        "source_sha256": sha256_file(BRAND_ICON_SOURCE),
        "sha256": icon_hash,
        "size_bytes": destination.stat().st_size,
        "electron_default_removed": not electron_default.exists(),
    }


def verify_brand_icon(app_path: Path) -> dict[str, Any]:
    plist_path = app_path / "Contents" / "Info.plist"
    with plist_path.open("rb") as handle:
        info = plistlib.load(handle)
    configured = str(info.get("CFBundleIconFile") or "")
    if configured != BRAND_ICON_FILENAME:
        raise RuntimeError(f"Packaged app does not select the Echo Founder icon: {configured or 'missing'}")
    icon_path = app_path / "Contents" / "Resources" / BRAND_ICON_FILENAME
    if not icon_path.is_file() or icon_path.stat().st_size < 1024 or icon_path.read_bytes()[:4] != b"icns":
        raise RuntimeError(f"Packaged Echo Founder icon is missing or invalid: {icon_path}")
    if (app_path / "Contents" / "Resources" / "electron.icns").exists():
        raise RuntimeError("Packaged app still contains Electron's default outer-app icon.")
    return {
        "filename": BRAND_ICON_FILENAME,
        "sha256": sha256_file(icon_path),
        "size_bytes": icon_path.stat().st_size,
    }


def apple_bundle_versions(product_version: str) -> tuple[str, str]:
    """Map the public SemVer to Apple's numeric marketing/build versions.

    Each marketing version has its own build train.  Reserved numeric windows
    keep alpha, beta, release-candidate, and final builds ordered without ever
    putting a SemVer prerelease identifier in ``CFBundleVersion``.
    """
    match = APPLE_PRODUCT_VERSION_RE.fullmatch(product_version)
    if not match:
        raise ValueError(
            "Product version must be MAJOR.MINOR.PATCH, optionally followed by "
            "-alpha.N, -beta.N, or -rc.N where N is 1..999."
        )

    marketing_version = ".".join(
        (match.group("major"), match.group("minor"), match.group("patch"))
    )
    phase = match.group("phase")
    if phase is None:
        return marketing_version, str(APPLE_RELEASE_BUILD_VERSION)

    sequence = int(match.group("sequence"))
    return marketing_version, str(APPLE_PRERELEASE_BUILD_BASE[phase] + sequence)


def update_info_plist(app_path: Path, app_name: str, bundle_id: str, version: str) -> None:
    marketing_version, build_version = apple_bundle_versions(version)
    plist_path = app_path / "Contents" / "Info.plist"
    with plist_path.open("rb") as handle:
        payload = plistlib.load(handle)
    payload.update(
        {
            "CFBundleExecutable": app_name,
            "CFBundleName": app_name,
            "CFBundleDisplayName": app_name,
            "CFBundleIdentifier": bundle_id,
            "CFBundleIconFile": BRAND_ICON_FILENAME,
            "CFBundleShortVersionString": marketing_version,
            "CFBundleVersion": build_version,
            "LSMinimumSystemVersion": MINIMUM_MACOS_VERSION,
            "NSHighResolutionCapable": True,
        }
    )
    with plist_path.open("wb") as handle:
        plistlib.dump(payload, handle)


def rename_main_binary(app_path: Path, app_name: str) -> None:
    macos_dir = app_path / "Contents" / "MacOS"
    source = macos_dir / "Electron"
    target = macos_dir / app_name
    if target.exists():
        target.unlink()
    source.rename(target)
    target.chmod(0o755)


def maybe_codesign(app_path: Path, enabled: bool, *, deep: bool = True) -> str:
    if not enabled:
        return "skipped"
    if not shutil.which("codesign"):
        return "unavailable"
    command = ["codesign", "--force"]
    if deep:
        command.append("--deep")
    command.extend(["--sign", "-", str(app_path)])
    run(command, timeout=300)
    run(["codesign", "--verify", "--deep", "--strict", str(app_path)], timeout=120)
    return "ad-hoc"


def verify_app_bundle(
    app_path: Path,
    app_name: str,
    expected_next_manifest: dict[str, Any],
    package_architecture: str,
) -> None:
    resources_root = app_path / "Contents" / "Resources" / "aifios"
    next_dist = resources_root / "ui" / DESKTOP_DIST_DIR
    standalone_dist = next_standalone_dist_dir(next_dist)
    required = [
        app_path / "Contents" / "MacOS" / app_name,
        resources_root / "VERSION",
        app_path / "Contents" / "Info.plist",
        app_path / "Contents" / "Resources" / BRAND_ICON_FILENAME,
        app_path / "Contents" / "Resources" / "app" / "package.json",
        *(app_path / "Contents" / "Resources" / "app" / "electron" / name for name in electron_runtime_module_names()),
        resources_root / "scripts" / "aifios.py",
        resources_root / "skills" / "content-runtime" / "scripts" / "content_runtime.py",
        resources_root / MATERIAL_OCR_BINARY_RELATIVE,
        next_dist / "BUILD_ID",
        next_build_manifest_path(next_dist),
        next_standalone_root(next_dist) / "server.js",
        standalone_dist / "BUILD_ID",
        next_standalone_root(next_dist) / "node_modules" / "next" / "package.json",
        *(standalone_dist / item for item in REQUIRED_NEXT_ROUTE_ARTIFACTS),
        *(resources_root / "skills" / TIKOMNI_SKILL_NAME / item for item in TIKOMNI_BUNDLE_FILES),
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("Packaged app is missing required file(s):\n" + "\n".join(missing))
    verify_brand_icon(app_path)
    material_ocr = resources_root / MATERIAL_OCR_BINARY_RELATIVE
    if not material_ocr.is_file() or not os.access(material_ocr, os.X_OK):
        raise RuntimeError(f"Packaged macOS PDF OCR helper is not executable: {material_ocr}")
    bundled_manifest = read_next_build_manifest(next_dist)
    if bundled_manifest.get("source_tree_sha256") != expected_next_manifest.get("source_tree_sha256"):
        raise RuntimeError("Packaged app contains a stale .next-desktop build that does not match the current package build.")
    if bundled_manifest.get("required_route_artifacts") != expected_next_manifest.get("required_route_artifacts"):
        raise RuntimeError("Packaged app is missing the expected desktop production route inventory.")
    if (resources_root / "ui" / "node_modules").exists():
        raise RuntimeError("Packaged app includes the full UI node_modules tree instead of the traced standalone runtime.")
    expected_electron_architectures = (
        MACOS_UNIVERSAL_ARCHITECTURES
        if package_architecture == "universal"
        else {lipo_architecture_name(package_architecture)}
    )
    material_ocr_architectures = macho_architectures(material_ocr)
    if not expected_electron_architectures.issubset(material_ocr_architectures):
        raise RuntimeError(
            "Packaged macOS PDF OCR helper is missing required architecture(s): "
            + ", ".join(sorted(expected_electron_architectures - material_ocr_architectures))
        )
    verify_electron_runtime_architecture(app_path, expected_electron_architectures)
    verify_next_native_runtime(next_standalone_root(next_dist), package_architecture)
    verify_playwright_runtime(resources_root, package_architecture)
    verify_tikomni_social_media_crawl(resources_root / "skills" / TIKOMNI_SKILL_NAME)
    verify_customer_bundle_hygiene(resources_root)
    verify_shipped_dependency_inventory(app_path)


def bundled_python_runtime_root(resources_root: Path, architecture: str) -> Path:
    return resources_root / "runtime" / "python" / architecture


def bundled_python_binary(resources_root: Path, architecture: str, version: str) -> Path | None:
    return python_binary_path_for_runtime(bundled_python_runtime_root(resources_root, architecture), version)


def verify_embedded_python_runtime(
    resources_root: Path,
    required: bool,
    version: str,
    package_architecture: str,
) -> dict[str, Any]:
    verified: dict[str, Any] = {}
    missing: list[str] = []
    for architecture in package_architectures(package_architecture):
        runtime_root = bundled_python_runtime_root(resources_root, architecture)
        python = python_binary_path_for_runtime(runtime_root, version)
        if not python:
            missing.append(str(runtime_root))
            continue
        expected_architecture = lipo_architecture_name(architecture)
        actual_architectures = macho_architectures(python)
        if expected_architecture not in actual_architectures:
            raise RuntimeError(
                f"Packaged Python runtime has the wrong architecture for {architecture}: "
                f"{python} ({sorted(actual_architectures)})"
            )
        native = architecture == host_macos_architecture()
        runtime_verification = verify_python_runtime(runtime_root, resources_root) if native else {
            "binary": str(python),
            "version": "cross-architecture-not-executed",
            "stdlib_smoke": "not-run-on-build-host",
            "content_runtime_smoke": "not-run-on-build-host",
        }
        remaining_external = dylib_scan(python_runtime_macho_files(runtime_root))
        if remaining_external and required:
            raise RuntimeError(
                f"Packaged embedded Python runtime still depends on non-system dylibs ({architecture}):\n"
                + json.dumps(remaining_external, ensure_ascii=False, indent=2)
            )
        verified[architecture] = {
            **runtime_verification,
            "runtime_root": str(runtime_root),
            "macho_architectures": sorted(actual_architectures),
            "portability": "review_required" if remaining_external else "self_contained_or_system_only",
            "nonportable_dylibs": remaining_external,
        }
    if missing and required:
        raise RuntimeError("Packaged app is missing embedded Python runtime(s):\n" + "\n".join(missing))
    return {
        "status": "pass" if verified else "missing",
        "architectures": verified,
        "missing": missing,
    }


def iter_files(paths: Iterable[Path]) -> Iterable[Path]:
    for path in paths:
        if path.is_file():
            yield path
        elif path.is_dir():
            yield from (item for item in path.rglob("*") if item.is_file())


def directory_size(path: Path) -> int:
    return sum(item.stat().st_size for item in iter_files([path]))


def validate_formal_runtime_arguments(args: argparse.Namespace) -> None:
    """Reject ambiguous or silently unused formal runtime source options."""
    if args.embed_python_runtime != "required":
        raise RuntimeError("Formal desktop packaging requires the approved embedded Python runtime.")
    if args.python_version != DEFAULT_PYTHON_VERSION:
        raise RuntimeError(f"Formal desktop packaging pins CPython {DEFAULT_PYTHON_VERSION}.")
    selected = set(package_architectures(args.arch))
    for runtime in ("electron", "playwright"):
        for architecture in ("arm64", "x64"):
            archive = getattr(args, f"{runtime}_{architecture}_archive", None)
            digest = getattr(args, f"{runtime}_{architecture}_sha256", None)
            if architecture not in selected and (archive or digest):
                raise RuntimeError(f"--{runtime}-{architecture}-* does not apply to --arch={args.arch}.")
            if bool(archive) != bool(digest):
                raise RuntimeError(f"--{runtime}-{architecture}-archive and SHA-256 must be supplied together.")

    generic_python = getattr(args, "python_runtime_archive", None)
    generic_python_sha = getattr(args, "python_runtime_sha256", None)
    if bool(generic_python) != bool(generic_python_sha):
        raise RuntimeError("--python-runtime-archive and --python-runtime-sha256 must be supplied together.")
    if args.arch == "universal" and (generic_python or generic_python_sha):
        raise RuntimeError("Universal packages require architecture-specific Python archive options.")
    for architecture in ("arm64", "x64"):
        archive = getattr(args, f"python_runtime_{architecture}_archive", None)
        digest = getattr(args, f"python_runtime_{architecture}_sha256", None)
        if architecture not in selected and (archive or digest):
            raise RuntimeError(f"--python-runtime-{architecture}-* does not apply to --arch={args.arch}.")
        if bool(archive) != bool(digest):
            raise RuntimeError(
                f"--python-runtime-{architecture}-archive and SHA-256 must be supplied together."
            )


def validate_approved_dependency_locks() -> None:
    approved = {
        UI_DIR / "package-lock.json": APPROVED_UI_PACKAGE_LOCK_SHA256,
        REPO_ROOT / "skills" / "xhs-card" / "package-lock.json": APPROVED_XHS_CARD_PACKAGE_LOCK_SHA256,
    }
    for path, expected in approved.items():
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"Formal dependency lock is missing or unsafe: {path}")
        actual = sha256_file(path)
        if actual != expected:
            raise RuntimeError(
                f"Formal dependency lock is not the approved reviewed snapshot: {path.name} "
                f"(expected {expected}, got {actual})"
            )


def build_app(args: argparse.Namespace) -> dict[str, object]:
    if not args.social_media_crawl_dir:
        raise RuntimeError(
            "A formal desktop package requires --social-media-crawl-dir bound to the approved TikOmni snapshot."
        )
    # Resolve and hash-gate external source inputs before an expensive UI or
    # Electron build starts. No home-directory plugin discovery is permitted.
    resolve_tikomni_social_media_crawl_source(args.social_media_crawl_dir)
    if args.skip_build:
        raise RuntimeError("Formal desktop packaging forbids --skip-build and always rebuilds UI dependencies in isolation.")
    validate_formal_runtime_arguments(args)
    validate_approved_dependency_locks()
    ensure_prerequisites()

    dist_dir = Path(args.dist_dir).expanduser().resolve()
    app_path = dist_dir / f"{args.app_name}.app"
    dist_dir.mkdir(parents=True, exist_ok=True)

    print(f"Preparing {args.arch} Electron app: {app_path}", flush=True)
    electron_runtime = create_electron_runtime(args, app_path)

    resources = app_path / "Contents" / "Resources"
    write_electron_app_entry(resources, args.app_name, args.version)
    brand_icon = build_brand_icon(resources)
    aifios_root = resources / "aifios"
    copy_aifios_runtime(aifios_root)
    xhs_card_dependencies = prepare_xhs_card_runtime_dependencies(
        REPO_ROOT / "skills" / "xhs-card",
        aifios_root / "skills" / "xhs-card",
    )
    hosted_client = write_hosted_client_config(
        aifios_root,
        args.hosted_gateway_url,
        args.hosted_research_public_key,
        args.hosted_research_key_id,
    )
    distribution_config = write_distribution_config(resources, hosted_client)
    demo_unlock = write_demo_unlock_config(aifios_root, args.demo_unlock_codes)
    next_build_manifest, ui_runtime = build_next_bundle(
        aifios_root,
        app_path / "Contents" / "MacOS" / "Electron",
    )
    standalone_root = next_standalone_root(aifios_root / "ui" / DESKTOP_DIST_DIR)
    ui_runtime["native_runtime"] = embed_next_native_runtime(standalone_root, args.arch)
    embedded_playwright_runtime = embed_playwright_runtime(
        aifios_root,
        args.arch,
        arm64_archive=args.playwright_arm64_archive,
        arm64_sha256=args.playwright_arm64_sha256,
        x64_archive=args.playwright_x64_archive,
        x64_sha256=args.playwright_x64_sha256,
    )
    embedded_tikomni_runtime = embed_tikomni_social_media_crawl(aifios_root, args.social_media_crawl_dir)
    embedded_python_runtime = embed_python_runtime(
        aifios_root,
        args.embed_python_runtime,
        args.python_runtime,
        args.python_runtime_arm64,
        args.python_runtime_x64,
        args.python_version,
        args.arch,
        explicit_archive=args.python_runtime_archive,
        explicit_arm64_archive=args.python_runtime_arm64_archive,
        explicit_x64_archive=args.python_runtime_x64_archive,
        explicit_sha256=args.python_runtime_sha256,
        explicit_arm64_sha256=args.python_runtime_arm64_sha256,
        explicit_x64_sha256=args.python_runtime_x64_sha256,
    )
    rename_main_binary(app_path, args.app_name)
    update_info_plist(app_path, args.app_name, args.bundle_id, args.version)
    # Sign Electron's nested framework tree before the final resource pass.
    # Chromium and the other executable payloads are signed afterwards so their
    # integrity manifest can be sealed without a later deep-sign mutation.
    deep_signature = maybe_codesign(app_path, not args.no_codesign, deep=True)
    resource_component_signing = sign_aifios_resource_components(aifios_root)
    playwright_after_resource_signing = refresh_playwright_runtime_manifest(aifios_root, args.arch)
    embedded_playwright_runtime["verification"] = playwright_after_resource_signing
    verified_python_runtime = verify_embedded_python_runtime(
        aifios_root,
        args.embed_python_runtime == "required",
        args.python_version,
        args.arch,
    )
    active_python = bundled_python_binary(aifios_root, host_macos_architecture(), args.python_version)
    embedded_tikomni_runtime["runtime_verification"] = verify_tikomni_social_media_crawl(
        aifios_root / "skills" / TIKOMNI_SKILL_NAME,
        active_python if active_python else sys.executable,
    )
    runtime_supply_chain_payload = build_runtime_supply_chain_evidence(
        app_path,
        package_architecture=args.arch,
        electron_runtime=electron_runtime,
        xhs_card_runtime=xhs_card_dependencies,
        embedded_python_runtime=embedded_python_runtime,
    )
    build_supply_chain = write_runtime_supply_chain_evidence(app_path, runtime_supply_chain_payload)
    shipped_dependency_inventory = write_shipped_dependency_inventory(
        app_path,
        product_version=args.version,
        python_version=args.python_version,
        package_architecture=args.arch,
        electron_versions=electron_process_versions(app_path),
        runtime_supply_chain=build_supply_chain,
    )
    verify_app_bundle(app_path, args.app_name, next_build_manifest, args.arch)
    # Seal the manifest and all resource bytes without re-signing Chromium.
    signature = (
        maybe_codesign(app_path, True, deep=False)
        if deep_signature == "ad-hoc"
        else deep_signature
    )
    final_playwright_verification = verify_playwright_runtime(aifios_root, args.arch)
    embedded_playwright_runtime["final_verification"] = final_playwright_verification
    verify_app_bundle(app_path, args.app_name, next_build_manifest, args.arch)
    customer_bundle_hygiene = verify_customer_bundle_hygiene(aifios_root)
    shipped_runtime = runtime_tree_fingerprint(aifios_root)
    qa_registry_before_source_trace = trusted_qa_key_registry_evidence()
    source_control = release_source_control(args.baseline_sha)
    trusted_qa_key_registry = trusted_qa_key_registry_evidence()
    if trusted_qa_key_registry != qa_registry_before_source_trace:
        raise RuntimeError("Trusted QA public-key registry changed while source-control evidence was captured.")

    manifest = {
        "status": "packed",
        "app_path": str(app_path),
        "app_name": args.app_name,
        "bundle_id": args.bundle_id,
        "version": args.version,
        "product": DEFAULT_APP_NAME,
        "minimum_macos_version": MINIMUM_MACOS_VERSION,
        "brand_icon": brand_icon,
        "customer_bundle_hygiene": customer_bundle_hygiene,
        "source_control": source_control,
        "trusted_qa_key_registry": trusted_qa_key_registry,
        "shipped_runtime": shipped_runtime,
        "shipped_dependency_inventory": shipped_dependency_inventory,
        "build_supply_chain": build_supply_chain,
        "signature": signature,
        "deep_signature": deep_signature,
        "architecture": electron_runtime,
        "created_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "resources_root": str(resources / "aifios"),
        "prebuilt_next_dist": f"ui/{DESKTOP_DIST_DIR}",
        "ui_runtime": ui_runtime,
        "next_build": {
            "source_tree_sha256": next_build_manifest.get("source_tree_sha256"),
            "source_file_count": next_build_manifest.get("source_file_count"),
            "source_bytes": next_build_manifest.get("source_bytes"),
            "built_at": next_build_manifest.get("built_at"),
            "required_route_artifacts": next_build_manifest.get("required_route_artifacts"),
        },
        "embedded_tikomni_social_media_crawl": embedded_tikomni_runtime,
        "xhs_card_runtime_dependencies": xhs_card_dependencies,
        "embedded_playwright_runtime": embedded_playwright_runtime,
        "embedded_python_runtime": embedded_python_runtime,
        "verified_python_runtime": verified_python_runtime,
        "resource_component_signing": resource_component_signing,
        "distribution": {
            "mode": "hosted-license" if hosted_client else "local-self-config",
            "embedded_gateway": bool(hosted_client),
            "credential_policy": "device-bound-session" if hosted_client else "user-managed-local",
            "device_binding": bool(hosted_client),
            "demo_unlock": bool(demo_unlock),
        },
        "distribution_config": distribution_config,
        "hosted_client": hosted_client,
        "demo_unlock": demo_unlock,
        "size_bytes": directory_size(app_path),
    }
    persisted_manifest = portable_release_manifest(
        manifest,
        [
            (app_path, app_path.name),
            (REPO_ROOT, "source"),
            (Path.home(), "build-home"),
            (Path(tempfile.gettempdir()), "build-temp"),
        ],
    )
    manifest_path = dist_dir / "desktop-package-manifest.json"
    manifest_path.write_text(json.dumps(persisted_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Build an unsigned Echo Founder macOS desktop app bundle")
    parser.add_argument("--dist-dir", default="dist/desktop")
    parser.add_argument("--app-name", default=DEFAULT_APP_NAME)
    parser.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID)
    parser.add_argument("--version", default=DEFAULT_PRODUCT_VERSION)
    parser.add_argument(
        "--baseline-sha",
        default="",
        help="frozen source baseline commit recorded in the customer-safe package manifest",
    )
    parser.add_argument(
        "--verify-manifest",
        default="",
        help="verify an existing desktop-package-manifest.json instead of building",
    )
    parser.add_argument(
        "--verify-app-path",
        default=f"dist/desktop/{DEFAULT_APP_NAME}.app",
        help="packaged App matched by --verify-manifest",
    )
    parser.add_argument(
        "--require-clean-source",
        action="store_true",
        help="fail verification when the package manifest honestly records dirty=true",
    )
    parser.add_argument(
        "--hosted-gateway-url",
        help="credential-free public HTTPS origin for a paid device-bound build; only public bootstrap data is embedded",
    )
    parser.add_argument(
        "--hosted-research-public-key",
        help="base64url SPKI DER verification key for signed hosted research; safe to embed",
    )
    parser.add_argument(
        "--hosted-research-key-id",
        default="market-v1",
        help="public signing-key identifier paired with --hosted-research-public-key",
    )
    parser.add_argument(
        "--demo-unlock-codes",
        help=argparse.SUPPRESS,  # Accepted for old build scripts; no longer creates a password gate.
    )
    parser.add_argument("--arch", choices=["universal", "arm64", "x64"], default=DEFAULT_DESKTOP_ARCH)
    parser.add_argument("--electron-arm64-app", help=argparse.SUPPRESS)
    parser.add_argument("--electron-x64-app", help=argparse.SUPPRESS)
    parser.add_argument("--electron-arm64-archive", help="approved Electron arm64 release ZIP")
    parser.add_argument("--electron-arm64-sha256", help="approved SHA-256 paired with --electron-arm64-archive")
    parser.add_argument("--electron-x64-archive", help="approved Electron x64 release ZIP")
    parser.add_argument("--electron-x64-sha256", help="approved SHA-256 paired with --electron-x64-archive")
    parser.add_argument("--playwright-arm64-archive", help="approved Playwright arm64 headless-shell ZIP")
    parser.add_argument("--playwright-arm64-sha256", help="approved SHA-256 paired with --playwright-arm64-archive")
    parser.add_argument("--playwright-x64-archive", help="approved Playwright x64 headless-shell ZIP")
    parser.add_argument("--playwright-x64-sha256", help="approved SHA-256 paired with --playwright-x64-archive")
    parser.add_argument("--skip-build", action="store_true", help="reuse existing ui/.next-desktop build")
    parser.add_argument("--no-codesign", action="store_true", help="skip local ad-hoc codesign")
    parser.add_argument(
        "--embed-python-runtime",
        choices=["auto", "required", "off"],
        default="required",
        help="copy relocatable Python runtime(s) into Contents/Resources/aifios/runtime/python/{arch} (required by default)",
    )
    parser.add_argument("--python-runtime", help=argparse.SUPPRESS)
    parser.add_argument("--python-runtime-arm64", help=argparse.SUPPRESS)
    parser.add_argument("--python-runtime-x64", help=argparse.SUPPRESS)
    parser.add_argument("--python-runtime-archive", help="approved Python archive for a single-architecture package")
    parser.add_argument("--python-runtime-sha256", help="approved SHA-256 paired with --python-runtime-archive")
    parser.add_argument("--python-runtime-arm64-archive", help="approved arm64 Python release archive")
    parser.add_argument("--python-runtime-arm64-sha256", help="approved SHA-256 paired with --python-runtime-arm64-archive")
    parser.add_argument("--python-runtime-x64-archive", help="approved x64 Python release archive")
    parser.add_argument("--python-runtime-x64-sha256", help="approved SHA-256 paired with --python-runtime-x64-archive")
    parser.add_argument("--python-version", default=DEFAULT_PYTHON_VERSION, help="approved pinned CPython version to embed")
    parser.add_argument(
        "--social-media-crawl-dir",
        help="source social-media-crawl skill directory to vendor into the standalone app",
    )
    args = parser.parse_args()

    if args.verify_manifest:
        try:
            traceability = verify_package_traceability(
                Path(args.verify_manifest).expanduser().resolve(),
                Path(args.verify_app_path).expanduser().resolve(),
                require_clean_source=args.require_clean_source,
            )
        except Exception as exc:
            print(f"FAIL desktop package traceability: {exc}", file=sys.stderr)
            return 1
        print("PASS desktop package traceability")
        print(f"manifest_sha256={traceability['manifest_sha256']}")
        print(f"source_dirty={str(traceability['source_control']['dirty']).lower()}")
        print(f"runtime_tree_sha256={traceability['shipped_runtime']['tree_sha256']}")
        return 0
    if args.require_clean_source:
        parser.error("--require-clean-source is valid only with --verify-manifest")

    try:
        manifest = build_app(args)
    except subprocess.CalledProcessError as exc:
        print(f"FAIL desktop package command exited with {exc.returncode}: {' '.join(exc.cmd)}", file=sys.stderr)
        return int(exc.returncode or 1)
    except Exception as exc:
        print(f"FAIL desktop package: {exc}", file=sys.stderr)
        return 1

    print("PASS desktop package")
    print(f"app_path={manifest['app_path']}")
    print(f"manifest_path={manifest['manifest_path']}")
    print(f"signature={manifest['signature']}")
    print(f"size_bytes={manifest['size_bytes']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
