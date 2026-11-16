import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { FileItem } from './types';
import { PROJECT_DIR, runtimeJoin, safeResolve, toProjectRelativePath } from './project-root';

export const BASE_DIR = PROJECT_DIR;
export { safeResolve };

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
        const fullPath = runtimeJoin(safePath, entry.name);
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

export async function listMaterials(type?: string): Promise<FileItem[]> {
  return listDirectory(type ? runtimeJoin('materials', type) : 'materials');
}

export async function listPipelineFiles(stage?: string): Promise<FileItem[]> {
  const dir = stage ? runtimeJoin('pipeline', stage) : 'pipeline';
  const safeDir = safeResolve(BASE_DIR, dir);
  if (!safeDir) throw new Error('Invalid pipeline path');

  try {
    const entries = await readdir(safeDir, { withFileTypes: true });
    const files: FileItem[] = [];

    for (const entry of entries) {
      const fullPath = runtimeJoin(safeDir, entry.name);
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
