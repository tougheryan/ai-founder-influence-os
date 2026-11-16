import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { readOutputFile } from '@/lib/output-files';
import { assertGeneratedResearchLanguage, buildRepairedDraftMarkdown, type RepairedDraftStep } from '@/lib/public-research';
import { resolveRuntimeWriteTarget } from '@/lib/runtime-run-resolver';
import { validateRuntimeOutput, writeRuntimeOutput } from '@/lib/runtime-writer';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';

const DRAFT_STEP_PREFIXES: Record<RepairedDraftStep, string[]> = {
  write: ['pipeline/final/'],
  xhs: ['pipeline/xhs/'],
};

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'draft-repair';
}

function assertReadablePath(path: string, label: string, prefixes: string[]): void {
  if (!prefixes.some((prefix) => path.startsWith(prefix))) {
    throw new InputLimitError(`${label}路径不在允许范围内`);
  }
  if (path.includes('..') || path.includes('\\')) {
    throw new InputLimitError(`${label}路径非法`);
  }
}

function assertOptionalReadablePath(path: string | undefined, label: string, prefixes: string[]): void {
  if (!path) return;
  assertReadablePath(path, label, prefixes);
}

function parseDraftStep(value: unknown): RepairedDraftStep {
  if (value === 'write' || value === 'xhs') return value;
  throw new InputLimitError('草稿类型必须是 write 或 xhs');
}

async function readOptional(path: string | undefined): Promise<string> {
  if (!path) return '';
  try {
    return await readOutputFile(path);
  } catch {
    return '';
  }
}

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as {
      draftStep?: unknown;
      draftPath?: unknown;
      breakdownPath?: unknown;
      slug?: unknown;
      topic?: unknown;
      targetPlatform?: unknown;
    };
    assertJsonInputSize(body, '成稿修复参数', MAX_AGENT_PAYLOAD_BYTES);

    const draftStep = parseDraftStep(body.draftStep);
    const draftPath = assertOptionalTextInput(body.draftPath, '草稿路径', MAX_SHORT_TEXT_BYTES)?.trim();
    const breakdownPath = assertTextInput(body.breakdownPath, '内容拆解方案路径', MAX_SHORT_TEXT_BYTES).trim();
    assertOptionalReadablePath(draftPath, '草稿', DRAFT_STEP_PREFIXES[draftStep]);
    assertReadablePath(breakdownPath, '内容拆解方案', ['pipeline/breakdown/']);

    const slug = sanitizeSlug(assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim() || 'draft-repair');
    const topic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim();
    const targetPlatform = assertOptionalTextInput(body.targetPlatform, '目标阵地', MAX_SHORT_TEXT_BYTES)?.trim();
    const draftContent = await readOptional(draftPath);
    const breakdownContent = await readOutputFile(breakdownPath);
    const repaired = buildRepairedDraftMarkdown({
      draftStep,
      draftContent,
      breakdownPath,
      breakdownContent,
      topic,
      targetPlatform,
    });
    const languageWarnings = assertGeneratedResearchLanguage(repaired.markdown, {
      label: '重新生成成稿',
      href: '/production?stage=3',
    });

    const target = await resolveRuntimeWriteTarget({
      fallbackSlug: slug,
      sourcePaths: [
        ...(draftPath ? [{ path: draftPath, step: draftStep }] : []),
        { path: breakdownPath, step: 'breakdown' },
      ],
    });
    const path = await writeRuntimeOutput(
      draftStep,
      target.slug || slug,
      repaired.markdown,
      `ui-repair:${draftPath || breakdownPath}`,
      target.runId || undefined,
    );
    const validation = await validateRuntimeOutput(draftStep, path);

    return NextResponse.json(redactLocalPaths({
      ok: validation.valid,
      path,
      validation,
      title: repaired.title,
      step: repaired.step,
      platform: repaired.platform,
      languageWarnings,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法修改成稿，请重试。',
      code: 'research_draft_repair_failed',
      status,
    });
  }
}
