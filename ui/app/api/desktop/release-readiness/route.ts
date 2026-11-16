import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile, stat } from 'fs/promises';
import { isAbsolute } from 'path';
import { NextResponse } from 'next/server';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { INSTALL_ROOT, redactLocalPaths, runtimeJoin } from '@/lib/project-root';
import { readCommercialAcceptanceFile } from '@/lib/commercial-acceptance-file';
import type { CommercialAcceptanceStatus } from '@/lib/commercial-acceptance-status';

export const dynamic = 'force-dynamic';

const AUDIT_DIR = runtimeJoin(INSTALL_ROOT, 'quality', 'system-audits');
const execFileAsync = promisify(execFile);
const ACCEPTANCE_DIR = runtimeJoin(INSTALL_ROOT, 'quality', 'acceptance');
const QA_REGISTRY_PATH = runtimeJoin(ACCEPTANCE_DIR, 'trusted-qa-public-keys.json');
const REPOSITORY_ACCEPTANCE_PATH = runtimeJoin(ACCEPTANCE_DIR, 'real-account-acceptance.json');

type JsonRecord = Record<string, unknown>;
type GateStatus = 'pass' | 'warn' | 'blocked' | 'missing';

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function actionStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!isRecord(item)) return '';
      const blocker = stringValue(item.blocker);
      const action = stringValue(item.action);
      return blocker && action ? `${blocker}：${action}` : action;
    })
    .filter(Boolean);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function latestTime(payload: JsonRecord, fallback: string): string {
  return (
    stringValue(payload.checked_at) ||
    stringValue(payload.finished_at) ||
    stringValue(payload.ended_at) ||
    stringValue(payload.started_at) ||
    fallback
  );
}

async function readLatestReport(prefix: string): Promise<{ path: string; modifiedAt: string; payload: JsonRecord } | null> {
  try {
    const files = (await readdir(AUDIT_DIR))
      .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
      .sort();
    if (!files.length) return null;

    const candidates = await Promise.all(
      files.map(async (file) => {
        const path = runtimeJoin(AUDIT_DIR, file);
        const stats = await stat(path);
        return { file, path, stats };
      })
    );
    const latest = candidates.sort((left, right) => {
      const timeDelta = left.stats.mtimeMs - right.stats.mtimeMs;
      return timeDelta || left.file.localeCompare(right.file);
    }).at(-1);
    if (!latest) return null;

    const raw = await readFile(latest.path, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      path: latest.path,
      modifiedAt: latest.stats.mtime.toISOString(),
      payload: record(parsed),
    };
  } catch {
    return null;
  }
}

async function readOptionalJson(path: string): Promise<JsonRecord | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > 2 * 1024 * 1024) return null;
    return record(JSON.parse(await readFile(path, 'utf-8')));
  } catch {
    return null;
  }
}

function realAccountAcceptancePath(): { path: string; source: 'active_workspace' | 'repository' } {
  const configured = String(process.env.AIFIOS_REAL_ACCOUNT_ACCEPTANCE_WORKSPACE || '').trim();
  if (configured && isAbsolute(configured)) {
    return {
      path: configured.endsWith('.json') ? configured : runtimeJoin(configured, 'real-account-acceptance.json'),
      source: 'active_workspace',
    };
  }
  const userData = String(process.env.AIFIOS_DESKTOP_USER_DATA_DIR || '').trim();
  if (userData && isAbsolute(userData)) {
    return {
      path: runtimeJoin(userData, 'acceptance', 'real-account-current', 'real-account-acceptance.json'),
      source: 'active_workspace',
    };
  }
  return { path: REPOSITORY_ACCEPTANCE_PATH, source: 'repository' };
}

async function readSourceStatus() {
  try {
    const [{ stdout: shaOutput }, { stdout: statusOutput }] = await Promise.all([
      execFileAsync('git', ['-C', INSTALL_ROOT, 'rev-parse', 'HEAD'], { timeout: 3000, maxBuffer: 1024 * 1024 }),
      execFileAsync('git', ['-C', INSTALL_ROOT, 'status', '--porcelain=v1', '--untracked-files=all'], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 }),
    ]);
    const entries = String(statusOutput).split(/\r?\n/).filter((line) => line.trim());
    return {
      available: true,
      currentSha: String(shaOutput).trim(),
      dirty: entries.length > 0,
      dirtyEntryCount: entries.length,
    };
  } catch {
    return { available: false, currentSha: '', dirty: null, dirtyEntryCount: null };
  }
}

