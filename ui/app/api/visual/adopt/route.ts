import { createHash } from 'crypto';
import { lstat, readFile, readdir, rename, writeFile } from 'fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { PROJECT_DIR, redactLocalPaths, runtimeJoin, safeResolve } from '@/lib/project-root';
import { runsForPipelinePath } from '@/lib/runtime-run-resolver';
import { registerRuntimePhaseArtifact } from '@/lib/runtime-writer';
import { selectVisualAsset, validateVisualAssetManifest, type VisualAssetCandidate, type VisualAssetManifest } from '@/lib/visual-asset-manifest';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';

class SelectionConflictError extends Error {}

type RecipeAsset = {
  id?: string;
  role?: string;
  platform?: string;
  platform_bindings?: string[];
};

type Recipe = {
  revision_id?: string;
  slug?: string;
  source_package?: string;
  assets?: RecipeAsset[];
};

type IndexOutput = {
  id?: string;
  output?: string;
  sha256?: string;
  revision_id?: string;
  status?: string;
  quality?: string;
  width?: number;
  height?: number;
};

type Index = {
  schema?: string;
  revision_id?: string;
  slug?: string;
  status?: string;
  legacy?: boolean;
  aesthetic_status?: string;
  quality_summary?: {
    status?: string;
    errors?: unknown;
  };
  outputs?: IndexOutput[];
};

const SLUG_RE = /^[a-z0-9\u4e00-\u9fff-]{1,50}$/i;
const REVISION_RE = /^r\d{3,}$/;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function semanticRole(assetId: string): string {
  if (/^wechat-cover(?:-alt-\d+)?$/i.test(assetId)) return 'wechat_cover';
  if (/^wechat-share(?:-alt-\d+)?$/i.test(assetId)) return 'wechat_share';
  return assetId;
}

function platformBindings(platform: string | undefined, declared?: string[]): string[] {
  if (Array.isArray(declared) && declared.length) return [...new Set(declared)];
  if (platform === 'xhs') return ['xiaohongshu'];
  if (platform === 'moments') return ['moments'];
  if (platform === 'video') return ['shipinhao', 'douyin', 'xiaohongshu'];
  return ['wechat'];
}

function assertVisualSlug(value: unknown): string {
  const slug = assertTextInput(value, '视觉任务 Slug', MAX_SHORT_TEXT_BYTES).trim();
  if (!SLUG_RE.test(slug)) throw new InputLimitError('视觉任务 Slug 格式不正确。');
  return slug;
}

function assertRevision(value: unknown): string {
  const revisionId = assertTextInput(value, '视觉版本', MAX_SHORT_TEXT_BYTES).trim();
  if (!REVISION_RE.test(revisionId)) throw new InputLimitError('视觉版本格式不正确。');
  return revisionId;
}

function assertAssetId(value: unknown): string {
  const assetId = assertTextInput(value, '视觉资产 ID', MAX_SHORT_TEXT_BYTES).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(assetId)) throw new InputLimitError('视觉资产 ID 格式不正确。');
  return assetId;
}

function visualRoot(slug: string): string {
  const root = safeResolve(PROJECT_DIR, runtimeJoin('pipeline', 'visual', slug));
  if (!root) throw new InputLimitError('视觉任务路径不合法。');
  return root;
}

