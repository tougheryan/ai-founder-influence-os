import { describe, expect, it } from 'vitest';
import { applyContentEdit, contentSections, contentSelectionTarget } from './content-editing';
import { readerSelectionRequest, readerTextRuns } from './reader-selection';
import { readerFieldBinding, readerTableRows, uniqueReaderSection } from './content-reader-bindings';

const hash = 'a'.repeat(64);
const body = '#### 先确认范围\r\n先问清楚😀，再报价。\r\n\r\n> 先问清楚😀，再报价。\r\n\r\n最后一句。';
const raw = '# 内容包\r\n\r\n## 1. 公众号原生长文\r\n- 发布标题：范围与报价\r\n\r\n### 正文\r\n\r\n' + body + '\r\n\r\n### 评论区引导\r\n保留评论。';
const section = contentSections(raw).find((value) => value.id === 'wechat:正文')!;
const snapshot = { path: 'pipeline/package/test.md', sha256: hash, section };
const runs = readerTextRuns(section.text);

describe('native platform field and cell selections', () => {
  const raw = '## 2. 小红书原生图文\r\n### 图文卡片脚本\r\n| 页码 | 页面任务 | 页面标题 | 页面正文 | 视觉提示 |\r\n|---|---|---|---|---|\r\n| P1 | 开场 | 标题一 | 先确认😀范围。 | 画面一 |\r\n| P2 | 展开 | 标题二 | 先确认😀范围。 | 画面二 |\r\n\r\n### 发布正文\r\n- 标题：先确认😀范围。\r\n- 正文：先确认😀范围。\r\n- 结尾问题：哪里不清楚？\r\n\r\n## 3. 视频号原生口播\r\n### 逐句口播稿\r\n| 时间段 | 口播文案 | 屏幕字幕 | 对应画面 |\r\n|---|---|---|---|\r\n| 0–5秒 | 先确认😀范围。 | 范围 | 画面一 |\r\n| 5–10秒 | 先确认😀范围。 | 范围 | 画面二 |';
  const sections = contentSections(raw);
  it.each(['xhs:图文卡片脚本', 'shipinhao:逐句口播稿'])('maps the second identical table cell in %s without changing other cells', (id) => {
    const section = uniqueReaderSection(sections, id)!;
    const cell = readerTableRows(section)[1][id.startsWith('xhs') ? '页面正文' : '口播文案'];
    const runs = readerTextRuns(section.text, cell.binding.range);
    expect(runs[0].text).toBe('先确认😀范围。');
    const request = readerSelectionRequest({ ...snapshot, section }, runs, {run: 0, offset: 0}, {run: 0, offset: runs[0].text.length});
    const target = contentSelectionTarget({ ...snapshot, sections }, request);
    const offset = section.start + request.selectionOffset;
    const changed = applyContentEdit(raw, target, '先列出两种选择。');
    expect(changed).toBe(raw.slice(0, offset) + '先列出两种选择。' + raw.slice(offset + request.selection.length));
    expect(changed).toContain('先确认😀范围。');
    expect(changed).toContain('画面二');
  });
  it('binds publish copy to its field, without matching an identical title', () => {
    const section = uniqueReaderSection(sections, 'xhs:发布正文')!;
    const binding = readerFieldBinding(section, '正文', '先确认😀范围。')!;
    const runs = readerTextRuns(section.text, binding.range);
    const request = readerSelectionRequest({ ...snapshot, section }, runs, {run:0,offset:0}, {run:0,offset:runs[0].text.length});
    expect(applyContentEdit(raw, contentSelectionTarget({ ...snapshot, sections }, request), '新的正文。')).toContain('- 标题：先确认😀范围。\r\n- 正文：新的正文。\r\n- 结尾问题：哪里不清楚？');
  });
  it('keeps multiline publishing copy selectable without including the following question', () => {
    const section = {id:'xhs:发布正文',label:'正文',start:0,end:100,text:'- 标题：标题\r\n- 正文：第一段。\r\n\r\n第二段。\r\n- 结尾问题：问题？'};
    const binding = readerFieldBinding(section,'正文','第一段。\n\n第二段。')!;
    const runs=readerTextRuns(section.text,binding.range);
    expect(runs.map((run)=>run.text)).toEqual(['第一段。','第二段。']);
    const request=readerSelectionRequest({...snapshot,section},runs,{run:1,offset:0},{run:1,offset:4});
    expect(request.selection).toBe('第二段。');
  });
  it('refuses duplicate fields, duplicate sections and a display value that no longer matches', () => {
    const section = uniqueReaderSection(sections, 'xhs:发布正文')!;
    expect(readerFieldBinding({...section,text:section.text+'\r\n- 正文：先确认😀范围。'},'正文','先确认😀范围。')).toBeUndefined();
    expect(readerFieldBinding(section,'正文','过期正文')).toBeUndefined();
    expect(uniqueReaderSection([...sections,section],section.id)).toBeUndefined();
  });
  it.each(['| A | A |\n|---|---|\n| 1 | 2 |', '| A | B |\n|---|---|\n| 1 | 2 | 3 |', '| A | B |\n|---|---|\n| 1 \\| 2 | 3 |'])('does not create editable cells for an ambiguous table', (text) => {
    expect(readerTableRows({ ...section, text })).toEqual([]);
  });
  it('does not reveal adjacent table syntax or field labels when rendering a fragment', () => {
    expect(readerTextRuns('标签：正文。下一字段。',{start:3,end:6}).map((run)=>run.text)).toEqual(['正文。']);
    expect(readerTextRuns('正文',{start:-1,end:2})).toEqual([]);
  });
  it('ignores rows and fields inside multiline hidden comments without shifting visible positions', () => {
    const section = {id:'xhs:发布正文',label:'正文',start:0,end:100,text:'<!--\n- 正文：不能显示\n-->\n- 正文：公开文字'};
    const binding = readerFieldBinding(section,'正文','公开文字')!;
    expect(section.text.slice(binding.range!.start,binding.range!.end)).toBe('公开文字');
    const table = {...section,text:'<!--\n| A | B |\n|---|---|\n| 内部 | 不能显示 |\n-->\n| A | B |\n|---|---|\n| 公开 | 可选择 |'};
    const rows=readerTableRows(table);
    expect(rows).toHaveLength(1);
    expect(rows[0].B.text).toBe('可选择');
    expect(table.text.slice(rows[0].B.binding.range!.start,rows[0].B.binding.range!.end)).toBe('可选择');
  });
});

