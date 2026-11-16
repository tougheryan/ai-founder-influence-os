#!/usr/bin/env python3
"""Lightweight structural contracts for the active AIFIOS runtime."""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = REPO_ROOT / "skills" / "content-runtime"
RUNTIME_SCRIPTS = RUNTIME_DIR / "scripts"
SCHEMAS_DIR = RUNTIME_DIR / "schemas"
CONTENT_RUNTIME = RUNTIME_SCRIPTS / "content_runtime.py"
DELIVERY_AUDIT = RUNTIME_SCRIPTS / "delivery_audit.py"
DELIVERY_PACK = RUNTIME_SCRIPTS / "delivery_pack.py"
MANIFEST = REPO_ROOT / "skills" / "manifest.json"
VISUAL_PROVIDERS = RUNTIME_DIR / "config" / "visual_providers.json"
RUNTIME_IMAGE_ROUTES = RUNTIME_DIR / "config" / "runtime-image-routes.json"
THIRD_PARTY_NOTICES = REPO_ROOT / "docs" / "third-party-notices.md"
AUXILIARY_SCHEMA_FILES = {
    "visual-recipe.schema.json",
    "visual-revision-request.schema.json",
    "image-provider-registry.schema.json",
    "image-provider-benchmark.schema.json",
    "image-account-policy.schema.json",
    "runtime-image-route-catalog.schema.json",
    "tikomni-hit-score.schema.json",
}
MATERIALS_API = REPO_ROOT / "ui" / "app" / "api" / "materials" / "route.ts"
CAPABILITY_TIER_SCHEMA = "aifios.skill-capability-tiers.v2"
CAPABILITY_TIERS = ("core", "optional")
CORE_PRODUCTION_SKILLS = {
    "content-runtime",
    "content-intake",
    "content-hit-collector",
    "content-validate",
    "content-blueprint",
    "wechat-writer",
    "content-package",
    "content-visual",
    "xhs-card",
    "dbs-wechat-html",
}
OPTIONAL_ENHANCEMENT_SKILLS = {"baoyu-diagram", "baoyu-comic"}
RETIRED_SKILLS = {
    "content",
    "content-angle",
    "content-audit",
    "content-breakdown",
    "content-compliance",
    "content-dbs-fusion",
    "content-performance-collector",
    "content-prelaunch",
    "content-repurpose",
    "content-review",
    "content-twin",
    "douyin-script",
    "self-archive",
}
EXPOSED_SKILLS = CORE_PRODUCTION_SKILLS | OPTIONAL_ENHANCEMENT_SKILLS

