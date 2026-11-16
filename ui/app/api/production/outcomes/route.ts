import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { listProductionOutcomes, readProductionOutcome, saveProductionOutcome, ProductionOutcomeError } from '@/lib/production-outcomes';
import { assertJsonInputSize, InputLimitError, MAX_AGENT_PAYLOAD_BYTES } from '@/lib/input-limits';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { WriteLockError } from '@/lib/write-guard';
import { OUTCOME_FILTERS, type OutcomeFilter } from '@/lib/production-outcome-types';

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const runId = req.nextUrl.searchParams.get('runId');
    const offset = req.nextUrl.searchParams.get('offset') || '0';
    if (!/^\d+$/.test(offset)) throw new ProductionOutcomeError('页码不正确。');
    const query = req.nextUrl.searchParams.get('query') || '';
    const filter = req.nextUrl.searchParams.get('filter') || 'all';
    if (query.length > 200 || !OUTCOME_FILTERS.some((item) => item.value === filter)) throw new ProductionOutcomeError('请使用不超过 200 字的关键词和有效的文章状态。');
    return NextResponse.json(runId ? { item: await readProductionOutcome(runId) } : await listProductionOutcomes(Number(offset), { query, filter: filter as OutcomeFilter }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return userFacingErrorResponse(error, { error: error instanceof ProductionOutcomeError ? error.message : '制作记录暂时无法读取，请重试。', code: 'production_outcomes_read_failed', status: error instanceof ProductionOutcomeError ? error.status : 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json();
    assertJsonInputSize(body, '制作记录', MAX_AGENT_PAYLOAD_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProductionOutcomeError('制作记录格式不正确。');
    return NextResponse.json({ note: await saveProductionOutcome(body) });
  } catch (error) {
    return userFacingErrorResponse(error, { error: error instanceof ProductionOutcomeError ? error.message : '制作记录没有保存成功，请重试。', code: 'production_outcomes_write_failed', status: error instanceof ProductionOutcomeError ? error.status : error instanceof WriteLockError ? 409 : error instanceof InputLimitError || error instanceof SyntaxError ? 400 : 500 });
  }
}
