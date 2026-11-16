import 'server-only';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECT_DIR, skillPath } from './project-root';
import { runtimePythonBinary } from './runtime-binary';

const execute = promisify(execFile);

/** Re-read source and output at adoption time; a cached pass is not evidence. */
export async function verifyWechatLayout(slug: string, revision: string): Promise<boolean> {
  try {
    const { stdout } = await execute(runtimePythonBinary(), [
      skillPath('content-runtime', 'scripts', 'visual_publish.py'),
      '--project', PROJECT_DIR, 'verify', '--slug', slug, '--revision', revision,
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    return result.status === 'pass' && Array.isArray(result.errors) && result.errors.length === 0;
  } catch {
    return false;
  }
}