# These paths are executable product surface, rather than historical reports or
# read-only project artifacts. Keeping this list explicit prevents a removed
# desktop or UI branch from silently escaping the runtime contract.
ACTIVE_SOURCE_ROOTS = (
    REPO_ROOT / "scripts",
    REPO_ROOT / "skills",
    RUNTIME_SCRIPTS,
    RUNTIME_DIR / "config",
    RUNTIME_DIR / "schemas",
    REPO_ROOT / "ui" / "app",
    REPO_ROOT / "ui" / "components",
    REPO_ROOT / "ui" / "electron",
    REPO_ROOT / "ui" / "lib",
)
ACTIVE_SOURCE_SUFFIXES = frozenset({".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md", ".html"})
ACTIVE_SOURCE_EXCLUSIONS = frozenset(
    {
        REPO_ROOT / "scripts" / "check_runtime_contracts.py",
        REPO_ROOT / "scripts" / "check_ui_runtime_gates.py",
    }
)
ACTIVE_SOURCE_FILES = (
    REPO_ROOT / "Makefile",
    MANIFEST,
    REPO_ROOT / "README.md",
    REPO_ROOT / "QUICKSTART-10MIN.md",
    REPO_ROOT / "RELEASE.md",
    REPO_ROOT / "docs" / "commercial-delivery-sop.md",
    REPO_ROOT / "docs" / "desktop-electron.md",
    REPO_ROOT / "docs" / "desktop-risk-assessment.md",
    THIRD_PARTY_NOTICES,
    REPO_ROOT / "ui" / "package.json",
)
CODEX_NATIVE_RUNTIME_ROOTS = (
    REPO_ROOT / "scripts",
    REPO_ROOT / "skills",
    REPO_ROOT / "ui" / "app",
    REPO_ROOT / "ui" / "components",
    REPO_ROOT / "ui" / "electron",
    REPO_ROOT / "ui" / "lib",
)
CODEX_NATIVE_RUNTIME_FILES = (
    REPO_ROOT / "Makefile",
    REPO_ROOT / "pyproject.toml",
    MANIFEST,
    REPO_ROOT / "ui" / "package.json",
    REPO_ROOT / "ui" / "package-lock.json",
)
CODEX_NATIVE_RUNTIME_EXCLUSIONS = frozenset({Path(__file__).resolve()})
CODEX_NATIVE_BOUNDARY_DOCS = (
    REPO_ROOT / "README.md",
    REPO_ROOT / "QUICKSTART-10MIN.md",
    REPO_ROOT / "RELEASE.md",
    REPO_ROOT / "docs" / "content-production-remediation.md",
    REPO_ROOT / "docs" / "content-production-loop.md",
    REPO_ROOT / "docs" / "commercial-delivery-sop.md",
    REPO_ROOT / "docs" / "skills-catalog.md",
)
SUPERPOWERS_REFERENCE = re.compile(r"\bsuperpowers?\b", re.IGNORECASE)
CODEX_NATIVE_BOUNDARY = re.compile(
    r"(?:does not (?:require|depend on)\s+(?:a\s+)?superpowers?\b|\u4e0d\u4f9d\u8d56\s*superpowers?\b)",
    re.IGNORECASE,
)
REMOVED_VIDEO_PATHS = (
    REPO_ROOT / "quality" / "golden-cases" / "video",
    REPO_ROOT / "scripts" / "video_failure_smoke.py",
    REPO_ROOT / "skills" / "content-video-packaging",
    RUNTIME_SCRIPTS / "video_package_quality.py",
    RUNTIME_DIR / "schemas" / "video-package.schema.json",
    RUNTIME_DIR / "fixtures" / "browser-hit" / "douyin.html",
    RUNTIME_DIR / "fixtures" / "browser-hit" / "shipinhao.html",
    RUNTIME_DIR / "tests" / "fixtures" / "tikomni" / "douyin-hit.json",
    RUNTIME_DIR / "tests" / "fixtures" / "tikomni" / "douyin-performance.json",
    RUNTIME_DIR / "tests" / "fixtures" / "tikomni" / "shipinhao-hit.json",
    RUNTIME_DIR / "tests" / "fixtures" / "tikomni" / "shipinhao-performance.json",
    REPO_ROOT / "ui" / "app" / "api" / "video",
    REPO_ROOT / "ui" / "app" / "api" / "video-generate",
    REPO_ROOT / "ui" / "app" / "video-clip",
    REPO_ROOT / "ui" / "app" / "video-generate",
    REPO_ROOT / "ui" / "lib" / "video-clip.ts",
    REPO_ROOT / "ui" / "lib" / "video-env.ts",
    REPO_ROOT / "ui" / "lib" / "video-generation-config.ts",
    REPO_ROOT / "ui" / "lib" / "video-upload.ts",
    REPO_ROOT / "ui" / "lib" / "volcengine-video.ts",
)
REMOVED_VIDEO_TOKENS = (
    "content-video-packaging",
    "video-package",
    "hyperframes",
    "ffmpeg",
    "ffprobe",
)


class ContractError(AssertionError):
    """Raised when active runtime declarations drift apart."""


def read(path: Path) -> str:
    if not path.is_file():
        raise ContractError(f"missing required file: {path.relative_to(REPO_ROOT)}")
    return path.read_text(encoding="utf-8")


