'use client';

import { Clipboard } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyPublicationText, type PublishingCopy } from '@/lib/publication-text-copy';
import type { PublicationTextField } from '@/lib/publication-text';
import { displayClientError } from '@/lib/client-error-copy';

type Field = { field: PublicationTextField; label: string };
type Props = { sourcePath: string; sha256: string; fields: Field[]; label: string };
const buttonClass = 'inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[#D8D3CD] bg-white px-3 text-xs font-semibold text-[#4F4A45] hover:border-[#A24637] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A24637] disabled:opacity-50';

export function PublicationTextActions(props: Props) {
  return <PublicationTextActionsControl key={JSON.stringify([props.sourcePath, props.sha256, props.fields])} {...props} />;
}

export function PublicationTextActionsControl({ sourcePath, sha256, fields, label }: Props) {
  const [state, setState] = useState<{
    busy: boolean; field?: Field; review?: PublishingCopy; copied: boolean; manual: boolean; text: string; notice: string; includedNotice: boolean; error: string;
  }>({ busy: false, copied: false, manual: false, text: '', notice: '', includedNotice: false, error: '' });
  const pending = useRef<AbortController | null>(null);
  const reviewedToken = useRef('');
  const reviewPanel = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => { if (state.review) reviewPanel.current?.focus(); }, [state.review]);

  async function copy(field: Field, options?: { reviewedToken?: string; withNotice?: boolean }) {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setState({ busy: true, field, copied: false, manual: false, text: '', notice: '', includedNotice: false, error: '' });
    try {
      const result = await copyPublicationText(sourcePath, sha256, field.field, {
        signal: controller.signal, isCurrent: () => pending.current === controller,
        writeText: (text) => navigator.clipboard.writeText(text),
        reviewedToken: options?.reviewedToken ?? reviewedToken.current, withNotice: options?.withNotice,
      });
      if (result.status === 'cancelled') return;
      if (result.status === 'review') {
        reviewedToken.current = '';
        setState({ busy: false, field, review: result, copied: false, manual: false, text: '', notice: '', includedNotice: false, error: '' });
      } else {
        reviewedToken.current = result.reviewToken;
        setState({ busy: false, field, copied: result.status === 'copied', manual: result.status === 'manual', text: result.text,
          notice: result.notice, includedNotice: result.includedNotice, error: '' });
        buttons.current.get(field.field)?.focus();
      }
    } catch (error) {
      if (!controller.signal.aborted && pending.current === controller) setState({ busy: false, field, copied: false, manual: false,
        text: '', notice: '', includedNotice: false, error: displayClientError(error, '暂时无法复制文案，请重试。') });
    } finally { if (pending.current === controller) pending.current = null; }
  }

  return <div aria-label={label} className="w-full min-w-0 space-y-2">
    <div className="flex flex-wrap gap-2">{fields.map((field) => <button key={field.field} type="button"
      ref={(node) => { if (node) buttons.current.set(field.field, node); else buttons.current.delete(field.field); }}
      disabled={state.busy || !/^[a-f0-9]{64}$/.test(sha256)} className={buttonClass} onClick={() => void copy(field)}>
      <Clipboard size={13} />复制{field.label}
    </button>)}</div>
    {!/^[a-f0-9]{64}$/.test(sha256) && <p role="status" className="text-xs text-[#80551B]">请重新读取成品，核对版本后再复制。</p>}
    {state.busy && <p role="status" className="text-xs text-[#6B6B6B]">正在读取文案与本期使用说明…</p>}
    {state.error && <p role="alert" className="text-xs text-[#943D30]">{state.error}</p>}
    {state.review && state.field && <div ref={reviewPanel} role="region" aria-label="复制前核对使用说明" tabIndex={-1}
      className="rounded-lg border border-[#D8C8B5] bg-[#FFF9EF] p-3 text-sm text-[#665238] focus:outline-2 focus:outline-[#A24637]">
      <p className="font-semibold">复制{state.field.label}前，核对本期使用说明</p>
      <p className="mt-2 whitespace-pre-wrap text-xs leading-6">{state.review.notice}</p>
      <p className="mt-2 text-xs leading-6">说明只用于你核对素材，不属于发布正文。复制不会修改公开限制，也不会发布内容。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {state.review.disclosureStatus === 'restricted_details' && <button type="button" className={buttonClass}
          onClick={() => void copy(state.field!, { reviewedToken: state.review!.reviewToken })}>已核对，复制{state.field.label}</button>}
        <button type="button" className={buttonClass} onClick={() => void copy(state.field!, { withNotice: true })}>复制含说明的预览稿</button>
        <button type="button" className={buttonClass} onClick={() => {
          const field = state.field!; setState({ busy: false, copied: false, manual: false, text: '', notice: '', includedNotice: false, error: '' });
          buttons.current.get(field.field)?.focus();
        }}>取消</button>
      </div>
    </div>}
    {state.copied && <p role="status" className="text-xs text-[#176936]">已复制{state.field?.label}{state.includedNotice ? '，包含使用说明。' : '，可粘贴到对应输入框。'}</p>}
    {state.notice && !state.includedNotice && <details className="text-xs text-[#80551B]"><summary className="cursor-pointer">本期使用说明仍有效</summary><p className="mt-2 whitespace-pre-wrap leading-6">{state.notice}</p></details>}
    {state.manual && <div>
      <p role="status" className="text-xs text-[#80551B]">自动复制不可用。点击下方文字全选后手动复制{state.includedNotice ? '，其中包含使用说明' : ''}。</p>
      <textarea readOnly aria-label={`${state.field?.label}：手动复制`} value={state.text} onFocus={(event) => event.currentTarget.select()}
        className="mt-2 block w-full rounded-md border border-[#D8D3CD] p-3 text-sm" rows={6} />
    </div>}
  </div>;
}
