import { existsSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';

function expandHome(value: string): string {
  if (value === '~') return process.env.HOME || value;
  if (value.startsWith('~/')) return join(process.env.HOME || '', value.slice(2));
  return value;
}

function runtimeResolve(...parts: string[]): string {
  return resolve(/* turbopackIgnore: true */ ...parts.map(expandHome));
}

export function runtimeJoin(...parts: string[]): string {
  return join(/* turbopackIgnore: true */ ...parts);
}

function deriveInstallRoot(): string {
  const cwd = runtimeResolve(process.cwd());
  if (basename(cwd) === 'ui') return dirname(cwd);
  if (existsSync(runtimeJoin(cwd, 'skills'))) return cwd;

  const parent = dirname(cwd);
  if (existsSync(runtimeJoin(parent, 'skills'))) return parent;

  return cwd;
}

export const INSTALL_ROOT = runtimeResolve(process.env.AIFIOS_HOME || deriveInstallRoot());
export const PROJECT_DIR = runtimeResolve(process.env.AIFIOS_PROJECT?.trim() || '~/ai-content-system');
export const PROJECT_NAME = basename(PROJECT_DIR) || 'Echo Founder Project';
export const SKILLS_DIR = runtimeResolve(
  process.env.AIFIOS_SKILLS_DIR || runtimeJoin(INSTALL_ROOT, 'skills')
);
export const CONFIG_FILE = runtimeJoin(PROJECT_DIR, 'config', 'llm-config.json');

function canonicalAbsolutePath(value: string): string {
  const resolved = runtimeResolve(value);
  try {
    return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  } catch {
    return resolved;
  }
}

export function safeResolve(base: string, target: string): string | null {
  const normalizedBase = runtimeResolve(base);
  const resolved = runtimeResolve(normalizedBase, target);
  const relation = relative(normalizedBase, resolved);
  if (relation === '..' || relation.startsWith('../') || isAbsolute(relation)) {
    return null;
  }
  return resolved;
}

export function projectPath(...parts: string[]): string {
  return runtimeJoin(PROJECT_DIR, ...parts);
}

export function skillPath(...parts: string[]): string {
  return runtimeJoin(SKILLS_DIR, ...parts);
}

export function contentRuntimeToolPath(scriptName: string): string {
  return skillPath('content-runtime', 'scripts', scriptName);
}

export function toProjectRelativePath(path: string | undefined | null): string {
  if (!path) return '';
  const normalized = isAbsolute(path) ? canonicalAbsolutePath(path) : path;
  if (!isAbsolute(normalized)) return normalized;

  const relation = relative(canonicalAbsolutePath(PROJECT_DIR), normalized);
  if (relation && relation !== '..' && !relation.startsWith('../') && !isAbsolute(relation)) {
    return relation;
  }
  if (relation === '') return '';
  return path;
}

function redactLocalPathString(value: string): string {
  const normalized = value.startsWith('~') || isAbsolute(value) ? canonicalAbsolutePath(value) : value;
  const projectRoot = canonicalAbsolutePath(PROJECT_DIR);

  if (isAbsolute(normalized)) {
    const relation = relative(projectRoot, normalized);
    if (relation === '') return PROJECT_NAME;
    if (relation && relation !== '..' && !relation.startsWith('../') && !isAbsolute(relation)) {
      return relation;
    }
    return basename(normalized) || '[local path redacted]';
  }

  let redacted = value;
  for (const marker of [PROJECT_DIR, projectRoot, INSTALL_ROOT, canonicalAbsolutePath(INSTALL_ROOT)]) {
    if (marker) redacted = redacted.split(marker).join(PROJECT_NAME);
  }

  return redacted
    .replace(/\/Users\/[^\s"'<>，。；;,)）\]}]+/g, '[local path redacted]')
    .replace(/\/private\/[^\s"'<>，。；;,)）\]}]+/g, '[local path redacted]')
    .replace(/\/var\/folders\/[^\s"'<>，。；;,)）\]}]+/g, '[local path redacted]')
    .replace(/\/tmp\/[^\s"'<>，。；;,)）\]}]+/g, '[local path redacted]');
}

export function redactLocalPaths<T>(value: T): T {
  if (typeof value === 'string') return redactLocalPathString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactLocalPaths(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactLocalPaths(item)])
    ) as T;
  }
  return value;
}
