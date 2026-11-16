import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { readOutputFile } from '@/lib/output-files';
import { createLowEvidencePassagePlanReport } from '@/lib/public-research';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';

function assertPipelineSourcePath(path: string): void {
  if (!path.startsWith('pipeline/intake/') && !path.startsWith('pipeline/validate/')) {
    throw new InputLimitError('低证据通行方案只支持读取 pipeline/intake 或 pipeline/validate 产物');
  }
  if (path.includes('..') || path.includes('\\')) {
    throw new InputLimitError('低证据通行方案来源路径非法');
  }
}

function assertOptionalReadablePath(path: string | undefined, label: string, prefixes: string[]): void {
  if (!path) return;
  if (!prefixes.some((prefix) => path.startsWith(prefix))) {
    throw new InputLimitError(`${label}路径不在允许范围内`);
  }
  if (path.includes('..') || path.includes('\\')) {
    throw new InputLimitError(`${label}路径非法`);
  }
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
      explorationReportPath?: unknown;
      slug?: unknown;
      topic?: unknown;
      platforms?: unknown;
    };
    assertJsonInputSize(body, '低证据通行方案参数', MAX_AGENT_PAYLOAD_BYTES);

    const sourcePath = assertTextInput(body.sourcePath, '低证据通行方案来源路径', MAX_SHORT_TEXT_BYTES).trim();
    assertPipelineSourcePath(sourcePath);
    const validateReportPath = assertOptionalTextInput(body.validateReportPath, '立项报告路径', MAX_SHORT_TEXT_BYTES)?.trim();
    const researchReportPath = assertOptionalTextInput(body.researchReportPath, '公开补证报告路径', MAX_SHORT_TEXT_BYTES)?.trim();
    const explorationReportPath = assertOptionalTextInput(body.explorationReportPath, '预研角度报告路径', MAX_SHORT_TEXT_BYTES)?.trim();
    assertOptionalReadablePath(validateReportPath, '立项报告', ['pipeline/validate/']);
    assertOptionalReadablePath(researchReportPath, '公开补证报告', ['materials/research/']);
    assertOptionalReadablePath(explorationReportPath, '预研角度报告', ['materials/research/']);

    const slug = assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim() || 'passage-plan';
    const topic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim();
    const platforms = stringArray(body.platforms);
    const sourceContent = await readOutputFile(sourcePath);
    const validateContent = await readOptional(validateReportPath);
    const researchContent = await readOptional(researchReportPath);
    const explorationContent = await readOptional(explorationReportPath);
    const report = await createLowEvidencePassagePlanReport({
      sourcePath,
      sourceContent,
      slug,
      topic,
      platforms,
      validateReportPath,
      validateContent,
      researchReportPath,
      researchContent,
      explorationReportPath,
      explorationContent,
    });

    return NextResponse.json(redactLocalPaths({
      ok: true,
      path: report.path,
      status: report.status,
      recommendedRoute: report.recommendedRoute,
      languageWarnings: report.languageWarnings,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法生成资料补充方案，请重试。',
      code: 'research_passage_plan_failed',
      status,
    });
  }
}
