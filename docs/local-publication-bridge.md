# Local Publication Bridge

The desktop app keeps publication credentials in the operating-system keychain
and never writes them to content packages or draft queues. Public sends are not
implemented by this bridge: every platform remains at a human send/confirm
step.

## Account Binding

Configure one local account for each platform from **Settings / Local
publication accounts**:

- WeChat Official Account API: `appId`, `appSecret`, optional author.
- WeChat browser fallback: a logged-in local `mp.weixin.qq.com` editor.
- Xiaohongshu browser: a logged-in local creator editor.
- Moments mobile bridge: a paired local mobile companion endpoint and pairing
  token.

Browser cookies remain in Electron's local persistent profile. Credential
values are encrypted with Electron `safeStorage`; the UI only receives binding
status, never a saved secret.

## WeChat Official Account

The desktop app obtains a temporary API token, uploads the adopted cover and
inline images, and calls `draft/add`. It does not call a mass-send,
free-publish, or publish endpoint. If the API is unavailable or rejects the
draft, the queue attempts the configured logged-in browser editor instead.

## Browser Editors

The app opens a platform-scoped persistent browser window. The operator signs
in and opens the platform editor. The bridge fills title, body, and adopted
local images without clicking a submit/publish control. Image paths handed to
Chromium point only to private main-process snapshots made from already
verified bytes, never back to mutable project files. The input then clones
those bytes in memory before the private files are zeroed and removed. On the
next app start, Echo Founder also sanitizes snapshots left by a process crash.
If an editor selector, file picker, CAPTCHA, or device confirmation cannot be
verified, the queue is marked for human handling rather than claiming success.

## Moments Mobile Companion Contract

The paired companion must expose a local-network HTTP endpoint or an HTTPS
endpoint. AIFIOS sends a `POST` request with `multipart/form-data`:

```text
Authorization: Bearer <pairing-token>
operation=aifios.moments.prefill.v1
title=<title>
copy=<copy>
human_send_required=true
images=<one or more adopted image files>
```

It must reply with one of the following JSON payloads:

```json
{ "status": "prefilled", "draftId": "local-editor-draft-id" }
```

```json
{ "status": "draft_filled", "draftId": "local-editor-draft-id" }
```

Any other response, network failure, expired pairing, or missing confirmation
is retained as a failed or human-verification queue item. The companion must
leave the Moments composer open for the operator to send manually.

## Signed Queue Results

The renderer sends only the project-local queue path, run ID, job ID, and the
payload hash it expects. Before opening an editor or making any API/mobile
request, Electron main reads the real queue with `O_NOFOLLOW` through the same
validated file descriptor, requires a regular single-link file owned by the
current user, and reconstructs the job from that queue. Under the versioned
`echo-founder.publication-authority.v1` contract it also reads the canonical
`runs/<run_id>.json`, matches `run_id + slug`, validates the current material
boundary and frozen TikOmni evidence, and requires current topic, content,
visual, and draft human approvals. It then recomputes the queue payload hash
and securely reads the bound content package, visual manifest, exact platform
body, and adopted assets to verify every recorded SHA-256. A missing, replaced,
linked, out-of-project, invalidated, unapproved, or hash-mismatched file fails
closed before any platform side effect.

Before that side effect, main atomically records an `in_flight` attempt in
`materials/publication/desktop-transactions/<run_id>/<job_id>.json` using schema
`echo-founder.publication-transaction.v1`. The adapter result is durably stored
before a signed receipt is returned. A process exit with an unfinished attempt
recovers as terminal `unknown_completion`, so the bridge never repeats an
uncertain platform action. `retryable_failure` and
`manual_intervention_required` can start a new attempt only after the signed
prior result has been applied by the server and increased the authoritative
queue `attempt_count`; concurrent requests from the same queue revision replay
one result instead of calling the platform twice. Manual retries require an
explicit confirmation after login, CAPTCHA, device confirmation, or bridge
pairing is complete. Project backups retain these JSON journals for
reconciliation and omit transient `.lock` files.

Electron signs each local fill result using an ephemeral per-launch HMAC secret
passed only to its child local service. The server verifies the receipt, binds
it to the current queue path, run, job ID, and payload hash, and records each
receipt ID once. Receipt identity comes from the main-process reconstruction;
a renderer request cannot supply a job body or invent a successful draft fill.
