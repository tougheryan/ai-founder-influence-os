export const PRODUCTION_PHASES = [
  'material_boundary',
  'topic_template',
  'content_package',
  'visual_assets',
  'draft_information',
  'publication_result',
  'weekly_review',
] as const;

export type ProductionPhase = (typeof PRODUCTION_PHASES)[number];

export const APPROVAL_SCOPES = [
  'topic_template',
  'content_package',
  'visual_assets',
  'draft_information',
  'publication_result',
] as const;

export type RunApprovalScope = (typeof APPROVAL_SCOPES)[number];

export type ApprovalInvalidationReason =
  | 'content_changed'
  | 'template_changed'
  | 'visual_changed'
  | 'platform_fields_changed';

export type RunApproval = {
  scope: RunApprovalScope;
  runSlug: string;
  version: number;
  sha256: string;
  approvedAt: string;
  method: 'human_review';
  artifactPath?: string;
  invalidatedAt?: string;
  invalidationReason?: ApprovalInvalidationReason;
};

const DOWNSTREAM_SCOPES: Record<RunApprovalScope, readonly RunApprovalScope[]> = {
  topic_template: ['content_package', 'visual_assets', 'draft_information', 'publication_result'],
  content_package: ['visual_assets', 'draft_information', 'publication_result'],
  visual_assets: ['draft_information', 'publication_result'],
  draft_information: ['publication_result'],
  publication_result: [],
};

export function isApprovalScope(value: string): value is RunApprovalScope {
  return (APPROVAL_SCOPES as readonly string[]).includes(value);
}

export function phaseForApproval(scope: RunApprovalScope): ProductionPhase {
  return scope;
}

export function invalidateDownstreamApprovals(
  approvals: readonly RunApproval[],
  changedScope: RunApprovalScope,
  details: { at: string; reason: ApprovalInvalidationReason },
): RunApproval[] {
  const downstream = new Set(DOWNSTREAM_SCOPES[changedScope]);
  return approvals.map((approval) => {
    if (!downstream.has(approval.scope) || approval.invalidatedAt) return { ...approval };
    return {
      ...approval,
      invalidatedAt: details.at,
      invalidationReason: details.reason,
    };
  });
}

export function matchesRunApproval(
  approval: RunApproval | null | undefined,
  target: Pick<RunApproval, 'scope' | 'runSlug' | 'version' | 'sha256'>,
): boolean {
  return Boolean(
    approval
      && approval.scope === target.scope
      && approval.runSlug === target.runSlug
      && approval.version === target.version
      && approval.sha256 === target.sha256
      && approval.method === 'human_review'
      && !approval.invalidatedAt,
  );
}
