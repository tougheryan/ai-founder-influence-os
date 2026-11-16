import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { readdir, readFile, stat } from 'fs/promises';
import type { FileItem } from '@/lib/types';
import { ensureProjectInitialized } from '@/lib/project-init';
import { PROJECT_DIR, PROJECT_NAME, projectPath, redactLocalPaths, runtimeJoin, safeResolve, toProjectRelativePath } from '@/lib/project-root';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';

const PIPELINE_DIR = projectPath('pipeline');
const SESSIONS_DIR = projectPath('sessions');
const DESKTOP_CHALLENGE_HEADER = 'x-aifios-desktop-challenge';
const DESKTOP_PROOF_HEADER = 'x-aifios-desktop-proof';

function desktopServiceProof(request: Request): { proof?: string; error?: string } {
  const challenge = request.headers.get(DESKTOP_CHALLENGE_HEADER) || '';
  if (!challenge) return {};

  const secret = process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET || '';
  if (!secret || challenge.length > 512) {
    return { error: 'Desktop service authentication failed.' };
  }
  return { proof: createHmac('sha256', secret).update(challenge).digest('hex') };
}

export async function GET(request: Request) {
  try {
    const authentication = desktopServiceProof(request);
    if (authentication.error) {
      return expectedUserFacingErrorResponse({
        error: '无法验证桌面应用请求，请重新启动应用。',
        code: 'desktop_service_authentication_failed',
        status: 403,
      });
    }
    await ensureProjectInitialized();
    const latestPath = runtimeJoin(SESSIONS_DIR, 'latest.json');
    let latest: Record<string, unknown> = {};
    try {
      latest = JSON.parse(await readFile(latestPath, 'utf-8'));
    } catch {
      // latest.json 可能不存在
    }
    const search = new URL(request.url).searchParams;
    const view = search.get('view');
    const requestedRunId = search.get('runId');
    if (requestedRunId && (view === 'production' || view === 'active-run')) {
      if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(requestedRunId)) {
        return NextResponse.json({ error: '内容编号不正确。' }, { status: 400 });
      }
      const requestedRun = await loadActiveRun({ active_run_id: requestedRunId });
      if (!requestedRun) return NextResponse.json({ error: '找不到这期内容。' }, { status: 404 });
      latest = { active_run_id: requestedRunId, current_slug: requestedRun.slug, phase_artifacts: requestedRun.phase_artifacts };
    }
    if (view === 'active-run') {
      const activeRun = await loadActiveRun(latest);
      const response = NextResponse.json({
        latest: typeof latest.active_run_id === 'string' ? { active_run_id: latest.active_run_id } : {},
        activeRun: redactLocalPaths(compactActiveRun(activeRun)),
      });
      if (authentication.proof) response.headers.set(DESKTOP_PROOF_HEADER, authentication.proof);
      return response;
    }
    if (view === 'production') {
      const activeRun = await loadActiveRun(latest);
      const statePath = runtimeJoin(SESSIONS_DIR, 'session-state.json');
      let sessionState: Record<string, unknown> = {};
      try {
        sessionState = JSON.parse(await readFile(statePath, 'utf-8'));
      } catch {
        // session-state.json 可能不存在
      }
      const response = NextResponse.json({
        latest: compactProductionLatest(latest, Boolean(activeRun)),
        sessionState: compactProductionSession(sessionState),
        activeRun: redactLocalPaths(activeRun),
      });
      if (authentication.proof) response.headers.set(DESKTOP_PROOF_HEADER, authentication.proof);
      return response;
    }
    latest = await normalizeLatestForActiveRun(latest);

    const statePath = runtimeJoin(SESSIONS_DIR, 'session-state.json');
    let sessionState: Record<string, unknown> = {};
    try {
      sessionState = JSON.parse(await readFile(statePath, 'utf-8'));
    } catch {
      // session-state.json 可能不存在
    }

    const pipelineFiles = await listPipelineFiles();
    const activeRun = await loadActiveRun(latest);

    const response = NextResponse.json({
      project: PROJECT_NAME,
      latest: redactLocalPaths(latest),
      sessionState: redactLocalPaths(sessionState),
      activeRun: redactLocalPaths(activeRun),
      pipelineFiles,
    });
    if (authentication.proof) response.headers.set(DESKTOP_PROOF_HEADER, authentication.proof);
    return response;
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取项目状态，请重试。',
      code: 'project_status_read_failed',
      status: 500,
    });
  }
}

