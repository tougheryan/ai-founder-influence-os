const test = require("node:test");
const assert = require("node:assert/strict");
const {
  restartDesktopService,
  runWithQuiescedService,
  updateCredentialWithCheckedRestart,
} = require("./service-restart.cjs");

test("checked restart resolves only after the service reports authenticated readiness", async () => {
  const events = [];
  const result = await restartDesktopService({
    stop: async () => { events.push("stopped"); },
    beforeStart: async () => { events.push("loading"); },
    start: async () => {
      events.push("started");
      return { ready: true, url: "http://127.0.0.1:3210" };
    },
    requireReady: true,
  });

  assert.deepEqual(events, ["stopped", "loading", "started"]);
  assert.equal(result.ready, true);
});

test("checked restart rejects when startup exits into background recovery", async () => {
  const failures = [];
  await assert.rejects(
    restartDesktopService({
      stop: async () => {},
      start: async () => ({ ready: false, recoveryScheduled: true }),
      onFailure: (error) => failures.push(error.message),
      requireReady: true,
    }),
    /did not reach authenticated health readiness/i,
  );
  assert.equal(failures.length, 1);
});

test("menu restart can report a failure without creating an unhandled rejection", async () => {
  const failures = [];
  const result = await restartDesktopService({
    stop: async () => {},
    start: async () => { throw new Error("startup failed"); },
    onFailure: (error) => failures.push(error.message),
    requireReady: false,
  });

  assert.deepEqual(result, { ready: false, error: true });
  assert.deepEqual(failures, ["startup failed"]);
});

test("checked restart defers renderer navigation until after the IPC-facing promise resolves", async () => {
  const events = [];
  const scheduled = [];
  const restartPromise = restartDesktopService({
    stop: async () => { events.push("stopped"); },
    start: async () => {
      events.push("health-ready");
      return { ready: true, url: "http://127.0.0.1:4321" };
    },
    afterReady: (result) => { events.push(`navigate:${result.url}`); },
    scheduleAfterReady: (callback) => { scheduled.push(callback); },
    requireReady: true,
  });

  const result = await restartPromise;
  assert.equal(result.ready, true);
  assert.deepEqual(events, ["stopped", "health-ready"]);
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.deepEqual(events, ["stopped", "health-ready", "navigate:http://127.0.0.1:4321"]);
});

test("credential update restores the previous encrypted value when checked restart fails", async () => {
  let stored = "old-encrypted-value";
  let restartCount = 0;

  await assert.rejects(
    updateCredentialWithCheckedRestart({
      readCurrent: () => stored,
      apply: () => {
        stored = "new-encrypted-value";
        return { configured: true };
      },
      restore: (previous) => { stored = previous; },
      restart: async () => {
        restartCount += 1;
        if (restartCount === 1) throw new Error("new service failed health check");
        return { ready: true };
      },
    }),
    /new service failed health check/,
  );

  assert.equal(stored, "old-encrypted-value");
  assert.equal(restartCount, 2);
});

test("credential deletion is also rolled back before restoring the old service", async () => {
  let stored = "old-encrypted-value";
  let restartCount = 0;

  await assert.rejects(updateCredentialWithCheckedRestart({
    readCurrent: () => stored,
    apply: () => {
      stored = "";
      return { configured: false };
    },
    restore: (previous) => { stored = previous; },
    restart: async () => {
      restartCount += 1;
      if (restartCount === 1) throw new Error("deleted service failed health check");
    },
  }), /deleted service failed health check/);

  assert.equal(stored, "old-encrypted-value");
  assert.equal(restartCount, 2);
});

test("project snapshot runs only while the service is fully stopped and always restores readiness", async () => {
  const events = [];
  const result = await runWithQuiescedService({
    stop: async () => { events.push("stop"); },
    waitStopped: async () => { events.push("port-closed"); return true; },
    operation: async () => { events.push("snapshot"); return { manifest: "abc" }; },
    start: async () => { events.push("start"); return { ready: true, url: "http://127.0.0.1:3000" }; },
  });

  assert.deepEqual(events, ["stop", "port-closed", "snapshot", "start"]);
  assert.deepEqual(result.operationResult, { manifest: "abc" });
  assert.equal(result.startResult.ready, true);
});

test("failed project snapshot still restores the service before returning the error", async () => {
  const events = [];
  await assert.rejects(runWithQuiescedService({
    stop: async () => { events.push("stop"); },
    waitStopped: async () => true,
    operation: async () => { events.push("snapshot"); throw new Error("snapshot failed"); },
    start: async () => { events.push("start"); return { ready: true }; },
  }), /snapshot failed/);
  assert.deepEqual(events, ["stop", "snapshot", "start"]);
});
