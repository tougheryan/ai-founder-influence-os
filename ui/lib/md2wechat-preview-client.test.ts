import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearMd2WechatPreviewCache,
  fetchMd2WechatPreview,
  getCachedMd2WechatPreview,
} from './md2wechat-preview-client';

const theme = { id: 'bold-blue', version: '2.0' };

afterEach(() => clearMd2WechatPreviewCache());

describe('md2wechat preview client cache', () => {
  it('does not request an uncached preview without an explicit external-call choice', async () => {
    const fetcher = vi.fn();
    await expect(fetchMd2WechatPreview(theme, { fetcher })).rejects.toThrow('外部排版服务');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('deduplicates simultaneous forced refreshes and permits later cache-only reads', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolve = done; }));
    const first = fetchMd2WechatPreview(theme, { fetcher, force: true, confirmExternalCall: true });
    const second = fetchMd2WechatPreview(theme, { fetcher, force: true, confirmExternalCall: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ themeId: theme.id, confirmExternalCall: true });
    resolve(new Response(JSON.stringify({ themeId: theme.id, html: '<p>saved</p>', exact: true })));
    await Promise.all([first, second]);
    expect((await fetchMd2WechatPreview(theme, { fetcher })).html).toBe('<p>saved</p>');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves a successful cached preview when an explicit refresh fails', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ themeId: theme.id, html: '<p>saved</p>', exact: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '连接失败' }), { status: 422 }));
    await fetchMd2WechatPreview(theme, { fetcher, confirmExternalCall: true });
    await expect(fetchMd2WechatPreview(theme, { fetcher, force: true, confirmExternalCall: true })).rejects.toThrow('连接失败');
    expect(getCachedMd2WechatPreview(theme)?.html).toBe('<p>saved</p>');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('deduplicates in-flight and completed preview requests', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      themeId: theme.id,
      html: '<section>preview</section>',
      renderer: 'md2wechat',
      exact: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const [first, second] = await Promise.all([
      fetchMd2WechatPreview(theme, { fetcher, confirmExternalCall: true }),
      fetchMd2WechatPreview(theme, { fetcher, confirmExternalCall: true }),
    ]);
    const third = await fetchMd2WechatPreview(theme, { fetcher, confirmExternalCall: true });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.html).toBe(second.html);
    expect(third.html).toBe(first.html);
    expect(getCachedMd2WechatPreview(theme)?.exact).toBe(true);
  });

  it('forces regeneration when the operator requests it', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      themeId: theme.id,
      html: `<section>${fetcher.mock.calls.length}</section>`,
      renderer: 'md2wechat',
      exact: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await fetchMd2WechatPreview(theme, { fetcher, confirmExternalCall: true });
    const refreshed = await fetchMd2WechatPreview(theme, { fetcher, force: true, confirmExternalCall: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshed.html).toContain('2');
  });
});
