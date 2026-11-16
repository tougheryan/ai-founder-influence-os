const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const RUNTIME_TREE_HASH_SCHEMA = "echo-founder.runtime-tree.v1";

function runtimeTreeSha256(root) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`runtime tree root is missing or unsafe: ${root}`);
  }

  const entries = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const candidate = path.join(directory, name);
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      const metadata = fs.lstatSync(candidate);
      entries.push({ candidate, relative, metadata });
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        walk(candidate);
      }
    }
  };
  walk(root);
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.relative, "utf8"),
    Buffer.from(right.relative, "utf8"),
  ));

  const digest = createHash("sha256");
  digest.update(Buffer.from(`${RUNTIME_TREE_HASH_SCHEMA}\0`, "utf8"));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const { candidate, relative, metadata } of entries) {
    digest.update(relative, "utf8");
    digest.update("\0", "utf8");
    if (metadata.isSymbolicLink()) {
      digest.update("link\0", "utf8");
      digest.update(fs.readlinkSync(candidate), "utf8");
    } else if (metadata.isDirectory()) {
      digest.update("dir\0", "utf8");
    } else if (metadata.isFile()) {
      digest.update("file\0", "utf8");
      digest.update(String(metadata.mode & 0o111), "utf8");
      digest.update("\0", "utf8");
      const descriptor = fs.openSync(candidate, "r");
      try {
        let bytesRead = 0;
        do {
          bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
          if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
      } finally {
        fs.closeSync(descriptor);
      }
    } else {
      throw new Error(`runtime tree contains an unsupported entry: ${relative}`);
    }
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

module.exports = { RUNTIME_TREE_HASH_SCHEMA, runtimeTreeSha256 };
