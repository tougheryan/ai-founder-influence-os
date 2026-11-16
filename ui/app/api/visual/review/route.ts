import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';

export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);
const VISUAL_PUBLISH_SCRIPT = contentRuntimeToolPath('visual_publish.py');

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, 'AI 视觉复核请求', MAX_AGENT_PAYLOAD_BYTES);
    const slug = assertTextInput(body.slug, '视觉任务', MAX_SHORT_TEXT_BYTES).trim();
    const revisionId = assertTextInput(body.revisionId, '视觉版本', MAX_SHORT_TEXT_BYTES).trim();
    const assetId = assertTextInput(body.assetId, '图片编号', MAX_SHORT_TEXT_BYTES).trim();
    const outputSha256 = assertTextInput(body.outputSha256, '图片校验值', MAX_SHORT_TEXT_BYTES).trim().toLowerCase();
    if (!/^[a-z0-9\u4e00-\u9fff-]{1,50}$/i.test(slug)) throw new InputLimitError('视觉任务格式不正确');
    if (!/^r\d{3,}$/.test(revisionId)) throw new InputLimitError('视觉版本格式不正确');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(assetId)) throw new InputLimitError('图片编号格式不正确');
    if (!/^[a-f0-9]{64}$/.test(outputSha256)) throw new InputLimitError('图片校验值格式不正确');
    if (body.confirmNoUnexpectedText !== true || body.confirmConceptBoundary !== true) {
      throw new InputLimitError('请先确认图片没有模型生成的意外文字，并且没有伪装成事实证据');
    }

    const { stdout } = await withProjectWriteLock(`visual-review:${slug}:${revisionId}:${assetId}`, () => execFileAsync(
      runtimePythonBinary(),
      [
        VISUAL_PUBLISH_SCRIPT,
        '--project', PROJECT_DIR,
        'review-ai-raster',
        '--slug', slug,
        '--revision', revisionId,
        '--asset', assetId,
        '--output-sha256', outputSha256,
        '--confirm-no-text',
        '--confirm-concept-boundary',
      ],
      { cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    ));
    return NextResponse.json(redactLocalPaths(JSON.parse(String(stdout || '{}'))));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法保存图片复核结果，请重试。',
      code: 'visual_ai_review_failed',
      status: error instanceof InputLimitError ? 400 : error instanceof WriteLockError ? 409 : 500,
    });
  }
}
