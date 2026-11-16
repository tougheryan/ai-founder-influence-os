import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'fs/promises';
import { isAbsolute, relative } from 'node:path';
import { promisify } from 'node:util';
import Ajv, { type ValidateFunction } from 'ajv';
import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import {
  expectedUserFacingErrorResponse,
  type UserFacingError,
  userFacingErrorPayload,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';
import { InputLimitError, assertJsonInputSize, assertTextInput, textByteLength, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { createLLMTextCompletion, getApiKey } from '@/lib/llm-client';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths, runtimeJoin, safeResolve, skillPath } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { resolveServerLLMConfig } from '@/lib/server-config';
import { assertVisualRevisionClientShape, parseWechatLayout, type WechatLayoutRequest } from '@/lib/visual-revision-request';
import { readMd2WechatThemeCatalog } from '@/lib/md2wechat-themes';
import { WriteLockError, readIdempotentResult, rememberIdempotentResult, withProjectWriteLock, writeFingerprint } from '@/lib/write-guard';

const execFileAsync = promisify(execFile);
const REVISION_TIMEOUT_MS = 10 * 60 * 1000;
const REVISION_MAX_BUFFER = 12 * 1024 * 1024;

const ALLOWED_OPERATIONS = [
  'change_system',
  'replace_evidence',
  'change_layout',
  'reduce_copy',
] as const;

type RevisionOperation = typeof ALLOWED_OPERATIONS[number];

type VisualRecipe = {
  schema?: string;
  revision_id?: string;
  slug?: string;
  source_package?: string;
  content_archetype?: string;
  evidence_mode?: string;
  source_assets?: string[];
  visual_preferences?: { mode?: string };
  platforms?: {
    wechat?: { layout_selection?: { selected?: string; candidates?: string[] }; wechat_layout?: WechatLayoutRequest };
    xhs?: { system?: string };
  };
  assets?: Array<{
    id?: string;
    role?: string;
    platform?: string;
    layout_recipe?: string;
    layout_style?: string;
    renderer?: string;
    source?: string;
    copy?: { headline?: string; supporting?: string };
  }>;
};

type RevisionRequestRecord = {
  status: 'queued' | 'review_required' | 'rendered' | 'blocked';
  requestPath?: string;
  baseRevisionId: string;
  operations?: RevisionOperation[];
  revisionId?: string;
  indexPath?: string;
  reason?: string;
};

type VisualIndex = {
  schema?: string;
  slug?: string;
  revision_id?: string;
  recipe_path?: string;
  status?: string;
  legacy?: boolean;
  renderer?: string;
  errors?: unknown[];
  revision_index_path?: string;
  platform_delivery_manifest?: string;
  quality_summary?: {
    status?: string;
    errors?: string[];
    blocking_issues?: string[];
    review_issues?: string[];
  };
  aesthetic_status?: string;
  outputs?: Array<{
    id?: string;
    renderer?: string;
    recipe_path?: string;
    revision_id?: string;
    status?: string;
    output?: string;
    size?: number;
    sha256?: string;
    ai_generated?: boolean;
    ocr_status?: string;
  }>;
};

type PlatformDeliveryManifest = {
  schema?: string;
  slug?: string;
  revision_id?: string;
};

type SelectionIntegrityFile = {
  role?: string;
  path?: string;
  id?: string;
  size?: number;
  sha256?: string;
};

type VisualSelection = {
  schema?: string;
  slug?: string;
  revision_id?: string;
  integrity?: { algorithm?: string; files?: SelectionIntegrityFile[] };
};

type RevisionFileRecord = Record<string, unknown> & {
  status?: string;
  diagnostic_reason?: string;
  revision_id?: string;
  index_path?: string;
};

type ConsumerResult = {
  status?: string;
  reason?: string;
  revision_id?: string;
  index_path?: string;
  request_path?: string;
};

let revisionRecordValidator: ValidateFunction | null = null;

async function validateRevisionRecord(record: Record<string, unknown>): Promise<void> {
  if (!revisionRecordValidator) {
    const schemaPath = skillPath('content-runtime', 'schemas', 'visual-revision-request.schema.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as Record<string, unknown>;
    revisionRecordValidator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  }
  if (!revisionRecordValidator(record)) {
    const detail = (revisionRecordValidator.errors || [])
      .map((item) => `${item.instancePath || '/'} ${item.message || 'invalid'}`)
      .join('; ');
    throw new Error(`视觉修订请求未通过 schema：${detail}`);
  }
}

function hasAllowedOperation(value: unknown): value is RevisionOperation {
  return typeof value === 'string' && (ALLOWED_OPERATIONS as readonly string[]).includes(value);
}

function parseTargetAssetIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new InputLimitError('目标视觉资产必须是不超过 20 项的列表');
  }
  const ids = value.map((item) => {
    const id = assertTextInput(item, '目标视觉资产 ID', MAX_SHORT_TEXT_BYTES).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(id)) {
      throw new InputLimitError('目标视觉资产 ID 格式不正确');
    }
    return id;
  });
  return Array.from(new Set(ids));
}

function deterministicOperations(request: string): RevisionOperation[] {
  const text = request.toLowerCase();
  const operations: RevisionOperation[] = [];
  if (/杂志|editorial|视觉系统|瑞士|swiss|混合|hybrid/.test(text)) operations.push('change_system');
  if (/真实.*截图|截图|证据|数据图|替换.*图/.test(text)) operations.push('replace_evidence');
  if (/版式|布局|排版|构图|换个?样式|layout|theme/.test(text)) operations.push('change_layout');
  if (/少一点字|减少.*字|精简文案|缩短.*文案|reduce.*copy/.test(text)) operations.push('reduce_copy');
  return Array.from(new Set(operations));
}

function requestedVisualSystem(request: string): string {
  const text = request.toLowerCase();
  if (/杂志|editorial|编辑风|刊物/.test(text)) return 'editorial';
  if (/瑞士|swiss/.test(text)) return 'swiss';
  if (/混合|hybrid/.test(text)) return 'hybrid';
  return '';
}

type EvidenceIntent = 'screenshot' | 'data' | 'any';

