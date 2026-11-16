const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { RUNTIME_TREE_HASH_SCHEMA, runtimeTreeSha256 } = require("./runtime-tree.cjs");

test("runtime tree digest binds directories, symlinks, executable bits, and bytes", (t) => {
  assert.equal(RUNTIME_TREE_HASH_SCHEMA, "echo-founder.runtime-tree.v1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-founder-runtime-tree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "empty"));
  fs.writeFileSync(path.join(root, "bin", "tool"), "tool\n");
  fs.chmodSync(path.join(root, "bin", "tool"), 0o755);
  fs.writeFileSync(path.join(root, "data.txt"), "data\n");
  fs.chmodSync(path.join(root, "data.txt"), 0o644);
  fs.symlinkSync("bin/tool", path.join(root, "tool-link"));

  const expected = "9261c074bbf33c354662ffbefad0b8e153b9731bb4c8bd6646bd8f0768ddbc2f";
  assert.equal(runtimeTreeSha256(root), expected);

  fs.chmodSync(path.join(root, "bin", "tool"), 0o644);
  assert.notEqual(runtimeTreeSha256(root), expected);
  fs.chmodSync(path.join(root, "bin", "tool"), 0o755);
  fs.writeFileSync(path.join(root, "data.txt"), "changed\n");
  assert.notEqual(runtimeTreeSha256(root), expected);
});
