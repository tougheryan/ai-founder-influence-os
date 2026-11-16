'use client';

import { useEffect, useState } from 'react';
import type { WritingRequirementReview } from '@/lib/writing-requirement-review';

export function WritingRequirementsResult({ review }: { review: WritingRequirementReview }) {
  if (!review.applicable) return null;
  return <section aria-label="本篇写作要求核对" className="space-y-3 rounded-lg border border-[#D8D1C9] bg-[#FFF9EC] p-4 text-sm">
    <h3 className="font-bold">按这篇的要求核对口播</h3>
    <p>口播：{review.characterCount ?? '暂无法统计'} 个非空白字符{review.range ? `；本篇要求 ${review.range.min}–${review.range.max} 字` : ''}。包含标点与数字，不计字幕、时间和镜头。</p>
    <div><p className="font-semibold">当前结尾原句</p><blockquote className="whitespace-pre-wrap border-l-2 border-[#D8D1C9] pl-3">{review.ending || '尚无可识别的口播末句'}</blockquote></div>
    {review.findings.map((finding, index) => <div key={`${finding.kind}:${index}`}><p>{finding.message}</p>{finding.quote && <blockquote className="whitespace-pre-wrap border-l-2 border-[#D8D1C9] pl-3">{finding.quote}</blockquote>}</div>)}
    {!review.findings.length && <p>{review.requirements.length ? '这些明确要求未发现机械检查可识别的偏差。' : '本篇尚未设置可核对的写作要求。'}</p>}
    <details><summary className="cursor-pointer">对照本篇已确认的要求</summary><ul className="mt-2 list-disc pl-5">{review.requirements.map((requirement, index) => <li key={index}>{requirement}</li>)}</ul></details>
    <p className="text-xs text-[#6B6B6B]">事实、经历是否真实，以及问题是否具体，仍需你对照素材核对。这些检查不代表成稿质量通过。</p>
  </section>;
}

export function WritingRequirementsReview({ runId, path, recoveryId, refreshKey }: { runId: string; path: string; recoveryId?: string; refreshKey: string }) {
  const key = JSON.stringify([runId, path, recoveryId, refreshKey]);
  const [result, setResult] = useState<{ key: string; review?: WritingRequirementReview; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/production/content-revisions?${new URLSearchParams({ runId, path, ...(recoveryId ? { recoveryId } : {}) })}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '暂时无法读取本篇要求。');
        if (!controller.signal.aborted) setResult({ key, review: data.source?.writingReview });
      } catch (cause) { if (!controller.signal.aborted) setResult({ key, error: cause instanceof Error ? cause.message : '暂时无法核对，请重新读取稿件。' }); }
    })();
    return () => controller.abort();
  }, [runId, path, recoveryId, key]);
  const { review, error } = result?.key === key ? result : {};
  return error ? <p role="status" className="text-sm text-[#8F3329]">本篇要求尚未核对：{error}</p> : review ? <WritingRequirementsResult review={review} /> : null;
}
