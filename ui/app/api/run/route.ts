import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { resolveConfiguredBrandTemplate, BrandTemplateResolutionError } from '@/lib/brand-template-config';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths, toProjectRelativePath } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { assertOptionalTextInput, InputLimitError, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { clearTikOmniContentLinkEvidence } from '@/lib/tikomni-content-link-evidence';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';

const execFileAsync = promisify(execFile);
const RUNTIME_SCRIPT = contentRuntimeToolPath('content_runtime.py');

type RunPayload = {
  topic?: string;
  slug?: string;
  runId?: string;
  templateId?: string;
  projectId?: string;
  platforms?: ProductionPlatform[];
  entryMode?: 'standard' | 'material_analysis';
};

function visualPreferences(value: unknown): { mode: 'ai_enhanced' | 'stable'; directionCount: 2; providerPolicy: 'auto' } {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const mode = assertOptionalTextInput(record.mode, '视觉模式', MAX_SHORT_TEXT_BYTES)?.trim() || 'stable';
  if (mode !== 'ai_enhanced' && mode !== 'stable') throw new InputLimitError('视觉模式不受支持。');
  const directionCount = record.directionCount ?? record.direction_count ?? 2;
  if (directionCount !== 2) throw new InputLimitError('当前固定生成两套视觉方向。');
  const providerPolicy = assertOptionalTextInput(record.providerPolicy ?? record.provider_policy, '视觉服务策略', MAX_SHORT_TEXT_BYTES)?.trim() || 'auto';
  if (providerPolicy !== 'auto') throw new InputLimitError('当前仅支持自动选择视觉服务。');
  return { mode: 'stable', directionCount: 2, providerPolicy: 'auto' };
}

const PRODUCTION_PLATFORMS = ['wechat', 'xhs', 'shipinhao'] as const;
type ProductionPlatform = (typeof PRODUCTION_PLATFORMS)[number];
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function toRelativePath(path: string | undefined | null): string {
  return toProjectRelativePath(path);
}

function projectId(value: unknown): string {
  return cleanupProjectId(value) || 'default';
}

function cleanupProjectId(value: unknown): string {
  const parsed = assertOptionalTextInput(value, '项目 ID', MAX_SHORT_TEXT_BYTES)?.trim().toLowerCase() || '';
  if (!parsed) return '';
  if (!PROJECT_ID_RE.test(parsed)) {
    throw new InputLimitError('项目 ID 只能包含小写字母、数字、连字符和下划线。');
  }
  return parsed;
}

function entryMode(value: unknown): RunPayload['entryMode'] {
  const parsed = assertOptionalTextInput(value, '任务入口模式', MAX_SHORT_TEXT_BYTES)?.trim();
  if (!parsed || parsed === 'standard') return 'standard';
  if (parsed === 'material_analysis') return 'material_analysis';
  throw new InputLimitError('任务入口模式不受支持。');
}

function selectedPlatforms(value: unknown): ProductionPlatform[] {
  if (value === undefined || value === null) return [...PRODUCTION_PLATFORMS];
  if (!Array.isArray(value)) throw new InputLimitError('目标平台必须是一个列表。');
  const selected = value.map((item) => assertOptionalTextInput(item, '目标平台', MAX_SHORT_TEXT_BYTES)?.trim() || '');
  const invalid = selected.filter((item) => !PRODUCTION_PLATFORMS.includes(item as ProductionPlatform));
  if (invalid.length > 0) throw new InputLimitError('目前只支持公众号、小红书和视频号。');
  const unique = [...new Set(selected)] as ProductionPlatform[];
  if (unique.length === 0) throw new InputLimitError('请至少选择一个目标平台。');
  return PRODUCTION_PLATFORMS.filter((platform) => unique.includes(platform));
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const body: RunPayload = {
      topic: assertOptionalTextInput(rawBody.topic, 'Run 主题', MAX_SHORT_TEXT_BYTES),
      slug: assertOptionalTextInput(rawBody.slug, 'Run slug', MAX_SHORT_TEXT_BYTES),
      runId: assertOptionalTextInput(rawBody.runId, 'Run ID', MAX_SHORT_TEXT_BYTES),
      templateId: assertOptionalTextInput(rawBody.templateId ?? rawBody.visualTemplate ?? rawBody.template, '品牌排版模板', MAX_SHORT_TEXT_BYTES),
      projectId: projectId(rawBody.projectId),
      platforms: selectedPlatforms(rawBody.platforms),
      entryMode: entryMode(rawBody.entryMode ?? rawBody.entry_mode),
    };
    const suppliedTemplateIds = [rawBody.templateId, rawBody.visualTemplate, rawBody.template]
      .filter((value) => value !== undefined)
      .map((value) => assertOptionalTextInput(value, '品牌排版模板', MAX_SHORT_TEXT_BYTES)?.trim() || '');
    if (new Set(suppliedTemplateIds).size > 1) {
      throw new InputLimitError('品牌排版模板参数不一致。');
    }
    // A material-only run deliberately starts before the operator chooses a
    // brand template. The runtime still needs a neutral renderer value, but it
    // is overwritten at the later topic/template confirmation checkpoint.
    const deferredTemplateSelection = body.entryMode === 'material_analysis' && !body.templateId?.trim();
    const template = deferredTemplateSelection ? null : await resolveConfiguredBrandTemplate(body.templateId?.trim());
    const platforms = (body.platforms || [...PRODUCTION_PLATFORMS]).join(',');
    const args = [
      RUNTIME_SCRIPT,
      '--project',
      PROJECT_DIR,
      'run-create',
      '--topic',
      body.topic || body.slug || (body.entryMode === 'material_analysis' ? '素材分析任务' : 'Echo Founder 内容任务'),
      '--platforms',
      platforms,
      '--visual-template',
      template?.layoutStyle || 'default',
      '--project-id',
      body.projectId || 'default',
    ];
    if (body.slug) args.push('--slug', body.slug);
    if (body.runId) args.push('--run-id', body.runId);

    const { stdout } = await withProjectWriteLock(`run-create:${body.runId || body.slug || body.topic || 'active'}`, () => execFileAsync(runtimePythonBinary(), args, {
        cwd: PROJECT_DIR,
        maxBuffer: 1024 * 1024 * 4,
        timeout: 15000,
      }));
    const run = JSON.parse(stdout) as { run_file?: string };
    return NextResponse.json(redactLocalPaths({
      ...run,
      run_file: toRelativePath(run.run_file),
      brand_template: template,
      template_selection: deferredTemplateSelection ? 'deferred' : 'resolved',
      entry_mode: body.entryMode,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof BrandTemplateResolutionError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    const cause = error instanceof BrandTemplateResolutionError
      ? new KnownUserFacingError({
        error: '这个排版模板已停用或不存在，请重新选择。',
        code: 'brand_template_unavailable',
      }, { status: 400, detail: error })
      : error;
    return userFacingErrorResponse(cause, {
      error: '暂时无法创建本期任务，请重试。',
      code: 'production_run_create_failed',
      status,
    });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const runId = assertOptionalTextInput(rawBody.runId ?? rawBody.run_id, 'Run ID', MAX_SHORT_TEXT_BYTES)?.trim();
    if (!runId) throw new InputLimitError('请选择要更新的平台任务。');
    if (rawBody.visualPreferences !== undefined || rawBody.visual_preferences !== undefined) {
      const preferences = visualPreferences(rawBody.visualPreferences ?? rawBody.visual_preferences);
      const { stdout } = await withProjectWriteLock(`run-visual-preferences:${runId}`, () => execFileAsync(runtimePythonBinary(), [
        RUNTIME_SCRIPT,
        '--project', PROJECT_DIR,
        'run-visual-preferences-set',
        '--run-id', runId,
        '--mode', preferences.mode,
        '--direction-count', String(preferences.directionCount),
        '--provider-policy', preferences.providerPolicy,
      ], {
        cwd: PROJECT_DIR,
        maxBuffer: 1024 * 1024 * 4,
        timeout: 15_000,
      }));
      return NextResponse.json(redactLocalPaths(JSON.parse(stdout)));
    }
    const platforms = selectedPlatforms(rawBody.platforms);
    const args = [
      RUNTIME_SCRIPT,
      '--project', PROJECT_DIR,
      'run-platforms-set',
      '--run-id', runId,
      '--platforms', platforms.join(','),
    ];
    if (rawBody.confirm === true) args.push('--confirm');
    const { stdout } = await withProjectWriteLock(`run-platforms:${runId}`, () => execFileAsync(runtimePythonBinary(), args, {
      cwd: PROJECT_DIR,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 15_000,
    }));
    return NextResponse.json(redactLocalPaths(JSON.parse(stdout)));
  } catch (error) {
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法保存本期平台，请重试。',
      code: 'production_platform_selection_failed',
      status,
    });
  }
}

/**
 * A deliberate "start a new period" action archives only the temporary run.
 * Its artifacts remain locally recoverable, while it can no longer be reused
 * by a retry or silently become another window's active production task.
 */
export async function DELETE(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const search = new URL(req.url).searchParams;
    const runId = assertOptionalTextInput(search.get('runId'), 'Run ID', MAX_SHORT_TEXT_BYTES)?.trim();
    if (!runId) throw new InputLimitError('请选择要归档的本期任务。');
    const { stdout } = await withProjectWriteLock(`run-archive:${runId}`, () => execFileAsync(runtimePythonBinary(), [
      RUNTIME_SCRIPT,
      '--project', PROJECT_DIR,
      'run-archive',
      '--run-id', runId,
    ], {
      cwd: PROJECT_DIR,
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    }));
    const run = JSON.parse(stdout) as { run_file?: string; project_id?: unknown };
    // New runtimes return this immutable run binding. The query fallback keeps
    // an already-installed older runtime cleanable during an explicit reset.
    const evidenceProjectId = cleanupProjectId(run.project_id) || cleanupProjectId(search.get('projectId'));
    let evidenceCleanup: 'cleared' | 'not_found' | 'skipped' | 'failed' = 'skipped';
    if (evidenceProjectId) {
      try {
        const result = await clearTikOmniContentLinkEvidence({ projectId: evidenceProjectId, runId });
        evidenceCleanup = result.removed ? 'cleared' : 'not_found';
      } catch {
        // The runtime archive has already committed. Do not misreport it as a
        // failed reset merely because a disposable local capture needs manual
        // cleanup later.
        evidenceCleanup = 'failed';
      }
    }
    return NextResponse.json(redactLocalPaths({
      ...run,
      run_file: toRelativePath(run.run_file),
      evidence_cleanup: evidenceCleanup,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法归档本期任务，请重试。',
      code: 'production_run_archive_failed',
      status,
    });
  }
}
