'use client';

import type { PublishingEditRequest, PublishingIssue } from '@/lib/content-editing';

export function PublishingCopyNotice({ issues, path, sha256, onEdit, disabled }: {
  issues: PublishingIssue[]; path: string; sha256: string;
  onEdit?: (request: PublishingEditRequest) => void; disabled?: boolean;
}) {
  if (!issues.length) return null;
  return <section aria-label="读者内容检查" className="rounded-lg border border-[#D8C8B5] bg-[#FFF9EF] px-4 py-3 text-sm">
    <details>
      <summary className="cursor-pointer font-semibold">核对这 {issues.length} 处文字：可能夹着写作说明</summary>
      <p className="mt-2 text-xs leading-6 text-[#6B5543]">这些是措辞提示，不会自动删除。若文章正在引用或讨论这些表达，可以保留；是否适合读者，由你判断。</p>
      <ol className="mt-3 space-y-3">{issues.map((issue, index) => <li key={`${issue.sectionId}:${issue.selectionOffset}`}>
        <p className="text-xs text-[#6B6B6B]">{index + 1} · {issue.label}</p>
        <blockquote className="my-1 border-l-2 border-[#C49D58] pl-3 leading-6">{issue.quote}</blockquote>
        <p className="text-xs leading-6 text-[#6B5543]">{issue.message}</p>
        {onEdit && sha256 && <button type="button" disabled={disabled} aria-label={`修改第 ${index + 1} 处文字`} className="mt-1 underline underline-offset-4 disabled:opacity-40" onClick={() => onEdit({ path, sha256, issue })}>修改这句话</button>}
      </li>)}</ol>
    </details>
  </section>;
}
