const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CREDENTIAL_VAULT_SCHEMA,
  createCredentialVault,
  migrateLegacyPlaintextCredentials,
  migrateLegacyPublicationCredentials,
} = require("./credential-vault.cjs");

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => {
      const text = Buffer.from(value).toString("utf8");
      if (!text.startsWith("encrypted:")) throw new Error("invalid ciphertext");
      return text.slice("encrypted:".length);
    },
  };
}

function withTempDir(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aifios-vault-test-"));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("unified vault encrypts credentials and status never returns raw values", () => withTempDir((root) => {
  const filePath = path.join(root, "credential-vault.json");
  const vault = createCredentialVault({
    filePath,
    safeStorage: fakeSafeStorage(),
    now: () => new Date("2026-08-24T01:02:03.000Z"),
  });

  const saved = vault.save("llm", { provider: "openai", apiKey: "sk-secret" });
  vault.save("tikomni", "tik-secret");
  vault.save("image_openrouter", JSON.stringify({ apiKey: "or-secret" }));
  vault.save("wechat_browser_bridge", JSON.stringify({ editorUrl: "https://mp.weixin.qq.com/" }));

  assert.deepEqual(saved, {
    id: "llm",
    configured: true,
    updatedAt: "2026-08-24T01:02:03.000Z",
  });
  assert.equal(JSON.stringify(vault.status()).includes("sk-secret"), false);
  assert.equal(fs.readFileSync(filePath, "utf8").includes("sk-secret"), false);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).schema, CREDENTIAL_VAULT_SCHEMA);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const env = vault.serviceEnvironment({
    OPENAI_API_KEY: "stale-openai",
    DEEPSEEK_API_KEY: "stale-deepseek",
    TIKOMNI_API_TOKEN: "stale-tik",
    AIFIOS_PUBLICATION_MOCK_ADAPTERS: "1",
    AIFIOS_ENABLE_DEMO_SURFACES: "1",
    AIFIOS_ENABLE_SMOKE_PROVIDER: "1",
    AIFIOS_SMOKE_PROVIDER_TOKEN: "poisoned-smoke-token",
    AIFIOS_LOCK_TEST_LABEL: "poisoned-test-mode",
    SAFE_SETTING: "kept",
  });
  assert.equal(env.OPENAI_API_KEY, "sk-secret");
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.TIKOMNI_API_TOKEN, undefined);
  assert.equal(env.AIFIOS_PUBLICATION_MOCK_ADAPTERS, undefined);
  assert.equal(env.AIFIOS_ENABLE_DEMO_SURFACES, undefined);
  assert.equal(env.AIFIOS_ENABLE_SMOKE_PROVIDER, undefined);
  assert.equal(env.AIFIOS_SMOKE_PROVIDER_TOKEN, undefined);
  assert.equal(env.AIFIOS_LOCK_TEST_LABEL, undefined);
  assert.equal(env.TIKOMNI_API_KEY, "tik-secret");
  assert.equal(env.OPENROUTER_API_KEY, "or-secret");
  assert.equal(env.SAFE_SETTING, "kept");

  assert.deepEqual(vault.delete("llm"), { id: "llm", configured: false, updatedAt: null });
  assert.equal(vault.read("llm"), "");
}));

