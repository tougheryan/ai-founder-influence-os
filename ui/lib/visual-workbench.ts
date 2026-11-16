import 'server-only';
import { createHash } from 'crypto';
import { lstat, readdir, readFile, realpath } from 'fs/promises';
import { isAbsolute, relative as relativePath } from 'path';
import { PROJECT_DIR, runtimeJoin, safeResolve } from './project-root';
import { verifyWechatLayout } from './wechat-layout-fidelity';
import { parseWechatLayout } from './visual-revision-request';

export type VisualWorkbenchRevisionStatus = 'ready' | 'review_required' | 'rendering' | 'blocked';

export type VisualWorkbenchAsset = {
  revisionId: string;
  id: string;
  platform: 'wechat' | 'xhs' | 'moments' | 'video';
  path: string;
  role: string;
  title?: string;
  status: string;
  quality: string;
  width?: number;
  height?: number;
  sha256?: string;
  nativeCopyVerified?: boolean;
  reviewRequired?: boolean;
  reason?: string;
  provider?: string;
  imageBackend?: string;
  wechatLayout?: {
    requestedTheme: string;
    renderedTheme?: string;
    usedFallback: boolean;
    candidates: string[];
    locallyRefined?: true;
    refinementProfile?: 'title-spacing-v1';
  };
};

export type VisualWorkbenchAdoptedAsset = {
  semanticRole: string;
  id: string;
  revisionId: string;
  path: string;
  sha256: string;
  platformBindings: string[];
};

export type VisualWorkbenchComparisonRole = 'cover' | 'evidence' | 'cta';
export type VisualWorkbenchComparisonLabel = 'previous' | 'current' | 'candidate';

export type VisualWorkbenchState = {
  slug: string;
  selectedRevisionId: string;
  hasExplicitSelection: boolean;
  hasExplicitAssetSelection?: boolean;
  hasCompleteAssetSelection?: boolean;
  selectedAssetKeys?: string[];
  adoptedAssetManifest?: {
    selectionSha256?: string;
    sourceContentHash: string;
    requiredRoles: string[];
    assets: VisualWorkbenchAdoptedAsset[];
  };
  revisions: Array<{
    revisionId: string;
    parentRevisionId?: string;
    recipePath: string;
    indexPath?: string;
    status: VisualWorkbenchRevisionStatus;
    reason?: string;
    issues?: string[];
  }>; 
  assets: VisualWorkbenchAsset[];
  assetCandidates?: VisualWorkbenchAsset[];
  reviewAssets: VisualWorkbenchAsset[];
  comparison: Array<{
    role: VisualWorkbenchComparisonRole;
    leftLabel: VisualWorkbenchComparisonLabel;
    leftRevisionId: string;
    left?: VisualWorkbenchAsset;
    rightLabel: VisualWorkbenchComparisonLabel;
    rightRevisionId: string;
    right?: VisualWorkbenchAsset;
  }>;
  visualPreferences?: {
    mode: 'ai_enhanced' | 'stable';
    directionCount: 2;
    providerPolicy: 'auto';
  };
  artDirections?: Array<{
    id: string;
    label: string;
    styleTokens: string[];
    palette: string[];
    composition: string;
    selected: boolean;
  }>;
  effectiveVisualMode?: 'ai_enhanced' | 'stable';
  fallbackNotes?: string[];
  providers?: string[];
};

type RecipeAsset = {
  id?: string;
  platform?: string;
  role?: string;
  copy?: {
    headline?: string;
  };
};

type VisualRecipe = {
  schema?: string;
  revision_id?: string;
  parent_revision_id?: string;
  slug?: string;
  content_archetype?: string;
  evidence_mode?: string;
  visual_preferences?: { mode?: string; direction_count?: number; provider_policy?: string };
  art_directions?: Array<{ id?: string; label?: string; style_tokens?: string[]; palette?: Record<string, string>; composition?: string }>;
  selected_direction?: string;
  assets?: RecipeAsset[];
  platforms?: { wechat?: { layout_selection?: { selected?: string; candidates?: unknown[] }; wechat_layout?: unknown } };
};

