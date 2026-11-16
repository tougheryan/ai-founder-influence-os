import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STORE_SCHEMA = 'aifios.gateway-ledger.v2';
export const LEGACY_STORE_SCHEMA = 'aifios.gateway-ledger.v1';
const MAX_ACTIVE_NONCES_PER_KEY = 2048;

export class GatewayStoreError extends Error {
  constructor(message, status = 400, code = 'gateway_error') {
    super(message);
    this.name = 'GatewayStoreError';
    this.status = status;
    this.code = code;
  }
}

function plainText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalIsoDate(value) {
  const raw = plainText(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new GatewayStoreError('授权码有效期格式不正确。', 400, 'invalid_expiry');
  }
  return date.toISOString();
}

function defaultLedger() {
  return {
    schema: STORE_SCHEMA,
    invites: [],
    sessions: [],
    usage: [],
    nonces: [],
  };
}

function validLedgerShape(value, schema) {
  return Boolean(value) && value.schema === schema && Array.isArray(value.invites)
    && Array.isArray(value.sessions) && Array.isArray(value.usage);
}

function migrateLegacyLedger(legacy, migratedAt) {
  const invites = legacy.invites.map((source) => {
    const invite = { ...source };
    const wasActivated = Boolean(invite.activatedAt || invite.deviceHash);
    delete invite.deviceHash;
    delete invite.deviceBoundAt;
    invite.device = null;
    invite.deviceProofStatus = wasActivated ? 'legacy_reissue_required' : 'unbound';
    if (wasActivated) invite.deviceProofMigrationRequiredAt = migratedAt;
    return invite;
  });
  const sessions = legacy.sessions.map((source) => {
    const session = { ...source };
    delete session.deviceHash;
    session.deviceKeyId = null;
    session.revokedAt ||= migratedAt;
    session.revocationReason ||= 'device-proof-v1-migration';
    return session;
  });
  return {
    schema: STORE_SCHEMA,
    migratedFrom: LEGACY_STORE_SCHEMA,
    migratedAt,
    invites,
    sessions,
    usage: legacy.usage,
    nonces: [],
  };
}

