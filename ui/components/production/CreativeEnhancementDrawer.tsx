'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, LoaderCircle, Sparkles, UsersRound, X } from 'lucide-react';
import type { ProductionStageId } from './production-model';

export type CreativeEnhancement = {
  id: string;
  title: string;
  description: string;
  tool: string;
  prompt: string;
};

type EnhancementResult = {
  output: string;
  savedPath: string;
};

const ENHANCEMENTS: Record<'topic-template' | 'content-package', CreativeEnhancement[]> = {
  'topic-template': [
    {
      id: 'business-diagnosis',
      title: '检查商业目标',
      description: '看看内容要打动谁，以及读者看完可以做什么。',
      tool: 'dbs-diagnosis',
      prompt: '基于本期主题，给出不超过三条可执行的商业表达判断、边界和结尾引导要求。不要虚构业务事实。',
    },
    {
      id: 'deep-benchmark',
      title: '对比同类内容',
      description: '找出哪些做法值得借鉴，哪些不适合照搬。',
      tool: 'dbs-benchmark',
      prompt: '基于本期主题与同类内容的具体依据，说明哪些写法值得测试、哪些条件无法照搬，以及本期可以尝试的不同写法；不要模仿具体作品或人格。',
    },
    {
      id: 'content-strategy',
      title: '检查写法',
      description: '确定从哪里讲起、核心观点是什么、要引起什么感受。',
      tool: 'dbs-content',
      prompt: '为本期主题诊断叙事入口、核心冲突、受众情绪和内容形式取舍，给出三条简洁约束。',
    },
    {
      id: 'multi-perspective',
      title: '换个角度挑错',
      description: '提前找出反例、容易被误解的地方和缺少的依据。',
      tool: 'dbs-chatroom',
      prompt: '用不同受众立场挑战本期判断，输出最值得回应的反例、误读风险和补证建议。',
    },
    {
      id: 'personal-growth',
      title: '找出当前卡点',
      description: '找出这次创作为什么推不动，并给一个下一步建议。',
      tool: 'dbs-action',
      prompt: '识别本期创作中的行动阻力，给出一条私人的下一步行动建议；不要自动写进公开内容。',
    },
  ],
  'content-package': [
    {
      id: 'content-diagnosis',
      title: '检查文章节奏',
      description: '看开头是否吸引人、章节是否顺、有没有绕弯。',
      tool: 'dbs-content',
      prompt: '检查公众号文章和其余五份内容的开头、章节推进和表达效率，给出三条可以直接执行的修改要求。',
    },
    {
      id: 'resonance-check',
      title: '检查读者是否有感',
      description: '看场景是否具体，读者能否对号入座。',
      tool: 'dbs-resonate',
      prompt: '检查本期内容的读者共鸣、具体场景和互动入口，给出可验证的调整建议。',
    },
    {
      id: 'spread-mechanism',
      title: '检查标题和开场',
      description: '看标题、图文卡片和视频开场是否让人想继续看。',
      tool: 'dbs-spread',
      prompt: '从传播心理角度审阅文章、观点卡和视频钩子，说明保留什么、删除什么、需要补什么。',
    },
    {
      id: 'counterargument',
      title: '从反方角度挑错',
      description: '提前找出说过头、没有依据或容易误解的地方。',
      tool: 'dbs-chatroom',
      prompt: '模拟合理反方对本期成品的质疑，输出需要收紧的判断、证据边界和平台风险。',
    },
    {
      id: 'execution-focus',
      title: '减少无用动作',
      description: '保留最重要的发布动作，删掉多余步骤。',
      tool: 'dbs-slowisfast',
      prompt: '从长期资产与执行摩擦角度，给出一条本期应保留的发布动作和一条应删去的复杂动作。',
    },
  ],
};