async function readCommercialAcceptanceStatus(productVersion: string, assessment: JsonRecord): Promise<CommercialAcceptanceStatus> {
  const expectedArtifactBase = `Echo-Founder-${productVersion}-mac-arm64`;
  const exactArtifactPaths = [
    runtimeJoin(INSTALL_ROOT, 'dist', `${expectedArtifactBase}.dmg`),
    runtimeJoin(INSTALL_ROOT, 'dist', `${expectedArtifactBase}.dmg.sha256`),
    runtimeJoin(INSTALL_ROOT, 'dist', `${expectedArtifactBase}.manifest.json`),
    runtimeJoin(INSTALL_ROOT, 'dist', `${expectedArtifactBase}.package-manifest.json`),
  ];
  const acceptanceLocation = realAccountAcceptancePath();
  const [source, registry, acceptance, exactArtifactStats] = await Promise.all([
    readSourceStatus(),
    readOptionalJson(QA_REGISTRY_PATH),
    readCommercialAcceptanceFile(acceptanceLocation.path),
    Promise.all(exactArtifactPaths.map((path) => stat(path).catch(() => null))),
  ]);
  const qaKeys = Array.isArray(registry?.keys)
    ? registry.keys.filter((item) => isRecord(item) && item.status !== 'revoked')
    : [];
  const assessedApp = record(assessment.app);
  const exactArtifactsPresent = exactArtifactStats.every((item) => Boolean(item?.isFile() && item.size > 0));
  const artifactVersionMatches = stringValue(assessedApp.version) === productVersion;
  const frozenCandidateReady = source.dirty === false && exactArtifactsPresent && artifactVersionMatches;
  return {
    schema: 'echo-founder.commercial-acceptance-status.v2',
    productVersion,
    source,
    qaTrust: {
      registryPresent: registry?.schema === 'echo-founder.trusted-qa-public-keys.v1',
      keyCount: qaKeys.length,
      ready: registry?.schema === 'echo-founder.trusted-qa-public-keys.v1' && qaKeys.length > 0,
    },
    frozenCandidate: {
      ready: frozenCandidateReady,
      exactArtifactsPresent,
      artifactVersionMatches,
      expectedArtifact: `${expectedArtifactBase}.dmg`,
    },
    record: {
      ...acceptance.record,
      source: acceptanceLocation.source,
    },
    eligibility: acceptance.eligibility,
  };
}

function statusFromReport(value: string, missingStatus: GateStatus = 'missing'): GateStatus {
  if (!value) return missingStatus;
  if (value === 'pass' || value === 'external_ready') return 'pass';
  if (value === 'warn' || value === 'review_required') return 'warn';
  return 'blocked';
}

function gate(id: string, label: string, status: GateStatus, detail: string, reportPath?: string) {
  return { id, label, status, detail, reportPath };
}

