const { createHash, randomBytes } = require("node:crypto");
const { constants } = require("node:fs");
const fsPromises = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { extname, join, resolve } = require("node:path");

const MAX_SNAPSHOT_ASSETS = 20;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const SAFE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

class PublicationAssetSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicationAssetSnapshotError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function expectedUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertPrivateDirectory(info) {
  if (!info.isDirectory() || info.isSymbolicLink?.()
    || (expectedUid() !== null && info.uid !== expectedUid()) || (info.mode & 0o077) !== 0) {
    throw new PublicationAssetSnapshotError("snapshot_directory_unsafe", "The publication asset snapshot directory is unsafe.");
  }
}

function assertPrivateFile(info, size) {
  if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1 || info.size !== size
    || (expectedUid() !== null && info.uid !== expectedUid()) || (info.mode & 0o077) !== 0) {
    throw new PublicationAssetSnapshotError("snapshot_file_unsafe", "A publication asset snapshot file is unsafe.");
  }
}

async function readExact(handle, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(buffer, offset, size - offset, offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  if (offset !== size) {
    throw new PublicationAssetSnapshotError("snapshot_file_changed", "A publication asset snapshot changed while it was verified.");
  }
  return buffer;
}

function defaultOps() {
  return {
    chmod: fsPromises.chmod,
    lstat: fsPromises.lstat,
    mkdir: fsPromises.mkdir,
    mkdtemp: fsPromises.mkdtemp,
    open: fsPromises.open,
    readdir: fsPromises.readdir,
    realpath: fsPromises.realpath,
    rename: fsPromises.rename,
    rmdir: fsPromises.rmdir,
    unlink: fsPromises.unlink,
  };
}

async function resolveSnapshotRoot(options, ops) {
  const requested = options.tempRoot ? resolve(options.tempRoot) : resolve(tmpdir());
  if (options.tempRoot) {
    await ops.mkdir(requested, { recursive: true, mode: 0o700 });
    const requestedInfo = await ops.lstat(requested);
    if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink?.()
      || (expectedUid() !== null && requestedInfo.uid !== expectedUid())) {
      throw new PublicationAssetSnapshotError("snapshot_directory_unsafe", "The publication snapshot root is unavailable or unsafe.");
    }
    await ops.chmod(requested, 0o700);
  }
  const root = await ops.realpath(requested);
  const info = await ops.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink?.()
    || (expectedUid() !== null && info.uid !== expectedUid())
    || (options.tempRoot && (info.mode & 0o077) !== 0)) {
    throw new PublicationAssetSnapshotError("snapshot_directory_unsafe", "The publication snapshot root is unavailable or unsafe.");
  }
  return root;
}

