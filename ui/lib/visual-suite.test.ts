import { describe, expect, it } from 'vitest';
import { buildVisualAssetSuites } from './visual-suite';

describe('buildVisualAssetSuites', () => {
  it('builds one Xiaohongshu suite per eight-page viewpoint', () => {
    const assets = [
      ...Array.from({ length: 8 }, (_, index) => ({ id: `xhs-01-p${index + 1}`, title: index === 0 ? '客户先看见自己的问题' : undefined })),
    ];

    const [suite] = buildVisualAssetSuites('social', assets);
    expect(suite).toMatchObject({
      id: 'social-01',
      platform: 'social',
      label: '图文卡片 1',
      title: '客户先看见自己的问题',
    });
    expect(suite.assets).toEqual(assets);
    expect(suite.previewAssets.map((asset) => asset.id)).toEqual([
      'xhs-01-p1', 'xhs-01-p2', 'xhs-01-p3', 'xhs-01-p4',
      'xhs-01-p5', 'xhs-01-p6', 'xhs-01-p7', 'xhs-01-p8',
    ]);
  });

  it('treats one md2wechat HTML file as the complete native WeChat suite', () => {
    const assets = [{ id: 'wechat-html', title: '微信正文排版' }];
    const [suite] = buildVisualAssetSuites('wechat', assets);

    expect(suite).toMatchObject({
      id: 'wechat-primary',
      platform: 'wechat',
      label: '公众号排版',
      title: '微信正文排版',
      assets,
      previewAssets: assets,
    });
  });

  it('pairs WeChat cover alternatives with their matching share image', () => {
    const assets = [
      { id: 'wechat-cover' },
      { id: 'wechat-share' },
      { id: 'wechat-cover-alt-01' },
      { id: 'wechat-share-alt-01' },
      { id: 'wechat-cover-alt-02' },
      { id: 'wechat-share-alt-02' },
      { id: 'wechat-html' },
      { id: 'inline-01' },
    ];

    const suites = buildVisualAssetSuites('wechat', assets);

    expect(suites.map((suite) => suite.label)).toEqual(['文章配图 A', '文章配图 B', '文章配图 C']);
    expect(suites[0].assets.map((asset) => asset.id)).toEqual([
      'wechat-cover', 'wechat-share', 'wechat-html', 'inline-01',
    ]);
    expect(suites[1].assets.map((asset) => asset.id)).toEqual([
      'wechat-cover-alt-01', 'wechat-share-alt-01', 'wechat-html', 'inline-01',
    ]);
    expect(suites[2].assets.map((asset) => asset.id)).toEqual([
      'wechat-cover-alt-02', 'wechat-share-alt-02', 'wechat-html', 'inline-01',
    ]);
    expect(suites[0].previewAssets.map((asset) => asset.id)).toEqual([
      'wechat-cover', 'wechat-share', 'wechat-html', 'inline-01',
    ]);
  });
});
