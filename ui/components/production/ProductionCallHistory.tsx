'use client';

import { useEffect, useState } from 'react';
import { useServiceCallHistory } from '@/hooks/useServiceCallHistory';
import { serviceCallLabel, serviceCallStatus, type ModelCallLimit, type ServiceCallHistory } from '@/lib/service-call-types';
import { serviceRecordTime } from '@/lib/service-status-copy';
import { PRODUCTION_WORKSPACE_STORAGE_KEY, productionWorkspaceContext, type ProductionWorkspaceContext } from '@/lib/production-workspace-context';

export function ModelCallRecords({ data }: { data: ServiceCallHistory }) {
  return <div className="space-y-3 text-sm leading-6">
    <p>这里只记录启用此功能后的本期写作和模型改稿请求。历史调用、连接测试、独立对标、数据采集及生图费用尚未合并，不能当作完整账单。</p>
    <p>费用未知，以服务商账单为准；失败、中断也可能计费。收到响应不等于文章已通过检查或被你采用。读取记录、保存文字和手动改稿不会新增模型请求。</p>
    {!data.records.length ? <p role="status">这份草稿还没有新的模型请求记录，不代表历史上没有调用或没有费用。</p> : <>
      <p>已保存 {data.records.length} 条模型请求记录</p>
      <ol className="space-y-3">{data.records.map((record) => <li key={record.id} id={record.id} className="scroll-mt-6 rounded-lg border border-black/10 bg-white p-3">
        <div className="flex flex-wrap justify-between gap-2"><strong>{serviceCallLabel(record.operation)}</strong><span>{serviceCallStatus(record.status)}</span></div>
        <p className="break-words">{record.provider === 'aifios-hosted' ? '授权写作服务' : record.provider} · {record.model}</p>
        <p className="text-xs text-[#6B6B6B]">发起于 {serviceRecordTime(record.startedAt)}{record.completedAt ? ` · 结果记录于 ${serviceRecordTime(record.completedAt)}` : ' · 结束时间未记录'}</p>
        <p>输入用量：{record.usage.inputTokens ?? '未知'} · 输出用量：{record.usage.outputTokens ?? '未知'}（Token）</p>
        {record.usage.totalTokens !== null && <p>服务返回合计：{record.usage.totalTokens} Token</p>}
        {(record.usage.cacheReadInputTokens !== null || record.usage.cacheCreationInputTokens !== null) && <p>缓存读取：{record.usage.cacheReadInputTokens ?? '未知'} · 缓存写入：{record.usage.cacheCreationInputTokens ?? '未知'}（Token）</p>}
        {(record.usage.inputTokens === null || record.usage.outputTokens === null) && <p className="text-xs text-[#6B6B6B]">服务未返回完整用量，不能据此计算整次消耗或扣费。</p>}
        <p className="text-xs text-[#6B6B6B]">Token 是服务返回的用量单位，不是字数或金额；不同服务的缓存统计口径不同，不直接相加。</p>
        {record.previousCallId && data.records.some((item) => item.id === record.previousCallId) && <p><a href={`#${record.previousCallId}`} className="underline">查看同类操作的上一次请求</a><span className="text-xs text-[#6B6B6B]">（可能是重做或改稿，不自动视为失败重试）</span></p>}
        {record.status !== 'completed' && <p>这次请求结果尚未完整确认，已显示用量也可能只覆盖部分响应。请先核对已有内容，再决定是否重新执行；再次请求可能产生费用。</p>}
      </li>)}</ol>
    </>}
  </div>;
}

