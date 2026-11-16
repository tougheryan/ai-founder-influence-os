import { nativeFieldSpans } from '@/electron/native-xhs-copy.cjs';

/** Text spans are derived from the saved package, never from model-provided offsets. */
export type ContentSection = { id: string; label: string; start: number; end: number; text: string };
export type ContentEditScope = 'section' | 'ending' | 'selection' | 'append';
export type ContentEditTarget = { sectionId: string; scope: ContentEditScope; selection?: string; selectionOffset?: number; endingParagraphs?: number };
export type PublishingIssue = { sectionId: string; label: string; quote: string; message: string; selectionOffset: number };
export type PublishingEditRequest = { path: string; sha256: string; issue: PublishingIssue };
export type ContentSelectionRequest = { path: string; sha256: string; sectionId: string; selection: string; selectionOffset: number };

/** A reader selection must still belong to the exact editor snapshot. */
export function contentSelectionTarget(source: { path: string; sha256: string; sections: ContentSection[] }, request: ContentSelectionRequest): ContentEditTarget {
  const matches = source.sections.filter((section) => section.id === request.sectionId);
  if (request.path !== source.path || !request.sha256 || request.sha256 !== source.sha256 || matches.length !== 1
    || !Number.isSafeInteger(request.selectionOffset) || request.selectionOffset < 0 || !request.selection.trim()
    || request.selection !== request.selection.trim()
    || matches[0].text.slice(request.selectionOffset, request.selectionOffset + request.selection.length) !== request.selection) {
    throw new Error('文章版本或所选文字已变化，请重新读取正文后再选择。已填写的修改保留。');
  }
  return { sectionId: request.sectionId, scope: 'selection', selection: request.selection, selectionOffset: request.selectionOffset };
}

function span(markdown: string, start: number, end: number) {
  const text = markdown.slice(start, end);
  const leading = text.length - text.trimStart().length;
  const trailing = text.length - text.trimEnd().length;
  return { start: start + leading, end: Math.max(start + leading, end - trailing), text: text.trim() };
}

/** Paragraph offsets use the saved text, including its original line endings. */
export function contentParagraphs(text: string) {
  const result: ReturnType<typeof span>[] = [];
  let start = 0;
  for (const separator of text.matchAll(/\r?\n(?:[ \t]*\r?\n)+/g)) {
    const paragraph = span(text, start, separator.index!);
    if (paragraph.text) result.push(paragraph);
    start = separator.index! + separator[0].length;
  }
  const last = span(text, start, text.length);
  if (last.text) result.push(last);
  return result;
}

export function contentEndingSpan(section: ContentSection, count = 1): ContentSection {
  const paragraphs = contentParagraphs(section.text);
  if (!Number.isSafeInteger(count) || count < 1 || count > paragraphs.length) {
    throw new Error('请重新选择结尾的起始段落，范围必须在当前正文中。');
  }
  const offset = paragraphs[paragraphs.length - count].start;
  return { ...section, start: section.start + offset, text: section.text.slice(offset) };
}

