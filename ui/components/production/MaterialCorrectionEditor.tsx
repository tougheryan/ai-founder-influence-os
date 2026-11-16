'use client';

import { useEffect, useRef, useState } from 'react';
import type { MaterialAnalysisContext, MaterialIntakeAnalysis } from '@/lib/material-analysis';
import { displayClientError } from '@/lib/client-error-copy';

export const MATERIAL_CORRECTION_GROUPS = [
  { key: 'opinions', label: '观点与做法' }, { key: 'facts', label: '事实' },
  { key: 'cases', label: '案例' }, { key: 'authorRequirements', label: '写作要求' }, { key: 'risks', label: '公开边界与待核实事项' },
  { key: 'illustrations', label: '示例与待核实描述' },
] as const;
type Group = typeof MATERIAL_CORRECTION_GROUPS[number]['key'];
type Fields = Pick<MaterialIntakeAnalysis, 'summary'> & Record<Group, string[]>;
type Source = { context: MaterialAnalysisContext; analysisFingerprint: string; editableAnalysis?: MaterialIntakeAnalysis };
type EditMode = { kind: 'all' } | { kind: 'requirement'; index: number | null };
function editable(analysis: MaterialIntakeAnalysis): Fields {
  return { summary: analysis.summary, opinions: [...analysis.opinions || []], facts: [...analysis.facts], cases: [...analysis.cases], authorRequirements: [...analysis.authorRequirements || []], risks: [...analysis.risks], illustrations: [...analysis.illustrations || []] };
}

