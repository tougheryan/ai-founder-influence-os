import { readdir, readFile } from 'fs/promises';
import { BASE_DIR, safeResolve } from './output-files';
import { runtimeJoin, toProjectRelativePath } from './project-root';

export type RuntimeRun = {
  research_mode?: 'platform' | 'author_material';
  author_evidence?: { id: string; path: string; sha256: string };
  material_correction?: import('./material-correction-record').MaterialCorrectionPointer;
  run_id?: string;
  slug?: string;
  topic?: string;
  project_id?: string;
  status?: string;
  visual_template?: string;
  updated_at?: string;
  current_step?: string | null;
  target_platforms?: string[];
  selected_platforms?: string[];
  visual_preferences?: {
    mode?: 'ai_enhanced' | 'stable';
    direction_count?: number;
    provider_policy?: 'auto';
  };
  steps?: Record<string, { latest?: string }>;
  phase_artifacts?: Record<string, { path?: string; sha256?: string; version?: number }>;
  history?: Array<{ step?: string; path?: string }>;
  topic_selection?: {
    topic?: string;
    market_snapshot_path?: string;
    market_snapshot_sha256?: string;
    selected_at?: string;
    suggestion_id?: string;
  };
};

type RuntimeState = {
  active_run_id?: string | null;
  current_slug?: string | null;
};

export type RuntimeSourcePath = {
  path: string;
  step?: string;
};

export type RuntimeWriteTarget = {
  slug: string;
  runId: string;
};

export function parseFrontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

async function readJsonFile<T>(relativePath: string): Promise<T | null> {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) return null;
  try {
    return JSON.parse(await readFile(safePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function runtimeRunById(runId: string): Promise<RuntimeRun | null> {
  const normalizedRunId = String(runId || '').trim();
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(normalizedRunId)) return null;
  return readJsonFile<RuntimeRun>(runtimeJoin('runs', `${normalizedRunId}.json`));
}

function normalizeRelativePath(path: string): string {
  return toProjectRelativePath(path).replace(/\\/g, '/').replace(/^\/+/, '');
}

function runPathMatches(run: RuntimeRun, relativePath: string, step?: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;

  if (step) {
    const latest = run.steps?.[step]?.latest;
    if (latest && normalizeRelativePath(latest) === normalized) return true;
    return Boolean(
      run.history?.some(
        (item) => item.step === step && item.path && normalizeRelativePath(item.path) === normalized
      )
    );
  }

  for (const meta of Object.values(run.steps || {})) {
    if (meta?.latest && normalizeRelativePath(meta.latest) === normalized) return true;
  }

  for (const artifact of Object.values(run.phase_artifacts || {})) {
    if (artifact?.path && normalizeRelativePath(artifact.path) === normalized) return true;
  }

  return Boolean(run.history?.some((item) => item.path && normalizeRelativePath(item.path) === normalized));
}

export async function listRuntimeRuns(): Promise<RuntimeRun[]> {
  const runsDir = safeResolve(BASE_DIR, 'runs');
  if (!runsDir) return [];
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const rows = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          try {
            return JSON.parse(await readFile(runtimeJoin(runsDir, entry.name), 'utf-8')) as RuntimeRun;
          } catch {
            return null;
          }
        })
    );
    return rows
      .filter((run): run is RuntimeRun => Boolean(run?.run_id || run?.slug))
      .sort((a, b) => new Date(b.updated_at || '').getTime() - new Date(a.updated_at || '').getTime());
  } catch {
    return [];
  }
}

export async function runsForPipelinePath(relativePath: string, step?: string): Promise<RuntimeRun[]> {
  const runs = await listRuntimeRuns();
  return runs.filter((run) => runPathMatches(run, relativePath, step));
}

export async function activeRuntimeRun(): Promise<RuntimeRun | null> {
  const state = await readJsonFile<RuntimeState>('sessions/latest.json');
  if (!state?.active_run_id) {
    return state?.current_slug ? { slug: state.current_slug } : null;
  }
  const run = await runtimeRunById(state.active_run_id);
  if (run) return run;
  return { run_id: state.active_run_id, slug: state.current_slug || undefined };
}

export async function resolveRuntimeWriteTarget(options: {
  fallbackSlug: string;
  sourcePaths?: RuntimeSourcePath[];
  preferredRunId?: string;
  useActiveFallback?: boolean;
}): Promise<RuntimeWriteTarget> {
  const sourcePaths = options.sourcePaths || [];
  for (const source of sourcePaths) {
    if (!source.path) continue;
    const matchedRun = (await runsForPipelinePath(source.path, source.step))[0];
    if (matchedRun?.slug || matchedRun?.run_id) {
      return {
        slug: matchedRun.slug || options.fallbackSlug,
        runId: matchedRun.run_id || '',
      };
    }
  }

  // An invocation may already have verified its target run before generation
  // starts (notably the temporary material entrance). Prefer that verified run
  // over a tab that became active while the model was streaming.
  if (options.preferredRunId) {
    const preferredRun = (await listRuntimeRuns()).find((run) => run.run_id === options.preferredRunId);
    if (preferredRun?.slug || preferredRun?.run_id) {
      return {
        slug: preferredRun.slug || options.fallbackSlug,
        runId: preferredRun.run_id || '',
      };
    }
  }

  if (options.useActiveFallback !== false) {
    const activeRun = await activeRuntimeRun();
    if (activeRun?.slug || activeRun?.run_id) {
      return {
        slug: activeRun.slug || options.fallbackSlug,
        runId: activeRun.run_id || '',
      };
    }
  }

  return {
    slug: options.fallbackSlug,
    runId: '',
  };
}
