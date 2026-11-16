import { describe, expect, it, vi } from 'vitest';

const catalog = {
  templates: [{
    id: 'wechat-native',
    label: 'wechat-native',
    detail: '微信公众号原生主题',
    layoutStyle: 'wechat-native',
    enabled: true,
    selectable: true,
    themeType: 'api',
    source: 'md2wechat',
  }],
  source: 'md2wechat',
  rendererAvailable: true,
  totalCount: 53,
  directlyUsableCount: 48,
  aiThemeCount: 4,
  note: '本机 md2wechat 返回 53 个主题。',
};

vi.mock('@/lib/md2wechat-themes', () => ({ readMd2WechatThemeCatalog: async () => catalog }));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));

import { GET, PUT } from './route';

describe('md2wechat theme catalog API', () => {
  it('returns the live md2wechat catalog and capability counts', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
  });

  it('keeps the external theme catalog read-only', async () => {
    const response = await PUT();
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ code: 'md2wechat_catalog_read_only' });
  });
});
