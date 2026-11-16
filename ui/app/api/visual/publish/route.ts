import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { isMd2WechatThemeId } from '@/lib/brand-templates';
import { ensureProjectInitialized } from '@/lib/project-init';
import { KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths, safeResolve } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { runsForPipelinePath, type RuntimeRun } from '@/lib/runtime-run-resolver';
import { assertFrozenRuntimeTikomniMarketSnapshot, getRuntimeProductionApproval } from '@/lib/runtime-writer';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';

export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);
const VISUAL_PUBLISH_SCRIPT = contentRuntimeToolPath('visual_publish.py');
const VISUAL_PUBLISH_TIMEOUT_MS = 10 * 60 * 1000;
const VISUAL_PUBLISH_MAX_BUFFER = 12 * 1024 * 1024;
const PACKAGE_PREFIX = 'pipeline/package/';

class VisualPublishPreconditionError extends Error {}

type VisualPublishResult = {
  status?: string;
  slug?: string;
  index_path?: string;
  outputs?: unknown[];
  quality_summary?: unknown;
  visual_record?: unknown;
  immutable?: boolean;
  recipe_path?: string;
  art_directions?: unknown[];
};

type VisualPreferences = {
  mode: 'ai_enhanced' | 'stable';
  directionCount: 2;
  providerPolicy: 'auto';
};

function parseVisualPreferences(value: unknown, defaultMode: VisualPreferences['mode'] = 'stable'): VisualPreferences {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const mode = assertOptionalTextInput(record.mode, '视觉模式', MAX_SHORT_TEXT_BYTES)?.trim() || defaultMode;
  if (mode !== 'ai_enhanced' && mode !== 'stable') throw new InputLimitError('视觉模式不受支持');
  const directionCount = record.directionCount ?? record.direction_count ?? 2;
  if (directionCount !== 2) throw new InputLimitError('当前固定生成两套视觉方向');
  const providerPolicy = assertOptionalTextInput(record.providerPolicy ?? record.provider_policy, '视觉服务策略', MAX_SHORT_TEXT_BYTES)?.trim() || 'auto';
  if (providerPolicy !== 'auto') throw new InputLimitError('当前仅支持自动选择视觉服务');
  return { mode: 'stable', directionCount: 2, providerPolicy: 'auto' };
}

function isSafeProjectRelativePath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function isInsideProject(projectRealPath: string, candidateRealPath: string): boolean {
  const relation = relative(projectRealPath, candidateRealPath);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

function packagePathFromBody(body: Record<string, unknown>): string {
  const packagePath = assertOptionalTextInput(body.packagePath, '内容包路径', MAX_SHORT_TEXT_BYTES);
  const packageAlias = assertOptionalTextInput(body.package, '内容包路径', MAX_SHORT_TEXT_BYTES);
  if (packagePath !== undefined && packageAlias !== undefined && packagePath !== packageAlias) {
    throw new InputLimitError('内容包路径参数不一致');
  }

  const value = packagePath ?? packageAlias;
  if (value === undefined) throw new InputLimitError('内容包路径不能为空');
  if (!isSafeProjectRelativePath(value) || !value.startsWith(PACKAGE_PREFIX) || !value.endsWith('.md')) {
    throw new InputLimitError('内容包路径必须是 pipeline/package 下的 Markdown 文件');
  }
  return value;
}

async function assertExistingPackagePath(packagePath: string): Promise<void> {
  const absolutePath = safeResolve(PROJECT_DIR, packagePath);
  if (!absolutePath) throw new InputLimitError('内容包路径必须位于当前项目目录内');

  try {
    const file = await lstat(absolutePath);
    if (file.isSymbolicLink() || !file.isFile()) {
      throw new InputLimitError('内容包必须是项目内的普通 Markdown 文件');
    }
    const [projectRealPath, packageRealPath] = await Promise.all([
      realpath(PROJECT_DIR),
      realpath(absolutePath),
    ]);
    if (!isInsideProject(projectRealPath, packageRealPath)) {
      throw new InputLimitError('内容包的真实路径必须位于当前项目目录内');
    }
  } catch (error) {
    if (error instanceof InputLimitError) throw error;
    throw new InputLimitError('内容包文件不存在或无法安全读取');
  }
}

async function assertApprovedCurrentPackage(
  packagePath: string,
  slug: string,
): Promise<RuntimeRun & { run_id: string; slug: string }> {
  const runs = await runsForPipelinePath(packagePath, 'package');
  const run = runs.find((candidate): candidate is RuntimeRun & { run_id: string; slug: string } => (
    Boolean(candidate.run_id && candidate.slug)
    && candidate.slug === slug
    && candidate.steps?.package?.latest === packagePath
  ));
  if (!run) {
    throw new VisualPublishPreconditionError('视觉资产必须基于当前任务已登记的内容包生成。');
  }
  const approval = await getRuntimeProductionApproval('content_package', packagePath, run.run_id);
  if (!approval.approved) {
    throw new VisualPublishPreconditionError('最终内容尚未完成负责人确认，不能生成视觉资产。');
  }
  return run;
}

function parseVisualPublishResult(stdout: string): VisualPublishResult {
  try {
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('not an object');
    return result as VisualPublishResult;
  } catch {
    throw new Error('视觉渲染器返回了无效 JSON');
  }
}

function visualPublishError(error: unknown): Error {
  const maybe = error as { stderr?: string | Buffer; message?: string };
  const stderr = String(maybe.stderr || '').trim();
  if (stderr) {
    try {
      const result: unknown = JSON.parse(stderr);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const message = (result as { error?: unknown }).error;
        if (typeof message === 'string' && message.trim()) return new Error(message);
      }
    } catch {
      // Python may include non-JSON diagnostics when its process cannot start.
    }
  }
  return new Error(stderr || maybe.message || '视觉渲染失败');
}

