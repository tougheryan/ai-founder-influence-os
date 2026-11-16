const test = require("node:test");
const assert = require("node:assert/strict");
const { createServiceLifecycleCoordinator } = require("./service-lifecycle.cjs");

function createSerialQueue() {
  let pending = Promise.resolve();
  return (task) => {
    const operation = pending.then(task, task);
    pending = operation.catch(() => {});
    return operation;
  };
}

test("manual restart supersedes an in-flight watchdog recovery without spawning two services", async () => {
  const lifecycle = createServiceLifecycleCoordinator(createSerialQueue());
  const events = [];
  let releaseWatchdogWait;
  const watchdogWait = new Promise((resolve) => { releaseWatchdogWait = resolve; });
  let watchdogDetached;
  const detached = new Promise((resolve) => { watchdogDetached = resolve; });

  const watchdog = lifecycle.run(async ({ isCurrent }) => {
    events.push("watchdog:kill-old");
    watchdogDetached();
    await watchdogWait;
    if (!isCurrent()) {
      events.push("watchdog:superseded");
      return { started: false };
    }
    events.push("watchdog:start");
    return { started: true };
  });

  await detached;
  const manual = lifecycle.run(async () => {
    events.push("manual:start");
    return { started: true };
  });
  releaseWatchdogWait();

  assert.deepEqual(await watchdog, { started: false });
  assert.deepEqual(await manual, { started: true });
  assert.deepEqual(events, ["watchdog:kill-old", "watchdog:superseded", "manual:start"]);
});

test("lifecycle tasks never overlap even when an earlier task rejects", async () => {
  const lifecycle = createServiceLifecycleCoordinator(createSerialQueue());
  let active = 0;
  let maxActive = 0;

  const first = lifecycle.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
    throw new Error("expected failure");
  });
  const second = lifecycle.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
    return "ready";
  });

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "ready");
  assert.equal(maxActive, 1);
});
