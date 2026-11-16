import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, PATCH, POST } from './route';

let temporaryRoot = '';

afterEach(async () => {
  delete process.env.AIFIOS_DESKTOP_USER_DATA_DIR;
  delete process.env.AIFIOS_INTERNAL_RELEASE_ACCEPTANCE;
  delete process.env.AIFIOS_IMAGE_ACCOUNT_IDS;
  delete process.env.AIFIOS_IMAGE_RUNTIME_ROUTE_CATALOG;
  for (const name of ['OPENROUTER_API_KEY', 'REPLICATE_API_TOKEN', 'ARK_API_KEY', 'DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'MINIMAX_API_KEY']) {
    delete process.env[name];
  }
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = '';
});

describe('GET /api/settings/image-providers', () => {
  it('returns only frozen route status and never credentials or operation payloads', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'echo-image-status-'));
    const directory = path.join(temporaryRoot, 'image-benchmarks');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'current.json'), JSON.stringify({
      schema_version: 'echo-founder.image-provider-benchmark.v1',
      benchmark_id: 'imgbench_20260826',
      status: 'scored',
      updated_at: '2026-08-26T10:00:00+08:00',
      secret: 'must-not-leak',
      selection: {
        primary: 'route-a',
        backup: 'route-b',
        ai_enhanced_default_eligible: true,
      },
      routes: [
        { route_id: 'route-a', provider: 'openrouter', model_id: 'openai/model', score: 91, rank: 1, api_key: 'must-not-leak' },
        { route_id: 'route-b', provider: 'ark', model_id: 'seedream/model', score: 82, rank: 2 },
      ],
    }), 'utf-8');
    process.env.AIFIOS_DESKTOP_USER_DATA_DIR = temporaryRoot;

    const response = await GET();
    const body = await response.json();

    expect(body.benchmark.primary).toBe('route-a');
    expect(body.benchmark.routes[0]).toEqual({
      routeId: 'route-a',
      provider: 'openrouter',
      modelId: 'openai/model',
      score: 91,
      rank: 1,
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(JSON.stringify(body)).not.toContain('api_key');
  });

  it('separates one-account runtime, cross-provider backup, internal benchmark and release-default readiness', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'echo-image-readiness-'));
    const directory = path.join(temporaryRoot, 'image-benchmarks');
    const acceptanceDirectory = path.join(temporaryRoot, 'acceptance');
    await mkdir(directory, { recursive: true });
    await mkdir(acceptanceDirectory, { recursive: true });
    await writeFile(path.join(directory, 'current.json'), JSON.stringify({
      schema_version: 'echo-founder.image-provider-benchmark.v1',
      benchmark_id: 'imgbench_ready',
      status: 'scored',
      selection: { primary: 'route-a', backup: 'route-b', ai_enhanced_default_eligible: true },
      routes: [
        { route_id: 'route-a', provider: 'openrouter', model_id: 'openai/image', score: 91, rank: 1 },
        { route_id: 'route-b', provider: 'ark', model_id: 'seedream/image', score: 84, rank: 2 },
      ],
    }));
    process.env.AIFIOS_DESKTOP_USER_DATA_DIR = temporaryRoot;
    process.env.OPENROUTER_API_KEY = 'not-returned';

    let response = await GET();
    let body = await response.json();
    expect(body.status).toMatchObject({
      accountCount: 1,
      runtimeImageReady: true,
      runtimeBackupReady: false,
      runtimeRouteReady: true,
      internalBenchmarkReady: true,
      aiDefaultEligible: false,
      releaseDefault: 'stable',
    });

    process.env.ARK_API_KEY = 'also-not-returned';
    response = await GET();
    body = await response.json();
    expect(body.status.runtimeBackupReady).toBe(true);

    await writeFile(path.join(acceptanceDirectory, 'internal-release-current.json'), JSON.stringify({
      schema: 'echo-founder.internal-release-acceptance.v1',
      status: 'pass',
      non_commercial: true,
      assertions: { ai_enhanced_default_verified: true },
    }));
    response = await GET();
    body = await response.json();
    expect(body.status).toMatchObject({ aiDefaultEligible: true, releaseDefault: 'ai_enhanced' });
    expect(JSON.stringify(body)).not.toContain('not-returned');
  });

  it('allows a configured Ark account to use the bundled runtime route without internal benchmark acceptance', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'echo-image-bundled-route-'));
    process.env.AIFIOS_DESKTOP_USER_DATA_DIR = temporaryRoot;
    process.env.ARK_API_KEY = 'not-returned';

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toMatchObject({
      accountCount: 1,
      activeAccountCount: 1,
      runtimeImageReady: true,
      runtimeRouteReady: true,
      runtimeRouteSource: 'bundled_catalog',
      internalBenchmarkReady: false,
      aiDefaultEligible: false,
      releaseDefault: 'stable',
    });
    expect(JSON.stringify(body)).not.toContain('not-returned');
  });

  it('persists at most three runtime roles and explicit budget confirmation without storing credentials', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'echo-image-policy-'));
    process.env.AIFIOS_DESKTOP_USER_DATA_DIR = temporaryRoot;
    process.env.ARK_API_KEY = 'ark-secret-never-written';
    process.env.DASHSCOPE_API_KEY = 'dash-secret-never-written';

    const response = await POST(new NextRequest('http://localhost/api/settings/image-providers', {
      method: 'POST',
      body: JSON.stringify({
        policy: {
          schema_version: 'echo-founder.image-account-policy.v1',
          preset: 'domestic_stability',
          primary_provider: 'image_ark',
          backup_provider: 'image_dashscope',
          advanced_provider: 'image_ark',
          budgets_cny: { per_call_limit: 4, per_task_limit: 16, monthly_reminder: 80 },
          first_paid_call_confirmed: false,
        },
      }),
      headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.policy).toMatchObject({
      preset: 'domestic_stability',
      primary_provider: 'image_ark',
      backup_provider: 'image_dashscope',
      advanced_provider: null,
      first_paid_call_confirmed: false,
    });
    const savedPath = path.join(temporaryRoot, 'image-account-policy.json');
    const serialized = await readFile(savedPath, 'utf-8');
    expect(serialized).not.toContain('ark-secret-never-written');
    expect((await stat(savedPath)).mode & 0o777).toBe(0o600);

    const confirmed = await PATCH(new NextRequest('http://localhost/api/settings/image-providers', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'confirm_first_paid_call' }),
      headers: { 'content-type': 'application/json' },
    }));
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).status.firstPaidCallConfirmed).toBe(true);
  });
});
