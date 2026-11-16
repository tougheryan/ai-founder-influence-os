import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import {
  expectedUserFacingErrorResponse,
  KnownUserFacingError,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';
import { writeOutputFile } from '@/lib/output-files';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { runsForPipelinePath, type RuntimeRun } from '@/lib/runtime-run-resolver';
import { validateRuntimeOutput } from '@/lib/runtime-writer';
import { hostedGatewayConnection } from '@/lib/hosted-gateway';
import { HostedMarketResearchError, requestHostedMarketResearch } from '@/lib/hosted-market-research';
import {
  assertMaterialAnalysisCurrent,
  assertMaterialReadyForResearch,
  getMaterialAnalysisContext,
} from '@/lib/material-analysis';
import { materialDirectionFor } from '@/lib/material-direction';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { inspectGeneratedLanguage, type GeneratedLanguageFinding } from '@/lib/product-voice';

const execFileAsync = promisify(execFile);
const REPORT_SCRIPT = contentRuntimeToolPath('market_signal_report.py');
// All selected sources start concurrently, but a real TikOmni keyword request
// needs enough time to complete its process startup and response parsing.
// This is still a hard gate: a slow or unavailable source returns diagnostics
// and leaves only that platform lane blocked when another lane succeeds.
const LIVE_RESEARCH_TIMEOUT_MS = 65_000;

function assertIntakePath(path: string): void {
  if (!path.startsWith('pipeline/intake/') || path.includes('..') || path.includes('\\')) {
    throw new InputLimitError('爆款抓取与对标只支持当前 pipeline/intake 素材报告');
  }
}

async function currentBoundRunForIntake(
  sourcePath: string,
  runId: string,
): Promise<RuntimeRun & { run_id: string; slug: string }> {
  const sourceRuns = await runsForPipelinePath(sourcePath, 'intake');
  const boundRun = sourceRuns.find((run): run is RuntimeRun & { run_id: string; slug: string } => (
    run.run_id === runId
    && typeof run.slug === 'string'
    && Boolean(run.slug.trim())
    && run.steps?.intake?.latest === sourcePath
  ));
  if (!boundRun) {
    throw new InputLimitError('爆款抓取与对标必须绑定当前 run 的最新 intake 素材，不能跨任务复用');
  }
  if (boundRun.status === 'archived') {
    throw new InputLimitError('当前 run 已归档，不能继续进行 TikOmni 研究。');
  }
  const slug = boundRun.slug.trim();
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,80}$/.test(slug)) {
    throw new InputLimitError('当前 run 的 slug 不符合研究产物命名规则。');
  }
  return { ...boundRun, slug };
}

const DEFAULT_TIKOMNI_PLATFORMS = ['wechat_mp', 'xiaohongshu', 'wechat_channels'] as const;
const PRODUCTION_TO_RESEARCH_PLATFORM: Record<string, string> = {
  wechat: 'wechat_mp',
  xhs: 'xiaohongshu',
  shipinhao: 'wechat_channels',
};
const PLATFORM_LABELS: Record<string, string> = {
  wechat_mp: '公众号',
  xiaohongshu: '小红书',
  wechat_channels: '视频号',
  all: '全部平台',
};

type MaterialResearchBinding = {
  inputFingerprint: string;
  analysisInputFingerprint: string;
  materialTypeId: string;
  structureId: string;
};

type MarketPlatformCheck = {
  status?: unknown;
  sample_count?: unknown;
};

function marketEvidenceBlockers(report: {
  sample_count?: number;
  platform_checks?: Record<string, unknown>;
}, requiredPlatforms: readonly string[]): Array<{ code: string; platform: string; message: string }> {
  const checks = report.platform_checks || {};
  const blockers: Array<{ code: string; platform: string; message: string }> = [];
  let readyLaneCount = 0;
  for (const platform of requiredPlatforms) {
    const rawCheck = checks[platform];
    const check = rawCheck && typeof rawCheck === 'object' && !Array.isArray(rawCheck)
      ? rawCheck as MarketPlatformCheck
      : {};
    const sampleCount = Number(check.sample_count);
    if (check.status === 'available' && Number.isSafeInteger(sampleCount) && sampleCount >= 1) readyLaneCount += 1;
  }
  const totalSamples = Number(report.sample_count);
  if (readyLaneCount === 0 || !Number.isSafeInteger(totalSamples) || totalSamples < 1) {
    blockers.push({
      code: 'selected_platform_evidence_insufficient',
      platform: 'all',
      message: '已选平台都没有取得可用内容，暂时不能生成主题。',
    });
  }
  return blockers;
}

