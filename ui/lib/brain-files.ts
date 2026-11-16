import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { BrainContext } from './types';
import { projectPath, safeResolve } from './project-root';

const BRAIN_DIR = projectPath('brain');

function safeBrainFile(file: string): string {
  const resolved = safeResolve(BRAIN_DIR, `${file}.md`);
  if (!resolved) throw new Error('Invalid brain file path');
  return resolved;
}

export async function readBrainFile(file: string): Promise<string> {
  return readFile(safeBrainFile(file), 'utf-8');
}

export async function writeBrainFile(file: string, content: string): Promise<void> {
  const path = safeBrainFile(file);
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
