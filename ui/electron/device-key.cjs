const {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} = require('crypto');
const fs = require('fs');
const path = require('path');

const DEVICE_KEY_SCHEMA = 'aifios.desktop-device.v3';
const DEVICE_PROOF_VERSION = '1';

function derivePublicIdentity(privateKey) {
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The stored device key is not an Ed25519 key.');
  }
  const publicKeySpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const keyId = `ed25519:${createHash('sha256').update(Buffer.from(publicKeySpki, 'base64url')).digest('base64url')}`;
  return { publicKey, publicKeySpki, keyId };
}

function assertProtectedStorage(safeStorage, platform = process.platform) {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error('OS keychain encryption is required for this device-bound license.');
  }
  if (platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('A protected OS keychain is required; Electron basic_text storage is not accepted.');
  }
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch { /* Windows has no POSIX file mode. */ }
}

function createDeviceKey(target, safeStorage) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const { publicKey, publicKeySpki, keyId } = derivePublicIdentity(privateKey);
  const privateKeyPkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
  const privateKeyCiphertext = safeStorage.encryptString(privateKeyPkcs8).toString('base64');
  atomicWriteJson(target, {
    schema: DEVICE_KEY_SCHEMA,
    algorithm: 'Ed25519',
    keyId,
    publicKeySpki,
    storage: 'os-keychain',
    privateKeyCiphertext,
    createdAt: new Date().toISOString(),
  });
  return { algorithm: 'Ed25519', keyId, publicKeySpki, privateKey, publicKey };
}

function readDeviceKey(target, safeStorage) {
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (parsed?.schema === 'aifios.desktop-device.v1' || parsed?.schema === 'aifios.desktop-device.v2') return null;
  if (parsed?.schema !== DEVICE_KEY_SCHEMA) {
    throw new Error('The device authorization key record has an unsupported schema.');
  }
  if (parsed.algorithm !== 'Ed25519' || parsed.storage !== 'os-keychain') {
    throw new Error('The device authorization key record is not protected correctly.');
  }
  if (typeof parsed.privateKeyCiphertext !== 'string' || parsed.privateKeyCiphertext.length < 24) {
    throw new Error('The encrypted device authorization key is missing.');
  }
  let privateKey;
  try {
    const encoded = safeStorage.decryptString(Buffer.from(parsed.privateKeyCiphertext, 'base64'));
    privateKey = createPrivateKey({ key: Buffer.from(encoded, 'base64url'), type: 'pkcs8', format: 'der' });
  } catch {
    throw new Error('The OS keychain could not decrypt the device authorization key.');
  }
  const derived = derivePublicIdentity(privateKey);
  if (parsed.keyId !== derived.keyId || parsed.publicKeySpki !== derived.publicKeySpki) {
    throw new Error('The device authorization key record failed its integrity check.');
  }
  return {
    algorithm: 'Ed25519',
    keyId: derived.keyId,
    publicKeySpki: derived.publicKeySpki,
    privateKey,
    publicKey: derived.publicKey,
  };
}

function loadOrCreateDeviceKey({ filePath, safeStorage, platform = process.platform }) {
  assertProtectedStorage(safeStorage, platform);
  if (fs.existsSync(filePath)) {
    const loaded = readDeviceKey(filePath, safeStorage);
    if (loaded) return loaded;
    // UUID-based v1/v2 records are intentionally not migrated. A new key is
    // required so an old caller-controlled identifier can never remain a
    // valid paid-device credential.
  }
  return createDeviceKey(filePath, safeStorage);
}

function signCanonical(identity, canonical) {
  return sign(null, Buffer.from(canonical, 'utf8'), identity.privateKey).toString('base64url');
}

module.exports = {
  DEVICE_KEY_SCHEMA,
  DEVICE_PROOF_VERSION,
  derivePublicIdentity,
  loadOrCreateDeviceKey,
  signCanonical,
};
