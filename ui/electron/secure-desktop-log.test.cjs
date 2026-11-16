const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LOG_DIRECTORY_MODE,
  LOG_FILE_MODE,
  ensureSecureLogDirectory,
  openSecureDesktopLogStream,
  revalidateSecureLogDirectory,
} = require("./secure-desktop-log.cjs");

async function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-founder-secure-log-"));
  try {
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeAndClose(stream, text) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.once("close", resolve);
    stream.end(text);
  });
}

test("secure desktop log creates private directories and a 0600 regular file", async () => {
  await withTempDir(async (root) => {
    const target = path.join(root, "logs", "desktop.log");
    await writeAndClose(openSecureDesktopLogStream(target), "safe entry\n");

    const directory = fs.lstatSync(path.dirname(target));
    const file = fs.lstatSync(target);
    assert.equal(directory.isDirectory(), true);
    assert.equal(directory.mode & 0o777, LOG_DIRECTORY_MODE);
    assert.equal(file.isFile(), true);
    assert.equal(file.isSymbolicLink(), false);
    assert.equal(file.mode & 0o777, LOG_FILE_MODE);
    assert.equal(fs.readFileSync(target, "utf8"), "safe entry\n");
  });
});

test("secure desktop log tightens an existing file to 0600 before appending", async () => {
  await withTempDir(async (root) => {
    const target = path.join(root, "logs", "desktop.log");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, "before\n", { mode: 0o666 });
    fs.chmodSync(target, 0o666);

    await writeAndClose(openSecureDesktopLogStream(target), "after\n");

    assert.equal(fs.lstatSync(target).mode & 0o777, LOG_FILE_MODE);
    assert.equal(fs.readFileSync(target, "utf8"), "before\nafter\n");
  });
});

test("secure desktop log rejects a symlink target without touching its victim", async () => {
  await withTempDir((root) => {
    const victim = path.join(root, "victim.txt");
    const target = path.join(root, "logs", "desktop.log");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(victim, "do not change\n");
    fs.symlinkSync(victim, target);

    assert.throws(
      () => openSecureDesktopLogStream(target),
      /symbolic link|too many levels|ELOOP/i,
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "do not change\n");
  });
});

test("secure desktop log rejects a symlinked log directory", async () => {
  await withTempDir((root) => {
    const redirected = path.join(root, "redirected");
    const logDirectory = path.join(root, "logs");
    fs.mkdirSync(redirected);
    fs.symlinkSync(redirected, logDirectory);

    assert.throws(
      () => openSecureDesktopLogStream(path.join(logDirectory, "desktop.log")),
      /real directory|symbolic link|not a directory|ENOTDIR/i,
    );
    assert.equal(fs.existsSync(path.join(redirected, "desktop.log")), false);
  });
});

test("secure desktop log detects a parent-directory replacement race", async () => {
  await withTempDir((root) => {
    const target = path.join(root, "logs", "desktop.log");
    const snapshot = ensureSecureLogDirectory(target);
    const original = path.join(root, "logs-original");
    const redirected = path.join(root, "redirected");
    fs.mkdirSync(redirected);
    fs.renameSync(path.join(root, "logs"), original);
    fs.symlinkSync(redirected, path.join(root, "logs"));

    assert.throws(
      () => revalidateSecureLogDirectory(snapshot),
      /directory changed/i,
    );
    assert.equal(fs.existsSync(path.join(redirected, "desktop.log")), false);
  });
});

test("an opened log stream keeps writing its verified inode if the path is replaced", async () => {
  await withTempDir(async (root) => {
    const target = path.join(root, "logs", "desktop.log");
    const verifiedInode = path.join(root, "logs", "desktop.verified.log");
    const victim = path.join(root, "victim.txt");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, "before\n", { mode: LOG_FILE_MODE });
    fs.writeFileSync(victim, "victim\n");

    const stream = openSecureDesktopLogStream(target);
    fs.renameSync(target, verifiedInode);
    fs.symlinkSync(victim, target);
    await writeAndClose(stream, "after race\n");

    assert.equal(fs.readFileSync(victim, "utf8"), "victim\n");
    assert.equal(fs.readFileSync(verifiedInode, "utf8"), "before\nafter race\n");
  });
});

test("secure desktop log rejects hard-linked targets", async () => {
  await withTempDir((root) => {
    const source = path.join(root, "source.log");
    const target = path.join(root, "logs", "desktop.log");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(source, "source\n", { mode: LOG_FILE_MODE });
    fs.linkSync(source, target);

    assert.throws(() => openSecureDesktopLogStream(target), /hard-linked/i);
    assert.equal(fs.readFileSync(source, "utf8"), "source\n");
  });
});
