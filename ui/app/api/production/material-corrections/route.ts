import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { assertJsonInputSize, MAX_AGENT_PAYLOAD_BYTES, InputLimitError } from '@/lib/input-limits';
import { saveMaterialCorrection } from '@/lib/material-corrections';
import { MaterialAnalysisInputError, MaterialAnalysisStaleError } from '@/lib/material-analysis';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { WriteLockError } from '@/lib/write-guard';

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json();
    assertJsonInputSize(body, '素材修正', MAX_AGENT_PAYLOAD_BYTES);
    if (!body || typeof body.runId !== 'string' || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(body.runId)
      || typeof body.id !== 'string' || !/^correction_[a-f0-9]{32}$/.test(body.id)
      || typeof body.expectedFingerprint !== 'string') throw new InputLimitError('请重新读取本期整理结果后再修改。');
    return NextResponse.json({ ok: true, ...await saveMaterialCorrection(body) });
  } catch (error) {
    return userFacingErrorResponse(error, { error: '修正尚未保存。填写的内容还在，请核对后重试。', code: 'material_correction_failed', status: error instanceof MaterialAnalysisStaleError || error instanceof WriteLockError ? 409 : error instanceof InputLimitError || error instanceof MaterialAnalysisInputError ? 400 : 500 });
  }
}
