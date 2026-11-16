import { describe, expect, it, vi } from 'vitest';
import { copyOutput, prepareOutputCopy } from './output-copy';

describe('copying deliverables with their current limits', () => {
  it('does not let an abandoned article copy overwrite the new platform copy', async () => {
    let finishArticle!: (response: Response) => void;
    const oldLookup = new Promise<Response>((resolve) => { finishArticle = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(oldLookup).mockResolvedValueOnce(Response.json({
      disclosure: { status: 'internal_only', restrictions: ['仅内部使用'] },
    }));
    let current = 'article';
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const article = copyOutput('pipeline/package/a.md', '旧文章', { fetcher, writeText, isCurrent: () => current === 'article' });
    current = 'social';
    const social = await copyOutput('pipeline/package/b.md', '当前配文', { fetcher, writeText, isCurrent: () => current === 'social' });
    finishArticle(Response.json({ disclosure: { status: 'no_whole_draft_limit', restrictions: [] } }));
    expect(await article).toEqual({ status: 'cancelled' });
    expect(social.status).toBe('copied');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('当前配文');
    expect(writeText.mock.calls[0][0]).toContain('仅供内部预览');
  });

  it('keeps the exact marked text for manual copying when clipboard permission is denied', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ disclosure: { status: 'internal_only', restrictions: ['本期仅内部使用'] } }));
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('NotAllowedError'));
    const result = await copyOutput('pipeline/package/a.md', '完整稿件', { fetcher, writeText, isCurrent: () => true });
    expect(result.status).toBe('manual');
    if (result.status === 'manual') {
      expect(result.text).toBe(writeText.mock.calls[0][0]);
      expect(result.text).toContain('仅供内部预览');
      expect(result.text.endsWith('完整稿件')).toBe(true);
    }
  });

  it('looks up the same artifact afresh for every copy instead of reusing cleared limits', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ disclosure: { status: 'no_whole_draft_limit', restrictions: [] } }))
      .mockResolvedValueOnce(Response.json({ disclosure: { status: 'internal_only', restrictions: ['本期仅内部使用'] } }));
    const path = 'pipeline/package/我的文章 #1.md';
    expect(await prepareOutputCopy(path, '原稿全文', fetcher)).toEqual({ text: '原稿全文', notice: '' });
    const latest = await prepareOutputCopy(path, '原稿全文', fetcher);
    expect(latest.text).toContain('仅供内部预览');
    expect(latest.text).toContain('本期仅内部使用');
    expect(latest.text.endsWith('原稿全文')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe('/api/output/pipeline/package/%E6%88%91%E7%9A%84%E6%96%87%E7%AB%A0%20%231.md?disclosure=1');
      expect(options?.cache).toBe('no-store');
    }
  });

  it('retains local copy and manual fallback content when the lookup fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const result = await prepareOutputCopy('pipeline/package/a.md', '标题\n\n完整正文', fetcher);
    expect(result.notice).toContain('公开限制待核对');
    expect(result.text).toContain('仅供内部预览');
    expect(result.text.endsWith('标题\n\n完整正文')).toBe(true);
  });

  it.each([
    null,
    { status: 'public', restrictions: [] },
    { status: 'internal_only', restrictions: [17] },
    { status: 'no_whole_draft_limit', restrictions: ['不要公开'] },
    { status: 'no_whole_draft_limit' },
  ])('does not treat malformed or inconsistent metadata as clearance (%j)', async (disclosure) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ disclosure }));
    expect((await prepareOutputCopy('pipeline/package/a.md', '正文', fetcher)).text).toContain('公开限制待核对');
  });

  it('uses a local warning when the artifact is missing or the response is not successful', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await prepareOutputCopy('', '文字', fetcher)).text).toContain('公开限制待核对');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await prepareOutputCopy('pipeline/package/a.md', '文字', fetcher)).text).toContain('公开限制待核对');
  });

  it('carries partial limits without falsely declaring the whole draft internal-only', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ disclosure: {
      status: 'restricted_details', restrictions: ['不要公开客户姓名'],
    } }));
    const result = await prepareOutputCopy('pipeline/package/a.md', '正文', fetcher);
    expect(result.text).toContain('不要公开客户姓名');
    expect(result.notice).toContain('局部公开限制');
    expect(result.notice).not.toContain('本期材料设有整期公开限制');
  });
});
