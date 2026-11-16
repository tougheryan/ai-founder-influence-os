import type { ContentPlanStatus } from './content-plan';
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { INSTALL_ROOT, PROJECT_DIR, contentRuntimeToolPath, toProjectRelativePath } from './project-root';
import { runtimePythonBinary } from './runtime-binary';

const execFileAsync = promisify(execFile);
const RUNTIME_SCRIPT = contentRuntimeToolPath('content_runtime.py');
const TIKOMNI_SCHEDULER_SCRIPT = contentRuntimeToolPath('tikomni_scheduler.py');
const MARKET_SIGNAL_REPORT_SCRIPT = contentRuntimeToolPath('market_signal_report.py');
const RUNTIME_WRITE_TEMP_PREFIX = 'aifios-runtime-write-';

// These steps create or alter the operator-facing content and publication
// trail. They remain bound to the source approved with the topic/template:
// frozen market evidence, or an explicitly selected author-material record.
// Keep this legacy export name for existing callers; absence of market data
// never selects the author-material path automatically.
const FROZEN_TIKOMNI_REQUIRED_STEPS = new Set([
  'angle',
  'breakdown',
  'write',
  'package',
  'xhs',
  'douyin',
  'platform-adapt',
  'visual',
  'prelaunch',
  'compliance',
  'audit',
  'publish',
  'performance',
  'review',
  'archive',
  'twin',
]);

export type RuntimeValidationPayload = {
  path?: string;
  step?: string;
  valid?: boolean;
  [key: string]: unknown;
};

export type RuntimeValidationResult = {
  valid: boolean;
  result: RuntimeValidationPayload;
};

export class RuntimeOutputValidationError extends Error {
  constructor(readonly validation: RuntimeValidationPayload) {
    super('生成内容未通过检查，当前版本未更新');
  }
}

export type BlueprintApprovalStatus = {
  approved: boolean;
  run_id?: string;
  path?: string;
  sha256?: string;
  approved_at?: string;
  method?: string;
  reason?: string;
  research_mode?: 'platform' | 'author_material';
};

export type AuthorSourceBinding = {
  verified: true;
  research_mode: 'author_material';
  run_id: string;
  author_evidence_path: string;
  author_evidence_sha256: string;
  source_path: string;
  source_sha256: string;
  material_sha256: string;
  material_correction_id: string;
  topic: string;
  target_platforms: string[];
};

export type AuthorSourceRequest = {
  run_id: string; id: string; topic: string;
  intake_path: string; intake_sha256: string; material_sha256: string; source_revision: string;
};
export type AuthorSourceContext = Omit<AuthorSourceRequest, 'id' | 'topic'> & {
  material: { input_fingerprint: string; correction_id: string; analysis: unknown };
};

export async function getRuntimeAuthorSourceContext(runId: string): Promise<AuthorSourceContext> {
  const { stdout } = await execFileAsync(runtimePythonBinary(), [
    RUNTIME_SCRIPT, '--project', PROJECT_DIR, 'author-source-context', '--run-id', runId,
  ], { cwd: INSTALL_ROOT, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 });
  return JSON.parse(stdout) as AuthorSourceContext;
}

export async function selectRuntimeAuthorSource(request: AuthorSourceRequest): Promise<AuthorSourceBinding & { slug: string }> {
  const file = await writeRuntimeContentTempFile(JSON.stringify(request));
  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), [
      RUNTIME_SCRIPT, '--project', PROJECT_DIR, 'author-source-select', '--content', `@${file.path}`,
    ], { cwd: INSTALL_ROOT, maxBuffer: 1024 * 1024, timeout: 15_000 });
    return JSON.parse(stdout) as AuthorSourceBinding & { slug: string };
  } finally { await file.cleanup(); }
}

