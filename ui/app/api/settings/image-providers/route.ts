import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { assertJsonInputSize, InputLimitError, MAX_AGENT_PAYLOAD_BYTES } from '@/lib/input-limits';
import {
  configuredImageCredentialIds,
  defaultImageAccountPolicy,
  effectiveImageAccountOrder,
  IMAGE_ACCOUNT_POLICY_SCHEMA,
  IMAGE_PROVIDER_ACCOUNTS,
  normalizeImageAccountPolicy,
  type ImageAccountPolicy,
  type ImageCredentialId,
} from '@/lib/image-account-policy';
import { INSTALL_ROOT, runtimeJoin } from '@/lib/project-root';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

const MAX_LOCAL_STATUS_BYTES = 2 * 1024 * 1024;

function userDataRoot() {
  const userData = String(process.env.AIFIOS_DESKTOP_USER_DATA_DIR || '').trim();
  if (!userData || !path.isAbsolute(userData)) return null;
  return path.resolve(userData);
}

function benchmarkPath(root: string) {
  return path.join(root, 'image-benchmarks', 'current.json');
}

function policyPath(root: string) {
  return path.join(root, 'image-account-policy.json');
}

function runtimeRouteCatalogPath() {
  const configured = String(process.env.AIFIOS_IMAGE_RUNTIME_ROUTE_CATALOG || '').trim();
  return configured && path.isAbsolute(configured)
    ? path.resolve(configured)
    : runtimeJoin(INSTALL_ROOT, 'skills', 'content-runtime', 'config', 'runtime-image-routes.json');
}

function acceptancePath(root: string) {
  const configured = String(process.env.AIFIOS_INTERNAL_RELEASE_ACCEPTANCE || '').trim();
  return configured && path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.join(root, 'acceptance', 'internal-release-current.json');
}

async function readSafeJson(file: string): Promise<Record<string, unknown> | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_LOCAL_STATUS_BYTES) {
    throw new Error('unsafe local image status file');
  }
  const value = JSON.parse(await fs.readFile(file, 'utf-8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid local image status file');
  return value as Record<string, unknown>;
}

async function readPolicy(root: string): Promise<ImageAccountPolicy> {
  const raw = await readSafeJson(policyPath(root));
  if (!raw) return defaultImageAccountPolicy();
  if (raw.schema_version !== IMAGE_ACCOUNT_POLICY_SCHEMA) throw new Error('unsupported image account policy schema');
  return normalizeImageAccountPolicy(raw);
}

