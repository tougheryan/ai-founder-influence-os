const { app, BrowserWindow, Menu, dialog, shell, ipcMain, safeStorage, Notification, nativeImage } = require("electron");
const { spawn, spawnSync } = require("child_process");
const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const {
  PUBLICATION_CREDENTIAL_IDS,
  createPublicationBridge,
  normalizeBridgeError,
} = require("./publication-bridge.cjs");
const {
  purgeStalePublicationAssetSnapshots,
} = require("./publication-asset-snapshot.cjs");
const {
  createCredentialVault,
  migrateLegacyPlaintextCredentials,
  migrateLegacyPublicationCredentials,
} = require("./credential-vault.cjs");
const {
  defaultRestoredProjectPath,
  ensureProjectSchema,
  exportProjectBackup,
  importProjectBackup,
  parseAndVerifyManifest,
} = require("./project-backup.cjs");
const { desktopStartupRoute } = require("./startup-route.cjs");
const { loadOrCreateDeviceKey } = require("./device-key.cjs");
const { startHostedGatewayProxy } = require("./hosted-gateway-proxy.cjs");
const { parseDistributionMode } = require("./distribution-mode.cjs");
const {
  restartDesktopService,
  runWithQuiescedService,
  updateCredentialWithCheckedRestart,
} = require("./service-restart.cjs");
const { createServiceLifecycleCoordinator } = require("./service-lifecycle.cjs");
const { restoreAndActivateProject } = require("./project-activation.cjs");
const {
  createDesktopUserFacingFailure,
  encodeDesktopUserFacingError,
  redactDesktopText,
} = require("./desktop-redaction.cjs");
const { openSecureDesktopLogStream } = require("./secure-desktop-log.cjs");
const { RUNTIME_TREE_HASH_SCHEMA, runtimeTreeSha256 } = require("./runtime-tree.cjs");
const { pythonProcessEnvironment } = require("./python-process-environment.cjs");
const { resolveMd2WechatRuntime } = require("./md2wechat-runtime.cjs");

const HOST = "127.0.0.1";
const PRODUCT_NAME = "Echo Founder";
const DEVELOPMENT_DOCK_ICON_PATH = path.join(__dirname, "EchoFounder.png");

app.setName(PRODUCT_NAME);

function configureDesktopAppIdentity() {
  app.setName(PRODUCT_NAME);
  if (process.platform !== "darwin" || app.isPackaged || !app.dock || !fs.existsSync(DEVELOPMENT_DOCK_ICON_PATH)) {
    return;
  }
  const dockIcon = nativeImage.createFromPath(DEVELOPMENT_DOCK_ICON_PATH);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function expandRootHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function configureDesktopUserDataDir() {
  const raw = String(process.env.AIFIOS_DESKTOP_USER_DATA_DIR || "").trim();
  if (!raw) return;
  const target = path.resolve(expandRootHome(raw));
  fs.mkdirSync(target, { recursive: true });
  app.setPath("userData", target);
}

configureDesktopUserDataDir();

function isAifiosRoot(candidate) {
  return Boolean(
    candidate
    && fs.existsSync(path.join(candidate, "scripts", "aifios.py"))
    && fs.existsSync(path.join(candidate, "skills", "content-runtime", "scripts", "content_runtime.py"))
    && fs.existsSync(path.join(candidate, "ui", "package.json"))
  );
}

function resolveAifiosRoot() {
  const envRoot = process.env.AIFIOS_HOME ? path.resolve(expandRootHome(process.env.AIFIOS_HOME)) : "";
  const sourceRoot = path.resolve(__dirname, "..", "..");
  const resourceRoot = path.join(process.resourcesPath || "", "aifios");
  const allowExternalPackagedHome = process.env.AIFIOS_DESKTOP_ALLOW_EXTERNAL_HOME === "1";
  const candidates = app.isPackaged && !allowExternalPackagedHome
    ? [resourceRoot, envRoot, sourceRoot].filter(Boolean)
    : [envRoot, sourceRoot, resourceRoot].filter(Boolean);
  const match = candidates.find(isAifiosRoot);
  if (match) return match;
  return sourceRoot;
}

const REPO_ROOT = resolveAifiosRoot();
const CLI_PATH = path.join(REPO_ROOT, "scripts", "aifios.py");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const DESKTOP_SERVER_MODE = ["dev", "production"].includes(process.env.AIFIOS_DESKTOP_SERVER_MODE)
  ? process.env.AIFIOS_DESKTOP_SERVER_MODE
  : "production";

function pythonCandidate(binary, source) {
  return { binary, source };
}

function normalizeRuntimeBinary(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes(path.sep) || raw.startsWith("~")) {
    return path.resolve(expandRootHome(raw));
  }
  return raw;
}

function validateCommandCandidate(candidate, args, env = process.env) {
  if (!candidate.binary) return null;
  if (candidate.binary.includes(path.sep) && !fs.existsSync(candidate.binary)) return null;
  const result = spawnSync(candidate.binary, args, {
    encoding: "utf-8",
    env,
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return {
    ...candidate,
    version: output.split(/\r?\n/).find(Boolean) || "unknown",
    available: true,
  };
}

function validatePythonCandidate(candidate) {
  return validateCommandCandidate(candidate, ["--version"], pythonProcessEnvironment(process.env));
}

function resolvePythonRuntime() {
  // Universal desktop builds carry one relocatable Python runtime per macOS
  // architecture. A released app must not silently use the recipient's
  // Python: that would make a broken bundle appear to work on the builder's
  // machine while failing for a friend who installs it from the DMG.
  const bundledCandidate = pythonCandidate(
    path.join(REPO_ROOT, "runtime", "python", process.arch, "bin", "python3"),
    "bundled-runtime",
  );
  const candidates = app.isPackaged
    ? [bundledCandidate]
    : [
      pythonCandidate(normalizeRuntimeBinary(process.env.AIFIOS_PYTHON), "env"),
      bundledCandidate,
      pythonCandidate(path.join(REPO_ROOT, "runtime", "python", "bin", "python3"), "bundled-runtime"),
      pythonCandidate(path.join(REPO_ROOT, ".venv", "bin", "python3"), "project-venv"),
      pythonCandidate("/usr/bin/python3", "system-absolute"),
      pythonCandidate("/opt/homebrew/bin/python3", "homebrew-absolute"),
      pythonCandidate("/usr/local/bin/python3", "local-absolute"),
      pythonCandidate("python3", "path"),
    ];
  for (const candidate of candidates) {
    const valid = validatePythonCandidate(candidate);
    if (valid) return valid;
  }
  return {
    binary: "",
    source: "missing",
    version: "",
    available: false,
    error: app.isPackaged
      ? `打包运行时不完整：未找到与当前 macOS 架构匹配的内置 Python。请重新安装 ${PRODUCT_NAME}。`
      : "未找到可用的 Python 3。请安装 Python 3，或设置 AIFIOS_PYTHON=/path/to/python3 后重新启动。",
  };
}

function runtimeBinaryPathPrefix(...runtimes) {
  const dirs = [];
  const seen = new Set();
  for (const runtime of runtimes) {
    const binary = runtime?.binary || "";
    if (!runtime?.available || !binary.includes(path.sep)) continue;
    const dir = path.dirname(binary);
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

const PYTHON_RUNTIME = resolvePythonRuntime();
const PYTHON = PYTHON_RUNTIME.binary || "python3";
const MD2WECHAT_RUNTIME = resolveMd2WechatRuntime();

function nonNegativeIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

let mainWindow = null;
let serverProcess = null;
let currentPort = null;
let logStream = null;
let logWriteFailureReported = false;
let projectDir = null;
let projectDirSource = "unknown";
let internalLoadingUrl = null;
let isQuitting = false;
let serverRestartCount = 0;
let serverWatchdogFailureCount = 0;
let serverWatchdogRestartCount = 0;
let pendingServerRestartTimer = null;
let serverWatchdogTimer = null;
let serverWatchdogRecovering = false;
let serverWatchdogProbeRunning = false;
let weeklyReviewReminderTimer = null;
let weeklyReviewReminderChecking = false;
let tikomniWeeklyMarketTimer = null;
let tikomniWeeklyMarketChecking = false;
let benchmarkAdvisorReminderTimer = null;
let benchmarkAdvisorReminderChecking = false;
let publicationBridge = null;
let credentialVault = null;
let desktopMutationQueue = Promise.resolve();
let serverLifecycle = null;
let desktopDeviceIdentity = null;
let hostedGatewayProxy = null;
let desktopLicenseMode = "local-self-config";
let lastServerExit = null;
const SERVICE_RESTART_MAX = nonNegativeIntEnv("AIFIOS_DESKTOP_SERVICE_RESTART_MAX", 3);
const SERVICE_RESTART_DELAY_MS = nonNegativeIntEnv("AIFIOS_DESKTOP_SERVICE_RESTART_DELAY_MS", 1500);
const SERVICE_WATCHDOG_INTERVAL_MS = nonNegativeIntEnv("AIFIOS_DESKTOP_SERVICE_WATCHDOG_INTERVAL_MS", 15000);
const SERVICE_WATCHDOG_TIMEOUT_MS = nonNegativeIntEnv("AIFIOS_DESKTOP_SERVICE_WATCHDOG_TIMEOUT_MS", 5000);
const SERVICE_WATCHDOG_FAILURES = nonNegativeIntEnv("AIFIOS_DESKTOP_SERVICE_WATCHDOG_FAILURES", 3);
const SERVICE_WATCHDOG_ENABLED = process.env.AIFIOS_DESKTOP_SERVICE_WATCHDOG !== "0";
const STARTUP_READINESS_TIMEOUT_MS = Math.max(1000, nonNegativeIntEnv("AIFIOS_DESKTOP_STARTUP_READINESS_TIMEOUT_MS", 5000));
const WEEKLY_REVIEW_REMINDER_INTERVAL_MS = nonNegativeIntEnv("AIFIOS_WEEKLY_REVIEW_REMINDER_INTERVAL_MS", 15 * 60 * 1000);
const TIKOMNI_WEEKLY_MARKET_INTERVAL_MS = nonNegativeIntEnv("AIFIOS_TIKOMNI_WEEKLY_MARKET_INTERVAL_MS", 6 * 60 * 60 * 1000);
const BENCHMARK_ADVISOR_REMINDER_INTERVAL_MS = nonNegativeIntEnv("AIFIOS_BENCHMARK_ADVISOR_REMINDER_INTERVAL_MS", 15 * 60 * 1000);
const SINGLE_INSTANCE_ENABLED = process.env.AIFIOS_DESKTOP_ALLOW_MULTI_INSTANCE !== "1";
const HAS_SINGLE_INSTANCE_LOCK = !SINGLE_INSTANCE_ENABLED || app.requestSingleInstanceLock();

function exitDuplicateInstance() {
  app.exit(0);
  process.exit(0);
}

if (!HAS_SINGLE_INSTANCE_LOCK) {
  exitDuplicateInstance();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function logPath() {
  const dir = path.join(app.getPath("userData"), "logs");
  ensureDir(dir);
  return path.join(dir, "desktop.log");
}

function desktopSettingsPath() {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

function desktopDeviceIdPath() {
  return path.join(app.getPath("userData"), "device-id.json");
}

function hostedBootstrapMarkerPresent() {
  const candidates = [
    path.join(process.resourcesPath || "", "aifios", "hosted-client.json"),
    path.join(REPO_ROOT, "hosted-client.json"),
  ];
  return candidates.some((target) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      return parsed?.schema === "aifios.hosted-client.v1" && parsed?.licenseMode === "device-bound";
    } catch {
      return false;
    }
  });
}

function readDesktopLicenseMode() {
  const markerPath = path.join(process.resourcesPath || "", "aifios-distribution.json");
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const mode = parseDistributionMode(marker, {
      packaged: app.isPackaged,
      hostedBootstrapPresent: hostedBootstrapMarkerPresent(),
    });
    if (mode) return mode;
  } catch {
    if (app.isPackaged) {
      throw new Error("桌面安装包缺少有效的分发标记，已拒绝以未授权模式启动。");
    }
  }

  // Legacy or developer builds do not have a distribution marker. A packaged
  // app never reaches this compatibility path, so deleting its marker cannot
  // turn a paid build into a local self-config build.
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "hosted-client.json"), "utf8"));
    return parsed?.schema === "aifios.hosted-client.v1" && parsed?.licenseMode === "device-bound"
      ? "device-bound"
      : "local-self-config";
  } catch {
    return "local-self-config";
  }
}

