import { execFile } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { NextRequest, NextResponse } from 'next/server';
import {
  OUTPUT_STAGE_META,
  PIPELINE_REGISTRY,
  getStepIdByRuntimeStep,
} from '@/lib/pipeline-registry';
import { ensureProjectInitialized } from '@/lib/project-init';
import { BASE_DIR, safeResolve } from '@/lib/output-files';
import { contentRuntimeToolPath, PROJECT_NAME, redactLocalPaths, runtimeJoin, toProjectRelativePath } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { assertOptionalTextInput, InputLimitError, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { loadVisualWorkbenchState } from '@/lib/visual-workbench';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';
import { getRunDisclosure } from '@/lib/output-disclosure';
import { MAX_OUTPUT_DOWNLOAD_BYTES, OutputDownloadError, prepareOutputDownload } from '@/lib/output-export';

const execFileAsync = promisify(execFile);
const DELIVERY_SCRIPT = contentRuntimeToolPath('delivery_pack.py');
const DELIVERY_AUDIT_SCRIPT = contentRuntimeToolPath('delivery_audit.py');
const RUNTIME_SCRIPT = contentRuntimeToolPath('content_runtime.py');

type RuntimeRun = {
  run_id?: string;
  slug?: string;
  status?: string;
  topic?: string;
  target_platforms?: string[];
  selected_platforms?: string[];
  current_step?: string | null;
  updated_at?: string;
  steps?: Record<string, { latest?: string; updated_at?: string; source?: string | null }>;
};

type DeliveryReadiness = {
  stepId: number;
  title: string;
  skill: string;
  runtimeSteps: string[];
  path: string;
  ready: boolean;
  requiredForDelivery: boolean;
  stageStepId: number | null;
};

type AssetGateItem = {
  type: 'visual';
  label: string;
  path: string;
  status: 'pass' | 'review' | 'blocked';
  reason: string;
  required: boolean;
};

type AssetGate = {
  status: 'pass' | 'review_required' | 'blocked' | 'not_started';
  summary: string;
  checkedCount: number;
  blockingCount: number;
  reviewCount: number;
  visualPlan?: string;
  items: AssetGateItem[];
};

type LatestState = {
  active_run_id?: string | null;
  current_slug?: string | null;
  latest_files?: Record<string, string | null>;
};

type DeliveryAuditAction = {
  id?: string;
  title?: string;
  owner?: string;
  severity?: string;
  issue_codes?: string[];
  issue_count?: number;
  command?: string;
  summary?: string;
  artifacts?: string[];
  messages?: string[];
};

type DeliveryManifest = {
  run_id?: string;
  slug?: string;
  topic?: string;
  created_at?: string;
  delivery_dir?: string;
  zip_path?: string;
  artifacts?: Array<{ step?: string; label?: string; source?: string | null; copied_to?: string | null }>;
  privacy_scan?: { status?: string; file_count?: number; flagged?: string[] };
  delivery_gate?: {
    status?: string;
    label?: string;
    can_deliver?: boolean;
    needs_human_review?: boolean;
    message?: string;
    blocking_count?: number | null;
    review_count?: number | null;
    audit_report?: string;
    markdown_report?: string;
    stale_artifacts?: Array<{ step?: string; path?: string; updated_at?: string; reason?: string }>;
    stale_quality_reports?: Array<{ path?: string; created_at?: string; platform?: string; file?: string; reason?: string }>;
    coverage_gaps?: Array<{ step?: string; path?: string; reason?: string }>;
    invalid_runtime_artifacts?: Array<{ step?: string; path?: string; reason?: string }>;
    recommended_actions?: DeliveryAuditAction[];
    runtime_validation?: {
      checked_count?: number;
      blocking_count?: number;
      review_count?: number;
      blocking?: Array<{ step?: string; path?: string; reason?: string }>;
      review?: Array<{ step?: string; path?: string; reason?: string }>;
    };
  };
};

type DeliveryAuditIssue = {
  severity?: 'blocked' | 'review' | string;
  code?: string;
  message?: string;
  fix?: string;
  artifact?: string;
};

type DeliveryAudit = {
  status?: 'pass' | 'review_required' | 'blocked' | 'error' | string;
  run_id?: string;
  slug?: string;
  topic?: string;
  audited_at?: string;
  blocking_count?: number;
  review_count?: number;
  issues?: DeliveryAuditIssue[];
  recommended_actions?: DeliveryAuditAction[];
  summary?: {
    can_deliver?: boolean;
    needs_human_review?: boolean;
    must_fix?: string[];
    review_before_delivery?: string[];
  };
  delivery_pack?: {
    status?: string | null;
    delivery_dir?: string | null;
    zip_path?: string | null;
    privacy_status?: string | null;
  };
  json_report_path?: string;
  markdown_report_path?: string;
  error?: string;
};

const VISUAL_PATH_RE = /pipeline\/visual\/[^\s`|，。；;)\]）]+/gi;
const DIRECTORY_PATH_SUFFIX_RE = /\/(?:keyframes|公众号HTML输出)\/?$/i;

function toRelativePath(path: string | undefined | null): string {
  return toProjectRelativePath(path);
}

function normalizeGateRows<T extends { path?: string; file?: string }>(rows?: T[]): T[] | undefined {
  return rows?.map((item) => ({
    ...item,
    path: toRelativePath(item.path),
    file: toRelativePath(item.file),
  }));
}

function normalizeManifestPaths(manifest: DeliveryManifest | null): DeliveryManifest | null {
  if (!manifest) return null;
  const gate = manifest.delivery_gate;
  return {
    ...manifest,
    delivery_dir: toRelativePath(manifest.delivery_dir),
    zip_path: toRelativePath(manifest.zip_path),
    delivery_gate: gate
      ? {
          ...gate,
          audit_report: toRelativePath(gate.audit_report),
          markdown_report: toRelativePath(gate.markdown_report),
          stale_artifacts: normalizeGateRows(gate.stale_artifacts),
          stale_quality_reports: normalizeGateRows(gate.stale_quality_reports),
          coverage_gaps: normalizeGateRows(gate.coverage_gaps),
          invalid_runtime_artifacts: normalizeGateRows(gate.invalid_runtime_artifacts),
          recommended_actions: gate.recommended_actions?.map((item) => ({
            ...item,
            artifacts: item.artifacts?.map((artifact) => toRelativePath(artifact)),
          })),
          runtime_validation: gate.runtime_validation
            ? {
                ...gate.runtime_validation,
                blocking: normalizeGateRows(gate.runtime_validation.blocking),
                review: normalizeGateRows(gate.runtime_validation.review),
              }
            : gate.runtime_validation,
        }
      : gate,
  };
}

function normalizeAuditPaths(audit: DeliveryAudit | null): DeliveryAudit | null {
  if (!audit) return null;
  return {
    ...audit,
    json_report_path: toRelativePath(audit.json_report_path),
    markdown_report_path: toRelativePath(audit.markdown_report_path),
    recommended_actions: audit.recommended_actions?.map((item) => ({
      ...item,
      artifacts: item.artifacts?.map((artifact) => toRelativePath(artifact)),
    })),
    delivery_pack: audit.delivery_pack
      ? {
          ...audit.delivery_pack,
          delivery_dir: toRelativePath(audit.delivery_pack.delivery_dir),
          zip_path: toRelativePath(audit.delivery_pack.zip_path),
        }
      : audit.delivery_pack,
  };
}

function normalizeRun(data: unknown): RuntimeRun | null {
  if (!data || typeof data !== 'object') return null;
  return data as RuntimeRun;
}

async function readJsonFile<T>(relativePath: string): Promise<T | null> {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) return null;
  try {
    return JSON.parse(await readFile(safePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function listRuns(): Promise<RuntimeRun[]> {
  const runsDir = safeResolve(BASE_DIR, 'runs');
  if (!runsDir) return [];
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    const rows = await Promise.all(
      files.map(async (entry) => {
        const path = runtimeJoin(runsDir, entry.name);
        const [stats, content] = await Promise.all([stat(path), readFile(path, 'utf-8')]);
        const run = normalizeRun(JSON.parse(content));
        return run ? { ...run, updated_at: run.updated_at || stats.mtime.toISOString() } : null;
      })
    );
    const validRows: RuntimeRun[] = [];
    for (const item of rows) {
      if (item) validRows.push(item);
    }
    return validRows.sort(
      (a, b) => new Date(b.updated_at || '').getTime() - new Date(a.updated_at || '').getTime()
    );
  } catch {
    return [];
  }
}

async function loadActiveRun(): Promise<RuntimeRun | null> {
  const latest = await readJsonFile<LatestState>('sessions/latest.json');
  const runs = await listRuns();
  const loaded = await loadRun(latest?.active_run_id, latest?.current_slug);
  if (loaded) return loaded;
  if (latest?.active_run_id) {
    const byRunId = runs.find((run) => run.run_id === latest.active_run_id);
    if (byRunId) return byRunId;
  }
  if (latest?.current_slug) {
    const bySlug = runs.find((run) => run.slug === latest.current_slug);
    if (bySlug) return bySlug;
  }
  return runs[0] || null;
}

function matchesActiveRun(
  item: { run_id?: string | null; slug?: string | null } | null | undefined,
  activeRun: RuntimeRun | null
): boolean {
  if (!item || !activeRun) return false;
  const activeRunId = activeRun.run_id?.trim();
  if (activeRunId) return item.run_id === activeRunId;
  const activeSlug = activeRun.slug?.trim();
  return Boolean(activeSlug && item.slug === activeSlug);
}

async function loadRun(runId?: string | null, slug?: string | null): Promise<RuntimeRun | null> {
  const args = [RUNTIME_SCRIPT, '--project', BASE_DIR, 'run'];
  if (runId) args.push('--run-id', runId);
  if (slug) args.push('--slug', slug);

  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), args, {
      cwd: BASE_DIR,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 15000,
    });
    return normalizeRun(JSON.parse(stdout));
  } catch {
    return null;
  }
}

function pickArtifactPath(run: RuntimeRun | null, latest: LatestState | null, runtimeSteps: string[]): string {
  const terminalStep = runtimeSteps.at(-1);
  if (!terminalStep) return '';
  // A run is the source of truth once one has been resolved. Falling back to
  // global session state here can display another run's artifact as ready.
  if (run) return run.steps?.[terminalStep]?.latest || '';
  return latest?.latest_files?.[terminalStep] || '';
}

function targetDraftRequirements(run: RuntimeRun | null) {
  if (run && !run.steps?.write?.latest) {
    const selected = run.selected_platforms?.length ? run.selected_platforms : run.target_platforms || [];
    const labels = selected.map((platform) => ({
      wechat: '公众号', xhs: '小红书', shipinhao: '视频号',
    }[platform] || platform));
    return [{
      runtimeStep: 'package',
      title: `已选平台原生成稿${labels.length ? `（${labels.join('、')}）` : ''}`,
      requiredForDelivery: true,
    }];
  }
  const rows = [
    { runtimeStep: 'write', title: '公众号母稿', requiredForDelivery: true },
    { runtimeStep: 'package', title: '全平台内容包（1+2+3）', requiredForDelivery: true },
  ];

  // The package is the default five-platform delivery artifact. An xhs draft is
  // only an explicit platform override, so its absence must not block delivery.
  if (run?.steps?.xhs?.latest) {
    rows.push({ runtimeStep: 'xhs', title: '小红书独立改写（可选）', requiredForDelivery: false });
  }
  return rows;
}

function trustCheckRequirements() {
  return [
    { runtimeStep: 'prelaunch', title: '发布前深度检查（按需）', skill: 'content-prelaunch' },
    { runtimeStep: 'compliance', title: '平台合规深度检查（按需）', skill: 'content-compliance' },
    { runtimeStep: 'audit', title: '可信深度审核（按需）', skill: 'content-audit' },
  ];
}

function buildReadiness(run: RuntimeRun | null, latest: LatestState | null): DeliveryReadiness[] {
  const rows = PIPELINE_REGISTRY
    // Publish assets are stored outside the runtime step ledger and are shown
    // in the dedicated platform-delivery surface instead of as a perpetually
    // missing readiness row.
    .filter((step) => step.runtimeSteps.length > 0)
    .map((step) => {
      const path = pickArtifactPath(run, latest, step.runtimeSteps);
      const requiredForDelivery = step.autoRunnable || step.id === 4;
      return {
        stepId: step.id,
        title: OUTPUT_STAGE_META[step.id]?.title || step.name,
        skill: step.skill,
        runtimeSteps: step.runtimeSteps,
        path,
        ready: Boolean(path),
        requiredForDelivery,
        stageStepId: path ? getStepIdByRuntimeStep(step.runtimeSteps[0]) : step.id,
      };
    });
  const draftRequirements = targetDraftRequirements(run);
  const platformDrafts = draftRequirements.map((item) => {
    const path = pickArtifactPath(run, latest, [item.runtimeStep]);
    return {
      stepId: 4,
      title: item.title,
      skill: item.runtimeStep === 'write'
        ? 'wechat-writer'
        : item.runtimeStep === 'package'
          ? 'content-package'
          : 'xhs-card',
      runtimeSteps: [item.runtimeStep],
      path,
      ready: Boolean(path),
      requiredForDelivery: item.requiredForDelivery,
      stageStepId: 4,
    };
  });
  const trustChecks = trustCheckRequirements().map((item) => {
    const path = pickArtifactPath(run, latest, [item.runtimeStep]);
    return {
      stepId: 7,
      title: item.title,
      skill: item.skill,
      runtimeSteps: [item.runtimeStep],
      path,
      ready: Boolean(path),
      // release_gate is the default content-package gate. These expensive
      // reports remain available for exceptional, high-risk reviews only.
      requiredForDelivery: false,
      stageStepId: 7,
    };
  });
  return rows.flatMap((row) => {
    if (row.stepId === 4) return platformDrafts;
    if (row.stepId === 7) return trustChecks;
    return [row];
  });
}

function extractVisualAssetPaths(text: string): string[] {
  const rows = text.match(VISUAL_PATH_RE) || [];
  const paths: string[] = [];
  for (const raw of rows) {
    const clean = raw.trim().replace(/[ `|，。；;,.、)）\]】]+$/g, '');
    if (clean.startsWith('pipeline/visual/') && !paths.includes(clean)) paths.push(clean);
  }
  return paths;
}

