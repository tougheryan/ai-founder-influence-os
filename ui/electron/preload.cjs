const { contextBridge, ipcRenderer } = require("electron");

// Sandboxed Electron preload scripts may only require a small allowlist of
// built-in modules. Keeping this decoder self-contained prevents one rejected
// local `require()` from disabling every desktop bridge on the page.
const DESKTOP_USER_ERROR_PREFIX = "AIFIOS_USER_ERROR:";

function decodeDesktopUserFacingError(value) {
  const message = String(value?.message || value || "");
  const offset = message.lastIndexOf(DESKTOP_USER_ERROR_PREFIX);
  if (offset < 0) return null;
  try {
    const payload = JSON.parse(message.slice(offset + DESKTOP_USER_ERROR_PREFIX.length));
    if (!payload || typeof payload.error !== "string" || typeof payload.code !== "string") return null;
    return {
      error: payload.error,
      code: payload.code,
      ...(payload.action && typeof payload.action === "object" ? { action: payload.action } : {}),
      ...(typeof payload.debugId === "string" ? { debugId: payload.debugId } : {}),
    };
  } catch {
    return null;
  }
}

async function invokeSafely(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    const payload = decodeDesktopUserFacingError(error) || {
      error: "操作失败，请重试。",
      code: "desktop_operation_failed",
    };
    const restored = new Error(payload.error);
    restored.name = "UserFacingError";
    restored.code = payload.code;
    if (payload.action) restored.action = payload.action;
    if (payload.debugId) restored.debugId = payload.debugId;
    throw restored;
  }
}

contextBridge.exposeInMainWorld("aifiosCredentials", {
  status: () => invokeSafely("aifios:credentials:status"),
  save: (id, value) => invokeSafely("aifios:credentials:save", { id, value }),
  delete: (id) => invokeSafely("aifios:credentials:delete", id),
});

contextBridge.exposeInMainWorld("aifiosProject", {
  exportBackup: () => invokeSafely("aifios:project:export-backup"),
  importBackup: () => invokeSafely("aifios:project:import-backup"),
});

contextBridge.exposeInMainWorld("aifiosPublication", {
  // Compatibility aliases for older renderers. New settings UI uses the
  // unified credential vault above; no method ever returns a raw secret.
  credentialStatus: () => invokeSafely("aifios:publication-credentials:status"),
  saveCredential: (id, value) => invokeSafely("aifios:publication-credentials:save", { id, value }),
  deleteCredential: (id) => invokeSafely("aifios:publication-credentials:delete", id),
  bridgeStatus: () => invokeSafely("aifios:publication:status"),
  openEditor: (platform) => invokeSafely("aifios:publication:open", platform),
  fillDraft: (request) => invokeSafely("aifios:publication:fill", {
    queuePath: request?.queuePath,
    runId: request?.runId,
    jobId: request?.jobId,
    expectedPayloadHash: request?.expectedPayloadHash,
  }),
});
