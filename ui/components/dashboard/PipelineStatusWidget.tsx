'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { PipelineVisual } from '@/components/PipelineVisual';
import { usePipelineStore } from '@/store/pipelineStore';

export function PipelineStatusWidget() {
  const { steps, currentStep, setCurrentStep, status } = usePipelineStore();
  const completedSteps = steps.filter((s) => s.status === 'completed').length;

  return (
    <div className="rounded-xl border border-[rgba(28,28,30,0.08)] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold text-[#1A1A1A]">内容生产线</span>
          <span className="rounded-full bg-[rgba(232,93,76,0.1)] px-2 py-0.5 text-[12px] font-medium text-[#E85D4C]">
            {completedSteps}/9
          </span>
        </div>
        <Link
          href="/production?stage=1"
          className="text-[13px] font-medium text-[#E85D4C] transition-opacity hover:opacity-80"
        >
          进入生产线 →
        </Link>
      </div>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <PipelineVisual
          activeStep={currentStep || 1}
          onStepClick={setCurrentStep}
          running={status === 'running'}
          compact
        />
      </motion.div>
    </div>
  );
}
