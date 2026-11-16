import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verification: {
    verified: true,
    run_id: 'topic-run',
    manifest_path: 'runs/topic-run/market-research/fixture/snapshot.json',
    snapshot_sha256: 'a'.repeat(64),
    source_path: 'pipeline/intake/topic-intake.md',
  } as Record<string, unknown>,
  files: new Map<string, string>(),
}));

vi.mock('./runtime-writer', () => ({
  verifyRuntimeTikomniMarketSnapshot: async () => mocks.verification,
}));

vi.mock('./output-files', () => ({
  readOutputFile: async (path: string) => {
    const value = mocks.files.get(path);
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  },
}));

import {
  assertVerifiedTopicResearchBinding,
  parseTopicResearchBinding,
  readVerifiedTopicResearchSamples,
  TopicResearchAccessError,
} from './topic-research';

const binding = {
  runId: 'topic-run',
  snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
  snapshotSha256: 'a'.repeat(64),
};

describe('snapshot-bound topic research reader', () => {
  beforeEach(() => {
    mocks.verification = {
      verified: true,
      run_id: 'topic-run',
      manifest_path: binding.snapshotPath,
      snapshot_sha256: binding.snapshotSha256,
      source_path: 'pipeline/intake/topic-intake.md',
    };
    mocks.files = new Map([
      [binding.snapshotPath, JSON.stringify({
        normalized_path: 'runs/topic-run/market-research/fixture/normalized-samples.json',
      })],
      ['runs/topic-run/market-research/fixture/normalized-samples.json', JSON.stringify({
        signals: [
          {
            platform: 'wechat_mp',
            title: '公众号样本',
            account: '公众号账号',
            published_at: '2026-07-16',
            content_form: '文章',
            metrics: { reads: 12000, likes: 300, unsafe: 999 },
            hook: '先给出一个具体问题。',
            mechanism: '痛点开头',
            source_url: 'https://example.com/wechat',
            raw_payload: { secret: 'must never leave the server' },
          },
          {
            platform: 'xiaohongshu',
            title: '小红书样本',
            account: '小红书账号',
            published_at: '2026-07-15',
            content_form: '图文',
            metrics: { likes: 640, collects: 80 },
            hook: '从一个误区开场。',
            mechanism: '反常识标题',
            source_url: 'javascript:alert(1)',
          },
          {
            platform: 'wechat_channels',
            title: '视频号样本',
            account: '视频号账号',
            published_at: '2026-07-14',
            content_form: '视频',
            metrics: { reads: 9000, comments: 14 },
            hook: '前三秒直接给场景。',
            mechanism: '案例叙事',
            source_url: 'https://example.com/channels',
          },
        ],
      })],
    ]);
  });

  it('returns every normalized sample in the fixed platform groups without raw payloads', async () => {
    const research = await readVerifiedTopicResearchSamples(binding);

    expect(research.requiredPlatforms).toEqual(['wechat_mp', 'xiaohongshu', 'wechat_channels']);
    expect(research.totalSampleCount).toBe(3);
    expect(research.groups.map((group) => group.sampleCount)).toEqual([1, 1, 1]);
    expect(research.groups[0].samples[0]).toMatchObject({
      title: '公众号样本',
      account: '公众号账号',
      publishedAt: '2026-07-16',
      contentForm: '文章',
      metrics: { reads: 12000, likes: 300, collects: null, comments: null, shares: null },
      hook: '先给出一个具体问题。',
      url: 'https://example.com/wechat',
    });
    expect(research.groups[1].samples[0].url).toBe('');
    expect(JSON.stringify(research)).not.toContain('raw_payload');
    expect(JSON.stringify(research)).not.toContain('must never leave the server');
    expect(JSON.stringify(research)).not.toContain('unsafe');
  });

  it('fails closed before reading a snapshot whose verifier binding changed', async () => {
    mocks.verification = {
      ...mocks.verification,
      snapshot_sha256: 'b'.repeat(64),
    };

    await expect(assertVerifiedTopicResearchBinding(binding)).rejects.toBeInstanceOf(TopicResearchAccessError);
  });

  it('makes every saved sample available beyond the first three without exposing provider fields', async () => {
    mocks.files.set(binding.snapshotPath, JSON.stringify({
      normalized_path: 'runs/topic-run/market-research/fixture/normalized-samples.json', required_platforms: ['wechat_mp'],
    }));
    mocks.files.set('runs/topic-run/market-research/fixture/normalized-samples.json', JSON.stringify({
      signals: Array.from({ length: 10 }, (_, index) => ({
        platform: 'wechat_mp', title: `参考 ${index + 1}`, source_url: `https://example.com/${index + 1}`,
        metrics: { likes: index }, raw_payload: { token: 'private-provider-field' },
      })),
    }));
    const research = await readVerifiedTopicResearchSamples(binding);
    expect(research.totalSampleCount).toBe(10);
    expect(research.groups[0].samples).toHaveLength(10);
    expect(research.groups[0].samples[9]).toMatchObject({ title: '参考 10', url: 'https://example.com/10' });
    expect(JSON.stringify(research)).not.toContain('private-provider-field');
  });

  it('rejects paths that are not inside the current run research tree', () => {
    expect(() => parseTopicResearchBinding({
      ...binding,
      snapshotPath: 'runs/other-run/market-research/fixture/snapshot.json',
    })).toThrow('必须属于当前 run');
  });
});
