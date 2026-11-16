const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { TextDecoder } = require("util");

const PROJECT_BACKUP_SCHEMA = "aifios.project-backup.v1";
const PROJECT_SCHEMA = "aifios.project.v1";
const LEGACY_PROJECT_SCHEMA = "aifios.project.v0";
const PROJECT_SCHEMA_FILE = ".aifios-project.json";
const MANIFEST_FILE = "manifest.json";
const DATA_DIRECTORY = "data";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILE_COUNT = 200_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024 * 1024;
const MAX_STRUCTURED_JSON_BYTES = 16 * 1024 * 1024;
const CONTENT_SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_TEXT_SCAN_LINE_CHARS = 2 * 1024 * 1024;
const STREAM_SCAN_CONTEXT_CHARS = 64 * 1024;
const REDACTED_JSON_SENTINELS = new Set(["[REDACTED]", "[已脱敏]"]);
const SAFE_TEXT_CREDENTIAL_PLACEHOLDERS = new Set([
  "[redacted]",
  "[已脱敏]",
  "your-api-key",
  "your_api_key",
  "your-token",
  "your_token",
  "example-api-key",
  "example-token",
  "replace-me",
  "replace_me",
  "<api-key>",
  "<token>",
  "sk-your-api-key",
  "sk-proj-your-api-key",
  "sk-ant-your-api-key",
  "ghp_your-token",
  "github_pat_your-token",
  "sk_live_your-api-key",
]);
const SAFE_LLM_CONFIG_KEYS = new Set([
  "provider",
  "model",
  "baseUrl",
  "temperature",
  "maxTokens",
  "brandTemplates",
]);
const SAFE_BRAND_TEMPLATE_KEYS = new Set(["id", "label", "detail", "layoutStyle", "enabled"]);

const EXPECTED_TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cjs", ".conf", ".config", ".cpp", ".cs", ".css", ".csv", ".cxx", ".dart",
  ".env", ".go", ".gradle", ".graphql", ".h", ".hh", ".hpp", ".htm", ".html", ".hxx", ".ini",
  ".java", ".js", ".json", ".jsonl", ".jsx", ".key", ".kt", ".kts", ".lock", ".log", ".lua", ".md",
  ".mdx", ".mjs", ".pem", ".php", ".pl", ".pm", ".properties", ".py", ".r", ".rb", ".rs", ".scala",
  ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml",
  ".yml",
]);
const EXPECTED_TEXT_FILE_NAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "dockerfile",
  "gemfile",
  "makefile",
  "procfile",
  "rakefile",
]);
const SOURCE_EXPRESSION_EXTENSIONS = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".cs", ".cxx", ".dart", ".go", ".java", ".js", ".jsx", ".kt",
  ".kts", ".lua", ".mjs", ".php", ".py", ".r", ".rb", ".rs", ".scala", ".svelte", ".swift",
  ".ts", ".tsx", ".vue",
]);

const SENSITIVE_STRUCTURED_KEYS = new Set([
  "token",
  "apikey",
  "appsecret",
  "clientsecret",
  "secret",
  "password",
  "passwd",
  "cookie",
  "cookies",
  "setcookie",
  "cookieheader",
  "authorization",
  "authorizationheader",
  "authheader",
  "privatekey",
  "sessionsecret",
  "sessiontoken",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "idtoken",
  "csrftoken",
  "devicetoken",
  "oauthcode",
  "pairingtoken",
  "mobilebridgetoken",
  "signingsecret",
  "webhooksecret",
  "gatewaysession",
  "demounlockcode",
  "credential",
  "credentials",
  "passphrase",
]);

const SENSITIVE_TOKEN_KEY_SUFFIXES = [
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "idtoken",
  "csrftoken",
  "devicetoken",
  "oauthtoken",
  "sessiontoken",
  "pairingtoken",
  "mobilebridgetoken",
  "openaitoken",
  "anthropictoken",
  "deepseektoken",
  "geminitoken",
  "siliconflowtoken",
  "dashscopetoken",
  "moonshottoken",
  "tikomnitoken",
  "githubtoken",
  "gitlabtoken",
  "wechattoken",
  "xiaohongshutoken",
  "douyintoken",
];
const NON_CREDENTIAL_TOKEN_KEYS = new Set([
  "designtoken",
  "colortoken",
  "spacingtoken",
  "typographytoken",
  "canceltoken",
  "cancellationtoken",
  "continuationtoken",
  "paginationtoken",
  "pagetoken",
  "nextpagetoken",
  "xsectoken",
]);

