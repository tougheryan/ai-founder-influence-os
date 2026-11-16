import { describe, expect, it } from 'vitest';
import {
  BrandTemplateValidationError,
  DEFAULT_BRAND_TEMPLATE,
  parseBrandTemplates,
} from './brand-templates';

describe('md2wechat theme contract', () => {
  it('keeps only one non-catalog fallback instead of sixteen product themes', () => {
    expect(DEFAULT_BRAND_TEMPLATE).toMatchObject({
      id: 'default',
      layoutStyle: 'default',
      source: 'echo-basic-fallback',
      themeType: 'fallback',
    });
  });

  it('accepts runtime-discovered md2wechat theme identifiers and metadata', () => {
    const theme = {
      id: 'minimal-green',
      label: 'minimal-green',
      detail: '绿色系，干净克制',
      layoutStyle: 'minimal-green',
      enabled: true,
      selectable: true,
      themeType: 'api' as const,
      version: '2.0',
      source: 'md2wechat' as const,
    };
    expect(parseBrandTemplates([theme])).toEqual([theme]);
  });

  it('rejects unsafe theme identifiers and a catalog with no directly usable theme', () => {
    expect(() => parseBrandTemplates([{
      id: 'unsafe', label: '不安全', detail: '不能绕过受控布局引擎。',
      layoutStyle: '../outside', enabled: true,
    }])).toThrow(BrandTemplateValidationError);

    expect(() => parseBrandTemplates([{
      id: 'autumn-warm', label: 'autumn-warm', detail: 'AI 主题',
      layoutStyle: 'autumn-warm', enabled: false, themeType: 'ai',
    }])).toThrow('没有可直接用于确定性排版的主题');
  });
});
