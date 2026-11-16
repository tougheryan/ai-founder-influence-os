#!/usr/bin/env python3
"""Guard frontend runtime handoff gates against regression.

This is intentionally a small static contract check. The critical invariant is:
an artifact may be saved for traceability, but it cannot enter the next pipeline
handoff until runtime validation has not failed.
"""
from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LEGACY_PIPELINE_PAGE = REPO_ROOT / "ui" / "app" / "pipeline" / "page.tsx"
PRODUCTION_PAGE = REPO_ROOT / "ui" / "app" / "production" / "page.tsx"
PRODUCTION_WORKBENCH = REPO_ROOT / "ui" / "components" / "production" / "ProductionWorkbench.tsx"
PRODUCTION_MODEL = REPO_ROOT / "ui" / "components" / "production" / "production-model.ts"
PRODUCTION_APPROVAL_API = REPO_ROOT / "ui" / "app" / "api" / "production" / "approval" / "route.ts"
AGENT_EXECUTOR = REPO_ROOT / "ui" / "components" / "AgentExecutor.tsx"
AGENT_STREAM = REPO_ROOT / "ui" / "hooks" / "useAgentStream.ts"
RESULT_PREVIEW = REPO_ROOT / "ui" / "components" / "ResultPreview.tsx"
VISUAL_WORKBENCH = REPO_ROOT / "ui" / "components" / "VisualWorkbench.tsx"
OUTPUT_LINKS = REPO_ROOT / "ui" / "lib" / "output-links.ts"
VISUAL_WORKBENCH_LOADER = REPO_ROOT / "ui" / "lib" / "visual-workbench.ts"
VISUAL_REVISE_API = REPO_ROOT / "ui" / "app" / "api" / "visual" / "revise" / "route.ts"
VISUAL_SELECT_API = REPO_ROOT / "ui" / "app" / "api" / "visual" / "select" / "route.ts"
VISUAL_REVISION_REQUEST = REPO_ROOT / "ui" / "lib" / "visual-revision-request.ts"
PIPELINE_REGISTRY = REPO_ROOT / "ui" / "lib" / "pipeline-registry.ts"
SKILL_LOADER = REPO_ROOT / "ui" / "lib" / "skill-loader.ts"
AGENT_INVOKE_API = REPO_ROOT / "ui" / "app" / "api" / "agent" / "invoke" / "route.ts"
PUBLISH_API = REPO_ROOT / "ui" / "app" / "api" / "publish" / "route.ts"
PUBLISH_DRAFTS_API = REPO_ROOT / "ui" / "app" / "api" / "publish" / "drafts" / "route.ts"
PUBLISH_RESULTS_API = REPO_ROOT / "ui" / "app" / "api" / "publish" / "results" / "route.ts"
QUALITY_API = REPO_ROOT / "ui" / "app" / "api" / "quality" / "route.ts"
DELIVERY_API = REPO_ROOT / "ui" / "app" / "api" / "delivery" / "route.ts"
TIKOMNI_SETTINGS = REPO_ROOT / "ui" / "components" / "TikOmniSettings.tsx"
CLIENT_ERROR_COPY = REPO_ROOT / "ui" / "lib" / "client-error-copy.ts"
PUBLICATION_BRIDGE_SETTINGS = REPO_ROOT / "ui" / "components" / "PublicationBridgeSettings.tsx"
PRODUCTION_STAGE_PANEL = REPO_ROOT / "ui" / "components" / "production" / "ProductionStagePanel.tsx"
BENCHMARK_ADVISOR_PAGE = REPO_ROOT / "ui" / "app" / "benchmark-advisor" / "page.tsx"
DELIVERY_PAGE = REPO_ROOT / "ui" / "app" / "delivery" / "page.tsx"
PUBLICATION_DESK_PAGE = REPO_ROOT / "ui" / "app" / "publication-desk" / "page.tsx"
WEEKLY_REVIEW_PAGE = REPO_ROOT / "ui" / "app" / "weekly-review" / "page.tsx"


