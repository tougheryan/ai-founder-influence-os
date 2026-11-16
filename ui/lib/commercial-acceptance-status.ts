export const CURRENT_ACCEPTANCE_REASON = '当前固定排版流程的正式验收契约尚待独立评审；旧生图验收和内部验收不能用于本次商业交付。';

export type AcceptanceReadState = 'read' | 'missing' | 'invalid' | 'unreadable';
export type AcceptanceEligibility = 'legacy_read_only' | 'internal_only' | 'pending_contract_review' | 'invalid';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// Mirrors load_current_acceptance in scripts/commercial_readiness_gate.py.
// This classifies current eligibility; it never verifies historical signatures.
export function describeAcceptance(value: unknown, readState: AcceptanceReadState) {
  const payload = isRecord(value) ? value : null;
  const schema = typeof payload?.schema === 'string' ? payload.schema : '';
  let status: AcceptanceEligibility = 'pending_contract_review';
  if (readState !== 'missing' && (readState !== 'read' || !payload || typeof payload.schema !== 'string')) {
    status = 'invalid';
  } else if (readState === 'read') {
    if (['echo-founder.real-account-acceptance.v2', 'echo-founder.real-account-acceptance.v3'].includes(schema)) {
      status = 'legacy_read_only';
    } else if (['echo-founder.internal-release-acceptance.v1', 'echo-founder.internal-release-acceptance.v2'].includes(schema)) {
      status = 'internal_only';
    }
  }

  const issues: string[] = [];
  if (status === 'invalid') issues.push(readState === 'unreadable' ? '记录暂时无法读取' : '记录不是有效的验收对象');
  if (payload?.status !== undefined && typeof payload.status !== 'string') issues.push('记录状态格式有误');
  const evidence = Array.isArray(payload?.evidence) ? payload.evidence : [];
  if (payload?.evidence !== undefined && !Array.isArray(payload.evidence)) issues.push('证据列表格式有误');
  const kinds = new Set<string>();
  for (const item of evidence) {
    if (!isRecord(item) || typeof item.kind !== 'string' || !item.kind.trim() || typeof item.result !== 'string') {
      issues.push('证据条目格式有误');
      continue;
    }
    if (kinds.has(item.kind)) issues.push('证据类型重复');
    kinds.add(item.kind);
  }
  const attestation = isRecord(payload?.attestation) ? payload.attestation : null;
  if (payload?.attestation !== undefined && !attestation) issues.push('签名字段格式有误');
  if (attestation?.signature_base64 !== undefined && typeof attestation.signature_base64 !== 'string') issues.push('签名字段格式有误');

  return {
    eligibility: {
      status,
      reason: status === 'invalid' ? '验收记录无法读取或格式无效，当前资格未验证。' : CURRENT_ACCEPTANCE_REASON,
      contractStatus: 'pending_independent_review' as const,
      commercialReady: false as const,
    },
    record: {
      readState,
      exists: readState !== 'missing',
      schema,
      reportedStatus: typeof payload?.status === 'string' ? payload.status : '',
      reportedEvidenceCount: evidence.length,
      structureIssues: [...new Set(issues)],
      signaturePresent: typeof attestation?.signature_base64 === 'string' && Boolean(attestation.signature_base64.trim()),
      signatureVerification: 'not_performed' as const,
      pass: false as const,
    },
  };
}

export type CommercialAcceptanceStatus = ReturnType<typeof describeAcceptance> & {
  schema: 'echo-founder.commercial-acceptance-status.v2';
  productVersion: string;
  source: { available: boolean; currentSha: string; dirty: boolean | null; dirtyEntryCount: number | null };
  qaTrust: { registryPresent: boolean; keyCount: number; ready: boolean };
  frozenCandidate: { ready: boolean; exactArtifactsPresent: boolean; artifactVersionMatches: boolean; expectedArtifact: string };
  record: ReturnType<typeof describeAcceptance>['record'] & { source: 'active_workspace' | 'repository' };
};

export type CommercialServiceStatus = {
  tikomniConfigured: boolean;
  tikomniWeeklySnapshotComplete: boolean;
  tikomniSampleCount: number | null;
  errors: string[];
};
