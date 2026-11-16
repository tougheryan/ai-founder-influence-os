'use client';

import { motion } from 'framer-motion';
import { Activity } from 'lucide-react';
import { useRuntimeStatus, type RuntimeStatus } from '@/hooks/useRuntimeStatus';

interface RuntimeStatusPanelProps {
  status?: RuntimeStatus | null;
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function RuntimeStatusPanel({ status: propStatus }: RuntimeStatusPanelProps) {
  const { status: hookStatus } = useRuntimeStatus();
  const status = propStatus !== undefined ? propStatus : hookStatus;

  if (!status) {
    return (
      <div className="rounded-[12px] border border-[rgba(28,28,30,0.08)] bg-white px-[16px] py-[12px] text-[13px] text-[#6B6B6B]">
        正在读取 runtime 状态…
      </div>
    );
  }

  const currentStep = status.latest?.current_step || '无';
  const latestFiles = status.latest?.latest_files || {};
  const session = status.sessionState || {};

  const completedSteps = Object.entries(latestFiles).filter(([, path]) => !!path);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="rounded-[16px] border border-[rgba(28,28,30,0.08)] bg-white px-[14px] py-[12px] shadow-[0_8px_22px_rgba(28,28,30,0.035)]"
    >
      <div className="flex flex-col gap-[10px] lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-[10px]">
          <div className="flex items-center gap-[8px]">
            <Activity size={17} className="text-[#E85D4C]" />
            <h3 className="text-[15px] font-bold text-[#1A1A1A]">运行状态</h3>
          </div>
          <span className="rounded-full bg-[rgba(232,93,76,0.09)] px-[10px] py-[4px] text-[12px] font-semibold text-[#E85D4C]">
            {completedSteps.length}/9 已有产物
          </span>
        </div>
        <div className="grid grid-cols-3 gap-[8px] lg:min-w-[520px]">
          <RuntimePill label="当前步骤" value={currentStep} />
          <RuntimePill label="选题追踪" value={`${arrayCount(session.topic_tracking)} 个`} />
          <RuntimePill label="稿子追踪" value={`${arrayCount(session.draft_tracking)} 个`} />
        </div>
      </div>
    </motion.div>
  );
}

function RuntimePill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[11px] bg-[#FDF8F3] px-[12px] py-[8px]">
      <p className="text-[11px] font-semibold text-[#9A9A9A]">{label}</p>
      <p className="mt-[2px] truncate text-[15px] font-bold text-[#1A1A1A]">{value}</p>
    </div>
  );
}