async function readJson<T>(relativePath: string): Promise<T | null> {
  const path = safeResolve(PROJECT_DIR, relativePath);
  if (!path) return null;
  try {
    const file = await lstat(path);
    if (file.isSymbolicLink() || !file.isFile()) return null;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function collectCandidates(slug: string): Promise<{
  candidates: VisualAssetCandidate[];
  sourceContentHash: string;
  sourcePackage: string;
  preferredRevision: string;
  rejectedCandidateReasons: Map<string, string>;
}> {
  const root = visualRoot(slug);
  const recipesDir = runtimeJoin(root, 'recipes');
  let recipeFiles: string[];
  try {
    recipeFiles = (await readdir(recipesDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && REVISION_RE.test(entry.name.replace('.visual-recipe.json', '')) && entry.name.endsWith('.visual-recipe.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new InputLimitError('尚未生成可采用的视觉资产。');
  }
  const preferredPointer = await readJson<{ revision_id?: string }>(runtimeJoin('pipeline', 'visual', slug, 'selected-revision.json'));
  const preferredRevision = typeof preferredPointer?.revision_id === 'string' && REVISION_RE.test(preferredPointer.revision_id)
    ? preferredPointer.revision_id
    : recipeFiles.at(-1)?.replace('.visual-recipe.json', '') || '';

  const candidates: VisualAssetCandidate[] = [];
  const rejectedCandidateReasons = new Map<string, string>();
  let sourcePackage = '';
  for (const recipeName of recipeFiles) {
    const revisionId = recipeName.replace('.visual-recipe.json', '');
    const recipePath = runtimeJoin('pipeline', 'visual', slug, 'recipes', recipeName);
    const indexPath = runtimeJoin('pipeline', 'visual', slug, 'revisions', `${revisionId}.index.json`);
    const [recipe, index] = await Promise.all([readJson<Recipe>(recipePath), readJson<Index>(indexPath)]);
    if (!recipe || !index || recipe.slug !== slug || recipe.revision_id !== revisionId || index.slug !== slug || index.revision_id !== revisionId) continue;
    if (!sourcePackage && typeof recipe.source_package === 'string') sourcePackage = recipe.source_package;
    const revisionAuditPassed = index.schema === 'aifios.visual-publish.v1'
      && index.status === 'generated'
      && index.legacy === false
      && index.quality_summary?.status === 'pass'
      && (!Array.isArray(index.quality_summary.errors) || index.quality_summary.errors.every((value) => !value))
      && (index.aesthetic_status === undefined || index.aesthetic_status === 'pass');
    const assets = new Map((recipe.assets || []).flatMap((asset) => typeof asset.id === 'string' ? [[asset.id, asset] as const] : []));
    for (const output of index.outputs || []) {
      const candidateKey = output.id ? `${revisionId}:${output.id}` : '';
      if (!output.id || !output.output || !output.sha256 || output.revision_id !== revisionId) continue;
      if (!revisionAuditPassed) {
        rejectedCandidateReasons.set(candidateKey, '该视觉版本未通过审核质量门，不能采用。');
        continue;
      }
      if (output.status !== 'generated' || (output.quality !== undefined && output.quality !== 'pass')) {
        rejectedCandidateReasons.set(candidateKey, '该视觉资产未通过审核质量门，不能采用。');
        continue;
      }
      const asset = assets.get(output.id);
      if (!asset) continue;
      const outputPath = safeResolve(PROJECT_DIR, output.output);
      if (!outputPath) continue;
      try {
        const file = await lstat(outputPath);
        if (file.isSymbolicLink() || !file.isFile()) continue;
        const bytes = await readFile(outputPath);
        if (!bytes.length || sha256(bytes) !== output.sha256) continue;
      } catch {
        continue;
      }
      candidates.push({
        assetId: output.id,
        semanticRole: semanticRole(output.id),
        revisionId,
        path: output.output,
        sha256: output.sha256,
        platformBindings: platformBindings(asset.platform, asset.platform_bindings),
        width: typeof output.width === 'number' ? output.width : undefined,
        height: typeof output.height === 'number' ? output.height : undefined,
      });
    }
  }
  if (!candidates.length || !sourcePackage) {
    throw new InputLimitError(rejectedCandidateReasons.size
      ? '没有通过审核质量门的可采用视觉资产。'
      : '视觉候选缺少可验证的源内容或已生成资产。');
  }
  const sourcePath = safeResolve(PROJECT_DIR, sourcePackage);
  if (!sourcePath) throw new InputLimitError('视觉候选的源内容路径不合法。');
  let sourceContentHash = '';
  try {
    const source = await lstat(sourcePath);
    if (source.isSymbolicLink() || !source.isFile()) throw new Error('invalid');
    sourceContentHash = sha256(await readFile(sourcePath));
  } catch {
    throw new InputLimitError('视觉候选的源内容不可读取。');
  }
  return { candidates, sourceContentHash, sourcePackage, preferredRevision, rejectedCandidateReasons };
}

function requiredRoles(candidates: VisualAssetCandidate[], preferredRevision: string): string[] {
  const preferred = candidates.filter((candidate) => candidate.revisionId === preferredRevision);
  const source = preferred.length ? preferred : candidates;
  return [...new Set(source
    .filter((candidate) => !/^wechat-(?:cover|share)-alt-\d+$/i.test(candidate.assetId))
    .filter((candidate) => !/^video-\d+-cover$/i.test(candidate.assetId))
    .map((candidate) => candidate.semanticRole))];
}

function normalizeRequiredRoles(
  manifest: VisualAssetManifest,
  candidates: VisualAssetCandidate[],
  preferredRevision: string,
): VisualAssetManifest {
  return {
    ...manifest,
    requiredRoles: requiredRoles(candidates, preferredRevision),
  };
}

async function readManifest(slug: string): Promise<VisualAssetManifest | null> {
  return readJson<VisualAssetManifest>(runtimeJoin('pipeline', 'visual', slug, 'selected-assets.json'));
}

async function writeManifest(slug: string, manifest: VisualAssetManifest): Promise<string> {
  const relativePath = runtimeJoin('pipeline', 'visual', slug, 'selected-assets.json');
  const target = safeResolve(PROJECT_DIR, relativePath);
  if (!target) throw new InputLimitError('视觉采用清单路径不合法。');
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(temporary, target);
  return relativePath;
}

function initialManifest(slug: string, sourceContentHash: string, candidates: VisualAssetCandidate[], preferredRevision: string): VisualAssetManifest {
  return {
    schema: 'aifios.visual-asset-manifest.v1',
    slug,
    sourceContentHash,
    requiredRoles: requiredRoles(candidates, preferredRevision),
    selections: {},
  };
}

async function registerVisualArtifact(manifestPath: string, sourcePackage: string): Promise<void> {
  const runs = await runsForPipelinePath(sourcePackage, 'package');
  const run = runs.find((item) => item.run_id && item.steps?.package?.latest === sourcePackage);
  if (!run?.run_id) return;
  await registerRuntimePhaseArtifact('visual_assets', manifestPath, run.run_id);
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const slug = assertVisualSlug(req.nextUrl.searchParams.get('slug') || '');
    const state = await collectCandidates(slug);
    const manifest = normalizeRequiredRoles(
      await readManifest(slug) || initialManifest(slug, state.sourceContentHash, state.candidates, state.preferredRevision),
      state.candidates,
      state.preferredRevision,
    );
    return NextResponse.json(redactLocalPaths({
      manifest,
      candidates: state.candidates,
      ready: validateVisualAssetManifest(manifest),
    }));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取图片候选，请重试。',
      code: 'visual_candidates_read_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as Record<string, unknown>;
    assertJsonInputSize(body, '视觉采用参数', MAX_AGENT_PAYLOAD_BYTES);
    const slug = assertVisualSlug(body.slug);
    const revisionId = assertRevision(body.revisionId);
    // A batch adoption loop lets the operator confirm every passing asset in
    // one action instead of clicking each card individually.
    const assetIds = Array.isArray(body.assetIds)
      ? (body.assetIds as unknown[]).map((id) => assertAssetId(id))
      : [assertAssetId(body.assetId)];
    const result = await withProjectWriteLock(`visual-asset-adopt:${slug}`, async () => {
      const state = await collectCandidates(slug);
      const current = await readManifest(slug);
      if (body.reconfirmSelection !== undefined) {
        const expected = body.reconfirmSelection as { selectionSha256?: unknown; sourceContentHash?: unknown } | null;
        if (!expected || typeof expected !== 'object' || Array.isArray(expected)
          || typeof expected.selectionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.selectionSha256)
          || typeof expected.sourceContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sourceContentHash)) {
          throw new InputLimitError('请重新读取这套图文后再核对。');
        }
        const selectionPath = safeResolve(PROJECT_DIR, runtimeJoin('pipeline', 'visual', slug, 'selected-assets.json'))!;
        const selectionBytes = current ? await readFile(selectionPath) : null;
        const runs = await runsForPipelinePath(state.sourcePackage, 'package');
        if (!selectionBytes || sha256(selectionBytes) !== expected.selectionSha256
          || current?.sourceContentHash !== expected.sourceContentHash
          || state.sourceContentHash !== expected.sourceContentHash
          || !runs.some((run) => run.run_id && run.status !== 'archived' && run.steps?.package?.latest === state.sourcePackage)) {
          throw new SelectionConflictError('原稿或图文选择已变化，请重新读取并核对；旧确认不会沿用。');
        }
        const selectedAssets = Object.values(current.selections);
        if (!validateVisualAssetManifest(current).valid || !selectedAssets.length
          || selectedAssets.some((asset) => !state.candidates.some((candidate) => candidate.assetId === asset.assetId
            && candidate.revisionId === asset.revisionId && candidate.path === asset.path && candidate.sha256 === asset.sha256))
          || assetIds.some((assetId) => !selectedAssets.some((asset) => asset.assetId === assetId && asset.revisionId === revisionId))) {
          throw new SelectionConflictError('所选图文已有变更或未通过检查，请核对并重新制作。');
        }
      }
      let manifest = current && current.schema === 'aifios.visual-asset-manifest.v1'
        && current.slug === slug && current.sourceContentHash === state.sourceContentHash
        ? current
        : initialManifest(slug, state.sourceContentHash, state.candidates, state.preferredRevision);
      manifest = normalizeRequiredRoles(manifest, state.candidates, state.preferredRevision);
      for (const assetId of assetIds) {
        const candidate = state.candidates.find((item) => item.revisionId === revisionId && item.assetId === assetId);
        if (!candidate) {
          throw new InputLimitError(
            state.rejectedCandidateReasons.get(`${revisionId}:${assetId}`)
            || '该视觉候选不存在、已变更或未通过完整性校验。',
          );
        }
        manifest = selectVisualAsset(manifest, candidate);
      }
      const manifestPath = await writeManifest(slug, manifest);
      await registerVisualArtifact(manifestPath, state.sourcePackage);
      return { manifest, manifestPath };
    });
    return NextResponse.json(redactLocalPaths({
      ok: true,
      ...result,
      ready: validateVisualAssetManifest(result.manifest),
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : error instanceof WriteLockError || error instanceof SelectionConflictError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法使用所选图片，请重试。',
      code: 'visual_adoption_failed',
      status,
    });
  }
}
