const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  DATA_DIRECTORY,
  MANIFEST_FILE,
  PROJECT_BACKUP_SCHEMA,
  PROJECT_SCHEMA,
  PROJECT_SCHEMA_FILE,
  canonicalJson,
  ensureProjectSchema,
  exportProjectBackup,
  importProjectBackup,
  sha256Buffer,
} = require("./project-backup.cjs");

function withTempDir(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aifios-backup-test-"));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeProjectFixture(project) {
  fs.mkdirSync(path.join(project, "config"), { recursive: true });
  fs.mkdirSync(path.join(project, "runs", "run-1"), { recursive: true });
  fs.mkdirSync(path.join(project, "materials"), { recursive: true });
  fs.mkdirSync(path.join(project, "materials", "logs"), { recursive: true });
  fs.mkdirSync(path.join(project, "materials", "cache"), { recursive: true });
  fs.mkdirSync(path.join(project, "dist"), { recursive: true });
  fs.mkdirSync(path.join(project, "credentials"), { recursive: true });
  fs.mkdirSync(path.join(project, "materials", "performance", "auth-cache"), { recursive: true });
  fs.mkdirSync(path.join(project, "materials", "tikomni", "raw"), { recursive: true });
  fs.mkdirSync(path.join(project, "materials", "publication", "desktop-transactions", "run-1"), { recursive: true });
  fs.mkdirSync(path.join(project, "browser-profile"), { recursive: true });
  fs.mkdirSync(path.join(project, "sessions", "browser-profiles", "xiaohongshu", "Default", "Network"), { recursive: true });
  fs.mkdirSync(path.join(project, "sessions", "locks", "stale-lock"), { recursive: true });
  fs.mkdirSync(path.join(project, "sessions", "idempotency"), { recursive: true });
  fs.writeFileSync(path.join(project, "config", "llm-config.json"), JSON.stringify({
    provider: "openai",
    apiKey: "must-not-back-up",
    gatewaySession: "must-not-back-up-either",
    model: "gpt-test",
  }));
  fs.writeFileSync(path.join(project, "runs", "run-1", "state.json"), JSON.stringify({ runId: "run-1" }));
  fs.writeFileSync(path.join(project, "materials", "credential-economy.md"), "legitimate customer material\n");
  fs.writeFileSync(path.join(project, "materials", "cookie-design.md"), "legitimate customer material\n");
  fs.writeFileSync(path.join(project, "materials", "logs", "field-notes.md"), "legitimate customer material\n");
  fs.writeFileSync(path.join(project, "materials", "cache", "source-notes.md"), "legitimate customer material\n");
  fs.writeFileSync(path.join(project, "materials", "tikomni", "raw", "wechat.json"), JSON.stringify({
    platform: "wechat",
    token: "[已脱敏]",
    authorization: "[REDACTED]",
    items: [{ title: "verified public sample" }],
  }));
  fs.writeFileSync(
    path.join(project, "materials", "publication", "desktop-transactions", "run-1", "draft_aaaaaaaaaaaaaaaaaaaa.json"),
    JSON.stringify({
      schema: "echo-founder.publication-transaction.v1",
      run_id: "run-1",
      job_id: "draft_aaaaaaaaaaaaaaaaaaaa",
      payload_hash: "b".repeat(64),
      queue_path: "materials/publication/drafts/run-1/draft-queue.json",
      attempts: [],
    }),
  );
  fs.writeFileSync(
    path.join(project, "materials", "publication", "desktop-transactions", "run-1", "draft_aaaaaaaaaaaaaaaaaaaa.lock"),
    "legacy-stale-lock-must-not-back-up\n",
  );
  fs.writeFileSync(path.join(project, ".env"), "SECRET=must-not-back-up\n");
  fs.writeFileSync(path.join(project, "desktop.log"), "must-not-back-up\n");
  fs.writeFileSync(path.join(project, "dist", "bundle.js"), "must-not-back-up\n");
  fs.writeFileSync(path.join(project, "credentials", "token.txt"), "must-not-back-up\n");
  fs.writeFileSync(
    path.join(project, "materials", "performance", "auth-cache", "wechat-official-token.json"),
    JSON.stringify({ access_token: "must-not-back-up", expires_at: 4_102_444_800 }),
  );
  fs.writeFileSync(path.join(project, "tikomni.env"), "TIKOMNI_API_KEY=must-not-back-up\n");
  fs.writeFileSync(path.join(project, "publication-credentials.json"), JSON.stringify({ appSecret: "must-not-back-up" }));
  fs.writeFileSync(path.join(project, "browser-profile", "cookies.json"), JSON.stringify({ cookie: "must-not-back-up" }));
  fs.writeFileSync(
    path.join(project, "sessions", "browser-profiles", "xiaohongshu", "Default", "Network", "Cookies"),
    Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.from("cookie-secret-canary")]),
  );
  fs.writeFileSync(path.join(project, "materials", "storage_state.json"), JSON.stringify({ cookies: ["must-not-back-up"] }));
  fs.writeFileSync(path.join(project, "sessions", "locks", "stale-lock", "ticket-dead.json"), "must-not-back-up\n");
  fs.writeFileSync(path.join(project, "sessions", "idempotency", "cached-result.json"), "must-not-back-up\n");
}

function rewriteManifest(backup, mutate) {
  const manifestPath = path.join(backup, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  mutate(manifest);
  const { manifestSha256: _ignored, ...payload } = manifest;
  manifest.manifestSha256 = sha256Buffer(Buffer.from(canonicalJson(payload), "utf8"));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Generated synthetic values exercise detection; these are never provider credentials.
const fakeProviderCredential = (prefix) => prefix + "testfixture".repeat(4);

test("backup exports a sanitized manifest and restores into a new project", () => withTempDir((root) => {
  const project = path.join(root, "source-project");
  const backup = path.join(root, "source-project.aifios-backup");
  const restored = path.join(root, "restored-project");
  fs.mkdirSync(project);
  writeProjectFixture(project);
  fs.writeFileSync(path.join(project, PROJECT_SCHEMA_FILE), JSON.stringify({ schema: PROJECT_SCHEMA }));

  const exported = exportProjectBackup({
    projectDir: project,
    backupPath: backup,
    appVersion: "0.2.0-beta.2",
    now: new Date("2026-08-24T02:00:00.000Z"),
  });
  assert.equal(exported.schema, PROJECT_BACKUP_SCHEMA);
  assert.equal(exported.fileCount, 9);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.schema, PROJECT_BACKUP_SCHEMA);
  assert.equal(manifest.projectSchema, PROJECT_SCHEMA);
  assert.deepEqual(manifest.files.map((item) => item.path), [
    PROJECT_SCHEMA_FILE,
    "config/llm-config.json",
    "materials/cache/source-notes.md",
    "materials/cookie-design.md",
    "materials/credential-economy.md",
    "materials/logs/field-notes.md",
    "materials/publication/desktop-transactions/run-1/draft_aaaaaaaaaaaaaaaaaaaa.json",
    "materials/tikomni/raw/wechat.json",
    "runs/run-1/state.json",
  ]);
  const backedConfig = fs.readFileSync(path.join(backup, DATA_DIRECTORY, "config", "llm-config.json"), "utf8");
  assert.equal(backedConfig.includes("must-not-back-up"), false);
  assert.deepEqual(JSON.parse(backedConfig), { provider: "openai", model: "gpt-test" });

  const imported = importProjectBackup({
    backupPath: backup,
    destinationPath: restored,
    appVersion: "0.2.0-beta.2",
    now: new Date("2026-08-24T03:00:00.000Z"),
  });
  assert.equal(imported.fileCount, 9);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restored, "runs", "run-1", "state.json"), "utf8")), { runId: "run-1" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(restored, PROJECT_SCHEMA_FILE), "utf8")).schema, PROJECT_SCHEMA);
  assert.equal(fs.existsSync(path.join(restored, "dist")), false);
  assert.equal(fs.existsSync(path.join(restored, ".env")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "tikomni.env")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "publication-credentials.json")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "browser-profile")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "sessions", "browser-profiles")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "materials", "storage_state.json")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "credentials")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "materials", "performance", "auth-cache")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "sessions", "locks")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "sessions", "idempotency")), false);
  assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, "materials", "publication", "desktop-transactions", "run-1", "draft_aaaaaaaaaaaaaaaaaaaa.lock")), false);
  assert.equal(fs.existsSync(path.join(restored, "materials", "publication", "desktop-transactions", "run-1", "draft_aaaaaaaaaaaaaaaaaaaa.lock")), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(restored, "materials", "publication", "desktop-transactions", "run-1", "draft_aaaaaaaaaaaaaaaaaaaa.json"), "utf8")).schema,
    "echo-founder.publication-transaction.v1",
  );
  assert.equal(fs.readFileSync(path.join(restored, "materials", "credential-economy.md"), "utf8"), "legitimate customer material\n");
  assert.equal(fs.readFileSync(path.join(restored, "materials", "cookie-design.md"), "utf8"), "legitimate customer material\n");
  assert.equal(fs.readFileSync(path.join(restored, "materials", "logs", "field-notes.md"), "utf8"), "legitimate customer material\n");
  assert.equal(fs.readFileSync(path.join(restored, "materials", "cache", "source-notes.md"), "utf8"), "legitimate customer material\n");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(restored, "materials", "tikomni", "raw", "wechat.json"), "utf8")),
    {
      platform: "wechat",
      token: "[已脱敏]",
      authorization: "[REDACTED]",
      items: [{ title: "verified public sample" }],
    },
  );
}));

