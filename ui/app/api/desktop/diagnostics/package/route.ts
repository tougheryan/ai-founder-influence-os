import os from 'os';
import { basename } from 'path';
import { NextResponse } from 'next/server';
import { sanitizeSupportPayload } from '@/lib/diagnostic-redaction';
import { INSTALL_ROOT, PROJECT_DIR, PROJECT_NAME, runtimeJoin } from '@/lib/project-root';
import { GET as diagnosticsGET } from '../route';
import { readManifestSummary, readTextTail } from './secure-local-files';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const dynamic = 'force-dynamic';

type JsonRecord = Record<string, unknown>;

function isoFilenameTime(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

async function readDesktopDiagnostics(): Promise<unknown> {
  const response = await diagnosticsGET();
  try {
    return await response.json();
  } catch {
    return {
      status: response.ok ? 'warn' : 'fail',
      summary: '桌面环境诊断接口返回了不可解析响应。',
      httpStatus: response.status,
    };
  }
}

function desktopLogPath(): string {
  const userDataDir = process.env.AIFIOS_DESKTOP_USER_DATA_DIR || '';
  return userDataDir ? runtimeJoin(userDataDir, 'logs', 'desktop.log') : '';
}

function selectedDesktopEnv(): JsonRecord {
  return {
    AIFIOS_DESKTOP: process.env.AIFIOS_DESKTOP || '',
    AIFIOS_DESKTOP_SINGLE_INSTANCE: process.env.AIFIOS_DESKTOP_SINGLE_INSTANCE || '',
    AIFIOS_DESKTOP_SERVER_MODE: process.env.AIFIOS_DESKTOP_SERVER_MODE || '',
    AIFIOS_DESKTOP_PROJECT_SOURCE: process.env.AIFIOS_DESKTOP_PROJECT_SOURCE || '',
    AIFIOS_DESKTOP_USER_DATA_DIR: process.env.AIFIOS_DESKTOP_USER_DATA_DIR || '',
    AIFIOS_DESKTOP_SETTINGS_PATH: process.env.AIFIOS_DESKTOP_SETTINGS_PATH || '',
    AIFIOS_DESKTOP_PARENT_PID: process.env.AIFIOS_DESKTOP_PARENT_PID || '',
    AIFIOS_DESKTOP_PYTHON_SOURCE: process.env.AIFIOS_DESKTOP_PYTHON_SOURCE || '',
    AIFIOS_NEXT_DIST_DIR: process.env.AIFIOS_NEXT_DIST_DIR || '',
    NODE_ENV: process.env.NODE_ENV || '',
  };
}

export async function GET() {
  try {
    const generatedAt = new Date();
    const desktopPackageManifestPath = runtimeJoin(INSTALL_ROOT, 'dist', 'desktop', 'desktop-package-manifest.json');
    const dmgManifestPath = runtimeJoin(INSTALL_ROOT, 'dist', 'Echo-Founder-0.2.0-beta.2-mac-arm64.manifest.json');
    const payload = {
      packageType: 'echo-founder-desktop-diagnostics-package',
      schema: 'echo-founder.desktop-diagnostics.v1',
      generatedAt: generatedAt.toISOString(),
      privacy: {
        redaction: 'local paths and common secret token patterns are redacted',
        exclusions: [
          'API keys and saved provider secrets',
          'full process environment',
          'cookies and browser profiles',
          'raw materials and user content files',
          'unbounded logs',
        ],
      },
      project: {
        name: PROJECT_NAME,
        root: PROJECT_DIR,
        installRoot: INSTALL_ROOT,
      },
      platform: {
        os: {
          platform: process.platform,
          arch: process.arch,
          type: os.type(),
          release: os.release(),
          hostname: basename(os.hostname() || 'local-host'),
        },
        process: {
          pid: process.pid,
          cwd: process.cwd(),
          nodeVersion: process.version,
          uptimeSeconds: Math.round(process.uptime()),
          versions: {
            electron: process.versions.electron || '',
            chrome: process.versions.chrome || '',
            node: process.versions.node || '',
            v8: process.versions.v8 || '',
          },
        },
      },
      runtimeEnv: selectedDesktopEnv(),
      diagnostics: await readDesktopDiagnostics(),
      logs: {
        desktop: await readTextTail(desktopLogPath()),
      },
      manifests: {
        desktopPackage: await readManifestSummary(desktopPackageManifestPath),
        dmg: await readManifestSummary(dmgManifestPath),
      },
    };

    const safePayload = sanitizeSupportPayload(payload);
    const filename = `echo-founder-diagnostics-${isoFilenameTime(generatedAt)}.json`;
    return NextResponse.json(safePayload, {
      headers: {
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法生成诊断包，请重试。',
      code: 'desktop_diagnostics_package_failed',
      status: 500,
      extra: { status: 'fail' },
    });
  }
}
