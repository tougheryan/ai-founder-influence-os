import { stat } from 'fs/promises';
import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { generatePublishAssets } from '@/lib/publish-assets';
import type { PlatformDeliverables, PublishVisualAsset } from '@/lib/publish-assets';
import { readOutputFile } from '@/lib/output-files';
import { PROJECT_DIR, redactLocalPaths, safeResolve } from '@/lib/project-root';
import { assertJsonInputSize, assertOptionalTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { runsForPipelinePath } from '@/lib/runtime-run-resolver';
import { getRuntimeProductionApproval, registerRuntimePhaseArtifact } from '@/lib/runtime-writer';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import {
  collectDraftContentPaths,
  collectReadyAssetPaths,
  createDraftQueue,
  hashProjectFiles,
  queuePathForRun,
  readDraftQueue,
  sha256,
  type DraftQueue,
  withDraftQueueWriteLock,
  writeDraftQueue,
} from '@/lib/publish/draft-queue';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';

function assertOptionalPipelinePath(path: string | undefined, label: string, prefixes: string[]): void {
  if (!path) return;
  if (path.includes('..') || path.includes('\\')) {
    throw new InputLimitError(`${label}路径非法`);
  }
  if (!prefixes.some((prefix) => path.startsWith(prefix))) {
    throw new InputLimitError(`${label}路径不在允许范围内`);
  }
}

function selectedVisualManifestPath(slug: string): string {
  return `pipeline/visual/${slug}/selected-assets.json`;
}

function isReadyImage(asset: PublishVisualAsset): boolean {
  return asset.status === 'ready' && /\.(?:png|jpe?g|webp|gif|avif)$/i.test(asset.path);
}

function incompleteVisualDeliverableIssues(
  deliverables: PlatformDeliverables,
  requireWechatImages = true,
): string[] {
  const issues: string[] = [];
  const wechat = deliverables.wechat;
  if (wechat) {
    const readyWechatCovers = wechat.coverOptions.filter(isReadyImage);
    const readyWechatInline = wechat.visualAssets.filter((asset) => (
      isReadyImage(asset)
      && (/^inline-/i.test(asset.id || '') || /^inline-/i.test(asset.role || '') || /\/inline\//i.test(asset.path))
    ));
    if (requireWechatImages && readyWechatCovers.length < 1) issues.push('公众号缺少已采用的封面图');
    if (requireWechatImages && readyWechatInline.length < 1) issues.push('公众号缺少已采用的正文配图');
  }

  const expectedXhsPages = deliverables.moments || deliverables.douyin ? 5 : 8;
  for (const post of deliverables.xiaohongshu?.posts || []) {
    const ready = (post.platformVisualAssets?.xiaohongshu || post.visualAssets).filter(isReadyImage);
    if (ready.length !== expectedXhsPages) issues.push(`小红书观点 ${post.index} 未绑定完整 P1–P${expectedXhsPages} 套图`);
  }
  for (const post of deliverables.moments?.posts || []) {
    const ready = (post.platformVisualAssets?.moments || post.visualAssets).filter(isReadyImage);
    if (ready.length !== 3) issues.push(`朋友圈观点 ${post.index} 未绑定完整 3 张方图`);
  }
  return issues;
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(',')}}`;
}

/**
 * Compare only the approval-relevant generated payload. Adapter progress,
 * attempts, events, and statuses belong to the durable queue and must survive
 * a repeated prepare request.
 */
function hasSameGeneratedDrafts(existing: DraftQueue, generated: DraftQueue): boolean {
  if (existing.queue_id !== generated.queue_id
    || existing.run_id !== generated.run_id
    || existing.run_slug !== generated.run_slug
    || existing.package_path !== generated.package_path
    || existing.package_sha256 !== generated.package_sha256
    || existing.visual_manifest_path !== generated.visual_manifest_path
    || existing.visual_manifest_sha256 !== generated.visual_manifest_sha256
    || stableValue(existing.target_platforms) !== stableValue(generated.target_platforms)
    || existing.jobs.length !== generated.jobs.length) return false;
  const existingJobs = new Map(existing.jobs.map((job) => [job.job_id, job]));
  return generated.jobs.every((job) => {
    const saved = existingJobs.get(job.job_id);
    return Boolean(saved
      && saved.platform === job.platform
      && saved.item_id === job.item_id
      && saved.item_label === job.item_label
      && saved.delivery_kind === job.delivery_kind
      && saved.fallback_adapter === job.fallback_adapter
      && saved.payload_hash === job.payload_hash
      && saved.content_hash === job.content_hash
      && stableValue(saved.payload) === stableValue(job.payload)
      && stableValue(saved.selected_asset_hashes) === stableValue(job.selected_asset_hashes));
  });
}

async function existingDraftQueue(relativePath: string): Promise<DraftQueue | null> {
  const target = safeResolve(PROJECT_DIR, relativePath);
  if (!target) throw new InputLimitError('发布队列路径非法');
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('发布队列不是普通文件。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return readDraftQueue(relativePath);
}

async function existingPipelinePath(path: string | undefined, label: string): Promise<string> {
  if (!path) return '';
  const safePath = safeResolve(PROJECT_DIR, path);
  if (!safePath) throw new InputLimitError(`${label}路径非法`);
  try {
    const info = await stat(safePath);
    if (info.isFile()) return path;
  } catch {
    // Handled below with a user-facing error.
  }
  throw new InputLimitError(`${label}文件不存在：${path}。请重新运行对应平台成稿，或从第 4 步继续生成。`);
}

async function optionalExistingPipelinePath(path: string | undefined): Promise<string> {
  if (!path) return '';
  const safePath = safeResolve(PROJECT_DIR, path);
  if (!safePath) return '';
  try {
    const info = await stat(safePath);
    return info.isFile() ? path : '';
  } catch {
    return '';
  }
}

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as {
      slug?: unknown;
      topic?: unknown;
      packagePath?: unknown;
      writePath?: unknown;
      xhsPath?: unknown;
      visualPlanPath?: unknown;
    };
    assertJsonInputSize(body, '平台发布成稿参数', MAX_AGENT_PAYLOAD_BYTES);

    const requestedSlug = assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim();
    const topic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim();
    const packagePath = assertOptionalTextInput(body.packagePath, '全平台内容包路径', MAX_SHORT_TEXT_BYTES)?.trim();
    const writePath = assertOptionalTextInput(body.writePath, '公众号成稿路径', MAX_SHORT_TEXT_BYTES)?.trim();
    const xhsPath = assertOptionalTextInput(body.xhsPath, '小红书成稿路径', MAX_SHORT_TEXT_BYTES)?.trim();
    const visualPlanPath = assertOptionalTextInput(body.visualPlanPath, '视觉计划路径', MAX_SHORT_TEXT_BYTES)?.trim();

    assertOptionalPipelinePath(packagePath, '全平台内容包', ['pipeline/package/']);
    assertOptionalPipelinePath(writePath, '公众号成稿', ['pipeline/write/', 'pipeline/final/']);
    assertOptionalPipelinePath(xhsPath, '小红书成稿', ['pipeline/xhs/']);
    assertOptionalPipelinePath(visualPlanPath, '视觉计划', ['pipeline/visual/']);

    const existingPackagePath = packagePath
      ? await existingPipelinePath(packagePath, '全平台内容包')
      : '';
    const existingWritePath = writePath ? await existingPipelinePath(writePath, '公众号成稿') : '';
    const existingXhsPath = xhsPath ? await existingPipelinePath(xhsPath, '小红书成稿') : '';
    const requestedVisualPlanPath = await optionalExistingPipelinePath(visualPlanPath);

    if (!existingPackagePath) {
      return expectedUserFacingErrorResponse({
        error: '请先生成并确认完整的全平台内容，再准备发布草稿。',
        code: 'content_package_required',
        status: 400,
      });
    }
    const packageBody = await readOutputFile(existingPackagePath);

    const packageRun = (await runsForPipelinePath(existingPackagePath, 'package'))
      .find((run) => run.run_id && run.steps?.package?.latest === existingPackagePath);
    if (!packageRun?.run_id || !packageRun.slug) {
      return expectedUserFacingErrorResponse({
        error: '这份内容不是当前版本，请刷新后重新选择。',
        code: 'content_package_not_current',
        status: 400,
      });
    }
    const packageRunId = packageRun.run_id;
    const packageRunSlug = packageRun.slug;
    const selectedPlatforms = packageRun.selected_platforms || packageRun.target_platforms || ['wechat', 'xhs', 'shipinhao'];
    const visualRequired = selectedPlatforms.some((platform) => platform === 'wechat' || platform === 'xhs' || platform === 'xiaohongshu');
    if (requestedSlug && requestedSlug !== packageRunSlug) {
      return expectedUserFacingErrorResponse({
        error: '这份内容不属于当前任务，请刷新后重新选择。',
        code: 'content_package_task_mismatch',
        status: 400,
      });
    }
    // The content package has already passed the explicit six-unit human
    // confirmation in the production workbench. Do not run a second AI
    // expression/release gate here; keep the approved artifact bytes intact.
    const packageApproval = await getRuntimeProductionApproval('content_package', existingPackagePath, packageRunId);
    if (!packageApproval.approved) {
      return expectedUserFacingErrorResponse({
        error: '请先确认最终内容，再准备平台草稿。',
        code: 'content_package_approval_required',
        status: 409,
      });
    }

    const visualManifestPath = visualRequired ? selectedVisualManifestPath(packageRunSlug) : '';
    if (requestedVisualPlanPath && requestedVisualPlanPath !== visualManifestPath) {
      return expectedUserFacingErrorResponse({
        error: '图片选择已发生变化，请刷新后重新选择。',
        code: 'visual_selection_task_mismatch',
        status: 400,
      });
    }
    if (visualRequired) {
      try {
        await hashProjectFiles([visualManifestPath]);
      } catch {
        return expectedUserFacingErrorResponse({
          error: '请先为本期图文平台选择图片，再准备平台草稿。',
          code: 'visual_selection_required',
          status: 409,
        });
      }
      const visualApproval = await getRuntimeProductionApproval('visual_assets', visualManifestPath, packageRunId);
      if (!visualApproval.approved) {
        return expectedUserFacingErrorResponse({
          error: '请先确认本期图文平台使用的图片，再准备平台草稿。',
          code: 'visual_approval_required',
          status: 409,
        });
      }
    }

    const draftQueuePath = queuePathForRun(packageRunSlug);
    const prepared = await withProjectWriteLock(`publish-assets:${packageRunId}`, async () => {
      const result = await generatePublishAssets({
        // The runtime run is authoritative. The production workbench normally
        // submits only packagePath, so deriving a slug from the timestamped
        // package filename would point at a non-existent visual directory.
        slug: packageRunSlug,
        topic,
        packagePath: existingPackagePath,
        writePath: existingWritePath,
        xhsPath: existingXhsPath,
        visualPlanPath: visualManifestPath || undefined,
      });

      const visualIssues = incompleteVisualDeliverableIssues(
        result.platformDeliverables,
        false,
      );
      if (visualIssues.length) return { result, visualIssues };

      const readyAssetPaths = collectReadyAssetPaths(result.platformDeliverables);
      const [assetHashes, contentFileHashes, visualHashes] = await Promise.all([
        hashProjectFiles(readyAssetPaths),
        hashProjectFiles(collectDraftContentPaths(result.platformDeliverables)),
        visualManifestPath ? hashProjectFiles([visualManifestPath]) : Promise.resolve({} as Record<string, string>),
      ]);
      const draftQueue = createDraftQueue({
        runId: packageRunId,
        runSlug: packageRunSlug,
        packagePath: existingPackagePath,
        packageSha256: sha256(packageBody),
        deliverables: result.platformDeliverables,
        visualManifestPath: visualManifestPath || undefined,
        visualManifestSha256: visualManifestPath ? visualHashes[visualManifestPath] : undefined,
        assetHashes,
        contentFileHashes,
      });
      const saved = await withDraftQueueWriteLock(draftQueuePath, async () => {
        const existing = await existingDraftQueue(draftQueuePath);
        if (existing && hasSameGeneratedDrafts(existing, draftQueue)) {
          return { queue: existing, idempotent: true };
        }
        await writeDraftQueue(draftQueuePath, draftQueue);
        return { queue: await readDraftQueue(draftQueuePath), idempotent: false };
      });
      const draftRegistration = await registerRuntimePhaseArtifact(
        'draft_information',
        draftQueuePath,
        packageRunId,
      );
      return { result, visualIssues: [], saved, draftRegistration };
    });

    if (prepared.visualIssues.length) {
      return expectedUserFacingErrorResponse({
        error: '部分平台还缺少图片，请补齐后再继续。',
        code: 'visual_assets_incomplete',
        status: 409,
        extra: { issues: prepared.visualIssues },
      });
    }

    return NextResponse.json(redactLocalPaths({
      ok: true,
      ...prepared.result,
      draftQueue: prepared.saved?.queue,
      draftQueuePath,
      draftRegistration: prepared.draftRegistration,
      idempotent_replay: prepared.saved?.idempotent === true,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法准备平台草稿，请重试。',
      code: 'publish_assets_prepare_failed',
      status,
    });
  }
}