def load_json(path: Path) -> Any:
    try:
        return json.loads(read(path))
    except json.JSONDecodeError as exc:
        raise ContractError(f"invalid JSON in {path.relative_to(REPO_ROOT)}: {exc}") from exc


def active_source_paths() -> list[Path]:
    paths = set(ACTIVE_SOURCE_FILES)
    for root in ACTIVE_SOURCE_ROOTS:
        if not root.is_dir():
            raise ContractError(f"missing active source directory: {root.relative_to(REPO_ROOT)}")
        for path in root.rglob("*"):
            if (
                not path.is_file()
                or path in ACTIVE_SOURCE_EXCLUSIONS
                or "__pycache__" in path.parts
                or "node_modules" in path.parts
                or path.suffix.lower() not in ACTIVE_SOURCE_SUFFIXES
            ):
                continue
            paths.add(path)
    return sorted(paths)


def codex_native_runtime_paths() -> list[Path]:
    """Return active executable/configuration surfaces, excluding archived plans."""
    paths = set(CODEX_NATIVE_RUNTIME_FILES)
    for root in CODEX_NATIVE_RUNTIME_ROOTS:
        if not root.is_dir():
            raise ContractError(f"missing Codex-native runtime directory: {root.relative_to(REPO_ROOT)}")
        for path in root.rglob("*"):
            if (
                not path.is_file()
                or path in CODEX_NATIVE_RUNTIME_EXCLUSIONS
                or "__pycache__" in path.parts
                or "node_modules" in path.parts
                or ".next" in path.parts
                or path.suffix.lower() not in ACTIVE_SOURCE_SUFFIXES
            ):
                continue
            paths.add(path)
    return sorted(paths)


def check_codex_native_runtime_boundary() -> None:
    """Block a hidden Superpowers workflow from re-entering active runtime paths."""
    offenders: list[str] = []
    for path in codex_native_runtime_paths():
        match = SUPERPOWERS_REFERENCE.search(read(path))
        if match:
            offenders.append(f"{path.relative_to(REPO_ROOT)}:{match.start()}")
    if offenders:
        raise ContractError(
            "active runtime must use Codex-native code, not a Superpowers dependency: "
            + ", ".join(offenders)
        )


def check_codex_native_documentation_boundary() -> None:
    """Keep the active operating docs clear while retaining historical plans."""
    missing: list[str] = []
    for path in CODEX_NATIVE_BOUNDARY_DOCS:
        if not CODEX_NATIVE_BOUNDARY.search(read(path)):
            missing.append(str(path.relative_to(REPO_ROOT)))
    if missing:
        raise ContractError(
            "active documentation must state the Codex-native, no-Superpowers boundary: "
            + ", ".join(missing)
        )


def literal_assignment(path: Path, name: str) -> Any:
    module = ast.parse(read(path), filename=str(path))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == name for target in node.targets
        ):
            return ast.literal_eval(node.value)
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name:
            return ast.literal_eval(node.value)
    raise ContractError(f"{path.relative_to(REPO_ROOT)} is missing literal {name}")


def validate_visual_provider_registry(registry: list[dict[str, Any]]) -> list[str]:
    required = ("license", "upstream", "pinned_revision", "permitted_use", "license_review")
    errors: list[str] = []
    for provider in registry:
        if provider.get("status") not in {"default", "verified"}:
            continue
        provider_id = str(provider.get("id") or "<missing-id>")
        for field in required:
            if not str(provider.get(field) or "").strip():
                errors.append(f"{provider_id}: missing {field}")
        source = str(provider.get("source") or "").strip()
        if source.startswith(("/", "~")) or re.match(r"^[A-Za-z]:[\\/]", source):
            errors.append(f"{provider_id}: source must be portable, not an absolute local path")
    return errors


