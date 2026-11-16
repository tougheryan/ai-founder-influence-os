import { NextRequest, NextResponse } from 'next/server';
import {
  CreativeLibraryConflictError,
  CreativeLibraryError,
  createCreativeProposal,
  listCreativeProposals,
  resolveCreativeProposal,
  type CreativeProposalStatus,
  type CreativeProposalTarget,
} from '@/lib/creative-library';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type ProposalRequest = {
  action?: unknown;
  target?: unknown;
  reason?: unknown;
  source?: unknown;
  patch?: unknown;
  proposalId?: unknown;
};

function parseTarget(value: unknown): CreativeProposalTarget {
  const target = assertTextInput(value, '建议目标', MAX_SHORT_TEXT_BYTES).trim();
  if (target === 'profile' || target === 'rules') return target;
  throw new InputLimitError('建议目标不受支持。');
}

function parseStatus(value: string | null): CreativeProposalStatus | undefined {
  if (!value) return undefined;
  if (value === 'pending' || value === 'accepted' || value === 'rejected') return value;
  throw new InputLimitError('建议状态不受支持。');
}

function parseOptionalTarget(value: string | null): CreativeProposalTarget | undefined {
  if (!value) return undefined;
  if (value === 'profile' || value === 'rules') return value;
  throw new InputLimitError('建议目标不受支持。');
}

function parseAction(value: unknown): 'create' | 'accept' | 'reject' | 'edit' {
  const action = assertTextInput(value, '创作建议操作', MAX_SHORT_TEXT_BYTES).trim();
  if (action === 'create' || action === 'accept' || action === 'reject' || action === 'edit') return action;
  throw new InputLimitError('创作建议操作不受支持。');
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const target = parseOptionalTarget(req.nextUrl.searchParams.get('target'));
    const status = parseStatus(req.nextUrl.searchParams.get('status'));
    return NextResponse.json(redactLocalPaths(await listCreativeProposals({ target, status })));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取更新建议，请重试。',
      code: 'creative_proposals_read_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as ProposalRequest;
    assertJsonInputSize(body, '创作建议请求', MAX_AGENT_PAYLOAD_BYTES);
    const action = parseAction(body.action);
    if (action === 'create') {
      const proposal = await withProjectWriteLock(
        'creative-library:settings',
        () => createCreativeProposal({
          target: parseTarget(body.target),
          reason: body.reason,
          source: body.source,
          patch: body.patch,
        }),
      );
      const state = await listCreativeProposals();
      return NextResponse.json(redactLocalPaths({ ok: true, action, proposal, pending: state.pending }));
    }

    const result = await withProjectWriteLock(
      'creative-library:settings',
      () => resolveCreativeProposal({ action, proposalId: body.proposalId, ...(action === 'edit' ? { patch: body.patch } : {}) }),
    );
    return NextResponse.json(redactLocalPaths({ ok: true, action, ...result }));
  } catch (error) {
    const status = error instanceof CreativeLibraryConflictError ? 409 : error instanceof InputLimitError || error instanceof CreativeLibraryError
      ? 400
      : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法处理这条更新建议，请重试。',
      code: 'creative_proposal_update_failed',
      status,
    });
  }
}
