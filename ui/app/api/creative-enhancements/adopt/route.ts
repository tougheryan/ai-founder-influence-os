import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { adoptCreativeEnhancement, CreativeEnhancementError } from '@/lib/creative-enhancements';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '创作增强采用参数', MAX_AGENT_PAYLOAD_BYTES);
    const result = await adoptCreativeEnhancement({
      runId: assertTextInput(body.runId, 'run ID', MAX_SHORT_TEXT_BYTES),
      projectId: assertTextInput(body.projectId, '项目 ID', MAX_SHORT_TEXT_BYTES),
      stage: assertTextInput(body.stage, '创作阶段', MAX_SHORT_TEXT_BYTES),
      tool: assertTextInput(body.tool, 'DBS 工具', MAX_SHORT_TEXT_BYTES),
      sourcePath: assertTextInput(body.sourcePath, 'DBS 输出路径', MAX_SHORT_TEXT_BYTES),
      adoptedText: assertTextInput(body.adoptedText, '采用结论', MAX_AGENT_PAYLOAD_BYTES),
    });
    return NextResponse.json(redactLocalPaths({ ok: true, ...result }));
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof CreativeEnhancementError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法使用这条建议，请重试。',
      code: 'creative_enhancement_adopt_failed',
      status,
    });
  }
}