describe('mapping reader selections to original source', () => {
  it('renders headings and quotes without exposing their prefixes, keeping original offsets', () => {
    expect(runs.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'heading', text: '先确认范围' }, { kind: 'paragraph', text: '先问清楚😀，再报价。' },
      { kind: 'quote', text: '先问清楚😀，再报价。' }, { kind: 'paragraph', text: '最后一句。' },
    ]);
    expect(section.text.slice(runs[2].starts[0], runs[2].ends.at(-1))).toBe(runs[2].text);
  });
  it('edits the second identical sentence and preserves every byte outside the selection', () => {
    const request = readerSelectionRequest(snapshot, runs, { run: 2, offset: 0 }, { run: 2, offset: runs[2].text.length });
    const target = contentSelectionTarget({ ...snapshot, sections: [section] }, request);
    const changed = applyContentEdit(raw, target, '先列出选项，再讨论费用。');
    const start = section.start + request.selectionOffset;
    expect(changed).toBe(raw.slice(0, start) + '先列出选项，再讨论费用。' + raw.slice(start + request.selection.length));
    expect(changed).toContain('先问清楚😀，再报价。\r\n\r\n> 先列出选项，再讨论费用。');
    expect(changed).toContain('### 评论区引导\r\n保留评论。');
  });
  it('keeps exact CRLF and markdown within a multi-paragraph selection', () => {
    const request = readerSelectionRequest(snapshot, runs, { run: 1, offset: 0 }, { run: 2, offset: runs[2].text.length });
    expect(request.selection).toBe('先问清楚😀，再报价。\r\n\r\n> 先问清楚😀，再报价。');
    expect(contentSelectionTarget({ ...snapshot, sections: [section] }, request).scope).toBe('selection');
  });
  it('handles emoji positions as browser UTF-16 offsets', () => {
    const start = runs[1].text.indexOf('😀');
    expect(readerSelectionRequest(snapshot, runs, { run: 1, offset: start }, { run: 1, offset: start + 2 }).selection).toBe('😀');
  });
  it('normalizes a selected line break only for display, keeping source line endings', () => {
    const source = { ...section, text: '第一行\r\n第二行' };
    const mapped = readerTextRuns(source.text);
    expect(mapped[0].text).toBe('第一行\n第二行');
    expect(readerSelectionRequest({ ...snapshot, section: source }, mapped, { run: 0, offset: 0 }, { run: 0, offset: mapped[0].text.length }).selection).toBe(source.text);
  });
  it('trims selected outer whitespace while adjusting the actual source offset', () => {
    const source = { ...section, text: '开头。  中间一句。  结尾。' };
    const mapped = readerTextRuns(source.text);
    const request = readerSelectionRequest({ ...snapshot, section: source }, mapped, { run: 0, offset: 3 }, { run: 0, offset: 12 });
    expect(source.text.slice(request.selectionOffset, request.selectionOffset + request.selection.length)).toBe(request.selection);
    expect(request.selection).toBe(request.selection.trim());
  });
  it('does not silently remove hidden comments selected across visible text', () => {
    const source = { ...section, text: '前句。<!-- 内部备注 -->后句。' };
    const mapped = readerTextRuns(source.text);
    expect(mapped[0].text).toBe('前句。后句。');
    expect(() => readerSelectionRequest({ ...snapshot, section: source }, mapped, { run: 0, offset: 0 }, { run: 0, offset: 6 })).toThrow('隐藏说明');
    expect(readerSelectionRequest({ ...snapshot, section: source }, mapped, { run: 0, offset: 3 }, { run: 0, offset: 6 }).selection).toBe('后句。');
  });
  it.each([
    [{ run: 0, offset: -1 }, { run: 0, offset: 2 }],
    [{ run: 0, offset: 0 }, { run: 0, offset: 0 }],
    [{ run: 1, offset: 0 }, { run: 0, offset: 2 }],
    [{ run: 0, offset: 0 }, { run: 99, offset: 2 }],
  ])('rejects invalid selection boundaries', (start, end) => {
    expect(() => readerSelectionRequest(snapshot, runs, start, end)).toThrow();
  });
  it('refuses stale snapshots, changed text, duplicate sections and cross-package requests', () => {
    const request = readerSelectionRequest(snapshot, runs, { run: 1, offset: 0 }, { run: 1, offset: 4 });
    const source = { path: snapshot.path, sha256: hash, sections: [section] };
    expect(() => contentSelectionTarget(source, { ...request, path: 'pipeline/package/other.md' })).toThrow();
    expect(() => contentSelectionTarget({ ...source, sha256: 'b'.repeat(64) }, request)).toThrow();
    expect(() => contentSelectionTarget({ ...source, sections: [section, section] }, request)).toThrow();
    expect(() => contentSelectionTarget(source, { ...request, selectionOffset: 0 })).toThrow();
    expect(() => contentSelectionTarget(source, { ...request, selection: '我没有选过的文字' })).toThrow();
  });
});