async function zeroSnapshotFile(path, ops) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    const pathInfo = await ops.lstat(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink?.()
      || (expectedUid() !== null && pathInfo.uid !== expectedUid()) || (pathInfo.mode & 0o077) !== 0
      || pathInfo.size > MAX_SNAPSHOT_BYTES) {
      throw new PublicationAssetSnapshotError("snapshot_file_unsafe", "A stale publication snapshot file is unsafe.");
    }
    handle = await ops.open(path, constants.O_RDWR | noFollow);
    const fdInfo = await handle.stat();
    if (!fdInfo.isFile() || fdInfo.dev !== pathInfo.dev || fdInfo.ino !== pathInfo.ino || fdInfo.size !== pathInfo.size) {
      throw new PublicationAssetSnapshotError("snapshot_file_changed", "A stale publication snapshot file changed during cleanup.");
    }
    if (fdInfo.size) {
      const zeros = Buffer.alloc(Math.min(fdInfo.size, 1024 * 1024));
      let position = 0;
      while (position < fdInfo.size) {
        const length = Math.min(zeros.length, fdInfo.size - position);
        await handle.write(zeros, 0, length, position);
        position += length;
      }
    }
    await handle.truncate(0);
    await handle.sync();
    const linked = fdInfo.nlink !== 1;
    await handle.close();
    handle = null;
    await ops.unlink(path);
    if (linked) {
      throw new PublicationAssetSnapshotError("snapshot_file_unsafe", "A linked stale snapshot was zeroed and removed.");
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Startup privacy recovery. Only directories and files created by this module
 * are touched; every stale regular file is zeroed through a no-follow file
 * descriptor before unlink so an app crash cannot retain unpublished assets.
 */
async function purgeStalePublicationAssetSnapshots(options = {}) {
  if (!options.tempRoot) {
    throw new PublicationAssetSnapshotError("snapshot_directory_unsafe", "A dedicated publication snapshot root is required for startup cleanup.");
  }
  const ops = { ...defaultOps(), ...(options.ops || {}) };
  const root = await resolveSnapshotRoot(options, ops);
  const failures = [];
  const directoryPattern = /^echo-founder-publication-[a-f0-9]{16}-[A-Za-z0-9]{6}$/;
  const filePattern = /^\d{2}-[a-f0-9]{16}\.(?:png|jpg|jpeg|gif|webp|bin)$/;
  const entries = await ops.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!directoryPattern.test(entry.name)) continue;
    const directory = join(root, entry.name);
    try {
      const directoryInfo = await ops.lstat(directory);
      assertPrivateDirectory(directoryInfo);
      const children = await ops.readdir(directory, { withFileTypes: true });
      for (const child of children) {
        const path = join(directory, child.name);
        if (!filePattern.test(child.name)) {
          failures.push(new PublicationAssetSnapshotError("snapshot_file_unsafe", "A stale publication snapshot contains an unexpected entry."));
          continue;
        }
        try {
          await zeroSnapshotFile(path, ops);
        } catch (error) {
          failures.push(error);
        }
      }
      await ops.rmdir(directory).catch((error) => failures.push(error));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new PublicationAssetSnapshotError("snapshot_cleanup_failed", "Stale publication asset snapshots could not be fully sanitized.");
  }
  return { root, purged: entries.filter((entry) => directoryPattern.test(entry.name)).length };
}

