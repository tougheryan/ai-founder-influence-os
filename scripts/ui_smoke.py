#!/usr/bin/env python3
"""Smoke test the local AIFIOS frontend and key API routes."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import quote
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_ROUTES = [
    "/pipeline",
    "/production?stage=1",
    "/production?stage=2",
    "/production?stage=3",
    "/production?stage=4",
    "/production?stage=5",
    "/production?stage=6",
    "/production?stage=7",
    "/case",
    "/materials",
    "/brain",
    "/twin",
    "/benchmark-advisor",
    "/publication-desk",
    "/weekly-review",
    "/settings",
    "/delivery",
]

DEFAULT_APIS = [
    "/api/status",
    "/api/delivery",
]


def fetch(base_url: str, path: str, timeout: int) -> tuple[int, str]:
    req = Request(f"{base_url.rstrip('/')}{path}", headers={"User-Agent": "aifios-ui-smoke/1.0"})
    with urlopen(req, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        return response.status, body


def request_json(
    base_url: str,
    path: str,
    timeout: int,
    method: str = "GET",
    payload: dict | None = None,
    expect_status: tuple[int, ...] = (200,),
) -> tuple[bool, dict]:
    data = None
    headers = {"User-Agent": "aifios-ui-smoke/1.0"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(f"{base_url.rstrip('/')}{path}", data=data, headers=headers, method=method)

    try:
        with urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            status = response.status
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        status = exc.code
    except URLError as exc:
        print(f"FAIL {method} {path}: {exc.reason}")
        return False, {}
    except TimeoutError:
        print(f"FAIL {method} {path}: timeout")
        return False, {}

    if status not in expect_status:
        print(f"FAIL {method} {path}: HTTP {status}")
        return False, {}

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        print(f"FAIL {method} {path}: response is not JSON")
        return False, {}

    if isinstance(parsed, dict) and parsed.get("error") and status < 400:
        print(f"FAIL {method} {path}: unexpected error payload: {parsed.get('error')}")
        return False, parsed

    print(f"PASS {method} {path}: HTTP {status}")
    return True, parsed


def config_save_payload(config: dict) -> dict:
    payload = dict(config)
    if payload.get("hasSavedKey") and not payload.get("apiKey"):
        payload.pop("apiKey", None)
    return payload


def request_text(
    base_url: str,
    path: str,
    timeout: int,
    method: str = "GET",
    payload: dict | None = None,
    expect_status: tuple[int, ...] = (200,),
) -> tuple[bool, str]:
    data = None
    headers = {"User-Agent": "aifios-ui-smoke/1.0"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(f"{base_url.rstrip('/')}{path}", data=data, headers=headers, method=method)

    try:
        with urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            status = response.status
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        status = exc.code
    except URLError as exc:
        print(f"FAIL {method} {path}: {exc.reason}")
        return False, ""
    except TimeoutError:
        print(f"FAIL {method} {path}: timeout")
        return False, ""

    if status not in expect_status:
        print(f"FAIL {method} {path}: HTTP {status}")
        return False, body

    print(f"PASS {method} {path}: HTTP {status}")
    return True, body


def request_bytes(
    base_url: str,
    path: str,
    timeout: int,
    expect_status: tuple[int, ...] = (200,),
) -> tuple[bool, bytes, dict[str, str]]:
    req = Request(f"{base_url.rstrip('/')}{path}", headers={"User-Agent": "aifios-ui-smoke/1.0"})

    try:
        with urlopen(req, timeout=timeout) as response:
            body = response.read()
            status = response.status
            headers = {key.lower(): value for key, value in response.headers.items()}
    except HTTPError as exc:
        body = exc.read()
        status = exc.code
        headers = {key.lower(): value for key, value in exc.headers.items()}
    except URLError as exc:
        print(f"FAIL GET {path}: {exc.reason}")
        return False, b"", {}
    except TimeoutError:
        print(f"FAIL GET {path}: timeout")
        return False, b"", {}

    if status not in expect_status:
        print(f"FAIL GET {path}: HTTP {status}")
        return False, body, headers

    print(f"PASS GET {path}: HTTP {status}")
    return True, body, headers


def request_sse_events(
    base_url: str,
    path: str,
    timeout: int,
    payload: dict,
    expect_status: tuple[int, ...] = (200,),
) -> tuple[bool, list[dict]]:
    ok, body = request_text(
        base_url,
        path,
        timeout,
        method="POST",
        payload=payload,
        expect_status=expect_status,
    )
    if not ok:
        return False, []

    events: list[dict] = []
    for line in body.splitlines():
        if not line.startswith("data: "):
            continue
        data = line[6:].strip()
        if data == "[DONE]":
            continue
        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            print(f"FAIL POST {path}: invalid SSE JSON")
            return False, events
        if isinstance(parsed, dict):
            events.append(parsed)
    return True, events


def request_multipart(
    base_url: str,
    path: str,
    timeout: int,
    fields: dict[str, str],
    files: dict[str, tuple[str, bytes, str]],
    expect_status: tuple[int, ...] = (200,),
) -> tuple[bool, dict]:
    boundary = f"----aifios-smoke-{int(time.time() * 1000)}"
    chunks: list[bytes] = []

    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        chunks.append(value.encode("utf-8"))
        chunks.append(b"\r\n")

    for name, (filename, content, content_type) in files.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            (
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(content)
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(chunks)
    req = Request(
        f"{base_url.rstrip('/')}{path}",
        data=body,
        headers={
            "User-Agent": "aifios-ui-smoke/1.0",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=timeout) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            status = response.status
    except HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        status = exc.code
    except URLError as exc:
        print(f"FAIL POST {path}: {exc.reason}")
        return False, {}
    except TimeoutError:
        print(f"FAIL POST {path}: timeout")
        return False, {}

    if status not in expect_status:
        print(f"FAIL POST {path}: HTTP {status}")
        return False, {}

    try:
        parsed = json.loads(response_body)
    except json.JSONDecodeError:
        print(f"FAIL POST {path}: response is not JSON")
        return False, {}

    if isinstance(parsed, dict) and parsed.get("error") and status < 400:
        print(f"FAIL POST {path}: unexpected error payload: {parsed.get('error')}")
        return False, parsed

    print(f"PASS POST {path}: HTTP {status}")
    return True, parsed


def output_api_path(relative_path: str) -> str:
    return "/api/output/" + "/".join(quote(part, safe="") for part in relative_path.split("/"))


def check_path(base_url: str, path: str, timeout: int, expect_json: bool) -> bool:
    try:
        status, body = fetch(base_url, path, timeout)
    except HTTPError as exc:
        print(f"FAIL {path}: HTTP {exc.code}")
        return False
    except URLError as exc:
        print(f"FAIL {path}: {exc.reason}")
        return False
    except TimeoutError:
        print(f"FAIL {path}: timeout")
        return False

    if status < 200 or status >= 400:
        print(f"FAIL {path}: HTTP {status}")
        return False

    if expect_json:
        try:
            json.loads(body)
        except json.JSONDecodeError:
            print(f"FAIL {path}: response is not JSON")
            return False

    print(f"PASS {path}: HTTP {status}")
    return True


def expect(condition: bool, label: str, detail: str = "") -> bool:
    if condition:
        print(f"PASS {label}")
        return True
    print(f"FAIL {label}{': ' + detail if detail else ''}")
    return False


def expect_no_local_absolute_paths(payload: dict, label: str) -> bool:
    rendered = json.dumps(payload, ensure_ascii=False)
    leaked_markers = [marker for marker in ("/Users/", "/private/", "/tmp/", "/var/folders/") if marker in rendered]
    return expect(
        not leaked_markers,
        label,
        f"markers={leaked_markers} payload={rendered[:500]}",
    )


def expect_private_config_permissions(project_dir: str | None) -> bool:
    if not project_dir:
        return True
    config_file = Path(project_dir).expanduser().resolve(strict=False) / "config" / "llm-config.json"
    try:
        mode = config_file.stat().st_mode & 0o777
    except FileNotFoundError:
        return expect(False, "config file permissions are private", str(config_file))
    return expect(
        mode & 0o077 == 0,
        "config file permissions are private",
        f"{config_file} mode={oct(mode)}",
    )


def check_project_initialized(project_dir: str | None) -> int:
    if not project_dir:
        return 0

    failures = 0
    root = Path(project_dir).expanduser().resolve(strict=False)
    required_dirs = [
        "pipeline",
        "pipeline/intake",
        "pipeline/final",
        "brain",
        "brain/twin",
        "sessions",
        "runs",
        "assets",
        "materials",
        "materials/hit-library",
    ]
    required_files = [
        "sessions/latest.json",
        "brain/insights.md",
        "brain/twin/content-dna.md",
    ]

    failures += 0 if expect(root.exists(), "project directory exists", str(root)) else 1
    for relative in required_dirs:
        failures += 0 if expect((root / relative).is_dir(), f"project initialized dir {relative}") else 1
    for relative in required_files:
        failures += 0 if expect((root / relative).is_file(), f"project initialized file {relative}") else 1

    return failures


def check_visual_workbench_contract() -> int:
    """Keep the delivery surface intentionally non-editable and review-focused."""
    ui_root = Path(__file__).resolve().parents[1] / "ui"
    delivery_page = ui_root / "components" / "production" / "ProductionStagePanel.tsx"
    component_path = ui_root / "components" / "VisualWorkbench.tsx"
    try:
        page_source = delivery_page.read_text(encoding="utf-8")
        source = component_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"FAIL visual workbench source: {exc}")
        return 1

    failures = 0
    failures += 0 if expect("VisualWorkbench" in page_source, "production stage mounts visual workbench") else 1
    for marker in (
        'data-testid="visual-workbench"',
        'data-testid="visual-revision-input"',
        'data-testid="visual-version-comparison"',
        'adoptSuite(suite)',
        'previewRevisionId',
        'blockedCount > 0',
    ):
        failures += 0 if expect(marker in source, f"visual workbench exposes {marker}") else 1
    failures += 0 if expect("拖拽" not in source, "visual workbench excludes drag editing") else 1
    failures += 0 if expect("resize-y" not in source and "resize-none" in source, "visual workbench excludes resize drag handles") else 1
    return failures


def read_run_file(project_dir: str | None, run_id: str) -> tuple[dict, str]:
    if not project_dir:
        return {}, ""
    run_file = Path(project_dir).expanduser().resolve(strict=False) / "runs" / f"{run_id}.json"
    try:
        return json.loads(run_file.read_text(encoding="utf-8")), ""
    except Exception as exc:
        return {}, str(exc)


def run_step_latest(project_dir: str | None, run_id: str, step: str) -> tuple[str, str]:
    run_data, error = read_run_file(project_dir, run_id)
    if error:
        return "", error
    latest = ((run_data.get("steps") or {}).get(step) or {}).get("latest")
    return str(latest or ""), ""


def expect_delivery_manifest_scoped_to_run(
    manifest: dict,
    run_data: dict,
    label: str,
    forbidden_tokens: list[str] | None = None,
) -> bool:
    steps = run_data.get("steps") or {}
    allowed_sources = {
        str(meta.get("latest") or "")
        for meta in steps.values()
        if isinstance(meta, dict) and meta.get("latest")
    }
    slug = str(run_data.get("slug") or "")
    if slug:
        allowed_sources.add(f"pipeline/visual/{slug}/*")
        allowed_sources.add(f"materials/publication/drafts/{slug}/draft-queue.json")
    sources = [
        str(item.get("source") or "")
        for item in (manifest.get("artifacts") or [])
        if isinstance(item, dict) and item.get("source")
    ]
    unexpected_sources = [source for source in sources if source not in allowed_sources]
    rendered = json.dumps(manifest, ensure_ascii=False)
    forbidden_hits = [token for token in (forbidden_tokens or []) if token and token in rendered]
    return expect(
        not unexpected_sources and not forbidden_hits,
        label,
        str({
            "unexpected_sources": unexpected_sources,
            "forbidden_hits": forbidden_hits,
            "allowed_sources": sorted(allowed_sources),
            "sources": sources,
        }),
    )


def active_run_id(project_dir: str | None) -> tuple[str, str]:
    if not project_dir:
        return "", ""
    state_file = Path(project_dir).expanduser().resolve(strict=False) / "sessions" / "latest.json"
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception as exc:
        return "", str(exc)
    return str(state.get("active_run_id") or ""), ""


def switch_runtime_run(project_dir: str | None, run_id: str) -> bool:
    if not project_dir or not run_id:
        return True
    runtime_script = Path(__file__).resolve().parents[1] / "skills" / "content-runtime" / "scripts" / "content_runtime.py"
    try:
        subprocess.run(
            ["python3", str(runtime_script), "--project", project_dir, "run-switch", "--run-id", run_id],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception as exc:
        return expect(False, "runtime run switch restores active run", str(exc))
    return expect(True, "runtime run switch restores active run")


def smoke_llm_config(smoke_provider_token: str) -> dict:
    return {
        "provider": "aifios-smoke",
        "apiKey": smoke_provider_token,
        "model": "aifios-smoke",
        "baseUrl": "",
        "temperature": 0,
        "maxTokens": 1200,
    }


def saved_path_from_events(events: list[dict]) -> str:
    for event in reversed(events):
        if event.get("type") == "saved":
            return str(event.get("path") or "")
    return ""


def validation_event_from_events(events: list[dict], path: str = "") -> dict:
    for event in reversed(events):
        if event.get("type") != "validation":
            continue
        if path and event.get("path") != path:
            continue
        return event
    return {}


def valid_write_content(slug: str) -> str:
    return (
        f"# UI Smoke 最终稿：{slug}\n\n"
        f"很多创始人第一次写内容时，都会把文章写成一份更温柔的简历。{slug} 这条样例用来验证最终稿、发布记录和下游复盘链路。\n\n"
        "真正重要的不是把经历堆上去，而是先说清楚读者卡在哪里。只有当客户觉得你理解他的处境，他才会继续判断你是否值得信任。\n\n"
        "这篇测试稿不使用硬数字，也不虚构客户案例，只保留一个清晰的判断：公众号长文应该从真实素材出发，完成判断链和商业收口。\n\n"
        "<!-- AIFIOS-WRITE-CHECK\n"
        f"上游 brief - pipeline/breakdown/{slug}.md\n"
        "推荐风格 - 用户指定：无；系统推荐：business-insight（置信度：中）；最终采用：business-insight；理由：UI smoke 验证长文判断链。\n"
        "写作任务卡 - 推荐风格：business-insight；题眼：公众号长文必须从真实素材完成判断链；读者：内容获客创始人。\n"
        "证据台账 - 测试样例不使用硬数字；证据来自 UI smoke marker 与正文判断。\n"
        "文章骨架 - 开头处境 → 核心判断 → 商业收口。\n"
        f"必用证据 - {slug}。\n"
        "传播心理兑现 - 沉默解除：写出读者担心内容获客第一篇开错头；满足动机：提供身份认同和信息价值；有效立场：站在怕销售感太重的创始人一边；传播入口：服务型业务负责人转发讨论开头怎么写；信念结构：确认客户先看问题理解，挑战先自我介绍；受众情绪底层：焦虑、怕显得不专业、希望被信任；受众还想听什么：开头模板、评论区诊断和真实客户问题改写。\n"
        "风险边界 - 不公开客户名、项目名和未授权数据。\n"
        "商业收口 - 引导读者检查自己的内容是否能建立信任。\n"
        "母稿字数 - 3200-3800 字。\n"
        "标题决策来源 - blueprint 标题假设：工作标题《客户不是先看你是谁》；package 标题候选：主标题《客户不是先看你是谁》。\n"
        "排版交接卡 - 封面：先讲客户问题；摘要：从读者处境进入判断链；HTML 排版：重点卡片和引用；CTA：留言业务场景；评论区：你第一篇最想解决哪个客户问题？\n"
        "质检结论 - pass\n"
        "-->"
    )


def run_agent_source_binding_exercise(
    base_url: str,
    timeout: int,
    project_dir: str | None,
    smoke_provider_token: str,
    base_slug: str,
    restore_run_id: str,
) -> int:
    if not project_dir or not smoke_provider_token:
        return 0

    failures = 0
    source_slug = f"{base_slug}-source-bind"
    source_run_id = f"{base_slug}-source-run"
    distractor_slug = f"{base_slug}-active-bind"
    distractor_run_id = f"{base_slug}-active-run"

    ok, source_run = request_json(
        base_url,
        "/api/run",
        timeout,
        method="POST",
        payload={
            "topic": "UI smoke 源 run 绑定测试",
            "platforms": ["wechat"],
            "slug": source_slug,
            "runId": source_run_id,
        },
    )
    failures += 0 if ok else 1
    if ok:
        source_run_id = str(source_run.get("run_id") or source_run_id)
        source_slug = str(source_run.get("slug") or source_slug)

    runtime_dir = Path(__file__).resolve().parents[1] / "skills/content-runtime/scripts"
    sys.path.insert(0, str(runtime_dir))
    from content_runtime import ContentRuntime
    from demo_data import DEMO_SAMPLES
    intake_content = DEMO_SAMPLES["intake"] + "\n\n本报告仅为虚构的接口兼容测试输入，不是客户素材或真人验收。\n"
    fixture = ContentRuntime(Path(project_dir))
    intake_saved = fixture.write("intake", source_slug, intake_content,
                                 source="ui-smoke-fixture", run_id=source_run_id)
    intake_path = str(Path(intake_saved["path"]).relative_to(fixture.project))
    failures += 0 if expect(intake_path.startswith("pipeline/intake/"),
                           "upstream fixture is bound to its source run", intake_path) else 1
    failures += 0 if expect(fixture.validate("intake", intake_path)["valid"],
                           "upstream fixture passes the existing intake contract") else 1
    ok, analysis = request_json(
        base_url, "/api/production/material-analysis", timeout, method="POST",
        payload={"runId": source_run_id, "rawMaterial": intake_content, "files": [], "links": []},
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(analysis.get("context", {}).get("analysisStatus") == "current",
                               "source-bound fixture has current local material analysis") else 1

    ok, distractor_run = request_json(
        base_url,
        "/api/run",
        timeout,
        method="POST",
        payload={
            "topic": "UI smoke 干扰 active run",
            "platforms": ["wechat"],
            "slug": distractor_slug,
            "runId": distractor_run_id,
        },
    )
    failures += 0 if ok else 1
    if ok:
        distractor_run_id = str(distractor_run.get("run_id") or distractor_run_id)

    if intake_path:
        # This exercise explicitly selects the research path. Only its chosen
        # platform is required; absent usable evidence must remain blocked.
        ok, blocked_research = request_json(
            base_url,
            "/api/production/flow",
            timeout,
            method="POST",
            payload={
                "action": "market_research",
                "sourcePath": intake_path,
                "slug": source_slug,
                "topic": "内容协作",
                "runId": source_run_id,
            },
            expect_status=(424,),
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(
                blocked_research.get("blocked") is True
                and blocked_research.get("requiredPlatforms") == ["wechat_mp"]
                and blocked_research.get("sampleCount") == 0
                and bool(blocked_research.get("blockers")),
                "production flow blocks the selected platform without usable research evidence",
                str(blocked_research),
            ) else 1

        ok, missing_market_report = request_text(
            base_url,
            "/api/agent/invoke",
            timeout,
            method="POST",
            payload={
                "skill": "content-validate",
                "params": {"source": intake_path, "strict": False, "businessFirst": False},
                "config": smoke_llm_config(smoke_provider_token),
                "runtimeStep": "validate",
            },
            expect_status=(400,),
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(
                json.loads(missing_market_report).get("code") == "platform_data_refresh_required",
                "content validation refuses to bypass the TikOmni research report",
                missing_market_report[:240],
            ) else 1

        ok, missing_blueprint = request_text(
            base_url,
            "/api/agent/invoke",
            timeout,
            method="POST",
            payload={
                "skill": "wechat-writer",
                "params": {"topic": "UI smoke 蓝图门禁", "blueprintPath": "pipeline/blueprint/missing.md"},
                "config": smoke_llm_config(smoke_provider_token),
                "runtimeStep": "write",
            },
            expect_status=(400,),
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(
                json.loads(missing_blueprint).get("code") == "content_reference_unavailable",
                "wechat writer refuses an unbound or unapproved blueprint",
                missing_blueprint[:240],
            ) else 1

        # A production build must reject the synthetic provider even with its
        # test flag/token. A blocked attempt must preserve both task bindings.
        ok, rejected_provider = request_json(
            base_url, "/api/agent/invoke", timeout, method="POST",
            payload={
                "skill": "content-intake",
                "params": {"runId": source_run_id, "rawMaterial": "虚构接口测试，不是客户素材。"},
                "config": smoke_llm_config(smoke_provider_token), "runtimeStep": "intake",
            },
            expect_status=(500,),
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(
                rejected_provider.get("code") == "content_generation_start_failed",
                "production build rejects the synthetic model provider",
                str(rejected_provider),
            ) else 1
    source_intake_path = ""

    source_data, source_error = read_run_file(project_dir, source_run_id)
    distractor_data, distractor_error = read_run_file(project_dir, distractor_run_id)
    failures += 0 if expect(
        not source_error and (source_intake_path or intake_path) == ((source_data.get("steps") or {}).get("intake") or {}).get("latest"),
        "TikOmni gate keeps intake bound to its source run",
        str({"expected": source_intake_path or intake_path, "actual": ((source_data.get("steps") or {}).get("intake") or {}).get("latest"), "error": source_error}),
    ) else 1
    failures += 0 if expect(
        not distractor_error and not ((distractor_data.get("steps") or {}).get("validate")),
        "blocked research does not create downstream artifacts in the active distractor run",
        str({"steps": distractor_data.get("steps"), "error": distractor_error}),
    ) else 1
    active, active_error = active_run_id(project_dir)
    failures += 0 if expect(
        not active_error and active == distractor_run_id,
        "source-bound TikOmni gate does not switch the active task",
        str({"expected": distractor_run_id, "actual": active, "error": active_error}),
    ) else 1

    failures += 0 if switch_runtime_run(project_dir, restore_run_id) else 1
    return failures


def run_write_exercises(
    base_url: str,
    timeout: int,
    project_dir: str | None = None,
    smoke_provider_token: str = "",
) -> int:
    failures = 0
    stamp = str(int(time.time() * 1000))
    slug = f"ui-smoke-{stamp}"
    run_id = f"ui-smoke-run-{stamp}"
    restored_brain = False

    ok, run = request_json(
        base_url,
        "/api/run",
        timeout,
        method="POST",
        payload={
            "topic": "UI smoke 运行链路测试",
            "platforms": ["wechat", "xhs"],
            "slug": slug,
            "runId": run_id,
        },
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(run.get("run_file", "").startswith("runs/"), "run-create returns relative run file") else 1
        failures += 0 if expect_no_local_absolute_paths(
            run,
            "run-create response does not expose local absolute paths",
        ) else 1

    ok, invalid_run = request_json(
        base_url,
        "/api/run",
        timeout,
        method="POST",
        payload={"topic": {"not": "text"}, "platforms": ["wechat"]},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in invalid_run, "run-create blocks non-text topic") else 1

    ok, brain_before = request_json(base_url, "/api/brain", timeout)
    failures += 0 if ok else 1
    original_you = str(brain_before.get("you", "")) if ok else ""
    if ok:
        marker = f"\n\n<!-- ui-smoke-brain-save:{slug} -->\n"
        ok, _ = request_json(
            base_url,
            "/api/brain",
            timeout,
            method="POST",
            payload={"file": "you", "content": f"{original_you.rstrip()}{marker}"},
        )
        failures += 0 if ok else 1
        ok, brain_after = request_json(base_url, "/api/brain", timeout)
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(marker.strip() in str(brain_after.get("you", "")), "brain save persists editable memory file") else 1
        ok, _ = request_json(
            base_url,
            "/api/brain",
            timeout,
            method="POST",
            payload={"file": "you", "content": original_you},
        )
        restored_brain = ok
        failures += 0 if expect(restored_brain, "brain save smoke restores original memory content") else 1

        ok, oversized_brain = request_json(
            base_url,
            "/api/brain",
            timeout,
            method="POST",
            payload={"file": "you", "content": "x" * (270 * 1024)},
            expect_status=(400,),
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect("error" in oversized_brain, "brain API blocks oversized memory content") else 1

    material_name = f"{slug}.md"
    material_content = f"# UI Smoke 素材\n\n这是前端 API 写入链路测试素材。\n\nslug: {slug}\n"
    ok, material = request_json(
        base_url,
        "/api/materials?action=create",
        timeout,
        method="POST",
        payload={
            "path": "materials/ui-smoke",
            "name": material_name,
            "content": material_content,
        },
    )
    failures += 0 if ok else 1
    material_path = str(material.get("path", "")) if ok else ""
    if ok:
        failures += 0 if expect(material_path.startswith("materials/ui-smoke/"), "materials create returns library path", material_path) else 1

    if material_path:
        ok, fetched = request_json(
            base_url,
            f"/api/materials?path={material_path}",
            timeout,
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(slug in str(fetched.get("content", "")), "materials read returns written content") else 1

        ok, text_extract = request_json(
            base_url,
            "/api/materials?action=extract",
            timeout,
            method="POST",
            payload={"path": material_path},
        )
        failures += 0 if ok else 1
        text_extract_path = str(text_extract.get("path", "")) if ok else ""
        if ok:
            text_extract_content = str(text_extract.get("content", ""))
            failures += 0 if expect(
                text_extract_path.startswith("materials/extracted/"),
                "materials API generates traceable text extraction asset",
                text_extract_path,
            ) else 1
            failures += 0 if expect(
                text_extract.get("extractionStatus") == "text_extracted"
                and "## 3. 证据台账" in text_extract_content
                and material_path in text_extract_content
                and slug in text_extract_content,
                "materials text extraction keeps source and evidence ledger",
                text_extract_content[:500],
            ) else 1

            ok, intake_handoff = request_json(
                base_url,
                "/api/materials?action=start-intake",
                timeout,
                method="POST",
                payload={"path": text_extract_path, "platforms": ["wechat", "xiaohongshu"]},
            )
            failures += 0 if ok else 1
            request_id = str(intake_handoff.get("requestId", "")) if ok else ""
            if ok:
                failures += 0 if expect(
                    request_id and intake_handoff.get("nextUrl") == f"/production?materialRequest={request_id}",
                    "materials API creates intake handoff request",
                    str(intake_handoff),
                ) else 1
            if request_id:
                ok, intake_request = request_json(
                    base_url,
                    f"/api/materials?intakeRequest={request_id}",
                    timeout,
                )
                failures += 0 if ok else 1
                if ok:
                    request_material = str(intake_request.get("rawMaterial", ""))
                    failures += 0 if expect(
                        intake_request.get("sourcePath") == text_extract_path
                        and intake_request.get("extractedPath") == text_extract_path
                        and intake_request.get("extractionStatus") == "text_extracted"
                        and "## 3. 证据台账" in request_material
                        and slug in request_material,
                        "materials API exposes intake handoff request",
                        str(intake_request)[:500],
                    ) else 1

    ok, blocked_material_read = request_json(
        base_url,
        f"/api/materials?path={quote('materials/../brain/you.md', safe='')}",
        timeout,
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in blocked_material_read, "materials API blocks reads outside materials/") else 1

    ok, blocked_material_list = request_json(
        base_url,
        f"/api/materials?type={quote('materials/../brain', safe='')}",
        timeout,
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in blocked_material_list, "materials API blocks listing outside materials/") else 1

    ok, uploaded_material = request_multipart(
        base_url,
        "/api/materials?action=upload",
        timeout,
        fields={"path": "materials/ui-smoke"},
        files={"file": (f"{slug}-upload.txt", f"uploaded material for {slug}\n".encode("utf-8"), "text/plain")},
    )
    failures += 0 if ok else 1
    uploaded_material_path = str(uploaded_material.get("path", "")) if ok else ""
    if ok:
        failures += 0 if expect(
            uploaded_material_path.startswith("materials/ui-smoke/"),
            "materials upload stores file in library path",
            uploaded_material_path,
        ) else 1
    if uploaded_material_path:
        ok, uploaded_material_read = request_json(base_url, f"/api/materials?path={uploaded_material_path}", timeout)
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(
                slug in str(uploaded_material_read.get("content", "")),
                "materials upload can be read back",
            ) else 1

    ok, binary_material = request_multipart(
        base_url,
        "/api/materials?action=upload",
        timeout,
        fields={"path": "materials/ui-smoke"},
        files={"file": (f"{slug}-binary.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "image/png")},
    )
    failures += 0 if ok else 1
    binary_material_path = str(binary_material.get("path", "")) if ok else ""
    if ok:
        failures += 0 if expect(
            binary_material_path.startswith("materials/ui-smoke/"),
            "materials binary upload stores file in library path",
            binary_material_path,
        ) else 1

    if binary_material_path:
        ok, binary_preview = request_json(
            base_url,
            f"/api/materials?path={quote(binary_material_path, safe='')}",
            timeout,
        )
        failures += 0 if ok else 1
        download_url = str(binary_preview.get("downloadUrl", "")) if ok else ""
        if ok:
            failures += 0 if expect(
                binary_preview.get("previewable") is False and bool(download_url),
                "materials API returns binary material download metadata",
                str(binary_preview),
            ) else 1
        if download_url:
            ok, downloaded_body, downloaded_headers = request_bytes(base_url, download_url, timeout)
            failures += 0 if ok else 1
            if ok:
                failures += 0 if expect(
                    downloaded_body.startswith(b"\x89PNG"),
                    "materials API downloads binary material content",
                    downloaded_body[:16].hex(),
                ) else 1
                failures += 0 if expect(
                    "attachment" in downloaded_headers.get("content-disposition", ""),
                    "materials binary download uses attachment disposition",
                    str(downloaded_headers),
                ) else 1

        ok, binary_extract = request_json(
            base_url,
            "/api/materials?action=extract",
            timeout,
            method="POST",
            payload={"path": binary_material_path},
        )
        failures += 0 if ok else 1
        if ok:
            binary_extract_content = str(binary_extract.get("content", ""))
            failures += 0 if expect(
                str(binary_extract.get("path", "")).startswith("materials/extracted/")
                and binary_extract.get("extractionStatus") == "needs_transcription"
                and "待补充转写/OCR" in binary_extract_content
                and "不应直接进入内容生成" in binary_extract_content,
                "materials API generates guarded binary extraction asset",
                binary_extract_content[:500],
            ) else 1

        ok, binary_handoff = request_json(
            base_url, "/api/materials?action=start-intake", timeout, method="POST",
            payload={"path": binary_material_path}, expect_status=(422,),
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(
                not binary_handoff.get("requestId") and binary_handoff.get("code") == "material_text_required",
                "materials API refuses intake until binary text is available",
                str(binary_handoff),
            ) else 1

    ok, blocked_material_download = request_json(
        base_url,
        f"/api/materials?download={quote('materials/../brain/you.md', safe='')}",
        timeout,
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in blocked_material_download, "materials API blocks download traversal outside materials/") else 1

    ok, blocked_material_extract = request_json(
        base_url,
        "/api/materials?action=extract",
        timeout,
        method="POST",
        payload={"path": "materials/../brain/you.md"},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in blocked_material_extract, "materials API blocks extraction traversal outside materials/") else 1

    ok, blocked_intake_handoff = request_json(
        base_url,
        "/api/materials?action=start-intake",
        timeout,
        method="POST",
        payload={"path": "materials/../brain/you.md"},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in blocked_intake_handoff, "materials API blocks intake handoff traversal outside materials/") else 1

    ok, blocked_material_upload = request_multipart(
        base_url,
        "/api/materials?action=upload",
        timeout,
        fields={"path": "materials/ui-smoke"},
        files={"file": (f"{slug}.sh", b"echo should-not-save\n", "text/plain")},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in blocked_material_upload, "materials API blocks unsupported uploads") else 1

    ok, invalid_material_content = request_json(
        base_url,
        "/api/materials?action=create",
        timeout,
        method="POST",
        payload={"path": "materials/ui-smoke", "name": f"{slug}-invalid.md", "content": {"not": "text"}},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in invalid_material_content, "materials API blocks non-text create content") else 1

    ok, blocked_material = request_json(
        base_url,
        "/api/materials?action=create",
        timeout,
        method="POST",
        payload={"path": "../outside", "name": f"{slug}.md", "content": "should be blocked"},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in blocked_material, "materials API blocks writes outside materials/") else 1

    final_seed_path = f"pipeline/final/{slug}-seed.md"
    final_content = valid_write_content(slug)
    ok, blocked_final_write = request_json(
        base_url,
        output_api_path(final_seed_path),
        timeout,
        method="POST",
        payload={"content": final_content, "versionLabel": "ui-smoke"},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    final_path = ""
    if ok:
        failures += 0 if expect(
            blocked_final_write.get("code") == "output_version_not_allowed",
            "output API refuses creating an unowned final draft",
            str(blocked_final_write),
        ) else 1

    ok, invalid_output_content = request_json(
        base_url,
        output_api_path(f"pipeline/final/{slug}-invalid-content.md"),
        timeout,
        method="POST",
        payload={"content": {"not": "text"}, "versionLabel": "invalid"},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in invalid_output_content, "output API blocks non-text version content") else 1

    if final_path:
        legacy_publish_payload = {
            "finalPath": final_path,
            "title": f"UI Smoke 发布记录 {slug}",
            "platform": "wechat",
            "publishedAt": "2026-07-12",
            "url": "https://example.com/aifios-ui-smoke",
            "views": "0",
            "likes": "0",
            "comments": "0",
            "notes": "UI smoke 发布记录链路测试。",
        }
        ok, final_read = request_json(base_url, output_api_path(final_path), timeout)
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(slug in str(final_read.get("content", "")), "output preview reads saved final draft") else 1
        ok, final_validated_read = request_json(base_url, f"{output_api_path(final_path)}?validate=1", timeout)
        failures += 0 if ok else 1
        if ok:
            read_validation = final_validated_read.get("validation") or {}
            failures += 0 if expect(
                isinstance(read_validation.get("valid"), bool),
                "output preview can validate existing runtime artifact",
                str(read_validation),
            ) else 1

        ok, retired_direct_publish = request_json(
            base_url,
            "/api/publish",
            timeout,
            method="POST",
            payload=legacy_publish_payload,
            expect_status=(410,),
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect_no_local_absolute_paths(
                retired_direct_publish,
                "retired direct-publish response does not expose local absolute paths",
            ) else 1
            failures += 0 if expect(
                retired_direct_publish.get("migration") == "/api/publish/results"
                and "已停用" in str(retired_direct_publish.get("error", "")),
                "legacy direct-publish endpoint is retired and routes callers to publication results",
                str(retired_direct_publish),
            ) else 1

        agent_chain: list[tuple[str, str, dict, str]] = []
        if final_path and smoke_provider_token:
            agent_chain.append((
                "content-review",
                "review",
                {
                    "originalArticlePath": final_path,
                    "platformData": "阅读 1200，互动 86，评论 18，转化 3 条咨询线索。",
                    "slug": "wrong-ui-smoke-review-slug",
                },
                "pipeline/review/",
            ))
        if final_path and smoke_provider_token:
            agent_chain.append((
                "self-archive",
                "archive",
                {
                    "draftPath": final_path,
                    "feedback": "UI smoke 归档链路测试。",
                    "slug": "wrong-ui-smoke-archive-slug",
                },
                "pipeline/archive/",
            ))
            agent_chain.append((
                "content-twin",
                "twin",
                {
                    "publishedContentPath": final_path,
                    "publishedContent": "UI smoke 数字孪生观察链路测试。",
                    "flags": [],
                    "slug": "wrong-ui-smoke-twin-slug",
                },
                "pipeline/twin/",
            ))

        for skill, runtime_step, params, prefix in agent_chain:
            ok, events = request_sse_events(
                base_url,
                "/api/agent/invoke",
                timeout,
                payload={
                    "skill": skill,
                    "params": params,
                    "config": smoke_llm_config(smoke_provider_token),
                    "runtimeStep": runtime_step,
                },
            )
            failures += 0 if ok else 1
            saved_path = saved_path_from_events(events) if ok else ""
            if ok:
                failures += 0 if expect_no_local_absolute_paths(
                    {"events": events},
                    "agent invoke events do not expose local absolute paths",
                ) else 1
                failures += 0 if expect(
                    saved_path.startswith(prefix),
                    f"{skill} agent saves {runtime_step} artifact",
                    saved_path,
                ) else 1
                validation_event = validation_event_from_events(events, saved_path)
                failures += 0 if expect(
                    isinstance(validation_event.get("valid"), bool),
                    f"{skill} agent emits runtime validation event",
                    str(validation_event),
                ) else 1
            if saved_path and project_dir:
                run_data, error = read_run_file(project_dir, run_id)
                if error:
                    failures += 0 if expect(False, f"{skill} run state can be read", error) else 1
                else:
                    step_latest = ((run_data.get("steps") or {}).get(runtime_step) or {}).get("latest")
                    failures += 0 if expect(
                        step_latest == saved_path,
                        f"{skill} agent writes {runtime_step} into source run",
                        str({"expected": saved_path, "actual": step_latest}),
                    ) else 1

        if final_path:
            ok, blocked_smoke_provider = request_text(
                base_url,
                "/api/agent/invoke",
                timeout,
                method="POST",
                payload={
                    "skill": "content-twin",
                    "params": {
                        "publishedContentPath": final_path,
                        "publishedContent": "负向测试：错误 token 不应启用 smoke provider。",
                        "flags": [],
                        "slug": slug,
                    },
                    "config": smoke_llm_config("wrong-smoke-provider-token"),
                    "runtimeStep": "twin",
                },
                expect_status=(500,),
            )
            failures += 0 if ok else 1
            if ok:
                failures += 0 if expect(
                    "aifios-smoke provider is disabled" in blocked_smoke_provider,
                    "smoke provider requires release token",
                    blocked_smoke_provider[:200],
                ) else 1

            ok, invalid_runtime_step = request_text(
                base_url,
                "/api/agent/invoke",
                timeout,
                method="POST",
                payload={
                    "skill": "content-review",
                    "params": {
                        "originalArticlePath": final_path,
                        "platformData": "负向测试：非法 runtime step 不应产生游离文件。",
                        "slug": slug,
                    },
                    "config": smoke_llm_config(smoke_provider_token),
                    "runtimeStep": "not-a-runtime-step",
                },
                expect_status=(400,),
            )
            failures += 0 if ok else 1
            if ok:
                failures += 0 if expect_no_local_absolute_paths(
                    {"body": invalid_runtime_step},
                    "agent invoke invalid runtime-step error does not expose local absolute paths",
                ) else 1
                failures += 0 if expect(
                    json.loads(invalid_runtime_step).get("code") == "invalid_request",
                    "agent invoke blocks invalid runtime step override",
                    invalid_runtime_step[:240],
                ) else 1

            ok, mismatched_runtime_step = request_text(
                base_url,
                "/api/agent/invoke",
                timeout,
                method="POST",
                payload={
                    "skill": "wechat-writer",
                    "params": {
                        "topic": "负向测试：合法 runtime step 也不能跨 skill 写入。",
                        "material": "本请求不应进入模型调用，也不应写入数字孪生。",
                        "slug": slug,
                    },
                    "config": smoke_llm_config(smoke_provider_token),
                    "runtimeStep": "twin",
                },
                expect_status=(400,),
            )
            failures += 0 if ok else 1
            if ok:
                failures += 0 if expect_no_local_absolute_paths(
                    {"body": mismatched_runtime_step},
                    "agent invoke runtime-step mismatch error does not expose local absolute paths",
                ) else 1
                failures += 0 if expect(
                    "Runtime step 与 skill 不匹配" in mismatched_runtime_step,
                    "agent invoke blocks mismatched runtime step override",
                    mismatched_runtime_step[:240],
                ) else 1

    placeholder_seed_path = f"pipeline/final/{slug}-placeholder.md"
    placeholder_content = (
        "# UI Smoke 占位符质量门禁\n\n"
        "很多创始人第一次写公众号，会把文章写成自我介绍。但客户真正关心的是你是否理解他的具体处境。\n\n"
        "## 一个真实场景\n\n"
        "最近一个咨询客户拿着项目页面来问我，为什么写了很多文章还是没人私信。问题不是他不专业，而是开头没有说出客户正在卡住的地方。\n\n"
        "## 判断标准\n\n"
        "下一步可以先检查三个问题：客户是谁、他卡在哪里、你能把他引向哪个咨询问题。\n\n"
        "## 待补充案例\n\n"
        "客户名：待填。这里补充一段更完整的客户原话。{{case_quote}}\n"
    )
    ok, blocked_placeholder_write = request_json(
        base_url,
        output_api_path(placeholder_seed_path),
        timeout,
        method="POST",
        payload={"content": placeholder_content, "versionLabel": "ui-smoke-placeholder"},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    placeholder_path = ""
    if ok:
        failures += 0 if expect(
            blocked_placeholder_write.get("code") == "output_version_not_allowed",
            "placeholder text cannot create an unowned output file",
            str(blocked_placeholder_write),
        ) else 1
    ok, blocked_output = request_json(base_url, "/api/output/brain/you.md", timeout, expect_status=(400,))
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in blocked_output, "output API refuses non-pipeline/quality reads") else 1

    ok, blocked_output_traversal = request_json(
        base_url,
        "/api/output/pipeline/%2E%2E/brain/you.md",
        timeout,
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(
            "error" in blocked_output_traversal,
            "output API refuses traversal through readable root",
        ) else 1

    ok, agent_guard = request_text(
        base_url,
        "/api/agent/invoke",
        timeout,
        method="POST",
        payload={
            "skill": "content-validate",
            "params": {"source": "materials/not-final.md"},
            "config": {"provider": "openai", "apiKey": "test-key", "model": "gpt-5.5", "baseUrl": "https://api.openai.com/v1"},
            "runtimeStep": "validate",
        },
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(
            json.loads(agent_guard).get("code") == "content_reference_unavailable",
            "agent invoke guard blocks unsafe validation sources",
        ) else 1

    ok, retired_skill = request_text(
        base_url,
        "/api/agent/invoke",
        timeout,
        method="POST",
        payload={"skill": "content-twin", "params": {}, "config": {}},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(
            json.loads(retired_skill).get("code") == "feature_not_available",
            "agent invoke keeps pruned historical skills inactive",
            retired_skill[:240],
        ) else 1

    ok, invalid_runtime_step = request_text(
        base_url,
        "/api/agent/invoke",
        timeout,
        method="POST",
        payload={
            "skill": "content-intake",
            "params": {"rawMaterial": "虚构接口检查", "runId": run_id},
            "config": {"provider": "openai", "apiKey": "test-key", "model": "gpt-5.5", "baseUrl": "https://api.openai.com/v1"},
            "runtimeStep": "not-a-runtime-step",
        },
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(
            json.loads(invalid_runtime_step).get("code") == "invalid_request",
            "agent invoke blocks invalid runtime-step overrides",
            invalid_runtime_step[:240],
        ) else 1

    ok, bad_agent_config = request_text(
        base_url,
        "/api/agent/invoke",
        timeout,
        method="POST",
        payload={
            "skill": "content-intake",
            "params": {"rawMaterial": "虚构接口检查", "runId": run_id},
            "config": {"provider": "not-a-provider", "apiKey": "", "model": "x"},
        },
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(json.loads(bad_agent_config).get("code") == "model_settings_invalid", "agent invoke rejects invalid LLM config") else 1

    ok, config = request_json(base_url, "/api/config", timeout)
    failures += 0 if ok else 1
    original_config = config.get("config", {}) if ok else {}
    if ok:
        failures += 0 if expect(isinstance(config.get("config"), dict), "config API returns config object") else 1
        failures += 0 if expect(
            not original_config.get("apiKey"),
            "config API does not expose saved API key",
        ) else 1
        if not original_config.get("hasSavedKey"):
            smoke_api_key = "sk-proj-ui-smoke-secret-not-for-network-1234567890"
            secret_config = {
                **original_config,
                "provider": "deepseek",
                "apiKey": smoke_api_key,
                "model": "deepseek-v4-flash",
                "baseUrl": "https://api.deepseek.com/v1",
                "temperature": 0,
                "maxTokens": 1200,
            }
            ok, saved_secret_config = request_json(
                base_url,
                "/api/config",
                timeout,
                method="POST",
                payload=secret_config,
            )
            failures += 0 if ok else 1
            if ok:
                saved_payload = saved_secret_config.get("config", {})
                failures += 0 if expect(
                    saved_payload.get("hasSavedKey") is True
                    and not saved_payload.get("apiKey")
                    and smoke_api_key not in json.dumps(saved_secret_config, ensure_ascii=False),
                    "config API redacts API key after save",
                    str(saved_payload),
                ) else 1
                failures += 0 if expect_private_config_permissions(project_dir) else 1

            preserve_payload = {
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "baseUrl": "https://api.deepseek.com/v1",
                "temperature": 0,
                "maxTokens": 1200,
            }
            ok, preserved_secret_config = request_json(
                base_url,
                "/api/config",
                timeout,
                method="POST",
                payload=preserve_payload,
            )
            failures += 0 if ok else 1
            if ok:
                failures += 0 if expect(
                    preserved_secret_config.get("config", {}).get("hasSavedKey") is True
                    and not preserved_secret_config.get("config", {}).get("apiKey"),
                    "config API preserves saved key when payload omits apiKey",
                    str(preserved_secret_config.get("config", {})),
                ) else 1
        if original_config.get("hasSavedKey"):
            temp_zero_config = config_save_payload({
                **original_config,
                "temperature": 0,
                "maxTokens": 1200,
            })
        else:
            temp_zero_config = {
                **original_config,
                "provider": "deepseek",
                "apiKey": "",
                "model": "deepseek-v4-flash",
                "baseUrl": "https://api.deepseek.com/v1",
                "temperature": 0,
                "maxTokens": 1200,
            }
        ok, saved_config = request_json(
            base_url,
            "/api/config",
            timeout,
            method="POST",
            payload=temp_zero_config,
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(saved_config.get("config", {}).get("temperature") == 0, "config API preserves zero temperature") else 1
            failures += 0 if expect_private_config_permissions(project_dir) else 1
        ok, reloaded_config = request_json(base_url, "/api/config", timeout)
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect(reloaded_config.get("config", {}).get("temperature") == 0, "config API reload preserves zero temperature") else 1
        ok, invalid_config = request_json(
            base_url,
            "/api/config",
            timeout,
            method="POST",
            payload={"provider": "not-a-provider", "model": "x", "baseUrl": "https://api.invalid.test/v1"},
            expect_status=(400,),
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect("issues" in invalid_config, "config API rejects unsupported provider") else 1
        if original_config:
            ok, _ = request_json(
                base_url,
                "/api/config",
                timeout,
                method="POST",
                payload=config_save_payload(original_config),
            )
            failures += 0 if expect(ok, "config API restores original config") else 1

    ok, status_payload = request_json(base_url, "/api/status", timeout)
    failures += 0 if ok else 1
    if ok:
        latest = status_payload.get("latest", {})
        failures += 0 if expect(
            latest.get("active_run_id") == run_id or status_payload.get("project"),
            "status API reflects usable project state",
        ) else 1
        failures += 0 if expect_no_local_absolute_paths(
            status_payload,
            "status API does not expose local absolute paths",
        ) else 1

    ok, quality = request_json(
        base_url,
        "/api/quality",
        timeout,
        method="POST",
        payload={"platform": "wechat", "slug": slug, "minScore": 72},
        expect_status=(200, 500),
    )
    # A new smoke run intentionally has no final draft, so either a structured blocked
    # response or a clear no-file error proves the API reached the runtime gate.
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect_no_local_absolute_paths(
            quality,
            "quality API response does not expose local absolute paths",
        ) else 1
        result = quality.get("result", {})
        message = str(quality.get("error") or result.get("error") or quality)
        reached_gate = (
            quality.get("status") in {"blocked", "unknown"}
            or result.get("gate_status") == "blocked"
            or "没有找到" in message
            or "No such file" in message
        )
        failures += 0 if expect(reached_gate, "quality API reaches deterministic runtime gate") else 1

    if project_dir and final_path:
        quality_distractor_slug = f"{slug}-quality-distractor"
        quality_distractor_run_id = f"{run_id}-quality-distractor"
        ok, quality_distractor = request_json(
            base_url,
            "/api/run",
            timeout,
            method="POST",
            payload={
                "topic": "UI smoke 质量报告归属负向测试",
                "platforms": ["wechat"],
                "slug": quality_distractor_slug,
                "runId": quality_distractor_run_id,
            },
        )
        failures += 0 if ok else 1
        if ok:
            quality_distractor_run_id = str(quality_distractor.get("run_id") or quality_distractor_run_id)
            ok, file_scoped_quality = request_json(
                base_url,
                "/api/quality",
                timeout,
                method="POST",
                payload={"platform": "wechat", "file": final_path, "minScore": 72},
            )
            failures += 0 if ok else 1
            if ok:
                failures += 0 if expect_no_local_absolute_paths(
                    file_scoped_quality,
                    "quality API file-scoped response does not expose local absolute paths",
                ) else 1
                result = file_scoped_quality.get("result") or {}
                failures += 0 if expect(
                    result.get("run_id") == run_id
                    and result.get("slug") == slug
                    and result.get("run_id") != quality_distractor_run_id
                    and result.get("file") == final_path
                    and str(result.get("json_report_path") or "").startswith("quality/reports/"),
                    "quality API binds explicit file report to owning run, not active distractor",
                    str({
                        "expected_run": run_id,
                        "actual_run": result.get("run_id"),
                        "distractor": quality_distractor_run_id,
                        "slug": result.get("slug"),
                        "file": result.get("file"),
                        "json_report_path": result.get("json_report_path"),
                    }),
                ) else 1
        failures += 0 if switch_runtime_run(project_dir, run_id) else 1

    if placeholder_path:
        ok, placeholder_quality = request_json(
            base_url,
            "/api/quality",
            timeout,
            method="POST",
            payload={"platform": "wechat", "file": placeholder_path, "minScore": 50},
        )
        failures += 0 if ok else 1
        if ok:
            failures += 0 if expect_no_local_absolute_paths(
                placeholder_quality,
                "quality API placeholder response does not expose local absolute paths",
            ) else 1
            result = placeholder_quality.get("result", {})
            blocking_ids = {item.get("id") for item in result.get("delivery_audit_blocking", [])}
            failures += 0 if expect(
                placeholder_quality.get("status") == "blocked"
                and result.get("gate_status") == "blocked"
                and result.get("delivery_audit_status") == "blocked"
                and "no_placeholders" in blocking_ids,
                "quality API blocks placeholder deliverables",
                str(result),
            ) else 1

    ok, unsafe_quality = request_json(
        base_url,
        "/api/quality",
        timeout,
        method="POST",
        payload={"platform": "wechat", "file": "../outside.md"},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("error" in unsafe_quality, "quality API blocks files outside project") else 1

    ok, blocked_non_draft_quality = request_json(
        base_url,
        "/api/quality",
        timeout,
        method="POST",
        payload={"platform": "wechat", "file": "brain/you.md"},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(
            blocked_non_draft_quality.get("code") == "content_quality_check_failed",
            "quality API blocks non-draft project files",
            str(blocked_non_draft_quality),
        ) else 1

    ok, blocked_quality_step = request_json(
        base_url,
        "/api/quality",
        timeout,
        method="POST",
        payload={"platform": "wechat", "step": "xhs", "slug": slug},
        expect_status=(400,),
    )
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect(
            blocked_quality_step.get("code") == "content_quality_check_failed",
            "quality API blocks platform step mismatch",
            str(blocked_quality_step),
        ) else 1

    ok, delivery = request_json(base_url, "/api/delivery", timeout)
    failures += 0 if ok else 1
    if ok:
        failures += 0 if expect("readiness" in delivery and "missingRequired" in delivery, "delivery API returns readiness model") else 1
        failures += 0 if expect_no_local_absolute_paths(
            delivery,
            "delivery API does not expose local absolute paths",
        ) else 1
        failures += 0 if expect(
            "activeRun" in delivery and "latestAudit" in delivery and "latestDelivery" in delivery,
            "delivery API returns active-run scoped delivery view",
            str({key: delivery.get(key) for key in ("activeRun", "latestAudit", "latestDelivery")}),
        ) else 1
        asset_gate = delivery.get("assetGate")
        failures += 0 if expect(
            isinstance(asset_gate, dict)
            and asset_gate.get("status") in {"pass", "review_required", "blocked", "not_started"}
            and isinstance(asset_gate.get("items"), list),
            "delivery API returns visual asset gate",
            str(asset_gate),
        ) else 1
        active_run = delivery.get("activeRun") or {}
        if active_run.get("run_id"):
            active_run_data: dict = {}
            if project_dir:
                active_run_data, active_run_error = read_run_file(project_dir, str(active_run.get("run_id") or ""))
                failures += 0 if expect(
                    not active_run_error and active_run_data.get("run_id") == active_run.get("run_id"),
                    "delivery smoke can read active run state",
                    str({"expected": active_run.get("run_id"), "actual": active_run_data.get("run_id"), "error": active_run_error}),
                ) else 1

            ok, audit_delivery = request_json(
                base_url,
                "/api/delivery?action=audit",
                timeout,
                method="POST",
                payload={"runId": active_run.get("run_id"), "slug": active_run.get("slug")},
            )
            failures += 0 if ok else 1
            if ok:
                failures += 0 if expect_no_local_absolute_paths(
                    audit_delivery,
                    "delivery audit API response does not expose local absolute paths",
                ) else 1
                overview = audit_delivery.get("overview") or {}
                latest_audit = overview.get("latestAudit") or {}
                latest_delivery = overview.get("latestDelivery") or {}
                delivery_gate = latest_delivery.get("delivery_gate") or {}
                runtime_validation = delivery_gate.get("runtime_validation") or {}
                audit_payload = audit_delivery.get("audit") or {}
                audit_status = audit_payload.get("status")
                audit_pack = audit_payload.get("delivery_pack") or {}
                audit_report_path = latest_audit.get("json_report_path") or latest_audit.get("report_path")
                markdown_report_path = latest_audit.get("markdown_report_path")
                audit_actions = latest_audit.get("recommended_actions") or []
                gate_actions = delivery_gate.get("recommended_actions") or []
                failures += 0 if expect(
                    audit_delivery.get("status") == audit_status
                    and latest_audit.get("status") == audit_status
                    and latest_audit.get("run_id") == active_run.get("run_id")
                    and latest_audit.get("json_report_path") == audit_payload.get("json_report_path")
                    and latest_delivery.get("run_id") == active_run.get("run_id")
                    and not any(
                        item.get("step") == "publish"
                        and str(item.get("source") or "").startswith("pipeline/publish/")
                        for item in latest_delivery.get("artifacts") or []
                    )
                    and not latest_delivery.get("zip_path")
                    and not audit_pack.get("zip_path")
                    and delivery_gate.get("can_deliver") is False
                    and delivery_gate.get("publication_prerequisites", {}).get("errors")
                    and delivery_gate.get("status") in {"pass", "review_required", "blocked", "not_audited"},
                    "delivery audit keeps incomplete active run internal without ZIP",
                    str({
                        "status": audit_delivery.get("status"),
                        "audit": latest_audit.get("run_id"),
                        "audit_report": audit_report_path,
                        "delivery": latest_delivery.get("run_id"),
                        "delivery_audit_report": delivery_gate.get("audit_report"),
                        "gate": delivery_gate.get("status"),
                        "zip": latest_delivery.get("zip_path"),
                        "audit_zip": audit_pack.get("zip_path"),
                        "legacy_publish": "retired",
                    }),
                ) else 1
                if active_run_data:
                    failures += 0 if expect_delivery_manifest_scoped_to_run(
                        latest_delivery,
                        active_run_data,
                        "delivery audit manifest artifacts belong to active run",
                    ) else 1
                failures += 0 if expect(
                    isinstance(delivery_gate.get("publication_prerequisites", {}).get("errors"), list)
                    and bool(delivery_gate.get("publication_prerequisites", {}).get("errors")),
                    "delivery gate exposes the blocking publication prerequisites",
                    str(delivery_gate.get("publication_prerequisites")),
                ) else 1
                needs_action = delivery_gate.get("status") in {"blocked", "review_required", "not_audited"} or audit_status in {"blocked", "review_required"}
                failures += 0 if expect(
                    not needs_action
                    or (
                        isinstance(audit_actions, list)
                        and isinstance(gate_actions, list)
                        and bool(audit_actions or gate_actions)
                        and all(item.get("title") and item.get("command") for item in (audit_actions or gate_actions)[:3])
                    ),
                    "delivery gate exposes recommended actions",
                    str({
                        "audit_status": audit_status,
                        "gate": delivery_gate.get("status"),
                        "audit_actions": audit_actions[:3],
                        "gate_actions": gate_actions[:3],
                    }),
                ) else 1

            ok, packed_delivery = request_json(
                base_url,
                "/api/delivery",
                timeout,
                method="POST",
                payload={"runId": active_run.get("run_id"), "slug": active_run.get("slug")},
            )
            failures += 0 if ok else 1
            if ok:
                failures += 0 if expect_no_local_absolute_paths(
                    packed_delivery,
                    "delivery pack API response does not expose local absolute paths",
                ) else 1
                manifest = packed_delivery.get("manifest") or {}
                gate = manifest.get("delivery_gate") or {}
                pack_overview = packed_delivery.get("overview") or {}
                pack_latest_audit = pack_overview.get("latestAudit") or {}
                pack_audit_report_path = pack_latest_audit.get("json_report_path") or pack_latest_audit.get("report_path")
                gate_actions = gate.get("recommended_actions") or []
                needs_action = gate.get("status") in {"blocked", "review_required", "not_audited"}
                failures += 0 if expect(
                    packed_delivery.get("status") == "review_packed"
                    and manifest.get("run_id") == active_run.get("run_id")
                    and not manifest.get("zip_path")
                    and manifest.get("formal_delivery") is False
                    and gate.get("can_deliver") is False
                    and gate.get("publication_prerequisites", {}).get("errors")
                    and gate.get("status") in {"pass", "review_required", "blocked", "not_audited"},
                    "delivery pack API keeps an incomplete active-run package internal",
                    str({
                        "status": packed_delivery.get("status"),
                        "run": manifest.get("run_id"),
                        "zip": manifest.get("zip_path"),
                        "audit_report": gate.get("audit_report"),
                        "latest_audit": pack_audit_report_path,
                        "gate": gate.get("status"),
                    }),
                ) else 1
                if active_run_data:
                    failures += 0 if expect_delivery_manifest_scoped_to_run(
                        manifest,
                        active_run_data,
                        "delivery pack manifest artifacts belong to active run",
                    ) else 1
                failures += 0 if expect(
                    not needs_action
                    or (
                        isinstance(gate_actions, list)
                        and bool(gate_actions)
                        and all(item.get("title") and item.get("command") for item in gate_actions[:3])
                    ),
                    "delivery pack API returns gate recommended actions",
                    str({
                        "gate": gate.get("status"),
                        "actions": gate_actions[:3],
                    }),
                ) else 1
                # The directory has a manifest but must not have a shareable ZIP.
                internal_dir = str(manifest.get("delivery_dir") or "")
                failures += 0 if expect(internal_dir.startswith("deliveries/"),
                                        "internal delivery path remains project-relative", internal_dir) else 1
                ok, blocked_download = request_json(
                    base_url, f"/api/delivery?download={quote(internal_dir + '.zip', safe='')}",
                    timeout, expect_status=(409,),
                )
                failures += 0 if ok else 1
                if ok:
                    failures += 0 if expect(blocked_download.get("code") == "delivery_not_ready",
                                            "internal-only delivery cannot be downloaded as a customer ZIP") else 1
                zip_path = manifest.get("zip_path")
                if isinstance(zip_path, str) and zip_path:
                    ok, zip_body = request_text(
                        base_url,
                        f"/api/delivery?download={quote(zip_path, safe='')}",
                        timeout,
                    )
                    failures += 0 if ok else 1
                    if ok:
                        failures += 0 if expect(zip_body.startswith("PK"), "delivery download returns zip content") else 1

                for unsafe_download in ("../README.md", "pipeline/final/fake.zip", "deliveries/fake-manifest.json"):
                    ok, unsafe_download_payload = request_json(
                        base_url,
                        f"/api/delivery?download={quote(unsafe_download, safe='')}",
                        timeout,
                        expect_status=(400,),
                    )
                    failures += 0 if ok else 1
                    if ok:
                        failures += 0 if expect(
                            "error" in unsafe_download_payload,
                            f"delivery download blocks unsafe path {unsafe_download}",
                        ) else 1

                if project_dir:
                    distractor_slug = f"{slug}-delivery-distractor"
                    distractor_run_id = f"{run_id}-delivery-distractor"
                    distractor_zip_path = ""
                    ok, distractor_run = request_json(
                        base_url,
                        "/api/run",
                        timeout,
                        method="POST",
                        payload={
                            "topic": "UI smoke 交付串线负向测试",
                            "platforms": ["wechat"],
                            "slug": distractor_slug,
                            "runId": distractor_run_id,
                        },
                    )
                    failures += 0 if ok else 1
                    if ok:
                        distractor_run_id = str(distractor_run.get("run_id") or distractor_run_id)
                        distractor_slug = str(distractor_run.get("slug") or distractor_slug)
                        ok, distractor_pack = request_json(
                            base_url,
                            "/api/delivery",
                            timeout,
                            method="POST",
                            payload={"runId": distractor_run_id, "slug": distractor_slug},
                        )
                        failures += 0 if ok else 1
                        if ok:
                            failures += 0 if expect_no_local_absolute_paths(
                                distractor_pack,
                                "distractor delivery pack response does not expose local absolute paths",
                            ) else 1
                            failures += 0 if expect(
                                (distractor_pack.get("manifest") or {}).get("run_id") == distractor_run_id,
                                "distractor delivery pack builds non-active comparison package",
                                str((distractor_pack.get("manifest") or {}).get("run_id")),
                            ) else 1
                            distractor_zip_path = str((distractor_pack.get("manifest") or {}).get("zip_path") or "")
                    failures += 0 if switch_runtime_run(project_dir, str(active_run.get("run_id") or "")) else 1
                    ok, scoped_delivery = request_json(base_url, "/api/delivery", timeout)
                    failures += 0 if ok else 1
                    if ok:
                        scoped_active_run = scoped_delivery.get("activeRun") or {}
                        scoped_latest_audit = scoped_delivery.get("latestAudit") or {}
                        scoped_latest_delivery = scoped_delivery.get("latestDelivery") or {}
                        scoped_deliveries = scoped_delivery.get("deliveries") or []
                        failures += 0 if expect(
                            scoped_active_run.get("run_id") == active_run.get("run_id")
                            and scoped_latest_audit.get("run_id") == active_run.get("run_id")
                            and scoped_latest_delivery.get("run_id") == active_run.get("run_id")
                            and scoped_latest_delivery.get("run_id") != distractor_run_id,
                            "delivery API ignores newer distractor package and keeps active-run scope",
                            str({
                                "active": scoped_active_run.get("run_id"),
                                "latest_audit": scoped_latest_audit.get("run_id"),
                                "latest_delivery": scoped_latest_delivery.get("run_id"),
                                "distractor": distractor_run_id,
                            }),
                        ) else 1
                        failures += 0 if expect(
                            all((item or {}).get("run_id") != distractor_run_id for item in scoped_deliveries),
                            "delivery API filters delivery history to active run",
                            str({"deliveries": [item.get("run_id") for item in scoped_deliveries if isinstance(item, dict)], "distractor": distractor_run_id}),
                        ) else 1
                        if active_run_data:
                            failures += 0 if expect_delivery_manifest_scoped_to_run(
                                scoped_latest_delivery,
                                active_run_data,
                                "delivery scoped overview manifest excludes distractor run artifacts",
                                [distractor_run_id, distractor_slug],
                            ) else 1
                    if distractor_zip_path:
                        ok, non_active_download = request_json(
                            base_url,
                            f"/api/delivery?download={quote(distractor_zip_path, safe='')}",
                            timeout,
                            expect_status=(400,),
                        )
                        failures += 0 if ok else 1
                        if ok:
                            failures += 0 if expect(
                                "error" in non_active_download,
                                "delivery download blocks non-active run zip",
                                str(non_active_download),
                            ) else 1

    failures += run_agent_source_binding_exercise(
        base_url,
        timeout,
        project_dir,
        smoke_provider_token,
        slug,
        run_id,
    )

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test AIFIOS frontend routes")
    parser.add_argument("--base-url", default="http://localhost:3000", help="frontend base URL")
    parser.add_argument("--timeout", type=int, default=10, help="request timeout seconds")
    parser.add_argument("--skip-pages", action="store_true", help="only check API routes")
    parser.add_argument(
        "--exercise-writes",
        action="store_true",
        help="also exercise safe write/read API flows against the configured AIFIOS_PROJECT",
    )
    parser.add_argument(
        "--project-dir",
        default="",
        help="optional AIFIOS_PROJECT path; verifies that frontend access initialized the project layout",
    )
    parser.add_argument(
        "--smoke-provider-token",
        default="",
        help="release-smoke-only token that enables the local aifios-smoke LLM provider",
    )
    args = parser.parse_args()

    failures = 0
    failures += check_visual_workbench_contract()
    if not args.skip_pages:
        for route in DEFAULT_ROUTES:
            failures += 0 if check_path(args.base_url, route, args.timeout, expect_json=False) else 1

    for route in DEFAULT_APIS:
        failures += 0 if check_path(args.base_url, route, args.timeout, expect_json=True) else 1

    if args.exercise_writes:
        failures += run_write_exercises(args.base_url, args.timeout, args.project_dir, args.smoke_provider_token)

    failures += check_project_initialized(args.project_dir)

    if failures:
        print(f"FAIL ui smoke: {failures} failure(s)")
        return 1

    print("PASS ui smoke")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
