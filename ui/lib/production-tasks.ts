import { randomUUID } from 'node:crypto';
import { authorAnalysisFingerprint } from './author-material-review';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { POST as invokeAgent } from '@/app/api/agent/invoke/route';
import { POST as saveMaterialAnalysis } from '@/app/api/production/material-analysis/route';
import { POST as buildMaterialIntake } from '@/app/api/production/intake/route';
import { POST as collectMarketSignal } from '@/app/api/research/market-signal/route';
import { POST as saveTopicSelection } from '@/app/api/research/topic-selection/route';
import { POST as bindTemplate } from '@/app/api/run/template/route';
import { POST as prewarmTopicSuggestions } from '@/app/api/research/topic-suggestions/route';
import { POST as publishVisualCandidates } from '@/app/api/visual/publish/route';
import { POST as preparePublishAssets } from '@/app/api/publish-assets/route';
import { ensureProjectInitialized } from '@/lib/project-init';
import { runContentReleaseGate } from '@/lib/content-release-gate';
import { readOutputFile } from '@/lib/output-files';
import {
  assertProductionTaskRunAuthority,
  ProductionTaskAuthorityError,
} from '@/lib/production-task-authority';
import {
  abandonProductionTaskOperation,
  commitProductionTaskOperation,
  dispatchProductionTaskOperation,
  isRecoverablePaidProductionStep,
  markProductionTaskOperationIndeterminate,
  prepareProductionTaskOperation,
  productionTaskOperation,
  recordProductionTaskOperationBlocked,
  reconcileProductionTaskOperation,
  type ProductionOperationReconciliation,
  type ProductionTaskOperation,
  type ProductionTaskOperationJournal,
} from '@/lib/production-task-operations';
import { PROJECT_DIR, redactLocalPaths, safeResolve } from '@/lib/project-root';
import { displayClientError } from '@/lib/client-error-copy';
import { resolveServerLLMConfig } from '@/lib/server-config';
import { getApiKey, validateLLMConfig } from '@/lib/llm-client';
import { KnownUserFacingError, userFacingErrorPayload } from '@/lib/user-facing-error';
import { materialIntakeFailureMessage } from '@/lib/material-intake-errors';
import { withProjectWriteLock, writeFingerprint } from '@/lib/write-guard';
import { getRuntimeAuthorSourceContext, selectRuntimeAuthorSource, verifyRuntimeAuthorSource, type AuthorSourceRequest } from '@/lib/runtime-writer';

export const PRODUCTION_TASK_KINDS = [
  'material-research',
  'author-blueprint',
  'topic-blueprint',
  'content-package',
  'visual-candidates',
  'draft-queue',
] as const;

export type ProductionTaskKind = (typeof PRODUCTION_TASK_KINDS)[number];
export type ProductionTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked';
export type ProductionTaskStepStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'blocked';

export type ProductionTaskStep = {
  id: string;
  label: string;
  status: ProductionTaskStepStatus;
  operationId?: string;
  startedAt?: string;
  completedAt?: string;
  /** New writes use the structured shape; strings remain readable for v1 compatibility. */
  error?: string | ProductionTaskFailure;
  result?: Record<string, unknown>;
};

export type ProductionTaskFailure = {
  code: string;
  /** Required for new writes; optional only so v1 task files remain readable. */
  displayMessage?: string;
  debugId?: string;
  stepId?: string;
  /** Read compatibility only. New task writes must not populate this field. */
  message?: string;
  /** Read compatibility only. Never included in the browser projection. */
  details?: Record<string, unknown>;
};

export type ProductionTask = {
  schema: 'aifios.production-task.v1';
  taskId: string;
  runId: string;
  kind: ProductionTaskKind;
  status: ProductionTaskStatus;
  currentStep: string | null;
  steps: ProductionTaskStep[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result: Record<string, unknown>;
  error?: ProductionTaskFailure;
  resumableFrom: string | null;
  // This is deliberately a whitelisted, secret-free task input. It is useful
  // for recovery but is never a copy of request headers or LLM configuration.
  request: Record<string, unknown>;
  operationJournal?: ProductionTaskOperationJournal;
};

type JsonRecord = Record<string, unknown>;

type TaskStepDefinition = Pick<ProductionTaskStep, 'id' | 'label'>;

const RUN_ID_RE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;
const TASK_ID_RE = /^[A-Za-z0-9_\-]{1,120}$/;
const FORBIDDEN_REQUEST_KEYS = new Set([
  'apikey', 'api_key', 'authorization', 'cookie', 'config', 'gateway_session', 'gatewaysession', 'token', 'secret',
]);

const TASK_STEPS: Record<ProductionTaskKind, TaskStepDefinition[]> = {
  'author-blueprint': [
    { id: 'material-analysis', label: '确认本期素材' },
    { id: 'material-intake', label: '保存素材底稿' },
    { id: 'author-source', label: '保存题目与素材依据' },
    { id: 'template-binding', label: '保存排版样式' },
    { id: 'content-blueprint', label: '生成写作方案' },
  ],
  'material-research': [
    { id: 'material-analysis', label: '确认素材理解' },
    { id: 'material-intake', label: '整理素材要点' },
    { id: 'market-research', label: '查看已选平台的同类内容' },
    { id: 'topic-suggestions', label: '生成主题建议' },
  ],
  'topic-blueprint': [
    { id: 'topic-selection', label: '保存选题' },
    { id: 'template-binding', label: '保存排版样式' },
    { id: 'content-validate', label: '检查选题依据' },
    { id: 'content-blueprint', label: '生成各平台内容蓝图' },
  ],
  'content-package': [
    { id: 'content-package', label: '分别生成已选平台的原生内容' },
  ],
  'visual-candidates': [
    { id: 'visual-candidates', label: '生成平台完整发布件' },
  ],
  'draft-queue': [
    { id: 'draft-queue', label: '整理发布内容' },
  ],
};

const activeTasks = new Map<string, Promise<void>>();

export class ProductionTaskInputError extends Error {}
export class ProductionTaskBlockedError extends Error {
  constructor(message: string, readonly code?: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

function now(): string {
  return new Date().toISOString();
}

function taskKey(runId: string, taskId: string): string {
  return `${runId}:${taskId}`;
}

export function isProductionTaskKind(value: unknown): value is ProductionTaskKind {
  return typeof value === 'string' && (PRODUCTION_TASK_KINDS as readonly string[]).includes(value);
}

export function assertProductionTaskIds(runId: unknown, taskId?: unknown): { runId: string; taskId?: string } {
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!RUN_ID_RE.test(normalizedRunId)) throw new ProductionTaskInputError('run ID 格式不正确。');
  if (taskId === undefined) return { runId: normalizedRunId };
  const normalizedTaskId = typeof taskId === 'string' ? taskId.trim() : '';
  if (!TASK_ID_RE.test(normalizedTaskId)) throw new ProductionTaskInputError('任务编号格式不正确。');
  return { runId: normalizedRunId, taskId: normalizedTaskId };
}

export function productionTaskPath(runId: string, taskId: string): string {
  const ids = assertProductionTaskIds(runId, taskId);
  return `runs/${ids.runId}/tasks/${ids.taskId}.json`;
}

function absoluteTaskPath(runId: string, taskId: string): string {
  const relativePath = productionTaskPath(runId, taskId);
  const resolved = safeResolve(PROJECT_DIR, relativePath);
  if (!resolved) throw new ProductionTaskInputError('任务路径不正确。');
  return resolved;
}

function asString(value: unknown, max = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asStringList(value: unknown, maxItems = 32, maxLength = 4_000): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function marketResearchDiagnostics(payload: JsonRecord): JsonRecord {
  const blockers = Array.isArray(payload.blockers)
    ? payload.blockers.slice(0, 3).map((item) => {
      const blocker = asRecord(item);
      return {
        platform: asString(blocker.platform, 80),
        code: asString(blocker.code, 80),
        message: asString(blocker.message, 500),
      };
    }).filter((item) => item.message)
    : [];
  const platformChecks = Object.fromEntries(
    Object.entries(asRecord(payload.platformChecks)).slice(0, 3).map(([platform, item]) => {
      const check = asRecord(item);
      return [platform, {
        status: asString(check.status, 32),
        code: asString(check.code, 80),
        reason: asString(check.reason, 500),
        sampleCount: typeof check.sample_count === 'number' ? check.sample_count : 0,
      }];
    }),
  );
  return {
    ...(blockers.length ? { blockers } : {}),
    ...(Object.keys(platformChecks).length ? { platformChecks } : {}),
    ...(asString(payload.operationOutcome, 32)
      ? { operationOutcome: asString(payload.operationOutcome, 32) }
      : {}),
  };
}

function hasForbiddenRequestKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenRequestKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as JsonRecord).some(([key, item]) => (
    FORBIDDEN_REQUEST_KEYS.has(key.toLowerCase()) || hasForbiddenRequestKey(item)
  ));
}

function safePath(value: unknown, prefixes: string[]): string {
  const path = asString(value, 1_000);
  if (!path) return '';
  if (path.includes('..') || path.includes('\\') || path.startsWith('/') || path.startsWith('~')) {
    throw new ProductionTaskInputError('任务输入中的产物路径不正确。');
  }
  if (!prefixes.some((prefix) => path.startsWith(prefix))) {
    throw new ProductionTaskInputError('任务输入中的产物路径不在允许范围内。');
  }
  return path;
}

function safeSlug(value: unknown): string {
  const slug = asString(value, 80);
  if (!slug) return '';
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,80}$/.test(slug)) {
    throw new ProductionTaskInputError('任务 slug 格式不正确。');
  }
  return slug;
}