test("backup restores Unicode and mixed-case paths independently of directory enumeration order", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  const restored = path.join(root, "restored-project");
  fs.mkdirSync(path.join(project, "materials", "中文目录"), { recursive: true });
  fs.writeFileSync(path.join(project, "materials", "alpha.txt"), "lowercase\n");
  fs.writeFileSync(path.join(project, "materials", "Zulu.txt"), "uppercase\n");
  fs.writeFileSync(path.join(project, "materials", "中文目录", "复盘.md"), "中文内容\n");

  const exported = exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  assert.equal(exported.fileCount, 3);
  importProjectBackup({ backupPath: backup, destinationPath: restored, appVersion: "test" });

  assert.equal(fs.readFileSync(path.join(restored, "materials", "alpha.txt"), "utf8"), "lowercase\n");
  assert.equal(fs.readFileSync(path.join(restored, "materials", "Zulu.txt"), "utf8"), "uppercase\n");
  assert.equal(fs.readFileSync(path.join(restored, "materials", "中文目录", "复盘.md"), "utf8"), "中文内容\n");
}));

test("backup permits only exact redaction sentinels in sensitive JSON fields", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(path.join(project, "materials"), { recursive: true });
  fs.writeFileSync(path.join(project, "materials", "safe.json"), JSON.stringify({
    token: "[REDACTED]",
    nested: { cookie: "[已脱敏]" },
  }));
  assert.equal(exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }).fileCount, 1);

  const unsafeProject = path.join(root, "unsafe-project");
  fs.mkdirSync(path.join(unsafeProject, "materials"), { recursive: true });
  fs.writeFileSync(path.join(unsafeProject, "materials", "unsafe.json"), JSON.stringify({ token: "[redacted]" }));
  assert.throws(
    () => exportProjectBackup({
      projectDir: unsafeProject,
      backupPath: path.join(root, "unsafe-backup.aifios-backup"),
      appVersion: "test",
    }),
    /non-empty sensitive field/i,
  );
}));

test("backup rejects credential-bearing LLM base URLs", () => withTempDir((root) => {
  const unsafeUrls = [
    "https://user:password@api.example.test/v1",
    "https://api.example.test/v1?api_key=live-query-secret",
    "https://api.example.test/v1#live-fragment-secret",
  ];
  for (const [index, baseUrl] of unsafeUrls.entries()) {
    const project = path.join(root, `unsafe-project-${index}`);
    const backup = path.join(root, `unsafe-backup-${index}.aifios-backup`);
    fs.mkdirSync(path.join(project, "config"), { recursive: true });
    fs.writeFileSync(path.join(project, "config", "llm-config.json"), JSON.stringify({
      provider: "openai",
      model: "gpt-test",
      baseUrl,
    }));
    assert.throws(
      () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
      /unsafe base URL/i,
    );
    assert.equal(fs.existsSync(backup), false);
  }

  const safeProject = path.join(root, "safe-project");
  const safeBackup = path.join(root, "safe-backup.aifios-backup");
  fs.mkdirSync(path.join(safeProject, "config"), { recursive: true });
  fs.writeFileSync(path.join(safeProject, "config", "llm-config.json"), JSON.stringify({
    provider: "azure-openai",
    model: "gpt-test",
    baseUrl: "https://api.example.test/v1?api-version=2026-01-01",
  }));
  assert.equal(exportProjectBackup({ projectDir: safeProject, backupPath: safeBackup, appVersion: "test" }).fileCount, 1);
}));

test("backup fails closed on non-empty credential fields in arbitrary JSON", () => withTempDir((root) => {
  const sensitiveRecords = [
    ["token", { token: "live-token-value" }],
    ["api-key", { nested: { api_key: "live-api-key" } }],
    ["app-secret", { integration: { appSecret: "live-app-secret" } }],
    ["client-secret", { client_secret: "live-client-secret" }],
    ["password", { account: { password: "live-password" } }],
    ["cookie", { cookie: "session=live-cookie" }],
    ["authorization", { authorization: "Bearer live-authorization" }],
    ["private-key", { "private key": "-----BEGIN PRIVATE KEY-----" }],
    ["session-secret", { "session secret": "live-session-secret" }],
    ["pairing-token", { pairingToken: "live-mobile-pairing-token" }],
    ["credential", { credential: "live-credential" }],
    ["credentials", { credentials: ["live-credential"] }],
    ["passphrase", { passphrase: "live-passphrase" }],
    ["encryption-key", { encryptionKey: "live-encryption-key" }],
    ["account-key", { accountKey: "live-account-key" }],
    ["client-key-data", { clientKeyData: "live-client-key-data" }],
  ];

  for (const [label, record] of sensitiveRecords) {
    const project = path.join(root, `project-${label}`);
    const backup = path.join(root, `backup-${label}.aifios-backup`);
    fs.mkdirSync(path.join(project, "integrations"), { recursive: true });
    fs.writeFileSync(path.join(project, "integrations", "integration.json"), JSON.stringify(record));
    assert.throws(
      () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
      /non-empty sensitive field/i,
      label,
    );
    assert.equal(fs.existsSync(backup), false, label);
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(`backup-${label}.aifios-backup.partial-`)), false, label);
  }

  const oversizedProject = path.join(root, "project-oversized-json");
  const oversizedBackup = path.join(root, "backup-oversized-json.aifios-backup");
  fs.mkdirSync(path.join(oversizedProject, "integrations"), { recursive: true });
  fs.closeSync(fs.openSync(path.join(oversizedProject, "integrations", "integration.json"), "w"));
  fs.truncateSync(path.join(oversizedProject, "integrations", "integration.json"), (16 * 1024 * 1024) + 1);
  assert.throws(
    () => exportProjectBackup({ projectDir: oversizedProject, backupPath: oversizedBackup, appVersion: "test" }),
    /too large for safe structured credential inspection/i,
  );
  assert.equal(fs.existsSync(oversizedBackup), false);
}));