type VisualIndex = {
  schema?: string;
  slug?: string;
  revision_id?: string;
  recipe_path?: string;
  status?: string;
  legacy?: boolean;
  revision_index_path?: string;
  platform_delivery_manifest?: string;
  quality_summary?: { status?: string; errors?: string[] };
  aesthetic_status?: string;
  effective_visual_mode?: string;
  visual_fallback_notes?: string[];
  outputs?: Array<{
    id?: string;
    kind?: string;
    renderer?: string;
    recipe_path?: string;
    output?: string;
    revision_id?: string;
    role?: string;
    status?: string;
    quality?: string;
    reason?: string;
    quality_reason?: string;
    sha256?: string;
    size?: number;
    width?: number;
    height?: number;
    ai_generated?: boolean;
    ocr_status?: string;
    provider?: string;
    image_backend?: string;
    layout_style?: string;
    renderer_theme?: string;
    layout_fallback_reason?: string;
    base_renderer?: string;
    base_theme?: string;
    local_refinements?: unknown;
    raw_html_sha256?: string;
    output_is_raw_api_result?: boolean;
    copy_fidelity?: { status?: string };
  }>;
};

type PlatformDeliveryManifest = {
  schema?: string;
  slug?: string;
  revision_id?: string;
};

type VisualSelection = {
  schema?: string;
  slug?: string;
  revision_id?: string;
  integrity?: {
    algorithm?: string;
    files?: Array<{
      role?: string;
      id?: string;
      path?: string;
      size?: number;
      sha256?: string;
    }>;
  };
};

type VisualAssetSelection = {
  schema?: string;
  slug?: string;
  sourceContentHash?: string;
  requiredRoles?: string[];
  selections?: Record<string, {
    assetId?: string;
    revisionId?: string;
    sha256?: string;
    path?: string;
    semanticRole?: string;
    platformBindings?: string[];
  }>;
};

type SelectionIntegrityFile = NonNullable<
  NonNullable<VisualSelection['integrity']>['files']
>[number];

export type VisualRevisionArtifactValidation = {
  valid: boolean;
  reason?: string;
  recipePath: string;
  indexPath: string;
};

type VisualRevisionInspection = VisualRevisionArtifactValidation & {
  reviewable?: boolean;
  previewable?: boolean;
  recipe?: VisualRecipe;
  index?: VisualIndex;
};

function normalizeSlug(value: string): string | null {
  const slug = value.trim();
  return /^[a-z0-9\u4e00-\u9fff-]{1,50}$/i.test(slug) ? slug : null;
}

function isRevisionId(value: string): boolean {
  return /^r\d{3,}$/.test(value);
}

function revisionNumber(value: string): number {
  return Number(value.slice(1)) || 0;
}

function toProjectPath(relativePath: string): string | null {
  return safeResolve(PROJECT_DIR, relativePath);
}

function isInsideProject(projectRealPath: string, candidateRealPath: string): boolean {
  const relative = relativePath(projectRealPath, candidateRealPath);
  return relative === '' || (!relative.startsWith('..') && !isAbsolute(relative));
}

async function readVerifiedProjectBytes(relativePathValue: string): Promise<Buffer | null> {
  const absolute = toProjectPath(relativePathValue);
  if (!absolute) return null;
  try {
    const [projectRealPath, fileRealPath, fileInfo] = await Promise.all([
      realpath(PROJECT_DIR),
      realpath(absolute),
      lstat(absolute),
    ]);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || !isInsideProject(projectRealPath, fileRealPath)) {
      return null;
    }
    return await readFile(absolute);
  } catch {
    return null;
  }
}

function isVisualPathForSlug(path: unknown, slug: string): path is string {
  if (typeof path !== 'string' || path.includes('\\')) return false;
  const root = `pipeline/visual/${slug}/`;
  const segments = path.split('/');
  return path.startsWith(root) && !segments.some((segment) => !segment || segment === '.' || segment === '..');
}

function isVisualOutputPathForRevision(path: unknown, slug: string, revisionId: string): path is string {
  if (typeof path !== 'string' || path.includes('\\')) return false;
  const root = `pipeline/visual/${slug}/publish/${revisionId}/`;
  const segments = path.split('/');
  return path.startsWith(root) && !segments.some((segment) => !segment || segment === '.' || segment === '..');
}

async function readProjectJson<T>(relativePath: string): Promise<T | null> {
  const bytes = await readVerifiedProjectBytes(relativePath);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString('utf-8')) as T;
  } catch {
    return null;
  }
}

async function projectEntryExists(relativePathValue: string): Promise<boolean> {
  const absolute = toProjectPath(relativePathValue);
  if (!absolute) return false;
  try {
    await lstat(absolute);
    return true;
  } catch {
    return false;
  }
}

