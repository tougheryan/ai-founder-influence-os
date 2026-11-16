import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TikOmniSampleBrowser,
  buildTikOmniPlatformGroups,
  formatTikOmniMetric,
  knownSampleInteractions,
  prepareTikOmniSamples,
  type TikOmniSampleRow,
} from './TikOmniSampleBrowser';

describe('TikOmniSampleBrowser utilities', () => {
  const rows: TikOmniSampleRow[] = [
    { id: 'xhs-1', platform: 'xiaohongshu', title: '小红书样本', account: '账号 A', interactions: 12_600 },
    { id: 'mp-1', platform: 'wechat_mp', title: '公众号样本', account: '账号 B', interactions: 920 },
    { id: 'extra-1', platform: 'custom', title: '额外平台样本', account: '账号 C' },
  ];

  it('keeps required platforms in order and appends returned extra platforms', () => {
    const groups = buildTikOmniPlatformGroups(rows, {
      wechat_mp: 1,
      xiaohongshu: 1,
      wechat_channels: 0,
      custom: 1,
    });

    expect(groups.map((group) => group.id)).toEqual([
      'wechat_mp',
      'xiaohongshu',
      'wechat_channels',
      'custom',
    ]);
    expect(groups.find((group) => group.id === 'wechat_channels')).toMatchObject({ total: 0, samples: [] });
    expect(groups.find((group) => group.id === 'custom')).toMatchObject({ total: 1, samples: [rows[2]] });
  });

  it('shows only selected production platforms even when legacy totals include other platforms', () => {
    const groups = buildTikOmniPlatformGroups(rows, { wechat_mp: 10, xiaohongshu: 0, wechat_channels: 0 }, [
      { id: 'wechat_mp', label: '公众号' },
    ], true);
    expect(groups.map((group) => group.id)).toEqual(['wechat_mp']);
    expect(groups[0]).toMatchObject({ total: 10, samples: [rows[1]] });
  });

  it('formats interaction metrics for compact operational scanning', () => {
    expect(formatTikOmniMetric(12_600)).toBe('1.3万');
    expect(formatTikOmniMetric(920)).toBe('920');
    expect(formatTikOmniMetric(null)).toBe('未知');
  });
});

describe('reference sorting with incomplete evidence', () => {
  const filters = { form: 'all', metrics: 'all', time: 'all' };
  const row = (id: string, patch: Partial<TikOmniSampleRow> = {}): TikOmniSampleRow => ({ id, title: id, account: '作者', platform: 'wechat_mp', ...patch });

  it('does not turn reads, invalid values, or absent metrics into interaction counts', () => {
    expect(knownSampleInteractions(row('reads', { metrics: { reads: 10_000, views: 300 } }))).toBeNull();
    expect(knownSampleInteractions(row('bad', { interactions: -1, metrics: { likes: NaN, shares: -1, comments: '300' } }))).toBeNull();
    expect(knownSampleInteractions(row('zero', { metrics: { reads: 1000, likes: 0 } }))).toBe(0);
    expect(knownSampleInteractions(row('partial', { metrics: { reads: 1000, likes: 10, comments: 2 } }))).toBe(12);
    expect(knownSampleInteractions(row('total', { interactions: 20, metrics: { likes: 10 } }))).toBe(20);
    expect(formatTikOmniMetric(-1)).toBe('未知');
  });

  it('keeps recorded order and makes unsupported interaction sorting explicit', () => {
    const rows = [row('second'), row('first', { metrics: { reads: 9000 } })];
    expect(prepareTikOmniSamples(rows, filters, 'interactions_desc')).toEqual({ rows, sort: 'original' });
    const view = prepareTikOmniSamples(rows, filters, 'original');
    const html = renderToStaticMarkup(createElement(TikOmniSampleBrowser, {
      sampleRows: view.rows, platformTotals: { wechat_mp: 2 }, filters, sort: view.sort,
      onFiltersChange: () => {}, onSortChange: () => {}, onContinue: () => {},
    }));
    expect(html).toContain('没有互动记录');
    expect(html).toContain('不代表相关性或热度排名');
    expect(html).toMatch(/<option value="interactions_desc" disabled=""/);
    expect(html).toMatch(/<option value="original" selected=""/);
  });

  it.each(['interactions_asc', 'interactions_desc'] as const)('puts unknown values last for %s and keeps ties stable', (sort) => {
    const rows = [row('unknown'), row('ten', { interactions: 10 }), row('zero', { interactions: 0 }), row('ten-again', { interactions: 10 }), row('also-unknown')];
    const view = prepareTikOmniSamples(rows, filters, sort);
    expect(view.rows.map((item) => item.id)).toEqual(sort === 'interactions_asc'
      ? ['zero', 'ten', 'ten-again', 'unknown', 'also-unknown'] : ['ten', 'ten-again', 'zero', 'unknown', 'also-unknown']);
    expect(rows[0].id).toBe('unknown');
  });

  it('sorts real dates with missing dates last in either direction', () => {
    const rows = [row('unknown', { publishedAt: 'invalid' }), row('new', { publishedAt: '2026-09-18' }), row('old', { publishedAt: '2026-09-10' })];
    expect(prepareTikOmniSamples(rows, filters, 'published_asc').rows.map((item) => item.id)).toEqual(['old', 'new', 'unknown']);
    expect(prepareTikOmniSamples(rows, filters, 'published_desc').rows.map((item) => item.id)).toEqual(['new', 'old', 'unknown']);
    expect(prepareTikOmniSamples([rows[0]], filters, 'published_asc').sort).toBe('original');
  });

  it('re-evaluates available sorting after filtering and excludes future dates from the past week', () => {
    const now = Date.parse('2026-09-18T00:00:00Z');
    const rows = [row('recent', { publishedAt: '2026-09-17', contentForm: '文章', sampleClass: 'insufficient' }), row('old', { publishedAt: '2026-09-01', interactions: 3 }), row('future', { publishedAt: '2026-09-19' }), row('undated')];
    const view = prepareTikOmniSamples(rows, { form: '文章', metrics: 'insufficient', time: '7d' }, 'interactions_desc', now);
    expect(view.rows.map((item) => item.id)).toEqual(['recent']);
    expect(view.sort).toBe('original');
    expect(prepareTikOmniSamples(rows, { ...filters, time: '7d' }, 'original', now).rows.map((item) => item.id)).toEqual(['recent']);
  });
});