test("backup preserves public Xiaohongshu xsec_token evidence while blocking credential tokens", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  const restored = path.join(root, "restored");
  const relative = "materials/tikomni/raw/xhs.json";
  fs.mkdirSync(path.join(project, "materials", "tikomni", "raw"), { recursive: true });
  fs.writeFileSync(path.join(project, ...relative.split("/")), JSON.stringify({
    data: { items: [{ note: { xsec_token: "public-note-navigation-token" } }] },
    urlToken: "[已脱敏]",
  }));

  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  importProjectBackup({ backupPath: backup, destinationPath: restored, appVersion: "test" });
  const restoredJson = JSON.parse(fs.readFileSync(path.join(restored, ...relative.split("/")), "utf8"));
  assert.equal(restoredJson.data.items[0].note.xsec_token, "public-note-navigation-token");

  const unsafeProject = path.join(root, "unsafe-project");
  const unsafeBackup = path.join(root, "unsafe-backup.aifios-backup");
  fs.mkdirSync(unsafeProject);
  fs.writeFileSync(path.join(unsafeProject, "tokens.json"), JSON.stringify({
    access_token: "live-access-token",
    customVendorToken: "live-provider-token",
  }));
  assert.throws(
    () => exportProjectBackup({ projectDir: unsafeProject, backupPath: unsafeBackup, appVersion: "test" }),
    /non-empty sensitive field/i,
  );
}));

test("backup rejects high-confidence authorization, private-key, and assignment secrets", () => withTempDir((root) => {
  const sensitiveTexts = [
    ["authorization", "Authorization: Bearer live-bearer-value\n"],
    ["private-key", "-----BEGIN PRIVATE KEY-----\nlive-private-key-material\n-----END PRIVATE KEY-----\n"],
    ["assignment", "TIKOMNI_API_KEY=live-tikomni-key\n"],
    ["quoted-source-assignment", "api_key = \"live-source-secret\"\n"],
    ["alphabetic-password", "password=huntertwo\n"],
    ["alphabetic-shell-key", "API_KEY=abcdefghijk\n"],
  ];

  for (const [label, content] of sensitiveTexts) {
    const project = path.join(root, `project-${label}`);
    const backup = path.join(root, `backup-${label}.aifios-backup`);
    fs.mkdirSync(path.join(project, "materials"), { recursive: true });
    fs.writeFileSync(path.join(project, "materials", "integration-notes.txt"), content);
    assert.throws(
      () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
      /high-confidence (?:authorization bearer header|private key|credential(?: literal)? assignment)/i,
      label,
    );
    assert.equal(fs.existsSync(backup), false, label);
  }

  const disguisedProject = path.join(root, "project-disguised-json");
  const disguisedBackup = path.join(root, "backup-disguised-json.aifios-backup");
  fs.mkdirSync(path.join(disguisedProject, "materials"), { recursive: true });
  fs.writeFileSync(path.join(disguisedProject, "materials", "integration.png"), JSON.stringify({ token: "renamed-secret" }));
  assert.throws(
    () => exportProjectBackup({ projectDir: disguisedProject, backupPath: disguisedBackup, appVersion: "test" }),
    /non-empty sensitive field|high-confidence JSON credential field/i,
  );
  assert.equal(fs.existsSync(disguisedBackup), false);

  const escapedProject = path.join(root, "project-escaped-json");
  const escapedBackup = path.join(root, "backup-escaped-json.aifios-backup");
  fs.mkdirSync(path.join(escapedProject, "materials"), { recursive: true });
  fs.writeFileSync(
    path.join(escapedProject, "materials", "integration.png"),
    '{"api\\u004bey":"live-escaped-secret"}',
  );
  assert.throws(
    () => exportProjectBackup({ projectDir: escapedProject, backupPath: escapedBackup, appVersion: "test" }),
    /non-empty sensitive field|high-confidence JSON credential field/i,
  );
  assert.equal(fs.existsSync(escapedBackup), false);
}));

test("backup detects a credential literal spanning the streaming chunk boundary", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(path.join(project, "materials"), { recursive: true });
  const prefix = "x".repeat((1024 * 1024) - 9000);
  const content = `${prefix} api_key = "${"s".repeat(12000)}"\n`;
  fs.writeFileSync(path.join(project, "materials", "boundary.txt"), content);

  assert.throws(
    () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
    /high-confidence credential literal assignment/i,
  );
  assert.equal(fs.existsSync(backup), false);
}));

test("backup and restore detect a multiline credential expression split at the streaming boundary", () => withTempDir((root) => {
  const chunkBytes = 1024 * 1024;
  const marker = "api_key = (\n";
  const paddingBytes = chunkBytes - Buffer.byteLength(marker);
  assert.equal(paddingBytes % 2, 0);
  const weaponized = Buffer.from(`${"#\n".repeat(paddingBytes / 2)}${marker}  "live-canary-secret"\n)\n`);
  assert.equal(weaponized.subarray(0, chunkBytes).toString("utf8").endsWith(marker), true);

  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "source.py"), weaponized);
  assert.throws(
    () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
    /credential literal assignment/i,
  );

  const safeProject = path.join(root, "safe-project");
  const safeBackup = path.join(root, "safe-backup.aifios-backup");
  fs.mkdirSync(safeProject);
  fs.writeFileSync(path.join(safeProject, "source.py"), "api_key = get_key()\n");
  exportProjectBackup({ projectDir: safeProject, backupPath: safeBackup, appVersion: "test" });
  fs.writeFileSync(path.join(safeBackup, DATA_DIRECTORY, "source.py"), weaponized);
  rewriteManifest(safeBackup, (manifest) => {
    const row = manifest.files.find((item) => item.path === "source.py");
    row.size = weaponized.length;
    row.sha256 = sha256Buffer(weaponized);
    manifest.totalBytes = weaponized.length;
  });
  assert.throws(
    () => importProjectBackup({
      backupPath: safeBackup,
      destinationPath: path.join(root, "restored-weaponized-source"),
      appVersion: "test",
    }),
    /credential literal assignment/i,
  );
}));

test("backup scans blank-line-heavy text without pathological backtracking", { timeout: 2_000 }, () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "blank.txt"), "\n".repeat(100_000));

  assert.equal(exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }).fileCount, 1);
}));

test("backup and restore reject valid secret JSON disguised across a streaming boundary", () => withTempDir((root) => {
  const chunkBytes = 1024 * 1024;
  const prefix = '{"padding":"';
  const keyAtBoundary = '","api\\u004bey":\n';
  const paddingBytes = chunkBytes - Buffer.byteLength(prefix) - Buffer.byteLength(keyAtBoundary);
  const weaponized = Buffer.from(`${prefix}${"x".repeat(paddingBytes)}${keyAtBoundary}"live-canary-secret"}`);
  assert.equal(weaponized[chunkBytes - 1], "\n".charCodeAt(0));

  const unsafeProject = path.join(root, "unsafe-project");
  const unsafeBackup = path.join(root, "unsafe-backup.aifios-backup");
  fs.mkdirSync(unsafeProject);
  fs.writeFileSync(path.join(unsafeProject, "payload.png"), weaponized);
  assert.throws(
    () => exportProjectBackup({ projectDir: unsafeProject, backupPath: unsafeBackup, appVersion: "test" }),
    /non-empty sensitive field/i,
  );
  assert.equal(fs.existsSync(unsafeBackup), false);

  const safeProject = path.join(root, "safe-project");
  const safeBackup = path.join(root, "safe-backup.aifios-backup");
  fs.mkdirSync(safeProject);
  fs.writeFileSync(path.join(safeProject, "payload.png"), '{"ok":true}');
  exportProjectBackup({ projectDir: safeProject, backupPath: safeBackup, appVersion: "test" });
  fs.writeFileSync(path.join(safeBackup, DATA_DIRECTORY, "payload.png"), weaponized);
  rewriteManifest(safeBackup, (manifest) => {
    const row = manifest.files.find((item) => item.path === "payload.png");
    row.size = weaponized.length;
    row.sha256 = sha256Buffer(weaponized);
    manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  });
  assert.throws(
    () => importProjectBackup({
      backupPath: safeBackup,
      destinationPath: path.join(root, "restored-weaponized"),
      appVersion: "test",
    }),
    /non-empty sensitive field/i,
  );
}));

test("backup accepts safe minified JSON larger than the text-line limit", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(path.join(project, "materials"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "materials", "large-safe.json"),
    JSON.stringify({ schema: "customer.material.v1", content: "x".repeat((2 * 1024 * 1024) + 4096) }),
  );

  assert.equal(exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }).fileCount, 1);
}));

