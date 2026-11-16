import 'server-only';

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { PROJECT_DIR, safeResolve } from './project-root';
import { runtimeRunById, type RuntimeRun } from './runtime-run-resolver';
import {
  recoverRuntimeTikomniMarketReport,
  validateRuntimeOutput,
  verifyRuntimeTikomniMarketSnapshot,
} from './runtime-writer';
import { writeOutputFile } from './output-files';
import { loadVisualWorkbenchState } from './visual-workbench';

type JsonRecord = Record<string, unknown>;

export type ProductionOperationState =
  | 'prepared'
  | 'dispatched'
  | 'task_committed'
  | 'indeterminate'
  | 'abandoned';

export type ProductionOperationClass = 'tikomni' | 'llm' | 'visual';

export type ProductionOperationArtifact = {
  path: string;
  sha256: string;
  size: number;
  mtime_ms: number;
};

export type ProductionTaskOperation = {
  operation_id: string;
  step_id: string;
  attempt: number;
  operation_class: ProductionOperationClass;
  request_fingerprint: string;
  state: ProductionOperationState;
  prepared_at: string;
  dispatched_at?: string;
  committed_at?: string;
  expected: {
    run_id: string;
    run_slug: string;
    runtime_step?: string;
    output_path?: string;
    source_paths: ProductionOperationArtifact[];
  };
  baseline: {
    output?: ProductionOperationArtifact;
    snapshot_path?: string;
    visual_indexes?: ProductionOperationArtifact[];
  };
  observed?: {
    artifacts: ProductionOperationArtifact[];
    snapshot_path?: string;
    snapshot_sha256?: string;
    revision_id?: string;
  };
  outcome_reason?: string;
  manual_retry_at?: string;
};

export type ProductionTaskOperationJournal = {
  schema: 'aifios.production-operation-journal.v1';
  operations: ProductionTaskOperation[];
};

type OperationTask = {
  taskId: string;
  runId: string;
  kind: string;
  request: JsonRecord;
  result: JsonRecord;
  operationJournal?: ProductionTaskOperationJournal;
};

type OperationDefinition = {
  operationClass: ProductionOperationClass;
  runtimeStep?: string;
  outputPath?: string;
  sourcePaths: string[];
  resultSection: 'materialResearch' | 'topicBlueprint' | 'contentPackage' | 'visualCandidates';
  resultPathKey?: 'validatePath' | 'blueprintPath' | 'articlePath' | 'packagePath';
};

export type ProductionOperationReconciliation = {
  completed: boolean;
  reason?: string;
  section?: OperationDefinition['resultSection'];
  sectionPatch?: JsonRecord;
  stepResult?: JsonRecord;
  observed?: NonNullable<ProductionTaskOperation['observed']>;
};

type ProjectFileSnapshot = {
  evidence: ProductionOperationArtifact;
  bytes: Buffer;
};

