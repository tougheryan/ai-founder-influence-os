import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContentRevisionComparison, ContentRevisionHistory, revisionCandidateBlocker, revisionHistorySelection, endingRevisionSection, RevisionReviewFindings, inlineRevisionPreview, InlineRevisionInput } from './ContentRevisionEditor';
import { compareRevisionReview } from '@/lib/content-revision-review';

describe('local revision review comparison', () => {
  it('retains inherited whole-article checks, counts new duplicate findings, and keeps changed claims new', () => {
    const before = { issues: ['必须补充来源'], warnings: ['公众号正文当前约 600 字；按本篇要求核对。', '需核对10%的说法', '句子有问题'] };
    const after = { issues: ['必须补充来源', '新增隐私问题'], warnings: ['公众号正文当前约 620 字；按本篇要求核对。', '需核对20%的说法', '句子有问题', '句子有问题'] };
    const comparison = compareRevisionReview(before, after);
    expect(comparison.existingWarnings).toEqual([after.warnings[0], '句子有问题']);
    expect(comparison.newWarnings).toEqual(['需核对20%的说法', '句子有问题']);
    expect(comparison.existingIssues).toEqual(['必须补充来源']);
    expect(comparison.newIssues).toEqual(['新增隐私问题']);
    const html = renderToStaticMarkup(<RevisionReviewFindings record={{ ...after, reviewComparison: comparison }} />);
    expect(html).toContain('原稿已有的整篇检查项');
    expect(html).toContain('原稿也有的同类问题，采用前仍需处理');
    expect(html).toContain('新增隐私问题');
    expect(html).not.toContain('<details open');
  });
  it('does not invent a before/after comparison for old records or retain resolved warnings', () => {
    expect(compareRevisionReview({ issues: [], warnings: ['已解决'] }, { issues: [], warnings: [] }).existingWarnings).toEqual([]);
    const html = renderToStaticMarkup(<RevisionReviewFindings record={{ issues: [], warnings: ['旧检查'] }} />);
    expect(html).toContain('旧记录未与原稿比较');
    expect(html).not.toContain('原稿已有的整篇检查项');
  });
});

describe('revision result display', () => {
  it('does not represent a missing model result as a deletion', () => {
    const html = renderToStaticMarkup(<ContentRevisionComparison record={{ mode: 'model', original: '原结尾', replacement: '' }} />);
    expect(html).toContain('原结尾');
    expect(html).toContain('尚未生成修改，原稿保留');
    expect(html).not.toContain('删除选中文字');
  });
  it('retains an explicitly empty manual edit as a deletion', () => {
    const html = renderToStaticMarkup(<ContentRevisionComparison record={{ mode: 'manual', original: '原结尾', replacement: '' }} />);
    expect(html).toContain('删除选中文字');
    expect(html).not.toContain('尚未生成');
  });
  it('shows retained text even if a later validation or save failed', () => {
    const html = renderToStaticMarkup(<ContentRevisionComparison record={{ mode: 'model', original: '原结尾', replacement: '已生成但还未采用的结尾' }} />);
    expect(html).toContain('已生成但还未采用的结尾');
    expect(html).not.toContain('尚未生成');
  });
});

describe('the ending action uses reader-facing body text', () => {
  const section = (id: string, text = '第一段。\n\n最后一段。') => ({ id, label: id, text, start: 0, end: text.length });
  it('does not fall back to a title in a single-platform article', () => {
    for (const [platform, body] of [['xhs', '发布正文'], ['shipinhao', '逐句口播稿'], ['wechat', '正文']]) {
      const title = section(`${platform}:field:发布标题`);
      const article = section(`${platform}:${body}`);
      expect(endingRevisionSection([title, article], title.id)).toBe(article);
      expect(endingRevisionSection([title, article], 'wechat:正文')).toBe(article);
    }
  });
  it('keeps the selected platform and refuses to treat metadata as a body', () => {
    const wechat = section('wechat:正文');
    const video = section('shipinhao:逐句口播稿');
    expect(endingRevisionSection([wechat, video], 'shipinhao:field:发布标题')).toBe(video);
    expect(endingRevisionSection([section('xhs:field:发布标题')], 'xhs:field:发布标题')).toBeUndefined();
  });
});


