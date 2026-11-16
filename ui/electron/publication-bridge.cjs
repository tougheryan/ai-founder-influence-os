const { basename, extname, isAbsolute } = require("path");
const { rebuildAuthoritativePublicationRequest } = require("./publication-authority.cjs");
const { createPublicationAssetSnapshot } = require("./publication-asset-snapshot.cjs");
const { createPublicationTransactionManager } = require("./publication-transaction.cjs");

const PUBLICATION_CREDENTIAL_IDS = [
  "wechat_official_api",
  "wechat_browser_bridge",
  "xiaohongshu_browser_bridge",
  "moments_mobile_bridge",
];

const RESULT_STATUSES = new Set([
  "draft_filled",
  "retryable_failure",
  "manual_intervention_required",
  "unknown_completion",
]);
const ADAPTER_KINDS = new Set([
  "wechat_official_api",
  "authorized_browser",
  "mobile_bridge",
  "download",
]);
const SENSITIVE_KEY = /(?:secret|token|cookie|password|api[_-]?key|private[_-]?key|credential)/i;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_ASSETS = 20;
const DEFAULT_NETWORK_TIMEOUT_MS = 20_000;
const MAX_NETWORK_TIMEOUT_MS = 120_000;

const PLATFORM_HOSTS = {
  wechat: new Set(["mp.weixin.qq.com"]),
  xiaohongshu: new Set([
    "creator.xiaohongshu.com",
    "www.xiaohongshu.com",
    "passport.xiaohongshu.com",
  ]),
};

class PublicationBridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "PublicationBridgeError";
    this.code = code;
    this.status = options.status || "retryable_failure";
    this.authorizationState = options.authorizationState;
  }
}

function networkTimeoutMs(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_NETWORK_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_NETWORK_TIMEOUT_MS);
}

function isAbortError(error) {
  return Boolean(error && typeof error === "object" && error.name === "AbortError");
}

function asString(value, label, max = 4096) {
  if (typeof value !== "string") throw new PublicationBridgeError("invalid_payload", `${label} is invalid.`);
  const result = value.trim();
  if (!result || Buffer.byteLength(result, "utf8") > max) {
    throw new PublicationBridgeError("invalid_payload", `${label} is invalid.`);
  }
  return result;
}

function optionalString(value, label, max = 4096) {
  if (value === undefined || value === null || value === "") return "";
  return asString(value, label, max);
}

function parseObject(raw, label) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PublicationBridgeError("invalid_configuration", `${label} must be valid JSON.`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PublicationBridgeError("invalid_configuration", `${label} must be an object.`);
  }
  return parsed;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PublicationBridgeError("invalid_configuration", `${label} contains an unsupported field.`);
  }
}

function normalizePlatformUrl(value, platform) {
  const raw = asString(value, "editorUrl", 2048);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicationBridgeError("invalid_configuration", "editorUrl must be an HTTPS URL.");
  }
  if (url.protocol !== "https:" || !PLATFORM_HOSTS[platform].has(url.hostname.toLowerCase())) {
    throw new PublicationBridgeError("invalid_configuration", "editorUrl is not an allowed platform URL.");
  }
  return url.toString();
}

function isPrivateIpv4(host) {
  const parts = host.split(".").map((value) => Number.parseInt(value, 10));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 127;
}

function normalizeMobileBridgeUrl(value) {
  const raw = asString(value, "endpoint", 2048);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicationBridgeError("invalid_configuration", "endpoint must be a valid URL.");
  }
  const hostname = url.hostname.toLowerCase();
  const localHttp = url.protocol === "http:"
    && (hostname === "localhost" || hostname === "::1" || isPrivateIpv4(hostname));
  if (url.protocol !== "https:" && !localHttp) {
    throw new PublicationBridgeError("invalid_configuration", "The mobile bridge must use HTTPS or a local-network HTTP endpoint.");
  }
  return url.toString();
}

/**
 * Parses only the minimum credentials/configuration required by a local
 * publication bridge. The returned object is stored encrypted by Electron;
 * queue files never receive any of these fields.
 */
