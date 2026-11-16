const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const test = require("node:test");
const {
  createPublicationTransactionManager,
  journalPathForIdentity,
} = require("./publication-transaction.cjs");

const identity = {
  queuePath: "materials/publication/drafts/demo/draft-queue.json",
  runId: "run-demo",
  jobId: `draft_${"a".repeat(20)}`,
  payloadHash: "b".repeat(64),
  adapter: "wechat_official_api",
  currentJobStatus: "pending",
  queueAttemptCount: 0,
};

function manager(root, suffix = "1") {
  return createPublicationTransactionManager({
    projectDir: () => root,
    now: (() => {
      let count = 0;
      return () => `2026-08-24T00:00:0${count++}.000+08:00`;
    })(),
    idFactory: () => `attempt-${suffix}`,
  });
}

test("an in-flight attempt is durably recovered as unknown and never executed twice after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-publication-transaction-"));
  try {
    const first = await manager(root, "first").beginAttempt(identity);
    assert.deepEqual(first, { action: "execute", attemptId: "attempt-first" });

    const recovered = await manager(root, "second").beginAttempt(identity);
    assert.equal(recovered.action, "replay");
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.result.status, "unknown_completion");
    assert.equal(recovered.result.code, "publication_attempt_interrupted");

    const replay = await manager(root, "third").beginAttempt(identity);
    assert.equal(replay.action, "replay");
    assert.equal(replay.result.status, "unknown_completion");
    const journal = JSON.parse(await readFile(join(root, ...journalPathForIdentity(identity).split("/")), "utf8"));
    assert.equal(journal.attempts.length, 1);
    assert.equal(journal.attempts[0].status, "completed");
    assert.equal(JSON.stringify(journal).includes("secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed platform result is replayed idempotently without a new attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-publication-complete-"));
  try {
    const transactions = manager(root, "completed");
    const begun = await transactions.beginAttempt(identity);
    await transactions.completeAttempt(identity, begun.attemptId, {
      adapter: "wechat_official_api",
      result: { status: "draft_filled", externalReference: "wechat-draft:media-1" },
    });
    const replay = await manager(root, "restart").beginAttempt(identity);
    assert.equal(replay.action, "replay");
    assert.equal(replay.result.status, "draft_filled");
    assert.equal(replay.result.externalReference, "wechat-draft:media-1");
    const journal = JSON.parse(await readFile(join(root, ...journalPathForIdentity(identity).split("/")), "utf8"));
    assert.equal(journal.attempts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a retry is opened only after the authoritative queue records the prior retryable result", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-publication-retry-"));
  try {
    const transactions = manager(root, "first");
    const begun = await transactions.beginAttempt({ ...identity, currentJobStatus: "pending" });
    await transactions.completeAttempt(identity, begun.attemptId, {
      adapter: "wechat_official_api",
      result: { status: "retryable_failure", code: "network_timeout", message: "Timed out." },
    });
    const duplicate = await manager(root, "duplicate").beginAttempt(identity);
    assert.equal(duplicate.action, "replay");
    const retryContext = { ...identity, currentJobStatus: "retryable_failure", queueAttemptCount: 1 };
    const retryManager = manager(root, "retry");
    const retry = await retryManager.beginAttempt(retryContext);
    assert.deepEqual(retry, { action: "execute", attemptId: "attempt-retry" });
    await retryManager.completeAttempt(retryContext, retry.attemptId, {
      adapter: "wechat_official_api",
      result: { status: "retryable_failure", code: "network_timeout", message: "Timed out again." },
    });

    const staleConcurrentRetry = await manager(root, "stale-concurrent").beginAttempt(retryContext);
    assert.equal(staleConcurrentRetry.action, "replay");
    assert.equal(staleConcurrentRetry.result.status, "retryable_failure");

    const nextRetry = await manager(root, "next-retry").beginAttempt({
      ...retryContext,
      queueAttemptCount: 2,
    });
    assert.deepEqual(nextRetry, { action: "execute", attemptId: "attempt-next-retry" });
    const journal = JSON.parse(await readFile(join(root, ...journalPathForIdentity(identity).split("/")), "utf8"));
    assert.equal(journal.attempts.length, 3);
    assert.deepEqual(journal.attempts.map((attempt) => attempt.queue_attempt_count), [0, 1, 2]);
    assert.equal(journal.attempts[2].status, "in_flight");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lock owner killed after persisting in-flight is safely reclaimed and recovered", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-publication-dead-lock-"));
  try {
    const modulePath = require.resolve("./publication-transaction.cjs");
    const childScript = `
      const { createPublicationTransactionManager } = require(process.env.TX_MODULE);
      const identity = JSON.parse(process.env.TX_IDENTITY);
      const manager = createPublicationTransactionManager({
        projectDir: () => process.env.TX_ROOT,
        idFactory: () => "attempt-killed",
        onBeforeLockRelease: async () => {
          process.stdout.write("LOCKED_AFTER_JOURNAL\\n");
          await new Promise(() => {});
        },
      });
      manager.beginAttempt(identity).catch((error) => { process.stderr.write(String(error.stack || error)); process.exit(2); });
    `;
    const child = spawn(process.execPath, ["-e", childScript], {
      env: { ...process.env, TX_MODULE: modulePath, TX_ROOT: root, TX_IDENTITY: JSON.stringify(identity) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("LOCKED_AFTER_JOURNAL")) resolve();
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("exit", (code) => reject(new Error(`child exited before lock marker: ${code} ${stderr}`)));
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const recovered = await manager(root, "recovered-lock").beginAttempt(identity);
    assert.equal(recovered.action, "replay");
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.result.status, "unknown_completion");
    assert.equal(recovered.result.code, "publication_attempt_interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linked journals and malformed transaction locks fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-founder-publication-transaction-links-"));
  try {
    const transactions = manager(root, "linked");
    const begun = await transactions.beginAttempt(identity);
    await transactions.completeAttempt(identity, begun.attemptId, {
      adapter: "wechat_official_api",
      result: { status: "draft_filled", externalReference: "wechat-draft:media-1" },
    });
    const journalPath = join(root, ...journalPathForIdentity(identity).split("/"));
    const hardlink = `${journalPath}.hardlink`;
    await link(journalPath, hardlink);
    await assert.rejects(manager(root, "hardlink").beginAttempt(identity), (error) => error?.code === "transaction_journal_invalid");
    await unlink(hardlink);

    const realJournal = `${journalPath}.real`;
    await writeFile(realJournal, await readFile(journalPath), { mode: 0o600 });
    await unlink(journalPath);
    await symlink(realJournal, journalPath);
    await assert.rejects(manager(root, "symlink").beginAttempt(identity), (error) => error?.code === "transaction_journal_invalid");
    await unlink(journalPath);
    await writeFile(journalPath, await readFile(realJournal), { mode: 0o600 });

    const lockPath = join(dirname(journalPath), `${identity.jobId}.lock`);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "stale\n", { mode: 0o600 });
    await assert.rejects(manager(root, "locked").beginAttempt(identity), (error) => error?.code === "transaction_locked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