/** Only reader-facing fields can be edited; shared facts and runtime bindings stay outside the editor. */
export function contentSections(markdown: string): ContentSection[] {
  const headings = [...markdown.matchAll(/^(#{2,4})[ \t]+([^\n\r]+)\r?$/gm)]
    .map((match) => ({ level: match[1].length, title: match[2].trim(), start: match.index!, end: match.index! + match[0].length }));
  const result: ContentSection[] = [];
  const platformLabels: Record<string, string> = { wechat: '公众号', xhs: '小红书', shipinhao: '视频号' };
  const allowedHeadings = new Set(['正文', '评论区承接', '评论区引导', '封面三句话', '图文卡片脚本', '发布正文', '结尾标签', '逐句口播稿', '分段口播稿', '镜头清单', '字幕重点', 'B-roll 建议', '发布文案']);
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading.level !== 2) continue;
    const platform = /^1\.\s*公众号/.test(heading.title) ? 'wechat'
      : /^2\.\s*小红书/.test(heading.title) ? 'xhs'
        : /^3\.\s*视频号/.test(heading.title) ? 'shipinhao' : '';
    if (!platform) continue;
    const end = headings.slice(index + 1).find((item) => item.level <= 2)?.start ?? markdown.length;
    const children = headings.filter((item) => item.start > heading.start && item.start < end && item.level === 3);
    const metadataEnd = children.find((item) => allowedHeadings.has(item.title))?.start ?? end;
    const metadata = markdown.slice(heading.end, metadataEnd);
    const fields = nativeFieldSpans(metadata, ['发布标题', '摘要', '头图文案', '封面字', '3秒钩子', '3 秒钩子', '建议时长', '时长']);
    const fieldGroup = (label: string) => label === '3 秒钩子' ? '3秒钩子' : label === '时长' ? '建议时长' : label;
    const duplicated = (label: string) => fields.filter((field) => fieldGroup(field.label) === fieldGroup(label)).length > 1;
    // A whole metadata range lets the author explicitly remove conflicting definitions.
    if (fields.some((field) => duplicated(field.label))) {
      result.push({ id: `${platform}:metadata`, label: `${platformLabels[platform]} · 整理重复字段`, ...span(markdown, heading.end, metadataEnd) });
    }
    for (const field of fields) {
      if (duplicated(field.label)) continue;
      result.push({ id: `${platform}:field:${field.label}`, label: `${platformLabels[platform]} · ${field.label}`,
        ...span(markdown, heading.end + field.start, heading.end + field.end) });
    }
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      if (!allowedHeadings.has(child.title)) continue;
      result.push({ id: `${platform}:${child.title}`, label: `${platformLabels[platform]} · ${child.title}`, ...span(markdown, child.end, children[childIndex + 1]?.start ?? end) });
      if (child.title === '发布文案') {
        const publishEnd = children[childIndex + 1]?.start ?? end;
        for (const field of nativeFieldSpans(markdown.slice(child.end, publishEnd), ['简介', '话题', '置顶评论'])) {
          result.push({ id: `${platform}:publish:${field.label}`, label: `${platformLabels[platform]} · ${field.label}`,
            ...span(markdown, child.end + field.start, child.end + field.end) });
        }
      }
    }
  }
  return result;
}

export function contentEditSpan(markdown: string, target: ContentEditTarget): ContentSection {
  if (target.endingParagraphs !== undefined && target.scope !== 'ending') throw new Error('结尾段数只用于修改结尾。');
  if (target.selectionOffset !== undefined && target.scope !== 'selection') throw new Error('原文位置只用于修改指定文字。');
  if (target.scope === 'append' && target.sectionId === 'recovery:append') return { id: target.sectionId, label: '补齐缺少的内容', start: markdown.length, end: markdown.length, text: '' };
  const matches = contentSections(markdown).filter((item) => item.id === target.sectionId);
  if (matches.length !== 1) throw new Error('这部分内容不存在或标题重复，请重新读取并核对当前版本。');
  const section = matches[0];
  if (target.scope === 'section') return section;
  if (target.scope === 'ending') {
    return contentEndingSpan(section, target.endingParagraphs);
  }
  if (target.scope !== 'selection') throw new Error('请选择要修改的范围。');
  const selection = target.selection?.trim() || '';
  if (target.selectionOffset !== undefined) {
    const offset = target.selectionOffset;
    if (!selection || !Number.isSafeInteger(offset) || offset < 0 || section.text.slice(offset, offset + selection.length) !== selection) {
      throw new Error('选中的原文位置已经变化，请重新读取后再修改。');
    }
    return { ...section, start: section.start + offset, end: section.start + offset + selection.length, text: selection };
  }
  const offset = selection ? section.text.indexOf(selection) : -1;
  if (offset < 0 || section.text.indexOf(selection, offset + 1) >= 0) {
    throw new Error('请选取一段能唯一定位的原文；选中文字必须与当前版本一致。');
  }
  return { ...section, start: section.start + offset, end: section.start + offset + selection.length, text: selection };
}

