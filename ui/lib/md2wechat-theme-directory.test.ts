import { describe, expect, it } from 'vitest';
import type { BrandTemplate } from './brand-templates';
import {
  buildMd2WechatThemeDirectory,
  md2WechatColorCategory,
  md2WechatLayoutCategory,
  recommendedMd2WechatThemes,
  themeDirectoryPath,
  toggleMd2WechatThemeComparison,
} from './md2wechat-theme-directory';

function theme(id: string, detail = `${id} theme`): BrandTemplate {
  return {
    id,
    label: id,
    detail,
    layoutStyle: id,
    enabled: true,
    source: 'md2wechat',
    themeType: 'api',
  };
}

const themes = [
  theme('bold-blue', '蓝色系，标题满底色'),
  theme('elegant-gold', '金色系，左边框递减'),
  theme('focus-green', '绿色系，居中对称'),
  theme('ink-minimal', '黑白水墨极简'),
  theme('wechat-native', '微信公众号原生绿'),
  theme('coffee-house', '巧克力棕色调'),
];

describe('md2wechat theme directory', () => {
  it('classifies layout families and colors from stable theme metadata', () => {
    expect(md2WechatLayoutCategory(themes[0]).id).toBe('bold');
    expect(md2WechatLayoutCategory(themes[3]).id).toBe('minimal');
    expect(md2WechatLayoutCategory(themes[4]).id).toBe('brand');
    expect(md2WechatColorCategory(themes[0]).id).toBe('blue');
    expect(md2WechatColorCategory(themes[1]).id).toBe('gold');
    expect(md2WechatColorCategory(themes[5]).id).toBe('warm');
  });

  it('builds reversible two-level directories for layout and color browsing', () => {
    const byLayout = buildMd2WechatThemeDirectory(themes, 'layout');
    const byColor = buildMd2WechatThemeDirectory(themes, 'color');

    expect(byLayout.find((group) => group.id === 'bold')?.sections[0].themes[0].id).toBe('bold-blue');
    expect(byColor.find((group) => group.id === 'green')?.count).toBe(2);
    expect(themeDirectoryPath(themes, 'layout', 'wechat-native')).toEqual({ groupId: 'brand', sectionId: 'green' });
    expect(themeDirectoryPath(themes, 'color', 'wechat-native')).toEqual({ groupId: 'green', sectionId: 'brand' });
  });

  it('omits AI, disabled, and fallback catalog entries from the selectable directory', () => {
    const hidden = [
      { ...theme('ai-theme'), enabled: false, themeType: 'ai' as const },
      { ...theme('fallback'), source: 'echo-basic-fallback' as const, themeType: 'fallback' as const },
    ];
    expect(buildMd2WechatThemeDirectory(hidden, 'layout')).toEqual([]);
  });

  it('reduces the first decision to three contextual recommendations', () => {
    const candidates = [
      ...themes,
      theme('elegant-navy'),
      theme('focus-blue'),
      theme('minimal-navy'),
    ];
    expect(recommendedMd2WechatThemes(candidates, '一份 AI 行业趋势研究报告').map((item) => item.id))
      .toEqual(['elegant-navy', 'focus-blue', 'minimal-navy']);
    expect(recommendedMd2WechatThemes(candidates, '', ['wechat-native'])[0].id).toBe('wechat-native');
  });

  it('keeps comparison choices explicit and capped at three', () => {
    expect(toggleMd2WechatThemeComparison(['apple'], 'bold-blue')).toEqual(['apple', 'bold-blue']);
    expect(toggleMd2WechatThemeComparison(['apple', 'bold-blue'], 'apple')).toEqual(['bold-blue']);
    expect(toggleMd2WechatThemeComparison(['a', 'b', 'c'], 'd')).toEqual(['a', 'b', 'c']);
  });
});