function parsePublicationCredentialConfig(id, rawValue) {
  if (!PUBLICATION_CREDENTIAL_IDS.includes(id)) {
    throw new PublicationBridgeError("invalid_configuration", "Unsupported publication credential identifier.");
  }
  const value = parseObject(rawValue, "Publication configuration");
  if (id === "wechat_official_api") {
    assertOnlyKeys(value, new Set(["appId", "appSecret", "author", "contentSourceUrl"]), "WeChat API configuration");
    const contentSourceUrl = optionalString(value.contentSourceUrl, "contentSourceUrl", 2048);
    if (contentSourceUrl) {
      try {
        const url = new URL(contentSourceUrl);
        if (url.protocol !== "https:") throw new Error("non-https");
      } catch {
        throw new PublicationBridgeError("invalid_configuration", "contentSourceUrl must be an HTTPS URL.");
      }
    }
    return {
      appId: asString(value.appId, "appId", 128),
      appSecret: asString(value.appSecret, "appSecret", 512),
      ...(optionalString(value.author, "author", 128) ? { author: optionalString(value.author, "author", 128) } : {}),
      ...(contentSourceUrl ? { contentSourceUrl } : {}),
    };
  }
  if (id === "wechat_browser_bridge") {
    assertOnlyKeys(value, new Set(["editorUrl"]), "WeChat browser configuration");
    return { editorUrl: normalizePlatformUrl(value.editorUrl, "wechat") };
  }
  if (id === "xiaohongshu_browser_bridge") {
    assertOnlyKeys(value, new Set(["editorUrl"]), "Xiaohongshu browser configuration");
    return { editorUrl: normalizePlatformUrl(value.editorUrl, "xiaohongshu") };
  }
  assertOnlyKeys(value, new Set(["endpoint", "pairingToken", "accessToken"]), "Moments mobile bridge configuration");
  const token = optionalString(value.pairingToken || value.accessToken, "pairingToken", 4096);
  if (!token) throw new PublicationBridgeError("invalid_configuration", "pairingToken is required for the mobile bridge.");
  return {
    endpoint: normalizeMobileBridgeUrl(value.endpoint),
    pairingToken: token,
  };
}

function assertNoSensitiveKeys(value, path = "request") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new PublicationBridgeError("invalid_payload", `Sensitive field is not allowed in ${path}.`);
    }
    assertNoSensitiveKeys(nested, `${path}.${key}`);
  }
}

function safeRelativePath(value, label) {
  const result = asString(value, label, 1024).replace(/\\/g, "/");
  if (isAbsolute(result) || /^[A-Za-z]:\//.test(result) || result.includes("\0") || result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new PublicationBridgeError("invalid_payload", `${label} must be a project-local path.`);
  }
  return result;
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== "object") throw new PublicationBridgeError("invalid_bridge_result", "The local bridge returned no result.");
  const result = raw;
  if (!RESULT_STATUSES.has(result.status)) {
    throw new PublicationBridgeError("invalid_bridge_result", "The local bridge returned an unsupported status.");
  }
  const normalize = (value, label, max) => value === undefined ? undefined : optionalString(value, label, max);
  return {
    status: result.status,
    ...(normalize(result.authorizationState, "authorizationState", 64) ? { authorizationState: normalize(result.authorizationState, "authorizationState", 64) } : {}),
    ...(normalize(result.code, "code", 128) ? { code: normalize(result.code, "code", 128) } : {}),
    ...(normalize(result.message, "message", 1024) ? { message: normalize(result.message, "message", 1024) } : {}),
    ...(normalize(result.externalReference, "externalReference", 512) ? { externalReference: normalize(result.externalReference, "externalReference", 512) } : {}),
  };
}