const REQUIRED_MARKET_PLATFORMS = ['wechat_mp', 'xiaohongshu', 'wechat_channels'] as const;
const PRODUCTION_TO_MARKET_PLATFORM: Record<string, (typeof REQUIRED_MARKET_PLATFORMS)[number]> = {
  wechat: 'wechat_mp',
  xhs: 'xiaohongshu',
  shipinhao: 'wechat_channels',
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as JsonRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function operationDefinition(task: OperationTask, stepId: string, runSlug: string): OperationDefinition | null {
  const request = task.request;
  const topic = asRecord(task.result.topicBlueprint);
  const material = asRecord(task.result.materialResearch);
  switch (`${task.kind}:${stepId}`) {
    case 'author-blueprint:content-blueprint':
      return {
        operationClass: 'llm',
        runtimeStep: 'blueprint',
        sourcePaths: [text(material.intakePath), text(asRecord(topic.authorSource).author_evidence_path)],
        resultSection: 'topicBlueprint',
        resultPathKey: 'blueprintPath',
      };
    case 'material-research:market-research':
      return {
        operationClass: 'tikomni',
        outputPath: `materials/research/${runSlug}-market-signal.md`,
        sourcePaths: [text(material.intakePath)],
        resultSection: 'materialResearch',
      };
    case 'topic-blueprint:content-validate':
      return {
        operationClass: 'llm',
        runtimeStep: 'validate',
        sourcePaths: [text(request.intakePath), text(request.reportPath), text(request.snapshotPath)],
        resultSection: 'topicBlueprint',
        resultPathKey: 'validatePath',
      };
    case 'topic-blueprint:content-blueprint':
      return {
        operationClass: 'llm',
        runtimeStep: 'blueprint',
        sourcePaths: [text(topic.validatePath), text(request.intakePath), text(request.reportPath), text(request.snapshotPath)],
        resultSection: 'topicBlueprint',
        resultPathKey: 'blueprintPath',
      };
    case 'content-package:wechat-writer':
      return {
        operationClass: 'llm',
        runtimeStep: 'write',
        sourcePaths: [text(request.blueprintPath)],
        resultSection: 'contentPackage',
        resultPathKey: 'articlePath',
      };
    case 'content-package:content-package':
      return {
        operationClass: 'llm',
        runtimeStep: 'package',
        sourcePaths: [text(request.blueprintPath)],
        resultSection: 'contentPackage',
        resultPathKey: 'packagePath',
      };
    case 'visual-candidates:visual-candidates':
      // Stable layout is rendered entirely on this Mac. It must not cross the
      // paid/side-effect operation boundary or inherit "unknown outcome" and
      // duplicate-fee recovery semantics that only apply to AI image calls.
      if (text(asRecord(request.visualPreferences).mode) !== 'ai_enhanced') return null;
      return {
        operationClass: 'visual',
        sourcePaths: [text(request.packagePath)],
        resultSection: 'visualCandidates',
      };
    default:
      return null;
  }
}

export function isRecoverablePaidProductionStep(task: OperationTask, stepId: string): boolean {
  const slug = text(asRecord(task.result.visualCandidates).slug) || text(task.request.slug) || 'run';
  return operationDefinition(task, stepId, slug) !== null;
}

async function projectFileSnapshot(relativePath: string): Promise<ProjectFileSnapshot | null> {
  if (!relativePath || relativePath.includes('\\')) return null;
  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  const absolute = safeResolve(PROJECT_DIR, relativePath);
  if (!absolute) return null;
  try {
    const [root, resolved, info, bytes] = await Promise.all([
      realpath(PROJECT_DIR),
      realpath(absolute),
      lstat(absolute),
      readFile(absolute),
    ]);
    const relation = relative(root, resolved);
    if (info.isSymbolicLink() || !info.isFile() || isAbsolute(relation) || relation === '..' || relation.startsWith('../')) {
      return null;
    }
    return {
      evidence: {
        path: relativePath,
        sha256: sha256(bytes),
        size: bytes.length,
        mtime_ms: info.mtimeMs,
      },
      bytes,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function requiredSourceEvidence(paths: string[]): Promise<ProductionOperationArtifact[]> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length !== paths.filter(Boolean).length || unique.length === 0) {
    throw new Error('付费任务缺少唯一、可验证的上游产物路径。');
  }
  const snapshots = await Promise.all(unique.map(projectFileSnapshot));
  if (snapshots.some((item) => !item)) {
    throw new Error('付费任务的上游产物不存在、越界或不是普通文件。');
  }
  return snapshots.map((item) => (item as ProjectFileSnapshot).evidence);
}

function marketBindingFromReport(bytes: Buffer): { snapshotPath: string; snapshotSha256: string } | null {
  const body = bytes.toString('utf-8');
  const path = body.match(/^- 研究快照：([^\r\n]+)$/m)?.[1]?.trim() || '';
  const digest = body.match(/^- 快照 SHA-256：([a-f0-9]{64})$/mi)?.[1]?.toLowerCase() || '';
  if (!path || path === '未生成' || !digest) return null;
  return { snapshotPath: path.replace(/\\/g, '/'), snapshotSha256: digest };
}

function outputChanged(
  current: ProductionOperationArtifact,
  baseline: ProductionOperationArtifact | undefined,
  dispatchedAt: string,
): boolean {
  if (!baseline) {
    const dispatchTime = Date.parse(dispatchedAt);
    return Number.isFinite(dispatchTime) && current.mtime_ms >= dispatchTime - 2_000;
  }
  return current.path !== baseline.path
    || current.sha256 !== baseline.sha256;
}

function inputFingerprint(input: {
  task: OperationTask;
  stepId: string;
  runId: string;
  runSlug: string;
  definition: OperationDefinition;
  sources: ProductionOperationArtifact[];
  baseline: ProductionTaskOperation['baseline'];
}): string {
  return sha256(stableStringify({
    task_id: input.task.taskId,
    run_id: input.runId,
    run_slug: input.runSlug,
    kind: input.task.kind,
    step_id: input.stepId,
    request: input.task.request,
    runtime_step: input.definition.runtimeStep || null,
    output_path: input.definition.outputPath || null,
    sources: input.sources,
    baseline: input.baseline,
  }));
}

function isOperationArtifact(value: unknown): value is ProductionOperationArtifact {
  const artifact = asRecord(value);
  return typeof artifact.path === 'string'
    && typeof artifact.sha256 === 'string'
    && typeof artifact.size === 'number'
    && typeof artifact.mtime_ms === 'number';
}

function isOperationEntry(value: unknown): value is ProductionTaskOperation {
  const operation = asRecord(value);
  const expected = asRecord(operation.expected);
  const baseline = asRecord(operation.baseline);
  return typeof operation.operation_id === 'string'
    && typeof operation.step_id === 'string'
    && typeof operation.attempt === 'number'
    && ['tikomni', 'llm', 'visual'].includes(String(operation.operation_class))
    && ['prepared', 'dispatched', 'task_committed', 'indeterminate', 'abandoned'].includes(String(operation.state))
    && typeof operation.request_fingerprint === 'string'
    && typeof operation.prepared_at === 'string'
    && typeof expected.run_id === 'string'
    && typeof expected.run_slug === 'string'
    && Array.isArray(expected.source_paths)
    && expected.source_paths.every(isOperationArtifact)
    && (!baseline.output || isOperationArtifact(baseline.output))
    && (!baseline.visual_indexes
      || (Array.isArray(baseline.visual_indexes) && baseline.visual_indexes.every(isOperationArtifact)));
}

function isOperationJournal(value: unknown): value is ProductionTaskOperationJournal {
  const journal = asRecord(value);
  if (journal.schema !== 'aifios.production-operation-journal.v1'
    || !Array.isArray(journal.operations)
    || !journal.operations.every(isOperationEntry)) return false;
  const ids = journal.operations.map((operation) => operation.operation_id);
  return new Set(ids).size === ids.length;
}

export function productionTaskOperation(
  task: OperationTask,
  operationId: string | undefined,
): ProductionTaskOperation | null {
  if (!operationId || !isOperationJournal(task.operationJournal)) return null;
  const operation = task.operationJournal.operations.find((item) => item.operation_id === operationId);
  return operation || null;
}

export async function prepareProductionTaskOperation(
  task: OperationTask,
  stepId: string,
  run: RuntimeRun & { run_id: string; slug: string },
): Promise<ProductionTaskOperation | null> {
  const definition = operationDefinition(task, stepId, run.slug);
  if (!definition) return null;
  const sources = await requiredSourceEvidence(definition.sourcePaths);
  const baseline: ProductionTaskOperation['baseline'] = {};
  if (definition.outputPath) {
    const output = await projectFileSnapshot(definition.outputPath);
    if (output) {
      baseline.output = output.evidence;
      baseline.snapshot_path = marketBindingFromReport(output.bytes)?.snapshotPath;
    }
  }
  if (definition.runtimeStep) {
    const currentPath = text(run.steps?.[definition.runtimeStep]?.latest);
    if (currentPath) baseline.output = (await projectFileSnapshot(currentPath))?.evidence;
  }
  if (definition.operationClass === 'visual') {
    const state = await loadVisualWorkbenchState(run.slug);
    baseline.visual_indexes = (await Promise.all((state?.revisions || []).flatMap((revision) => (
      revision.indexPath ? [projectFileSnapshot(revision.indexPath)] : []
    )))).flatMap((item) => item ? [item.evidence] : []);
  }

  if (task.operationJournal && !isOperationJournal(task.operationJournal)) {
    throw new Error('operation journal 已损坏，外部操作未调度。');
  }
  const journal = task.operationJournal || {
      schema: 'aifios.production-operation-journal.v1' as const,
      operations: [],
    };
  task.operationJournal = journal;
  const attempt = journal.operations.filter((item) => item.step_id === stepId).length + 1;
  const requestFingerprint = inputFingerprint({
    task,
    stepId,
    runId: run.run_id,
    runSlug: run.slug,
    definition,
    sources,
    baseline,
  });
  const operationId = `op_${sha256(`${task.taskId}:${stepId}:${attempt}:${requestFingerprint}`).slice(0, 32)}`;
  const operation: ProductionTaskOperation = {
    operation_id: operationId,
    step_id: stepId,
    attempt,
    operation_class: definition.operationClass,
    request_fingerprint: requestFingerprint,
    state: 'prepared',
    prepared_at: new Date().toISOString(),
    expected: {
      run_id: run.run_id,
      run_slug: run.slug,
      ...(definition.runtimeStep ? { runtime_step: definition.runtimeStep } : {}),
      ...(definition.outputPath ? { output_path: definition.outputPath } : {}),
      source_paths: sources,
    },
    baseline,
  };
  journal.operations.push(operation);
  return operation;
}

export function dispatchProductionTaskOperation(operation: ProductionTaskOperation, at: string): void {
  if (operation.state !== 'prepared') throw new Error('付费任务 operation 状态不允许重复调度。');
  operation.state = 'dispatched';
  operation.dispatched_at = at;
}

export function commitProductionTaskOperation(
  operation: ProductionTaskOperation,
  observed: NonNullable<ProductionTaskOperation['observed']>,
  at: string,
): void {
  operation.state = 'task_committed';
  operation.observed = observed;
  operation.committed_at = at;
  delete operation.outcome_reason;
}

export function abandonProductionTaskOperation(operation: ProductionTaskOperation, at: string): void {
  if (operation.state === 'prepared' || operation.state === 'indeterminate') {
    operation.state = 'abandoned';
  }
  operation.manual_retry_at = at;
}

export function recordProductionTaskOperationBlocked(
  operation: ProductionTaskOperation,
  reason: string,
): void {
  if (operation.state !== 'dispatched') return;
  operation.state = 'abandoned';
  operation.outcome_reason = reason.trim().slice(0, 500) || '外部操作返回明确的阻断结果。';
}

export function markProductionTaskOperationIndeterminate(
  operation: ProductionTaskOperation,
  reason: string,
): void {
  if (operation.state !== 'dispatched') return;
  operation.state = 'indeterminate';
  operation.outcome_reason = reason.trim().slice(0, 500) || '外部操作结果无法验证。';
}

async function sourcesRemainCurrent(operation: ProductionTaskOperation): Promise<boolean> {
  const current = await Promise.all(operation.expected.source_paths.map((item) => projectFileSnapshot(item.path)));
  return current.every((item, index) => Boolean(
    item
    && item.evidence.sha256 === operation.expected.source_paths[index].sha256
    && item.evidence.size === operation.expected.source_paths[index].size,
  ));
}

async function reconcileLlm(
  task: OperationTask,
  operation: ProductionTaskOperation,
  definition: OperationDefinition,
  run: RuntimeRun & { run_id: string; slug: string },
): Promise<ProductionOperationReconciliation> {
  const runtimeStep = definition.runtimeStep || '';
  const path = text(run.steps?.[runtimeStep]?.latest);
  const output = path ? await projectFileSnapshot(path) : null;
  if (!output || !operation.dispatched_at || !outputChanged(output.evidence, operation.baseline.output, operation.dispatched_at)) {
    return { completed: false, reason: '无法证明本次模型调用已产生新的权威产物。' };
  }
  const validation = await validateRuntimeOutput(runtimeStep, path, run.run_id);
  // A saved blueprint remains reviewable even when its scope needs correction.
  // Completing generation never grants topic approval or permission to write.
  if (!validation.valid && !(runtimeStep === 'blueprint' && validation.result.platform_scope)) {
    return { completed: false, reason: '模型产物存在，但未通过 runtime 契约校验。' };
  }
  const pathKey = definition.resultPathKey as NonNullable<OperationDefinition['resultPathKey']>;
  const patch = { [pathKey]: path };
  return {
    completed: true,
    section: definition.resultSection,
    sectionPatch: patch,
    stepResult: { ...patch, validation: validation.result },
    observed: { artifacts: [output.evidence] },
  };
}

async function reconcileMarketResearch(
  task: OperationTask,
  operation: ProductionTaskOperation,
  definition: OperationDefinition,
  run: RuntimeRun,
): Promise<ProductionOperationReconciliation> {
  const outputPath = definition.outputPath || '';
  let output = await projectFileSnapshot(outputPath);
  if (!output || !operation.dispatched_at || !outputChanged(output.evidence, operation.baseline.output, operation.dispatched_at)) {
    const rootPath = `runs/${task.runId}/market-research`;
    const root = safeResolve(PROJECT_DIR, rootPath);
    const sourcePath = operation.expected.source_paths[0]?.path || '';
    const dispatchedAt = Date.parse(operation.dispatched_at || '');
    let candidates: Array<{ path: string; createdAt: number }> = [];
    if (root && Number.isFinite(dispatchedAt)) {
      try {
        const entries = await readdir(root, { withFileTypes: true });
        candidates = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
          const path = `${rootPath}/${entry.name}/snapshot.json`;
          const snapshot = await projectFileSnapshot(path);
          if (!snapshot || path === operation.baseline.snapshot_path) return null;
          try {
            const manifest = asRecord(JSON.parse(snapshot.bytes.toString('utf-8')));
            const createdAt = Date.parse(text(manifest.created_at));
            return Number.isFinite(createdAt) && createdAt >= dispatchedAt - 2_000 ? { path, createdAt } : null;
          } catch {
            return null;
          }
        }))).filter((item): item is { path: string; createdAt: number } => item !== null)
          .sort((left, right) => right.createdAt - left.createdAt);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    for (const candidate of candidates) {
      const verification = await verifyRuntimeTikomniMarketSnapshot(task.runId, candidate.path);
      if (!verification.verified
        || verification.manifest_path !== candidate.path
        || verification.source_path !== sourcePath) continue;
      const recovered = await recoverRuntimeTikomniMarketReport(task.runId, sourcePath, candidate.path);
      if (recovered.snapshot_path !== candidate.path
        || recovered.snapshot_sha256 !== verification.snapshot_sha256) continue;
      // This is a local replay of already persisted immutable evidence. It is
      // intentionally the only write performed here and never contacts TikOmni.
      await writeOutputFile(outputPath, recovered.markdown);
      output = await projectFileSnapshot(outputPath);
      break;
    }
    if (!output || !operation.dispatched_at || !outputChanged(output.evidence, operation.baseline.output, operation.dispatched_at)) {
      return { completed: false, reason: '未找到可验证的本次 TikOmni 快照，未重新调用外部服务。' };
    }
  }
  const binding = marketBindingFromReport(output.bytes);
  if (!binding
    || binding.snapshotPath === operation.baseline.snapshot_path
    || !binding.snapshotPath.startsWith(`runs/${task.runId}/market-research/`)
    || !binding.snapshotPath.endsWith('/snapshot.json')) {
    return { completed: false, reason: 'TikOmni 报告没有绑定本次 run 的新快照。' };
  }
  const verification = await verifyRuntimeTikomniMarketSnapshot(task.runId, binding.snapshotPath);
  const sourcePath = operation.expected.source_paths[0]?.path || '';
  if (!verification.verified
    || verification.manifest_path !== binding.snapshotPath
    || verification.snapshot_sha256 !== binding.snapshotSha256
    || verification.source_path !== sourcePath) {
    return { completed: false, reason: 'TikOmni 快照的 run、素材或 SHA-256 绑定校验失败。' };
  }
  const manifest = await projectFileSnapshot(binding.snapshotPath);
  if (!manifest) return { completed: false, reason: 'TikOmni 快照清单不可读。' };
  let payload: JsonRecord;
  try {
    payload = asRecord(JSON.parse(manifest.bytes.toString('utf-8')));
  } catch {
    return { completed: false, reason: 'TikOmni 快照清单不是有效 JSON。' };
  }
  const createdAt = Date.parse(text(payload.created_at));
  const dispatchedAt = Date.parse(operation.dispatched_at);
  const platforms = Array.isArray(payload.required_platforms) ? payload.required_platforms : [];
  const selectedProductionPlatforms = run.selected_platforms?.length
    ? run.selected_platforms
    : run.target_platforms?.length
      ? run.target_platforms
      : ['wechat', 'xhs', 'shipinhao'];
  const expectedMarketPlatforms = REQUIRED_MARKET_PLATFORMS.filter((platform) => (
    selectedProductionPlatforms.some((selected) => PRODUCTION_TO_MARKET_PLATFORM[selected] === platform)
  ));
  if (!Number.isFinite(createdAt)
    || !Number.isFinite(dispatchedAt)
    || createdAt < dispatchedAt - 2_000
    || stableStringify(platforms) !== stableStringify(expectedMarketPlatforms)) {
    return { completed: false, reason: 'TikOmni 快照时间或平台选择不属于本次 operation。' };
  }
  const queries = Array.isArray(payload.queries) ? payload.queries.filter((item): item is string => typeof item === 'string') : [];
  const platformChecks = asRecord(payload.platform_checks);
  const sampleCount = Object.values(platformChecks).reduce<number>((total, item) => {
    const count = asRecord(item).sample_count;
    return total + (typeof count === 'number' && Number.isFinite(count) ? count : 0);
  }, 0);
  const patch = {
    reportPath: outputPath,
    snapshotPath: binding.snapshotPath,
    snapshotSha256: binding.snapshotSha256,
    status: 'ready',
    sampleCount,
    queries,
    requiredPlatforms: expectedMarketPlatforms,
    platformChecks,
  };
  return {
    completed: true,
    section: definition.resultSection,
    sectionPatch: patch,
    stepResult: patch,
    observed: {
      artifacts: [output.evidence, manifest.evidence],
      snapshot_path: binding.snapshotPath,
      snapshot_sha256: binding.snapshotSha256,
    },
  };
}

