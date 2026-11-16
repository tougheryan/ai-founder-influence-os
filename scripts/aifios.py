#!/usr/bin/env python3
"""Unified Echo Founder command entry.

The AIFIOS-prefixed environment variables below are retained as internal and
historical compatibility identifiers.

This CLI is intentionally a thin wrapper. It keeps user-facing commands compact
and delegates the actual work to the already-tested runtime/session/hit scripts.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))


def _load_local_release_gate():
    """Load this CLI's sibling module without colliding with runtime modules."""
    module_name = "echo_founder_cli_release_gate"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(module_name, SCRIPT_DIR / "release_gate.py")
    if spec is None or spec.loader is None:
        raise ImportError("Cannot load Echo Founder release gate")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_release_gate = _load_local_release_gate()
default_markdown_report_path = _release_gate.default_markdown_report_path
refresh_manifest_check = _release_gate.refresh_manifest_check
render_markdown_report = _release_gate.render_markdown_report
write_markdown_report = _release_gate.write_markdown_report


REPO_ROOT = SCRIPT_DIR.parent
RUNTIME_DIR = REPO_ROOT / "skills" / "content-runtime"
RUNTIME_SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
UI_DIR = REPO_ROOT / "ui"
PYTHON = sys.executable or "python3"
DEFAULT_PROJECT = "~/Echo Founder"
LEGACY_DEFAULT_PROJECT = "~/ai-content-system"

PLATFORM_ALIASES = {
    "wechat": "wechat",
    "weixin": "wechat",
    "wechat_mp": "wechat",
    "mp.weixin.qq.com": "wechat",
    "微信": "wechat",
    "公众号": "wechat",
    "微信公号": "wechat",
    "xhs": "xhs",
    "rednote": "xhs",
    "xiaohongshu": "xhs",
    "小红书": "xhs",
}

TIKOMNI_BENCHMARK_PRESETS = {
    "xhs": {
        "endpoint_id": "xiaohongshu.search.app_v2.search_notes",
        "params": {"page": 1},
    },
    "wechat": {
        "endpoint_id": "wechat_search.search.v2.fetch_search",
        "params": {"business_type": "article", "raw": False},
    },
}


class CliError(Exception):
    """User-facing CLI error."""


def expand_path(value: str) -> str:
    return str(Path(value).expanduser().resolve(strict=False))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def archive_sidecar_check(archive: str, actual_sha256: str) -> dict[str, Any]:
    sidecar_path = f"{archive}.sha256" if archive else ""
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
    return {
        "path": sidecar_path,
        "exists": exists,
        "expected_sha256": expected_sha256,
        "actual_sha256": actual_sha256,
        "filename": filename,
        "filename_matches": filename_matches,
        "matches": matches,
    }


def extract_project(argv: list[str]) -> tuple[str, list[str]]:
    """Allow --project/-p before or after subcommands."""
    configured = os.environ.get("AIFIOS_PROJECT")
    preferred = Path(DEFAULT_PROJECT).expanduser()
    legacy = Path(LEGACY_DEFAULT_PROJECT).expanduser()
    project = configured or str(legacy if not preferred.exists() and legacy.exists() else preferred)
    cleaned: list[str] = []
    index = 0
    while index < len(argv):
        item = argv[index]
        if item in {"--project", "-p"}:
            if index + 1 >= len(argv):
                raise CliError("--project requires a value")
            project = argv[index + 1]
            index += 2
        elif item.startswith("--project="):
            project = item.split("=", 1)[1]
            index += 1
        else:
            cleaned.append(item)
            index += 1
    return expand_path(project), cleaned


def normalize_platform(value: str) -> str:
    key = str(value or "").strip().lower()
    platform = PLATFORM_ALIASES.get(key, key)
    if platform not in {"wechat", "xhs"}:
        raise CliError(f"未知平台: {value}；可用: wechat, xhs")
    return platform


def joined(values: list[str] | None) -> str:
    return " ".join(values or []).strip()


def append_flag(command: list[str], flag: str, value: Any) -> None:
    if value not in (None, ""):
        command.extend([flag, str(value)])


