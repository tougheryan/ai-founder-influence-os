import { describe, expect, it, vi } from 'vitest';
import { copyReadableArticle } from './readable-article-copy';
import { readableArticleHref } from './output-links';

const sha = 'a'.repeat(64);
const payload = { sha256: sha, text: '【使用说明】仅内部\n文章草稿\n标题\n摘要\n正文', notice: '仅供内部预览' };
const response = () => new Response(JSON.stringify(payload), { status: 200 });
const options = () => ({ signal: new AbortController().signal, isCurrent: () => true, writeText: vi.fn(async () => {}), fetcher: vi.fn(async () => response()) as unknown as typeof fetch });

describe('source-bound article copying', () => {
  it('copies the current server text and retained notice, with an encoded, snapshot-bound URL', async () => {
    const deps = options();
    expect(await copyReadableArticle('pipeline/package/有 空格.md', sha, deps)).toEqual({ status: 'copied', text: payload.text, notice: payload.notice });
    expect(deps.writeText).toHaveBeenCalledWith(payload.text);
    expect(deps.fetcher).toHaveBeenCalledWith(readableArticleHref('pipeline/package/有 空格.md', sha), expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }));
    expect(readableArticleHref('pipeline/package/有 空格.md', sha, true)).toContain('&download=1');
  });
  it('offers the exact marked text for manual copying if clipboard access fails', async () => {
    const deps = options(); deps.writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    expect(await copyReadableArticle('pipeline/package/a.md', sha, deps)).toEqual({ status: 'manual', text: payload.text, notice: payload.notice });
  });
  it.each(['stale', 'invalid-payload', 'wrong-version', 'network'] as const)('never falls back to unchecked text after %s', async (scenario) => {
    const deps = options();
    deps.fetcher = vi.fn(async () => {
      if (scenario === 'network') throw new Error('Disconnected');
      if (scenario === 'stale') return new Response(JSON.stringify({ error: '文章已经更新。' }), { status: 409 });
      return new Response(JSON.stringify(scenario === 'wrong-version' ? { ...payload, sha256: 'b'.repeat(64) } : {}));
    }) as typeof fetch;
    await expect(copyReadableArticle('pipeline/package/a.md', sha, deps)).rejects.toThrow();
    expect(deps.writeText).not.toHaveBeenCalled();
  });
  it('does not copy a response that arrives after switching articles', async () => {
    const deps = options(); deps.isCurrent = () => false;
    expect(await copyReadableArticle('pipeline/package/a.md', sha, deps)).toEqual({ status: 'cancelled' });
    expect(deps.writeText).not.toHaveBeenCalled();
  });
  it('does not write to the clipboard when a cancelled fetch completes late', async () => {
    const controller = new AbortController(); const deps = options(); deps.signal = controller.signal;
    deps.fetcher = vi.fn(async () => { controller.abort(); return response(); }) as typeof fetch;
    await expect(copyReadableArticle('pipeline/package/a.md', sha, deps)).rejects.toThrow();
    expect(deps.writeText).not.toHaveBeenCalled();
  });
});
