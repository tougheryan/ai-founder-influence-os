const assert = require("node:assert/strict");
const test = require("node:test");
const { desktopStartupRoute } = require("./startup-route.cjs");

function configuredModel() {
  return { config: { hasSavedKey: true, hasEnvKey: false } };
}

function configuredTikOmni() {
  return { setup: { status: "ready_to_test" } };
}

function configuredHostedModel() {
  return { config: { connectionMode: "hosted", gatewayConnected: true } };
}

test("configured desktop users enter the desktop home page", () => {
  assert.deepEqual(
    desktopStartupRoute(configuredModel(), configuredTikOmni()),
    { path: "/", blockers: [] },
  );
});

test("missing model credentials keep the home entry while reporting the blocker", () => {
  const target = desktopStartupRoute({ config: { hasSavedKey: false, hasEnvKey: false } }, configuredTikOmni());

  assert.equal(target.path, "/");
  assert.deepEqual(target.blockers, ["model_configuration_required"]);
});

test("TikOmni Token or GHID setup remains visible from the home entry", () => {
  const target = desktopStartupRoute(configuredModel(), {
    setup: { status: "blocked", blockers: ["未检测到 TikOmni Token"] },
  });

  assert.equal(target.path, "/");
  assert.deepEqual(target.blockers, ["tikomni_configuration_required"]);
});

test("hosted invite users do not receive a local TikOmni credential blocker", () => {
  assert.deepEqual(
    desktopStartupRoute(configuredHostedModel(), { setup: { status: "blocked" } }, { connected: true }),
    { path: "/", blockers: [] },
  );
});

test("hosted builds force an unactivated device to the license screen", () => {
  assert.deepEqual(
    desktopStartupRoute(
      { config: { licenseRequired: true, gatewayConnected: false } },
      { setup: { status: "blocked" } },
      { connected: false },
    ),
    { path: "/settings?firstRun=1", blockers: ["device_activation_required"] },
  );
});

test("hosted builds reject a forged local session until the gateway verifies it", () => {
  assert.deepEqual(
    desktopStartupRoute(
      { config: { licenseRequired: true, gatewayConnected: true } },
      { setup: { status: "blocked" } },
      { connected: false, message: "invalid session" },
    ),
    { path: "/settings?firstRun=1", blockers: ["device_activation_required"] },
  );
});

test("hosted builds fail closed when gateway verification is unavailable", () => {
  assert.deepEqual(
    desktopStartupRoute(
      { config: { licenseRequired: true, gatewayConnected: true } },
      { setup: { status: "blocked" } },
      null,
    ),
    { path: "/settings?firstRun=1", blockers: ["device_activation_required"] },
  );
});

test("legacy product-password flags do not gate the local desktop entry", () => {
  assert.deepEqual(
    desktopStartupRoute(
      { config: { demoUnlockRequired: true, demoUnlocked: false } },
      { setup: { status: "blocked" } },
      { connected: false },
    ),
    { path: "/", blockers: ["model_configuration_required", "tikomni_configuration_required"] },
  );
});

test("demo builds let an unlocked device through to the home entry", () => {
  assert.deepEqual(
    desktopStartupRoute(
      { config: { demoUnlockRequired: true, demoUnlocked: true, hasSavedKey: true } },
      { setup: { status: "ready_to_test" } },
      { connected: false },
    ),
    { path: "/", blockers: [] },
  );
});

test("publication bridge configuration is not a first-run blocker", () => {
  const target = desktopStartupRoute(configuredModel(), configuredTikOmni());

  assert.equal(target.path, "/");
});

test("unreadable setup status stays visible on the home entry", () => {
  const target = desktopStartupRoute(null, null);

  assert.equal(target.path, "/");
  assert.deepEqual(target.blockers, ["model_configuration_required", "tikomni_configuration_required"]);
});
