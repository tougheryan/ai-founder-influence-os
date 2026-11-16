'use client';

import { useEffect, useState } from 'react';
import { displayClientError } from '@/lib/client-error-copy';
import { readContentPlanComparison, type ContentPlanComparison } from '@/lib/content-plan-comparison';
import { WRITING_BRIEF_FIELDS } from '@/lib/writing-brief';
import { ContentPackageReview } from './ContentPackageReview';

const ignoreReview = () => {};
const noChecks = {};

export function WritingPlanComparisonDetails({ comparison }: { comparison: ContentPlanComparison }) {
  return <div className="mt-3 space-y-3 text-sm leading-6">
    <p>{comparison.status.reason}</p>
    {comparison.currentError && <p role="status">{comparison.currentError}</p>}
    {comparison.sourceError && <p role="status">{comparison.sourceError}</p>}
    <p className="text-[#6B6B6B]">这里比较方案中的四项文字。文章是否落实这些要求，仍需结合下方正文判断。</p>
    {WRITING_BRIEF_FIELDS.map(({ key, label }) => {
      const canCompare = Boolean(comparison.source && comparison.current);
      const changed = canCompare && comparison.source![key] !== comparison.current![key];
      return <section key={key} aria-label={`${label}对照`} className="rounded-md border border-[#D8D1C9] p-3">
        <h3 className="font-semibold">{label}{canCompare && <span className="ml-2 text-xs font-normal">{changed ? '有变化' : '文字相同'}</span>}</h3>
        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          <div><p className="text-xs text-[#6B6B6B]">这稿使用的方案</p><p className="mt-1 whitespace-pre-wrap">{comparison.source ? comparison.source[key] || '当时未单独说明' : '版本未核实'}</p></div>
          <div><p className="text-xs text-[#6B6B6B]">当前保存的方案</p><p className="mt-1 whitespace-pre-wrap">{comparison.current ? comparison.current[key] || '当前未单独说明' : '版本未核实'}</p></div>
        </div>
      </section>;
    })}
  </div>;
}

export function WritingPlanComparison({ runId, packagePath, blueprintPath }: {
  runId: string;
  packagePath: string;
  blueprintPath: string;
}) {
  const [comparison, setComparison] = useState<ContentPlanComparison | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readContentPlanComparison({ runId, packagePath, blueprintPath }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setComparison(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(displayClientError(cause, '暂时无法读取方案对照。已有正文仍可阅读。')); });
    return () => controller.abort();
  }, [runId, packagePath, blueprintPath, attempt]);

  return <details className="rounded-lg border border-[#D8D1C9] p-4">
      <summary className="cursor-pointer text-sm font-semibold">对照这稿使用的方案与当前方案</summary>
      {comparison ? <WritingPlanComparisonDetails comparison={comparison} /> : <p role="status" className="mt-3 text-sm">{error || '正在读取方案版本…'}</p>}
      {(error || comparison?.sourceError || comparison?.currentError) && <button type="button" className="mt-3 text-sm underline" onClick={() => { setComparison(null); setError(''); setAttempt((value) => value + 1); }}>重新读取方案对照</button>}
    </details>;
}

export function SavedContentReview({ runId, packagePath, blueprintPath, requiredStageLabel, onReturn }: {
  runId: string;
  packagePath: string;
  blueprintPath: string;
  requiredStageLabel: string;
  onReturn: () => void;
}) {
  return <section aria-label="查看已有稿件" className="space-y-5 p-5 sm:p-6">
    <div className="rounded-lg border border-[#D8C8B5] bg-[#FFF9EF] p-4 text-sm leading-6">
      <h2 className="text-lg font-bold">查看已有稿件</h2>
      <p className="mt-2">原稿保留，可以先阅读和对照。修改、确认文章或继续制作前，请先完成「{requiredStageLabel}」。</p>
      <p className="mt-2">先核对当前写作要求，确认后可在改稿区带入结尾要求，并选择要替换的段落。</p>
      <button type="button" onClick={onReturn} className="mt-3 font-semibold underline underline-offset-4">返回待确认步骤</button>
    </div>
    <WritingPlanComparison key={`${runId}:${packagePath}:${blueprintPath}`} runId={runId} packagePath={packagePath} blueprintPath={blueprintPath} />
    <ContentPackageReview key={packagePath} packagePath={packagePath} checked={noChecks} onChange={ignoreReview} readOnly />
  </section>;
}
