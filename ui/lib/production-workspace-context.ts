/** Read-only navigation context; never approval or content authority. */
export const PRODUCTION_WORKSPACE_STORAGE_KEY = 'aifios.production-workbench.v1';
export type ProductionWorkspaceContext =
  | { state: 'none' | 'unavailable' }
  | { state: 'selected'; runId: string; name: string; returnHref: string };

export function productionWorkspaceContext(raw: string | null): ProductionWorkspaceContext {
  if (!raw) return { state: 'none' };
  try {
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !stored.draft || typeof stored.draft !== 'object') return { state: 'unavailable' };
    const runId = stored.draft.runId;
    if (runId === '' || runId === undefined) return { state: 'none' };
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) return { state: 'unavailable' };
    const draftId = typeof stored.savedDraftId === 'string' && /^draft_[a-f0-9]{32}$/.test(stored.savedDraftId) ? stored.savedDraftId : `run:${runId}`;
    const name = (typeof stored.draftName === 'string' && stored.draftName.trim())
      || (typeof stored.draft.topic === 'string' && stored.draft.topic.trim()) || '未命名草稿';
    return { state: 'selected', runId, name: name.slice(0, 100), returnHref: `/production?stage=2&openDraft=${encodeURIComponent(draftId)}` };
  } catch { return { state: 'unavailable' }; }
}
