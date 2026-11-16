'use client';

import { Check, CircleAlert, LockKeyhole } from 'lucide-react';
import { PRODUCTION_STATUS_DISPLAY_NAMES } from '@/lib/product-copy';
import {
  PRODUCTION_STAGES,
  canAdvanceStage,
  canViewProductionStage,
  isProductionStageApplicable,
  requiredProductionStages,
  type ProductionDraft,
  type ProductionStageId,
} from './production-model';

type Props = {
  activeStage: ProductionStageId;
  draft: ProductionDraft;
  onSelect: (stage: ProductionStageId) => void;
  onLockedSelect?: (stage: ProductionStageId) => void;
  stageStatusLabels?: Partial<Record<ProductionStageId, string>>;
};

function stageStateLabel(
  stage: (typeof PRODUCTION_STAGES)[number],
  completed: boolean,
  unlocked: boolean,
  current: boolean,
  applicable = true,
  hasResult = false,
  detail?: string,
  readable = false,
): string {
  if (!applicable) return '本期跳过';
  if (completed) return PRODUCTION_STATUS_DISPLAY_NAMES.completed;
  if (!unlocked) return readable ? '可查看旧稿，待确认上一步' : hasResult ? '已有结果，先确认上一步' : '先完成上一步';
  if (detail) return detail;
  if (stage.id === 'material-boundary') return PRODUCTION_STATUS_DISPLAY_NAMES.pending;
  if (hasResult && stage.requiresHumanApproval) return PRODUCTION_STATUS_DISPLAY_NAMES.blocked;
  if (!current) return PRODUCTION_STATUS_DISPLAY_NAMES.pending;
  if (stage.optional) return '可选';
  return stage.requiresHumanApproval
    ? PRODUCTION_STATUS_DISPLAY_NAMES.pending
    : PRODUCTION_STATUS_DISPLAY_NAMES.running;
}

