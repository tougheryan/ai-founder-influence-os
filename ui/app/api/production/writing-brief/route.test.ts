import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ run: {} as Record<string, unknown>, verify: vi.fn() }));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/runtime-run-resolver', () => ({ runtimeRunById: async () => fixture.run }));
vi.mock('@/lib/runtime-writer', () => ({ validateRuntimeOutput: async () => ({ valid: true, result: { platform_scope: { scope_status: 'matched', scope_matches: true, issues: [] } } }), verifyRuntimeAuthorSource: fixture.verify, writeRuntimeOutput: vi.fn() }));
vi.mock('@/lib/output-files', () => ({ readOutputFile: async () => '# 写作方案\n自己的素材' }));
vi.mock('@/lib/material-analysis', () => ({ getMaterialAnalysisContext: async () => null, assertMaterialAnalysisCurrent: vi.fn() }));

import { GET } from './route';

beforeEach(() => {
  fixture.run = { run_id: 'own-run', slug: 'own', status: 'active', research_mode: 'author_material', steps: { blueprint: { latest: 'pipeline/blueprint/own.md' } } };
  fixture.verify.mockReset().mockResolvedValue({ verified: true });
});
const request = () => new NextRequest('http://localhost/api/production/writing-brief?runId=own-run');

it('labels the author review using server mode only after verifying the current bound plan', async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ researchMode: 'author_material', path: 'pipeline/blueprint/own.md' });
  expect(fixture.verify).toHaveBeenCalledWith('own-run', 'pipeline/blueprint/own.md');
});

it('does not present an old plan as belonging to a newly selected author source', async () => {
  fixture.verify.mockRejectedValueOnce(new Error('old source'));
  const response = await GET(request());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('现有方案还没有对应当前素材与题目') });
});

it('preserves the platform-research review for existing runs', async () => {
  delete fixture.run.research_mode;
  const response = await GET(request());
  expect(await response.json()).toMatchObject({ researchMode: 'platform' });
  expect(fixture.verify).not.toHaveBeenCalled();
});
