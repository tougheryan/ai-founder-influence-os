import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyWechatLayout, wechatLayoutPlainText, writeWechatLayoutClipboard } from './wechat-layout-copy';
import { outputHref } from './output-links';

const path = 'pipeline/visual/demo/publish/r003/wechat/article.html';
const html = '<!doctype html><html><head><title>内部标题</title><style>p {color:blue}</style></head><body><h1>标题<br>第二行</h1><p style="line-height:1.8">正文。<a href="https://example.com/source">出处</a></p></body></html>';
const sha = createHash('sha256').update(html).digest('hex');
const allowed = { status: 'no_whole_draft_limit', restrictions: [], fingerprint: 'a'.repeat(64) };
function setup() {
  const controller = new AbortController();
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('disclosure=1')) return Response.json({ disclosure: allowed });
    if (String(url).includes('raw=1')) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return Response.json({ path, content: html });
  });
  return { controller, signal: controller.signal, isCurrent: () => true, fetcher: fetcher as typeof fetch, write: vi.fn(async () => {}) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('copy the final WeChat layout', () => {
  it('copies exactly the verified final HTML with a readable text alternative', async () => {
    const options = setup();
    const result = await copyWechatLayout(path, sha, options);
    expect(result.status).toBe('copied');
    expect(options.write).toHaveBeenCalledWith(html, '标题\n第二行\n\n正文。出处');
    expect(options.fetcher).toHaveBeenCalledWith(outputHref(path, 'view'), expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }));
    expect(options.fetcher).toHaveBeenCalledTimes(4);
  });

  it('keeps punctuation, links text, line breaks and paragraphs in the plain alternative', () => {
    expect(wechatLayoutPlainText(html)).toBe('标题\n第二行\n\n正文。出处');
    expect(wechatLayoutPlainText('<p>甲 &amp; 乙。</p><p>丙！</p><script>secret()</script><template>hidden</template>')).toBe('甲 & 乙。\n\n丙！');
  });

  it('does not report success when clipboard permission is denied', async () => {
    const options = setup(); options.write.mockRejectedValueOnce(new Error('NotAllowedError'));
    const result = await copyWechatLayout(path, sha, options);
    expect(result).toEqual({ status: 'manual', notice: expect.stringContaining('未完成') });
    expect(result).toEqual({ status: 'manual', notice: expect.stringContaining('手动复制') });
  });

  it.each(['internal_only', 'restricted_details', 'unverified', 'malformed'])('preserves the restriction barrier: %s', async (status) => {
    const options = setup();
    options.fetcher = vi.fn(async (url) => String(url).includes('disclosure=1')
      ? Response.json({ disclosure: status === 'malformed' ? { status: 'no_whole_draft_limit', restrictions: ['仍有保密事项'], fingerprint: allowed.fingerprint } : { ...allowed, status } })
      : Response.json({ path, content: html })) as typeof fetch;
    expect(await copyWechatLayout(path, sha, options)).toEqual({ status: 'restricted', notice: expect.stringContaining('使用说明') });
    expect(options.write).not.toHaveBeenCalled();
  });

  it('checks source digest before copying or resolving disclosure', async () => {
    const options = setup();
    await expect(copyWechatLayout(path, 'b'.repeat(64), options)).rejects.toThrow('排版已经变化');
    expect(options.fetcher).toHaveBeenCalledTimes(1);
    expect(options.write).not.toHaveBeenCalled();
  });

  it('never substitutes unmarked JSON content when the preview gains a warning', async () => {
    const options = setup(); const original = options.fetcher;
    options.fetcher = vi.fn(async (url, init) => String(url).includes('raw=1')
      ? new Response('<aside>仅供内部</aside>' + html, { headers: { 'Content-Type': 'text/html' } })
      : original(url, init)) as typeof fetch;
    await expect(copyWechatLayout(path, sha, options)).rejects.toThrow('使用说明已经变化');
    expect(options.write).not.toHaveBeenCalled();
  });

  it('rechecks author limits after reading the final HTML', async () => {
    const options = setup(); const original = options.fetcher; let disclosures = 0;
    options.fetcher = vi.fn(async (url, init) => String(url).includes('disclosure=1') && ++disclosures === 2
      ? Response.json({ disclosure: { ...allowed, fingerprint: 'b'.repeat(64) } }) : original(url, init)) as typeof fetch;
    expect((await copyWechatLayout(path, sha, options)).status).toBe('restricted');
    expect(options.write).not.toHaveBeenCalled();
  });

  it.each(['network', 'bad-json', 'wrong-path', 'not-html'])('does not copy after a read failure: %s', async (failure) => {
    const options = setup(); const original = options.fetcher;
    options.fetcher = vi.fn(async (url, init) => {
      if (failure === 'network') throw new Error('Network failed');
      if (failure === 'bad-json') return Response.json({});
      if (failure === 'wrong-path') return Response.json({ path: 'pipeline/other.html', content: html });
      if (String(url).includes('raw=1')) return new Response(html, { headers: { 'Content-Type': 'application/json' } });
      return original(url, init);
    }) as typeof fetch;
    await expect(copyWechatLayout(path, sha, options)).rejects.toThrow();
    expect(options.write).not.toHaveBeenCalled();
  });

  it.each(['switch', 'abort'])('does not copy a response after %s', async (reason) => {
    const options = setup(); const original = options.fetcher; let current = true;
    options.isCurrent = () => current;
    options.fetcher = vi.fn(async (url, init) => {
      if (String(url).includes('raw=1')) {
        if (reason === 'abort') options.controller.abort(); else current = false;
      }
      return original(url, init);
    }) as typeof fetch;
    expect(await copyWechatLayout(path, sha, options)).toEqual({ status: 'cancelled' });
    expect(options.write).not.toHaveBeenCalled();
  });

  it.each(['../article.html', 'https://example.com/article.html', 'pipeline/visual/demo/publish/r003/../article.html'])('rejects a noncanonical layout path: %s', async (candidate) => {
    const options = setup();
    await expect(copyWechatLayout(candidate, sha, options)).rejects.toThrow('排版版本');
    expect(options.fetcher).not.toHaveBeenCalled();
  });

  it('writes text/html and text/plain together and propagates native clipboard failures', async () => {
    const write = vi.fn(async () => {});
    class TestClipboardItem { constructor(readonly values: Record<string, Blob>) {} }
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write } });
    await writeWechatLayoutClipboard(html, '正文。');
    const item = (write.mock.calls[0] as unknown as [TestClipboardItem[]])[0][0];
    expect(await item.values['text/html'].text()).toBe(html);
    expect(await item.values['text/plain'].text()).toBe('正文。');
    write.mockRejectedValueOnce(new Error('denied'));
    await expect(writeWechatLayoutClipboard(html, '正文。')).rejects.toThrow('denied');
    vi.stubGlobal('ClipboardItem', undefined);
    await expect(writeWechatLayoutClipboard(html, '正文。')).rejects.toThrow('不可用');
  });
});
