# Echo Founder Active Skill Catalog

## Scope

`skills/manifest.json` is the only installable Skill surface. It contains the
production domains behind the single "Content Production" workspace and a
small set of optional creative enhancements. Operators do not navigate through
individual Skills during normal production. The active runtime is Codex-native
local code; it does not depend on a Superpowers workflow.

New runs select any non-empty combination of WeChat official account,
Xiaohongshu and WeChat Channels. The lanes share a fact base and constraints,
then research, choose an angle and generate independently; no motherpiece is
used as another platform's input.

## Production Core

| Domain | Skill | Role |
| --- | --- | --- |
| Runtime | `content-runtime` | Owns local runs, approvals, hashes, state, and project paths. |
| Material | `content-intake` | Extracts usable facts, privacy boundaries, and material gaps. |
| Market research | `content-hit-collector` | Supplies the public-evidence domain for mandatory TikOmni market research. The runtime always verifies live WeChat official account, Xiaohongshu and WeChat Channels data before topic approval. |
| Topic decision | `content-validate` | Gates topic approval on authorized material and current research. |
| Platform blueprint | `content-blueprint` | Produces platform-specific structures bound to the shared evidence boundary. |
| Long-form writing | `wechat-writer` | Drafts the WeChat-native article for the WeChat lane. |
| Content package | `content-package` | Enforces the three independent platform-native delivery contracts. |
| Visual publication | `content-visual` | Plans covers, illustrations, card pages, and selected visual assets. |
| Card renderer | `xhs-card` | Renders approved social-card and cover deliverables. |
| WeChat layout | `dbs-wechat-html` | Independent Echo Founder MIT implementation at the compatibility path; produces basic WeChat HTML previews. |

## Optional enhancements in the public source edition

The bundled optional tier contains `baoyu-diagram` and `baoyu-comic`, both with upstream MIT notices. Restricted DBS prompts and the unverified illustration-style pack are not redistributed. DBS integrations remain optional callers and require a separately installed, appropriately authorized upstream copy. The core production workflow does not require them.

## Compatibility Boundary

Older source folders remain in the repository only so the history migration can
read existing local projects. They are not listed in the install manifest, are
not installed by `scripts/install.py`, and are not a navigation or default
production surface. `docs/superpowers/` is likewise historical planning
archive, not an active dependency. Migrate verified publication history before
any later physical cleanup:

```bash
python3 scripts/migrate_final_publication_history.py --project ~/ai-content-system --dry-run
python3 scripts/migrate_final_publication_history.py --project ~/ai-content-system --apply
```

## Source of Truth

- Active install manifest: `skills/manifest.json`
- Production workflow: `docs/content-production-loop.md`
- Active remediation and acceptance baseline: `docs/content-production-remediation.md`
- Runtime authority: `skills/content-runtime/scripts/content_runtime.py`
- History migration contract: `scripts/migration_manifest.json`