async function runVisualPublish(
  slug: string,
  packagePath: string,
  visualTemplate: string,
  preferences: VisualPreferences,
  selectedDirection: 'direction-a' | 'direction-b',
  previewOnly: boolean,
  regenerate: boolean,
): Promise<VisualPublishResult> {
  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), [
      VISUAL_PUBLISH_SCRIPT,
      '--project', PROJECT_DIR,
      'generate',
      '--slug', slug,
      '--package', packagePath,
      '--renderer', 'local',
      '--layout-style', visualTemplate,
      '--visual-mode', preferences.mode,
      '--direction-count', String(preferences.directionCount),
      '--provider-policy', preferences.providerPolicy,
      '--selected-direction', selectedDirection,
      ...(previewOnly ? ['--preview-only'] : []),
      ...(regenerate ? ['--new-revision'] : []),
    ], {
      cwd: PROJECT_DIR,
      encoding: 'utf-8',
      timeout: VISUAL_PUBLISH_TIMEOUT_MS,
      maxBuffer: VISUAL_PUBLISH_MAX_BUFFER,
    });
    return parseVisualPublishResult(String(stdout || ''));
  } catch (error) {
    if (error instanceof Error && error.message === '视觉渲染器返回了无效 JSON') throw error;
    throw visualPublishError(error);
  }
}

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '视觉渲染请求', MAX_AGENT_PAYLOAD_BYTES);

    const slug = assertTextInput(body.slug, 'Slug', MAX_SHORT_TEXT_BYTES).trim();
    if (!/^[a-z0-9\u4e00-\u9fff-]{1,50}$/i.test(slug)) throw new InputLimitError('Slug 格式不正确');
    const packagePath = packagePathFromBody(body);
    await assertExistingPackagePath(packagePath);
    const packageRun = await assertApprovedCurrentPackage(packagePath, slug);
    const authoritativePreferences: VisualPreferences = {
      mode: 'stable',
      directionCount: 2,
      providerPolicy: 'auto',
    };
    const requestedPreferences = parseVisualPreferences(
      body.visualPreferences ?? body.visual_preferences,
      authoritativePreferences.mode,
    );
    if (requestedPreferences.mode !== authoritativePreferences.mode) {
      throw new VisualPublishPreconditionError('视觉生成方式已经变化，请刷新后重试。');
    }
    const requestedDirection = assertOptionalTextInput(body.selectedDirection ?? body.selected_direction, '视觉方向', MAX_SHORT_TEXT_BYTES)?.trim() || 'direction-a';
    if (requestedDirection !== 'direction-a' && requestedDirection !== 'direction-b') {
      throw new InputLimitError('视觉方向不受支持');
    }
    const previewOnly = body.previewOnly === true || body.preview_only === true;
    if (body.regenerate !== undefined && typeof body.regenerate !== 'boolean') throw new InputLimitError('重新排版选项必须为布尔值');
    try {
      await assertFrozenRuntimeTikomniMarketSnapshot('visual', packageRun.run_id);
    } catch (error) {
      throw new VisualPublishPreconditionError(
        error instanceof Error ? error.message : '选题与模板的 TikOmni 研究快照未通过校验。',
      );
    }
    const rawTemplate = packageRun.visual_template;
    const visualTemplate = isMd2WechatThemeId(rawTemplate)
      ? rawTemplate
      : 'default';

    const result = await withProjectWriteLock(
      `visual-publish:${slug}`,
      () => runVisualPublish(slug, packagePath, visualTemplate, authoritativePreferences, requestedDirection, previewOnly, body.regenerate === true),
      { timeoutMs: 30_000, staleMs: VISUAL_PUBLISH_TIMEOUT_MS + 60_000 },
    );
    return NextResponse.json(redactLocalPaths(result));
  } catch (error) {
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof VisualPublishPreconditionError || error instanceof WriteLockError
        ? 409
        : 500;
    const cause = error instanceof VisualPublishPreconditionError
      ? new KnownUserFacingError({
        error: '请先确认最新内容和选题资料，再生成完整发布件。',
        code: 'visual_publish_precondition_failed',
      }, { status: 409, detail: error })
      : error;
    return userFacingErrorResponse(cause, {
      error: '暂时无法生成完整发布件，请重试。',
      code: 'visual_publish_failed',
      status,
    });
  }
}
