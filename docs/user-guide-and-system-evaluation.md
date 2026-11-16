# Echo Founder User Guide And System Evaluation

## What It Does

Echo Founder turns one authorized source into any non-empty combination of three platform-native deliverables:

- WeChat official account: complete article, title, summary, HTML, cover and inline visuals;
- Xiaohongshu: title, body, cover copy, exactly P1–P8 and ending tags;
- WeChat Channels: hook, spoken script, shot guidance, subtitle priorities and post copy, with no static-visual job.

The lanes share only facts, evidence, creator voice, disclosure boundaries and commercial goals. Each lane researches, chooses an angle and writes independently; the WeChat article is never the source draft for Xiaohongshu or WeChat Channels. Every public send remains a human action.

## Basic Use

Configure the model provider and TikOmni before starting. Automatic illustration is the default: it always has a deterministic local cover/diagram fallback. A paid image account is optional and is used only after the operator has explicitly confirmed the image budget; uncertain or failed calls are never charged again automatically.

```bash
make init PROJECT=~/ai-content-system
make onboard \
  PROJECT=~/ai-content-system \
  PLATFORMS="公众号,小红书,视频号" \
  OFFER="..." TARGET="..." PRODUCT="..."
make ui PROJECT=~/ai-content-system PORT=3000
```

Open `/production?stage=1`, select the platform combination and complete the seven stages: material boundary, platform research/direction, platform-native drafts, one recommended platform publish suite, draft information, publication result and optional weekly review. Stages 2–6 require human confirmation.

Use `/benchmark-advisor` only for optional account-level guidance. It is project-isolated, cites public evidence and affects a run only after explicit adoption.

## System Evaluation

A healthy system proves that:

- one `run_id + slug` binds the source boundary, lane snapshots, approvals, assets, drafts and results;
- all seven non-empty platform combinations work, and one lane may fail or retry without altering the others;
- the WeChat article never becomes Xiaohongshu or WeChat Channels generation input;
- missing metrics stay unknown, and TikOmni cannot call future, zero-metric or insufficient-evidence rows verified hits;
- Xiaohongshu contains exactly P1–P8, while WeChat Channels produces zero static-visual jobs;
- AI-enhanced mode creates two direction previews and only one complete selected suite;
- only human-adopted visual assets reach drafts, with accurate Chinese rendered locally;
- draft filling never triggers public send; results require human confirmation and real evidence;
- weekly learning waits for attributable metrics and human confirmation; and
- legacy five-platform, mother-draft and `1+2+3` records remain read-only and cannot re-enter new runs.

## References

- [Content production loop](content-production-loop.md)
- [Active remediation and acceptance baseline](content-production-remediation.md)
- [Commercial delivery SOP](commercial-delivery-sop.md)
- [Paid image acceptance](paid-image-acceptance.md)
- [Active skill catalog](skills-catalog.md)

## Verification

```bash
make version-check
make test
make pytest
make runtime-contracts
make ui-runtime-gates
make content-loop-check
make commercial-readiness-source
cd ui && npx tsc --noEmit && npm run lint && npm run build
```