const TEXT_SECRET_PATTERNS = [
  {
    label: "provider credential",
    valueGroups: ["providerCredential"],
    pattern: /\b(?<providerCredential>(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}|(?:sk|rk)_live_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}))\b/i,
  },
  {
    label: "authorization bearer header",
    pattern: /(?:^|[\r\n])[^\S\r\n]*(?:proxy-)?authorization[^\S\r\n]*:[^\S\r\n]*bearer[ \t]+[A-Za-z0-9._~+/=-]{12,}/i,
  },
  {
    label: "private key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  },
  {
    label: "credential literal assignment",
    identifierGroups: ["assignmentIdentifier"],
    valueGroups: ["assignmentDoubleValue", "assignmentSingleValue", "assignmentTemplateValue"],
    // Source expressions are allowed, but a credential-named assignment or
    // call argument containing an actual string literal is not. This covers
    // `const apiKey = "..."`, `settings.api_key = "..."`, and
    // `client(api_key="...")` without matching `api_key=get_key()`.
    pattern: /(?:^|[^A-Za-z0-9_$])(?<assignmentIdentifier>\$?(?:\\u[0-9A-Fa-f]{4}|[A-Za-z_$])(?:\\u[0-9A-Fa-f]{4}|[A-Za-z0-9_$.-])*)(?:\s*:\s*[^=\r\n]{1,128})?\s*(?:\?\?=|\|\|=|&&=|\+=|:=|=|:)\s*(?:\(\s*)*[bBrRuUfF]{0,3}(?:"(?<assignmentDoubleValue>[^"\r\n]+)"|'(?<assignmentSingleValue>[^'\r\n]+)'|`(?<assignmentTemplateValue>[^`\r\n]+)`)/im,
  },
  {
    label: "credential fallback literal assignment",
    identifierGroups: ["fallbackIdentifier"],
    valueGroups: ["fallbackDoubleValue", "fallbackSingleValue"],
    // Environment lookup defaults are still stored literals and must never be
    // projected into a customer backup.
    pattern: /(?:^|[^A-Za-z0-9_$])(?<fallbackIdentifier>\$?(?:\\u[0-9A-Fa-f]{4}|[A-Za-z_$])(?:\\u[0-9A-Fa-f]{4}|[A-Za-z0-9_$.-])*)(?:\s*:\s*[^=\r\n]{1,128})?\s*=\s*(?:os\.(?:getenv|environ\.get)|getenv)\s*\(\s*["'][A-Za-z_][A-Za-z0-9_]*["']\s*,\s*[bBrRuUfF]{0,3}(?:"(?<fallbackDoubleValue>[^"\r\n]+)"|'(?<fallbackSingleValue>[^'\r\n]+)')/im,
  },
  {
    label: "credential expression fallback literal assignment",
    identifierGroups: ["expressionFallbackIdentifier"],
    valueGroups: ["expressionFallbackDoubleValue", "expressionFallbackSingleValue", "expressionFallbackTemplateValue"],
    pattern: /(?:^|[^A-Za-z0-9_$])(?<expressionFallbackIdentifier>\$?(?:\\u[0-9A-Fa-f]{4}|[A-Za-z_$])(?:\\u[0-9A-Fa-f]{4}|[A-Za-z0-9_$.-])*)(?:\s*:\s*[^=\r\n]{1,128})?\s*=\s*[^\r\n]{1,512}?(?:\|\||\?\?|\bor\b)\s*[bBrRuUfF]{0,3}(?:"(?<expressionFallbackDoubleValue>[^"\r\n]+)"|'(?<expressionFallbackSingleValue>[^'\r\n]+)'|`(?<expressionFallbackTemplateValue>[^`\r\n]+)`)/im,
  },
  {
    label: "credential indexed literal assignment",
    identifierGroups: ["indexedIdentifier"],
    valueGroups: ["indexedDoubleValue", "indexedSingleValue", "indexedTemplateValue"],
    pattern: /(?:^|[^A-Za-z0-9_$])(?:[A-Za-z_$][A-Za-z0-9_$]*\s*)?\[\s*["'](?<indexedIdentifier>(?:\\u[0-9A-Fa-f]{4}|[A-Za-z0-9_$.-])+)["']\s*\]\s*(?:\?\?=|\|\|=|&&=|\+=|:=|=|:)\s*[bBrRuUfF]{0,3}(?:"(?<indexedDoubleValue>[^"\r\n]+)"|'(?<indexedSingleValue>[^'\r\n]+)'|`(?<indexedTemplateValue>[^`\r\n]+)`)/im,
  },
  {
    label: "credential assignment",
    identifierGroups: ["assignmentBareIdentifier"],
    valueGroups: ["assignmentBareValue"],
    // A complete unquoted single-token value is fail-closed regardless of the
    // filename. Calls/property lookups contain syntax outside this value class
    // and are handled as expressions instead of stored credential literals.
    pattern: /(?:^|[\r\n])[^\S\r\n]*(?:export[ \t]+)?(?<assignmentBareIdentifier>(?:\\u[0-9A-Fa-f]{4}|[A-Za-z_$])(?:\\u[0-9A-Fa-f]{4}|[A-Za-z0-9_$.-])*)[^\S\r\n]*(?:\?\?=|\|\|=|&&=|\+=|:=|=|:)[^\S\r\n]*(?<assignmentBareValue>[A-Za-z0-9._~+/=-]+)[^\S\r\n]*;?[^\S\r\n]*(?:#.*)?(?=$|[\r\n])/im,
  },
  {
    label: "credential unquoted assignment",
    extensions: [".conf", ".config", ".env", ".ini", ".properties", ".toml", ".yaml", ".yml"],
    identifierGroups: ["assignmentRemainderIdentifier"],
    valueGroups: ["assignmentRemainderValue"],
    pattern: /(?:^|[\r\n])[^\S\r\n]*(?:export[ \t]+)?(?<assignmentRemainderIdentifier>(?:\\u[0-9A-Fa-f]{4}|[A-Za-z_$])(?:\\u[0-9A-Fa-f]{4}|[A-Za-z0-9_$.-])*)[^\S\r\n]*(?:\?\?=|\|\|=|&&=|\+=|:=|=|:)[^\S\r\n]*(?<assignmentRemainderValue>[^\r\n#;]+?)[^\S\r\n]*(?:[;#].*)?(?=$|[\r\n])/im,
  },
  {
    label: "JSON credential field",
    identifierGroups: ["jsonIdentifier"],
    valueGroups: ["jsonDoubleValue", "jsonSingleValue"],
    pattern: /["'](?<jsonIdentifier>(?:\\u[0-9A-Fa-f]{4}|[A-Za-z0-9_$.-])+)["']\s*:\s*(?:"(?<jsonDoubleValue>[^"\r\n]+)"|'(?<jsonSingleValue>[^'\r\n]+)'|[1-9][0-9]*|true|\[[^\]]|\{[^}])/i,
  },
];

const EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "credentials",
  ".credentials",
  "auth-cache",
  ".auth-cache",
  "cookies",
  ".cookies",
  "browser-profile",
  "browser-profiles",
  "browser-data",
  "browser-session",
  "session-storage",
  "session storage",
  "sessionstore-backups",
  "storage_state",
  "storage-state",
  "user-data",
  ".docker",
  ".gnupg",
  ".kube",
  ".ssh",
  ".playwright",
  "playwright-profile",
]);

const EXCLUDED_TOP_LEVEL_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  "cache",
  "caches",
  "coverage",
  "dist",
  "build",
  "logs",
  "tmp",
  "temp",
]);
const EXPORT_ONLY_EXCLUDED_DIRECTORY_NAMES = new Set([
  "__pycache__",
]);
const EXPORT_ONLY_EXCLUDED_TOP_LEVEL_DIRECTORY_NAMES = new Set([
  ".pytest_cache",
]);

const EXCLUDED_RELATIVE_DIRECTORY_PATHS = new Set([
  "sessions/idempotency",
  "sessions/locks",
]);

const LEGACY_MIXED_PROJECT_SOURCE_DIRECTORIES = new Set([
  ".aifios-demo",
  ".github",
  "content_runtime",
  "schemas",
  "scripts",
  "skills",
  "ui",
]);
const LEGACY_MIXED_PROJECT_TEST_SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".cs", ".cxx", ".go", ".h", ".hh", ".hpp", ".hxx", ".java",
  ".js", ".jsx", ".kt", ".kts", ".mjs", ".php", ".py", ".pyi", ".rb", ".rs", ".sh", ".swift",
  ".ts", ".tsx",
]);
const LEGACY_MIXED_PROJECT_SOURCE_ROOT_FILES = new Set([
  "agents.md",
  "claude.md",
  "license",
  "license.md",
  "makefile",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "readme.md",
  "requirements-dev.txt",
  "requirements.txt",
  "tsconfig.json",
  "yarn.lock",
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".cookie",
  ".cookies",
  ".credentials.json",
  "cookie.json",
  "cookies.json",
  "cookies.sqlite",
  "cookies.sqlite-shm",
  "cookies.sqlite-wal",
  "cookies",
  "cookies-journal",
  "cookies-wal",
  "cookies-shm",
  "storage_state.json",
  "storage-state.json",
  "current session",
  "current tabs",
  "last session",
  "last tabs",
  "session.sqlite",
  "session.sqlite-shm",
  "session.sqlite-wal",
  "cookies.binarycookies",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "sessionstore.jsonlz4",
  "credential.json",
  "credentials.json",
  "publication-credentials.json",
  "wechat-official-token.json",
]);
const EXCLUDED_CREDENTIAL_FILE_EXTENSIONS = new Set([
  ".jks",
  ".keystore",
  ".p12",
  ".pfx",
]);

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fileIdentity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function normalizedSensitiveKey(value) {
  const decoded = String(value || "").replace(/\\u([0-9A-Fa-f]{4})/g, (_match, code) => (
    String.fromCharCode(Number.parseInt(code, 16))
  ));
  return decoded.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveStructuredKey(value) {
  const normalized = normalizedSensitiveKey(value);
  if (SENSITIVE_STRUCTURED_KEYS.has(normalized)) return true;
  const isCredentialToken = normalized.endsWith("token") && !NON_CREDENTIAL_TOKEN_KEYS.has(normalized);
  return normalized.endsWith("apikey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("privatekeybase64")
    || normalized.endsWith("secretkey")
    || normalized.endsWith("secretaccesskey")
    || normalized.endsWith("encryptionkey")
    || normalized.endsWith("accountkey")
    || normalized.endsWith("clientkeydata")
    || normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("appsecret")
    || normalized.endsWith("clientsecret")
    || normalized.endsWith("sessionsecret")
    || normalized.endsWith("signingsecret")
    || normalized.endsWith("webhooksecret")
    || normalized.endsWith("cookie")
    || normalized.endsWith("authorization")
    || normalized.endsWith("invitecode")
    || normalized.endsWith("invitecodes")
    || normalized.endsWith("activationcode")
    || normalized.endsWith("activationcodes")
    || normalized.endsWith("authorizationcode")
    || normalized.endsWith("authorizationcodes")
    || normalized.endsWith("unlockcode")
    || normalized.endsWith("unlockcodes")
    || normalized.endsWith("tokenpepper")
    || normalized.endsWith("demounlockcodes")
    || isCredentialToken
    || SENSITIVE_TOKEN_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function hasNonEmptySensitiveValue(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 && !REDACTED_JSON_SENTINELS.has(normalized);
  }
  if (typeof value === "number" || typeof value === "bigint") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function assertSafeText(value, field, maximumLength, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > maximumLength || (!allowEmpty && !value.trim())) {
    throw new Error(`LLM configuration contains an invalid ${field}.`);
  }
  if (countUnexpectedControlCharacters(value) > 0) {
    throw new Error(`LLM configuration contains an invalid ${field}.`);
  }
  return value;
}

function normalizeSafeBaseUrl(value) {
  const normalized = assertSafeText(value, "base URL", 2048, { allowEmpty: true }).trim();
  if (!normalized) return "";
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("LLM configuration contains an invalid base URL.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)
    || parsed.username || parsed.password || parsed.hash) {
    throw new Error("LLM configuration contains an unsafe base URL.");
  }
  for (const key of parsed.searchParams.keys()) {
    const normalizedKey = normalizedSensitiveKey(key);
    if (normalizedKey === "key" || isSensitiveStructuredKey(key)) {
      throw new Error("LLM configuration contains an unsafe base URL.");
    }
  }
  return normalized;
}

function normalizeSafeBrandTemplates(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error("LLM configuration contains invalid brand templates.");
  }
  const identifiers = new Set();
  let enabledCount = 0;
  const templates = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).some((key) => !SAFE_BRAND_TEMPLATE_KEYS.has(key))) {
      throw new Error("LLM configuration contains invalid brand templates.");
    }
    const id = assertSafeText(candidate.id, "brand template id", 64).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || identifiers.has(id)) {
      throw new Error("LLM configuration contains invalid brand templates.");
    }
    identifiers.add(id);
    if (typeof candidate.enabled !== "boolean") {
      throw new Error("LLM configuration contains invalid brand templates.");
    }
    if (candidate.enabled) enabledCount += 1;
    return {
      id,
      label: assertSafeText(candidate.label, "brand template label", 40).trim(),
      detail: assertSafeText(candidate.detail, "brand template detail", 160).trim(),
      layoutStyle: assertSafeText(candidate.layoutStyle, "brand template layout", 64).trim(),
      enabled: candidate.enabled,
    };
  });
  if (enabledCount === 0) throw new Error("LLM configuration contains invalid brand templates.");
  return templates;
}

function normalizeSafeLlmConfig(value, { rejectUnknown = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LLM configuration is invalid and cannot be backed up safely.");
  }
  if (rejectUnknown && Object.keys(value).some((key) => !SAFE_LLM_CONFIG_KEYS.has(key))) {
    throw new Error("Project backup contains an unsafe LLM configuration schema.");
  }
  const result = {};
  if (Object.prototype.hasOwnProperty.call(value, "provider")) {
    result.provider = assertSafeText(value.provider, "provider", 64).trim();
  }
  if (Object.prototype.hasOwnProperty.call(value, "model")) {
    result.model = assertSafeText(value.model, "model", 256).trim();
  }
  if (Object.prototype.hasOwnProperty.call(value, "baseUrl")) {
    result.baseUrl = normalizeSafeBaseUrl(value.baseUrl);
  }
  if (Object.prototype.hasOwnProperty.call(value, "temperature")) {
    if (typeof value.temperature !== "number" || !Number.isFinite(value.temperature)
      || value.temperature < 0 || value.temperature > 2) {
      throw new Error("LLM configuration contains an invalid temperature.");
    }
    result.temperature = value.temperature;
  }
  if (Object.prototype.hasOwnProperty.call(value, "maxTokens")) {
    if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 1_000_000) {
      throw new Error("LLM configuration contains an invalid maxTokens value.");
    }
    result.maxTokens = value.maxTokens;
  }
  if (Object.prototype.hasOwnProperty.call(value, "brandTemplates")) {
    result.brandTemplates = normalizeSafeBrandTemplates(value.brandTemplates);
  }
  return result;
}

function findSensitiveStructuredField(value, location = "$") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findSensitiveStructuredField(value[index], `${location}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    const nextLocation = `${location}.${key}`;
    if (isSensitiveStructuredKey(key) && hasNonEmptySensitiveValue(nestedValue)) {
      return nextLocation;
    }
    const nested = findSensitiveStructuredField(nestedValue, nextLocation);
    if (nested) return nested;
  }
  return null;
}

function stripSensitiveStructuredFields(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) stripSensitiveStructuredFields(item);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (isSensitiveStructuredKey(key)) delete value[key];
    else stripSensitiveStructuredFields(value[key]);
  }
  return value;
}

function isSafeTextCredentialValue(value) {
  const trimmed = String(value || "").trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return true;
  if ((normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    return isSafeTextCredentialValue(trimmed.slice(1, -1));
  }
  if (["false", "null", "none", "~"].includes(normalized)) return true;
  if (SAFE_TEXT_CREDENTIAL_PLACEHOLDERS.has(normalized)) return true;
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized)
    || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
    || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(normalized)
    || /^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
    || /^(?:args|cfg|config|settings|self|options)\.[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
    || /^\$\{process\.env\.[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized)
    || /^\{os\.environ\[['"][A-Za-z_][A-Za-z0-9_]*['"]\]\}$/.test(normalized)
    || /^\{os\.getenv\(['"][A-Za-z_][A-Za-z0-9_]*['"]\)\}$/.test(normalized)
    || /^os\.environ\[['"][A-Za-z_][A-Za-z0-9_]*['"]\]$/.test(normalized)
    || /^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*\(\)$/.test(trimmed)
    || /^[A-Za-z_$][A-Za-z0-9_$]*\.get\(["'][A-Za-z0-9_$.-]+["'][ \t]*,[ \t]*(?:""|'')\)$/.test(trimmed)
    || /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*[ \t]*=[ \t]*(?:""|'')$/.test(trimmed);
}

function hasSafeCredentialValueTail(content, match) {
  const lineTail = content.slice((match.index || 0) + match[0].length).split(/\r?\n/, 1)[0];
  return /^[ \t]*(?:[)\]}][ \t]*)*(?:[,;]|#|\/\/|$)/.test(lineTail);
}

function findHighConfidenceTextSecret(content, relativePath = "") {
  for (const candidate of TEXT_SECRET_PATTERNS) {
    if (Array.isArray(candidate.extensions)
      && !candidate.extensions.includes(path.extname(relativePath).toLowerCase())) continue;
    const flags = candidate.pattern.flags.includes("g")
      ? candidate.pattern.flags
      : `${candidate.pattern.flags}g`;
    const matcher = new RegExp(candidate.pattern.source, flags);
    for (const match of content.matchAll(matcher)) {
      if (Array.isArray(candidate.identifierGroups)) {
        const identifier = candidate.identifierGroups
          .map((name) => match.groups?.[name])
          .find((value) => typeof value === "string");
        if (identifier === undefined || !isSensitiveStructuredKey(identifier)) continue;
      }
      if (Array.isArray(candidate.valueGroups)) {
        const capturedValue = candidate.valueGroups
          .map((name) => match.groups?.[name])
          .find((value) => typeof value === "string");
        const sourceIdentifierExpression = candidate.label === "credential assignment"
          && SOURCE_EXPRESSION_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
          && /^[A-Z_][A-Z0-9_]*$/.test(String(capturedValue || "").trim());
        if (capturedValue !== undefined
          && (isSafeTextCredentialValue(capturedValue) || sourceIdentifierExpression)
          && hasSafeCredentialValueTail(content, match)) continue;
      }
      return candidate.label;
    }
  }
  return null;
}

function countUnexpectedControlCharacters(content) {
  return (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
}

function startsWithBytes(buffer, bytes) {
  return buffer.length >= bytes.length && bytes.every((value, index) => buffer[index] === value);
}

function hasKnownBinarySignature(buffer) {
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true;
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return true;
  if (startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04])
    || startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06])
    || startsWithBytes(buffer, [0x50, 0x4b, 0x07, 0x08])) return true;
  if (startsWithBytes(buffer, [0x1f, 0x8b]) || startsWithBytes(buffer, [0x42, 0x5a, 0x68])) return true;
  if (startsWithBytes(buffer, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return true;
  if (startsWithBytes(buffer, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return true;
  if (startsWithBytes(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return true;
  if (startsWithBytes(buffer, [0x47, 0x49, 0x46, 0x38])) return true;
  if (startsWithBytes(buffer, [0x42, 0x4d]) || startsWithBytes(buffer, [0x49, 0x49, 0x2a, 0x00])) return true;
  if (startsWithBytes(buffer, [0x4d, 0x4d, 0x00, 0x2a])) return true;
  if (startsWithBytes(buffer, [0x52, 0x49, 0x46, 0x46])) return true;
  if (startsWithBytes(buffer, [0x66, 0x4c, 0x61, 0x43]) || startsWithBytes(buffer, [0x4f, 0x67, 0x67, 0x53])) return true;
  if (startsWithBytes(buffer, [0x49, 0x44, 0x33])) return true;
  if (startsWithBytes(buffer, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])) return true;
  if (startsWithBytes(buffer, [0x00, 0x01, 0x00, 0x00]) || startsWithBytes(buffer, [0x4f, 0x54, 0x54, 0x4f])) return true;
  return buffer.length >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

function inspectOpenBackupDescriptor(relativePath, descriptor, suppliedInfo = null) {
  const extension = path.extname(relativePath).toLowerCase();
  const declaredJson = extension === ".json";
  const expectedText = EXPECTED_TEXT_EXTENSIONS.has(extension)
    || EXPECTED_TEXT_FILE_NAMES.has(path.basename(relativePath).toLowerCase());
  const beforeInfo = suppliedInfo || fs.fstatSync(descriptor);
  if (!beforeInfo.isFile() || beforeInfo.size > MAX_FILE_BYTES) {
    throw new Error("Backup contains an unsafe or oversized file.");
  }
  const before = fileIdentity(beforeInfo);
  if (before.size === 0) return before;
  if (declaredJson && before.size > MAX_STRUCTURED_JSON_BYTES) {
    throw new Error(`Backup blocked because ${relativePath} is too large for safe structured credential inspection.`);
  }
  const header = Buffer.allocUnsafe(Math.min(32, before.size));
  const headerBytes = fs.readSync(descriptor, header, 0, header.length, 0);
  if (headerBytes !== header.length) throw new Error("Backup file changed while it was being inspected.");
  if (hasKnownBinarySignature(header)) {
    if (expectedText) {
      throw new Error(`Backup blocked because ${relativePath} is not valid inspectable text.`);
    }
    return before;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(Math.min(CONTENT_SCAN_CHUNK_BYTES, Math.max(1, before.size)));
  const structuredBuffers = before.size <= MAX_STRUCTURED_JSON_BYTES ? [] : null;
  let offset = 0;
  let carry = "";
  let finding = null;
  let firstNonWhitespaceCharacter = "";
  let decodedCharacters = 0;
  let unexpectedControls = 0;
  let binaryEvidence = false;

  while (offset < before.size) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
    if (bytesRead <= 0) throw new Error("Backup file changed while it was being inspected.");
    const chunk = buffer.subarray(0, bytesRead);
    if (structuredBuffers) structuredBuffers.push(Buffer.from(chunk));
    if (chunk.includes(0)) binaryEvidence = true;
    if (!binaryEvidence) {
      let decoded;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        binaryEvidence = true;
      }
      if (!binaryEvidence) {
        decodedCharacters += decoded.length;
        unexpectedControls += countUnexpectedControlCharacters(decoded);
        if (!firstNonWhitespaceCharacter) {
          firstNonWhitespaceCharacter = decoded.match(/[^\s\uFEFF]/u)?.[0] || "";
        }
        if (!declaredJson) {
          const candidate = `${carry}${decoded}`;
          if (!finding) finding = findHighConfidenceTextSecret(candidate, relativePath);
          const lastLineBreak = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf("\r"));
          const currentLine = lastLineBreak >= 0 ? candidate.slice(lastLineBreak + 1) : candidate;
          if (currentLine.length > MAX_TEXT_SCAN_LINE_CHARS) {
            throw new Error(`Backup blocked because ${relativePath} contains a text line too large for safe credential inspection.`);
          }
          carry = lastLineBreak >= 0
            ? candidate.slice(Math.max(0, lastLineBreak - STREAM_SCAN_CONTEXT_CHARS))
            : currentLine;
        }
      }
    }
    offset += bytesRead;
    if (binaryEvidence) break;
  }
  if (!binaryEvidence) {
    let decoded;
    try {
      decoded = decoder.decode();
    } catch {
      binaryEvidence = true;
    }
    if (!binaryEvidence) {
      decodedCharacters += decoded.length;
      unexpectedControls += countUnexpectedControlCharacters(decoded);
      if (!firstNonWhitespaceCharacter) {
        firstNonWhitespaceCharacter = decoded.match(/[^\s\uFEFF]/u)?.[0] || "";
      }
      if (!declaredJson) {
        const finalCandidate = `${carry}${decoded}`;
        const lastLineBreak = Math.max(finalCandidate.lastIndexOf("\n"), finalCandidate.lastIndexOf("\r"));
        const currentLine = lastLineBreak >= 0 ? finalCandidate.slice(lastLineBreak + 1) : finalCandidate;
        if (currentLine.length > MAX_TEXT_SCAN_LINE_CHARS) {
          throw new Error(`Backup blocked because ${relativePath} contains a text line too large for safe credential inspection.`);
        }
        if (!finding) finding = findHighConfidenceTextSecret(finalCandidate, relativePath);
      }
    }
  }

  const after = fileIdentity(fs.fstatSync(descriptor));
  if (!sameFileIdentity(before, after)) {
    throw new Error("Backup file changed while it was being inspected.");
  }
  const excessiveControls = decodedCharacters > 0 && unexpectedControls / decodedCharacters > 0.02;
  if (binaryEvidence || excessiveControls) {
    if (expectedText) {
      throw new Error(`Backup blocked because ${relativePath} is not valid inspectable text.`);
    }
    return before;
  }

  const looksLikeJson = firstNonWhitespaceCharacter === "{" || firstNonWhitespaceCharacter === "[";
  if (!structuredBuffers && looksLikeJson) {
    throw new Error(`Backup blocked because ${relativePath} is too large for safe structured credential inspection.`);
  }
  const bufferedText = structuredBuffers
    ? Buffer.concat(structuredBuffers, before.size).toString("utf8").replace(/^\uFEFF/, "")
    : null;
  if (bufferedText !== null) {
    finding = finding || findHighConfidenceTextSecret(bufferedText, relativePath);
  }
  if (structuredBuffers && (declaredJson || looksLikeJson)) {
    const jsonText = bufferedText;
    let parsed;
    let parsedOk = false;
    try {
      parsed = JSON.parse(jsonText);
      parsedOk = true;
    } catch {
      if (declaredJson) {
        throw new Error(`Backup blocked because ${relativePath} contains invalid JSON that cannot be inspected safely.`);
      }
    }
    if (parsedOk) {
      const sensitiveField = findSensitiveStructuredField(parsed);
      if (sensitiveField) {
        throw new Error(`Backup blocked because ${relativePath} contains a non-empty sensitive field (${sensitiveField}).`);
      }
      if (relativePath.toLowerCase() === "config/llm-config.json") {
        normalizeSafeLlmConfig(parsed, { rejectUnknown: true });
      }
    }
  }
  if (finding) {
    throw new Error(`Backup blocked because ${relativePath} contains a high-confidence ${finding}.`);
  }
  return before;
}

function inspectBackupCandidate(relativePath, absolutePath) {
  const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    return inspectOpenBackupDescriptor(relativePath, descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertBufferSafeForBackup(relativePath, buffer) {
  const extension = path.extname(relativePath).toLowerCase();
  if (buffer.length === 0 || hasKnownBinarySignature(buffer.subarray(0, 32))) return;
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Backup blocked because ${relativePath} is not valid inspectable text.`);
  }
  const normalizedContent = content.replace(/^\uFEFF/, "");
  const firstNonWhitespaceCharacter = normalizedContent.match(/[^\s]/u)?.[0] || "";
  const looksLikeJson = firstNonWhitespaceCharacter === "{" || firstNonWhitespaceCharacter === "[";
  if (extension === ".json" || looksLikeJson) {
    let parsed;
    try {
      parsed = JSON.parse(normalizedContent);
    } catch {
      if (extension === ".json") {
        throw new Error(`Backup blocked because ${relativePath} contains invalid JSON that cannot be inspected safely.`);
      }
    }
    if (parsed !== undefined) {
      const sensitiveField = findSensitiveStructuredField(parsed);
      if (sensitiveField) {
        throw new Error(`Backup blocked because ${relativePath} contains a non-empty sensitive field (${sensitiveField}).`);
      }
    }
  }
  const finding = findHighConfidenceTextSecret(content, relativePath);
  if (finding) throw new Error(`Backup blocked because ${relativePath} contains a high-confidence ${finding}.`);
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Backup contains an unsafe or oversized file.");
    let bytesRead = 0;
    let totalBytes = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        totalBytes += bytesRead;
        if (totalBytes > MAX_FILE_BYTES) throw new Error("Backup contains an oversized file.");
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
    const after = fs.fstatSync(descriptor);
    if (totalBytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("Backup file changed while it was being verified.");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function copyRegularFileSafely(
  sourcePath,
  targetPath,
  maxBytes = MAX_FILE_BYTES,
  inspectedIdentity = null,
  inspectRelativePath = null,
) {
  const source = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let target;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = fs.fstatSync(source);
    if (!before.isFile() || before.size > maxBytes) throw new Error("Backup contains an unsafe or oversized file.");
    const beforeIdentity = fileIdentity(before);
    if (inspectedIdentity && !sameFileIdentity(inspectedIdentity, beforeIdentity)) {
      throw new Error("Backup file changed after its sensitive-content inspection.");
    }
    if (inspectRelativePath) {
      const inspected = inspectOpenBackupDescriptor(inspectRelativePath, source, before);
      if (!sameFileIdentity(inspected, beforeIdentity)) {
        throw new Error("Backup file changed during its sensitive-content inspection.");
      }
    }
    target = fs.openSync(targetPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let offset = 0;
    while (offset < before.size) {
      const bytesRead = fs.readSync(source, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead <= 0) throw new Error("Backup file changed while it was being copied.");
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(target, buffer, written, bytesRead - written, offset + written);
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fileIdentity(fs.fstatSync(source));
    if (!sameFileIdentity(beforeIdentity, after)) {
      throw new Error("Backup file changed while it was being copied.");
    }
    fs.fsyncSync(target);
    return { size: before.size, sha256: hash.digest("hex") };
  } finally {
    if (target !== undefined) fs.closeSync(target);
    fs.closeSync(source);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalPath(candidate) {
  let cursor = path.resolve(candidate);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const existing = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor;
  return path.join(existing, ...missing);
}

function isSubpath(root, target) {
  const relation = path.relative(canonicalPath(root), canonicalPath(target));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation));
}

function assertSafeRelativePath(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 4096 || value.includes("\0") || value.includes("\\")) {
    throw new Error("Backup manifest contains an unsafe path.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Backup manifest contains an unsafe path.");
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Backup manifest contains an unsafe path.");
  }
  return normalized;
}

function assertSafeProjectName(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 255
    || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error("Project backup contains an unsafe project name.");
  }
  return value;
}

function readRegularFile(filePath, maxBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes) {
      throw new Error("Backup contains an unsafe or oversized file.");
    }
    const buffer = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (buffer.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("Backup file changed while it was being read.");
    }
    return buffer;
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAtomicFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode, flag: "wx" });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, mode);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The atomic rename already consumed the temporary file.
    }
  }
}

function shouldExclude(relativePath, info) {
  const parts = relativePath.split("/");
  const name = parts[parts.length - 1];
  const lowerName = name.toLowerCase();
  const normalizedRelativePath = parts.map((part) => part.toLowerCase()).join("/");
  if (info.isDirectory()) {
    return EXCLUDED_DIRECTORY_NAMES.has(lowerName)
      || lowerName.startsWith(".next")
      || EXCLUDED_RELATIVE_DIRECTORY_PATHS.has(normalizedRelativePath)
      || (parts.length === 1 && EXCLUDED_TOP_LEVEL_DIRECTORY_NAMES.has(lowerName));
  }
  return lowerName === ".ds_store"
    || lowerName === "thumbs.db"
    || lowerName === "desktop.ini"
    || lowerName === ".env"
    || lowerName.startsWith(".env.")
    || lowerName === "tikomni.env"
    || lowerName.endsWith(".log")
    || EXCLUDED_CREDENTIAL_FILE_EXTENSIONS.has(path.extname(lowerName))
    || EXCLUDED_FILE_NAMES.has(lowerName)
    || (normalizedRelativePath.startsWith("materials/publication/desktop-transactions/") && lowerName.endsWith(".lock"))
    || /^(?:session|tabs)_[0-9]+$/.test(lowerName)
    || lowerName.endsWith(".aifios-backup");
}

function shouldExcludeFromNewExport(relativePath, info) {
  const parts = relativePath.split("/");
  if (!info.isDirectory()) return false;
  const lowerName = parts[parts.length - 1].toLowerCase();
  return EXPORT_ONLY_EXCLUDED_DIRECTORY_NAMES.has(lowerName)
    || (parts.length === 1 && EXPORT_ONLY_EXCLUDED_TOP_LEVEL_DIRECTORY_NAMES.has(lowerName));
}

function assertBackupPathAllowed(relativePath) {
  const normalized = assertSafeRelativePath(relativePath);
  const parts = normalized.split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    const directoryPath = parts.slice(0, index + 1).join("/");
    if (shouldExclude(directoryPath, { isDirectory: () => true })) {
      throw new Error(`Project backup manifest contains an excluded path: ${normalized}`);
    }
  }
  if (shouldExclude(normalized, { isDirectory: () => false })) {
    throw new Error(`Project backup manifest contains an excluded path: ${normalized}`);
  }
  return normalized;
}

function isRegularPath(candidate, expectedType) {
  try {
    const info = fs.lstatSync(candidate);
    return !info.isSymbolicLink() && (expectedType === "directory" ? info.isDirectory() : info.isFile());
  } catch {
    return false;
  }
}

function hasLegacyMixedCheckoutFingerprint(root) {
  const pyproject = readRegularFile(path.join(root, "pyproject.toml"), 256 * 1024);
  const cli = readRegularFile(path.join(root, "content_runtime", "cli.py"), 1024 * 1024);
  const playbook = readRegularFile(path.join(root, "MASTER_PLAYBOOK.md"), 1024 * 1024);
  if (!pyproject || !cli || !playbook) return false;
  const pyprojectText = pyproject.toString("utf8");
  const cliText = cli.toString("utf8");
  const playbookText = playbook.toString("utf8");
  return pyprojectText.includes('name = "content-runtime"')
    && pyprojectText.includes("AI Founder Influence OS")
    && cliText.includes("from content_runtime.core import ContentRuntime")
    && cliText.includes("content-runtime · AI Founder Influence OS")
    && playbookText.includes("# AI FOUNDER INFLUENCE OS · 总控手册");
}

function backupProjectionForProject(projectDir, schemaRecord) {
  const root = path.resolve(projectDir);
  const persistedLegacyProjection = schemaRecord?.schema === PROJECT_SCHEMA
    && schemaRecord?.backupProjection === "legacy-mixed-checkout-data";
  const unmarkedLegacyProject = schemaRecord?.schema === LEGACY_PROJECT_SCHEMA
    && schemaRecord?.markerPresent === false;
  if (!persistedLegacyProjection && !unmarkedLegacyProject) return "complete-project";
  const legacyMarkers = [
    isRegularPath(path.join(root, "content_runtime", "cli.py"), "file"),
    isRegularPath(path.join(root, "pyproject.toml"), "file"),
    isRegularPath(path.join(root, "schemas"), "directory"),
    isRegularPath(path.join(root, "scripts"), "directory"),
    isRegularPath(path.join(root, "skills"), "directory"),
  ];
  const dataMarkers = ["brain", "materials", "pipeline", "runs"]
    .filter((name) => isRegularPath(path.join(root, name), "directory"));
  const provenanceVerified = persistedLegacyProjection || hasLegacyMixedCheckoutFingerprint(root);
  return legacyMarkers.every(Boolean) && dataMarkers.length >= 3 && provenanceVerified
    ? "legacy-mixed-checkout-data"
    : "complete-project";
}

function includedByBackupProjection(relativePath, projection) {
  if (projection !== "legacy-mixed-checkout-data") return true;
  const [topLevel, ...rest] = relativePath.split("/");
  const lowerTopLevel = topLevel.toLowerCase();
  if (LEGACY_MIXED_PROJECT_SOURCE_DIRECTORIES.has(lowerTopLevel)) return false;
  if (lowerTopLevel === "tests" && LEGACY_MIXED_PROJECT_TEST_SOURCE_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) {
    return false;
  }
  if (rest.length === 0 && LEGACY_MIXED_PROJECT_SOURCE_ROOT_FILES.has(lowerTopLevel)) return false;
  return true;
}

function walkProjectFiles(projectDir, projection = "complete-project") {
  const root = path.resolve(projectDir);
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Project root must be a regular directory.");
  }
  const files = [];
  const visit = (directory, relativeDirectory = "") => {
    const names = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertSafeRelativePath(relativePath);
      const absolutePath = path.join(directory, name);
      const info = fs.lstatSync(absolutePath);
      if (!includedByBackupProjection(relativePath, projection)) continue;
      if (shouldExclude(relativePath, info) || shouldExcludeFromNewExport(relativePath, info)) continue;
      if (info.isSymbolicLink()) throw new Error(`Project contains an unsupported symbolic link: ${relativePath}`);
      if (info.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES) throw new Error(`Project file is too large to back up: ${relativePath}`);
        files.push({ relativePath, absolutePath, size: info.size });
        if (files.length > MAX_FILE_COUNT) throw new Error("Project contains too many files to back up safely.");
      } else {
        throw new Error(`Project contains an unsupported file type: ${relativePath}`);
      }
    }
  };
  visit(root);
  return files;
}

function sanitizedFileBuffer(relativePath, absolutePath) {
  const isLlmConfig = relativePath.toLowerCase() === "config/llm-config.json";
  const buffer = readRegularFile(absolutePath, isLlmConfig ? MAX_STRUCTURED_JSON_BYTES : MAX_FILE_BYTES);
  if (buffer === null) throw new Error("Project file disappeared while the backup was being created.");
  if (!isLlmConfig) return buffer;
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("LLM configuration is invalid and cannot be backed up safely.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM configuration is invalid and cannot be backed up safely.");
  }
  stripSensitiveStructuredFields(parsed);
  const safeConfig = normalizeSafeLlmConfig(parsed);
  const sanitized = Buffer.from(`${JSON.stringify(safeConfig, null, 2)}\n`, "utf8");
  assertBufferSafeForBackup(relativePath, sanitized);
  return sanitized;
}

function readProjectSchema(projectDir) {
  const markerPath = path.join(projectDir, PROJECT_SCHEMA_FILE);
  const content = readRegularFile(markerPath, 64 * 1024);
  if (content === null) return { schema: LEGACY_PROJECT_SCHEMA, markerPresent: false };
  let parsed;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Project schema marker contains invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.schema !== "string") {
    throw new Error("Project schema marker is invalid.");
  }
  return { ...parsed, markerPresent: true };
}

function writeProjectSchema(projectDir, appVersion, now = new Date(), { backupProjection = null } = {}) {
  const marker = {
    schema: PROJECT_SCHEMA,
    appVersion: String(appVersion || "unknown"),
    updatedAt: now.toISOString(),
  };
  if (backupProjection === "legacy-mixed-checkout-data") {
    marker.backupProjection = backupProjection;
  }
  const markerPath = path.join(projectDir, PROJECT_SCHEMA_FILE);
  writeAtomicFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 0o600);
  return marker;
}

function manifestPayload(manifest) {
  const { manifestSha256: _ignored, ...payload } = manifest;
  return payload;
}

function exportProjectBackup({ projectDir, backupPath, appVersion, projectSchemaOverride, now = new Date() }) {
  const root = path.resolve(projectDir);
  const destination = path.resolve(backupPath);
  if (isSubpath(root, destination) || isSubpath(destination, root)) {
    throw new Error("Backup destination must be outside the project directory.");
  }
  if (fs.existsSync(destination)) throw new Error("Backup destination already exists.");
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const staging = `${destination}.partial-${process.pid}-${Date.now()}`;
  if (fs.existsSync(staging)) throw new Error("Backup staging directory already exists.");

  let completed = false;
  try {
    fs.mkdirSync(path.join(staging, DATA_DIRECTORY), { recursive: true, mode: 0o700 });
    const schemaRecord = readProjectSchema(root);
    const projectSchema = projectSchemaOverride || schemaRecord.schema;
    if (![PROJECT_SCHEMA, LEGACY_PROJECT_SCHEMA].includes(projectSchema)) {
      throw new Error("Project schema is unsupported and cannot be backed up.");
    }
    const projection = backupProjectionForProject(root, { ...schemaRecord, schema: projectSchema });
    const rows = [];
    let totalBytes = 0;
    for (const file of walkProjectFiles(root, projection)) {
      const target = path.join(staging, DATA_DIRECTORY, ...file.relativePath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (file.relativePath.toLowerCase() === "config/llm-config.json") {
        const content = sanitizedFileBuffer(file.relativePath, file.absolutePath);
        fs.writeFileSync(target, content, { mode: 0o600, flag: "wx" });
        rows.push({
          path: file.relativePath,
          size: content.length,
          sha256: sha256Buffer(content),
        });
      } else {
        const inspectedIdentity = inspectBackupCandidate(file.relativePath, file.absolutePath);
        const copied = copyRegularFileSafely(file.absolutePath, target, MAX_FILE_BYTES, inspectedIdentity);
        rows.push({ path: file.relativePath, ...copied });
      }
      const copied = fs.lstatSync(target);
      if (!copied.isFile() || copied.isSymbolicLink() || copied.size > MAX_FILE_BYTES) {
        throw new Error(`Project file could not be copied safely: ${file.relativePath}`);
      }
      totalBytes += copied.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Project backup exceeds the supported size limit.");
    }
    const payload = {
      schema: PROJECT_BACKUP_SCHEMA,
      projectSchema,
      appVersion: String(appVersion || "unknown"),
      createdAt: now.toISOString(),
      sourceProjectName: path.basename(root) || "project",
      projection,
      files: rows,
      totalBytes,
    };
    const manifest = {
      ...payload,
      manifestSha256: sha256Buffer(Buffer.from(canonicalJson(payload), "utf8")),
    };
    writeAtomicFile(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    fs.renameSync(staging, destination);
    completed = true;
    return {
      schema: PROJECT_BACKUP_SCHEMA,
      fileName: path.basename(destination),
      fileCount: rows.length,
      totalBytes,
      manifestSha256: manifest.manifestSha256,
      projection,
    };
  } finally {
    if (!completed) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function parseAndVerifyManifest(backupPath) {
  const backupInfo = fs.lstatSync(backupPath);
  if (!backupInfo.isDirectory() || backupInfo.isSymbolicLink()) {
    throw new Error("Project backup must be a regular backup directory.");
  }
  const rootEntries = fs.readdirSync(backupPath).sort();
  if (rootEntries.length !== 2 || rootEntries[0] !== DATA_DIRECTORY || rootEntries[1] !== MANIFEST_FILE) {
    throw new Error("Project backup contains unlisted top-level data.");
  }
  const content = readRegularFile(path.join(backupPath, MANIFEST_FILE), MAX_MANIFEST_BYTES);
  if (content === null) throw new Error("Project backup manifest is missing.");
  let manifest;
  try {
    manifest = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Project backup manifest contains invalid JSON.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schema !== PROJECT_BACKUP_SCHEMA) {
    throw new Error("Project backup schema is unsupported.");
  }
  if (![PROJECT_SCHEMA, LEGACY_PROJECT_SCHEMA].includes(manifest.projectSchema)) {
    throw new Error("Project data schema is unsupported.");
  }
  const projection = Object.prototype.hasOwnProperty.call(manifest, "projection")
    ? manifest.projection
    : "complete-project";
  if (!["complete-project", "legacy-mixed-checkout-data"].includes(projection)) {
    throw new Error("Project backup projection is unsupported.");
  }
  assertSafeProjectName(manifest.sourceProjectName);
  if (typeof manifest.appVersion !== "string" || Buffer.byteLength(manifest.appVersion, "utf8") > 256
    || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("Project backup metadata is invalid.");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_FILE_COUNT) {
    throw new Error("Project backup file manifest is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(manifest.manifestSha256 || ""))) {
    throw new Error("Project backup manifest checksum is invalid.");
  }
  const expectedManifestHash = sha256Buffer(Buffer.from(canonicalJson(manifestPayload(manifest)), "utf8"));
  if (expectedManifestHash !== manifest.manifestSha256) {
    throw new Error("Project backup manifest checksum does not match.");
  }

  const exactPaths = new Set();
  const foldedPaths = new Set();
  let totalBytes = 0;
  const files = manifest.files.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Project backup file manifest is invalid.");
    const relativePath = assertBackupPathAllowed(row.path);
    if (!includedByBackupProjection(relativePath, projection)) {
      throw new Error(`Project backup manifest violates its declared projection: ${relativePath}`);
    }
    const folded = relativePath.toLocaleLowerCase("en-US");
    if (exactPaths.has(relativePath) || foldedPaths.has(folded)) {
      throw new Error("Project backup manifest contains duplicate paths.");
    }
    exactPaths.add(relativePath);
    foldedPaths.add(folded);
    const size = Number(row.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(String(row.sha256 || ""))) {
      throw new Error("Project backup file metadata is invalid.");
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Project backup exceeds the supported size limit.");
    return { path: relativePath, size, sha256: row.sha256 };
  });
  if (manifest.totalBytes !== totalBytes) throw new Error("Project backup total size does not match the manifest.");
  return { manifest, files };
}

function listBackupDataFiles(backupPath) {
  const root = path.join(backupPath, DATA_DIRECTORY);
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Project backup data directory is unsafe.");
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      assertSafeRelativePath(relativePath);
      const target = path.join(directory, name);
      const rowInfo = fs.lstatSync(target);
      if (rowInfo.isSymbolicLink()) throw new Error("Project backup contains a symbolic link.");
      if (rowInfo.isDirectory()) visit(target, relativePath);
      else if (rowInfo.isFile()) files.push(relativePath);
      else throw new Error("Project backup contains an unsupported file type.");
    }
  };
  visit(root);
  return files;
}

function importProjectBackup({ backupPath, destinationPath, appVersion, now = new Date() }) {
  const source = path.resolve(backupPath);
  const destination = path.resolve(destinationPath);
  if (fs.existsSync(destination)) throw new Error("Restore destination already exists; an existing project will never be overwritten.");
  if (isSubpath(source, destination) || isSubpath(destination, source)) {
    throw new Error("Restore destination must be outside the backup directory.");
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const { manifest, files } = parseAndVerifyManifest(source);
  const listedFiles = listBackupDataFiles(source);
  const manifestPaths = new Set(files.map((file) => file.path));
  if (listedFiles.length !== manifestPaths.size || listedFiles.some((item) => !manifestPaths.has(item))) {
    throw new Error("Project backup data files do not match the manifest.");
  }

  const staging = `${destination}.restore-${process.pid}-${Date.now()}`;
  if (fs.existsSync(staging)) throw new Error("Restore staging directory already exists.");
  let completed = false;
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    for (const file of files) {
      const sourceFile = path.join(source, DATA_DIRECTORY, ...file.path.split("/"));
      const info = fs.lstatSync(sourceFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
        throw new Error(`Project backup file is unsafe or has changed: ${file.path}`);
      }
      const target = path.join(staging, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const copied = copyRegularFileSafely(sourceFile, target, file.size, null, file.path);
      if (copied.size !== file.size || copied.sha256 !== file.sha256) {
        throw new Error(`Project backup checksum does not match: ${file.path}`);
      }
      if (sha256File(target) !== file.sha256) throw new Error(`Restored file checksum does not match: ${file.path}`);
    }
    writeProjectSchema(staging, appVersion, now);
    fs.renameSync(staging, destination);
    completed = true;
    return {
      schema: PROJECT_BACKUP_SCHEMA,
      projectSchema: PROJECT_SCHEMA,
      fileCount: files.length,
      totalBytes: manifest.totalBytes,
      sourceProjectName: String(manifest.sourceProjectName || "project"),
      manifestSha256: manifest.manifestSha256,
      projection: Object.prototype.hasOwnProperty.call(manifest, "projection")
        ? manifest.projection
        : "complete-project",
    };
  } finally {
    if (!completed) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function uniqueAutomaticBackupPath(backupRoot, projectDir, now) {
  const safeName = (path.basename(projectDir) || "project").replace(/[^A-Za-z0-9._-]+/g, "-");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let candidate = path.join(backupRoot, `${safeName}-pre-schema-v1-${stamp}.aifios-backup`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(backupRoot, `${safeName}-pre-schema-v1-${stamp}-${suffix}.aifios-backup`);
    suffix += 1;
  }
  return candidate;
}

function projectHasContent(projectDir) {
  return fs.readdirSync(projectDir).some((name) => name !== ".DS_Store" && name !== PROJECT_SCHEMA_FILE);
}

function ensureProjectSchema({ projectDir, appVersion, backupRoot, now = new Date() }) {
  const root = path.resolve(projectDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Project root must be a regular directory.");
  const current = readProjectSchema(root);
  if (current.schema === PROJECT_SCHEMA) {
    return { schema: PROJECT_SCHEMA, migrated: false, backup: null };
  }
  if (current.schema !== LEGACY_PROJECT_SCHEMA) throw new Error("Project schema is newer or unsupported; startup was stopped.");

  let backup = null;
  if (projectHasContent(root)) {
    if (!backupRoot) throw new Error("Project schema migration requires a backup directory.");
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const backupPath = uniqueAutomaticBackupPath(backupRoot, root, now);
    backup = exportProjectBackup({
      projectDir: root,
      backupPath,
      appVersion,
      projectSchemaOverride: LEGACY_PROJECT_SCHEMA,
      now,
    });
  }
  writeProjectSchema(root, appVersion, now, {
    backupProjection: backup?.projection === "legacy-mixed-checkout-data"
      ? "legacy-mixed-checkout-data"
      : null,
  });
  return { schema: PROJECT_SCHEMA, migrated: true, backup };
}

function defaultRestoredProjectPath({ parentDir, sourceProjectName, now = new Date() }) {
  const name = String(sourceProjectName || "project").replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, "-") || "project";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(parentDir || path.join(os.homedir(), "Echo Founder Projects"), `${name}-restored-${stamp}`);
}

module.exports = {
  DATA_DIRECTORY,
  LEGACY_PROJECT_SCHEMA,
  MANIFEST_FILE,
  PROJECT_BACKUP_SCHEMA,
  PROJECT_SCHEMA,
  PROJECT_SCHEMA_FILE,
  canonicalJson,
  defaultRestoredProjectPath,
  ensureProjectSchema,
  exportProjectBackup,
  importProjectBackup,
  parseAndVerifyManifest,
  readProjectSchema,
  sha256Buffer,
  sha256File,
};
