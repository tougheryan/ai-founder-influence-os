import { describe, expect, it, vi } from 'vitest';
import { copyPublicationText } from './publication-text-copy';

const hash = 'a'.repeat(64), token = 'b'.repeat(64);
const path = 'pipeline/package/a.md';
const response = (patch: Record<string, unknown> = {}) => Response.json({
  field: 'xhs-body', sha256: hash, text: '发布正文', previewText: '使用说明\n发布正文', notice: '不要公开客户姓名',
  disclosureStatus: 'restricted_details', reviewToken: token, ...patch,
});
const options = () => ({ signal: new AbortController().signal, isCurrent: () => true,
  writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(), fetcher: vi.fn<typeof fetch>().mockResolvedValue(response()) });
describe('field copying with current source and limits', () => {
  it('does not write restricted text until its current notice has been reviewed', async () => {
    const opts = options();
    expect((await copyPublicationText(path, hash, 'xhs-body', opts)).status).toBe('review');
    expect(opts.writeText).not.toHaveBeenCalled();
    opts.fetcher.mockResolvedValue(response());
    expect((await copyPublicationText(path, hash, 'xhs-body', { ...opts, reviewedToken: token })).status).toBe('copied');
    expect(opts.writeText).toHaveBeenLastCalledWith('发布正文');
  });
  it('requires review again when restrictions changed, even after the user clicked confirm', async () => {
    const opts = options(); opts.fetcher.mockResolvedValue(response({ reviewToken: 'c'.repeat(64) }));
    expect((await copyPublicationText(path, hash, 'xhs-body', { ...opts, reviewedToken: token })).status).toBe('review');
    expect(opts.writeText).not.toHaveBeenCalled();
  });
  it.each(['internal_only', 'unverified'])('keeps %s copies marked despite a supplied acknowledgement', async (disclosureStatus) => {
    const opts = options(); opts.fetcher.mockImplementation(async () => response({ disclosureStatus }));
    expect((await copyPublicationText(path, hash, 'xhs-body', { ...opts, reviewedToken: token })).status).toBe('review');
    expect(opts.writeText).not.toHaveBeenCalled();
    await copyPublicationText(path, hash, 'xhs-body', { ...opts, withNotice: true });
    expect(opts.writeText).toHaveBeenLastCalledWith('使用说明\n发布正文');
  });
  it('copies unrestricted text directly and uses the exact same text for clipboard fallback', async () => {
    const opts = options(); opts.fetcher.mockResolvedValue(response({ disclosureStatus: 'no_whole_draft_limit', notice: '' }));
    opts.writeText.mockRejectedValue(new Error('clipboard denied'));
    expect(await copyPublicationText(path, hash, 'xhs-body', opts)).toMatchObject({ status: 'manual', text: '发布正文', includedNotice: false });
  });
  it('does not let an abandoned request overwrite the clipboard', async () => {
    const opts = options(); opts.isCurrent = () => false;
    expect(await copyPublicationText(path, hash, 'xhs-body', { ...opts, reviewedToken: token })).toEqual({ status: 'cancelled' });
    expect(opts.writeText).not.toHaveBeenCalled();
  });
  it.each([{ sha256: 'old' }, { field: 'video-title' }, { text: '' }, { reviewToken: '' }, { disclosureStatus: 'public' }, { notice: '' }])('rejects incomplete or wrong-source responses (%j)', async (patch) => {
    const opts = options(); opts.fetcher.mockResolvedValue(response(patch));
    await expect(copyPublicationText(path, hash, 'xhs-body', { ...opts, reviewedToken: token })).rejects.toThrow();
    expect(opts.writeText).not.toHaveBeenCalled();
  });
  it('reports stale-source errors without offering unchecked fallback', async () => {
    const opts = options(); opts.fetcher.mockResolvedValue(Response.json({ error: '原稿已更新' }, { status: 409 }));
    await expect(copyPublicationText(path, hash, 'xhs-body', opts)).rejects.toThrow('原稿已更新');
    expect(opts.writeText).not.toHaveBeenCalled();
  });
});