async function createPublicationAssetSnapshot(assets, options = {}) {
  if (!Array.isArray(assets) || assets.length > MAX_SNAPSHOT_ASSETS) {
    throw new PublicationAssetSnapshotError("snapshot_input_invalid", "The publication asset snapshot input is invalid.");
  }
  if (assets.length === 0) {
    return { paths: [], directory: "", validate: async () => undefined, cleanup: async () => undefined };
  }
  const ops = { ...defaultOps(), ...(options.ops || {}) };
  let parent;
  try {
    parent = await resolveSnapshotRoot(options, ops);
  } catch {
    throw new PublicationAssetSnapshotError("snapshot_directory_unsafe", "The publication snapshot root is unavailable.");
  }

  let directory = "";
  const records = [];
  let cleaned = false;

  async function validate() {
    if (cleaned) throw new PublicationAssetSnapshotError("snapshot_file_changed", "The publication asset snapshot has already been cleaned.");
    let directoryInfo;
    try {
      directoryInfo = await ops.lstat(directory);
      assertPrivateDirectory(directoryInfo);
    } catch (error) {
      if (error instanceof PublicationAssetSnapshotError) throw error;
      throw new PublicationAssetSnapshotError("snapshot_directory_unsafe", "The publication asset snapshot directory changed.");
    }
    for (const record of records) {
      try {
        const [fdInfo, pathInfo] = await Promise.all([record.handle.stat(), ops.lstat(record.path)]);
        assertPrivateFile(fdInfo, record.buffer.length);
        assertPrivateFile(pathInfo, record.buffer.length);
        if (!sameIdentity(fdInfo, record.identity) || !sameIdentity(pathInfo, record.identity)) {
          throw new PublicationAssetSnapshotError("snapshot_file_changed", "A publication asset snapshot path changed.");
        }
        const bytes = await readExact(record.handle, record.buffer.length);
        if (sha256(bytes) !== record.sha256) {
          throw new PublicationAssetSnapshotError("snapshot_file_changed", "A publication asset snapshot hash changed.");
        }
      } catch (error) {
        if (error instanceof PublicationAssetSnapshotError) throw error;
        throw new PublicationAssetSnapshotError("snapshot_file_changed", "A publication asset snapshot could not be revalidated.");
      }
    }
  }

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    const failures = [];
    for (const record of records) {
      // Zero and truncate through the original file descriptor before unlinking.
      // Thus even an unlink/rmdir failure cannot leave the approved bytes behind.
      try {
        if (record.buffer.length) {
          const zeros = Buffer.alloc(Math.min(record.buffer.length, 1024 * 1024));
          let position = 0;
          while (position < record.buffer.length) {
            const length = Math.min(zeros.length, record.buffer.length - position);
            await record.handle.write(zeros, 0, length, position);
            position += length;
          }
        }
        await record.handle.truncate(0);
        await record.handle.sync();
      } catch (error) {
        failures.push(error);
      }
      try {
        await ops.unlink(record.path);
      } catch (error) {
        if (error?.code !== "ENOENT") failures.push(error);
      }
      try {
        await record.handle.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (directory) {
      try {
        await ops.chmod(directory, 0o700);
        await ops.rmdir(directory);
      } catch (error) {
        if (error?.code !== "ENOENT") failures.push(error);
      }
    }
    if (failures.length) {
      throw new PublicationAssetSnapshotError(
        "snapshot_cleanup_failed",
        "The publication asset snapshot could not be fully removed; all reachable snapshot bytes were zeroed.",
      );
    }
  }

  try {
    directory = await ops.mkdtemp(join(parent, `echo-founder-publication-${randomBytes(8).toString("hex")}-`));
    await ops.chmod(directory, 0o700);
    const directoryInfo = await ops.lstat(directory);
    assertPrivateDirectory(directoryInfo);
    for (const [index, asset] of assets.entries()) {
      if (!asset || !Buffer.isBuffer(asset.buffer) || asset.buffer.length > MAX_SNAPSHOT_BYTES
        || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256)
        || sha256(asset.buffer) !== asset.sha256.toLowerCase()) {
        throw new PublicationAssetSnapshotError("snapshot_input_invalid", "A verified publication asset is invalid.");
      }
      const extension = SAFE_EXTENSIONS.has(extname(asset.relativePath || "").toLowerCase())
        ? extname(asset.relativePath).toLowerCase()
        : ".bin";
      const path = join(directory, `${String(index + 1).padStart(2, "0")}-${asset.sha256.slice(0, 16)}${extension}`);
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      const handle = await ops.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, 0o600);
      const record = { path, handle, buffer: asset.buffer, sha256: asset.sha256.toLowerCase(), identity: null };
      records.push(record);
      await handle.writeFile(asset.buffer);
      await handle.sync();
      const [fdInfo, pathInfo] = await Promise.all([handle.stat(), ops.lstat(path)]);
      assertPrivateFile(fdInfo, asset.buffer.length);
      assertPrivateFile(pathInfo, asset.buffer.length);
      if (!sameIdentity(fdInfo, pathInfo)) {
        throw new PublicationAssetSnapshotError("snapshot_file_unsafe", "A publication asset snapshot path was replaced.");
      }
      record.identity = fdInfo;
    }
    await validate();
    return { paths: records.map((record) => record.path), directory, validate, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch {
      // Preserve the original fail-closed cause. cleanup already zeroed every
      // snapshot file reachable through its original descriptor.
    }
    if (error instanceof PublicationAssetSnapshotError) throw error;
    throw new PublicationAssetSnapshotError("snapshot_creation_failed", "The publication asset snapshot could not be created.");
  }
}

module.exports = {
  PublicationAssetSnapshotError,
  createPublicationAssetSnapshot,
  purgeStalePublicationAssetSnapshots,
};
