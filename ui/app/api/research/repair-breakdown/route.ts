import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { readOutputFile } from '@/lib/output-files';
import { assertGeneratedResearchLanguage, buildRepairedBreakdownMarkdown } from '@/lib/public-research';
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
    .slice(0, 50) || 'breakdown-repair';
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
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
      angleReportPath?: unknown;
      slug?: unknown;
      topic?: unknown;
      targetPlatform?: unknown;
      platforms?: unknown;
    };
    assertJsonInputSize(body, '内容拆解修复参数', MAX_AGENT_PAYLOAD_BYTES);

    const angleReportPath = assertTextInput(body.angleReportPath, '角度报告路径', MAX_SHORT_TEXT_BYTES).trim();
    const sourcePath = assertOptionalTextInput(body.sourcePath, '素材理解报告路径', MAX_SHORT_TEXT_BYTES)?.trim();
    assertReadablePath(angleReportPath, '角度报告', ['pipeline/angles/']);
    assertOptionalReadablePath(sourcePath, '素材理解报告', ['pipeline/intake/']);

    const slug = sanitizeSlug(assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim() || 'breakdown-repair');
    const topic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim();
    const targetPlatform = assertOptionalTextInput(body.targetPlatform, '目标阵地', MAX_SHORT_TEXT_BYTES)?.trim();
    const platforms = stringArray(body.platforms);
    const angleContent = await readOutputFile(angleReportPath);
    const sourceContent = await readOptional(sourcePath);
    const repaired = buildRepairedBreakdownMarkdown({
      sourcePath,
      sourceContent,
      angleReportPath,
      angleContent,
      targetPlatform,
      topic,
      platforms,
    });
    const languageWarnings = assertGeneratedResearchLanguage(repaired.markdown, {
      label: '重新生成文章提纲',
      href: '/production?stage=2',
    });

    const target = await resolveRuntimeWriteTarget({
      fallbackSlug: slug,
      sourcePaths: [{ path: angleReportPath, step: 'angle' }],
    });
    const path = await writeRuntimeOutput(
      'breakdown',
      target.slug || slug,
      repaired.markdown,
      `ui-repair:${angleReportPath}`,
      target.runId || undefined,
    );
    const validation = await validateRuntimeOutput('breakdown', path);

    return NextResponse.json(redactLocalPaths({
      ok: validation.valid,
      path,
      validation,
      title: repaired.title,
      selectedAngle: repaired.selectedAngle,
      platform: repaired.platform,
      languageWarnings,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法修改内容结构，请重试。',
      code: 'research_breakdown_repair_failed',
      status,
    });
  }
}
