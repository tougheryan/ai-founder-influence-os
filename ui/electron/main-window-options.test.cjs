const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

test('an external build-directory override applies only to source launches', () => {
  const expression = mainSource.match(/AIFIOS_NEXT_DIST_DIR:\s*([^\n]+),/)?.[1];
  assert.ok(expression, 'the child service must receive an explicit build directory');
  const select = (isPackaged, requested) => vm.runInNewContext(`(${expression})`, {
    app: { isPackaged }, process: { env: { AIFIOS_NEXT_DIST_DIR: requested } },
  });
  assert.equal(select(true, '.next-untrusted-external'), '.next-desktop');
  assert.equal(select(false, '  .next-source-verification  '), '.next-source-verification');
  assert.equal(select(false, ''), '.next-desktop');
  assert.equal(select(false, '   '), '.next-desktop');
});

test('inactive macOS windows forward the activating click to web contents', () => {
  const start = mainSource.indexOf('function createWindow()');
  const end = mainSource.indexOf('function focusMainWindow()', start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(mainSource.slice(start, end), /acceptFirstMouse:\s*true/);
});

test('development launches use the Echo Founder app name and Dock icon', () => {
  assert.match(mainSource, /app\.setName\(PRODUCT_NAME\)/);
  assert.match(mainSource, /DEVELOPMENT_DOCK_ICON_PATH\s*=\s*path\.join\(__dirname,\s*["']EchoFounder\.png["']\)/);
  assert.match(mainSource, /app\.dock\.setIcon\(dockIcon\)/);
});

test('startup screen uses the Echo Founder mark and respects reduced motion', () => {
  const start = mainSource.indexOf('function loadingHtml(');
  const end = mainSource.indexOf('function loadInternalHtml(', start);
  const loadingScreen = mainSource.slice(start, end);

  assert.match(loadingScreen, /class="mark"/);
  assert.match(loadingScreen, />ECHO FOUNDER</);
  assert.match(loadingScreen, /role="progressbar"/);
  assert.match(loadingScreen, /prefers-reduced-motion:\s*reduce/);
});

test('new desktop projects use the Echo Founder directory without breaking saved, env, or legacy selections', () => {
  const defaultStart = mainSource.indexOf('function defaultProjectDir()');
  const resolverStart = mainSource.indexOf('function resolveInitialProjectDir()');
  const resolverEnd = mainSource.indexOf('function saveProjectDirSelection(', resolverStart);

  assert.notEqual(defaultStart, -1);
  assert.match(mainSource.slice(defaultStart, resolverStart), /path\.join\(os\.homedir\(\), "Echo Founder"\)/);
  assert.match(mainSource.slice(defaultStart, resolverStart), /path\.join\(os\.homedir\(\), "ai-content-system"\)/);

  const resolver = mainSource.slice(resolverStart, resolverEnd);
  assert.match(resolver, /if \(savedProject\)[\s\S]*return savedProject/);
  assert.match(resolver, /if \(envProject\)[\s\S]*return envProject/);
  assert.match(resolver, /fs\.existsSync\(legacyProject\)[\s\S]*return legacyProject/);
  assert.match(resolver, /return defaultProject/);
});

test('publication browser snapshots use a private userData root and are purged before the app window starts', () => {
  const bridgeStart = mainSource.indexOf('function ensurePublicationBridge()');
  const bridgeEnd = mainSource.indexOf('function signedPublicationReceipt(', bridgeStart);
  const startupStart = mainSource.indexOf('app.whenReady().then(async () => {');
  const windowStart = mainSource.indexOf('  createWindow();', startupStart);
  const purgeStart = mainSource.indexOf('await purgeStalePublicationAssetSnapshots({', startupStart);

  assert.notEqual(bridgeStart, -1);
  assert.match(mainSource.slice(bridgeStart, bridgeEnd), /publicationAssetSnapshotOptions:[\s\S]*tempRoot:\s*publicationAssetSnapshotRoot\(\)/);
  assert.match(mainSource, /app\.getPath\("userData"\),\s*"publication-asset-snapshots"/);
  assert.notEqual(purgeStart, -1);
  assert.ok(purgeStart < windowStart, 'stale private assets must be sanitized before creating the renderer window');
});