function isCheckableAssetPath(relativePath: string): boolean {
  if (/\/prompts\//i.test(relativePath)) return false;
  if (/^pipeline\/visual\/[^/]+-visual\.md$/i.test(relativePath)) return false;
  return DIRECTORY_PATH_SUFFIX_RE.test(relativePath) || /\/[^/]+\.[A-Za-z0-9]+$/.test(relativePath);
}

function assetLabel(relativePath: string): string {
  if (/公众号HTML输出\/?$/i.test(relativePath) || /公众号HTML输出\/index\.html$/i.test(relativePath)) return '公众号 HTML';
  if (/cover\.(png|jpg|jpeg|webp|html)$/i.test(relativePath)) return '封面资产';
  if (/share|card/i.test(relativePath)) return '分享卡片';
  return '视觉资产';
}

async function hasNonEmptyFile(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = runtimeJoin(directory, entry.name);
      if (entry.isFile()) {
        const stats = await stat(child);
        if (stats.size > 0) return true;
      } else if (entry.isDirectory() && (await hasNonEmptyFile(child))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function checkProjectAsset(relativePath: string): Promise<{ ok: boolean; reason: string }> {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) return { ok: false, reason: '路径越界或非法' };
  try {
    const stats = await stat(safePath);
    if (stats.isFile()) {
      return stats.size > 0 ? { ok: true, reason: '已落盘' } : { ok: false, reason: '文件为空' };
    }
    if (stats.isDirectory()) {
      return (await hasNonEmptyFile(safePath))
        ? { ok: true, reason: '目录内已有非空文件' }
        : { ok: false, reason: '目录内没有非空文件' };
    }
    return { ok: false, reason: '不是可交付文件或目录' };
  } catch {
    return { ok: false, reason: '文件或目录不存在' };
  }
}

async function readProjectText(relativePath?: string): Promise<string> {
  if (!relativePath) return '';
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) return '';
  try {
    return await readFile(safePath, 'utf-8');
  } catch {
    return '';
  }
}

async function buildAssetGate(run: RuntimeRun | null): Promise<AssetGate> {
  const items: AssetGateItem[] = [];
  if (!run) {
    return {
      status: 'not_started',
      summary: '当前没有活动 run，暂未检查视觉实物资产。',
      checkedCount: 0,
      blockingCount: 0,
      reviewCount: 0,
      items,
    };
  }

  const slug = run.slug || '';
  const visualPlan = run.steps?.visual?.latest || '';
  const slugPrefix = slug ? `pipeline/visual/${slug}/` : 'pipeline/visual/';

  if (visualPlan) {
    const visualBody = await readProjectText(visualPlan);
    const visualPaths = extractVisualAssetPaths(visualBody).filter(isCheckableAssetPath);
    if (!visualPaths.length) {
      items.push({
        type: 'visual',
        label: '视觉 Manifest',
        path: visualPlan,
        status: 'review',
        reason: '视觉计划没有声明可验证的实际资产路径',
        required: true,
      });
    }
    for (const path of visualPaths) {
      if (slug && !path.startsWith(slugPrefix)) {
        items.push({
          type: 'visual',
          label: assetLabel(path),
          path,
          status: 'blocked',
          reason: '引用了非当前 run 的视觉资产路径',
          required: true,
        });
        continue;
      }
      const result = await checkProjectAsset(path);
      items.push({
        type: 'visual',
        label: assetLabel(path),
        path,
        status: result.ok ? 'pass' : 'blocked',
        reason: result.reason,
        required: true,
      });
    }
  }

  const blockingCount = items.filter((item) => item.status === 'blocked').length;
  const reviewCount = items.filter((item) => item.status === 'review').length;
  const checkedCount = items.filter((item) => item.status === 'pass').length;
  const status = blockingCount ? 'blocked' : reviewCount ? 'review_required' : items.length ? 'pass' : 'not_started';
  const summary =
    status === 'pass'
      ? '视觉计划声明的实物资产均已落盘。'
      : status === 'review_required'
        ? '部分视觉资产路径无法自动验证，需要人工补齐或确认。'
        : status === 'blocked'
          ? '存在视觉资产未生成、为空或串用其它 run 的问题。'
          : '还没有可检查的视觉资产。';

  return {
    status,
    summary,
    checkedCount,
    blockingCount,
    reviewCount,
    visualPlan: visualPlan || undefined,
    items,
  };
}

async function listDeliveries(): Promise<DeliveryManifest[]> {
  const deliveriesDir = safeResolve(BASE_DIR, 'deliveries');
  if (!deliveriesDir) return [];
  try {
    const entries = await readdir(deliveriesDir, { withFileTypes: true });
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const manifestPath = runtimeJoin(deliveriesDir, entry.name, 'manifest.json');
          try {
            const [stats, content] = await Promise.all([stat(manifestPath), readFile(manifestPath, 'utf-8')]);
            const manifest = JSON.parse(content) as DeliveryManifest;
            const actualDeliveryDir = runtimeJoin(deliveriesDir, entry.name);
            const actualZipPath = `${actualDeliveryDir}.zip`;
            return {
              ...manifest,
              created_at: manifest.created_at || stats.mtime.toISOString(),
              delivery_dir: actualDeliveryDir,
              zip_path: existsSync(actualZipPath) ? actualZipPath : manifest.zip_path,
            };
          } catch {
            return null;
          }
        })
    );
    const validManifests: DeliveryManifest[] = [];
    for (const item of manifests) {
      if (item) validManifests.push(item);
    }
    return validManifests.sort(
      (a, b) => new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime()
    );
  } catch {
    return [];
  }
}

