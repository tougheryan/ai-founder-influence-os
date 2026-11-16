const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pythonProcessEnvironment } = require("./python-process-environment.cjs");

test("Python child environments disable bytecode writes, user site packages, and injected paths", () => {
  const source = {
    PATH: "/usr/bin",
    PYTHONDONTWRITEBYTECODE: "0",
    PYTHONNOUSERSITE: "0",
    PYTHONHOME: "/tmp/poisoned-home",
    PYTHONPATH: "/tmp/poisoned-path",
    PYTHONSTARTUP: "/tmp/poisoned-startup.py",
    PYTHONUSERBASE: "/tmp/poisoned-user-base",
    PYTHONINSPECT: "1",
  };

  const environment = pythonProcessEnvironment(source);

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  });
  assert.equal(source.PYTHONDONTWRITEBYTECODE, "0");
  assert.equal(source.PYTHONNOUSERSITE, "0");
  assert.equal(source.PYTHONPATH, "/tmp/poisoned-path");
});

test("desktop Python availability probes use the immutable Python environment", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const validationStart = mainSource.indexOf("function validatePythonCandidate(");
  const validationEnd = mainSource.indexOf("function resolvePythonRuntime()", validationStart);
  const validationSource = mainSource.slice(validationStart, validationEnd);

  assert.notEqual(validationStart, -1);
  assert.match(
    validationSource,
    /validateCommandCandidate\(candidate, \["--version"\], pythonProcessEnvironment\(process\.env\)\)/,
  );
  assert.match(mainSource, /pythonProcessEnvironment\(ensureCredentialVault\(\)\.serviceEnvironment\(process\.env\)\)/);
});
