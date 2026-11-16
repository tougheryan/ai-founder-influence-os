import type { ContentSection } from './content-editing';
import type { ReaderTextRange } from './reader-selection';

export type ContentReaderBinding = { section: ContentSection; range?: ReaderTextRange };
export type ReaderTableRow = Record<string, { text: string; binding: ContentReaderBinding }>;
const visible = (text: string) => text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
const maskComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ' '));

export function uniqueReaderSection(sections: ContentSection[], id: string): ContentSection | undefined {
  const matches = sections.filter((section) => section.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Display fragments retain offsets into the whole editable source section. */
function fragment(section: ContentSection, start: number, end: number) {
  const raw = section.text.slice(start, end);
  const left = raw.length - raw.trimStart().length;
  const right = raw.length - raw.trimEnd().length;
  return { text: visible(raw), binding: { section, range: { start: start + left, end: end - right } } };
}

function readerField(section: ContentSection | undefined, label: string) {
  if (!section) return undefined;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const masked = maskComments(section.text);
  const matches = [...masked.matchAll(new RegExp(`^([ \\t]*[-*][ \\t]*(?:\\*\\*)?${escaped}(?:\\*\\*)?[ \\t]*[：:][ \\t]*)([^\\r\\n]*)`, 'gm'))];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const start = match.index + match[1].length;
  const next = masked.slice(start).search(/^(?:[ \t]*[-*][ \t]+(?:\*\*)?[\w\u4e00-\u9fff /-]{1,32}(?:\*\*)?[：:]|#{1,6}[ \t]+)/m);
  return fragment(section, start, next < 0 ? section.text.length : start + next);
}

export function readerFieldText(text: string, label: string): string {
  return readerField({ id: '', label: '', text, start: 0, end: text.length }, label)?.text || '';
}

export function readerFieldBinding(section: ContentSection | undefined, label: string, expected: string): ContentReaderBinding | undefined {
  const value = readerField(section, label);
  return expected && value?.text === expected ? value.binding : undefined;
}

/** Tables are selectable only when their headers and source cells are unambiguous. */
export function readerTableRows(section: ContentSection | undefined): ReaderTableRow[] {
  if (!section) return [];
  const lines = [...maskComments(section.text).matchAll(/^[ \t]*\|[^\r\n]*\|[ \t]*\r?$/gm)];
  if (lines.length < 3 || lines.some(([line]) => line.includes('\\|') || line.includes('<!--'))) return [];
  const cells = lines.map((line) => [...line[0].matchAll(/\|([^|]*)/g)]
    .slice(0, -1).map((cell) => fragment(section, line.index + cell.index + 1, line.index + cell.index + cell[0].length)));
  const headers = cells[0].map((cell) => cell.text);
  if (!headers.length || headers.some((header) => !header) || new Set(headers).size !== headers.length
    || cells.some((row) => row.length !== headers.length)
    || !cells[1].every((cell) => /^:?-{2,}:?$/.test(cell.text))
    || cells.slice(2).some((row) => row.every((cell) => /^:?-{2,}:?$/.test(cell.text)))) return [];
  return cells.slice(2).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}
