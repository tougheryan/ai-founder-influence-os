import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { INSTALL_ROOT } from './project-root';
import { describeAcceptance } from './commercial-acceptance-status';

describe('settings and formal CLI current eligibility', () => {
  it('agrees with the actual Python release policy, including future schema names', () => {
    const cases = [null, [], {}, { schema: 3 },
      ...['echo-founder.real-account-acceptance.v2', 'echo-founder.real-account-acceptance.v3',
        'echo-founder.internal-release-acceptance.v1', 'echo-founder.internal-release-acceptance.v2',
        'echo-founder.real-account-acceptance.v4', 'unreviewed'].map(schema => ({ schema, status: 'pass',
          evidence: [{ kind: 'platform-draft-fill', result: 'pass' }, { kind: 'platform-draft-fill', result: 'pass' }],
          attestation: { signature_base64: 'invalid-self-report' } })),
    ];
    const python = `
import json,sys,tempfile
from pathlib import Path
sys.path.insert(0, str(Path.cwd()/'scripts'))
from commercial_readiness_gate import load_current_acceptance
with tempfile.TemporaryDirectory() as folder:
 p=Path(folder)/'record.json'
 results=[]
 for value in json.load(sys.stdin):
  p.write_text(json.dumps(value))
  results.append(load_current_acceptance(None if value is None else p))
 print(json.dumps(results))
`;
    const results = JSON.parse(execFileSync('python3', ['-c', python], { cwd: INSTALL_ROOT, input: JSON.stringify(cases), encoding: 'utf-8', timeout: 10000 }));
    cases.forEach((value, i) => {
      const result = describeAcceptance(value, value === null ? 'missing' : 'read');
      expect(result.eligibility.status).toBe(results[i].status);
      expect(result.eligibility.commercialReady).toBe(results[i].commercial_ready);
      expect(result.record.pass).toBe(false);
    });
  });
});
