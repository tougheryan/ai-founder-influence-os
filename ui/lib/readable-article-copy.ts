import { readableArticleHref } from './output-links';

export type ReadableArticleCopyResult = { status: 'cancelled' }
  | { status: 'copied' | 'manual'; text: string; notice: string };

export async function copyReadableArticle(path: string, sha256: string, options: {
  signal: AbortSignal;
  isCurrent: () => boolean;
  writeText: (text: string) => Promise<void>;
  fetcher?: typeof fetch;
}): Promise<ReadableArticleCopyResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 10_000);
  let text = '';
  let notice = '';
  try {
    const response = await (options.fetcher || fetch)(readableArticleHref(path, sha256), {
      cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
    });
    const payload: unknown = await response.json();
    if (controller.signal.aborted) throw new Error('读取文章超时或已取消，请重试。');
    if (!response.ok) {
      throw new Error(payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error : '暂时无法复制文章。请重试。');
    }
    if (!payload || typeof payload !== 'object' || !('sha256' in payload) || payload.sha256 !== sha256
      || !('text' in payload) || typeof payload.text !== 'string' || !payload.text.trim()
      || !('notice' in payload) || typeof payload.notice !== 'string') throw new Error('文章没有读取完整。请重新读取后再复制。');
    text = payload.text;
    notice = payload.notice;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', abort);
  }
  if (options.signal.aborted || !options.isCurrent()) return { status: 'cancelled' };
  try {
    await options.writeText(text);
    return options.signal.aborted || !options.isCurrent() ? { status: 'cancelled' } : { status: 'copied', text, notice };
  } catch {
    return options.signal.aborted || !options.isCurrent() ? { status: 'cancelled' } : { status: 'manual', text, notice };
  }
}
