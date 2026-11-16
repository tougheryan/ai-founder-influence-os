import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { BrandTemplateResolutionError, resolveConfiguredBrandTemplate } from '@/lib/brand-template-config';
import { ensureProjectInitialized } from '@/lib/project-init';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

const execFileAsync = promisify(execFile);
const RUNTIME_SCRIPT = contentRuntimeToolPath('content_runtime.py');

function parseRunId(value: unknown): string {
  const runId = assertTextInput(value, 'run ID', MAX_SHORT_TEXT_BYTES).trim();
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) {
    throw new InputLimitError('run ID 格式不正确。');
  }
  return runId;
}

function parseTemplateId(value: unknown): string {
  const template = assertTextInput(value, '品牌排版模板', MAX_SHORT_TEXT_BYTES).trim();
  return template;
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as Record<string, unknown>;
    assertJsonInputSize(body, '品牌排版模板参数', MAX_AGENT_PAYLOAD_BYTES);
    const runId = parseRunId(body.runId);
    const templateId = parseTemplateId(body.templateId ?? body.visualTemplate ?? body.template);
    const suppliedTemplateIds = [body.templateId, body.visualTemplate, body.template]
      .filter((value) => value !== undefined)
      .map((value) => parseTemplateId(value));
    if (new Set(suppliedTemplateIds).size > 1) {
      throw new InputLimitError('品牌排版模板参数不一致。');
    }
    const template = await resolveConfiguredBrandTemplate(templateId);
    const result = await withProjectWriteLock(`run-template:${runId}`, async () => {
      const { stdout } = await execFileAsync(runtimePythonBinary(), [
        RUNTIME_SCRIPT,
        '--project', PROJECT_DIR,
        'run-template-set',
        '--run-id', runId,
        '--visual-template', template.layoutStyle,
      ], {
        cwd: PROJECT_DIR,
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      });
      return JSON.parse(stdout) as Record<string, unknown>;
    });
    return NextResponse.json(redactLocalPaths({ ...result, brand_template: template }));
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof BrandTemplateResolutionError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法更新排版模板，请重试。',
      code: 'run_template_update_failed',
      status,
    });
  }
}
