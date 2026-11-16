import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startOutputDownload } from '@/lib/output-download';
import { OutputDownloadLink } from './OutputDownloadLink';

const hooks = vi.hoisted(() => ({ setState: vi.fn(), cleanup: undefined as (() => void) | undefined }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [initial, hooks.setState],
  useRef: (initial: unknown) => ({ current: initial }),
  useId: () => 'download-status',
  useEffect: (effect: () => () => void) => { hooks.cleanup = effect(); },
}));
vi.mock('@/lib/output-download', () => ({ startOutputDownload: vi.fn() }));

beforeEach(() => { hooks.cleanup = undefined; });

describe('download link semantics', () => {
  it('retains its meaningful link, label, title and child content before interaction', () => {
    const html = renderToStaticMarkup(<OutputDownloadLink href="/api/output/pipeline/mock.png?download=1" aria-label="下载模拟图片与说明" title="原图和说明" className="download-link"><span>下载图片</span></OutputDownloadLink>);
    expect(html).toContain('<a href="/api/output/pipeline/mock.png?download=1"');
    expect(html).toContain('aria-label="下载模拟图片与说明"');
    expect(html).toContain('title="原图和说明"');
    expect(html).toContain('class="download-link"');
    expect(html).toContain('<span>下载图片</span>');
    expect(html).not.toContain('role="alert"');
  });

  it.each(['recorded', 'unrecorded', 'aborted', 'refresh-throws', 'refresh-rejects'] as const)(
    'notifies only for a current confirmed record and preserves download success: %s', async (scenario) => {
      let complete!: (value: { recorded: boolean; message: string }) => void;
      vi.mocked(startOutputDownload).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
      const onRecorded = vi.fn(() => {
        if (scenario === 'refresh-throws') throw new Error('Refresh failed');
        if (scenario === 'refresh-rejects') return Promise.reject(new Error('Refresh failed'));
      });
      const tree = OutputDownloadLink({ href: '/api/output/draft.md?download=1', children: '下载', onRecorded });
      const link = tree.props.children[0] as ReactElement<{ onClick: (event: { preventDefault: () => void }) => Promise<void> }>;
      const click = link.props.onClick({ preventDefault: vi.fn() });
      expect(onRecorded).not.toHaveBeenCalled();
      if (scenario === 'aborted') hooks.cleanup?.();
      complete({ recorded: scenario !== 'unrecorded', message: '已发起浏览器下载' });
      await click;
      expect(onRecorded).toHaveBeenCalledTimes(scenario === 'unrecorded' || scenario === 'aborted' ? 0 : 1);
      if (scenario !== 'aborted') {
        expect(hooks.setState).toHaveBeenLastCalledWith({ href: '/api/output/draft.md?download=1', busy: false, error: '', message: '已发起浏览器下载' });
      }
      expect(startOutputDownload).toHaveBeenCalledTimes(1);
    },
  );
});