/** This verifies author material; it never returns TikOmni evidence fields. */
export async function verifyRuntimeAuthorSource(runId: string, blueprintPath?: string): Promise<AuthorSourceBinding> {
  const { stdout } = await execFileAsync(runtimePythonBinary(), [
    RUNTIME_SCRIPT, '--project', PROJECT_DIR, 'author-source-verify', '--run-id', runId,
    ...(blueprintPath ? ['--file', blueprintPath] : []),
  ], { cwd: INSTALL_ROOT, maxBuffer: 1024 * 1024, timeout: 15_000 });
  const result = JSON.parse(stdout) as AuthorSourceBinding;
  if (result.verified !== true || result.research_mode !== 'author_material' || result.run_id !== runId
      || !/^runs\/[^/]+\/author-evidence\/author_[a-f0-9]{32}\.json$/.test(result.author_evidence_path)
      || !result.author_evidence_path.startsWith(`runs/${runId}/`)
      || !/^[a-f0-9]{64}$/.test(result.author_evidence_sha256)) throw new Error('本期作者素材版本无法核对。');
  return result;
}

export type ProductionApprovalStatus = {
  approved?: boolean;
  registered?: boolean;
  scope?: string;
  run_id?: string;
  run_slug?: string;
  path?: string;
  sha256?: string;
  version?: number;
  approved_at?: string;
  method?: string;
  invalidated_at?: string;
  invalidation_reason?: string;
  reason?: string;
};

export type TikomniSnapshotVerification = {
  verified: boolean;
  reason?: string;
  detail?: string;
  run_id?: string;
  snapshot_id?: string;
  manifest_path?: string;
  snapshot_sha256?: string;
  source_path?: string;
  source_sha256?: string;
  frozen_at?: string;
  [key: string]: unknown;
};

export type RecoveredTikomniMarketReport = {
  markdown: string;
  status: string;
  sample_count: number;
  snapshot_path: string;
  snapshot_sha256: string;
  [key: string]: unknown;
};

export type RuntimeTopicSelection = {
  status?: string;
  run_id?: string;
  slug?: string;
  topic?: string;
  changed?: boolean;
  market_snapshot_path?: string;
  market_snapshot_sha256?: string;
  suggestion_id?: string;
};

type RuntimeRunSnapshot = {
  run_id?: string;
  steps?: Record<string, { latest?: string }>;
};

function cliErrorStdout(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stdout' in error)) return '';
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === 'string' ? stdout : '';
}

async function invokeTikomniVerification(args: string[]): Promise<TikomniSnapshotVerification> {
  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), [
      TIKOMNI_SCHEDULER_SCRIPT,
      '--project',
      PROJECT_DIR,
      ...args,
    ], {
      cwd: INSTALL_ROOT,
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });
    return JSON.parse(stdout) as TikomniSnapshotVerification;
  } catch (error) {
    // The verification CLI deliberately exits non-zero for a failed check,
    // but still emits its structured reason on stdout.
    const stdout = cliErrorStdout(error);
    if (stdout.trim()) {
      try {
        return JSON.parse(stdout) as TikomniSnapshotVerification;
      } catch {
        // Preserve the original process error below when stdout was not JSON.
      }
    }
    throw error;
  }
}

export async function recoverRuntimeTikomniMarketReport(
  runId: string,
  sourcePath: string,
  snapshotPath: string,
): Promise<RecoveredTikomniMarketReport> {
  const { stdout } = await execFileAsync(runtimePythonBinary(), [
    MARKET_SIGNAL_REPORT_SCRIPT,
    '--project',
    PROJECT_DIR,
    '--source',
    sourcePath,
    '--run-id',
    runId,
    '--recover-snapshot',
    snapshotPath,
  ], {
    cwd: INSTALL_ROOT,
    maxBuffer: 1024 * 1024 * 12,
    timeout: 30_000,
  });
  const result = JSON.parse(stdout) as Partial<RecoveredTikomniMarketReport>;
  if (result.status !== 'ready'
    || typeof result.markdown !== 'string'
    || !result.markdown.trim()
    || typeof result.snapshot_path !== 'string'
    || typeof result.snapshot_sha256 !== 'string') {
    throw new Error('已有 TikOmni 快照未能重建出完整研究报告。');
  }
  return result as RecoveredTikomniMarketReport;
}

