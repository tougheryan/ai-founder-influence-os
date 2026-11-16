'use client';

import { BlueprintPlanReview } from './BlueprintPlanReview';
import { canConfirmBlueprintScope, type BlueprintSection, type BlueprintSectionEdit, type BlueprintScope } from '@/lib/blueprint-sections';
import { MaterialCorrectionSummary } from './MaterialCorrectionEditor';
import type { MaterialIntakeAnalysis } from '@/lib/material-analysis';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WRITING_BRIEF_FIELDS, writingBriefEndingProposal, type WritingBrief } from '@/lib/writing-brief';

type Source = { sections?: BlueprintSection[]; platformScope?: BlueprintScope; sourceMaterial?: string; researchMode?: 'platform' | 'author_material'; path: string; sha256: string; brief: WritingBrief; materialCorrectionId?: string; correctedAnalysis?: MaterialIntakeAnalysis | null };
type Props = { runId: string; templateId: string; busy: boolean; onSaved: (path: string) => void; onConfirmed: (path: string) => Promise<void>; onViewSavedContent?: () => void };

export function WritingBriefReview({ runId, templateId, busy, onSaved, onConfirmed, onViewSavedContent }: Props) {
  const [source, setSource] = useState<Source | null>(null);
  const [brief, setBrief] = useState<WritingBrief | null>(null);
  const [sectionEdits, setSectionEdits] = useState<BlueprintSectionEdit[]>([]);
  const [sectionPreview, setSectionPreview] = useState(false);
  const [working, setWorking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState('');
  const [showEndingPreview, setShowEndingPreview] = useState(false);
  const mounted = useRef(true);
  const confirmationId = useRef('');
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/production/writing-brief?runId=${encodeURIComponent(runId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '无法读取方案。');
      if (mounted.current) { setSource(data); setBrief(data.brief); setChecked(false); setShowEndingPreview(false); setMessage(''); setSectionEdits([]); setSectionPreview(false); confirmationId.current = ''; }
    } catch (error) { if (mounted.current) setMessage((error as Error).message); }
  }, [runId]);
  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void load(), 0);
    return () => { mounted.current = false; window.clearTimeout(timer); };
  }, [load]);

  async function save(confirm: boolean) {
    if (!source || !brief || working || busy || (sectionEdits.length > 0 && !sectionPreview) || (confirm && (!checked || sectionEdits.length > 0 || !canConfirmBlueprintScope(source.platformScope)))) return;
    setWorking(true); setMessage('');
    try {
      const response = await fetch('/api/production/writing-brief', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, basePath: source.path, baseSha256: source.sha256, materialCorrectionId: source.materialCorrectionId || '', brief, sectionEdits }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '方案未能保存。');
      if (!mounted.current) return;
      setSource(data); setBrief(data.brief); setSectionEdits([]); setSectionPreview(false); onSaved(data.path);
      if (confirm) {
        if (!canConfirmBlueprintScope(data.platformScope)) throw new Error('方案已保存，平台范围仍需修改。请核对具体方案后再确认。');
        confirmationId.current ||= `brief-${crypto.randomUUID()}`;
        const approval = await fetch('/api/production/advance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          stage: 'topic-template', runId, artifactPath: data.path, reviewedMaterialCorrectionId: source.materialCorrectionId || '', templateId, requestId: confirmationId.current,
          reviewAssertions: { ...(source.researchMode === 'author_material' ? { author_source_reviewed: true } : { market_evidence_reviewed: true }), topic_boundary_and_goal_confirmed: true, brand_template_confirmed: true },
        }) });
        const result = await approval.json();
        if (!approval.ok || result.advanced !== true) throw new Error(result.error || '方案已保存，确认未完成，请重试。');
        await onConfirmed(data.path);
      } else { setChecked(false); setMessage('方案已保存。旧版本保留；核对后再确认。'); }
    } catch (error) { if (mounted.current) setMessage((error as Error).message); }
    finally { if (mounted.current) setWorking(false); }
  }
  const endingProposal = brief ? writingBriefEndingProposal(brief) : null;
  return <section aria-labelledby="writing-brief-title" className="space-y-5 rounded-lg border border-[rgba(28,28,30,0.12)] bg-white p-5">
    <div><h2 id="writing-brief-title" className="text-lg font-bold text-[#1A1A1A]">先看写作方向</h2><p className="mt-2 text-sm leading-6 text-[#6B6B6B]">{source?.researchMode === 'author_material' ? '这四项会直接用于正文。本期依据你的素材，未进行平台研究。可以修改后保存，不会调用模型。' : '这四项会直接用于正文。可以改文字后保存，沿用本期研究和排版设置，不会重新调用研究或写作服务。'}</p></div>
    {onViewSavedContent && <div className="text-sm leading-6">
      <p>这期已有稿件，可以先对照。确认方案后，再决定如何处理原稿。</p>
      <button type="button" disabled={working || busy} onClick={onViewSavedContent} className="mt-2 font-semibold underline underline-offset-4">查看已有稿件与方案对照</button>
    </div>}
    {source?.correctedAnalysis && <aside aria-label="本期已修正的素材" className="space-y-3 rounded border border-[#D8B576] bg-[#FFF9EC] p-4"><h3 className="font-semibold">先核对本期修正</h3><p className="text-sm leading-6">{source.researchMode === 'author_material' ? '下面是你保存的整理结果。请核对方案与它是否一致。本期不使用平台研究；确认不会自动改写旧稿。' : '下面是作者保存的整理结果。请检查方案与它是否一致，并核对已有参考是否仍适用；需要时可以返回素材重新研究。本次确认不会重新采集，也不会自动改写旧稿。'}</p><MaterialCorrectionSummary analysis={source.correctedAnalysis} /></aside>}
    {source && <BlueprintPlanReview sections={source.sections || []} scope={source.platformScope} sourceMaterial={source.sourceMaterial} edits={sectionEdits} preview={sectionPreview} disabled={working || busy} onPreview={() => setSectionPreview(true)} onChange={(edits) => {
      setSectionEdits(edits); setSectionPreview(false); setChecked(false); confirmationId.current = '';
    }} />}
    {brief ? <>
      {WRITING_BRIEF_FIELDS.map(({ key, label, rows }) => <label key={key} className="block text-sm font-semibold text-[#1A1A1A]">{label}<textarea className="mt-2 block w-full resize-y rounded-md border border-[#D8D1C9] bg-white p-3 text-sm font-normal leading-6 focus:border-[#E85D4C] focus:outline-none" rows={rows} maxLength={6000} value={brief[key]} disabled={working || busy} placeholder="方案没有写清这一项，请补充后继续。" onChange={(event) => { setBrief({ ...brief, [key]: event.target.value }); setChecked(false); setShowEndingPreview(false); confirmationId.current = ''; }} /></label>)}
      {endingProposal && <aside aria-label="核对收尾要求" className="space-y-3 rounded-md border border-[#D8B576] bg-[#FFF9EC] p-4 text-sm leading-6">
        <p className="font-semibold">两处都写了收尾要求，请核对是否一致</p>
        <p>结构中的要求：</p>
        {endingProposal.previous.map((text, index) => <blockquote key={index} className="border-l-2 border-[#D8B576] pl-3">{text}</blockquote>)}
        <p>最后怎样收尾：{brief.ending}</p>
        <p>可以保留并手动调整，也可以让结构统一引用最后一项。这里只修改方案，已有文章仍需单独核对。</p>
        {showEndingPreview ? <div className="space-y-3">
          <p className="font-semibold">修改后的结构（尚未保存）</p>
          <p className="whitespace-pre-wrap">{endingProposal.structure}</p>
          <button type="button" disabled={working || busy} className="mr-4 font-semibold underline" onClick={() => {
            setBrief({ ...brief, structure: endingProposal.structure }); setChecked(false); setShowEndingPreview(false); confirmationId.current = '';
            setMessage('已统一方案中的收尾要求，尚未保存。请核对后保存；原文章不会自动改动。');
          }}>用这个结构</button>
          <button type="button" disabled={working || busy} className="underline" onClick={() => setShowEndingPreview(false)}>取消预览</button>
        </div> : <button type="button" disabled={working || busy} className="font-semibold underline" onClick={() => setShowEndingPreview(true)}>预览统一收尾</button>}
      </aside>}
      <label className="flex items-start gap-2 text-sm leading-6 text-[#4B4742]"><input type="checkbox" className="mt-1" checked={checked} disabled={working || busy || sectionEdits.length > 0 || !canConfirmBlueprintScope(source?.platformScope)} onChange={(event) => setChecked(event.target.checked)} />{source?.researchMode === 'author_material' ? '我已核对自己的素材、写作要求、公开边界和排版选择。方案与它们一致；本期未进行平台研究。' : source?.correctedAnalysis ? '我已核对修正后的事实、观点、写作要求和公开边界，方案与它们一致，已有研究仍适用于本期。' : onViewSavedContent ? '我已核对写作方向、研究边界和本期排版选择，确认后继续处理已有稿件。' : '我已核对写作方向、研究边界和本期排版选择，确认后开始写正文。'}</label>
      <div className="flex flex-wrap gap-3"><button type="button" onClick={() => void save(false)} disabled={working || busy || (sectionEdits.length > 0 && !sectionPreview)} className="rounded-full border border-[#1A1A1A] px-4 py-2 text-sm disabled:opacity-50">只保存方案</button><button type="button" onClick={() => void save(true)} disabled={working || busy || !checked || sectionEdits.length > 0 || !canConfirmBlueprintScope(source?.platformScope) || WRITING_BRIEF_FIELDS.some(({ key }) => !brief[key].trim())} className="rounded-full bg-[#1A1A1A] px-4 py-2 text-sm text-white disabled:opacity-40">{working ? '正在保存…' : '确认方案，进入正文'}</button></div>
    </> : !message && <p className="text-sm text-[#6B6B6B]">正在读取已生成的方案…</p>}
    {message && <p role="status" className="text-sm leading-6 text-[#8F3329]">{message}</p>}
    <button type="button" onClick={() => void load()} disabled={working || busy} className="text-xs text-[#6B6B6B] underline">重新读取已保存的方案</button>
  </section>;
}