def check_runtime_schema_contract() -> list[str]:
    steps = literal_assignment(CONTENT_RUNTIME, "STEPS")
    step_dirs = literal_assignment(CONTENT_RUNTIME, "STEP_DIRS")
    required_sections = literal_assignment(CONTENT_RUNTIME, "REQUIRED_SECTIONS")
    if not isinstance(steps, list) or not all(isinstance(step, str) for step in steps):
        raise ContractError("STEPS must be a literal list of strings")
    if len(steps) != len(set(steps)):
        raise ContractError("STEPS contains duplicate entries")
    if sorted(required_sections) != sorted(steps):
        raise ContractError("REQUIRED_SECTIONS keys must match STEPS")

    runtime_text = read(CONTENT_RUNTIME)
    for step in steps:
        directory = step_dirs.get(step, step)
        if f'self.pipeline / "{directory}"' not in runtime_text:
            raise ContractError(f"init() does not create pipeline directory for {step}")

    schema_files = [
        path for path in sorted(SCHEMAS_DIR.glob("*.schema.json"))
        if path.name not in AUXILIARY_SCHEMA_FILES
    ]
    schema_steps = [path.name.removesuffix(".schema.json") for path in schema_files]
    if sorted(schema_steps) != sorted(steps):
        raise ContractError(
            f"runtime schema mismatch: missing={sorted(set(steps) - set(schema_steps))}, "
            f"extra={sorted(set(schema_steps) - set(steps))}"
        )

    common = load_json(SCHEMAS_DIR / "common.json")
    common_steps = common["properties"]["frontmatter"]["properties"]["step"]["enum"]
    if common_steps != steps:
        raise ContractError("common.json step enum must match STEPS order")
    schema_readme = load_json(SCHEMAS_DIR / "README.json")
    if schema_readme.get("steps") != steps:
        raise ContractError("schemas/README.json steps must match STEPS order")
    readme_sections = schema_readme.get("required_sections")
    if not isinstance(readme_sections, dict) or set(readme_sections) != set(required_sections):
        raise ContractError("schemas/README.json required_sections must cover every runtime step")
    return steps


def check_delivery_contract(steps: list[str]) -> None:
    names = (
        "DRAFT_STEPS",
        "FINAL_DRAFT_STEPS",
        "REQUIRED_CORE_STEPS",
        "OPTIONAL_LEGACY_STEPS",
        "CHECK_STEPS",
        "OPTIONAL_LIFECYCLE_STEPS",
        "OPTIONAL_EVIDENCE_STEPS",
        "PLATFORM_TO_DRAFT",
        "LEGACY_PLATFORM_TO_DRAFT",
    )
    audit_values = {name: literal_assignment(DELIVERY_AUDIT, name) for name in names}
    pack_values = {name: literal_assignment(DELIVERY_PACK, name) for name in names}
    for name in names:
        if audit_values[name] != pack_values[name]:
            raise ContractError(f"delivery contract drift: {name}")

    for name in ("DRAFT_STEPS", "FINAL_DRAFT_STEPS", "REQUIRED_CORE_STEPS", "OPTIONAL_LEGACY_STEPS", "CHECK_STEPS", "OPTIONAL_LIFECYCLE_STEPS", "OPTIONAL_EVIDENCE_STEPS"):
        unknown = set(audit_values[name]) - set(steps)
        if unknown:
            raise ContractError(f"delivery contract {name} references unknown steps: {sorted(unknown)}")
    quality_report_steps = literal_assignment(DELIVERY_AUDIT, "QUALITY_REPORT_STEPS")
    if set(quality_report_steps) != set(audit_values["FINAL_DRAFT_STEPS"]):
        raise ContractError("quality reports must cover every final draft step")
    if set(audit_values["PLATFORM_TO_DRAFT"]) != {"wechat", "xhs", "xiaohongshu"}:
        raise ContractError("delivery platforms must be limited to WeChat and Xiaohongshu")
    if set(audit_values["LEGACY_PLATFORM_TO_DRAFT"]) != {"xhs", "xiaohongshu"}:
        raise ContractError("legacy delivery draft map must only contain Xiaohongshu aliases")