test("backup preserves ordinary security-related prose, empty fields, and binary data", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(path.join(project, "materials"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "materials", "security-article.md"),
    "This article compares token economics, credential economy, and cookie design without storing credentials.\nToken: a unit of text used by a model, not a saved credential.\n",
  );
  fs.writeFileSync(path.join(project, "materials", "article-metadata.json"), JSON.stringify({
    token: "",
    cookie: null,
    tokenCount: 1200,
    credentialEconomy: "research topic",
    cookieDesign: "article topic",
    securityGuide: "Authorization: Bearer is the standard HTTP header syntax; never paste a live value here.",
  }));
  const binary = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x10, 0x80]),
    Buffer.from("Authorization: Bearer this-is-binary-not-a-text-secret", "ascii"),
  ]);
  fs.writeFileSync(path.join(project, "materials", "sample.dat"), binary);

  const exported = exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  assert.equal(exported.fileCount, 3);
  assert.equal(
    fs.readFileSync(path.join(backup, DATA_DIRECTORY, "materials", "security-article.md"), "utf8"),
    "This article compares token economics, credential economy, and cookie design without storing credentials.\nToken: a unit of text used by a model, not a saved credential.\n",
  );
  assert.deepEqual(fs.readFileSync(path.join(backup, DATA_DIRECTORY, "materials", "sample.dat")), binary);
}));

test("backup preserves credential-related source expressions without literal values", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  const source = [
    "class LLMConfig:",
    "    api_key: str = \"\"",
    "",
    "def load_key(cfg, data, os):",
    "    client(api_key=get_key())",
    "    api_key = data.get(\"apiKey\", \"\")",
    "    api_key = cfg.effective_api_key()",
    "    cfg.api_key = os.environ[\"LLM_API_KEY\"]",
    "    cfg.api_key = args.api_key",
    "    api_key = f\"{os.environ['OPENAI_API_KEY']}\"",
    "    if not api_key:",
    "        raise RuntimeError(\"API key is required\")",
    "    return api_key",
    "",
  ].join("\n");
  fs.mkdirSync(path.join(project, "content_runtime"), { recursive: true });
  fs.writeFileSync(path.join(project, "content_runtime", "llm.py"), source);
  fs.writeFileSync(
    path.join(project, "content_runtime", "adapter.cjs"),
    [
      "const apiKey = SOME_IDENTIFIER;",
      "settings.api_key = process.env.OPENAI_API_KEY;",
      "client({ apiKey: `${OPENAI_API_KEY}` });",
      "client({ apiKey: `${process.env.OPENAI_API_KEY}` });",
      "",
    ].join("\n"),
  );

  const exported = exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  assert.equal(exported.fileCount, 2);
  assert.equal(
    fs.readFileSync(path.join(backup, DATA_DIRECTORY, "content_runtime", "llm.py"), "utf8"),
    source,
  );
}));

test("backup scans every credential occurrence after a safe placeholder", () => withTempDir((root) => {
  const cases = [
    ["quoted.py", 'api_key = "your-api-key"\npassword = "live-secret-value"\n'],
    ["bare.conf", "API_KEY=your-api-key\nPASSWORD=huntertwo\n"],
    ["json-doc.md", '{"apiKey":"your-api-key"}\n{"password":"live-secret-value"}\n'],
    ["mixed-template.js", 'const apiKey = `live-secret-prefix-${process.env.SUFFIX}`;\n'],
  ];
  for (const [fileName, content] of cases) {
    const project = path.join(root, `project-${fileName.replace(/[^a-z]/gi, "-")}`);
    const backup = path.join(root, `backup-${fileName.replace(/[^a-z]/gi, "-")}.aifios-backup`);
    fs.mkdirSync(path.join(project, "materials"), { recursive: true });
    fs.writeFileSync(path.join(project, "materials", fileName), content);
    assert.throws(
      () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
      /high-confidence (?:JSON credential field|credential(?: literal)? assignment)/i,
      fileName,
    );
    assert.equal(fs.existsSync(backup), false, fileName);
  }
}));

test("backup rejects YAML multi-word and block-scalar credential values", () => withTempDir((root) => {
  const cases = [
    ["password.yaml", "password: correct horse battery staple\n"],
    ["literal.yaml", "api_key: |\n  live-canary-secret\n"],
    ["folded.yml", "client_secret: >\n  live-canary-secret\n"],
  ];
  for (const [index, [fileName, content]] of cases.entries()) {
    const project = path.join(root, `project-${index}`);
    const backup = path.join(root, `backup-${index}.aifios-backup`);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, fileName), content);
    assert.throws(
      () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
      /high-confidence credential unquoted assignment/i,
    );
  }

  const safeProject = path.join(root, "safe-project");
  const safeBackup = path.join(root, "safe-backup.aifios-backup");
  fs.mkdirSync(safeProject);
  fs.writeFileSync(path.join(safeProject, "safe.yaml"), "api_key: your-api-key\npassword: null\n");
  assert.equal(exportProjectBackup({ projectDir: safeProject, backupPath: safeBackup, appVersion: "test" }).fileCount, 1);
  const weaponized = Buffer.from("password: CORRECTHORSEBATTERY\n");
  fs.writeFileSync(path.join(safeBackup, DATA_DIRECTORY, "safe.yaml"), weaponized);
  rewriteManifest(safeBackup, (manifest) => {
    const row = manifest.files.find((item) => item.path === "safe.yaml");
    row.size = weaponized.length;
    row.sha256 = sha256Buffer(weaponized);
    manifest.totalBytes = weaponized.length;
  });
  assert.throws(
    () => importProjectBackup({
      backupPath: safeBackup,
      destinationPath: path.join(root, "restored-weaponized-yaml"),
      appVersion: "test",
    }),
    /credential(?: unquoted)? assignment/i,
  );
}));