type ChildProcessFailure = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
};

function isChildProcessFailure(error: unknown): error is ChildProcessFailure {
  if (!(error instanceof Error)) return false;
  const failure = error as ChildProcessFailure;
  return error.message.startsWith('Command failed:')
    || failure.killed === true
    || Boolean(failure.signal)
    || failure.code === 'ETIMEDOUT'
    || failure.code === 'ENOENT';
}

function tikOmniExecutionBlockedResponse(error: ChildProcessFailure): NextResponse {
  const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
  const reason = timedOut
    ? '平台样本更新超时。请检查网络和平台数据设置后重试。'
    : '平台样本更新未完成。请检查平台数据设置后重试。';
  const code = timedOut ? 'research_timeout' : 'research_execution_failed';
  const cause = new KnownUserFacingError({ error: reason, code }, { status: 424, detail: error });

  return userFacingErrorResponse(cause, {
    error: reason,
    code,
    status: 424,
    extra: {
      ok: false,
      blocked: true,
      status: 'blocked',
      signalStatus: 'blocked',
      queries: [],
      blockers: [{ code, platform: 'all', message: reason }],
      operationOutcome: 'unknown',
    },
    legacyMessageField: 'message',
  });
}

function publicResearchBlockers(value: unknown): Array<{ code: string; platform: string; message: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const code = typeof row.code === 'string' ? row.code : 'platform_check_failed';
    const platform = typeof row.platform === 'string' ? row.platform : 'all';
    const label = PLATFORM_LABELS[platform] || '该平台';
    const message = code === 'query_missing'
      ? '素材中还没有可用的检索方向。请补充本期讨论的行业或具体问题，重新整理素材后再试。'
      : code === 'platform_evidence_insufficient'
      ? `${label}没有取得可用内容。`
      : code === 'cross_platform_evidence_insufficient'
        ? '已选平台的可用内容不足，暂时不能生成主题。'
        : `${label}暂时无法更新。`;
    return { code, platform, message };
  });
}

function blockedResearchMessage(blockers: Array<{ code: string; platform: string; message: string }>): string {
  const missingQuery = blockers.find((blocker) => blocker.code === 'query_missing');
  if (missingQuery) return missingQuery.message;
  if (blockers.some((blocker) => blocker.code === 'generated_language_blocked')) {
    return '平台返回的公开内容暂时无法安全整理，请重新获取。';
  }
  const failedPlatforms = Array.from(new Set(
    blockers
      .map((blocker) => blocker.platform)
      .filter((platform) => platform && platform !== 'all'),
  ));
  if (failedPlatforms.length) {
    const labels = failedPlatforms.map((platform) => PLATFORM_LABELS[platform] || '该平台');
    return `${labels.join('、')}暂时无法更新，请检查对应平台的数据权限或稍后重试。`;
  }
  return '已选平台的公开内容暂时没有准备好，请稍后重试。';
}

function publicPlatformChecks(
  value: unknown,
  requiredPlatforms: readonly string[],
): Record<string, { status: string; sample_count: number }> {
  const checks = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(requiredPlatforms.map((platform) => {
    const row = checks[platform] && typeof checks[platform] === 'object' && !Array.isArray(checks[platform])
      ? checks[platform] as Record<string, unknown>
      : {};
    const sampleCount = Number(row.sample_count);
    return [platform, {
      status: row.status === 'available' ? 'available' : 'unavailable',
      sample_count: Number.isSafeInteger(sampleCount) && sampleCount > 0 ? sampleCount : 0,
    }];
  }));
}

function readyResearchPlatforms(value: unknown, requiredPlatforms: readonly string[]): string[] {
  const checks = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return requiredPlatforms.filter((platform) => {
    const row = checks[platform] && typeof checks[platform] === 'object' && !Array.isArray(checks[platform])
      ? checks[platform] as Record<string, unknown>
      : {};
    const sampleCount = Number(row.sample_count);
    return row.status === 'available' && Number.isSafeInteger(sampleCount) && sampleCount >= 1;
  });
}

