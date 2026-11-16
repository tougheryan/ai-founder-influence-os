import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  savedToken: '',
  savedGhid: '',
  removed: false,
  lockKeys: [] as string[],
  status: {
    credential: {
      configured: true,
      source: 'env_file' as const,
      localFileConfigured: true,
      endpointConfigured: false,
    },
    runtime: {
      providerEnabled: true,
      socialMediaCrawlInstalled: true,
    },
    wechatPublicAccount: {
      configured: true,
      source: 'project_config' as const,
      configValid: true,
    },
    platforms: [
      { id: 'wechat_mp', label: '公众号', detail: '固定读取公开文章。' },
      { id: 'xiaohongshu', label: '小红书', detail: '固定公开检索。' },
      { id: 'wechat_channels', label: '视频号', detail: '抖音研究代理。' },
    ],
    setup: { status: 'ready_to_test' as const, blockers: [] as string[] },
    recentCollection: {
      lastAttemptAt: null,
      lastAttemptWeek: null,
      lastStatus: null,
      lastSuccessWeek: null,
      snapshotAvailable: false,
      collectedAt: null,
      sampleCount: null,
      platformChecks: { wechat_mp: 'unknown', xiaohongshu: 'unknown', wechat_channels: 'unknown' },
    },
  },
}));

vi.mock('@/lib/tikomni-settings', () => ({
  TikOmniSettingsError: class TikOmniSettingsError extends Error {},
  readTikOmniSettingsStatus: async () => mocks.status,
  saveTikOmniApiToken: async (token: string) => {
    mocks.savedToken = token;
    return mocks.status;
  },
  saveWechatPublicAccountGhid: async (ghid: string) => {
    mocks.savedGhid = ghid;
    return mocks.status;
  },
  removeTikOmniApiToken: async () => {
    mocks.removed = true;
    return mocks.status;
  },
}));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(key: string, callback: () => Promise<T>) => {
    mocks.lockKeys.push(key);
    return callback();
  },
}));

import { GET, POST } from './route';

const ORIGINAL_DESKTOP = process.env.AIFIOS_DESKTOP;

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/settings/tikomni', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('TikOmni local settings API', () => {
  beforeEach(() => {
    mocks.savedToken = '';
    mocks.savedGhid = '';
    mocks.removed = false;
    mocks.lockKeys = [];
    delete process.env.AIFIOS_DESKTOP;
  });

  afterEach(() => {
    if (ORIGINAL_DESKTOP === undefined) delete process.env.AIFIOS_DESKTOP;
    else process.env.AIFIOS_DESKTOP = ORIGINAL_DESKTOP;
  });

  it('returns local status without exposing a credential value', async () => {
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.credential).toEqual({
      configured: true,
      source: 'env_file',
      localFileConfigured: true,
      endpointConfigured: false,
    });
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  it('saves a token locally but never echoes it in the response', async () => {
    const response = await POST(request({ action: 'save_token', token: 'secret-token' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.savedToken).toBe('secret-token');
    expect(mocks.lockKeys).toEqual(['settings-tikomni']);
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  it('keeps the fixed market contract while saving the public-account source', async () => {
    const response = await POST(request({ action: 'save_wechat_ghid', ghid: 'gh_public_account' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.savedGhid).toBe('gh_public_account');
    expect(payload.status.platforms.map((platform: { id: string }) => platform.id)).toEqual([
      'wechat_mp', 'xiaohongshu', 'wechat_channels',
    ]);
  });

  it('only removes the locally stored token through an explicit action', async () => {
    const response = await POST(request({ action: 'remove_token' }));

    expect(response.status).toBe(200);
    expect(mocks.removed).toBe(true);
  });

  it('rejects plaintext token save and remove actions in desktop mode', async () => {
    process.env.AIFIOS_DESKTOP = '1';

    const saveResponse = await POST(request({ action: 'save_token', token: 'must-not-write' }));
    const removeResponse = await POST(request({ action: 'remove_token' }));

    expect(saveResponse.status).toBe(400);
    expect(removeResponse.status).toBe(400);
    expect(mocks.savedToken).toBe('');
    expect(mocks.removed).toBe(false);
    expect(mocks.lockKeys).toEqual([]);
    expect(await saveResponse.json()).toMatchObject({ error: expect.stringContaining('系统钥匙串') });
  });

  it('keeps non-secret GHID settings available to the desktop service', async () => {
    process.env.AIFIOS_DESKTOP = '1';

    const response = await POST(request({ action: 'save_wechat_ghid', ghid: 'example-ghid' }));

    expect(response.status).toBe(200);
    expect(mocks.savedGhid).toBe('example-ghid');
    expect(mocks.lockKeys).toEqual(['settings-tikomni']);
  });
});
