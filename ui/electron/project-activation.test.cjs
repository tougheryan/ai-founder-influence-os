const test = require("node:test");
const assert = require("node:assert/strict");
const { restoreAndActivateProject } = require("./project-activation.cjs");

test("project activation occurs only after the complete restore validator succeeds", async () => {
  const events = [];
  const restored = await restoreAndActivateProject({
    currentProjectDir: "/projects/current",
    nextProjectDir: "/projects/restored",
    restore: async () => {
      events.push("verified-and-copied");
      return { fileCount: 12 };
    },
    selectProject: async (value) => { events.push(`selected:${value}`); },
    restart: async () => { events.push("healthy-restart"); },
  });

  assert.deepEqual(restored, { fileCount: 12 });
  assert.deepEqual(events, [
    "verified-and-copied",
    "selected:/projects/restored",
    "healthy-restart",
  ]);
});

test("failed restore validation never changes the active project", async () => {
  const events = [];
  await assert.rejects(
    restoreAndActivateProject({
      currentProjectDir: "/projects/current",
      nextProjectDir: "/projects/restored",
      restore: async () => { throw new Error("checksum mismatch"); },
      selectProject: async (value) => { events.push(`selected:${value}`); },
      restart: async () => { events.push("restart"); },
    }),
    /checksum mismatch/i,
  );
  assert.deepEqual(events, []);
});

test("failed checked restart restores the prior project selection", async () => {
  const events = [];
  await assert.rejects(
    restoreAndActivateProject({
      currentProjectDir: "/projects/current",
      nextProjectDir: "/projects/restored",
      restore: async () => ({ fileCount: 3 }),
      selectProject: async (value) => { events.push(`selected:${value}`); },
      restart: async () => {
        events.push("new-restart-failed");
        throw new Error("health readiness failed");
      },
      restartAfterRollback: async () => { events.push("old-restart-ready"); },
    }),
    /health readiness failed/i,
  );
  assert.deepEqual(events, [
    "selected:/projects/restored",
    "new-restart-failed",
    "selected:/projects/current",
    "old-restart-ready",
  ]);
});