export class GatewayStore {
  constructor({ dataDir, pepper, now = () => new Date() }) {
    if (!plainText(dataDir)) throw new Error('GATEWAY_DATA_DIR is required.');
    if (!plainText(pepper)) throw new Error('GATEWAY_TOKEN_PEPPER is required.');
    this.dataDir = dataDir;
    this.ledgerPath = join(dataDir, 'ledger.json');
    this.pepper = pepper;
    this.now = now;
    this.ledger = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath, 'utf8'));
      if (validLedgerShape(parsed, LEGACY_STORE_SCHEMA)) {
        this.ledger = migrateLegacyLedger(parsed, this.nowIso());
        await this.persist();
      } else if (validLedgerShape(parsed, STORE_SCHEMA) && Array.isArray(parsed.nonces)) {
        this.ledger = parsed;
      } else {
        throw new Error('invalid schema');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`Gateway ledger cannot be read safely: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.ledger = defaultLedger();
      await this.persist();
    }
    await chmod(this.dataDir, 0o700);
    await chmod(this.ledgerPath, 0o600);
  }

  hash(value) {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  async persist() {
    const temporary = `${this.ledgerPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(temporary, 0o600);
      const temporaryHandle = await open(temporary, 'r');
      try {
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      await rename(temporary, this.ledgerPath);
      await chmod(this.ledgerPath, 0o600);
      const directoryHandle = await open(this.dataDir, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async mutate(action) {
    const next = this.writeQueue.then(async () => {
      const before = structuredClone(this.ledger);
      try {
        const result = await action();
        await this.persist();
        return result;
      } catch (error) {
        this.ledger = before;
        throw error;
      }
    });
    this.writeQueue = next.catch(() => {});
    return next;
  }

  nowIso() {
    return this.now().toISOString();
  }

  isExpired(isoDate) {
    return Boolean(isoDate) && new Date(isoDate).getTime() <= this.now().getTime();
  }

  validateNonceInput(keyIdValue, nonceValue, expiresAtValue) {
    const keyId = plainText(keyIdValue);
    const nonce = plainText(nonceValue);
    const expiresAt = optionalIsoDate(expiresAtValue);
    if (!/^ed25519:[A-Za-z0-9_-]{43}$/.test(keyId) || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce) || !expiresAt) {
      throw new GatewayStoreError('设备签名随机数无效。', 401, 'invalid_device_proof');
    }
    return { keyId, nonce, expiresAt };
  }

  recordNonce({ keyId, nonce, expiresAt }) {
    const current = this.now().getTime();
    this.ledger.nonces = this.ledger.nonces.filter((entry) => new Date(entry.expiresAt).getTime() >= current);
    const nonceHash = this.hash(`${keyId}\0${nonce}`);
    if (this.ledger.nonces.some((entry) => safeEqual(entry.nonceHash, nonceHash))) {
      throw new GatewayStoreError('设备签名已被使用，请重试。', 409, 'replayed_device_proof');
    }
    if (this.ledger.nonces.filter((entry) => entry.keyId === keyId).length >= MAX_ACTIVE_NONCES_PER_KEY) {
      throw new GatewayStoreError('设备请求过于频繁，请稍后重试。', 429, 'device_proof_rate_limited');
    }
    this.ledger.nonces.push({
      nonceHash,
      keyId,
      seenAt: this.nowIso(),
      expiresAt,
    });
  }

  quotaForInvite(inviteId) {
    return this.ledger.usage.filter((entry) => entry.inviteId === inviteId && entry.status !== 'refunded').length;
  }

  publicInvite(invite) {
    const used = this.quotaForInvite(invite.id);
    return {
      id: invite.id,
      label: invite.label,
      status: invite.status,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      activatedAt: invite.activatedAt,
      quotaLimit: invite.quotaLimit,
      requestsUsed: used,
      requestsRemaining: Math.max(0, invite.quotaLimit - used),
      deviceBound: invite.deviceProofStatus === 'bound' && Boolean(invite.device?.keyId),
      deviceProofStatus: invite.deviceProofStatus || 'unbound',
      deviceKeyId: invite.device?.keyId || null,
      deviceProofMigrationRequiredAt: invite.deviceProofMigrationRequiredAt || null,
    };
  }

  async createInvite({ label, quotaLimit, expiresAt, defaultQuota }) {
    const cleanLabel = plainText(label).slice(0, 120) || 'beta friend';
    const quota = positiveInteger(quotaLimit, defaultQuota);
    if (quota > 100000) throw new GatewayStoreError('授权码额度不能超过 100000 次。', 400, 'invalid_quota');
    const expiry = optionalIsoDate(expiresAt);
    if (expiry && this.isExpired(expiry)) throw new GatewayStoreError('授权码有效期必须晚于当前时间。', 400, 'invalid_expiry');

    return this.mutate(async () => {
      const code = `AIF-${randomBytes(15).toString('base64url').toUpperCase()}`;
      const invite = {
        id: randomUUID(),
        codeHash: this.hash(code),
        label: cleanLabel,
        status: 'active',
        quotaLimit: quota,
        expiresAt: expiry,
        createdAt: this.nowIso(),
        activatedAt: null,
        device: null,
        deviceProofStatus: 'unbound',
      };
      this.ledger.invites.push(invite);
      return { code, invite: this.publicInvite(invite) };
    });
  }

  async listInvites() {
    await this.writeQueue;
    return this.ledger.invites.map((invite) => this.publicInvite(invite));
  }

  findInviteById(inviteId) {
    return this.ledger.invites.find((invite) => invite.id === inviteId) || null;
  }

  assertActiveInvite(invite) {
    if (!invite || invite.status !== 'active') {
      throw new GatewayStoreError('授权码无效或已被撤销。', 401, 'invalid_invite');
    }
    if (this.isExpired(invite.expiresAt)) {
      throw new GatewayStoreError('授权码已过期。', 401, 'expired_invite');
    }
  }

  async activate(codeValue, sessionTtlDays, device, proof) {
    const code = plainText(codeValue);
    if (!code || code.length > 256) throw new GatewayStoreError('授权码格式不正确。', 400, 'invalid_invite');
    if (!device || device.algorithm !== 'Ed25519' || !plainText(device.keyId) || !plainText(device.publicKeySpki)) {
      throw new GatewayStoreError('缺少有效设备公钥，请重新激活。', 400, 'invalid_device_key');
    }
    const nonceInput = this.validateNonceInput(proof?.keyId, proof?.nonce, proof?.expiresAt);
    if (!safeEqual(nonceInput.keyId, device.keyId)) {
      throw new GatewayStoreError('设备签名与激活公钥不匹配。', 401, 'device_key_mismatch');
    }
    const codeHash = this.hash(code);
    return this.mutate(async () => {
      const invite = this.ledger.invites.find((entry) => safeEqual(entry.codeHash, codeHash));
      this.assertActiveInvite(invite);
      if (invite.deviceProofStatus === 'legacy_reissue_required') {
        throw new GatewayStoreError('该授权需要管理员补发新授权码后才能继续使用。', 409, 'license_reissue_required');
      }
      this.recordNonce(nonceInput);
      const createdAt = this.now();
      const createdAtIso = createdAt.toISOString();
      if (invite.activatedAt && (!invite.device
        || !safeEqual(invite.device.keyId, device.keyId)
        || !safeEqual(invite.device.publicKeySpki, device.publicKeySpki))) {
        throw new GatewayStoreError('该授权码已绑定其他设备；请向管理员索取新的授权码。', 409, 'invite_already_activated');
      }
      if (invite.activatedAt) {
        // A valid paid user can recover from a lost local session or a normal
        // session expiry only from the already-bound device. Revoke any prior
        // bearer session before issuing the replacement.
        for (const session of this.ledger.sessions) {
          if (session.inviteId === invite.id && !session.revokedAt) session.revokedAt = createdAtIso;
        }
        invite.reactivatedAt = createdAtIso;
      }
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(createdAt.getTime() + sessionTtlDays * 24 * 60 * 60 * 1000).toISOString();
      const session = {
        id: randomUUID(),
        tokenHash: this.hash(token),
        inviteId: invite.id,
        deviceKeyId: device.keyId,
        createdAt: createdAt.toISOString(),
        expiresAt,
        revokedAt: null,
      };
      invite.device = {
        algorithm: 'Ed25519',
        keyId: device.keyId,
        publicKeySpki: device.publicKeySpki,
      };
      invite.deviceProofStatus = 'bound';
      invite.deviceBoundAt = session.createdAt;
      if (!invite.activatedAt) invite.activatedAt = session.createdAt;
      this.ledger.sessions.push(session);
      return {
        token,
        session: { expiresAt, invite: this.publicInvite(invite) },
      };
    });
  }

  authenticateToken(tokenValue) {
    const token = plainText(tokenValue);
    if (!token || token.length > 1024) throw new GatewayStoreError('登录状态无效，请重新输入授权码。', 401, 'invalid_session');
    const tokenHash = this.hash(token);
    const session = this.ledger.sessions.find((entry) => safeEqual(entry.tokenHash, tokenHash));
    const invite = session ? this.findInviteById(session.inviteId) : null;
    if (invite?.deviceProofStatus === 'legacy_reissue_required') {
      throw new GatewayStoreError('该授权需要管理员补发新授权码后才能继续使用。', 409, 'license_reissue_required');
    }
    if (!session || session.revokedAt || this.isExpired(session.expiresAt)) {
      throw new GatewayStoreError('登录状态已失效，请重新输入授权码。', 401, 'invalid_session');
    }
    if (!session.deviceKeyId || !invite?.device || invite.deviceProofStatus !== 'bound'
      || !safeEqual(session.deviceKeyId, invite.device.keyId)) {
      throw new GatewayStoreError('当前授权缺少可信设备签名，请联系管理员补发授权码。', 409, 'license_reissue_required');
    }
    this.assertActiveInvite(invite);
    return { session, invite };
  }

  async authenticate(tokenValue) {
    await this.writeQueue;
    return this.authenticateToken(tokenValue);
  }

  async consumeAuthenticatedDeviceNonce(tokenValue, keyIdValue, nonceValue, expiresAtValue) {
    const nonceInput = this.validateNonceInput(keyIdValue, nonceValue, expiresAtValue);
    return this.mutate(async () => {
      const auth = this.authenticateToken(tokenValue);
      if (!safeEqual(auth.session.deviceKeyId, nonceInput.keyId)
        || !safeEqual(auth.invite.device.keyId, nonceInput.keyId)) {
        throw new GatewayStoreError('设备签名与当前授权不匹配。', 401, 'device_key_mismatch');
      }
      this.recordNonce(nonceInput);
      return auth;
    });
  }

  async consumeQuota({ session, invite }, metadata = {}) {
    return this.mutate(async () => {
      // Resolve the authorization again inside the serialized mutation. The
      // object supplied by the preceding proof check may be stale when a
      // second function instance revoked or reissued the invite meanwhile.
      const currentSession = this.ledger.sessions.find((entry) => entry.id === session?.id);
      const currentInvite = currentSession ? this.findInviteById(currentSession.inviteId) : null;
      if (!currentSession || !currentInvite) {
        throw new GatewayStoreError('当前授权已失效，请重新激活。', 401, 'invalid_session');
      }
      this.assertActiveInvite(currentInvite);
      if (currentSession.revokedAt || this.isExpired(currentSession.expiresAt)) {
        throw new GatewayStoreError('登录状态已失效，请重新输入授权码。', 401, 'invalid_session');
      }
      const used = this.quotaForInvite(currentInvite.id);
      if (used >= currentInvite.quotaLimit) {
        throw new GatewayStoreError('本期使用额度已用完，请联系管理员续费或追加额度。', 429, 'quota_exhausted');
      }
      const usage = {
        id: randomUUID(),
        inviteId: currentInvite.id,
        sessionId: currentSession.id,
        kind: metadata.kind === 'market_research' ? 'market_research' : 'llm_chat',
        status: 'accepted',
        createdAt: this.nowIso(),
        inputChars: Math.max(0, Number(metadata.inputChars) || 0),
        outputChars: 0,
      };
      this.ledger.usage.push(usage);
      return {
        usage,
        quota: {
          quotaLimit: currentInvite.quotaLimit,
          requestsUsed: used + 1,
          requestsRemaining: Math.max(0, currentInvite.quotaLimit - used - 1),
        },
      };
    });
  }

  async finishUsage(usageId, { status, outputChars = 0 } = {}) {
    return this.mutate(async () => {
      const usage = this.ledger.usage.find((entry) => entry.id === usageId);
      if (!usage) return;
      usage.status = status || 'completed';
      usage.outputChars = Math.max(0, Number(outputChars) || 0);
      usage.finishedAt = this.nowIso();
    });
  }

  async refundUsage(usageId) {
    return this.finishUsage(usageId, { status: 'refunded', outputChars: 0 });
  }

  async revokeInvite(inviteId) {
    return this.mutate(async () => {
      const invite = this.findInviteById(inviteId);
      if (!invite) throw new GatewayStoreError('授权码不存在。', 404, 'invite_not_found');
      invite.status = 'revoked';
      invite.revokedAt = this.nowIso();
      for (const session of this.ledger.sessions) {
        if (session.inviteId === invite.id && !session.revokedAt) session.revokedAt = invite.revokedAt;
      }
      return this.publicInvite(invite);
    });
  }

  async reissueInvite(inviteId) {
    return this.mutate(async () => {
      const original = this.findInviteById(inviteId);
      if (!original) throw new GatewayStoreError('授权码不存在。', 404, 'invite_not_found');
      if (original.status === 'replaced') {
        throw new GatewayStoreError('该授权码已经补发过，请使用最新授权码。', 409, 'invite_already_reissued');
      }
      this.assertActiveInvite(original);

      const reissuedAt = this.nowIso();
      const used = this.quotaForInvite(original.id);
      original.status = 'replaced';
      original.replacedAt = reissuedAt;
      for (const session of this.ledger.sessions) {
        if (session.inviteId === original.id && !session.revokedAt) session.revokedAt = reissuedAt;
      }

      const code = `AIF-${randomBytes(15).toString('base64url').toUpperCase()}`;
      const replacement = {
        id: randomUUID(),
        codeHash: this.hash(code),
        label: original.label,
        status: 'active',
        // Preserve only the buyer's unconsumed balance. A zero balance may
        // still be activated so support can subsequently top it up.
        quotaLimit: Math.max(0, original.quotaLimit - used),
        expiresAt: original.expiresAt,
        createdAt: reissuedAt,
        activatedAt: null,
        reissuedFrom: original.id,
        device: null,
        deviceProofStatus: 'unbound',
      };
      this.ledger.invites.push(replacement);
      return { code, invite: this.publicInvite(replacement), replacedInvite: this.publicInvite(original) };
    });
  }

  async updateInviteQuota(inviteId, quotaLimit) {
    const quota = positiveInteger(quotaLimit, 0);
    if (!quota || quota > 100000) throw new GatewayStoreError('授权码额度必须在 1 到 100000 之间。', 400, 'invalid_quota');
    return this.mutate(async () => {
      const invite = this.findInviteById(inviteId);
      if (!invite) throw new GatewayStoreError('授权码不存在。', 404, 'invite_not_found');
      invite.quotaLimit = quota;
      invite.updatedAt = this.nowIso();
      return this.publicInvite(invite);
    });
  }
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
