import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { materialPreparationProgress } from '@/lib/material-progress';

import {
  displayTaskMessage,
  productionTaskProgress,
  productionTaskStage,
  stagePanelStatus,
  ProductionTaskPanel,
  type ProductionTaskPanelTask,
} from './ProductionStagePanel';

describe('material preparation before generation', () => {
  const ready = { hasAnalysis: true, stale: false, writingMode: 'author_material', topic: '先问清楚' };
  const panel = { approved: false, busy: false, approvalReady: false, requiresHumanApproval: false };
  it('shows the missing connection after analysis, and preserves stale-input and empty states', () => {
    const progress = materialPreparationProgress({ ...ready, modelSetupIssue: '尚未配置密钥' });
    expect(stagePanelStatus({ ...panel, preparedStatus: progress?.label })).toBe('等你完成模型连接');
    expect(materialPreparationProgress({ ...ready, modelSetupIssue: null })?.label).toBe('素材已整理，待确认');
    expect(materialPreparationProgress({ ...ready, stale: true, modelSetupIssue: '尚未配置密钥' })?.label).toBe('素材有更改，待重新整理');
    expect(materialPreparationProgress({ ...ready, hasAnalysis: false })).toBeUndefined();
  });
  it('does not let preparation overwrite confirmation, an active operation or a failed task', () => {
    const preparedStatus = materialPreparationProgress({ ...ready, modelSetupIssue: '缺少密钥' })?.label;
    expect(stagePanelStatus({ ...panel, preparedStatus, approved: true })).toBe('已完成');
    expect(stagePanelStatus({ ...panel, preparedStatus, busy: true })).toBe('进行中');
    const task: ProductionTaskPanelTask = { taskId: 'failed', kind: 'author-blueprint', status: 'failed', currentStep: null,
      startedAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', steps: [] };
    expect(stagePanelStatus({ ...panel, preparedStatus, task })).not.toBe(preparedStatus);
  });
});

describe('production task display messages', () => {
  it('turns recovery diagnostics into user language without leaking technical terms', () => {
    const message = displayTaskMessage(
      'TikOmni 快照的 run、素材或 SHA-256 绑定校验失败。',
    );
    expect(message).toBe('平台数据不完整或已经变化。请重新获取平台数据后再继续。');
    expect(message).not.toMatch(/TikOmni|run|SHA-256|snapshot|runtime|operation/i);
  });

  it('hides an unknown stack or raw object instead of echoing it', () => {
    const message = displayTaskMessage(
      'renderer failed {"schema":"private"}\n at save (/Users/alice/private.ts:1:1)',
    );
    expect(message).toContain('请重试');
    expect(message).not.toMatch(/renderer|schema|alice|private|\{|\}/i);
  });

  it('uses the product names for the three required picture roles', () => {
    expect(displayTaskMessage('封面、证据图和 CTA 资产未完整。')).toBe(
      '平台成品还不完整。请重新生成公众号排版或小红书 P1-P8。',
    );
  });
});

describe('production task guidance', () => {
  it('foregrounds a verified recovered draft while preserving the failed task under closed history', () => {
    const task: ProductionTaskPanelTask = { taskId: 'task-recovered', kind: 'content-package', status: 'blocked', currentStep: 'content-package',
      startedAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:01:00Z', steps: [], contentRecovered: true,
      error: { code: 'content_release_blocked', displayMessage: '上次内容未完整生成。' } };
    const html = renderToStaticMarkup(createElement(ProductionTaskPanel, { task, currentStageId: 'content-package', onRetry: () => {} }));
    expect(html).toContain('这份稿已修好，可以继续检查成品。');
    expect(html).toContain('查看上次生成记录');
    expect(html).toContain('上次内容未完整生成。');
    expect(html).toContain('从这里重试');
    expect(html.indexOf('查看上次生成记录')).toBeLessThan(html.indexOf('从这里重试'));
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(task.status).toBe('blocked');
  });
  it('offers setup for a missing connection and resumes the same task when configured', () => {
    const task: ProductionTaskPanelTask = { taskId: 'task_setup', kind: 'topic-blueprint', status: 'blocked', currentStep: 'validate',
      startedAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:01Z',
      steps: [{ id: 'validate', label: '检查选题依据', status: 'blocked' }], error: { code: 'model_setup_required', displayMessage: '请连接服务' } };
    const props = { task, currentStageId: 'topic-template' as const, onRetry: () => {} };
    const missing = renderToStaticMarkup(createElement(ProductionTaskPanel, { ...props, modelSetupIssue: '缺少密钥' }));
    expect(missing).toContain('等你完成模型连接');
    expect(missing).toContain('连接写作服务后继续');
    expect(missing).not.toContain('从这里重试');
    const configured = renderToStaticMarkup(createElement(ProductionTaskPanel, { ...props, modelSetupIssue: null }));
    expect(configured).toContain('继续本期');
    expect(configured).not.toContain('连接写作服务后继续');
  });
  it('does not present four preparation steps as 80% of writing or elapsed generation time', () => {
    const task: ProductionTaskPanelTask = { taskId: 'author-1', kind: 'author-blueprint', status: 'blocked', currentStep: 'content-blueprint',
      startedAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z',
      steps: [
        ...['确认本期素材', '保存素材底稿', '保存题目与素材依据', '保存排版样式'].map((label, i) => ({ id: String(i), label, status: 'completed' as const })),
        { id: 'content-blueprint', label: '生成写作方案', status: 'blocked' },
      ], error: { code: 'model_setup_required' } };
    const html = renderToStaticMarkup(createElement(ProductionTaskPanel, { task, currentStageId: 'topic-template', recovered: true }));
    expect(html).toContain('准备进度已保存，正在等待你连接写作服务');
    expect(html).toContain('连接写作服务后继续');
    expect(html).toContain('已完成 4 项');
    expect(html).toContain('已读回上次记录');
    expect(html).toContain('2026-09-18T00:00:00Z');
    expect(html).not.toMatch(/80%|任务进度|任务历时|耗时/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });
  it.each(['queued', 'running', 'failed', 'completed'] as const)('explains %s using the actual task state', (status) => {
    const task: ProductionTaskPanelTask = { taskId: 'task-1', kind: 'content-package', status, currentStep: null,
      startedAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:01:00Z',
      steps: [{ id: 'first', label: '准备写作', status: status === 'queued' ? 'pending' : status }, { id: 'last', label: '保存文章', status: status === 'completed' ? 'completed' : 'pending' }],
      error: status === 'failed' ? '连接中断，已经收到的文字仍保留。' : { code: 'model_setup_required' } };
    const html = renderToStaticMarkup(createElement(ProductionTaskPanel, { task, currentStageId: 'content-package', onRetry: () => {} }));
    expect(html).toContain({ queued: '等待开始：准备写作', running: '正在处理：准备写作', failed: '已暂停：准备写作', completed: '本次处理已完成，请核对结果' }[status]);
    expect(html).not.toContain('连接写作服务后继续');
    if (status === 'failed') { expect(html).toContain('连接中断'); expect(html).toContain('从这里重试'); }
  });
  it('keeps result recovery and the separate charged retry visible on uncertain completion', () => {
    const task: ProductionTaskPanelTask = { taskId: 'task-unknown', kind: 'content-package', status: 'blocked', currentStep: null,
      startedAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:01:00Z', steps: [],
      error: { code: 'operation_outcome_unknown', displayMessage: '结果尚未核实' } };
    const html = renderToStaticMarkup(createElement(ProductionTaskPanel, { task, currentStageId: 'content-package', onRetry: () => {} }));
    expect(html).toContain('恢复已有结果');
    expect(html).toContain('重新执行这一步（可能产生费用）');
    expect(html.indexOf('恢复已有结果')).toBeLessThan(html.indexOf('<details'));
  });
  it('shows a return action instead of a full task when reading another stage', () => {
    const task: ProductionTaskPanelTask = { taskId: 'author-1', kind: 'author-blueprint', status: 'blocked', currentStep: 'content-blueprint',
      startedAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:01:00Z', steps: [], error: { code: 'model_setup_required' } };
    const html = renderToStaticMarkup(createElement(ProductionTaskPanel, { task, currentStageId: 'material-boundary', onReturnToTaskStage: () => {} }));
    expect(html).toContain('等你完成模型连接');
    expect(html).toContain('返回处理步骤');
    expect(html).not.toContain('查看过程');
    expect(html).not.toContain('连接写作服务后继续');
  });
  it('returns users to the stage that owns the background work', () => {
    expect(productionTaskStage('author-blueprint', 'material-intake')).toBe('material-boundary');
    expect(productionTaskStage('author-blueprint', 'content-blueprint')).toBe('topic-template');
    expect(productionTaskStage('material-research')).toBe('material-boundary');
    expect(productionTaskStage('topic-blueprint')).toBe('topic-template');
    expect(productionTaskStage('content-package')).toBe('content-package');
    expect(productionTaskStage('visual-candidates')).toBe('visual-assets');
    expect(productionTaskStage('draft-queue')).toBe('draft-information');
  });

  it('distinguishes completed work from skipped steps', () => {
    expect(productionTaskProgress({ steps: [
      { id: 'one', label: '一', status: 'completed' },
      { id: 'two', label: '二', status: 'skipped' },
      { id: 'three', label: '三', status: 'running' },
      { id: 'four', label: '四', status: 'pending' },
    ] })).toEqual({ completed: 1, skipped: 1, total: 4 });
  });
});