test("backup rejects provider-prefixed and cross-language credential literals", () => withTempDir((root) => {
  const cases = [
    ["secret.sh", "OPENAI_API_KEY=alphabeticsecret\n"],
    ["uppercase-env.env", "PASSWORD=HUNTERTWO\n"],
    ["uppercase-shell.sh", "API_KEY=ABCDEFGHIJKL\n"],
    ["uppercase-yaml.yaml", "password: CORRECTHORSEBATTERY\n"],
    ["provider-token.sh", "OPENAI_TOKEN=livecanarytoken\n"],
    ["smoke-provider-token.sh", "AIFIOS_SMOKE_PROVIDER_TOKEN=livecanarytoken\n"],
    ["vendor-token.sh", "CUSTOM_VENDOR_TOKEN=livecanarytoken\n"],
    ["gateway-token.sh", "GATEWAY_ADMIN_TOKEN=livecanarytoken\n"],
    ["proxy-token.sh", "AIFIOS_DESKTOP_GATEWAY_PROXY_TOKEN=livecanarytoken\n"],
    ["token-pepper.sh", "GATEWAY_TOKEN_PEPPER=livecanarypepper\n"],
    ["private-key-base64.sh", "GATEWAY_RESEARCH_SIGNING_PRIVATE_KEY_BASE64=livecanarybase64\n"],
    ["demo-unlock-codes.sh", "AIFIOS_DEMO_UNLOCK_CODES=livecanarycodes\n"],
    ["aws-secret-key.sh", "AWS_SECRET_ACCESS_KEY=livecanarysecretvalue\n"],
    ["invite-code.sh", "AIFIOS_INVITE_CODE=AIF-LIVE-CANARY-CODE\n"],
    ["secret.cjs", 'const openaiApiKey = "live-source-secret";\n'],
    ["access-token.cjs", 'const githubAccessToken = "live-canary-token";\n'],
    ["session-cookie.cjs", 'const sessionCookie = "session=live";\n'],
    ["secret.go", 'apiKey := "live-source-secret"\n'],
    ["Secret.java", 'String apiKey = "live-source-secret";\n'],
    ["secret.php", '$apiKey = "live-source-secret";\n'],
    ["secret.py", 'config["apiKey"] = "live-source-secret"\n'],
    ["parenthesized.py", 'api_key = ("live-source-secret")\n'],
    ["fallback.py", 'api_key = os.getenv("OPENAI_API_KEY", "live-source-secret")\n'],
    ["python-or-fallback.py", 'api_key = os.environ.get("OPENAI_API_KEY") or "live-source-secret"\n'],
    ["javascript-or-fallback.cjs", 'const apiKey = process.env.OPENAI_API_KEY || "live-source-secret";\n'],
    ["javascript-nullish-fallback.cjs", 'const apiKey = process.env.OPENAI_API_KEY ?? "live-source-secret";\n'],
    ["placeholder-concatenation.py", 'api_key = "your-api-key" + "-live-canary-secret"\n'],
    ["fragmented-key.cjs", 'const apiKey = "sk-" + "proj-livecanaryabcdefghijklmnop";\n'],
    ["adjacent-fragment.py", 'api_key = "sk-" "proj-livecanaryabcdefghijklmnop"\n'],
    ["short-password.cjs", 'const password = "abc";\n'],
    ["nullish-assignment.cjs", 'config.apiKey ??= "live-source-secret";\n'],
    ["or-assignment.cjs", 'apiKey ||= "live-source-secret";\n'],
    ["append-assignment.py", 'password += "live-source-secret"\n'],
    ["unicode-api-key.cjs", 'const api\\u004bey = "live-source-secret";\n'],
    ["unicode-password.cjs", 'const passw\\u006frd = "live-source-secret";\n'],
    ["secret.rs", 'let api_key: &str = "live-source-secret";\n'],
    ["receipt.ts", 'const AIFIOS_PUBLICATION_RECEIPT_SECRET = "live-source-secret";\n'],
    ["raw.py", 'api_key = r"live-source-secret"\n'],
    ["formatted.py", 'api_key = f"live-source-secret"\n'],
  ];
  for (const [fileName, content] of cases) {
    const project = path.join(root, `project-${fileName.replace(/[^a-z]/gi, "-")}`);
    const backup = path.join(root, `backup-${fileName.replace(/[^a-z]/gi, "-")}.aifios-backup`);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, fileName), content);
    assert.throws(
      () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
      /high-confidence credential/i,
      fileName,
    );
    assert.equal(fs.existsSync(backup), false, fileName);
  }

  const structuredProject = path.join(root, "structured-project");
  const structuredBackup = path.join(root, "structured-backup.aifios-backup");
  fs.mkdirSync(structuredProject);
  fs.writeFileSync(path.join(structuredProject, "metadata.json"), JSON.stringify({
    githubAccessToken: "live-canary-token",
    sessionCookie: "session=live",
    AIFIOS_SMOKE_PROVIDER_TOKEN: "live-canary-token",
    GATEWAY_TOKEN_PEPPER: "live-canary-pepper",
    GATEWAY_RESEARCH_SIGNING_PRIVATE_KEY_BASE64: "live-canary-base64",
    AIFIOS_DEMO_UNLOCK_CODES: "live-canary-codes",
    awsSecretAccessKey: "live-canary-secret-value",
    inviteCode: "AIF-LIVE-CANARY-CODE",
    activationCode: "live-activation-code",
    authorizationCode: "live-oauth-code-canary",
    unlockCode: "DEMO-LIVE-CANARY",
  }));
  assert.throws(
    () => exportProjectBackup({ projectDir: structuredProject, backupPath: structuredBackup, appVersion: "test" }),
    /non-empty sensitive field/i,
  );
  assert.equal(fs.existsSync(structuredBackup), false);
}));

test("backup rejects raw high-confidence provider credentials without a field name", () => withTempDir((root) => {
  const credentials = [
    fakeProviderCredential("sk-proj-"),
    fakeProviderCredential("ghp_"),
    fakeProviderCredential("sk_live_"),
  ];
  for (const [index, credential] of credentials.entries()) {
    const project = path.join(root, `project-${index}`);
    const backup = path.join(root, `backup-${index}.aifios-backup`);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "notes.md"), `pasted credential: ${credential}\n`);
    assert.throws(
      () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
      /high-confidence provider credential/i,
    );
    assert.equal(fs.existsSync(backup), false);
  }
}));

test("backup preserves non-credential design tokens", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "design.json"), JSON.stringify({
    designToken: "spacing-large",
    colorToken: "brand-primary",
    publicKey: "safe-public-key-material",
    signingPublicKey: "safe-signing-public-key-material",
  }));
  fs.writeFileSync(path.join(project, "design.ts"), [
    'const designToken = "spacing-large";',
    'const colorToken = "brand-primary";',
    "",
  ].join("\n"));

  assert.equal(exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }).fileCount, 2);
}));

test("backup fails closed on invalid UTF-8 in source and private-key text files", () => withTempDir((root) => {
  const sourceNames = [
    "source.go", "Source.java", "source.php", "source.rs", "source.rb", "source.swift",
    "source.kt", "source.cs", "source.cpp", "source.vue", "source.svelte", "private.pem", "private.key",
  ];
  for (const [index, fileName] of sourceNames.entries()) {
    const project = path.join(root, `project-${index}`);
    const backup = path.join(root, `backup-${index}.aifios-backup`);
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, fileName),
      Buffer.concat([Buffer.from([0xff]), Buffer.from('\napi_key = "live-canary-secret"\n')]),
    );
    assert.throws(
      () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
      /not valid inspectable text/i,
      fileName,
    );
  }

  const safeProject = path.join(root, "safe-project");
  const safeBackup = path.join(root, "safe-backup.aifios-backup");
  const restored = path.join(root, "restored");
  fs.mkdirSync(safeProject);
  fs.writeFileSync(path.join(safeProject, "source.go"), "package main\n");
  fs.writeFileSync(path.join(safeProject, "customer-ca.pem"), [
    "-----BEGIN CERTIFICATE-----",
    "U0FGRS1QVUJMSUMtQ0VSVElGSUNBVEU=",
    "-----END CERTIFICATE-----",
    "",
  ].join("\n"));
  exportProjectBackup({ projectDir: safeProject, backupPath: safeBackup, appVersion: "test" });
  importProjectBackup({ backupPath: safeBackup, destinationPath: restored, appVersion: "test" });
  assert.equal(fs.existsSync(path.join(restored, "customer-ca.pem")), true);

  const weaponized = Buffer.concat([Buffer.from([0xff]), Buffer.from('\napi_key = "live-canary-secret"\n')]);
  fs.writeFileSync(path.join(safeBackup, DATA_DIRECTORY, "source.go"), weaponized);
  rewriteManifest(safeBackup, (manifest) => {
    const row = manifest.files.find((item) => item.path === "source.go");
    row.size = weaponized.length;
    row.sha256 = sha256Buffer(weaponized);
    manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  });
  assert.throws(
    () => importProjectBackup({
      backupPath: safeBackup,
      destinationPath: path.join(root, "weaponized-restore"),
      appVersion: "test",
    }),
    /not valid inspectable text/i,
  );
}));

