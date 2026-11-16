import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Md2WechatThemePreview } from './Md2WechatThemePreview';
import { clearMd2WechatPreviewCache, fetchMd2WechatPreview } from '@/lib/md2wechat-preview-client';
import type { BrandTemplate } from '@/lib/brand-templates';

const theme: BrandTemplate = { id: 'apple', label: 'Apple', detail: '简洁', enabled: true, layoutStyle: 'apple', version: '1' };
afterEach(() => clearMd2WechatPreviewCache());

describe('explicit theme preview requests', () => {
  it.each([false, true])('shows external service scope before a preview is generated, compact=%s', (compact) => {
    const html = renderToStaticMarkup(<Md2WechatThemePreview theme={theme} compact={compact} />);
    expect(html).toContain('尚未生成示例');
    expect(html).toContain('生成 Apple 示例预览（外部服务）');
    expect(html).toContain('可能计费');
    expect(html).toContain('不计入本期模型调用次数上限');
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain('<iframe');
  });

  it('reads a completed example from cache without starting another external request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ themeId: theme.id, html: '<p>已生成示例</p>', exact: true })));
    await fetchMd2WechatPreview(theme, { fetcher, confirmExternalCall: true });
    const html = renderToStaticMarkup(<Md2WechatThemePreview theme={theme} />);
    expect(html).toContain('已生成示例');
    expect(html).toContain('重新生成 Apple 示例预览（外部服务）');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
