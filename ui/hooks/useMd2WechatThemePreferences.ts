'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  emptyMd2WechatThemePreferences,
  readMd2WechatThemePreferences,
  recordRecentMd2WechatTheme,
  setDefaultMd2WechatTheme,
  toggleFavoriteMd2WechatTheme,
  writeMd2WechatThemePreferences,
  type Md2WechatThemePreferences,
} from '@/lib/md2wechat-theme-preferences';

export function useMd2WechatThemePreferences() {
  const [preferences, setPreferences] = useState<Md2WechatThemePreferences>(
    emptyMd2WechatThemePreferences,
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setPreferences(readMd2WechatThemePreferences()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const update = useCallback((change: (current: Md2WechatThemePreferences) => Md2WechatThemePreferences) => {
    setPreferences((current) => writeMd2WechatThemePreferences(change(current)));
  }, []);

  const recordRecent = useCallback((themeId: string) => {
    update((current) => recordRecentMd2WechatTheme(current, themeId));
  }, [update]);

  const toggleFavorite = useCallback((themeId: string) => {
    update((current) => toggleFavoriteMd2WechatTheme(current, themeId));
  }, [update]);

  const setDefault = useCallback((themeId: string) => {
    update((current) => setDefaultMd2WechatTheme(current, themeId));
  }, [update]);

  return { preferences, recordRecent, toggleFavorite, setDefault };
}
