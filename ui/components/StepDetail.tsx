'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Circle, ClipboardCheck, FileInput, FileOutput, RefreshCw, UserCheck } from 'lucide-react';
import { getStepDefinition } from '@/lib/pipeline-registry';
import type { PipelineStep, SkillDefinition } from '@/lib/types';

interface StepDetailProps {
  stepId: number;
  step?: PipelineStep;
  skillDef?: SkillDefinition | null;
}

function summarizeInput(step?: PipelineStep): string {
  if (!step?.input || Object.keys(step.input).length === 0) {
    return '等待输入...';
  }
  return Object.entries(step.input)
    .filter(([key]) => key !== 'slug')
    .map(([key, value]) => {
      let display = String(value);
      if (display.length > 120) display = display.slice(0, 120) + '...';
      return `• ${key}: ${display}`;
    })
    .join('\n');
}

function summarizeOutput(step?: PipelineStep): string {
  if (!step) return '等待执行...';
  if (step.status === 'running') return '正在执行...';
  if (step.status === 'failed') {
    const output = typeof step.output === 'string' ? step.output : '';
    if (output.includes('预研资产') || output.includes('未放行正式生产')) {
      return '正式生产未放行，已生成补证或预研建议。';
    }
    return '执行失败，请查看日志。';
  }
  if (step.status === 'completed' || step.output) {
    const len = typeof step.output === 'string' ? step.output.length : 0;
    return `执行完成，输出 ${len} 字符。`;
  }
  return '等待执行...';
}

function getStatusMeta(status?: PipelineStep['status']) {
  switch (status) {
    case 'completed':
      return { label: '已生成', icon: CheckCircle2, className: 'bg-[#F8FBF6] text-[#16803C]' };
    case 'running':
      return { label: '生成中', icon: RefreshCw, className: 'bg-[#FDF3F0] text-[#E85D4C]' };
    case 'failed':
      return { label: '需处理', icon: AlertTriangle, className: 'bg-[#FFF2EF] text-[#E85D4C]' };
    default:
      return { label: '待生成', icon: Circle, className: 'bg-[#F7F7F7] text-[#9A9A9A]' };
  }
}

function getAutomationMeta(mode: 'automatic' | 'semi_automatic' | 'manual_required') {
  switch (mode) {
    case 'automatic':
      return { label: '系统自动', className: 'bg-[#EAF8EF] text-[#16803C]' };
    case 'manual_required':
      return { label: '人工必须', className: 'bg-[#FFF2EF] text-[#C64D3D]' };
    default:
      return { label: '半自动协作', className: 'bg-[#FFF4E8] text-[#B8641E]' };
  }
}

export function StepDetail({ stepId, step, skillDef }: StepDetailProps) {
  const detail = getStepDefinition(stepId);
  if (!detail) return null;

  const inputDisplay = step?.input ? summarizeInput(step) : detail.input;
  const outputDisplay = summarizeOutput(step);
  const descriptionDisplay = skillDef?.description;
  const statusMeta = getStatusMeta(step?.status);
  const automationMeta = getAutomationMeta(detail.automationMode);
  const StatusIcon = statusMeta.icon;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={stepId}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.4 }}
        className="space-y-[12px]"
      >
        <div className="grid grid-cols-1 gap-[10px] xl:grid-cols-3">
          <div className="rounded-[14px] border border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] p-[14px]">
            <div className="mb-[10px] flex items-center gap-[8px] text-[12px] font-bold text-[#E85D4C]">
              <FileInput size={15} />
              输入来源
            </div>
            <pre className="max-h-[150px] overflow-auto whitespace-pre-wrap text-[13px] leading-[1.65] text-[#4B4743]">{inputDisplay}</pre>
          </div>

          <div className="rounded-[14px] border border-[rgba(28,28,30,0.08)] bg-white p-[14px]">
            <div className="mb-[10px] flex items-center justify-between gap-[8px]">
              <div className="flex items-center gap-[8px] text-[12px] font-bold text-[#1A1A1A]">
                <FileOutput size={15} className="text-[#F4A261]" />
                系统产出
              </div>
              <span className={`inline-flex h-[24px] items-center gap-[5px] rounded-full px-[8px] text-[11px] font-bold ${statusMeta.className}`}>
                <StatusIcon size={12} className={step?.status === 'running' ? 'animate-spin' : ''} />
                {statusMeta.label}
              </span>
            </div>
            <p className="text-[14px] leading-[1.65] text-[#1A1A1A]">{detail.output}</p>
            <p className="mt-[9px] text-[12px] leading-[1.6] text-[#6B6B6B]">{outputDisplay}</p>
          </div>

          <div className="rounded-[14px] border border-[rgba(232,93,76,0.16)] bg-[#FDF3F0] p-[14px]">
            <div className="mb-[10px] flex items-center justify-between gap-[8px]">
              <div className="flex items-center gap-[8px] text-[12px] font-bold text-[#E85D4C]">
                <UserCheck size={15} />
                人工关口
              </div>
              <span className={`rounded-full px-[8px] py-[4px] text-[11px] font-bold ${automationMeta.className}`}>
                {automationMeta.label}
              </span>
            </div>
            <p className="text-[13px] leading-[1.7] text-[#8A4A3E]">{detail.intervention}</p>
            <p className="mt-[8px] text-[12px] leading-[1.65] text-[#6F4138]">
              <b>放行操作：</b>{detail.humanGate}
            </p>
          </div>
        </div>

        <div className="rounded-[14px] border border-[rgba(28,28,30,0.08)] bg-white p-[14px]">
          <div className="mb-[10px] flex items-center gap-[8px] text-[13px] font-bold text-[#1A1A1A]">
            <ClipboardCheck size={15} className="text-[#E85D4C]" />
            本步复核清单
          </div>
          <div className="grid grid-cols-1 gap-[8px] md:grid-cols-3">
            {detail.reviewItems.map((item) => (
              <div key={item} className="flex items-start gap-[7px] rounded-[11px] bg-[#F7F7F7] px-[10px] py-[8px]">
                <CheckCircle2 size={13} className="mt-[2px] shrink-0 text-[#16803C]" />
                <span className="text-[12px] leading-[1.5] text-[#4B4743]">{item}</span>
              </div>
            ))}
          </div>
          {descriptionDisplay && (
            <p className="mt-[10px] text-[12px] leading-[1.65] text-[#9A9A9A]">{descriptionDisplay}</p>
          )}
          <p className="mt-[10px] rounded-[10px] bg-[#FFF8F5] px-[10px] py-[8px] text-[12px] leading-[1.65] text-[#8A4A3E]">
            <b>未通过时：</b>{detail.blockedReturn}
          </p>
        </div>

        <details className="rounded-[14px] border border-[rgba(28,28,30,0.08)] bg-[#1C1C1E] p-[14px] shadow-[0_6px_18px_rgba(28,28,30,0.04)]">
          <summary className="cursor-pointer text-[12px] font-bold text-[#F4A261]">
            参考示例
          </summary>
          <pre className="mt-[14px] max-h-[260px] overflow-auto whitespace-pre-wrap text-[13px] leading-[1.7] text-[#D4D4D4]">{detail.example}</pre>
        </details>
      </motion.div>
    </AnimatePresence>
  );
}
