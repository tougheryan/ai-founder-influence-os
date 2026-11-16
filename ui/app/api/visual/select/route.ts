import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import {
  expectedUserFacingErrorResponse,
  KnownUserFacingError,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';
import { InputLimitError, assertJsonInputSize, assertTextInput, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { PROJECT_DIR, redactLocalPaths, runtimeJoin, safeResolve, skillPath } from '@/lib/project-root';
import { validateVisualRevisionArtifacts } from '@/lib/visual-workbench';
import { WriteLockError, withProjectWriteLock } from '@/lib/write-guard';

type IntegrityRole = 'recipe' | 'index' | 'output' | 'platform_delivery';

type IntegrityFile = {
  role: IntegrityRole;
  path: string;
  size: number;
  sha256: string;
  id?: string;
};

type IntegrityRead = {
  bytes: Buffer;
  file: IntegrityFile;
};

class VisualSelectionIntegrityError extends Error {}

let visualRecipeValidator: ValidateFunction | null = null;

function selectionConflict(message: string): never {
  throw new VisualSelectionIntegrityError(message);
}

function isRevisionOutputPath(value: unknown, slug: string, revisionId: string): value is string {
  if (typeof value !== 'string' || value.includes('\\')) return false;
  const root = `pipeline/visual/${slug}/publish/${revisionId}/`;
  const segments = value.split('/');
  return value.startsWith(root) && !segments.some((segment) => !segment || segment === '.' || segment === '..');
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      selectionConflict(`${label}不是有效的 JSON 对象`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof VisualSelectionIntegrityError) throw error;
    return selectionConflict(`${label}不是有效的 JSON 文件`);
  }
}

function isSafeProjectRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim()) return false;
  if (value.includes('\\') || value.includes('\0') || [...value].some((character) => character.charCodeAt(0) < 32)) {
    return false;
  }
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