function readHostedGatewayBootstrap() {
  const candidates = [
    path.join(process.resourcesPath || "", "aifios", "hosted-client.json"),
    path.join(REPO_ROOT, "hosted-client.json"),
  ];
  for (const target of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      if (parsed?.schema !== "aifios.hosted-client.v1" || parsed?.licenseMode !== "device-bound") continue;
      const raw = String(parsed.gatewayUrl || "").trim();
      const origin = new URL(raw);
      if (origin.protocol !== "https:" || origin.username || origin.password
        || origin.pathname !== "/" || origin.search || origin.hash) continue;
      return origin.origin;
    } catch {
      // Try the next resource location; a paid package must fail closed below.
    }
  }
  throw new Error("托管授权包缺少有效的 HTTPS 网关地址。");
}

async function initializeHostedLicense() {
  if (desktopLicenseMode !== "device-bound") return;
  const gatewayOrigin = readHostedGatewayBootstrap();
  desktopDeviceIdentity = loadOrCreateDeviceKey({
    filePath: desktopDeviceIdPath(),
    safeStorage,
  });
  hostedGatewayProxy = await startHostedGatewayProxy({
    remoteOrigin: gatewayOrigin,
    identity: desktopDeviceIdentity,
  });
  appendLog(`Hosted device proof initialized: keyId=${desktopDeviceIdentity.keyId} proxy=${hostedGatewayProxy.url}`);
}

const PUBLICATION_RECEIPT_SCHEMA = "aifios.desktop-publication-receipt.v1";
// This lives only for the active desktop/service session. It lets the local
// service distinguish a real Electron bridge result from a renderer request.
const PUBLICATION_RECEIPT_SECRET = randomBytes(32).toString("base64url");
// The local loopback port is not a sufficient identity check: an occupied or
// raced port could otherwise satisfy a generic HTTP readiness probe. The
// child service proves it inherited this per-process secret before Electron
// loads it as a trusted renderer with IPC access.
const DESKTOP_SERVICE_AUTH_SECRET = randomBytes(32).toString("base64url");

function legacyPublicationCredentialStorePath() {
  return path.join(app.getPath("userData"), "publication-credentials.json");
}

function credentialVaultPath() {
  return path.join(app.getPath("userData"), "credential-vault.json");
}

function projectBackupRoot() {
  return path.join(app.getPath("userData"), "project-backups");
}

function llmConfigPath() {
  return path.join(projectDir, "config", "llm-config.json");
}

function ensureCredentialVault() {
  if (!credentialVault) throw new Error("Desktop credential vault is not initialized.");
  return credentialVault;
}

function initializeCredentialVault() {
  credentialVault = createCredentialVault({
    filePath: credentialVaultPath(),
    safeStorage,
  });
  const publicationMigration = migrateLegacyPublicationCredentials({
    vault: credentialVault,
    legacyFilePath: legacyPublicationCredentialStorePath(),
  });
  const plaintextMigration = migrateLegacyPlaintextCredentials({
    vault: credentialVault,
    llmConfigPath: llmConfigPath(),
    tikomniEnvPath: desktopTikomniEnvFile(),
    processEnvironment: process.env,
  });
  appendLog(`Credential vault initialized: publicationMigrated=${publicationMigration.migrated.length} llmMigrated=${plaintextMigration.llm} tikomniMigrated=${plaintextMigration.tikomni}`);
}

function initializeProjectSchema(targetProjectDir = projectDir) {
  const result = ensureProjectSchema({
    projectDir: targetProjectDir,
    appVersion: app.getVersion(),
    backupRoot: projectBackupRoot(),
  });
  appendLog(`Project schema ready: schema=${result.schema} migrated=${result.migrated} automaticBackup=${Boolean(result.backup)}`);
}

function queueDesktopMutation(task) {
  const operation = desktopMutationQueue.then(task, task);
  desktopMutationQueue = operation.catch(() => {});
  return operation;
}

function ensureServerLifecycle() {
  if (!serverLifecycle) {
    serverLifecycle = createServiceLifecycleCoordinator(queueDesktopMutation);
  }
  return serverLifecycle;
}

function queueServerLifecycle(task) {
  return ensureServerLifecycle().run(task);
}

function isTrustedDesktopRenderer(event) {
  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  return isLocalAppUrl(url);
}

function redactDesktopMessage(value, fallback = "Desktop operation failed.") {
  const markers = [projectDir, app.getPath("userData"), REPO_ROOT, os.homedir()]
    .filter(Boolean);
  return redactDesktopText(value, { fallback, markers });
}

async function rendererSafeOperation(label, task) {
  try {
    return await task();
  } catch (error) {
    const failure = createDesktopUserFacingFailure(error, {
      operation: label,
      markers: [projectDir, app.getPath("userData"), REPO_ROOT, os.homedir()].filter(Boolean),
    });
    appendLog(`${label} failed [${failure.payload.debugId}]: ${failure.logDetail}`);
    throw new Error(encodeDesktopUserFacingError(failure.payload));
  }
}

function requireTrustedDesktopRenderer(event, scope) {
  if (isTrustedDesktopRenderer(event)) return;
  const error = new Error(`Unauthorized ${scope} request.`);
  error.code = "desktop_access_denied";
  throw error;
}

function ensurePublicationBridge() {
  if (publicationBridge) return publicationBridge;
  publicationBridge = createPublicationBridge({
    BrowserWindow,
    projectDir: () => projectDir,
    getCredential: (id) => ensureCredentialVault().read(id),
    publicationAssetSnapshotOptions: {
      tempRoot: publicationAssetSnapshotRoot(),
    },
  });
  return publicationBridge;
}

function publicationAssetSnapshotRoot() {
  return path.join(app.getPath("userData"), "publication-asset-snapshots");
}

function signedPublicationReceipt(fillResult) {
  const payload = {
    schema: PUBLICATION_RECEIPT_SCHEMA,
    receipt_id: randomUUID(),
    issued_at: new Date().toISOString(),
    queue_path: fillResult.queuePath,
    run_id: fillResult.runId,
    job_id: fillResult.job.jobId,
    payload_hash: fillResult.job.payloadHash,
    adapter: fillResult.adapter,
    result: fillResult.result,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    schema: PUBLICATION_RECEIPT_SCHEMA,
    payload: encoded,
    signature: createHmac("sha256", PUBLICATION_RECEIPT_SECRET).update(encoded).digest("hex"),
  };
}

