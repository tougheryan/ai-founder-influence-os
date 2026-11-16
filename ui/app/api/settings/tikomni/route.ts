import { NextRequest, NextResponse } from 'next/server';
import {
  readTikOmniSettingsStatus,
  removeTikOmniApiToken,
  saveTikOmniApiToken,
  saveWechatPublicAccountGhid,
  TikOmniSettingsError,
} from '@/lib/tikomni-settings';
import { ensureProjectInitialized } from '@/lib/project-init';
import {
  assertJsonInputSize,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type TikOmniSettingsAction = 'save_token' | 'remove_token' | 'save_wechat_ghid';

function parseAction(value: unknown): TikOmniSettingsAction {
  const action = assertTextInput(value, 'TikOmni 设置操作', MAX_SHORT_TEXT_BYTES).trim();
  if (action === 'save_token' || action === 'remove_token' || action === 'save_wechat_ghid') return action;
  throw new InputLimitError('TikOmni 设置操作不受支持。');
}

export async function GET() {
  try {
    await ensureProjectInitialized();
    return NextResponse.json(redactLocalPaths(await readTikOmniSettingsStatus()));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取平台数据设置，请重试。',
      code: 'research_settings_read_failed',
      status: 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, 'TikOmni 本机设置', MAX_AGENT_PAYLOAD_BYTES);
    const action = parseAction(body.action);
    if (process.env.AIFIOS_DESKTOP === '1' && (action === 'save_token' || action === 'remove_token')) {
      return expectedUserFacingErrorResponse({
        error: '请在应用设置中保存平台数据密钥。桌面版会使用系统钥匙串保护它。',
        code: 'desktop_keychain_required',
        status: 400,
        action: { label: '打开设置', href: '/settings' },
      });
    }
    const status = await withProjectWriteLock('settings-tikomni', async () => {
      if (action === 'save_token') {
        return saveTikOmniApiToken(assertTextInput(body.token, 'TikOmni Token', MAX_SHORT_TEXT_BYTES));
      }
      if (action === 'save_wechat_ghid') {
        return saveWechatPublicAccountGhid(assertTextInput(body.ghid, '公众号 GHID', MAX_SHORT_TEXT_BYTES));
      }
      return removeTikOmniApiToken();
    });
    return NextResponse.json(redactLocalPaths({ status }));
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof TikOmniSettingsError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法保存平台数据设置，请重试。',
      code: 'research_settings_save_failed',
      status,
    });
  }
}
