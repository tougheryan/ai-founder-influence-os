import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saved: {} as Record<string, unknown>,
  gatewayUrl: 'https://gateway.example.com',
  callResult: {
    account: { label: 'paid user', sessionExpiresAt: '2030-01-01T00:00:00.000Z' },
    quota: { limit: 10, used: 2, remaining: 8 },
  } as unknown,
  calls: [] as Array<Record<string, unknown>>,
  error: null as Error | null,
}));

vi.mock('@/lib/hosted-gateway', () => {
  class HostedGatewayError extends Error {
    constructor(message: string, public readonly status = 502) {
      super(message);
    }
  }
  return {
    HostedGatewayError,
    hostedGatewayConnection: async () => ({ saved: mocks.saved, gatewayUrl: mocks.gatewayUrl }),
    callHostedGateway: async (gatewayUrl: string, path: string, options: Record<string, unknown>) => {
      mocks.calls.push({ gatewayUrl, path, options });
      if (mocks.error) throw mocks.error;
      return mocks.callResult;
    },
    parseGatewayStatus: (payload: unknown) => ({ connected: true, ...(payload as Record<string, unknown>) }),
  };
});

import { HostedGatewayError } from '@/lib/hosted-gateway';
import { GET } from './route';

describe('GET /api/config/hosted/status', () => {
  beforeEach(() => {
    mocks.saved = {};
    mocks.gatewayUrl = 'https://gateway.example.com';
    mocks.calls = [];
    mocks.error = null;
  });

  it('fails closed without a local session', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: false });
    expect(mocks.calls).toEqual([]);
  });

  it('reports connected only after the gateway verifies the device-bound session', async () => {
    mocks.saved = { gatewaySession: 'device-bound-session' };

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.connected).toBe(true);
    expect(payload.quota).toEqual({ limit: 10, used: 2, remaining: 8 });
    expect(mocks.calls).toEqual([{
      gatewayUrl: 'https://gateway.example.com',
      path: '/v1/me',
      options: { token: 'device-bound-session' },
    }]);
  });

  it('keeps the desktop locked when the gateway rejects the session', async () => {
    mocks.saved = { gatewaySession: 'forged-session' };
    mocks.error = new HostedGatewayError('登录状态已失效', 401);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      connected: false,
      error: '设备授权已失效，请重新输入设备授权码。',
      message: '设备授权已失效，请重新输入设备授权码。',
      code: 'device_authorization_expired',
      debugId: expect.stringMatching(/^err_[a-z0-9]+$/i),
    });
  });
});
