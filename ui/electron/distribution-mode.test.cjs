const assert = require("node:assert/strict");
const test = require("node:test");
const { parseDistributionMode } = require("./distribution-mode.cjs");

const hostedMarker = {
  schema: "aifios.desktop-distribution.v1",
  mode: "hosted-license",
  deviceBinding: true,
};

test("recognizes a valid hosted distribution marker", () => {
  assert.equal(parseDistributionMode(hostedMarker, { packaged: true }), "device-bound");
});

test("recognizes a valid local self-config distribution marker", () => {
  assert.equal(parseDistributionMode({
    schema: "aifios.desktop-distribution.v1",
    mode: "local-self-config",
  }, { packaged: true }), "local-self-config");
});

test("packaged builds reject a local marker when hosted bootstrap metadata is present", () => {
  assert.throws(
    () => parseDistributionMode({
      schema: "aifios.desktop-distribution.v1",
      mode: "local-self-config",
    }, { packaged: true, hostedBootstrapPresent: true }),
    /托管授权配置与本地分发标记冲突/,
  );
});

test("packaged builds fail closed when the marker is missing", () => {
  assert.throws(
    () => parseDistributionMode(null, { packaged: true }),
    /缺少有效的分发标记/,
  );
});

test("packaged hosted builds fail closed when device binding is removed", () => {
  assert.throws(
    () => parseDistributionMode({ ...hostedMarker, deviceBinding: false }, { packaged: true }),
    /缺少设备绑定标记/,
  );
});

test("developer mode preserves the legacy no-marker fallback", () => {
  assert.equal(parseDistributionMode(null, { packaged: false }), null);
});
