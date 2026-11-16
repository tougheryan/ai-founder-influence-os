import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: { analysis: { recommendedTypeId: 'business-growth', recommendedStructureId: 'customer-question-method' }, input: {} } as Record<string, unknown> | null,
  stale: false,
  unreadable: false,
  invalid: false,
  writes: vi.fn(),
  StaleError: class extends Error {},
  ReadinessError: class extends Error {},
  ValidationError: class extends Error { validation = { valid: false, quality_errors: ['internal validation detail'] }; },
}));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/material-analysis', () => ({
  MaterialAnalysisInputError: class extends Error {},
  MaterialAnalysisStaleError: mocks.StaleError,
  MaterialReadinessError: mocks.ReadinessError,
  getMaterialAnalysisContext: async () => mocks.context,
  assertMaterialAnalysisCurrent: () => { if (mocks.stale) throw new mocks.StaleError('internal stale detail'); },
  assertMaterialReadyForResearch: async () => { if (mocks.unreadable) throw new mocks.ReadinessError('/Users/private/customer.pdf'); },
}));
vi.mock('@/lib/material-direction', () => ({ materialDirectionFor: () => ({}) }));
vi.mock('@/lib/material-intake-report', () => ({ buildMaterialIntakeReport: () => 'source-backed report' }));
vi.mock('@/lib/product-voice', () => ({ inspectGeneratedLanguage: () => ({ blocking: [], warnings: [] }) }));
vi.mock('@/lib/runtime-run-resolver', () => ({ listRuntimeRuns: async () => [{ run_id: 'run-a', slug: 'run-a', status: 'active' }] }));
vi.mock('@/lib/runtime-writer', () => ({
  RuntimeOutputValidationError: mocks.ValidationError,
  writeValidatedRuntimeOutput: async (...args: unknown[]) => {
    mocks.writes(...args);
    if (mocks.invalid) throw new mocks.ValidationError();
    return { path: 'pipeline/intake/new.md', validation: { valid: true, result: { valid: true } } };
  },
}));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class extends Error {},
  withProjectWriteLock: async (_key: string, action: () => Promise<unknown>) => action(),
}));

import { POST } from './route';

function request() {
  return new NextRequest('http://localhost/api/production/intake', { method: 'POST', body: JSON.stringify({ runId: 'run-a' }) });
}

describe('material intake save and failure contract', () => {
  beforeEach(() => {
    mocks.context = { analysis: { recommendedTypeId: 'business-growth', recommendedStructureId: 'customer-question-method' }, input: {} };
    mocks.stale = false;
    mocks.unreadable = false;
    mocks.invalid = false;
    mocks.writes.mockClear();
  });

  it('only returns an artifact committed after validation', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: 'pipeline/intake/new.md', validation: { valid: true } });
    expect(mocks.writes).toHaveBeenCalledWith('intake', 'run-a', 'source-backed report', 'production-material-analysis', 'run-a');
  });

  it.each(['missing', 'stale', 'unreadable'] as const)('explains %s material without writing an intake', async (kind) => {
    if (kind === 'missing') mocks.context = null;
    if (kind === 'stale') mocks.stale = true;
    if (kind === 'unreadable') mocks.unreadable = true;
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.code).toBe({ missing: 'material_analysis_missing', stale: 'material_analysis_stale', unreadable: 'material_source_unreadable' }[kind]);
    expect(body.error).toMatch(/请/);
    expect(body.error).not.toMatch(/\/Users|internal|customer.pdf/);
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it('identifies a system-generated invalid report without telling the author to invent material', async () => {
    mocks.invalid = true;
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.code).toBe('material_report_invalid');
    expect(body.error).toContain('原素材和上次结果已保留');
    expect(body.error).toContain('没有调用模型或平台数据服务');
    expect(body.error).toContain('联系支持');
    expect(JSON.stringify(body)).not.toContain('internal validation detail');
  });
});
