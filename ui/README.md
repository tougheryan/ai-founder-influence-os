# Echo Founder Frontend Workbench

This is the Next.js workbench for Echo Founder. It is packaged with the local
runtime and should normally be started through the desktop app. `AIFIOS_*`
environment names are retained only as internal compatibility contracts.

## Recommended Start

```bash
cd /path/to/AIFI-OS
python3 scripts/aifios.py --project ~/ai-content-system ui --install-deps --port 3000
```

Open `http://localhost:3000/production?stage=1`.

The CLI sets the required environment variables before starting Next.js:

- `AIFIOS_HOME`: internal install root.
- `AIFIOS_PROJECT`: project data root containing `pipeline/`, `brain/`, `sessions/`, `materials/`.
- `AIFIOS_SKILLS_DIR`: bundled skills directory.

If `--project` is omitted, the project data root defaults to
`~/ai-content-system`. This keeps generated content, API config, and delivery
assets out of the source install directory. Packaged desktop installs instead
default to `~/Echo Founder/`, while preserving saved and legacy project paths.

## Direct Next.js Commands

Use direct commands only for frontend development:

```bash
cd ui
npm ci
AIFIOS_HOME="$(pwd)/.." \
AIFIOS_PROJECT="$HOME/ai-content-system" \
AIFIOS_SKILLS_DIR="$(pwd)/../skills" \
npm run dev -- --hostname 127.0.0.1 --port 3000
```

## Verification

From the repository root:

```bash
cd ui && npm run lint && npm run build
python3 scripts/ui_smoke.py --base-url http://localhost:3000 --exercise-writes --project-dir ~/ai-content-system
```
