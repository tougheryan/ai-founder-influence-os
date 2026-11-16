const fs = require("fs");
const path = require("path");
const {
  PUBLICATION_CREDENTIAL_IDS,
  parsePublicationCredentialConfig,
} = require("./publication-bridge.cjs");

const CREDENTIAL_VAULT_SCHEMA = "aifios.credential-vault.v1";
const LEGACY_PUBLICATION_SCHEMA = "aifios.publication-credentials.v1";
const IMAGE_PROVIDER_CREDENTIALS = Object.freeze({
  image_openrouter: { env: "OPENROUTER_API_KEY", fields: ["apiKey"] },
  image_replicate: { env: "REPLICATE_API_TOKEN", fields: ["apiKey"] },
  image_ark: { env: "ARK_API_KEY", fields: ["apiKey"] },
  image_dashscope: { env: "DASHSCOPE_API_KEY", fields: ["apiKey", "workspaceId", "region"] },
  image_zai: { env: "ZAI_API_KEY", fields: ["apiKey"] },
  image_minimax: { env: "MINIMAX_API_KEY", fields: ["apiKey"] },
});
const CREDENTIAL_IDS = Object.freeze([
  "llm",
  "tikomni",
  ...Object.keys(IMAGE_PROVIDER_CREDENTIALS),
  ...PUBLICATION_CREDENTIAL_IDS,
]);
const CREDENTIAL_ID_SET = new Set(CREDENTIAL_IDS);
const LLM_PROVIDER_ENV_KEYS = Object.freeze({
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
  dashscope: "DASHSCOPE_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
});
const SERVICE_SECRET_ENV_KEYS = Object.freeze([
  ...Object.values(LLM_PROVIDER_ENV_KEYS),
  ...Object.values(IMAGE_PROVIDER_CREDENTIALS).map((entry) => entry.env),
  "ANTHROPIC_AUTH_TOKEN",
  "TIKOMNI_API_KEY",
  "TIKOMNI_API_TOKEN",
  "DASHSCOPE_WORKSPACE_ID",
  "DASHSCOPE_REGION",
]);
const SERVICE_TEST_ONLY_ENV_KEYS = Object.freeze([
  "AIFIOS_PUBLICATION_MOCK_ADAPTERS",
  "AIFIOS_ENABLE_DEMO_SURFACES",
  "AIFIOS_ENABLE_SMOKE_PROVIDER",
  "AIFIOS_SMOKE_PROVIDER_TOKEN",
  "AIFIOS_LOCK_TEST_LABEL",
  "AIFIOS_LOCK_TEST_READY_PATH",
  "AIFIOS_LOCK_TEST_BARRIER_PATH",
  "AIFIOS_LOCK_TEST_ACTIVE_PATH",
  "AIFIOS_LOCK_TEST_EVENT_PATH",
]);
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_TIKOMNI_TOKEN_BYTES = 4096;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRegularFile(filePath, maxBytes = MAX_STORE_BYTES) {
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error("Credential storage is not a safe regular file.");
  }
  return fs.readFileSync(filePath, "utf8");
}

function writePrivateFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.lstatSync(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Credential storage is not a safe regular file.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The atomic rename already consumed the temporary file.
    }
  }
}

function readJsonObject(filePath, fallback) {
  const content = readRegularFile(filePath);
  if (content === null) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Credential storage contains invalid JSON.");
  }
  if (!isPlainObject(parsed)) throw new Error("Credential storage contains invalid data.");
  return parsed;
}

function parseJsonObject(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${label} must be valid JSON.`);
    }
  }
  if (!isPlainObject(parsed)) throw new Error(`${label} must be an object.`);
  return parsed;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field.`);
  }
}

function normalizeLlmCredential(rawValue) {
  const value = parseJsonObject(rawValue, "LLM credential");
  assertOnlyKeys(value, new Set(["provider", "apiKey"]), "LLM credential");
  const provider = String(value.provider || "").trim().toLowerCase();
  const apiKey = String(value.apiKey || "").trim();
  if (!Object.prototype.hasOwnProperty.call(LLM_PROVIDER_ENV_KEYS, provider)) {
    throw new Error("Unsupported LLM provider credential.");
  }
  if (!apiKey || Buffer.byteLength(apiKey, "utf8") > MAX_CREDENTIAL_BYTES || /[\r\n\0]/.test(apiKey)) {
    throw new Error("LLM API key is invalid.");
  }
  return JSON.stringify({ provider, apiKey });
}