function normalizeJob(raw) {
  assertNoSensitiveKeys(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PublicationBridgeError("invalid_payload", "Publication job is invalid.");
  }
  const job = raw;
  const platform = asString(job.platform, "platform", 64);
  if (!["wechat", "xiaohongshu", "moments", "shipinhao", "douyin"].includes(platform)) {
    throw new PublicationBridgeError("invalid_payload", "Unsupported publication platform.");
  }
  const deliveryKind = asString(job.delivery_kind, "delivery_kind", 64);
  const adapter = asString(job.adapter, "adapter", 64);
  if (!["draft_fill", "execution_package"].includes(deliveryKind) || !ADAPTER_KINDS.has(adapter)) {
    throw new PublicationBridgeError("invalid_payload", "Publication job adapter is invalid.");
  }
  const payload = job.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PublicationBridgeError("invalid_payload", "Publication payload is invalid.");
  }
  const assetPaths = Array.isArray(payload.asset_paths) ? payload.asset_paths.map((value) => safeRelativePath(value, "asset_paths")) : [];
  if (assetPaths.length > MAX_ASSETS) throw new PublicationBridgeError("invalid_payload", "Too many publication assets.");
  const selectedAssets = Array.isArray(job.selected_asset_hashes)
    ? job.selected_asset_hashes.map((asset) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) throw new PublicationBridgeError("invalid_payload", "Selected asset is invalid.");
      return {
        ...(asset.id === undefined ? {} : { id: optionalString(asset.id, "selected asset id", 128) }),
        path: safeRelativePath(asset.path, "selected asset path"),
        role: optionalString(asset.role, "selected asset role", 128),
        sha256: asString(asset.sha256, "selected asset sha256", 64),
      };
    })
    : [];
  return {
    jobId: asString(job.job_id, "job_id", 128),
    queueStatus: asString(job.status, "status", 64),
    queueAttemptCount: job.attempt_count,
    platform,
    deliveryKind,
    adapter,
    fallbackAdapter: job.fallback_adapter === undefined ? "" : asString(job.fallback_adapter, "fallback_adapter", 64),
    payloadHash: asString(job.payload_hash, "payload_hash", 128),
    contentHash: asString(job.content_hash, "content_hash", 128),
    payload: {
      title: asString(payload.title, "title", 512),
      summary: optionalString(payload.summary, "summary", 1024),
      copyPath: payload.copy_path ? safeRelativePath(payload.copy_path, "copy_path") : "",
      htmlPath: payload.html_path ? safeRelativePath(payload.html_path, "html_path") : "",
      executionPackagePath: payload.execution_package_path ? safeRelativePath(payload.execution_package_path, "execution_package_path") : "",
      assetPaths,
    },
    selectedAssets,
  };
}

