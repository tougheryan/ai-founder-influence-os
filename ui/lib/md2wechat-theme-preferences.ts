import { isMd2WechatThemeId } from './brand-templates';

export const MD2WECHAT_THEME_PREFERENCES_KEY = 'echo-founder.md2wechat-theme-preferences.v1';
const MAX_FAVORITES = 24;
const MAX_RECENT = 6;

export type Md2WechatThemePreferences = {
  favoriteThemeIds: string[];
  recentThemeIds: string[];
  defaultThemeId: string;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function emptyMd2WechatThemePreferences(): Md2WechatThemePreferences {
  return { favoriteThemeIds: [], recentThemeIds: [], defaultThemeId: '' };
}

function themeIds(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(isMd2WechatThemeId)))
    .slice(0, limit);
}

export function normalizeMd2WechatThemePreferences(value: unknown): Md2WechatThemePreferences {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const defaultThemeId = typeof source.defaultThemeId === 'string'
    ? source.defaultThemeId.trim().toLowerCase()
    : '';
  return {
    favoriteThemeIds: themeIds(source.favoriteThemeIds, MAX_FAVORITES),
    recentThemeIds: themeIds(source.recentThemeIds, MAX_RECENT),
    defaultThemeId: isMd2WechatThemeId(defaultThemeId) ? defaultThemeId : '',
  };
}

function browserStorage(): StorageLike | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function readMd2WechatThemePreferences(
  storage: StorageLike | null = browserStorage(),
): Md2WechatThemePreferences {
  if (!storage) return emptyMd2WechatThemePreferences();
  try {
    const raw = storage.getItem(MD2WECHAT_THEME_PREFERENCES_KEY);
    return raw ? normalizeMd2WechatThemePreferences(JSON.parse(raw)) : emptyMd2WechatThemePreferences();
  } catch {
    return emptyMd2WechatThemePreferences();
  }
}

export function writeMd2WechatThemePreferences(
  preferences: Md2WechatThemePreferences,
  storage: StorageLike | null = browserStorage(),
): Md2WechatThemePreferences {
  const normalized = normalizeMd2WechatThemePreferences(preferences);
  try {
    storage?.setItem(MD2WECHAT_THEME_PREFERENCES_KEY, JSON.stringify(normalized));
  } catch {
    // Preferences improve convenience only; a blocked browser store must not stop production.
  }
  return normalized;
}

export function recordRecentMd2WechatTheme(
  preferences: Md2WechatThemePreferences,
  themeId: string,
): Md2WechatThemePreferences {
  if (!isMd2WechatThemeId(themeId)) return preferences;
  return normalizeMd2WechatThemePreferences({
    ...preferences,
    recentThemeIds: [themeId, ...preferences.recentThemeIds.filter((id) => id !== themeId)],
  });
}

export function toggleFavoriteMd2WechatTheme(
  preferences: Md2WechatThemePreferences,
  themeId: string,
): Md2WechatThemePreferences {
  if (!isMd2WechatThemeId(themeId)) return preferences;
  const exists = preferences.favoriteThemeIds.includes(themeId);
  return normalizeMd2WechatThemePreferences({
    ...preferences,
    favoriteThemeIds: exists
      ? preferences.favoriteThemeIds.filter((id) => id !== themeId)
      : [themeId, ...preferences.favoriteThemeIds],
  });
}

export function setDefaultMd2WechatTheme(
  preferences: Md2WechatThemePreferences,
  themeId: string,
): Md2WechatThemePreferences {
  if (!isMd2WechatThemeId(themeId)) return preferences;
  return normalizeMd2WechatThemePreferences({ ...preferences, defaultThemeId: themeId });
}

export function resolvePreferredMd2WechatThemeId(
  availableThemeIds: readonly string[],
  preferences: Md2WechatThemePreferences,
  fallbackThemeId = 'default',
): string {
  const available = new Set(availableThemeIds);
  if (preferences.defaultThemeId && available.has(preferences.defaultThemeId)) {
    return preferences.defaultThemeId;
  }
  if (available.has('wechat-native')) return 'wechat-native';
  if (available.has(fallbackThemeId)) return fallbackThemeId;
  return availableThemeIds[0] || fallbackThemeId;
}
