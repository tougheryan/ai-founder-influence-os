import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHostedGatewayResponse, HostedGatewayError } from './hosted-gateway';

const ENV_KEYS = [
  'AIFIOS_DESKTOP_LICENSE_MODE',
  'AIFIOS_DESKTOP_GATEWAY_PROXY_URL',
  'AIFIOS_DESKTOP_GATEWAY_PROXY_TOKEN',
  'AIFIOS_DEVICE_ID',
] as const;

describe('hosted gateway desktop transport', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.unstubAllGlobals();
  });

  it('routes paid requests only through the authenticated Electron loopback proxy', async () => {
    process.env.AIFIOS_DESKTOP_LICENSE_MODE = 'device-bound';
    process.env.AIFIOS_DESKTOP_GATEWAY_PROXY_URL = 'http://127.0.0.1:45678';
    process.env.AIFIOS_DESKTOP_GATEWAY_PROXY_TOKEN = 'p'.repeat(43);
    process.env.AIFIOS_DEVICE_ID = 'legacy-device-id-must-not-be-sent';
    const gatewayFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', gatewayFetch);

    await fetchHostedGatewayResponse('https://gateway.example.com', '/v1/me', {
      token: 'paid-session',
    });

    expect(gatewayFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:45678/v1/me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer paid-session',
          'x-aifios-local-proxy-token': 'p'.repeat(43),
        }),
      }),
    );
    const call = gatewayFetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit?] | undefined;
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-aifios-device-id');
  });

  it('fails closed when a paid package has no Electron signing proxy', async () => {
    process.env.AIFIOS_DESKTOP_LICENSE_MODE = 'device-bound';

    await expect(fetchHostedGatewayResponse('https://gateway.example.com', '/v1/me'))
      .rejects.toEqual(expect.objectContaining<Partial<HostedGatewayError>>({ status: 503 }));
  });

  it('keeps direct transport only for non-paid development mode', async () => {
    const gatewayFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', gatewayFetch);

    await fetchHostedGatewayResponse('https://gateway.example.com', '/v1/me');

    expect(gatewayFetch).toHaveBeenCalledWith(
      'https://gateway.example.com/v1/me',
      expect.any(Object),
    );
  });
});
