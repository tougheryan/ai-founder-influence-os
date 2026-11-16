# Desktop Risk Assessment

## Current Boundary

The desktop product is a local wrapper around one workspace and one local service. It supports the active WeChat and Xiaohongshu workflow only.

## Controls

| Risk | Control |
|---|---|
| Finder has a minimal environment | Packaged startup resolves Python independently from a shell profile. |
| Duplicate launches | Electron enforces one instance and focuses the existing window. |
| Service exits after startup | The shell records the failure and attempts bounded recovery. |
| Service becomes unresponsive | A watchdog probes the local service and restarts it when needed. |
| User data leaks into evidence | Diagnostics export redacts local paths and secret-like values. |
| Packaging drift | Package, smoke, DMG and release-assessment commands produce auditable reports. |

## Verification

```bash
make desktop-check
make desktop-package
make desktop-packaged-smoke
make desktop-packaged-open-smoke
make desktop-packaged-single-instance-smoke
make desktop-packaged-recovery-smoke
make desktop-packaged-watchdog-smoke
```

External distribution still requires Developer ID signing, notarization, staple and Gatekeeper validation on a clean machine.
