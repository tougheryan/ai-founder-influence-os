import { readNativeXhsCopy } from '@/electron/native-xhs-copy.cjs';
import { contentSections } from './content-editing';
import { uniqueReaderSection } from './content-reader-bindings';

export const PUBLICATION_TEXT_FIELDS = ['xhs-title', 'xhs-body', 'video-title', 'video-spoken'] as const;
export type PublicationTextField = typeof PUBLICATION_TEXT_FIELDS[number];
export class PublicationTextError extends Error {
  constructor(message = '这份文案还不能完整识别，请回到正文核对后重试。', readonly status = 422) { super(message); }
}
export type SpokenSegment = { time: string; words: string; subtitle: string; picture: string };

function cells(line: string): string[] {
  if (!line.startsWith('|') || !line.endsWith('|')) throw new PublicationTextError();
  const result: string[] = []; let cell = '';
  for (let index = 1; index < line.length; index++) {
    const char = line[index];
    if (char === '\\' && ['|', '\\'].includes(line[index + 1])) { cell += line[++index]; continue; }
    if (char === '|') { result.push(cell.trim().replace(/<br\s*\/?\s*>/gi, '\n')); cell = ''; }
    else cell += char;
  }
  if (cell) throw new PublicationTextError();
  return result;
}

/** The spoken column is copied verbatim; timing, captions and camera directions are separate. */
export function spokenScript(raw: string): { text: string; segments: SpokenSegment[] } {
  const visible = raw.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim();
  if (!visible || /^[ \t]*(`{3,}|~{3,})/m.test(visible)) throw new PublicationTextError();
  const lines = visible.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.some((line) => line.startsWith('|'))) return { text: visible, segments: [] };
  if (lines.some((line) => !line.startsWith('|') || !line.endsWith('|'))) throw new PublicationTextError('口播表格旁还有其他文字，请先把要念的内容整理到口播文案中。');
  const rows = lines.map(cells); const headers = rows[0];
  if (rows.length < 3 || !headers.includes('口播文案') || headers.some((header) => !header)
    || headers.some((header) => !['时间段', '口播文案', '屏幕字幕', '对应画面'].includes(header))
    || new Set(headers).size !== headers.length || rows.some((row) => row.length !== headers.length)
    || !rows[1].every((value) => /^:?-{2,}:?$/.test(value))) throw new PublicationTextError();
  const segments = rows.slice(2).map((row) => {
    if (row.every((value) => /^:?-{2,}:?$/.test(value))) throw new PublicationTextError();
    const value = (name: string) => row[headers.indexOf(name)] || '';
    if (!value('口播文案')) throw new PublicationTextError('有一段口播文案为空，请核对后再复制。');
    return { time: value('时间段'), words: value('口播文案'), subtitle: value('屏幕字幕'), picture: value('对应画面') };
  });
  return { text: segments.map((segment) => segment.words).join('\n\n'), segments };
}

export function publicationTextFromPackage(markdown: string, field: PublicationTextField): string {
  if (field === 'xhs-title' || field === 'xhs-body') {
    const copy = readNativeXhsCopy(markdown);
    return field === 'xhs-title' ? copy.title : copy.text;
  }
  const visible = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  if (/^[ \t]*(`{3,}|~{3,})/m.test(visible)
    || [...visible.matchAll(/^##[ \t]+3\.[ \t]*视频号原生口播[ \t]*$/gm)].length !== 1) throw new PublicationTextError();
  const sections = contentSections(visible);
  if (field === 'video-title') {
    const title = uniqueReaderSection(sections, 'shipinhao:field:发布标题')?.text;
    if (!title || title.includes('\n')) throw new PublicationTextError();
    return title;
  }
  const section = uniqueReaderSection(sections, 'shipinhao:逐句口播稿');
  if (!section) throw new PublicationTextError();
  return spokenScript(section.text).text;
}