def parse_json_object(value: str, label: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError as exc:
        raise CliError(f"{label} 必须是 JSON 对象: {exc}") from exc
    if not isinstance(parsed, dict):
        raise CliError(f"{label} 必须是 JSON 对象")
    return parsed


def tikomni_benchmark_preset(platform: str, keyword: str, params_json: str = "{}") -> tuple[str, dict[str, Any]]:
    normalized = normalize_platform(platform)
    keyword = (keyword or "").strip()
    if not keyword:
        raise CliError("collect-benchmark 需要 --keyword")
    preset = TIKOMNI_BENCHMARK_PRESETS[normalized]
    params = dict(preset["params"])
    params["keyword"] = keyword
    params.update(parse_json_object(params_json, "--params"))
    return str(preset["endpoint_id"]), params


def absolute_file(value: str) -> str:
    if not value:
        return value
    return str(Path(value).expanduser().resolve(strict=False))


def run(command: list[str], cwd: Path = REPO_ROOT) -> int:
    return subprocess.run(command, cwd=cwd, env=ui_node_env(os.environ.copy())).returncode


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def run_text(command: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    return result.returncode == 0, result.stdout.strip()


def parse_semver(value: str) -> tuple[int, int, int] | None:
    match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", value or "")
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def required_node_version() -> tuple[int, int, int]:
    try:
        pkg = json.loads((UI_DIR / "package.json").read_text(encoding="utf-8"))
        engine = str(pkg.get("engines", {}).get("node", ">=20.9.0"))
    except (OSError, json.JSONDecodeError):
        engine = ">=20.9.0"
    match = re.search(r">=\s*(\d+)\.(\d+)\.(\d+)", engine)
    if not match:
        return (20, 9, 0)
    return tuple(int(part) for part in match.groups())


def format_semver(version: tuple[int, int, int]) -> str:
    return ".".join(str(part) for part in version)


def ui_node_binary(env: dict[str, str]) -> str:
    return env.get("AIFIOS_NODE_BINARY", "").strip() or "node"


def ui_node_env(env: dict[str, str]) -> dict[str, str]:
    node_env = env.copy()
    if node_env.get("AIFIOS_NODE_RUN_AS_NODE") == "1":
        node_env["ELECTRON_RUN_AS_NODE"] = "1"
    return node_env


def ui_next_cli_path() -> Path:
    return UI_DIR / "node_modules" / "next" / "dist" / "bin" / "next"


def ui_dist_dir(env: dict[str, str]) -> Path:
    dist_name = env.get("AIFIOS_NEXT_DIST_DIR", "").strip() or ".next"
    return UI_DIR / dist_name


def ui_standalone_server_path(env: dict[str, str]) -> Path:
    return ui_dist_dir(env) / "standalone" / "server.js"


def use_prebuilt_ui_standalone(env: dict[str, str]) -> bool:
    return env.get("AIFIOS_NEXT_STANDALONE") == "1" and env.get("AIFIOS_SKIP_UI_BUILD") == "1"


def ui_production_build_ready(env: dict[str, str]) -> bool:
    dist_dir = ui_dist_dir(env)
    if use_prebuilt_ui_standalone(env):
        return (dist_dir / "BUILD_ID").is_file() and ui_standalone_server_path(env).is_file()
    return (dist_dir / "BUILD_ID").is_file() and (dist_dir / "server").is_dir()


def ui_dependencies_installed() -> bool:
    return (
        (UI_DIR / "node_modules").is_dir()
        and ui_next_cli_path().exists()
    )


def install_ui_dependencies(env: dict[str, str]) -> int:
    npm_binary = env.get("AIFIOS_NPM_BINARY", "").strip() or "npm"
    package_lock = UI_DIR / "package-lock.json"
    command = [npm_binary, "ci"] if package_lock.exists() else [npm_binary, "install"]
    print(f"Installing UI dependencies: {' '.join(command)}", flush=True)
    return subprocess.run(command, cwd=UI_DIR, env=env).returncode


def build_ui_production(env: dict[str, str]) -> int:
    command = [ui_node_binary(env), str(ui_next_cli_path()), "build", "--webpack"]
    print(f"Building UI production bundle: {' '.join(command)}", flush=True)
    return subprocess.run(command, cwd=UI_DIR, env=ui_node_env(env)).returncode


def ui_server_command(server_mode: str, host: str, port: int, env: dict[str, str]) -> list[str]:
    if server_mode == "production":
        if env.get("AIFIOS_NEXT_STANDALONE") == "1":
            return [ui_node_binary(env), str(ui_standalone_server_path(env))]
        return [ui_node_binary(env), str(ui_next_cli_path()), "start", "--hostname", host, "--port", str(port)]
    return [ui_node_binary(env), str(ui_next_cli_path()), "dev", "--hostname", host, "--port", str(port)]


def ensure_project_initialized(project: str) -> int:
    command = [
        PYTHON,
        str(RUNTIME_SCRIPTS / "content_runtime.py"),
        "--project",
        project,
        "init",
    ]
    try:
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"FAIL project initialization timed out: {project}", file=sys.stderr)
        output = "\n".join(part for part in [exc.stdout or "", exc.stderr or ""] if part)
        if output:
            print(output, file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"FAIL unable to initialize project data directory: {project}", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1
    if result.returncode != 0:
        print(f"FAIL unable to initialize project data directory: {project}", file=sys.stderr)
        output = "\n".join(part for part in [result.stdout.strip(), result.stderr.strip()] if part)
        if output:
            print(output, file=sys.stderr)
    return result.returncode


def runtime(project: str, args: list[str]) -> int:
    return run([PYTHON, str(RUNTIME_SCRIPTS / "content_runtime.py"), "--project", project, *args])


def session(project: str, args: list[str]) -> int:
    return run([PYTHON, str(RUNTIME_SCRIPTS / "session_manager.py"), "--project", project, *args])


def director(project: str, args: list[str]) -> int:
    return run([PYTHON, str(RUNTIME_SCRIPTS / "content_pipeline.py"), "--project", project, *args])


def hit(project: str, args: list[str]) -> int:
    return run([PYTHON, str(RUNTIME_SCRIPTS / "hit_collector.py"), "--project", project, *args])


def cmd_init(args: argparse.Namespace, project: str) -> int:
    command = ["init"]
    if args.demo:
        command.append("--demo")
    return runtime(project, command)


def cmd_start(args: argparse.Namespace, project: str) -> int:
    command = ["start"]
    text = joined(args.input)
    if text:
        command.append(text)
    if args.json:
        command.append("--json")
    return session(project, command)


def cmd_onboard(args: argparse.Namespace, project: str) -> int:
    command = ["onboard"]
    for flag in ["goal", "platforms", "offer", "target", "product"]:
        append_flag(command, f"--{flag}", getattr(args, flag))
    if args.json:
        command.append("--json")
    return session(project, command)


def cmd_work(args: argparse.Namespace, project: str) -> int:
    command = [args.command]
    text = joined(args.input)
    if text:
        command.append(text)
    if args.json:
        command.append("--json")
    return session(project, command)


def cmd_status(args: argparse.Namespace, project: str) -> int:
    command: list[str] = []
    append_flag(command, "--slug", args.slug)
    command.append("status")
    return director(project, command)


def cmd_next(args: argparse.Namespace, project: str) -> int:
    command: list[str] = []
    append_flag(command, "--slug", args.slug)
    command.append("next")
    return director(project, command)


def cmd_flow(args: argparse.Namespace, project: str) -> int:
    command = ["flow"]
    append_flag(command, "--intake", absolute_file(args.intake))
    append_flag(command, "--slug", args.slug)
    return director(project, command)


def cmd_write(args: argparse.Namespace, project: str) -> int:
    content = args.content
    if content.startswith("@"):
        content = "@" + absolute_file(content[1:])
        command = ["write", "--step", args.step, "--slug", args.slug, "--content", content]
        append_flag(command, "--source", args.source)
        return runtime(project, command)

    with tempfile.TemporaryDirectory(prefix="aifios-cli-write-") as temp_dir:
        content_path = Path(temp_dir) / "content.md"
        content_path.write_text(content, encoding="utf-8")
        command = ["write", "--step", args.step, "--slug", args.slug, "--content", f"@{content_path}"]
        append_flag(command, "--source", args.source)
        return runtime(project, command)


def cmd_read(args: argparse.Namespace, project: str) -> int:
    command = ["read", "--step", args.step]
    if args.file:
        append_flag(command, "--file", args.file)
    else:
        command.append("--latest")
        append_flag(command, "--slug", args.slug)
    return runtime(project, command)


def selected_run_id(args: argparse.Namespace) -> str | None:
    return getattr(args, "run_id", None) or getattr(args, "run_id_pos", None)


def cmd_run_group(args: argparse.Namespace, project: str) -> int:
    if args.run_command == "create":
        command = ["run-create"]
        append_flag(command, "--topic", args.topic)
        append_flag(command, "--platforms", args.platforms)
        append_flag(command, "--slug", args.slug)
        append_flag(command, "--run-id", args.run_id)
        append_flag(command, "--goal", args.goal)
        append_flag(command, "--success-metric", args.success_metric)
        append_flag(command, "--baseline", args.baseline)
        append_flag(command, "--target", args.target)
        return runtime(project, command)
    if args.run_command == "list":
        return runtime(project, ["runs", "--limit", str(args.limit)])
    if args.run_command == "show":
        command = ["run"]
        append_flag(command, "--run-id", selected_run_id(args))
        append_flag(command, "--slug", args.slug)
        return runtime(project, command)
    if args.run_command == "switch":
        run_id = selected_run_id(args)
        if not run_id:
            raise CliError("run switch requires RUN_ID")
        return runtime(project, ["run-switch", "--run-id", run_id])
    if args.run_command == "resume":
        command = ["run-resume"]
        append_flag(command, "--run-id", selected_run_id(args))
        return runtime(project, command)
    if args.run_command == "archive":
        command = ["run-archive"]
        append_flag(command, "--run-id", selected_run_id(args))
        return runtime(project, command)
    raise CliError(f"unknown run command: {args.run_command}")


def cmd_quality(args: argparse.Namespace, project: str) -> int:
    command = ["--platform", normalize_platform(args.platform)]
    append_flag(command, "--file", args.file)
    append_flag(command, "--step", args.step)
    append_flag(command, "--slug", args.slug)
    append_flag(command, "--min-score", args.min_score)
    return run([PYTHON, str(RUNTIME_SCRIPTS / "quality_check.py"), "--project", project, *command])


def cmd_delivery(args: argparse.Namespace, project: str) -> int:
    command: list[str] = []
    append_flag(command, "--run-id", args.run_id)
    append_flag(command, "--slug", args.slug)
    return run([PYTHON, str(RUNTIME_SCRIPTS / "delivery_pack.py"), "--project", project, *command])


def cmd_delivery_audit(args: argparse.Namespace, project: str) -> int:
    command: list[str] = []
    append_flag(command, "--run-id", args.run_id)
    append_flag(command, "--slug", args.slug)
    if args.auto_pack:
        command.append("--auto-pack")
    return run([PYTHON, str(RUNTIME_SCRIPTS / "delivery_audit.py"), "--project", project, *command])


def cmd_dbs_fusion_apply(args: argparse.Namespace, project: str) -> int:
    command: list[str] = []
    append_flag(command, "--file", args.file)
    append_flag(command, "--slug", args.slug)
    if args.dry_run:
        command.append("--dry-run")
    if args.force:
        command.append("--force")
    return run([PYTHON, str(RUNTIME_SCRIPTS / "dbs_fusion_apply.py"), "--project", project, *command])


def cmd_performance_group(args: argparse.Namespace, project: str) -> int:
    if args.performance_command == "wechat-browser":
        command = [
            ui_node_binary(os.environ),
            str(RUNTIME_SCRIPTS / "wechat_mp_browser_collector.mjs"),
            "--project",
            project,
        ]
        for flag in [
            "slug", "title", "publish_url", "published_at", "url", "profile", "fixture",
            "auto_timeout_ms", "max_articles", "max_pages",
        ]:
            value = getattr(args, flag)
            cli_flag = f"--{flag.replace('_', '-')}"
            append_flag(command, cli_flag, value)
        if args.auto_after_login:
            command.append("--auto-after-login")
        if args.all_published:
            command.append("--all-published")
        if args.capture_content:
            command.append("--capture-content")
        if args.no_wait:
            command.append("--no-wait")
        if args.headless:
            command.append("--headless")
        return run(command)

    command = [
        PYTHON,
        str(RUNTIME_SCRIPTS / "performance_collector.py"),
        "--project",
        project,
        args.performance_command,
    ]
    if args.performance_command == "mock-wechat":
        command.extend(["--slug", args.slug, "--title", args.title])
    elif args.performance_command == "wechat":
        for flag in [
            "file", "slug", "title", "article_id", "publish_url", "published_at", "publish_asset",
            "authorization_mode", "authorization_record", "data_source", "captured_by", "evidence",
            "exposures", "reads", "readers", "likes", "wows", "comments", "shares", "collects",
            "new_followers", "profile_visits", "leads",
        ]:
            value = getattr(args, flag)
            cli_flag = f"--{flag.replace('_', '-')}"
            append_flag(command, cli_flag, value)
        for value in args.comment or []:
            command.extend(["--comment", value])
        for value in args.benchmark_report or []:
            command.extend(["--benchmark-report", value])
    elif args.performance_command == "wechat-api":
        for flag in [
            "slug", "article_id", "msg_data_id", "published_at", "begin_date", "end_date", "comment_limit",
        ]:
            value = getattr(args, flag)
            cli_flag = f"--{flag.replace('_', '-')}"
            append_flag(command, cli_flag, value)
        for value in args.benchmark_report or []:
            command.extend(["--benchmark-report", value])
    return run(command)


def cmd_hit_group(args: argparse.Namespace, project: str) -> int:
    if args.hit_command == "init":
        return hit(project, ["init"])
    if args.hit_command == "add":
        command = ["add", "--platform", normalize_platform(args.platform), "--title", args.title]
        for flag in [
            "url", "author", "keyword", "topic", "cover_text", "hook",
            "audience_pain", "commercial_angle", "why_it_worked", "tags",
            "reads", "likes", "collects", "comments", "shares", "wows", "recommends",
        ]:
            value = getattr(args, flag)
            cli_flag = f"--{flag.replace('_', '-')}"
            append_flag(command, cli_flag, value)
        return hit(project, command)
    if args.hit_command in {"import", "queue"}:
        command = [args.hit_command, "--platform", normalize_platform(args.platform), "--file", absolute_file(args.file)]
        append_flag(command, "--format", args.format)
        append_flag(command, "--keyword", args.keyword)
        append_flag(command, "--topic", args.topic)
        if args.hit_command == "import":
            if args.preview:
                command.append("--preview")
            if args.confirm:
                command.append("--confirm")
        return hit(project, command)
    if args.hit_command == "list":
        command = ["list"]
        if args.platform:
            append_flag(command, "--platform", normalize_platform(args.platform))
        append_flag(command, "--keyword", args.keyword)
        append_flag(command, "--limit", args.limit)
        return hit(project, command)
    if args.hit_command == "report":
        command = ["report"]
        if args.platform:
            append_flag(command, "--platform", normalize_platform(args.platform))
        append_flag(command, "--keyword", args.keyword)
        append_flag(command, "--limit", args.limit)
        return hit(project, command)
    if args.hit_command == "queue-list":
        return hit(project, ["queue-list"])
    if args.hit_command == "queue-import":
        command = ["queue-import", "--file", args.file]
        if args.confirm:
            command.append("--confirm")
        return hit(project, command)
    if args.hit_command == "queue-reject":
        command = ["queue-reject", "--file", args.file]
        append_flag(command, "--reason", args.reason)
        return hit(project, command)
    raise CliError(f"unknown hit command: {args.hit_command}")


def cmd_tikomni_group(args: argparse.Namespace, project: str) -> int:
    adapter_command = "hit-fetch" if args.tikomni_command == "collect-benchmark" else args.tikomni_command
    command = [PYTHON, str(RUNTIME_SCRIPTS / "tikomni_adapter.py"), "--project", project, adapter_command]
    if args.tikomni_command == "hit-import":
        command.extend(["--platform", normalize_platform(args.platform), "--file", absolute_file(args.file)])
        append_flag(command, "--keyword", args.keyword)
        append_flag(command, "--topic", args.topic)
        if args.queue:
            command.append("--queue")
    elif args.tikomni_command == "performance-import":
        command.extend(["--platform", normalize_platform(args.platform), "--file", absolute_file(args.file)])
        append_flag(command, "--slug", args.slug)
        append_flag(command, "--authorization-mode", args.authorization_mode)
        append_flag(command, "--captured-by", args.captured_by)
    elif args.tikomni_command == "api-fetch":
        command.extend([
            "--platform", normalize_platform(args.platform),
            "--endpoint-id", args.endpoint_id,
            "--params", args.params,
        ])
        append_flag(command, "--kind", args.kind)
        append_flag(command, "--skill-dir", args.skill_dir)
        append_flag(command, "--env-file", args.env_file)
        append_flag(command, "--timeout-ms", args.timeout_ms)
    elif args.tikomni_command == "hit-fetch":
        command.extend([
            "--platform", normalize_platform(args.platform),
            "--endpoint-id", args.endpoint_id,
            "--params", args.params,
        ])
        append_flag(command, "--keyword", args.keyword)
        append_flag(command, "--topic", args.topic)
        append_flag(command, "--skill-dir", args.skill_dir)
        append_flag(command, "--env-file", args.env_file)
        append_flag(command, "--timeout-ms", args.timeout_ms)
        append_flag(command, "--enrich-limit", args.enrich_limit)
        if args.queue:
            command.append("--queue")
        if args.enrich_details:
            command.append("--enrich-details")
        if args.infer_insights:
            command.append("--infer-insights")
    elif args.tikomni_command == "collect-benchmark":
        endpoint_id, params = tikomni_benchmark_preset(args.platform, args.keyword, args.params)
        command.extend([
            "--platform", normalize_platform(args.platform),
            "--endpoint-id", endpoint_id,
            "--params", json.dumps(params, ensure_ascii=False),
        ])
        append_flag(command, "--keyword", args.keyword)
        append_flag(command, "--topic", args.topic or args.keyword)
        append_flag(command, "--skill-dir", args.skill_dir)
        append_flag(command, "--env-file", args.env_file)
        append_flag(command, "--timeout-ms", args.timeout_ms)
        append_flag(command, "--enrich-limit", args.enrich_limit)
        if args.queue:
            command.append("--queue")
        if args.enrich_details:
            command.append("--enrich-details")
        if args.infer_insights:
            command.append("--infer-insights")
    else:
        raise CliError(f"unknown tikomni command: {args.tikomni_command}")
    return run(command)


def browser_collect_command(args: argparse.Namespace, project: str, queue: bool = False) -> list[str]:
    command = [
        ui_node_binary(os.environ),
        str(RUNTIME_SCRIPTS / "browser_hit_collector.mjs"),
        "--project",
        project,
        "--platform",
        normalize_platform(args.platform),
    ]
    if queue:
        command.append("--queue")
    for flag in ["keyword", "url", "profile", "limit", "max_scrolls"]:
        value = getattr(args, flag)
        cli_flag = f"--{flag.replace('_', '-')}"
        append_flag(command, cli_flag, value)
    if args.no_wait:
        command.append("--no-wait")
    if args.headless:
        command.append("--headless")
    if args.diagnostics:
        command.append("--diagnostics")
    return command


def cmd_browser_group(args: argparse.Namespace, project: str) -> int:
    if args.browser_command == "doctor":
        return run([ui_node_binary(os.environ), str(RUNTIME_SCRIPTS / "browser_hit_doctor.mjs")])
    if args.browser_command == "fixture-check":
        del project
        return run([ui_node_binary(os.environ), str(RUNTIME_SCRIPTS / "browser_hit_fixture_check.mjs")])
    if args.browser_command == "install":
        return run(["npm", "install"], cwd=REPO_ROOT / "skills" / "xhs-card")
    if args.browser_command == "collect":
        return run(browser_collect_command(args, project, queue=False))
    if args.browser_command == "queue":
        return run(browser_collect_command(args, project, queue=True))
    raise CliError(f"unknown browser command: {args.browser_command}")


def cmd_demo(args: argparse.Namespace, project: str) -> int:
    command = [PYTHON, str(REPO_ROOT / "scripts" / "demo.py"), "--project", project]
    append_flag(command, "--slug", args.slug)
    append_flag(command, "--platform", args.platform)
    if args.reset:
        command.append("--reset")
    return run(command)


def cmd_doctor(args: argparse.Namespace, project: str) -> int:
    del project
    command = [PYTHON, str(REPO_ROOT / "scripts" / "doctor.py"), "--install-dir", expand_path(args.install_dir)]
    if args.strict:
        command.append("--strict")
    if args.require_install:
        command.append("--require-install")
    if args.require_external:
        command.append("--require-external")
    if args.require_ui_deps:
        command.append("--require-ui-deps")
    if args.skip_ui:
        command.append("--skip-ui")
    if args.show_resolutions:
        command.append("--show-resolutions")
    if args.json:
        command.append("--json")
    if args.report:
        command.extend(["--report", expand_path(args.report)])
    return run(command)


def cmd_verify(args: argparse.Namespace, project: str) -> int:
    del project
    report = Path(args.report).expanduser().resolve(strict=False) if args.report else Path("/private/tmp/aifios-verify/doctor-report.json")
    demo_project = Path(args.demo_project).expanduser().resolve(strict=False)
    failures: list[str] = []
    completed: list[str] = []

    steps: list[tuple[str, list[str], Path]] = []
    doctor_command = [
        PYTHON,
        str(REPO_ROOT / "scripts" / "doctor.py"),
        "--install-dir",
        expand_path(args.install_dir),
        "--show-resolutions",
        "--report",
        str(report),
    ]
    if not args.skip_install_check:
        doctor_command.append("--require-install")
    if args.strict:
        doctor_command.append("--strict")
    if args.require_external:
        doctor_command.append("--require-external")
    if args.require_ui_deps:
        doctor_command.append("--require-ui-deps")
    if args.skip_ui:
        doctor_command.append("--skip-ui")
    steps.append(("doctor", doctor_command, REPO_ROOT))

    if not args.skip_tests:
        steps.append(("manifest", [PYTHON, str(RUNTIME_SCRIPTS / "check_manifest.py")], REPO_ROOT))
        steps.append(("runtime-contracts", [PYTHON, str(REPO_ROOT / "scripts" / "check_runtime_contracts.py")], REPO_ROOT))
        steps.append(("runtime-tests", [PYTHON, str(RUNTIME_DIR / "tests" / "test_runtime.py")], REPO_ROOT))
    if not args.skip_demo:
        steps.append(("platform-demo", [PYTHON, str(REPO_ROOT / "scripts" / "demo.py"), "--project", str(demo_project), "--platform", "all", "--reset"], REPO_ROOT))
    if not args.skip_browser_fixture:
        steps.append(("browser-fixture", [ui_node_binary(os.environ), str(RUNTIME_SCRIPTS / "browser_hit_fixture_check.mjs")], REPO_ROOT))

    for label, command, cwd in steps:
        print(f"\n== {label} ==")
        print("+ " + " ".join(shlex.quote(part) for part in command))
        try:
            result = subprocess.run(command, cwd=cwd, env=ui_node_env(os.environ.copy()))
        except OSError as exc:
            print(f"FAIL {label}: {exc}", file=sys.stderr)
            failures.append(label)
            continue
        if result.returncode != 0:
            failures.append(label)
        else:
            completed.append(label)

    if failures:
        print(f"\nFAIL verify: {', '.join(failures)}")
        print(f"Doctor report: {report}")
        return 1

    print(f"\nPASS verify: completed {', '.join(completed)}.")
    print(f"Doctor report: {report}")
    if not args.skip_demo:
        print(f"Demo project: {demo_project}")
    return 0


def cmd_install(args: argparse.Namespace, project: str) -> int:
    del project
    command = [
        PYTHON,
        str(REPO_ROOT / "scripts" / "install.py"),
        "--install-dir",
        expand_path(args.install_dir),
        "--mode",
        args.mode,
    ]
    if args.force:
        command.append("--force")
    if args.dry_run:
        command.append("--dry-run")
    if args.external_plan:
        command.append("--external-plan")
    return run(command)


def cmd_install_cli(args: argparse.Namespace, project: str) -> int:
    del project
    bin_dir = Path(args.bin_dir).expanduser().resolve(strict=False)
    target = bin_dir / "aifios"
    source = REPO_ROOT / "scripts" / "aifios.py"
    wrapper = (
        "#!/bin/sh\n"
        f"exec {shlex.quote(PYTHON)} {shlex.quote(str(source))} \"$@\"\n"
    )
    if target.exists() and not args.force:
        print(f"FAIL {target} already exists; rerun with --force to replace it", file=sys.stderr)
        return 1
    if args.dry_run:
        print(f"DRY install aifios CLI -> {target}")
        print(wrapper.rstrip())
        return 0
    bin_dir.mkdir(parents=True, exist_ok=True)
    target.write_text(wrapper, encoding="utf-8")
    target.chmod(0o755)
    print(f"PASS installed aifios CLI: {target}")
    print(f"Try: {target} --help")
    return 0


def cmd_package(args: argparse.Namespace, project: str) -> int:
    del project
    command = [PYTHON, str(REPO_ROOT / "scripts" / "package.py"), "--dist-dir", args.dist_dir]
    append_flag(command, "--name", args.name)
    return run(command)


def cmd_release_gate(args: argparse.Namespace, project: str) -> int:
    del project
    command = [
        PYTHON,
        str(REPO_ROOT / "scripts" / "release_gate.py"),
        "--dist-dir",
        args.dist_dir,
        "--quickstart-work-dir",
        args.quickstart_work_dir,
        "--smoke-work-dir",
        args.smoke_work_dir,
        "--report",
        args.report,
    ]
    append_flag(command, "--archive", args.archive)
    append_flag(command, "--markdown-report", args.markdown_report)
    return run(command)


def load_release_report(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CliError(f"release gate report not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CliError(f"release gate report is invalid JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise CliError(f"release gate report must be a JSON object: {path}")
    return payload


def cmd_release_report(args: argparse.Namespace, project: str) -> int:
    del project
    report_path = Path(args.report).expanduser().resolve(strict=False)
    payload = load_release_report(report_path)
    steps = payload.get("steps")
    if not isinstance(steps, list):
        raise CliError("release gate report is missing steps[]")

    status = str(payload.get("status") or "unknown")
    archive = str(payload.get("archive") or "")
    archive_sha256 = str(payload.get("archive_sha256") or "")
    markdown_report = str(payload.get("markdown_report") or default_markdown_report_path(report_path))
    markdown_report_path = (
        Path(args.markdown_report).expanduser().resolve(strict=False)
        if args.markdown_report
        else Path(markdown_report).expanduser().resolve(strict=False)
    )
    archive_exists = False
    archive_sha256_actual = ""
    archive_sha256_matches = False
    if archive:
        archive_path = Path(archive).expanduser().resolve(strict=False)
        archive_exists = archive_path.is_file()
        if archive_exists:
            archive_sha256_actual = sha256_file(archive_path)
            archive_sha256_matches = archive_sha256_actual == archive_sha256
    archive_check = {
        "exists": archive_exists,
        "expected_sha256": archive_sha256,
        "actual_sha256": archive_sha256_actual,
        "matches": archive_sha256_matches,
    }
    sidecar_check = archive_sidecar_check(archive, archive_sha256_actual)
    sidecar_required = "archive_sidecar_check" in payload or bool(sidecar_check.get("exists"))
    sidecar_valid = (
        bool(sidecar_check.get("exists"))
        and bool(sidecar_check.get("filename_matches"))
        and bool(sidecar_check.get("matches"))
    )
    manifest_payload = dict(payload)
    manifest_payload["archive_check"] = archive_check
    refresh_manifest_check(manifest_payload)
    manifest_check = manifest_payload.get("archive_manifest_check") if isinstance(manifest_payload.get("archive_manifest_check"), dict) else {}
    manifest_required = "archive_manifest_check" in payload or bool(archive and Path(f"{archive}.manifest.json").is_file())
    manifest_valid = (
        bool(manifest_check.get("exists"))
        and not manifest_check.get("error")
        and bool(manifest_check.get("archive_filename_matches"))
        and bool(manifest_check.get("archive_sha256_matches"))
        and bool(manifest_check.get("entry_count_matches"))
        and bool(manifest_check.get("total_size_matches"))
        and bool(manifest_check.get("entries_match"))
    )
    step_rows: list[dict[str, Any]] = [step for step in steps if isinstance(step, dict)]
    failed_steps = [step for step in step_rows if step.get("status") != "pass" or step.get("returncode") != 0]
    missing_required_steps = sorted({"quickstart-smoke", "smoke-release"} - {str(step.get("label")) for step in step_rows})

    if args.json:
        enriched = dict(payload)
        enriched["archive_check"] = archive_check
        if sidecar_required:
            enriched["archive_sidecar_check"] = sidecar_check
        if manifest_required:
            enriched["archive_manifest_check"] = manifest_check
        enriched["markdown_report"] = str(markdown_report_path)
        enriched["missing_required_steps"] = missing_required_steps
        print(json.dumps(enriched, ensure_ascii=False, indent=2))
    else:
        print("# Echo Founder Release Gate Report")
        print(f"- 状态：{status}")
        print(f"- Archive：`{archive or '未记录'}`")
        print(f"- SHA256：`{archive_sha256 or '未记录'}`")
        print(f"- Archive 文件存在：{'yes' if archive_exists else 'no'}")
        print(f"- SHA256 复核：{'match' if archive_sha256_matches else 'mismatch'}")
        if sidecar_required:
            print(f"- Sidecar：`{sidecar_check.get('path') or '未记录'}`")
            print(f"- Sidecar 文件存在：{'yes' if sidecar_check.get('exists') else 'no'}")
            print(f"- Sidecar SHA256 复核：{'match' if sidecar_check.get('matches') else 'mismatch'}")
        if manifest_required:
            print(f"- Manifest：`{manifest_check.get('path') or '未记录'}`")
            print(f"- Manifest 文件存在：{'yes' if manifest_check.get('exists') else 'no'}")
            print(f"- Manifest 总大小复核：{'match' if manifest_check.get('total_size_matches') else 'mismatch'}")
            print(f"- Manifest 条目复核：{'match' if manifest_check.get('entries_match') else 'mismatch'}")
        print(f"- 报告：`{report_path}`")
        print(f"- Markdown：`{markdown_report_path}`")
        print(f"- 开始：{payload.get('started_at') or '未记录'}")
        print(f"- 结束：{payload.get('finished_at') or '未记录'}")
        print("\n## Steps")
        for step in step_rows:
            label = step.get("label") or "unknown"
            step_status = step.get("status") or "unknown"
            returncode = step.get("returncode")
            duration = step.get("duration_seconds")
            print(f"- {label}: {step_status} / returncode={returncode} / {duration}s")
        if failed_steps:
            labels = ", ".join(str(step.get("label") or "unknown") for step in failed_steps)
            print(f"\nFAIL failed steps: {labels}", file=sys.stderr)
        elif missing_required_steps:
            print(f"\nFAIL missing required steps: {', '.join(missing_required_steps)}", file=sys.stderr)
        elif not archive_exists:
            print("\nFAIL archive file recorded in report does not exist", file=sys.stderr)
        elif not archive_sha256_matches:
            print("\nFAIL archive SHA256 does not match release gate report", file=sys.stderr)
        elif sidecar_required and not sidecar_valid:
            print("\nFAIL archive SHA256 sidecar does not match release gate report", file=sys.stderr)
        elif manifest_required and not manifest_valid:
            print("\nFAIL archive manifest sidecar does not match release gate report", file=sys.stderr)
        elif status != "pass":
            print(f"\nFAIL release gate status is {status}", file=sys.stderr)
        else:
            print("\nPASS release gate report is pass")

    if args.write_markdown or args.markdown_report:
        markdown_payload = dict(payload)
        markdown_payload["archive_check"] = archive_check
        if sidecar_required:
            markdown_payload["archive_sidecar_check"] = sidecar_check
        if manifest_required:
            markdown_payload["archive_manifest_check"] = manifest_check
        markdown_payload["markdown_report"] = str(markdown_report_path)
        markdown_payload["missing_required_steps"] = missing_required_steps
        write_markdown_report(markdown_report_path, markdown_payload)
        if not args.json:
            print(f"Markdown report: {markdown_report_path}")

    if (
        status != "pass"
        or failed_steps
        or missing_required_steps
        or not archive
        or len(archive_sha256) != 64
        or not archive_exists
        or not archive_sha256_matches
        or (sidecar_required and not sidecar_valid)
        or (manifest_required and not manifest_valid)
    ):
        return 1
    return 0


def cmd_ui(args: argparse.Namespace, project: str) -> int:
    if not UI_DIR.exists():
        print(f"FAIL UI directory not found: {UI_DIR}", file=sys.stderr)
        return 1
    if not (UI_DIR / "package.json").exists():
        print(f"FAIL UI package.json not found: {UI_DIR / 'package.json'}", file=sys.stderr)
        return 1

    env = os.environ.copy()
    env["AIFIOS_HOME"] = str(REPO_ROOT)
    env["AIFIOS_PROJECT"] = project
    env.setdefault("AIFIOS_SKILLS_DIR", str(REPO_ROOT / "skills"))
    env["PORT"] = str(args.port)
    env["HOSTNAME"] = args.host
    env["AIFIOS_DESKTOP_SERVER_MODE"] = args.server_mode

    node_binary = ui_node_binary(env)
    node_ok, node_output = run_text([node_binary, "--version"], env=ui_node_env(env))
    required_node = required_node_version()
    node_version = parse_semver(node_output)
    if not node_ok or node_version is None:
        print(f"FAIL unable to read Node.js version: {node_output or 'unknown'}", file=sys.stderr)
        if not env.get("AIFIOS_NODE_BINARY"):
            print("Install Node.js 20.9+ or launch through the Electron desktop shell.", file=sys.stderr)
        return 1
    if node_version < required_node:
        print(
            f"FAIL Node.js {node_output} is too old; required >= {format_semver(required_node)}.",
            file=sys.stderr,
        )
        return 1
    if not use_prebuilt_ui_standalone(env) and not ui_dependencies_installed():
        if not args.install_deps:
            print("FAIL UI dependencies are not installed.", file=sys.stderr)
            print("Run: npm --prefix ui ci", file=sys.stderr)
            print("Or rerun: python3 scripts/aifios.py ui --install-deps", file=sys.stderr)
            return 1
        npm_binary = env.get("AIFIOS_NPM_BINARY", "").strip() or "npm"
        if not command_exists(npm_binary):
            print("FAIL UI dependencies are missing and npm is not available to install them.", file=sys.stderr)
            return 1
        install_code = install_ui_dependencies(env)
        if install_code != 0:
            return install_code

    init_code = ensure_project_initialized(project)
    if init_code != 0:
        return init_code

    if args.server_mode == "production":
        if env.get("AIFIOS_SKIP_UI_BUILD") == "1":
            if not ui_production_build_ready(env):
                print(f"FAIL prebuilt UI production bundle not found: {ui_dist_dir(env)}", file=sys.stderr)
                return 1
            print(f"Using prebuilt UI production bundle: {ui_dist_dir(env)}", flush=True)
        else:
            build_code = build_ui_production(env)
            if build_code != 0:
                return build_code

    command = ui_server_command(args.server_mode, args.host, args.port, env)
    print(f"Project data: {project}", flush=True)
    print(f"UI server mode: {args.server_mode}", flush=True)
    print(f"UI node: {node_binary}", flush=True)
    if not args.no_open:
        print(f"Open http://{args.host}:{args.port}", flush=True)
    return run_ui_dev_server(command, UI_DIR, ui_node_env(env))


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def terminate_ui_process(proc: subprocess.Popen[object]) -> None:
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
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except OSError:
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            proc.kill()
        proc.wait(timeout=10)


def run_ui_dev_server(command: list[str], cwd: Path, env: dict[str, str]) -> int:
    parent_pid_raw = env.get("AIFIOS_DESKTOP_PARENT_PID", "").strip()
    if not parent_pid_raw:
        return subprocess.run(command, cwd=cwd, env=env).returncode
    try:
        parent_pid = int(parent_pid_raw)
    except ValueError:
        return subprocess.run(command, cwd=cwd, env=env).returncode

    proc = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        start_new_session=os.name != "nt",
    )
    previous_sigterm = signal.getsignal(signal.SIGTERM)
    previous_sigint = signal.getsignal(signal.SIGINT)

    def handle_stop(signum: int, _frame: object) -> None:
        print(f"Echo Founder UI received signal {signum}; stopping UI server.", file=sys.stderr, flush=True)
        terminate_ui_process(proc)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)
    try:
        while True:
            code = proc.poll()
            if code is not None:
                return int(code)
            if not process_exists(parent_pid):
                print("Echo Founder desktop parent exited; stopping UI server.", file=sys.stderr, flush=True)
                terminate_ui_process(proc)
                return 0
            time.sleep(1)
    finally:
        terminate_ui_process(proc)
        signal.signal(signal.SIGTERM, previous_sigterm)
        signal.signal(signal.SIGINT, previous_sigint)


def add_browser_collection_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--platform", required=True, help="wechat | xhs")
    parser.add_argument("--keyword", default="")
    parser.add_argument("--url", default="")
    parser.add_argument("--profile", default="")
    parser.add_argument("--limit", default="")
    parser.add_argument("--max-scrolls", dest="max_scrolls", default="")
    parser.add_argument("--no-wait", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--diagnostics", action="store_true", help="always save screenshot/html/trace diagnostics")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aifios",
        description="Echo Founder unified cockpit for independent 公众号、小红书和视频号 content lanes.",
        epilog=(
            "Examples:\n"
            "  python3 scripts/aifios.py --project '~/Echo Founder' onboard --platforms '公众号,小红书' --offer 'AI 创业顾问' --target '早期创业者' --product '陪跑咨询'\n"
            "  python3 scripts/aifios.py work --project '~/Echo Founder' 继续\n"
            "  python3 scripts/aifios.py run create --project '~/Echo Founder' --topic '第一篇公众号' --platforms '公众号'\n"
            "  python3 scripts/aifios.py browser queue --project '~/Echo Founder' --platform xhs --keyword '个人 IP'\n"
            "  python3 scripts/aifios.py verify --skip-demo --skip-browser-fixture\n"
            "  python3 scripts/aifios.py release-report --report /private/tmp/aifios-release-gate-report.json\n"
            "  python3 scripts/aifios.py ui --install-deps --port 3000\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--project",
        "-p",
        default=DEFAULT_PROJECT,
        help="project directory; can appear before or after the command; defaults to AIFIOS_PROJECT or ~/Echo Founder",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="initialize project")
    p_init.add_argument("--demo", action="store_true")
    p_init.set_defaults(func=cmd_init)

    p_start = sub.add_parser("start", help="show next-step guide")
    p_start.add_argument("input", nargs="*")
    p_start.add_argument("--json", action="store_true")
    p_start.set_defaults(func=cmd_start)

    p_onboard = sub.add_parser("onboard", help="first-use setup")
    for flag in ["goal", "platforms", "offer", "target", "product"]:
        p_onboard.add_argument(f"--{flag}", default="")
    p_onboard.add_argument("--json", action="store_true")
    p_onboard.set_defaults(func=cmd_onboard)

    for name in ["work", "cockpit"]:
        p_work = sub.add_parser(name, help="open unified cockpit")
        p_work.add_argument("input", nargs="*")
        p_work.add_argument("--json", action="store_true")
        p_work.set_defaults(func=cmd_work)

    p_status = sub.add_parser("status", help="show pipeline status")
    p_status.add_argument("--slug", default="")
    p_status.set_defaults(func=cmd_status)

    p_next = sub.add_parser("next", help="generate next task card")
    p_next.add_argument("--slug", default="")
    p_next.set_defaults(func=cmd_next)

    p_flow = sub.add_parser("flow", help="start or continue from an intake file")
    p_flow.add_argument("--intake", default="")
    p_flow.add_argument("--slug", default="")
    p_flow.set_defaults(func=cmd_flow)

    p_write = sub.add_parser("write", help="write a pipeline artifact")
    p_write.add_argument("--step", required=True)
    p_write.add_argument("--slug", required=True)
    p_write.add_argument("--content", required=True, help="literal text or @/path/to/file.md")
    p_write.add_argument("--source", default="")
    p_write.set_defaults(func=cmd_write)

    p_read = sub.add_parser("read", help="read a pipeline artifact")
    p_read.add_argument("--step", required=True)
    p_read.add_argument("--slug", default="")
    p_read.add_argument("--file", default="")
    p_read.set_defaults(func=cmd_read)

    p_state = sub.add_parser("state", help="show runtime state")
    p_state.set_defaults(func=lambda args, project: runtime(project, ["state"]))

    p_run = sub.add_parser("run", help="manage runs/{run_id}.json")
    run_sub = p_run.add_subparsers(dest="run_command", required=True)
    p_run_create = run_sub.add_parser("create", help="create and activate a run")
    p_run_create.add_argument("--topic", default="")
    p_run_create.add_argument("--platforms", default="")
    p_run_create.add_argument("--slug", default="")
    p_run_create.add_argument("--run-id", default="")
    p_run_create.add_argument("--goal", default="")
    p_run_create.add_argument("--success-metric", dest="success_metric", default="")
    p_run_create.add_argument("--baseline", default="")
    p_run_create.add_argument("--target", default="")
    p_run_create.set_defaults(func=cmd_run_group)
    p_run_list = run_sub.add_parser("list", help="list recent runs")
    p_run_list.add_argument("--limit", type=int, default=20)
    p_run_list.set_defaults(func=cmd_run_group)
    p_run_show = run_sub.add_parser("show", help="show one run")
    p_run_show.add_argument("run_id_pos", nargs="?")
    p_run_show.add_argument("--run-id", default="")
    p_run_show.add_argument("--slug", default="")
    p_run_show.set_defaults(func=cmd_run_group)
    for name in ["switch", "resume", "archive"]:
        p = run_sub.add_parser(name, help=f"{name} a run")
        p.add_argument("run_id_pos", nargs="?")
        p.add_argument("--run-id", default="")
        p.set_defaults(func=cmd_run_group)

    p_quality = sub.add_parser("quality", help="run content quality gate")
    p_quality.add_argument("--platform", required=True)
    p_quality.add_argument("--file", default="")
    p_quality.add_argument("--step", default="")
    p_quality.add_argument("--slug", default="")
    p_quality.add_argument("--min-score", dest="min_score", default="")
    p_quality.set_defaults(func=cmd_quality)

    p_delivery = sub.add_parser("delivery", help="build commercial delivery pack")
    p_delivery.add_argument("--run-id", default="")
    p_delivery.add_argument("--slug", default="")
    p_delivery.set_defaults(func=cmd_delivery)

    p_delivery_audit = sub.add_parser("delivery-audit", help="run adversarial delivery audit")
    p_delivery_audit.add_argument("--run-id", default="")
    p_delivery_audit.add_argument("--slug", default="")
    p_delivery_audit.add_argument("--auto-pack", action="store_true")
    p_delivery_audit.set_defaults(func=cmd_delivery_audit)

    p_dbs_apply = sub.add_parser("dbs-fusion-apply", help="apply dbs-fusion writeback plan")
    p_dbs_apply.add_argument("--file", default="")
    p_dbs_apply.add_argument("--slug", default="")
    p_dbs_apply.add_argument("--dry-run", action="store_true")
    p_dbs_apply.add_argument("--force", action="store_true")
    p_dbs_apply.set_defaults(func=cmd_dbs_fusion_apply)

    p_performance = sub.add_parser("performance", help="collect authorized performance data")
    performance_sub = p_performance.add_subparsers(dest="performance_command", required=True)
    p_mock_wechat = performance_sub.add_parser("mock-wechat", help="write mock WeChat performance data")
    p_mock_wechat.add_argument("--slug", required=True)
    p_mock_wechat.add_argument("--title", required=True)
    p_mock_wechat.set_defaults(func=cmd_performance_group)
    p_wechat = performance_sub.add_parser("wechat", help="collect authorized WeChat OA performance data")
    p_wechat.add_argument("--file", default="")
    p_wechat.add_argument("--slug", default="")
    p_wechat.add_argument("--title", default="")
    p_wechat.add_argument("--article-id", default="")
    p_wechat.add_argument("--publish-url", default="")
    p_wechat.add_argument("--published-at", default="")
    p_wechat.add_argument("--publish-asset", default="")
    p_wechat.add_argument("--authorization-mode", default="self-account")
    p_wechat.add_argument("--authorization-record", default="")
    p_wechat.add_argument("--data-source", default="")
    p_wechat.add_argument("--captured-by", default="")
    p_wechat.add_argument("--evidence", default="")
    p_wechat.add_argument("--benchmark-report", action="append", default=[])
    p_wechat.add_argument("--comment", action="append", default=[])
    for flag in [
        "exposures", "reads", "readers", "likes", "wows", "comments", "shares", "collects",
        "new-followers", "profile-visits", "leads",
    ]:
        p_wechat.add_argument(f"--{flag}", default="")
    p_wechat.set_defaults(func=cmd_performance_group)
    p_wechat_api = performance_sub.add_parser("wechat-api", help="collect WeChat OA performance data through official APIs")
    p_wechat_api.add_argument("--slug", required=True)
    p_wechat_api.add_argument("--article-id", required=True)
    p_wechat_api.add_argument("--msg-data-id", default="")
    p_wechat_api.add_argument("--published-at", required=True)
    p_wechat_api.add_argument("--begin-date", default="")
    p_wechat_api.add_argument("--end-date", default="")
    p_wechat_api.add_argument("--comment-limit", default="50")
    p_wechat_api.add_argument("--benchmark-report", action="append", default=[])
    p_wechat_api.set_defaults(func=cmd_performance_group)
    p_wechat_browser = performance_sub.add_parser(
        "wechat-browser",
        help="collect WeChat OA performance from the current logged-in browser page",
    )
    p_wechat_browser.add_argument("--slug", required=True)
    p_wechat_browser.add_argument("--title", default="")
    p_wechat_browser.add_argument("--publish-url", default="")
    p_wechat_browser.add_argument("--published-at", default="")
    p_wechat_browser.add_argument("--url", default="")
    p_wechat_browser.add_argument("--profile", default="")
    p_wechat_browser.add_argument("--fixture", default="")
    p_wechat_browser.add_argument("--auto-after-login", action="store_true")
    p_wechat_browser.add_argument("--all-published", action="store_true")
    p_wechat_browser.add_argument("--capture-content", action="store_true")
    p_wechat_browser.add_argument("--auto-timeout-ms", default="")
    p_wechat_browser.add_argument("--max-articles", default="")
    p_wechat_browser.add_argument("--max-pages", default="")
    p_wechat_browser.add_argument("--no-wait", action="store_true")
    p_wechat_browser.add_argument("--headless", action="store_true")
    p_wechat_browser.set_defaults(func=cmd_performance_group)

    p_hit = sub.add_parser("hit", help="manage hit library")
    hit_sub = p_hit.add_subparsers(dest="hit_command", required=True)
    hit_sub.add_parser("init", help="initialize hit library").set_defaults(func=cmd_hit_group)
    p_hit_add = hit_sub.add_parser("add", help="add a sample")
    p_hit_add.add_argument("--platform", required=True)
    p_hit_add.add_argument("--title", required=True)
    for flag in [
        "url", "author", "keyword", "topic", "cover-text", "hook",
        "audience-pain", "commercial-angle", "why-it-worked", "tags",
        "reads", "likes", "collects", "comments", "shares", "wows", "recommends",
    ]:
        p_hit_add.add_argument(f"--{flag}", dest=flag.replace("-", "_"), default="")
    p_hit_add.set_defaults(func=cmd_hit_group)
    for name in ["import", "queue"]:
        p = hit_sub.add_parser(name, help=f"{name} samples")
        p.add_argument("--platform", required=True)
        p.add_argument("--file", required=True)
        p.add_argument("--format", default="")
        p.add_argument("--keyword", default="")
        p.add_argument("--topic", default="")
        if name == "import":
            p.add_argument("--preview", action="store_true")
            p.add_argument("--confirm", action="store_true")
        p.set_defaults(func=cmd_hit_group)
    for name in ["list", "report"]:
        p = hit_sub.add_parser(name, help=f"{name} samples")
        p.add_argument("--platform", default="")
        p.add_argument("--keyword", default="")
        p.add_argument("--limit", default="")
        p.set_defaults(func=cmd_hit_group)
    hit_sub.add_parser("queue-list", help="list pending queues").set_defaults(func=cmd_hit_group)
    p_qi = hit_sub.add_parser("queue-import", help="import pending queue")
    p_qi.add_argument("--file", required=True)
    p_qi.add_argument("--confirm", action="store_true")
    p_qi.set_defaults(func=cmd_hit_group)
    p_qr = hit_sub.add_parser("queue-reject", help="reject pending queue")
    p_qr.add_argument("--file", required=True)
    p_qr.add_argument("--reason", default="")
    p_qr.set_defaults(func=cmd_hit_group)

    p_tikomni = sub.add_parser("tikomni", help="import TikOmni JSON into Echo Founder")
    tikomni_sub = p_tikomni.add_subparsers(dest="tikomni_command", required=True)
    p_tikomni_hit = tikomni_sub.add_parser("hit-import", help="import TikOmni public hit samples")
    p_tikomni_hit.add_argument("--platform", required=True)
    p_tikomni_hit.add_argument("--file", required=True)
    p_tikomni_hit.add_argument("--keyword", default="")
    p_tikomni_hit.add_argument("--topic", default="")
    p_tikomni_hit.add_argument("--queue", action="store_true")
    p_tikomni_hit.set_defaults(func=cmd_tikomni_group)

    p_tikomni_perf = tikomni_sub.add_parser("performance-import", help="import TikOmni published performance data")
    p_tikomni_perf.add_argument("--platform", required=True)
    p_tikomni_perf.add_argument("--file", required=True)
    p_tikomni_perf.add_argument("--slug", required=True)
    p_tikomni_perf.add_argument("--authorization-mode", default="public-visible")
    p_tikomni_perf.add_argument("--captured-by", default="")
    p_tikomni_perf.set_defaults(func=cmd_tikomni_group)

    p_tikomni_api = tikomni_sub.add_parser("api-fetch", help="fetch TikOmni API data by endpoint_id into raw snapshots")
    p_tikomni_api.add_argument("--platform", required=True)
    p_tikomni_api.add_argument("--endpoint-id", required=True)
    p_tikomni_api.add_argument("--params", default="{}")
    p_tikomni_api.add_argument("--kind", default="raw")
    p_tikomni_api.add_argument("--skill-dir", default="")
    p_tikomni_api.add_argument("--env-file", default="")
    p_tikomni_api.add_argument("--timeout-ms", default="")
    p_tikomni_api.set_defaults(func=cmd_tikomni_group)

    p_tikomni_hit_fetch = tikomni_sub.add_parser("hit-fetch", help="fetch TikOmni API data and import public hit samples")
    p_tikomni_hit_fetch.add_argument("--platform", required=True)
    p_tikomni_hit_fetch.add_argument("--endpoint-id", required=True)
    p_tikomni_hit_fetch.add_argument("--params", default="{}")
    p_tikomni_hit_fetch.add_argument("--keyword", default="")
    p_tikomni_hit_fetch.add_argument("--topic", default="")
    p_tikomni_hit_fetch.add_argument("--queue", action="store_true")
    p_tikomni_hit_fetch.add_argument("--skill-dir", default="")
    p_tikomni_hit_fetch.add_argument("--env-file", default="")
    p_tikomni_hit_fetch.add_argument("--timeout-ms", default="")
    p_tikomni_hit_fetch.add_argument("--enrich-details", action="store_true")
    p_tikomni_hit_fetch.add_argument("--enrich-limit", default="")
    p_tikomni_hit_fetch.add_argument("--infer-insights", action="store_true")
    p_tikomni_hit_fetch.set_defaults(func=cmd_tikomni_group)

    p_tikomni_collect = tikomni_sub.add_parser(
        "collect-benchmark",
        help="collect public benchmark hit samples with Echo Founder platform presets",
    )
    p_tikomni_collect.add_argument("--platform", required=True)
    p_tikomni_collect.add_argument("--keyword", required=True)
    p_tikomni_collect.add_argument("--params", default="{}")
    p_tikomni_collect.add_argument("--topic", default="")
    p_tikomni_collect.add_argument("--queue", dest="queue", action="store_true", default=True)
    p_tikomni_collect.add_argument("--no-queue", dest="queue", action="store_false")
    p_tikomni_collect.add_argument("--skill-dir", default="")
    p_tikomni_collect.add_argument("--env-file", default="")
    p_tikomni_collect.add_argument("--timeout-ms", default="")
    p_tikomni_collect.add_argument("--enrich-details", dest="enrich_details", action="store_true", default=True)
    p_tikomni_collect.add_argument("--no-enrich-details", dest="enrich_details", action="store_false")
    p_tikomni_collect.add_argument("--enrich-limit", default="8")
    p_tikomni_collect.add_argument("--infer-insights", dest="infer_insights", action="store_true", default=True)
    p_tikomni_collect.add_argument("--no-infer-insights", dest="infer_insights", action="store_false")
    p_tikomni_collect.set_defaults(func=cmd_tikomni_group)

    p_browser = sub.add_parser("browser", help="visible-page browser helper")
    browser_sub = p_browser.add_subparsers(dest="browser_command", required=True)
    browser_sub.add_parser("doctor", help="check browser dependencies").set_defaults(func=cmd_browser_group)
    browser_sub.add_parser("fixture-check", help="check selector profiles against local fixtures").set_defaults(func=cmd_browser_group)
    browser_sub.add_parser("install", help="install Playwright dependency").set_defaults(func=cmd_browser_group)
    p_collect = browser_sub.add_parser("collect", help="collect visible samples directly")
    add_browser_collection_options(p_collect)
    p_collect.set_defaults(func=cmd_browser_group)
    p_queue = browser_sub.add_parser("queue", help="collect visible samples into pending queue")
    add_browser_collection_options(p_queue)
    p_queue.set_defaults(func=cmd_browser_group)

    p_demo = sub.add_parser("demo", help="create demo project")
    p_demo.add_argument("--slug", default="codex-demo")
    p_demo.add_argument("--platform", default="full", help="full | all | wechat | xhs")
    p_demo.add_argument("--reset", action="store_true")
    p_demo.set_defaults(func=cmd_demo)

    p_doctor = sub.add_parser("doctor", help="run installation doctor")
    p_doctor.add_argument("--install-dir", default="~/.agents/skills")
    p_doctor.add_argument("--strict", action="store_true")
    p_doctor.add_argument("--require-install", action="store_true")
    p_doctor.add_argument("--require-external", action="store_true")
    p_doctor.add_argument("--require-ui-deps", action="store_true")
    p_doctor.add_argument("--skip-ui", action="store_true")
    p_doctor.add_argument("--show-resolutions", action="store_true")
    p_doctor.add_argument("--json", action="store_true")
    p_doctor.add_argument("--report", default="")
    p_doctor.set_defaults(func=cmd_doctor)

    p_verify = sub.add_parser("verify", help="run post-install delivery health checks")
    p_verify.add_argument("--install-dir", default="~/.agents/skills")
    p_verify.add_argument("--demo-project", default="/private/tmp/aifios-verify-demos")
    p_verify.add_argument("--report", default="")
    p_verify.add_argument("--strict", action="store_true")
    p_verify.add_argument("--skip-install-check", action="store_true", help="do not require bundled skills to be installed in --install-dir")
    p_verify.add_argument("--require-external", action="store_true")
    p_verify.add_argument("--require-ui-deps", action="store_true")
    p_verify.add_argument("--skip-ui", action="store_true")
    p_verify.add_argument("--skip-tests", action="store_true")
    p_verify.add_argument("--skip-demo", action="store_true")
    p_verify.add_argument("--skip-browser-fixture", action="store_true")
    p_verify.set_defaults(func=cmd_verify)

    p_install = sub.add_parser("install", help="install skills")
    p_install.add_argument("--install-dir", default="~/.agents/skills")
    p_install.add_argument("--mode", choices=["symlink", "copy"], default="symlink")
    p_install.add_argument("--force", action="store_true")
    p_install.add_argument("--dry-run", action="store_true")
    p_install.add_argument("--external-plan", action="store_true")
    p_install.set_defaults(func=cmd_install)

    p_install_cli = sub.add_parser("install-cli", help="install the aifios command into a bin directory")
    p_install_cli.add_argument("--bin-dir", default="~/.local/bin")
    p_install_cli.add_argument("--force", action="store_true")
    p_install_cli.add_argument("--dry-run", action="store_true")
    p_install_cli.set_defaults(func=cmd_install_cli)

    p_package = sub.add_parser("package", help="build release package")
    p_package.add_argument("--dist-dir", default="dist")
    p_package.add_argument("--name", default="")
    p_package.set_defaults(func=cmd_package)

    p_release_gate = sub.add_parser("release-gate", help="run full pre-release gate")
    p_release_gate.add_argument("--archive", default="")
    p_release_gate.add_argument("--dist-dir", default="/private/tmp/aifios-release-gate-dist")
    p_release_gate.add_argument("--quickstart-work-dir", default="/private/tmp/aifios-release-gate-quickstart")
    p_release_gate.add_argument("--smoke-work-dir", default="/private/tmp/aifios-release-gate-smoke")
    p_release_gate.add_argument("--report", default="/private/tmp/aifios-release-gate-report.json")
    p_release_gate.add_argument("--markdown-report", default="")
    p_release_gate.set_defaults(func=cmd_release_gate)

    p_release_report = sub.add_parser("release-report", help="read and validate release gate report")
    p_release_report.add_argument("--report", default="/private/tmp/aifios-release-gate-report.json")
    p_release_report.add_argument("--markdown-report", default="")
    p_release_report.add_argument("--write-markdown", action="store_true", help="write or refresh markdown summary")
    p_release_report.add_argument("--json", action="store_true")
    p_release_report.set_defaults(func=cmd_release_report)

    p_ui = sub.add_parser("ui", help="start Next.js UI from ui/", description="start Next.js UI from ui/")
    p_ui.add_argument("--host", default="127.0.0.1")
    p_ui.add_argument("--port", type=int, default=3000)
    p_ui.add_argument("--server-mode", choices=["dev", "production"], default="dev")
    p_ui.add_argument("--install-deps", action="store_true", help="install UI dependencies before starting when missing")
    p_ui.add_argument("--no-open", action="store_true")
    p_ui.set_defaults(func=cmd_ui)

    return parser


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    if not raw:
        parser.print_help()
        return 0
    try:
        project, cleaned = extract_project(raw)
        args = parser.parse_args(cleaned)
        return args.func(args, project)
    except CliError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
