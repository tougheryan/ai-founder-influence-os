const { randomUUID } = require("node:crypto");
const { constants } = require("node:fs");
const { lstat, mkdir, open, realpath, rename, unlink } = require("node:fs/promises");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");
const { secureReadProjectFile } = require("./publication-authority.cjs");

const PUBLICATION_TRANSACTION_SCHEMA = "echo-founder.publication-transaction.v1";
const TRANSACTION_ROOT = "materials/publication/desktop-transactions";
const MAX_JOURNAL_BYTES = 1024 * 1024;
const RESULT_STATUSES = new Set(["draft_filled", "retryable_failure", "manual_intervention_required", "unknown_completion"]);
const ADAPTERS = new Set(["wechat_official_api", "authorized_browser", "mobile_bridge", "download"]);
const RETRYABLE_QUEUE_STATUSES = new Set(["retryable_failure", "manual_intervention_required"]);
const ATTEMPTABLE_QUEUE_STATUSES = new Set(["pending", ...RETRYABLE_QUEUE_STATUSES]);
const SENSITIVE_KEY = /(?:secret|token|cookie|password|api[_-]?key|private[_-]?key|credential)/i;

class PublicationTransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicationTransactionError";
    this.code = code;
  }
}

function safeString(value, label, pattern, max = 1024) {
  if (typeof value !== "string") throw new PublicationTransactionError("transaction_identity_invalid", `${label} is invalid.`);
  const result = value.trim();
  if (!result || Buffer.byteLength(result, "utf8") > max || (pattern && !pattern.test(result))) {
    throw new PublicationTransactionError("transaction_identity_invalid", `${label} is invalid.`);
  }
  return result;
}

function assertNoSensitiveKeys(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach(assertNoSensitiveKeys);
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new PublicationTransactionError("transaction_result_invalid", "Publication transaction data contains a sensitive field.");
    assertNoSensitiveKeys(nested);
  }
}

function normalizeIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PublicationTransactionError("transaction_identity_invalid", "Publication transaction identity is invalid.");
  }
  const runId = safeString(input.runId, "runId", /^[A-Za-z0-9._\-\u4e00-\u9fff]{1,256}$/, 256);
  const jobId = safeString(input.jobId, "jobId", /^draft_[a-f0-9]{20}$/, 64);
  const payloadHash = safeString(input.payloadHash, "payloadHash", /^[a-f0-9]{64}$/i, 64).toLowerCase();
  const queuePath = safeString(
    input.queuePath,
    "queuePath",
    /^materials\/publication\/drafts\/[A-Za-z0-9_\-\u4e00-\u9fff]+\/draft-queue\.json$/,
    1024,
  );
  const adapter = safeString(input.adapter, "adapter", null, 64);
  if (!ADAPTERS.has(adapter)) throw new PublicationTransactionError("transaction_identity_invalid", "adapter is invalid.");
  return { runId, jobId, payloadHash, queuePath, adapter };
}

function normalizeQueueAttemptContext(input) {
  const currentJobStatus = safeString(input?.currentJobStatus, "currentJobStatus", null, 64);
  if (!ATTEMPTABLE_QUEUE_STATUSES.has(currentJobStatus)) {
    throw new PublicationTransactionError("transaction_identity_invalid", "currentJobStatus is invalid.");
  }
  if (!Number.isSafeInteger(input?.queueAttemptCount) || input.queueAttemptCount < 0) {
    throw new PublicationTransactionError("transaction_identity_invalid", "queueAttemptCount is invalid.");
  }
  return { currentJobStatus, queueAttemptCount: input.queueAttemptCount };
}

function normalizeResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !RESULT_STATUSES.has(input.status)) {
    throw new PublicationTransactionError("transaction_result_invalid", "Publication transaction result is invalid.");
  }
  assertNoSensitiveKeys(input);
  const output = { status: input.status };
  for (const [key, max] of [["authorizationState", 64], ["code", 128], ["message", 1024], ["externalReference", 512]]) {
    if (input[key] === undefined || input[key] === "") continue;
    output[key] = safeString(input[key], key, null, max);
    if (isAbsolute(output[key]) || output[key].includes("\0")) {
      throw new PublicationTransactionError("transaction_result_invalid", "Publication transaction results cannot contain absolute local paths.");
    }
  }
  return output;
}

function journalPathForIdentity(input) {
  const identity = normalizeIdentity(input);
  return `${TRANSACTION_ROOT}/${identity.runId}/${identity.jobId}.json`;
}

function sameJournalIdentity(journal, identity) {
  return journal.run_id === identity.runId && journal.job_id === identity.jobId
    && journal.payload_hash === identity.payloadHash && journal.queue_path === identity.queuePath;
}

function isSubpath(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function assertOwnedDirectory(info, privateMode = false) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isDirectory() || info.isSymbolicLink?.() || (uid !== null && info.uid !== uid)
    || (privateMode && (info.mode & 0o077) !== 0)) {
    throw new PublicationTransactionError("transaction_path_unsafe", "The publication transaction directory is unsafe.");
  }
}