function compactActiveRun(activeRun: Record<string, unknown> | null): Record<string, string> | null {
  if (!activeRun) return null;
  const runId = typeof activeRun.run_id === 'string' ? activeRun.run_id : '';
  const projectId = typeof activeRun.project_id === 'string' ? activeRun.project_id : '';
  return {
    ...(runId ? { run_id: runId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  };
}

const PRODUCTION_LATEST_FILE_KEYS = new Set(['intake', 'blueprint', 'package', 'visual', 'publish', 'review']);

function compactProductionLatest(latest: Record<string, unknown>, hasActiveRun: boolean): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const key of ['active_run_id', 'current_slug', 'phase_artifacts']) {
    if (latest[key] !== undefined) compact[key] = latest[key];
  }
  // Legacy runs without a run record still need their small artifact map to
  // hydrate. Never send the full global file index to the production client.
  if (!hasActiveRun) {
    const files = objectRecord(latest.latest_files);
    compact.latest_files = Object.fromEntries(
      Object.entries(files).filter(([key]) => PRODUCTION_LATEST_FILE_KEYS.has(key)),
    );
  }
  return compact;
}

function compactProductionSession(session: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const key of ['active_run_id', 'current_slug', 'active_project_id', 'phase_artifacts']) {
    if (session[key] !== undefined) compact[key] = session[key];
  }
  const activeRun = objectRecord(session.active_run);
  if (Object.keys(activeRun).length) compact.active_run = activeRun;
  return compact;
}

async function loadActiveRun(latest: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const runId = typeof latest.active_run_id === 'string' ? latest.active_run_id.trim() : '';
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) return null;
  const path = safeResolve(PROJECT_DIR, runtimeJoin('runs', `${runId}.json`));
  if (!path) return null;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const value = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function normalizeLatestForActiveRun(latest: Record<string, unknown>): Promise<Record<string, unknown>> {
  const globalLatestFiles = objectRecord(latest.latest_files);
  const latestBySlug = objectRecord(latest.latest_by_slug);
  const currentSlug = typeof latest.current_slug === 'string' ? latest.current_slug : '';
  const scopedLatestFiles = currentSlug ? objectRecord(latestBySlug[currentSlug]) : {};

  const sanitizedGlobal = await existingFileMap(globalLatestFiles);
  const sanitizedScoped = await existingFileMap(scopedLatestFiles);
  return {
    ...latest,
    global_latest_files: sanitizedGlobal,
    scoped_latest_files: sanitizedScoped,
    latest_files: currentSlug && Object.keys(scopedLatestFiles).length ? sanitizedScoped : sanitizedGlobal,
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function existingFileMap(files: Record<string, unknown>): Promise<Record<string, string | null>> {
  const rows = await Promise.all(
    Object.entries(files).map(async ([key, value]) => {
      const path = typeof value === 'string' ? value : '';
      if (!path) return [key, null] as const;
      const safePath = safeResolve(PROJECT_DIR, path);
      if (!safePath) return [key, null] as const;
      try {
        const info = await stat(safePath);
        return [key, info.isFile() ? path : null] as const;
      } catch {
        return [key, null] as const;
      }
    })
  );
  return Object.fromEntries(rows);
}

async function listPipelineFiles(): Promise<FileItem[]> {
  try {
    const entries = await readdir(PIPELINE_DIR, { withFileTypes: true });
    const files: FileItem[] = [];

    for (const entry of entries) {
      const fullPath = runtimeJoin(PIPELINE_DIR, entry.name);
      const stats = await stat(fullPath);

      if (entry.isDirectory()) {
        const subEntries = await readdir(fullPath, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isFile()) continue;
          const subPath = runtimeJoin(fullPath, sub.name);
          const subStats = await stat(subPath);
          files.push({
            name: `${entry.name}/${sub.name}`,
            path: toProjectRelativePath(subPath),
            isDirectory: false,
            size: subStats.size,
            modifiedAt: subStats.mtime.toISOString(),
          });
        }
      } else {
        files.push({
          name: entry.name,
          path: toProjectRelativePath(fullPath),
          isDirectory: false,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        });
      }
    }

    return files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  } catch {
    return [];
  }
}