describe('saved reference overview', () => {
  const row = (id: string, patch: Partial<TikOmniSampleRow> = {}): TikOmniSampleRow => ({
    id, title: id, platform: 'wechat_mp', account: '作者', contentForm: '文章', ...patch,
  });
  const render = (samples: TikOmniSampleRow[], visible = samples, totals = { wechat_mp: samples.filter((item) => item.platform === 'wechat_mp').length }) => renderToStaticMarkup(createElement(TikOmniSampleBrowser, {
    sampleRows: visible, platformTotals: totals,
    overview: { topic: '客户临时加需求', queries: ['需求变更', '交付范围', '需求变更'], samples },
    platforms: [{ id: 'wechat_mp', label: '公众号' }], onlyProvidedPlatforms: true,
    filters: { form: 'all', metrics: 'all', time: 'all' }, sort: 'original',
    onFiltersChange: () => {}, onSortChange: () => {}, onContinue: () => {},
  }));
  const overview = (html: string) => html.match(/<div aria-label="本期参考概况"[\s\S]*?<\/div>/)?.[0];

  it('keeps full coverage when filtering to zero and excludes unselected platforms', () => {
    const samples = [row('linked', { url: 'https://example.test/1' }), row('zero', { metrics: { likes: 0 }, evidenceStatus: 'sufficient' }), row('unselected', { platform: 'xiaohongshu', url: 'https://example.test/2', interactions: 30 })];
    const full = render(samples);
    const empty = render(samples, []);
    expect(overview(full)).toBe(overview(empty));
    expect(overview(empty)).toContain('已读取 2 条，其中 1 条附有来源链接，1 条有互动记录，1 条表现证据不足');
    expect(overview(empty)).toContain('1 条未附来源链接');
    expect(overview(empty)).toContain('需求变更、交付范围');
    expect(empty).toContain('显示 0 / 2 条');
    expect(empty).toContain('option value="文章"');
  });

  it('does not infer performance from reads alone or claim unloaded records were checked', () => {
    const html = render([row('reads', { metrics: { reads: 90_000 } })], [], { wechat_mp: 10 });
    expect(overview(html)).toContain('0 条有互动记录，1 条表现证据不足');
    expect(overview(html)).toContain('不能据此判断传播效果');
    expect(overview(html)).toContain('还有 9 条明细尚未读取');
    expect(overview(render([], [], { wechat_mp: 10 }))).toContain('目前没有可读取的参考明细');
  });

  it('keeps all recorded metrics behind a closed, individually named disclosure', () => {
    const html = render([row('五项数据', { metrics: { reads: 10, likes: 0, collects: 2, comments: 3, shares: 4 } })]);
    const details = html.match(/<article[\s\S]*?<details[\s\S]*?<\/details>/)?.[0] || '';
    expect(details).toContain('查看数据与评分依据');
    expect(details).toContain('sr-only">：五项数据');
    expect(details).toContain('分享');
    expect(details).toContain('综合分 未知');
    expect(details).toContain('置信度 未知');
    expect(details).not.toMatch(/<details[^>]*\bopen\b/);
  });
});