async function listProjectFiles(relativePath: string): Promise<string[]> {
  const path = toProjectPath(relativePath);
  if (!path) return [];
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function inspectVisualRevision(slug: string, revisionId: string): Promise<VisualRevisionInspection> {
  const recipePath = runtimeJoin('pipeline', 'visual', slug, 'recipes', `${revisionId}.visual-recipe.json`);
  const indexPath = runtimeJoin('pipeline', 'visual', slug, 'revisions', `${revisionId}.index.json`);
  const [recipe, index] = await Promise.all([
    readProjectJson<VisualRecipe>(recipePath),
    readProjectJson<VisualIndex>(indexPath),
  ]);
  const invalid = (reason: string): VisualRevisionInspection => ({
    valid: false,
    reason,
    recipePath,
    indexPath,
    recipe: recipe || undefined,
    index: index || undefined,
  });

  if (!recipe || recipe.slug !== slug || recipe.revision_id !== revisionId) {
    return invalid('该版本的最终配方不存在、无法读取或与版本不一致。');
  }
  if (!index) return invalid('该版本的发布索引不存在或无法读取。');
  if (index.schema !== 'aifios.visual-publish.v1') return invalid('发布索引 schema 不受支持。');
  if (index.slug !== slug || index.revision_id !== revisionId) {
    return invalid('发布索引与目标 Slug 或版本不一致。');
  }
  if (index.legacy !== false) return invalid('旧版视觉输出没有配方，不能作为默认发布版本。');
  if (index.status !== 'generated') return invalid('该版本没有成功生成发布资产。');
  if (!index.quality_summary?.status) {
    return invalid('该版本缺少 quality_summary.status=pass，不能采用。');
  }
  if (index.recipe_path !== recipePath) {
    return invalid('发布索引的配方来源不是该版本的最终配方。');
  }
  if (index.revision_index_path !== indexPath) {
    return invalid('发布索引没有绑定当前 canonical revision index。');
  }
  if (!Array.isArray(index.outputs) || index.outputs.length === 0) {
    return invalid('发布索引没有可采用的输出资产。');
  }
  const recipeAssetIds = (recipe.assets || []).map((asset) => String(asset.id || ''));
  const outputIds = index.outputs.map((output) => String(output.id || ''));
  const outputPaths = index.outputs.map((output) => String(output.output || ''));
  if (
    recipeAssetIds.length === 0
    || recipeAssetIds.some((id) => !id)
    || new Set(recipeAssetIds).size !== recipeAssetIds.length
    || outputIds.some((id) => !id)
    || new Set(outputIds).size !== outputIds.length
    || outputIds.length !== recipeAssetIds.length
    || outputIds.some((id) => !recipeAssetIds.includes(id))
    || outputPaths.some((path) => !path)
    || new Set(outputPaths).size !== outputPaths.length
  ) {
    return invalid('发布索引缺少配方资产输出，或输出 ID/路径不唯一。');
  }

  for (const output of index.outputs) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      return invalid('发布索引包含无效的输出记录。');
    }
    if (output.renderer !== 'local') return invalid('发布资产不是由本地 renderer 生成。');
    if (output.revision_id !== revisionId || output.status !== 'generated') {
      return invalid('发布资产没有绑定目标 revision 或生成状态。');
    }
    if (output.recipe_path !== recipePath) return invalid('发布资产的配方来源不是该版本的最终配方。');
    if (!isVisualOutputPathForRevision(output.output, slug, revisionId)) {
      return invalid('发布资产路径不属于该 Slug 与版本。');
    }
    const bytes = await readVerifiedProjectBytes(String(output.output));
    if (!bytes || bytes.length <= 0) return invalid(`发布资产不存在、为空或为符号链接：${output.output}`);
    if (
      !Number.isInteger(output.size)
      || Number(output.size) !== bytes.length
      || typeof output.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(output.sha256)
      || createHash('sha256').update(bytes).digest('hex') !== output.sha256
    ) {
      return invalid(`发布资产摘要与当前文件不一致：${output.output}`);
    }
  }

  if (index.outputs.some((output) => output.kind === 'wechat_html' || output.id === 'wechat-html')) {
    if (!await verifyWechatLayout(slug, revisionId)) {
      return { ...invalid('公众号全文、标点或引用未通过当前文件核对，请重新排版。'), previewable: true };
    }
  }

  // visual_publish.py creates this companion manifest for platform-ready delivery.
  // Keep its eligibility and selection contract in lockstep with /api/visual/select.
  if (index.platform_delivery_manifest !== undefined) {
    if (!isVisualOutputPathForRevision(index.platform_delivery_manifest, slug, revisionId)) {
      return invalid('平台视觉交付清单不属于该 Slug 与版本。');
    }
    const platformDelivery = await readProjectJson<PlatformDeliveryManifest>(index.platform_delivery_manifest);
    if (!platformDelivery) return invalid('平台视觉交付清单不存在、无法读取或不是有效 JSON。');
    if (
      !['aifios.platform-visual-delivery.v1', 'echo-founder.platform-visual-delivery.v2'].includes(String(platformDelivery.schema || ''))
      || platformDelivery.slug !== slug
      || platformDelivery.revision_id !== revisionId
    ) {
      return invalid('平台视觉交付清单与目标 Slug 或版本不一致。');
    }
  }

  const qualityStatus = index.quality_summary?.status;
  if (qualityStatus === 'pass') {
    const persistedQualityReason = qualityReason(index);
    if (persistedQualityReason) return invalid(persistedQualityReason);
    return { valid: true, recipePath, indexPath, recipe, index };
  }
  const reviewErrors = index.quality_summary?.errors || [];
  const reviewable = qualityStatus === 'review_required'
    && reviewErrors.length === 0
    && index.aesthetic_status === 'review_required'
    && (
      (recipe.content_archetype === 'concept' && recipe.evidence_mode === 'illustration_allowed')
      || recipe.schema === 'aifios.visual-recipe.v2'
    )
    && index.outputs.some((output) => output.ai_generated && output.ocr_status === 'review_required');
  if (reviewable) {
    return {
      valid: false,
      reviewable: true,
      reason: '概念插画等待摘要绑定的人工复核，复核前不能采用。',
      recipePath,
      indexPath,
      recipe,
      index,
    };
  }
  // All files and bindings were verified above. A quality rejection should
  // retain read-only previews so the author can see what needs correcting.
  return { ...invalid(qualityReason(index) || '该版本没有通过视觉质量门，不能采用。'), previewable: true };

}

