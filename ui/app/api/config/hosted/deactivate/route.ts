import { NextResponse } from 'next/server';
import { readLiteConfig, writeLiteConfig } from '@/lib/config-lite';
import { ensureProjectInitialized } from '@/lib/project-init';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export async function POST() {
  try {
    await ensureProjectInitialized();
    await withProjectWriteLock('settings-hosted-deactivation', async () => {
      const existing = await readLiteConfig();
      const next = { ...existing };
      delete next.gatewaySession;
      delete next.gatewaySessionExpiresAt;
      delete next.gatewayAccountLabel;
      await writeLiteConfig(next);
    });
    return NextResponse.json({ connected: false });
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法退出当前账号，请重试。',
      code: 'hosted_account_deactivate_failed',
      status: error instanceof WriteLockError ? 409 : 500,
    });
  }
}
