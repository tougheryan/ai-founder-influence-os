import { type ContentSection, type ContentSelectionRequest } from './content-editing';

export type ReaderTextRun = { kind: 'heading' | 'paragraph' | 'quote'; text: string; starts: number[]; ends: number[] };
export type ReaderTextPoint = { run: number; offset: number };
export type ReaderTextRange = { start: number; end: number };

/** Mirror the article reader while retaining original UTF-16 positions, including CRLF. */
export function readerTextRuns(source: string, range?: ReaderTextRange): ReaderTextRun[] {
  const from = range?.start ?? 0, until = range?.end ?? source.length;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || from < 0 || until > source.length || from >= until) return [];
  let text = '';
  const starts: number[] = [], ends: number[] = [];
  for (let index = from; index < until;) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end >= 0 && end + 3 <= until) { index = end + 3; continue; }
    }
    const size = source.startsWith('\r\n', index) ? 2 : 1;
    text += source[index] === '\r' ? '\n' : source[index];
    starts.push(index); ends.push(index + size); index += size;
  }
  const runs: ReaderTextRun[] = [];
  const add = (kind: ReaderTextRun['kind'], from: number, to: number) => {
    if (to > from) runs.push({ kind, text: text.slice(from, to), starts: starts.slice(from, to), ends: ends.slice(from, to) });
  };
  for (const block of text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)) {
    const left = block[0].length - block[0].trimStart().length;
    const value = block[0].trim();
    if (!value) continue;
    const from = block.index + left, to = from + value.length;
    const heading = /^####\s+/.exec(value);
    if (heading) {
      const newline = text.indexOf('\n', from + heading[0].length);
      const end = newline < 0 || newline >= to ? to : newline;
      add('heading', from + heading[0].length, end);
      if (end < to) add('paragraph', end + 1, to);
    } else {
      const quote = /^>\s?/.exec(value);
      add(quote ? 'quote' : 'paragraph', from + (quote?.[0].length || 0), to);
    }
  }
  return runs;
}

/** Use positions rather than indexOf: identical sentences remain distinct. */
export function readerSelectionRequest(snapshot: { path: string; sha256: string; section: ContentSection }, runs: ReaderTextRun[], start: ReaderTextPoint, end: ReaderTextPoint): ContentSelectionRequest {
  const first = runs[start.run], last = runs[end.run];
  if (!/^[a-f0-9]{64}$/.test(snapshot.sha256) || !first || !last
    || !Number.isSafeInteger(start.offset) || !Number.isSafeInteger(end.offset)
    || start.offset < 0 || start.offset >= first.text.length || end.offset < 1 || end.offset > last.text.length
    || start.run > end.run || (start.run === end.run && start.offset >= end.offset)) throw new Error('请在当前正文中选择要修改的文字。');
  let from = first.starts[start.offset];
  const to = last.ends[end.offset - 1];
  const raw = snapshot.section.text.slice(from, to);
  if (raw.includes('<!--')) throw new Error('所选范围包含隐藏说明，请选择不跨过说明的文字。');
  from += raw.length - raw.trimStart().length;
  const selection = raw.trim();
  if (!selection) throw new Error('请先选中正文中的文字。');
  return { path: snapshot.path, sha256: snapshot.sha256, sectionId: snapshot.section.id, selection, selectionOffset: from };
}
