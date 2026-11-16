'use client';

import { ModelCallAction } from './ModelCallAction';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { contentEndingSpan, contentParagraphs, contentSelectionTarget, publishingIssueTarget, type ContentEditScope, type ContentSection, type ContentSelectionRequest, type PublishingIssue, type PublishingEditRequest } from '@/lib/content-editing';
import type { ContentRevision } from '@/lib/content-revisions';
import type { WritingBrief } from '@/lib/writing-brief';
import { WritingRequirementsResult } from './WritingRequirementsReview';

type Revision = Omit<ContentRevision, 'baseBody' | 'ownerPid' | 'planBody'>;
type PlanBinding = { path: string; sha256: string };
type Source = { materialCorrectionId?: string; path: string; sha256: string; sections: ContentSection[]; issues: PublishingIssue[]; plan?: PlanBinding & { brief: WritingBrief }; planError?: string; draftVersion?: number; remainingIssues?: string[] };
const busyStatuses = new Set(['queued', 'running', 'adopting', 'reverting']);
export type ContentRevisionActions = { selectEnding: () => void; selectIssue: (request: PublishingEditRequest) => void; selectText: (request: ContentSelectionRequest) => void };
type EditorProps = {
  runId: string;
  packagePath: string;
  recoveryId?: string;
  disabled?: boolean;
  showPublishingIssues?: boolean;
  actionsRef?: Ref<ContentRevisionActions>;
  inlineTarget?: HTMLElement | null;
  onCloseInline?: () => void;
  onOpenFullEditor?: () => void;
  onVersionChange: (path: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDraftSaved?: () => void;
};

export function endingRevisionSection(sections: ContentSection[], selectedId: string) {
  const bodies = sections.filter((section) => /:(?:正文|发布正文|逐句口播稿|分段口播稿)$/.test(section.id) && section.text.trim());
  return bodies.find((section) => section.id === selectedId)
    || bodies.find((section) => section.id.split(':')[0] === selectedId.split(':')[0]) || bodies[0];
}

export function RevisionEndingRange({ section, count, disabled, onChange }: {
  section: ContentSection; count: number; disabled?: boolean; onChange: (count: number) => void;
}) {
  const paragraphs = contentParagraphs(section.text);
  return <label className="block space-y-1 text-sm">结尾从哪段开始
    <select aria-label="结尾从哪段开始" value={count} disabled={disabled || !paragraphs.length} onChange={(event) => onChange(Number(event.target.value))} className="w-full rounded-lg border border-[#D8D1C9] bg-white px-3 py-2 text-sm">
      {paragraphs.map((paragraph, index) => <option key={paragraph.start} value={paragraphs.length - index}>最后 {paragraphs.length - index} 段 · {paragraph.text.replace(/\s+/g, ' ').slice(0, 64)}</option>)}
    </select>
    <span className="block text-xs leading-5 text-[#6B6B6B]">从所选段落到这部分末尾，都会被替换。请核对下方原文；其他部分及评论区不会随之修改。</span>
  </label>;
}

export function ContentRevisionComparison({ record }: { record: Pick<Revision, 'original' | 'replacement' | 'mode'> }) {
  return <div className="grid gap-3 md:grid-cols-2">
    <div><p className="text-xs text-[#6B6B6B]">修改前</p><div className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap bg-[#FFF5F1] p-2 text-sm leading-6">{record.original || '（空）'}</div></div>
    <div><p className="text-xs text-[#6B6B6B]">修改后</p><div className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap bg-[#F0F7EE] p-2 text-sm leading-6">{record.replacement || (record.mode === 'manual' ? '（删除选中文字）' : '尚未生成修改，原稿保留。')}</div></div>
  </div>;
}

export function revisionCandidateBlocker(record: Revision, source: Source | null): string | undefined {
  if (!source) return '正在核对当前稿件，请稍后再试。';
  if (record.basePath !== source.path || (record.status === 'saved_draft' ? record.savedDraftSha256 : record.baseSha256) !== source.sha256) return '原稿已更新，请基于当前稿件重新修改。';
  if ((record.materialCorrectionId || '') !== (source.materialCorrectionId || '')) return '素材整理结果已修正，请基于当前素材重新修改。';
  if (record.planBinding && (record.planBinding.path !== source.plan?.path || record.planBinding.sha256 !== source.plan?.sha256)) return '这次修改使用的写作方案已更新或暂时无法核对，请重新带入方案要求。';
}

const candidateStatuses = new Set(['queued', 'running', 'ready', 'needs_work', 'failed', 'adopting']);
const revisionStatusLabel: Record<Revision['status'], string> = {
  queued: '准备修改', running: '正在修改', ready: '待采用', needs_work: '需要再改', failed: '这次未完成',
  adopting: '正在保存', adopted: '已采用', reverting: '正在撤回', reverted: '已撤回',
  saved_draft: '已保存到待完成稿',
};

export function revisionHistorySelection(records: Revision[], source: Source | null, selectedId: string | null) {
  // Records arrive newest first. Once that attempt is dismissed or adopted,
  // older candidates belong in history until the author explicitly opens one.
  const selected = selectedId ? records.find((record) => record.id === selectedId) : records[0];
  const preview = selected && !selected.archivedAt && candidateStatuses.has(selected.status) ? selected : undefined;
  const current = records.find((record) => (record.status === 'adopted' && record.adoptedPath === source?.path && record.adoptedSha256 === source?.sha256)
    || (record.status === 'reverted' && record.revertedPath === source?.path)
    || (record.status === 'saved_draft' && record.basePath === source?.path && record.savedDraftSha256 === source?.sha256));
  return { preview, current, history: records.filter((record) => record.id !== preview?.id && record.id !== current?.id) };
}

export function inlineRevisionPreview(records: Revision[], selectedId: string | null, selection: ContentSelectionRequest | null) {
  if (!selectedId || !selection) return undefined;
  const record = records.find((item) => item.id === selectedId);
  if (!record || record.archivedAt || !candidateStatuses.has(record.status)) return undefined;
  // Equal words can occur more than once. A paragraph preview belongs to this
  // exact occurrence and source version, never simply the newest candidate.
  return record.basePath === selection.path && record.baseSha256 === selection.sha256
    && record.target.scope === 'selection' && record.target.sectionId === selection.sectionId
    && record.target.selection === selection.selection && record.target.selectionOffset === selection.selectionOffset
    ? record : undefined;
}

export function InlineRevisionInput({ runId, original, manual, instruction, disabled, refreshKey, manualInput, onManualChange, onInstructionChange, onPreview }: {
  runId: string; original: string; manual: string; instruction: string; disabled?: boolean; refreshKey: string;
  manualInput?: Ref<HTMLTextAreaElement>; onManualChange: (value: string) => void; onInstructionChange: (value: string) => void;
  onPreview: (mode: 'manual' | 'model') => void;
}) {
  const fieldClass = 'w-full rounded-lg border border-[#D8D1C9] bg-white px-3 py-2 text-sm text-[#303030]';
  const buttonClass = 'rounded-full border border-[#D8D1C9] bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40';
  return <div className="space-y-3">
    <div><p className="text-xs font-semibold text-[#6B6B6B]">选中的原文</p><blockquote className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-[#D8D1C9] pl-3 text-sm leading-7">{original}</blockquote></div>
    <label className="block space-y-1 text-sm font-semibold">直接修改文字<textarea ref={manualInput} aria-label="直接修改文字" className={fieldClass} rows={4} value={manual} onChange={(event) => onManualChange(event.target.value)} disabled={disabled} /></label>
    <div className="flex flex-wrap items-center gap-3"><button type="button" className={buttonClass} disabled={disabled || manual === original} onClick={() => onPreview('manual')}>预览我的修改</button><p className="text-xs text-[#6B6B6B]">直接编辑不调用模型；预览后再决定是否采用。</p></div>
    <details className="border-t border-[#DDD5CC] pt-3"><summary className="cursor-pointer text-sm font-semibold">按要求帮我改写</summary><div className="mt-3 space-y-3">
      <label className="block space-y-1 text-sm">希望怎样修改<textarea aria-label="修改要求" className={fieldClass} rows={3} value={instruction} placeholder="例如：把这句话写短一些，保留原意。" onChange={(event) => onInstructionChange(event.target.value)} disabled={disabled} /></label>
      <ModelCallAction runId={runId} refreshKey={refreshKey}>{(callUnavailable) => <button type="button" className={buttonClass} disabled={callUnavailable || disabled || !instruction.trim() || !original.trim()} onClick={() => onPreview('model')}>按要求生成修改</button>}</ModelCallAction>
    </div></details>
  </div>;
}

type RevisionHistoryProps = {
  records: Revision[]; source: Source | null; selectedId: string | null; disabled?: boolean;
  onSelect: (id: string) => void;
  onAction: (record: Revision, action: 'adopt' | 'undo' | 'archive' | 'restore' | 'save-draft') => void;
  onContinue: (record: Revision) => void;
  previewRef?: Ref<HTMLElement>;
};

export function RevisionReviewFindings({ record }: { record: Pick<Revision, 'issues' | 'warnings' | 'reviewComparison' | 'writingReview'> }) {
  const comparison = record.reviewComparison;
  const list = (items: string[]) => <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6">{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>;
  if (!comparison) return <>
    {list(record.issues)}
    {record.warnings.length > 0 && <details><summary className="cursor-pointer text-sm">整篇检查提示（旧记录未与原稿比较）· {record.warnings.length} 条</summary>{list(record.warnings)}</details>}
  </>;
  return <section aria-label="修改前后的检查结果" className="space-y-3">
    {record.writingReview && <WritingRequirementsResult review={record.writingReview} />}
    <p className="text-xs leading-5 text-[#6B6B6B]">按保存的原稿与本次候选稿比较检查项；这不是事实核验或质量保证。整篇待办仍需处理，采用修改不会自动确认全文。</p>
    {comparison.newIssues.length > 0 && <div className="text-[#9D3327]"><p className="text-sm font-semibold">修改后新增或变化的问题，采用前需处理</p>{list(comparison.newIssues)}</div>}
    {comparison.existingIssues.length > 0 && <div className="text-[#9D3327]"><p className="text-sm font-semibold">原稿也有的同类问题，采用前仍需处理</p>{list(comparison.existingIssues)}</div>}
    {comparison.newWarnings.length > 0 ? <div><p className="text-sm font-semibold">修改后新增或变化的检查提示</p>{list(comparison.newWarnings)}</div> : <p className="text-sm">未发现新增的一般提示；请继续核对修改文字及上方问题。</p>}
    {comparison.existingWarnings.length > 0 && <details><summary className="cursor-pointer text-sm">原稿已有的整篇检查项 · {comparison.existingWarnings.length} 条</summary><p className="mt-2 text-xs text-[#6B6B6B]">数值按修改后的稿件显示，不表示这些问题已解决。</p>{list(comparison.existingWarnings)}</details>}
  </section>;
}

export function ContentRevisionHistory({ records, source, selectedId, disabled, onSelect, onAction, onContinue, previewRef }: RevisionHistoryProps) {
  const [historyLimit, setHistoryLimit] = useState(10);
  const { preview, current, history } = revisionHistorySelection(records, source, selectedId);
  const buttonClass = 'rounded-full border border-[#D8D1C9] bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40';
  const details = (record: Revision) => {
    const blocker = revisionCandidateBlocker(record, source);
    return <div className="space-y-3">
      {record.instruction && <p className="text-sm">修改要求：{record.instruction}</p>}
      {record.planBinding && <p className="text-xs leading-5 text-[#6B6B6B]">这次修改使用了带入时的写作方案，仅替换选中的原文。采用后仍需核对全文。</p>}
      {busyStatuses.has(record.status) ? <p role="status" className="text-sm">{record.status === 'queued' ? '修改已保存，正在准备。' : record.status === 'running' ? '正在等待修改结果；可以离开页面，回来后继续查看。' : '正在保存新版本…'}</p> : <ContentRevisionComparison record={record} />}
      <RevisionReviewFindings record={record} />
      {record.status === 'failed' && record.issues.some((issue) => issue.includes('模型连接')) && <a className="inline-block text-sm underline" href="/settings#model-connection">去设置模型</a>}

      {candidateStatuses.has(record.status) && blocker && <p className="text-sm leading-6 text-[#6B5543]">{blocker}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {record.archivedAt ? <><p className="text-sm">已暂不采用，原稿未因此改变。</p><button type="button" className={buttonClass} disabled={disabled} onClick={() => onAction(record, 'restore')}>恢复到待选</button></> : <>
          {record.status === 'ready' && <button type="button" className={buttonClass} disabled={disabled || Boolean(blocker)} onClick={() => onAction(record, 'adopt')}>采用这次修改</button>}
          {record.recoveryId && ['ready', 'needs_work'].includes(record.status) && <button type="button" className={buttonClass} disabled={disabled || Boolean(blocker)} onClick={() => onAction(record, 'save-draft')}>保存到待完成稿</button>}
          {record.status === 'saved_draft' && current?.id === record.id && <p className="text-sm">待完成稿第 {record.savedDraftVersion} 版。保存不会确认正文或进入发布。</p>}
          {(record.status === 'failed' || record.status === 'needs_work') && <button type="button" className={buttonClass} disabled={disabled || Boolean(blocker)} onClick={() => onContinue(record)}>接着修改</button>}
          {['ready', 'needs_work', 'failed'].includes(record.status) && <button type="button" className={buttonClass} disabled={disabled} onClick={() => onAction(record, 'archive')}>暂不采用</button>}
        </>}
        {record.status === 'adopted' && <p className="text-sm text-[#16803C]">已采用，原稿已保留。</p>}
        {record.status === 'adopted' && !record.recoveryId && current?.id === record.id && <button type="button" className={buttonClass} disabled={disabled} onClick={() => onAction(record, 'undo')}>撤回这次修改</button>}
        {record.status === 'reverted' && <p className="text-sm">已撤回，恢复内容另存为新版本。</p>}
      </div>
    </div>;
  };
  return <div className="space-y-4 border-t border-[#DDD5CC] pt-4">
    <section aria-label="当前稿件" className="space-y-2 rounded-lg border border-[#DDD5CC] bg-white p-3">
      <h4 className="font-bold">当前稿件{current?.status === 'reverted' ? ' · 撤回后的版本' : ''}</h4>
      <p className="text-sm text-[#6B6B6B]">{current ? `${current.label} · ${current.mode === 'manual' ? '手动修改' : '按要求改稿'}` : '当前保留的稿件。候选修改只有在你采用后才会替换原文。'}</p>
      {current && <details><summary className="cursor-pointer text-sm">查看当前版本的修改</summary><div className="mt-3">{details(current)}</div></details>}
      {current?.status === 'saved_draft' && <button type="button" className={buttonClass} disabled={disabled || Boolean(revisionCandidateBlocker(current, source)) || Boolean(source?.remainingIssues?.length)} onClick={() => onAction(current, 'adopt')}>检查并另存为正式正文</button>}
    </section>
    <section ref={previewRef} tabIndex={-1} aria-label="本次查看的修改预览" className="space-y-3 rounded-lg border border-[#CCC8B9] bg-white p-4">
      <h4 className="font-bold">修改预览{preview ? ` · ${revisionStatusLabel[preview.status]}` : ''}</h4>
      {preview ? <><p className="text-sm">{preview.label} · {preview.mode === 'manual' ? '手动修改' : '按要求改稿'} · <time dateTime={preview.createdAt}>{new Date(preview.createdAt).toLocaleString('zh-CN')}</time></p>{details(preview)}</> : <p className="text-sm text-[#6B6B6B]">当前没有正在查看的修改。较早的候选稿和暂不采用的文字都在历史记录中，打开或恢复后仍需由你决定是否采用。</p>}
    </section>
    {history.length > 0 && <details className="space-y-3"><summary className="cursor-pointer text-sm font-bold">历史记录（{history.length}）</summary>
      <p className="text-xs leading-5 text-[#6B6B6B]">旧记录单独保留；早前失败不代表当前稿件出错。展开一条查看前后文字，或恢复暂不采用的修改。</p>
      {history.slice(0, historyLimit).map((record) => <details key={record.id} className="rounded-lg border border-[#DDD5CC] bg-white p-3">
        <summary className="cursor-pointer text-sm leading-6"><span className="font-semibold">{record.label} · {record.archivedAt ? '暂不采用' : revisionStatusLabel[record.status]}</span><time className="ml-2 text-[#6B6B6B]" dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString('zh-CN')}</time></summary>
        <div className="mt-3 space-y-3">{!record.archivedAt && candidateStatuses.has(record.status) && <button type="button" className="text-sm underline disabled:opacity-40" disabled={disabled} onClick={() => onSelect(record.id)}>查看这次预览</button>}{details(record)}</div>
      </details>)}
      {historyLimit < history.length && <button type="button" className={buttonClass} onClick={() => setHistoryLimit((value) => value + 10)}>再看 10 条历史记录（还有 {history.length - historyLimit} 条）</button>}
    </details>}
  </div>;
}

export function ContentRevisionEditor(props: EditorProps) {
  return <RevisionEditor key={JSON.stringify([props.runId, props.packagePath, props.recoveryId || ''])} {...props} />;
}

function RevisionEditor({ runId, packagePath, recoveryId, disabled, showPublishingIssues = true, actionsRef, inlineTarget, onCloseInline, onOpenFullEditor, onVersionChange, onBusyChange, onDraftSaved }: EditorProps) {
  const [source, setSource] = useState<Source | null>(null);
  const [records, setRecords] = useState<Revision[]>([]);
  const [sectionId, setSectionId] = useState(recoveryId ? 'recovery:append' : 'wechat:正文');
  const [scope, setScope] = useState<ContentEditScope>(recoveryId ? 'append' : 'ending');
  const [endingParagraphs, setEndingParagraphs] = useState(1);
  const [planBinding, setPlanBinding] = useState<PlanBinding | null>(null);
  const [selection, setSelection] = useState('');
  const [selectionOffset, setSelectionOffset] = useState<number | undefined>(undefined);
  const [selectionBinding, setSelectionBinding] = useState<PlanBinding | null>(null);
  const [readerSelection, setReaderSelection] = useState<ContentSelectionRequest | null>(null);
  const [instruction, setInstruction] = useState('');
  const [manual, setManual] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [revisionNotice, setRevisionNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const active = useRef(true);
  const onVersionChangeRef = useRef(onVersionChange);
  useEffect(() => { onVersionChangeRef.current = onVersionChange; }, [onVersionChange]);
  const requestId = useRef<{ fingerprint: string; id: string } | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const pendingEnding = useRef(false);
  const pendingIssue = useRef<PublishingEditRequest | null>(null);
  const pendingSelection = useRef<ContentSelectionRequest | null>(null);
  const manualInput = useRef<HTMLTextAreaElement>(null);
  const selected = source?.sections.find((section) => section.id === sectionId) ?? endingRevisionSection(source?.sections || [], sectionId) ?? source?.sections[0];
  const running = records.some((record) => busyStatuses.has(record.status));
  const busy = working || running;
  const available = source?.path === packagePath;
  const planStale = Boolean(planBinding && (source?.plan?.path !== planBinding.path || source?.plan?.sha256 !== planBinding.sha256));
  const selectionStale = Boolean(selectionBinding && (source?.path !== selectionBinding.path || source?.sha256 !== selectionBinding.sha256));
  const inlineSelectionLocated = Boolean(readerSelection && selectionBinding
    && selectionBinding.path === readerSelection.path && selectionBinding.sha256 === readerSelection.sha256
    && scope === 'selection' && sectionId === readerSelection.sectionId
    && selection === readerSelection.selection && selectionOffset === readerSelection.selectionOffset);
  const paragraphCount = Math.min(endingParagraphs, contentParagraphs(selected?.text || '').length) || 1;
  let original = selected?.text || '';
  if (scope === 'ending' && selected?.text) original = contentEndingSpan(selected, paragraphCount).text;
  if (scope === 'selection') original = selection;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const selectIssue = (snapshot: Source, request: PublishingEditRequest) => {
    try {
      const target = publishingIssueTarget(snapshot, request);
      setSectionId(target.sectionId); setScope('selection'); setSelection(target.selection!); setSelectionOffset(target.selectionOffset);
      setManual(target.selection!); setPlanBinding(null); setEndingParagraphs(1); setError('');
      setSelectionBinding({ path: request.path, sha256: request.sha256 });
      setInstruction('请把选中的文字改成面向读者的表达，不新增事实或案例，不复述写作规则。');
      requestId.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请重新读取正文后定位。'); }
  };
  const selectText = (snapshot: Source, request: ContentSelectionRequest) => {
    setSelectedRevisionId(null); setRevisionNotice(''); setSelectionBinding(null);
    try {
      const target = contentSelectionTarget(snapshot, request);
      setSectionId(target.sectionId); setScope('selection'); setSelection(target.selection!); setSelectionOffset(target.selectionOffset);
      setSelectionBinding({ path: request.path, sha256: request.sha256 });
      setManual(target.selection!); setInstruction(''); setPlanBinding(null); setEndingParagraphs(1); setError('');
      requestId.current = null;
      requestAnimationFrame(() => manualInput.current?.focus());
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请重新选择正文。'); }
  };
  useImperativeHandle(actionsRef, () => ({ selectEnding() {
    if (busy || disabled) return;
    pendingIssue.current = null;
    pendingSelection.current = null; setSelectionBinding(null);
    if (!source) { pendingEnding.current = true; return; }
    const section = endingRevisionSection(source.sections, selected?.id || sectionId);
    if (!section) { setError('没有找到可定位结尾的正文，请先选择修改位置和原文。'); return; }
    setSectionId(section.id); setScope('ending'); setEndingParagraphs(1); setSelection(''); setSelectionOffset(undefined); setManual(null);
  }, selectIssue(request) {
    if (busy || disabled) return;
    pendingEnding.current = false;
    pendingSelection.current = null;
    if (!source) { pendingIssue.current = request; return; }
    selectIssue(source, request);
  }, selectText(request) {
    if (busy || disabled) return;
    pendingEnding.current = false; pendingIssue.current = null;
    setReaderSelection(request); setSelectedRevisionId(null); setSelectionBinding(null); setError(''); setRevisionNotice('');
    if (!source) { pendingSelection.current = request; return; }
    selectText(source, request);
  } }));

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const read = async () => {
      try {
        const response = await fetch(`/api/production/content-revisions?${new URLSearchParams({ runId, path: packagePath, ...(recoveryId ? { recoveryId } : {}) })}`, { cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '暂时无法读取改稿记录。');
        if (cancelled) return;
        // Refreshing records must not erase a failed edit's actionable error.
        // Explicit retry and new edit actions clear it when the author acts.
        setSource(payload.source); setRecords(payload.revisions || []);
        if (pendingSelection.current && payload.source) {
          const request = pendingSelection.current; pendingSelection.current = null;
          selectText(payload.source, request);
        }
        if (pendingIssue.current && payload.source) {
          const request = pendingIssue.current; pendingIssue.current = null;
          selectIssue(payload.source, request);
        }
        if (pendingEnding.current && payload.source) {
          pendingEnding.current = false;
          const section = endingRevisionSection(payload.source.sections || [], sectionId);
          if (section) { setSectionId(section.id); setScope('ending'); setEndingParagraphs(1); setSelection(''); setSelectionOffset(undefined); setManual(null); }
          else setError('没有找到可定位结尾的正文，请先选择修改位置和原文。');
        }
        if (payload.source?.path && payload.source.path !== packagePath) {
          setManual(null); setEndingParagraphs(1); requestId.current = null;
          onVersionChangeRef.current(payload.source.path);
        }
        if ((payload.revisions || []).some((record: Revision) => busyStatuses.has(record.status))) timer = setTimeout(read, 1_500);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '暂时无法读取改稿记录。');
      }
    };
    void read();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [runId, packagePath, refresh, recoveryId, sectionId]);

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/production/content-revisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, ...body }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '这次修改没有完成，原稿保留。');
    return payload.revision as Revision;
  };

  const create = async (mode: 'manual' | 'model') => {
    if (!selected || !source || !available || busy || disabled || planStale || selectionStale || (inlineTarget && !inlineSelectionLocated)) return;
    setWorking(true); setError(''); setRevisionNotice('');
    try {
      const target = { sectionId: selected.id, scope, ...(scope === 'selection' ? { selection, ...(selectionOffset !== undefined ? { selectionOffset } : {}) } : {}), ...(scope === 'ending' ? { endingParagraphs: paragraphCount } : {}) };
      // Offsets derived from a finding are rechecked against text and full-file
      // hash on the server; typing a different selection clears the offset.
      const input = { action: 'create', ...(recoveryId ? { recoveryId } : {}), ...(planBinding ? { planBinding } : {}), basePath: packagePath, baseSha256: source.sha256, materialCorrectionId: source.materialCorrectionId || '', target, mode, instruction: mode === 'model' ? instruction : '', ...(mode === 'manual' ? { replacement: manual ?? original } : {}) };
      const fingerprint = JSON.stringify(input);
      if (requestId.current?.fingerprint !== fingerprint) requestId.current = { fingerprint, id: `rev_${crypto.randomUUID().replaceAll('-', '')}` };
      const record = await post({ ...input, id: requestId.current.id });
      if (!active.current) return;
      setRecords((current) => [record, ...current.filter((item) => item.id !== record.id)]);
      setSelectedRevisionId(record.id);
      requestAnimationFrame(() => previewRef.current?.focus({ preventScroll: false }));
      setRefresh((value) => value + 1);
    } catch (reason) {
      if (active.current) { setError(reason instanceof Error ? reason.message : '修改没有完成。'); setRefresh((value) => value + 1); }
    } finally { if (active.current) setWorking(false); }
  };

  const commit = async (record: Revision, action: 'adopt' | 'undo' | 'archive' | 'restore' | 'save-draft') => {
    if (busy || disabled || !available) return false;
    setWorking(true); setError(''); setRevisionNotice('');
    try {
      const result = await post({ id: record.id, action, expectedArchiveVersion: record.archiveVersion ?? 0 });
      if (!active.current) return false;
      const path = action === 'undo' ? result.revertedPath : action === 'adopt' ? result.adoptedPath : undefined;
      if (path) onVersionChange(path);
      if (action === 'save-draft') { onDraftSaved?.(); setManual(null); setInstruction(''); setSelection(''); setSelectionBinding(null); setRevisionNotice('已保存到待完成稿，原始文字和修改历史保留。请继续处理剩余问题。'); }
      setRecords((current) => current.map((item) => item.id === result.id ? result : item));
      if (action === 'adopt' || action === 'undo') { setManual(null); setEndingParagraphs(1); }
      if (action !== 'archive' || (selectedRevisionId ?? records[0]?.id) === result.id) setSelectedRevisionId(result.id);
      if (action === 'archive') setRevisionNotice('这次修改已移到历史记录，原稿未改变。可以展开历史记录恢复它。');
      if (action === 'restore') setRevisionNotice('这次修改已恢复到待选，原稿未改变。请核对预览，再决定是否采用。');
      requestId.current = null; setRefresh((value) => value + 1);
      return true;
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : '版本没有保存。'); return false; }
    finally { if (active.current) setWorking(false); }
  };

  const fieldClass = 'w-full rounded-lg border border-[#D8D1C9] bg-white px-3 py-2 text-sm text-[#303030]';
  const buttonClass = 'rounded-full border border-[#D8D1C9] bg-white px-4 py-2 text-sm font-semibold disabled:opacity-40';
  if (inlineTarget) {
    const preview = inlineSelectionLocated ? inlineRevisionPreview(records, selectedRevisionId, readerSelection) : undefined;
    const blocker = preview ? revisionCandidateBlocker(preview, source) : undefined;
    const unavailable = busy || disabled || !available;
    const close = () => {
      if (busy || disabled) return;
      if (!preview) {
        setManual(null); setInstruction(''); setSelectionBinding(null); setReaderSelection(null); setSelectedRevisionId(null);
        pendingSelection.current = null; requestId.current = null; setError(''); setRevisionNotice('');
      }
      onCloseInline?.();
    };
    return createPortal(<section aria-label="修改选中的文字" className="my-4 space-y-4 rounded-xl border border-[#CCC8B9] bg-[#FDF8F3] p-4 text-left">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-bold">修改这段</h3><button type="button" className="text-sm underline underline-offset-4 disabled:opacity-40" disabled={busy || disabled} onClick={close}>{preview ? '收起修改' : '取消编辑'}</button></div>
      {error && <div role="alert" className="text-sm text-[#9D3327]"><p>{error}</p><button type="button" className="mt-1 underline disabled:opacity-40" disabled={busy || disabled} onClick={() => { setError(''); setRefresh((value) => value + 1); }}>重新读取稿件和修改记录</button></div>}
      {!inlineSelectionLocated && <p role="status" className="text-sm text-[#6B6B6B]">{source ? '这次选段暂时无法定位。请关闭后从当前正文重新选择；已有修改仍可在全部修改记录中查看。' : '正在核对选中的原文…'}</p>}
      {selectionStale && <p role="alert" className="text-sm text-[#9D3327]">正文已更新，请重新从当前正文选择文字。已填的修改保留，暂时不能提交。</p>}
      {inlineSelectionLocated && (preview ? <section ref={previewRef} tabIndex={-1} aria-label="本次查看的修改预览" className="space-y-3">
        <h4 className="text-sm font-bold">修改预览 · {revisionStatusLabel[preview.status]}</h4>
        {busyStatuses.has(preview.status) ? <p role="status" className="text-sm">{preview.status === 'queued' ? '修改已保存，正在准备。' : preview.status === 'running' ? '正在等待修改结果；可以离开页面，回来后在修改记录中查看。' : '正在保存新版本…'}</p> : <ContentRevisionComparison record={preview} />}
        <RevisionReviewFindings record={preview} />
        {preview.status === 'failed' && preview.issues.some((issue) => issue.includes('模型连接')) && <a className="inline-block text-sm underline" href="/settings#model-connection">去设置模型</a>}
        {blocker && <p role="status" className="text-sm text-[#6B5543]">{blocker}</p>}
        <div className="flex flex-wrap gap-2">
          {preview.status === 'ready' && <button type="button" className={buttonClass} disabled={unavailable || Boolean(blocker)} onClick={() => void commit(preview, 'adopt')}>采用这次修改</button>}
          {['ready', 'needs_work', 'failed'].includes(preview.status) && <>
            <button type="button" className={buttonClass} disabled={unavailable || Boolean(blocker)} onClick={() => {
              setManual(preview.mode === 'manual' ? preview.replacement : preview.replacement || preview.original);
              setInstruction(preview.instruction); setSelectedRevisionId(null); setError(''); requestId.current = null;
              requestAnimationFrame(() => manualInput.current?.focus());
            }}>接着修改</button>
            <button type="button" className={buttonClass} disabled={unavailable} onClick={async () => { if (await commit(preview, 'archive')) onCloseInline?.(); }}>暂不采用</button>
          </>}
        </div>
        <p className="text-xs leading-5 text-[#6B6B6B]">预览已保存在修改记录中。收起不会采用或删除它。</p>
      </section> : <InlineRevisionInput runId={runId} original={original} manual={manual ?? original} instruction={instruction}
        disabled={unavailable || planStale || selectionStale} refreshKey={`${busy}:${refresh}`} manualInput={manualInput}
        onManualChange={setManual} onInstructionChange={setInstruction} onPreview={(mode) => void create(mode)} />)}
      {onOpenFullEditor && <button type="button" className="text-sm underline underline-offset-4 disabled:opacity-40" disabled={busy || disabled} onClick={onOpenFullEditor}>查看全部修改记录</button>}
    </section>, inlineTarget);
  }
  return (
    <section aria-label="修改文章与版本" className="space-y-4 rounded-xl border border-[#D8D1C9] bg-[#FDF8F3] p-4">
      <div><h3 className="font-bold">把这稿改到满意</h3><p className="mt-1 text-sm text-[#6B6B6B]">选择要改的部分。先看修改前后，再决定是否采用；原稿会保留。</p></div>
      {!recoveryId && source?.plan?.brief.ending && <section aria-label="当前方案的结尾要求" className="rounded-lg border border-[#D8D1C9] bg-white p-3 text-sm leading-6">
        <h4 className="font-semibold">当前方案希望怎样收尾</h4>
        <p className="mt-1 whitespace-pre-wrap">{source.plan.brief.ending}</p>
        <button type="button" disabled={busy || disabled || !available} className="mt-2 underline" onClick={() => {
          setInstruction(source.plan!.brief.ending);
          setPlanBinding({ path: source.plan!.path, sha256: source.plan!.sha256 });
          requestId.current = null;
        }}>带入这条修改要求</button>
        <p className="mt-2 text-xs text-[#6B6B6B]">带入后，请选择要替换的原文。只改选中部分不代表整篇文章已符合新方案，之后仍需核对全文。</p>
      </section>}
      {!recoveryId && source?.planError && <p role="status" className="text-sm text-[#6B5543]">{source.planError}</p>}
      {planBinding && <div role="status" className="text-sm leading-6 text-[#6B5543]"><p>{planStale ? '方案已有更新，请重新读取后带入最新要求。已填写的文字保留。' : '本次修改已关联带入时的方案；生成和采用前会核对版本。'}</p><button type="button" disabled={busy || disabled} className="underline" onClick={() => { setPlanBinding(null); requestId.current = null; }}>取消方案关联，保留已填文字</button></div>}
      {showPublishingIssues && source?.issues.length ? <div role="status" className="space-y-2 rounded-lg bg-[#FFF1DC] p-3 text-sm"><p className="font-semibold">这几处需要你核对</p>{source.issues.map((issue, index) => <div key={`${issue.sectionId}:${index}`}><p>{issue.message}</p><blockquote className="my-1 border-l-2 border-[#A66300] pl-2">{issue.quote}</blockquote><button type="button" disabled={busy || disabled} className="underline" onClick={() => { setSectionId(issue.sectionId); setScope('selection'); selectIssue(source, { path: source.path, sha256: source.sha256, issue }); }}>修改这一处</button></div>)}</div> : null}
      {error && <div role="alert" className="text-sm text-[#9D3327]"><p>{error}</p><button type="button" className="mt-1 underline disabled:opacity-40" disabled={busy || disabled} onClick={() => { setError(''); setRefresh((value) => value + 1); }}>重新读取稿件和修改记录</button></div>}
      {!source && !error && <p className="text-sm">正在读取当前稿件…</p>}
      {recoveryId && source && <aside aria-label="待完成稿检查" className="rounded-lg bg-[#FFF8E8] p-3 text-sm"><p>当前待完成稿 · 第 {source.draftVersion ?? 0} 版。保存修改不会确认正文。</p>{source.remainingIssues?.length ? <ul className="list-disc pl-5">{source.remainingIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p>必要字段检查未发现缺项；请核对全文，再另存为正式正文。</p>}</aside>}
      {selectionStale && <p role="alert" className="text-sm text-[#9D3327]">正文已更新，请重新从当前正文选择文字。已填的修改保留，暂时不能提交。</p>}
      {selected && <>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">修改位置<select aria-label="修改位置" className={fieldClass} value={selected.id} disabled={busy || disabled} onChange={(event) => { setSelectionBinding(null); setSectionId(event.target.value); setScope(event.target.value === 'recovery:append' ? 'append' : 'section'); setEndingParagraphs(1); setManual(null); setSelection(''); setSelectionOffset(undefined); }}>{source!.sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}</select></label>
          <label className="space-y-1 text-sm">修改范围<select aria-label="修改范围" className={fieldClass} value={scope} disabled={busy || disabled} onChange={(event) => { setSelectionBinding(null); setScope(event.target.value as ContentEditScope); setEndingParagraphs(1); setSelectionOffset(undefined); setManual(null); }}>{selected.id === 'recovery:append' ? <option value="append">补齐缺少的内容</option> : <><option value="ending">修改结尾（选择起始段落）</option><option value="selection">修改指定原文</option><option value="section">修改这一部分</option></>}</select></label>
        </div>
        {scope === 'ending' && <RevisionEndingRange section={selected} count={paragraphCount} disabled={busy || disabled} onChange={(count) => { setEndingParagraphs(count); setManual(null); }} />}
        {scope === 'selection' && <label className="block space-y-1 text-sm">要修改的原文<textarea aria-label="要修改的原文" className={fieldClass} rows={3} value={selection} onChange={(event) => { setSelectionBinding(null); setSelection(event.target.value); setSelectionOffset(undefined); setManual(null); }} disabled={busy || disabled} /></label>}
        {scope === 'ending' && <div className="rounded-lg border border-[#D8D1C9] bg-white p-3 text-sm leading-7"><p className="font-semibold">本次会替换的原文 · 最后 {paragraphCount} 段</p><div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{original}</div></div>}
        <details><summary className="cursor-pointer text-sm">查看这一部分的原文</summary><div className="mt-2 whitespace-pre-wrap rounded-lg bg-white p-3 text-sm leading-7">{selected.text}</div></details>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2"><label className="block text-sm">希望怎样修改<textarea aria-label="修改要求" className={fieldClass} rows={4} placeholder="例如：结尾只保留一句具体行动，不引导购买。" value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={busy || disabled} /></label><ModelCallAction runId={runId} refreshKey={`${busy}:${refresh}`}>{(callUnavailable) => <button className={buttonClass} type="button" disabled={callUnavailable || busy || disabled || planStale || selectionStale || !instruction.trim() || (!original.trim() && scope !== 'append') || !available} onClick={() => void create('model')}>按要求生成修改</button>}</ModelCallAction><p className="text-xs text-[#6B6B6B]">只修改选定文字，采用前可核对。</p></div>
          <div className="space-y-2"><label className="block text-sm">也可以直接改文字<textarea ref={manualInput} aria-label="直接修改文字" className={fieldClass} rows={4} value={manual ?? original} onChange={(event) => setManual(event.target.value)} disabled={busy || disabled} /></label><button className={buttonClass} type="button" disabled={busy || disabled || planStale || selectionStale || (manual ?? original) === original || !available} onClick={() => void create('manual')}>预览我的修改</button><p className="text-xs text-[#6B6B6B]">直接编辑不调用模型。</p></div>
        </div>
      </>}
      {revisionNotice && <p role="status" className="rounded-lg bg-[#F0F7EE] p-3 text-sm leading-6">{revisionNotice}</p>}
      {records.length > 0 && <ContentRevisionHistory records={records} source={source} selectedId={selectedRevisionId} previewRef={previewRef} disabled={busy || disabled || !available}
        onSelect={(id) => { setSelectedRevisionId(id); requestAnimationFrame(() => previewRef.current?.focus({ preventScroll: false })); }}
        onAction={(record, action) => void commit(record, action)}
        onContinue={(record) => { setSelectionBinding(record.target.scope === 'selection' ? { path: record.basePath, sha256: record.baseSha256 } : null); setSectionId(record.target.sectionId); setScope(record.target.scope); setEndingParagraphs(record.target.endingParagraphs || 1); setSelection(record.target.selection || ''); setSelectionOffset(record.target.selectionOffset); setInstruction(record.instruction); setPlanBinding(record.planBinding || null); setManual(record.mode === 'manual' ? record.replacement : record.replacement || record.original); requestId.current = null; }} />}

    </section>
  );
}
