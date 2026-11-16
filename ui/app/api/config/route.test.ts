import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hosted: null as { gatewayUrl: string } | null,
  hostedLicenseRequired: false,
  demoUnlockRequired: false,
  existing: {
    provider: 'deepseek',
    apiKey: 'saved-key',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    temperature: 0.7,
    maxTokens: 8000,
    brandTemplates: [{
      id: 'founder-notes',
      label: '创始人手记',
      detail: '用于复盘和个人经验。',
      layoutStyle: 'editorial',
      enabled: true,
    }],
  } as Record<string, unknown>,
  writes: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/config-lite', () => ({
  readLiteConfig: async () => mocks.existing,
  writeLiteConfig: async (value: Record<string, unknown>) => {
    mocks.writes.push(value);
  },
}));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/hosted-client-config', () => ({
  readHostedClientBootstrap: async () => mocks.hosted,
  hostedLicenseRequired: () => mocks.hostedLicenseRequired,
}));
vi.mock('@/lib/demo-unlock', () => ({
  demoUnlockRequired: async () => mocks.demoUnlockRequired,
}));
vi.mock('@/lib/llm-client', () => ({
  HOSTED_PROVIDER: 'aifios-hosted',
  PROVIDER_PRESETS: {
    deepseek: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com' },
  },
  normalizeProvider: (value: string) => value,
  validateLLMConfig: () => [],
}));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(_key: string, callback: () => Promise<T>) => callback(),
}));

import { GET, POST } from './route';

const ORIGINAL_DESKTOP = process.env.AIFIOS_DESKTOP;

describe('POST /api/config', () => {
  beforeEach(() => {
    mocks.writes = [];
    mocks.hosted = null;
    mocks.hostedLicenseRequired = false;
    mocks.demoUnlockRequired = false;
    delete process.env.AIFIOS_DESKTOP;
  });

  afterEach(() => {
    if (ORIGINAL_DESKTOP === undefined) delete process.env.AIFIOS_DESKTOP;
    else process.env.AIFIOS_DESKTOP = ORIGINAL_DESKTOP;
  });

  it('preserves the locally managed brand templates while LLM settings change', async () => {
    const response = await POST(new NextRequest('http://localhost/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-reasoner' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.writes).toEqual([expect.objectContaining({
      model: 'deepseek-reasoner',
      brandTemplates: mocks.existing.brandTemplates,
    })]);
  });

  it('still removes a cleared manual key instead of restoring it from the prior config', async () => {
    const response = await POST(new NextRequest('http://localhost/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: '' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.writes[0]).not.toHaveProperty('apiKey');
    expect(mocks.writes[0]).toHaveProperty('brandTemplates', mocks.existing.brandTemplates);
  });

  it('fails closed when a desktop renderer tries to write a plaintext API key', async () => {
    process.env.AIFIOS_DESKTOP = '1';
    const response = await POST(new NextRequest('http://localhost/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', apiKey: 'must-not-write' }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('系统钥匙串') });
    expect(mocks.writes).toEqual([]);
  });

  it('drops any legacy plaintext key while saving non-secret desktop settings', async () => {
    process.env.AIFIOS_DESKTOP = '1';
    const response = await POST(new NextRequest('http://localhost/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'desktop-model' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.writes).toHaveLength(1);
    expect(mocks.writes[0]).not.toHaveProperty('apiKey');
  });

  it('returns hosted account state without exposing the local session or a prior API key', async () => {
    const previous = mocks.existing;
    mocks.existing = {
      ...previous,
      connectionMode: 'hosted',
      gatewayUrl: 'https://gateway.example.com',
      gatewaySession: 'friend-session-token',
      apiKey: 'old-local-key',
    };
    mocks.hosted = { gatewayUrl: 'https://gateway.example.com' };

    const response = await GET();
    const payload = await response.json() as { config: Record<string, unknown> };

    expect(payload.config).toMatchObject({
      provider: 'aifios-hosted',
      connectionMode: 'hosted',
      gatewayConnected: true,
      gatewayUrl: 'https://gateway.example.com',
      apiKey: '',
    });
    expect(payload.config).not.toHaveProperty('gatewaySession');
    mocks.existing = previous;
  });

  it('keeps a paid desktop package at the authorization gate when its embedded gateway metadata is unavailable', async () => {
    mocks.hostedLicenseRequired = true;

    const response = await GET();
    const payload = await response.json() as { config: Record<string, unknown> };

    expect(payload.config).toMatchObject({
      provider: 'deepseek',
      licenseRequired: true,
      gatewayConnected: false,
      hasSavedKey: true,
    });
    expect(payload.config).not.toHaveProperty('connectionMode');
  });

  it('does not expose the retired password gate even with a legacy unlock configuration', async () => {
    mocks.demoUnlockRequired = true;

    const response = await GET();
    const payload = await response.json() as { config: Record<string, unknown> };

    expect(payload.config).toMatchObject({
      provider: 'deepseek',
      hasSavedKey: true,
    });
    expect(payload.config).not.toHaveProperty('demoUnlockRequired');
    expect(payload.config).not.toHaveProperty('demoUnlocked');
  });
});
