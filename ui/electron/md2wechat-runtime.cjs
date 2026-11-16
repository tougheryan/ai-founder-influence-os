"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function expandHome(value, homeDirectory) {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return path.join(homeDirectory, value.slice(2));
  return value;
}

function normalizeBinary(value, homeDirectory) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes(path.sep) || raw.startsWith("~")) {
    return path.resolve(expandHome(raw, homeDirectory));
  }
  return raw;
}

function nodeVersionParts(name) {
  const match = String(name || "").match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? match.slice(1, 4).map((part) => Number.parseInt(part || "0", 10)) : [0, 0, 0];
}

function compareNodeVersionsDescending(left, right) {
  const leftParts = nodeVersionParts(left);
  const rightParts = nodeVersionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return rightParts[index] - leftParts[index];
  }
  return String(right).localeCompare(String(left));
}

function nvmCandidates(homeDirectory) {
  const versionsDirectory = path.join(homeDirectory, ".nvm", "versions", "node");
  try {
    return fs.readdirSync(versionsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareNodeVersionsDescending)
      .map((version) => ({
        binary: path.join(versionsDirectory, version, "bin", "md2wechat"),
        source: "nvm",
      }));
  } catch {
    return [];
  }
}

function md2WechatCandidates(environment = process.env, homeDirectory = os.homedir()) {
  return [
    { binary: normalizeBinary(environment.MD2WECHAT_BINARY, homeDirectory), source: "env" },
    { binary: "md2wechat", source: "path" },
    { binary: "/opt/homebrew/bin/md2wechat", source: "homebrew-absolute" },
    { binary: "/usr/local/bin/md2wechat", source: "local-absolute" },
    { binary: path.join(homeDirectory, ".volta", "bin", "md2wechat"), source: "volta" },
    { binary: path.join(homeDirectory, ".local", "bin", "md2wechat"), source: "user-local" },
    { binary: path.join(homeDirectory, ".local", "share", "fnm", "aliases", "default", "bin", "md2wechat"), source: "fnm" },
    { binary: path.join(homeDirectory, ".fnm", "aliases", "default", "bin", "md2wechat"), source: "fnm" },
    ...nvmCandidates(homeDirectory),
  ].filter((candidate) => candidate.binary);
}

function validateMd2WechatCandidate(candidate, environment = process.env) {
  if (!candidate?.binary) return null;
  const absolute = candidate.binary.includes(path.sep);
  if (absolute && !fs.existsSync(candidate.binary)) return null;

  const binaryDirectory = absolute ? path.dirname(candidate.binary) : "";
  const candidateEnvironment = {
    ...environment,
    PATH: binaryDirectory
      ? `${binaryDirectory}${path.delimiter}${environment.PATH || ""}`
      : environment.PATH || "",
  };
  const result = spawnSync(candidate.binary, ["--version"], {
    encoding: "utf-8",
    env: candidateEnvironment,
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

function resolveMd2WechatRuntime(environment = process.env, homeDirectory = os.homedir()) {
  for (const candidate of md2WechatCandidates(environment, homeDirectory)) {
    const valid = validateMd2WechatCandidate(candidate, environment);
    if (valid) return valid;
  }
  return {
    binary: "",
    source: "missing",
    version: "",
    available: false,
  };
}

module.exports = {
  compareNodeVersionsDescending,
  md2WechatCandidates,
  resolveMd2WechatRuntime,
  validateMd2WechatCandidate,
};