export async function verifyRuntimeTikomniMarketSnapshot(
  runId: string,
  snapshotPath: string,
): Promise<TikomniSnapshotVerification> {
  if (!runId) return { verified: false, reason: 'run_required' };
  if (!snapshotPath) return { verified: false, reason: 'snapshot_required' };
  return invokeTikomniVerification([
    'topic-snapshot-verify',
    '--run-id',
    runId,
    '--snapshot',
    snapshotPath,
  ]);
}

export async function verifyFrozenRuntimeTikomniMarketSnapshot(
  runId: string,
): Promise<TikomniSnapshotVerification> {
  if (!runId) return { verified: false, reason: 'run_required' };
  return invokeTikomniVerification([
    'topic-verify',
    '--run-id',
    runId,
  ]);
}

/**
 * Saves a human-selected topic on an existing run. The runtime command keeps
 * the run ID and slug intact and re-verifies the candidate market snapshot.
 */
export async function setRuntimeRunTopic(input: {
  runId: string;
  topic: string;
  snapshotPath: string;
  snapshotSha256: string;
  suggestionId?: string;
}): Promise<RuntimeTopicSelection> {
  const { stdout } = await execFileAsync(runtimePythonBinary(), [
    RUNTIME_SCRIPT,
    '--project',
    PROJECT_DIR,
    'run-topic-set',
    '--run-id',
    input.runId,
    '--topic',
    input.topic,
    '--snapshot',
    input.snapshotPath,
    '--snapshot-sha256',
    input.snapshotSha256,
    ...(input.suggestionId ? ['--suggestion-id', input.suggestionId] : []),
  ], {
    cwd: INSTALL_ROOT,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  return JSON.parse(stdout) as RuntimeTopicSelection;
}

async function assertCurrentTopicTemplateApproval(runId: string): Promise<BlueprintApprovalStatus> {
  const { stdout } = await execFileAsync(runtimePythonBinary(), [
    RUNTIME_SCRIPT,
    '--project',
    PROJECT_DIR,
    'run',
    '--run-id',
    runId,
  ], {
    cwd: INSTALL_ROOT,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  const run = JSON.parse(stdout) as RuntimeRunSnapshot;
  const blueprintPath = run.steps?.blueprint?.latest || '';
  if (!blueprintPath) {
    throw new Error('当前 runtime run 缺少思想母版蓝图，不能继续下游内容生产');
  }
  const approval = await getRuntimeBlueprintApproval(blueprintPath, runId);
  if (!approval.approved) {
    throw new Error(`选题与模板确认已失效，不能继续下游内容生产：${approval.reason || '请重新确认蓝图'}`);
  }
  return approval;
}

export async function assertFrozenRuntimeTikomniMarketSnapshot(
  step: string,
  runId?: string,
): Promise<void> {
  if (!FROZEN_TIKOMNI_REQUIRED_STEPS.has(step)) return;
  if (!runId) {
    throw new Error(`步骤 ${step} 必须绑定 runtime run，才能验证已冻结的 TikOmni 研究快照`);
  }
  const approval = await assertCurrentTopicTemplateApproval(runId);
  if (approval.research_mode === 'author_material') {
    // Use the runtime authority again: a source change between the read above
    // and the write must not fall back to an old market snapshot.
    const { stdout } = await execFileAsync(runtimePythonBinary(), [
      RUNTIME_SCRIPT, '--project', PROJECT_DIR, 'writing-source-verify', '--run-id', runId, '--step', step,
    ], { cwd: INSTALL_ROOT, maxBuffer: 1024 * 1024, timeout: 15_000 });
    const result = JSON.parse(stdout) as Record<string, unknown>;
    if (result.verified !== true || result.research_mode !== 'author_material' || result.run_id !== runId) {
      throw new Error('本期作者素材或确认已变化，请重新核对。');
    }
    return;
  }
  const verification = await verifyFrozenRuntimeTikomniMarketSnapshot(runId);
  if (!verification.verified) {
    throw new Error(
      `TikOmni 冻结研究快照未通过校验，不能继续 ${step}：${verification.reason || '未知错误'}`,
    );
  }
}

async function writeRuntimeContentTempFile(content: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), RUNTIME_WRITE_TEMP_PREFIX));
  const path = join(directory, 'content.md');
  await writeFile(path, content, 'utf-8');
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export type RuntimeOutputExpectation = {
  path: string;
  sha256: string;
  blueprint?: { path: string; sha256: string };
};

async function writeRuntimeOutputPayload(
  step: string,
  slug: string,
  content: string,
  source: string,
  runId?: string,
  expected?: RuntimeOutputExpectation,
  requireValid = false,
): Promise<{ path: string; validation?: RuntimeValidationPayload }> {
  await assertFrozenRuntimeTikomniMarketSnapshot(step, runId);

  let stdout = '';
  const contentFile = await writeRuntimeContentTempFile(content);
  try {
    const result = await execFileAsync(runtimePythonBinary(), [
      RUNTIME_SCRIPT,
      '--project',
      PROJECT_DIR,
      'write',
      '--step',
      step,
      '--slug',
      slug,
      '--content',
      `@${contentFile.path}`,
      '--source',
      source,
      ...(runId ? ['--run-id', runId] : []),
      ...(expected ? ['--expected-path', expected.path, '--expected-sha256', expected.sha256] : []),
      ...(expected?.blueprint ? ['--expected-blueprint-path', expected.blueprint.path, '--expected-blueprint-sha256', expected.blueprint.sha256] : []),
      ...(requireValid ? ['--require-valid'] : []),
    ], {
      cwd: INSTALL_ROOT,
      maxBuffer: 1024 * 1024 * 12,
      timeout: 30000,
    });
    stdout = result.stdout;
  } catch (error) {
    const stderr = (error as { stderr?: unknown })?.stderr;
    if (requireValid && typeof stderr === 'string') {
      let detail: { code?: string; validation?: RuntimeValidationPayload } = {};
      try { detail = JSON.parse(stderr); } catch { /* Unknown process failures retain their original diagnostic. */ }
      if (detail.code === 'runtime_output_invalid' && detail.validation?.valid === false) {
        throw new RuntimeOutputValidationError(detail.validation);
      }
    }
    throw error;
  } finally {
    await contentFile.cleanup();
  }

  const payload = JSON.parse(stdout) as { path?: string; validation?: RuntimeValidationPayload };
  if (!payload.path) throw new Error('runtime 未返回保存路径');
  return { path: toProjectRelativePath(payload.path), validation: payload.validation };
}

export async function writeRuntimeOutput(
  step: string, slug: string, content: string, source: string,
  runId?: string, expected?: RuntimeOutputExpectation,
): Promise<string> {
  return (await writeRuntimeOutputPayload(step, slug, content, source, runId, expected)).path;
}

export async function writeValidatedRuntimeOutput(
  step: string, slug: string, content: string, source: string, runId: string,
): Promise<{ path: string; validation: RuntimeValidationResult }> {
  const result = await writeRuntimeOutputPayload(step, slug, content, source, runId, undefined, true);
  if (result.validation?.valid !== true) throw new Error('runtime 未返回有效的保存前检查结果');
  return { path: result.path, validation: { valid: true, result: result.validation } };
}

export async function validateRuntimeOutput(
  step: string,
  relativePath: string,
  runId?: string,
): Promise<RuntimeValidationResult> {
  const { stdout } = await execFileAsync(runtimePythonBinary(), [
    RUNTIME_SCRIPT,
    '--project',
    PROJECT_DIR,
    'validate',
    '--step',
    step,
    '--file',
    relativePath,
    ...(runId ? ['--run-id', runId] : []),
  ], {
    cwd: INSTALL_ROOT,
    maxBuffer: 1024 * 1024 * 12,
    timeout: 30000,
  });

  const result = JSON.parse(stdout) as RuntimeValidationPayload;
  return {
    valid: result.valid === true,
    result,
  };
}

async function readRuntimeBlueprintApproval(
  command: 'blueprint-approve' | 'blueprint-approval',
  path: string,
  runId?: string,
): Promise<BlueprintApprovalStatus> {
  const args = [
    RUNTIME_SCRIPT,
    '--project',
    PROJECT_DIR,
    command,
    '--file',
    path,
  ];
  if (runId) args.push('--run-id', runId);

  const { stdout } = await execFileAsync(runtimePythonBinary(), args, {
    cwd: INSTALL_ROOT,
    maxBuffer: 1024 * 1024,
    timeout: 15000,
  });
  return JSON.parse(stdout) as BlueprintApprovalStatus;
}

export function approveRuntimeBlueprint(path: string, runId?: string): Promise<BlueprintApprovalStatus> {
  return readRuntimeBlueprintApproval('blueprint-approve', path, runId);
}

export function getRuntimeBlueprintApproval(path: string, runId?: string): Promise<BlueprintApprovalStatus> {
  return readRuntimeBlueprintApproval('blueprint-approval', path, runId);
}

async function readRuntimeProductionApproval(
  command: 'approval-approve' | 'approval-status' | 'phase-artifact-register',
  scope: string,
  path: string,
  runId?: string,
  reviewedPlanSha256?: string,
  reviewedMaterialCorrectionId?: string,
): Promise<ProductionApprovalStatus> {
  const args = [
    RUNTIME_SCRIPT,
    '--project',
    PROJECT_DIR,
    command,
    '--scope',
    scope,
    '--file',
    path,
  ];
  if (runId) args.push('--run-id', runId);
  if (reviewedPlanSha256) args.push('--reviewed-plan-sha256', reviewedPlanSha256);
  if (reviewedMaterialCorrectionId) args.push('--reviewed-material-correction-id', reviewedMaterialCorrectionId);

  const { stdout } = await execFileAsync(runtimePythonBinary(), args, {
    cwd: INSTALL_ROOT,
    maxBuffer: 1024 * 1024,
    timeout: 15000,
  });
  return JSON.parse(stdout) as ProductionApprovalStatus;
}

export function registerRuntimePhaseArtifact(
  scope: string,
  path: string,
  runId?: string,
): Promise<ProductionApprovalStatus> {
  return readRuntimeProductionApproval('phase-artifact-register', scope, path, runId);
}

export function approveRuntimeProductionArtifact(
  scope: string,
  path: string,
  runId?: string,
  reviewedPlanSha256?: string,
  reviewedMaterialCorrectionId?: string,
): Promise<ProductionApprovalStatus> {
  return readRuntimeProductionApproval('approval-approve', scope, path, runId, reviewedPlanSha256, reviewedMaterialCorrectionId);
}

export async function applyRuntimeMaterialCorrection(record: import('./material-correction-record').MaterialCorrectionRecord) {
  const temporary = await writeRuntimeContentTempFile(JSON.stringify(record));
  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), [RUNTIME_SCRIPT, '--project', PROJECT_DIR, 'material-correction-apply', '--content', `@${temporary.path}`], { cwd: INSTALL_ROOT, maxBuffer: 1024 * 1024, timeout: 15000 });
    return JSON.parse(stdout) as { saved: boolean; id: string; replayed: boolean };
  } finally { await temporary.cleanup(); }
}

export async function getRuntimeContentPlanStatus(runId: string): Promise<ContentPlanStatus> {
  const { stdout } = await execFileAsync(runtimePythonBinary(), [RUNTIME_SCRIPT, '--project', PROJECT_DIR, 'content-plan-status', '--run-id', runId], { cwd: INSTALL_ROOT, maxBuffer: 1024 * 1024, timeout: 15000 });
  return JSON.parse(stdout) as ContentPlanStatus;
}

export function getRuntimeProductionApproval(
  scope: string,
  path: string,
  runId?: string,
): Promise<ProductionApprovalStatus> {
  return readRuntimeProductionApproval('approval-status', scope, path, runId);
}
