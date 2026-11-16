'use client';

import { Activity } from 'lucide-react';
import { usePipelineStore } from '@/store/pipelineStore';

const levelColors: Record<string, string> = {
  info: 'text-[#6B6B6B]',
  success: 'text-green-600',
  warning: 'text-amber-600',
  error: 'text-[#E85D4C]',
};

export function ActivityLogWidget() {
  const { steps } = usePipelineStore();

  const allLogs = steps
    .flatMap((step) => step.logs.map((log) => ({ ...log, stepName: step.name })))
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 8);

  return (
    <div className="rounded-xl border border-[rgba(28,28,30,0.08)] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Activity size={16} className="text-[#E85D4C]" />
        <span className="text-[15px] font-bold text-[#1A1A1A]">最近活动</span>
      </div>

      {allLogs.length === 0 ? (
        <div className="py-6 text-center text-[13px] text-[#9A9A9A]">
          暂无活动日志
        </div>
      ) : (
        <div className="space-y-2">
          {allLogs.map((log, idx) => (
            <div key={idx} className="flex items-start gap-2 text-[12px]">
              <span className="shrink-0 text-[11px] text-[#9A9A9A]">
                {new Date(log.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="shrink-0 rounded bg-[#F5EDE4] px-1.5 py-0.5 text-[11px] text-[#6B6B6B]">
                {log.stepName}
              </span>
              <span className={`break-all ${levelColors[log.level] || 'text-[#6B6B6B]'}`}>{log.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
