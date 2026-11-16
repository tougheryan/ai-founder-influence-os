import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { readOutputFile } from '@/lib/output-files';
import { assertGeneratedResearchLanguage, buildRepairedVisualMarkdown } from '@/lib/public-research';
import { resolveRuntimeWriteTarget } from '@/lib/runtime-run-resolver';
import { validateRuntimeOutput, writeRuntimeOutput } from '@/lib/runtime-writer';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'visual-repair';
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
      sourcePath?: unknown;
      visualPlanPath?: unknown;
      slug?: unknown;
      topic?: unknown;
      targetPlatform?: unknown;
      imageType?: unknown;
    };
    assertJsonInputSize(body, '视觉计划修复参数', MAX_AGENT_PAYLOAD_BYTES);

    const sourcePath = assertTextInput(body.sourcePath, '源内容路径', MAX_SHORT_TEXT_BYTES).trim();
    const visualPlanPath = assertOptionalTextInput(body.visualPlanPath, '视觉计划路径', MAX_SHORT_TEXT_BYTES)?.trim();
    assertReadablePath(sourcePath, '源内容', ['pipeline/final/', 'pipeline/xhs/']);
    assertOptionalReadablePath(visualPlanPath, '视觉计划', ['pipeline/visual/']);

    const slug = sanitizeSlug(assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim() || 'visual-repair');
    const topic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim();
    const targetPlatform = assertOptionalTextInput(body.targetPlatform, '目标阵地', MAX_SHORT_TEXT_BYTES)?.trim();
    const imageType = assertOptionalTextInput(body.imageType, '视觉类型', MAX_SHORT_TEXT_BYTES)?.trim();
    const sourceContent = await readOutputFile(sourcePath);
    const visualContent = await readOptional(visualPlanPath);
    const repaired = buildRepairedVisualMarkdown({
      sourcePath,
      sourceContent,
      visualContent,
      topic,
      targetPlatform,
      imageType,
    });
    const languageWarnings = assertGeneratedResearchLanguage(repaired.markdown, {
      label: '重新生成配图方案',
      href: '/production?stage=4',
    });

    const target = await resolveRuntimeWriteTarget({
      fallbackSlug: slug,
      sourcePaths: [
        ...(visualPlanPath ? [{ path: visualPlanPath, step: 'visual' }] : []),
        { path: sourcePath },
      ],
    });
    const path = await writeRuntimeOutput(
      'visual',
      target.slug || slug,
      repaired.markdown,
      `ui-repair:${visualPlanPath || sourcePath}`,
      target.runId || undefined,
    );
    const validation = await validateRuntimeOutput('visual', path);

    return NextResponse.json(redactLocalPaths({
      ok: validation.valid,
      path,
      validation,
      title: repaired.title,
      platform: repaired.platform,
      assetCount: repaired.assetCount,
      languageWarnings,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法修改配图方案，请重试。',
      code: 'research_visual_repair_failed',
      status,
    });
  }
}
