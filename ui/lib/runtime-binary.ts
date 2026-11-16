import { isAbsolute } from 'node:path';

export class RuntimeBinaryResolutionError extends Error {}

type RuntimeEnvironment = Record<string, string | undefined>;

function configuredPythonBinary(env: RuntimeEnvironment): string {
  return String(env.AIFIOS_DESKTOP_PYTHON_BINARY || env.AIFIOS_PYTHON || '').trim();
}

/**
 * Return the Python interpreter used by server-side content operations.
 *
 * The desktop shell injects an absolute path to its bundled interpreter. Do
 * not fall through to the recipient's PATH in desktop mode: doing so hides a
 * broken installer on the builder's machine and fails after the app is shared.
 */
export function runtimePythonBinary(env: RuntimeEnvironment = process.env): string {
  const configured = configuredPythonBinary(env);
  if (env.AIFIOS_DESKTOP === '1') {
    if (!configured) {
      throw new RuntimeBinaryResolutionError('Echo Founder 桌面运行时缺少内置 Python。请重新安装 Echo Founder。');
    }
    if (!isAbsolute(configured)) {
      throw new RuntimeBinaryResolutionError('Echo Founder 桌面运行时的 Python 路径无效。请重新安装 Echo Founder。');
    }
    return configured;
  }

  if (configured && isAbsolute(configured)) return configured;
  return 'python3';
}

export function runtimePythonDiagnosticBinary(env: RuntimeEnvironment = process.env): string {
  return runtimePythonBinary(env);
}
