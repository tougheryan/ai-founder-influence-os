import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  required: true,
  saved: {} as Record<string, unknown>,
  error: null as Error | null,
  calls: 0,
}));

vi.mock('./hosted-client-config', () => ({
  hostedLicenseRequired: () => mocks.required,
}));

vi.mock('./hosted-gateway', () => {
  class HostedGatewayError extends Error {
    constructor(message: string, public readonly status = 502) {
      super(message);
    }
  }
  return {
    HostedGatewayError,
    hostedGatewayConnection: async () => ({ saved: mocks.saved, gatewayUrl: 'https://gateway.example.com' }),
    callHostedGateway: async () => {
      mocks.calls += 1;
      if (mocks.error) throw mocks.error;
      return { quota: { limit: 10, used: 1, remaining: 9 } };
    },
    parseGatewayStatus: () => ({ connected: true }),
  };
});

import { HostedGatewayError } from './hosted-gateway';
import { verifyHostedLicenseAccess } from './hosted-license-access';

describe('hosted license live authorization', () => {
  beforeEach(() => {
    mocks.required = true;
    mocks.saved = {};
    mocks.error = null;
    mocks.calls = 0;
  });

  it('does not gate local self-config distributions', async () => {
    mocks.required = false;
    mocks.saved = { demoUnlocked: false };

    expect(await verifyHostedLicenseAccess()).toEqual({ required: false, authorized: true });
    expect(mocks.calls).toBe(0);
  });

  it('fails closed before a paid device is activated', async () => {
    const decision = await verifyHostedLicenseAccess();

    expect(decision.authorized).toBe(false);
    expect(decision).toMatchObject({ required: true, status: 401 });
    expect(mocks.calls).toBe(0);
  });

  it('allows access only after the gateway verifies the current session', async () => {
    mocks.saved = { gatewaySession: 'paid-device-session' };

    expect(await verifyHostedLicenseAccess()).toEqual({ required: true, authorized: true });
    expect(mocks.calls).toBe(1);
  });

  it('preserves gateway outage status while failing closed', async () => {
    mocks.saved = { gatewaySession: 'paid-device-session' };
    mocks.error = new HostedGatewayError('gateway unavailable', 503);

    expect(await verifyHostedLicenseAccess()).toEqual({
      required: true,
      authorized: false,
      status: 503,
      message: 'gateway unavailable',
    });
  });

  it('rejects a revoked or forged session', async () => {
    mocks.saved = { gatewaySession: 'forged-session' };
    mocks.error = new HostedGatewayError('session revoked', 401);

    expect(await verifyHostedLicenseAccess()).toMatchObject({ authorized: false, status: 401 });
  });
});
