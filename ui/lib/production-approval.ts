import {
  isApprovalScope,
  matchesRunApproval,
  type RunApproval,
  type RunApprovalScope,
} from './production-state';

export type RuntimeProductionApproval = {
  approved: boolean;
  scope?: string;
  run_id?: string;
  run_slug?: string;
  path?: string;
  sha256?: string;
  version?: number;
  approved_at?: string;
  method?: string;
  invalidated_at?: string;
  invalidation_reason?: string;
  reason?: string;
};

export function runtimeApprovalToRunApproval(
  status: RuntimeProductionApproval,
): RunApproval | null {
  if (
    !status.scope || !isApprovalScope(status.scope) || !status.run_slug || !status.sha256
    || !status.approved_at || typeof status.version !== 'number' || status.method !== 'human_review'
  ) {
    return null;
  }
  return {
    scope: status.scope,
    runSlug: status.run_slug,
    version: status.version,
    sha256: status.sha256,
    approvedAt: status.approved_at,
    method: 'human_review',
    artifactPath: status.path,
    invalidatedAt: status.invalidated_at,
    invalidationReason: status.invalidation_reason as RunApproval['invalidationReason'],
  };
}

export function matchesRuntimeProductionApproval(
  status: RuntimeProductionApproval,
  target: {
    scope: RunApprovalScope;
    runSlug: string;
    version: number;
    sha256: string;
  },
): boolean {
  return status.approved === true && matchesRunApproval(runtimeApprovalToRunApproval(status), target);
}
