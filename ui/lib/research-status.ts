import 'server-only';

import { lstat, readFile, readdir } from 'node:fs/promises';
import { PROJECT_DIR, safeResolve } from './project-root';
import { runtimeRunById } from './runtime-run-resolver';
import { verifyRuntimeAuthorSource, verifyFrozenRuntimeTikomniMarketSnapshot, verifyRuntimeTikomniMarketSnapshot } from './runtime-writer';

export type CurrentResearchStatus = {
  runId: string | null; title: string; state: 'no_run' | 'author_material' | 'not_collected' | 'collected' | 'current' | 'stale' | 'unavailable';
  checkedAt: string; collectedAt: string | null; reason: string;
  platforms: Array<{ id: string; label: string; status: 'available' | 'unavailable' | 'unknown'; sampleCount: number | null }>;
  lastAttempt: { status: string; startedAt: string; completedAt: string | null } | null;
};
export class ResearchStatusInputError extends Error {}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const platforms: Record<string, [string, string]> = { wechat: ['wechat_mp', '公众号'], wechat_mp: ['wechat_mp', '公众号'], xhs: ['xiaohongshu', '小红书'], xiaohongshu: ['xiaohongshu', '小红书'], shipinhao: ['wechat_channels', '视频号'], wechat_channels: ['wechat_channels', '视频号'] };

