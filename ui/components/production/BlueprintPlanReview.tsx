'use client';

import type { BlueprintSection, BlueprintSectionEdit, BlueprintScope } from '@/lib/blueprint-sections';

export function BlueprintPlanReview({ sections, scope, sourceMaterial, edits, preview, disabled, onChange, onPreview }: {
  sections: BlueprintSection[]; scope?: BlueprintScope; sourceMaterial?: string;
  edits: BlueprintSectionEdit[]; preview: boolean; disabled: boolean;
  onChange: (edits: BlueprintSectionEdit[]) => void; onPreview: () => void;
}) {
  const change = (section: BlueprintSection, text: string) => onChange([
    ...edits.filter((edit) => edit.id !== section.id),
    ...(text === section.text ? [] : [{ id: section.id, text }]),
  ]);
  return <section aria-labelledby="blueprint-plan-title" className="space-y-4 border-t border-[#E5DDD6] pt-5">
    <h3 id="blueprint-plan-title" className="font-bold">逐章核对具体方案</h3>
    <div role="status" className={`rounded-md p-3 text-sm leading-6 ${scope?.scope_matches ? 'bg-[#EDF8F0]' : 'bg-[#FFF9EC]'}`}>
      <p className="font-semibold">{scope?.scope_status === 'legacy' ? '旧版方案，按历史格式核对' : scope?.scope_matches ? '平台范围已核对' : '方案已保存，平台范围需要修改'}</p>
      {scope?.issues?.map((issue, index) => <p key={index}>{issue}</p>)}
      <p>这里只检查平台章节。请逐项核对事实、写法和公开边界，再确认。</p>
    </div>
    {sourceMaterial && <details open className="rounded-md border border-[#D8D1C9] p-3">
      <summary className="cursor-pointer font-semibold">对照本期原始素材</summary>
      <p className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-7">{sourceMaterial}</p>
    </details>}
    <p className="text-sm leading-6 text-[#6B6B6B]">展开查看完整方案。修改只作用于所选章节，保存为新版本；来源记录由系统保留。已有正文不会自动改写。</p>
    {sections.map((section) => {
      const edit = edits.find((item) => item.id === section.id);
      return <details key={section.id} open={section.editable} className="rounded-md border border-[#D8D1C9] p-3">
        <summary className="cursor-pointer font-semibold">{section.title}{edit ? ' · 未保存' : ''}{!section.editable ? ' · 只读' : ''}</summary>
        {edit ? <label className="mt-3 block text-sm">修改「{section.title}」
          <textarea rows={12} maxLength={60000} disabled={disabled} value={edit.text} onChange={(event) => change(section, event.target.value)} className="mt-2 w-full rounded border border-[#D8D1C9] p-3 text-sm leading-7" />
        </label> : <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-7">{section.text}</pre>}
        {section.editable && <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <button type="button" disabled={disabled} className="underline" onClick={() => onChange([...edits.filter((item) => item.id !== section.id), { id: section.id, text: section.text }])}>手动修改这一章</button>
          <button type="button" disabled={disabled} className="underline" onClick={() => change(section, '')}>移除这一章</button>
          {edit && <button type="button" disabled={disabled} className="underline" onClick={() => change(section, section.text)}>撤销这一章修改</button>}
        </div>}
      </details>;
    })}
    {edits.length > 0 && <aside aria-label="章节修改预览" className="space-y-3 rounded-md bg-[#F7F3EE] p-4 text-sm">
      <button type="button" disabled={disabled} onClick={onPreview} className="font-semibold underline">预览章节修改</button>
      {preview && edits.map((edit) => <div key={edit.id} className="grid gap-4 md:grid-cols-2">
        <div><h4 className="font-semibold">修改前</h4><pre className="mt-2 whitespace-pre-wrap break-words font-sans leading-6">{sections.find((section) => section.id === edit.id)?.text}</pre></div>
        <div><h4 className="font-semibold">修改后 · 尚未保存</h4><pre className="mt-2 whitespace-pre-wrap break-words font-sans leading-6">{edit.text || '这一章将从新版本移除，原始版本仍保留。'}</pre></div>
      </div>)}
      <p>核对预览后，点击下方“只保存方案”。保存后重新检查平台范围，再确认。</p>
    </aside>}
  </section>;
}