export async function GET() {
  try {
    const [assessmentReport, notarizationReport, releaseGateReport, soakReport] = await Promise.all([
      readLatestReport('desktop-release-assessment-'),
      readLatestReport('desktop-notarization-check'),
      readLatestReport('desktop-release-gate-'),
      readLatestReport('desktop-packaged-soak-'),
    ]);

    const assessment = record(assessmentReport?.payload);
    const notarization = record(notarizationReport?.payload);
    const releaseGate = record(releaseGateReport?.payload);
    const soak = record(soakReport?.payload);
    const app = record(assessment.app);
    const dmg = record(assessment.dmg);
    const signing = record(record(assessment.signing).summary);
    const embeddedPython = record(assessment.embedded_python_runtime);
    const releaseBlockers = stringArray(assessment.blockers);
    const notarizationBlockers = stringArray(notarization.blockers);
    const externalBlockers = dedupe([...releaseBlockers, ...notarizationBlockers]);
    const releaseGateStatus = statusFromReport(stringValue(releaseGate.status));
    const soakStatus = statusFromReport(stringValue(soak.status));
    const artifactsReady = booleanValue(app.exists) && booleanValue(dmg.exists);
    const runtimeReady = stringValue(embeddedPython.status) === 'pass';
    const internalReady = releaseGateStatus === 'pass' && soakStatus === 'pass' && artifactsReady && runtimeReady;
    const externalReady = stringValue(assessment.status) === 'external_ready' && externalBlockers.length === 0;
    const overallStatus = externalReady
      ? 'external_ready'
      : internalReady
        ? 'internal_ready_external_blocked'
        : assessmentReport || releaseGateReport || soakReport
          ? 'needs_attention'
          : 'missing_reports';

    const gates = [
      gate(
        'internal-release-gate',
        '内部发布门禁',
        releaseGateStatus,
        releaseGateReport
          ? `${stringValue(releaseGate.mode, 'unknown')} / ${stringValue(releaseGate.status, 'unknown')}`
          : '未找到 desktop-release-gate 报告',
        releaseGateReport?.path
      ),
      gate(
        'packaged-soak',
        '打包版长稳测试',
        soakStatus,
        soakReport
          ? `${numberValue(soak.iterations) ?? 0} 轮 / 失败 ${Array.isArray(soak.failures) ? soak.failures.length : 0} 次`
          : '未找到 desktop-packaged-soak 报告',
        soakReport?.path
      ),
      gate(
        'app-dmg-artifacts',
        'App 与 DMG 产物',
        artifactsReady ? 'pass' : 'blocked',
        artifactsReady
          ? `App ${stringValue(app.version, 'unknown')} / DMG ${(numberValue(dmg.size_bytes) ?? 0).toLocaleString('zh-CN')} bytes`
          : 'App 或 DMG 产物缺失',
        assessmentReport?.path
      ),
      gate(
        'embedded-python-runtime',
        '内置 Python 运行时',
        runtimeReady ? 'pass' : 'blocked',
        `Python ${stringValue(embeddedPython.status, 'missing')}`,
        assessmentReport?.path
      ),
      gate(
        'developer-id',
        'Developer ID 签名',
        releaseBlockers.some((item) => item.includes('developer-id') || item.includes('hardened-runtime')) ? 'blocked' : statusFromReport(stringValue(assessment.status)),
        `${stringValue(signing.signature_kind, 'unknown')} / hardened runtime ${booleanValue(signing.hardened_runtime) ? 'pass' : 'missing'}`,
        assessmentReport?.path
      ),
      gate(
        'notarization',
        '公证与凭证',
        notarizationBlockers.length || releaseBlockers.some((item) => item.includes('notarization')) ? 'blocked' : statusFromReport(stringValue(notarization.status), 'warn'),
        notarizationBlockers.length ? notarizationBlockers.join(', ') : stringValue(notarization.status, '未检查'),
        notarizationReport?.path
      ),
      gate(
        'gatekeeper',
        'Gatekeeper 首启',
        releaseBlockers.some((item) => item.includes('gatekeeper') || item.includes('quarantine')) ? 'blocked' : statusFromReport(stringValue(assessment.status)),
        releaseBlockers.filter((item) => item.includes('gatekeeper') || item.includes('quarantine')).join(', ') || stringValue(assessment.status, '未检查'),
        assessmentReport?.path
      ),
    ];

    const recommendedActions = dedupe([
      ...actionStrings(assessment.recommended_actions),
      ...actionStrings(notarization.recommended_actions),
      ...(internalReady ? [] : ['先复跑 make desktop-release-gate DESKTOP_RELEASE_GATE_MODE=standard，并确认 packaged soak 报告留存在 quality/system-audits。']),
      ...(externalReady ? [] : ['正式外部分发前必须完成 Developer ID 签名、公证、staple 和 Gatekeeper/quarantine 验收。']),
    ]);

    const productVersion = (await readFile(runtimeJoin(INSTALL_ROOT, 'VERSION'), 'utf-8')).trim();
    const commercialAcceptance = await readCommercialAcceptanceStatus(productVersion, assessment);
    const payload = {
      status: overallStatus,
      checkedAt: new Date().toISOString(),
      summary: externalReady
        ? '桌面版已满足正式外部分发检查。'
        : internalReady
          ? '桌面版满足当前源码/DMG 内测交付要求；正式外部分发仍被签名、公证或 Gatekeeper 阻断。'
          : '桌面版交付证据不完整或存在阻断项，需要先补齐内部发布门禁与长稳测试。',
      internalReady,
      externalReady,
      externalBlockers,
      gates,
      recommendedActions,
      commercialAcceptance,
      reports: {
        releaseAssessment: assessmentReport
          ? {
              path: assessmentReport.path,
              checkedAt: latestTime(assessment, assessmentReport.modifiedAt),
              status: stringValue(assessment.status),
              blockers: releaseBlockers,
              app: {
                exists: booleanValue(app.exists),
                bundleId: stringValue(app.bundle_id),
                version: stringValue(app.version),
              },
              dmg: {
                exists: booleanValue(dmg.exists),
                sha256: stringValue(dmg.sha256),
                sizeBytes: numberValue(dmg.size_bytes),
              },
              signing: {
                signatureKind: stringValue(signing.signature_kind),
                developerId: booleanValue(signing.developer_id),
                hardenedRuntime: booleanValue(signing.hardened_runtime),
              },
            }
          : null,
        notarization: notarizationReport
          ? {
              path: notarizationReport.path,
              checkedAt: latestTime(notarization, notarizationReport.modifiedAt),
              status: stringValue(notarization.status),
              blockers: notarizationBlockers,
              readinessChecklist: Array.isArray(notarization.readiness_checklist) ? notarization.readiness_checklist : [],
            }
          : null,
        releaseGate: releaseGateReport
          ? {
              path: releaseGateReport.path,
              checkedAt: latestTime(releaseGate, releaseGateReport.modifiedAt),
              status: stringValue(releaseGate.status),
              mode: stringValue(releaseGate.mode),
              durationSeconds: numberValue(releaseGate.duration_seconds),
              failedSteps: Array.isArray(releaseGate.failed_steps) ? releaseGate.failed_steps : [],
            }
          : null,
        packagedSoak: soakReport
          ? {
              path: soakReport.path,
              checkedAt: latestTime(soak, soakReport.modifiedAt),
              status: stringValue(soak.status),
              iterations: numberValue(soak.iterations),
              actualDurationSeconds: numberValue(soak.actual_duration_seconds),
              portClosed: booleanValue(soak.port_closed),
              failures: Array.isArray(soak.failures) ? soak.failures.length : 0,
            }
          : null,
      },
    };

    return NextResponse.json(redactLocalPaths(payload), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法完成发布准备检查，请重试。',
      code: 'desktop_release_readiness_failed',
      status: 500,
      extra: { status: 'fail' },
    });
  }
}