function normalizeTikomniCredential(rawValue) {
  let token = "";
  if (isPlainObject(rawValue)) {
    assertOnlyKeys(rawValue, new Set(["token"]), "TikOmni credential");
    token = String(rawValue.token || "").trim();
  } else {
    const raw = String(rawValue || "").trim();
    if (raw.startsWith("{")) {
      const parsed = parseJsonObject(raw, "TikOmni credential");
      assertOnlyKeys(parsed, new Set(["token"]), "TikOmni credential");
      token = String(parsed.token || "").trim();
    } else {
      token = raw;
    }
  }
  if (!token || Buffer.byteLength(token, "utf8") > MAX_TIKOMNI_TOKEN_BYTES || /[\r\n\0]/.test(token)) {
    throw new Error("TikOmni token is invalid.");
  }
  return token;
}

function normalizeImageProviderCredential(id, rawValue) {
  const definition = IMAGE_PROVIDER_CREDENTIALS[id];
  if (!definition) throw new Error("Unsupported image provider credential.");
  const value = isPlainObject(rawValue)
    ? rawValue
    : parseJsonObject(rawValue, "Image provider credential");
  assertOnlyKeys(value, new Set(definition.fields), "Image provider credential");
  const apiKey = String(value.apiKey || "").trim();
  if (!apiKey || Buffer.byteLength(apiKey, "utf8") > MAX_CREDENTIAL_BYTES || /[\r\n\0]/.test(apiKey)) {
    throw new Error("Image provider API key is invalid.");
  }
  if (id === "image_dashscope") {
    const workspaceId = String(value.workspaceId || "").trim();
    const region = String(value.region || "cn-beijing").trim();
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(workspaceId)) {
      throw new Error("DashScope Workspace ID is invalid.");
    }
    if (!["cn-beijing", "ap-southeast-1"].includes(region)) {
      throw new Error("DashScope region is invalid.");
    }
    return JSON.stringify({ apiKey, workspaceId, region });
  }
  return JSON.stringify({ apiKey });
}

function normalizeCredential(id, rawValue) {
  if (id === "llm") return normalizeLlmCredential(rawValue);
  if (id === "tikomni") return normalizeTikomniCredential(rawValue);
  if (Object.prototype.hasOwnProperty.call(IMAGE_PROVIDER_CREDENTIALS, id)) {
    return normalizeImageProviderCredential(id, rawValue);
  }
  return JSON.stringify(parsePublicationCredentialConfig(id, rawValue));
}

function parseEnvValues(content) {
  const values = {};
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) values[key] = value;
  }
  return values;
}

