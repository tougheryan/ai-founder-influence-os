import { lstat, rm } from 'node:fs/promises';
import { PROJECT_DIR, safeResolve } from './project-root';
import { tikomniContentLinkRunScope } from './tikomni-content-link';

const SESSION_ROOT = 'sessions/content-link-reads';
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class TikOmniContentLinkEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TikOmniContentLinkEvidenceError';
  }
}

export type TikOmniContentLinkEvidenceScope = {
  projectId: string;
  runId: string;
};

export type TikOmniContentLinkEvidenceClearResult = TikOmniContentLinkEvidenceScope & {
  relativePath: string;
  removed: boolean;
};

function cleanProjectId(value: string): string {
  const projectId = value.trim().toLowerCase();
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new TikOmniContentLinkEvidenceError('项目 ID 格式不正确。');
  }
  return projectId;
}

function cleanRunId(value: string): { runId: string; collectorRunScope: string } {
  const runId = value.trim();
  try {
    return { runId, collectorRunScope: tikomniContentLinkRunScope(runId) };
  } catch {
    throw new TikOmniContentLinkEvidenceError('run ID 格式不正确。');
  }
}

function evidencePath(scope: TikOmniContentLinkEvidenceScope): {
  scope: TikOmniContentLinkEvidenceScope;
  sessionPath: string;
  rootPath: string;
  projectPath: string;
  runPath: string;
  relativePath: string;
} {
  const projectId = cleanProjectId(scope.projectId);
  const { runId, collectorRunScope } = cleanRunId(scope.runId);
  const normalizedScope = { projectId, runId };
  const relativePath = `${SESSION_ROOT}/${projectId}/${collectorRunScope}`;
  const sessionPath = safeResolve(PROJECT_DIR, 'sessions');
  const rootPath = safeResolve(PROJECT_DIR, SESSION_ROOT);
  const projectPath = safeResolve(PROJECT_DIR, `${SESSION_ROOT}/${normalizedScope.projectId}`);
  const runPath = safeResolve(PROJECT_DIR, relativePath);
  if (!sessionPath || !rootPath || !projectPath || !runPath) {
    throw new TikOmniContentLinkEvidenceError('TikOmni 临时读取目录不合法。');
  }
  return { scope: normalizedScope, sessionPath, rootPath, projectPath, runPath, relativePath };
}

async function directoryState(path: string, label: string): Promise<'missing' | 'directory'> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TikOmniContentLinkEvidenceError(`${label}不能使用符号链接或普通文件。`);
    }
    return 'directory';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/**
 * Removes only the raw and normalized third-party capture for one explicit
 * project/run reset. It intentionally leaves parent directories, material
 * input, pipeline artifacts, and every other project's evidence untouched.
 */
export async function clearTikOmniContentLinkEvidence(
  scope: TikOmniContentLinkEvidenceScope,
): Promise<TikOmniContentLinkEvidenceClearResult> {
  const paths = evidencePath(scope);
  const result = {
    ...paths.scope,
    relativePath: paths.relativePath,
    removed: false,
  };

  if (await directoryState(paths.sessionPath, '会话目录') === 'missing') return result;
  if (await directoryState(paths.rootPath, 'TikOmni 临时读取目录') === 'missing') return result;
  if (await directoryState(paths.projectPath, '项目 TikOmni 临时读取目录') === 'missing') return result;
  if (await directoryState(paths.runPath, '本期 TikOmni 临时读取目录') === 'missing') return result;

  await rm(paths.runPath, { recursive: true, force: true });
  return { ...result, removed: true };
}
