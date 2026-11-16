'use client';

import { BookOpenText, Check, ChevronRight, FileText, LoaderCircle, Sparkles } from 'lucide-react';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { platformDisplayName } from '@/lib/product-copy';
import { formatDate, type PublishedScript } from './material-library-types';

type Props = {
  scripts: PublishedScript[];
  total: number;
  loading?: boolean;
  collecting?: boolean;
  onCollect: () => Promise<void>;
  onLoadScript?: (id: string) => Promise<PublishedScript>;
};

function ScriptStatus({ script }: { script: PublishedScript }) {
  return script.collected === false ? (
    <span className="bg-[#FFF8E8] px-2 py-1 text-[10px] font-bold text-[#8D5A00]">未加入参考</span>
  ) : (
    <span className="inline-flex items-center gap-1 bg-[#EDF8F0] px-2 py-1 text-[10px] font-bold text-[#16803C]"><Check size={11} strokeWidth={2.5} />写作时参考</span>
  );
}

export function PublishedScriptsPanel({ scripts, total, loading = false, collecting = false, onCollect, onLoadScript }: Props) {
  const [selectedScript, setSelectedScript] = useState<PublishedScript | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const collectedCount = scripts.filter((script) => script.collected !== false).length;

  const openScript = async (script: PublishedScript) => {
    setSelectedScript(script);
    if (!onLoadScript) return;
    setDetailLoading(true);
    try {
      const detail = await onLoadScript(script.id);
      setSelectedScript((current) => current?.id === script.id ? { ...current, ...detail } : current);
    } catch {
      // The list summary remains usable when a historical body file is unavailable.
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-4 border border-[rgba(28,28,30,0.1)] bg-white px-5 py-5 shadow-[0_8px_22px_rgba(28,28,30,0.035)] lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center bg-[rgba(232,93,76,0.1)] text-[#E85D4C]"><BookOpenText size={20} /></span>
          <div>
            <h2 className="text-[18px] font-bold text-[#1A1A1A]">已发布内容</h2>
            <p className="mt-1 text-[12px] leading-[1.6] text-[#6B6B6B]">这里保存已确认发布的内容，后续写作会参考这些作品。</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <p className="text-[10px] font-bold text-[#8A8178]">已加入参考</p>
            <p className="mt-1 text-[14px] font-bold tabular-nums text-[#1A1A1A]">{collectedCount} / {total}</p>
          </div>
          <button type="button" onClick={() => void onCollect()} disabled={collecting} className="inline-flex h-9 items-center gap-2 bg-[#1C1C1E] px-3 text-[12px] font-bold text-white transition-colors hover:bg-[#353535] disabled:opacity-50">
            {collecting ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
            同步已发布内容
          </button>
        </div>
      </section>

      <section className="overflow-hidden border border-[rgba(28,28,30,0.1)] bg-white shadow-[0_8px_22px_rgba(28,28,30,0.035)]">
        <div className="flex items-center justify-between border-b border-[rgba(28,28,30,0.08)] px-5 py-3.5">
          <div>
            <p className="text-[13px] font-bold text-[#1A1A1A]">内容列表</p>
            <p className="mt-1 text-[11px] text-[#8A8178]">标题、形式、平台、时间、表现和可复用写法</p>
          </div>
          <span className="font-mono text-[11px] font-bold text-[#8A8178]">{total} 篇</span>
        </div>

        {loading ? (
          <div className="space-y-2 p-5">
            {[1, 2, 3, 4].map((item) => <div key={item} className="h-16 animate-pulse bg-[#F5EDE4]" />)}
          </div>
        ) : scripts.length > 0 ? (
          <div className="divide-y divide-[rgba(28,28,30,0.07)]">
            {scripts.map((script) => (
              <button key={script.id} type="button" onClick={() => void openScript(script)} className="grid w-full gap-3 px-5 py-4 text-left transition-colors hover:bg-[#FFFDF9] md:grid-cols-[minmax(0,1.25fr)_100px_94px_118px_minmax(0,0.8fr)_24px] md:items-center md:gap-4">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[14px] font-bold text-[#1A1A1A]">{script.title}</span>
                    <span className="border border-[rgba(28,28,30,0.1)] bg-white px-1.5 py-0.5 text-[10px] font-bold text-[#6B6B6B]">{script.contentForm || '内容'}</span>
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-[#6B6B6B]">{script.learningFeature || '还没有提取可复用的写法。'}</span>
                </span>
                <span className="text-[12px] font-semibold text-[#4F4A45]">{platformDisplayName(script.platform || '', script.platform || '-')}</span>
                <span className="text-[12px] text-[#6B6B6B]">{formatDate(script.publishedAt)}</span>
                <span className="text-[11px] leading-[1.5] text-[#6B6B6B]">{script.performanceSummary || '暂无表现数据'}</span>
                <span className="justify-self-start md:justify-self-auto"><ScriptStatus script={script} /></span>
                <ChevronRight size={16} className="hidden text-[#AAA39B] md:block" />
              </button>
            ))}
          </div>
        ) : (
          <div className="flex min-h-[340px] flex-col items-center justify-center px-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center bg-[rgba(232,93,76,0.1)] text-[#E85D4C]"><FileText size={22} /></span>
            <h3 className="mt-4 text-[16px] font-bold text-[#1A1A1A]">还没有已发布内容</h3>
            <p className="mt-2 max-w-[420px] text-[12px] leading-[1.65] text-[#6B6B6B]">确认发布后，点击上方按钮即可把系统记录的内容同步到这里。</p>
          </div>
        )}
      </section>

      <Dialog open={Boolean(selectedScript)} onOpenChange={(open) => !open && setSelectedScript(null)}>
        <DialogContent className="max-h-[84vh] max-w-[780px] overflow-y-auto rounded-[18px] border border-[rgba(28,28,30,0.1)] bg-white p-0 text-[#1A1A1A] shadow-[0_24px_60px_rgba(28,28,30,0.16)]">
          {selectedScript && (
            <>
              <DialogHeader className="border-b border-[rgba(28,28,30,0.08)] px-6 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <DialogTitle className="text-[20px] font-bold">{selectedScript.title}</DialogTitle>
                    <DialogDescription className="mt-2 text-[12px] text-[#6B6B6B]">{platformDisplayName(selectedScript.platform || '', selectedScript.platform || '未记录平台')} · {selectedScript.contentForm || '内容'} · {formatDate(selectedScript.publishedAt)}</DialogDescription>
                  </div>
                  <ScriptStatus script={selectedScript} />
                </div>
              </DialogHeader>
              <div className="space-y-5 px-6 py-5">
                <div className="border-l-[3px] border-[#E85D4C] bg-[#FFF9F7] px-3 py-3">
                  <p className="text-[10px] font-bold text-[#C94A3B]">可复用的写法</p>
                  <p className="mt-1.5 text-[13px] leading-[1.65] text-[#4F4A45]">{selectedScript.learningFeature || '还没有提取可复用的写法。'}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <DetailItem label="表现摘要" value={selectedScript.performanceSummary || '暂无表现数据'} />
                  <DetailItem label="发布链接" value={selectedScript.sourceUrl || '未记录'} link={selectedScript.sourceUrl} />
                </div>
                <div>
                  <p className="text-[12px] font-bold text-[#1A1A1A]">完整内容</p>
                  <pre className="mt-3 whitespace-pre-wrap border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] p-4 text-[13px] leading-[1.75] text-[#303030]">{detailLoading ? '正在加载内容…' : selectedScript.body || '完整内容尚未同步到本地。'}</pre>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailItem({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div className="border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-3 py-3">
      <p className="text-[10px] font-bold text-[#8A8178]">{label}</p>
      {link ? <a href={link} target="_blank" rel="noreferrer" className="mt-1.5 block truncate text-[12px] font-semibold text-[#2763A6] hover:underline">{value}</a> : <p className="mt-1.5 text-[12px] leading-[1.6] text-[#4F4A45]">{value}</p>}
    </div>
  );
}
