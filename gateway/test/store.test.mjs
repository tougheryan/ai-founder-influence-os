import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayStore } from '../src/store.mjs';
import { newDevice } from './device-client.mjs';

function proof(device, nonce, now) {
  return {
    keyId: device.device.keyId,
    nonce,
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
  };
}

test('an expired session can only be renewed with the original code and key', async (t) => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'aifios-gateway-store-'));
  const store = new GatewayStore({ dataDir, pepper: 'test-pepper', now: () => now });
  await store.init();
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const created = await store.createInvite({ label: 'paid user', quotaLimit: 10, defaultQuota: 10 });
  const boundDevice = newDevice();
  const otherDevice = newDevice();
  const first = await store.activate(created.code, 1, boundDevice.device, proof(
    boundDevice,
    'renewal-activation-nonce-000001',
    now,
  ));

  now = new Date('2026-01-03T00:00:00.000Z');
  await assert.rejects(
    store.authenticate(first.token),
    (error) => error?.code === 'invalid_session',
  );
  await assert.rejects(
    store.activate(created.code, 1, otherDevice.device, proof(otherDevice, 'renewal-other-device-nonce-01', now)),
    (error) => error?.code === 'invite_already_activated',
  );

  const renewed = await store.activate(
    created.code,
    1,
    boundDevice.device,
    proof(boundDevice, 'renewal-same-device-nonce-0001', now),
  );
  const authenticated = await store.authenticate(renewed.token);
  assert.equal(authenticated.invite.id, created.invite.id);
  assert.equal(authenticated.session.deviceKeyId, boundDevice.device.keyId);
});

test('nonce admission is linearizable and survives a store restart', async (t) => {
  const now = new Date('2026-02-02T02:02:02.000Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'aifios-gateway-store-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const device = newDevice();
  const firstStore = new GatewayStore({ dataDir, pepper: 'test-pepper', now: () => now });
  await firstStore.init();
  const created = await firstStore.createInvite({ label: 'nonce user', quotaLimit: 10, defaultQuota: 10 });
  const activated = await firstStore.activate(
    created.code,
    30,
    device.device,
    proof(device, 'nonce-activation-persist-00001', now),
  );
  const reusedProof = proof(device, 'nonce-concurrent-and-restart-01', now);

  const concurrent = await Promise.allSettled([
    firstStore.consumeAuthenticatedDeviceNonce(
      activated.token,
      reusedProof.keyId,
      reusedProof.nonce,
      reusedProof.expiresAt,
    ),
    firstStore.consumeAuthenticatedDeviceNonce(
      activated.token,
      reusedProof.keyId,
      reusedProof.nonce,
      reusedProof.expiresAt,
    ),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(concurrent.find((result) => result.status === 'rejected').reason.code, 'replayed_device_proof');

  const restarted = new GatewayStore({ dataDir, pepper: 'test-pepper', now: () => now });
  await restarted.init();
  await assert.rejects(
    restarted.consumeAuthenticatedDeviceNonce(
      activated.token,
      reusedProof.keyId,
      reusedProof.nonce,
      reusedProof.expiresAt,
    ),
    (error) => error?.code === 'replayed_device_proof',
  );
  const persisted = await readFile(join(dataDir, 'ledger.json'), 'utf8');
  assert.equal(persisted.includes(reusedProof.nonce), false);
});

test('v1 migration fails closed for activated licenses and allows reissue', async (t) => {
  const now = new Date('2026-03-03T03:03:03.000Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'aifios-gateway-store-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new GatewayStore({ dataDir, pepper: 'test-pepper', now: () => now });
  const activatedCode = 'AIF-LEGACY-ACTIVATED-CODE';
  const unboundCode = 'AIF-LEGACY-UNBOUND-CODE';
  const legacyToken = 'legacy-session-token';
  const activatedId = '11111111-1111-4111-8111-111111111111';
  await writeFile(join(dataDir, 'ledger.json'), `${JSON.stringify({
    schema: 'aifios.gateway-ledger.v1',
    invites: [
      {
        id: activatedId,
        codeHash: store.hash(activatedCode),
        label: 'legacy activated',
        status: 'active',
        quotaLimit: 8,
        expiresAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        activatedAt: '2025-01-02T00:00:00.000Z',
        deviceHash: 'legacy-device-hash-must-disappear',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        codeHash: store.hash(unboundCode),
        label: 'legacy never activated',
        status: 'active',
        quotaLimit: 4,
        expiresAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        activatedAt: null,
      },
    ],
    sessions: [{
      id: '33333333-3333-4333-8333-333333333333',
      tokenHash: store.hash(legacyToken),
      inviteId: activatedId,
      deviceHash: 'legacy-session-device-hash',
      createdAt: '2025-01-02T00:00:00.000Z',
      expiresAt: '2027-01-02T00:00:00.000Z',
      revokedAt: null,
    }],
    usage: [],
  }, null, 2)}\n`, { mode: 0o600 });

  await store.init();
  const listed = await store.listInvites();
  assert.equal(listed.find((invite) => invite.id === activatedId).deviceProofStatus, 'legacy_reissue_required');
  assert.equal(listed.find((invite) => invite.label === 'legacy never activated').deviceProofStatus, 'unbound');
  await assert.rejects(store.authenticate(legacyToken), (error) => error?.code === 'license_reissue_required');

  const legacyDevice = newDevice();
  await assert.rejects(
    store.activate(
      activatedCode,
      30,
      legacyDevice.device,
      proof(legacyDevice, 'legacy-activated-refused-0001', now),
    ),
    (error) => error?.code === 'license_reissue_required',
  );

  const reissued = await store.reissueInvite(activatedId);
  const replacementDevice = newDevice();
  const replacementSession = await store.activate(
    reissued.code,
    30,
    replacementDevice.device,
    proof(replacementDevice, 'legacy-reissued-activation-001', now),
  );
  assert.equal((await store.authenticate(replacementSession.token)).invite.reissuedFrom, activatedId);

  const unboundDevice = newDevice();
  const unboundSession = await store.activate(
    unboundCode,
    30,
    unboundDevice.device,
    proof(unboundDevice, 'legacy-unbound-activation-0001', now),
  );
  assert.equal((await store.authenticate(unboundSession.token)).invite.label, 'legacy never activated');

  const migrated = await readFile(join(dataDir, 'ledger.json'), 'utf8');
  assert.match(migrated, /"schema": "aifios.gateway-ledger.v2"/);
  assert.match(migrated, /"migratedFrom": "aifios.gateway-ledger.v1"/);
  assert.equal(migrated.includes('legacy-device-hash-must-disappear'), false);
  assert.equal(migrated.includes('legacy-session-device-hash'), false);
});

