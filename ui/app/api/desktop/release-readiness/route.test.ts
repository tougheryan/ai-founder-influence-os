import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_ROOT } from '@/lib/project-root';
import { GET } from './route';

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'echo-acceptance-status-'));
  vi.stubEnv('AIFIOS_REAL_ACCOUNT_ACCEPTANCE_WORKSPACE', workspace);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(workspace, { recursive: true, force: true }); });

const reportedPass = {
  status: 'pass', reviewer: { independent_from_implementation: true },
  attestation: { signature_base64: 'deliberately-invalid-signature' },
  evidence: [{ kind: 'platform-draft-fill', result: 'pass' }],
};

async function status() {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const result = (await response.json()).commercialAcceptance;
  expect(result.record.pass).toBe(false);
  expect(result.record.signatureVerification).toBe('not_performed');
  expect(result.eligibility.commercialReady).toBe(false);
  expect(result.eligibility.contractStatus).toBe('pending_independent_review');
  return result;
}

describe('desktop current commercial eligibility', () => {
  it('keeps missing records pending without inventing a current evidence checklist', async () => {
    const result = await status();
    expect(result.schema).toBe('echo-founder.commercial-acceptance-status.v2');
    expect(result.productVersion).toBe((await readFile(join(INSTALL_ROOT, 'VERSION'), 'utf-8')).trim());
    expect(result.source).not.toHaveProperty('entries');
    expect(result.record).toMatchObject({ source: 'active_workspace', exists: false, readState: 'missing', signaturePresent: false });
    expect(result.record).not.toHaveProperty('missingEvidence');
    expect(result.record).not.toHaveProperty('requiredEvidenceCount');
    expect(result.eligibility.status).toBe('pending_contract_review');
  });

  it.each([
    ['echo-founder.real-account-acceptance.v2', 'legacy_read_only'],
    ['echo-founder.real-account-acceptance.v3', 'legacy_read_only'],
    ['echo-founder.internal-release-acceptance.v1', 'internal_only'],
    ['echo-founder.internal-release-acceptance.v2', 'internal_only'],
    ['echo-founder.real-account-acceptance.v4', 'pending_contract_review'],
  ])('does not certify self-reported passes in %s', async (schema, expected) => {
    await writeFile(join(workspace, 'real-account-acceptance.json'), JSON.stringify({ ...reportedPass, schema }));
    const result = await status();
    expect(result.eligibility.status).toBe(expected);
    expect(result.record).toMatchObject({ schema, reportedStatus: 'pass', signaturePresent: true });
    expect(JSON.stringify(result)).not.toContain('deliberately-invalid-signature');
  });

  it.each(['{', '[]', 'null', '{}', '{"schema":1}', '', 'x'.repeat(2 * 1024 * 1024 + 1), '\ufeff{"schema":"x"}'])('keeps malformed or oversized records invalid (%#)', async raw => {
    await writeFile(join(workspace, 'real-account-acceptance.json'), raw);
    expect((await status()).eligibility.status).toBe('invalid');
  });

  it('rejects a non-file record and invalid UTF-8', async () => {
    const path = join(workspace, 'real-account-acceptance.json');
    await mkdir(path);
    expect((await status()).record.readState).toBe('invalid');
    await rm(path, { recursive: true });
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    expect((await status()).record.readState).toBe('invalid');
  });

  it('shows duplicate evidence as invalid structure, not completed production', async () => {
    await writeFile(join(workspace, 'real-account-acceptance.json'), JSON.stringify({ ...reportedPass,
      schema: 'echo-founder.real-account-acceptance.v3', evidence: [...reportedPass.evidence, ...reportedPass.evidence] }));
    const result = await status();
    expect(result.eligibility.status).toBe('legacy_read_only');
    expect(result.record.structureIssues).toContain('证据类型重复');
  });
});