function removeEnvKeys(content, keys) {
  const rejected = new Set(keys);
  const lines = String(content || "").split(/\r?\n/).filter((rawLine) => {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !rejected.has(match[1]);
  });
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function createCredentialVault({ filePath, safeStorage, now = () => new Date() }) {
  if (!filePath || !safeStorage) throw new Error("Credential vault requires a storage path and safeStorage.");

  function assertId(rawId) {
    const id = String(rawId || "").trim();
    if (!CREDENTIAL_ID_SET.has(id)) throw new Error("Unsupported credential identifier.");
    return id;
  }

  function emptyStore() {
    return { schema: CREDENTIAL_VAULT_SCHEMA, entries: {} };
  }

  function readStore() {
    const parsed = readJsonObject(filePath, emptyStore());
    if (parsed.schema !== CREDENTIAL_VAULT_SCHEMA || !isPlainObject(parsed.entries)) {
      throw new Error("Credential vault schema is unsupported.");
    }
    return { schema: CREDENTIAL_VAULT_SCHEMA, entries: parsed.entries };
  }

  function writeStore(store) {
    writePrivateFile(filePath, `${JSON.stringify(store, null, 2)}\n`);
  }

  function status() {
    const store = readStore();
    return CREDENTIAL_IDS.map((id) => ({
      id,
      configured: Boolean(store.entries[id]?.ciphertext),
      updatedAt: typeof store.entries[id]?.updatedAt === "string" && Number.isFinite(Date.parse(store.entries[id].updatedAt))
        ? store.entries[id].updatedAt
        : null,
    }));
  }

  function read(rawId) {
    const id = assertId(rawId);
    const entry = readStore().entries[id];
    if (!entry?.ciphertext) return "";
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS keychain encryption is unavailable.");
    }
    try {
      return safeStorage.decryptString(Buffer.from(entry.ciphertext, "base64"));
    } catch {
      throw new Error("Encrypted credential cannot be decrypted on this device.");
    }
  }

  function save(rawId, rawValue) {
    const id = assertId(rawId);
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS keychain encryption is unavailable; credential was not saved.");
    }
    const normalized = normalizeCredential(id, rawValue);
    if (!normalized || Buffer.byteLength(normalized, "utf8") > MAX_CREDENTIAL_BYTES) {
      throw new Error("Credential value is invalid.");
    }
    const ciphertext = safeStorage.encryptString(normalized).toString("base64");
    const verified = safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
    if (verified !== normalized) throw new Error("Credential encryption verification failed.");
    const store = readStore();
    const updatedAt = now().toISOString();
    store.entries[id] = { ciphertext, updatedAt };
    writeStore(store);
    return { id, configured: true, updatedAt };
  }

  function remove(rawId) {
    const id = assertId(rawId);
    const store = readStore();
    delete store.entries[id];
    writeStore(store);
    return { id, configured: false, updatedAt: null };
  }

  function importEncrypted(rawId, ciphertext) {
    const id = assertId(rawId);
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS keychain encryption is unavailable; legacy credential was not migrated.");
    }
    if (typeof ciphertext !== "string" || !ciphertext || Buffer.byteLength(ciphertext, "utf8") > MAX_CREDENTIAL_BYTES * 2) {
      throw new Error("Legacy encrypted credential is invalid.");
    }
    let plaintext;
    try {
      plaintext = safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
    } catch {
      throw new Error("Legacy encrypted credential cannot be decrypted on this device.");
    }
    return save(id, plaintext);
  }

  function matchesEncrypted(rawId, ciphertext) {
    const id = assertId(rawId);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS keychain encryption is unavailable.");
    let plaintext;
    try {
      plaintext = safeStorage.decryptString(Buffer.from(String(ciphertext || ""), "base64"));
    } catch {
      throw new Error("Legacy encrypted credential cannot be decrypted on this device.");
    }
    return read(id) === normalizeCredential(id, plaintext);
  }

  function serviceEnvironment(baseEnvironment = {}) {
    const env = { ...baseEnvironment };
    for (const key of SERVICE_SECRET_ENV_KEYS) delete env[key];
    for (const key of SERVICE_TEST_ONLY_ENV_KEYS) delete env[key];
    delete env.AIFIOS_IMAGE_ACCOUNT_IDS;

    const llm = read("llm");
    if (llm) {
      const parsed = parseJsonObject(llm, "Encrypted LLM credential");
      const provider = String(parsed.provider || "").trim().toLowerCase();
      const apiKey = String(parsed.apiKey || "");
      const envKey = LLM_PROVIDER_ENV_KEYS[provider];
      if (!envKey || !apiKey) throw new Error("Encrypted LLM credential is invalid.");
      env[envKey] = apiKey;
    }

    const tikomni = read("tikomni");
    if (tikomni) env.TIKOMNI_API_KEY = tikomni;
    const configuredImageAccounts = [];
    for (const [id, definition] of Object.entries(IMAGE_PROVIDER_CREDENTIALS)) {
      const raw = read(id);
      if (!raw) continue;
      const parsed = parseJsonObject(raw, "Encrypted image provider credential");
      const apiKey = String(parsed.apiKey || "");
      if (!apiKey) throw new Error("Encrypted image provider credential is invalid.");
      configuredImageAccounts.push(id);
      env[definition.env] = apiKey;
      if (id === "image_dashscope") {
        env.DASHSCOPE_WORKSPACE_ID = String(parsed.workspaceId || "");
        env.DASHSCOPE_REGION = String(parsed.region || "cn-beijing");
      }
    }
    env.AIFIOS_IMAGE_ACCOUNT_IDS = configuredImageAccounts.join(",");
    return env;
  }

  return { filePath, status, read, save, delete: remove, importEncrypted, matchesEncrypted, serviceEnvironment };
}

function migrateLegacyPublicationCredentials({ vault, legacyFilePath }) {
  const content = readRegularFile(legacyFilePath);
  if (content === null) return { migrated: [], removedLegacyStore: false };
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Legacy publication credential store contains invalid JSON.");
  }
  if (!isPlainObject(parsed) || parsed.schema !== LEGACY_PUBLICATION_SCHEMA || !isPlainObject(parsed.entries)) {
    throw new Error("Legacy publication credential store schema is unsupported.");
  }
  for (const [id, entry] of Object.entries(parsed.entries)) {
    if (!PUBLICATION_CREDENTIAL_IDS.includes(id) || !isPlainObject(entry) || typeof entry.ciphertext !== "string" || !entry.ciphertext) {
      throw new Error("Legacy publication credential store contains an unsupported entry.");
    }
  }

  const configured = new Set(vault.status().filter((item) => item.configured).map((item) => item.id));
  const migrated = [];
  for (const id of PUBLICATION_CREDENTIAL_IDS) {
    const legacy = parsed.entries[id];
    if (!legacy?.ciphertext) continue;
    if (configured.has(id)) {
      if (!vault.matchesEncrypted(id, legacy.ciphertext)) {
        throw new Error("Legacy publication credential conflicts with the encrypted credential vault; old store was retained.");
      }
      continue;
    }
    vault.importEncrypted(id, legacy.ciphertext);
    migrated.push(id);
  }
  fs.unlinkSync(legacyFilePath);
  return { migrated, removedLegacyStore: true };
}

