/**
 * Runtime-only hosted transport. Keep this module free of fs/path imports so
 * the client-facing LLM module can share the request path without pulling
 * server configuration readers into the browser bundle.
 */

export class HostedGatewayError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = 'HostedGatewayError';
  }
}

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedGatewayOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new HostedGatewayError('托管服务地址无效，请重新安装应用。', 503);
  }
}

function localGatewayProxy(env = process.env): { url: string; token: string } | null {
  const rawUrl = plainText(env.AIFIOS_DESKTOP_GATEWAY_PROXY_URL);
  const token = plainText(env.AIFIOS_DESKTOP_GATEWAY_PROXY_TOKEN);
  if (!rawUrl && !token) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/'
      || parsed.username || parsed.password || parsed.search || parsed.hash || token.length < 32) {
      throw new Error('invalid local proxy');
    }
    return { url: parsed.origin, token };
  } catch {
    throw new HostedGatewayError('本机设备授权服务无效，请重启应用。', 503);
  }
}

export async function fetchHostedGatewayResponse(
  gatewayUrl: string,
  path: string,
  options: {
    method?: 'GET' | 'POST';
    token?: string;
    body?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  if (!gatewayUrl) throw new HostedGatewayError('此应用包尚未配置托管服务地址。', 503);
  if (!/^\/v1\/[A-Za-z0-9/_-]+$/.test(path)) throw new HostedGatewayError('托管服务接口无效。', 500);
  const localProxy = localGatewayProxy();
  if (process.env.AIFIOS_DESKTOP_LICENSE_MODE === 'device-bound' && !localProxy) {
    throw new HostedGatewayError('本机设备授权服务未启动，请重启应用。', 503);
  }
  const baseUrl = localProxy?.url || normalizedGatewayOrigin(gatewayUrl);
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(localProxy ? { 'x-aifios-local-proxy-token': localProxy.token } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
}
