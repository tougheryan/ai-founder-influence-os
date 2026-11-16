import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProductionDraftSummary } from '@/lib/production-drafts';
import { ProductionDraftList } from './ProductionDraftShelf';
import { filterProductionDrafts, draftDeliveryStatus } from '@/lib/production-draft-filter';
import type { ProductionFlowIntegrity } from '@/lib/production-flow';

const entry = (changes: Partial<ProductionDraftSummary> = {}): ProductionDraftSummary => ({
  id: 'draft_a', name: '客户常问的问题', version: 1, updatedAt: '2026-09-20T12:00:00Z',
  modifiedAt: '2026-09-20T10:00:00Z', runId: 'run-a', platforms: ['wechat'], source: 'saved',
  excerpt: '一位客户提出了三个需求。', progress: { label: '正文文件已保存', nextStep: '打开核对正文与确认状态。' }, ...changes,
});
const render = (items: ProductionDraftSummary[], identity: { currentDraftId?: string; currentRunId?: string } = {}) => renderToStaticMarkup(<ProductionDraftList items={items} disabled={false} onOpen={() => {}} {...identity} />);

describe('searching a working library', () => {
  it('combines title/material search with status without modifying or reordering 30 drafts', () => {
    const items = Array.from({ length: 30 }, (_, index) => entry({ id: `draft_${index}`, name: `客户笔记 ${index}`, topic: `交付计划 ${index}`, excerpt: index === 17 ? 'ACME 客户的交期' : '其他素材', status: index % 2 ? 'ready' : 'pending' }));
    const before = JSON.stringify(items);
    expect(filterProductionDrafts(items, '  ａｃｍｅ  交期 ', 'ready').map((item) => item.id)).toEqual(['draft_17']);
    expect(filterProductionDrafts(items, '交付计划 17', 'all').map((item) => item.id)).toEqual(['draft_17']);
    expect(filterProductionDrafts(items, 'ACME', 'pending')).toEqual([]);
    expect(filterProductionDrafts(items, '', 'ready')).toHaveLength(15);
    expect(filterProductionDrafts(items, '', 'all')).toEqual(items);
    expect(JSON.stringify(items)).toBe(before);
  });
  it('keeps unknown status distinct and treats metacharacters as literal search text', () => {
    const items = [entry({ name: '[客户] (.*)', status: undefined }), entry({ id: 'b', status: 'pending' })];
    expect(filterProductionDrafts(items, '[客户]', 'unknown')).toEqual([items[0]]);
    expect(filterProductionDrafts(items, 'missing', 'all')).toEqual([]);
  });
});

const delivery = (): ProductionFlowIntegrity => ({
  run_id: 'run-a', slug: 'topic-a', artifacts: {
    content_package: { path: 'pipeline/package/a.md', sha256: 'a'.repeat(64), exists: true },
    draft_information: { path: 'pipeline/publish/a.json', sha256: 'b'.repeat(64), exists: true },
  }, approvals: {
    content_package: { approved: true, path: 'pipeline/package/a.md', sha256: 'a'.repeat(64) },
    draft_information: { approved: true, path: 'pipeline/publish/a.json', sha256: 'b'.repeat(64) },
  }, draft_queue: { path: '', total: 1, complete: true, lineage_current: true, status_counts: {} }, publication: { ledger_path: '', records: 0, confirmed: 0, complete: false },
  current_phase: { id: 'draft_information', number: 5 }, invalidations: [], weekly_review: { status: 'pending', missing_metrics: 0, memory_applied: false },
  resolved_paths: { package_path: '', deliverables_path: '', visual_manifest_path: '', draft_queue_path: '', publication_ledger_path: '' },
  recovery: { persistent_tasks: true, write_locking: true, idempotency_supported: true },
});

describe('truthful delivery filters', () => {
  it('requires both current approvals and a complete current queue before marking export ready', () => {
    expect(draftDeliveryStatus(delivery())).toBe('ready');
    for (const scope of ['content_package', 'draft_information']) {
      const flow = delivery(); flow.approvals[scope].sha256 = 'c'.repeat(64);
      expect(draftDeliveryStatus(flow)).toBe('pending');
      flow.approvals[scope].sha256 = flow.artifacts[scope]!.sha256;
      flow.artifacts[scope]!.hash_matches_registered = false;
      expect(draftDeliveryStatus(flow)).toBe('pending');
    }
    const flow = delivery(); flow.draft_queue.complete = false;
    expect(draftDeliveryStatus(flow)).toBe('pending');
    expect(draftDeliveryStatus(null)).toBe('unknown');
  });
  it('keeps publication tied to the current queue and never equates a file with publication', () => {
    const flow = delivery(); flow.publication.confirmed = 1;
    expect(draftDeliveryStatus(flow)).toBe('published');
    flow.draft_queue.lineage_current = false;
    expect(draftDeliveryStatus(flow)).toBe('pending');
    const unconfirmed = delivery(); unconfirmed.approvals = {};
    expect(draftDeliveryStatus(unconfirmed)).toBe('pending');
  });
});

describe('draft shelf identity and saved evidence', () => {
  it('marks only the exact current snapshot even if another row belongs to the same run', () => {
    const html = render([entry(), entry({ id: 'draft_b', name: '另一个快照' })], { currentDraftId: 'draft_a', currentRunId: 'run-a' });
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="正在编辑草稿：客户常问的问题"');
    expect(html).toContain('aria-label="打开草稿：另一个快照"');
  });
  it('marks a bare runtime row only when no saved draft identity exists', () => {
    const runtime = entry({ id: 'run:run-a', source: 'runtime' });
    expect(render([runtime], { currentRunId: 'run-a' })).toContain('aria-current="true"');
    expect(render([runtime], { currentDraftId: 'draft_missing', currentRunId: 'run-a' })).not.toContain('aria-current="true"');
  });
  it('shows individual summaries, truthful file status, next action and separate save/modification labels', () => {
    const html = render([entry(), entry({ id: 'draft_b', name: '第二份', excerpt: '另一位读者的故事。', progress: { label: '素材已保存', nextStep: '整理素材。' } })]);
    expect(html).toContain('一位客户提出了三个需求。');
    expect(html).toContain('另一位读者的故事。');
    expect(html).toContain('正文文件已保存');
    expect(html).toContain('下一步：');
    expect(html).toContain('输入修改：');
    expect(html).toContain('快照保存：');
    expect(html).not.toContain('已完成');
  });
  it('labels missing legacy details and invalid dates as unknown instead of inventing progress', () => {
    const html = render([entry({ excerpt: undefined, progress: undefined, modifiedAt: undefined, updatedAt: 'unknown' })]);
    expect(html).toContain('旧草稿尚无摘要');
    expect(html).toContain('进度待核对');
    expect(html).toContain('输入修改：未记录');
    expect(html).toContain('快照保存：未记录');
    expect(html).not.toContain('Invalid Date');
  });
  it('does not relabel a runtime timestamp as an author edit and escapes source text', () => {
    const html = render([entry({ id: 'run:run-a', source: 'runtime', excerpt: '<script>alert(1)</script>' })]);
    expect(html).toContain('任务记录更新：');
    expect(html).toContain('输入修改时间未记录');
    expect(html).not.toContain('输入修改：');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
