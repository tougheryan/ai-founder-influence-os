# Echo Founder 0.2.0-beta.2 Internal Release Candidate

## Release Boundary

This release is an internal, ad-hoc-signed desktop candidate. It is not notarized and does not claim independent commercial QA. The active implementation is Codex-native local runtime code and does not depend on a Superpowers workflow; historical material under `docs/superpowers/` is not a release entry point.

Each run selects any non-empty combination of WeChat official account, Xiaohongshu and WeChat Channels. The three lanes share only the fact base, source evidence, creator voice and disclosure boundaries; they independently research, choose an angle and generate native content. There is no WeChat motherpiece conversion path. Xiaohongshu delivers exactly P1–P8; WeChat Channels delivers script, hook, shots, subtitle priorities and post copy without a static-visual task.

## Required Operating Rules

- With “help me find a direction”, topic approval requires fresh TikOmni evidence for the selected platforms. The desktop draft bridge verifies the same selected-platform scope. Legacy five-platform queues retain their original three-platform evidence contract; WeChat Channels remains their Douyin research proxy.
- With “write from my own topic”, topic approval binds the author's explicit topic, selected platforms and immutable material record. This path does not request platform research or claim market validation. Source, topic, platform or material-correction changes require review again; the desktop bridge verifies the current author record and its blueprint binding.
- After topic/template approval, the selected writing evidence is immutable for the approved version. Cached, historical and inferred samples cannot replace a failed live research pass. A missing research record never silently switches a run to the author-material path.
- The operator must confirm the topic/template, complete content package, each adopted platform layout, platform draft information and final publication result.
- New runs are fixed to `stable` layout mode. WeChat preserves authorized images already present in the source, prefers the locally installed `md2wechat` CLI, and falls back to the bundled `dbs-wechat-html` renderer; Xiaohongshu renders deterministic P1–P8 cards locally. The production flow offers no AI-image option, does not read image-provider accounts, and does not invoke paid image-generation services.
- `md2wechat` is detected at runtime and is not bundled in this candidate. Commercial redistribution or commercial use must follow its separate license; the bundled renderer remains the release-safe fallback.
- The local queue can fill authorized drafts, but the operator clicks send in every platform. WeChat uses the official draft API first and an authorized browser fallback; other editor paths require the operator's local authorization.
- Current queues contain exactly one job per selected platform. A WeChat Channels-only execution package stays local and does not require a visual manifest; runs with image/text platforms still require the current approved visual assets. Legacy queues retain all 11 original jobs and cannot be partially reinterpreted as a new queue.
- Current delivery audits use the selected-platform contract before packing and verify the same public file digests in the directory and ZIP. Source, plan, content, layout or draft-information changes invalidate the previous audit. File handoff does not require or create a public publication result. Offline demos remain internal-only.
- Native Xiaohongshu pages determine evidence requirements from their own copy and cited material, separately from the layout route. Advice containing words such as “method” does not automatically require a data image. Factual claims still require page-specific sources; ambiguous assertions remain marked for review. Changed copy or source bytes generate a new recipe candidate without rewriting an adopted revision.
- Weekly learning uses manually supplied, attributable metrics for verified publication records. It cannot turn mock or missing data into a durable conclusion.
- The optional Benchmark Growth Advisor is isolated by project, accepts one to five public accounts, keeps evidence links and capture times, refreshes weekly and writes to a run only after explicit adoption.

## Skill Boundary

The installable surface is [`skills/manifest.json`](skills/manifest.json): a core production tier plus an optional enhancement tier. Legacy Skill folders are compatibility inputs for the final-publication history migration, not default production routes or UI navigation. The active inventory is documented in [docs/skills-catalog.md](docs/skills-catalog.md).

## Release Gates

```bash
make version-check
make commercial-readiness-source  # automated source preflight only
make test
make pytest
make runtime-contracts
make ui-runtime-gates
make content-loop-check
make package
make quickstart-smoke
make smoke-release
```

For frontend verification:

```bash
cd ui
npx tsc --noEmit
npm run lint
npm run build
```

For the desktop shell:

```bash
make desktop-check
make desktop-package
make desktop-packaged-smoke
make desktop-packaged-open-smoke  # isolated HOME, dynamic port, no AIFIOS_* bootstrap
make desktop-package-traceability
make desktop-release-assessment
```

The arm64 candidate artifact is `Echo-Founder-0.2.0-beta.2-mac-arm64.dmg`, accompanied by an exact-name `.dmg.sha256` checksum. Its manifest binds `Echo-Founder-0.2.0-beta.2-mac-arm64.package-manifest.json`, which records the frozen source SHA, clean state, shipped-runtime tree digest and dependency/license inventory. A dirty build or a filename containing `internal` is only a snapshot and cannot be the frozen candidate.

Run `make commercial-readiness-full-automated` for the packaged, recovery and 30-minute soak preflight. This target explicitly uses `--automated-only`, may report an honest `dirty=true` internal build, and can never certify commercial acceptance.

For this internal candidate, use `quality/acceptance/internal-release-acceptance.template.json` (`echo-founder.internal-release-acceptance.v2`), or initialize a new observation workspace with `python3 scripts/internal_release_acceptance.py --init <new-directory>`. It covers the current stable layout, real model/cost checks, author and research paths, native production, drafts, installation and recovery; every generated observation starts pending. The checker binds the exact DMG and manifests and always reports `commercial_ready=false`. See [the acceptance instructions](quality/acceptance/README.md). There is currently no reviewed formal-acceptance schema for the fixed `stable` layout path. A future replacement must still bind clean source and a frozen App/DMG to real-account evidence and an independently reviewed QA trust anchor; rebuilding after acceptance invalidates that evidence.

The former six-account, ten-route paid-image benchmark and `echo-founder.real-account-acceptance.v3` artifacts are retained only for historical AI-image experiments, compatibility and audit. They are not requirements for the current production path, and a complete or signed v3 record cannot certify this candidate. The formal CLI and the settings status endpoint enforce this policy separately from historical signature verification. Settings show raw record status as unverified, never infer signature validity from a nonempty field, and keep missing, unreadable, malformed or duplicate evidence unverified. Loading and failed reads cannot mark production evidence complete. Current eligibility follows these rules: v2/v3 real-account records are read-only, internal records cannot certify a release, and an unreviewed schema name cannot grant eligibility. Until a replacement acceptance schema is independently reviewed and completed, this candidate remains internal-only.

The release is ready for internal use only after the applicable gates pass. This beta does not claim Apple Developer ID signing, notarization or Gatekeeper public-distribution readiness. See [the commercial readiness matrix](quality/commercial-readiness-matrix.md) for current blockers.
