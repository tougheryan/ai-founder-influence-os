# Echo Founder Third-Party Notices

The public source edition licenses original Echo Founder code under MIT. Third-party subdirectories retain their own licenses; see [OPEN_SOURCE.md](../OPEN_SOURCE.md). Restricted DBS content and the separately supplied TikOmni connector snapshot are not included in this public tree. The historical fallback module name now points to an independently written MIT renderer. The register below describes packaging obligations, not a statement that an installer has been publicly released.

This is the human-readable register for the internal-beta desktop package. The
machine-readable source of truth is generated inside each App at
`Contents/Resources/aifios/third-party-notices/shipped-dependencies.json`; it is
built from files physically present in that App and includes hashes for the
critical notices. A listing in this document is not legal advice, a warranty,
or a grant of rights.

## Components shipped in the desktop App

### Electron, Chromium and embedded Node.js

- Electron is distributed under the MIT license. The App copies Electron's
  complete `LICENSE` to `third-party-notices/Electron-LICENSE.txt`.
- Electron embeds Chromium, Node.js and other third-party code. The App copies
  the Electron distribution's complete `LICENSES.chromium.html` rather than
  replacing it with a short summary.
- Exact Electron, Chromium and Node.js versions are read from the packaged
  runtime during the build and recorded in the machine inventory.
- Formal packaging accepts only the lock-bound Electron release archives and
  approved SHA-256 values. Each archive is extracted into a new disposable
  directory; a writable previously extracted `Electron.app` is not a package
  input.

### Next.js standalone production runtime

- Only the traced Next.js standalone production tree is shipped; the full UI
  development `node_modules` tree is not.
- The UI dependency closure is installed from `ui/package-lock.json` by
  `npm ci --ignore-scripts` inside a disposable build tree with isolated HOME,
  npm configuration and cache. The local UI `node_modules`, generated `.next*`
  trees, `.env*`, `.npmrc` and symlink inputs are excluded or rejected.
- The packager reads every physical `package.json` in the standalone
  `node_modules`, including the separately vendored metadata under
  `next/dist/compiled`. Each manifest has its own path and SHA-256; compiled
  dependencies are not silently attributed to Next.js or its MIT declaration.
- A missing name, version or declared license is recorded as `NOASSERTION` with
  a matching manual-review boundary. When a manifest directory contains no
  discrete LICENSE/NOTICE text, its aggregate section has an empty evidence
  hash list and a separate matching boundary. Full-text evidence is accepted
  only when its hashes bind to that manifest's section in
  `Next-standalone-NOTICES.txt`.

### Embedded CPython

- The customer package embeds the architecture-specific CPython runtime needed
  by the content runtime. Its exact version and architecture are recorded.
- Each embedded runtime retains CPython's `lib/python*/LICENSE.txt`. The
  packager also enumerates every shipped `.dist-info` directory—including pip,
  setuptools and setuptools' vendored distributions—and hashes `METADATA` plus
  every license/NOTICE file bundled below that distribution. All paths are
  relative to App Resources; no build-machine path is used as evidence.
- CPython comes from the version/architecture release URL and SHA-256 pinned by
  the packager. A formal build extracts that archive from scratch and rejects
  local interpreter directories or mutable managed-runtime fallbacks.

### Playwright and Chromium headless shell

- The `xhs-card` rendering source's lock-bound production closure currently
  includes `fsevents`, Playwright and Playwright Core. The machine inventory
  enumerates every actual package and its LICENSE/NOTICE evidence and binds the
  closure to the shipped `package-lock.json` hash.
- Each separately embedded Chromium headless-shell architecture retains its
  upstream `LICENSE.headless_shell`, including Chromium's third-party notices.
  The Playwright version, browser revision, architecture and notice hashes are
  recorded in the machine inventory.
- The lock-bound browser version/revision maps to an approved archive URL and
  SHA-256 for each architecture. The archive is freshly extracted into an
  isolated build directory; global Playwright browser caches and download-host
  overrides are not runtime inputs.

### op7418/guizang-social-card-skill (`xhs-card`)

- Repository: <https://github.com/op7418/guizang-social-card-skill>
- Declared license: AGPL-3.0-only.
- Use in Echo Founder: local HTML-to-PNG rendering for Xiaohongshu cards and
  WeChat cover pairs.
- Source availability: the distributed App includes the complete customer source snapshot
  at `Contents/Resources/aifios/skills/xhs-card/`, including
  `LICENSE`, `README.md`, `README.en.md` and `MODIFICATIONS.md`; all are bound
  into the machine inventory as license evidence.
- `AGPL-3.0-only` is the declared SPDX identifier. The original text in the
  component's bundled `LICENSE` is authoritative. This register does not decide
  compliance for a commercial, distribution, modification or network-use
  scenario; the distribution operator must obtain an independent
  license-compliance review. This is not legal advice or a legal approval.

### TikOmni API connector boundary

- The App ships only a small caller, resolver and endpoint-catalog subset. A
  formal package must receive its source through the explicit
  `--social-media-crawl-dir` input; home-directory fallback discovery is
  prohibited. Every approved snapshot file and the combined snapshot identity
  are fixed by SHA-256 and rechecked in the App inventory and package manifest.
  The TikOmni service/backend, service source, customer account, token, returned
  data and platform sessions are not shipped.
- The official [`@tikomni/skills` 1.0.7 distribution](https://github.com/mark-ly-wang/TikOmni-Skills/tree/253c98e267e1444aca33ccfea51661cc5a28076c) declares MIT. Its complete upstream copyright and permission text is retained in `TikOmni-Connector-NOTICE.txt`.
- Six approved snapshot files match that release. The local `scripts/core/tikomni_common.py`, `references/api-catalog/aliases.json`, and `references/api-catalog/operations.json` differ. Their provenance remains a review item; the whole local snapshot retains `NOASSERTION` without cancelling the upstream MIT rights.
- Public or broader redistribution requires review of those differences and the separate service terms. No account, token or paid-service entitlement is included.

## Other reviewed capabilities

The following entries describe reviewed source or optional skills. They are not
automatically classified as shipped; only the per-App machine inventory states
what a particular package actually contains.

### JimLiu/baoyu-skills

- Repository: <https://github.com/JimLiu/baoyu-skills>
- License: MIT.
- Reviewed snapshot: `6b7a2e417500561a5ecdd0b168332f4142584617`.
- Use: source-bounded diagram, comic, cover, Xiaohongshu-image and infographic
  capabilities selected by the visual-provider registry. Vendored directories
  preserve their upstream MIT notice.
- Boundary: generated facts, labels and data still require Echo Founder source
  validation; a visual skill does not establish factual accuracy.

### kostja94/social-cards-skills

- Repository: <https://github.com/kostja94/social-cards-skills>
- License: MIT.
- Use: future isolated Open Graph/Twitter-card evaluation only.
- Boundary: not part of the active WeChat/Xiaohongshu production chain.

### wshuyi/remotion-video-skill

- Repository: <https://github.com/wshuyi/remotion-video-skill>
- License: no license was declared at the reviewed source.
- Use: reference-only evaluation; no code, dependency, template, or runtime
  behavior is imported into Echo Founder.
- Boundary: the active product has no motion-media execution surface. Any
  future evaluation requires an explicit license grant and a new product and
  design review before implementation.

### white0dew/XiaohongshuSkills

- Repository: <https://github.com/white0dew/XiaohongshuSkills>
- License: MIT.
- Use: excluded from visual rendering execution.
- Boundary: it targets account search, publish and comment automation and
  requires a separate account-operation review.
