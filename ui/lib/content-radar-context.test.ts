import { describe, expect, it } from 'vitest';
import type { ContentRadarSnapshot } from './content-radar';
import { contentRadarContext, radarForQuery, radarQueryReady } from './content-radar-context';

const stored = (topic: string, selectedPlatforms: unknown, runId = 'run-a') => JSON.stringify({
  draftName: '当前稿件', savedDraftId: `draft_${'a'.repeat(32)}`, draft: { topic, selectedPlatforms, runId },
});

describe('radar navigation from the opened draft', () => {
  it('carries the selected draft title, platform and exact return link', () => {
    expect(contentRadarContext(stored('客户需求变更', ['wechat']))).toMatchObject({
      industry: '客户需求变更', platforms: ['wechat_mp'],
      context: { runId: 'run-a', name: '当前稿件', returnHref: `/production?stage=2&openDraft=draft_${'a'.repeat(32)}` },
    });
    expect(contentRadarContext(stored('门店如何拍视频', ['shipinhao'], 'run-b'))).toMatchObject({
      industry: '门店如何拍视频', platforms: ['wechat_channels'], context: { runId: 'run-b' },
    });
  });
  it('deduplicates supported aliases without inheriting unknown or prototype keys', () => {
    expect(contentRadarContext(stored('话题', ['wechat', 'wechat_mp', 'douyin', '__proto__', 'constructor', 1, 'xiaohongshu'])).platforms)
      .toEqual(['wechat_mp', 'xiaohongshu']);
    expect(contentRadarContext(stored('话题', 'wechat')).platforms).toEqual([]);
  });
  it.each([null, '{', 'null', '[]', stored('旧内容', ['wechat'], ''), stored('旧内容', ['wechat'], '../other')])(
    'keeps blank or unavailable selection empty instead of using an unrelated historical topic (%s)', (raw) => {
      expect(contentRadarContext(raw)).toMatchObject({ industry: '', platforms: [] });
    },
  );
  it('keeps a long author title intact but requires deliberate shortening before a paid scan', () => {
    const title = '长'.repeat(31);
    expect(contentRadarContext(stored(title, ['wechat'])).industry).toBe(title);
    expect(radarQueryReady('wechat_mp', title)).toBe(false);
    expect(radarQueryReady('wechat_mp', '短标题')).toBe(true);
    expect(radarQueryReady(null, '短标题')).toBe(false);
    expect(radarQueryReady('wechat_mp', ' ')).toBe(false);
    expect(radarQueryReady('wechat_mp', '一')).toBe(false);
  });
  it('never presents another platform or topic cache as the current result, including after manual editing', () => {
    const previous = { platform: 'wechat_mp', industry: '客户需求变更' } as ContentRadarSnapshot;
    expect(radarForQuery(previous, 'wechat_mp', '客户需求变更')).toBe(previous);
    expect(radarForQuery(previous, 'xiaohongshu', '客户需求变更')).toBeNull();
    expect(radarForQuery(previous, 'wechat_mp', '客户合同')).toBeNull();
    expect(radarForQuery(previous, null, '')).toBeNull();
    expect(radarForQuery(null, 'wechat_mp', '客户需求变更')).toBeNull();
    expect(previous.industry).toBe('客户需求变更');
  });
});
