import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { readOutputFile } from '@/lib/output-files';
import { assertGeneratedResearchLanguage, buildRepairedAngleMarkdown } from '@/lib/public-research';
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
    .slice(0, 50) || 'angle-repair';
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
      validateReportPath?: unknown;
      researchReportPath?: unknown;
      slug?: unknown;
      topic?: unknown;
      platforms?: unknown;
    };
    assertJsonInputSize(body, '角度报告修复参数', MAX_AGENT_PAYLOAD_BYTES);

    const sourcePath = assertTextInput(body.sourcePath, '素材理解报告路径', MAX_SHORT_TEXT_BYTES).trim();
    const validateReportPath = assertTextInput(body.validateReportPath, '立项报告路径', MAX_SHORT_TEXT_BYTES).trim();
    const researchReportPath = assertOptionalTextInput(body.researchReportPath, '公开补证报告路径', MAX_SHORT_TEXT_BYTES)?.trim();
    assertReadablePath(sourcePath, '素材理解报告', ['pipeline/intake/']);
    assertReadablePath(validateReportPath, '立项报告', ['pipeline/validate/']);
    assertOptionalReadablePath(researchReportPath, '公开补证报告', ['materials/research/']);

    const slug = sanitizeSlug(assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim() || 'angle-repair');
    const topic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim();
    const platforms = stringArray(body.platforms);
    const sourceContent = await readOutputFile(sourcePath);
    const validateContent = await readOutputFile(validateReportPath);
    const researchContent = await readOptional(researchReportPath);
    const repaired = buildRepairedAngleMarkdown({
      sourceContent,
      validateReportPath,
      validateContent,
      researchReportPath,
      researchContent,
      topic,
      platforms,
    });
    const languageWarnings = assertGeneratedResearchLanguage(repaired.markdown, {
      label: '重新生成内容角度',
      href: '/production?stage=2',
    });

    const target = await resolveRuntimeWriteTarget({
      fallbackSlug: slug,
      sourcePaths: [{ path: validateReportPath, step: 'validate' }],
    });
    const path = await writeRuntimeOutput(
      'angle',
      target.slug || slug,
      repaired.markdown,
      `ui-repair:${validateReportPath}`,
      target.runId || undefined,
    );
    const validation = await validateRuntimeOutput('angle', path);

    return NextResponse.json(redactLocalPaths({
      ok: validation.valid,
      path,
      validation,
      title: repaired.title,
      platform: repaired.platform,
      angleCount: repaired.angleCount,
      languageWarnings,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法修改内容角度，请重试。',
      code: 'research_angle_repair_failed',
      status,
    });
  }
}