/** Re-read and validate every persisted artifact required to adopt a revision. */
export async function validateVisualRevisionArtifacts(
  rawSlug: string,
  rawRevisionId: string,
): Promise<VisualRevisionArtifactValidation> {
  const slug = normalizeSlug(rawSlug);
  if (!slug || !isRevisionId(rawRevisionId)) {
    return {
      valid: false,
      reason: 'Slug 或版本 ID 格式不正确。',
      recipePath: '',
      indexPath: '',
    };
  }
  const inspection = await inspectVisualRevision(slug, rawRevisionId);
  return {
    valid: inspection.valid,
    reason: inspection.reason,
    recipePath: inspection.recipePath,
    indexPath: inspection.indexPath,
  };
}

async function verifiedSelectedRevisionId(
  selection: VisualSelection | null,
  slug: string,
  inspections: Map<string, VisualRevisionInspection>,
): Promise<string> {
  const revisionId = String(selection?.revision_id || '');
  if (
    selection?.schema !== 'aifios.visual-selection.v1'
    || selection.slug !== slug
    || !isRevisionId(revisionId)
    || selection.integrity?.algorithm !== 'sha256'
    || !Array.isArray(selection.integrity.files)
  ) return '';
  const inspection = inspections.get(revisionId);
  if (!inspection?.valid || !inspection.index) return '';
  const outputs = inspection.index.outputs || [];
  const expected = [
    { role: 'recipe', path: inspection.recipePath, id: undefined, size: undefined, sha256: undefined },
    { role: 'index', path: inspection.indexPath, id: undefined, size: undefined, sha256: undefined },
    ...outputs.map((output) => ({
      role: 'output',
      path: String(output.output || ''),
      id: output.id,
      size: output.size,
      sha256: output.sha256,
    })),
    ...(inspection.index.platform_delivery_manifest !== undefined ? [{
      role: 'platform_delivery',
      path: inspection.index.platform_delivery_manifest,
      id: undefined,
      size: undefined,
      sha256: undefined,
    }] : []),
  ];
  const files = selection.integrity.files;
  if (files.length !== expected.length) return '';
  const records = new Map<string, SelectionIntegrityFile>();
  for (const file of files) {
    if (!file || typeof file.role !== 'string' || typeof file.path !== 'string') return '';
    const key = `${file.role}\0${file.path}`;
    if (records.has(key)) return '';
    records.set(key, file);
  }
  const checks = await Promise.all(expected.map(async (item) => {
    if (!item.path) return false;
    const record = records.get(`${item.role}\0${item.path}`);
    if (
      !record
      || record.id !== item.id
      || !Number.isInteger(record.size)
      || Number(record.size) <= 0
      || typeof record.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.sha256)
      || (item.role === 'output' && (record.size !== item.size || record.sha256 !== item.sha256))
    ) return false;
    const bytes = await readVerifiedProjectBytes(item.path);
    return Boolean(
      bytes
      && bytes.length === record.size
      && createHash('sha256').update(bytes).digest('hex') === record.sha256
    );
  }));
  return checks.every(Boolean) ? revisionId : '';
}