def check_skill_capability_tiers(manifest: dict[str, Any], included_names: set[str]) -> None:
    """Assert the manifest exposes only active production and enhancement domains."""
    config = manifest.get("capability_tiers")
    if not isinstance(config, dict) or config.get("schema") != CAPABILITY_TIER_SCHEMA:
        raise ContractError("skills/manifest.json capability_tiers has an unsupported schema")
    if config.get("default_tiers") != ["core"]:
        raise ContractError("skills/manifest.json default capability tier must be core")
    tiers = config.get("tiers")
    if not isinstance(tiers, dict) or set(tiers) != set(CAPABILITY_TIERS):
        raise ContractError("skills/manifest.json must define core and optional capability tiers")

    tier_sets: dict[str, set[str]] = {}
    declared: set[str] = set()
    for tier in CAPABILITY_TIERS:
        definition = tiers[tier]
        if not isinstance(definition, dict):
            raise ContractError(f"skills/manifest.json {tier} capability tier must be an object")
        skills = definition.get("skills")
        if not isinstance(skills, list) or not skills or not all(isinstance(name, str) and name for name in skills):
            raise ContractError(f"skills/manifest.json {tier} capability tier must list skills")
        names = set(skills)
        if len(names) != len(skills):
            raise ContractError(f"skills/manifest.json {tier} capability tier duplicates a skill")
        overlap = declared & names
        if overlap:
            raise ContractError(f"skills/manifest.json capability tiers overlap: {sorted(overlap)}")
        declared.update(names)
        tier_sets[tier] = names
    if declared != included_names:
        raise ContractError("skills/manifest.json capability tiers must cover every included skill exactly once")
    if tier_sets["core"] != CORE_PRODUCTION_SKILLS:
        raise ContractError("skills/manifest.json core tier must contain exactly default production skills")
    if tier_sets["optional"] != OPTIONAL_ENHANCEMENT_SKILLS:
        raise ContractError("skills/manifest.json optional tier must contain exactly the approved creative enhancements")
    if included_names != EXPOSED_SKILLS:
        raise ContractError("skills/manifest.json must not expose retired standalone skills")


