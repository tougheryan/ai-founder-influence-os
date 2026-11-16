import { describe, expect, it } from 'vitest';
import { matchesBlueprintApproval, type BlueprintApproval } from './blueprint-approval';

const approval: BlueprintApproval = {
  scope: 'blueprint',
  run_id: 'topic-run',
  path: 'pipeline/blueprint/topic-blueprint.md',
  sha256: 'a'.repeat(64),
  approved_at: '2026-07-15T10:00:00Z',
  method: 'human_blueprint_review',
};

describe('blueprint approval', () => {
  it('requires the current run, path, digest, and human approval method', () => {
    expect(matchesBlueprintApproval(approval, {
      runId: 'topic-run',
      path: 'pipeline/blueprint/topic-blueprint.md',
      sha256: 'a'.repeat(64),
    })).toBe(true);

    expect(matchesBlueprintApproval(approval, {
      runId: 'other-run',
      path: 'pipeline/blueprint/topic-blueprint.md',
      sha256: 'a'.repeat(64),
    })).toBe(false);
    expect(matchesBlueprintApproval(approval, {
      runId: 'topic-run',
      path: 'pipeline/blueprint/edited.md',
      sha256: 'a'.repeat(64),
    })).toBe(false);
    expect(matchesBlueprintApproval(approval, {
      runId: 'topic-run',
      path: 'pipeline/blueprint/topic-blueprint.md',
      sha256: 'b'.repeat(64),
    })).toBe(false);
    expect(matchesBlueprintApproval({ ...approval, invalidated_at: '2026-07-15T10:05:00Z' }, {
      runId: 'topic-run',
      path: 'pipeline/blueprint/topic-blueprint.md',
      sha256: 'a'.repeat(64),
    })).toBe(false);
  });
});