test("backup excludes credential-store files and restore rejects a rehashed store", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(path.join(project, ".docker"), { recursive: true });
  fs.writeFileSync(path.join(project, "note.txt"), "customer data\n");
  fs.writeFileSync(path.join(project, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_livecanaryabcdefghijklmnopqrstuvwxyz\n");
  fs.writeFileSync(path.join(project, ".netrc"), "machine api.example.test login alice password livecanarypassword\n");
  fs.writeFileSync(path.join(project, ".pypirc"), "password=livecanarypassword\n");
  fs.writeFileSync(path.join(project, ".git-credentials"), "https://alice:livecanarypassword@example.test\n");
  fs.writeFileSync(path.join(project, ".docker", "config.json"), JSON.stringify({ auths: { "registry.example.test": { auth: "YWxpY2U6cGFzc3dvcmQ=" } } }));
  fs.writeFileSync(path.join(project, "private.p12"), Buffer.from("private container"));

  const exported = exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  assert.equal(exported.fileCount, 1);
  for (const relative of [".npmrc", ".netrc", ".pypirc", ".git-credentials", ".docker/config.json", "private.p12"]) {
    assert.equal(fs.existsSync(path.join(backup, DATA_DIRECTORY, ...relative.split("/"))), false, relative);
  }

  const injected = Buffer.from("//registry.npmjs.org/:_authToken=npm_livecanaryabcdefghijklmnopqrstuvwxyz\n");
  fs.writeFileSync(path.join(backup, DATA_DIRECTORY, ".npmrc"), injected);
  rewriteManifest(backup, (manifest) => {
    manifest.files.push({ path: ".npmrc", size: injected.length, sha256: sha256Buffer(injected) });
    manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  });
  assert.throws(
    () => importProjectBackup({
      backupPath: backup,
      destinationPath: path.join(root, "restored"),
      appVersion: "test",
    }),
    /excluded path/i,
  );
}));

test("backup permits exact credential placeholders in documentation", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "docs", "setup.md"),
    [
      "```json",
      '{"apiKey": "your-api-key"}',
      "```",
      "```sh",
      "TIKOMNI_API_KEY=your-api-key",
      "```",
      "",
    ].join("\n"),
  );

  assert.equal(exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }).fileCount, 1);
}));

test("backup preserves ordinary top-level tests and GitHub files while excluding build-system caches", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  const restored = path.join(root, "restored");
  fs.mkdirSync(path.join(project, "tests"), { recursive: true });
  fs.mkdirSync(path.join(project, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(project, ".pytest_cache"), { recursive: true });
  fs.mkdirSync(path.join(project, "materials", "tests"), { recursive: true });
  fs.writeFileSync(path.join(project, "tests", "customer-ab-test.md"), "customer experiment\n");
  fs.writeFileSync(path.join(project, ".github", "workflows", "ci.yml"), "name: customer workflow\n");
  fs.writeFileSync(path.join(project, ".pytest_cache", "state.txt"), "cache");
  fs.writeFileSync(path.join(project, "materials", "tests", "note.txt"), "customer material");

  const exported = exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  assert.equal(exported.fileCount, 3);
  assert.equal(
    fs.readFileSync(path.join(backup, DATA_DIRECTORY, "materials", "tests", "note.txt"), "utf8"),
    "customer material",
  );
  assert.equal(
    fs.readFileSync(path.join(backup, DATA_DIRECTORY, "tests", "customer-ab-test.md"), "utf8"),
    "customer experiment\n",
  );
  assert.equal(
    fs.readFileSync(path.join(backup, DATA_DIRECTORY, ".github", "workflows", "ci.yml"), "utf8"),
    "name: customer workflow\n",
  );
  importProjectBackup({ backupPath: backup, destinationPath: restored, appVersion: "test" });
  assert.equal(fs.readFileSync(path.join(restored, "tests", "customer-ab-test.md"), "utf8"), "customer experiment\n");
  assert.equal(fs.readFileSync(path.join(restored, ".github", "workflows", "ci.yml"), "utf8"), "name: customer workflow\n");
}));

test("backup explicitly projects data and unknown business assets from a recognized legacy mixed checkout", () => withTempDir((root) => {
  const project = path.join(root, "legacy-mixed-project");
  const backup = path.join(root, "backup.aifios-backup");
  const restored = path.join(root, "restored");
  for (const directory of ["content_runtime", "schemas", "scripts", "skills", "brain", "materials", "pipeline", "runs", "tests", "docs", ".github/workflows", "client-archive"]) {
    fs.mkdirSync(path.join(project, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(project, "content_runtime", "cli.py"), [
    "from content_runtime.core import ContentRuntime",
    'DESCRIPTION = "content-runtime · AI Founder Influence OS"',
    'api_key = "fake-test-fixture"',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(project, "pyproject.toml"), [
    "[project]",
    'name = "content-runtime"',
    'description = "AI Founder Influence OS runtime"',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(project, "schemas", "run.json"), "{}");
  fs.writeFileSync(path.join(project, "scripts", "build.py"), "pass\n");
  fs.writeFileSync(path.join(project, "skills", "runtime.md"), "source skill\n");
  fs.writeFileSync(path.join(project, "tests", "fixture.py"), 'api_key = "fake-test-fixture"\n');
  fs.writeFileSync(path.join(project, "tests", "customer-ab-test.md"), "customer experiment\n");
  fs.writeFileSync(path.join(project, "docs", "customer-contract.md"), "customer contract\n");
  fs.writeFileSync(path.join(project, ".github", "workflows", "ci.yml"), "name: source workflow\n");
  fs.writeFileSync(path.join(project, "brain", "profile.md"), "customer profile\n");
  fs.writeFileSync(path.join(project, "materials", "note.md"), "customer material\n");
  fs.writeFileSync(path.join(project, "pipeline", "draft.md"), "customer draft\n");
  fs.writeFileSync(path.join(project, "runs", "run.json"), "{}");
  fs.writeFileSync(path.join(project, "MASTER_PLAYBOOK.md"), "# AI FOUNDER INFLUENCE OS · 总控手册\ncustomer playbook\n");
  fs.writeFileSync(path.join(project, "client-ledger.xlsx"), "customer spreadsheet bytes\n");
  fs.writeFileSync(path.join(project, "client-archive", "evidence.txt"), "customer evidence\n");

  const exported = exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  assert.equal(exported.projection, "legacy-mixed-checkout-data");
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.projection, "legacy-mixed-checkout-data");
  const projectedPaths = new Set(manifest.files.map((row) => row.path));
  for (const expectedPath of [
    "brain/profile.md",
    "client-archive/evidence.txt",
    "client-ledger.xlsx",
    "docs/customer-contract.md",
    "MASTER_PLAYBOOK.md",
    "materials/note.md",
    "pipeline/draft.md",
    "runs/run.json",
    "tests/customer-ab-test.md",
  ]) {
    assert.equal(projectedPaths.has(expectedPath), true, expectedPath);
  }
  for (const excludedPath of ["content_runtime/cli.py", "tests/fixture.py", ".github/workflows/ci.yml"]) {
    assert.equal(projectedPaths.has(excludedPath), false, excludedPath);
  }
  importProjectBackup({ backupPath: backup, destinationPath: restored, appVersion: "test" });
  assert.equal(fs.readFileSync(path.join(restored, "client-ledger.xlsx"), "utf8"), "customer spreadsheet bytes\n");
  assert.equal(fs.readFileSync(path.join(restored, "client-archive", "evidence.txt"), "utf8"), "customer evidence\n");
  assert.equal(fs.readFileSync(path.join(restored, "docs", "customer-contract.md"), "utf8"), "customer contract\n");
  assert.equal(fs.readFileSync(path.join(restored, "tests", "customer-ab-test.md"), "utf8"), "customer experiment\n");
  assert.equal(fs.existsSync(path.join(restored, "content_runtime")), false);
}));

test("ordinary v1 projects are never projected from directory-name collisions", () => withTempDir((root) => {
  const project = path.join(root, "ordinary-project");
  const backup = path.join(root, "backup.aifios-backup");
  for (const directory of ["content_runtime", "schemas", "scripts", "skills", "brain", "materials", "pipeline", "tests", "docs"]) {
    fs.mkdirSync(path.join(project, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(project, PROJECT_SCHEMA_FILE), JSON.stringify({ schema: PROJECT_SCHEMA }));
  fs.writeFileSync(path.join(project, "content_runtime", "cli.py"), "print('customer tool')\n");
  fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\nname='customer-project'\n");
  fs.writeFileSync(path.join(project, "tests", "customer-ab-test.md"), "customer experiment\n");
  fs.writeFileSync(path.join(project, "docs", "customer-contract.md"), "customer contract\n");

  const exported = exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, MANIFEST_FILE), "utf8"));
  assert.equal(exported.projection, "complete-project");
  assert.equal(manifest.files.some((item) => item.path === "tests/customer-ab-test.md"), true);
  assert.equal(manifest.files.some((item) => item.path === "docs/customer-contract.md"), true);
}));

test("backup does not accept binary data disguised as required JSON", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(path.join(project, "materials"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "materials", "fake.json"),
    Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.from("not-json")]),
  );

  assert.throws(
    () => exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" }),
    /not valid inspectable text/i,
  );
}));