function platformForOutput(
  output: { kind?: string },
  recipeAsset?: RecipeAsset,
): 'wechat' | 'xhs' | 'moments' | 'video' {
  if (recipeAsset?.platform === 'moments' || output.kind === 'moments_card') return 'moments';
  if (recipeAsset?.platform === 'video' || output.kind === 'video_cover') return 'video';
  if (recipeAsset?.platform === 'xhs' || output.kind === 'xhs_card') return 'xhs';
  return 'wechat';
}

function qualityReason(index: VisualIndex): string {
  const summary = index.quality_summary;
  if (summary?.errors?.[0]) return summary.errors[0];
  if (summary?.status && summary.status !== 'pass') return `视觉质量状态：${summary.status}`;
  if (index.aesthetic_status && index.aesthetic_status !== 'pass') return `渲染审美状态：${index.aesthetic_status}`;
  return '';
}

function revisionStatus(
  inspection: VisualRevisionInspection | undefined,
  hasIndexFile: boolean,
  hasQueuedRequest: boolean,
): { status: VisualWorkbenchRevisionStatus; reason?: string } {
  if (!hasIndexFile) {
    return hasQueuedRequest
      ? { status: 'rendering', reason: '修订请求已记录，等待受控渲染。' }
      : { status: 'rendering', reason: '配方已生成，等待渲染。' };
  }
  if (inspection?.reviewable) {
    return { status: 'review_required', reason: inspection.reason };
  }
  return inspection?.valid
    ? { status: 'ready' }
    : { status: 'blocked', reason: inspection?.reason || '该版本的发布索引无法通过完整性校验。' };
}

function comparisonRole(asset: VisualWorkbenchAsset): VisualWorkbenchComparisonRole | null {
  const role = asset.role.toLowerCase();
  if (role === 'evidence' || role === 'evidence_required') return 'evidence';
  if (role === 'cta' || /-p5$/i.test(asset.id)) return 'cta';
  if (role === 'cover' || /-p1$/i.test(asset.id)) return 'cover';
  return null;
}