function migrateLegacyPlaintextCredentials({ vault, llmConfigPath, tikomniEnvPath, processEnvironment = null }) {
  const report = { llm: false, tikomni: false };
  const environment = processEnvironment || {};

  const llmContent = readRegularFile(llmConfigPath);
  let config = {};
  if (llmContent !== null && llmContent.trim()) {
    try {
      config = JSON.parse(llmContent);
    } catch {
      throw new Error("Legacy LLM configuration contains invalid JSON.");
    }
    if (!isPlainObject(config)) throw new Error("Legacy LLM configuration is invalid.");
  }
  const provider = String(config.provider || environment.DEFAULT_PROVIDER || "deepseek").trim().toLowerCase();
  const providerEnvKey = LLM_PROVIDER_ENV_KEYS[provider];
  const fileApiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const environmentApiKey = providerEnvKey
    ? String(environment[providerEnvKey] || (provider === "anthropic" ? environment.ANTHROPIC_AUTH_TOKEN : "") || "").trim()
    : "";
  const apiKey = fileApiKey || environmentApiKey;
  if (apiKey) {
    const alreadyConfigured = vault.status().some((item) => item.id === "llm" && item.configured);
    if (!alreadyConfigured) {
      vault.save("llm", { provider, apiKey });
    } else {
      const encrypted = parseJsonObject(vault.read("llm"), "Encrypted LLM credential");
      if (encrypted.provider !== provider || encrypted.apiKey !== apiKey) {
        throw new Error("Legacy LLM credential conflicts with the encrypted credential vault; plaintext was not removed.");
      }
    }
    if (!vault.read("llm")) throw new Error("Encrypted LLM credential verification failed.");
    if (fileApiKey) {
      delete config.apiKey;
      writePrivateFile(llmConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    if (providerEnvKey) delete environment[providerEnvKey];
    if (provider === "anthropic") delete environment.ANTHROPIC_AUTH_TOKEN;
    report.llm = true;
  }

  const tikomniContent = readRegularFile(tikomniEnvPath);
  const values = parseEnvValues(tikomniContent || "");
  const fileToken = String(values.TIKOMNI_API_KEY || values.TIKOMNI_API_TOKEN || "").trim();
  const environmentToken = String(environment.TIKOMNI_API_KEY || environment.TIKOMNI_API_TOKEN || "").trim();
  const token = fileToken || environmentToken;
  if (token) {
    const alreadyConfigured = vault.status().some((item) => item.id === "tikomni" && item.configured);
    if (!alreadyConfigured) {
      vault.save("tikomni", token);
    } else if (vault.read("tikomni") !== token) {
      throw new Error("Legacy TikOmni credential conflicts with the encrypted credential vault; plaintext was not removed.");
    }
    if (!vault.read("tikomni")) throw new Error("Encrypted TikOmni credential verification failed.");
    if (fileToken && tikomniContent !== null) {
      writePrivateFile(tikomniEnvPath, removeEnvKeys(tikomniContent, ["TIKOMNI_API_KEY", "TIKOMNI_API_TOKEN"]));
    }
    delete environment.TIKOMNI_API_KEY;
    delete environment.TIKOMNI_API_TOKEN;
    report.tikomni = true;
  }

  return report;
}

module.exports = {
  CREDENTIAL_IDS,
  CREDENTIAL_VAULT_SCHEMA,
  IMAGE_PROVIDER_CREDENTIALS,
  LEGACY_PUBLICATION_SCHEMA,
  LLM_PROVIDER_ENV_KEYS,
  SERVICE_SECRET_ENV_KEYS,
  SERVICE_TEST_ONLY_ENV_KEYS,
  createCredentialVault,
  migrateLegacyPlaintextCredentials,
  migrateLegacyPublicationCredentials,
  normalizeCredential,
  parseEnvValues,
  removeEnvKeys,
};
