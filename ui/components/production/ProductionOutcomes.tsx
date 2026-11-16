'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OutcomeNote, ProductionOutcome, ProductionOutcomes as OutcomesResponse } from '@/lib/production-outcome-types';
import { displayClientError } from '@/lib/client-error-copy';
import { platformDisplayName } from '@/lib/product-copy';
import { OutputDownloadLink } from '@/components/OutputDownloadLink';
import { outputHref } from '@/lib/output-links';
import { OUTCOME_FILTERS, type OutcomeFilter } from '@/lib/production-outcome-types';

const button = 'rounded-lg border border-[#D3D8CB] bg-white px-3 py-2 text-sm text-[#263821] disabled:opacity-50';
const date = (value: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未记录';
const openDraft = (item: ProductionOutcome, stage: number) => `/production?${new URLSearchParams({ openDraft: item.draftId || `run:${item.runId}`, stage: String(stage) })}`;

export function OutcomeActions({ item }: { item: ProductionOutcome }) {
  const next = item.deliverables ? { stage: 5, label: '查看成品' }
    : item.contentConfirmed ? { stage: 4, label: '继续排版' }
    : item.content ? { stage: 3, label: '看稿与修改' }
    : { stage: 1, label: '继续这篇' };
  return <nav aria-label={`继续处理：${item.title}`} className="mt-3 flex flex-wrap items-center gap-3 text-sm">
    <a href={openDraft(item, next.stage)} className="rounded-lg bg-[#263821] px-3 py-2 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#263821]">{next.label}</a>
    {next.stage > 3 && item.content && <a href={openDraft(item, 3)} className="underline underline-offset-4">查看文章</a>}
  </nav>;
}

export function OutcomeSummary({ item }: { item: ProductionOutcome }) {
  return <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
    <div><dt className="text-[#656B5F]">文章</dt><dd className="mt-1 font-medium">{item.contentConfirmed ? '已确认文章' : item.content ? '已有正文，待确认' : '尚无可核对正文'}</dd></div>
    <div><dt className="text-[#656B5F]">本次制作</dt><dd className="mt-1 font-medium">{item.currentCompletion ? '本次制作已完成' : item.deliverablesConfirmed ? '成品已核对' : item.deliverables ? '成品待核对' : '尚未生成成品'}</dd>{Boolean(item.note?.completions.length && !item.currentCompletion) && <dd className="mt-1 text-xs text-[#77633C]">留有此前版本的完成记录</dd>}</div>
    <div><dt className="text-[#656B5F]">下载操作</dt><dd className="mt-1 font-medium">{item.downloads ? item.downloads.count ? `已发起 ${item.downloads.count} 次下载` : '尚无下载操作记录' : '暂时无法核对'}</dd></div>
    <div><dt className="text-[#656B5F]">发布记录</dt><dd className="mt-1 font-medium">{item.publicationRecords === null ? '暂时无法核对' : item.publicationRecords ? `当前版本记录 ${item.publicationRecords} 条发布` : '当前版本尚无发布记录'}</dd></div>
  </dl>;
}

function OutcomeDetail({ item, onRefresh, onRecorded, onCompleted }: {
  item: ProductionOutcome; onRefresh: () => void; onRecorded: () => void; onCompleted: (note: OutcomeNote) => void;
}) {
  const [minutes, setMinutes] = useState(item.note?.minutesSpent?.toString() || (item.note?.minutesSpent === 0 ? '0' : ''));
  const [reuse, setReuse] = useState(item.note?.reusedPreviousWork === null || !item.note ? '' : String(item.note.reusedPreviousWork));
  const [note, setNote] = useState(item.note?.note || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(item.note);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const submit = async (action: 'save-note' | 'complete') => {
    if (busy || !saved) return;
    if (action === 'save-note' && minutes.trim() && !/^\d+$/.test(minutes.trim())) { setError('请填写整数分钟，或者留空表示未记录。'); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setMessage(''); setError('');
    try {
      const response = await fetch('/api/production/outcomes', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ runId: item.runId, snapshot: item.snapshot, expectedVersion: saved.version, action,
          ...(action === 'save-note' ? { minutesSpent: minutes.trim() ? Number(minutes) : null, reusedPreviousWork: reuse === '' ? null : reuse === 'true', note } : {}) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(displayClientError(payload, '记录没有保存成功。已填写内容保留。'));
      if (controller.signal.aborted) return;
      setSaved(payload.note);
      setMessage(action === 'complete' ? '已记录本次制作完成，发布结果可以以后补。' : '已保存你的使用记录。');
      if (action === 'complete') onCompleted(payload.note);
    } catch (cause) { if (!controller.signal.aborted) setError(displayClientError(cause, '记录没有保存成功。已填写内容保留。')); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <div className="mt-4 space-y-4 border-t border-[#E0E4D9] pt-4">
    {item.warnings.map((warning) => <p key={warning} role="status" className="text-sm text-[#77633C]">{warning}</p>)}
    <div className="flex flex-wrap gap-3 text-sm">
      {item.content && <OutputDownloadLink href={outputHref(item.content.path, 'download')} onRecorded={onRecorded} className="underline underline-offset-4">下载已保存的内容文件</OutputDownloadLink>}
    </div>
    {item.content && <p className="text-xs text-[#656B5F]">这是当前内容文件，可能含标题、正文及制作说明。确认状态不因下载改变；需要排版成品时，请回工作台继续制作。</p>}
    {item.deliverablesConfirmed && !item.currentCompletion && <div className="rounded-lg bg-[#F3F6ED] p-3">
      <p className="text-sm leading-6">文章和成品已经核对。拿到需要的内容后，可以结束本次制作，发布结果以后再补。</p>
      <button type="button" className={`${button} mt-2`} disabled={busy || !saved} onClick={() => void submit('complete')}>本次制作完成，暂不发布</button>
    </div>}
    {item.currentCompletion && <p className="text-sm text-[#35582C]">本次制作完成于 {date(item.currentCompletion.recordedAt)}。这项记录不会替你发布内容。</p>}
    <form onSubmit={(event) => { event.preventDefault(); void submit('save-note'); }} className="space-y-3">
      <p className="text-sm font-semibold">这期实际用了多少工夫？<span className="ml-2 font-normal text-[#656B5F]">选填，由你记录。</span></p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">自己实际投入的时间（分钟）<input aria-label={`实际投入分钟：${item.title}`} inputMode="numeric" type="number" min="0" max="100000" step="1" placeholder="未记录" value={minutes} disabled={busy || !saved} onChange={(event) => setMinutes(event.target.value)} className="mt-1 block w-full rounded-lg border border-[#D3D8CB] bg-white p-2" /></label>
        <label className="text-sm">复用了以前的素材或写作设置吗？<select aria-label={`复用情况：${item.title}`} value={reuse} disabled={busy || !saved} onChange={(event) => setReuse(event.target.value)} className="mt-1 block w-full rounded-lg border border-[#D3D8CB] bg-white p-2"><option value="">未记录</option><option value="true">有复用</option><option value="false">没有复用</option></select></label>
      </div>
      <label className="block text-sm">哪些地方有用，哪些还需要自己做？<textarea aria-label={`使用感受：${item.title}`} maxLength={500} rows={2} value={note} disabled={busy || !saved} onChange={(event) => setNote(event.target.value)} className="mt-1 block w-full rounded-lg border border-[#D3D8CB] bg-white p-2" /></label>
      <p className="text-xs leading-5 text-[#656B5F]">这里只记录你的实际投入，不从生成次数推算节省时间，也不把等待时长当作人工时间。</p>
      <button type="submit" className={button} disabled={busy || !saved}>{busy ? '正在保存…' : '保存使用记录'}</button>
    </form>
    {message && <p role="status" className="text-sm text-[#35582C]">{message}</p>}
    {error && <div role="alert" className="text-sm text-[#963C2D]"><p>{error}</p><button type="button" className="mt-1 underline" disabled={busy} onClick={onRefresh}>重新读取记录（会重置未保存的填写）</button></div>}
    <details><summary className="cursor-pointer text-sm">调用与费用</summary><p className="mt-2 text-sm leading-6 text-[#656B5F]">{item.modelCalls === null ? '调用记录暂时无法读取。' : `本期记录了 ${item.modelCalls} 次模型请求。`}实际费用需对照服务商账单，当前未汇总全部费用；没有记录不代表零费用。</p><a className="mt-2 inline-block text-sm underline" href={`${openDraft(item, item.content ? 3 : 1)}#current-service-calls`}>查看本期调用明细</a></details>
    <details><summary className="cursor-pointer text-sm">此前完成的版本（{saved?.completions.length || 0}）</summary>
      {!saved?.completions.length && <p className="mt-2 text-sm text-[#656B5F]">尚无完成记录，历史时间不会补造。</p>}
      {saved?.completions.map((entry) => <div key={entry.id} className="mt-2 rounded-lg bg-[#F5F6F2] p-3 text-sm"><p>{date(entry.recordedAt)} · 作者记录制作完成</p><p className="mt-1 text-xs text-[#656B5F]">对应当时已确认的正文和成品；后续改稿需重新核对，这条记录不代表当前版本已完成。</p></div>)}
    </details>
  </div>;
}

export function ProductionOutcomes() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<OutcomeFilter>('all');
  const [criteria, setCriteria] = useState({ query: '', filter: 'all' as OutcomeFilter });
  const [data, setData] = useState<OutcomesResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const refreshDownloads = useCallback(async (runId: string) => {
    try {
      const response = await fetch(`/api/production/outcomes?${new URLSearchParams({ runId })}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || payload.item?.runId !== runId) return;
      setData((previous) => previous ? { ...previous, items: previous.items.map((item) => item.runId === runId ? { ...item, downloads: payload.item.downloads } : item) } : previous);
    } catch { /* The confirmed download remains valid; the full refresh can retry this read. */ }
  }, []);
  const recordCompletion = useCallback((runId: string, note: OutcomeNote) => {
    setData((previous) => previous ? { ...previous, items: previous.items.map((item) => {
      if (item.runId !== runId) return item;
      const completion = note.completions.find((entry) => entry.content.path === item.content?.path && entry.content.sha256 === item.content?.sha256
        && entry.deliverables.path === item.deliverables?.path && entry.deliverables.sha256 === item.deliverables?.sha256) || null;
      return { ...item, note, currentCompletion: item.deliverablesConfirmed ? completion : null };
    }) } : previous);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true); setError('');
      try {
        const params = new URLSearchParams({ offset: String(offset), query: criteria.query, filter: criteria.filter });
        const response = await fetch(`/api/production/outcomes?${params}`, { cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(displayClientError(payload, '制作记录暂时无法读取。'));
        if (!controller.signal.aborted) setData(payload);
      } catch (cause) { if (!controller.signal.aborted) { setError(displayClientError(cause, '制作记录暂时无法读取。')); setData(null); } }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [offset, revision, criteria]);
  const search = (next = { query: query.trim(), filter }) => {
    setBusy(true); setError(''); setOffset(0); setCriteria(next);
  };
  return <section aria-label="制作与使用记录" className="rounded-xl border border-[#D3D8CB] bg-white p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-bold text-[#263821]">草稿与文章</h2><p className="mt-2 text-sm leading-6 text-[#656B5F]">先看文章和成品，再看发布表现。下载、完成制作和发布分别记录。</p></div><button type="button" onClick={refresh} className={button} disabled={busy}>刷新制作记录</button></div>
    <form aria-label="查找文章" onSubmit={(event) => { event.preventDefault(); search(); }} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="min-w-0 basis-56 flex-1 text-sm text-[#656B5F]">名称或题目<input aria-label="搜索文章" type="search" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：客户报价" className="mt-1 block h-10 w-full rounded-lg border border-[#D3D8CB] px-3 text-sm text-[#263821]" /></label>
      <label className="text-sm text-[#656B5F]">文章状态<select aria-label="筛选文章状态" value={filter} onChange={(event) => setFilter(event.target.value as OutcomeFilter)} className="mt-1 block h-10 rounded-lg border border-[#D3D8CB] px-2 text-sm text-[#263821]">{OUTCOME_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <button type="submit" className={button}>查找</button>
      {(query || filter !== 'all' || criteria.query || criteria.filter !== 'all') && <button type="button" className={`${button} underline`} onClick={() => { setQuery(''); setFilter('all'); search({ query: '', filter: 'all' }); }}>清除搜索和筛选</button>}
    </form>
    <p className="mt-2 text-xs leading-5 text-[#656B5F]">查找、翻页或刷新前请先保存填写的使用记录。查找覆盖本机全部制作记录，未创建内容任务的素材草稿可在工作台“查看草稿”中找回。</p>
    <details className="mt-2 text-xs leading-5 text-[#656B5F]"><summary className="cursor-pointer">筛选状态是什么意思</summary><p>已有正文包括尚未确认的文章；成品已确认要求当前文章、成品及其来源均已核对。已有发布记录只统计当前版本，可以是部分平台已发布。筛选不会替你确认或发布。</p></details>
    {busy && <p role="status" className="mt-4 text-sm">正在核对本机稿件、确认状态和使用记录…</p>}
    {error && <p role="alert" className="mt-4 text-sm text-[#963C2D]">{error}</p>}
    {data && !busy && <>
      <p role="status" className="my-4 text-sm leading-6 text-[#656B5F]">{criteria.query || criteria.filter !== 'all' ? `符合条件 ${data.total} 期，本页 ${data.items.length} 期` : `共 ${data.total} 期，本页 ${data.items.length} 期`}{criteria.query ? ` · 关键词：${criteria.query}` : ''} · {OUTCOME_FILTERS.find((item) => item.value === criteria.filter)?.label}</p>
      <p className="mb-4 text-xs leading-5 text-[#656B5F]">按任务区分，不按保存次数累加，按任务最近更新排序。下载记录从此功能启用后开始，不代表文件已成功落盘；发布数量仅对应当前版本，历史发布未做完整汇总。</p>
      {data.searchWarning && <p role="status" className="mb-3 text-sm text-[#77633C]">{data.searchWarning}</p>}
      {data.unreadable > 0 && <p role="status" className="mb-3 text-sm text-[#77633C]">另有 {data.unreadable} 份记录无法核对，未作为零成果计入。</p>}
      {!data.items.length && <p className="py-4 text-sm text-[#656B5F]">{criteria.query || criteria.filter !== 'all' ? '没有找到符合条件的文章。可以换个关键词，或清除搜索和筛选。' : '还没有可核对的制作记录。先从一份素材开始，保存的文章会出现在这里。'}</p>}
      <div className="space-y-3">{data.items.map((item) => <article key={`${revision}:${item.runId}:${item.snapshot}`} className="rounded-lg border border-[#E0E4D9] p-4">
        <h3 className="text-base font-semibold text-[#263821]">{item.title}<span className="ml-2 text-xs font-normal text-[#656B5F]">{item.platforms.map((platform) => platformDisplayName(platform)).join(' / ')}</span></h3>
        <p className="mt-1 text-xs text-[#656B5F]">内容任务更新于 {date(item.updatedAt)}</p>
        <div className="mt-3"><OutcomeSummary item={item} /></div>
        {item.progress && !item.currentCompletion && <p className="mt-3 text-sm leading-6 text-[#656B5F]"><span className="font-medium text-[#263821]">{item.progress.label}</span> · {item.progress.nextStep}</p>}
        <OutcomeActions item={item} />
        <details className="mt-3"><summary className="cursor-pointer text-sm underline underline-offset-4">记录使用感受、查看详情</summary><OutcomeDetail item={item} onRefresh={refresh} onRecorded={() => { void refreshDownloads(item.runId); }} onCompleted={(note) => recordCompletion(item.runId, note)} /></details>
      </article>)}</div>
      {data.total > data.limit && <div className="mt-4 flex items-center gap-3"><button type="button" className={button} disabled={data.offset === 0 || busy} onClick={() => { setBusy(true); setOffset(Math.max(0, data.offset - data.limit)); refresh(); }}>上一页</button><span className="text-sm">第 {Math.floor(data.offset / data.limit) + 1} 页</span><button type="button" className={button} disabled={data.offset + data.limit >= data.total || busy} onClick={() => { setBusy(true); setOffset(data.offset + data.limit); refresh(); }}>下一页</button></div>}
    </>}
  </section>;
}