function publicationCredentialStatus() {
  const publicationIds = new Set(PUBLICATION_CREDENTIAL_IDS);
  return ensureCredentialVault().status().filter((item) => publicationIds.has(item.id));
}

async function saveDesktopCredential(id, value) {
  const vault = ensureCredentialVault();
  const serviceCredential = id === "llm" || id === "tikomni" || String(id || "").startsWith("image_");
  if (!serviceCredential) return vault.save(id, value);
  return updateCredentialWithCheckedRestart({
    readCurrent: () => vault.read(id),
    apply: () => vault.save(id, value),
    restore: (previous) => previous ? vault.save(id, previous) : vault.delete(id),
    restart: () => restartServer(id === "llm"
      ? "模型密钥已保存，正在重新打开工作区。"
      : id === "tikomni"
        ? "平台数据密钥已保存，正在重新打开工作区。"
        : "生图服务密钥已保存，正在重新打开工作区。", { requireReady: true, deferNavigation: true }),
  });
}

async function deleteDesktopCredential(id) {
  const vault = ensureCredentialVault();
  const serviceCredential = id === "llm" || id === "tikomni" || String(id || "").startsWith("image_");
  if (!serviceCredential) return vault.delete(id);
  return updateCredentialWithCheckedRestart({
    readCurrent: () => vault.read(id),
    apply: () => vault.delete(id),
    restore: (previous) => previous ? vault.save(id, previous) : vault.delete(id),
    restart: () => restartServer(id === "llm"
      ? "模型密钥已删除，正在重新打开工作区。"
      : id === "tikomni"
        ? "平台数据密钥已删除，正在重新打开工作区。"
        : "生图服务密钥已删除，正在重新打开工作区。", { requireReady: true, deferNavigation: true }),
  });
}

function defaultBackupFileName() {
  const projectName = (path.basename(projectDir || "project") || "project").replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${projectName}-${stamp}.aifios-backup`;
}

async function exportProjectBackupFromDesktop() {
  const result = await dialog.showSaveDialog(mainWindow || undefined, {
    title: `导出 ${PRODUCT_NAME} 项目备份`,
    defaultPath: path.join(app.getPath("documents"), defaultBackupFileName()),
    buttonLabel: "导出备份",
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const stoppedPort = currentPort;
  const { operationResult: backup, startResult } = await runWithQuiescedService({
    stop: stopServer,
    waitStopped: () => stoppedPort ? waitForPortClosed(stoppedPort, 10000) : Promise.resolve(true),
    operation: () => exportProjectBackup({
      projectDir,
      backupPath: result.filePath,
      appVersion: app.getVersion(),
    }),
    start: () => startServer({ deferNavigation: true }),
  });
  setTimeout(() => loadDesktopEntry(startResult.url).catch(showStartupError), 75);
  appendLog(`Project backup exported: file=${backup.fileName} files=${backup.fileCount} bytes=${backup.totalBytes} manifest=${backup.manifestSha256}`);
  return { canceled: false, ...backup };
}

async function importProjectBackupFromDesktop() {
  const selected = await dialog.showOpenDialog(mainWindow || undefined, {
    title: `选择 ${PRODUCT_NAME} 项目备份`,
    properties: ["openDirectory"],
    buttonLabel: "验证备份",
  });
  if (selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
  const backupPath = selected.filePaths[0];
  const { manifest } = parseAndVerifyManifest(backupPath);
  const restoredProjectsRoot = path.join(app.getPath("documents"), "Echo Founder Projects");
  ensureDir(restoredProjectsRoot);
  const destinationSelection = await dialog.showSaveDialog(mainWindow || undefined, {
    title: "选择恢复后的新项目目录",
    defaultPath: defaultRestoredProjectPath({
      parentDir: restoredProjectsRoot,
      sourceProjectName: manifest.sourceProjectName,
    }),
    buttonLabel: "恢复到新项目",
  });
  if (destinationSelection.canceled || !destinationSelection.filePath) return { canceled: true };

  const destination = normalizeProjectDir(destinationSelection.filePath);
  if (!destination) throw new Error("Restore destination is invalid.");
  const previousProjectDir = projectDir;
  const restored = await restoreAndActivateProject({
    currentProjectDir: previousProjectDir,
    nextProjectDir: destination,
    restore: () => importProjectBackup({
      backupPath,
      destinationPath: destination,
      appVersion: app.getVersion(),
    }),
    selectProject: (selectedProjectDir) => {
      saveProjectDirSelection(selectedProjectDir);
      projectDir = selectedProjectDir;
    },
    restart: () => restartServer("备份已确认并恢复，正在打开新项目。", { requireReady: true, deferNavigation: true }),
    restartAfterRollback: () => {
      appendLog("Restored project did not become healthy; reverted the active project selection.");
      return restartServer("恢复后的项目无法打开，正在返回原项目。", { requireReady: true, deferNavigation: true });
    },
  });
  appendLog(`Project backup restored and selected: files=${restored.fileCount} bytes=${restored.totalBytes} manifest=${restored.manifestSha256}`);
  return {
    canceled: false,
    schema: restored.schema,
    projectSchema: restored.projectSchema,
    fileCount: restored.fileCount,
    totalBytes: restored.totalBytes,
    sourceProjectName: restored.sourceProjectName,
    manifestSha256: restored.manifestSha256,
    switched: true,
  };
}

function registerDesktopIpc() {
  ipcMain.handle("aifios:credentials:status", (event) => {
    return rendererSafeOperation("Credential status", () => {
      requireTrustedDesktopRenderer(event, "credential");
      return ensureCredentialVault().status();
    });
  });
  ipcMain.handle("aifios:credentials:save", (event, payload) => {
    return queueDesktopMutation(() => rendererSafeOperation("Credential save", () => {
      requireTrustedDesktopRenderer(event, "credential");
      return saveDesktopCredential(payload?.id, payload?.value);
    }));
  });
  ipcMain.handle("aifios:credentials:delete", (event, id) => {
    return queueDesktopMutation(() => rendererSafeOperation("Credential delete", () => {
      requireTrustedDesktopRenderer(event, "credential");
      return deleteDesktopCredential(id);
    }));
  });
  ipcMain.handle("aifios:publication-credentials:status", (event) => {
    return rendererSafeOperation("Publication credential status", () => {
      requireTrustedDesktopRenderer(event, "publication credential");
      return publicationCredentialStatus();
    });
  });
  ipcMain.handle("aifios:publication-credentials:save", (event, payload) => {
    return queueDesktopMutation(() => rendererSafeOperation("Publication credential save", () => {
      requireTrustedDesktopRenderer(event, "publication credential");
      return saveDesktopCredential(payload?.id, payload?.value);
    }));
  });
  ipcMain.handle("aifios:publication-credentials:delete", (event, id) => {
    return queueDesktopMutation(() => rendererSafeOperation("Publication credential delete", () => {
      requireTrustedDesktopRenderer(event, "publication credential");
      return deleteDesktopCredential(id);
    }));
  });
  ipcMain.handle("aifios:publication:status", (event) => {
    return rendererSafeOperation("Publication bridge status", () => {
      requireTrustedDesktopRenderer(event, "publication bridge");
      return ensurePublicationBridge().status();
    });
  });
  ipcMain.handle("aifios:publication:open", async (event, platform) => {
    return rendererSafeOperation("Publication editor open", () => {
      requireTrustedDesktopRenderer(event, "publication bridge");
      return ensurePublicationBridge().openEditor(String(platform || ""));
    });
  });
  ipcMain.handle("aifios:publication:fill", async (event, request) => {
    return rendererSafeOperation("Publication draft fill", async () => {
      requireTrustedDesktopRenderer(event, "publication bridge");
      const bridge = ensurePublicationBridge();
      try {
        const filled = await bridge.fill(request);
        appendLog(`Local publication draft fill: job=${filled.job.jobId} adapter=${filled.adapter} status=${filled.result.status}`);
        return { receipt: signedPublicationReceipt(filled) };
      } catch (error) {
        // Invalid renderer input cannot produce a signed receipt. Valid bridge
        // failures are converted inside the bridge and persisted as such.
        const normalized = normalizeBridgeError(error);
        appendLog(`Local publication bridge rejected request: code=${normalized.code || "bridge_exception"}`);
        if (error && typeof error === "object" && !error.code) error.code = normalized.code || "bridge_exception";
        throw error;
      }
    });
  });
  ipcMain.handle("aifios:project:export-backup", (event) => {
    return queueDesktopMutation(() => rendererSafeOperation("Project backup export", () => {
      requireTrustedDesktopRenderer(event, "project backup");
      return exportProjectBackupFromDesktop();
    }));
  });
  ipcMain.handle("aifios:project:import-backup", (event) => {
    return queueDesktopMutation(() => rendererSafeOperation("Project backup restore", () => {
      requireTrustedDesktopRenderer(event, "project restore");
      return importProjectBackupFromDesktop();
    }));
  });
}

function readDesktopSettings() {
  try {
    return JSON.parse(fs.readFileSync(desktopSettingsPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeDesktopSettings(settings) {
  const target = desktopSettingsPath();
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeProjectDir(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.resolve(expandHome(raw));
}

function defaultProjectDir() {
  return path.join(os.homedir(), "Echo Founder");
}

function legacyDefaultProjectDir() {
  return path.join(os.homedir(), "ai-content-system");
}

function desktopTikomniEnvFile() {
  return path.join(app.getPath("userData"), "credentials", "tikomni.env");
}

function bundledTikomniSkillDir() {
  const candidate = path.join(SKILLS_DIR, "social-media-crawl");
  return fs.existsSync(path.join(candidate, "scripts", "core", "call_tikomni_api.py")) ? candidate : "";
}

const PLAYWRIGHT_RUNTIME_SCHEMA = "aifios.playwright-runtime.v1";

function isExecutableRegularFile(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function safeRuntimePath(root, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")) {
    throw new Error(`${label} is not a safe relative path.`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`${label} escapes the bundled runtime.`);
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...normalized.split("/"));
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`${label} escapes the bundled runtime.`);
  }
  return resolved;
}

function directorySha256(root) {
  return runtimeTreeSha256(root);
}

function packagedPlaywrightRuntime() {
  const runtimeRoot = path.join(REPO_ROOT, "runtime", "playwright");
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read bundled runtime manifest: ${error.message}`);
  }
  if (
    !manifest
    || manifest.schema !== PLAYWRIGHT_RUNTIME_SCHEMA
    || manifest.tree_hash_schema !== RUNTIME_TREE_HASH_SCHEMA
    || !manifest.architectures
    || typeof manifest.architectures !== "object"
  ) {
    throw new Error("bundled runtime manifest schema is invalid.");
  }
  const revision = String(manifest.headless_shell_revision || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(revision)) {
    throw new Error("bundled runtime manifest has an invalid Chromium revision.");
  }
  const architecture = process.arch;
  const entry = manifest.architectures[architecture];
  if (!entry || typeof entry !== "object") {
    throw new Error(`bundled runtime does not contain a Chromium build for ${architecture}.`);
  }
  if (String(entry.source_revision || "") !== revision) {
    throw new Error(`bundled runtime revision does not match its ${architecture} entry.`);
  }
  const expectedHash = String(entry.tree_sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`bundled runtime is missing a valid ${architecture} integrity hash.`);
  }
  const relativeExecutable = String(entry.executable || "");
  const architecturePrefix = `${architecture}/`;
  if (!relativeExecutable.startsWith(architecturePrefix)) {
    throw new Error(`bundled runtime executable does not belong to ${architecture}.`);
  }
  const executableWithinArchitecture = relativeExecutable.slice(architecturePrefix.length);
  const sourceRuntimeRoot = safeRuntimePath(runtimeRoot, architecture, "runtime architecture path");
  const sourceExecutable = safeRuntimePath(runtimeRoot, relativeExecutable, "runtime executable path");
  const expectedSourceExecutable = safeRuntimePath(sourceRuntimeRoot, executableWithinArchitecture, "runtime executable path");
  if (sourceExecutable !== expectedSourceExecutable || !isExecutableRegularFile(sourceExecutable)) {
    throw new Error(`bundled Chromium executable is unavailable for ${architecture}.`);
  }
  const actualHash = directorySha256(sourceRuntimeRoot);
  if (actualHash !== expectedHash) {
    throw new Error(`bundled Chromium integrity check failed for ${architecture}.`);
  }
  return {
    architecture,
    revision,
    expectedHash,
    sourceRuntimeRoot,
    executableWithinArchitecture,
  };
}