function normalizeInput(kind: ProductionTaskKind, raw: unknown): JsonRecord {
  const input = asRecord(raw);
  if (hasForbiddenRequestKey(input)) {
    throw new ProductionTaskInputError('任务请求不能携带密钥、Token 或 LLM 配置。');
  }

  switch (kind) {
    case 'author-blueprint':
    case 'material-research': {
      const files = Array.isArray(input.files) ? input.files.slice(0, 40) : [];
      const topic = asString(input.topic, 240).replace(/\s+/g, ' ');
      if (kind === 'author-blueprint' && (!topic || typeof input.topic !== 'string' || input.topic.trim().length > 240)) {
        throw new ProductionTaskInputError('请填写不超过 240 字的题目。');
      }
      if (kind === 'author-blueprint' && (!/^[a-f0-9]{64}$/.test(asString(input.reviewedAnalysisSha256)) || !/^[a-f0-9]{64}$/.test(asString(input.inputFingerprint)))) {
        throw new ProductionTaskInputError('请重新读取并核对本期素材后继续。');
      }
      return {
        ...(kind === 'author-blueprint' ? { topic, templateId: asString(input.templateId, 160),
          reviewedAnalysisSha256: asString(input.reviewedAnalysisSha256, 64),
          reviewedMaterialCorrectionId: asString(input.reviewedMaterialCorrectionId, 64) } : {}),
        slug: safeSlug(input.slug),
        projectId: asString(input.projectId, 64).toLowerCase(),
        rawMaterial: asString(input.rawMaterial ?? input.materialText, 80_000),
        files,
        links: asStringList(input.links, 40, 2_000),
        selectedTypeId: asString(input.selectedTypeId, 120),
        selectedStructureId: asString(input.selectedStructureId, 120),
        platforms: asStringList(input.platforms, 3, 40).filter((platform) => (
          platform === 'wechat' || platform === 'xhs' || platform === 'shipinhao'
        )),
        inputFingerprint: asString(input.inputFingerprint, 64).toLowerCase(),
      };
    }
    case 'topic-blueprint':
      return {
        intakePath: safePath(input.intakePath, ['pipeline/intake/']),
        reportPath: safePath(input.reportPath ?? input.marketSignalPath, ['materials/research/']),
        snapshotPath: safePath(input.snapshotPath, ['runs/']),
        snapshotSha256: asString(input.snapshotSha256, 64).toLowerCase(),
        topic: asString(input.topic, 240),
        templateId: asString(input.templateId ?? input.template, 160),
        suggestionId: asString(input.suggestionId, 64),
        reviewAssertions: asRecord(input.reviewAssertions),
        platforms: asStringList(input.platforms, 3, 40).filter((platform) => (
          platform === 'wechat' || platform === 'xhs' || platform === 'shipinhao'
        )),
      };
    case 'content-package':
      return {
        slug: safeSlug(input.slug),
        topic: asString(input.topic, 240),
        blueprintPath: safePath(input.blueprintPath, ['pipeline/blueprint/']),
        platforms: asStringList(input.platforms, 3, 40).filter((platform) => (
          platform === 'wechat' || platform === 'xhs' || platform === 'shipinhao'
        )),
      };
    case 'visual-candidates':
      {
        return {
          slug: safeSlug(input.slug),
          packagePath: safePath(input.packagePath, ['pipeline/package/']),
          ...(input.regenerate === true ? { regenerate: true } : {}),
          visualPreferences: {
            mode: 'stable',
            directionCount: 2,
            providerPolicy: 'auto',
          },
        };
      }
    case 'draft-queue':
      return { packagePath: safePath(input.packagePath, ['pipeline/package/']) };
  }
}

function initialResult(kind: ProductionTaskKind): JsonRecord {
  switch (kind) {
    case 'author-blueprint':
      return { materialResearch: {}, topicBlueprint: {} };
    case 'material-research':
      return { materialResearch: {} };
    case 'topic-blueprint':
      return { topicBlueprint: {} };
    case 'content-package':
      return { contentPackage: {} };
    case 'visual-candidates':
      return { visualCandidates: {} };
    case 'draft-queue':
      return { draftQueue: {} };
  }
}

export function createProductionTask(input: {
  runId: string;
  kind: ProductionTaskKind;
  taskId?: string;
  request?: unknown;
}): ProductionTask {
  const ids = assertProductionTaskIds(input.runId, input.taskId || `task_${randomUUID()}`);
  const timestamp = now();
  return {
    schema: 'aifios.production-task.v1',
    taskId: ids.taskId as string,
    runId: ids.runId,
    kind: input.kind,
    status: 'queued',
    currentStep: null,
    steps: TASK_STEPS[input.kind].map((step) => ({ ...step, status: 'pending' })),
    startedAt: timestamp,
    updatedAt: timestamp,
    result: initialResult(input.kind),
    resumableFrom: null,
    request: normalizeInput(input.kind, input.request),
    operationJournal: {
      schema: 'aifios.production-operation-journal.v1',
      operations: [],
    },
  };
}

function isTaskStep(value: unknown): value is ProductionTaskStep {
  const step = asRecord(value);
  return typeof step.id === 'string'
    && typeof step.label === 'string'
    && ['pending', 'running', 'completed', 'skipped', 'failed', 'blocked'].includes(String(step.status));
}

