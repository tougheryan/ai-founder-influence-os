import { readNativeField } from '@/electron/native-xhs-copy.cjs';

/** Reader exports are extracted from a package, never from client-supplied text. */
export type ReadableArticle = { title: string; summary: string; body: string };

export class ReadableArticleError extends Error {
  constructor(message = '这份稿件的标题或正文还无法完整识别。请核对原始文件后重试。', readonly status = 422) {
    super(message);
    this.name = 'ReadableArticleError';
  }
}

function headings(lines: string[]): Array<{ index: number; level: number; title: string }> {
  const result: Array<{ index: number; level: number; title: string }> = [];
  let fence = '';
  for (const [index, line] of lines.entries()) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = '';
      continue;
    }
    if (delimiter) { fence = delimiter[1]; continue; }
    const match = line.match(/^(#{1,6})[ \t]+(.+?)\s*$/);
    if (match) result.push({ index, level: match[1].length, title: match[2] });
  }
  return result;
}

export function readableArticleFromPackage(markdown: string): ReadableArticle {
  let content = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4);
    if (end < 0 || !/^\n---(?:\n|$)/.test(content.slice(end))) throw new ReadableArticleError();
    content = content.slice(end + 4).replace(/^\n/, '');
  }
  content = content.replace(/<!--[\s\S]*?-->/g, '');
  const lines = content.split('\n');
  const structure = headings(lines);
  const articles = structure.filter((heading) => heading.level === 2
    && (/^1\.\s*公众号原生长文$/.test(heading.title) || /^1\.\s*公众号(?:母稿|长文)(?:\s.*)?$/.test(heading.title)));
  if (articles.length !== 1) throw new ReadableArticleError();
  const start = articles[0].index;
  const end = structure.find((heading) => heading.index > start && heading.level <= 2)?.index ?? lines.length;
  const sections = structure.filter((heading) => heading.index > start && heading.index < end && heading.level === 3);
  const bodies = sections.filter((heading) => heading.title === '正文');
  if (bodies.length !== 1) throw new ReadableArticleError();
  const bodyEnd = structure.find((heading) => heading.index > bodies[0].index && heading.level <= 3)?.index ?? end;
  const metadata = lines.slice(start + 1, bodies[0].index).join('\n');
  const field = (label: string) => {
    try { return readNativeField(metadata, [label]); }
    catch { throw new ReadableArticleError('这份稿件含有重复或不明确的标题或摘要。请先核对，再复制或保存。'); }
  };
  const article = { title: field('发布标题'), summary: field('摘要'), body: lines.slice(bodies[0].index + 1, bodyEnd).join('\n').trim() };
  if (!article.title || !article.body) throw new ReadableArticleError();
  return article;
}

export const ARTICLE_DRAFT_NOTICE = '文章草稿 · 尚未排版，使用前请核对。';

/** Match the reader's headings and quotes without interpreting raw HTML. */
export function readableArticleText(article: ReadableArticle): string {
  const body = article.body.split(/\n{2,}/).map((paragraph) => paragraph
    .replace(/^####\s+/, '').replace(/^>\s?/, '')).join('\n\n');
  return [ARTICLE_DRAFT_NOTICE, article.title, ...(article.summary ? [`摘要\n${article.summary}`] : []), body].join('\n\n') + '\n';
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function readableArticleHtml(article: ReadableArticle): string {
  const body = article.body.split(/\n{2,}/).map((paragraph) => {
    if (/^####\s+/.test(paragraph)) {
      const [heading, ...rest] = paragraph.split('\n');
      return `<section><h2>${escapeHtml(heading.replace(/^####\s+/, ''))}</h2>${rest.length ? `<p>${escapeHtml(rest.join('\n'))}</p>` : ''}</section>`;
    }
    if (paragraph.startsWith('>')) return `<blockquote>${escapeHtml(paragraph.replace(/^>\s?/, ''))}</blockquote>`;
    return `<p>${escapeHtml(paragraph)}</p>`;
  }).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(article.title)} · 草稿</title>
<style>body{max-width:760px;margin:40px auto;padding:0 24px;color:#242424;background:#fff;font:17px/1.85 system-ui,sans-serif;overflow-wrap:anywhere}h1{font-size:30px;line-height:1.4}h2{font-size:22px;line-height:1.5;margin-top:32px}p,blockquote{white-space:pre-wrap}blockquote{margin:24px 0;border-left:3px solid #777;padding-left:20px}.draft,.summary{color:#555}.draft{font-size:14px}.summary{border-bottom:1px solid #ddd;padding-bottom:24px}</style></head>
<body><main><p class="draft">${ARTICLE_DRAFT_NOTICE}</p><article><h1>${escapeHtml(article.title)}</h1>${article.summary ? `<p class="summary">${escapeHtml(article.summary)}</p>` : ''}${body}</article></main></body></html>`;
}

export function readableArticleFileName(title: string): string {
  return `${title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').trim() || '文章'}-草稿.html`;
}