function verifiedMaterializedPlaywrightExecutable(runtime, destinationRoot) {
  if (!fs.existsSync(destinationRoot)) return "";
  try {
    const executable = safeRuntimePath(destinationRoot, runtime.executableWithinArchitecture, "materialized runtime executable path");
    if (!isExecutableRegularFile(executable)) return "";
    return directorySha256(destinationRoot) === runtime.expectedHash ? executable : "";
  } catch {
    return "";
  }
}

function materializePackagedPlaywrightChromium() {
  try {
    const runtime = packagedPlaywrightRuntime();
    const revisionRoot = path.join(app.getPath("userData"), "runtime", "playwright", runtime.revision);
    const destinationRoot = path.join(revisionRoot, runtime.architecture);
    const existing = verifiedMaterializedPlaywrightExecutable(runtime, destinationRoot);
    if (existing) return existing;

    ensureDir(revisionRoot);
    fs.rmSync(destinationRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    const temporaryRoot = path.join(
      revisionRoot,
      `.${runtime.architecture}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      fs.cpSync(runtime.sourceRuntimeRoot, temporaryRoot, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
      if (!verifiedMaterializedPlaywrightExecutable(runtime, temporaryRoot)) {
        throw new Error(`copied Chromium integrity check failed for ${runtime.architecture}.`);
      }
      fs.renameSync(temporaryRoot, destinationRoot);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }

    const executable = verifiedMaterializedPlaywrightExecutable(runtime, destinationRoot);
    if (!executable) {
      throw new Error(`materialized Chromium verification failed for ${runtime.architecture}.`);
    }
    return executable;
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    throw new Error(`内置视觉渲染运行时校验或部署失败：${detail} 请重新安装完整的 ${PRODUCT_NAME} 应用包。`);
  }
}

function bundledPlaywrightChromiumPath() {
  const bundled = path.join(REPO_ROOT, "runtime", "playwright", process.arch, "chrome-headless-shell");
  if (fs.existsSync(bundled)) return bundled;

  // Dev/source desktop launches do not ship a bundled Chromium under
  // runtime/playwright. Fall back to the Playwright browser cache so the
  // visual-candidates screenshot step can still run.
  const cacheRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (!fs.existsSync(cacheRoot)) return "";
  const archSuffix = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  const chromiumDirs = fs.readdirSync(cacheRoot).filter((entry) => entry.startsWith("chromium_headless_shell-"));
  for (const dir of chromiumDirs) {
    const candidate = path.join(cacheRoot, dir, `chrome-headless-shell-${archSuffix}`, "chrome-headless-shell");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function samePath(left, right) {
  return path.resolve(left || "") === path.resolve(right || "");
}

function resolveInitialProjectDir() {
  const settings = readDesktopSettings();
  const savedProject = normalizeProjectDir(settings.projectDir);
  const envProject = normalizeProjectDir(process.env.AIFIOS_PROJECT || "");
  const defaultProject = defaultProjectDir();

  if (envProject && !samePath(envProject, defaultProject)) {
    projectDirSource = "env";
    return envProject;
  }
  if (savedProject) {
    projectDirSource = "saved";
    return savedProject;
  }
  if (envProject) {
    projectDirSource = "env-default";
    return envProject;
  }
  const legacyProject = legacyDefaultProjectDir();
  if (!fs.existsSync(defaultProject) && fs.existsSync(legacyProject)) {
    projectDirSource = "legacy-default";
    return legacyProject;
  }
  projectDirSource = "default";
  return defaultProject;
}

function saveProjectDirSelection(nextProjectDir) {
  const settings = readDesktopSettings();
  writeDesktopSettings({
    ...settings,
    projectDir: nextProjectDir,
    updatedAt: new Date().toISOString(),
  });
  projectDirSource = "saved";
}

function appendLog(line) {
  const entry = `[${new Date().toISOString()}] ${redactDesktopMessage(line, "Desktop event")}\n`;
  try {
    if (!logStream) {
      logStream = openSecureDesktopLogStream(logPath());
      logStream.on("error", (error) => {
        logStream = null;
        if (logWriteFailureReported) return;
        logWriteFailureReported = true;
        process.stderr.write(`[${PRODUCT_NAME}] Desktop logging disabled after a secure write failure: ${redactDesktopMessage(error, "secure log write failed")}\n`);
      });
    }
    logStream.write(entry);
  } catch (error) {
    logStream = null;
    if (logWriteFailureReported) return;
    logWriteFailureReported = true;
    process.stderr.write(`[${PRODUCT_NAME}] Desktop logging disabled: ${redactDesktopMessage(error, "secure log unavailable")}\n`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port, timeout: 500 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortClosed(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portIsOpen(port))) return true;
    await sleep(250);
  }
  return !(await portIsOpen(port));
}

function desktopServiceChallenge() {
  return randomBytes(32).toString("base64url");
}

function desktopServiceProof(challenge) {
  return createHmac("sha256", DESKTOP_SERVICE_AUTH_SECRET).update(challenge).digest("hex");
}

function hasValidDesktopServiceProof(response, challenge) {
  const proof = response.headers.get("x-aifios-desktop-proof") || "";
  const expected = desktopServiceProof(challenge);
  if (proof.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(proof, "utf8"), Buffer.from(expected, "utf8"));
}

function waitForHttp(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const challenge = desktopServiceChallenge();
      fetch(`${url}/api/desktop/health`, {
        method: "GET",
        headers: { "x-aifios-desktop-challenge": challenge },
      })
        .then((response) => {
          if (response.ok && hasValidDesktopServiceProof(response, challenge)) {
            resolve();
            return;
          }
          retry();
        })
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`${PRODUCT_NAME} service did not become ready: ${url}`));
        return;
      }
      setTimeout(attempt, 1000);
    };
    attempt();
  });
}

async function readLocalJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STARTUP_READINESS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Cache-Control": "no-store" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadDesktopEntry(url) {
  const [configPayload, tikOmniPayload, hostedStatusPayload] = await Promise.all([
    readLocalJson(`${url}/api/config`),
    readLocalJson(`${url}/api/settings/tikomni`),
    readLocalJson(`${url}/api/config/hosted/status`),
  ]);
  const target = desktopStartupRoute(configPayload, tikOmniPayload, hostedStatusPayload);
  appendLog(`Desktop startup route: ${target.path} blockers=${target.blockers.join(",") || "none"}`);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(`${url}${target.path}`);
}

async function probeServerHealth(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const challenge = desktopServiceChallenge();
  try {
    const response = await fetch(`${url}/api/desktop/health`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Cache-Control": "no-store",
        "x-aifios-desktop-challenge": challenge,
      },
    });
    return response.ok && hasValidDesktopServiceProof(response, challenge);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function loadingHtml(message, title = `${PRODUCT_NAME} 正在启动`) {
  const safeMessage = escapeHtml(message);
  const safeTitle = escapeHtml(title);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root { color-scheme: dark; }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background:
              radial-gradient(circle at 50% 18%, rgba(84, 244, 255, 0.12), transparent 30%),
              radial-gradient(circle at 72% 72%, rgba(255, 98, 193, 0.08), transparent 28%),
              #070a13;
            color: #f8fafc;
          }
          body::before {
            content: "";
            position: fixed;
            inset: 0;
            pointer-events: none;
            background-image:
              linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
            background-size: 64px 64px;
            mask-image: linear-gradient(to bottom, black, transparent 82%);
          }
          main {
            position: relative;
            width: min(460px, calc(100vw - 48px));
            padding: 36px;
            text-align: center;
          }
          .mark {
            width: 72px;
            height: 72px;
            margin: 0 auto 24px;
            filter: drop-shadow(0 16px 34px rgba(84, 244, 255, 0.14));
          }
          .eyebrow {
            margin: 0 0 12px;
            color: #54f4ff;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.28em;
          }
          h1 {
            margin: 0 0 12px;
            font-size: 24px;
            line-height: 1.35;
            letter-spacing: -0.02em;
          }
          p {
            margin: 0 auto;
            max-width: 380px;
            color: #99a3b5;
            font-size: 14px;
            line-height: 1.75;
            white-space: pre-line;
          }
          .progress {
            position: relative;
            width: 160px;
            height: 2px;
            margin: 28px auto 0;
            overflow: hidden;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.1);
          }
          .progress::after {
            content: "";
            position: absolute;
            inset: 0;
            width: 52%;
            border-radius: inherit;
            background: linear-gradient(90deg, #54f4ff, #ac8cff, #ff62c1);
            animation: progress 1.6s ease-in-out infinite;
          }
          @keyframes progress {
            from { transform: translateX(-120%); }
            to { transform: translateX(220%); }
          }
          @media (prefers-reduced-motion: reduce) {
            .progress::after { animation: none; transform: translateX(46%); }
          }
        </style>
      </head>
      <body>
        <main>
          <svg class="mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="60" height="60" rx="16" fill="#080C1B" />
            <path d="M46 16H26c-5.2 0-8 3.2-8 8v8" stroke="#54F4FF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M18 32h22" stroke="#AC8CFF" stroke-width="6" stroke-linecap="round" />
            <path d="M18 32v8c0 4.8 2.8 8 8 8h20" stroke="#FF62C1" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
            <circle cx="46" cy="16" r="2" fill="#E7FF7A" />
            <circle cx="40" cy="32" r="2" fill="#E8DBFF" />
            <circle cx="46" cy="48" r="2" fill="#FFD0E9" />
          </svg>
          <div class="eyebrow">ECHO FOUNDER</div>
          <h1>${safeTitle}</h1>
          <p>${safeMessage}</p>
          <div class="progress" role="progressbar" aria-label="正在准备应用"></div>
        </main>
      </body>
    </html>
  `)}`;
}

function loadInternalHtml(message, title) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
  internalLoadingUrl = loadingHtml(message, title);
  return mainWindow.loadURL(internalLoadingUrl);
}

function isLocalAppUrl(rawUrl) {
  if (!currentPort) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" && parsed.hostname === HOST && parsed.port === String(currentPort);
  } catch {
    return false;
  }
}

function isAllowedNavigation(rawUrl) {
  return rawUrl === internalLoadingUrl || isLocalAppUrl(rawUrl);
}

function openSafeExternal(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) {
      appendLog(`Blocked unsafe external navigation: ${rawUrl}`);
      return;
    }
    shell.openExternal(rawUrl);
  } catch {
    appendLog(`Blocked malformed external navigation: ${rawUrl}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    title: PRODUCT_NAME,
    backgroundColor: "#f7f5ef",
    // On macOS, deliver the click that activates an inactive window to the
    // underlying control as well. Otherwise the first click only focuses the
    // app and buttons such as "去工作台" appear unresponsive.
    acceptFirstMouse: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  loadInternalHtml("正在准备工作区，请稍候。首次打开可能需要一点时间。");

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalAppUrl(url)) {
      mainWindow.loadURL(url);
    } else {
      openSafeExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      openSafeExternal(url);
    }
  });
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function childProcessTreePids(rootPid) {
  if (process.platform === "win32" || !rootPid) return [];
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return [];

  const children = new Map();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const list = children.get(ppid) || [];
    list.push(pid);
    children.set(ppid, list);
  }

  const descendants = [];
  const stack = [rootPid];
  while (stack.length) {
    const parent = stack.pop();
    for (const pid of children.get(parent) || []) {
      descendants.push(pid);
      stack.push(pid);
    }
  }
  return descendants;
}

function signalPosixPidOrGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Some descendants are not process-group leaders; signal the pid directly.
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    appendLog(`Failed to signal Echo Founder service process pid=${pid}: ${error.message || error}`);
  }
}

function signalServerProcess(child, signal) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    child.kill(signal);
    return;
  }

  const pids = [...childProcessTreePids(child.pid).reverse(), child.pid];
  const seen = new Set();
  for (const pid of pids) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    signalPosixPidOrGroup(pid, signal);
  }
}

function clearServerWatchdog() {
  if (serverWatchdogTimer) {
    clearInterval(serverWatchdogTimer);
    serverWatchdogTimer = null;
  }
  serverWatchdogFailureCount = 0;
  serverWatchdogProbeRunning = false;
}

function clearWeeklyReviewReminder() {
  if (weeklyReviewReminderTimer) {
    clearInterval(weeklyReviewReminderTimer);
    weeklyReviewReminderTimer = null;
  }
  weeklyReviewReminderChecking = false;
}

function clearTikOmniWeeklyMarket() {
  if (tikomniWeeklyMarketTimer) {
    clearInterval(tikomniWeeklyMarketTimer);
    tikomniWeeklyMarketTimer = null;
  }
  tikomniWeeklyMarketChecking = false;
}

function clearBenchmarkAdvisorReminder() {
  if (benchmarkAdvisorReminderTimer) {
    clearInterval(benchmarkAdvisorReminderTimer);
    benchmarkAdvisorReminderTimer = null;
  }
  benchmarkAdvisorReminderChecking = false;
}