function extensionMimeType(path) {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

function browserAllowedUrl(platform, value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && PLATFORM_HOSTS[platform].has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function firstMatchingAsset(job, kind) {
  const byRole = job.selectedAssets.find((asset) => asset.role.toLowerCase().includes(kind));
  if (byRole) return byRole.path;
  if (kind === "cover") {
    return job.payload.assetPaths.find((path) => /cover/i.test(path)) || job.payload.assetPaths[0] || "";
  }
  return "";
}

function replaceLocalAssetReferences(content, assetPath, hostedUrl) {
  const candidates = [
    assetPath,
    `/${assetPath}`,
    assetPath.replace(/^pipeline\//, ""),
    basename(assetPath),
  ];
  let result = content;
  for (const candidate of candidates) {
    if (candidate) result = result.split(candidate).join(hostedUrl);
  }
  return result;
}

function containsUnresolvedLocalImage(content) {
  const srcs = [...content.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]);
  return srcs.some((source) => source.startsWith("file:") || source.startsWith("/") || source.startsWith("pipeline/") || source.includes("/api/output/"));
}

function createPublicationBridge(options) {
  const browserWindows = new Map();
  const publicationOperations = new Map();
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("A fetch implementation is required for publication bridges.");
  const requestTimeoutMs = networkTimeoutMs(options.networkTimeoutMs);
  const transactionManager = options.publicationTransactionManager || createPublicationTransactionManager({
    projectDir: () => options.projectDir(),
  });

  async function serializePublicationOperation(key, task) {
    const previous = publicationOperations.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    publicationOperations.set(key, current);
    try {
      return await current;
    } finally {
      if (publicationOperations.get(key) === current) publicationOperations.delete(key);
    }
  }

  function readCredential(id) {
    const raw = options.getCredential(id);
    if (!raw) return null;
    try {
      return parsePublicationCredentialConfig(id, raw);
    } catch {
      return null;
    }
  }

  function verifiedFile(job, path, label) {
    const relativePath = safeRelativePath(path, label);
    const file = job.verifiedFiles?.get(relativePath);
    if (!file) {
      throw new PublicationBridgeError("authority_snapshot_missing", `${label} is not in the verified publication snapshot.`);
    }
    return file;
  }

  async function readText(job, path, label) {
    if (!path) return "";
    const file = verifiedFile(job, path, label);
    if (file.buffer.length > MAX_TEXT_BYTES) {
      throw new PublicationBridgeError("asset_missing", `${label} is too large.`);
    }
    return file.buffer.toString("utf8");
  }

  async function readAssets(job) {
    const assets = [];
    for (const assetPath of job.payload.assetPaths) {
      const file = verifiedFile(job, assetPath, "publication asset");
      if (file.buffer.length > MAX_ASSET_BYTES) {
        throw new PublicationBridgeError("asset_missing", "A publication asset is too large.");
      }
      assets.push(file);
    }
    return assets;
  }

  async function withNetworkTimeout(timeoutMessage, task) {
    if (typeof AbortController !== "function") {
      throw new PublicationBridgeError("network_unavailable", "This desktop runtime cannot create timed publication requests.");
    }
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId;
    const request = Promise.resolve().then(() => task(controller.signal));
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new PublicationBridgeError("network_timeout", timeoutMessage));
      }, requestTimeoutMs);
    });
    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (timedOut || controller.signal.aborted || isAbortError(error)) {
        throw new PublicationBridgeError("network_timeout", timeoutMessage);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function fetchJsonWithTimeout(url, init, messages) {
    try {
      return await withNetworkTimeout(messages.timeout, async (signal) => {
        const response = await fetchFn(url, { ...(init || {}), signal });
        try {
          return { response, body: await response.json(), jsonError: false };
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw error;
          return { response, body: undefined, jsonError: true };
        }
      });
    } catch (error) {
      if (error instanceof PublicationBridgeError) throw error;
      throw new PublicationBridgeError("network_unavailable", messages.unavailable);
    }
  }

  async function fetchWechatJson(url, init) {
    const { response, body, jsonError } = await fetchJsonWithTimeout(url, init, {
      timeout: "The WeChat API request timed out before it could be confirmed.",
      unavailable: "The WeChat API cannot be reached from this device.",
    });
    if (jsonError) {
      throw new PublicationBridgeError("api_unavailable", "The WeChat API returned an unreadable response.");
    }
    if (!response.ok || (typeof body.errcode === "number" && body.errcode !== 0)) {
      throw new PublicationBridgeError("api_unavailable", "The WeChat API did not accept this draft.");
    }
    return body;
  }

  async function wechatAccessToken(config) {
    const query = new URLSearchParams({
      grant_type: "client_credential",
      appid: config.appId,
      secret: config.appSecret,
    });
    const body = await fetchWechatJson(`https://api.weixin.qq.com/cgi-bin/token?${query.toString()}`, { method: "GET" });
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new PublicationBridgeError("api_unavailable", "The WeChat API did not return an access token.");
    }
    return body.access_token;
  }

  async function wechatUpload(token, endpoint, asset) {
    if (typeof FormData === "undefined" || typeof Blob === "undefined") {
      throw new PublicationBridgeError("api_unavailable", "This desktop runtime cannot upload WeChat media.");
    }
    const form = new FormData();
    form.append("media", new Blob([asset.buffer], { type: extensionMimeType(asset.relativePath) }), basename(asset.relativePath));
    const url = new URL(endpoint);
    url.searchParams.set("access_token", token);
    return fetchWechatJson(url.toString(), { method: "POST", body: form });
  }

  async function fillWechatOfficial(job, config) {
    const token = await wechatAccessToken(config);
    const html = await readText(job, job.payload.htmlPath || job.payload.copyPath, "WeChat draft");
    if (!html) throw new PublicationBridgeError("invalid_payload", "The WeChat draft content is missing.");
    const coverPath = firstMatchingAsset(job, "cover");
    if (!coverPath) throw new PublicationBridgeError("configuration_missing", "The WeChat API needs an adopted cover image.");
    const allAssets = await readAssets(job);
    const cover = allAssets.find((asset) => asset.relativePath === coverPath);
    if (!cover) throw new PublicationBridgeError("asset_missing", "The adopted WeChat cover is unavailable.");
    const coverUpload = await wechatUpload(token, "https://api.weixin.qq.com/cgi-bin/material/add_material?type=image", cover);
    if (typeof coverUpload.media_id !== "string" || !coverUpload.media_id) {
      throw new PublicationBridgeError("api_unavailable", "The WeChat API did not return a cover media ID.");
    }

    let content = html;
    for (const asset of allAssets) {
      const uploaded = await wechatUpload(token, "https://api.weixin.qq.com/cgi-bin/media/uploadimg", asset);
      if (typeof uploaded.url !== "string" || !uploaded.url) {
        throw new PublicationBridgeError("api_unavailable", "The WeChat API did not return an inline image URL.");
      }
      content = replaceLocalAssetReferences(content, asset.relativePath, uploaded.url);
    }
    if (containsUnresolvedLocalImage(content)) {
      throw new PublicationBridgeError("configuration_missing", "The WeChat draft still contains unresolved local images.");
    }
    const payload = {
      articles: [{
        title: job.payload.title,
        ...(config.author ? { author: config.author } : {}),
        digest: job.payload.summary || "",
        content,
        ...(config.contentSourceUrl ? { content_source_url: config.contentSourceUrl } : {}),
        thumb_media_id: coverUpload.media_id,
        show_cover_pic: 1,
        need_open_comment: 0,
        only_fans_can_comment: 0,
      }],
    };
    const draft = await fetchWechatJson(`https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (typeof draft.media_id !== "string" || !draft.media_id) {
      throw new PublicationBridgeError("api_unavailable", "The WeChat API did not return a draft ID.");
    }
    return {
      adapter: "wechat_official_api",
      result: normalizeResult({
        status: "draft_filled",
        authorizationState: "authorized",
        externalReference: `wechat-draft:${draft.media_id}`,
        message: "The article was saved to the WeChat draft box. It was not sent.",
      }),
    };
  }

  async function getBrowserWindow(platform, config) {
    const current = browserWindows.get(platform);
    if (current && !current.isDestroyed()) {
      current.show();
      current.focus();
      return current;
    }
    if (!options.BrowserWindow) {
      throw new PublicationBridgeError("browser_session_required", "The desktop browser bridge is unavailable.", {
        status: "manual_intervention_required",
        authorizationState: "requires_human_action",
      });
    }
    const window = new options.BrowserWindow({
      width: 1240,
      height: 900,
      minWidth: 920,
      minHeight: 680,
      title: platform === "wechat" ? "Echo Founder · 公众号草稿" : "Echo Founder · 图文草稿",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `persist:aifios-publication-${platform}`,
      },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (browserAllowedUrl(platform, url)) {
        window.loadURL(url).catch(() => undefined);
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!browserAllowedUrl(platform, url)) event.preventDefault();
    });
    window.on("closed", () => browserWindows.delete(platform));
    browserWindows.set(platform, window);
    try {
      await window.loadURL(config.editorUrl);
    } catch {
      throw new PublicationBridgeError("network_unavailable", "The platform editor cannot be opened from this device.");
    }
    window.show();
    window.focus();
    return window;
  }

  function editorSelectors(platform) {
    if (platform === "wechat") {
      return {
        title: ["#title", "input[name='title']", "input[placeholder*='标题']"],
        content: ["#ueditor_0", ".edui-editor-iframeholder iframe", "[contenteditable='true']", "textarea[placeholder*='正文']"],
        files: ["input[type='file'][accept*='image']", "input[type='file']"],
      };
    }
    return {
      title: ["input[placeholder*='标题']"],
      content: ["textarea[placeholder*='正文']", ".ql-editor", ".ProseMirror", "[contenteditable='true']"],
      files: ["input[type='file'][accept*='image']", "input[type='file']"],
    };
  }

  async function injectEditorContent(window, platform, payload) {
    const selectors = editorSelectors(platform);
    const script = `(() => {
      const selectors = ${JSON.stringify(selectors)};
      const payload = ${JSON.stringify(payload)};
      const find = (list) => {
        for (const selector of list) {
          const node = document.querySelector(selector);
          if (node) return { node, selector };
        }
        return { node: null, selector: "" };
      };
      const setText = (node, value, rich) => {
        if (!node) return false;
        node.focus();
        if (rich || node.isContentEditable) {
          node.innerHTML = rich ? value : value.replace(/\\n/g, "<br>");
        } else {
          const prototype = Object.getPrototypeOf(node);
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          if (!descriptor || typeof descriptor.set !== "function") return false;
          descriptor.set.call(node, value);
        }
        node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        node.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;
      };
      const title = find(selectors.title);
      const content = find(selectors.content);
      const file = find(selectors.files);
      let contentTarget = content.node;
      if (contentTarget && contentTarget.tagName === "IFRAME") {
        contentTarget = contentTarget.contentDocument && contentTarget.contentDocument.body;
      }
      return {
        titleFound: Boolean(title.node),
        contentFound: Boolean(contentTarget),
        fileSelector: file.selector,
        titleFilled: setText(title.node, payload.title, false),
        contentFilled: setText(contentTarget, payload.content, payload.html === true),
      };
    })()`;
    return window.webContents.executeJavaScript(script, true);
  }

  async function attachBrowserFiles(window, platform, snapshot) {
    if (!snapshot.paths.length) return { attached: true };
    const selectors = editorSelectors(platform).files;
    const selectorScript = `(() => {
      const selectors = ${JSON.stringify(selectors)};
      for (const selector of selectors) {
        if (document.querySelector(selector)) return selector;
      }
      return "";
    })()`;
    const selector = await window.webContents.executeJavaScript(selectorScript, true);
    if (!selector) return { attached: false, reason: "file_input_missing" };
    let attached = false;
    try {
      await snapshot.validate();
      window.webContents.debugger.attach("1.3");
      attached = true;
      const document = await window.webContents.debugger.sendCommand("DOM.getDocument", { depth: 1 });
      const match = await window.webContents.debugger.sendCommand("DOM.querySelector", {
        nodeId: document.root.nodeId,
        selector,
      });
      if (!match.nodeId) return { attached: false, reason: "file_input_missing" };
      await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", {
        nodeId: match.nodeId,
        files: snapshot.paths,
      });
      const cloneResult = await window.webContents.executeJavaScript(`(async () => {
        const echoFounderClonePublicationFiles = true;
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input || !input.files || typeof DataTransfer !== "function") return { cloned: false, count: 0 };
        const transfer = new DataTransfer();
        for (const file of Array.from(input.files)) {
          const bytes = await file.arrayBuffer();
          transfer.items.add(new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { cloned: echoFounderClonePublicationFiles, count: input.files.length };
      })()`, true);
      await snapshot.validate();
      if (!cloneResult || cloneResult.cloned !== true || cloneResult.count !== snapshot.paths.length) {
        throw new PublicationBridgeError("snapshot_clone_failed", "The browser did not clone every verified publication asset.");
      }
      return { attached: true };
    } catch {
      try {
        await window.webContents.executeJavaScript(`(() => {
          const input = document.querySelector(${JSON.stringify(String(selector || "input[type='file']"))});
          if (input) { input.value = ""; input.dispatchEvent(new Event("change", { bubbles: true })); }
          return true;
        })()`, true);
      } catch {
        // The editor is untrusted external UI. Failure to clear it still cannot
        // turn a local prefill into a confirmed or publicly sent result.
      }
      return { attached: false, reason: "file_attach_failed" };
    } finally {
      if (attached) {
        try {
          window.webContents.debugger.detach();
        } catch {
          // DevTools may have detached first; leaving the editor untouched is safe.
        }
      }
    }
  }

  async function fillAuthorizedBrowser(job, platform, config) {
    const content = platform === "wechat"
      ? await readText(job, job.payload.htmlPath || job.payload.copyPath, "platform draft")
      : await readText(job, job.payload.copyPath, "platform copy");
    if (!content) throw new PublicationBridgeError("invalid_payload", "The platform draft content is missing.");
    const window = await getBrowserWindow(platform, config);
    const before = await injectEditorContent(window, platform, {
      title: job.payload.title,
      content,
      html: platform === "wechat" && Boolean(job.payload.htmlPath),
    });
    if (!before.titleFound || !before.contentFound || !before.titleFilled || !before.contentFilled) {
      return {
        adapter: "authorized_browser",
        result: normalizeResult({
          status: "manual_intervention_required",
          authorizationState: "requires_human_action",
          code: "browser_session_required",
          message: "The platform editor is not ready. Sign in and open the draft editor, then retry this item.",
        }),
      };
    }
    const assets = await readAssets(job);
    const snapshot = await createPublicationAssetSnapshot(assets.map((asset) => ({
      buffer: asset.buffer,
      relativePath: asset.relativePath,
      sha256: asset.sha256,
    })), options.publicationAssetSnapshotOptions || {});
    try {
      const fileResult = await attachBrowserFiles(window, platform, snapshot);
      if (!fileResult.attached) {
        return {
          adapter: "authorized_browser",
          result: normalizeResult({
            status: "unknown_completion",
            authorizationState: "requires_human_action",
            code: "browser_fill_incomplete",
            message: "Text was filled but the image picker did not confirm every verified asset. Check the open editor before retrying.",
          }),
        };
      }
      return {
        adapter: "authorized_browser",
        result: normalizeResult({
          status: "unknown_completion",
          authorizationState: "requires_human_action",
          code: "browser_save_confirmation_required",
          message: "Text and verified in-memory file snapshots were handed to the open platform editor, but login state, upload completion, risk controls, and draft persistence cannot be verified automatically. Confirm the draft in the editor; nothing was sent.",
        }),
      };
    } finally {
      await snapshot.cleanup();
    }
  }

  async function fillMomentsMobile(job, config) {
    const copy = await readText(job, job.payload.copyPath, "Moments copy");
    if (!copy) throw new PublicationBridgeError("invalid_payload", "The Moments copy is missing.");
    const assets = await readAssets(job);
    if (typeof FormData === "undefined" || typeof Blob === "undefined") {
      throw new PublicationBridgeError("mobile_bridge_required", "This desktop runtime cannot transfer images to the mobile bridge.", {
        status: "manual_intervention_required",
        authorizationState: "requires_human_action",
      });
    }
    const form = new FormData();
    form.append("operation", "aifios.moments.prefill.v1");
    form.append("title", job.payload.title);
    form.append("copy", copy);
    form.append("human_send_required", "true");
    for (const asset of assets) {
      form.append("images", new Blob([asset.buffer], { type: extensionMimeType(asset.relativePath) }), basename(asset.relativePath));
    }
    const { response, body, jsonError } = await fetchJsonWithTimeout(config.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.pairingToken}` },
      body: form,
    }, {
      timeout: "The connected mobile bridge request timed out before it could be confirmed.",
      unavailable: "The connected mobile bridge cannot be reached.",
    });
    if (response.status === 401 || response.status === 403) {
      throw new PublicationBridgeError("authorization_required", "The connected mobile bridge needs to be paired again.", {
        status: "manual_intervention_required",
        authorizationState: "requires_human_action",
      });
    }
    if (jsonError) {
      throw new PublicationBridgeError("mobile_bridge_unconfirmed", "The mobile bridge did not confirm the prefill result.", {
        status: "unknown_completion",
        authorizationState: "requires_human_action",
      });
    }
    if (!response.ok) throw new PublicationBridgeError("network_unavailable", "The mobile bridge could not accept this prefill request.");
    if (body?.status !== "prefilled" && body?.status !== "draft_filled") {
      throw new PublicationBridgeError("mobile_bridge_unconfirmed", "The mobile bridge did not confirm the prefill result.", {
        status: "unknown_completion",
        authorizationState: "requires_human_action",
      });
    }
    const draftId = typeof body.draftId === "string" && body.draftId.trim() ? body.draftId.trim().slice(0, 256) : "local-editor";
    return {
      adapter: "mobile_bridge",
      result: normalizeResult({
        status: "draft_filled",
        authorizationState: "authorized",
        externalReference: `moments-draft:${draftId}`,
        message: "The connected mobile editor was prefilled. It was not sent.",
      }),
    };
  }

  async function fillExecutionPackage(job) {
    const executionPath = job.payload.executionPackagePath || job.payload.copyPath;
    if (!executionPath) throw new PublicationBridgeError("asset_missing", "The video execution package is missing.");
    verifiedFile(job, executionPath, "video execution package");
    return {
      adapter: "download",
      result: normalizeResult({
        status: "draft_filled",
        externalReference: executionPath,
        message: "The local video execution package is ready for manual shooting and publishing.",
      }),
    };
  }

  async function fillPrepared(queuePath, runId, job) {
    if (job.deliveryKind === "execution_package") {
      return { queuePath, runId, job, ...(await fillExecutionPackage(job)) };
    }
    if (job.platform === "wechat") {
      const api = readCredential("wechat_official_api");
      let apiFailure = null;
      if (api) {
        try {
          return { queuePath, runId, job, ...(await fillWechatOfficial(job, api)) };
        } catch (error) {
          const normalized = normalizeBridgeError(error);
          const fallbackCodes = new Set(["credential_unavailable", "configuration_missing", "api_unavailable", "network_unavailable", "network_timeout"]);
          if (!fallbackCodes.has(normalized.code)) return { queuePath, runId, job, adapter: "wechat_official_api", result: normalized };
          apiFailure = normalized;
        }
      }
      const browser = readCredential("wechat_browser_bridge");
      if (!browser) {
        if (apiFailure) {
          return { queuePath, runId, job, adapter: "wechat_official_api", result: apiFailure };
        }
        return {
          queuePath,
          runId,
          job,
          adapter: "authorized_browser",
          result: normalizeResult({
            status: "manual_intervention_required",
            authorizationState: "requires_human_action",
            code: "browser_session_required",
            message: "Configure the WeChat browser bridge and sign in to use the official API fallback.",
          }),
        };
      }
      try {
        return { queuePath, runId, job, ...(await fillAuthorizedBrowser(job, "wechat", browser)) };
      } catch (error) {
        return { queuePath, runId, job, adapter: "authorized_browser", result: normalizeBridgeError(error) };
      }
    }
    if (job.platform === "xiaohongshu") {
      const browser = readCredential("xiaohongshu_browser_bridge");
      if (!browser) {
        return {
          queuePath,
          runId,
          job,
          adapter: "authorized_browser",
          result: normalizeResult({
            status: "manual_intervention_required",
            authorizationState: "requires_human_action",
            code: "browser_session_required",
            message: "Configure the Xiaohongshu browser bridge and sign in before filling drafts.",
          }),
        };
      }
      return { queuePath, runId, job, ...(await fillAuthorizedBrowser(job, "xiaohongshu", browser)) };
    }
    if (job.platform === "moments") {
      const mobile = readCredential("moments_mobile_bridge");
      if (!mobile) {
        return {
          queuePath,
          runId,
          job,
          adapter: "mobile_bridge",
          result: normalizeResult({
            status: "manual_intervention_required",
            authorizationState: "requires_human_action",
            code: "mobile_bridge_required",
            message: "Pair the connected mobile WeChat bridge before filling Moments drafts.",
          }),
        };
      }
      return { queuePath, runId, job, ...(await fillMomentsMobile(job, mobile)) };
    }
    return { queuePath, runId, job, ...(await fillExecutionPackage(job)) };
  }

  async function fill(request) {
    // Renderer input is only an opaque queue/job selector. The main process
    // securely reads the real queue and files, rebuilds the job, and verifies
    // every bound hash before any network/browser/mobile side effect occurs.
    const authority = await rebuildAuthoritativePublicationRequest({
      projectDir: options.projectDir(),
      request,
    });
    const queuePath = authority.queuePath;
    const runId = authority.runId;
    const job = normalizeJob(authority.rawJob);
    Object.defineProperty(job, "verifiedFiles", {
      value: authority.verifiedFiles,
      enumerable: false,
      writable: false,
    });
    const transactionIdentity = {
      queuePath,
      runId,
      jobId: job.jobId,
      payloadHash: job.payloadHash,
      adapter: job.adapter,
      currentJobStatus: job.queueStatus,
      queueAttemptCount: job.queueAttemptCount,
    };
    const operationKey = `${runId}:${job.jobId}:${job.payloadHash}`;
    return serializePublicationOperation(operationKey, async () => {
      const begun = await transactionManager.beginAttempt(transactionIdentity);
      if (begun.action === "replay") {
        return {
          queuePath,
          runId,
          job,
          adapter: begun.adapter,
          result: normalizeResult(begun.result),
        };
      }
      let filled;
      try {
        filled = await fillPrepared(queuePath, runId, job);
      } catch (error) {
        const result = normalizeBridgeError(error);
        const adapter = job.platform === "wechat"
          ? (job.adapter === "authorized_browser" ? "authorized_browser" : "wechat_official_api")
          : job.platform === "xiaohongshu"
            ? "authorized_browser"
            : job.platform === "moments"
              ? "mobile_bridge"
              : "download";
        filled = { queuePath, runId, job, adapter, result };
      }
      // Persist the authoritative result before it can be signed or returned to
      // the renderer. A crash before this write leaves in_flight, which the next
      // launch converts to unknown_completion without repeating the side effect.
      await transactionManager.completeAttempt(transactionIdentity, begun.attemptId, {
        adapter: filled.adapter,
        result: filled.result,
      });
      return filled;
    });
  }

  function status() {
    return PUBLICATION_CREDENTIAL_IDS.map((id) => {
      const config = readCredential(id);
      return {
        id,
        configured: Boolean(config),
        mode: id === "wechat_official_api" ? "official_api" : id === "moments_mobile_bridge" ? "mobile_bridge" : "authorized_browser",
      };
    });
  }

  async function openEditor(platform) {
    if (platform !== "wechat" && platform !== "xiaohongshu") {
      throw new PublicationBridgeError("invalid_payload", "Unsupported browser editor platform.");
    }
    const credentialId = platform === "wechat" ? "wechat_browser_bridge" : "xiaohongshu_browser_bridge";
    const config = readCredential(credentialId);
    if (!config) {
      throw new PublicationBridgeError("browser_session_required", "Configure this browser bridge before opening its editor.", {
        status: "manual_intervention_required",
        authorizationState: "requires_human_action",
      });
    }
    await getBrowserWindow(platform, config);
    return { opened: true, platform };
  }

  return { fill, status, openEditor, close: () => {
    for (const window of browserWindows.values()) {
      if (!window.isDestroyed()) window.close();
    }
    browserWindows.clear();
  } };
}

function normalizeBridgeError(error) {
  if (error instanceof PublicationBridgeError) {
    return normalizeResult({
      status: error.status,
      ...(error.authorizationState ? { authorizationState: error.authorizationState } : {}),
      code: error.code,
      message: error.message,
    });
  }
  return normalizeResult({
    status: "retryable_failure",
    code: "bridge_exception",
    message: "The local publication bridge encountered an unexpected error.",
  });
}

module.exports = {
  ADAPTER_KINDS,
  PUBLICATION_CREDENTIAL_IDS,
  PublicationBridgeError,
  createPublicationBridge,
  normalizeBridgeError,
  parsePublicationCredentialConfig,
};
