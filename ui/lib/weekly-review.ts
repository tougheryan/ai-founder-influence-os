import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { INSTALL_ROOT, PROJECT_DIR, contentRuntimeToolPath } from './project-root';
import { runtimePythonBinary } from './runtime-binary';

const execFileAsync = promisify(execFile);
const WEEKLY_LEARNING_SCRIPT = contentRuntimeToolPath('weekly_learning.py');
const WEEKLY_REVIEW_TEMP_PREFIX = 'aifios-weekly-review-';

export const WEEKLY_RECORD_PATH_RE = /^materials\/weekly-review\/\d{4}-W\d{2}\/learning-record\.json$/;

export type WeeklyReviewMetric = {
  value: number;
  source: 'manual_operator' | 'performance_evidence' | 'tikomni_live';
  recorded_at: string;
  evidence_path?: string;
};

export type WeeklyReviewItem = {
  source_record_id: string;
  /** Added in v2 run-bound collection; absent only on legacy weekly records. */
  run_id?: string;
  run_slug?: string;
  queue_id?: string;
  source_ledger_path?: string;
  platform: 'wechat' | 'xiaohongshu' | 'moments' | 'shipinhao' | 'douyin';
  item_id: string;
  published_url: string;
  published_at: string;
  final_content_hash: string;
  adopted_visual_assets: Array<{ path: string; sha256: string; role?: string }>;
  required_metrics: string[];
  metrics: Record<string, WeeklyReviewMetric>;
  comment_samples: string[];
  public_collection?: {
    status: 'available' | 'unavailable';
    captured_at: string;
    endpoint_id: string;
    raw_path: string;
    reason: string;
  };
};

export type WeeklyReviewRecord = {
  schema: 'aifios.weekly-learning-record.v1';
  record_id: string;
  week: string;
  status: 'waiting_metrics' | 'ready' | 'completed' | 'memory_applied' | 'no_publications';
  items: WeeklyReviewItem[];
  run_bindings?: Array<{
    run_id: string;
    run_slug: string;
    queue_id?: string;
    source_ledger_path?: string;
  }>;
  report_path?: string;
  quality_status?: 'pass' | 'review_required' | 'blocked';
  quality_issues?: { blocking?: string[]; review?: string[] };
  proposed_memory?: Record<string, string[]>;
  memory_paths?: string[];
};

export type WeeklyReviewSummary = {
  status: WeeklyReviewRecord['status'] | 'not_due';
  record_path?: string;
  record?: WeeklyReviewRecord;
  missing_metrics?: Array<{
    source_record_id: string;
    platform: string;
    metric: string;
    label: string;
  }>;
  report_path?: string;
  reminder?: {
    should_notify: boolean;
    week: string;
    record_path: string;
    message: string;
  };
  schedule?: {
    timezone?: string;
    weekday?: number;
    hour?: number;
    minute?: number;
    last_notified_week?: string;
  };
  next_scheduled_at?: string;
  [key: string]: unknown;
};

export type WeeklyMetricsUpdate = Record<string, {
  metrics?: Record<string, number>;
  comments?: string[];
}>;

function cliErrorStdout(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stdout' in error)) return '';
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === 'string' ? stdout : '';
}

function cliErrorStderr(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stderr' in error)) return '';
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr : '';
}

function parseResult(stdout: string): WeeklyReviewSummary {
  const parsed = JSON.parse(stdout) as WeeklyReviewSummary & { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

async function writeUpdatesFile(updates: WeeklyMetricsUpdate): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), WEEKLY_REVIEW_TEMP_PREFIX));
  const path = join(directory, 'updates.json');
  await writeFile(path, JSON.stringify(updates), { encoding: 'utf-8', mode: 0o600 });
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function invoke(args: string[]): Promise<WeeklyReviewSummary> {
  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), [
      WEEKLY_LEARNING_SCRIPT,
      '--project',
      PROJECT_DIR,
      ...args,
    ], {
      cwd: INSTALL_ROOT,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 30_000,
    });
    return parseResult(stdout);
  } catch (error) {
    const stdout = cliErrorStdout(error);
    if (stdout.trim()) {
      try {
        return parseResult(stdout);
      } catch (parsedError) {
        throw parsedError;
      }
    }
    const stderr = cliErrorStderr(error).trim();
    throw new Error(stderr || (error instanceof Error ? error.message : '每周复盘运行失败'));
  }
}

export function isWeeklyReviewRecordPath(value: string): boolean {
  return WEEKLY_RECORD_PATH_RE.test(value);
}

export function getWeeklyReviewStatus(ensure = true): Promise<WeeklyReviewSummary> {
  return invoke(['status', ...(ensure ? ['--ensure'] : [])]);
}

export function collectWeeklyReview(): Promise<WeeklyReviewSummary> {
  return invoke(['collect', '--force']);
}

export async function saveWeeklyReviewMetrics(
  recordPath: string,
  updates: WeeklyMetricsUpdate,
): Promise<WeeklyReviewSummary> {
  const payload = await writeUpdatesFile(updates);
  try {
    return await invoke(['record-metrics', '--record', recordPath, '--updates', `@${payload.path}`]);
  } finally {
    await payload.cleanup();
  }
}

export function completeWeeklyReview(recordPath: string): Promise<WeeklyReviewSummary> {
  return invoke(['complete', '--record', recordPath]);
}

export function acknowledgeWeeklyReminder(recordPath: string): Promise<WeeklyReviewSummary> {
  return invoke(['acknowledge-reminder', '--record', recordPath]);
}

export function applyWeeklyReviewMemory(recordPath: string, humanConfirmed: boolean): Promise<WeeklyReviewSummary> {
  if (!humanConfirmed) {
    return Promise.reject(new Error('写入长期学习前必须由操作者明确勾选确认。'));
  }
  return invoke(['apply-memory', '--record', recordPath, '--human-confirmed']);
}
