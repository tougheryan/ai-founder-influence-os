import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { describeAcceptance, type CommercialAcceptanceStatus } from '@/lib/commercial-acceptance-status';
import { CommercialAcceptancePanel } from './CommercialAcceptancePanel';

function acceptance(schema = 'echo-founder.real-account-acceptance.v3'): CommercialAcceptanceStatus {
  const described = describeAcceptance({ schema, status: 'pass', attestation: { signature_base64: 'invalid-signature' }, evidence: [] }, 'read');
  return { ...described, schema: 'echo-founder.commercial-acceptance-status.v2', productVersion: 'test',
    source: { available: true, currentSha: 'abc', dirty: false, dirtyEntryCount: 0 },
    qaTrust: { registryPresent: true, keyCount: 1, ready: true },
    frozenCandidate: { ready: true, exactArtifactsPresent: true, artifactVersionMatches: true, expectedArtifact: 'test.dmg' },
    record: { ...described.record, source: 'active_workspace' } };
}
const props = { services: null, loading: false, onRefresh: () => {} };

describe('commercial acceptance display', () => {
  it.each(['echo-founder.real-account-acceptance.v3', 'echo-founder.internal-release-acceptance.v2', 'unreviewed-schema'])('never promotes %s into current production or signature approval', schema => {
    const html = renderToStaticMarkup(<CommercialAcceptancePanel {...props} readiness={{ status: 'external_ready', checkedAt: '', commercialAcceptance: acceptance(schema) }} />);
    expect(html).toContain('尚未完成正式验收');
    expect(html).toContain('原始自报状态：pass');
    expect(html).toContain('本页未验签');
    expect(html).toContain('data-gate="production" data-state="pending"');
    expect(html).toContain('data-gate="attestation" data-state="pending"');
    expect(html).not.toMatch(/签署 v3|通过签名验证|付费生图|45 条人工标注|九条草稿/);
  });

  it.each(['missing', 'loading', 'failed', 'old-server'])('keeps all gates unverified for %s', mode => {
    const data = acceptance();
    if (mode === 'old-server') Object.assign(data, { schema: 'echo-founder.commercial-acceptance-status.v1', record: { pass: true, missingEvidence: [] } });
    const html = renderToStaticMarkup(<CommercialAcceptancePanel {...props} loading={mode === 'loading'} readiness={mode === 'missing' ? null : { status: mode === 'failed' ? 'fail' : 'needs_attention', checkedAt: '', commercialAcceptance: data }} />);
    expect(html).not.toContain('data-state="pass"');
    expect(html).toContain('0/6');
    expect(html).toContain('尚未完成正式验收');
  });
});