function visualComparisonRole(asset: { id: string; role: string }): 'cover' | 'evidence' | 'cta' | null {
  const role = asset.role.toLowerCase();
  if (role === 'evidence' || role === 'evidence_required') return 'evidence';
  if (role === 'cta' || /-p5$/i.test(asset.id)) return 'cta';
  if (role === 'cover' || /-p1$/i.test(asset.id)) return 'cover';
  return null;
}

async function reconcileVisual(
  operation: ProductionTaskOperation,
  definition: OperationDefinition,
  run: RuntimeRun & { run_id: string; slug: string },
): Promise<ProductionOperationReconciliation> {
  const state = await loadVisualWorkbenchState(run.slug);
  if (!state || !operation.dispatched_at) {
    return { completed: false, reason: '视觉生成未落盘可校验的版本索引。' };
  }
  const baseline = new Map((operation.baseline.visual_indexes || []).map((item) => [item.path, item]));
  for (const revision of state.revisions) {
    if (!revision.indexPath || !['ready', 'review_required'].includes(revision.status)) continue;
    const index = await projectFileSnapshot(revision.indexPath);
    if (!index || !outputChanged(index.evidence, baseline.get(revision.indexPath), operation.dispatched_at)) continue;
    const recipe = await projectFileSnapshot(revision.recipePath);
    if (!recipe) continue;
    let recipePayload: JsonRecord;
    try {
      recipePayload = asRecord(JSON.parse(recipe.bytes.toString('utf-8')));
    } catch {
      continue;
    }
    if (recipePayload.slug !== run.slug || recipePayload.source_package !== operation.expected.source_paths[0]?.path) continue;
    const assets = (state.assetCandidates || state.assets).filter((asset) => asset.revisionId === revision.revisionId);
    const roles = new Set<'cover' | 'evidence' | 'cta'>(
      assets.map(visualComparisonRole).filter((role): role is 'cover' | 'evidence' | 'cta' => role !== null),
    );
    if (!(['cover', 'evidence', 'cta'] as const).every((role) => roles.has(role))) continue;
    const assetSnapshots = await Promise.all(assets.map((asset) => projectFileSnapshot(asset.path)));
    if (assetSnapshots.some((item) => !item)) continue;
    const observed = [recipe.evidence, index.evidence, ...assetSnapshots.map((item) => (item as ProjectFileSnapshot).evidence)];
    const patch = { slug: run.slug };
    return {
      completed: true,
      section: definition.resultSection,
      sectionPatch: patch,
      stepResult: patch,
      observed: {
        artifacts: observed,
        revision_id: revision.revisionId,
      },
    };
  }
  return { completed: false, reason: '无法证明本次视觉调用已完整产出封面、证据图和 CTA 资产。' };
}

