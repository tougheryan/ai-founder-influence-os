import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { readOutputFile } from '@/lib/output-files';
import { createPublicEvidenceReport } from '@/lib/public-research';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';

function assertResearchSourcePath(path: string): void {
  if (!path.startsWith('pipeline/intake/') && !path.startsWith('pipeline/validate/')) {
    throw new InputLimitError('公开补证只支持读取 pipeline/intake 或 pipeline/validate 产物');
  }
  if (path.includes('..') || path.includes('\\')) {
    throw new InputLimitError('公开补证来源路径非法');
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function researchMode(value: unknown): 'broad' | 'precision' {
  return value === 'broad' ? 'broad' : 'precision';
}

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as {
      sourcePath?: unknown;
      slug?: unknown;
      topic?: unknown;
      platforms?: unknown;
      mode?: unknown;
    };
    assertJsonInputSize(body, '公开补证参数', MAX_AGENT_PAYLOAD_BYTES);

    const sourcePath = assertTextInput(body.sourcePath, '公开补证来源路径', MAX_SHORT_TEXT_BYTES).trim();
    assertResearchSourcePath(sourcePath);
    const slug = assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim() || 'public-evidence';
    const topic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim();
    const platforms = stringArray(body.platforms);
    const mode = researchMode(body.mode);
    const sourceContent = await readOutputFile(sourcePath);
    const report = await createPublicEvidenceReport({
      sourcePath,
      sourceContent,
      slug,
      topic,
      platforms,
      mode,
    });

    return NextResponse.json(redactLocalPaths({
      ok: true,
      path: report.path,
      status: report.status,
      queries: report.queries,
      sources: report.sources,
      languageWarnings: report.languageWarnings,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法补充公开资料，请重试。',
      code: 'research_evidence_failed',
      status,
    });
  }
}