test("image provider credentials are separately encrypted and exposed only to the service environment", () => withTempDir((root) => {
  const filePath = path.join(root, "credential-vault.json");
  const vault = createCredentialVault({ filePath, safeStorage: fakeSafeStorage() });
  const credentials = {
    image_openrouter: ["OPENROUTER_API_KEY", "openrouter-secret"],
    image_replicate: ["REPLICATE_API_TOKEN", "replicate-secret"],
    image_ark: ["ARK_API_KEY", "ark-secret"],
    image_dashscope: ["DASHSCOPE_API_KEY", "dashscope-secret"],
    image_zai: ["ZAI_API_KEY", "zai-secret"],
    image_minimax: ["MINIMAX_API_KEY", "minimax-secret"],
  };
  for (const [id, [, secret]] of Object.entries(credentials)) {
    vault.save(id, JSON.stringify({
      apiKey: secret,
      ...(id === "image_dashscope" ? { workspaceId: "ws_benchmark", region: "cn-beijing" } : {}),
    }));
  }

  const serializedStatus = JSON.stringify(vault.status());
  const serializedStore = fs.readFileSync(filePath, "utf8");
  const environment = vault.serviceEnvironment();
  for (const [id, [envName, secret]] of Object.entries(credentials)) {
    assert.equal(vault.status().find((item) => item.id === id)?.configured, true);
    assert.equal(serializedStatus.includes(secret), false);
    assert.equal(serializedStore.includes(secret), false);
    assert.equal(environment[envName], secret);
  }
  assert.equal(environment.DASHSCOPE_WORKSPACE_ID, "ws_benchmark");
  assert.equal(environment.DASHSCOPE_REGION, "cn-beijing");
  assert.equal(environment.AIFIOS_IMAGE_ACCOUNT_IDS, Object.keys(credentials).join(","));
}));

test("credential status never reflects untrusted metadata from the encrypted store", () => withTempDir((root) => {
  const filePath = path.join(root, "credential-vault.json");
  const safeStorage = fakeSafeStorage();
  const ciphertext = safeStorage.encryptString(JSON.stringify({ provider: "openai", apiKey: "hidden" })).toString("base64");
  fs.writeFileSync(filePath, JSON.stringify({
    schema: CREDENTIAL_VAULT_SCHEMA,
    entries: {
      llm: { ciphertext, updatedAt: "/Users/alice/private-project/api-key.txt" },
    },
  }));

  const vault = createCredentialVault({ filePath, safeStorage });
  const llmStatus = vault.status().find((item) => item.id === "llm");
  assert.deepEqual(llmStatus, { id: "llm", configured: true, updatedAt: null });
  assert.doesNotMatch(JSON.stringify(vault.status()), /Users|private-project|api-key/i);
}));

test("plaintext LLM and TikOmni credentials migrate only after encrypted verification", () => withTempDir((root) => {
  const vault = createCredentialVault({
    filePath: path.join(root, "credential-vault.json"),
    safeStorage: fakeSafeStorage(),
  });
  const llmConfigPath = path.join(root, "project", "config", "llm-config.json");
  const tikomniEnvPath = path.join(root, "credentials", "tikomni.env");
  fs.mkdirSync(path.dirname(llmConfigPath), { recursive: true });
  fs.mkdirSync(path.dirname(tikomniEnvPath), { recursive: true });
  fs.writeFileSync(llmConfigPath, JSON.stringify({ provider: "deepseek", apiKey: "llm-plain", model: "chat" }));
  fs.writeFileSync(tikomniEnvPath, "TIKOMNI_API_BASE=https://example.test\nTIKOMNI_API_TOKEN=tik-plain\n");

  const result = migrateLegacyPlaintextCredentials({ vault, llmConfigPath, tikomniEnvPath });
  assert.deepEqual(result, { llm: true, tikomni: true });
  assert.deepEqual(JSON.parse(vault.read("llm")), { provider: "deepseek", apiKey: "llm-plain" });
  assert.equal(vault.read("tikomni"), "tik-plain");
  assert.deepEqual(JSON.parse(fs.readFileSync(llmConfigPath, "utf8")), { provider: "deepseek", model: "chat" });
  assert.equal(fs.readFileSync(tikomniEnvPath, "utf8"), "TIKOMNI_API_BASE=https://example.test\n");
}));

test("plaintext files remain untouched when OS encryption is unavailable", () => withTempDir((root) => {
  const vault = createCredentialVault({
    filePath: path.join(root, "credential-vault.json"),
    safeStorage: fakeSafeStorage(false),
  });
  const llmConfigPath = path.join(root, "llm-config.json");
  const tikomniEnvPath = path.join(root, "tikomni.env");
  const llm = JSON.stringify({ provider: "openai", apiKey: "must-remain" });
  fs.writeFileSync(llmConfigPath, llm);
  fs.writeFileSync(tikomniEnvPath, "TIKOMNI_API_KEY=must-remain\n");

  assert.throws(
    () => migrateLegacyPlaintextCredentials({ vault, llmConfigPath, tikomniEnvPath }),
    /keychain encryption is unavailable/i,
  );
  assert.equal(fs.readFileSync(llmConfigPath, "utf8"), llm);
  assert.equal(fs.readFileSync(tikomniEnvPath, "utf8"), "TIKOMNI_API_KEY=must-remain\n");
}));