async function listAudits(): Promise<DeliveryAudit[]> {
  const auditsDir = safeResolve(BASE_DIR, 'quality/system-audits');
  if (!auditsDir) return [];
  try {
    const entries = await readdir(auditsDir, { withFileTypes: true });
    const rows = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const path = runtimeJoin(auditsDir, entry.name);
          try {
            const [stats, content] = await Promise.all([stat(path), readFile(path, 'utf-8')]);
            const audit = JSON.parse(content) as DeliveryAudit;
            return {
              ...audit,
              audited_at: audit.audited_at || stats.mtime.toISOString(),
              json_report_path: audit.json_report_path || path,
              markdown_report_path: audit.markdown_report_path || path.replace(/\.json$/, '.md'),
            };
          } catch {
            return null;
          }
        })
    );
    const validAudits: DeliveryAudit[] = [];
    for (const item of rows) {
      if (item) validAudits.push(item);
    }
    return validAudits.sort(
      (a, b) => new Date(b.audited_at || '').getTime() - new Date(a.audited_at || '').getTime()
    );
  } catch {
    return [];
  }
}

async function runDeliveryAudit(body: { runId?: string; slug?: string; autoPack?: boolean }) {
  const args = [DELIVERY_AUDIT_SCRIPT, '--project', BASE_DIR];
  if (body.runId) args.push('--run-id', body.runId);
  if (body.slug) args.push('--slug', body.slug);
  if (body.autoPack) args.push('--auto-pack');

  try {
    const { stdout, stderr } = await execFileAsync(runtimePythonBinary(), args, {
      cwd: BASE_DIR,
      maxBuffer: 1024 * 1024 * 12,
      timeout: 120000,
    });
    return { audit: normalizeAuditPaths(JSON.parse(stdout) as DeliveryAudit), stderr };
  } catch (error) {
    const maybe = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (maybe.stdout) {
      try {
        const audit = JSON.parse(maybe.stdout) as DeliveryAudit;
        if (audit.status === 'blocked') {
          return { audit: normalizeAuditPaths(audit), stderr: maybe.stderr || '' };
        }
      } catch {
        // fall through to regular error response
      }
    }
    throw new Error(maybe.stderr || maybe.message || '交付审查失败');
  }
}

