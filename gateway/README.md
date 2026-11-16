# AIFIOS Gateway

This is the paid-access gateway for the AIFIOS desktop app. It keeps the owner's model credential on the server, activates a buyer with a unique authorization code, stores only hashed authorization/session credentials, and counts accepted model requests against each license quota.

## Start

1. Copy `.env.example` to `gateway/.env` on the server and fill in the owner-controlled upstream model settings.
2. Point the intended subdomain's DNS A/AAAA record at the server before starting the bundled Caddy proxy.
3. Set `GATEWAY_PUBLIC_ORIGIN` to the exact HTTPS origin embedded in the hosted desktop build.
4. Keep `GATEWAY_ADMIN_TOKEN`, `GATEWAY_TOKEN_PEPPER`, and every `UPSTREAM_*` secret on the server only.

```bash
cd gateway
cp .env.example .env
# edit .env on the server; do not put it in source control
docker compose up -d --build
docker compose ps
```

`compose.yaml` runs one non-root gateway instance, persists its ledger in the Docker-managed `gateway_data` volume, and exposes it only through Caddy with automatic HTTPS. The image creates that volume target with the correct ownership before dropping privileges, so a clean Tencent Cloud host can start without a manual `chown`. This JSON ledger mode is intentionally a single-replica beta deployment; use a transaction-capable database before horizontal scaling or moving it into stateless cloud functions.

Verify after DNS and certificate issuance:

```bash
export AIFIOS_GATEWAY_URL=https://gateway.example.com
export GATEWAY_ADMIN_TOKEN='the-admin-token'
npm run verify:deployment
# Performs one upstream model request as an optional final check:
npm run verify:deployment -- --model-smoke
```

The deployment verifier creates a disposable authorization code and two independent Ed25519 key pairs. It proves first-key activation, second-key rejection, stolen-session rejection, nonce replay rejection, and the public administrator binding state. It revokes the disposable code before exiting.

Create a backup inside the persistent volume, then copy it off the server and encrypt it with your normal backup tooling:

```bash
docker compose exec -T \
  -e GATEWAY_BACKUP_DIR=/var/lib/aifios-gateway/backups \
  gateway node scripts/backup-ledger.mjs
docker compose cp gateway:/var/lib/aifios-gateway/backups ./backups
```

The backup tool accepts both v1 ledgers and the current v2 ledger. To restore, stop the gateway, mount the selected host backup read-only into a one-shot root container, copy it to `/var/lib/aifios-gateway/ledger.json`, set owner `node:node` and mode `0600`, then start the gateway again. Restoring an older snapshot can resurrect revoked sessions or remove consumed nonces, so a rollback restore is not an in-place recovery: keep the gateway offline, restore, then reissue every affected active license before reopening traffic.

```bash
docker compose stop gateway
docker compose run --rm --user root \
  -v "$PWD/backups:/restore:ro" \
  gateway sh -c 'cp /restore/ledger-YYYY-MM-DD.json /var/lib/aifios-gateway/ledger.json && chown node:node /var/lib/aifios-gateway/ledger.json && chmod 600 /var/lib/aifios-gateway/ledger.json'
docker compose up -d gateway
```

## Tencent Cloud Function + CloudBase

If the available Tencent service is Cloud Functions rather than a persistent
host, deploy `src/cloudbase-handler.mjs` as an HTTP-triggered Node.js function
and set the function handler to `cloudbase-handler.main_handler` (the bundled
CommonJS wrapper loads the ESM implementation). Install
the gateway package with `npm ci --omit=dev`; the package includes
`@cloudbase/node-sdk`. The handler keeps the model and TikOmni credentials in
function environment variables and stores the hashed authorization ledger in a
single CloudBase document through database transactions.

From the repository, a ready-to-upload zip can be assembled with:

```bash
cd gateway
npm run bundle:cloudbase -- --output ../dist/aifios-cloudbase-gateway.zip
```

