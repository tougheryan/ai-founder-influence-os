import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { outputHref } from './output-links';

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MANUAL_NOTICE = '自动复制未完成。请打开排版预览手动复制，或下载排版文件。';
const RESTRICTED_NOTICE = '这份排版有公开限制或尚未核对。请先打开排版预览，保留其中的使用说明。';
type CopyResult = { status: 'cancelled' } | { status: 'copied' | 'manual' | 'restricted'; notice: string };
type CopyOptions = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  write: (html: string, text: string) => Promise<void>;
  fetcher?: typeof fetch;
};

/** Derive the plain-text alternative from this final HTML, including paragraph breaks. */
export function wechatLayoutPlainText(html: string): string {
  const blocks = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'li', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr']);
  function text(node: DefaultTreeAdapterMap['node']): string {
    if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
    if (!('childNodes' in node)) return '';
    const tag = 'tagName' in node ? node.tagName : '';
    if (['script', 'style', 'head', 'template'].includes(tag)) return '';
    if (tag === 'br') return '\n';
    const value = node.childNodes.map(text).join('');
    return blocks.has(tag) ? `\n${value}\n` : value;
  }
  return text(parse(html)).replace(/[\t ]+\n/g, '\n').replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function clearDisclosure(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('disclosure' in value)) return null;
  const disclosure = value.disclosure;
  if (!disclosure || typeof disclosure !== 'object' || !('status' in disclosure) || disclosure.status !== 'no_whole_draft_limit'
    || !('restrictions' in disclosure) || !Array.isArray(disclosure.restrictions) || disclosure.restrictions.length
    || !('fingerprint' in disclosure) || typeof disclosure.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(disclosure.fingerprint)) return null;
  return disclosure.fingerprint;
}

async function hashHtml(html: string): Promise<string> {
  const bytes = new TextEncoder().encode(html);
  if (!bytes.length || bytes.length > MAX_HTML_BYTES) throw new Error('排版文件过大或为空，请打开预览核对。');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Copy only the displayed, unchanged HTML; marked exports never fall back to an unmarked original. */
export async function copyWechatLayout(path: string, sha256: string, options: CopyOptions): Promise<CopyResult> {
  if (!/^pipeline\/visual\/[^/]+\/publish\/r\d{3,}\/(?:[^/]+\/)*[^/]+\.html?$/i.test(path)
    || path.split('/').some((part) => ['.', '..'].includes(part)) || /[\\\x00-\x1f]/.test(path)
    || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('暂时无法核对排版版本，请刷新后再复制。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const timeout = setTimeout(abort, 10_000);
  const current = () => !options.signal.aborted && options.isCurrent();
  const fetcher = options.fetcher || fetch;
  const read = async (url: string) => {
    const response = await fetcher(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!response.ok || controller.signal.aborted) throw new Error('排版读取失败或超时，请打开预览后重试。');
    return response;
  };
  try {
    if (!current()) return { status: 'cancelled' };
    const source: unknown = await (await read(outputHref(path))).json();
    if (!current()) return { status: 'cancelled' };
    if (!source || typeof source !== 'object' || !('path' in source) || source.path !== path
      || !('content' in source) || typeof source.content !== 'string'
      || await hashHtml(source.content) !== sha256) throw new Error('排版已经变化，请刷新并核对新版本后再复制。');
    const disclosure = clearDisclosure(await (await read(`${outputHref(path)}?disclosure=1`)).json());
    if (!current()) return { status: 'cancelled' };
    if (!disclosure) return { status: 'restricted', notice: RESTRICTED_NOTICE };
    const raw = await read(outputHref(path, 'view'));
    if (!raw.headers.get('content-type')?.toLowerCase().startsWith('text/html')) throw new Error('没有读到完整排版，请打开预览核对。');
    const html = await raw.text();
    if (!current()) return { status: 'cancelled' };
    if (await hashHtml(html) !== sha256) throw new Error('排版或使用说明已经变化，请打开预览重新核对。');
    const latestDisclosure = clearDisclosure(await (await read(`${outputHref(path)}?disclosure=1`)).json());
    if (!current()) return { status: 'cancelled' };
    if (!latestDisclosure || latestDisclosure !== disclosure) return { status: 'restricted', notice: RESTRICTED_NOTICE };
    const text = wechatLayoutPlainText(html);
    if (!text) throw new Error('这份排版没有可复制的正文，请打开预览核对。');
    if (!current()) return { status: 'cancelled' };
    if (controller.signal.aborted) throw new Error('读取排版超时，请打开预览后重试。');
    try {
      await options.write(html, text);
      return current() ? { status: 'copied', notice: '已复制排版，可粘贴到公众号编辑器。' } : { status: 'cancelled' };
    } catch {
      return current() ? { status: 'manual', notice: MANUAL_NOTICE } : { status: 'cancelled' };
    }
  } catch (error) {
    if (!current()) return { status: 'cancelled' };
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', abort);
  }
}

export async function writeWechatLayoutClipboard(html: string, text: string): Promise<void> {
  if (!globalThis.ClipboardItem || !navigator.clipboard?.write) throw new Error('富文本剪贴板不可用');
  await navigator.clipboard.write([new ClipboardItem({
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([text], { type: 'text/plain' }),
  })]);
}
