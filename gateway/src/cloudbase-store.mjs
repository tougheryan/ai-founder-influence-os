import { GatewayStore, STORE_SCHEMA } from './store.mjs';

const DEFAULT_COLLECTION = 'aifios_gateway_ledger';
const DEFAULT_DOCUMENT_ID = 'main';

function plainText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function emptyLedger() {
  return {
    schema: STORE_SCHEMA,
    invites: [],
    sessions: [],
    usage: [],
    nonces: [],
  };
}

function stripCloudBaseMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...value };
  // CloudBase adds these fields to documents. They are not part of the
  // gateway ledger and must not be sent back in a replacement write.
  delete copy._id;
  delete copy._openid;
  delete copy._createTime;
  delete copy._updateTime;
  return copy;
}

function parseLedger(value) {
  const payload = stripCloudBaseMetadata(value?.data || value);
  if (!payload) return emptyLedger();
  if (payload.schema !== STORE_SCHEMA || !Array.isArray(payload.invites)
    || !Array.isArray(payload.sessions) || !Array.isArray(payload.usage)
    || !Array.isArray(payload.nonces)) {
    throw new Error('CloudBase gateway ledger has an unsupported schema.');
  }
  return payload;
}

/**
 * CloudBase-backed ledger for stateless Tencent Cloud Functions.
 *
 * The existing JSON GatewayStore remains the default single-host beta store.
 * This adapter replaces each ledger mutation with a CloudBase transaction so
 * two warm function instances cannot both consume the same nonce or quota.
 */
export class CloudBaseGatewayStore extends GatewayStore {
  constructor({ db, pepper, collection = DEFAULT_COLLECTION, documentId = DEFAULT_DOCUMENT_ID, now } = {}) {
    if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
      throw new Error('A CloudBase database client with transaction support is required.');
    }
    super({ dataDir: '/tmp/aifios-cloudbase-ledger', pepper, now });
    this.db = db;
    this.collectionName = plainText(collection) || DEFAULT_COLLECTION;
    this.documentId = plainText(documentId) || DEFAULT_DOCUMENT_ID;
  }

  document(collection = this.db.collection(this.collectionName)) {
    return collection.doc(this.documentId);
  }

  async init() {
    const result = await this.document().get();
    if (!result?.data) {
      this.ledger = emptyLedger();
      await this.document().set(this.ledger);
      return;
    }
    this.ledger = parseLedger(result);
  }

  async reload() {
    this.ledger = parseLedger(await this.document().get());
    return this.ledger;
  }

  async authenticate(token) {
    await this.writeQueue;
    await this.reload();
    return this.authenticateToken(token);
  }

  async listInvites() {
    await this.writeQueue;
    await this.reload();
    return this.ledger.invites.map((invite) => this.publicInvite(invite));
  }

  // The parent class persists atomically to a local file. CloudBase writes
  // are handled by mutate()'s transaction and never use the local filesystem.
  async persist() {}

  async mutate(action) {
    const next = this.writeQueue.then(() => this.db.runTransaction(async (transaction) => {
      const document = this.document(transaction.collection(this.collectionName));
      const current = await document.get();
      this.ledger = parseLedger(current);
      const before = structuredClone(this.ledger);
      try {
        const result = await action();
        await document.set(stripCloudBaseMetadata(this.ledger));
        return result;
      } catch (error) {
        this.ledger = before;
        throw error;
      }
    }, 5));
    this.writeQueue = next.catch(() => {});
    return next;
  }
}

export const CLOUD_BASE_LEDGER_DEFAULTS = Object.freeze({
  collection: DEFAULT_COLLECTION,
  documentId: DEFAULT_DOCUMENT_ID,
});