describe('current version, preview and history', () => {
  type Record = Parameters<typeof revisionHistorySelection>[0][number];
  const source = { path: 'pipeline/package/current.md', sha256: 'current-hash', materialCorrectionId: 'material-1', sections: [], issues: [], plan: {
    path: 'pipeline/blueprint/current.md', sha256: 'plan-hash', brief: { audience: '', point: '', structure: '', ending: '' },
  } };
  const candidate = (id: string, extra: Partial<Record> = {}): Record => ({
    schema: 'echo.content-revision.v1', id, runId: 'run-a', basePath: source.path, baseSha256: source.sha256,
    materialCorrectionId: source.materialCorrectionId, target: { sectionId: 'wechat:正文', scope: 'ending' },
    label: '公众号结尾', original: '原结尾', instruction: '', replacement: '新的结尾', mode: 'manual',
    status: 'ready', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', issues: [], warnings: [], ...extra,
  });
  const render = (records: Record[], currentSource: typeof source | null = source) => renderToStaticMarkup(<ContentRevisionHistory
    records={records} source={currentSource} selectedId={null} onSelect={() => {}} onAction={() => {}} onContinue={() => {}} />);

  it('keeps an old failure and shelved preview out of the active preview without hiding their history', () => {
    const records = [candidate('new'), candidate('shelved', { archivedAt: '2026-09-22T01:00:00Z' }), candidate('failed', { status: 'failed' }),
      candidate('current', { status: 'adopted', adoptedPath: source.path, adoptedSha256: source.sha256 })];
    const group = revisionHistorySelection(records, source, null);
    expect(group.preview?.id).toBe('new'); expect(group.current?.id).toBe('current');
    expect(group.history.map((record) => record.id)).toEqual(['shelved', 'failed']);
    const html = render(records);
    expect(html).toContain('修改预览 · 待采用');
    expect(html).toContain('历史记录（2）');
    expect(html).not.toContain('有未完成的修改');
    expect(html).toContain('恢复到待选');
    expect(revisionHistorySelection(records, source, 'failed').preview?.id).toBe('failed');
    expect(revisionHistorySelection(records, source, 'shelved').preview).toBeUndefined();
  });

  it('does not make an archived ready result adoptable or call a non-current version the current article', () => {
    const html = render([candidate('archived', { archivedAt: '2026-09-22T01:00:00Z' })]);
    expect(html).toContain('当前没有正在查看的修改'); expect(html).not.toContain('采用这次修改');
    expect(html).toContain('恢复到待选');
    expect(revisionHistorySelection([candidate('other', { status: 'adopted', adoptedPath: source.path, adoptedSha256: 'different' })], source, null).current).toBeUndefined();
  });

  it('explains article, material and plan drift and disables adoption before the server recheck', () => {
    for (const [extra, message] of [
      [{ basePath: 'pipeline/package/old.md' }, '原稿已更新'], [{ baseSha256: 'other' }, '原稿已更新'],
      [{ materialCorrectionId: 'old' }, '素材整理结果已修正'],
      [{ planBinding: { path: source.plan.path, sha256: 'old' } }, '写作方案已更新'],
    ] as [Partial<Record>, string][]) {
      const record = candidate('old', extra);
      expect(revisionCandidateBlocker(record, source)).toContain(message);
      expect(render([record])).toMatch(/<button[^>]*disabled=""[^>]*>采用这次修改/);
    }
    expect(revisionCandidateBlocker(candidate('ok', { planBinding: source.plan }), source)).toBeUndefined();
    expect(revisionCandidateBlocker(candidate('ok'), null)).toContain('正在核对');
    // Unbound legacy candidates remain valid if the exact original and material match.
    expect(render([candidate('ok')])).not.toMatch(/<button[^>]*disabled=""[^>]*>采用这次修改/);
  });

  it('offers incremental browsing for every older record instead of expanding all comparisons', () => {
    const html = render(Array.from({ length: 37 }, (_, index) => candidate(`id-${index}`)));
    expect(html).toContain('历史记录（36）');
    expect(html).toContain('再看 10 条历史记录（还有 26 条）');
    expect(html.match(/查看这次预览/g)).toHaveLength(10);
  });

  it('does not replace a dismissed preview with an earlier pending edit, including after reopening', () => {
    const older = candidate('older', { replacement: '较早的改法' });
    const latest = candidate('latest', { replacement: '刚才的改法' });
    expect(revisionHistorySelection([latest, older], source, latest.id).preview).toBe(latest);
    const dismissed = { ...latest, archivedAt: '2026-09-30T10:00:00Z' };
    for (const selectedId of [latest.id, null]) {
      const result = revisionHistorySelection([dismissed, older], source, selectedId);
      expect(result.preview).toBeUndefined();
      expect(result.history.map((record) => record.id)).toEqual(['latest', 'older']);
    }
    expect(render([dismissed, older])).toContain('当前没有正在查看的修改');
    expect(revisionHistorySelection([dismissed, older], source, older.id).preview).toBe(older);
    expect(revisionHistorySelection([latest, older], source, latest.id).preview).toBe(latest);
  });

  it.each(['adopted', 'reverted'] as const)('keeps older pending edits in history after the latest attempt is %s', (status) => {
    const latest = candidate('latest', { status, adoptedPath: source.path, adoptedSha256: source.sha256, revertedPath: source.path });
    const older = candidate('older');
    const group = revisionHistorySelection([latest, older], source, null);
    expect(group.current).toBe(latest);
    expect(group.preview).toBeUndefined();
    expect(group.history).toEqual([older]);
  });

  it('does not switch to another candidate when the explicitly selected record disappears', () => {
    expect(revisionHistorySelection([candidate('other')], source, 'missing').preview).toBeUndefined();
  });

  it('still shows the newest running or failed attempt and allows explicitly restored older candidates', () => {
    const older = candidate('older');
    for (const status of ['queued', 'running', 'failed'] as const) {
      expect(revisionHistorySelection([candidate('latest', { status }), older], source, null).preview?.id).toBe('latest');
    }
    const dismissed = candidate('latest', { archivedAt: '2026-09-30T10:00:00Z' });
    expect(revisionHistorySelection([dismissed, older], source, older.id).preview).toBe(older);
  });
});

