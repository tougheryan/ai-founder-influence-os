import type { OutputDisclosure } from './output-disclosure';

/** Plain text only: safe to show through React or to put in an archive's readme. */
export function disclosureNotice(disclosure: OutputDisclosure): string {
  if (disclosure.status === 'no_whole_draft_limit') return '';

  const introduction = {
    internal_only: '仅供内部预览\n本期材料设有整期公开限制。请保留此说明，核对并调整限制后再对外使用。',
    restricted_details: '含局部公开限制，请逐项核对\n部分细节设有公开限制。请核对限制原文，完成隐去、替换或授权确认后再对外使用。',
    unverified: '公开限制待核对 · 仅供内部预览\n当前未能核对这份内容与素材的公开限制。核对完成前请勿对外使用。',
  }[disclosure.status];
  const restrictions = disclosure.restrictions.filter((restriction) => restriction.trim());
  return restrictions.length
    ? `${introduction}\n\n下列原句可能含有不能公开的细节，仅供作者及有权查看原素材的人核对；本说明不会自动隐去这些细节。\n限制原文：\n${restrictions.map((restriction) => `- ${restriction}`).join('\n')}`
    : introduction;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeMarkdown(value: string): string {
  return escapeHtml(value).replace(/[\\`*_{}[\]()#+.!|~\-]/g, '\\$&');
}

/** Find markup rather than a body-looking string inside a comment or script. */
function htmlNoticeOffset(content: string): number {
  const tags = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  const rawText = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);
  let templateDepth = 0;
  let htmlEnd = 0;
  let headEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(content))) {
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    const closing = match[0].startsWith('</');
    if (tag === 'template') {
      templateDepth = Math.max(0, templateDepth + (closing ? -1 : 1));
      continue;
    }
    if (!closing && rawText.has(tag)) {
      const end = new RegExp(`</${tag}\\s*>`, 'gi');
      end.lastIndex = tags.lastIndex;
      const close = end.exec(content);
      if (!close) break;
      tags.lastIndex = end.lastIndex;
      continue;
    }
    if (templateDepth) continue;
    if (tag === 'body' && !closing) return tags.lastIndex;
    if (tag === 'html' && !closing) htmlEnd = tags.lastIndex;
    if (tag === 'head' && closing) headEnd = tags.lastIndex;
  }
  // An HTML document without a body tag has an implicit body after its head.
  return headEnd || htmlEnd;
}

/** Marks an export copy; the supplied source is never edited or truncated. */
export function markExportText(content: string, extension: string, disclosure: OutputDisclosure): string {
  const notice = disclosureNotice(disclosure);
  if (!notice) return content;
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (ext === 'html' || ext === 'htm') {
    const block = `\n<aside data-echo-founder-export-notice="true" role="note" style="display:block;border:2px solid #945400;padding:16px;margin:16px 0;background:#fff8e7;color:#422900;font:16px/1.6 sans-serif;white-space:pre-wrap"><strong>导出使用说明</strong>\n${escapeHtml(notice)}</aside>\n`;
    const offset = htmlNoticeOffset(content);
    return content.slice(0, offset) + block + content.slice(offset);
  }
  if (ext === 'md' || ext === 'markdown') {
    const block = notice.split(/\r?\n/).map((line) => `> ${escapeMarkdown(line)}`).join('\n');
    return `> **导出使用说明**\n>\n${block}\n\n---\n\n${content}`;
  }
  if (ext === 'txt') return `【导出使用说明】\n${notice}\n\n--------------------\n\n${content}`;
  return content;
}
