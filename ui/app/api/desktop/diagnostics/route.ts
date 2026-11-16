import { execFile } from 'child_process';
import { constants } from 'fs';
import { access, stat } from 'fs/promises';
import { promisify } from 'util';
import { NextResponse } from 'next/server';
import { readLiteConfig } from '@/lib/config-lite';
import { runtimePythonDiagnosticBinary } from '@/lib/runtime-binary';
import {
  CONFIG_FILE,
  INSTALL_ROOT,
  PROJECT_DIR,
  PROJECT_NAME,
  SKILLS_DIR,
  contentRuntimeToolPath,
  redactLocalPaths,
  runtimeJoin,
} from '@/lib/project-root';
import { userFacingErrorPayload, userFacingErrorResponse } from '@/lib/user-facing-error';

export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5000;

const ENV_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  siliconflow: 'SILICONFLOW_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
};

type DiagnosticStatus = 'pass' | 'warn' | 'fail';

type DiagnosticItem = {
  id: string;
  label: string;
  status: DiagnosticStatus;
  version?: string;
  detail?: string;
  code?: string;
  debugId?: string;
};

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function extractVersion(value: string): string {
  const line = firstLine(value);
  const version = line.match(/\d+(?:\.\d+){1,3}(?:[-+._a-zA-Z0-9]*)?/);
  return version?.[0] || line || 'unknown';
}

async function commandDiagnostic(
  id: string,
  label: string,
  command: string,
  args: string[],
  required = true,
  extraEnv: Record<string, string> = {}
): Promise<DiagnosticItem> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    const output = `${stdout}\n${stderr}`.trim();
    return {
      id,
      label,
      status: 'pass',
      version: extractVersion(output),
      detail: firstLine(output),
    };
  } catch (error) {
    const missing = error instanceof Error && error.message.includes('ENOENT');
    const failure = userFacingErrorPayload(error, {
      error: missing ? `${label}未安装或不可用。` : `${label}检查失败，请重试。`,
      code: `desktop_diagnostic_${id}_failed`,
      context: `desktop diagnostic ${id}`,
    });
    return {
      id,
      label,
      status: required ? 'fail' : 'warn',
      detail: failure.error,
      code: failure.code,
      debugId: failure.debugId,
    };
  }
}

function nodeRuntimeDiagnostic(): Promise<DiagnosticItem> {
  const nodeBinary = process.env.AIFIOS_NODE_BINARY || 'node';
  const extraEnv: Record<string, string> = process.env.AIFIOS_NODE_RUN_AS_NODE === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  return commandDiagnostic('node', 'Node.js', nodeBinary, ['--version'], true, extraEnv);
}

function pythonRuntimeDiagnostic(): Promise<DiagnosticItem> {
  try {
    return commandDiagnostic('python', 'Python', runtimePythonDiagnosticBinary(), ['--version']);
  } catch (error) {
    const failure = userFacingErrorPayload(error, {
      error: 'Python 运行环境检查失败，请重试。',
      code: 'desktop_diagnostic_python_failed',
      context: 'desktop diagnostic python',
    });
    return Promise.resolve({
      id: 'python',
      label: 'Python',
      status: 'fail',
      detail: failure.error,
      code: failure.code,
      debugId: failure.debugId,
    });
  }
}

async function pathDiagnostic(id: string, label: string, path: string, writable = false, required = true): Promise<DiagnosticItem> {
  try {
    await access(path, writable ? constants.R_OK | constants.W_OK : constants.R_OK);
    const stats = await stat(path);
    return {
      id,
      label,
      status: 'pass',
      detail: `${stats.isDirectory() ? '目录' : '文件'}可访问：${redactLocalPaths(path)}`,
    };
  } catch (error) {
    const failure = userFacingErrorPayload(error, {
      error: `${label}无法访问。`,
      code: `desktop_diagnostic_${id}_failed`,
      context: `desktop path diagnostic ${id}`,
    });
    return {
      id,
      label,
      status: required ? 'fail' : 'warn',
      detail: failure.error,
      code: failure.code,
      debugId: failure.debugId,
    };
  }
}

function envKeyName(provider: string): string {
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_AUTH_TOKEN) {
    return 'ANTHROPIC_AUTH_TOKEN';
  }
  return ENV_KEY_MAP[provider] || '';
}

