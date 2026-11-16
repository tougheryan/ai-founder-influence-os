const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { link, lstat, mkdtemp, readFile, rm, symlink, unlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const {
  createPublicationAssetSnapshot,
  purgeStalePublicationAssetSnapshots,
} = require("./publication-asset-snapshot.cjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("publication asset snapshots are private, hash-bound, and removed after use", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-snapshot-test-"));
  try {
    const buffer = Buffer.from("approved-image-bytes", "utf8");
    const snapshot = await createPublicationAssetSnapshot([{
      buffer,
      sha256: sha256(buffer),
      relativePath: "pipeline/visual/demo/publish/r001/cover.png",
    }], { tempRoot: root });
    const directoryInfo = await lstat(snapshot.directory);
    const fileInfo = await lstat(snapshot.paths[0]);
    assert.equal(directoryInfo.mode & 0o077, 0);
    assert.equal(fileInfo.mode & 0o077, 0);
    assert.equal(fileInfo.nlink, 1);
    assert.deepEqual(await readFile(snapshot.paths[0]), buffer);
    await snapshot.validate();
    await snapshot.cleanup();
    await assert.rejects(lstat(snapshot.directory), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot symlink and hardlink replacement fails closed and erases approved bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-snapshot-links-"));
  try {
    const buffer = Buffer.from("sensitive-approved-image", "utf8");
    const symlinkSnapshot = await createPublicationAssetSnapshot([{
      buffer, sha256: sha256(buffer), relativePath: "cover.png",
    }], { tempRoot: root });
    const originalPath = symlinkSnapshot.paths[0];
    const decoy = join(root, "decoy.png");
    await unlink(originalPath);
    await symlink(decoy, originalPath);
    await assert.rejects(
      symlinkSnapshot.validate(),
      (error) => error?.code === "snapshot_file_changed" || error?.code === "snapshot_file_unsafe",
    );
    await symlinkSnapshot.cleanup();

    const hardlinkSnapshot = await createPublicationAssetSnapshot([{
      buffer, sha256: sha256(buffer), relativePath: "cover.png",
    }], { tempRoot: root });
    const leakedLink = join(root, "attacker-hardlink.png");
    await link(hardlinkSnapshot.paths[0], leakedLink);
    await assert.rejects(hardlinkSnapshot.validate(), (error) => error?.code === "snapshot_file_unsafe");
    await hardlinkSnapshot.cleanup();
    assert.equal((await readFile(leakedLink)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup failure is reported only after descriptor-backed bytes are zeroed", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-snapshot-cleanup-"));
  try {
    const buffer = Buffer.from("sensitive-approved-image", "utf8");
    const snapshot = await createPublicationAssetSnapshot([{
      buffer, sha256: sha256(buffer), relativePath: "cover.png",
    }], {
      tempRoot: root,
      ops: {
        unlink: async () => {
          const error = new Error("injected unlink failure");
          error.code = "EACCES";
          throw error;
        },
        rmdir: async () => {
          const error = new Error("injected rmdir failure");
          error.code = "EACCES";
          throw error;
        },
      },
    });
    await assert.rejects(snapshot.cleanup(), (error) => error?.code === "snapshot_cleanup_failed");
    assert.equal((await readFile(snapshot.paths[0])).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery zeroes and removes a snapshot left by a SIGKILL", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-snapshot-crash-"));
  try {
    const modulePath = require.resolve("./publication-asset-snapshot.cjs");
    const sensitive = "unpublished-approved-image-after-crash";
    const childScript = `
      const { createHash } = require("node:crypto");
      const { createPublicationAssetSnapshot } = require(process.env.SNAPSHOT_MODULE);
      const buffer = Buffer.from(process.env.SNAPSHOT_BYTES, "utf8");
      createPublicationAssetSnapshot([{
        buffer,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        relativePath: "pipeline/visual/demo/private-cover.png",
      }], { tempRoot: process.env.SNAPSHOT_ROOT }).then((snapshot) => {
        process.stdout.write(JSON.stringify({ directory: snapshot.directory, path: snapshot.paths[0] }) + "\\n");
        setInterval(() => {}, 60_000);
      }).catch((error) => {
        process.stderr.write(String(error.stack || error));
        process.exit(2);
      });
    `;
    const child = spawn(process.execPath, ["-e", childScript], {
      env: {
        ...process.env,
        SNAPSHOT_MODULE: modulePath,
        SNAPSHOT_ROOT: root,
        SNAPSHOT_BYTES: sensitive,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        const line = stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
        if (line) resolve(JSON.parse(line));
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("exit", (code) => reject(new Error(`snapshot child exited before ready: ${code} ${stderr}`)));
    });
    const exitPromise = new Promise((resolve) => child.once("exit", resolve));
    assert.equal((await readFile(record.path, "utf8")), sensitive);
    child.kill("SIGKILL");
    await exitPromise;

    const recovered = await purgeStalePublicationAssetSnapshots({ tempRoot: root });
    assert.equal(recovered.purged, 1);
    await assert.rejects(lstat(record.path), (error) => error?.code === "ENOENT");
    await assert.rejects(lstat(record.directory), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
