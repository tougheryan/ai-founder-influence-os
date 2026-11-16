'use client';

import { CheckCircle2, Circle, Play, Loader2, AlertCircle, SkipForward } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { PipelineStep } from '@/lib/types';
import { getPhaseLabel, SKILL_NAMES } from '@/lib/pipeline-state';

interface PipelineOverviewProps {
  steps: PipelineStep[];
  currentStep: number;
  status: string;
  onStepClick: (stepId: number) => void;
  onStartPipeline: () => void;
  onResetPipeline: () => void;
}

export function PipelineOverview({
  steps,
  currentStep,
  status,
  onStepClick,
  onStartPipeline,
  onResetPipeline,
}: PipelineOverviewProps) {
  const completedCount = steps.filter((s) => s.status === 'completed').length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="mb-1 text-[14px] font-normal text-[#d4d1cd]">进度</div>
          <div className="text-[36px] font-bold leading-[1.2] tracking-[-0.02em] text-white md:text-[48px]">
            {completedCount}/{steps.length} 步已完成
          </div>
        </div>
        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={onResetPipeline}
            disabled={status === 'running'}
            className="border-white bg-transparent px-5 py-2 text-[14px] font-semibold text-white hover:bg-white hover:text-[#1c1b18]"
            style={{ borderRadius: 32 }}
          >
            重置
          </Button>
          <Button
            onClick={onStartPipeline}
            disabled={status === 'running'}
            className="px-5 py-2 text-[14px] font-semibold text-[#1c1b18] transition-opacity hover:opacity-90"
            style={{ borderRadius: 32, backgroundColor: '#f1f252' }}
          >
            {status === 'running' ? (
              <>
                <Loader2 size={14} className="mr-1 animate-spin" />
                运行中
              </>
            ) : (
              <>
                <Play size={14} className="mr-1" />
                一键启动
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {steps.map((step, idx) => (
          <StepCard
            key={step.id}
            step={step}
            index={idx}
            isActive={currentStep === step.id}
            onClick={() => onStepClick(step.id)}
          />
        ))}
      </div>
    </div>
  );
}

function StepCard({
  step,
  index,
  isActive,
  onClick,
}: {
  step: PipelineStep;
  index: number;
  isActive: boolean;
  onClick: () => void;
}) {
  const statusIcon = {
    pending: <Circle size={18} className="text-[#d4d1cd]" />,
    running: <Loader2 size={18} className="animate-spin text-[#1c1b18]" />,
    completed: <CheckCircle2 size={18} className="text-[#1c1b18]" />,
    failed: <AlertCircle size={18} className="text-[#1c1b18]" />,
    skipped: <SkipForward size={18} className="text-[#d4d1cd]" />,
  };

  return (
    <Card
      onClick={onClick}
      className="group cursor-pointer border bg-white p-6 transition-all"
      style={{
        borderRadius: 24,
        boxShadow: 'none',
        borderColor: isActive ? '#f1f252' : '#d4d1cd',
      }}
    >
      <div className="flex items-start gap-4">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center text-sm font-semibold"
          style={{
            backgroundColor: step.status === 'completed' ? '#1c1b18' : 'transparent',
            border: `1px solid ${step.status === 'completed' ? '#1c1b18' : '#d4d1cd'}`,
            color: step.status === 'completed' ? '#ffffff' : '#1c1b18',
            borderRadius: 9999,
          }}
        >
          {step.status === 'completed' ? statusIcon.completed : <span>{index + 1}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold text-[#1c1b18]">{step.name}</div>
          <p className="mt-1 text-[14px] leading-[1.5] text-[#545048]">{step.description}</p>
          <div className="mt-4 flex items-center gap-[6px]">
            <span
              className="border border-[#d4d1cd] bg-[#efece7] px-3 py-1 text-[12px] font-normal text-[#545048]"
              style={{ borderRadius: 9999 }}
            >
              {getPhaseLabel(step.phase)}
            </span>
            {step.skill && (
              <span
                className="border border-[#d4d1cd] bg-[#efece7] px-3 py-1 text-[12px] font-normal text-[#545048]"
                style={{ borderRadius: 9999 }}
              >
                {SKILL_NAMES[step.skill] || step.skill}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0">{statusIcon[step.status]}</div>
      </div>
    </Card>
  );
}
