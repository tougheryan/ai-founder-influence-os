import { hostedLicenseRequired } from './hosted-client-config';
import {
  callHostedGateway,
  hostedGatewayConnection,
  HostedGatewayError,
  parseGatewayStatus,
} from './hosted-gateway';

export type HostedLicenseDecision =
  | { required: false; authorized: true }
  | { required: true; authorized: true }
  | { required: true; authorized: false; status: number; message: string };

export const HOSTED_LICENSE_PUBLIC_REQUESTS = Object.freeze([
  { method: 'GET', pathname: '/settings' },
  { method: 'HEAD', pathname: '/settings' },
  { method: 'GET', pathname: '/api/config' },
  { method: 'GET', pathname: '/api/config/hosted/status' },
  { method: 'POST', pathname: '/api/config/hosted/activate' },
  { method: 'GET', pathname: '/api/desktop/health' },
] as const);

const PUBLIC_HOSTED_REQUESTS = new Set(
  HOSTED_LICENSE_PUBLIC_REQUESTS.map(({ method, pathname }) => `${method} ${pathname}`),
);

export function isHostedLicensePublicRequest(pathname: string, method: string): boolean {
  return PUBLIC_HOSTED_REQUESTS.has(`${method} ${pathname}`);
}

export async function verifyHostedLicenseAccess(): Promise<HostedLicenseDecision> {
  const licenseRequired = hostedLicenseRequired();
  if (!licenseRequired) return { required: false, authorized: true };

  try {
    const { saved, gatewayUrl } = await hostedGatewayConnection();
    if (!saved.gatewaySession) {
      return {
        required: true,
        authorized: false,
        status: 401,
        message: '请先使用购买后获得的授权码激活此设备。',
      };
    }
    const status = parseGatewayStatus(await callHostedGateway(gatewayUrl, '/v1/me', {
      token: saved.gatewaySession,
      timeoutMs: 5_000,
    }));
    if (!status.connected) {
      return {
        required: true,
        authorized: false,
        status: 401,
        message: '当前设备尚未获得有效授权。',
      };
    }
    return { required: true, authorized: true };
  } catch (error) {
    return {
      required: true,
      authorized: false,
      status: error instanceof HostedGatewayError ? error.status : 502,
      message: error instanceof Error ? error.message : '无法验证当前设备授权。',
    };
  }
}
