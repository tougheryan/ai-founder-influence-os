import { posix } from 'node:path';
import { parse, serialize, defaultTreeAdapter, html, type DefaultTreeAdapterMap } from 'parse5';

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];
export const MAX_PORTABLE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES_BYTES = 32 * 1024 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_BYTES = 48 * 1024 * 1024;
const POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

export class PortableArticleError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

/** Keep referenced files within this article's publish revision, never another run. */
export function portableArticleRoot(path: string): string | null {
  const match = /^(pipeline\/visual\/[^/]+\/publish\/(?:r[0-9]+\/)?)(?:wechat\/[^/]+|wechat-article)\.html?$/i.exec(path);
  return match?.[1] || null;
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 10 && /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function setAttribute(element: Element, name: string, value: string) {
  const attribute = element.attrs.find((item) => item.name === name);
  if (attribute) attribute.value = value;
  else element.attrs.push({ name, value });
}

export async function preparePortableArticle(source: Buffer, path: string, readImage: (path: string) => Promise<Buffer>): Promise<Buffer> {
  const articleRoot = portableArticleRoot(path);
  if (!articleRoot) return source;
  const root: string = articleRoot;
  if (source.length > MAX_HTML_BYTES) throw new PortableArticleError('排版文章超过 8MB，请拆分后再下载。', 413);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(source); }
  catch { throw new PortableArticleError('排版文章编码无法识别，请重新整理成品后下载。'); }
  const document = parse(text);
  const loaded = new Map<string, string>();
  let imageBytes = 0;
  let embeddedBytes = 0;
  function includeImage(value: string) {
    // Repeated uses share one read, but each occurrence expands the HTML.
    embeddedBytes += Buffer.byteLength(value, 'utf8');
    if (embeddedBytes > MAX_EMBEDDED_BYTES) throw new PortableArticleError('配图在文章中重复过多，导出文件会过大。请减少重复配图或压缩图片后再下载。', 413);
    return value;
  }
  async function imageUrl(value: string): Promise<string> {
    const url = value.trim();
    if (loaded.has(url)) return includeImage(loaded.get(url)!);
    if (loaded.size >= 32) throw new PortableArticleError('文章引用的图片超过 32 张，请拆分后再下载。', 413);
    let bytes: Buffer;
    if (/^data:/i.test(url)) {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(url);
      if (!match) throw new PortableArticleError('文章含暂不支持的内嵌图片，请使用 PNG、JPG、GIF 或 WebP 后重新整理成品。');
      bytes = Buffer.from(match[2], 'base64');
    } else {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url)) throw new PortableArticleError('文章包含网络图片或外部文件。请先将配图保存为本期素材并重新整理成品，再下载离线文章。');
      let decoded: string;
      try { decoded = decodeURIComponent(url.split(/[?#]/)[0]); }
      catch { throw new PortableArticleError('文章配图地址无法识别，请重新整理成品后下载。'); }
      if (!decoded || /[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('/')) throw new PortableArticleError('文章配图地址无法核对，请重新整理成品后下载。');
      const relative = posix.normalize(posix.join(posix.dirname(path), decoded));
      if (!relative.startsWith(root) || !/\.(?:png|jpe?g|gif|webp)$/i.test(relative)) throw new PortableArticleError('文章引用了本期排版之外的文件或不支持的图片，请重新整理成品后下载。');
      bytes = await readImage(relative);
    }
    if (bytes.length > MAX_PORTABLE_IMAGE_BYTES || imageBytes + bytes.length > MAX_IMAGES_BYTES) throw new PortableArticleError('文章配图过大，请将单张图片控制在 16MB、全部图片控制在 32MB 内，再重新整理成品。', 413);
    const mime = imageMime(bytes);
    if (!mime) throw new PortableArticleError('文章中有无法识别的配图，请重新上传图片并整理成品后下载。');
    imageBytes += bytes.length;
    const embedded = `data:${mime};base64,${bytes.toString('base64')}`;
    loaded.set(url, embedded);
    return includeImage(embedded);
  }

  async function css(value: string) {
    // Controlled article renderers use inline CSS. Do not fetch remote sheets,
    // fonts or escaped URL syntaxes, or silently ship a file missing them.
    if (/@import\b|\\/.test(value)) throw new PortableArticleError('排版样式含外部或无法识别的引用，请重新整理成品后下载。');
    const urls = [...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"()]+))\s*\)/gi)];
    if ((value.match(/url\s*\(/gi) || []).length !== urls.length) throw new PortableArticleError('排版样式中的图片引用无法识别，请重新整理成品后下载。');
    let result = value;
    for (const match of urls.reverse()) {
      const url = match[1] ?? match[2] ?? match[3];
      if (url.startsWith('#')) continue;
      const replacement = `url("${await imageUrl(url)}")`;
      result = result.slice(0, match.index) + replacement + result.slice(match.index! + match[0].length);
    }
    return result;
  }

  const stack: { node: Node; depth: number }[] = [{ node: document, depth: 0 }];
  let count = 0;
  let head: Element | undefined;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > 30_000 || depth > 100) throw new PortableArticleError('排版文章结构过于复杂，请重新整理成品后下载。', 413);
    if ('tagName' in node) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'head') head = node;
      if (['script', 'base'].includes(tag) || (tag === 'meta' && node.attrs.some((a) => a.name === 'http-equiv'))) {
        defaultTreeAdapter.detachNode(node); continue;
      }
      if (['iframe', 'object', 'embed', 'video', 'audio', 'source', 'form', 'input', 'template', 'foreignobject'].includes(tag)) throw new PortableArticleError('排版文件包含无法离线保存的交互或媒体组件，请重新整理成品后下载。');
      if (tag === 'link') {
        if (node.attrs.some((a) => a.name === 'rel' && a.value.toLowerCase().split(/\s+/).includes('stylesheet'))) throw new PortableArticleError('排版文章使用了外部样式文件，请重新整理成品后下载。');
        defaultTreeAdapter.detachNode(node); continue;
      }
      node.attrs = node.attrs.filter((a) => !/^on/i.test(a.name));
      if (node.attrs.some((a) => a.name === 'srcset')) throw new PortableArticleError('文章含多尺寸配图引用，请重新整理成品后下载。');
      for (const attribute of node.attrs) {
        if (tag === 'use' && attribute.name === 'href' && !attribute.value.startsWith('#')) throw new PortableArticleError('文章图形引用了外部文件，请重新整理成品后下载。');
        if (attribute.name === 'style') attribute.value = await css(attribute.value);
        if ((tag === 'img' && attribute.name === 'src') || (['image', 'feimage'].includes(tag) && attribute.name === 'href')) attribute.value = await imageUrl(attribute.value);
        if (attribute.name === 'background') attribute.value = await imageUrl(attribute.value);
      }
      if (tag === 'img') {
        if (!node.attrs.some((a) => a.name === 'src' && a.value)) throw new PortableArticleError('文章中有缺少图片来源的配图，请重新整理成品后下载。');
        setAttribute(node, 'loading', 'eager');
      }
      if (tag === 'style') for (const child of node.childNodes) if ('value' in child) child.value = await css(child.value);
    }
    if ('childNodes' in node) for (const child of [...node.childNodes].reverse()) stack.push({ node: child, depth: depth + 1 });
  }
  if (!head) throw new PortableArticleError('排版文章结构无法识别，请重新整理成品后下载。');
  const meta = defaultTreeAdapter.createElement('meta', html.NS.HTML, [{ name: 'http-equiv', value: 'Content-Security-Policy' }, { name: 'content', value: POLICY }]);
  if (head.childNodes[0]) defaultTreeAdapter.insertBefore(head, meta, head.childNodes[0]);
  else defaultTreeAdapter.appendChild(head, meta);
  return Buffer.from(serialize(document), 'utf8');
}