async function buildStatus() {
  const latest = await readJsonFile<LatestState>('sessions/latest.json');
  const runs = await listRuns();
  const activeRun = await loadActiveRun();
  const readiness = buildReadiness(activeRun, latest);
  const assetGate = await buildAssetGate(activeRun);
  const requiredItems = readiness.filter((item) => item.requiredForDelivery);
  const missingRequired = requiredItems.filter((item) => !item.ready);
  const deliveries = await listDeliveries();
  const audits = await listAudits();
  const scopedDeliveries = activeRun ? deliveries.filter((delivery) => matchesActiveRun(delivery, activeRun)) : [];
  const scopedAudits = activeRun ? audits.filter((audit) => matchesActiveRun(audit, activeRun)) : [];
  const latestDelivery = scopedDeliveries[0] || null;
  const latestAudit = scopedAudits[0] || null;
  const visualWorkbench = activeRun?.slug ? await loadVisualWorkbenchState(activeRun.slug) : null;

  return redactLocalPaths({
    project: PROJECT_NAME,
    latest,
    runs,
    activeRun,
    visualWorkbench,
    readiness,
    assetGate,
    readyCount: readiness.filter((item) => item.ready).length,
    requiredCount: requiredItems.length,
    missingRequired,
    latestDelivery: normalizeManifestPaths(latestDelivery),
    deliveries: scopedDeliveries.slice(0, 10).map((item) => normalizeManifestPaths(item) as DeliveryManifest),
    latestAudit: normalizeAuditPaths(latestAudit),
    audits: scopedAudits.slice(0, 10).map((item) => normalizeAuditPaths(item) as DeliveryAudit),
  });
}

