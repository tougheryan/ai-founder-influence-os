import { chmod, readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import type { BrainContext, FileItem, PersistedConfig } from './types';
import {
  CONFIG_FILE,
  PROJECT_DIR,
  SKILLS_DIR,
  safeResolve,
  toProjectRelativePath,
} from './project-root';

export const BASE_DIR = PROJECT_DIR;
export { CONFIG_FILE, SKILLS_DIR, safeResolve };

export async function readBrainFile(file: string): Promise<string> {
  const path = safeResolve(BASE_DIR, join('brain', `${file}.md`));
  if (!path) throw new Error('Invalid brain file path');
  return readFile(path, 'utf-8');
}

export async function writeBrainFile(file: string, content: string): Promise<void> {
  const path = safeResolve(BASE_DIR, join('brain', `${file}.md`));
  if (!path) throw new Error('Invalid brain file path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

export async function loadBrainContext(): Promise<BrainContext> {
  const [you, user, commands] = await Promise.all([
    readBrainFile('you').catch(() => ''),
    readBrainFile('user').catch(() => ''),
    readBrainFile('commands').catch(() => ''),
  ]);
  return { you, user, commands };
}

export async function readSkillMd(skill: string): Promise<string> {
  const path = safeResolve(SKILLS_DIR, join(skill, 'SKILL.md'));
  if (!path) throw new Error('Invalid skill path');
  return readFile(path, 'utf-8');
}

export async function listSkills(): Promise<string[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function listMaterials(type?: string): Promise<FileItem[]> {
  const dir = type
    ? safeResolve(BASE_DIR, join('materials', type))
    : safeResolve(BASE_DIR, 'materials');
  if (!dir) throw new Error('Invalid materials path');

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(dir, entry.name);
        const stats = await stat(fullPath);
        return {
          name: entry.name,
          path: toProjectRelativePath(fullPath),
          isDirectory: entry.isDirectory(),
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      })
    );
  } catch {
    return [];
  }
}

export async function readOutputFile(relativePath: string): Promise<string> {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) throw new Error('Invalid output path');
  return readFile(safePath, 'utf-8');
}

export async function writeOutputFile(relativePath: string, content: string): Promise<void> {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) throw new Error('Invalid output path');
  await mkdir(dirname(safePath), { recursive: true });
  await writeFile(safePath, content, 'utf-8');
}

export async function writeOutputBuffer(relativePath: string, content: Buffer): Promise<void> {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) throw new Error('Invalid output path');
  await mkdir(dirname(safePath), { recursive: true });
  await writeFile(safePath, content);
}

export async function listDirectory(relativePath: string): Promise<FileItem[]> {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) throw new Error('Invalid directory path');

  try {
    const entries = await readdir(safePath, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(safePath, entry.name);
        const stats = await stat(fullPath);
        return {
          name: entry.name,
          path: toProjectRelativePath(fullPath),
          isDirectory: entry.isDirectory(),
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      })
    );
  } catch {
    return [];
  }
}

export async function readConfigFile(): Promise<Partial<PersistedConfig>> {
  try {
    const content = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as Partial<PersistedConfig>;
  } catch {
    return {};
  }
}

export async function writeConfigFile(config: Partial<PersistedConfig>): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}

export async function listPipelineFiles(stage?: string): Promise<FileItem[]> {
  const dir = stage
    ? safeResolve(BASE_DIR, join('pipeline', stage))
    : safeResolve(BASE_DIR, 'pipeline');
  if (!dir) throw new Error('Invalid pipeline path');

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: FileItem[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const stats = await stat(fullPath);

      if (entry.isDirectory()) {
        const subEntries = await readdir(fullPath, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isFile()) {
            const subPath = join(fullPath, sub.name);
            const subStats = await stat(subPath);
            files.push({
              name: `${entry.name}/${sub.name}`,
              path: toProjectRelativePath(subPath),
              isDirectory: false,
              size: subStats.size,
              modifiedAt: subStats.mtime.toISOString(),
            });
          }
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