async function assertVisualRecipeContract(
  recipe: Record<string, unknown>,
  slug: string,
  revisionId: string,
): Promise<void> {
  if (!visualRecipeValidator) {
    const schema = JSON.parse(await readFile(
      skillPath('content-runtime', 'schemas', 'visual-recipe.schema.json'),
      'utf-8',
    )) as Record<string, unknown>;
    visualRecipeValidator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  }
  if (!visualRecipeValidator(recipe)) {
    const detail = (visualRecipeValidator.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'invalid'}`)
      .join('; ');
    selectionConflict(`视觉配方未通过 schema：${detail}`);
  }

  if (recipe.slug !== slug || recipe.revision_id !== revisionId) {
    selectionConflict('视觉配方与待采用版本不一致');
  }
  if (recipe.parent_revision_id !== undefined
    && (typeof recipe.parent_revision_id !== 'string' || !/^r\d{3,}$/.test(recipe.parent_revision_id))) {
    selectionConflict('视觉配方的父版本 ID 格式不正确');
  }
  if (!isSafeProjectRelativePath(recipe.source_package)
    || (recipe.recipe_path !== undefined && !isSafeProjectRelativePath(recipe.recipe_path))) {
    selectionConflict('视觉配方包含不安全的项目路径');
  }

  const sourceAssets = recipe.source_assets ?? [];
  if (!Array.isArray(sourceAssets) || sourceAssets.some((source) => !isSafeProjectRelativePath(source))) {
    selectionConflict('视觉配方的来源资产路径不合法');
  }

  const platforms = recipe.platforms as Record<string, unknown>;
  const wechat = platforms.wechat as Record<string, unknown> | undefined;
  const xhs = platforms.xhs as Record<string, unknown> | undefined;
  if ((!wechat && !xhs)
    || (wechat && (typeof wechat.system !== 'string' || !wechat.system))
    || (xhs && (typeof xhs.system !== 'string' || !xhs.system
      || !Array.isArray(xhs.page_recipes) || ![5, 8].includes(xhs.page_recipes.length)))) {
    selectionConflict('视觉配方的平台配置不完整');
  }

  const assets = recipe.assets as Array<Record<string, unknown>>;
  const assetIds = new Set<string>();
  for (const asset of assets) {
    const assetId = asset.id;
    if (typeof assetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(assetId)) {
      selectionConflict('视觉配方包含不安全的资产 ID');
    }
    if (assetIds.has(assetId)) {
      selectionConflict(`视觉配方包含重复的资产 ID：${assetId}`);
    }
    assetIds.add(assetId);
    if (asset.source !== undefined && !isSafeProjectRelativePath(asset.source)) {
      selectionConflict(`视觉资产 ${assetId} 的来源路径不合法`);
    }
    if (asset.output !== undefined && !isSafeProjectRelativePath(asset.output)) {
      selectionConflict(`视觉资产 ${assetId} 的输出路径不合法`);
    }
  }

  const xhsPosts = new Set(
    assets.flatMap((asset) => {
      const match = typeof asset.id === 'string' ? asset.id.match(/^xhs-(\d+)-p[1-8]$/i) : null;
      return match ? [match[1]] : [];
    }),
  );
  const momentsAssetIds = assets.flatMap((asset) => (
    asset.platform === 'moments' && typeof asset.id === 'string' ? [asset.id] : []
  ));
  if (momentsAssetIds.length > 0) {
    const moments = platforms.moments;
    if (!moments || typeof moments !== 'object' || Array.isArray(moments)) {
      selectionConflict('三条观点图文必须包含朋友圈 1:1 图组配置');
    }
    const momentsConfig = moments as Record<string, unknown>;
    const series = momentsConfig.series;
    if (momentsConfig.format !== 'square_triptych' || !Array.isArray(series)) {
      selectionConflict('朋友圈视觉配置必须声明 square_triptych 1:1 图组');
    }
    const declaredIds = new Set(
      series.flatMap((item) => (
        item && typeof item === 'object' && !Array.isArray(item) && Array.isArray((item as Record<string, unknown>).asset_ids)
          ? (item as Record<string, unknown>).asset_ids as unknown[]
          : []
      )).filter((id): id is string => typeof id === 'string'),
    );
    const expectedIds = new Set(
      [...xhsPosts].flatMap((post) => [1, 3, 5].map((page) => `moments-${post.padStart(2, '0')}-p${page}`)),
    );
    if (
      momentsAssetIds.some((id) => !/^moments-\d+-p[135]$/i.test(id))
      || [...expectedIds].some((id) => !assetIds.has(id) || !declaredIds.has(id))
    ) {
      selectionConflict('朋友圈视觉配置缺少 P1、P3、P5 的独立 1:1 资产');
    }
  } else if (xhs?.platform_bindings !== undefined) {
    const bindings = xhs.platform_bindings;
    if (!Array.isArray(bindings) || !['xiaohongshu', 'xiaohongshu,moments'].includes(bindings.join(','))) {
      selectionConflict('小红书视觉套图必须绑定小红书；旧版可同时绑定朋友圈');
    }
  }
}

function assertMomentsDeliveryContract(
  recipe: Record<string, unknown>,
  index: Record<string, unknown>,
  delivery: Record<string, unknown>,
): void {
  const assets = Array.isArray(recipe.assets) ? recipe.assets as Array<Record<string, unknown>> : [];
  const expectedIds = assets.flatMap((asset) => (
    asset.platform === 'moments' && typeof asset.id === 'string' ? [asset.id] : []
  ));
  const platforms = recipe.platforms as Record<string, unknown> | undefined;
  const xhs = platforms?.xhs as Record<string, unknown> | undefined;
  const sharedSocial = Array.isArray(xhs?.platform_bindings)
    && (xhs?.platform_bindings as unknown[]).join(',') === 'xiaohongshu,moments';
  if (!expectedIds.length && !sharedSocial) return;
  const moments = delivery.moments;
  if (!moments || typeof moments !== 'object' || Array.isArray(moments)) {
    selectionConflict('平台视觉交付清单缺少朋友圈图文套图');
  }
  const posts = (moments as Record<string, unknown>).posts;
  if (!Array.isArray(posts)) selectionConflict('平台视觉交付清单缺少朋友圈图组页序');
  const outputPaths = new Map(
    (Array.isArray(index.outputs) ? index.outputs : []).flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const output = value as Record<string, unknown>;
      return typeof output.id === 'string' && typeof output.output === 'string'
        ? [[output.id, output.output] as const]
        : [];
    }),
  );
  const seen = new Set<string>();
  if (sharedSocial) {
    const expectedSharedIds = assets.flatMap((asset) => (
      typeof asset.id === 'string' && /^xhs-\d+-p[1-5]$/i.test(asset.id) ? [asset.id] : []
    ));
    for (const post of posts) {
      if (!post || typeof post !== 'object' || Array.isArray(post)) {
        selectionConflict('平台视觉交付清单包含无效的朋友圈图组');
      }
      const record = post as Record<string, unknown>;
      if (record.upload_mode !== 'shared_carousel' || record.upload_format !== '3:4' || !Array.isArray(record.pages)) {
        selectionConflict('朋友圈必须复用小红书 3:4 完整套图');
      }
      const pages = record.pages as Array<Record<string, unknown>>;
      if (pages.length !== 5 || pages.map((page) => page.page_id).join(',') !== 'P1,P2,P3,P4,P5') {
        selectionConflict('朋友圈共享套图必须按 P1–P5 顺序包含五张图片');
      }
      for (const page of pages) {
        if (
          typeof page.asset_id !== 'string'
          || !expectedSharedIds.includes(page.asset_id)
          || page.path !== outputPaths.get(page.asset_id)
        ) {
          selectionConflict('朋友圈共享套图必须绑定对应的小红书已生成资产');
        }
        seen.add(page.asset_id);
      }
    }
    if (expectedSharedIds.some((id) => !seen.has(id))) {
      selectionConflict('平台视觉交付清单未覆盖全部共享 P1–P5 资产');
    }
    return;
  }
  for (const post of posts) {
    if (!post || typeof post !== 'object' || Array.isArray(post)) {
      selectionConflict('平台视觉交付清单包含无效的朋友圈图组');
    }
    const record = post as Record<string, unknown>;
    if (record.upload_mode !== 'square_triptych' || record.upload_format !== '1:1' || !Array.isArray(record.pages)) {
      selectionConflict('朋友圈图组必须是可直接上传的 1:1 square_triptych');
    }
    const pages = record.pages as unknown[];
    if (pages.length !== 3) selectionConflict('朋友圈图组必须包含三张 1:1 图片');
    const pageIds = pages.flatMap((page) => (
      page && typeof page === 'object' && !Array.isArray(page) ? [(page as Record<string, unknown>).page_id] : []
    ));
    if (pageIds.join(',') !== 'P1,P3,P5') {
      selectionConflict('朋友圈图组必须按 P1、P3、P5 顺序上传');
    }
    for (const page of pages) {
      if (!page || typeof page !== 'object' || Array.isArray(page)) continue;
      const item = page as Record<string, unknown>;
      if (
        typeof item.asset_id !== 'string'
        || !expectedIds.includes(item.asset_id)
        || item.path !== outputPaths.get(item.asset_id)
        || item.width !== 1080
        || item.height !== 1080
      ) {
        selectionConflict('朋友圈图组必须绑定对应的 1080x1080 已生成资产');
      }
      seen.add(item.asset_id);
    }
  }
  if (expectedIds.some((id) => !seen.has(id))) {
    selectionConflict('平台视觉交付清单未覆盖全部朋友圈 1:1 图组资产');
  }
}

async function assertSelectionTargetPath(relativePath: string): Promise<string> {
  const target = safeResolve(PROJECT_DIR, relativePath);
  if (!target) throw new InputLimitError('采用版本路径非法');

  const components = relative(PROJECT_DIR, target).split(sep);
  let current = PROJECT_DIR;
  for (const [index, component] of components.entries()) {
    current = runtimeJoin(current, component);
    try {
      const file = await lstat(current);
      if (file.isSymbolicLink()) {
        selectionConflict('采用版本路径不能包含符号链接');
      }
      if (index < components.length - 1 && !file.isDirectory()) {
        selectionConflict('采用版本路径的父级不是目录');
      }
      if (index === components.length - 1 && !file.isFile()) {
        selectionConflict('采用版本指针不是普通文件');
      }
    } catch (error) {
      if (error instanceof VisualSelectionIntegrityError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && index === components.length - 1) {
        return target;
      }
      selectionConflict('采用版本路径无法安全访问');
    }
  }
  return target;
}

async function writeSelectionPointer(target: string, contents: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      target,
      constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      selectionConflict('采用版本指针不能是符号链接');
    }
    selectionConflict('采用版本指针无法安全写入');
  } finally {
    await handle?.close();
  }
}

async function readIntegrityFile(
  role: IntegrityRole,
  relativePath: string,
  projectRealPath: string,
  id?: string,
): Promise<IntegrityRead> {
  const absolutePath = safeResolve(PROJECT_DIR, relativePath);
  if (!absolutePath) selectionConflict(`视觉${role}路径非法`);

  try {
    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink()) selectionConflict(`视觉${role}不能是符号链接`);
    if (!fileStat.isFile()) selectionConflict(`视觉${role}不是普通文件`);

    const resolvedPath = await realpath(absolutePath);
    if (!resolvedPath.startsWith(`${projectRealPath}${sep}`)) {
      selectionConflict(`视觉${role}的真实路径位于项目目录之外`);
    }

    const bytes = await readFile(absolutePath);
    if (bytes.byteLength === 0) selectionConflict(`视觉${role}不能为空`);
    return {
      bytes,
      file: {
        role,
        path: relativePath,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(id ? { id } : {}),
      },
    };
  } catch (error) {
    if (error instanceof VisualSelectionIntegrityError) throw error;
    return selectionConflict(`视觉${role}无法读取`);
  }
}

async function buildSelectionIntegrity(
  slug: string,
  revisionId: string,
  recipePath: string,
  indexPath: string,
): Promise<{ algorithm: 'sha256'; files: IntegrityFile[] }> {
  let projectRealPath: string;
  try {
    projectRealPath = await realpath(PROJECT_DIR);
  } catch {
    return selectionConflict('项目目录无法读取');
  }

  const [recipeRead, indexRead] = await Promise.all([
    readIntegrityFile('recipe', recipePath, projectRealPath),
    readIntegrityFile('index', indexPath, projectRealPath),
  ]);
  const recipe = parseJsonObject(recipeRead.bytes, '视觉配方');
  const index = parseJsonObject(indexRead.bytes, '视觉发布索引');

  await assertVisualRecipeContract(recipe, slug, revisionId);
  if (index.schema !== 'aifios.visual-publish.v1') {
    selectionConflict('视觉发布索引 schema 不受支持');
  }
  if (index.slug !== slug || index.revision_id !== revisionId || index.recipe_path !== recipePath
    || index.revision_index_path !== indexPath) {
    selectionConflict('视觉发布索引与待采用版本不一致');
  }
  if (index.legacy !== false || index.status !== 'generated') {
    selectionConflict('视觉发布索引不是可采用的已生成版本');
  }
  const qualitySummary = index.quality_summary;
  if (!qualitySummary || typeof qualitySummary !== 'object' || Array.isArray(qualitySummary)
    || (qualitySummary as Record<string, unknown>).status !== 'pass') {
    selectionConflict('视觉发布索引未通过质量门');
  }
  const qualityErrors = (qualitySummary as Record<string, unknown>).errors;
  if (Array.isArray(qualityErrors) && qualityErrors.some((error) => Boolean(error))) {
    selectionConflict('视觉发布索引仍包含质量错误');
  }
  if (index.aesthetic_status && index.aesthetic_status !== 'pass') {
    selectionConflict('视觉发布索引未通过审美质量门');
  }
  if (!Array.isArray(index.outputs) || index.outputs.length === 0) {
    selectionConflict('视觉发布索引没有可采用的输出资产');
  }

  const recipeAssetIds = new Set(
    (recipe.assets as Array<Record<string, unknown>>).map((asset) => asset.id as string),
  );
  const outputIds = new Set<string>();
  const outputs = index.outputs.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return selectionConflict('视觉发布索引包含无效的输出记录');
    }
    const output = value as Record<string, unknown>;
    if (output.renderer !== 'local' || output.recipe_path !== recipePath
      || output.status !== 'generated' || output.revision_id !== revisionId) {
      return selectionConflict('视觉输出不是由目标配方在本地生成');
    }
    if (!isRevisionOutputPath(output.output, slug, revisionId)) {
      return selectionConflict('视觉输出路径不属于待采用版本');
    }
    if (typeof output.id !== 'string' || !output.id || !recipeAssetIds.has(output.id)) {
      return selectionConflict('视觉输出 ID 必须非空且属于目标配方');
    }
    if (outputIds.has(output.id)) {
      return selectionConflict(`视觉发布索引包含重复的输出 ID：${output.id}`);
    }
    outputIds.add(output.id);
    return {
      id: output.id,
      path: output.output,
      size: output.size,
      sha256: output.sha256,
    };
  });
  const missingOutputIds = [...recipeAssetIds].filter((assetId) => !outputIds.has(assetId));
  if (missingOutputIds.length > 0) {
    selectionConflict(`视觉发布索引缺少配方资产输出：${missingOutputIds.join('、')}`);
  }
  for (const output of outputs) {
    if (!Number.isInteger(output.size) || Number(output.size) <= 0
      || typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(output.sha256)) {
      selectionConflict('视觉输出缺少有效的 size 或 sha256 摘要');
    }
  }
  const outputReads = await Promise.all(outputs.map((output) => (
    readIntegrityFile('output', output.path, projectRealPath, output.id)
  )));
  outputReads.forEach((output, index) => {
    if (output.file.size !== outputs[index].size || output.file.sha256 !== outputs[index].sha256) {
      selectionConflict('视觉输出摘要与发布索引不一致');
    }
  });
  let platformDeliveryRead: IntegrityRead | null = null;
  if (index.platform_delivery_manifest !== undefined) {
    if (!isRevisionOutputPath(index.platform_delivery_manifest, slug, revisionId)) {
      selectionConflict('平台视觉交付清单不属于待采用版本');
    }
    platformDeliveryRead = await readIntegrityFile(
      'platform_delivery',
      index.platform_delivery_manifest,
      projectRealPath,
    );
    const platformDelivery = parseJsonObject(platformDeliveryRead.bytes, '平台视觉交付清单');
    if (!['aifios.platform-visual-delivery.v1', 'echo-founder.platform-visual-delivery.v2'].includes(String(platformDelivery.schema))
      || platformDelivery.slug !== slug || platformDelivery.revision_id !== revisionId) {
      selectionConflict('平台视觉交付清单与待采用版本不一致');
    }
    assertMomentsDeliveryContract(recipe, index, platformDelivery);
  } else {
    assertMomentsDeliveryContract(recipe, index, {});
  }

  return {
    algorithm: 'sha256',
    files: [
      recipeRead.file,
      indexRead.file,
      ...outputReads.map((output) => output.file),
      ...(platformDeliveryRead ? [platformDeliveryRead.file] : []),
    ],
  };
}

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const raw = await req.json() as Record<string, unknown>;
    assertJsonInputSize(raw, '采用视觉版本请求', MAX_AGENT_PAYLOAD_BYTES);
    if (Object.keys(raw).some((key) => key !== 'slug' && key !== 'revisionId')) {
      throw new InputLimitError('采用版本不接受路径或配方内容');
    }
    const slug = assertTextInput(raw.slug, 'Slug', MAX_SHORT_TEXT_BYTES).trim();
    const revisionId = assertTextInput(raw.revisionId, '版本 ID', MAX_SHORT_TEXT_BYTES).trim();
    if (!/^[a-z0-9\u4e00-\u9fff-]{1,50}$/i.test(slug) || !/^r\d{3,}$/.test(revisionId)) {
      throw new InputLimitError('Slug 或版本 ID 格式不正确');
    }

    return await withProjectWriteLock(`visual-select:${slug}`, async () => {
      const validation = await validateVisualRevisionArtifacts(slug, revisionId);
      if (!validation.valid) {
        return expectedUserFacingErrorResponse({
          error: '这个图片版本已失效或未通过检查，请重新生成。',
          code: 'visual_revision_not_ready',
          status: 409,
        });
      }
      const integrity = await buildSelectionIntegrity(
        slug,
        revisionId,
        validation.recipePath,
        validation.indexPath,
      );
      const relativePath = runtimeJoin('pipeline', 'visual', slug, 'selected-revision.json');
      const target = await assertSelectionTargetPath(relativePath);
      await writeSelectionPointer(target, JSON.stringify({
        schema: 'aifios.visual-selection.v1',
        slug,
        revision_id: revisionId,
        integrity,
      }, null, 2));
      return NextResponse.json(redactLocalPaths({ status: 'selected', slug, revisionId }));
    }, { timeoutMs: 5_000 });
  } catch (error) {
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof WriteLockError || error instanceof VisualSelectionIntegrityError
        ? 409
        : 500;
    const cause = error instanceof VisualSelectionIntegrityError
      ? new KnownUserFacingError({
        error: '这个图片版本的文件不完整，请重新生成。',
        code: 'visual_selection_integrity_failed',
      }, { status: 409, detail: error })
      : error;
    return userFacingErrorResponse(cause, {
      error: '暂时无法使用这个图片版本，请重试。',
      code: 'visual_selection_failed',
      status,
    });
  }
}
