import { queuePathForRun } from './publish/draft-queue';
import { runtimeRunById, type RuntimeRun } from './runtime-run-resolver';
import { verifyRuntimeAuthorSource } from './runtime-writer';

type JsonRecord = Record<string, unknown>;

export type ProductionTaskAuthoritySubject = {
  runId: string;
  kind: 'material-research' | 'author-blueprint' | 'topic-blueprint' | 'content-package' | 'visual-candidates' | 'draft-queue';
  request: JsonRecord;
  result: JsonRecord;
};

export class ProductionTaskAuthorityError extends Error {}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
}

function currentPath(run: RuntimeRun, step: string): string {
  return text(run.steps?.[step]?.latest);
}

function requireEqual(actual: string, expected: string, label: string): void {
  if (!actual || !expected || actual !== expected) {
    throw new ProductionTaskAuthorityError(`${label}不属于任务绑定的当前 run 最新版本。`);
  }
}

function requireSlug(value: unknown, runSlug: string): void {
  requireEqual(text(value), runSlug, '任务 slug');
}

function requireSnapshotPath(value: unknown, runId: string): string {
  const path = text(value);
  if (!path.startsWith(`runs/${runId}/market-research/`) || !path.endsWith('/snapshot.json')) {
    throw new ProductionTaskAuthorityError('TikOmni 研究快照不属于任务绑定的当前 run。');
  }
  return path;
}

/**
 * Re-resolves the durable runtime run before and after every task step. This
 * prevents a persisted task for run A from following a browser-supplied path
 * or slug owned by run B after a refresh, retry, or concurrent tab change.
 */
export async function assertProductionTaskRunAuthority(
  task: ProductionTaskAuthoritySubject,
): Promise<RuntimeRun & { run_id: string; slug: string }> {
  const run = await runtimeRunById(task.runId);
  if (!run?.run_id || !run.slug || run.run_id !== task.runId) {
    throw new ProductionTaskAuthorityError('后台任务绑定的 runtime run 不存在或已失效。');
  }
  const runSlug = text(run.slug);
  const input = task.request;

  if (task.kind === 'material-research' || task.kind === 'author-blueprint') {
    requireSlug(input.slug, runSlug);
    const requestedProject = text(input.projectId).toLowerCase();
    const runProject = text(run.project_id).toLowerCase();
    if (requestedProject && runProject && requestedProject !== runProject) {
      throw new ProductionTaskAuthorityError('素材任务的项目标识不属于当前 run。');
    }
    const section = asRecord(task.result.materialResearch);
    const intakePath = text(section.intakePath);
    if (intakePath) requireEqual(intakePath, currentPath(run, 'intake'), '素材理解报告');
    const reportPath = text(section.reportPath);
    if (reportPath) requireEqual(reportPath, `materials/research/${runSlug}-market-signal.md`, 'TikOmni 研究报告');
    const snapshotPath = text(section.snapshotPath);
    if (snapshotPath) requireSnapshotPath(snapshotPath, task.runId);
  }

  if (task.kind === 'author-blueprint') {
    const section = asRecord(task.result.topicBlueprint);
    const source = asRecord(section.authorSource);
    if (Object.keys(source).length) {
      const current = await verifyRuntimeAuthorSource(task.runId);
      requireEqual(text(source.author_evidence_path), current.author_evidence_path, '作者素材记录');
      requireEqual(text(source.author_evidence_sha256), current.author_evidence_sha256, '作者素材版本');
      requireEqual(text(input.topic), current.topic, '作者题目');
      requireEqual(text(section.topic), current.topic, '方案题目');
      requireEqual(text(section.runSlug), runSlug, '方案所属草稿');
    }
    const blueprintPath = text(section.blueprintPath);
    if (blueprintPath) requireEqual(blueprintPath, currentPath(run, 'blueprint'), '写作方案');
  }

  if (task.kind === 'topic-blueprint') {
    requireEqual(text(input.intakePath), currentPath(run, 'intake'), '素材理解报告');
    requireEqual(text(input.reportPath), `materials/research/${runSlug}-market-signal.md`, 'TikOmni 研究报告');
    const snapshotPath = requireSnapshotPath(input.snapshotPath, task.runId);
    const section = asRecord(task.result.topicBlueprint);
    const selected = run.topic_selection;
    if (selected) {
      requireEqual(snapshotPath, text(selected.market_snapshot_path), '已选主题的研究快照');
      requireEqual(text(input.snapshotSha256).toLowerCase(), text(selected.market_snapshot_sha256).toLowerCase(), '已选主题的研究快照哈希');
      // Before the topic-selection step runs, the run may legitimately still
      // hold the previous choice. Once this durable task has saved its topic,
      // every resumed downstream step must agree with the runtime authority.
      if (text(section.topic) && text(run.topic)) {
        requireEqual(text(input.topic), text(run.topic), '任务主题');
        requireEqual(text(section.topic), text(run.topic), '立项结果主题');
      }
    }
    const resultSlug = text(section.runSlug);
    if (resultSlug) requireEqual(resultSlug, runSlug, '立项结果 slug');
    const validatePath = text(section.validatePath);
    if (validatePath) requireEqual(validatePath, currentPath(run, 'validate'), '立项报告');
    const blueprintPath = text(section.blueprintPath);
    if (blueprintPath) requireEqual(blueprintPath, currentPath(run, 'blueprint'), '思想母版蓝图');
  }

  if (task.kind === 'content-package') {
    requireSlug(input.slug, runSlug);
    requireEqual(text(input.blueprintPath), currentPath(run, 'blueprint'), '思想母版蓝图');
    if (text(run.topic)) requireEqual(text(input.topic), text(run.topic), '内容包主题');
    const section = asRecord(task.result.contentPackage);
    const articlePath = text(section.articlePath);
    if (articlePath) requireEqual(articlePath, currentPath(run, 'write'), '公众号母稿');
    const packagePath = text(section.packagePath);
    if (packagePath) requireEqual(packagePath, currentPath(run, 'package'), '完整内容包');
  }

  if (task.kind === 'visual-candidates') {
    requireSlug(input.slug, runSlug);
    requireEqual(text(input.packagePath), currentPath(run, 'package'), '视觉源内容包');
    const section = asRecord(task.result.visualCandidates);
    if (text(section.slug)) requireEqual(text(section.slug), runSlug, '视觉结果 slug');
  }

  if (task.kind === 'draft-queue') {
    requireEqual(text(input.packagePath), currentPath(run, 'package'), '草稿源内容包');
    const section = asRecord(task.result.draftQueue);
    const queuePath = text(section.draftQueuePath);
    if (queuePath) requireEqual(queuePath, queuePathForRun(runSlug), '草稿队列');
    const queue = asRecord(section.draftQueue);
    if (Object.keys(queue).length) {
      requireEqual(text(queue.run_id), task.runId, '草稿队列 run ID');
      requireEqual(text(queue.run_slug), runSlug, '草稿队列 run slug');
      requireEqual(text(queue.package_path), text(input.packagePath), '草稿队列内容包');
    }
  }

  return run as RuntimeRun & { run_id: string; slug: string };
}