export function applyContentEdit(markdown: string, target: ContentEditTarget, replacement: string): string {
  const selected = contentEditSpan(markdown, target);
  // Preserve every byte outside the selected range. Markdown structure is subsequently validated by the runtime.
  const inserted = target.scope === 'append' && replacement.trim() ? `\n\n${replacement.trim()}` : replacement.trim();
  return markdown.slice(0, selected.start) + inserted + markdown.slice(selected.end);
}

export function inspectPublishingSections(markdown: string): PublishingIssue[] {
  const patterns = [
    { pattern: /(?:本文|本篇|这里).{0,12}(?:能确认|可确认)的事实.{0,12}素材提供者[^。！？\n|]*(?:[。！？]|$)/gm, message: '这句像素材整理说明，请核对读者是否需要。' },
    { pattern: /素材提供者(?:提出|要求|希望|提供)[^。！？\n|]*(?:[。！？]|(?=\||$))/gm, message: '这句用“素材提供者”称呼作者，可能需要换成作者自己的表达。' },
    { pattern: /(?:这里|本文|本篇)(?:不|不会)引导(?:私信|购买|预约)[^。！？\n|]*(?:[。！？]|(?=\||$))/gm, message: '这句可能把“不引导购买”等写作要求写进了内容。' },
    { pattern: /(?:根据|按照)(?:用户|作者)(?:提供的素材|的写作要求|的指令)[^。！？\n|]*(?:[。！？]|(?=\||$))/gm, message: '这句像生成过程说明，请核对是否应出现在读者看到的内容中。' },
  ];
  const findings = contentSections(markdown).filter((section) => !/:(?:镜头清单|B-roll 建议)$/.test(section.id)).flatMap((section) => {
    // Preserve UTF-16 positions while ignoring hidden comments and fenced code.
    const mask = (text: string) => text.replace(/[^\r\n]/g, ' ');
    let visible = section.text.replace(/<!--[\s\S]*?(?:-->|$)/g, mask)
      .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*(?:\n|$)/gm, mask);
    if (section.id === 'xhs:图文卡片脚本') {
      // The required card table starts with page, title and reader text. Visual
      // prompts/layout instructions in subsequent columns are not public copy.
      visible = visible.replace(/^\|[^\n]+\|[ \t]*$/gm, (row) => {
        const pipes = [...row.matchAll(/(?<!\\)\|/g)].map((match) => match.index!);
        return pipes.length >= 5 ? row.slice(0, pipes[3]) + mask(row.slice(pipes[3])) : row;
      });
    }
    return patterns.flatMap(({ pattern, message }) => [...visible.matchAll(pattern)]
      .filter((match) => section.text.slice(match.index!, match.index! + match[0].trimEnd().length) === match[0].trimEnd())
      .map((match) => ({
      sectionId: section.id, label: section.label, quote: match[0].trimEnd(),
      selectionOffset: match.index!, message,
    })));
  });
  return findings.filter((finding, index) => !findings.some((other, otherIndex) => (
    otherIndex !== index && other.sectionId === finding.sectionId && other.selectionOffset <= finding.selectionOffset
    && other.selectionOffset + other.quote.length >= finding.selectionOffset + finding.quote.length
    && (other.quote.length > finding.quote.length || otherIndex < index)
  ))).sort((a, b) => a.sectionId.localeCompare(b.sectionId) || a.selectionOffset - b.selectionOffset);
}

/** A finding from the reader must still refer to the exact editor snapshot. */
export function publishingIssueTarget(source: { path: string; sha256: string; sections: ContentSection[] }, request: PublishingEditRequest): ContentEditTarget {
  const issue = request.issue;
  const matches = source.sections.filter((section) => section.id === issue.sectionId);
  if (request.path !== source.path || !request.sha256 || request.sha256 !== source.sha256 || matches.length !== 1
    || !Number.isSafeInteger(issue.selectionOffset) || issue.selectionOffset < 0 || !issue.quote
    || matches[0].text.slice(issue.selectionOffset, issue.selectionOffset + issue.quote.length) !== issue.quote) {
    throw new Error('文章版本已变化，请重新读取正文后再定位这句话。已填写的修改保留。');
  }
  return { sectionId: issue.sectionId, scope: 'selection', selection: issue.quote, selectionOffset: issue.selectionOffset };
}
