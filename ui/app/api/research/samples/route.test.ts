import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fail: false,
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/topic-research', () => {
  class TopicResearchAccessError extends Error {}
  return {
    TopicResearchAccessError,
    parseTopicResearchBinding: (value: Record<string, string>) => value,
    readVerifiedTopicResearchSamples: async () => {
      if (mocks.fail) throw new TopicResearchAccessError('snapshot mismatch');
      return {
        requiredPlatforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
        douyinResearchProxy: 'wechat_channels',
        totalSampleCount: 1,
        groups: [{
          platform: 'wechat_mp', label: '公众号', sampleCount: 1,
          samples: [{
            id: 'sample_1', title: '样本', account: '账号', publishedAt: '2026-07-16', contentForm: '文章',
            metrics: { reads: 1, likes: 0, collects: 0, comments: 0, shares: 0 },
            hook: '开场', mechanism: '痛点开头', url: 'https://example.com/sample',
          }],
        }],
      };
    },
  };
});

import { GET } from './route';

function request() {
  return new NextRequest(`http://localhost/api/research/samples?${new URLSearchParams({
    runId: 'topic-run',
    snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
    snapshotSha256: 'a'.repeat(64),
  }).toString()}`);
}

describe('GET /api/research/samples', () => {
  beforeEach(() => { mocks.fail = false; });

  it('returns the browser-safe normalized sample view only', async () => {
    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, totalSampleCount: 1 });
    expect(payload).not.toHaveProperty('douyinResearchProxy');
    expect(payload.groups[0].samples[0]).toMatchObject({ title: '样本', account: '账号' });
    expect(payload).not.toHaveProperty('rawPayload');
  });

  it('keeps a failed snapshot as a hard research block', async () => {
    mocks.fail = true;
    const response = await GET(request());

    expect(response.status).toBe(424);
    const payload = await response.json();
    expect(payload).toMatchObject({ code: 'research_samples_read_failed' });
    expect(JSON.stringify(payload)).not.toContain('snapshot mismatch');
  });
});
