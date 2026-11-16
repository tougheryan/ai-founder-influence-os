'use client';

import { useEffect, useRef, useState } from 'react';
import { displayClientError } from '@/lib/client-error-copy';
import { appendPreferenceText, reusablePreferenceText, type DraftPreferenceCandidate } from '@/lib/draft-preference-candidates';

type Props = { runId: string; inputFingerprint: string; disabled?: boolean };
type Review = {
  analysisFingerprint: string;
  profile: { version: number; profile: { targetAudience: string; writingStyle: string; prohibitions: string } };
  candidates: DraftPreferenceCandidate[];
};

/** Key the whole review to its explicit source; no active-run or draft lookup. */
export function DraftPreferenceReuse(props: Props) {
  if (!props.runId || !props.inputFingerprint || props.disabled) return null;
  return <PreferenceReview key={`${props.runId}:${props.inputFingerprint}`} {...props} />;
}

function PreferenceReview({ runId, inputFingerprint }: Props) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setOpen(true); setBusy(true); setError(''); setSaved(false); setReview(null); setSelected([]);
    try {
      const params = new URLSearchParams({ runId, inputFingerprint });
      const response = await fetch(`/api/creative-library/profile?${params}`, { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(displayClientError(payload, '偏好建议没有读取成功，请重试。'));
      if (controller.signal.aborted) return;
      const next = payload as Review;
      setReview(next); setChoices(Object.fromEntries(next.candidates.map((item) => [item.id, item.value])));
    } catch (cause) { if (!controller.signal.aborted) setError(displayClientError(cause, '偏好建议没有读取成功，请重试。')); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const save = async () => {
    if (!review || !selected.length) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/creative-library/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ action: 'append-preferences', runId, inputFingerprint, analysisFingerprint: review.analysisFingerprint,
          expectedVersion: review.profile.version, choices: selected.map((id) => ({ id, value: choices[id].trim() })) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(displayClientError(payload, '偏好没有保存成功，请重试。'));
      if (!controller.signal.aborted) { setSaved(true); setOpen(false); setReview(null); setSelected([]); }
    } catch (cause) { if (!controller.signal.aborted) setError(displayClientError(cause, '偏好没有保存成功，请重试。')); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const valid = selected.length > 0 && selected.every((id) => reusablePreferenceText(choices[id] || ''));
  return <section className="rounded border border-[#D8DECF] bg-[#FAFCF7] p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-sm font-semibold text-[#263821]">有些要求，下次也想沿用？</h3><p className="mt-1 text-xs leading-6 text-[#586351]">从本篇要求中挑选，逐项确认后保存到写作设置。本篇要求仍然优先。</p></div>
      {!open && <button type="button" onClick={() => void load()} disabled={busy} className="rounded border border-[#CBD5BF] bg-white px-3 py-2 text-xs font-semibold">挑选长期偏好</button>}
    </div>
    {saved && <p role="status" className="mt-2 text-xs text-[#3F6508]">已把你选择的偏好加入写作设置；原有设置和本篇要求都保留。可在“账号与写作设置”中编辑或删除。</p>}
    {open && <div className="mt-3 space-y-3">
      {busy && <p role="status" className="text-xs">{review ? '正在保存你选中的偏好…' : '正在读取本篇要求…'}</p>}
      {review && !review.candidates.length && <p className="text-xs leading-6 text-[#586351]">本篇没有识别到适合长期保留的读者、表达或禁写偏好。字数、平台、一次性要求和内部测试限制不会带入。</p>}
      {review?.candidates.map((item) => <div key={item.id} className="rounded border border-[#D8DECF] bg-white p-3">
        <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={selected.includes(item.id)} disabled={busy} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />长期保留：{item.label}</label>
        <p className="my-2 whitespace-pre-wrap text-xs leading-6 text-[#70776D]">本篇要求：{item.source}</p>
        <label className="block text-xs text-[#586351]">可修改后再保存<textarea aria-label={`${item.label}候选`} value={choices[item.id] || ''} disabled={busy} maxLength={600} rows={2} onChange={(event) => setChoices((current) => ({ ...current, [item.id]: event.target.value }))} className="mt-1 block w-full rounded border border-[#CDD5C7] p-2 text-sm text-[#263821]" /></label>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-[#586351]">已有设置：{review.profile.profile[item.field] || '尚未设置'}</p>
        {selected.includes(item.id) && <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-[#263821]">保存后：{appendPreferenceText(review.profile.profile[item.field], review.candidates.filter((candidate) => candidate.field === item.field && selected.includes(candidate.id)).map((candidate) => choices[candidate.id]?.trim() || '').filter(Boolean))}</p>}
      </div>)}
      {selected.length > 0 && !valid && <p className="text-xs text-[#934A39]">请填写长期偏好，去掉本篇字数、平台或临时限制。</p>}
      {error && <p role="alert" className="text-xs text-[#934A39]">{error} <button type="button" disabled={busy} onClick={() => void load()} className="underline">重新读取并核对</button></p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !valid} onClick={() => void save()} className="rounded bg-[#263821] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">保存选中的 {selected.length} 项长期偏好</button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setReview(null); setSelected([]); setError(''); }} className="rounded border border-[#CBD5BF] px-3 py-2 text-xs">这次不保存</button>
      </div>
    </div>}
  </section>;
}
