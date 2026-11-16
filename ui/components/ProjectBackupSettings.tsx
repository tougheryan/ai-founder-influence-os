'use client';

import { useEffect, useState } from 'react';
import { ArchiveRestore, Download, Loader2, ShieldCheck, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { displayClientError } from '@/lib/client-error-copy';

export function ProjectBackupSettings() {
  const [desktop, setDesktop] = useState(false);
  const [working, setWorking] = useState<'export' | 'import' | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDesktop(Boolean(window.aifiosProject));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const exportBackup = async () => {
    if (!window.aifiosProject || working) return;
    setWorking('export');
    try {
      const result = await window.aifiosProject.exportBackup();
      if (result.canceled) return;
      toast.success(`项目备份已导出（${result.fileCount ?? 0} 个文件）`);
    } catch (error) {
      toast.error(displayClientError(error, '项目备份没有导出成功。请重新选择保存位置后再试。'));
    } finally {
      setWorking(null);
    }
  };

  const importBackup = async () => {
    if (!window.aifiosProject || working) return;
    setWorking('import');
    try {
      const result = await window.aifiosProject.importBackup();
      if (result.canceled) return;
      toast.success(`备份已恢复并切换到新项目（${result.fileCount ?? 0} 个文件）`);
    } catch (error) {
      toast.error(displayClientError(error, '项目备份没有恢复成功。请换一份备份后重试。'));
    } finally {
      setWorking(null);
    }
  };

  if (!desktop) {
    return (
      <section className="aifios-settings-section border border-[rgba(28,28,30,0.1)] bg-white p-4">
        <div className="flex items-center gap-2 text-[13px] text-[#6B6B6B]">
          <ArchiveRestore size={16} className="text-[#8A8178]" />
          <span>项目备份与恢复仅在 Echo Founder 桌面端提供。</span>
        </div>
      </section>
    );
  }

  const actionClass = 'inline-flex h-10 items-center justify-center gap-2 border border-[rgba(28,28,30,0.14)] bg-white px-3.5 text-[12px] font-bold text-[#1A1A1A] transition hover:border-[#52790C] hover:bg-[#F7FAF4] hover:text-[#3B5E06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#52790C]/25 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <section className="aifios-settings-section border border-[rgba(28,28,30,0.1)] bg-white">
      <div className="aifios-settings-section__header flex flex-col gap-4 border-b border-[rgba(28,28,30,0.08)] px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center bg-[#F2F7ED] text-[#52790C]">
            <ArchiveRestore size={17} />
          </span>
          <div>
            <h2 className="text-[17px] font-bold text-[#1A1A1A]">项目备份与恢复</h2>
            <p className="mt-1 max-w-[760px] text-[12px] leading-[1.6] text-[#6B6B6B]">
              备份包含项目文件，不包含 API Key、登录状态、Cookie、日志或缓存。
            </p>
          </div>
        </div>
        <ShieldCheck size={20} className="shrink-0 text-[#52790C]" />
      </div>
      <div className="aifios-settings-grid grid gap-4 bg-[#F7F9F5] p-5 lg:grid-cols-2">
        <div className="aifios-settings-card flex min-h-[174px] flex-col bg-white p-5 shadow-[0_12px_32px_rgba(31,61,37,0.04)]">
          <h3 className="text-[13px] font-bold text-[#1A1A1A]">导出当前项目</h3>
          <p className="mt-2 text-[12px] leading-5 text-[#6B6B6B]">导出一份当前项目副本，不会修改正在使用的项目。</p>
          <button type="button" onClick={() => void exportBackup()} disabled={working !== null} className={`${actionClass} mt-auto self-start`}>
            {working === 'export' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            导出备份
          </button>
        </div>
        <div className="aifios-settings-card flex min-h-[174px] flex-col bg-white p-5 shadow-[0_12px_32px_rgba(31,61,37,0.04)]">
          <h3 className="text-[13px] font-bold text-[#1A1A1A]">恢复为新项目</h3>
          <p className="mt-2 text-[12px] leading-5 text-[#6B6B6B]">系统会先检查备份，再恢复为一个新项目，不会覆盖当前项目。</p>
          <button type="button" onClick={() => void importBackup()} disabled={working !== null} className={`${actionClass} mt-auto self-start`}>
            {working === 'import' ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            选择备份并恢复
          </button>
        </div>
      </div>
    </section>
  );
}