function isProductionTask(value: unknown): value is ProductionTask {
  const task = asRecord(value);
  return task.schema === 'aifios.production-task.v1'
    && typeof task.taskId === 'string'
    && typeof task.runId === 'string'
    && isProductionTaskKind(task.kind)
    && ['queued', 'running', 'completed', 'failed', 'blocked'].includes(String(task.status))
    && Array.isArray(task.steps)
    && task.steps.every(isTaskStep)
    && typeof task.result === 'object'
    && typeof task.request === 'object';
}

export async function getProductionTask(runId: string, taskId: string): Promise<ProductionTask | null> {
  const path = absoluteTaskPath(runId, taskId);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isProductionTask(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Returns the newest durable task for one run after a browser/app restart. */
export async function latestProductionTaskForRun(runId: string): Promise<ProductionTask | null> {
  const ids = assertProductionTaskIds(runId);
  const directory = safeResolve(PROJECT_DIR, `runs/${ids.runId}/tasks`);
  if (!directory) throw new ProductionTaskInputError('任务目录不正确。');
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const tasks = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => getProductionTask(ids.runId, entry.name.slice(0, -'.json'.length))));
    return tasks
      .filter((task): task is ProductionTask => Boolean(task))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0]
      || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function persistProductionTask(task: ProductionTask): Promise<void> {
  const path = absoluteTaskPath(task.runId, task.taskId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(task, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export async function createOrReadProductionTask(input: {
  runId: string;
  kind: ProductionTaskKind;
  taskId?: string;
  request?: unknown;
}): Promise<{ task: ProductionTask; created: boolean }> {
  const task = createProductionTask(input);
  return withProjectWriteLock(`production-task:${task.runId}:${task.taskId}`, async () => {
    const existing = await getProductionTask(task.runId, task.taskId);
    if (existing) {
      if (existing.kind !== task.kind) throw new ProductionTaskInputError('任务编号已用于其他任务类型。');
      const existingFingerprint = writeFingerprint('production-task-request', {
        runId: existing.runId,
        kind: existing.kind,
        request: existing.request,
      });
      const requestedFingerprint = writeFingerprint('production-task-request', {
        runId: task.runId,
        kind: task.kind,
        request: task.request,
      });
      if (existingFingerprint !== requestedFingerprint) {
        throw new ProductionTaskInputError('同一任务编号已绑定不同的 run、路径或输入参数。');
      }
      return { task: existing, created: false };
    }
    await assertTaskModelSetup(task.kind);
    await persistProductionTask(task);
    return { task, created: true };
  });
}

function compactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : '任务执行失败。';
  return raw
    .replace(/(?:api[_ -]?key|authorization|token|secret)\s*[:=]\s*[^\s,，;；]+/gi, '[敏感信息已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || '任务执行失败。';
}

function stableFailureCode(value: unknown, fallback: string): string {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9_]{2,79}$/.test(code) ? code : fallback;
}

function taskFailureCode(error: unknown, blocked: boolean): string {
  if (error instanceof KnownUserFacingError) return error.definition.code;
  if (error instanceof ProductionTaskBlockedError) {
    return stableFailureCode(error.code, 'production_task_blocked');
  }
  if (error instanceof ProductionTaskAuthorityError) return 'run_authority_mismatch';
  return blocked ? 'production_task_blocked' : 'production_task_step_failed';
}

/**
 * Converts any provider/route exception into the only failure shape allowed in
 * a newly persisted task. The diagnostic logger receives the redacted detail;
 * the task file and browser receive no raw message, path, stack, or payload.
 */
function persistedTaskFailure(error: unknown, blocked: boolean, stepId?: string): ProductionTaskFailure {
  const code = taskFailureCode(error, blocked);
  const fallback = blocked
    ? '当前步骤需要你处理后才能继续。请按页面提示完成后重试。'
    : '当前步骤处理失败。请稍后重试。';
  const displayMessage = displayClientError({
    code,
    message: error instanceof Error ? error.message : '',
  }, fallback);
  const knownIntakeMessage = materialIntakeFailureMessage(code);
  const payload = userFacingErrorPayload(knownIntakeMessage
    ? new KnownUserFacingError({ code, error: knownIntakeMessage }, { detail: error })
    : error, {
    error: displayMessage,
    code,
    context: `production-task:${code}`,
  });
  return {
    code: stableFailureCode(payload.code, code),
    displayMessage: payload.error,
    debugId: payload.debugId || `err_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    ...(stepId ? { stepId } : {}),
  };
}

function projectedTaskFailure(
  value: unknown,
  fallback: string,
  stepId?: string,
): ProductionTaskFailure | undefined {
  if (!value) return undefined;
  const record = asRecord(value);
  const rawMessage = typeof value === 'string'
    ? value
    : asString(record.displayMessage || record.message, 500);
  const code = stableFailureCode(record.code, 'production_task_failed');
  const displayMessage = displayClientError({ code, message: rawMessage }, fallback);
  const storedDebugId = asString(record.debugId, 80);
  // Old records have no debug ID. Derive a stable opaque identifier instead
  // of exposing their original message or changing on every poll.
  const debugId = /^err_[a-z0-9_]{6,72}$/i.test(storedDebugId)
    ? storedDebugId
    : `err_legacy_${writeFingerprint('legacy-task-error', { code, stepId, rawMessage }).replace(/[^a-f0-9]/gi, '').slice(0, 12) || 'unknown'}`;
  return { code, displayMessage, debugId, ...(stepId ? { stepId } : {}) };
}

function request(url: string, body: JsonRecord): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function jsonResponse(response: Response): Promise<JsonRecord> {
  const payload = await response.json().catch(() => ({}));
  return asRecord(payload);
}

async function requireOk(response: Response, fallback: string): Promise<JsonRecord> {
  const payload = await jsonResponse(response);
  if (!response.ok) {
    const intakeCode = asString(payload.code, 80);
    const intakeMessage = materialIntakeFailureMessage(intakeCode);
    if (intakeMessage) {
      if (response.status === 409) throw new ProductionTaskBlockedError(intakeMessage, intakeCode);
      throw new KnownUserFacingError({ code: intakeCode, error: intakeMessage }, { status: response.status });
    }
    const message = asString(payload.message || payload.error, 500) || fallback;
    if (response.status === 409 || response.status === 424 || payload.blocked === true) {
      throw new ProductionTaskBlockedError(message, asString(payload.code, 80) || undefined);
    }
    throw new Error(message);
  }
  return payload;
}

async function assertCompletePlatformNativePackage(packagePath: string): Promise<void> {
  let content = '';
  try {
    content = await readOutputFile(packagePath);
  } catch {
    throw new ProductionTaskBlockedError(
      '第 3 步的原生内容无法读取。请返回第 3 步重新生成并确认内容。',
      'content_package_incomplete',
      { operationOutcome: 'known_blocked' },
    );
  }
  const gate = await runContentReleaseGate(content);
  const manifest = asRecord(gate.package_manifest);
  if (gate.status === 'blocked' || manifest.valid === false) {
    throw new ProductionTaskBlockedError(
      '第 3 步没有完整生成已选平台的原生内容。请返回第 3 步重新生成；内容完整前不会进入配图。',
      'content_package_incomplete',
      { operationOutcome: 'known_blocked' },
    );
  }
}

type AgentInvocationResult = { path: string; validation?: JsonRecord; warnings?: string[] };

async function invokeTaskAgent(skill: string, params: JsonRecord, onPartial?: (attemptId: string) => void): Promise<AgentInvocationResult> {
  const response = await invokeAgent(request('http://localhost/api/agent/invoke', {
    skill,
    params,
    // The route resolves server-local credentials. Keeping this empty means
    // no credential can enter the durable task record.
    config: {},
  }) as never);
  if (!response.ok) {
    throw new Error((await response.text()).slice(0, 500) || `${skill} 执行失败。`);
  }
  const source = await response.text();
  let path = '';
  let validation: JsonRecord | undefined;
  let failure = '';
  let failureCode = '';
  const warnings = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6);
    if (raw === '[DONE]') continue;
    try {
      const event = asRecord(JSON.parse(raw));
      if (event.type === 'partial' && typeof event.attemptId === 'string' && /^attempt_[a-f0-9]{32}$/.test(event.attemptId)) onPartial?.(event.attemptId);
      if (event.type === 'saved') path = asString(event.path, 1_000);
      if (event.type === 'validation') validation = event;
      if (event.type === 'error') {
        failure = asString(event.content, 500);
        failureCode = asString(event.code, 80);
      }
      if (event.type === 'language_quality' && event.status === 'review_required') {
        warnings.add('内容有几处表达偏模板化，发布前请再检查一次。');
      }
      if (event.type === 'release_gate' && event.status === 'review_required') {
        warnings.add('全部内容有几处需要你在发布前确认。');
      }
    } catch {
      // A malformed event cannot be treated as a successful artifact write.
    }
  }
  if (failure) {
    if (failureCode === 'content_release_blocked') {
      throw new ProductionTaskBlockedError(failure, failureCode, {
        operationOutcome: 'known_blocked',
      });
    }
    throw new Error(failure);
  }
  if (!path) throw new Error(`${skill} 未返回可恢复的产物路径。`);
  return {
    path,
    ...(validation ? { validation } : {}),
    ...(warnings.size ? { warnings: [...warnings] } : {}),
  };
}

function resultSection(task: ProductionTask, name: string): JsonRecord {
  const current = asRecord(task.result[name]);
  task.result = { ...task.result, [name]: current };
  return current;
}

function applyOperationReconciliation(
  task: ProductionTask,
  reconciliation: ProductionOperationReconciliation,
): JsonRecord {
  if (!reconciliation.completed
    || !reconciliation.section
    || !reconciliation.sectionPatch
    || !reconciliation.stepResult
    || !reconciliation.observed) {
    throw new ProductionTaskBlockedError(
      reconciliation.reason || '外部操作没有可验证的权威产物。',
      'operation_effect_unverified',
    );
  }
  Object.assign(resultSection(task, reconciliation.section), reconciliation.sectionPatch);
  return reconciliation.stepResult;
}

async function assertTaskModelSetup(kind: ProductionTaskKind): Promise<void> {
  if (kind !== 'topic-blueprint' && kind !== 'content-package') return;
  const config = await resolveServerLLMConfig({});
  if (validateLLMConfig(config).length || !getApiKey(config).trim()) {
    throw new KnownUserFacingError({
      error: '请先完成模型连接，再回到本期继续。已有素材和选题保留，本次尚未调用生成服务。',
      code: 'model_setup_required',
      action: { label: '连接写作服务', href: '/settings#model-connection' },
    }, { status: 422 });
  }
}

async function preparePaidStepInputs(task: ProductionTask, step: ProductionTaskStep): Promise<void> {
  if (!step.operationId && ['content-validate', 'content-blueprint', 'wechat-writer', 'content-package'].includes(step.id)) {
    // Local configuration errors precede dispatch and cannot represent an
    // indeterminate paid operation. Never persist resolved credentials.
    const config = await resolveServerLLMConfig({});
    if (validateLLMConfig(config).length || !getApiKey(config).trim()) {
      throw new ProductionTaskBlockedError(
        '生成服务尚未配置完整。请到系统设置保存模型设置并测试连接，再重试这一步；本次尚未调用生成服务。',
        'model_setup_required',
        { operationOutcome: 'known_blocked' },
      );
    }
  }
  if (task.kind === 'material-research' && step.id === 'market-research') {
    // Keep local selection persistence outside the paid-operation dispatch
    // boundary. A failure here is known not to have contacted TikOmni.
    await persistTaskMaterialDirection(task);
  }
  if (task.kind === 'visual-candidates' && step.id === 'visual-candidates') {
    // Validate the source before the operation journal crosses the dispatch
    // boundary. Missing platform content is a deterministic local blocker, not
    // an unknown image-provider result and never a reason to show a fee warning.
    await assertCompletePlatformNativePackage(asString(task.request.packagePath, 1_000));
  }
}

function unknownOperationFailure(
  operation: ProductionTaskOperation | null,
  reason: string,
): ProductionTaskBlockedError {
  const safeReason = reason.trim().slice(0, 500) || '外部操作结果无法验证。';
  if (operation) markProductionTaskOperationIndeterminate(operation, safeReason);
  return new ProductionTaskBlockedError(
    '外部生成操作可能已经发生，但本地无法证明其完整结果。系统已停止自动重试，请人工确认后再重试，避免重复调用或重复计费。',
    'operation_outcome_unknown',
    {
      ...(operation ? {
        operationId: operation.operation_id,
        operationClass: operation.operation_class,
      } : {}),
      reason: safeReason,
    },
  );
}

async function completeStep(task: ProductionTask, step: ProductionTaskStep, result: JsonRecord): Promise<void> {
  step.status = 'completed';
  step.completedAt = now();
  step.error = undefined;
  step.result = result;
  task.currentStep = null;
  task.updatedAt = now();
  await persistProductionTask(task);
}

async function runMaterialAnalysis(task: ProductionTask): Promise<JsonRecord> {
  const context = await persistTaskMaterialDirection(task);
  const materialResearch = resultSection(task, 'materialResearch');
  materialResearch.inputFingerprint = asString(context.inputFingerprint, 128);
  materialResearch.analysisStatus = asString(context.analysisStatus, 80);
  return { inputFingerprint: materialResearch.inputFingerprint, analysisStatus: materialResearch.analysisStatus };
}

async function persistTaskMaterialDirection(task: ProductionTask): Promise<JsonRecord> {
  const input = task.request;
  // The input snapshot was already persisted by the analysis step. Submitting
  // rawMaterial/files/links again here would trip the "new input invalidates
  // the previous selection" rule and wipe the operator's type/structure choice,
  // which then blocks the intake step. Persist only the direction.
  const expectedInputFingerprint = asString(input.inputFingerprint, 64).toLowerCase();
  const response = await saveMaterialAnalysis(request('http://localhost/api/production/material-analysis', {
    runId: task.runId,
    ...(asString(input.projectId) ? { projectId: asString(input.projectId) } : {}),
    ...(expectedInputFingerprint ? { expectedInputFingerprint } : {}),
    selectedTypeId: asString(input.selectedTypeId, 120),
    selectedStructureId: asString(input.selectedStructureId, 120),
  }) as never);
  const payload = await requireOk(response, '保存素材判断失败。');
  const context = asRecord(payload.context);
  const selection = asRecord(context.selection);
  if (
    asString(selection.materialTypeId) !== asString(input.selectedTypeId)
    || asString(selection.structureId) !== asString(input.selectedStructureId)
  ) {
    throw new ProductionTaskBlockedError('本期素材判断没有保存成功。请重新整理素材后再试。', 'material_direction_not_saved');
  }
  return context;
}

async function runMaterialIntake(task: ProductionTask): Promise<JsonRecord> {
  // Reassert the operator's direction here because a late browser autosave
  // must never clear it in the gap between the durable task's first two steps.
  await persistTaskMaterialDirection(task);
  const response = await buildMaterialIntake(request('http://localhost/api/production/intake', { runId: task.runId }) as never);
  const payload = await requireOk(response, '构建素材理解报告失败。');
  const intakePath = safePath(payload.path, ['pipeline/intake/']);
  const materialResearch = resultSection(task, 'materialResearch');
  materialResearch.intakePath = intakePath;
  const warnings = asStringList(asRecord(payload.languageQuality).warnings, 6, 240);
  if (warnings.length) materialResearch.warnings = warnings;
  return { intakePath, ...(warnings.length ? { warnings } : {}) };
}

async function runAuthorSource(task: ProductionTask): Promise<JsonRecord> {
  return withProjectWriteLock(`material-analysis:${task.runId}`, async () => {
    const material = resultSection(task, 'materialResearch');
    const section = resultSection(task, 'topicBlueprint');
    let prepared = material.authorSourceRequest as AuthorSourceRequest | undefined;
    if (!prepared) {
      const context = await getRuntimeAuthorSourceContext(task.runId);
      if (context.intake_path !== material.intakePath
          || context.material.input_fingerprint !== task.request.inputFingerprint
          || await authorAnalysisFingerprint(context.material.analysis) !== task.request.reviewedAnalysisSha256
          || context.material.correction_id !== (task.request.reviewedMaterialCorrectionId || '')) {
        throw new ProductionTaskBlockedError('素材或修正已变化，请重新读取并核对后继续。', 'author_source_changed');
      }
      prepared = { run_id: task.runId, id: `author_${randomUUID().replaceAll('-', '')}`,
        topic: asString(task.request.topic, 240), intake_path: context.intake_path,
        intake_sha256: context.intake_sha256, material_sha256: context.material_sha256,
        source_revision: context.source_revision };
      material.authorSourceRequest = prepared;
      // Persist before the local runtime commit. A lost response reuses the
      // same ID and displayed source revision, never silently selects anew.
      await persistProductionTask(task);
    }
    const binding = await selectRuntimeAuthorSource(prepared);
    if (binding.run_id !== task.runId || binding.topic !== task.request.topic) {
      throw new ProductionTaskBlockedError('题目与本期素材依据没有保存成功。', 'author_source_changed');
    }
    Object.assign(section, { topic: binding.topic, runSlug: binding.slug, authorSource: binding });
    return { authorSource: binding, topic: binding.topic, runSlug: binding.slug };
  });
}

async function runMarketResearch(task: ProductionTask): Promise<JsonRecord> {
  const materialResearch = resultSection(task, 'materialResearch');
  const intakePath = asString(materialResearch.intakePath);
  if (!intakePath) throw new ProductionTaskBlockedError('当前任务缺少可验证的素材理解报告。', 'intake_required');
  const response = await collectMarketSignal(request('http://localhost/api/research/market-signal', {
    sourcePath: intakePath,
    slug: asString(task.request.slug) || task.runId,
    topic: '',
    runId: task.runId,
    platforms: asStringList(task.request.platforms, 3, 40),
  }));
  const payload = await jsonResponse(response);
  if (!response.ok || payload.blocked === true) {
    throw new ProductionTaskBlockedError(
      asString(payload.message || payload.error, 500) || 'TikOmni 已选平台研究未通过，不能继续立项。',
      asString(payload.code, 80) || 'tikomni_blocked',
      marketResearchDiagnostics(payload),
    );
  }
  const reportPath = safePath(payload.path, ['materials/research/']);
  const snapshotPath = safePath(payload.snapshotPath, ['runs/']);
  const snapshotSha256 = asString(payload.snapshotSha256, 64).toLowerCase();
  if (!reportPath || !snapshotPath || !/^[a-f0-9]{64}$/.test(snapshotSha256)) {
    throw new ProductionTaskBlockedError('TikOmni 研究未生成可校验快照，不能继续立项。', 'research_snapshot_invalid');
  }
  Object.assign(materialResearch, {
    reportPath,
    snapshotPath,
    snapshotSha256,
    sampleCount: typeof payload.sampleCount === 'number' ? payload.sampleCount : 0,
    queries: asStringList(payload.queries, 12, 120),
    requiredPlatforms: asStringList(payload.requiredPlatforms, 3, 80),
    readyPlatforms: asStringList(payload.readyPlatforms, 3, 80),
    partial: payload.partial === true,
    platformChecks: asRecord(payload.platformChecks),
  });
  return { ...materialResearch };
}

async function runTopicSuggestions(task: ProductionTask): Promise<JsonRecord> {
  const materialResearch = resultSection(task, 'materialResearch');
  const response = await prewarmTopicSuggestions(request('http://localhost/api/research/topic-suggestions', {
    mode: 'prewarm',
    runId: task.runId,
    snapshotPath: asString(materialResearch.snapshotPath),
    snapshotSha256: asString(materialResearch.snapshotSha256),
  }) as never);
  // Topic prewarming is an acceleration only. A recovered task still has a
  // valid research snapshot when this optional cache build fails.
  if (!response.ok) return { prewarmed: false };
  const payload = await jsonResponse(response);
  materialResearch.topicSuggestionsPrewarmed = payload.ok === true;
  return { prewarmed: payload.ok === true };
}

async function runTopicSelection(task: ProductionTask): Promise<JsonRecord> {
  const input = task.request;
  const response = await saveTopicSelection(request('http://localhost/api/research/topic-selection', {
    runId: task.runId,
    snapshotPath: asString(input.snapshotPath),
    snapshotSha256: asString(input.snapshotSha256),
    topic: asString(input.topic, 240),
    ...(asString(input.suggestionId, 64) ? { suggestionId: asString(input.suggestionId, 64) } : {}),
  }) as never);
  const payload = await requireOk(response, '保存本期主题失败。');
  const section = resultSection(task, 'topicBlueprint');
  section.topic = asString(payload.topic, 240) || asString(input.topic, 240);
  section.runSlug = asString(payload.runSlug, 80);
  return { topic: section.topic, runSlug: section.runSlug };
}

async function runTemplateBinding(task: ProductionTask): Promise<JsonRecord> {
  const response = await bindTemplate(request('http://localhost/api/run/template', {
    runId: task.runId,
    templateId: asString(task.request.templateId, 160),
  }) as never);
  await requireOk(response, '绑定品牌模板失败。');
  return { templateId: asString(task.request.templateId, 160) };
}

async function runValidate(task: ProductionTask): Promise<JsonRecord> {
  const input = task.request;
  const section = resultSection(task, 'topicBlueprint');
  const result = await invokeTaskAgent('content-validate', {
    topic: asString(section.topic, 240) || asString(input.topic, 240),
    source: asString(input.intakePath),
    marketSignalPath: asString(input.reportPath),
    businessFirst: false,
    allowLowEvidenceReframe: false,
  });
  section.validatePath = result.path;
  if (result.validation?.valid !== true) {
    throw new ProductionTaskBlockedError(
      '立项报告未完整生成，系统已停在立项校验步骤，避免使用缺少决策的报告继续生成内容蓝图。请从此处重试。',
      'validate_output_incomplete',
      {
        validation: result.validation || {},
        operationOutcome: 'known_blocked',
      },
    );
  }
  return { validatePath: result.path, ...(result.validation ? { validation: result.validation } : {}) };
}

async function runBlueprint(task: ProductionTask): Promise<JsonRecord> {
  const input = task.request;
  const section = resultSection(task, 'topicBlueprint');
  const validatePath = asString(section.validatePath);
  const ownTopic = task.kind === 'author-blueprint';
  if (ownTopic) {
    const source = await verifyRuntimeAuthorSource(task.runId);
    const chosen = asRecord(section.authorSource);
    if (source.author_evidence_path !== chosen.author_evidence_path || source.author_evidence_sha256 !== chosen.author_evidence_sha256) {
      throw new ProductionTaskBlockedError('写作依据已变化，请核对后重新开始。', 'author_source_changed');
    }
  } else if (!validatePath) throw new ProductionTaskBlockedError('当前任务缺少有效立项报告。', 'validate_required');
  const result = await invokeTaskAgent('content-blueprint', {
    topic: asString(section.topic, 240) || asString(input.topic, 240),
    ...(ownTopic ? { intakeReportPath: asString(asRecord(task.result.materialResearch).intakePath) } : {
      validateReportPath: validatePath,
      intakeReportPath: asString(input.intakePath),
      marketSignalPath: asString(input.reportPath),
    }),
    platforms: asStringList(input.platforms, 3, 40),
  });
  section.blueprintPath = result.path;
  if (result.warnings?.length) section.warnings = result.warnings;
  return {
    blueprintPath: result.path,
    ...(result.validation ? { validation: result.validation } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}

async function runArticle(task: ProductionTask): Promise<JsonRecord> {
  const input = task.request;
  const result = await invokeTaskAgent('wechat-writer', {
    topic: asString(input.topic, 240),
    blueprintPath: asString(input.blueprintPath),
    wordCount: 1800,
    slug: asString(input.slug),
  });
  const section = resultSection(task, 'contentPackage');
  section.articlePath = result.path;
  if (result.warnings?.length) section.warnings = result.warnings;
  return {
    articlePath: result.path,
    ...(result.validation ? { validation: result.validation } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}

async function runContentPackage(task: ProductionTask): Promise<JsonRecord> {
  const section = resultSection(task, 'contentPackage');
  const blueprintPath = asString(task.request.blueprintPath);
  if (!blueprintPath) throw new ProductionTaskBlockedError('当前任务缺少已确认的平台内容蓝图。', 'blueprint_required');
  const result = await invokeTaskAgent('content-package', {
    topic: asString(task.request.topic, 240),
    blueprintPath,
    platforms: asStringList(task.request.platforms, 3, 40),
    slug: asString(task.request.slug),
  }, (attemptId) => { section.attemptId = attemptId; });
  if (result.validation && result.validation.valid === false) {
    throw new ProductionTaskBlockedError(
      '已选平台的内容没有完整生成。请在第 3 步重新生成；完整内容通过检查前不会进入配图。',
      'content_package_incomplete',
      { operationOutcome: 'known_blocked' },
    );
  }
  section.packagePath = result.path;
  const warnings = [...new Set([
    ...asStringList(section.warnings),
    ...(result.warnings || []),
  ])];
  if (warnings.length) section.warnings = warnings;
  return {
    packagePath: result.path,
    ...(result.validation ? { validation: result.validation } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

async function runVisualCandidates(task: ProductionTask): Promise<JsonRecord> {
  const response = await publishVisualCandidates(request('http://localhost/api/visual/publish', {
    slug: asString(task.request.slug),
    packagePath: asString(task.request.packagePath),
    ...(task.request.regenerate === true ? { regenerate: true } : {}),
    visualPreferences: {
      mode: 'stable',
      directionCount: 2,
      providerPolicy: 'auto',
    },
    // Generate the publish layout without invoking an image-generation service.
    previewOnly: false,
  }));
  await requireOk(response, '生成视觉候选失败。');
  const section = resultSection(task, 'visualCandidates');
  section.slug = asString(task.request.slug);
  return { slug: section.slug };
}

async function runDraftQueue(task: ProductionTask): Promise<JsonRecord> {
  const response = await preparePublishAssets(request('http://localhost/api/publish-assets', {
    packagePath: asString(task.request.packagePath),
  }));
  const payload = await requireOk(response, '整理三类成品失败。');
  const section = resultSection(task, 'draftQueue');
  section.draftQueuePath = safePath(payload.draftQueuePath, ['materials/', 'pipeline/']);
  section.draftQueue = asRecord(payload.draftQueue);
  return { draftQueuePath: section.draftQueuePath, draftQueue: section.draftQueue };
}

async function executeStep(task: ProductionTask, step: ProductionTaskStep): Promise<JsonRecord> {
  switch (`${task.kind}:${step.id}`) {
    case 'author-blueprint:material-analysis': return runMaterialAnalysis(task);
    case 'author-blueprint:material-intake': return runMaterialIntake(task);
    case 'author-blueprint:author-source': return runAuthorSource(task);
    case 'author-blueprint:template-binding': return runTemplateBinding(task);
    case 'author-blueprint:content-blueprint': return runBlueprint(task);
    case 'material-research:material-analysis': return runMaterialAnalysis(task);
    case 'material-research:material-intake': return runMaterialIntake(task);
    case 'material-research:market-research': return runMarketResearch(task);
    case 'material-research:topic-suggestions': return runTopicSuggestions(task);
    case 'topic-blueprint:topic-selection': return runTopicSelection(task);
    case 'topic-blueprint:template-binding': return runTemplateBinding(task);
    case 'topic-blueprint:content-validate': return runValidate(task);
    case 'topic-blueprint:content-blueprint': return runBlueprint(task);
    // Read compatibility for tasks persisted before the platform-native v2
    // flow removed the intermediate WeChat mother-draft step.
    case 'content-package:wechat-writer': return runArticle(task);
    case 'content-package:content-package': return runContentPackage(task);
    case 'visual-candidates:visual-candidates': return runVisualCandidates(task);
    case 'draft-queue:draft-queue': return runDraftQueue(task);
    default: throw new Error(`未实现的任务步骤：${step.id}`);
  }
}

async function executeProductionTask(runId: string, taskId: string): Promise<void> {
  await withProjectWriteLock(`production-task:${runId}:${taskId}`, async () => {
    const task = await getProductionTask(runId, taskId);
    if (!task || task.status === 'completed') return;
    await ensureProjectInitialized();
    task.status = 'running';
    task.error = undefined;
    task.resumableFrom = null;
    task.updatedAt = now();
    await persistProductionTask(task);

    for (const step of task.steps) {
      if (step.status === 'completed' || step.status === 'skipped') continue;
      let operation: ProductionTaskOperation | null = null;
      try {
        const authoritativeRun = await assertProductionTaskRunAuthority(task);
        await preparePaidStepInputs(task, step);
        if (isRecoverablePaidProductionStep(task, step.id)) {
          if (step.operationId) {
            throw unknownOperationFailure(
              productionTaskOperation(task, step.operationId),
              '待执行步骤仍绑定旧 operation，必须先完成人工重试确认。',
            );
          }
          operation = await prepareProductionTaskOperation(task, step.id, authoritativeRun);
          if (!operation) throw new Error('付费步骤未能建立 operation journal。');
          step.operationId = operation.operation_id;
        }

        step.status = 'running';
        step.startedAt = now();
        step.completedAt = undefined;
        step.error = undefined;
        task.currentStep = step.id;
        task.updatedAt = now();
        // Persist the prepared journal atomically with the running step. A
        // crash before this point has not crossed an external side-effect
        // boundary and therefore remains safe to queue.
        await persistProductionTask(task);

        if (operation) {
          dispatchProductionTaskOperation(operation, now());
          task.updatedAt = now();
          // This durable dispatched marker is written immediately before the
          // provider call. Recovery will never auto-dispatch it a second time.
          await persistProductionTask(task);
        }

        let result = await executeStep(task, step);
        // Several steps write runtime artifacts. Resolve the run again after
        // the write so a returned path for another run is never persisted as
        // a successfully completed durable step.
        await assertProductionTaskRunAuthority(task);
        if (operation) {
          const reconciliation = await reconcileProductionTaskOperation(task, operation);
          result = applyOperationReconciliation(task, reconciliation);
          await assertProductionTaskRunAuthority(task);
          commitProductionTaskOperation(operation, reconciliation.observed as NonNullable<typeof operation.observed>, now());
        }
        await completeStep(task, step, result);
      } catch (error) {
        let failure = error;
        // A route error does not prove the provider failed before committing
        // its work. Reconcile once against authoritative runtime artifacts;
        // complete locally when proof exists, otherwise stop for a human.
        const knownBlockedOutcome = failure instanceof ProductionTaskBlockedError
          && failure.details?.operationOutcome === 'known_blocked';
        if (operation?.state === 'dispatched' && knownBlockedOutcome) {
          // The internal route received a complete negative provider result.
          // Preserve its actionable blockers and allow an explicit retry;
          // there is no successful artifact to reconcile in this branch.
          recordProductionTaskOperationBlocked(
            operation,
            displayClientError(failure, '外部服务没有返回可用结果。请处理后重试。'),
          );
        } else if (operation?.state === 'dispatched') {
          try {
            const reconciliation = await reconcileProductionTaskOperation(task, operation);
            if (reconciliation.completed && reconciliation.observed) {
              const recoveredResult = applyOperationReconciliation(task, reconciliation);
              await assertProductionTaskRunAuthority(task);
              commitProductionTaskOperation(operation, reconciliation.observed, now());
              await completeStep(task, step, recoveredResult);
              continue;
            }
            failure = unknownOperationFailure(
              operation,
              reconciliation.reason || compactError(error),
            );
          } catch (reconciliationError) {
            failure = unknownOperationFailure(operation, compactError(reconciliationError));
          }
        }
        const blocked = failure instanceof ProductionTaskBlockedError
          || failure instanceof ProductionTaskAuthorityError;
        const safeFailure = persistedTaskFailure(failure, blocked, step.id);
        step.status = blocked ? 'blocked' : 'failed';
        step.error = safeFailure;
        step.completedAt = now();
        task.status = blocked ? 'blocked' : 'failed';
        task.currentStep = step.id;
        task.resumableFrom = step.id;
        task.error = safeFailure;
        task.updatedAt = now();
        await persistProductionTask(task);
        return;
      }
    }
    task.status = 'completed';
    task.currentStep = null;
    task.resumableFrom = null;
    task.completedAt = now();
    task.updatedAt = now();
    await persistProductionTask(task);
  });
}

/**
 * Reconciles a task left in `running` by a dead process. Local-only steps and
 * paid operations that never crossed the durable dispatch boundary are safe
 * to queue. Dispatched TikOmni/LLM/visual operations are completed only when
 * their run-scoped output and lineage can be proved; unknown outcomes stop for
 * explicit human retry instead of being charged a second time automatically.
 */
export async function recoverInterruptedProductionTask(
  runId: string,
  taskId: string,
): Promise<{ task: ProductionTask; recovered: boolean }> {
  const ids = assertProductionTaskIds(runId, taskId);
  const key = taskKey(ids.runId, ids.taskId as string);
  if (activeTasks.has(key)) {
    const active = await getProductionTask(ids.runId, ids.taskId as string);
    if (!active) throw new ProductionTaskInputError('任务不存在。');
    return { task: active, recovered: false };
  }
  return withProjectWriteLock(`production-task:${ids.runId}:${ids.taskId}`, async () => {
    const task = await getProductionTask(ids.runId, ids.taskId as string);
    if (!task) throw new ProductionTaskInputError('任务不存在。');
    if (task.status !== 'running') return { task, recovered: false };

    const interrupted = task.steps.find((step) => step.status === 'running')
      || task.steps.find((step) => step.id === task.currentStep)
      || task.steps.find((step) => step.status === 'pending');
    if (!interrupted) {
      task.status = task.steps.every((step) => ['completed', 'skipped'].includes(step.status))
        ? 'completed'
        : 'blocked';
      task.currentStep = null;
      task.resumableFrom = null;
      task.updatedAt = now();
      await persistProductionTask(task);
      return { task, recovered: true };
    }

    const paid = isRecoverablePaidProductionStep(task, interrupted.id);
    const operation = productionTaskOperation(task, interrupted.operationId);

    if (paid && operation?.state === 'dispatched') {
      let reconciliation: ProductionOperationReconciliation;
      try {
        reconciliation = await reconcileProductionTaskOperation(task, operation);
        if (reconciliation.completed && reconciliation.observed) {
          const recoveredResult = applyOperationReconciliation(task, reconciliation);
          await assertProductionTaskRunAuthority(task);
          commitProductionTaskOperation(operation, reconciliation.observed, now());
          interrupted.status = 'completed';
          interrupted.completedAt = now();
          interrupted.error = undefined;
          interrupted.result = recoveredResult;
          const next = task.steps.find((step) => !['completed', 'skipped'].includes(step.status));
          task.status = next ? 'queued' : 'completed';
          task.currentStep = null;
          task.resumableFrom = next?.id || null;
          task.error = undefined;
          task.completedAt = next ? undefined : now();
          task.updatedAt = now();
          await persistProductionTask(task);
          return { task, recovered: true };
        }
      } catch (error) {
        reconciliation = { completed: false, reason: compactError(error) };
      }

      const failure = unknownOperationFailure(
        operation,
        reconciliation.reason || '已调度的外部操作没有可核验的完整产物。',
      );
      const safeFailure = persistedTaskFailure(failure, true, interrupted.id);
      interrupted.status = 'blocked';
      interrupted.completedAt = now();
      interrupted.error = safeFailure;
      task.status = 'blocked';
      task.currentStep = interrupted.id;
      task.resumableFrom = interrupted.id;
      task.error = safeFailure;
      task.updatedAt = now();
      await persistProductionTask(task);
      return { task, recovered: true };
    }

    const safeBeforeDispatch = !paid
      || interrupted.status === 'pending'
      || operation?.state === 'prepared';
    if (safeBeforeDispatch) {
      if (operation?.state === 'prepared') {
        abandonProductionTaskOperation(operation, now());
        delete interrupted.operationId;
      }
      for (const step of task.steps) {
        if (step.status !== 'running') continue;
        step.status = 'pending';
        step.startedAt = undefined;
        step.completedAt = undefined;
        step.error = undefined;
      }
      task.status = 'queued';
      task.currentStep = null;
      task.resumableFrom = interrupted.id;
      task.error = undefined;
      task.completedAt = undefined;
      task.updatedAt = now();
      await persistProductionTask(task);
      return { task, recovered: true };
    }

    const failure = unknownOperationFailure(
      operation,
      operation
        ? `operation 状态为 ${operation.state}，不能证明可安全自动重试。`
        : '旧版付费任务没有 dispatch journal，不能证明外部调用尚未发生。',
    );
    const safeFailure = persistedTaskFailure(failure, true, interrupted.id);
    interrupted.status = 'blocked';
    interrupted.completedAt = now();
    interrupted.error = safeFailure;
    task.status = 'blocked';
    task.currentStep = interrupted.id;
    task.resumableFrom = interrupted.id;
    task.error = safeFailure;
    task.updatedAt = now();
    await persistProductionTask(task);
    return { task, recovered: true };
  }, { timeoutMs: 5_000, staleMs: 0 });
}

/**
 * Repairs the specific legacy state where a deterministic, local package
 * validation failure was persisted as an indeterminate external visual call.
 * This is deliberately narrow: a complete package leaves the old task
 * untouched because its provider outcome may genuinely need reconciliation.
 */
export async function refreshKnownLocalProductionTaskFailure(
  task: ProductionTask,
): Promise<ProductionTask> {
  const visualMode = asString(asRecord(task.request.visualPreferences).mode, 32);
  if (
    task.status !== 'blocked'
    || task.kind !== 'visual-candidates'
    || task.error?.code !== 'operation_outcome_unknown'
    || visualMode !== 'stable'
  ) return task;

  try {
    await assertCompletePlatformNativePackage(asString(task.request.packagePath, 1_000));
    return task;
  } catch (error) {
    if (!(error instanceof ProductionTaskBlockedError)) return task;
    return withProjectWriteLock(`production-task:${task.runId}:${task.taskId}`, async () => {
      const current = await getProductionTask(task.runId, task.taskId);
      if (!current) throw new ProductionTaskInputError('任务不存在。');
      const currentMode = asString(asRecord(current.request.visualPreferences).mode, 32);
      if (
        current.status !== 'blocked'
        || current.kind !== 'visual-candidates'
        || current.error?.code !== 'operation_outcome_unknown'
        || currentMode !== 'stable'
      ) return current;

      const step = current.steps.find((item) => item.id === current.resumableFrom)
        || current.steps.find((item) => item.status === 'blocked' || item.status === 'failed')
        || current.steps.find((item) => item.id === current.currentStep);
      if (!step) return current;
      const operation = productionTaskOperation(current, step.operationId);
      if (operation?.state === 'indeterminate') abandonProductionTaskOperation(operation, now());

      const failure = persistedTaskFailure(error, true, step.id);
      step.status = 'blocked';
      step.completedAt = now();
      step.error = failure;
      current.status = 'blocked';
      current.currentStep = step.id;
      current.resumableFrom = step.id;
      current.error = failure;
      current.updatedAt = now();
      await persistProductionTask(current);
      return current;
    });
  }
}

/** Starts a durable task without holding the HTTP request open. */
export function scheduleProductionTask(runId: string, taskId: string): void {
  const ids = assertProductionTaskIds(runId, taskId);
  const key = taskKey(ids.runId, ids.taskId as string);
  if (activeTasks.has(key)) return;
  const execution = executeProductionTask(ids.runId, ids.taskId as string)
    .catch(() => {
      // Execution errors are persisted on the task where possible. The route
      // deliberately never turns a background failure into an unhandled rejection.
    })
    .finally(() => activeTasks.delete(key));
  activeTasks.set(key, execution);
}

export type ProductionTaskRetryMode = 'default' | 'recover' | 'redispatch';

export async function retryProductionTask(
  runId: string,
  taskId: string,
  mode: ProductionTaskRetryMode = 'default',
): Promise<ProductionTask> {
  const ids = assertProductionTaskIds(runId, taskId);
  return withProjectWriteLock(`production-task:${ids.runId}:${ids.taskId}`, async () => {
    const task = await getProductionTask(ids.runId, ids.taskId as string);
    if (!task) throw new ProductionTaskInputError('任务不存在。');
    if (task.status === 'completed') throw new ProductionTaskInputError('已完成任务不需要重试。');
    if (task.status === 'running') throw new ProductionTaskInputError('任务正在执行，请等待当前步骤结束。');
    let resumeIndex = task.steps.findIndex((step) => step.status === 'failed' || step.status === 'blocked');
    if (resumeIndex < 0) throw new ProductionTaskInputError('当前任务没有可重试的失败步骤。');

    // Older tasks could persist an invalid validate artifact as "completed"
    // and then fail one step later while generating the blueprint. Resume from
    // that invalid upstream artifact so retry actually repairs the cause.
    const invalidValidateIndex = task.steps.findIndex((step) => (
      step.id === 'content-validate'
      && asRecord(step.result?.validation).valid === false
    ));
    if (invalidValidateIndex >= 0 && invalidValidateIndex < resumeIndex) {
      resumeIndex = invalidValidateIndex;
    }

    const blockedStep = task.steps[resumeIndex];
    const blockedOperation = productionTaskOperation(task, blockedStep.operationId);
    const safeLocalVisualRetry = task.kind === 'visual-candidates';
    if (task.error?.code === 'operation_outcome_unknown'
      && blockedOperation
      && blockedOperation.state === 'indeterminate'
      && mode !== 'redispatch'
      && !safeLocalVisualRetry) {
      const reconciliation = await reconcileProductionTaskOperation(task, blockedOperation);
      if (!reconciliation.completed || !reconciliation.observed) {
        throw new ProductionTaskInputError(
          reconciliation.reason || '未找到可验证的已有完整结果；任务保持阻断，没有重新调用外部服务。',
        );
      }
      const recoveredResult = applyOperationReconciliation(task, reconciliation);
      commitProductionTaskOperation(blockedOperation, reconciliation.observed, now());
      blockedStep.status = 'completed';
      blockedStep.completedAt = now();
      blockedStep.error = undefined;
      blockedStep.result = recoveredResult;
      const next = task.steps.slice(resumeIndex + 1).find((step) => !['completed', 'skipped'].includes(step.status));
      task.status = 'queued';
      task.currentStep = null;
      task.resumableFrom = next?.id || null;
      task.error = undefined;
      task.completedAt = undefined;
      task.updatedAt = now();
      await persistProductionTask(task);
      return task;
    }

    // Recovering a saved result above remains possible without credentials.
    // A new dispatch must pass setup before mutating attempts or approvals.
    await assertTaskModelSetup(task.kind);
    if (task.error?.code === 'operation_outcome_unknown'
      && blockedOperation
      && blockedOperation.state === 'indeterminate'
      && (mode === 'redispatch' || safeLocalVisualRetry)) {
      // This branch is reachable only through the explicit UI confirmation.
      // Record the operator-authorized abandonment before a new operation can
      // be prepared, preserving the original attempt in the journal.
      abandonProductionTaskOperation(blockedOperation, now());
    }

    for (let index = resumeIndex; index < task.steps.length; index += 1) {
      const step = task.steps[index];
      const operation = productionTaskOperation(task, step.operationId);
      if (operation) abandonProductionTaskOperation(operation, now());
      delete step.operationId;
      step.status = 'pending';
      step.startedAt = undefined;
      step.completedAt = undefined;
      step.error = undefined;
      step.result = undefined;
    }
    task.status = 'queued';
    task.currentStep = null;
    task.resumableFrom = task.steps[resumeIndex].id;
    task.error = undefined;
    task.completedAt = undefined;
    task.updatedAt = now();
    await persistProductionTask(task);
    return task;
  });
}

function productionTaskRetryMayCharge(task: ProductionTask): boolean {
  if (task.kind === 'visual-candidates') return false;
  if (task.kind === 'draft-queue') return false;
  return true;
}

/** The browser only needs this compact, path-redacted record for polling. */
export function productionTaskResponse(
  task: ProductionTask,
): ProductionTask & { retryMayCharge: boolean } {
  const projected = {
    ...task,
    retryMayCharge: productionTaskRetryMayCharge(task),
    // Inputs can contain raw source text and internal paths. The browser only
    // needs the status and result needed to advance the visible workbench.
    request: {},
    operationJournal: undefined,
    error: projectedTaskFailure(
      task.error,
      '当前步骤处理失败。请从这里重试。',
      task.error?.stepId,
    ),
    steps: task.steps.map((step) => ({
      ...step,
      error: projectedTaskFailure(
        step.error,
        '当前步骤处理失败。请从这里重试。',
        step.id,
      ),
    })),
  };
  return redactLocalPaths(projected);
}