/**
 * The market endpoint is callable without the workbench, so it must not rely
 * on the client having already stopped at the material-direction checkpoint.
 */
async function requireCurrentMaterialResearchBinding(runId: string): Promise<MaterialResearchBinding> {
  let context;
  try {
    context = await getMaterialAnalysisContext(runId);
  } catch (error) {
    throw new InputLimitError(error instanceof Error ? error.message : '当前 run 的素材分析不可读取。');
  }
  if (!context) {
    throw new InputLimitError('当前 run 没有可用的本期素材分析，请回到素材输入重新分析。');
  }

  try {
    assertMaterialAnalysisCurrent(context);
    const recommendation = context.analysis;
    const selection = context.selection || (recommendation ? {
      materialTypeId: recommendation.recommendedTypeId,
      structureId: recommendation.recommendedStructureId,
    } : null);
    if (!selection || !materialDirectionFor(selection.materialTypeId, selection.structureId)) {
      throw new InputLimitError('系统没有得到可用的素材判断，请重新整理素材。');
    }
    await assertMaterialReadyForResearch(context.input);
    return {
      inputFingerprint: context.inputFingerprint,
      analysisInputFingerprint: context.analysisInputFingerprint,
      materialTypeId: selection.materialTypeId,
      structureId: selection.structureId,
    };
  } catch (error) {
    throw new InputLimitError(error instanceof Error ? error.message : '本期素材尚未满足 TikOmni 研究条件。');
  }
}

function sameMaterialResearchBinding(left: MaterialResearchBinding, right: MaterialResearchBinding): boolean {
  return left.inputFingerprint === right.inputFingerprint
    && left.analysisInputFingerprint === right.analysisInputFingerprint
    && left.materialTypeId === right.materialTypeId
    && left.structureId === right.structureId;
}

function parseHostedQueries(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('本地检索词生成结果格式异常。');
  }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const queries = Array.isArray(record.queries) ? record.queries : [];
  const valid = queries
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item, index, values) => item.length >= 2 && item.length <= 80 && values.indexOf(item) === index)
    .slice(0, 3);
  if (!valid.length) throw new InputLimitError('无法从本期素材生成可执行的 TikOmni 检索词。');
  return valid;
}