Create the CloudBase database collection named by `GATEWAY_CLOUDBASE_COLLECTION`
(`aifios_gateway_ledger` by default) and configure these function variables:

```text
GATEWAY_PUBLIC_ORIGIN=https://license.your-domain.cn
GATEWAY_CLOUDBASE_COLLECTION=aifios_gateway_ledger
GATEWAY_CLOUDBASE_DOCUMENT_ID=main
GATEWAY_PATH_PREFIX=
GATEWAY_TRUST_PROXY=1
GATEWAY_ADMIN_TOKEN=...
GATEWAY_TOKEN_PEPPER=...
UPSTREAM_API_KEY=...
UPSTREAM_BASE_URL=https://api.deepseek.com/v1
UPSTREAM_MODEL=...
```

Bind the HTTPS custom domain directly to the function so the client sees
`/healthz`, `/v1/activate`, `/v1/me`, `/v1/llm/chat` and
`/v1/research/market-signal` without an unlisted path prefix. If API Gateway
adds a stage prefix, set the exact prefix in `GATEWAY_PATH_PREFIX`. The
function adapter buffers streaming model events into the HTTP response, which
is compatible with the desktop client but is less efficient than the Docker
gateway's direct stream.

Do not deploy the function without CloudBase database access. A function-local
JSON file is not a valid paid deployment: separate warm instances would not
share nonce consumption, device bindings or quotas.

## Invite Operations

Run these commands from an administrator machine. The invite code is printed once at creation time; the ledger intentionally retains only its hash.

```bash
export AIFIOS_GATEWAY_URL=https://gateway.example.com
export GATEWAY_ADMIN_TOKEN='the-admin-token'

npm run invite -- invite:create --label "张三" --quota 50
npm run invite -- invite:list
npm run invite -- invite:quota <invite-id> 100
npm run invite -- invite:revoke <invite-id>
npm run invite -- invite:reissue <invite-id>
```

The current beta unit is one accepted model request or one accepted hosted market-research request. A model request that fails before the gateway has connected to the model is refunded; a request that begins upstream generation remains counted, including a client-side stream interruption. A hosted research request is counted once it has been accepted for TikOmni retrieval, including when a source platform later reports an outage.

The first hosted activation proves possession of an installation-specific Ed25519 private key and binds the invite to its canonical SPKI public key. The private key is encrypted through the operating-system keychain and never leaves the desktop process. Every activation, `/v1/me`, model, and hosted-research request signs the exact method, fixed pathname, raw body hash, bearer-token hash, timestamp, and nonce. Nonces are durably recorded in the v2 ledger before a capability is accepted, so a captured request cannot be replayed after a process restart. A second private key is rejected even when it has copied the bearer session.

This is strong access control against ordinary installer/session sharing, not hardware-backed DRM. A determined owner of an already authorized computer can modify the app or operate that computer as a signing relay. Paid model and TikOmni capabilities therefore remain server-side and quota-enforced.

When a paying user changes computers or loses the local OS-keychain identity, reissue the invite. The prior session and code are disabled immediately, and the replacement carries only the unconsumed quota. The replacement code is printed once and must be delivered privately.

## Desktop Packaging

Build the macOS client only after the gateway has a stable HTTPS URL:

```bash
python3 scripts/desktop_package.py \
  --app-name "Echo Founder" \
  --arch universal \
  --hosted-gateway-url https://gateway.example.com
```

This embeds only `hosted-client.json` with the public gateway URL. The packaging flag rejects insecure or credential-bearing URLs. It does not embed model keys, TikOmni tokens, admin tokens, invite codes, or a shared session.

The DMG builder additionally refuses placeholder hosts such as `gateway.example.com`, localhost, and loopback addresses. A proof build may use the example host, but it cannot be turned into a distributable DMG until a real HTTPS gateway origin is embedded.

The hosted build is the paid/shareable form. On first launch it stops at “激活此设备” until the buyer enters the unique authorization code. The local self-config build is a separate mode and intentionally has no gateway license gate.

