import 'server-only';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { PROJECT_DIR, safeResolve } from './project-root';
import { parseFrontmatter } from './runtime-run-resolver';
import type { ContentAttempt } from './content-attempts';
import type { ContentRevision } from './content-revisions';
import type { ProductionTask } from './production-tasks';
import type { ProductionFlowIntegrity } from './production-flow';

async function readRegular(path: string): Promise<string> {
  const parts = path.split('/');
  if (path.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid recovery path');
  for (let i = 1; i <= parts.length; i++) {
    const resolved = safeResolve(PROJECT_DIR, parts.slice(0, i).join('/'));
    if (!resolved) throw new Error('Invalid recovery path');
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) throw new Error('Invalid recovery file');
  }
  return readFile(safeResolve(PROJECT_DIR, path)!, 'utf8');
}

async function records<T>(directory: string): Promise<T[]> {
  // readRegular also rejects symlinks in every directory component.
  const entries = await readdir(safeResolve(PROJECT_DIR, directory)!, { withFileTypes: true });
  return Promise.all(entries.filter(entry => entry.name.endsWith('.json')).map(async entry => JSON.parse(await readRegular(`${directory}/${entry.name}`)) as T));
}

/** A display-only projection. It never changes the failed task or creates work. */
export async function recoveredContentTask(
  runId: string,
  packagePath: string,
  approval: ProductionFlowIntegrity['approvals'][string] | undefined,
): Promise<ProductionFlowIntegrity['recovered_content_task']> {
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId) || !approval?.approved || approval.path !== packagePath
    || !/^pipeline\/package\/[^/\\]+\.md$/.test(packagePath)) return null;
  try {
    const content = await readRegular(packagePath);
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (approval.sha256 !== sha256) return null;
    const revisionId = /^content-revision:(rev_[a-f0-9]{32})$/.exec(parseFrontmatter(content).source || '')?.[1];
    if (!revisionId) return null;
    const revision = JSON.parse(await readRegular(`runs/${runId}/content-revisions/${revisionId}.json`)) as ContentRevision;
    const attemptId = revision.recoveryId;
    if (revision.schema !== 'echo.content-revision.v1' || revision.id !== revisionId || revision.runId !== runId || revision.status !== 'adopted'
      || revision.adoptedPath !== packagePath || revision.adoptedSha256 !== sha256 || !/^attempt_[a-f0-9]{32}$/.test(attemptId || '')
      || revision.basePath !== `runs/${runId}/content-attempts/${attemptId}.json`) return null;
    const attempt = JSON.parse(await readRegular(revision.basePath)) as ContentAttempt;
    if (attempt.schema !== 'echo.content-attempt.v1' || attempt.id !== attemptId || attempt.runId !== runId
      || attempt.status !== 'saved' || attempt.savedPath !== packagePath) return null;
    const tasks = await records<ProductionTask>(`runs/${runId}/tasks`);
    const eligible = tasks.filter(task => task.schema === 'aifios.production-task.v1' && task.runId === runId
      && task.kind === 'content-package' && ['failed', 'blocked'].includes(task.status));
    const explicit = eligible.filter(task => (task.result.contentPackage as { attemptId?: string } | undefined)?.attemptId === attemptId);
    if (explicit.length === 1) return { taskId: explicit[0].taskId, packagePath, packageSha256: sha256 };
    if (explicit.length > 1) return null;

    // Older tasks discarded the partial-result receipt. Accept only one completed
    // release-gate failure window, its exact input plan, and one attempt in that
    // window. Ambiguous/missing histories keep the original failure visible.
    const created = Date.parse(attempt.createdAt);
    const matching = eligible.filter(task => {
      if ((task.result.contentPackage as { attemptId?: string } | undefined)?.attemptId || task.error?.code !== 'content_release_blocked') return false;
      const step = task.steps.find(item => item.id === 'content-package');
      const operation = task.operationJournal?.operations.find(item => item.operation_id === step?.operationId);
      return Number.isFinite(created) && created >= Date.parse(step?.startedAt || '') && created <= Date.parse(step?.completedAt || '')
        && operation?.expected.source_paths?.some(source => source.path === attempt.plan.path && source.sha256 === attempt.plan.sha256);
    });
    if (matching.length !== 1) return null;
    const step = matching[0].steps.find(item => item.id === 'content-package')!;
    const attempts = await records<ContentAttempt>(`runs/${runId}/content-attempts`);
    const inWindow = attempts.filter(item => item.runId === runId && Date.parse(item.createdAt) >= Date.parse(step.startedAt!) && Date.parse(item.createdAt) <= Date.parse(step.completedAt!));
    if (inWindow.length !== 1 || inWindow[0].id !== attemptId) return null;
    return { taskId: matching[0].taskId, packagePath, packageSha256: sha256 };
  } catch {
    return null;
  }
}
