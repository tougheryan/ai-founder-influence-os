const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compareNodeVersionsDescending,
  md2WechatCandidates,
  resolveMd2WechatRuntime,
} = require("./md2wechat-runtime.cjs");

function writeExecutable(target, version = "3.4.0") {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o755 });
}

test("sorts NVM versions by numeric version instead of lexicographically", () => {
  assert.deepEqual(
    ["v9.9.0", "v24.15.0", "v20.12.2"].sort(compareNodeVersionsDescending),
    ["v24.15.0", "v20.12.2", "v9.9.0"],
  );
});

test("discovers the newest installed NVM md2wechat binary", (context) => {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "echo-founder-md2wechat-home-"));
  context.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  const older = path.join(homeDirectory, ".nvm", "versions", "node", "v20.12.2", "bin", "md2wechat");
  const newer = path.join(homeDirectory, ".nvm", "versions", "node", "v24.15.0", "bin", "md2wechat");
  writeExecutable(older, "3.3.0");
  writeExecutable(newer, "3.4.0");

  const nvm = md2WechatCandidates({ PATH: "/usr/bin:/bin" }, homeDirectory)
    .filter((candidate) => candidate.source === "nvm");

  assert.deepEqual(nvm.map((candidate) => candidate.binary), [newer, older]);
  assert.deepEqual(resolveMd2WechatRuntime({ PATH: "/usr/bin:/bin" }, homeDirectory), {
    binary: newer,
    source: "nvm",
    version: "3.4.0",
    available: true,
  });
});

test("prefers an explicit md2wechat binary", (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "echo-founder-md2wechat-bin-"));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const explicitBinary = path.join(temporaryDirectory, "md2wechat");
  writeExecutable(explicitBinary, "9.8.7");

  assert.deepEqual(
    resolveMd2WechatRuntime({ MD2WECHAT_BINARY: explicitBinary, PATH: "/usr/bin:/bin" }, temporaryDirectory),
    {
      binary: explicitBinary,
      source: "env",
      version: "9.8.7",
      available: true,
    },
  );
});
