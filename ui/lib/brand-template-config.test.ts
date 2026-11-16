import { describe, expect, it, vi } from 'vitest';

const templates = [{
  id: 'wechat-native', label: 'wechat-native', detail: '微信原生',
  layoutStyle: 'wechat-native', enabled: true,
}, {
  id: 'autumn-warm', label: 'autumn-warm', detail: 'AI 主题',
  layoutStyle: 'autumn-warm', enabled: false,
}];

vi.mock('./md2wechat-themes', () => ({
  readMd2WechatThemeCatalog: async () => ({ templates }),
}));

import {
  BrandTemplateResolutionError,
  readConfiguredBrandTemplates,
  resolveConfiguredBrandTemplate,
} from './brand-template-config';

describe('md2wechat theme resolution', () => {
  it('reads the live catalog and resolves only directly usable API themes', async () => {
    await expect(readConfiguredBrandTemplates()).resolves.toEqual(templates);
    await expect(resolveConfiguredBrandTemplate('wechat-native')).resolves.toMatchObject({
      id: 'wechat-native', layoutStyle: 'wechat-native',
    });
    await expect(resolveConfiguredBrandTemplate('autumn-warm')).rejects.toBeInstanceOf(BrandTemplateResolutionError);
  });
});
