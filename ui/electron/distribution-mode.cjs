const DISTRIBUTION_SCHEMA = "aifios.desktop-distribution.v1";

/**
 * Resolve the package distribution mode without silently downgrading a
 * packaged paid build when its marker is missing or malformed.
 */
function parseDistributionMode(marker, { packaged = false, hostedBootstrapPresent = false } = {}) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    if (packaged) {
      throw new Error("桌面安装包缺少有效的分发标记，已拒绝以未授权模式启动。");
    }
    return null;
  }

  if (marker.schema !== DISTRIBUTION_SCHEMA) {
    if (packaged) {
      throw new Error("桌面安装包的分发标记版本不受支持，已拒绝启动。");
    }
    return null;
  }

  if (marker.mode === "hosted-license") {
    if (marker.deviceBinding !== true) {
      throw new Error("托管授权包缺少设备绑定标记，已拒绝启动。");
    }
    return "device-bound";
  }

  if (marker.mode === "local-self-config") {
    if (packaged && hostedBootstrapPresent) {
      throw new Error("托管授权配置与本地分发标记冲突，已拒绝降级启动。");
    }
    return "local-self-config";
  }

  if (packaged) {
    throw new Error("桌面安装包的分发模式无效，已拒绝启动。");
  }
  return null;
}

module.exports = {
  DISTRIBUTION_SCHEMA,
  parseDistributionMode,
};