function requestedEvidenceIntent(request: string): EvidenceIntent {
  const text = request.toLowerCase();
  if (/截图|截屏|界面|图片|照片|screenshot|screen|\bui\b|image|photo/.test(text)) return 'screenshot';
  if (/数据|表格|电子表格|csv|json|excel|\bxls\b|xlsx|dataset|spreadsheet/.test(text)) return 'data';
  return 'any';
}

function isSafeSourcePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) && Boolean(safeResolve(PROJECT_DIR, value));
}

class WechatLayoutInputError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function explicitWechatThemes(request: string, candidates: string[]): string[] {
  const names = new Set<string>();
  const text = request.toLowerCase();
  for (const candidate of candidates) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate)) continue;
    if (new RegExp(`(?<![a-z0-9_-])${candidate}(?![a-z0-9_-])`).test(text)) names.add(candidate);
  }
  for (const match of text.matchAll(/(?<![a-z0-9_-])[a-z0-9]+(?:[-_][a-z0-9]+)+(?![a-z0-9_-])/g)) names.add(match[0]);
  for (const match of text.matchAll(/(?:主题|样式|\btheme\b|改为|改成|换为|换成|调整为|设为)\s*(?:(?:改为|改成|换为|换成|调整为|设为|为|成)\s*)?[:：=]?\s*["'“‘`]?([a-z0-9][a-z0-9_-]{0,63})(?![a-z0-9_-])/g)) names.add(match[1]);
  return [...names].filter((name) => !['wechat-html', 'title-spacing-v1'].includes(name));
}

async function verifiedWechatLayout(
  recipe: VisualRecipe,
  request: string,
  targetAssetIds: string[],
  supplied?: WechatLayoutRequest,
): Promise<WechatLayoutRequest | undefined> {
  const targetsArticle = targetAssetIds.length === 1 && targetAssetIds[0] === 'wechat-html';
  if (supplied && !targetsArticle) throw new WechatLayoutInputError('公众号排版参数只能用于本篇文章，请单独选择公众号成品。');
  if (!targetsArticle) return undefined;
  const namedThemes = explicitWechatThemes(request, recipe.platforms?.wechat?.layout_selection?.candidates || []);
  if (namedThemes.length > 1 || (supplied && namedThemes.some((name) => name !== supplied.theme))) {
    throw new WechatLayoutInputError('这次指定了不同的排版主题，请只保留一个明确选择。');
  }
  const themeId = supplied?.theme || namedThemes[0];
  if (!themeId) return undefined;
  const catalog = await readMd2WechatThemeCatalog();
  if (catalog.source !== 'md2wechat' || !catalog.rendererAvailable) {
    throw new WechatLayoutInputError('暂时无法读取 md2wechat 主题目录，已保留当前排版，请检查工具连接后重试。');
  }
  if (!catalog.templates.some((theme) => theme.id === themeId && theme.source === 'md2wechat'
    && theme.themeType === 'api' && theme.enabled && theme.selectable === true)) {
    throw new WechatLayoutInputError('指定的主题当前不可用，请选择 md2wechat 目录中可直接使用的主题。');
  }
  const source = recipe.source_package;
  const absolute = typeof source === 'string' && source.startsWith('pipeline/package/') && isSafeSourcePath(source)
    ? safeResolve(PROJECT_DIR, source) : null;
  if (!absolute) throw new WechatLayoutInputError('找不到这篇排版对应的原稿，请刷新后重新选择。', 409);
  let bytes: Buffer;
  try {
    const [projectPath, sourcePath] = await Promise.all([realpath(PROJECT_DIR), realpath(absolute)]);
    const fromProject = relative(projectPath, sourcePath);
    if (isAbsolute(fromProject) || fromProject === '..' || fromProject.startsWith('../')) throw new Error('outside project');
    bytes = await readFile(sourcePath);
  } catch {
    throw new WechatLayoutInputError('这篇原稿已变化或无法读取，请重新核对后调整排版。', 409);
  }
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  if (supplied && supplied.source_package_sha256 !== sourceHash) {
    throw new WechatLayoutInputError('原稿已变化，旧的标题与排版参数不能继续使用，请重新核对。', 409);
  }
  return supplied || { theme: themeId, source_package_sha256: sourceHash };
}

function evidenceSourceMatchesIntent(source: string, intent: EvidenceIntent): boolean {
  const normalized = source.toLowerCase();
  const isData = /\.(?:csv|json|tsv)$/.test(normalized);
  const isScreenshot = /\.(?:png|jpe?g|webp|gif)$/.test(normalized);
  if (intent === 'any') return isData || isScreenshot;
  if (intent === 'data') {
    return isData;
  }
  return isScreenshot;
}

function matchingEvidenceSources(
  recipe: VisualRecipe,
  asset: NonNullable<VisualRecipe['assets']>[number],
  request: string,
): string[] {
  const intent = requestedEvidenceIntent(request);
  return (recipe.source_assets || []).filter((source) => (
    typeof source === 'string'
    && source !== asset.source
    && isSafeSourcePath(source)
    && evidenceSourceMatchesIntent(source, intent)
  ));
}

function revisionOperationReviewReason(
  recipe: VisualRecipe,
  operations: RevisionOperation[],
  targetAssetIds: string[],
  request: string,
): string {
  const assets = recipe.assets || [];
  const explicitTargets = targetAssetIds.length > 0;
  const targets = explicitTargets ? assets.filter((asset) => targetAssetIds.includes(String(asset.id || ''))) : assets;
  for (const operation of operations) {
    if (operation === 'change_system') {
      if (explicitTargets) return '整体风格会影响全部图片，不能只修改其中一张。';
      const requested = requestedVisualSystem(request);
      if (!requested || requested === recipe.platforms?.xhs?.system) return '当前要求不会产生可见变化，请换一种说法。';
    }
    if (operation === 'change_layout') {
      const applicable = targets.filter((asset) => (
        (asset.platform === 'xhs' && typeof asset.layout_recipe === 'string')
        || (asset.id === 'wechat-html' && typeof asset.layout_style === 'string')
      ));
      if (!applicable.length || (explicitTargets && applicable.length !== targets.length)) {
        return '所选图片不支持修改版式。';
      }
      const requested = request.match(/\b([SM]\d{2})\b/i)?.[1]?.toUpperCase();
      const xhsApplicable = applicable.filter((asset) => asset.platform === 'xhs');
      if (requested && xhsApplicable.length && xhsApplicable.every((asset) => asset.layout_recipe === requested)) {
        return '所选图片已经是这个版式。';
      }
    }
    if (operation === 'reduce_copy') {
      const reducible = targets.filter((asset) => [asset.copy?.headline, asset.copy?.supporting]
        .some((value) => typeof value === 'string' && value.trim().length > 24));
      if (!reducible.length || (explicitTargets && reducible.length !== targets.length)) {
        return '所选图片没有可精简的长文案。';
      }
    }
    if (operation === 'replace_evidence') {
      const evidence = targets.filter((asset) => ['evidence', 'evidence_required'].includes(String(asset.role || '')));
      if (!evidence.length || (explicitTargets && evidence.length !== targets.length)) {
        return '所选图片不是可替换的资料图。';
      }
      if (evidence.some((asset) => !matchingEvidenceSources(recipe, asset, request).length)) {
        return '没有找到符合要求的备用资料图。';
      }
    }
  }
  return '';
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function parseOperationsWithConfiguredModel(request: string, targetAssetIds: string[]): Promise<RevisionOperation[]> {
  const config = await resolveServerLLMConfig(null);
  if (!getApiKey(config)) return [];
  const response = await createLLMTextCompletion(config, [{
    role: 'system',
    content: '把视觉修订请求分类成严格 JSON。只允许 operations: change_system, replace_evidence, change_layout, reduce_copy。不要添加字段。',
  }, {
    role: 'user',
    content: JSON.stringify({ request, target_asset_ids: targetAssetIds }),
  }], { temperature: 0, maxTokens: 160, timeoutMs: 15_000 });
  const parsed = parseJsonObject(response);
  if (!Array.isArray(parsed?.operations)) return [];
  return Array.from(new Set(parsed.operations.filter(hasAllowedOperation)));
}

async function readProjectJson<T>(relativePath: string): Promise<T | null> {
  const absolute = safeResolve(PROJECT_DIR, relativePath);
  if (!absolute) return null;
  try {
    return JSON.parse(await readFile(absolute, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function isRevisionOutputPath(value: unknown, slug: string, revisionId: string): value is string {
  if (typeof value !== 'string' || value.includes('\\')) return false;
  const root = `pipeline/visual/${slug}/publish/${revisionId}/`;
  const segments = value.split('/');
  return value.startsWith(root) && !segments.some((segment) => !segment || segment === '.' || segment === '..');
}

async function platformDeliveryManifestIsValid(
  index: VisualIndex,
  slug: string,
  revisionId: string,
): Promise<boolean> {
  const path = index.platform_delivery_manifest;
  if (path === undefined) return true;
  if (!isRevisionOutputPath(path, slug, revisionId)) return false;
  const manifest = await readProjectJson<PlatformDeliveryManifest>(path);
  return Boolean(manifest)
    && ['aifios.platform-visual-delivery.v1', 'echo-founder.platform-visual-delivery.v2'].includes(String(manifest?.schema || ''))
    && manifest?.slug === slug
    && manifest?.revision_id === revisionId;
}

async function renderedIndexArtifactsAreValid(
  index: VisualIndex,
  slug: string,
  revisionId: string,
  recipePath: string,
  acceptedQualityStatuses: readonly string[] = ['pass'],
  expectedAssetIds?: ReadonlySet<string>,
): Promise<boolean> {
  if (
    index.schema !== 'aifios.visual-publish.v1'
    || index.slug !== slug
    || index.revision_id !== revisionId
    || index.recipe_path !== recipePath
    || index.status !== 'generated'
    || index.legacy !== false
    || ![undefined, 'local'].includes(index.renderer)
    || (index.errors !== undefined && (!Array.isArray(index.errors) || index.errors.length > 0))
    || !acceptedQualityStatuses.includes(String(index.quality_summary?.status || ''))
    || !index.outputs?.length
    || index.outputs.some((output) => (
      output.renderer !== 'local'
      || output.recipe_path !== recipePath
      || output.revision_id !== revisionId
      || output.status !== 'generated'
    ))
  ) return false;
  if (!(await platformDeliveryManifestIsValid(index, slug, revisionId))) return false;
  const outputIds = index.outputs.map((output) => String(output.id || ''));
  if (
    outputIds.some((id) => !id)
    || new Set(outputIds).size !== outputIds.length
    || (expectedAssetIds && (
      outputIds.length !== expectedAssetIds.size
      || outputIds.some((id) => !expectedAssetIds.has(id))
    ))
  ) return false;
  const outputRootSegments = ['pipeline', 'visual', slug, 'publish', revisionId];
  const files = await Promise.all(index.outputs.map(async (output) => {
    if (typeof output.output !== 'string' || output.output.includes('\\')) return false;
    const segments = output.output.split('/');
    if (
      segments.length <= outputRootSegments.length
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || outputRootSegments.some((segment, indexPosition) => segments[indexPosition] !== segment)
    ) return false;
    const absolute = safeResolve(PROJECT_DIR, output.output);
    if (!absolute) return false;
    try {
      const bytes = await readFile(absolute);
      return bytes.length > 0
        && Number.isInteger(output.size)
        && Number(output.size) === bytes.length
        && typeof output.sha256 === 'string'
        && /^[a-f0-9]{64}$/.test(output.sha256)
        && createHash('sha256').update(bytes).digest('hex') === output.sha256;
    } catch {
      return false;
    }
  }));
  return files.every(Boolean);
}

function exactRecipeAssetIds(recipe: VisualRecipe): Set<string> | null {
  const assets = recipe.assets;
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const ids = assets.map((asset) => String(asset.id || ''));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  return new Set(ids);
}

async function selectedIntegrityIsValid(
  selection: VisualSelection,
  recipe: VisualRecipe,
  index: VisualIndex,
  recipePath: string,
  indexPath: string,
): Promise<boolean> {
  const files = selection.integrity?.files;
  if (selection.integrity?.algorithm !== 'sha256' || !Array.isArray(files)) return false;
  const outputs = index.outputs || [];
  const recipeAssetIds = new Set(
    (recipe.assets || []).map((asset) => String(asset.id || '')).filter(Boolean),
  );
  const outputIds = new Set<string>();
  for (const output of outputs) {
    const outputId = String(output.id || '');
    if (!outputId || outputIds.has(outputId) || !recipeAssetIds.has(outputId)) return false;
    outputIds.add(outputId);
  }
  if (outputIds.size !== recipeAssetIds.size) return false;

  const expected = [
    { role: 'recipe', path: recipePath, id: undefined, size: undefined, sha256: undefined },
    { role: 'index', path: indexPath, id: undefined, size: undefined, sha256: undefined },
    ...outputs.map((output) => ({
      role: 'output',
      path: String(output.output || ''),
      id: output.id,
      size: output.size,
      sha256: output.sha256,
    })),
    ...(index.platform_delivery_manifest !== undefined ? [{
      role: 'platform_delivery',
      path: index.platform_delivery_manifest,
      id: undefined,
      size: undefined,
      sha256: undefined,
    }] : []),
  ];
  if (files.length !== expected.length) return false;
  const records = new Map<string, SelectionIntegrityFile>();
  for (const file of files) {
    if (!file || typeof file.role !== 'string' || typeof file.path !== 'string') return false;
    const key = `${file.role}\0${file.path}`;
    if (records.has(key)) return false;
    records.set(key, file);
  }

  const checks = await Promise.all(expected.map(async (item) => {
    if (!item.path) return false;
    const record = records.get(`${item.role}\0${item.path}`);
    if (!record || record.id !== item.id) return false;
    if (!Number.isInteger(record.size) || Number(record.size) <= 0
      || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
    if (item.role === 'output' && (record.size !== item.size || record.sha256 !== item.sha256)) return false;
    const absolute = safeResolve(PROJECT_DIR, item.path);
    if (!absolute) return false;
    try {
      const bytes = await readFile(absolute);
      return bytes.length === record.size
        && createHash('sha256').update(bytes).digest('hex') === record.sha256;
    } catch {
      return false;
    }
  }));
  return checks.every(Boolean);
}

async function readSelectedRecipe(
  slug: string,
  requestedBaseRevisionId?: string,
): Promise<{ recipePath: string; recipe: VisualRecipe; baseRevisionId: string } | null> {
  const root = `pipeline/visual/${slug}`;
  const selection = requestedBaseRevisionId
    ? null
    : await readProjectJson<VisualSelection>(`${root}/selected-revision.json`);
  if (!requestedBaseRevisionId && (selection?.schema !== 'aifios.visual-selection.v1' || selection.slug !== slug)) return null;
  const baseRevisionId = requestedBaseRevisionId || String(selection?.revision_id || '');
  if (!/^r\d{3,}$/.test(baseRevisionId)) return null;

  const recipePath = `${root}/recipes/${baseRevisionId}.visual-recipe.json`;
  const indexPath = `${root}/revisions/${baseRevisionId}.index.json`;
  const [recipe, index] = await Promise.all([
    readProjectJson<VisualRecipe>(recipePath),
    readProjectJson<VisualIndex>(indexPath),
  ]);
  if (!recipe || !['aifios.visual-recipe.v1', 'aifios.visual-recipe.v2'].includes(String(recipe.schema || ''))
    || recipe.slug !== slug || recipe.revision_id !== baseRevisionId) return null;
  if (index?.revision_index_path !== indexPath) return null;
  const recipeAssetIds = exactRecipeAssetIds(recipe);
  if (!recipeAssetIds
    || !index
    || !(await renderedIndexArtifactsAreValid(index, slug, baseRevisionId, recipePath, ['pass'], recipeAssetIds))) return null;
  if (selection && !(await selectedIntegrityIsValid(selection, recipe, index, recipePath, indexPath))) return null;
  return { recipePath, recipe, baseRevisionId };
}

function recipeCanUseStableRevision(recipe: VisualRecipe): boolean {
  if (recipe.schema === 'aifios.visual-recipe.v2' && recipe.visual_preferences?.mode !== 'stable') {
    return false;
  }
  return !(recipe.assets || []).some((asset) => (
    asset.role === 'illustration'
    || asset.renderer === 'ian-xiaohei-illustrations'
  ));
}

async function nextRequestPath(slug: string, baseRevisionId: string): Promise<{ relative: string; absolute: string; requestId: string }> {
  const root = `pipeline/visual/${slug}/revisions`;
  for (let sequence = 1; sequence <= 99; sequence += 1) {
    const suffix = sequence === 1 ? '' : `-${String(sequence).padStart(2, '0')}`;
    const relative = `${root}/${baseRevisionId}-request${suffix}.json`;
    const absolute = safeResolve(PROJECT_DIR, relative);
    if (!absolute) throw new InputLimitError('修订请求路径非法');
    try {
      await readFile(absolute, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { relative, absolute, requestId: `${baseRevisionId}-request${suffix}` };
    }
  }
  throw new InputLimitError('当前版本的修订请求过多，请先处理已有请求');
}

function parseConsumerResult(stdout: string): ConsumerResult {
  try {
    const value = JSON.parse(stdout) as ConsumerResult;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error('视觉修订 consumer 返回了无效 JSON');
  }
}

async function runRevisionConsumer(slug: string, requestId: string): Promise<ConsumerResult> {
  const { stdout } = await execFileAsync(runtimePythonBinary(), [
    contentRuntimeToolPath('visual_revision.py'),
    '--project', PROJECT_DIR,
    'consume',
    '--slug', slug,
    '--request-id', requestId,
  ], {
    cwd: PROJECT_DIR,
    encoding: 'utf-8',
    timeout: REVISION_TIMEOUT_MS,
    maxBuffer: REVISION_MAX_BUFFER,
  });
  return parseConsumerResult(String(stdout || ''));
}

async function markRequestBlocked(
  path: string,
  record: Record<string, unknown>,
  error: unknown,
): Promise<UserFacingError> {
  const failure = userFacingErrorPayload(error, {
    error: error instanceof Error && error.message.includes('所选排版样式未应用')
      ? '所选排版样式没有应用，原成品已保留。请检查排版服务后重试；本次请求是否扣费以服务方记录为准。'
      : '图片修改失败，请调整要求后重试。',
    code: 'visual_revision_execution_failed',
    context: 'visual revision consumer',
  });
  const blocked = {
    ...record,
    status: 'blocked',
    diagnostic_reason: failure.error,
  };
  delete (blocked as RevisionFileRecord).revision_id;
  delete (blocked as RevisionFileRecord).index_path;
  await validateRevisionRecord(blocked);
  await writeFile(path, JSON.stringify(blocked, null, 2), 'utf-8');
  return failure;
}

async function verifyRenderedResult(
  slug: string,
  baseRevisionId: string,
  destination: { relative: string; absolute: string },
  result: ConsumerResult,
): Promise<{ revisionId: string; indexPath: string }> {
  const revisionId = String(result.revision_id || '');
  if (!/^r\d{3,}$/.test(revisionId) || revisionId === baseRevisionId) {
    throw new Error('视觉修订 consumer 未返回新的合法 revision_id');
  }
  const recipePath = `pipeline/visual/${slug}/recipes/${revisionId}.visual-recipe.json`;
  const indexPath = `pipeline/visual/${slug}/revisions/${revisionId}.index.json`;
  if (result.index_path !== indexPath || result.request_path !== destination.relative) {
    throw new Error('视觉修订 consumer 返回了非服务端解析路径');
  }

  const [recipe, index, requestRecord] = await Promise.all([
    readProjectJson<VisualRecipe & { parent_revision_id?: string }>(recipePath),
    readProjectJson<VisualIndex>(indexPath),
    readProjectJson<RevisionFileRecord>(destination.relative),
  ]);
  if (
    !recipe
    || recipe.slug !== slug
    || recipe.revision_id !== revisionId
    || recipe.parent_revision_id !== baseRevisionId
    || !index
    || !requestRecord
    || requestRecord.status !== 'rendered'
    || requestRecord.revision_id !== revisionId
    || requestRecord.index_path !== indexPath
  ) {
    throw new Error('视觉修订 consumer 未完成配方、索引、本地 renderer 与请求状态的原子闭环');
  }
  if (requestRecord.wechat_layout && JSON.stringify(parseWechatLayout(requestRecord.wechat_layout))
    !== JSON.stringify(parseWechatLayout(recipe.platforms?.wechat?.wechat_layout))) {
    throw new Error('视觉修订结果没有保留本次指定的公众号排版参数');
  }
  const recipeAssetIds = exactRecipeAssetIds(recipe);
  if (!recipeAssetIds
    || !(await renderedIndexArtifactsAreValid(index, slug, revisionId, recipePath, ['pass'], recipeAssetIds))) {
    throw new Error('视觉修订 consumer 未完成最终 recipe provenance 与输出文件回验');
  }
  await validateRevisionRecord(requestRecord);
  return { revisionId, indexPath };
}

async function verifyReviewRequiredResult(
  slug: string,
  baseRevisionId: string,
  destination: { relative: string; absolute: string },
  result: ConsumerResult,
): Promise<{ revisionId: string; indexPath: string }> {
  const revisionId = String(result.revision_id || '');
  if (!/^r\d{3,}$/.test(revisionId) || revisionId === baseRevisionId) {
    throw new Error('视觉修订 consumer 未返回新的合法待复核 revision_id');
  }
  const recipePath = `pipeline/visual/${slug}/recipes/${revisionId}.visual-recipe.json`;
  const indexPath = `pipeline/visual/${slug}/revisions/${revisionId}.index.json`;
  if (result.index_path !== indexPath || result.request_path !== destination.relative) {
    throw new Error('视觉修订 consumer 返回了非服务端解析的待复核路径');
  }
  const [recipe, index, requestRecord] = await Promise.all([
    readProjectJson<VisualRecipe & { parent_revision_id?: string }>(recipePath),
    readProjectJson<VisualIndex>(indexPath),
    readProjectJson<RevisionFileRecord>(destination.relative),
  ]);
  const reviewIssues = index?.quality_summary?.review_issues || [];
  const blockingIssues = index?.quality_summary?.blocking_issues || [];
  if (
    !recipe
    || recipe.slug !== slug
    || recipe.revision_id !== revisionId
    || recipe.parent_revision_id !== baseRevisionId
    || recipe.content_archetype !== 'concept'
    || recipe.evidence_mode !== 'illustration_allowed'
    || !index
    || index.aesthetic_status !== 'review_required'
    || index.quality_summary?.status !== 'review_required'
    || (index.quality_summary.errors || []).some(Boolean)
    || blockingIssues.some(Boolean)
    || !reviewIssues.some(Boolean)
    || !index.outputs?.some((output) => output.ai_generated && output.ocr_status === 'review_required')
    || !requestRecord
    || requestRecord.status !== 'review_required'
    || requestRecord.revision_id !== revisionId
    || requestRecord.index_path !== indexPath
  ) {
    throw new Error('视觉修订 consumer 未完成待人工复核候选的原子闭环');
  }
  const recipeAssetIds = exactRecipeAssetIds(recipe);
  if (!recipeAssetIds || !(await renderedIndexArtifactsAreValid(
    index,
    slug,
    revisionId,
    recipePath,
    ['review_required'],
    recipeAssetIds,
  ))) {
    throw new Error('待人工复核候选未通过 recipe provenance、摘要或输出文件回验');
  }
  await validateRevisionRecord(requestRecord);
  return { revisionId, indexPath };
}

async function recoverPersistedRenderedResult(
  slug: string,
  baseRevisionId: string,
  destination: { relative: string; absolute: string },
): Promise<{ revisionId: string; indexPath: string } | null> {
  const requestRecord = await readProjectJson<RevisionFileRecord>(destination.relative);
  if (requestRecord?.status !== 'rendered') return null;
  try {
    return await verifyRenderedResult(slug, baseRevisionId, destination, {
      status: 'rendered',
      revision_id: requestRecord.revision_id,
      index_path: requestRecord.index_path,
      request_path: destination.relative,
    });
  } catch {
    return null;
  }
}

async function recoverPersistedReviewRequiredResult(
  slug: string,
  baseRevisionId: string,
  destination: { relative: string; absolute: string },
): Promise<{ revisionId: string; indexPath: string } | null> {
  const requestRecord = await readProjectJson<RevisionFileRecord>(destination.relative);
  if (requestRecord?.status !== 'review_required') return null;
  try {
    return await verifyReviewRequiredResult(slug, baseRevisionId, destination, {
      status: 'review_required',
      revision_id: requestRecord.revision_id,
      index_path: requestRecord.index_path,
      request_path: destination.relative,
    });
  } catch {
    return null;
  }
}

function cachedRequestDestination(
  slug: string,
  baseRevisionId: string,
  cached: RevisionRequestRecord,
): { relative: string; absolute: string } | null {
  const relative = String(cached.requestPath || '');
  const root = `pipeline/visual/${slug}/revisions/`;
  const name = relative.startsWith(root) ? relative.slice(root.length) : '';
  if (!new RegExp(`^${baseRevisionId}-request(?:-\\d{2})?\\.json$`).test(name)) return null;
  const absolute = safeResolve(PROJECT_DIR, relative);
  return absolute ? { relative, absolute } : null;
}

async function existingRevisionStateIds(slug: string): Promise<Set<string>> {
  const locations: Array<{ relative: string; pattern: RegExp }> = [
    { relative: `pipeline/visual/${slug}/recipes`, pattern: /^(r\d{3,})\.visual-recipe\.json$/ },
    { relative: `pipeline/visual/${slug}/revisions`, pattern: /^(r\d{3,})\.index\.json$/ },
    { relative: `pipeline/visual/${slug}/publish`, pattern: /^(r\d{3,})$/ },
    { relative: `pipeline/visual/${slug}/publish/render`, pattern: /^(r\d{3,})$/ },
  ];
  const ids = new Set<string>();
  for (const location of locations) {
    const absolute = safeResolve(PROJECT_DIR, location.relative);
    if (!absolute) throw new Error('视觉 revision 状态目录非法');
    try {
      for (const name of await readdir(absolute)) {
        const revisionId = name.match(location.pattern)?.[1];
        if (revisionId) ids.add(revisionId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return ids;
}

async function candidateRevisionId(result: ConsumerResult | undefined, requestPath: string): Promise<string> {
  const direct = String(result?.revision_id || '');
  if (/^r\d{3,}$/.test(direct)) return direct;
  const record = await readProjectJson<RevisionFileRecord>(requestPath);
  const persisted = String(record?.revision_id || '');
  if (/^r\d{3,}$/.test(persisted)) return persisted;
  const requestName = requestPath.split('/').pop()?.replace(/\.json$/, '') || '';
  const revisions = safeResolve(PROJECT_DIR, requestPath.split('/').slice(0, -1).join('/'));
  if (!revisions || !/^r\d{3,}-request(?:-\d{2})?$/.test(requestName)) return '';
  try {
    for (const name of await readdir(revisions)) {
      const match = name.match(/^\.(r\d{3,})\.(r\d{3,}-request(?:-\d{2})?)\.visual-recipe\.pending\.json$/);
      if (match?.[2] === requestName) return match[1];
    }
  } catch {
    return '';
  }
  return '';
}

async function cleanupFailedCandidate(slug: string, revisionId: string, preexisting: Set<string>): Promise<void> {
  if (!/^r\d{3,}$/.test(revisionId) || preexisting.has(revisionId)) return;
  const paths = [
    `pipeline/visual/${slug}/recipes/${revisionId}.visual-recipe.json`,
    `pipeline/visual/${slug}/revisions/${revisionId}.index.json`,
    `pipeline/visual/${slug}/publish/${revisionId}`,
    `pipeline/visual/${slug}/publish/render/${revisionId}`,
  ];
  await Promise.all(paths.map(async (relative) => {
    const absolute = safeResolve(PROJECT_DIR, relative);
    if (absolute) await rm(absolute, { recursive: true, force: true });
  }));
  const revisions = safeResolve(PROJECT_DIR, `pipeline/visual/${slug}/revisions`);
  if (!revisions) return;
  try {
    const names = await readdir(revisions);
    await Promise.all(names
      .filter((name) => name.startsWith(`.${revisionId}.`) && name.endsWith('.visual-recipe.pending.json'))
      .map((name) => rm(runtimeJoin(revisions, name), { force: true })));
  } catch {
    // Candidate cleanup is best-effort after the server has rejected the result.
  }
}

async function cleanupFailedCandidates(slug: string, hintedRevisionId: string, preexisting: Set<string>): Promise<void> {
  if (/^r\d{3,}$/.test(hintedRevisionId) && !preexisting.has(hintedRevisionId)) {
    await cleanupFailedCandidate(slug, hintedRevisionId, preexisting);
  }
}

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const raw = await req.json() as Record<string, unknown>;
    assertJsonInputSize(raw, '视觉修订请求', MAX_AGENT_PAYLOAD_BYTES);
    try {
      assertVisualRevisionClientShape(raw);
    } catch (error) {
      throw new InputLimitError(error instanceof Error ? error.message : '视觉修订请求字段不正确');
    }

    const slug = assertTextInput(raw.slug, 'Slug', MAX_SHORT_TEXT_BYTES).trim();
    if (!/^[a-z0-9\u4e00-\u9fff-]{1,50}$/i.test(slug)) throw new InputLimitError('Slug 格式不正确');
    const request = assertTextInput(raw.request, '修改说明', MAX_SHORT_TEXT_BYTES).trim();
    if (!request || textByteLength(request) > 2_000) throw new InputLimitError('修改说明不能为空且不得超过 2000 字节');
    const targetAssetIds = parseTargetAssetIds(raw.targetAssetIds);
    const suppliedWechatLayout = parseWechatLayout(raw.wechatLayout);
    const baseRevisionId = raw.baseRevisionId === undefined
      ? undefined
      : assertTextInput(raw.baseRevisionId, '排版版本', MAX_SHORT_TEXT_BYTES).trim();
    if (baseRevisionId !== undefined && !/^r\d{3,}$/.test(baseRevisionId)) {
      throw new InputLimitError('排版版本格式不正确');
    }

    return await withProjectWriteLock(`visual-revise:${slug}`, async () => {
      const active = await readSelectedRecipe(slug, baseRevisionId);
      if (!active) {
        const error = baseRevisionId
          ? '这套排版已经变化或未通过检查，请刷新后重试。'
          : '请先选择一个已通过检查的排版版本。';
        return expectedUserFacingErrorResponse({
          error,
          code: 'visual_selection_required',
          status: 409,
          extra: { status: 'review_required', reason: error },
        });
      }
      if (!recipeCanUseStableRevision(active.recipe)) {
        const error = '这份旧成品包含已经停用的生图内容，不能继续修改。请重新生成平台排版。';
        return expectedUserFacingErrorResponse({
          error,
          code: 'visual_ai_revision_removed',
          status: 422,
          extra: { status: 'review_required', reason: error },
        });
      }
      const wechatLayout = await verifiedWechatLayout(active.recipe, request, targetAssetIds, suppliedWechatLayout);
      const fingerprint = writeFingerprint('visual-revise', {
        slug,
        request,
        targetAssetIds,
        baseRevisionId: active.baseRevisionId,
        ...(wechatLayout ? { wechatLayout } : {}),
      });
      const cached = await readIdempotentResult<RevisionRequestRecord>(fingerprint);
      if (cached?.status === 'rendered') {
        const destination = cachedRequestDestination(slug, active.baseRevisionId, cached);
        if (destination && cached.revisionId && cached.indexPath) {
          try {
            await verifyRenderedResult(slug, active.baseRevisionId, destination, {
              status: 'rendered',
              revision_id: cached.revisionId,
              index_path: cached.indexPath,
              request_path: destination.relative,
            });
            return NextResponse.json(redactLocalPaths(cached));
          } catch {
            // Stale cache entries never bypass persisted recipe/index/output checks.
          }
        }
      }
      if (cached?.status === 'review_required') {
        const destination = cachedRequestDestination(slug, active.baseRevisionId, cached);
        if (destination && cached.revisionId && cached.indexPath) {
          const persisted = await readProjectJson<RevisionFileRecord>(destination.relative);
          if (persisted?.status === 'rendered') {
            try {
              const rendered = await verifyRenderedResult(slug, active.baseRevisionId, destination, {
                status: 'rendered',
                revision_id: cached.revisionId,
                index_path: cached.indexPath,
                request_path: destination.relative,
              });
              const response: RevisionRequestRecord = {
                ...cached,
                status: 'rendered',
                revisionId: rendered.revisionId,
                indexPath: rendered.indexPath,
              };
              await rememberIdempotentResult(fingerprint, response);
              return NextResponse.json(redactLocalPaths(response));
            } catch {
              // Fall through to strict review-candidate verification.
            }
          }
          try {
            await verifyReviewRequiredResult(slug, active.baseRevisionId, destination, {
              status: 'review_required',
              revision_id: cached.revisionId,
              index_path: cached.indexPath,
              request_path: destination.relative,
            });
            return NextResponse.json(redactLocalPaths(cached), { status: 202 });
          } catch {
            // Stale review candidates never bypass persisted recipe/index/output checks.
          }
        }
      }
      const assetIds = new Set((active.recipe.assets || []).map((asset) => String(asset.id || '')).filter(Boolean));
      const invalidIds = targetAssetIds.filter((id) => !assetIds.has(id));
      if (invalidIds.length) {
        const error = '所选图片已经变化，请重新选择。';
        return expectedUserFacingErrorResponse({
          error,
          code: 'visual_assets_changed',
          status: 400,
          extra: { status: 'review_required', reason: error },
        });
      }

      if (!wechatLayout && /颜色|配色|色板|蓝色|红色|绿色|palette/i.test(request)) {
        const error = '暂时还不能只改配色。请改成调整整体风格或版式。';
        return expectedUserFacingErrorResponse({
          error,
          code: 'visual_palette_change_unsupported',
          status: 422,
          extra: { status: 'review_required', reason: error },
        });
      }
      let operations = deterministicOperations(request);
      if (wechatLayout) {
        if (operations.some((operation) => operation !== 'change_layout')) {
          throw new WechatLayoutInputError('公众号排版微调请单独提交，不与其他内容修改合并。');
        }
        operations = ['change_layout'];
      }
      if (!operations.length) {
        operations = await parseOperationsWithConfiguredModel(request, targetAssetIds);
      }
      if (!operations.length) {
        const error = '没看懂这次要改什么。请写清楚要改的风格、版式、文案或已有资料图。';
        return expectedUserFacingErrorResponse({
          error,
          code: 'visual_revision_request_unclear',
          status: 422,
          extra: { status: 'review_required', reason: error },
        });
      }
      const operationReviewReason = revisionOperationReviewReason(active.recipe, operations, targetAssetIds, request);
      if (operationReviewReason) {
        return expectedUserFacingErrorResponse({
          error: operationReviewReason,
          code: 'visual_revision_not_applicable',
          status: 422,
          extra: { status: 'review_required', reason: operationReviewReason },
        });
      }

      const destination = await nextRequestPath(slug, active.baseRevisionId);
      const record = {
        schema: 'aifios.visual-revision-request.v1',
        base_revision_id: active.baseRevisionId,
        request,
        operations,
        ...(targetAssetIds.length ? { target_asset_ids: targetAssetIds } : {}),
        ...(wechatLayout ? { wechat_layout: wechatLayout } : {}),
        constraints: ['保留原文事实', '中文文字由代码层渲染', '不修改既有配方文件'],
        status: 'queued',
      };
      await validateRevisionRecord(record);
      await mkdir(runtimeJoin(PROJECT_DIR, 'pipeline', 'visual', slug, 'revisions'), { recursive: true });
      await writeFile(destination.absolute, JSON.stringify(record, null, 2), 'utf-8');
      const revisionsBeforeConsume = await existingRevisionStateIds(slug);
      let consumed: ConsumerResult | undefined;
      let consumerError: unknown;
      try {
        consumed = await runRevisionConsumer(slug, destination.requestId);
      } catch (error) {
        consumerError = error;
      }
      const consumedRevisionId = await candidateRevisionId(consumed, destination.relative);
      if (consumerError) {
        const recovered = await recoverPersistedRenderedResult(slug, active.baseRevisionId, destination);
        if (recovered) {
          const response: RevisionRequestRecord = {
            status: 'rendered', requestPath: destination.relative, baseRevisionId: active.baseRevisionId,
            operations, revisionId: recovered.revisionId, indexPath: recovered.indexPath,
          };
          await rememberIdempotentResult(fingerprint, response);
          return NextResponse.json(redactLocalPaths(response));
        }
        const recoveredReview = await recoverPersistedReviewRequiredResult(slug, active.baseRevisionId, destination);
        if (recoveredReview) {
          const response: RevisionRequestRecord = {
            status: 'review_required', requestPath: destination.relative, baseRevisionId: active.baseRevisionId,
            operations, revisionId: recoveredReview.revisionId, indexPath: recoveredReview.indexPath,
          };
          await rememberIdempotentResult(fingerprint, response);
          return NextResponse.json(redactLocalPaths(response), { status: 202 });
        }
        await cleanupFailedCandidates(
          slug,
          consumedRevisionId,
          revisionsBeforeConsume,
        );
        const failure = await markRequestBlocked(destination.absolute, record, consumerError);
        const response: RevisionRequestRecord = {
          status: 'blocked',
          requestPath: destination.relative,
          baseRevisionId: active.baseRevisionId,
          operations,
          reason: failure.error,
        };
        return NextResponse.json(redactLocalPaths({ ...response, ...failure }), { status: 500 });
      }

      if (consumed?.status === 'blocked') {
        const requestRecord = await readProjectJson<RevisionFileRecord>(destination.relative);
        const reason = String(requestRecord?.diagnostic_reason || consumed.reason || '视觉修订未通过 renderer 或质量门');
        const failure = await markRequestBlocked(destination.absolute, record, new Error(reason));
        await cleanupFailedCandidates(
          slug,
          consumedRevisionId,
          revisionsBeforeConsume,
        );
        const response: RevisionRequestRecord = {
          status: 'blocked',
          requestPath: destination.relative,
          baseRevisionId: active.baseRevisionId,
          operations,
          reason: failure.error,
        };
        return NextResponse.json(redactLocalPaths({ ...response, ...failure }), { status: 422 });
      }
      if (consumed?.status === 'review_required') {
        try {
          const review = await verifyReviewRequiredResult(slug, active.baseRevisionId, destination, consumed);
          const response: RevisionRequestRecord = {
            status: 'review_required',
            requestPath: destination.relative,
            baseRevisionId: active.baseRevisionId,
            operations,
            revisionId: review.revisionId,
            indexPath: review.indexPath,
          };
          await rememberIdempotentResult(fingerprint, response);
          return NextResponse.json(redactLocalPaths(response), { status: 202 });
        } catch (error) {
          await cleanupFailedCandidates(slug, consumedRevisionId, revisionsBeforeConsume);
          const failure = await markRequestBlocked(destination.absolute, record, error);
          return NextResponse.json(redactLocalPaths({
            status: 'blocked', requestPath: destination.relative, baseRevisionId: active.baseRevisionId,
            operations, reason: failure.error, ...failure,
          }), { status: 500 });
        }
      }
      if (consumed?.status !== 'rendered') {
        await cleanupFailedCandidates(
          slug,
          consumedRevisionId,
          revisionsBeforeConsume,
        );
        const failure = await markRequestBlocked(destination.absolute, record, new Error('视觉修订 consumer 未返回 rendered、review_required 或 blocked 状态'));
        return NextResponse.json(redactLocalPaths({
          status: 'blocked', requestPath: destination.relative, baseRevisionId: active.baseRevisionId,
          operations, reason: failure.error, ...failure,
        }), { status: 500 });
      }

      let rendered: { revisionId: string; indexPath: string };
      try {
        rendered = await verifyRenderedResult(slug, active.baseRevisionId, destination, consumed);
      } catch (error) {
        const recovered = await recoverPersistedRenderedResult(slug, active.baseRevisionId, destination);
        if (recovered) {
          const response: RevisionRequestRecord = {
            status: 'rendered', requestPath: destination.relative, baseRevisionId: active.baseRevisionId,
            operations, revisionId: recovered.revisionId, indexPath: recovered.indexPath,
          };
          await rememberIdempotentResult(fingerprint, response);
          return NextResponse.json(redactLocalPaths(response));
        }
        await cleanupFailedCandidates(
          slug,
          consumedRevisionId,
          revisionsBeforeConsume,
        );
        const failure = await markRequestBlocked(destination.absolute, record, error);
        return NextResponse.json(redactLocalPaths({
          status: 'blocked', requestPath: destination.relative, baseRevisionId: active.baseRevisionId,
          operations, reason: failure.error, ...failure,
        }), { status: 500 });
      }
      const response: RevisionRequestRecord = {
        status: 'rendered',
        requestPath: destination.relative,
        baseRevisionId: active.baseRevisionId,
        operations,
        revisionId: rendered.revisionId,
        indexPath: rendered.indexPath,
      };
      await rememberIdempotentResult(fingerprint, response);
      return NextResponse.json(redactLocalPaths(response));
    }, { timeoutMs: 5_000, staleMs: REVISION_TIMEOUT_MS + 60_000 });
  } catch (error) {
    if (error instanceof WechatLayoutInputError) {
      return expectedUserFacingErrorResponse({
        error: error.message,
        code: 'wechat_layout_request_invalid',
        status: error.status,
        extra: { status: 'review_required', reason: error.message },
      });
    }
    const status = error instanceof InputLimitError ? 400 : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法修改图片，请重试。',
      code: 'visual_revision_failed',
      status,
    });
  }
}
