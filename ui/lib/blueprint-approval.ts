export type BlueprintApproval = {
  scope: 'blueprint';
  run_id: string;
  run_slug?: string;
  path: string;
  sha256: string;
  approved_at: string;
  method: 'human_blueprint_review';
  invalidated_at?: string;
  invalidation_reason?: string;
};

export type BlueprintApprovalTarget = {
  runId: string;
  path: string;
  sha256: string;
};

export function matchesBlueprintApproval(
  approval: BlueprintApproval | null | undefined,
  target: BlueprintApprovalTarget,
): boolean {
  return Boolean(
    approval
      && approval.scope === 'blueprint'
      && approval.run_id === target.runId
      && approval.path === target.path
      && approval.sha256 === target.sha256
      && approval.method === 'human_blueprint_review'
      && !approval.invalidated_at,
  );
}