type Props = {
  stage: ProductionStageId | null;
  projectId: string;
  runId: string;
  onClose: () => void;
  onRun: (enhancement: CreativeEnhancement) => Promise<EnhancementResult>;
  onAdopt: (enhancement: CreativeEnhancement, result: EnhancementResult) => Promise<void>;
};

export function displayEnhancementError(error: string): string {
  const cleaned = error
    .replace(/(?:pipeline|materials|runs)\/[\w./@-]+/gi, '相关文件')
    .replace(/\b(?:run|task|asset|revision)[_-][A-Za-z0-9_-]+\b/gi, '相关记录')
    .replace(/\b[a-f0-9]{32,64}\b/gi, '内容校验值')
    .replace(/(?:LLM|AI|Agent)/gi, '生成服务')
    .replace(/创作增强/g, '专项检查')
    .replace(/\b(?:pipeline|runtime|snapshot|artifact|schema|slug|hash)\b/gi, '系统信息')
    .replace(/\b(?:TypeError|ReferenceError|SyntaxError|Error):?\s*/gi, '')
    .trim();
  if (!cleaned || /^[\[{]/.test(cleaned) || /(?:\/Users\/|\/private\/|[A-Za-z]:\\)/.test(cleaned)) {
    return '这项检查没有完成。请重试；如果仍然失败，请到系统设置测试连接。';
  }
  return cleaned;
}

export function displayEnhancementOutput(output: string): string {
  const cleaned = output
    .replace(/公众号母稿|母稿/g, '公众号文章')
    .replace(/(?:完整\s*)?1\s*\+\s*2\s*\+\s*3\s*内容包|内容包/g, '全部 6 份内容')
    .replace(/CTA\s*图|CTA/gi, '结尾图')
    .replace(/B[\s-]?roll/gi, '补充画面')
    .replace(/视觉资产|视觉候选/g, '配图方案')
    .replace(/公开样本|公开对标/g, '同类内容')
    .replace(/(?:pipeline|materials|runs)\/[\w./@-]+/gi, '相关文件')
    .replace(/\b(?:run|task|asset|revision)[_-][A-Za-z0-9_-]+\b/gi, '相关记录')
    .replace(/\b[a-f0-9]{32,64}\b/gi, '内容校验值')
    .replace(/\b(?:pipeline|runtime|snapshot|artifact|schema|slug|hash|SHA-256)\b/gi, '系统信息')
    .replace(/([\u4E00-\u9FFF])\s+(?=[\u4E00-\u9FFF])/g, '$1')
    .trim();
  if (!cleaned || /^[\[{]/.test(cleaned) || /(?:\/Users\/|\/private\/|[A-Za-z]:\\)/.test(cleaned)) {
    return '检查结果暂时无法显示。请重新检查。';
  }
  return cleaned;
}

export function CreativeEnhancementDrawer({ stage, projectId, runId, onClose, onRun, onAdopt }: Props) {
  const [results, setResults] = useState<Record<string, EnhancementResult>>({});
  const [runningId, setRunningId] = useState('');
  const [adoptingId, setAdoptingId] = useState('');
  const [error, setError] = useState('');
  const visible = stage === 'topic-template' || stage === 'content-package';

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, visible]);

  if (!visible) return null;

  const title = stage === 'topic-template' ? '检查选题' : '检查内容';
  const items = ENHANCEMENTS[stage];
  const ready = Boolean(projectId && runId);

  const run = async (enhancement: CreativeEnhancement) => {
    if (!ready || runningId || adoptingId) return;
    setRunningId(enhancement.id);
    setError('');
    try {
      const result = await onRun(enhancement);
      setResults((current) => ({ ...current, [enhancement.id]: result }));
    } catch (runError) {
      setError(displayEnhancementError(runError instanceof Error ? runError.message : ''));
    } finally {
      setRunningId('');
    }
  };

  const adopt = async (enhancement: CreativeEnhancement) => {
    const result = results[enhancement.id];
    if (!result || runningId || adoptingId) return;
    setAdoptingId(enhancement.id);
    setError('');
    try {
      await onAdopt(enhancement, result);
      onClose();
    } catch (adoptError) {
      setError(displayEnhancementError(adoptError instanceof Error ? adoptError.message : ''));
    } finally {
      setAdoptingId('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(28,28,30,0.22)]" role="presentation" onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex h-full w-full max-w-[460px] flex-col border-l border-[rgba(28,28,30,0.1)] bg-white shadow-[-16px_0_36px_rgba(28,28,30,0.12)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[rgba(28,28,30,0.08)] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[#E85D4C]">
              <Sparkles size={17} />
              <span className="text-[12px] font-bold">专项检查</span>
            </div>
            <h2 className="mt-2 text-[19px] font-bold text-[#1A1A1A]">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭专项检查"
            title="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center text-[#6B6B6B] transition-colors hover:bg-[#F5EDE4] hover:text-[#1A1A1A]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!ready && (
            <p className="border-l-[3px] border-[#E4A43B] bg-[#FFF8E8] px-3 py-2 text-[12px] leading-[1.6] text-[#8D5A00]">
              请先开始本期内容，再运行专项检查。
            </p>
          )}
          {error && <p role="alert" className="mt-3 border-l-[3px] border-[#E85D4C] bg-[#FFF1EE] px-3 py-2 text-[12px] leading-[1.6] text-[#B43C2E]">{error}</p>}
          <div className="mt-3 space-y-2">
            {items.map((item) => {
              const result = results[item.id];
              const running = runningId === item.id;
              const adopting = adoptingId === item.id;
              return (
                <article key={item.id} className="border border-[rgba(28,28,30,0.1)] bg-white">
                  <button
                    type="button"
                    onClick={() => void run(item)}
                    disabled={!ready || Boolean(runningId) || Boolean(adoptingId)}
                    className="group flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-[#FFF8F5] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center bg-[#F5EDE4] text-[#E85D4C] transition-colors group-hover:bg-[#E85D4C] group-hover:text-white">
                      {running ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-bold text-[#1A1A1A]">{item.title}</span>
                      <span className="mt-1 block text-[12px] leading-[1.6] text-[#6B6B6B]">{item.description}</span>
                    </span>
                  </button>
                  {result && (
                    <div className="border-t border-[rgba(28,28,30,0.08)] px-3 py-3">
                      <p className="max-h-44 overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.65] text-[#454545]">{displayEnhancementOutput(result.output)}</p>
                      <button
                        type="button"
                        onClick={() => void adopt(item)}
                        disabled={Boolean(runningId) || Boolean(adoptingId)}
                        className="mt-3 inline-flex h-8 items-center gap-1.5 border border-[#1A1A1A] bg-[#1A1A1A] px-3 text-[11px] font-bold text-white hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {adopting ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
                        用于本期
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <div className="mt-5 border-t border-[rgba(28,28,30,0.08)] pt-5">
            <Link
              href={`/benchmark-advisor?${new URLSearchParams({
                projectId: projectId || 'default',
                ...(runId ? { runId } : {}),
              }).toString()}`}
              className="group flex w-full items-start gap-3 border border-[rgba(28,28,30,0.12)] bg-[#FDF8F3] p-3 text-left transition-colors hover:border-[#E85D4C] hover:bg-[#FFF8F5]"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center bg-white text-[#E85D4C] transition-colors group-hover:bg-[#E85D4C] group-hover:text-white">
                <UsersRound size={15} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-bold text-[#1A1A1A]">同类账号对比</span>
                <span className="mt-1 block text-[12px] leading-[1.6] text-[#6B6B6B]">对比相关账号和视频，查看本期已保存的结论。</span>
              </span>
              <ArrowRight size={15} className="mt-1 shrink-0 text-[#8A8178] transition-transform group-hover:translate-x-0.5 group-hover:text-[#C94A3B]" />
            </Link>
          </div>
        </div>
      </aside>
    </div>
  );
}