export function ModelCallLimitEditor({ runId, limit, readVerified = true, onSaved }: { runId: string; limit: ModelCallLimit; readVerified?: boolean; onSaved: (limit: ModelCallLimit) => void }) {
  const [edit, setEdit] = useState<{ value: string; revision: number } | null>(null);
  const value = edit?.value ?? (limit.maxCalls === null ? '' : String(limit.maxCalls));
  const revision = edit?.revision ?? limit.revision;
  const dirty = edit !== null;
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const parsed = value.trim() === '' ? null : /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  const valid = parsed === null || (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 10000);
  async function save() {
    if (!valid || saving || !readVerified || revision !== limit.revision) return;
    setSaving(true); setMessage('');
    try {
      const response = await fetch('/api/production/service-calls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set-limit', runId, maxCalls: parsed, expectedRevision: revision }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '调用限制未能保存。');
      if (payload.runId !== runId || !payload.limit) throw new Error('调用限制返回的草稿不一致，请重新读取。');
      onSaved(payload.limit); setEdit(null); setMessage('调用限制已保存，不会发起模型请求。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '调用限制未能保存，你填写的次数仍保留。'); }
    finally { setSaving(false); }
  }
  return <section aria-label="本期模型调用限制" className="space-y-2 rounded-lg border border-black/10 p-3 text-sm leading-6">
    <h3 className="font-semibold">先限定本期调用次数</h3>
    <p>当前{limit.maxCalls === null ? '不限次数' : `上限 ${limit.maxCalls} 次`}；已记录 {limit.recordedCalls} 次{limit.remaining === null ? '' : `，还可发起 ${limit.remaining} 次`}。</p>
    <label className="block">本期累计最多调用几次<input aria-label="本期模型调用次数上限" type="text" inputMode="numeric" value={value} disabled={saving} placeholder="留空表示不限次数" className="ml-2 rounded border px-2 py-1" onChange={(event) => { setEdit({ value: event.target.value, revision }); setMessage(''); }} /></label>
    <p className="text-xs text-[#6B6B6B]">包含已记录的成功、失败、重试和未确认请求，修改限制不会清零。设为 0 可暂停新请求；已发出的请求不会被取消。</p>
    <p className="text-xs text-[#6B6B6B]">仅限制本期写作与模型改稿，不覆盖连接测试、独立对标、数据采集或产品外调用。这是次数限制，不是金额上限；实际费用仍以服务商账单为准。</p>
    {!valid && <p role="alert">请填写 0 到 10000 的整数，或留空。</p>}
    <button type="button" disabled={saving || !readVerified || !dirty || !valid || revision !== limit.revision} onClick={() => void save()} className="rounded bg-[#1C1C1E] px-3 py-2 font-semibold text-white disabled:opacity-40">{saving ? '正在保存限制' : '保存调用限制'}</button>
    {!readVerified && <p role="alert">当前限制尚未重新核实，上方为上次读取结果。你的输入仍保留，请先重新读取调用记录。</p>}
    {revision !== limit.revision && <><p role="alert">其他窗口已修改限制，你的输入仍保留。请核对上方当前限制。</p><button type="button" disabled={saving || !readVerified} className="underline" onClick={() => { setEdit({ value, revision: limit.revision }); setMessage('已核对当前限制，请再次点击保存以提交你的输入。'); }}>已核对，保留我的输入</button></>}
    {dirty && <button type="button" disabled={saving} className="ml-3 underline" onClick={() => { setEdit(null); setMessage(''); }}>放弃输入，使用已读取的限制</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}

export function ProductionCallHistory({ runId, refreshKey = '' }: { runId: string; refreshKey?: string }) {
  const [open, setOpen] = useState(false);
  const { data, pending, error, reload, onSaved } = useServiceCallHistory(runId, open, refreshKey);
  return <details id="current-service-calls" className="rounded-xl border border-black/10 bg-white p-4" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-semibold">本期模型调用与用量</summary>
    {open && <div className="mt-3 space-y-3">
      <button type="button" className="text-sm underline" disabled={pending} onClick={reload}>重新读取调用记录</button>
      {error && <p role="alert" className="text-sm">{error}</p>}
      {data?.runId === runId ? <>
        {data.limit && <ModelCallLimitEditor key={runId} runId={runId} limit={data.limit} readVerified={!pending && !error} onSaved={onSaved} />}
        <ModelCallRecords data={data} />
      </> : !error && <p role="status" className="text-sm">正在读取本期记录，不会重新请求生成。</p>}
    </div>}
  </details>;
}

export function CurrentDraftCallHistory() {
  const [selection, setSelection] = useState<ProductionWorkspaceContext | null>(null);
  useEffect(() => {
    const load = () => {
      try { setSelection(productionWorkspaceContext(window.localStorage.getItem(PRODUCTION_WORKSPACE_STORAGE_KEY))); }
      catch { setSelection({ state: 'unavailable' }); }
    };
    const changed = (event: StorageEvent) => { if (event.key === PRODUCTION_WORKSPACE_STORAGE_KEY || event.key === null) load(); };
    load(); window.addEventListener('focus', load); window.addEventListener('storage', changed);
    return () => { window.removeEventListener('focus', load); window.removeEventListener('storage', changed); };
  }, []);
  return <section aria-label="当前草稿的模型调用记录" className="space-y-2">
    {selection?.state === 'selected' ? <>
      <p className="text-sm font-semibold">{selection.name || '当前草稿'}</p>
      <ProductionCallHistory key={selection.runId} runId={selection.runId} />
      <a href={selection.returnHref} className="text-sm underline">回到这份草稿</a>
    </> : <p className="text-sm">{selection ? '先在工作台打开一份草稿，再查看它的模型调用记录。' : '正在确定当前草稿。'}</p>}
  </section>;
}
