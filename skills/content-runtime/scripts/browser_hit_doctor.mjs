#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = fileURLToPath(new URL("../../xhs-card", import.meta.url));
const packageJson = path.join(skillRoot, "package.json");

function runtimeNodeBinary() {
  return String(process.env.AIFIOS_NODE_BINARY || process.execPath || "node").trim();
}

function runtimeNodeEnv() {
  const env = { ...process.env };
  if (env.AIFIOS_NODE_RUN_AS_NODE === "1") env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function packagedChromiumPath() {
  const configured = String(process.env.AIFIOS_PLAYWRIGHT_CHROMIUM_PATH || "").trim();
  if (process.env.AIFIOS_DESKTOP === "1" && !configured) {
    throw new Error("AIFIOS desktop runtime is missing its bundled Chromium executable.");
  }
  if (configured && !fs.existsSync(configured)) {
    throw new Error(`Configured AIFIOS Chromium executable is missing: ${configured}`);
  }
  return configured;
}

function run(command, args = [], cwd = process.cwd()) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd, env: runtimeNodeEnv() });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function line(ok, message, detail = "") {
  return { status: ok ? "PASS" : "FAIL", message, detail };
}

async function main() {
  const checks = [];
  const nodeCheck = run(runtimeNodeBinary(), ["--version"]);
  checks.push(line(nodeCheck.ok, "node", nodeCheck.stdout || nodeCheck.stderr));

  if (process.env.AIFIOS_DESKTOP === "1") {
    checks.push(line(true, "npm", "packaged desktop does not require npm"));
  } else {
    const npmCheck = run("npm", ["--version"]);
    checks.push(line(npmCheck.ok, "npm", npmCheck.stdout || npmCheck.stderr));
  }

  checks.push(line(fs.existsSync(packageJson), "xhs-card package.json", packageJson));

  let playwright = null;
  try {
    const require = createRequire(new URL("../../xhs-card/package.json", import.meta.url));
    playwright = require("playwright");
    checks.push(line(true, "playwright package", "installed"));
  } catch (error) {
    checks.push(line(false, "playwright package", error.message));
  }

  if (playwright) {
    try {
      const executablePath = packagedChromiumPath();
      const browser = await playwright.chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
      await browser.close();
      checks.push(line(true, "chromium browser", "launch ok"));
    } catch (error) {
      checks.push(line(false, "chromium browser", error.message));
    }
  } else {
    checks.push(line(false, "chromium browser", "skip because playwright package is missing"));
  }

  const failures = checks.filter((item) => item.status === "FAIL");
  console.log(JSON.stringify({
    status: failures.length ? "failed" : "ok",
    checks,
    resolution: failures.length ? "Run `make browser-hit-install` from AIFI-OS root, then retry `make browser-hit-doctor`." : "",
  }, null, 2));
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "failed", error: error.message }, null, 2));
  process.exit(1);
});