describe('editing a paragraph beside the original', () => {
  type Record = Parameters<typeof inlineRevisionPreview>[0][number];
  const selection = { path: 'pipeline/package/current.md', sha256: 'current-hash', sectionId: 'wechat:正文', selection: '同一句话。', selectionOffset: 53 };
  const candidate: Record = {
    schema: 'echo.content-revision.v1', id: 'current-preview', runId: 'run-a', basePath: selection.path, baseSha256: selection.sha256,
    target: { sectionId: selection.sectionId, scope: 'selection', selection: selection.selection, selectionOffset: selection.selectionOffset },
    label: '公众号选段', original: selection.selection, instruction: '', replacement: '这次只改第二处。', mode: 'manual',
    status: 'ready', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', issues: [], warnings: [],
  };

  it('requires an explicit preview from the same occurrence in the same article version', () => {
    expect(inlineRevisionPreview([candidate], null, selection)).toBeUndefined();
    expect(inlineRevisionPreview([candidate], candidate.id, null)).toBeUndefined();
    expect(inlineRevisionPreview([candidate], 'missing-id', selection)).toBeUndefined();
    expect(inlineRevisionPreview([candidate], candidate.id, selection)).toBe(candidate);
    for (const changedSelection of [
      { ...selection, path: 'pipeline/package/earlier.md' }, { ...selection, sha256: 'different-hash' },
      { ...selection, sectionId: 'xhs:发布正文' }, { ...selection, selection: '不同的话。' },
      { ...selection, selectionOffset: 0 },
    ]) expect(inlineRevisionPreview([candidate], candidate.id, changedSelection)).toBeUndefined();
    expect(inlineRevisionPreview([{ ...candidate, target: { ...candidate.target, selectionOffset: undefined } }], candidate.id, selection)).toBeUndefined();
    expect(inlineRevisionPreview([{ ...candidate, target: { ...candidate.target, scope: 'ending' } }], candidate.id, selection)).toBeUndefined();
  });

  it('keeps busy or failed results attached to this selection without reviving dismissed or adopted previews', () => {
    for (const status of ['queued', 'running', 'failed', 'needs_work', 'adopting'] as const) {
      expect(inlineRevisionPreview([{ ...candidate, status }], candidate.id, selection)?.status).toBe(status);
    }
    const older = { ...candidate, id: 'older-preview' };
    for (const dismissed of [
      { ...candidate, archivedAt: '2026-10-05T01:00:00Z' },
      { ...candidate, status: 'adopted' as const }, { ...candidate, status: 'reverted' as const },
    ]) expect(inlineRevisionPreview([dismissed, older], candidate.id, selection)).toBeUndefined();
  });

  const renderInput = (manual: string, disabled = false) => renderToStaticMarkup(<InlineRevisionInput runId="run-a" original={selection.selection} manual={manual} instruction="" disabled={disabled}
    refreshKey="" onManualChange={() => {}} onInstructionChange={() => {}} onPreview={() => {}} />);

  it('starts with direct editing and keeps model rewriting, calls and fees together in a closed detail', () => {
    const html = renderInput('改短一些。');
    expect(html.indexOf('直接修改文字')).toBeLessThan(html.indexOf('<details'));
    expect(html).toContain('选中的原文');
    expect(html).toContain('同一句话。');
    expect(html).toContain('按要求帮我改写');
    expect(html).toContain('生成前的调用与费用');
    expect(html).toContain('本次费用未知');
    expect(html).not.toContain('<details open');
    expect(html).not.toContain('修改位置');
    expect(html).not.toContain('修改范围');
    expect(html).not.toContain('历史记录');
  });

  it('disables unchanged previews and blocked editing but permits an intentional empty replacement', () => {
    expect(renderInput(selection.selection)).toMatch(/<button[^>]*disabled=""[^>]*>预览我的修改/);
    expect(renderInput('')).not.toMatch(/<button[^>]*disabled=""[^>]*>预览我的修改/);
    const disabledHtml = renderInput('改短一些。', true);
    expect(disabledHtml).toMatch(/<button[^>]*disabled=""[^>]*>预览我的修改/);
    expect(disabledHtml).toMatch(/<textarea[^>]*aria-label="直接修改文字"[^>]*disabled=""/);
  });
});
