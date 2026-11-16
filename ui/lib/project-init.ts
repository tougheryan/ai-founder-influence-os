import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { INSTALL_ROOT, PROJECT_DIR, contentRuntimeToolPath, runtimeJoin } from './project-root';
import { runtimePythonBinary } from './runtime-binary';

const execFileAsync = promisify(execFile);
const RUNTIME_SCRIPT = contentRuntimeToolPath('content_runtime.py');

let initialized = false;
let initialization: Promise<void> | null = null;

export async function ensureProjectInitialized(): Promise<void> {
  const statePath = runtimeJoin(PROJECT_DIR, 'sessions', 'latest.json');
  // Existing projects do not need a child-process round trip on every fresh
  // route module. This is also important during a cold start, when several
  // route requests can arrive together before this module has set its flag.
  if (initialized || existsSync(statePath)) {
    initialized = true;
    return;
  }

  if (!initialization) {
    initialization = execFileAsync(runtimePythonBinary(), [
      RUNTIME_SCRIPT,
      '--project',
      PROJECT_DIR,
      'init',
    ], {
      cwd: INSTALL_ROOT,
      maxBuffer: 1024 * 1024 * 2,
      timeout: 15000,
    }).then(() => {
      initialized = true;
    }).finally(() => {
      initialization = null;
    });
  }

  await initialization;
}
