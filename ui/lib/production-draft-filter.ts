import type { ProductionDraftSummary } from './production-drafts';
import type { ProductionFlowIntegrity } from './production-flow';

export type DraftStatus = 'pending' | 'ready' | 'published' | 'unknown';
export type DraftFilter = 'all' | DraftStatus;
export const DRAFT_FILTERS: { value: DraftFilter; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'pending', label: '待继续处理' },
  { value: 'ready', label: '可导出' }, { value: 'published', label: '已有发布记录' },
  { value: 'unknown', label: '进度待核对' },
];

/** Export readiness needs current content and deliverable approvals, not file existence. */
export function draftDeliveryStatus(flow: ProductionFlowIntegrity | null): DraftStatus {
  if (!flow) return 'unknown';
  const confirmed = (scope: string) => {
    const artifact = flow.artifacts[scope];
    const approval = flow.approvals[scope];
    return Boolean(artifact?.exists && artifact.hash_matches_registered !== false && artifact.sha256
      && approval?.approved && approval.path === artifact.path && approval.sha256 === artifact.sha256);
  };
  if (flow.draft_queue.lineage_current !== true) return 'pending';
  if (flow.publication.confirmed > 0) return 'published';
  return confirmed('content_package') && confirmed('draft_information') && flow.draft_queue.complete ? 'ready' : 'pending';
}

const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
export function filterProductionDrafts(items: ProductionDraftSummary[], query: string, status: DraftFilter): ProductionDraftSummary[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return items.filter((item) => (status === 'all' || (item.status || 'unknown') === status)
    && terms.every((term) => normalize(`${item.name} ${item.topic || ''} ${item.excerpt || ''}`).includes(term)));
}