/** Read only project-local recipe and published-index state for the delivery workbench. */
export async function loadVisualWorkbenchState(rawSlug: string): Promise<VisualWorkbenchState | null> {
  const slug = normalizeSlug(rawSlug);
  if (!slug) return null;

  const root = runtimeJoin('pipeline', 'visual', slug);
  const recipesRoot = runtimeJoin(root, 'recipes');
  const revisionsRoot = runtimeJoin(root, 'revisions');
  const recipeNames = await listProjectFiles(recipesRoot);
  const recipeRows = await Promise.all(recipeNames.map(async (name) => {
    const match = name.match(/^(r\d{3,})\.visual-recipe\.json$/);
    if (!match) return null;
    const path = runtimeJoin(recipesRoot, name);
    const recipe = await readProjectJson<VisualRecipe>(path);
    if (!recipe || recipe.revision_id !== match[1] || recipe.slug !== slug) return null;
    return { revisionId: match[1], path, recipe };
  }));
  const recipes = recipeRows.filter((row): row is NonNullable<typeof row> => Boolean(row));

  const revisionNames = await listProjectFiles(revisionsRoot);
  const canonicalIndexIds = new Set(
    revisionNames
      .map((name) => name.match(/^(r\d{3,})\.index\.json$/)?.[1] || '')
      .filter(Boolean)
  );
  const queuedIds = new Set(
    revisionNames
      .map((name) => name.match(/^(r\d{3,})-request\.json$/)?.[1] || '')
      .filter(Boolean)
  );

  const currentIndexPath = runtimeJoin(root, 'publish', 'index.json');
  const loadedCurrentIndex = await readProjectJson<VisualIndex>(currentIndexPath);
  const currentIndex = loadedCurrentIndex?.slug === slug ? loadedCurrentIndex : null;

  if (!recipes.length && !currentIndex) return null;
  if (!recipes.length && currentIndex) {
    return {
      slug,
      selectedRevisionId: 'legacy',
      hasExplicitSelection: false,
      revisions: [{
        revisionId: 'legacy',
        recipePath: '',
        indexPath: currentIndexPath,
        status: 'blocked',
        reason: '历史视觉输出缺少配方（legacy），不能作为默认发布版本。',
      }],
      assets: [],
      reviewAssets: [],
      comparison: [],
    };
  }

  const inspectionRows = await Promise.all(recipes.map(async ({ revisionId }) => [
    revisionId,
    await inspectVisualRevision(slug, revisionId),
  ] as const));
  const inspections = new Map(inspectionRows);

  const selectionPath = runtimeJoin(root, 'selected-revision.json');
  const [selection, selectionRecordExists] = await Promise.all([
    readProjectJson<VisualSelection>(selectionPath),
    projectEntryExists(selectionPath),
  ]);
  const selectedByPointer = await verifiedSelectedRevisionId(selection, slug, inspections);
  const currentRevisionId = String(currentIndex?.revision_id || '');
  const currentInspection = inspections.get(currentRevisionId);
  const currentMatchesCanonical = Boolean(
    currentIndex
    && currentInspection?.index
    && (currentInspection.valid || currentInspection.reviewable || currentInspection.previewable)
    && JSON.stringify(currentIndex) === JSON.stringify(currentInspection.index)
  );
  const orderedRecipes = [...recipes].sort((a, b) => revisionNumber(a.revisionId) - revisionNumber(b.revisionId));
  const inspectableRecipes = orderedRecipes.filter((recipe) => {
    const inspection = inspections.get(recipe.revisionId);
    return inspection?.valid || inspection?.reviewable || inspection?.previewable;
  });
  const fallbackRevisionId = selectionRecordExists && !selectedByPointer
    ? (currentMatchesCanonical ? currentRevisionId : inspectableRecipes[0]?.revisionId)
    : (currentMatchesCanonical
      ? currentRevisionId
      : inspectableRecipes[inspectableRecipes.length - 1]?.revisionId);
  const selectedRevisionId = selectedByPointer
    || fallbackRevisionId
    || orderedRecipes[0]?.revisionId
    || 'legacy';

  const revisions = recipes
    .map(({ revisionId, path, recipe }) => {
      const inspection = inspections.get(revisionId);
      const state = revisionStatus(inspection, canonicalIndexIds.has(revisionId), queuedIds.has(revisionId));
      return {
        revisionId,
        parentRevisionId: recipe.parent_revision_id,
        recipePath: path,
        indexPath: canonicalIndexIds.has(revisionId) ? inspection?.indexPath : undefined,
        ...(inspection?.previewable ? { issues: (inspection.index?.quality_summary?.errors || []).filter((item) => typeof item === 'string').slice(0, 24) } : {}),
        ...state,
      };
    })
    .sort((a, b) => revisionNumber(b.revisionId) - revisionNumber(a.revisionId));

  const assetsForRevision = (revisionId: string): VisualWorkbenchAsset[] => {
    const recipe = recipes.find((row) => row.revisionId === revisionId)?.recipe;
    const inspection = inspections.get(revisionId);
    const index = inspection?.valid || inspection?.reviewable || inspection?.previewable ? inspection.index : undefined;
    return (index?.outputs || []).flatMap((output) => {
      const outputPath = String(output.output || '');
      if (!isVisualPathForSlug(outputPath, slug)) return [];
      const recipeAsset = recipe?.assets?.find((asset) => asset.id === output.id);
      const quality = inspection?.previewable ? 'blocked' : String(output.quality || index?.quality_summary?.status || index?.aesthetic_status || 'not_checked');
      const globalReason = index?.quality_summary?.errors?.find((item) => item.includes(String(output.id || '')))
        || (quality !== 'pass' ? index?.quality_summary?.errors?.[0] : undefined);
      const themeId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value);
      const layout = recipe?.platforms?.wechat?.layout_selection;
      const requestedTheme = themeId(output.layout_style) ? output.layout_style : themeId(layout?.selected) ? layout.selected : '';
      let locallyRefined = false;
      if (output.id === 'wechat-html' && output.base_renderer === 'md2wechat-cli'
        && output.base_theme === requestedTheme && output.renderer_theme === requestedTheme
        && output.output_is_raw_api_result === false && /^[a-f0-9]{64}$/.test(output.raw_html_sha256 || '')) {
        try {
          const requested = parseWechatLayout(recipe?.platforms?.wechat?.wechat_layout);
          const rendered = requested && parseWechatLayout({ ...requested, refinement: output.local_refinements });
          locallyRefined = Boolean(requested?.refinement && requested.theme === requestedTheme
            && JSON.stringify(requested.refinement) === JSON.stringify(rendered?.refinement));
        } catch { /* Incomplete provenance must not be shown as a confirmed refinement. */ }
      }
      const wechatLayout = output.id === 'wechat-html' && requestedTheme ? {
        requestedTheme,
        renderedTheme: themeId(output.renderer_theme) ? output.renderer_theme : undefined,
        usedFallback: Boolean(output.layout_fallback_reason) || output.renderer_theme === 'echo-basic',
        candidates: [...new Set((layout?.candidates || []).filter(themeId))],
        ...(locallyRefined ? { locallyRefined: true as const, refinementProfile: 'title-spacing-v1' as const } : {}),
      } : undefined;
      return [{
        revisionId,
        id: String(output.id || outputPath),
        platform: platformForOutput(output, recipeAsset),
        path: outputPath,
        role: String(recipeAsset?.role || output.role || output.kind || 'asset'),
        title: typeof recipeAsset?.copy?.headline === 'string' && recipeAsset.copy.headline.trim()
          ? recipeAsset.copy.headline.trim()
          : undefined,
        status: String(output.status || 'unknown'),
        quality,
        width: typeof output.width === 'number' ? output.width : undefined,
        height: typeof output.height === 'number' ? output.height : undefined,
        sha256: typeof output.sha256 === 'string' ? output.sha256 : undefined,
        nativeCopyVerified: output.copy_fidelity?.status === 'pass',
        reviewRequired: Boolean(
          inspection?.reviewable && output.ai_generated && output.ocr_status === 'review_required'
        ),
        reason: String(output.reason || output.quality_reason || globalReason || '').trim() || undefined,
        provider: typeof output.provider === 'string' ? output.provider : undefined,
        imageBackend: typeof output.image_backend === 'string' ? output.image_backend : undefined,
        ...(wechatLayout ? { wechatLayout } : {}),
      }];
    });
  };

  const assets = assetsForRevision(selectedRevisionId);
  const assetCandidates = revisions.flatMap((revision) => assetsForRevision(revision.revisionId));
  const selectedAssetBytes = await readVerifiedProjectBytes(runtimeJoin(root, 'selected-assets.json'));
  let selectedAssetManifest: VisualAssetSelection | null = null;
  try { if (selectedAssetBytes) selectedAssetManifest = JSON.parse(selectedAssetBytes.toString('utf8')) as VisualAssetSelection; } catch { /* Keep unreadable selection unadopted. */ }
  const selectedAssetRows = selectedAssetManifest?.schema === 'aifios.visual-asset-manifest.v1'
    && selectedAssetManifest.slug === slug && selectedAssetManifest.selections
    ? Object.entries(selectedAssetManifest.selections)
    : [];
  const selectedManifestAssets = selectedAssetRows.length
    ? selectedAssetRows.flatMap(([semanticRole, selected]) => {
      if (!selected?.assetId || !selected.revisionId || !selected.sha256) return [];
      const candidate = assetCandidates.find((asset) => (
        asset.id === selected.assetId
        && asset.revisionId === selected.revisionId
        && asset.sha256 === selected.sha256
      ));
      if (!candidate) return [];
      const bindings = Array.isArray(selected.platformBindings)
        ? [...new Set(selected.platformBindings.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
        : [candidate.platform];
      return [{
        candidate,
        manifest: {
          semanticRole,
          id: candidate.id,
          revisionId: candidate.revisionId,
          path: candidate.path,
          sha256: candidate.sha256 || '',
          platformBindings: bindings,
        } satisfies VisualWorkbenchAdoptedAsset,
      }];
    })
    : [];
  const selectedAssets = selectedManifestAssets.map((item) => item.candidate);
  const validSourceContentHash = typeof selectedAssetManifest?.sourceContentHash === 'string'
    && /^[a-f0-9]{64}$/i.test(selectedAssetManifest.sourceContentHash)
    ? selectedAssetManifest.sourceContentHash
    : '';
  const requiredRoles = Array.isArray(selectedAssetManifest?.requiredRoles)
    ? selectedAssetManifest.requiredRoles.filter((role): role is string => (
      typeof role === 'string'
      && role.trim().length > 0
      && !/^video-\d+-cover$/i.test(role)
    ))
    : [];
  const usesAssetManifest = selectedAssetRows.length > 0
    && selectedAssets.length === selectedAssetRows.length
    && Boolean(validSourceContentHash)
    && requiredRoles.length > 0;
  const hasCompleteAssetSelection = usesAssetManifest
    && requiredRoles.every((role) => selectedAssetRows.some(([selectedRole]) => selectedRole === role));
  const reviewAssets = revisions.flatMap((revision) => (
    revision.status === 'review_required'
      ? assetsForRevision(revision.revisionId).filter((asset) => asset.reviewRequired)
      : []
  ));
  const selectedRecipe = recipes.find((row) => row.revisionId === selectedRevisionId)?.recipe;
  const selectedIndex = inspections.get(selectedRevisionId)?.index;
  const candidateRevisionId = revisions.find((revision) => (
    revision.revisionId !== selectedRevisionId
      && revision.parentRevisionId === selectedRevisionId
      && (revision.status === 'ready' || revision.status === 'review_required')
  ))?.revisionId;
  const parentRevisionId = selectedRecipe?.parent_revision_id
    && revisions.some((revision) => revision.revisionId === selectedRecipe.parent_revision_id && revision.status === 'ready')
    ? selectedRecipe.parent_revision_id
    : undefined;
  const comparisonPair = candidateRevisionId
    ? {
        leftLabel: 'current' as const,
        leftRevisionId: selectedRevisionId,
        leftAssets: assets,
        rightLabel: 'candidate' as const,
        rightRevisionId: candidateRevisionId,
        rightAssets: assetsForRevision(candidateRevisionId),
      }
    : parentRevisionId
      ? {
          leftLabel: 'previous' as const,
          leftRevisionId: parentRevisionId,
          leftAssets: assetsForRevision(parentRevisionId),
          rightLabel: 'current' as const,
          rightRevisionId: selectedRevisionId,
          rightAssets: assets,
        }
      : null;
  const assetForRole = (revisionAssets: VisualWorkbenchAsset[], role: VisualWorkbenchComparisonRole) => (
    revisionAssets.find((asset) => asset.platform === 'xhs' && comparisonRole(asset) === role)
      || revisionAssets.find((asset) => comparisonRole(asset) === role)
  );
  const comparison = comparisonPair
    ? (['cover', 'evidence', 'cta'] as const).map((role) => ({
        role,
        leftLabel: comparisonPair.leftLabel,
        leftRevisionId: comparisonPair.leftRevisionId,
        left: assetForRole(comparisonPair.leftAssets, role),
        rightLabel: comparisonPair.rightLabel,
        rightRevisionId: comparisonPair.rightRevisionId,
        right: assetForRole(comparisonPair.rightAssets, role),
      })).filter((item) => item.left || item.right)
    : [];

  return {
    slug,
    selectedRevisionId,
    hasExplicitSelection: Boolean(selectedByPointer),
    revisions,
    assets: usesAssetManifest ? selectedAssets : assets,
    assetCandidates,
    hasExplicitAssetSelection: usesAssetManifest,
    hasCompleteAssetSelection,
    selectedAssetKeys: selectedAssets.map((asset) => `${asset.revisionId}:${asset.id}`),
    ...(usesAssetManifest ? {
      adoptedAssetManifest: {
        selectionSha256: selectedAssetBytes ? createHash('sha256').update(selectedAssetBytes).digest('hex') : undefined,
        sourceContentHash: validSourceContentHash,
        requiredRoles,
        assets: selectedManifestAssets.map((item) => item.manifest),
      },
    } : {}),
    reviewAssets,
    comparison,
    ...(selectedRecipe?.visual_preferences ? {
      visualPreferences: {
        mode: selectedRecipe.visual_preferences.mode === 'ai_enhanced' ? 'ai_enhanced' : 'stable',
        directionCount: 2,
        providerPolicy: 'auto',
      },
    } : {}),
    ...(Array.isArray(selectedRecipe?.art_directions) ? {
      artDirections: selectedRecipe.art_directions.flatMap((direction) => (
        direction.id && direction.label
          ? [{
              id: direction.id,
              label: direction.label,
              styleTokens: Array.isArray(direction.style_tokens) ? direction.style_tokens.filter((item): item is string => typeof item === 'string') : [],
              palette: direction.palette && typeof direction.palette === 'object'
                ? Object.values(direction.palette).filter((item): item is string => typeof item === 'string' && /^#[0-9a-f]{6}$/i.test(item)).slice(0, 5)
                : [],
              composition: String(direction.composition || ''),
              selected: Boolean(selectedIndex && direction.id === selectedRecipe.selected_direction),
            }]
          : []
      )),
    } : {}),
    effectiveVisualMode: selectedIndex?.effective_visual_mode === 'ai_enhanced'
      || (!selectedIndex && selectedRecipe?.visual_preferences?.mode === 'ai_enhanced')
      ? 'ai_enhanced'
      : 'stable',
    fallbackNotes: Array.isArray(selectedIndex?.visual_fallback_notes)
      ? selectedIndex.visual_fallback_notes.filter((item): item is string => typeof item === 'string')
      : [],
    providers: [...new Set((selectedIndex?.outputs || []).flatMap((output) => (
      typeof output.provider === 'string' && output.provider ? [output.provider] : []
    )))],
  };
}