function hasEnvKey(provider: string): boolean {
  const name = envKeyName(provider);
  return Boolean(name && process.env[name]);
}

function desktopParentAlive(): boolean | null {
  const pid = Number(process.env.AIFIOS_DESKTOP_PARENT_PID || 0);
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPackagedDesktopRuntime(): boolean {
  return process.env.AIFIOS_DESKTOP === '1' && process.env.AIFIOS_NEXT_STANDALONE === '1';
}

function worstStatus(items: DiagnosticItem[], llmStatus: DiagnosticStatus): DiagnosticStatus {
  if (items.some((item) => item.status === 'fail')) return 'fail';
  if (llmStatus === 'fail') return 'fail';
  if (items.some((item) => item.status === 'warn') || llmStatus === 'warn') return 'warn';
  return 'pass';
}

function recommendedActions(
  tools: DiagnosticItem[],
  paths: DiagnosticItem[],
  llmStatus: DiagnosticStatus,
  packagedDesktop: boolean,
): string[] {
  const actions: string[] = [];
  const requiredToolIds = packagedDesktop ? ['python', 'node'] : ['python', 'node', 'npm'];
  if (tools.some((item) => requiredToolIds.includes(item.id) && item.status === 'fail')) {
    actions.push(packagedDesktop
      ? '桌面安装包的内置运行时不完整，请重新安装 Echo Founder。'
      : '安装 Python 3、Node.js 和 npm 后重新启动桌面版。');
  }
  if (paths.some((item) => item.status === 'fail')) {
    actions.push('检查项目目录、skills 目录和 content-runtime 是否存在且可读写。');
  }
  if (llmStatus !== 'pass') {
    actions.push('在设置页保存 API Key，或配置当前 Provider 对应的环境变量。');
  }
  if (!actions.length) actions.push(packagedDesktop ? '当前桌面环境满足独立安装版运行要求。' : '当前桌面环境满足源码内测桌面版运行要求。');
  return actions;
}

export async function GET() {
  try {
    const savedConfig = await readLiteConfig();
    const provider = savedConfig.provider || process.env.DEFAULT_PROVIDER || 'deepseek';
    const model = savedConfig.model || process.env.DEFAULT_MODEL || '';
    const savedKey = Boolean(savedConfig.apiKey);
    const envKey = hasEnvKey(provider);
    const llmStatus: DiagnosticStatus = savedKey || envKey ? 'pass' : 'warn';

    const packagedDesktop = isPackagedDesktopRuntime();
    const nextDistPath = runtimeJoin(INSTALL_ROOT, 'ui', process.env.AIFIOS_NEXT_DIST_DIR || '.next-desktop');
    const uiRuntimePath = packagedDesktop
      ? runtimeJoin(nextDistPath, 'standalone', 'node_modules', 'next', 'package.json')
      : runtimeJoin(INSTALL_ROOT, 'ui', 'node_modules');
    const [python, node, npm, projectPath, installRoot, skillsDir, runtimeScript, uiRuntime, nextDesktopDist] = await Promise.all([
      pythonRuntimeDiagnostic(),
      nodeRuntimeDiagnostic(),
      packagedDesktop
        ? Promise.resolve<DiagnosticItem>({ id: 'npm', label: 'npm', status: 'pass', detail: '独立安装版不需要 npm' })
        : commandDiagnostic('npm', 'npm', 'npm', ['--version']),
      pathDiagnostic('project', '项目目录', PROJECT_DIR, true),
      pathDiagnostic('install-root', '安装目录', INSTALL_ROOT),
      pathDiagnostic('skills', 'Skills 目录', SKILLS_DIR),
      pathDiagnostic('content-runtime', 'content-runtime', contentRuntimeToolPath('content_runtime.py')),
      pathDiagnostic('ui-runtime', packagedDesktop ? 'UI 独立运行时' : 'UI 依赖', uiRuntimePath),
      pathDiagnostic('next-desktop-dist', 'Next 桌面构建缓存', nextDistPath, false, packagedDesktop),
    ]);

    const tools = [python, node, npm];
    const paths = [projectPath, installRoot, skillsDir, runtimeScript, uiRuntime, nextDesktopDist];
    const status = worstStatus([...tools, ...paths], llmStatus);
    const desktopParentStatus = desktopParentAlive();

    return NextResponse.json(redactLocalPaths({
      status,
      summary:
        status === 'pass'
          ? (packagedDesktop ? '桌面环境满足独立安装版运行要求。' : '桌面环境满足当前源码内测版运行要求。')
          : status === 'warn'
            ? '桌面环境可启动，但仍有需要处理的运行提醒。'
            : '桌面环境缺少必要依赖，可能导致桌面版无法稳定运行。',
      checkedAt: new Date().toISOString(),
      project: {
        name: PROJECT_NAME,
        path: PROJECT_DIR,
      },
      runtime: {
        isDesktop: process.env.AIFIOS_DESKTOP === '1',
        packagedDesktop,
        singleInstance: process.env.AIFIOS_DESKTOP_SINGLE_INSTANCE || '',
        nodeEnv: process.env.NODE_ENV || 'development',
        serverMode: process.env.AIFIOS_DESKTOP_SERVER_MODE || '',
        pythonBinary: process.env.AIFIOS_DESKTOP_PYTHON_BINARY || process.env.AIFIOS_PYTHON || '',
        pythonSource: process.env.AIFIOS_DESKTOP_PYTHON_SOURCE || '',
        pythonVersion: process.env.AIFIOS_DESKTOP_PYTHON_VERSION || '',
        nodeBinary: process.env.AIFIOS_NODE_BINARY || '',
        nextDistDir: process.env.AIFIOS_NEXT_DIST_DIR || '',
        projectSource: process.env.AIFIOS_DESKTOP_PROJECT_SOURCE || '',
        desktopUserDataDir: process.env.AIFIOS_DESKTOP_USER_DATA_DIR || '',
        desktopSettingsPath: process.env.AIFIOS_DESKTOP_SETTINGS_PATH || '',
        desktopParentPid: process.env.AIFIOS_DESKTOP_PARENT_PID || '',
        desktopParentAlive: desktopParentStatus,
        serviceRestartCount: process.env.AIFIOS_DESKTOP_SERVICE_RESTART_COUNT || '',
        serviceStartedAt: process.env.AIFIOS_DESKTOP_SERVICE_STARTED_AT || '',
        serviceLastExit: process.env.AIFIOS_DESKTOP_SERVICE_LAST_EXIT || '',
        serviceRestartMax: process.env.AIFIOS_DESKTOP_SERVICE_RESTART_MAX || '',
        serviceWatchdogEnabled: process.env.AIFIOS_DESKTOP_SERVICE_WATCHDOG_ENABLED || '',
        serviceWatchdogFailureCount: process.env.AIFIOS_DESKTOP_SERVICE_WATCHDOG_FAILURE_COUNT || '',
        serviceWatchdogThreshold: process.env.AIFIOS_DESKTOP_SERVICE_WATCHDOG_THRESHOLD || '',
        serviceWatchdogRestartCount: process.env.AIFIOS_DESKTOP_SERVICE_WATCHDOG_RESTART_COUNT || '',
        serviceWatchdogIntervalMs: process.env.AIFIOS_DESKTOP_SERVICE_WATCHDOG_INTERVAL_MS || '',
        serviceWatchdogTimeoutMs: process.env.AIFIOS_DESKTOP_SERVICE_WATCHDOG_TIMEOUT_MS || '',
        electronVersion: process.env.AIFIOS_ELECTRON_VERSION || '',
        electronAppVersion: process.env.AIFIOS_ELECTRON_APP_VERSION || '',
        configFile: CONFIG_FILE,
      },
      llm: {
        status: llmStatus,
        provider,
        model,
        keySource: savedKey ? '已保存密钥' : envKey ? '环境变量' : '未配置',
        hasSavedKey: savedKey,
        hasEnvKey: envKey,
        envKeyName: envKeyName(provider),
      },
      tools,
      paths,
      recommendedActions: recommendedActions(tools, paths, llmStatus, packagedDesktop),
    }));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法完成运行诊断，请重试。',
      code: 'desktop_diagnostics_failed',
      status: 500,
      extra: { status: 'fail' },
    });
  }
}
