import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProductionStageRail } from './ProductionStageRail';
import { materialPreparationProgress } from '@/lib/material-progress';
import { createProductionDraft, type ProductionDraft, type ProductionStageId } from './production-model';

function articleLabels(draft: ProductionDraft, activeStage: ProductionStageId) {
  const html = renderToStaticMarkup(<ProductionStageRail draft={draft} activeStage={activeStage} onSelect={() => {}} />);
  return [
    html.match(/<option value="content-package"[^>]*>(.*?)<\/option>/)?.[1],
    html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes('03 ·')),
  ];
}

function withArticle() {
  const draft = createProductionDraft();
  draft.runId = 'run-one';
  draft.approved['material-boundary'] = true;
  draft.approved['topic-template'] = true;
  draft.artifactPaths['content-package'] = 'pipeline/package/article.md';
  return draft;
}

describe('persisted article progress in navigation', () => {
  it('does not call opening an empty material step ongoing work', () => {
    const draft = createProductionDraft();
    const html = renderToStaticMarkup(<ProductionStageRail draft={draft} activeStage="material-boundary" onSelect={() => {}} />);
    expect(html.match(/<option value="material-boundary"[^>]*>(.*?)<\/option>/)?.[1]).toContain('未开始');
    const busy = renderToStaticMarkup(<ProductionStageRail draft={draft} activeStage="material-boundary" onSelect={() => {}} stageStatusLabels={{ 'material-boundary': '进行中' }} />);
    expect(busy.match(/<option value="material-boundary"[^>]*>(.*?)<\/option>/)?.[1]).toContain('进行中');
  });
  it('shows preparation consistently before a task exists without unlocking the plan', () => {
    const draft = { ...createProductionDraft(), writingMode: 'author_material' as const, topic: '先问清楚' };
    const progress = materialPreparationProgress({ hasAnalysis: true, stale: false, ...draft, modelSetupIssue: '缺少密钥' });
    const html = renderToStaticMarkup(<ProductionStageRail draft={draft} activeStage="material-boundary" onSelect={() => {}} stageStatusLabels={{ 'material-boundary': progress?.label }} />);
    expect(html.match(/<option value="material-boundary"[^>]*>(.*?)<\/option>/)?.[1]).toContain('等你完成模型连接');
    expect(html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes('01 ·'))).toContain('等你完成模型连接');
    expect(html.match(/<option value="topic-template"[^>]*>/)?.[0]).toContain('disabled');
  });
  it('shows the concrete task blocker in desktop and mobile navigation without unlocking later stages', () => {
    const draft = createProductionDraft();
    draft.approved['material-boundary'] = true;
    const html = renderToStaticMarkup(<ProductionStageRail draft={draft} activeStage="topic-template" onSelect={() => {}} stageStatusLabels={{ 'topic-template': '等你完成模型连接', 'content-package': '进行中' }} />);
    expect(html.match(/<option value="topic-template"[^>]*>(.*?)<\/option>/)?.[1]).toContain('等你完成模型连接');
    expect(html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes('02 ·'))).toContain('等你完成模型连接');
    expect(html.match(/<option value="content-package"[^>]*>(.*?)<\/option>/)?.[1]).toContain('先完成上一步');
  });
  it('shows an existing unapproved article consistently while reading the plan or the article', () => {
    for (const stage of ['topic-template', 'content-package'] as const) {
      for (const label of articleLabels(withArticle(), stage)) {
        expect(label).toContain('待你确认');
        expect(label).not.toContain('未开始');
      }
    }
  });
  it('does not claim an ungenerated article is ready for confirmation', () => {
    const draft = withArticle();
    delete draft.artifactPaths['content-package'];
    for (const label of articleLabels(draft, 'content-package')) expect(label).toContain('未开始');
  });
  it('lets desktop and mobile open the old article while keeping the next production stage locked', () => {
    const draft = withArticle();
    draft.approved['topic-template'] = false;
    const labels = articleLabels(draft, 'topic-template');
    for (const label of labels) expect(label).toContain('可查看旧稿，待确认上一步');
    expect(labels[1]).toContain('aria-disabled="false"');
    const html = renderToStaticMarkup(<ProductionStageRail draft={draft} activeStage="content-package" onSelect={() => {}} />);
    expect(html.match(/<option value="content-package"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(html.match(/<option value="visual-assets"[^>]*>/)?.[0]).toContain('disabled');
  });
  it('keeps explicitly approved articles completed', () => {
    const draft = withArticle();
    draft.approved['content-package'] = true;
    for (const label of articleLabels(draft, 'topic-template')) expect(label).toContain('已完成');
  });
});