test("restore never overwrites an existing destination and rejects extra or missing files", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "note.txt"), "hello");
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });

  const existing = path.join(root, "existing-project");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "sentinel.txt"), "keep-me");
  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: existing, appVersion: "test" }),
    /already exists/i,
  );
  assert.equal(fs.readFileSync(path.join(existing, "sentinel.txt"), "utf8"), "keep-me");
  assert.deepEqual(fs.readdirSync(existing), ["sentinel.txt"]);

  fs.writeFileSync(path.join(backup, DATA_DIRECTORY, "extra.txt"), "not-listed");
  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: path.join(root, "restore-extra"), appVersion: "test" }),
    /do not match the manifest/i,
  );
  assert.equal(fs.existsSync(path.join(root, "restore-extra")), false);

  fs.unlinkSync(path.join(backup, DATA_DIRECTORY, "extra.txt"));
  fs.unlinkSync(path.join(backup, DATA_DIRECTORY, "note.txt"));
  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: path.join(root, "restore-missing"), appVersion: "test" }),
    /do not match the manifest/i,
  );
  assert.equal(fs.existsSync(path.join(root, "restore-missing")), false);
}));

test("restore enforces an explicit legacy projection and rejects invalid projection metadata", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(path.join(project, "tests"), { recursive: true });
  fs.writeFileSync(path.join(project, "tests", "source.py"), "print('source')\n");
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  rewriteManifest(backup, (manifest) => {
    manifest.projection = "legacy-mixed-checkout-data";
  });
  assert.throws(
    () => importProjectBackup({
      backupPath: backup,
      destinationPath: path.join(root, "restore-projection-violation"),
      appVersion: "test",
    }),
    /violates its declared projection/i,
  );

  for (const [index, invalidProjection] of [null, ""].entries()) {
    const candidateBackup = path.join(root, `invalid-projection-${index}.aifios-backup`);
    exportProjectBackup({ projectDir: project, backupPath: candidateBackup, appVersion: "test" });
    rewriteManifest(candidateBackup, (manifest) => {
      manifest.projection = invalidProjection;
    });
    assert.throws(
      () => importProjectBackup({
        backupPath: candidateBackup,
        destinationPath: path.join(root, `restore-invalid-projection-${index}`),
        appVersion: "test",
      }),
      /projection is unsupported/i,
    );
  }
}));

test("restore remains compatible with pre-projection backups containing pytest cache data", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "historical.aifios-backup");
  const restored = path.join(root, "restored");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "note.txt"), "customer data\n");
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "legacy" });

  const cacheContent = Buffer.from("historical cache state\n");
  const cachePath = path.join(backup, DATA_DIRECTORY, ".pytest_cache", "state.txt");
  const bytecodeContent = Buffer.from("historical bytecode cache\n");
  const bytecodePath = path.join(backup, DATA_DIRECTORY, "nested", "__pycache__", "module.pyc");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.mkdirSync(path.dirname(bytecodePath), { recursive: true });
  fs.writeFileSync(cachePath, cacheContent);
  fs.writeFileSync(bytecodePath, bytecodeContent);
  rewriteManifest(backup, (manifest) => {
    delete manifest.projection;
    manifest.files.push({
      path: ".pytest_cache/state.txt",
      size: cacheContent.length,
      sha256: sha256Buffer(cacheContent),
    });
    manifest.files.push({
      path: "nested/__pycache__/module.pyc",
      size: bytecodeContent.length,
      sha256: sha256Buffer(bytecodeContent),
    });
    manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  });

  const imported = importProjectBackup({ backupPath: backup, destinationPath: restored, appVersion: "test" });
  assert.equal(imported.projection, "complete-project");
  assert.equal(fs.readFileSync(path.join(restored, ".pytest_cache", "state.txt"), "utf8"), "historical cache state\n");
  assert.equal(fs.readFileSync(path.join(restored, "nested", "__pycache__", "module.pyc"), "utf8"), "historical bytecode cache\n");
}));

test("restore rejects traversal and duplicate paths before writing destination", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "note.txt"), "hello");
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });

  rewriteManifest(backup, (manifest) => {
    manifest.files[0].path = "../escape.txt";
  });
  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: path.join(root, "restore-traversal"), appVersion: "test" }),
    /unsafe path/i,
  );
  assert.equal(fs.existsSync(path.join(root, "restore-traversal")), false);

  fs.rmSync(backup, { recursive: true, force: true });
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  rewriteManifest(backup, (manifest) => {
    manifest.files.push({ ...manifest.files[0], path: manifest.files[0].path.toUpperCase() });
    manifest.totalBytes += manifest.files[0].size;
  });
  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: path.join(root, "restore-duplicate"), appVersion: "test" }),
    /duplicate paths/i,
  );
}));

test("restore rejects a source project name that could disclose or escape a local path", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  const restored = path.join(root, "restore-unsafe-name");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "note.txt"), "hello");
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });

  rewriteManifest(backup, (manifest) => {
    manifest.sourceProjectName = "/Users/alice/private-project";
  });

  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: restored, appVersion: "test" }),
    /unsafe project name/i,
  );
  assert.equal(fs.existsSync(restored), false);
}));

test("restore rejects checksum mismatch, symlinks, and unsupported schemas", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "note.txt"), "hello");
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  fs.writeFileSync(path.join(backup, DATA_DIRECTORY, "note.txt"), "changed");
  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: path.join(root, "restore-checksum"), appVersion: "test" }),
    /unsafe or has changed|checksum does not match/i,
  );

  fs.rmSync(backup, { recursive: true, force: true });
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  fs.unlinkSync(path.join(backup, DATA_DIRECTORY, "note.txt"));
  fs.symlinkSync(path.join(project, "note.txt"), path.join(backup, DATA_DIRECTORY, "note.txt"));
  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: path.join(root, "restore-link"), appVersion: "test" }),
    /symbolic link/i,
  );

  fs.rmSync(backup, { recursive: true, force: true });
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
  rewriteManifest(backup, (manifest) => {
    manifest.projectSchema = "aifios.project.v999";
  });
  assert.throws(
    () => importProjectBackup({ backupPath: backup, destinationPath: path.join(root, "restore-schema"), appVersion: "test" }),
    /data schema is unsupported/i,
  );
}));

test("restore rejects excluded browser state even when an attacker recomputes every checksum", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "note.txt"), "hello");
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });

  const relative = "sessions/browser-profiles/xiaohongshu/Default/Network/Cookies";
  const cookieDatabase = Buffer.concat([
    Buffer.from("SQLite format 3\0", "binary"),
    Buffer.from("live-cookie-canary"),
  ]);
  const cookiePath = path.join(backup, DATA_DIRECTORY, ...relative.split("/"));
  fs.mkdirSync(path.dirname(cookiePath), { recursive: true });
  fs.writeFileSync(cookiePath, cookieDatabase);
  rewriteManifest(backup, (manifest) => {
    manifest.files.push({ path: relative, size: cookieDatabase.length, sha256: sha256Buffer(cookieDatabase) });
    manifest.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
    manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  });

  assert.throws(
    () => importProjectBackup({
      backupPath: backup,
      destinationPath: path.join(root, "restore-browser-state"),
      appVersion: "test",
    }),
    /excluded path/i,
  );
  assert.equal(fs.existsSync(path.join(root, "restore-browser-state")), false);
}));