async function checkWeeklyReviewReminder(url) {
  if (isQuitting || weeklyReviewReminderChecking) return;
  weeklyReviewReminderChecking = true;
  try {
    const response = await fetch(`${url}/api/weekly-review`, { method: "GET" });
    if (!response.ok) {
      appendLog(`Weekly review reminder check failed: status=${response.status}`);
      return;
    }
    const payload = await response.json();
    const reminder = payload?.reminder;
    if (!reminder?.should_notify || !reminder?.record_path) return;
    if (!Notification.isSupported()) {
      appendLog("Weekly review reminder is pending but desktop notifications are unavailable.");
      return;
    }
    const notification = new Notification({
      title: `${PRODUCT_NAME} 本周复盘待完成`,
      body: "本周发布数据还没补齐，点此继续复盘。",
      silent: false,
    });
    notification.on("click", () => {
      focusMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(`${url}/weekly-review`);
      }
    });
    notification.show();
    const acknowledged = await fetch(`${url}/api/weekly-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "acknowledge_reminder", recordPath: reminder.record_path }),
    });
    if (!acknowledged.ok) {
      appendLog(`Weekly review reminder acknowledgement failed: status=${acknowledged.status}`);
      return;
    }
    appendLog(`Weekly review reminder delivered: ${reminder.record_path}`);
  } catch (error) {
    appendLog(`Weekly review reminder check failed: ${error.message || error}`);
  } finally {
    weeklyReviewReminderChecking = false;
  }
}

function startWeeklyReviewReminder(url) {
  clearWeeklyReviewReminder();
  if (WEEKLY_REVIEW_REMINDER_INTERVAL_MS <= 0) {
    appendLog("Weekly review reminder disabled.");
    return;
  }
  appendLog(`Weekly review reminder started: intervalMs=${WEEKLY_REVIEW_REMINDER_INTERVAL_MS}`);
  checkWeeklyReviewReminder(url);
  weeklyReviewReminderTimer = setInterval(() => {
    checkWeeklyReviewReminder(url);
  }, WEEKLY_REVIEW_REMINDER_INTERVAL_MS);
}

async function checkTikOmniWeeklyMarket(url) {
  if (isQuitting || tikomniWeeklyMarketChecking) return;
  tikomniWeeklyMarketChecking = true;
  try {
    const response = await fetch(`${url}/api/research/weekly-market`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      appendLog(`TikOmni weekly market collection failed: status=${response.status} error=${payload?.error || "unknown"}`);
      return;
    }
    if (payload?.status === "ready") {
      appendLog(`TikOmni weekly market snapshot collected: ${payload?.snapshot_path || "unknown"}`);
    } else if (payload?.status === "blocked") {
      // This optional weekly learning input remains visible but cannot change
      // the strict per-topic real-time three-platform gate.
      appendLog("TikOmni weekly market collection blocked; topic-time gate remains strict.");
    }
  } catch (error) {
    appendLog(`TikOmni weekly market collection failed: ${error.message || error}`);
  } finally {
    tikomniWeeklyMarketChecking = false;
  }
}

function startTikOmniWeeklyMarket(url) {
  clearTikOmniWeeklyMarket();
  if (TIKOMNI_WEEKLY_MARKET_INTERVAL_MS <= 0) {
    appendLog("TikOmni weekly market collection disabled.");
    return;
  }
  appendLog(`TikOmni weekly market collection started: intervalMs=${TIKOMNI_WEEKLY_MARKET_INTERVAL_MS}`);
  checkTikOmniWeeklyMarket(url);
  tikomniWeeklyMarketTimer = setInterval(() => {
    checkTikOmniWeeklyMarket(url);
  }, TIKOMNI_WEEKLY_MARKET_INTERVAL_MS);
}

async function checkBenchmarkAdvisorReminder(url) {
  if (isQuitting || benchmarkAdvisorReminderChecking) return;
  benchmarkAdvisorReminderChecking = true;
  try {
    const projectsResponse = await fetch(`${url}/api/benchmark-advisor?listProjects=1`);
    if (!projectsResponse.ok) {
      appendLog(`Benchmark advisor project list failed: status=${projectsResponse.status}`);
      return;
    }
    const projectsPayload = await projectsResponse.json();
    const projectIds = Array.isArray(projectsPayload?.projectIds)
      ? projectsPayload.projectIds.filter((item) => typeof item === "string")
      : [];
    for (const projectId of projectIds) {
      // Refresh only the due, project-isolated archive. This does not freeze
      // or relax the mandatory topic-time TikOmni gate.
      const response = await fetch(`${url}/api/benchmark-advisor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh_if_due", projectId }),
      });
      if (!response.ok) {
        appendLog(`Benchmark advisor reminder check failed: project=${projectId} status=${response.status}`);
        continue;
      }
      const payload = await response.json();
      const reminder = payload?.reminder;
      if (!reminder?.shouldNotify) continue;
      if (!Notification.isSupported()) {
        appendLog(`Benchmark advisor reminder is pending but desktop notifications are unavailable: project=${projectId}`);
        continue;
      }
      const notification = new Notification({
        title: `${PRODUCT_NAME} 本周同行参考有更新`,
        body: "本周新增了可参考的同行做法，点此查看。",
        silent: false,
      });
      notification.on("click", () => {
        focusMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(`${url}/benchmark-advisor?projectId=${encodeURIComponent(projectId)}`);
        }
      });
      notification.show();
      const acknowledged = await fetch(`${url}/api/benchmark-advisor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "acknowledge_desktop_notification", projectId }),
      });
      if (!acknowledged.ok) {
        appendLog(`Benchmark advisor reminder acknowledgement failed: project=${projectId} status=${acknowledged.status}`);
        continue;
      }
      appendLog(`Benchmark advisor reminder delivered: project=${projectId}`);
    }
  } catch (error) {
    appendLog(`Benchmark advisor reminder check failed: ${error.message || error}`);
  } finally {
    benchmarkAdvisorReminderChecking = false;
  }
}

function startBenchmarkAdvisorReminder(url) {
  clearBenchmarkAdvisorReminder();
  if (BENCHMARK_ADVISOR_REMINDER_INTERVAL_MS <= 0) {
    appendLog("Benchmark advisor reminder disabled.");
    return;
  }
  appendLog(`Benchmark advisor reminder started: intervalMs=${BENCHMARK_ADVISOR_REMINDER_INTERVAL_MS}`);
  checkBenchmarkAdvisorReminder(url);
  benchmarkAdvisorReminderTimer = setInterval(() => {
    checkBenchmarkAdvisorReminder(url);
  }, BENCHMARK_ADVISOR_REMINDER_INTERVAL_MS);
}

function stopServer() {
  if (pendingServerRestartTimer) {
    clearTimeout(pendingServerRestartTimer);
    pendingServerRestartTimer = null;
  }
  clearServerWatchdog();
  clearWeeklyReviewReminder();
  clearTikOmniWeeklyMarket();
  clearBenchmarkAdvisorReminder();
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  appendLog(`Stopping Echo Founder service tree: pid=${child.pid}`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    signalServerProcess(child, "SIGTERM");
    setTimeout(() => {
      if (!settled && child.exitCode === null && child.signalCode === null) {
        appendLog(`Force stopping Echo Founder service tree: pid=${child.pid}`);
        signalServerProcess(child, "SIGKILL");
      }
    }, 5000);
    setTimeout(finish, 8000);
  });
}

async function restartUnresponsiveServer(child, url) {
  if (serverWatchdogRecovering || isQuitting || serverProcess !== child) return;
  serverWatchdogRecovering = true;
  try {
    await queueServerLifecycle(async ({ isCurrent }) => {
      if (isQuitting || serverProcess !== child) return;
      clearServerWatchdog();
      lastServerExit = {
        pid: child.pid,
        reason: "watchdog-unresponsive",
        ready: true,
        at: new Date().toISOString(),
      };

      if (serverRestartCount >= SERVICE_RESTART_MAX) {
        appendLog(`Echo Founder service watchdog restart limit reached: ${JSON.stringify(lastServerExit)}`);
        showStartupError(new Error("Local service watchdog recovery limit reached."));
        return;
      }

      serverRestartCount += 1;
      serverWatchdogRestartCount += 1;
      const attempt = serverRestartCount;
      const portToWait = currentPort;
      appendLog(`Echo Founder service watchdog restarting unresponsive service: attempt=${attempt}/${SERVICE_RESTART_MAX} pid=${child.pid} url=${url}`);
      loadInternalHtml("应用暂时没有响应，正在恢复，请稍候。");
      serverProcess = null;
      signalServerProcess(child, "SIGKILL");
      if (portToWait) {
        await waitForPortClosed(portToWait, 10000);
      }
      await sleep(SERVICE_RESTART_DELAY_MS);
      if (!isCurrent() || isQuitting) {
        appendLog("Echo Founder watchdog recovery was superseded by a newer service lifecycle request.");
        return;
      }
      await startServer();
    });
  } catch (error) {
    showStartupError(error);
  } finally {
    serverWatchdogRecovering = false;
  }
}

function startServerWatchdog(child, url) {
  clearServerWatchdog();
  if (!SERVICE_WATCHDOG_ENABLED || SERVICE_WATCHDOG_INTERVAL_MS <= 0 || SERVICE_WATCHDOG_FAILURES <= 0) {
    appendLog("Echo Founder service watchdog disabled.");
    return;
  }
  appendLog(`Echo Founder service watchdog started: intervalMs=${SERVICE_WATCHDOG_INTERVAL_MS} timeoutMs=${SERVICE_WATCHDOG_TIMEOUT_MS} failures=${SERVICE_WATCHDOG_FAILURES}`);
  serverWatchdogTimer = setInterval(async () => {
    if (isQuitting || serverProcess !== child || child.exitCode !== null || child.signalCode !== null || serverWatchdogRecovering) {
      return;
    }
    if (serverWatchdogProbeRunning) {
      appendLog("Echo Founder service watchdog skipped overlapping probe.");
      return;
    }
    serverWatchdogProbeRunning = true;
    try {
      const healthy = await probeServerHealth(url, SERVICE_WATCHDOG_TIMEOUT_MS);
      if (healthy) {
        if (serverWatchdogFailureCount > 0) {
          appendLog(`Echo Founder service watchdog recovered after ${serverWatchdogFailureCount} failed probe(s).`);
        }
        serverWatchdogFailureCount = 0;
        return;
      }
      serverWatchdogFailureCount += 1;
      appendLog(`Echo Founder service watchdog probe failed: failure=${serverWatchdogFailureCount}/${SERVICE_WATCHDOG_FAILURES} pid=${child.pid}`);
      if (serverWatchdogFailureCount >= SERVICE_WATCHDOG_FAILURES) {
        await restartUnresponsiveServer(child, url);
      }
    } finally {
      serverWatchdogProbeRunning = false;
    }
  }, SERVICE_WATCHDOG_INTERVAL_MS);
}

function scheduleServerAutoRestart(exitInfo, options = {}) {
  const deferNavigation = options.deferNavigation === true;
  // The local service must remain self-healing even if macOS has temporarily
  // closed or recreated the window. `loadInternalHtml` already handles the
  // no-window case, while `startServer` will load the entry when one exists.
  if (isQuitting) return false;
  if (pendingServerRestartTimer) {
    appendLog("Echo Founder service auto-restart already scheduled; skipping duplicate schedule.");
    return true;
  }
  lastServerExit = {
    ...exitInfo,
    at: new Date().toISOString(),
  };
  if (serverRestartCount >= SERVICE_RESTART_MAX) {
    appendLog(`Echo Founder service auto-restart limit reached: ${JSON.stringify(lastServerExit)}`);
    if (!deferNavigation) showStartupError(new Error("Local service auto-restart limit reached."));
    return false;
  }

  serverRestartCount += 1;
  const attempt = serverRestartCount;
  appendLog(`Scheduling Echo Founder service auto-restart: attempt=${attempt}/${SERVICE_RESTART_MAX} delayMs=${SERVICE_RESTART_DELAY_MS} exit=${JSON.stringify(lastServerExit)}`);
  if (!deferNavigation) {
    loadInternalHtml("应用暂时中断，正在恢复，请稍候。");
  }
  pendingServerRestartTimer = setTimeout(() => {
    pendingServerRestartTimer = null;
    queueServerLifecycle(({ isCurrent }) => {
      if (!isCurrent() || isQuitting) return { ready: false, superseded: true };
      return startServer();
    }).catch(showStartupError);
  }, SERVICE_RESTART_DELAY_MS);
  return true;
}

async function startServer(options = {}) {
  const deferNavigation = options.deferNavigation === true;
  if (isQuitting) return { ready: false, cancelled: true };
  if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    throw new Error(`Refusing to start a second local service while pid=${serverProcess.pid} is still active.`);
  }
  if (!PYTHON_RUNTIME.available) {
    const recovery = app.isPackaged
      ? `请重新安装完整的 ${PRODUCT_NAME} 应用包。`
      : "建议：\n1. 安装 Python 3。\n2. 或用 AIFIOS_PYTHON=/path/to/python3 make desktop 指定 Python。";
    const message = `${PYTHON_RUNTIME.error}\n\n${recovery}`;
    appendLog(`Python runtime unavailable: ${message}`);
    if (!deferNavigation) loadInternalHtml("缺少必要的运行组件，正在打开处理说明。");
    throw new Error(message);
  }
  currentPort = Number(process.env.AIFIOS_DESKTOP_PORT || 0) || await findFreePort();
  const url = `http://${HOST}:${currentPort}`;
  const runtimePathPrefix = runtimeBinaryPathPrefix(PYTHON_RUNTIME, MD2WECHAT_RUNTIME);
  // Chromium cannot safely launch from inside a macOS .app bundle under every
  // architecture. Packaged builds therefore validate and atomically deploy it
  // to userData before the local service receives the executable path.
  const chromiumPath = app.isPackaged
    ? materializePackagedPlaywrightChromium()
    : (process.env.AIFIOS_PLAYWRIGHT_CHROMIUM_PATH || bundledPlaywrightChromiumPath());
  const serviceStartedAt = new Date().toISOString();
  const env = {
    ...pythonProcessEnvironment(ensureCredentialVault().serviceEnvironment(process.env)),
    AIFIOS_HOME: REPO_ROOT,
    AIFIOS_PROJECT: projectDir,
    AIFIOS_SKILLS_DIR: SKILLS_DIR,
    AIFIOS_PYTHON: PYTHON_RUNTIME.binary,
    AIFIOS_DESKTOP: "1",
    AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET: PUBLICATION_RECEIPT_SECRET,
    AIFIOS_DESKTOP_SERVICE_AUTH_SECRET: DESKTOP_SERVICE_AUTH_SECRET,
    AIFIOS_DESKTOP_SINGLE_INSTANCE: SINGLE_INSTANCE_ENABLED ? "1" : "0",
    AIFIOS_DESKTOP_PROJECT_SOURCE: projectDirSource,
    // A paid hosted package cannot be switched into local self-config mode by
    // injecting a different gateway URL into the parent environment.
    AIFIOS_DESKTOP_LICENSE_MODE: desktopLicenseMode,
    AIFIOS_DESKTOP_USER_DATA_DIR: app.getPath("userData"),
    // The Next child can send only fixed gateway requests through this
    // authenticated loopback transport. The Ed25519 private key remains in
    // Electron and is never exposed as an environment variable or IPC method.
    AIFIOS_DESKTOP_GATEWAY_PROXY_URL: hostedGatewayProxy?.url || "",
    AIFIOS_DESKTOP_GATEWAY_PROXY_TOKEN: hostedGatewayProxy?.token || "",
    AIFIOS_TIKOMNI_ENV_FILE: process.env.AIFIOS_TIKOMNI_ENV_FILE || desktopTikomniEnvFile(),
    ...(bundledTikomniSkillDir() ? { TIKOMNI_SOCIAL_MEDIA_CRAWL_DIR: bundledTikomniSkillDir() } : {}),
    // A packaged build never falls back to a recipient's Playwright cache.
    AIFIOS_PLAYWRIGHT_CHROMIUM_PATH: chromiumPath,
    AIFIOS_DESKTOP_SETTINGS_PATH: desktopSettingsPath(),
    AIFIOS_DESKTOP_PARENT_PID: String(process.pid),
    AIFIOS_DESKTOP_SERVICE_RESTART_COUNT: String(serverRestartCount),
    AIFIOS_DESKTOP_SERVICE_STARTED_AT: serviceStartedAt,
    AIFIOS_DESKTOP_SERVICE_LAST_EXIT: lastServerExit ? JSON.stringify(lastServerExit) : "",
    AIFIOS_DESKTOP_SERVICE_RESTART_MAX: String(SERVICE_RESTART_MAX),
    AIFIOS_DESKTOP_SERVICE_WATCHDOG_ENABLED: SERVICE_WATCHDOG_ENABLED ? "1" : "0",
    AIFIOS_DESKTOP_SERVICE_WATCHDOG_FAILURE_COUNT: String(serverWatchdogFailureCount),
    AIFIOS_DESKTOP_SERVICE_WATCHDOG_THRESHOLD: String(SERVICE_WATCHDOG_FAILURES),
    AIFIOS_DESKTOP_SERVICE_WATCHDOG_RESTART_COUNT: String(serverWatchdogRestartCount),
    AIFIOS_DESKTOP_SERVICE_WATCHDOG_INTERVAL_MS: String(SERVICE_WATCHDOG_INTERVAL_MS),
    AIFIOS_DESKTOP_SERVICE_WATCHDOG_TIMEOUT_MS: String(SERVICE_WATCHDOG_TIMEOUT_MS),
    AIFIOS_ELECTRON_VERSION: process.versions.electron || "",
    AIFIOS_ELECTRON_APP_VERSION: app.getVersion(),
    AIFIOS_DESKTOP_SERVER_MODE: DESKTOP_SERVER_MODE,
    AIFIOS_DESKTOP_PYTHON_BINARY: PYTHON_RUNTIME.binary,
    AIFIOS_DESKTOP_PYTHON_SOURCE: PYTHON_RUNTIME.source,
    AIFIOS_DESKTOP_PYTHON_VERSION: PYTHON_RUNTIME.version,
    MD2WECHAT_BINARY: MD2WECHAT_RUNTIME.available ? MD2WECHAT_RUNTIME.binary : "",
    AIFIOS_DESKTOP_MD2WECHAT_SOURCE: MD2WECHAT_RUNTIME.source,
    AIFIOS_DESKTOP_MD2WECHAT_VERSION: MD2WECHAT_RUNTIME.version,
    AIFIOS_NODE_BINARY: process.execPath,
    AIFIOS_NODE_RUN_AS_NODE: "1",
    AIFIOS_SKIP_UI_BUILD: app.isPackaged ? "1" : process.env.AIFIOS_SKIP_UI_BUILD || "",
    // Packaged builds contain Next's traced standalone server rather than the
    // development ui/node_modules tree. Source Electron continues to use the
    // normal Next CLI unless explicitly opted in.
    AIFIOS_NEXT_STANDALONE: app.isPackaged ? "1" : process.env.AIFIOS_NEXT_STANDALONE || "",
    AIFIOS_NEXT_DIST_DIR: app.isPackaged ? ".next-desktop" : String(process.env.AIFIOS_NEXT_DIST_DIR || "").trim() || ".next-desktop",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(currentPort),
    HOSTNAME: HOST,
    PATH: runtimePathPrefix.length ? `${runtimePathPrefix.join(path.delimiter)}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH || "",
  };
  const args = [
    CLI_PATH,
    "--project",
    projectDir,
    "ui",
    "--host",
    HOST,
    "--port",
    String(currentPort),
    "--server-mode",
    DESKTOP_SERVER_MODE,
    "--install-deps",
    "--no-open",
  ];

  appendLog(`Using Python runtime: ${PYTHON_RUNTIME.binary} (${PYTHON_RUNTIME.source}, ${PYTHON_RUNTIME.version})`);
  appendLog(MD2WECHAT_RUNTIME.available
    ? `Using md2wechat runtime: ${MD2WECHAT_RUNTIME.binary} (${MD2WECHAT_RUNTIME.source}, ${MD2WECHAT_RUNTIME.version})`
    : "md2wechat runtime unavailable; WeChat publishing will use the bundled basic renderer.");
  if (app.isPackaged) appendLog(`Using materialized Playwright Chromium: ${chromiumPath}`);
  appendLog(`Starting Echo Founder service: ${PYTHON} ${args.join(" ")}`);
  let childReady = false;
  let recoveryScheduled = false;
  const child = spawn(PYTHON, args, {
    cwd: REPO_ROOT,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess = child;
  appendLog(`Echo Founder service process started: pid=${child.pid} restartCount=${serverRestartCount} startedAt=${serviceStartedAt}`);

  child.stdout.on("data", (chunk) => appendLog(chunk.toString().trimEnd()));
  child.stderr.on("data", (chunk) => appendLog(chunk.toString().trimEnd()));
  child.on("error", (error) => {
    appendLog(`Echo Founder service process error: ${error.message || error}`);
  });
  child.on("exit", (code, signal) => {
    appendLog(`Echo Founder service exited: code=${code} signal=${signal} ready=${childReady} tracked=${serverProcess === child} quitting=${isQuitting}`);
    if (serverProcess === child) {
      serverProcess = null;
      if (!isQuitting) {
        signalServerProcess(child, "SIGTERM");
        // A service can accept its first health probe just before the async
        // startup continuation sets `childReady`. Recovery must not lose that
        // narrow window or a ready desktop can be left without its service.
        recoveryScheduled = scheduleServerAutoRestart(
          { code, signal, pid: child.pid, ready: childReady },
          { deferNavigation },
        );
      } else if (childReady && mainWindow && !mainWindow.isDestroyed()) {
        loadInternalHtml("应用正在退出。");
      }
    }
  });
  const exitPromise = new Promise((_resolve, reject) => {
    child.once("exit", (code, signal) => {
      const error = new Error(`Echo Founder service exited before ready: code=${code ?? "none"} signal=${signal ?? "none"}`);
      error.aifiosRecoveryScheduled = recoveryScheduled;
      reject(error);
    });
  });
  const processErrorPromise = new Promise((_resolve, reject) => {
    child.once("error", reject);
  });

  try {
    await Promise.race([waitForHttp(url), exitPromise, processErrorPromise]);
  } catch (error) {
    if (error?.aifiosRecoveryScheduled) {
      appendLog("Echo Founder service exited during startup; auto-recovery was scheduled.");
      return { ready: false, recoveryScheduled: true };
    }
    throw error;
  }
  childReady = true;
  appendLog(`Echo Founder service ready: ${url}`);
  startServerWatchdog(child, url);
  startWeeklyReviewReminder(url);
  startTikOmniWeeklyMarket(url);
  startBenchmarkAdvisorReminder(url);
  if (!deferNavigation) await loadDesktopEntry(url);
  return { ready: true, url };
}

async function restartServer(message = "正在重新打开工作区，请稍候。", options = {}) {
  ensureServerLifecycle().supersede();
  const deferNavigation = options.deferNavigation === true;
  return restartDesktopService({
    stop: stopServer,
    beforeStart: () => {
      if (!deferNavigation && mainWindow && !mainWindow.isDestroyed()) loadInternalHtml(message);
    },
    start: () => startServer({ deferNavigation }),
    onFailure: deferNavigation
      ? (error) => appendLog(`Checked service restart failed before renderer navigation: ${error.message || error}`)
      : showStartupError,
    afterReady: deferNavigation
      ? (result) => loadDesktopEntry(result.url).catch(showStartupError)
      : null,
    // Let Electron settle the ipcRenderer.invoke response before replacing
    // the sender frame with the newly healthy local service page.
    scheduleAfterReady: deferNavigation
      ? (callback) => setTimeout(callback, 75)
      : (callback) => callback(),
    requireReady: options.requireReady === true,
  });
}

async function chooseProjectDirectory() {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: `选择 ${PRODUCT_NAME} 项目目录`,
    defaultPath: projectDir || defaultProjectDir(),
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "使用此目录",
  });
  if (result.canceled || !result.filePaths?.[0]) return;

  const nextProjectDir = normalizeProjectDir(result.filePaths[0]);
  if (!nextProjectDir) return;
  if (samePath(nextProjectDir, projectDir)) {
    appendLog(`Project directory unchanged: ${nextProjectDir}`);
    return;
  }

  ensureDir(nextProjectDir);
  const migration = migrateLegacyPlaintextCredentials({
    vault: ensureCredentialVault(),
    llmConfigPath: path.join(nextProjectDir, "config", "llm-config.json"),
    tikomniEnvPath: desktopTikomniEnvFile(),
  });
  initializeProjectSchema(nextProjectDir);
  appendLog(`Selected project security preparation complete: llmMigrated=${migration.llm} tikomniMigrated=${migration.tikomni}`);
  saveProjectDirSelection(nextProjectDir);
  projectDir = nextProjectDir;
  appendLog(`Switched desktop project directory: ${projectDir}`);
  await restartServer("正在切换项目，请稍候。");
}

function showStartupError(error) {
  const failure = createDesktopUserFacingFailure(error, {
    operation: "Desktop startup",
    markers: [projectDir, app.getPath("userData"), REPO_ROOT, os.homedir()].filter(Boolean),
  });
  const message = `${failure.payload.error}\n\n参考编号：${failure.payload.debugId}`;
  appendLog(`Startup failed [${failure.payload.debugId}]: ${failure.logDetail}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    loadInternalHtml(message, `${PRODUCT_NAME} 无法启动`);
  }
  dialog.showErrorBox(`${PRODUCT_NAME} 无法启动`, message);
}

