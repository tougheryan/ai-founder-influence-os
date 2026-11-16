const { randomUUID } = require("crypto");

const DESKTOP_USER_ERROR_PREFIX = "AIFIOS_USER_ERROR:";

function redactDesktopText(value, options = {}) {
  const fallback = options.fallback || "Desktop operation failed.";
  let message = String(value?.message || value || fallback);
  const markers = (options.markers || [])
    .map((marker) => String(marker || "").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  for (const marker of markers) message = message.split(marker).join("[local path]");

  return message
    .replace(/file:\/\/\/[^\s"'<>]+/gi, "[local path]")
    .replace(/\/(?:Users|home|root|private|var|tmp|Volumes|Applications|Library|System|opt|srv|workspace|app|mnt)\/[^\s"'<>，。；;,)）\]}]+/g, "[local path]")
    .replace(/[A-Za-z]:\\[^\r\n"'<>]+/g, "[local path]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[secret redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, "[secret redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[secret redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[digest redacted]")
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"',;]+/gi, "$1[secret redacted]")
    .replace(/\b(?:bearer|basic)\s+[^\s"',;]+/gi, "[secret redacted]")
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, "$1[secret redacted]")
    .replace(
      /("(?:api[_-]?key|access[_-]?token|auth[_-]?token|pairing[_-]?token|token|authorization|cookie|password|private[_-]?key|app[_-]?secret|client[_-]?secret|secret)"\s*:\s*")[^"\r\n]*(")/gi,
      "$1[secret redacted]$2",
    )
    .replace(
      /('(?:api[_-]?key|access[_-]?token|auth[_-]?token|pairing[_-]?token|token|authorization|cookie|password|private[_-]?key|app[_-]?secret|client[_-]?secret|secret)'\s*:\s*')[^'\r\n]*(')/gi,
      "$1[secret redacted]$2",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|pairing[_-]?token|token|authorization|cookie|password|private[_-]?key|app[_-]?secret|client[_-]?secret|secret)\s*[:=]\s*)[^\s"',;&]+/gi,
      "$1[secret redacted]",
    )
    .slice(0, 8000);
}

const DESKTOP_OPERATION_ERRORS = Object.freeze({
  "Credential status": {
    error: "无法读取密钥状态，请重试。",
    code: "credential_status_failed",
  },
  "Credential save": {
    error: "无法保存密钥。请在系统钥匙串中允许访问后重试。",
    code: "credential_save_failed",
  },
  "Credential delete": {
    error: "无法删除密钥，请重试。",
    code: "credential_delete_failed",
  },
  "Publication credential status": {
    error: "无法读取发布账号连接状态，请重试。",
    code: "publication_credential_status_failed",
  },
  "Publication credential save": {
    error: "无法保存发布账号密钥。请在系统钥匙串中允许访问后重试。",
    code: "publication_credential_save_failed",
  },
  "Publication credential delete": {
    error: "无法删除发布账号密钥，请重试。",
    code: "publication_credential_delete_failed",
  },
  "Publication bridge status": {
    error: "无法读取发布账号连接状态，请重试。",
    code: "publication_connection_status_failed",
  },
  "Publication editor open": {
    error: "无法打开平台后台，请重试。",
    code: "publication_editor_open_failed",
  },
  "Publication draft fill": {
    error: "草稿准备失败，请重试。",
    code: "publication_draft_fill_failed",
  },
  "Project backup export": {
    error: "无法导出备份，请换个位置后重试。",
    code: "backup_export_failed",
  },
  "Project backup restore": {
    error: "无法恢复备份，当前项目未被修改。",
    code: "backup_restore_failed",
  },
  "Desktop startup": {
    error: "应用启动失败，请重新启动。若仍失败，请打开运行诊断。",
    code: "desktop_startup_failed",
  },
  "License initialization": {
    error: "设备授权初始化失败，请重新启动应用。",
    code: "license_initialization_failed",
  },
  "Secure data initialization": {
    error: "本机数据无法安全初始化，原项目未被修改。请重新启动应用。",
    code: "secure_data_initialization_failed",
  },
});

const BRIDGE_ERROR_DEFINITIONS = Object.freeze({
  browser_session_required: {
    error: "平台后台尚未登录。请先完成登录，再重试。",
    code: "browser_session_required",
    action: { label: "打开平台后台" },
  },
  browser_fill_incomplete: {
    error: "正文已填入，但图片未全部添加。请在平台后台检查后再重试。",
    code: "browser_fill_incomplete",
  },
  browser_save_confirmation_required: {
    error: "内容已填入编辑器，请在平台后台确认草稿已保存。尚未发布。",
    code: "browser_save_confirmation_required",
  },
  mobile_bridge_required: {
    error: "尚未连接朋友圈发布设备。请先完成设备连接。",
    code: "mobile_bridge_required",
  },
});

function desktopOperationError(operation) {
  return DESKTOP_OPERATION_ERRORS[operation] || {
    error: "操作失败，请重试。",
    code: "desktop_operation_failed",
  };
}

function errorParts(value) {
  if (value && typeof value === "object") {
    const constructorName = value.constructor?.name;
    return {
      name: String(value.name && value.name !== "Error" ? value.name : constructorName || "Error"),
      message: String(value.message || ""),
      code: String(value.code || ""),
    };
  }
  return { name: "Error", message: String(value || ""), code: "" };
}

function knownDesktopError(value) {
  const { name, message, code } = errorParts(value);
  if (BRIDGE_ERROR_DEFINITIONS[code]) return BRIDGE_ERROR_DEFINITIONS[code];
  if (/unauthorized|forbidden|permission/i.test(`${name} ${message} ${code}`)) {
    return { error: "当前窗口没有执行此操作的权限。", code: "desktop_access_denied" };
  }
  if (/safe.?storage|keychain|decrypt|encrypt|credential vault|钥匙串|解密|加密/i.test(`${name} ${message} ${code}`)) {
    return {
      error: "系统钥匙串暂时不可用。请允许应用访问钥匙串后重试。",
      code: "keychain_unavailable",
    };
  }
  if (/checksum|integrity|digest|hash mismatch|校验和|完整性校验|摘要不一致/i.test(message)) {
    return {
      error: "备份校验失败，请重新选择原始备份。",
      code: "backup_integrity_failed",
    };
  }
  if (/destination.{0,20}(?:exists|not empty)|already exists|目标.{0,12}(?:存在|非空)/i.test(message)) {
    return {
      error: "该位置已有同名文件，请换个名称。",
      code: "backup_destination_exists",
    };
  }
  if (/unsupported.{0,24}(?:schema|version)|incompatible.{0,24}(?:schema|version)|不兼容.{0,12}版本/i.test(message)) {
    return {
      error: "这个备份来自不兼容的版本，请先升级应用。",
      code: "backup_version_incompatible",
    };
  }
  if (/python runtime|python.{0,24}unavailable|missing.{0,24}python|运行组件/i.test(`${name} ${message}`)) {
    return {
      error: "缺少必要的运行组件，请重新安装完整应用。",
      code: "runtime_component_missing",
    };
  }
  if (/econn|enet|network|socket|timed?\s*out|网络|连接超时|服务不可用/i.test(`${name} ${message}`)) {
    return {
      error: "应用暂时没有响应，请稍后重试。",
      code: "desktop_service_unavailable",
    };
  }
  return null;
}

function createDesktopDebugId() {
  return `err_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function createDesktopUserFacingFailure(value, options = {}) {
  const definition = knownDesktopError(value) || options.definition || desktopOperationError(options.operation);
  const debugId = createDesktopDebugId();
  return {
    payload: {
      error: String(definition.error || "操作失败，请重试。"),
      code: String(definition.code || "desktop_operation_failed"),
      ...(definition.action ? { action: definition.action } : {}),
      debugId,
    },
    logDetail: redactDesktopText(value, {
      fallback: "Desktop operation failed.",
      markers: options.markers || [],
    }),
  };
}

function encodeDesktopUserFacingError(payload) {
  return `${DESKTOP_USER_ERROR_PREFIX}${JSON.stringify({
    error: String(payload?.error || "操作失败，请重试。"),
    code: String(payload?.code || "desktop_operation_failed"),
    ...(payload?.action ? { action: payload.action } : {}),
    ...(payload?.debugId ? { debugId: String(payload.debugId) } : {}),
  })}`;
}

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

module.exports = {
  DESKTOP_USER_ERROR_PREFIX,
  createDesktopUserFacingFailure,
  decodeDesktopUserFacingError,
  desktopOperationError,
  encodeDesktopUserFacingError,
  redactDesktopText,
};
