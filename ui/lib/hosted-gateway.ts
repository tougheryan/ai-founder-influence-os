import { readLiteConfig } from './config-lite';
import { hostedLicenseRequired, readHostedClientBootstrap } from './hosted-client-config';
import {
  fetchHostedGatewayResponse,
  HostedGatewayError,
} from './hosted-gateway-transport';

export { fetchHostedGatewayResponse, HostedGatewayError } from './hosted-gateway-transport';

export type HostedGatewayStatus = {
  connected: boolean;
  account?: { label?: string; sessionExpiresAt?: string };
  quota?: { limit: number; used: number; remaining: number };
  message?: string;
};

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function gatewayError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = payload.error;
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
      return error.message;
    }
  }
  return fallback;
}

export async function hostedGatewayConnection() {
  const saved = await readLiteConfig();
  const bootstrap = await readHostedClientBootstrap();
  const licenseRequired = hostedLicenseRequired();
  const gatewayUrl = bootstrap?.gatewayUrl || (!licenseRequired && saved.connectionMode === 'hosted' ? plainText(saved.gatewayUrl) : '');
  return {
    saved,
    gatewayUrl,
    licenseRequired,
    researchPublicKey: bootstrap?.researchPublicKey || '',
    researchKeyId: bootstrap?.researchKeyId || '',
  };
}

export async function callHostedGateway(
  gatewayUrl: string,
  path: string,
  options: {
    method?: 'GET' | 'POST';
    token?: string;
    body?: Record<string, unknown>;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  if (!gatewayUrl) throw new HostedGatewayError('此应用包尚未配置托管服务地址。', 503);
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.min(30_000, Math.max(1_000, Number(options.timeoutMs)))
    : 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchHostedGatewayResponse(gatewayUrl, path, {
      method: options.method,
      token: options.token,
      body: options.body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new HostedGatewayError(gatewayError(payload, '托管服务暂时不可用，请稍后重试。'), response.status);
    return payload;
  } catch (error) {
    if (error instanceof HostedGatewayError) throw error;
    throw new HostedGatewayError('无法连接托管服务，请检查网络后重试。');
  } finally {
    clearTimeout(timer);
  }
}

export function parseGatewayActivation(payload: unknown): {
  sessionToken: string;
  sessionExpiresAt: string;
  accountLabel: string;
  quota: { limit: number; used: number; remaining: number };
} {
  if (!payload || typeof payload !== 'object') throw new HostedGatewayError('托管服务返回无效的激活结果。');
  const item = payload as Record<string, unknown>;
  const sessionToken = plainText(item.sessionToken);
  const sessionExpiresAt = plainText(item.sessionExpiresAt);
  const account = item.account && typeof item.account === 'object' ? item.account as Record<string, unknown> : {};
  const quota = item.quota && typeof item.quota === 'object' ? item.quota as Record<string, unknown> : {};
  const values = [quota.limit, quota.used, quota.remaining].map((value) => Number(value));
  if (sessionToken.length < 24 || !sessionExpiresAt || !values.every(Number.isFinite)) {
    throw new HostedGatewayError('托管服务返回无效的激活结果。');
  }
  return {
    sessionToken,
    sessionExpiresAt,
    accountLabel: plainText(account.label) || '内测用户',
    quota: { limit: values[0], used: values[1], remaining: values[2] },
  };
}

export function parseGatewayStatus(payload: unknown): HostedGatewayStatus {
  if (!payload || typeof payload !== 'object') throw new HostedGatewayError('托管服务返回无效的账户状态。');
  const item = payload as Record<string, unknown>;
  const account = item.account && typeof item.account === 'object' ? item.account as Record<string, unknown> : {};
  const quota = item.quota && typeof item.quota === 'object' ? item.quota as Record<string, unknown> : {};
  const values = [quota.limit, quota.used, quota.remaining].map((value) => Number(value));
  if (!values.every(Number.isFinite)) throw new HostedGatewayError('托管服务返回无效的账户状态。');
  return {
    connected: true,
    account: { label: plainText(account.label), sessionExpiresAt: plainText(account.sessionExpiresAt) },
    quota: { limit: values[0], used: values[1], remaining: values[2] },
  };
}