export function ProductionStageRail({ activeStage, draft, onSelect, onLockedSelect, stageStatusLabels = {} }: Props) {
  const activeMeta = PRODUCTION_STAGES.find((stage) => stage.id === activeStage) || PRODUCTION_STAGES[0];
  const activeApplicable = isProductionStageApplicable(draft, activeMeta.id);
  const activeCompleted = draft.approved[activeMeta.id];
  const activeUnlocked = activeApplicable && canAdvanceStage(draft, activeMeta.id);
  const requiredStages = requiredProductionStages(draft);
  const completedCount = requiredStages.filter((stage) => draft.approved[stage.id]).length;
  const requiredCount = requiredStages.length;

  return (
    <nav aria-label="从素材到发布的步骤" className="aifios-stage-rail min-w-0 border-b xl:min-h-full xl:border-b-0 xl:border-l">
      <div className="aifios-stage-rail-heading hidden border-b px-5 py-5 xl:block">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[16px] font-bold">制作步骤</h2>
          <span className="text-[12px] font-semibold">{completedCount}/{requiredCount}</span>
        </div>
        <p className="mt-1 text-[12px] leading-[1.6]">可以回看已有稿件；继续制作前需完成相应确认。</p>
      </div>

      <div className="aifios-stage-rail-mobile border-b bg-white px-4 py-3 xl:hidden">
        <div className="flex items-center justify-between gap-3">
          <label className="min-w-0 flex-1">
            <span className="aifios-stage-rail-mobile-label mb-1 block text-[10px] font-bold">当前步骤</span>
            <select
              value={activeStage}
              onChange={(event) => onSelect(event.target.value as ProductionStageId)}
              className="aifios-stage-select h-10 w-full rounded-md border px-3 text-[12px] font-bold outline-none"
              aria-label="选择步骤"
            >
              {PRODUCTION_STAGES.map((stage) => {
                const applicable = isProductionStageApplicable(draft, stage.id);
                const unlocked = applicable && canAdvanceStage(draft, stage.id);
                const completed = draft.approved[stage.id];
                const readable = canViewProductionStage(draft, stage.id);
                return (
                  <option key={stage.id} value={stage.id} disabled={!readable}>
                    {String(stage.number).padStart(2, '0')} · {stage.id === 'topic-template' && draft.writingMode === 'author_material' ? '核对写作方案' : stage.label}（{stageStateLabel(stage, completed, unlocked, stage.id === activeStage, applicable, Boolean(draft.artifactPaths[stage.id]), stageStatusLabels[stage.id], readable)}）
                  </option>
                );
              })}
            </select>
          </label>
            <span className={`aifios-stage-mobile-status shrink-0 rounded-md px-2.5 py-1 text-[10px] font-bold ${
            activeCompleted ? 'is-complete' : activeUnlocked ? 'is-ready' : 'is-locked'
          }`}>
            {stageStateLabel(activeMeta, activeCompleted, activeUnlocked, true, activeApplicable, Boolean(draft.artifactPaths[activeStage]), stageStatusLabels[activeStage], canViewProductionStage(draft, activeStage))}
          </span>
        </div>
      </div>

      <ol className="aifios-stage-rail-list hidden p-4 xl:flex xl:flex-col">
        {PRODUCTION_STAGES.map((stage, index) => {
          const isCurrent = stage.id === activeStage;
          const applicable = isProductionStageApplicable(draft, stage.id);
          const completed = draft.approved[stage.id];
          const unlocked = applicable && canAdvanceStage(draft, stage.id);
          const readable = canViewProductionStage(draft, stage.id);
          const stateLabel = stageStateLabel(stage, completed, unlocked, isCurrent, applicable, Boolean(draft.artifactPaths[stage.id]), stageStatusLabels[stage.id], readable);
          const startsWorkSegment = index === 0 || PRODUCTION_STAGES[index - 1].workSegment !== stage.workSegment;
          return (
            <li key={stage.id} className="aifios-stage-item relative">
              {startsWorkSegment && (
                <p className="aifios-stage-work-segment mb-1.5 px-1 text-[10px] font-bold">
                  {stage.workSegment}
                </p>
              )}
              <button
                type="button"
                onClick={() => (readable ? onSelect(stage.id) : onLockedSelect?.(stage.id))}
                aria-current={isCurrent ? 'step' : undefined}
                aria-disabled={!readable}
                title={!applicable ? '本期未选择需要视觉制作的平台。' : !unlocked ? readable ? '查看已有稿件；修改和继续制作前请先确认上一步。' : '请先完成上一步。' : undefined}
                className={`aifios-stage-button relative flex min-h-[60px] w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left ${
                  isCurrent
                    ? 'is-current'
                    : readable
                      ? 'is-unlocked'
                      : 'is-locked'
                }`}
              >
                {isCurrent && <span aria-hidden="true" className="aifios-stage-button__marker absolute bottom-2 left-0 top-2 w-[3px]" />}
                <span className={`aifios-stage-number relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold ${
                  completed
                    ? 'is-complete'
                    : isCurrent
                      ? 'is-current'
                      : readable
                        ? 'is-unlocked'
                        : 'is-locked'
                }`}>
                  {completed ? <Check size={15} strokeWidth={2.5} /> : !readable ? <LockKeyhole size={13} /> : stage.number}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="aifios-stage-label block text-[12px] font-bold leading-[1.35]">{String(stage.number).padStart(2, '0')} · {stage.id === 'topic-template' && draft.writingMode === 'author_material' ? '核对写作方案' : stage.label}</span>
                  <span className={`aifios-stage-state mt-1 flex items-center gap-1 text-[10px] font-medium ${
                    completed ? 'is-complete' : !unlocked || stage.id === 'topic-template' ? 'is-waiting' : 'is-ready'
                  }`}>
                    {stateLabel === '待你确认' && <CircleAlert size={11} strokeWidth={2.2} />}
                    {stateLabel}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
