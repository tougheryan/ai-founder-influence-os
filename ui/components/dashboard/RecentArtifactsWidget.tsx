'use client';

import { FileText, FolderOpen } from 'lucide-react';
import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';

export function RecentArtifactsWidget() {
  const { status, loading } = useRuntimeStatus();
  const currentStep = status?.latest?.current_step || '无';
  const latestFiles = status?.latest?.latest_files || {};
  const recentFiles = (status?.pipelineFiles || []).slice(0, 5);
  const completedSteps = Object.entries(latestFiles).filter(([, path]) => !!path);

  return (
    <div className="rounded-xl border border-[rgba(28,28,30,0.08)] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[15px] font-bold text-[#1A1A1A]">最近产物</span>
        <span className="text-[12px] text-[#6B6B6B]">当前: {currentStep}</span>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-[#F5EDE4]" />
          ))}
        </div>
      ) : completedSteps.length === 0 && recentFiles.length === 0 ? (
        <div className="py-6 text-center text-[13px] text-[#9A9A9A]">
          暂无产物，去生产线运行一个 skill
        </div>
      ) : (
        <div className="space-y-2">
          {completedSteps.slice(0, 4).map(([step, path]) => (
            <div
              key={step}
              className="flex items-center justify-between gap-2 rounded-lg border border-[rgba(28,28,30,0.06)] bg-[#FDF8F3] px-3 py-2"
            >
              <div className="flex items-center gap-2 overflow-hidden">
                <FileText size={14} className="shrink-0 text-[#E85D4C]" />
                <span className="truncate text-[13px] font-medium text-[#1A1A1A]">{step}</span>
              </div>
              <span className="shrink-0 truncate max-w-[120px] text-[11px] text-[#6B6B6B]" title={path || ''}>
                {path?.split('/').pop()}
              </span>
            </div>
          ))}
          {recentFiles.slice(0, Math.max(0, 4 - completedSteps.length)).map((file) => (
            <div key={file.path} className="flex items-center gap-2 text-[12px] text-[#6B6B6B]">
              <FolderOpen size={14} className="shrink-0 text-[#9A9A9A]" />
              <span className="truncate">{file.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