def check_manifest_and_providers() -> None:
    manifest = load_json(MANIFEST)
    included = manifest.get("included_skills")
    if not isinstance(included, list):
        raise ContractError("skills/manifest.json included_skills must be a list")
    names: set[str] = set()
    for item in included:
        if not isinstance(item, dict):
            raise ContractError("skills/manifest.json contains an invalid skill entry")
        name = str(item.get("name") or "")
        path = str(item.get("path") or "")
        if not name or not path:
            raise ContractError("skills/manifest.json skill entries require name and path")
        if name in names:
            raise ContractError(f"skills/manifest.json duplicates {name}")
        names.add(name)
        if not (REPO_ROOT / path).is_file():
            raise ContractError(f"manifest points to missing skill: {path}")
    retired = names & RETIRED_SKILLS
    if retired:
        raise ContractError("manifest still exposes retired standalone skills: " + ", ".join(sorted(retired)))
    if "content-video-packaging" in names:
        raise ContractError("manifest still exposes removed content-video-packaging")
    check_skill_capability_tiers(manifest, names)

    providers = load_json(VISUAL_PROVIDERS)
    if not isinstance(providers, list) or not all(isinstance(item, dict) for item in providers):
        raise ContractError("visual_providers.json must be a list of objects")
    errors = validate_visual_provider_registry(providers)
    if errors:
        raise ContractError("; ".join(errors))

    runtime_routes = load_json(RUNTIME_IMAGE_ROUTES)
    if (
        runtime_routes.get("schema_version") != "echo-founder.runtime-image-route-catalog.v1"
        or runtime_routes.get("status") != "ready"
        or not isinstance(runtime_routes.get("routes"), list)
        or not runtime_routes["routes"]
    ):
        raise ContractError("runtime-image-routes.json must contain a ready non-empty route catalog")
    route_ids: set[str] = set()
    provider_by_credential = {
        "image_openrouter": "openrouter",
        "image_replicate": "replicate",
        "image_ark": "ark",
        "image_dashscope": "dashscope",
        "image_zai": "zai",
        "image_minimax": "minimax",
    }
    for route in runtime_routes["routes"]:
        if not isinstance(route, dict):
            raise ContractError("runtime image route entries must be objects")
        route_id = str(route.get("route_id") or "")
        credential_id = str(route.get("credential_id") or "")
        estimate = route.get("estimated_cost_cny")
        if (
            not route_id
            or route_id in route_ids
            or provider_by_credential.get(credential_id) != route.get("provider")
            or not str(route.get("model_id") or "")
            or route.get("runtime_eligible") is not True
            or not isinstance(estimate, (int, float))
            or isinstance(estimate, bool)
            or not 0 < float(estimate) <= 40
        ):
            raise ContractError(f"invalid bundled runtime image route: {route_id or '<missing>'}")
        route_ids.add(route_id)

    xhs_provider = next((item for item in providers if item.get("id") == "xhs-card"), None)
    xhs_package = load_json(REPO_ROOT / "skills" / "xhs-card" / "package.json")
    xhs_lock = load_json(REPO_ROOT / "skills" / "xhs-card" / "package-lock.json")
    xhs_lock_license = ((xhs_lock.get("packages") or {}).get("") or {}).get("license")
    if not isinstance(xhs_provider, dict) or xhs_provider.get("license") != "AGPL-3.0-only":
        raise ContractError("xhs-card provider registry must declare AGPL-3.0-only")
    if xhs_package.get("license") != "AGPL-3.0-only" or xhs_lock_license != "AGPL-3.0-only":
        raise ContractError("xhs-card package metadata must declare AGPL-3.0-only")
    if "GNU AFFERO GENERAL PUBLIC LICENSE" not in read(REPO_ROOT / "skills" / "xhs-card" / "LICENSE"):
        raise ContractError("xhs-card LICENSE must contain the GNU AGPL license")
    readmes = {
        "README.md": read(REPO_ROOT / "skills" / "xhs-card" / "README.md"),
        "README.en.md": read(REPO_ROOT / "skills" / "xhs-card" / "README.en.md"),
    }
    for name, contents in readmes.items():
        if "AGPL-3.0-only" not in contents or "LICENSE" not in contents:
            raise ContractError(f"xhs-card {name} must disclose AGPL-3.0-only and the authoritative LICENSE")
        forbidden_claims = ("No paid-only distribution", "permits charging fees", "可以收费和商业使用")
        if any(claim in contents for claim in forbidden_claims):
            raise ContractError(f"xhs-card {name} must not substitute a license interpretation for independent review")
    modifications = read(REPO_ROOT / "skills" / "xhs-card" / "MODIFICATIONS.md")
    for required in ("AGPL-3.0-only", "source snapshot", "original text in `LICENSE` is authoritative", "independent"):
        if required not in modifications:
            raise ContractError(f"xhs-card MODIFICATIONS.md is missing source-availability disclosure: {required}")
    permitted_use = str(xhs_provider.get("permitted_use") or "")
    if "preserve the bundled source and notices" not in permitted_use or "network-service" not in permitted_use:
        raise ContractError("xhs-card provider registry must record AGPL source and network-use review boundaries")

    notices = read(THIRD_PARTY_NOTICES)
    required_reference_only_notice = (
        "## wshuyi/remotion-video-skill",
        "License: no license was declared",
        "Use: reference-only evaluation",
        "no code, dependency, template, or runtime",
    )
    missing_notice = [item for item in required_reference_only_notice if item not in notices]
    if missing_notice:
        raise ContractError(f"third-party notice is missing the reference-only unlicensed source boundary: {missing_notice}")
    required_shipped_notice = (
        "## Components shipped in the desktop App",
        "LICENSES.chromium.html",
        "Next-standalone-NOTICES.txt",
        "next/dist/compiled",
        "fsevents",
        "every shipped `.dist-info`",
        "complete customer source snapshot",
        "README.en.md",
        "TikOmni API connector boundary",
        "approved snapshot",
        "NOASSERTION",
        "AGPL-3.0-only",
    )
    missing_shipped_notice = [item for item in required_shipped_notice if item not in notices]
    if missing_shipped_notice:
        raise ContractError(f"third-party notice is missing a shipped dependency boundary: {missing_shipped_notice}")


