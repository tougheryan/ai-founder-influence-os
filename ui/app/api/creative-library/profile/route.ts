import { NextRequest, NextResponse } from 'next/server';
import { readDraftPreferenceReview, saveDraftPreferences } from '@/lib/draft-preference-reuse';
import { assertCreativeVersion, CreativeLibraryConflictError, CreativeLibraryError, readCreativeProfile, saveCreativeProfile } from '@/lib/creative-library';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type ProfileRequest = {
  action?: unknown;
  expectedVersion?: unknown;
  runId?: unknown;
  inputFingerprint?: unknown;
  analysisFingerprint?: unknown;
  choices?: unknown;
  profile?: unknown;
};

function parseAction(value: unknown): 'initialize' | 'update' {
  const action = assertTextInput(value, '创作名片操作', MAX_SHORT_TEXT_BYTES).trim();
  if (action === 'initialize' || action === 'update') return action;
  throw new InputLimitError('创作名片操作不受支持。');
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const runId = req.nextUrl.searchParams.get('runId');
    if (runId !== null) return NextResponse.json(redactLocalPaths(await readDraftPreferenceReview(runId, req.nextUrl.searchParams.get('inputFingerprint') || '')), { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json(redactLocalPaths({ profile: await readCreativeProfile() }));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取账号资料，请重试。',
      code: 'creative_profile_read_failed',
      status: error instanceof CreativeLibraryConflictError ? 409 : error instanceof CreativeLibraryError ? 400 : 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as ProfileRequest;
    assertJsonInputSize(body, '创作名片请求', MAX_AGENT_PAYLOAD_BYTES);
    if (body.action === 'append-preferences') {
      const runId = assertTextInput(body.runId, '本篇标识', MAX_SHORT_TEXT_BYTES).trim();
      const inputFingerprint = assertTextInput(body.inputFingerprint, '素材版本', MAX_SHORT_TEXT_BYTES).trim();
      const profile = await withProjectWriteLock(`material-analysis:${runId}`, () => withProjectWriteLock('creative-library:settings', () => saveDraftPreferences({ runId, inputFingerprint, analysisFingerprint: body.analysisFingerprint, expectedVersion: body.expectedVersion, choices: body.choices })));
      return NextResponse.json(redactLocalPaths({ ok: true, profile }));
    }
    const action = parseAction(body.action);
    const profile = await withProjectWriteLock(
      'creative-library:settings',
      async () => {
        const current = await readCreativeProfile();
        assertCreativeVersion(body.expectedVersion, current.version);
        return saveCreativeProfile({ action, profile: body.profile, expectedVersion: current.version });
      },
    );
    return NextResponse.json(redactLocalPaths({ ok: true, action, profile }));
  } catch (error) {
    const status = error instanceof CreativeLibraryConflictError ? 409 : error instanceof InputLimitError || error instanceof CreativeLibraryError
      ? 400
      : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法保存账号资料，请重试。',
      code: 'creative_profile_save_failed',
      status,
    });
  }
}
