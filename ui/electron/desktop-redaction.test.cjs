const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDesktopUserFacingFailure,
  decodeDesktopUserFacingError,
  encodeDesktopUserFacingError,
  redactDesktopText,
} = require("./desktop-redaction.cjs");

test("desktop diagnostics redact credentials and user-specific paths", () => {
  const projectPath = "/Users/alice/Documents/Echo Founder/private-project";
  const output = redactDesktopText(
    `failed at ${projectPath}/config/llm-config.json apiKey=sk-live-secret-value token=tikomni-secret cookie=session-secret C:\\Users\\alice\\Echo\\project.json`,
    { markers: [projectPath] },
  );

  assert.doesNotMatch(output, /alice|private-project|sk-live|tikomni-secret|session-secret/i);
  assert.match(output, /\[local path\]/);
  assert.match(output, /apiKey=\[secret redacted\]/);
  assert.match(output, /token=\[secret redacted\]/);
  assert.match(output, /cookie=\[secret redacted\]/);
});

test("desktop diagnostics redact Bearer and Basic authorization headers", () => {
  const output = redactDesktopText([
    "Authorization: Bearer bearer-token-value",
    "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "Authorization=Bearer equality-token-value",
    "request failed with Bearer inline-token-value",
  ].join("\n"));

  assert.doesNotMatch(output, /bearer-token-value|dXNlcjpwYXNzd29yZA|equality-token-value|inline-token-value/);
  assert.equal((output.match(/\[secret redacted\]/g) || []).length, 4);
});

test("desktop diagnostics redact JSON secret fields and cookie headers", () => {
  const output = redactDesktopText([
    '{"apiKey":"json-api-secret","token":"json-token-secret","safe":"visible"}',
    "{'clientSecret':'json-client-secret'}",
    "Cookie: session=cookie-secret; theme=dark",
    "Set-Cookie: session=set-cookie-secret; HttpOnly; Path=/",
  ].join("\n"));

  assert.doesNotMatch(output, /json-api-secret|json-token-secret|json-client-secret|cookie-secret|set-cookie-secret/);
  assert.match(output, /"safe":"visible"/);
  assert.match(output, /Cookie: \[secret redacted\]/);
  assert.match(output, /Set-Cookie: \[secret redacted\]/);
});

test("desktop diagnostics redact deployment paths and standalone provider tokens", () => {
  const value = redactDesktopText(
    "failed at file:///workspace/private/config.json with ghp_abcdefghijklmnopqrstuvwxyz123456",
  );

  assert.equal(value.includes("workspace"), false);
  assert.equal(value.includes("config.json"), false);
  assert.equal(value.includes("ghp_"), false);
  assert.equal(value.includes("[local path]"), true);
  assert.equal(value.includes("[secret redacted]"), true);
});

test("desktop diagnostics redact content digests", () => {
  const digest = "a".repeat(64);
  const output = redactDesktopText(`content hash=${digest}`);
  assert.equal(output.includes(digest), false);
  assert.equal(output.includes("[digest redacted]"), true);
});

test("desktop diagnostics retain actionable non-sensitive context", () => {
  const output = redactDesktopText("Project restore failed: checksum mismatch for data/materials/note.md");
  assert.equal(output, "Project restore failed: checksum mismatch for data/materials/note.md");
});

test("desktop error transport exposes only stable copy, code, and diagnostic id", () => {
  const failure = createDesktopUserFacingFailure(
    new Error('failed at /Users/alice/private/project.json token=private-token {"password":"open"}'),
    { operation: "Project backup export", markers: ["/Users/alice/private"] },
  );
  const encoded = encodeDesktopUserFacingError(failure.payload);
  const decoded = decodeDesktopUserFacingError(`Error invoking remote method: Error: ${encoded}`);

  assert.deepEqual(decoded, failure.payload);
  assert.match(decoded.debugId, /^err_[a-z0-9]+$/i);
  assert.equal(decoded.code, "backup_export_failed");
  assert.doesNotMatch(JSON.stringify(decoded), /alice|private-token|project\.json|password/i);
  assert.match(failure.logDetail, /\[local path\]|\[secret redacted\]/);
  assert.doesNotMatch(failure.logDetail, /alice|private-token|"open"/i);
});

test("desktop error transport maps known bridge and backup failures", () => {
  const browser = Object.assign(new Error("editor session missing"), { code: "browser_session_required" });
  const browserFailure = createDesktopUserFacingFailure(browser, { operation: "Publication draft fill" });
  assert.equal(browserFailure.payload.code, "browser_session_required");
  assert.match(browserFailure.payload.error, /尚未登录/);

  const backupFailure = createDesktopUserFacingFailure(
    new Error("manifest checksum mismatch for /Users/alice/backup/file.json"),
    { operation: "Project backup restore" },
  );
  assert.equal(backupFailure.payload.code, "backup_integrity_failed");
  assert.doesNotMatch(JSON.stringify(backupFailure.payload), /manifest|checksum|alice|file\.json/i);

  const runtimeFailure = createDesktopUserFacingFailure(
    new Error("Python runtime unavailable at /Users/alice/.local/bin/python3"),
    { operation: "Desktop startup" },
  );
  assert.equal(runtimeFailure.payload.code, "runtime_component_missing");
  assert.equal(runtimeFailure.payload.error, "缺少必要的运行组件，请重新安装完整应用。");
  assert.doesNotMatch(JSON.stringify(runtimeFailure.payload), /Python|alice|\.local/i);
});

test("malformed desktop transport messages are not decoded", () => {
  assert.equal(decodeDesktopUserFacingError("raw /Users/alice/secret.json"), null);
  assert.equal(decodeDesktopUserFacingError("AIFIOS_USER_ERROR:{not-json}"), null);
});
