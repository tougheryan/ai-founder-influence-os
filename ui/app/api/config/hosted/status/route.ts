import { NextResponse } from 'next/server';
import { callHostedGateway, hostedGatewayConnection, HostedGatewayError, parseGatewayStatus } from '@/lib/hosted-gateway';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export async function GET() {
  try {
    const { saved, gatewayUrl } = await hostedGatewayConnection();
    if (!saved.gatewaySession) return NextResponse.json({ connected: false });
    const status = parseGatewayStatus(await callHostedGateway(gatewayUrl, '/v1/me', {
      token: saved.gatewaySession,
    }));
    return NextResponse.json(status);
  } catch (error) {
    const status = error instanceof HostedGatewayError ? error.status : 502;
    return userFacingErrorResponse(error, {
      error: status === 401
        ? '设备授权已失效，请重新输入设备授权码。'
        : '暂时无法读取账号状态，请检查网络后重试。',
      code: status === 401 ? 'device_authorization_expired' : 'hosted_account_status_failed',
      status,
      extra: { connected: false },
      legacyMessageField: 'message',
    });
  }
}
