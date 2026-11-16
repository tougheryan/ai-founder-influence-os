import { NextRequest, NextResponse } from 'next/server';
import { assertCreativeVersion, CreativeLibraryConflictError, CreativeLibraryError, readCreativeRules, saveCreativeRules } from '@/lib/creative-library';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type RulesRequest = {
  action?: unknown;
  expectedVersion?: unknown;
  items?: unknown;
};

function parseAction(value: unknown): 'initialize' | 'update' {
  const action = assertTextInput(value, '创作规则操作', MAX_SHORT_TEXT_BYTES).trim();
  if (action === 'initialize' || action === 'update') return action;
  throw new InputLimitError('创作规则操作不受支持。');
}

export async function GET() {
  try {
    await ensureProjectInitialized();
    return NextResponse.json(redactLocalPaths({ rules: await readCreativeRules() }));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取写作规则，请重试。',
      code: 'creative_rules_read_failed',
      status: 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as RulesRequest;
    assertJsonInputSize(body, '创作规则请求', MAX_AGENT_PAYLOAD_BYTES);
    const action = parseAction(body.action);
    const rules = await withProjectWriteLock(
      'creative-library:settings',
      async () => {
        const current = await readCreativeRules();
        assertCreativeVersion(body.expectedVersion, current.version);
        return saveCreativeRules({ action, items: body.items, expectedVersion: current.version });
      },
    );
    return NextResponse.json(redactLocalPaths({ ok: true, action, rules }));
  } catch (error) {
    const status = error instanceof CreativeLibraryConflictError ? 409 : error instanceof InputLimitError || error instanceof CreativeLibraryError
      ? 400
      : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法保存写作规则，请重试。',
      code: 'creative_rules_save_failed',
      status,
    });
  }
}
