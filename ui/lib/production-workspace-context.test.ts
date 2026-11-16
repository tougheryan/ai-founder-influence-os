import { describe, expect, it } from 'vitest';
import { productionWorkspaceContext } from './production-workspace-context';

describe('the selected draft shared by the workbench and settings', () => {
  it('binds the request and return link to the opened draft instead of another active run', () => {
    const savedDraftId = `draft_${'a'.repeat(32)}`;
    const selected = productionWorkspaceContext(JSON.stringify({ savedDraftId, draftName: '客户问题', draft: { runId: 'run-a', topic: 'raw topic' } }));
    expect(selected).toEqual({ state: 'selected', runId: 'run-a', name: '客户问题', returnHref: `/production?stage=2&openDraft=${savedDraftId}` });
    expect(productionWorkspaceContext(JSON.stringify({ draft: { runId: 'run-b', topic: '新稿' } }))).toMatchObject({ runId: 'run-b', returnHref: '/production?stage=2&openDraft=run%3Arun-b' });
  });
  it('never substitutes a historical task for an intentionally blank new draft', () => {
    for (const raw of [null, JSON.stringify({ draft: { runId: '' } }), JSON.stringify({ draft: {} })]) expect(productionWorkspaceContext(raw)).toEqual({ state: 'none' });
  });
  it.each(['{', 'null', '[]', '{"draft":{"runId":"../another-project"}}', '{"draft":{"runId":23}}'])('does not turn corrupt selection %s into an active-task fallback', (raw) => {
    expect(productionWorkspaceContext(raw)).toEqual({ state: 'unavailable' });
  });
  it('does not trust a malformed saved-draft link', () => {
    expect(productionWorkspaceContext(JSON.stringify({ savedDraftId: 'draft_a&stage=6', draft: { runId: 'run-a' } }))).toMatchObject({ name: '未命名草稿', returnHref: '/production?stage=2&openDraft=run%3Arun-a' });
  });
});