test("desktop startup imports inherited LLM and TikOmni env secrets then clears its process copy", () => withTempDir((root) => {
  const vault = createCredentialVault({
    filePath: path.join(root, "credential-vault.json"),
    safeStorage: fakeSafeStorage(),
  });
  const environment = {
    DEFAULT_PROVIDER: "openai",
    OPENAI_API_KEY: "openai-env-secret",
    TIKOMNI_API_TOKEN: "tikomni-env-secret",
    SAFE_SETTING: "keep",
  };

  const result = migrateLegacyPlaintextCredentials({
    vault,
    llmConfigPath: path.join(root, "missing-llm.json"),
    tikomniEnvPath: path.join(root, "missing-tikomni.env"),
    processEnvironment: environment,
  });

  assert.deepEqual(result, { llm: true, tikomni: true });
  assert.deepEqual(JSON.parse(vault.read("llm")), { provider: "openai", apiKey: "openai-env-secret" });
  assert.equal(vault.read("tikomni"), "tikomni-env-secret");
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.TIKOMNI_API_TOKEN, undefined);
  assert.equal(environment.SAFE_SETTING, "keep");
}));

test("conflicting plaintext is never deleted when an encrypted credential already exists", () => withTempDir((root) => {
  const vault = createCredentialVault({
    filePath: path.join(root, "credential-vault.json"),
    safeStorage: fakeSafeStorage(),
  });
  vault.save("llm", { provider: "openai", apiKey: "encrypted-key" });
  const llmConfigPath = path.join(root, "llm-config.json");
  const original = JSON.stringify({ provider: "openai", apiKey: "different-plaintext-key", model: "test" });
  fs.writeFileSync(llmConfigPath, original);

  assert.throws(
    () => migrateLegacyPlaintextCredentials({
      vault,
      llmConfigPath,
      tikomniEnvPath: path.join(root, "missing-tikomni.env"),
    }),
    /conflicts with the encrypted credential vault/i,
  );
  assert.equal(fs.readFileSync(llmConfigPath, "utf8"), original);
  assert.deepEqual(JSON.parse(vault.read("llm")), { provider: "openai", apiKey: "encrypted-key" });
}));

test("legacy encrypted publication store is validated, imported, and removed", () => withTempDir((root) => {
  const safeStorage = fakeSafeStorage();
  const vault = createCredentialVault({
    filePath: path.join(root, "credential-vault.json"),
    safeStorage,
  });
  const legacyFilePath = path.join(root, "publication-credentials.json");
  const value = JSON.stringify({ editorUrl: "https://creator.xiaohongshu.com/publish/publish" });
  fs.writeFileSync(legacyFilePath, JSON.stringify({
    schema: "aifios.publication-credentials.v1",
    entries: {
      xiaohongshu_browser_bridge: {
        ciphertext: safeStorage.encryptString(value).toString("base64"),
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    },
  }));

  const result = migrateLegacyPublicationCredentials({ vault, legacyFilePath });
  assert.deepEqual(result, { migrated: ["xiaohongshu_browser_bridge"], removedLegacyStore: true });
  assert.equal(fs.existsSync(legacyFilePath), false);
  assert.deepEqual(JSON.parse(vault.read("xiaohongshu_browser_bridge")), JSON.parse(value));
}));

test("vault rejects malformed identifiers and unsafe publication configuration", () => withTempDir((root) => {
  const vault = createCredentialVault({
    filePath: path.join(root, "credential-vault.json"),
    safeStorage: fakeSafeStorage(),
  });
  assert.throws(() => vault.save("unknown", "secret"), /unsupported credential/i);
  assert.throws(
    () => vault.save("wechat_browser_bridge", JSON.stringify({ editorUrl: "https://evil.example/" })),
    /allowed platform URL/i,
  );
}));