export function MaterialCorrectionSummary({ analysis }: { analysis: MaterialIntakeAnalysis }) {
  return <div className="space-y-3 text-sm leading-6"><p>{analysis.summary}</p>{MATERIAL_CORRECTION_GROUPS.map(({ key, label }) => <div key={key}><p className="font-semibold">{label}</p>{analysis[key]?.length ? <ul className="list-disc space-y-1 pl-5">{analysis[key]!.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>未列出</p>}</div>)}</div>;
}

export function MaterialCorrectionEditor({ runId, analysis, disabled, onSaved }: { runId: string; analysis: MaterialIntakeAnalysis; disabled?: boolean; onSaved: (context: MaterialAnalysisContext) => void }) {
  const [mode, setMode] = useState<EditMode | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [loadedAnalysis, setLoadedAnalysis] = useState<{ basedOn: MaterialIntakeAnalysis; latest: MaterialIntakeAnalysis } | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [retryOnly, setRetryOnly] = useState(false);
  const operation = useRef('');
  const pending = useRef(false);
  const alive = useRef(true);
  // A deliberate reread may be newer than the parent snapshot. Keep it when
  // cancelling, but let a later parent analysis replace that local read.
  const visibleAnalysis = loadedAnalysis?.basedOn === analysis ? loadedAnalysis.latest : analysis;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function load(nextMode: EditMode = { kind: 'all' }) {
    if (pending.current || disabled) return;
    const previousRequirements = mode?.kind === 'requirement' && source
      ? (source.editableAnalysis || source.context.analysis).authorRequirements || []
      : visibleAnalysis.authorRequirements || [];
    const expectedRequirement = nextMode.kind === 'requirement' && nextMode.index !== null ? previousRequirements[nextMode.index] : undefined;
    pending.current = true; setWorking(true); setMode(nextMode); setMessage('');
    if (!mode) { setSource(null); setFields(null); }
    try {
      const response = await fetch(`/api/production/material-analysis?runId=${encodeURIComponent(runId)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '无法读取整理结果。');
      if (data.context?.runId !== runId || data.context?.analysisStatus !== 'current') throw new Error('原始素材已经变化，请重新整理后再修改。');
      if (!alive.current) return;
      const nextFields = editable(data.editableAnalysis || data.context.analysis);
      setLoadedAnalysis({ basedOn: analysis, latest: data.editableAnalysis || data.context.analysis });
      setSource(data); setFields(nextFields); setConflict(false); setRetryOnly(false); operation.current = '';
      if (nextMode.kind === 'requirement' && nextMode.index !== null && nextFields.authorRequirements[nextMode.index] !== expectedRequirement) {
        setMode({ kind: 'requirement', index: null });
        setMessage('写作要求已有更新。请从当前列表重新选择要修改的那条。');
      }
    } catch (error) { if (alive.current) setMessage(displayClientError(error, '无法读取整理结果，请重试。')); }
    finally { pending.current = false; if (alive.current) setWorking(false); }
  }
  function change(next: Fields) { setFields(next); operation.current = ''; setMessage(''); }
  async function save() {
    if (!fields || !source || pending.current || disabled || conflict) return;
    pending.current = true; setWorking(true); setMessage('');
    operation.current ||= `correction_${crypto.randomUUID().replaceAll('-', '')}`;
    let responseStatus = 0;
    try {
      const response = await fetch('/api/production/material-corrections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, id: operation.current, expectedFingerprint: source.analysisFingerprint, changes: fields }) });
      responseStatus = response.status;
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && alive.current) setConflict(true);
        throw new Error(data.error || '修正尚未保存。');
      }
      if (!alive.current) return;
      const savedRequirement = mode?.kind === 'requirement';
      setSource(data); setFields(editable(data.context.analysis)); setMode(null); setRetryOnly(false); operation.current = '';
      onSaved(data.context);
      setMessage(savedRequirement ? '这条要求已保存。其他要求和原始素材保留；已有方案与旧稿请重新核对。' : '修正已保存。原始材料、已有参考和旧稿都保留；请重新核对方案后继续。');
    } catch (error) {
      if (alive.current) { setRetryOnly(responseStatus === 0 || responseStatus >= 500); setMessage(displayClientError(error, '未收到保存结果，填写内容还在。可以重试同一次保存，或重新读取核对。')); }
    } finally { pending.current = false; if (alive.current) setWorking(false); }
  }
  function cancel() {
    setMode(null); setFields(null); setSource(null); setMessage(''); setRetryOnly(false); setConflict(false); operation.current = '';
  }
  const locked = working || disabled || retryOnly || conflict;
  const invalid = !fields || !fields.summary.trim() || MATERIAL_CORRECTION_GROUPS.some(({ key }) => fields[key].some((value) => !value.trim()));
  const single = mode?.kind === 'requirement';
  const requirements = single && fields ? fields.authorRequirements : visibleAnalysis.authorRequirements || [];
  const unchangedRequirement = single && mode.index !== null && fields && source
    && fields.authorRequirements[mode.index] === (source.editableAnalysis || source.context.analysis).authorRequirements?.[mode.index];
  const feedback = <>
    {conflict && <p className="text-sm leading-6">本地文字仍可选中复制。请先保留需要的修改，再读取已保存结果并重新核对。</p>}
    {message && <p role="status" className="mt-3 text-sm leading-6 text-[#72513C]">{message}</p>}
  </>;
  return <div>
    {requirements.length > 0 && <section aria-label="本期写作要求" className="mt-4 rounded-xl border border-[#DDE5D7] bg-[#F8FAF5] p-4">
      <h3 className="text-sm font-semibold text-[#1A1A1A]">这次按你的要求写</h3>
      <p className="mt-1 text-sm leading-6 text-[#666]">请核对这些要求；它们优先于系统推荐，只用于本期。</p>
      <ul className="mt-2 space-y-2 text-sm leading-relaxed text-[#303030]">
        {requirements.map((requirement, index) => <li key={index} className="rounded-md border border-[#E2E7DD] bg-white px-3 py-2">
          {single && mode.index === index && fields ? <div className="space-y-2">
            <label className="block font-semibold">修改第 {index + 1} 条写作要求<textarea aria-label={`修改第 ${index + 1} 条写作要求`} autoFocus value={requirement} disabled={working || disabled} readOnly={retryOnly || conflict} rows={2} maxLength={600} onChange={(event) => change({ ...fields, authorRequirements: fields.authorRequirements.map((value, i) => i === index ? event.target.value : value) })} className="mt-2 w-full rounded border border-[#B9C6AD] bg-white p-2 font-normal focus:outline-2 focus:outline-offset-2 focus:outline-[#52790C]" /></label>
            <p className="text-xs leading-5 text-[#62584F]">只改这一条，不调用模型。保存后，已有方案和后续确认需要重新核对。</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={working || disabled || conflict || invalid || Boolean(unchangedRequirement)} onClick={() => void save()} className="rounded-full bg-[#1A1A1A] px-4 py-2 text-sm text-white disabled:opacity-40">{working ? '正在保存…' : retryOnly ? '重试这次保存' : '保存这条要求'}</button>
              <button type="button" disabled={working || disabled} onClick={cancel} className="px-2 py-2 underline disabled:opacity-40">取消修改</button>
            </div>
            {feedback}
            {(conflict || retryOnly) && <button type="button" disabled={working || disabled} onClick={() => void load(mode)} className="text-xs underline disabled:opacity-40">放弃本地修改，读取已保存要求</button>}
          </div> : <div className="flex items-start justify-between gap-3"><span className="min-w-0 break-words">{requirement}</span><button type="button" aria-label={`修改第 ${index + 1} 条写作要求`} disabled={working || disabled || (mode !== null && !(single && mode.index === null))} onClick={() => void load({ kind: 'requirement', index })} className="shrink-0 px-2 py-1 text-xs underline disabled:opacity-40">修改</button></div>}
        </li>)}
      </ul>
      {single && <>
        {working && !fields && <p role="status" className="mt-2 text-sm">正在读取这条要求…</p>}
        {(!fields || mode.index === null) && <button type="button" disabled={working || disabled} onClick={cancel} className="mt-2 text-sm underline">取消修改</button>}
        {(!fields || mode.index === null) && <>{feedback}<button type="button" disabled={working || disabled} onClick={() => void load(mode)} className="mt-3 text-xs underline disabled:opacity-40">重新读取写作要求</button></>}
      </>}
    </section>}
    <section aria-label="修正素材整理结果" className="mt-3 space-y-4 rounded-lg border border-[#CFC5B9] bg-[#FAF8F4] p-4">
    {mode?.kind !== 'all' ? <button type="button" disabled={working || disabled || single} onClick={() => void load()} className="text-sm font-semibold underline underline-offset-4 disabled:opacity-40">调整素材分类与全部要求</button> : <>
      <div><h3 className="font-semibold">修正这次的理解</h3><p className="mt-2 text-sm leading-6 text-[#62584F]">直接修改、删除或调整分类。原始材料与来源保留；只用于本期，不会自动存为长期偏好，也不调用模型或重新采集参考。保存后，方案及后续确认需要重新核对，旧稿仍可查看。</p></div>
      {fields && <>
        <label className="block text-sm font-semibold">素材概述<textarea aria-label="修正素材概述" disabled={working || disabled} readOnly={retryOnly || conflict} value={fields.summary} rows={3} maxLength={4000} onChange={(event) => change({ ...fields, summary: event.target.value })} className="mt-2 w-full rounded border border-[#D8D1C9] bg-white p-2 font-normal" /></label>
        {MATERIAL_CORRECTION_GROUPS.map(({ key, label }) => <fieldset key={key} disabled={working || disabled} className="space-y-3"><legend className="mb-2 text-sm font-semibold">{label}（{fields[key].length}/12）</legend>
          {fields[key].map((value, index) => <div key={index} className="rounded border border-[#DDD5CA] bg-white p-3"><textarea aria-label={`${label}第${index + 1}条`} value={value} readOnly={retryOnly || conflict} rows={2} maxLength={600} onChange={(event) => change({ ...fields, [key]: fields[key].map((item, i) => i === index ? event.target.value : item) })} className="w-full rounded border border-[#D8D1C9] p-2 text-sm" /><div className="mt-2 flex flex-wrap items-center gap-3 text-xs"><label>调整分类<select aria-label={`${label}第${index + 1}条分类`} value={key} disabled={retryOnly || conflict} onChange={(event) => {
            const to = event.target.value as Group;
            if (to === key || fields[to].length >= 12) return;
            change({ ...fields, [key]: fields[key].filter((_, i) => i !== index), [to]: [...fields[to], value] });
          }} className="ml-2 rounded border p-1">{MATERIAL_CORRECTION_GROUPS.map((group) => <option key={group.key} value={group.key} disabled={group.key !== key && fields[group.key].length >= 12}>{group.label}</option>)}</select></label><button type="button" aria-label={`删除${label}第${index + 1}条`} disabled={retryOnly || conflict} onClick={() => change({ ...fields, [key]: fields[key].filter((_, i) => i !== index) })} className="underline">删除这条</button></div></div>)}
          <button type="button" disabled={locked || fields[key].length >= 12} onClick={() => change({ ...fields, [key]: [...fields[key], ''] })} className="text-sm underline">添加{label}</button>
        </fieldset>)}
        <p className="text-xs text-[#62584F]">空白条目请删除；清空一组表示本期不再采用这一组提炼。</p>
        <button type="button" disabled={working || disabled || conflict || invalid} onClick={() => void save()} className="rounded-full bg-[#1A1A1A] px-5 py-2 text-sm text-white disabled:opacity-40">{working ? '正在保存…' : retryOnly ? '重试这次保存' : '保存修正'}</button>
      </>}
      <div className="flex flex-wrap gap-4 text-sm"><button type="button" disabled={working || disabled} onClick={cancel} className="underline">取消编辑</button><button type="button" disabled={working || disabled} onClick={() => void load()} className="underline">放弃本地修改，读取已保存结果</button></div>
    </>}
    </section>
    {!single && feedback}
  </div>;
}
