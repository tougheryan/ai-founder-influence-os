'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { contentPlanNeedsReview, type ContentPlanStatus } from '@/lib/content-plan';
import { displayClientError } from '@/lib/client-error-copy';
import { WritingPlanComparison } from './SavedContentReview';

export function ContentPlanNotice({ runId, packagePath, blueprintPath, disabled, onReviewChange, onEditEnding }: {
  runId: string;
  packagePath: string;
  blueprintPath: string;
  disabled?: boolean;
  onReviewChange: (ready: boolean, reviewedPlanSha256: string, materialCorrectionId?: string) => void;
  onEditEnding?: () => void;
}) {
  const [status, setStatus] = useState<ContentPlanStatus | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const requestSequence = useRef(0);
  const invalidateRequests = useCallback(() => { requestSequence.current += 1; }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    setStatus(null);
    setError('');
    setChecked(false);
    onReviewChange(false, '');
    try {
      const response = await fetch(`/api/production/content-plan?runId=${encodeURIComponent(runId)}`, { signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '暂时无法核对正文与方案。');
      if (data.package_path !== packagePath || data.blueprint_path !== blueprintPath) throw new Error('正文或方案已更新，请刷新本期进度。');
      if (signal?.aborted || sequence !== requestSequence.current) return;
      setStatus(data);
      onReviewChange(data.status === 'current' || data.status === 'retained', '', data.material_correction_id || '');
    } catch (cause) {
      if (!signal?.aborted && sequence === requestSequence.current) setError(displayClientError(cause, '暂时无法核对正文与方案，请重试。'));
    }
  }, [runId, packagePath, blueprintPath, onReviewChange]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { void load(controller.signal); }, 0);
    return () => { clearTimeout(timer); controller.abort(); invalidateRequests(); };
  }, [load, invalidateRequests]);

  const summary = error || status?.status === 'unavailable'
    ? '暂时无法核对稿件版本 · 展开重试'
    : checked ? '已选择保留这稿 · 仍需确认文章'
      : status?.status === 'outdated' ? '写作方案已更新 · 展开核对后继续'
        : status?.status === 'unknown' ? '这份旧稿的方案待核对 · 展开后继续'
          : status?.status === 'retained' ? '已确认保留这份稿件'
            : status?.status === 'current' ? '稿件与方案版本一致'
              : '正在核对这稿使用的方案…';

  return (
    <details aria-label="正文与写作方案" className="rounded-lg border border-[#D8C8B5] bg-[#FFF9EF] px-4 py-3 text-sm">
      <summary className="cursor-pointer font-semibold leading-6 text-[#44382C]"><span role="status">{summary}</span></summary>
      <p className="mt-2 leading-6 text-[#6B5543]">{error || status?.reason || '核对完成后会显示稿件与方案的版本关系。'}</p>
      {status && contentPlanNeedsReview(status.status) && (
        <>
          <a href="/production?stage=2" className="mt-2 inline-block underline">查看当前写作方案</a>
          <WritingPlanComparison key={`${runId}:${packagePath}:${blueprintPath}`} runId={runId} packagePath={packagePath} blueprintPath={blueprintPath} />
          {onEditEnding && <div className="mt-3 rounded-md border border-[#D8C8B5] bg-white p-3">
            <p className="leading-6">如果这次只调整结尾，可以带入当前要求，选择从哪段开始修改。其他文字保留，之后再核对全文。</p>
            <button type="button" disabled={disabled} onClick={onEditEnding} className="mt-2 font-semibold underline underline-offset-4">按当前要求修改结尾</button>
          </div>}
          <label className="mt-3 flex items-start gap-2 text-[#44382C]">
            <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => {
              setChecked(event.target.checked);
              onReviewChange(event.target.checked, event.target.checked ? status.blueprint_sha256 : '', status.material_correction_id || '');
            }} className="mt-1" />
            <span>我已对照当前方案和素材修正检查，选择保留这稿。之后仍需确认文章内容。</span>
          </label>
          <details className="mt-2 text-[#6B5543]">
            <summary className="cursor-pointer">如何处理方案变化</summary>
            <p className="mt-2 leading-6">可以查看方案后修改相关文字，或重新生成。原稿会保留；修改方案本身不会自动改写正文。</p>
          </details>
        </>
      )}
      {(error || status?.status === 'unavailable') && <button type="button" disabled={disabled} onClick={() => { void load(); }} className="mt-2 underline">重新核对稿件版本</button>}
    </details>
  );
}
