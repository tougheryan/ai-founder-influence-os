const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadPreload(invokeImplementation) {
  const exposed = {};
  const invocations = [];
  const source = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  vm.runInNewContext(source, {
    require: (id) => {
      // Electron sandboxed preloads cannot load arbitrary local Node modules.
      // This test deliberately mirrors that restricted require surface.
      assert.equal(id, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (name, api) => { exposed[name] = api; },
        },
        ipcRenderer: {
          invoke: async (...args) => {
            invocations.push(args);
            if (invokeImplementation) return invokeImplementation(...args);
            return { ok: true };
          },
        },
      };
    },
  }, { filename: "preload.cjs" });
  return { exposed, invocations };
}

test("preload exposes status-only credential and project-backup APIs", async () => {
  const { exposed, invocations } = loadPreload();
  assert.deepEqual(Object.keys(exposed.aifiosCredentials).sort(), ["delete", "save", "status"]);
  assert.deepEqual(Object.keys(exposed.aifiosProject).sort(), ["exportBackup", "importBackup"]);

  await exposed.aifiosCredentials.status();
  await exposed.aifiosCredentials.save("llm", "opaque-input");
  await exposed.aifiosCredentials.delete("llm");
  await exposed.aifiosProject.exportBackup();
  await exposed.aifiosProject.importBackup();

  assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
    ["aifios:credentials:status"],
    ["aifios:credentials:save", { id: "llm", value: "opaque-input" }],
    ["aifios:credentials:delete", "llm"],
    ["aifios:project:export-backup"],
    ["aifios:project:import-backup"],
  ]);
  assert.equal("read" in exposed.aifiosCredentials, false);
  assert.equal("get" in exposed.aifiosCredentials, false);
});

test("publication preload sends only authoritative queue selectors to the main process", async () => {
  const { exposed, invocations } = loadPreload();
  await exposed.aifiosPublication.fillDraft({
    queuePath: "materials/publication/drafts/demo/draft-queue.json",
    runId: "run-demo",
    jobId: "draft_0123456789abcdef0123",
    expectedPayloadHash: "a".repeat(64),
    job: { payload: { title: "forged renderer body" } },
    appSecret: "must-not-cross-ipc",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [[
    "aifios:publication:fill",
    {
      queuePath: "materials/publication/drafts/demo/draft-queue.json",
      runId: "run-demo",
      jobId: "draft_0123456789abcdef0123",
      expectedPayloadHash: "a".repeat(64),
    },
  ]]);
});

test("preload restores the safe desktop error code and debug id", async () => {
  const payload = {
    error: "无法导出备份，请换个位置后重试。",
    code: "backup_export_failed",
    debugId: "err_0123456789abcdef",
    action: { label: "重新选择位置" },
  };
  const transportError = new Error(
    `Error invoking remote method: Error: AIFIOS_USER_ERROR:${JSON.stringify(payload)}`,
  );
  const { exposed } = loadPreload(async () => { throw transportError; });

  await assert.rejects(exposed.aifiosProject.exportBackup(), (error) => {
    assert.equal(error.name, "UserFacingError");
    assert.equal(error.message, payload.error);
    assert.equal(error.code, payload.code);
    assert.equal(error.debugId, payload.debugId);
    assert.deepEqual(JSON.parse(JSON.stringify(error.action)), payload.action);
    assert.doesNotMatch(error.message, /AIFIOS_USER_ERROR|remote method|JSON/i);
    return true;
  });
});

test("preload hides unstructured Electron failures", async () => {
  const { exposed } = loadPreload(async () => {
    throw new Error("failed at /Users/alice/private.json token=private-token");
  });

  await assert.rejects(exposed.aifiosCredentials.status(), (error) => {
    assert.equal(error.message, "操作失败，请重试。");
    assert.equal(error.code, "desktop_operation_failed");
    assert.equal(error.debugId, undefined);
    assert.doesNotMatch(error.message, /alice|private-token|json|token/i);
    return true;
  });
});
