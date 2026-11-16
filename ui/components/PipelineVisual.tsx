'use client';

import { motion } from 'framer-motion';
import {
  FileText,
  Compass,
  Scissors,
  PenTool,
  Image,
  PackageCheck,
  ShieldCheck,
  BarChart3,
  Archive,
  ScanFace,
  ChevronRight,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { PIPELINE_REGISTRY } from '@/lib/pipeline-registry';

const iconMap: Record<string, ComponentType<{ size?: number; strokeWidth?: number; className?: string }>> = {
  fileText: FileText,
  compass: Compass,
  scissors: Scissors,
  penTool: PenTool,
  image: Image,
  package: PackageCheck,
  shieldCheck: ShieldCheck,
  barChart3: BarChart3,
  archive: Archive,
  scanFace: ScanFace,
};

const steps = PIPELINE_REGISTRY.map((step) => ({
  ...step,
  name: step.shortName,
  phase: step.phaseLabel,
  icon: iconMap[step.iconKey] || FileText,
}));

const productionSteps = steps.filter((step) => step.production);
const postLaunchSteps = steps.filter((step) => !step.production);

interface PipelineVisualProps {
  activeStep: number;
  onStepClick: (stepId: number) => void;
  running?: boolean;
  compact?: boolean;
}

export function PipelineVisual({ activeStep, onStepClick, running = false, compact = false }: PipelineVisualProps) {
  if (compact) {
    const v2Steps = [
      {
        id: 1,
        number: '1',
        title: '素材理解',
        body: '提取素材、事实、证据、风险和不可公开内容。',
        skill: 'content-intake',
        icon: FileText,
        tone: 'neutral',
      },
      {
        id: 2,
        number: '2',
        title: '公开样本研究与立项',
        body: '整理可公开核验的内容结构与互动线索，再判断是否适合当前主题。',
        skill: 'content-validate',
        icon: ShieldCheck,
        tone: 'neutral',
      },
      {
        id: 3,
        number: '3',
        title: '母版蓝图',
        body: '思想母版骨架、证据链、叙事线、评论区预埋。',
        skill: 'content-blueprint + 人工确认',
        icon: Compass,
        tone: 'amber',
      },
      {
        id: 4,
        number: '4',
        title: '平台原生内容',
        body: '共享事实底稿，各已选平台依据自己的样本、选题和结构独立生成。',
        skill: 'content-package',
        icon: PenTool,
        tone: 'orange',
      },
      {
        id: 6,
        number: '5',
        title: '视觉与发布稿',
        body: '公众号生成完整排版与配图，小红书生成图文卡片；视频号不额外生成视觉资产。',
        skill: 'content-visual',
        icon: PackageCheck,
        tone: 'pink',
      },
      {
        id: 8,
        number: '6',
        title: '数据回流',
        body: '汇集各平台授权数据和人工回填，进入复盘与长期记忆。',
        skill: 'content-performance-collector',
        icon: Archive,
        tone: 'blue',
      },
    ] as const;

    const toneClass: Record<(typeof v2Steps)[number]['tone'], {
      surface: string;
      accent: string;
      icon: string;
      soft: string;
      active: string;
    }> = {
      neutral: {
        surface: 'border-[#E3E7EF] bg-[#FFFFFF] hover:border-[#B9C2D1]',
        accent: 'bg-[#AEB8C7]',
        icon: 'text-[#6F7B8F] bg-[#F4F6F9]',
        soft: 'bg-[#F6F8FB] text-[#6F7B8F]',
        active: 'shadow-[0_0_0_3px_rgba(111,123,143,0.13)]',
      },
      amber: {
        surface: 'border-[#F3B34C] bg-[#FFF9EE] hover:border-[#E39718]',
        accent: 'bg-[#F39A18]',
        icon: 'text-[#B96A00] bg-[#FFEBC7]',
        soft: 'bg-[#FFEED1] text-[#A85F00]',
        active: 'shadow-[0_0_0_3px_rgba(243,154,24,0.18)]',
      },
      orange: {
        surface: 'border-[#F06F37] bg-[#FFF7F1] hover:border-[#DB5D28]',
        accent: 'bg-[#F06F37]',
        icon: 'text-[#C84819] bg-[#FFE2D2]',
        soft: 'bg-[#FFE9DC] text-[#B84518]',
        active: 'shadow-[0_0_0_3px_rgba(240,111,55,0.17)]',
      },
      pink: {
        surface: 'border-[#F47C91] bg-[#FFF3F6] hover:border-[#E7657D]',
        accent: 'bg-[#F47C91]',
        icon: 'text-[#C75368] bg-[#FFE0E6]',
        soft: 'bg-[#FFE7EC] text-[#B74B60]',
        active: 'shadow-[0_0_0_3px_rgba(244,124,145,0.17)]',
      },
      blue: {
        surface: 'border-[#69A9F7] bg-[#F1F7FF] hover:border-[#4B97EE]',
        accent: 'bg-[#5EA8FF]',
        icon: 'text-[#2E75BF] bg-[#DDEEFF]',
        soft: 'bg-[#E3F0FF] text-[#2E75BF]',
        active: 'shadow-[0_0_0_3px_rgba(94,168,255,0.18)]',
      },
    } as const;

    return (
      <div className="relative overflow-hidden rounded-[10px] bg-[#FFFCF8] px-[16px] py-[16px] text-[#101010] md:px-[22px] md:py-[18px]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-[#E85D4C] via-[#F4A261] to-[#5EA8FF]" />
        <div className="mb-[14px] flex flex-col gap-[8px] md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-[11px] font-[700] uppercase leading-none text-[#9B7252]">
              content growth loop
            </p>
            <h3 className="mt-[5px] text-[19px] font-[800] leading-[1.05] text-[#101010] md:text-[22px]">
              内容生产闭环
            </h3>
          </div>
          <div className="flex items-center gap-[6px] text-[12px] font-[700] text-[#7B6B5D]">
            <span className="rounded-[7px] bg-white px-[8px] py-[5px] shadow-[inset_0_0_0_1px_rgba(28,28,30,0.07)]">
              6 个节点
            </span>
            <span className="rounded-[7px] bg-white px-[8px] py-[5px] shadow-[inset_0_0_0_1px_rgba(28,28,30,0.07)]">
              最终产出优先
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
          {v2Steps.map((step) => {
            const Icon = step.icon;
            const tone = toneClass[step.tone];
            const isActive = activeStep === step.id;
            return (
              <button
                key={`${step.number}-${step.title}`}
                onClick={() => onStepClick(step.id)}
                title={step.title}
                className={`group relative flex min-h-[154px] flex-col overflow-hidden rounded-[10px] border px-[13px] py-[12px] text-left transition duration-200 hover:-translate-y-[1px] hover:shadow-[0_12px_26px_rgba(102,83,61,0.09)] ${
                  tone.surface
                } ${isActive ? tone.active : ''}`}
              >
                <span className={`absolute inset-x-0 top-0 h-[3px] ${tone.accent}`} />
                <span className="flex items-center justify-between gap-[10px]">
                  <span className={`flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] ${tone.icon}`}>
                    <Icon size={15} strokeWidth={2.2} />
                  </span>
                  <span className="text-[18px] font-[800] leading-none text-[#161616]">
                    {step.number}
                  </span>
                </span>

                <span className="mt-[12px] block text-[17px] font-[800] leading-[1.18] text-[#111]">
                  {step.title}
                </span>
                <span className="mt-[8px] block flex-1 text-[12px] font-[560] leading-[1.55] text-[#34302B]">
                  {step.body}
                </span>
                <span className={`mt-[12px] block break-words rounded-[7px] px-[8px] py-[6px] text-[11px] font-[750] leading-[1.25] ${tone.soft}`}>
                  {step.skill}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-[14px]">
      <div className="flex flex-col gap-[4px] md:flex-row md:items-end md:justify-between">
        <div>
          <h3 className="text-[15px] font-bold text-[#1A1A1A]">主生产流程</h3>
          <p className="mt-[3px] text-[12px] text-[#6B6B6B]">
            从共享事实出发，先选择平台，再按各平台样本、选题、内容、视觉与发布结果独立推进。
          </p>
        </div>
        <span className="text-[12px] font-semibold text-[#E85D4C]">自动接力范围</span>
      </div>

      <div className="relative">
        <div className="absolute left-0 top-[26px] hidden h-[2px] w-full md:block">
          <div className="h-full w-full bg-[rgba(28,28,30,0.08)]">
            <motion.div
              className="h-full bg-gradient-to-r from-[#E85D4C] to-[#F4A261]"
              initial={{ width: '0%' }}
              animate={{
                width: running
                  ? '100%'
                  : `${Math.min(Math.max((activeStep - 1) / (productionSteps.length - 1), 0), 1) * 100}%`,
              }}
              transition={{ duration: running ? 6 : 0.6, ease: 'easeInOut' }}
            />
          </div>
        </div>

        <div className="relative grid grid-cols-1 gap-[10px] md:grid-cols-7 md:gap-[8px]">
          {productionSteps.map((step, idx) => {
            const Icon = step.icon;
            const isActive = activeStep === step.id;
            const isPast = activeStep > step.id;

            return (
              <motion.button
                key={step.id}
                onClick={() => onStepClick(step.id)}
                initial={{ opacity: 0, y: 22 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.06, duration: 0.42 }}
                className="group relative flex flex-row items-center gap-[12px] rounded-[12px] px-[10px] py-[8px] transition hover:bg-[rgba(28,28,30,0.035)] md:flex-col md:gap-[8px] md:px-[4px]"
              >
                <div
                  className={`relative flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] border transition-all duration-300 md:h-[54px] md:w-[54px] ${
                    isActive
                      ? 'border-[#E85D4C] bg-[#E85D4C] text-white shadow-[0_12px_24px_rgba(232,93,76,0.22)]'
                      : isPast
                        ? 'border-[rgba(232,93,76,0.3)] bg-[rgba(232,93,76,0.08)] text-[#E85D4C]'
                        : 'border-[rgba(28,28,30,0.1)] bg-white text-[#9A9A9A] hover:border-[#E85D4C] hover:text-[#E85D4C]'
                  }`}
                >
                  <Icon size={isActive ? 22 : 20} strokeWidth={isActive ? 2.5 : 2} />
                  {isActive && running && (
                    <div className="absolute -inset-[6px] rounded-[16px] border-2 border-[#E85D4C] opacity-40 animate-ping" />
                  )}
                </div>

                <div className="flex flex-col items-start md:items-center">
                  <span
                    className={`text-[13px] font-bold transition-colors md:text-[13px] ${
                      isActive ? 'text-[#1A1A1A]' : 'text-[#6B6B6B] group-hover:text-[#1A1A1A]'
                    }`}
                  >
                    {step.name}
                  </span>
                  <span className="mt-0.5 text-[12px] text-[#9A9A9A] md:hidden">
                    {step.phase}
                  </span>
                </div>

                {idx < productionSteps.length - 1 && (
                  <ChevronRight
                    size={18}
                    className="ml-auto text-[rgba(28,28,30,0.15)] md:hidden"
                  />
                )}
              </motion.button>
            );
          })}
        </div>
      </div>

      <div className="rounded-[14px] border border-dashed border-[rgba(28,28,30,0.12)] bg-[#FDF8F3] p-[12px]">
        <div className="flex flex-col gap-[10px] md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-[13px] font-bold text-[#1A1A1A]">发布后资产沉淀</h3>
            <p className="mt-[3px] text-[12px] leading-[1.6] text-[#6B6B6B]">
              需要真实发布数据、评论和最终成品后再进入。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-[7px] md:min-w-[360px]">
            {postLaunchSteps.map((step) => {
              const Icon = step.icon;
              const isActive = activeStep === step.id;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => onStepClick(step.id)}
                  className={`flex items-center justify-center gap-[6px] rounded-[11px] border px-[8px] py-[8px] text-[12px] font-bold transition ${
                    isActive
                      ? 'border-[#1C1C1E] bg-[#1C1C1E] text-white'
                      : 'border-[rgba(28,28,30,0.08)] bg-white text-[#6B6B6B] hover:text-[#1A1A1A]'
                  }`}
                >
                  <Icon size={14} />
                  {step.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
