import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runCalls: [] as unknown[] }));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => undefined }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(_key: string, callback: () => Promise<T>) => callback(),
}));
vi.mock('@/lib/content-radar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/content-radar')>('@/lib/content-radar');
  return {
    ...actual,
    readLatestContentRadar: async () => null,
    readContentRadarComparison: async (industry: string) => ({ industry, availablePlatforms: [], missingPlatforms: ['xiaohongshu', 'wechat_mp'], rows: [] }),
    runContentRadar: async (input: unknown) => {
      mocks.runCalls.push(input);
      return { schema: 'aifios.content-radar.v5', status: 'ready', industry: '美妆行业', platform: 'xiaohongshu' };
    },
  };
});

import { GET, POST } from './route';

describe('/api/content-radar', () => {
  it('returns a nullable cached platform snapshot', async () => {
    const response = await GET(new NextRequest('http://localhost/api/content-radar?platform=xiaohongshu'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, radar: null });
  });

  it('returns an honest cross-platform comparison without synthesizing missing snapshots', async () => {
    const response = await GET(new NextRequest('http://localhost/api/content-radar?view=compare&industry=美妆行业'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, comparison: { industry: '美妆行业', availablePlatforms: [], rows: [] } });
  });

  it('starts a bounded platform scan', async () => {
    mocks.runCalls = [];
    const response = await POST(new NextRequest('http://localhost/api/content-radar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ industry: '美妆行业', platform: 'xiaohongshu' }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.runCalls).toEqual([{ industry: '美妆行业', platform: 'xiaohongshu' }]);
  });

  it('rejects an unsupported platform before invoking the runner', async () => {
    mocks.runCalls = [];
    const response = await POST(new NextRequest('http://localhost/api/content-radar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ industry: '美妆行业', platform: 'douyin', persona: 'reviewer', goal: 'conversion' }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.runCalls).toEqual([]);
  });

  it('ignores legacy account and goal filters so they cannot narrow the candidate pool', async () => {
    mocks.runCalls = [];
    const response = await POST(new NextRequest('http://localhost/api/content-radar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ industry: '美妆行业', platform: 'xiaohongshu', persona: 'unknown', goal: 'trust' }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.runCalls).toEqual([{ industry: '美妆行业', platform: 'xiaohongshu' }]);
  });
});