async function safePath(path: string) {
  const absolute = safeResolve(PROJECT_DIR, path);
  const parts = path.split('/');
  if (!absolute || path.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid research record path');
  for (let index = 0; index < parts.length; index += 1) {
    const stat = await lstat(safeResolve(PROJECT_DIR, parts.slice(0, index + 1).join('/'))!);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error('Invalid research record file');
  }
  return absolute;
}
async function json(path: string) { return object(JSON.parse(await readFile(await safePath(path), 'utf8'))); }

type ResearchAttempt = NonNullable<CurrentResearchStatus['lastAttempt']> & { snapshotPath: string; snapshotSha256: string };
async function researchAttempts(runId: string): Promise<ResearchAttempt[]> {
  let files: string[];
  try { files = await readdir(await safePath(`runs/${runId}/tasks`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const attempts: ResearchAttempt[] = [];
  for (const name of files.filter((name) => /^[A-Za-z0-9_-]{1,120}\.json$/.test(name))) {
    const task = await json(`runs/${runId}/tasks/${name}`);
    if (task.runId !== runId || !Array.isArray(task.steps)) continue;
    const step = task.steps.map(object).find((item) => item.id === 'market-research' && text(item.startedAt));
    if (step) {
      const result = object(step.result);
      attempts.push({ status: text(step.status) || 'unknown', startedAt: text(step.startedAt), completedAt: text(step.completedAt) || null, snapshotPath: text(result.snapshotPath), snapshotSha256: text(result.snapshotSha256) });
    }
  }
  return attempts.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Verify this run's selected evidence or its completed, not-yet-selected collection. Never starts collection. */
export async function readCurrentResearchStatus(runId: string): Promise<CurrentResearchStatus> {
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) throw new ResearchStatusInputError('请先打开一份草稿，再查看它的研究记录。');
  const run = await runtimeRunById(runId);
  const result: CurrentResearchStatus = { runId: run?.run_id || null, title: run?.topic || run?.slug || '', state: 'no_run', checkedAt: new Date().toISOString(), collectedAt: null, reason: '这份草稿关联的任务暂时无法读取，请回到工作台核对；没有改为显示其他任务。', platforms: [], lastAttempt: null };
  if (!run?.run_id || !run.slug || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(run.run_id)) return result;
  if (run.research_mode === 'author_material') {
    try {
      await verifyRuntimeAuthorSource(runId);
      result.state = 'author_material';
      result.reason = '本期按自己的题目写，素材依据已保存，未进行平台研究。以前的研究文件保留，但不作为本期写作依据。';
    } catch {
      result.state = 'stale';
      result.reason = '本期按自己的题目写，但素材依据已变化或无法核对。请返回素材页重新确认；不会自动采集平台数据。';
    }
    return result;
  }
  result.state = 'not_collected'; result.reason = '这期还没有保存可核对的研究结果。';
  const selected = run.selected_platforms || run.target_platforms || [];
  result.platforms = [...new Set(selected.map((id) => platforms[id]?.[0]).filter(Boolean))].map((id) => ({ id, label: platforms[id][1], status: 'unknown', sampleCount: null }));
  let attempts: ResearchAttempt[] = [];
  try {
    attempts = await researchAttempts(run.run_id);
    const latest = attempts[0];
    if (latest) result.lastAttempt = { status: latest.status, startedAt: latest.startedAt, completedAt: latest.completedAt };
  }
  catch { result.reason = '本期采集记录暂时无法完整读取。'; }
  let pointerRead = false;
  try {
    let pointer: Record<string, unknown>;
    let selectedSnapshot = true;
    try { pointer = await json(`runs/${run.run_id}/market-research/frozen-snapshot.json`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const collected = attempts.find((attempt) => attempt.status === 'completed' && attempt.snapshotPath && attempt.snapshotSha256);
      if (!collected) return result;
      selectedSnapshot = false;
      pointer = { run_id: run.run_id, manifest_path: collected.snapshotPath, snapshot_sha256: collected.snapshotSha256 };
    }
    pointerRead = true;
    const manifestPath = text(pointer.manifest_path);
    if (pointer.run_id !== run.run_id || !new RegExp(`^runs/${run.run_id}/market-research/[^/\\\\]+/snapshot\\.json$`).test(manifestPath)) throw new Error('Snapshot belongs to another run');
    const manifest = await json(manifestPath);
    const verification = selectedSnapshot
      ? await verifyFrozenRuntimeTikomniMarketSnapshot(run.run_id)
      : await verifyRuntimeTikomniMarketSnapshot(run.run_id, manifestPath);
    if (!verification.verified || verification.run_id !== run.run_id || verification.manifest_path !== manifestPath || verification.snapshot_sha256 !== pointer.snapshot_sha256 || manifest.sha256 !== pointer.snapshot_sha256 || manifest.run_id !== run.run_id) throw new Error('Snapshot verification failed');
    result.collectedAt = text(manifest.created_at) || null;
    if (verification.source_path !== run.steps?.intake?.latest) {
      result.state = 'stale'; result.reason = '素材已更新，已有研究属于旧素材。请回到本期内容核对后更新研究。'; return result;
    }
    const checks = object(manifest.platform_checks);
    if (!result.platforms.length && Array.isArray(manifest.required_platforms)) result.platforms = manifest.required_platforms.filter((id): id is string => typeof id === 'string' && Boolean(platforms[id])).map((id) => ({ id, label: platforms[id][1], status: 'unknown', sampleCount: null }));
    result.platforms = result.platforms.map((platform) => {
      const check = object(checks[platform.id]);
      return { ...platform, status: check.status === 'available' ? 'available' : check.status === 'unavailable' ? 'unavailable' : 'unknown', sampleCount: count(check.sample_count) };
    });
    result.state = selectedSnapshot ? 'current' : 'collected';
    result.reason = selectedSnapshot
      ? '已有研究与这期素材对应。这里只核对本地存档，没有重新连接数据服务；样本表现仍需逐条判断。'
      : '这期研究已经保存，还等你核对并确认使用。请回到本期查看样本和选题；这里只读取存档，不会重新采集。';
  } catch (error) {
    if (pointerRead || (error as NodeJS.ErrnoException).code !== 'ENOENT') { result.state = 'unavailable'; result.reason = '本期研究存档未能通过核对，请回到本期内容检查；不会自动重新采集。'; }
  }
  return result;
}
