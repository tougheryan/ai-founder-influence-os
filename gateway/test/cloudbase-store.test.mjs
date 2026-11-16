import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudBaseGatewayStore } from '../src/cloudbase-store.mjs';
import { generateDeviceKeyPair } from '../src/device-proof.mjs';

class FakeDocument {
  constructor(owner, transaction = null) {
    this.owner = owner;
    this.transaction = transaction;
  }

  get state() {
    return this.transaction ? this.transaction.state : this.owner.state;
  }

  set state(value) {
    if (this.transaction) this.transaction.state = value;
    else this.owner.state = value;
  }

  async get() {
    return this.state ? { data: structuredClone(this.state) } : { data: undefined };
  }

  async set(value) {
    this.state = structuredClone(value);
    return { updated: 1 };
  }
}

class FakeCollection {
  constructor(owner, transaction = null) {
    this.owner = owner;
    this.transaction = transaction;
  }

  doc() {
    return new FakeDocument(this.owner, this.transaction);
  }
}

class FakeCloudBaseDb {
  state = null;

  collection() {
    return new FakeCollection(this);
  }

  async runTransaction(callback) {
    const transaction = { state: this.state ? structuredClone(this.state) : null };
    const result = await callback({ collection: () => new FakeCollection(this, transaction) });
    this.state = transaction.state;
    return result;
  }
}

function proofFor(device) {
  return {
    keyId: device.keyId,
    nonce: 'cloudbase-store-test-nonce-000001',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test('CloudBase ledger persists activation binding across fresh store instances', async () => {
  const db = new FakeCloudBaseDb();
  const first = new CloudBaseGatewayStore({ db, pepper: 'test-pepper' });
  await first.init();
  const created = await first.createInvite({ label: 'cloudbase', quotaLimit: 2, defaultQuota: 2 });
  const device = generateDeviceKeyPair();
  await first.activate(created.code, 30, device.device, proofFor(device.device));

  const second = new CloudBaseGatewayStore({ db, pepper: 'test-pepper' });
  await second.init();
  const invites = await second.listInvites();
  assert.equal(invites[0].deviceProofStatus, 'bound');
  assert.equal(invites[0].deviceKeyId, device.device.keyId);
});

test('CloudBase ledger rejects an unsupported legacy document instead of silently losing licenses', async () => {
  const db = new FakeCloudBaseDb();
  db.state = { schema: 'aifios.gateway-ledger.v1', invites: [], sessions: [], usage: [] };
  const store = new CloudBaseGatewayStore({ db, pepper: 'test-pepper' });
  await assert.rejects(() => store.init(), /unsupported schema/);
});