async function writePolicy(root: string, value: ImageAccountPolicy): Promise<void> {
  const file = policyPath(root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const existing = await fs.lstat(file).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('unsafe image account policy target');
  const temporary = path.join(root, `.image-account-policy.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function publicBenchmark(raw: Record<string, unknown> | null) {
  if (!raw) return null;
  if (raw.schema_version !== 'echo-founder.image-provider-benchmark.v1') {
    throw new Error('unsupported image benchmark schema');
  }
  const selection = raw.selection && typeof raw.selection === 'object'
    ? raw.selection as Record<string, unknown>
    : {};
  const routes = Array.isArray(raw.routes) ? raw.routes : [];
  return {
    benchmarkId: String(raw.benchmark_id || ''),
    status: String(raw.status || 'blocked'),
    updatedAt: String(raw.updated_at || raw.created_at || ''),
    primary: typeof selection.primary === 'string' ? selection.primary : null,
    backup: typeof selection.backup === 'string' ? selection.backup : null,
    eligible: selection.ai_enhanced_default_eligible === true,
    routes: routes.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').map((item) => ({
      routeId: String(item.route_id || ''),
      provider: String(item.provider || ''),
      modelId: String(item.model_id || ''),
      score: typeof item.score === 'number' ? item.score : null,
      rank: typeof item.rank === 'number' ? item.rank : null,
    })),
  };
}

function internalAcceptanceVerified(raw: Record<string, unknown> | null): boolean {
  const assertions = raw?.assertions && typeof raw.assertions === 'object'
    ? raw.assertions as Record<string, unknown>
    : {};
  return raw?.schema === 'echo-founder.internal-release-acceptance.v1'
    && raw.status === 'pass'
    && raw.non_commercial === true
    && assertions.ai_enhanced_default_verified === true;
}

function runtimeCatalogProviders(raw: Record<string, unknown> | null): Set<string> {
  if (!raw) return new Set();
  if (raw.schema_version !== 'echo-founder.runtime-image-route-catalog.v1' || raw.status !== 'ready') {
    throw new Error('unsupported runtime image route catalog');
  }
  const routes = Array.isArray(raw.routes) ? raw.routes : [];
  return new Set(routes.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const route = item as Record<string, unknown>;
    return route.runtime_eligible === true
      && typeof route.provider === 'string' && route.provider
      && typeof route.model_id === 'string' && route.model_id
      && typeof route.estimated_cost_cny === 'number' && route.estimated_cost_cny > 0
      ? [route.provider]
      : [];
  }));
}

function statusPayload(
  policy: ImageAccountPolicy,
  benchmark: ReturnType<typeof publicBenchmark>,
  acceptanceVerified: boolean,
  bundledRouteProviders: Set<string>,
) {
  const configured = configuredImageCredentialIds();
  const active = effectiveImageAccountOrder(policy, configured).slice(0, 3);
  const providerByCredential = new Map<ImageCredentialId, string>(
    IMAGE_PROVIDER_ACCOUNTS.map((item) => [item.id, item.provider]),
  );
  const activeProviders = new Set(active.map((id) => providerByCredential.get(id)));
  const benchmarkRouteReady = Boolean(benchmark?.eligible && benchmark.routes.some((route) => (
    activeProviders.has(route.provider) && route.modelId && route.score !== null && route.score >= 75
  )));
  const bundledRouteReady = [...activeProviders].some((provider) => (
    typeof provider === 'string' && bundledRouteProviders.has(provider)
  ));
  const routeReady = benchmarkRouteReady || bundledRouteReady;
  const internalBenchmarkReady = benchmark?.eligible === true;
  return {
    accountCount: configured.length,
    activeAccountCount: active.length,
    activeProviders: active,
    runtimeImageReady: active.length >= 1,
    runtimeBackupReady: active.length >= 2,
    runtimeRouteReady: routeReady,
    runtimeRouteSource: benchmarkRouteReady ? 'internal_benchmark' : bundledRouteReady ? 'bundled_catalog' : null,
    internalBenchmarkReady,
    aiDefaultEligible: Boolean(internalBenchmarkReady && acceptanceVerified),
    firstPaidCallConfirmed: policy.first_paid_call_confirmed,
    releaseDefault: internalBenchmarkReady && acceptanceVerified ? 'ai_enhanced' : 'stable',
  };
}

async function payload() {
  const root = userDataRoot();
  const runtimeCatalog = await readSafeJson(runtimeRouteCatalogPath());
  const bundledRouteProviders = runtimeCatalogProviders(runtimeCatalog);
  if (!root) {
    const policy = defaultImageAccountPolicy();
    return { ok: true, policy, status: statusPayload(policy, null, false, bundledRouteProviders), benchmark: null };
  }
  const [policy, benchmarkRaw, acceptanceRaw] = await Promise.all([
    readPolicy(root),
    readSafeJson(benchmarkPath(root)),
    readSafeJson(acceptancePath(root)),
  ]);
  const benchmark = publicBenchmark(benchmarkRaw);
  return {
    ok: true,
    policy,
    status: statusPayload(policy, benchmark, internalAcceptanceVerified(acceptanceRaw), bundledRouteProviders),
    benchmark,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await payload());
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取生图账户状态。',
      code: 'image_provider_status_failed',
      status: 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const root = userDataRoot();
    if (!root) throw new InputLimitError('生图账户策略只能在 Echo Founder 桌面 App 中保存。');
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    assertJsonInputSize(body, '生图账户策略', MAX_AGENT_PAYLOAD_BYTES);
    const policy = normalizeImageAccountPolicy(body.policy);
    policy.updated_at = new Date().toISOString();
    await writePolicy(root, policy);
    return NextResponse.json(await payload());
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: error instanceof InputLimitError ? error.message : '暂时无法保存生图账户策略。',
      code: 'image_provider_policy_save_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const root = userDataRoot();
    if (!root) throw new InputLimitError('首次付费确认只能在 Echo Founder 桌面 App 中完成。');
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    assertJsonInputSize(body, '首次付费确认', MAX_AGENT_PAYLOAD_BYTES);
    if (body.action !== 'confirm_first_paid_call') throw new InputLimitError('不支持的生图账户操作。');
    const policy = await readPolicy(root);
    policy.first_paid_call_confirmed = true;
    policy.updated_at = new Date().toISOString();
    await writePolicy(root, policy);
    return NextResponse.json(await payload());
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: error instanceof InputLimitError ? error.message : '暂时无法保存首次付费确认。',
      code: 'image_provider_confirmation_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}
