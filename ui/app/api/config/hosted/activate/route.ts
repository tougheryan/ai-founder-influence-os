import { NextRequest, NextResponse } from 'next/server';
import { readLiteConfig, writeLiteConfig } from '@/lib/config-lite';
import { callHostedGateway, hostedGatewayConnection, HostedGatewayError, parseGatewayActivation } from '@/lib/hosted-gateway';
import { ensureProjectInitialized } from '@/lib/project-init';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

function inviteCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code || code.length > 256 || /[\r\n]/.test(code)) throw new Error('授权码格式不正确。');
  return code;
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json().catch(() => ({})) as { inviteCode?: unknown };
    const code = inviteCode(body.inviteCode);
    const { gatewayUrl } = await hostedGatewayConnection();
    const activation = parseGatewayActivation(await callHostedGateway(gatewayUrl, '/v1/activate', {
      method: 'POST',
      body: { code },
    }));
    await withProjectWriteLock('settings-hosted-activation', async () => {
      const existing = await readLiteConfig();
      const next = {
        ...existing,
        connectionMode: 'direct' as const,
        gatewayUrl,
        gatewaySession: activation.sessionToken,
        gatewaySessionExpiresAt: activation.sessionExpiresAt,
        gatewayAccountLabel: activation.accountLabel,
      };
      await writeLiteConfig(next);
    });
    return NextResponse.json({
      connected: true,
      account: { label: activation.accountLabel, sessionExpiresAt: activation.sessionExpiresAt },
      quota: activation.quota,
    });
  } catch (error) {
    const status = error instanceof HostedGatewayError ? error.status : error instanceof WriteLockError ? 409 : 400;
    return userFacingErrorResponse(error, {
      error: '设备授权失败，请检查授权码后重试。',
      code: 'device_activation_failed',
      status,
    });
  }
}
