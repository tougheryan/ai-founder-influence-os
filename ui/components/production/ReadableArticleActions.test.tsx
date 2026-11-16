import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyReadableArticle } from '@/lib/readable-article-copy';
import { ReadableArticleActions, ReadableArticleActionsControl } from './ReadableArticleActions';

const hooks = vi.hoisted(() => ({ setState: vi.fn(), cleanup: undefined as (() => void) | undefined }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [initial, hooks.setState],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => () => void) => { hooks.cleanup = effect(); },
}));
vi.mock('@/lib/readable-article-copy', () => ({ copyReadableArticle: vi.fn() }));
vi.mock('@/components/OutputDownloadLink', () => ({ OutputDownloadLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
beforeEach(() => { hooks.cleanup = undefined; });
const props = { path: 'pipeline/package/a.md', sha256: 'a'.repeat(64), onRefresh: vi.fn() };

describe('reader article controls', () => {
  it('keeps copy and export available while protecting an open paragraph editor from refresh', () => {
    const html = renderToStaticMarkup(<ReadableArticleActions {...props} refreshDisabled />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?重新读取文章<\/button>/);
    expect(html).toContain('readable=article');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?复制文章<\/button>/);
  });
  it('offers copy, readable download and refresh in both normal and read-only article rendering', () => {
    const html = renderToStaticMarkup(<ReadableArticleActions {...props} />);
    expect(html).toContain('复制文章');
    expect(html).toContain('保存可读稿');
    expect(html).toContain('readable=article');
    expect(html).toContain('download=1');
    expect(html).toContain('保存为 HTML 草稿');
    expect(html).not.toContain('已发布');
  });
  it('does not expose an unchecked export when the article version is unavailable', () => {
    const html = renderToStaticMarkup(<ReadableArticleActions {...props} sha256="" />);
    expect(html).toContain('disabled');
    expect(html).toContain('重新读取');
    expect(html).not.toContain('download=1');
  });
  it.each(['copied', 'manual', 'failed', 'cancelled'] as const)('keeps current state truthful after %s', async (scenario) => {
    let resolve!: (value: Awaited<ReturnType<typeof copyReadableArticle>>) => void;
    let reject!: (reason: Error) => void;
    vi.mocked(copyReadableArticle).mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const tree = ReadableArticleActionsControl(props);
    const row = tree.props.children[0] as ReactElement<{ children: ReactElement[] }>;
    const button = row.props.children[0] as ReactElement<{ onClick: () => Promise<void> }>;
    const action = button.props.onClick();
    if (scenario === 'cancelled') { hooks.cleanup?.(); resolve({ status: 'cancelled' }); }
    else if (scenario === 'failed') reject(new Error('文章已经更新。请重新读取文章，再复制或保存。'));
    else resolve({ status: scenario, text: '正文和说明', notice: '仅供内部预览' });
    await action;
    if (scenario === 'cancelled') expect(hooks.setState).toHaveBeenCalledTimes(1);
    else expect(hooks.setState).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false, copied: scenario === 'copied', manual: scenario === 'manual' }));
    if (scenario === 'failed') expect(hooks.setState).toHaveBeenLastCalledWith(expect.objectContaining({ error: '文章已经更新。请重新读取文章，再复制或保存。', text: '' }));
  });
  it('remounts copy and download state when either the file or its bytes changes', () => {
    expect(ReadableArticleActions(props).key).not.toBe(ReadableArticleActions({ ...props, sha256: 'b'.repeat(64) }).key);
    expect(ReadableArticleActions(props).key).not.toBe(ReadableArticleActions({ ...props, path: 'pipeline/package/b.md' }).key);
  });
});