async function ensureTransactionDirectory(projectDir, runId) {
  let root;
  try {
    root = await realpath(resolve(projectDir));
  } catch {
    throw new PublicationTransactionError("transaction_path_unsafe", "The active project directory is unavailable.");
  }
  const components = ["materials", "publication", "desktop-transactions", runId];
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    if (!isSubpath(root, current)) throw new PublicationTransactionError("transaction_path_unsafe", "The publication transaction path escaped the project.");
    try {
      await mkdir(current, { mode: index >= 2 ? 0o700 : 0o755 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    assertOwnedDirectory(info, index >= 2);
  }
  return { root, directory: current };
}

async function readJournal(projectDir, relativePath, missingAllowed = false) {
  try {
    const file = await secureReadProjectFile(projectDir, relativePath, {
      label: "publication transaction journal",
      maxBytes: MAX_JOURNAL_BYTES,
      missingCode: "transaction_missing",
    });
    const journal = JSON.parse(file.buffer.toString("utf8"));
    if (!journal || typeof journal !== "object" || Array.isArray(journal)
      || journal.schema !== PUBLICATION_TRANSACTION_SCHEMA || !Array.isArray(journal.attempts)) {
      throw new Error("invalid journal");
    }
    assertNoSensitiveKeys(journal);
    return journal;
  } catch (error) {
    if (missingAllowed && error?.code === "transaction_missing") return null;
    if (error instanceof PublicationTransactionError) throw error;
    throw new PublicationTransactionError("transaction_journal_invalid", "The publication transaction journal is missing or invalid.");
  }
}

async function writeJournalAtomic(projectDir, identity, journal, directory) {
  const relativePath = journalPathForIdentity(identity);
  const target = resolve(projectDir, relativePath);
  const temp = join(directory, `.${identity.jobId}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_JOURNAL_BYTES) throw new PublicationTransactionError("transaction_journal_invalid", "The publication transaction journal is too large.");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const info = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isFile() || info.nlink !== 1 || info.size !== bytes.length || (uid !== null && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      throw new PublicationTransactionError("transaction_path_unsafe", "The publication transaction temporary file is unsafe.");
    }
    await handle.close();
    handle = null;
    await rename(temp, target);
    const verified = await readJournal(projectDir, relativePath);
    if (!sameJournalIdentity(verified, identity)) throw new PublicationTransactionError("transaction_journal_invalid", "The persisted transaction identity changed.");
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    if (error instanceof PublicationTransactionError) throw error;
    throw new PublicationTransactionError("transaction_write_failed", "The publication transaction journal could not be persisted.");
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function reclaimDeadLock(lockPath) {
  let pathInfo;
  let handle;
  try {
    pathInfo = await lstat(lockPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink?.() || pathInfo.nlink !== 1
      || (uid !== null && pathInfo.uid !== uid) || (pathInfo.mode & 0o077) !== 0 || pathInfo.size > 4096) return false;
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(lockPath, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino
      || before.size !== pathInfo.size || (uid !== null && before.uid !== uid)) return false;
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) return false;
    const owner = JSON.parse(buffer.toString("utf8"));
    if (!owner || owner.schema !== "echo-founder.publication-transaction-lock.v1"
      || !Number.isInteger(owner.pid) || owner.pid <= 0
      || typeof owner.instance_id !== "string" || !/^[a-f0-9-]{36}$/i.test(owner.instance_id)
      || processIsAlive(owner.pid)) return false;
    const current = await lstat(lockPath);
    if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1) return false;
    const quarantine = `${lockPath}.dead-${randomUUID()}`;
    await rename(lockPath, quarantine);
    await unlink(quarantine);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function withJournalLock(projectDir, identity, task, hooks = {}) {
  const { directory } = await ensureTransactionDirectory(projectDir, identity.runId);
  const lockPath = join(directory, `${identity.jobId}.lock`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let lock;
  for (let attempt = 0; attempt < 2 && !lock; attempt += 1) {
    try {
      lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      await lock.writeFile(Buffer.from(`${JSON.stringify({
        schema: "echo-founder.publication-transaction-lock.v1",
        pid: process.pid,
        instance_id: randomUUID(),
        created_at: new Date().toISOString(),
      })}\n`, "utf8"));
      await lock.sync();
    } catch (error) {
      if (lock) await lock.close().catch(() => undefined);
      lock = null;
      if (error?.code === "EEXIST" && attempt === 0 && await reclaimDeadLock(lockPath)) continue;
      break;
    }
  }
  if (!lock) {
    throw new PublicationTransactionError("transaction_locked", "Another publication transaction owns this job; retry is blocked.");
  }
  let hookError;
  try {
    if (typeof hooks.onLockAcquired === "function") await hooks.onLockAcquired(lockPath);
    return await task(directory);
  } finally {
    if (typeof hooks.onBeforeLockRelease === "function") {
      try {
        await hooks.onBeforeLockRelease(lockPath);
      } catch (error) {
        hookError = error;
      }
    }
    await lock.close().catch(() => undefined);
    try {
      await unlink(lockPath);
    } catch (error) {
      throw new PublicationTransactionError("transaction_lock_cleanup_failed", "The publication transaction lock could not be removed.");
    }
    if (hookError) throw hookError;
  }
}

function createPublicationTransactionManager(options) {
  const projectDir = () => typeof options.projectDir === "function" ? options.projectDir() : options.projectDir;
  const now = options.now || (() => new Date().toISOString());
  const idFactory = options.idFactory || randomUUID;

  async function beginAttempt(input) {
    const { currentJobStatus, queueAttemptCount } = normalizeQueueAttemptContext(input);
    const identity = normalizeIdentity(input);
    return withJournalLock(projectDir(), identity, async (directory) => {
      const relativePath = journalPathForIdentity(identity);
      const journal = await readJournal(projectDir(), relativePath, true) || {
        schema: PUBLICATION_TRANSACTION_SCHEMA,
        run_id: identity.runId,
        job_id: identity.jobId,
        payload_hash: identity.payloadHash,
        queue_path: identity.queuePath,
        attempts: [],
        created_at: now(),
        updated_at: now(),
      };
      if (!sameJournalIdentity(journal, identity)) {
        throw new PublicationTransactionError("transaction_identity_mismatch", "The existing publication transaction belongs to another payload.");
      }
      const latest = journal.attempts.at(-1);
      if (latest?.status === "in_flight") {
        latest.status = "completed";
        latest.completed_at = now();
        latest.recovered_after_restart = true;
        latest.result = {
          status: "unknown_completion",
          authorizationState: "requires_human_action",
          code: "publication_attempt_interrupted",
          message: "A previous platform attempt ended before its result was durably recorded. Verify the platform draft manually; automatic retry is blocked.",
        };
        journal.updated_at = now();
        await writeJournalAtomic(projectDir(), identity, journal, directory);
        return { action: "replay", adapter: latest.adapter, result: latest.result, recovered: true, attemptId: latest.attempt_id };
      }
      if (latest?.status === "completed") {
        const previousResult = normalizeResult(latest.result);
        const terminal = previousResult.status === "draft_filled" || previousResult.status === "unknown_completion";
        const serverConfirmedRetry = RETRYABLE_QUEUE_STATUSES.has(previousResult.status)
          && currentJobStatus === previousResult.status
          && Number.isSafeInteger(latest.queue_attempt_count)
          && queueAttemptCount > latest.queue_attempt_count;
        if (terminal || !serverConfirmedRetry) {
          return {
            action: "replay",
            adapter: latest.adapter,
            result: previousResult,
            recovered: Boolean(latest.recovered_after_restart),
            attemptId: latest.attempt_id,
          };
        }
      }
      const attempt = {
        attempt_id: idFactory(),
        status: "in_flight",
        adapter: identity.adapter,
        started_at: now(),
        queue_attempt_count: queueAttemptCount,
      };
      journal.attempts.push(attempt);
      journal.updated_at = now();
      await writeJournalAtomic(projectDir(), identity, journal, directory);
      return { action: "execute", attemptId: attempt.attempt_id };
    }, options);
  }

  async function completeAttempt(input, attemptId, fillResult) {
    const identity = normalizeIdentity(input);
    const adapter = safeString(fillResult?.adapter, "result adapter", null, 64);
    if (!ADAPTERS.has(adapter)) throw new PublicationTransactionError("transaction_result_invalid", "The publication result adapter is invalid.");
    const result = normalizeResult(fillResult?.result);
    return withJournalLock(projectDir(), identity, async (directory) => {
      const relativePath = journalPathForIdentity(identity);
      const journal = await readJournal(projectDir(), relativePath);
      if (!sameJournalIdentity(journal, identity)) throw new PublicationTransactionError("transaction_identity_mismatch", "The publication transaction identity changed.");
      const latest = journal.attempts.at(-1);
      if (!latest || latest.attempt_id !== attemptId) throw new PublicationTransactionError("transaction_attempt_mismatch", "The publication attempt is not current.");
      if (latest.status === "completed") {
        if (latest.adapter !== adapter || JSON.stringify(normalizeResult(latest.result)) !== JSON.stringify(result)) {
          throw new PublicationTransactionError("transaction_attempt_mismatch", "A completed publication attempt cannot be replaced.");
        }
        return { adapter, result, replayed: true };
      }
      if (latest.status !== "in_flight") throw new PublicationTransactionError("transaction_attempt_mismatch", "The publication attempt cannot be completed.");
      latest.status = "completed";
      latest.adapter = adapter;
      latest.result = result;
      latest.completed_at = now();
      journal.updated_at = now();
      await writeJournalAtomic(projectDir(), identity, journal, directory);
      return { adapter, result, replayed: false };
    }, options);
  }

  return { beginAttempt, completeAttempt, journalPathForIdentity };
}

module.exports = {
  PUBLICATION_TRANSACTION_SCHEMA,
  PublicationTransactionError,
  createPublicationTransactionManager,
  journalPathForIdentity,
};
