'use client';

import { Check, LoaderCircle, PencilLine, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { LibraryProposal } from './material-library-types';

type Props = {
  open: boolean;
  targetLabel: string;
  proposals: LibraryProposal[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onResolve: (proposalId: string, action: 'accept' | 'reject' | 'edit', value?: string) => Promise<void>;
};

export function ProposalReviewDialog({
  open,
  targetLabel,
  proposals,
  busy = false,
  onOpenChange,
  onResolve,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedValue, setEditedValue] = useState('');

  const startEdit = (proposal: LibraryProposal) => {
    setEditingId(proposal.id);
    setEditedValue(proposal.suggestedValue);
  };

  const resolve = async (proposalId: string, action: 'accept' | 'reject' | 'edit', value?: string) => {
    try {
      await onResolve(proposalId, action, value);
      if (action === 'edit') {
        setEditingId(null);
        setEditedValue('');
      }
    } catch {
      // The workspace displays the error without closing the proposal dialog.
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setEditingId(null);
      setEditedValue('');
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-[920px] overflow-y-auto rounded-[18px] border border-[rgba(28,28,30,0.1)] bg-white p-0 text-[#1A1A1A] shadow-[0_24px_60px_rgba(28,28,30,0.16)]">
        <DialogHeader className="border-b border-[rgba(28,28,30,0.08)] px-6 py-5">
          <DialogTitle className="text-[20px] font-bold">确认{targetLabel}修改建议</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-[#6B6B6B]">逐条查看当前内容和修改建议，再决定是否采用。</DialogDescription>
        </DialogHeader>

        <div className="divide-y divide-[rgba(28,28,30,0.08)]">
          {proposals.map((proposal, index) => {
            const editing = editingId === proposal.id;
            return (
              <article key={proposal.id} className="px-6 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] font-bold text-[#8A8178]">{String(index + 1).padStart(2, '0')}</span>
                      <h3 className="text-[14px] font-bold text-[#1A1A1A]">{proposal.label || proposal.field}</h3>
                    </div>
                    <p className="mt-2 max-w-[690px] text-[12px] leading-[1.6] text-[#6B6B6B]">{proposal.reason}</p>
                  </div>
                  <span className="shrink-0 bg-[#FFF8E8] px-2 py-1 text-[10px] font-bold text-[#8D5A00]">待确认</span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="border border-[rgba(28,28,30,0.1)] bg-[#FAFAFA] px-3 py-3">
                    <p className="text-[10px] font-bold text-[#8A8178]">当前内容</p>
                    <p className="mt-2 whitespace-pre-wrap text-[12px] leading-[1.65] text-[#4F4A45]">{proposal.currentValue || '尚未填写'}</p>
                  </div>
                  <div className="border border-[rgba(232,93,76,0.24)] bg-[#FFF9F7] px-3 py-3">
                    <p className="text-[10px] font-bold text-[#C94A3B]">建议内容</p>
                    {editing ? (
                      <textarea
                        value={editedValue}
                        onChange={(event) => setEditedValue(event.target.value)}
                        rows={5}
                        className="mt-2 block w-full resize-y border border-[rgba(232,93,76,0.32)] bg-white px-2.5 py-2 text-[12px] leading-[1.65] text-[#1A1A1A] outline-none focus:border-[#E85D4C]"
                      />
                    ) : (
                      <p className="mt-2 whitespace-pre-wrap text-[12px] leading-[1.65] text-[#4F4A45]">{proposal.suggestedValue}</p>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  {editing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setEditedValue('');
                        }}
                        disabled={busy}
                        className="inline-flex h-8 items-center gap-1.5 border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[11px] font-bold text-[#6B6B6B] transition-colors hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50"
                      >
                        <RotateCcw size={13} />取消编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void resolve(proposal.id, 'edit', editedValue)}
                        disabled={busy || !editedValue.trim()}
                        className="inline-flex h-8 items-center gap-1.5 bg-[#1C1C1E] px-2.5 text-[11px] font-bold text-white transition-colors hover:bg-[#353535] disabled:opacity-50"
                      >
                        {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
                        保存并采用
                      </button>
                    </>
                  ) : (
                    <>
                      {proposal.editable !== false && (
                        <button
                          type="button"
                          onClick={() => startEdit(proposal)}
                          disabled={busy}
                          className="inline-flex h-8 items-center gap-1.5 border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[11px] font-bold text-[#6B6B6B] transition-colors hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50"
                        >
                          <PencilLine size={13} />修改后采用
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void resolve(proposal.id, 'reject')}
                        disabled={busy}
                        className="inline-flex h-8 items-center gap-1.5 border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[11px] font-bold text-[#6B6B6B] transition-colors hover:border-[#B43C2E] hover:text-[#B43C2E] disabled:opacity-50"
                      >
                        <X size={13} />拒绝
                      </button>
                      <button
                        type="button"
                        onClick={() => void resolve(proposal.id, 'accept')}
                        disabled={busy}
                        className="inline-flex h-8 items-center gap-1.5 bg-[#1C1C1E] px-2.5 text-[11px] font-bold text-white transition-colors hover:bg-[#353535] disabled:opacity-50"
                      >
                        {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
                        采用
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
          {proposals.length === 0 && (
            <div className="px-6 py-12 text-center text-[13px] text-[#6B6B6B]">当前没有待确认的更新建议。</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
