import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { contentRuntimeToolPath, INSTALL_ROOT } from './project-root';
import { runtimePythonBinary } from './runtime-binary';

const execFileAsync = promisify(execFile);
const RELEASE_GATE_SCRIPT = contentRuntimeToolPath('release_gate.py');

export type ContentReleaseGateResult = {
  schema?: string;
  status: 'pass' | 'review_required' | 'blocked';
  repaired: boolean;
  blocking_issues: string[];
  review_issues: string[];
  units: Array<{
    id: string;
    status: 'passed' | 'repaired' | 'review_required' | 'blocked';
    blocking_issues?: string[];
    review_issues?: string[];
  }>;
  package_manifest?: Record<string, unknown>;
  repairedBody: string;
};

function parseGateOutput(value: string): Omit<ContentReleaseGateResult, 'repairedBody'> {
  try {
    return JSON.parse(value) as Omit<ContentReleaseGateResult, 'repairedBody'>;
  } catch {
    throw new Error('发布质量门未返回可读取的检查结果。');
  }
}

export async function runContentReleaseGate(content: string): Promise<ContentReleaseGateResult> {
  const directory = await mkdtemp(join(tmpdir(), 'aifios-release-gate-'));
  const packagePath = join(directory, 'package.md');
  await writeFile(packagePath, content, 'utf-8');

  try {
    let parsed: Omit<ContentReleaseGateResult, 'repairedBody'>;
    try {
      const { stdout } = await execFileAsync(runtimePythonBinary(), [
        RELEASE_GATE_SCRIPT,
        '--file',
        packagePath,
        '--write-repaired',
      ], {
        cwd: INSTALL_ROOT,
        maxBuffer: 12 * 1024 * 1024,
        timeout: 30_000,
      });
      parsed = parseGateOutput(stdout);
    } catch (error) {
      const stdout = typeof error === 'object' && error && 'stdout' in error
        ? String((error as { stdout?: unknown }).stdout || '')
        : '';
      parsed = parseGateOutput(stdout);
    }

    return {
      ...parsed,
      repairedBody: await readFile(packagePath, 'utf-8'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