async function readDeliveryManifestForZip(relativePath: string): Promise<DeliveryManifest | null> {
  const manifestPath = relativePath.replace(/^deliveries\/(.+)\.zip$/, 'deliveries/$1/manifest.json');
  const safeManifestPath = safeResolve(BASE_DIR, manifestPath);
  if (!safeManifestPath) return null;
  try {
    return JSON.parse(await readFile(safeManifestPath, 'utf-8')) as DeliveryManifest;
  } catch {
    return null;
  }
}

async function deliveryDownloadResponse(relativePath: string) {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath || !/^deliveries\/[^/]+\.zip$/.test(relativePath)) {
    return expectedUserFacingErrorResponse({
      error: '下载地址无效，请返回交付页面重试。',
      code: 'delivery_download_invalid',
      status: 400,
    });
  }
  const activeRun = await loadActiveRun();
  const manifest = await readDeliveryManifestForZip(relativePath);
  if (!matchesActiveRun(manifest, activeRun)) {
    return expectedUserFacingErrorResponse({
      error: '这个交付包不属于当前任务，请重新生成。',
      code: 'delivery_task_mismatch',
      status: 400,
    });
  }
  if (manifest?.delivery_gate?.can_deliver !== true) {
    return expectedUserFacingErrorResponse({
      error: '这份交付包还未通过发布检查，暂时不能下载。',
      code: 'delivery_not_ready',
      status: 409,
    });
  }

  try {
    if ((await stat(safePath)).size > MAX_OUTPUT_DOWNLOAD_BYTES) {
      return expectedUserFacingErrorResponse({ error: '单个导出文件超过 256MB，请拆分后重试。', code: 'delivery_download_too_large', status: 413 });
    }
    const content = await readFile(safePath);
    const fileName = relativePath.split('/').pop() || 'aifios-delivery.zip';
    const disclosure = await getRunDisclosure(manifest?.run_id || '');
    const output = prepareOutputDownload(content, fileName, 'application/zip', disclosure);
    return new Response(new Uint8Array(output.body), {
      headers: {
        'Content-Type': output.contentType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(output.fileName)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof OutputDownloadError) return expectedUserFacingErrorResponse({ error: error.message, code: 'delivery_download_limit', status: 413 });
    return expectedUserFacingErrorResponse({
      error: '交付包不存在，可能已被删除。',
      code: 'delivery_not_found',
      status: 404,
    });
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const download = url.searchParams.get('download');
  if (download) return await deliveryDownloadResponse(download);

  try {
    await ensureProjectInitialized();
    return NextResponse.json(await buildStatus());
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取交付状态，请重试。',
      code: 'delivery_status_read_failed',
      status: 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const url = new URL(req.url);
    const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const body = {
      runId: assertOptionalTextInput(rawBody.runId, 'Run ID', MAX_SHORT_TEXT_BYTES),
      slug: assertOptionalTextInput(rawBody.slug, 'Slug', MAX_SHORT_TEXT_BYTES),
      autoPack: typeof rawBody.autoPack === 'boolean' ? rawBody.autoPack : undefined,
    };
    const action = url.searchParams.get('action');
    return await withProjectWriteLock(`delivery:${action || 'pack'}:${body.runId || body.slug || 'active'}`, async () => {
      if (action === 'audit') {
        const auditResult = await runDeliveryAudit({ ...body, autoPack: body.autoPack ?? true });
        return NextResponse.json(redactLocalPaths({
          status: auditResult.audit?.status || 'unknown',
          audit: auditResult.audit,
          overview: await buildStatus(),
        }));
      }

      const args = [DELIVERY_SCRIPT, '--project', BASE_DIR];
      if (body.runId) args.push('--run-id', body.runId);
      if (body.slug) args.push('--slug', body.slug);

      const { stdout } = await execFileAsync(runtimePythonBinary(), args, {
        cwd: BASE_DIR,
        maxBuffer: 1024 * 1024 * 12,
        timeout: 120000,
      });
      const manifest = JSON.parse(stdout) as DeliveryManifest;
      return NextResponse.json(redactLocalPaths({
        status: manifest.delivery_gate?.can_deliver ? 'ready_for_delivery' : 'review_packed',
        manifest: normalizeManifestPaths(manifest),
        overview: await buildStatus(),
      }));
    }, { timeoutMs: 5_000 });
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法生成交付包，请重试。',
      code: 'delivery_package_create_failed',
      status,
    });
  }
}