async function stopHostedGatewayProxy() {
  const active = hostedGatewayProxy;
  hostedGatewayProxy = null;
  if (!active) return;
  try {
    await active.close();
  } catch (error) {
    appendLog(`Hosted gateway proxy shutdown failed: ${error.message || error}`);
  }
}

function shutdownFromSignal(signal) {
  if (isQuitting) return;
  isQuitting = true;
  appendLog(`Received ${signal}; shutting down Echo Founder desktop`);
  publicationBridge?.close();
  Promise.all([queueServerLifecycle(() => stopServer()), stopHostedGatewayProxy()]).finally(() => {
    if (logStream) {
      logStream.end();
    }
    app.exit(0);
  });
}

function setupMenu() {
  const template = [
    {
      label: PRODUCT_NAME,
      submenu: [
        { label: "重新打开工作区", click: () => queueServerLifecycle(() => restartServer()).catch(showStartupError) },
        {
          label: "选择项目目录",
          click: () => queueDesktopMutation(() => chooseProjectDirectory()).catch(showStartupError),
        },
        {
          label: "运行诊断",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed() && currentPort) {
              mainWindow.loadURL(`http://${HOST}:${currentPort}/settings?desktopDiagnostics=1`);
            }
          },
        },
        { label: "打开项目目录", click: () => shell.openPath(projectDir) },
        { label: "打开日志文件", click: () => shell.openPath(logPath()) },
        { type: "separator" },
        { role: "reload", label: "刷新窗口" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  if (!HAS_SINGLE_INSTANCE_LOCK) return;
  configureDesktopAppIdentity();
  registerDesktopIpc();
  try {
    desktopLicenseMode = readDesktopLicenseMode();
    if (desktopLicenseMode === "device-bound") {
      await initializeHostedLicense();
    }
  } catch (error) {
    const failure = createDesktopUserFacingFailure(error, {
      operation: "License initialization",
      markers: [projectDir, app.getPath("userData"), REPO_ROOT, os.homedir()].filter(Boolean),
    });
    const message = `${failure.payload.error}\n\n参考编号：${failure.payload.debugId}`;
    appendLog(`License initialization failed [${failure.payload.debugId}]: ${failure.logDetail}`);
    dialog.showErrorBox(`${PRODUCT_NAME} 无法验证设备授权`, message);
    app.quit();
    return;
  }
  appendLog(`Desktop license mode: ${desktopLicenseMode}`);
  projectDir = resolveInitialProjectDir();
  ensureDir(projectDir);
  appendLog(`Desktop project directory: ${projectDir} source=${projectDirSource}`);
  try {
    // Secrets are migrated and verified before the legacy project receives
    // its pre-schema backup, so a backup can never capture a plaintext key.
    initializeCredentialVault();
    initializeProjectSchema();
    const snapshotRecovery = await purgeStalePublicationAssetSnapshots({
      tempRoot: publicationAssetSnapshotRoot(),
    });
    if (snapshotRecovery.purged > 0) {
      appendLog(`Sanitized ${snapshotRecovery.purged} stale publication asset snapshot(s).`);
    }
  } catch (error) {
    const failure = createDesktopUserFacingFailure(error, {
      operation: "Secure data initialization",
      markers: [projectDir, app.getPath("userData"), REPO_ROOT, os.homedir()].filter(Boolean),
    });
    const message = `${failure.payload.error}\n\n参考编号：${failure.payload.debugId}`;
    appendLog(`Secure data initialization failed [${failure.payload.debugId}]: ${failure.logDetail}`);
    dialog.showErrorBox(`${PRODUCT_NAME} 无法准备本机数据`, message);
    app.quit();
    return;
  }
  createWindow();
  setupMenu();
  await queueServerLifecycle(() => startServer()).catch(showStartupError);
});

if (SINGLE_INSTANCE_ENABLED) {
  app.on("second-instance", () => {
    appendLog("Second Echo Founder desktop instance requested; focusing existing window.");
    focusMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && currentPort) {
      loadDesktopEntry(`http://${HOST}:${currentPort}`).catch((error) => {
        appendLog(`Failed to restore desktop entry after second-instance request: ${error.message || error}`);
      });
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    if (currentPort) {
      loadDesktopEntry(`http://${HOST}:${currentPort}`).catch((error) => {
        appendLog(`Failed to restore desktop entry after activation: ${error.message || error}`);
      });
    }
  }
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  publicationBridge?.close();
  Promise.all([queueServerLifecycle(() => stopServer()), stopHostedGatewayProxy()]).finally(() => {
    if (logStream) {
      logStream.end();
    }
    app.quit();
  });
});

process.on("SIGTERM", () => shutdownFromSignal("SIGTERM"));
process.on("SIGINT", () => shutdownFromSignal("SIGINT"));