The desktop startup path fails closed: a saved token is not treated as proof of authorization until `/v1/me` accepts a fresh signature from the bound private key. If the gateway is unavailable or rejects either value, the hosted build remains on the activation screen and never falls back to direct local API configuration.

## Device Proof Protocol

Device proof v1 uses these five request headers:

```text
x-aifios-device-proof-version: 1
x-aifios-device-key-id: ed25519:<base64url SHA-256 of canonical SPKI DER>
x-aifios-device-timestamp: <Unix epoch milliseconds>
x-aifios-device-nonce: <base64url random bytes>
x-aifios-device-signature: <base64url Ed25519 signature>
```

The signed bytes are UTF-8 with no trailing newline:

```text
[
  "AIFIOS-DEVICE-PROOF-V1",
  GATEWAY_PUBLIC_ORIGIN,
  keyId,
  timestamp,
  nonce,
  METHOD_IN_UPPERCASE,
  exactFixedPathname,
  base64url_sha256(rawRequestBody),
  base64url_sha256(rawBearerTokenOrEmptyString)
].join("\\n")
```

Signed v1 endpoints reject query strings, non-canonical/normalized request targets, duplicate proof headers, encoded request bodies, and clock drift beyond `DEVICE_PROOF_MAX_SKEW_SECONDS`. Activation includes `{algorithm, keyId, publicKeySpki}` under `device` and is itself signed by that key.

When a v1 ledger is opened, it is atomically rewritten as v2. Never-activated codes remain usable with Ed25519 activation. Previously activated v1 licenses and all old sessions fail closed with `license_reissue_required`; use `invite:reissue` to issue a fresh code and bind a new key.

## Hosted TikOmni Research

To let invited friends pass the mandatory three-platform topic-research gate without a local TikOmni token, configure `TIKOMNI_API_KEY` and an Ed25519 signing key on the gateway. The client sends only locally-derived search terms; source materials stay on the friend’s device. Gateway research responses are signed, bound to a one-time client request ID, and expire after five minutes. The desktop app verifies the public signature before its existing local runtime writes the immutable run snapshot.

Generate a key pair on an administrator machine and retain the private output only in `gateway/.env`:

```bash
node - <<'NODE'
const { generateKeyPairSync } = require('crypto');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
console.log('GATEWAY_RESEARCH_SIGNING_PRIVATE_KEY_BASE64=' + privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'));
console.log('DESKTOP_HOSTED_RESEARCH_PUBLIC_KEY=' + publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'));
NODE
```

Build the hosted desktop client with the public output only:

```bash
python3 scripts/desktop_package.py \
  --app-name "Echo Founder" \
  --arch universal \
  --hosted-gateway-url https://gateway.example.com \
  --hosted-research-public-key "$DESKTOP_HOSTED_RESEARCH_PUBLIC_KEY"
```

The gateway uses three frozen catalog endpoint IDs for WeChat public-account search, Xiaohongshu note search, and WeChat Channels video search. It does not accept a caller-provided TikOmni path, method, endpoint ID, or parameter set.

## Privacy Boundary

The ledger records invite/session hashes, public device keys/key IDs, hashed nonces, request timestamps, request status, and input/output character counts. It does not persist authorization codes, bearer tokens, device private keys, prompts, completions, upstream responses, or model credentials. Protect the ledger data directory with server-only filesystem permissions and back it up as operational data.

Activation attempts are rate-limited per client address. In the Compose deployment, Caddy is the only public entry point and `GATEWAY_TRUST_PROXY=1` makes this limit use its forwarded client address.

For hosted TikOmni research, the ledger adds only the request kind and character count of the derived search terms. It still never persists an owner TikOmni token, research response, prompt, completion, or raw source material. The immutable public research snapshot remains in the friend’s local AIFIOS project, where existing topic-gate validation continues to apply.
