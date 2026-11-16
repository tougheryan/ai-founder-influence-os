# Echo Founder Desktop Shell

## Scope

The desktop shell is a small Electron wrapper around the existing local workspace. It owns process startup, local port selection, single-instance protection, service recovery and diagnostics. It does not introduce a second business runtime.

## Requirements

- macOS 13+ on Apple Silicon (arm64) for the `0.2.0-beta.2` delivery
- UI dependencies installed with `cd ui && npm install`
- Python 3 available, or an embedded Python runtime in a packaged app

## Commands

```bash
make desktop-check
make desktop PROJECT=~/ai-content-system
make desktop-smoke
make desktop-soak DESKTOP_SOAK_DURATION=60 DESKTOP_SOAK_INTERVAL=10
```

## Packaging

```bash
make desktop-package
make desktop-packaged-smoke
make desktop-packaged-open-smoke
make desktop-packaged-single-instance-smoke
make desktop-packaged-recovery-smoke
make desktop-packaged-watchdog-smoke
```

`desktop-package` can embed a relocatable Python runtime with `DESKTOP_EMBED_PYTHON_RUNTIME=auto|required|off`. Packaged smoke tests start with a minimal environment and isolated user data directory.

The desktop package is a local self-configuration build: it does not embed a gateway URL, invitation code, owner model credentials or TikOmni credentials. Each user completes their own model and optional research-service setup in the Settings page after installation.

On a sandboxed build machine where the internal compatibility cache is not writable, point the build-only download cache at a writable temporary directory:

```bash
AIFIOS_DESKTOP_CACHE_DIR=/private/tmp/aifios-desktop-cache make desktop-package
```

The cache is not copied into the finished app.

## Diagnostics

The settings page exposes runtime availability, project health, desktop mode, single-instance state and service recovery state, plus a redacted diagnostics download. New packaged installs default to `~/Echo Founder/`; saved paths, explicit `AIFIOS_PROJECT`, and an existing historical `~/ai-content-system/` remain compatible.

## Distribution

The current build is an unsigned internal beta. A future public macOS distribution must run package, DMG, Developer ID signing, notarization and Gatekeeper checks in sequence:

```bash
make desktop-dmg
make desktop-dmg-verify
make desktop-external-release
make desktop-external-verify
make desktop-release-assessment REQUIRE_EXTERNAL_READY=1
```

Credentials are intentionally not stored in the repository.