export async function reconcileProductionTaskOperation(
  task: OperationTask,
  operation: ProductionTaskOperation,
): Promise<ProductionOperationReconciliation> {
  const run = await runtimeRunById(task.runId);
  if (!run?.run_id || !run.slug
    || run.run_id !== operation.expected.run_id
    || run.slug !== operation.expected.run_slug
    || !['dispatched', 'indeterminate'].includes(operation.state)
    || !operation.dispatched_at) {
    return { completed: false, reason: 'operation 没有绑定可用的当前 runtime run。' };
  }
  const definition = operationDefinition(task, operation.step_id, run.slug);
  if (!definition || definition.operationClass !== operation.operation_class) {
    return { completed: false, reason: 'operation 类型或步骤契约不匹配。' };
  }
  const expectedFingerprint = inputFingerprint({
    task,
    stepId: operation.step_id,
    runId: run.run_id,
    runSlug: run.slug,
    definition,
    sources: operation.expected.source_paths,
    baseline: operation.baseline,
  });
  if (expectedFingerprint !== operation.request_fingerprint || !(await sourcesRemainCurrent(operation))) {
    return { completed: false, reason: 'operation 的请求或上游产物哈希已变化。' };
  }
  if (operation.operation_class === 'tikomni') {
    return reconcileMarketResearch(task, operation, definition, run);
  }
  if (operation.operation_class === 'llm') {
    return reconcileLlm(task, operation, definition, run as RuntimeRun & { run_id: string; slug: string });
  }
  return reconcileVisual(operation, definition, run as RuntimeRun & { run_id: string; slug: string });
}
