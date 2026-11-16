#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.dirname(SCRIPT_DIR);
const REPO_ROOT = path.resolve(RUNTIME_DIR, "..", "..");
const COLLECTOR = path.join(SCRIPT_DIR, "browser_hit_collector.mjs");
const FIXTURE_DIR = path.join(RUNTIME_DIR, "fixtures", "browser-hit");
const PLATFORMS = ["wechat", "xhs"];

function runtimeNodeBinary() {
  return String(process.env.AIFIOS_NODE_BINARY || process.execPath || "node").trim();
}

function runtimeNodeEnv() {
  const env = { ...process.env };
  if (env.AIFIOS_NODE_RUN_AS_NODE === "1") env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function printHelp() {
  console.log(`AIFIOS browser selector fixture check

Usage:
  node skills/content-runtime/scripts/browser_hit_fixture_check.mjs [--project /tmp/aifios-browser-fixtures]

This command checks local HTML fixtures only. It does not access real platforms
and does not prove that live pages will be available after login, captcha, or
platform DOM changes.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      args.help = true;
    } else if (item === "--project") {
      args.project = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function runCollector(project, platform) {
  const fixture = path.join(FIXTURE_DIR, `${platform}.html`);
  if (!fs.existsSync(fixture)) {
    throw new Error(`Missing fixture: ${fixture}`);
  }
  const result = spawnSync(runtimeNodeBinary(), [
    COLLECTOR,
    "--project", project,
    "--platform", platform,
    "--url", pathToFileURL(fixture).toString(),
    "--keyword", "fixture",
    "--limit", "3",
    "--max-scrolls", "0",
    "--no-wait",
    "--headless",
  ], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: runtimeNodeEnv(),
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    if (output.includes("Playwright dependency is not installed")) {
      return {
        platform,
        status: "skipped",
        reason: "Playwright dependency is not installed. Run `make browser-hit-install` first.",
      };
    }
    throw new Error(`collector failed for ${platform}: ${output}`);
  }
  const payload = JSON.parse(result.stdout);
  if (payload.status === "skipped") {
    return {
      platform,
      status: "skipped",
      reason: payload.reason || "Browser runtime unavailable.",
      resolution: payload.resolution || "",
      selector_profile: payload.selector_profile,
    };
  }
  const capture = payload.capture_file ? readJson(payload.capture_file) : {};
  const importedDir = path.join(project, "materials", "hit-library", platform);
  const importedFiles = fs.existsSync(importedDir)
    ? fs.readdirSync(importedDir).filter((name) => name.endsWith(".json"))
    : [];
  const ok = (
    payload.status === "collected"
    && payload.count >= 1
    && Boolean(payload.selector_profile?.version)
    && Boolean(capture.selector_profile?.version)
    && Array.isArray(capture.samples)
    && capture.samples.length >= 1
    && importedFiles.length >= 1
  );
  return {
    platform,
    status: ok ? "pass" : "fail",
    collector_status: payload.status,
    count: payload.count,
    selector_profile: payload.selector_profile,
    capture_file: payload.capture_file,
    imported_files: importedFiles.length,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }
  const project = path.resolve(args.project || fs.mkdtempSync(path.join(os.tmpdir(), "aifios-browser-fixtures-")));
  fs.mkdirSync(project, { recursive: true });
  const results = PLATFORMS.map((platform) => runCollector(project, platform));
  const skipped = results.some((item) => item.status === "skipped");
  const failed = results.filter((item) => item.status === "fail");
  const summary = {
    status: skipped ? "skipped" : (failed.length ? "failed" : "pass"),
    project,
    note: "Local fixture check only; real platform collection still requires user login and current visible pages.",
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length) {
    process.exit(1);
  }
}

main();
