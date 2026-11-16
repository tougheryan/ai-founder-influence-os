const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verify } = require('node:crypto');
const {
  DEVICE_KEY_SCHEMA,
  loadOrCreateDeviceKey,
  signCanonical,
} = require('./device-key.cjs');

function testStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').slice('protected:'.length),
    getSelectedStorageBackend: () => 'keychain',
  };
}

function withTempIdentity(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifios-device-key-'));
  try {
    return run(path.join(root, 'device-id.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('creates and reloads one encrypted Ed25519 installation identity', () => withTempIdentity((filePath) => {
  const first = loadOrCreateDeviceKey({ filePath, safeStorage: testStorage(), platform: 'darwin' });
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const second = loadOrCreateDeviceKey({ filePath, safeStorage: testStorage(), platform: 'darwin' });

  assert.equal(record.schema, DEVICE_KEY_SCHEMA);
  assert.equal(record.storage, 'os-keychain');
  assert.equal(record.algorithm, 'Ed25519');
  assert.equal(record.keyId, first.keyId);
  assert.equal(record.publicKeySpki, first.publicKeySpki);
  assert.ok(record.privateKeyCiphertext.length > 24);
  assert.equal('privateKey' in record, false);
  assert.equal('deviceId' in record, false);
  assert.equal(second.keyId, first.keyId);
}));

test('signatures prove possession of the encrypted installation private key', () => withTempIdentity((filePath) => {
  const identity = loadOrCreateDeviceKey({ filePath, safeStorage: testStorage(), platform: 'win32' });
  const canonical = 'AIFIOS-DEVICE-PROOF-V1\nfixed-vector';
  const signature = signCanonical(identity, canonical);

  assert.equal(verify(null, Buffer.from(canonical), identity.publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(verify(null, Buffer.from(`${canonical}-tampered`), identity.publicKey, Buffer.from(signature, 'base64url')), false);
}));

test('fails closed when secure keychain encryption is unavailable', () => withTempIdentity((filePath) => {
  assert.throws(
    () => loadOrCreateDeviceKey({
      filePath,
      safeStorage: { isEncryptionAvailable: () => false },
      platform: 'darwin',
    }),
    /OS keychain encryption is required/,
  );
}));

test('fails closed when an encrypted identity record is tampered', () => withTempIdentity((filePath) => {
  loadOrCreateDeviceKey({ filePath, safeStorage: testStorage(), platform: 'darwin' });
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  record.keyId = 'tampered-key-id';
  fs.writeFileSync(filePath, JSON.stringify(record));

  assert.throws(
    () => loadOrCreateDeviceKey({ filePath, safeStorage: testStorage(), platform: 'darwin' }),
    /integrity check/,
  );
}));

test('rejects Electron basic_text storage on Linux', () => withTempIdentity((filePath) => {
  const storage = testStorage();
  storage.getSelectedStorageBackend = () => 'basic_text';
  assert.throws(
    () => loadOrCreateDeviceKey({ filePath, safeStorage: storage, platform: 'linux' }),
    /basic_text/,
  );
}));