test("restore rescans content and rejects a rehashed secret-bearing backup", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  const relative = "materials/tikomni/raw/wechat.json";
  fs.mkdirSync(path.join(project, "materials", "tikomni", "raw"), { recursive: true });
  fs.writeFileSync(path.join(project, ...relative.split("/")), JSON.stringify({ token: "[已脱敏]", items: [] }));
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });

  const weaponized = Buffer.from(JSON.stringify({ token: "live-import-secret", items: [] }));
  fs.writeFileSync(path.join(backup, DATA_DIRECTORY, ...relative.split("/")), weaponized);
  rewriteManifest(backup, (manifest) => {
    const row = manifest.files.find((item) => item.path === relative);
    row.size = weaponized.length;
    row.sha256 = sha256Buffer(weaponized);
    manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  });

  assert.throws(
    () => importProjectBackup({
      backupPath: backup,
      destinationPath: path.join(root, "restore-weaponized"),
      appVersion: "test",
    }),
    /non-empty sensitive field/i,
  );
  assert.equal(fs.existsSync(path.join(root, "restore-weaponized")), false);
}));

test("restore rejects rehashed invite codes and raw provider credentials", () => withTempDir((root) => {
  const cases = [
    ["metadata.json", Buffer.from(JSON.stringify({ inviteCode: "AIF-LIVE-CANARY-CODE" })), /non-empty sensitive field/i],
    ["notes.md", Buffer.from(`pasted credential: ${fakeProviderCredential("ghp_")}\n`), /provider credential/i],
    ["unicode.cjs", Buffer.from('const api\\u004bey = "live-canary-secret";\n'), /credential literal assignment/i],
  ];
  for (const [index, [relative, weaponized, expected]] of cases.entries()) {
    const project = path.join(root, `project-${index}`);
    const backup = path.join(root, `backup-${index}.aifios-backup`);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, relative), relative.endsWith(".json") ? "{}" : "safe notes\n");
    exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });
    fs.writeFileSync(path.join(backup, DATA_DIRECTORY, relative), weaponized);
    rewriteManifest(backup, (manifest) => {
      const row = manifest.files.find((item) => item.path === relative);
      row.size = weaponized.length;
      row.sha256 = sha256Buffer(weaponized);
      manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
    });
    assert.throws(
      () => importProjectBackup({
        backupPath: backup,
        destinationPath: path.join(root, `restored-${index}`),
        appVersion: "test",
      }),
      expected,
    );
  }
}));

test("restore accepts only the sanitized LLM configuration schema", () => withTempDir((root) => {
  const project = path.join(root, "project");
  const backup = path.join(root, "backup.aifios-backup");
  const relative = "config/llm-config.json";
  fs.mkdirSync(path.join(project, "config"), { recursive: true });
  fs.writeFileSync(path.join(project, ...relative.split("/")), JSON.stringify({
    provider: "openai",
    model: "gpt-test",
    baseUrl: "https://api.example.test/v1",
    temperature: 0.7,
    maxTokens: 8000,
    apiKey: "removed-during-export",
  }));
  exportProjectBackup({ projectDir: project, backupPath: backup, appVersion: "test" });

  const weaponized = Buffer.from(`${JSON.stringify({
    provider: "openai",
    model: "gpt-test",
    apiKey: "[REDACTED]",
  })}\n`);
  fs.writeFileSync(path.join(backup, DATA_DIRECTORY, ...relative.split("/")), weaponized);
  rewriteManifest(backup, (manifest) => {
    const row = manifest.files.find((item) => item.path === relative);
    row.size = weaponized.length;
    row.sha256 = sha256Buffer(weaponized);
    manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  });

  assert.throws(
    () => importProjectBackup({
      backupPath: backup,
      destinationPath: path.join(root, "restore-unsafe-config"),
      appVersion: "test",
    }),
    /unsafe LLM configuration schema/i,
  );

  const credentialUrl = Buffer.from(`${JSON.stringify({
    provider: "openai",
    model: "gpt-test",
    baseUrl: "https://api.example.test/v1?api_key=live-query-secret",
  })}\n`);
  fs.writeFileSync(path.join(backup, DATA_DIRECTORY, ...relative.split("/")), credentialUrl);
  rewriteManifest(backup, (manifest) => {
    const row = manifest.files.find((item) => item.path === relative);
    row.size = credentialUrl.length;
    row.sha256 = sha256Buffer(credentialUrl);
    manifest.totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  });
  assert.throws(
    () => importProjectBackup({
      backupPath: backup,
      destinationPath: path.join(root, "restore-credential-url"),
      appVersion: "test",
    }),
    /unsafe base URL/i,
  );
  assert.equal(fs.existsSync(path.join(root, "restore-credential-url")), false);
}));

test("legacy project receives an automatic pre-migration backup before schema marker", () => withTempDir((root) => {
  const project = path.join(root, "legacy-project");
  const backupRoot = path.join(root, "automatic-backups");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "note.txt"), "legacy data");

  const result = ensureProjectSchema({
    projectDir: project,
    appVersion: "0.2.0-beta.2",
    backupRoot,
    now: new Date("2026-08-24T04:00:00.000Z"),
  });
  assert.equal(result.migrated, true);
  assert.equal(result.backup?.schema, PROJECT_BACKUP_SCHEMA);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, PROJECT_SCHEMA_FILE), "utf8")).schema, PROJECT_SCHEMA);
  const backupName = fs.readdirSync(backupRoot)[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, backupName, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.projectSchema, "aifios.project.v0");
  assert.equal(fs.existsSync(path.join(backupRoot, backupName, DATA_DIRECTORY, PROJECT_SCHEMA_FILE)), false);
}));

test("legacy mixed-project migration backs up unknown business data before writing its marker", () => withTempDir((root) => {
  const project = path.join(root, "legacy-mixed-project");
  const backupRoot = path.join(root, "automatic-backups");
  for (const directory of ["content_runtime", "schemas", "scripts", "skills", "brain", "materials", "pipeline", "runs", "client-archive"]) {
    fs.mkdirSync(path.join(project, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(project, "content_runtime", "cli.py"), [
    "from content_runtime.core import ContentRuntime",
    'DESCRIPTION = "content-runtime · AI Founder Influence OS"',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(project, "pyproject.toml"), [
    "[project]",
    'name = "content-runtime"',
    'description = "AI Founder Influence OS runtime"',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(project, "MASTER_PLAYBOOK.md"), "# AI FOUNDER INFLUENCE OS · 总控手册\n");
  fs.writeFileSync(path.join(project, "client-ledger.xlsx"), "customer spreadsheet bytes\n");
  fs.writeFileSync(path.join(project, "client-archive", "evidence.txt"), "customer evidence\n");

  const migrated = ensureProjectSchema({
    projectDir: project,
    appVersion: "0.2.0-beta.2",
    backupRoot,
    now: new Date("2026-08-24T08:00:00.000Z"),
  });
  assert.equal(migrated.migrated, true);
  const backupPath = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupPath, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.projection, "legacy-mixed-checkout-data");
  assert.equal(manifest.files.some((item) => item.path === "client-ledger.xlsx"), true);
  assert.equal(manifest.files.some((item) => item.path === "client-archive/evidence.txt"), true);
  assert.equal(manifest.files.some((item) => item.path === "content_runtime/cli.py"), false);
  const marker = JSON.parse(fs.readFileSync(path.join(project, PROJECT_SCHEMA_FILE), "utf8"));
  assert.equal(marker.schema, PROJECT_SCHEMA);
  assert.equal(marker.backupProjection, "legacy-mixed-checkout-data");
}));

test("legacy migration never writes its schema marker when the safety backup is blocked", () => withTempDir((root) => {
  const project = path.join(root, "legacy-project");
  const backupRoot = path.join(root, "automatic-backups");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "unsafe.conf"), "password=huntertwo\n");

  assert.throws(
    () => ensureProjectSchema({ projectDir: project, appVersion: "0.2.0-beta.2", backupRoot }),
    /high-confidence credential assignment/i,
  );
  assert.equal(fs.existsSync(path.join(project, PROJECT_SCHEMA_FILE)), false);
  assert.deepEqual(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [], []);
}));
