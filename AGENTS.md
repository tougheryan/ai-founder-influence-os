# Echo Founder repository rules

## Product truth

- Customer-facing product name: `Echo Founder`. `AIFI-OS` and `AIFIOS` remain internal compatibility identifiers only.
- Product-version source of truth: root `VERSION`. Run `make version` for source/artifact status and `make version-check` before release work.
- A dirty build or a DMG containing `internal` in its name is an internal snapshot, never a formal release.
- `aifios.*.vN` values are data-schema versions, not product versions.
- `docs/superpowers/` and `dist/friend-release-*` are historical material, not current runtime or delivery entry points.

## Active entry points

- Operator UI: `/production`; normal production follows the seven-stage flow documented in `README.md`.
- Runtime orchestration: `skills/content-runtime/`.
- Current release requirements: `RELEASE.md` and `quality/commercial-readiness-matrix.md`.
- Version semantics and upgrade procedure: `docs/versioning.md`.

## Change safety

- Preserve unrelated working-tree changes. Do not reset or rewrite user work.
- Keep credentials and local project data out of Git; follow `.gitignore` and existing redaction helpers.
- Do not treat generated `dist/`, `outputs/`, `.next*`, runtime project folders or system-audit reports as source files.
- Update existing documentation entries instead of appending session history to this file.
- Use `python3`, not `python`, in repository commands.

## Verification

- Fast contract checks: `make version-check`, `make runtime-contracts`, `make content-loop-check`.
- Full source checks: `make test`, `make pytest`, and the UI checks listed in `README.md`.
- Desktop and commercial release work must use the additional gates in `RELEASE.md`; automated green checks do not replace real-account acceptance.