def removed_surface_scan_text(path: Path) -> str:
    text = read(path)
    if path == THIRD_PARTY_NOTICES:
        marker = "## wshuyi/remotion-video-skill"
        start = text.find(marker)
        if start >= 0:
            end = text.find("\n## ", start + len(marker))
            text = text[:start] + (text[end:] if end >= 0 else "")
    return text.lower()


def check_removed_video_surface() -> None:
    restored_paths = [path.relative_to(REPO_ROOT) for path in REMOVED_VIDEO_PATHS if path.exists()]
    if restored_paths:
        raise ContractError(
            "removed video paths were restored: " + ", ".join(str(path) for path in restored_paths)
        )

    for path in active_source_paths():
        lower = removed_surface_scan_text(path)
        hits = [token for token in REMOVED_VIDEO_TOKENS if token in lower]
        if hits:
            raise ContractError(f"removed video surface remains in {path.relative_to(REPO_ROOT)}: {', '.join(hits)}")


def check_scripted_video_package_contract() -> None:
    """Permit publish-ready scripts without restoring render/upload products."""
    package_skill = read(REPO_ROOT / "skills" / "content-package" / "SKILL.md")
    release_gate = read(RUNTIME_SCRIPTS / "release_gate.py")
    required_skill_markers = (
        "## 3. 视频号原生口播",
        "### 逐句口播稿",
        "### 镜头清单",
        "### 字幕重点",
        "### B-roll 建议",
        "### 发布文案",
    )
    missing_skill_markers = [marker for marker in required_skill_markers if marker not in package_skill]
    if missing_skill_markers:
        raise ContractError("content-package short-video contract is incomplete: " + ", ".join(missing_skill_markers))
    required_quality_markers = ("PRIMARY_PLATFORMS", "_build_native_package_manifest", '"### B-roll 建议"')
    missing_quality_markers = [marker for marker in required_quality_markers if marker not in release_gate]
    if missing_quality_markers:
        raise ContractError("package quality short-video gate is incomplete: " + ", ".join(missing_quality_markers))


def check_legacy_media_read_only_compatibility() -> None:
    text = read(MATERIALS_API)
    required = (
        "REMOVED_MEDIA_EXTENSIONS",
        "仅保留下载兼容，不再进入解析或生产流程",
        "materialDownloadResponse",
    )
    missing = [needle for needle in required if needle not in text]
    if missing:
        raise ContractError(
            "legacy media compatibility is incomplete in ui/app/api/materials/route.ts: "
            + ", ".join(missing)
        )


def main() -> int:
    try:
        check_codex_native_runtime_boundary()
        check_codex_native_documentation_boundary()
        steps = check_runtime_schema_contract()
        check_delivery_contract(steps)
        check_manifest_and_providers()
        check_removed_video_surface()
        check_scripted_video_package_contract()
        check_legacy_media_read_only_compatibility()
    except (ContractError, ValueError, SyntaxError) as exc:
        print(f"FAIL runtime contracts: {exc}", file=sys.stderr)
        return 1
    print("PASS Codex-native runtime independence")
    print("PASS Codex-native documentation boundary")
    print(f"PASS runtime declarations: {len(steps)} steps")
    print("PASS delivery contract")
    print("PASS skill manifest and visual provenance")
    print("PASS skill capability tiers")
    print("PASS removed video surface")
    print("PASS scripted video package contract")
    print("PASS legacy media read-only compatibility")
    print("PASS runtime contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
