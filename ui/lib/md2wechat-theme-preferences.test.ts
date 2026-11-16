import { describe, expect, it } from 'vitest';
import {
  emptyMd2WechatThemePreferences,
  normalizeMd2WechatThemePreferences,
  readMd2WechatThemePreferences,
  recordRecentMd2WechatTheme,
  resolvePreferredMd2WechatThemeId,
  setDefaultMd2WechatTheme,
  toggleFavoriteMd2WechatTheme,
  writeMd2WechatThemePreferences,
} from './md2wechat-theme-preferences';

describe('md2wechat theme preferences', () => {
  it('normalizes untrusted stored values and removes duplicate theme ids', () => {
    expect(normalizeMd2WechatThemePreferences({
      favoriteThemeIds: ['bold-blue', 'bold-blue', '../bad'],
      recentThemeIds: ['apple', 7],
      defaultThemeId: ' ELEGANT-GOLD ',
    })).toEqual({
      favoriteThemeIds: ['bold-blue'],
      recentThemeIds: ['apple'],
      defaultThemeId: 'elegant-gold',
    });
  });

  it('records recent, favorite, and default choices without conflating them', () => {
    const initial = emptyMd2WechatThemePreferences();
    const recent = recordRecentMd2WechatTheme(initial, 'apple');
    const favorite = toggleFavoriteMd2WechatTheme(recent, 'bold-blue');
    const selectedDefault = setDefaultMd2WechatTheme(favorite, 'wechat-native');

    expect(selectedDefault).toEqual({
      favoriteThemeIds: ['bold-blue'],
      recentThemeIds: ['apple'],
      defaultThemeId: 'wechat-native',
    });
    expect(toggleFavoriteMd2WechatTheme(selectedDefault, 'bold-blue').favoriteThemeIds).toEqual([]);
  });

  it('round-trips through the supplied storage without depending on a browser', () => {
    let stored = '';
    const storage = {
      getItem: () => stored || null,
      setItem: (_key: string, value: string) => { stored = value; },
    };
    writeMd2WechatThemePreferences({
      favoriteThemeIds: ['apple'],
      recentThemeIds: ['bold-gray'],
      defaultThemeId: 'apple',
    }, storage);
    expect(readMd2WechatThemePreferences(storage).defaultThemeId).toBe('apple');
  });

  it('uses an available operator default for a new period and falls back safely', () => {
    const preferences = { ...emptyMd2WechatThemePreferences(), defaultThemeId: 'bold-blue' };
    expect(resolvePreferredMd2WechatThemeId(['default', 'bold-blue'], preferences)).toBe('bold-blue');
    expect(resolvePreferredMd2WechatThemeId(['wechat-native', 'default'], preferences)).toBe('wechat-native');
  });
});