async function hostedMarketSignalReport({
  sourcePath,
  topic,
  runId,
  gatewayUrl,
  gatewaySession,
  researchPublicKey,
  researchKeyId,
  platforms,
}: {
  sourcePath: string;
  topic: string;
  runId: string;
  gatewayUrl: string;
  gatewaySession: string;
  researchPublicKey: string;
  researchKeyId: string;
  platforms: readonly string[];
}) {
  // Keep raw materials on this device. The only data sent to the hosted
  // research service is the small local-derived keyword list below.
  const derived = await execFileAsync(runtimePythonBinary(), [
    REPORT_SCRIPT,
    '--project', PROJECT_DIR,
    '--source', sourcePath,
    '--run-id', runId,
    '--derive-query-context',
  ], {
    cwd: PROJECT_DIR,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  const queries = parseHostedQueries(derived.stdout);
  const envelope = await requestHostedMarketResearch({
    gatewayUrl,
    sessionToken: gatewaySession,
    researchPublicKey,
    researchKeyId,
    queries,
    platforms: [...platforms],
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'aifios-hosted-market-'));
  const envelopePath = join(temporaryDirectory, 'research-envelope.json');
  try {
    await writeFile(envelopePath, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    const { stdout } = await execFileAsync(runtimePythonBinary(), [
      REPORT_SCRIPT,
      '--project', PROJECT_DIR,
      '--source', sourcePath,
      '--topic', topic,
      '--platforms', platforms.join(','),
      '--run-id', runId,
      '--hosted-envelope', envelopePath,
    ], {
      cwd: PROJECT_DIR,
      maxBuffer: 1024 * 1024 * 4,
      timeout: LIVE_RESEARCH_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as {
      sourcePath?: unknown;
      slug?: unknown;
      topic?: unknown;
      platforms?: unknown;
      runId?: unknown;
    };
    assertJsonInputSize(body, '爆款抓取与对标参数', MAX_AGENT_PAYLOAD_BYTES);
    const sourcePath = assertTextInput(body.sourcePath, '素材理解报告路径', MAX_SHORT_TEXT_BYTES).trim();
    assertIntakePath(sourcePath);
    const requestedSlug = assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim() || '';
    const requestedTopic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim() || '';
    const runId = assertTextInput(body.runId, '当前 runtime run ID', MAX_SHORT_TEXT_BYTES).trim();
    // Keep validating a legacy client field if sent, but do not allow it to
    // weaken the mandatory TikOmni source contract.
    if (Array.isArray(body.platforms)) {
      body.platforms.forEach((platform) => assertOptionalTextInput(platform, 'TikOmni 平台', MAX_SHORT_TEXT_BYTES));
    }
    const boundRun = await currentBoundRunForIntake(sourcePath, runId);
    const selectedProductionPlatforms = boundRun.selected_platforms?.length
      ? boundRun.selected_platforms
      : boundRun.target_platforms?.length
        ? boundRun.target_platforms
        : ['wechat', 'xhs', 'shipinhao'];
    const selectedResearchPlatforms = DEFAULT_TIKOMNI_PLATFORMS.filter((platform) => (
      selectedProductionPlatforms.some((selected) => PRODUCTION_TO_RESEARCH_PLATFORM[selected] === platform)
    ));
    if (selectedResearchPlatforms.length === 0) {
      throw new InputLimitError('当前任务没有可研究的目标平台。');
    }
    const slug = boundRun.slug;
    if (requestedSlug && requestedSlug !== slug) {
      throw new InputLimitError('研究产物 slug 必须由当前 run 决定，不能跨 run 写入其他研究报告。');
    }
    const topic = requestedTopic || slug;
    const intakeValidation = await validateRuntimeOutput('intake', sourcePath);
    if (!intakeValidation.valid) {
      throw new InputLimitError('素材理解报告未通过 runtime 校验，不能进入 TikOmni 研究。请重新生成本期素材理解报告。');
    }
    const materialBinding = await requireCurrentMaterialResearchBinding(runId);
    const outputPath = `materials/research/${slug}-market-signal.md`;
    const hosted = await hostedGatewayConnection();
    const researchHosted = hosted.saved.connectionMode === 'hosted' && Boolean(hosted.gatewayUrl);

    const result = await withProjectWriteLock(`market-signal:${slug}`, async () => {
      await currentBoundRunForIntake(sourcePath, runId);
      const report = researchHosted
        ? await hostedMarketSignalReport({
          sourcePath,
          topic,
          runId,
          gatewayUrl: hosted.gatewayUrl,
          gatewaySession: hosted.saved.gatewaySession || '',
          researchPublicKey: hosted.researchPublicKey,
          researchKeyId: hosted.researchKeyId,
          platforms: selectedResearchPlatforms,
        })
        : JSON.parse((await execFileAsync(runtimePythonBinary(), [
          REPORT_SCRIPT,
          '--project',
          PROJECT_DIR,
          '--source',
          sourcePath,
          '--topic',
          topic,
          '--platforms',
          selectedResearchPlatforms.join(','),
          '--run-id',
          runId,
        ], {
          cwd: PROJECT_DIR,
          maxBuffer: 1024 * 1024 * 4,
          timeout: LIVE_RESEARCH_TIMEOUT_MS,
        })).stdout) as Record<string, unknown>;
      const currentMaterialBinding = await requireCurrentMaterialResearchBinding(runId);
      if (!sameMaterialResearchBinding(materialBinding, currentMaterialBinding)) {
        throw new InputLimitError('本期素材快照或表达方向在 TikOmni 研究期间已变化，请重新分析并确认后再研究。');
      }
      const currentRun = await currentBoundRunForIntake(sourcePath, runId);
      if (currentRun.slug !== slug) {
        throw new InputLimitError('当前 run 在研究期间已变化，研究报告未写入。');
      }
      const normalizedReport = report as {
        markdown?: string;
        status?: string;
        signal_status?: string;
        queries?: string[];
        sample_count?: number;
        realtime_count?: number;
        local_count?: number;
        snapshot_path?: string;
        snapshot_sha256?: string;
        blockers?: { code?: string; message?: string; platform?: string }[];
        platform_checks?: Record<string, unknown>;
        ready_platforms?: string[];
        platform_lanes?: Record<string, unknown>;
        partial?: boolean;
        language_warnings?: GeneratedLanguageFinding[];
      };
      if (normalizedReport.status === 'blocked') return normalizedReport;
      const evidenceBlockers = marketEvidenceBlockers(normalizedReport, selectedResearchPlatforms);
      if (evidenceBlockers.length) {
        return {
          ...normalizedReport,
          status: 'blocked',
          signal_status: 'blocked',
          blockers: evidenceBlockers,
        };
      }
      if (!normalizedReport.markdown || !normalizedReport.snapshot_path || !normalizedReport.snapshot_sha256) {
        throw new Error('爆款抓取与对标未生成可验证的 TikOmni 实时快照');
      }
      const languageReview = inspectGeneratedLanguage(normalizedReport.markdown);
      if (languageReview.blocking.length) {
        throw new KnownUserFacingError({
          error: '平台分析中还有未处理的占位内容或敏感信息，尚未保存。请重新获取平台数据。',
          code: 'market_research_language_blocked',
          action: { label: '重新获取平台数据', href: '/production?stage=2' },
        }, {
          status: 422,
          detail: { blockingCodes: languageReview.blocking.map((item) => item.code) },
        });
      }
      normalizedReport.language_warnings = languageReview.warnings;
      await writeOutputFile(outputPath, normalizedReport.markdown);
      const writtenRun = await currentBoundRunForIntake(sourcePath, runId);
      if (writtenRun.slug !== slug) {
        throw new InputLimitError('当前 run 在研究报告写入后发生变化，该报告不能进入立项。');
      }
      return normalizedReport;
    });

    if (result.status === 'blocked') {
      const blockers = publicResearchBlockers(result.blockers);
      const message = blockedResearchMessage(blockers);
      return expectedUserFacingErrorResponse({
        error: message,
        code: blockers.some((blocker) => blocker.code === 'query_missing') ? 'research_query_missing' : 'research_platforms_incomplete',
        status: 424,
        extra: {
          ok: false,
          blocked: true,
          status: 'blocked',
          signalStatus: 'blocked',
          queries: result.queries || [],
          sampleCount: 0,
          realtimeCount: 0,
          localCount: 0,
          requiredPlatforms: selectedResearchPlatforms,
          blockers,
          platformChecks: publicPlatformChecks(result.platform_checks, selectedResearchPlatforms),
          // The provider returned a complete negative result. There is no
          // successful artifact to reconcile, but an explicit operator retry is
          // safe to offer instead of misclassifying this as an unknown outcome.
          operationOutcome: 'known_blocked',
        },
        legacyMessageField: 'message',
      });
    }

    const readyPlatforms = Array.isArray(result.ready_platforms) && result.ready_platforms.length
      ? result.ready_platforms
      : readyResearchPlatforms(result.platform_checks, selectedResearchPlatforms);
    return NextResponse.json(redactLocalPaths({
      ok: true,
      warning: false,
      creatorMode: false,
      path: outputPath,
      status: result.status || 'review_required',
      signalStatus: result.signal_status || 'unknown',
      queries: result.queries || [],
      sampleCount: result.sample_count || 0,
      realtimeCount: result.realtime_count || 0,
      localCount: 0,
      requiredPlatforms: selectedResearchPlatforms,
      readyPlatforms,
      platformLanes: result.platform_lanes || {},
      platformChecks: publicPlatformChecks(result.platform_checks, selectedResearchPlatforms),
      partial: Boolean(result.partial) || readyPlatforms.length !== selectedResearchPlatforms.length,
      snapshotPath: result.snapshot_path || '',
      snapshotSha256: result.snapshot_sha256 || '',
      languageWarnings: result.language_warnings || [],
    }));
  } catch (error) {
    if (isChildProcessFailure(error)) {
      return tikOmniExecutionBlockedResponse(error);
    }
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : error instanceof HostedMarketResearchError
          ? error.status
          : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法更新平台样本，请检查设置后重试。',
      code: 'market_research_failed',
      status,
      action: { label: '打开设置', href: '/settings' },
      extra: {
        operationOutcome: error instanceof InputLimitError || error instanceof WriteLockError
          ? 'known_blocked'
          : 'unknown',
      },
    });
  }
}
