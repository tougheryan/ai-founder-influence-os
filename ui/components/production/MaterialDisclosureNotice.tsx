'use client';

import { internalOnlyRestrictions } from '@/electron/material-disclosure.cjs';

export function MaterialDisclosureNotice({ risks, stale, onReview }: {
  risks?: readonly string[]; stale?: boolean; onReview: () => void;
}) {
  const restrictions = internalOnlyRestrictions(risks);
  if (!restrictions.length) return null;
  return <aside aria-label="本期公开限制" className="flex items-start justify-between gap-4 rounded-lg border border-[#E4D7C3] bg-[#FBF6EC] px-4 py-3 text-sm text-[#665238]">
    <details className="min-w-0 flex-1"><summary className="cursor-pointer"><strong>{stale ? '素材已变化，请重新核对公开限制' : '本期仅供内部预览'}</strong><span className="ml-2 text-xs">查看限制原句与说明</span></summary>
      <p className="mt-2 leading-6">可以继续写作、排版和下载。确认稿件或下载文件不会解除公开限制，填入外部平台草稿也属于对外传送。</p>
      <ul className="mt-2 list-disc pl-5">{restrictions.map((line) => <li key={line}>{line}</li>)}</ul>
      <p className="mt-2 text-xs leading-5">内部预览指不送入发布平台；模型写作仍使用你配置的服务。更改用途前，请先核对素材中的限制，再确认后续内容。</p>
    </details>
    <button type="button" onClick={onReview} className="shrink-0 underline underline-offset-4">核对公开限制</button>
  </aside>;
}