class GateCheckError(AssertionError):
    pass


def read(path: Path) -> str:
    if not path.exists():
        raise GateCheckError(f"missing required UI source: {path.relative_to(REPO_ROOT)}")
    return path.read_text(encoding="utf-8")


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise GateCheckError(f"missing gate: {label}")


def require_any(text: str, needles: tuple[str, ...], label: str) -> str:
    for needle in needles:
        if needle in text:
            return needle
    raise GateCheckError(f"missing gate: {label}")


def forbid(text: str, needle: str, label: str) -> None:
    if needle in text:
        raise GateCheckError(f"forbidden regression: {label}")


def lines_between(text: str, start: str, end: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise GateCheckError(f"cannot find block start: {start}")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise GateCheckError(f"cannot find block end after {start}: {end}")
    return text[start_index:end_index]


def check_agent_stream(text: str) -> None:
    require(
        text,
        "export interface AgentStreamResult",
        "stream invoke exposes structured result",
    )
    require(
        text,
        "let runtimeValidation: RuntimeValidationResult | undefined;",
        "stream stores validation until the stream ends",
    )
    require(
        text,
        "runtimeValidation = validation;",
        "stream captures validation event before returning",
    )
    require(
        text,
        "return { output: outputRef.current, savedPath, validation: runtimeValidation };",
        "stream returns savedPath and validation together",
    )


def check_agent_executor(text: str) -> None:
    saved_effect = lines_between(text, "if (savedPath) {", "}, [savedPath, onLog]);")
    forbid(saved_effect, "onSaved", "AgentExecutor must not call onSaved from savedPath effect")
    require(
        text,
        "const runInFlightRef = useRef(false);",
        "AgentExecutor has a synchronous in-flight guard",
    )
    require(
        text,
        "if (isRunning || runInFlightRef.current) {",
        "AgentExecutor blocks duplicate starts before React state settles",
    )
    require(
        text,
        "runInFlightRef.current = true;",
        "AgentExecutor marks a run in flight before invoking",
    )
    require(
        text,
        "runInFlightRef.current = false;",
        "AgentExecutor releases the in-flight guard after completion or failure",
    )
    require(
        text,
        "disabled={isRunning}",
        "AgentExecutor locks editable fields while running",
    )
    require(
        text,
        "disabled={materialLoading || isRunning}",
        "AgentExecutor locks material selection while running",
    )
    require(
        text,
        ".split(',')",
        "AgentExecutor supports multi-directory material categories",
    )
    require(
        text,
        "category === 'pipeline' || category.startsWith('pipeline/')",
        "AgentExecutor handles pipeline material categories consistently",
    )
    require(
        text,
        "disabled={isRunning ? false : !configReady || materialLoading}",
        "AgentExecutor keeps stop available while running and blocks starts while material lists load",
    )
    require(
        text,
        "aria-busy={isRunning}",
        "AgentExecutor exposes running state to the UI tree",
    )
    require(
        text,
        "当前任务执行中，参数已锁定。本次结果写入 runtime 并完成校验后才会接入下一步。",
        "AgentExecutor shows deterministic in-progress status",
    )
    require(
        text,
        "const runtimeValidation = result.validation;",
        "AgentExecutor uses final stream validation result",
    )
    require(
        text,
        "if (runtimeValidation?.valid !== false) {\n        onSaved?.(result.savedPath);\n      }",
        "AgentExecutor promotes savedPath only when validation did not fail",
    )
    require(
        text,
        "onComplete?.(result.output, runtimeValidation, runningStepId);",
        "AgentExecutor passes output, not the structured stream result, to pipeline completion",
    )


def check_production_workbench(page: str, workbench: str, model: str, approval_api: str) -> None:
    """Keep the seven-stage production screen bound to server approvals.

    The former /pipeline page is now a compatibility redirect.  The real
    production surface must not silently regress to browser-local approvals.
    """
    require(page, "getProductionStage", "production page resolves the requested stage")
    require(page, "<ProductionWorkbench", "production page renders the single production workspace")

    for stage_id in (
        "material-boundary",
        "topic-template",
        "content-package",
        "visual-assets",
        "draft-information",
        "publication-result",
        "weekly-review",
    ):
        require(model, f"id: '{stage_id}'", f"production model keeps {stage_id} in the seven-stage flow")
    for scope in (
        "topic_template",
        "content_package",
        "visual_assets",
        "draft_information",
        "publication_result",
    ):
        require(model, f"approvalScope: '{scope}'", f"production model binds {scope} to a server approval")

    require(
        workbench,
        "Browser storage is a convenience for form fields, never an approval authority.",
        "production workbench does not trust localStorage approvals",
    )
    require(
        workbench,
        "invalidateApprovalsFrom(toStoredDraft(saved.draft), 'topic-template')",
        "stored browser approvals are invalidated before the run is restored",
    )
    require(
        workbench,
        "fetch(`/api/production/flow?${new URLSearchParams({ runId })}`",
        "production workbench refreshes approval state from the server",
    )
    require(
        workbench,
        "if (!response.ok || !integrity || integrity.run_id !== runId) throw",
        "restored progress requires a successful response for the requested run",
    )
    require(
        workbench,
        "if (materialRunRef.current !== runId || !workbenchMountedRef.current) return {};",
        "a stale progress response cannot replace another open draft",
    )
    require(
        workbench,
        "setDraft((current) => restoreVerifiedProductionProgress(current, integrity, materialChangedRef.current));",
        "the workbench restores approvals through the verified runtime progress rules",
    )
    confirmation_route = require_any(
        workbench,
        ("fetch('/api/production/advance',", "fetch('/api/production/approval',"),
        "production workbench sends human confirmation to the server",
    )
    if confirmation_route == "fetch('/api/production/advance',":
        require(workbench, "stage: activeStage,", "production advance binds the current stage")
        require(workbench, "artifactPath,", "production advance binds the current artifact")
        require(workbench, "runId: draft.runId,", "production advance binds the current run")
        require(
            workbench,
            "if (!response.ok || data.advanced !== true)",
            "production advance blocks when the server has not approved the current artifact",
        )
    else:
        require(
            workbench,
            "body: JSON.stringify({ scope: stage.approvalScope, path: artifactPath, runId: draft.runId })",
            "production confirmation binds scope, artifact, and run together",
        )
        require(
            workbench,
            "if (!response.ok || data.approved !== true)",
            "production confirmation blocks when the server has not approved the current artifact",
        )
    require(workbench, "confirmationMode = 'server';", "server-confirmed stages are marked as server approvals")
    require(
        workbench,
        "visualWorkbench?.hasExplicitAssetSelection === true",
        "visual stage requires explicit per-asset adoption before confirmation",
    )

    require(approval_api, "const SCOPE_PATH_PATTERNS", "approval API limits paths by production phase")
    require(approval_api, "currentArtifactRun(scope, path)", "approval API resolves artifact ownership from runtime state")
    require(approval_api, "runOwnsCurrentArtifact(run, scope, path)", "approval API requires the current run artifact")
    require(approval_api, "requestedRunId !== run.run_id", "approval API rejects cross-run confirmations")
    require(approval_api, "approveRuntimeProductionArtifact(target.scope, target.path, target.runId,", "approval API writes a runtime-backed approval with the reviewed plan version")


def check_legacy_pipeline_redirect(text: str) -> None:
    require(
        text,
        "redirect('/production?stage=1');",
        "legacy pipeline URL redirects to the first production stage",
    )


def check_no_user_navigation_to_legacy_pipeline() -> None:
    """Legacy /pipeline may exist for bookmarks but must not be linked by the UI."""
    navigation_patterns = (
        re.compile(r'''href\s*=\s*["']/pipeline(?:[?#["'])'''),
        re.compile(r'''href\s*:\s*["']/pipeline(?:[?#["'])'''),
        re.compile(r'''(?:redirect|push|replace)\(\s*["']/pipeline(?:[?#["'])'''),
    )
    source_roots = (REPO_ROOT / "ui" / "app", REPO_ROOT / "ui" / "components")
    for root in source_roots:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {".ts", ".tsx"} or path == LEGACY_PIPELINE_PAGE:
                continue
            text = read(path)
            if any(pattern.search(text) for pattern in navigation_patterns):
                raise GateCheckError(
                    f"user navigation still links legacy /pipeline: {path.relative_to(REPO_ROOT)}"
                )


def check_result_preview(text: str) -> None:
    require(
        text,
        "function escapeHtml",
        "ResultPreview escapes user and LLM text before HTML preview rendering",
    )
    require(
        text,
        "escapeHtml(content)",
        "ResultPreview does not inject raw content into preview HTML",
    )
    forbid(
        text,
        "__html: isHtml ? content : renderMarkdown(content)",
        "ResultPreview must not inject raw HTML or unsanitized markdown",
    )


def check_visual_workbench_contract(text: str) -> None:
    require(text, 'data-testid="visual-workbench"', "visual workbench is addressable for delivery smoke")
    require(text, 'data-testid="visual-revision-input"', "visual workbench exposes bounded revision input")
    require(text, 'data-testid="visual-version-comparison"', "visual workbench compares cover, evidence and CTA assets")
    require(text, "qualityLabel(asset.quality)", "visual workbench displays asset quality state")
    require(text, 'if (quality === "pass") return "可以使用";', "visual workbench translates passing quality for customers")
    require(text, "onClick={() => void adoptSuite(suite)}", "visual workbench has an explicit suite-selection command")
    require(text, '"选择这套成品"', "visual workbench labels the explicit suite-selection command")
    require(text, "state.hasExplicitSelection", "visual workbench keeps an unselected first render adoptable")
    require(text, 'outputLink(path, "view")', "visual workbench opens HTML outputs using the rendered-preview link mode")
    require(read(OUTPUT_LINKS), "if (mode === 'view') return `${href}?raw=1`;", "rendered-preview links request the raw document rather than JSON")
    require(text, "xl:grid-cols-[minmax(0,1fr)_270px]", "visual workbench keeps controls beside previews at 1440px")
    require(text, "order-1 space-y", "visual workbench puts revision controls before the mobile asset gallery")
    forbid(text, "contentEditable", "visual workbench must not expose direct text editing")
    forbid(text, 'type="color"', "visual workbench must not expose a color picker")
    forbid(text, "draggable=", "visual workbench must not expose a drag canvas")
    forbid(text, "resize-y", "visual workbench must not expose textarea resize drag handles")


def check_visual_workbench_loader(text: str) -> None:
    require(text, "safeResolve(PROJECT_DIR, relativePath)", "visual workbench resolves project files safely")
    require(text, "isVisualPathForSlug", "visual workbench filters cross-slug output paths")
    require(text, "selected-revision.json", "visual workbench reads explicit selected revision pointer")
    require(text, "if (!recipes.length && currentIndex)", "recipe-less legacy visual outputs are not selectable")
    require(text, "comparisonRole", "visual workbench loader builds bounded comparison roles")
    require(text, "rightLabel: 'candidate'", "visual workbench labels a ready child as a candidate, not a previous revision")
    require(text, "output.renderer !== 'local'", "visual workbench rejects non-local rendered outputs")
    require(text, "output.recipe_path !== recipePath", "visual workbench rejects stale output recipe provenance")
    require(text, "isVisualOutputPathForRevision", "visual workbench binds output files to one revision directory")
    require(text, "bytes.length <= 0", "visual workbench rejects missing or empty output files")


def check_visual_revision_routes(revise: str, select: str, request_contract: str) -> None:
    require(revise, "assertVisualRevisionClientShape(raw)", "revision API applies the bounded client request contract")
    require(request_contract, "new Set(['slug', 'request', 'targetAssetIds', 'baseRevisionId', 'wechatLayout'])", "revision API accepts only bounded revision and layout inputs, never client paths or recipe patches")
    require(request_contract, "!VISUAL_REVISION_CLIENT_KEYS.has(key)", "revision API rejects unexpected client keys")
    require(request_contract, "parseWechatLayout(raw.wechatLayout)", "revision API validates nested layout options through the strict parser")
    require(request_contract, "Object.keys(record).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(record, key))", "layout objects reject unknown and missing keys")
    require(request_contract, "exactObject(value, ['theme', 'source_package_sha256', 'refinement'], ['theme', 'source_package_sha256']", "layout inputs accept only a theme, source hash and bounded refinement")
    require(request_contract, "exactObject(layout.refinement, ['profile', 'title_lines', 'heading_blocks'], ['profile', 'title_lines', 'heading_blocks']", "layout refinements cannot carry CSS, HTML, paths or patches")
    require(request_contract, "exactObject(value, ['block_index', 'text_sha256', 'segments'], ['block_index', 'text_sha256', 'segments']", "heading refinements accept only source anchors and text segments")
    require(request_contract, "refinement.profile !== 'title-spacing-v1'", "layout refinements use only the approved fixed profile")
    require(revise, "if (!/^r\\d{3,}$/.test(baseRevisionId)) return null;", "revision identifiers cannot supply file paths")
    require(revise, "readSelectedRecipe(slug, baseRevisionId)", "revision API resolves the bounded revision server-side")
    require(revise, "selected-revision.json", "revision API reads the selected recipe pointer server-side")
    require(revise, "withProjectWriteLock(`visual-revise:${slug}`", "revision API serializes immutable requests")
    require(revise, "nextRequestPath", "revision API chooses request path server-side")
    require(revise, "visual-revision-request.schema.json", "revision API loads the canonical request schema")
    require(revise, "validateRevisionRecord(record)", "revision API validates the server-built request before writing")
    require(request_contract, "视觉修订不接受配方路径、JSON patch 或客户端操作列表", "revision API rejects raw recipe path and patch inputs")
    require(select, "selected-revision.json", "adopt API writes explicit selection pointer")
    require(
        select,
        "validateVisualRevisionArtifacts(slug, revisionId)",
        "adopt API independently revalidates rendered quality-passing revision artifacts",
    )


def check_publication_route_contracts(legacy: str, drafts: str, results: str) -> None:
    """Keep public sending behind the approved local draft queue.

    The direct endpoint remains only as a deliberate 410 migration signal;
    draft preparation and human-confirmed result evidence are the writable
    publication path.
    """
    require(legacy, "Retired direct-publish endpoint.", "legacy direct-publish route is explicitly retired")
    require(legacy, "status: 410", "legacy direct-publish route returns Gone")
    require(legacy, "migration: '/api/publish/results'", "legacy direct-publish route exposes result migration")
    forbid(legacy, "writeRuntimeOutput(", "retired direct-publish route must not write runtime artifacts")

    require(drafts, "getRuntimeProductionApproval('content_package', packagePath, run.run_id)", "draft queue requires final-content approval")
    require(drafts, "getRuntimeProductionApproval('visual_assets', visualManifestPath, run.run_id)", "draft queue requires visual approval")
    require(drafts, "createDraftQueue({", "draft queue is created from approved platform deliverables")
    require(drafts, "registerRuntimePhaseArtifact('draft_information', queuePath, run.run_id)", "draft queue registers the draft-information artifact")

    require(results, "if (!humanConfirmed)", "publication results require an explicit human confirmation")
    require(results, "getRuntimeProductionApproval('draft_information', queuePath, queue.run_id)", "publication results require draft-information approval")
    require(results, "recordPublicationResult(queue, ledger, {", "publication results bind evidence to a draft job")
    require(results, "registerRuntimePhaseArtifact('publication_result', ledgerPath, mutation.queue.run_id)", "publication results register the local ledger")


def check_removed_video_runtime_surface(sources: dict[str, str]) -> None:
    forbidden = {
        "pipeline registry": ["'douyin-script':", "runtimeSteps: ['write', 'douyin', 'xhs']", "pipeline/douyin/"],
        "skill loader": ["'douyin-script':", "case 'douyin-script':", "pipeline/douyin"],
        "agent invoke API": ["case 'douyin-script':", "pipeline/douyin/"],
        "publish API": ["pipeline/douyin/", "step: 'write' | 'xhs' | 'douyin'"],
        "quality API": ["pipeline/douyin/", "douyin: 'douyin'"],
        "delivery API": ["runtimeStep: 'douyin'", "'douyin-script'"],
        "pipeline page": ['type RuntimeDraftStep = "write" | "xhs" | "douyin"', 'skill = "douyin-script"', "pipeline/douyin/"],
    }
    for label, needles in forbidden.items():
        text = sources[label]
        for needle in needles:
            forbid(text, needle, f"{label} must not expose removed video runtime: {needle}")


def check_delivery_presentation_boundary(sources: dict[str, str], client_error_copy: str) -> None:
    """Keep customer-visible research and delivery language vendor-neutral.

    Internal routes, environment variables, and integration types may retain
    their implementation names. This check is deliberately scoped to the UI
    surfaces shown to a delivery recipient.
    """
    for label in ("research settings", "production workbench"):
        require(
            sources[label],
            "displayClientError",
            f"{label} routes backend errors through the shared customer-safe sanitizer",
        )
    require(
        client_error_copy,
        ".replace(/TikOmni\\s+(?:Token|API Key)/gi, '平台数据密钥')",
        "shared error sanitizer removes vendor credential names",
    )
    require(
        client_error_copy,
        ".replace(/TikOmni/gi, '平台数据服务')",
        "shared error sanitizer removes vendor names",
    )

    customer_visible_regressions = (
        "TikOmni 市场研究",
        "TikOmni API Key",
        "TikOmni 三平台",
        "TikOmni 公开证据",
        "公众号官方接口",
        "公众号已授权浏览器",
        "小红书已授权浏览器",
        "授权处理中",
    )
    for label, text in sources.items():
        # This literal is an input to the required backend-error sanitizer,
        # not a customer-visible label. Keep all other occurrences blocked.
        visible_text = text
        for sanitizer_literal in (
            ".replaceAll('TikOmni Token', '公开内容服务访问凭证')",
            ".replaceAll('TikOmni API Key', '公开内容服务访问凭证')",
            ".replaceAll('TikOmni', '公开内容服务')",
        ):
            visible_text = visible_text.replace(sanitizer_literal, "")
        for phrase in customer_visible_regressions:
            forbid(visible_text, phrase, f"{label} exposes customer-facing phrase: {phrase}")

    require(sources["research settings"], "平台数据服务", "research settings uses a neutral research label")
    require(
        sources["research settings"],
        "平台数据密钥",
        "research settings uses a neutral credential label",
    )
    require(
        sources["publication bridge settings"],
        "本机已登录浏览器",
        "publication bridge describes local browser state without affiliation claims",
    )
    require(
        sources["production stage panel"],
        "正在连接平台",
        "production stage describes connection state without authorization claims",
    )

    benchmark_page = sources["benchmark advisor"]
    for snippet in ("<img", "<video", "<iframe", "primaryText.slice", "text.slice"):
        forbid(benchmark_page, snippet, f"benchmark advisor must not rehost third-party media or excerpts: {snippet}")
    require(
        benchmark_page,
        "完整视频和原文请从“打开来源”查看；分析不会复制原内容",
        "benchmark advisor states its non-republication boundary",
    )


def main() -> int:
    checks = [
        ("useAgentStream", check_agent_stream, read(AGENT_STREAM)),
        ("AgentExecutor", check_agent_executor, read(AGENT_EXECUTOR)),
        ("legacy pipeline redirect", check_legacy_pipeline_redirect, read(LEGACY_PIPELINE_PAGE)),
        ("ResultPreview safe rendering", check_result_preview, read(RESULT_PREVIEW)),
        ("visual workbench surface", check_visual_workbench_contract, read(VISUAL_WORKBENCH)),
        ("visual workbench loader", check_visual_workbench_loader, read(VISUAL_WORKBENCH_LOADER)),
    ]
    failures: list[str] = []
    for label, check, text in checks:
        try:
            check(text)
            print(f"PASS {label}")
        except GateCheckError as exc:
            failures.append(f"{label}: {exc}")
            print(f"FAIL {label}: {exc}")

    try:
        check_production_workbench(
            read(PRODUCTION_PAGE),
            read(PRODUCTION_WORKBENCH),
            read(PRODUCTION_MODEL),
            read(PRODUCTION_APPROVAL_API),
        )
        print("PASS production runtime gates")
    except GateCheckError as exc:
        failures.append(f"production runtime gates: {exc}")
        print(f"FAIL production runtime gates: {exc}")

    try:
        check_no_user_navigation_to_legacy_pipeline()
        print("PASS legacy pipeline navigation")
    except GateCheckError as exc:
        failures.append(f"legacy pipeline navigation: {exc}")
        print(f"FAIL legacy pipeline navigation: {exc}")

    try:
        check_visual_revision_routes(read(VISUAL_REVISE_API), read(VISUAL_SELECT_API), read(VISUAL_REVISION_REQUEST))
        print("PASS visual revision routes")
    except GateCheckError as exc:
        failures.append(f"visual revision routes: {exc}")
        print(f"FAIL visual revision routes: {exc}")

    try:
        check_publication_route_contracts(
            read(PUBLISH_API),
            read(PUBLISH_DRAFTS_API),
            read(PUBLISH_RESULTS_API),
        )
        print("PASS publication route contracts")
    except GateCheckError as exc:
        failures.append(f"publication route contracts: {exc}")
        print(f"FAIL publication route contracts: {exc}")

    try:
        check_removed_video_runtime_surface({
            "pipeline registry": read(PIPELINE_REGISTRY),
            "skill loader": read(SKILL_LOADER),
            "agent invoke API": read(AGENT_INVOKE_API),
            "publish API": read(PUBLISH_API),
            "quality API": read(QUALITY_API),
            "delivery API": read(DELIVERY_API),
            "pipeline page": read(LEGACY_PIPELINE_PAGE),
        })
        print("PASS removed video runtime UI surface")
    except GateCheckError as exc:
        failures.append(f"removed video runtime UI surface: {exc}")
        print(f"FAIL removed video runtime UI surface: {exc}")

    try:
        check_delivery_presentation_boundary(
            {
                "research settings": read(TIKOMNI_SETTINGS),
                "production workbench": read(PRODUCTION_WORKBENCH),
                "publication bridge settings": read(PUBLICATION_BRIDGE_SETTINGS),
                "production stage panel": read(PRODUCTION_STAGE_PANEL),
                "benchmark advisor": read(BENCHMARK_ADVISOR_PAGE),
                "delivery page": read(DELIVERY_PAGE),
                "publication desk": read(PUBLICATION_DESK_PAGE),
                "weekly review": read(WEEKLY_REVIEW_PAGE),
            },
            read(CLIENT_ERROR_COPY),
        )
        print("PASS delivery presentation boundary")
    except GateCheckError as exc:
        failures.append(f"delivery presentation boundary: {exc}")
        print(f"FAIL delivery presentation boundary: {exc}")

    if failures:
        print(f"FAIL ui runtime gates: {len(failures)} failure(s)")
        return 1
    print("PASS ui runtime gates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
