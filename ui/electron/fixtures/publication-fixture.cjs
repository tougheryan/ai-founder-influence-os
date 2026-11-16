const assert = require("node:assert/strict");
const { mkdir, rm, writeFile } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { canonicalJsonStringify, draftQueueContractSha256, sha256, stableStringify } = require("../publication-authority.cjs");

const QUEUE_PATH = "materials/publication/drafts/demo/draft-queue.json";
const RUN_ID = "run-demo";
const FIXED_JOBS = [
  ["wechat", "wechat-article", "draft_fill", "wechat_official_api"],
  ["xiaohongshu", "xiaohongshu-opinion-1", "draft_fill", "authorized_browser"],
  ["xiaohongshu", "xiaohongshu-opinion-2", "draft_fill", "authorized_browser"],
  ["xiaohongshu", "xiaohongshu-opinion-3", "draft_fill", "authorized_browser"],
  ["moments", "moments-opinion-1", "draft_fill", "mobile_bridge"],
  ["moments", "moments-opinion-2", "draft_fill", "mobile_bridge"],
  ["moments", "moments-opinion-3", "draft_fill", "mobile_bridge"],
  ["shipinhao", "shipinhao-video-execution-1", "execution_package", "download"],
  ["shipinhao", "shipinhao-video-execution-2", "execution_package", "download"],
  ["douyin", "douyin-video-execution-1", "execution_package", "download"],
  ["douyin", "douyin-video-execution-2", "execution_package", "download"],
];

async function writeProjectFile(root, relativePath, value) {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value, { mode: 0o600 });
  return target;
}

async function writePythonHashedRecord(root, path, value) {
  const generated = spawnSync('python3', ['-c', [
    'import json,sys,hashlib',
    'sys.path.insert(0,sys.argv[1])',
    'from market_signal import _canonical_json_bytes',
    'value=json.load(sys.stdin); value.pop("sha256",None)',
    'value["sha256"]=hashlib.sha256(_canonical_json_bytes(value)).hexdigest()',
    'print(_canonical_json_bytes(value).decode())',
  ].join('\n'), join(__dirname, '../../../skills/content-runtime/scripts')], { input: JSON.stringify(value), encoding: 'utf8', timeout: 10000 });
  assert.equal(generated.status, 0, generated.stderr);
  await writeProjectFile(root, path, generated.stdout);
  return JSON.parse(generated.stdout);
}

async function createQueueFixture(root, options = {}) {
  const targets = options.platforms;
  const activeJobs = targets ? FIXED_JOBS.filter(([platform, item]) => targets.includes(platform === 'xiaohongshu' ? 'xhs' : platform)
    && ['wechat-article', 'xiaohongshu-opinion-1', 'shipinhao-video-execution-1'].includes(item)) : FIXED_JOBS;
  const targetItemId = options.itemId || activeJobs[0][1];
  const materialPath = "pipeline/intake/demo.md";
  const blueprintPath = "pipeline/blueprint/demo.md";
  const packagePath = "pipeline/package/demo-package.md";
  const visualManifestPath = "pipeline/visual/demo/selected-assets.json";
  const materialBody = Buffer.from(options.material || "authorized source material", "utf8");
  const blueprintBody = Buffer.from("approved topic and template", "utf8");
  const nativeXhs = targets?.includes('xhs');
  const nativeCopy = '第一段原文。\n\n第二段必须保留。\n\n你怎么看？\n\n#本地验收';
  const packageBody = Buffer.from(nativeXhs
    ? '## 2. 小红书原生图文\n### 发布正文\n- 标题：八页图文\n- 正文：第一段原文。\n\n第二段必须保留。\n- 结尾问题：你怎么看？\n### 结尾标签\n#本地验收\n'
    : "approved package", "utf8");
  await writeProjectFile(root, materialPath, materialBody);
  await writeProjectFile(root, blueprintPath, blueprintBody);
  await writeProjectFile(root, packagePath, packageBody);

  let selectedJob;
  const selectedForManifest = [];
  const jobs = [];
  for (const [platform, itemId, deliveryKind, adapter] of activeJobs) {
    const isTarget = itemId === targetItemId;
    const defaultPath = deliveryKind === "execution_package"
      ? `pipeline/publish-assets/${itemId}.md`
      : platform === "wechat"
        ? "pipeline/publish-assets/wechat.html"
        : `pipeline/publish-assets/${itemId}.md`;
    const override = isTarget ? (options.job || {}) : {};
    const payload = {
      title: `${platform} title`,
      ...(nativeXhs && platform === 'xiaohongshu' ? { title: '八页图文', metadata: { tags: '#本地验收' } } : {}),
      ...(platform === "wechat" ? { html_path: defaultPath } : { copy_path: defaultPath }),
      ...(deliveryKind === "execution_package" ? { execution_package_path: defaultPath } : {}),
      ...(override.payload || {}),
      asset_paths: [],
    };
    const assets = targets && !options.assets ? (platform === 'wechat'
      ? [{ path: 'pipeline/visual/demo/publish/r001/wechat-cover.png', body: 'local cover fixture', role: 'wechat_cover' }]
      : platform === 'xiaohongshu' ? Array.from({ length: 8 }, (_, i) => ({ id: `xhs-card-${i + 1}`, role: `xhs-card-${i + 1}`, path: `pipeline/visual/demo/publish/r001/xhs-${i + 1}.png`, body: `local P${i + 1} fixture` })) : [])
      : isTarget ? (options.assets || []) : [];
    const selectedAssets = [];
    for (const [index, asset] of assets.entries()) {
      const bytes = Buffer.isBuffer(asset.body) ? asset.body : Buffer.from(asset.body || `asset-${index}`, "utf8");
      await writeProjectFile(root, asset.path, bytes);
      selectedAssets.push({
        ...(asset.id ? { id: asset.id } : {}),
        path: asset.path,
        sha256: sha256(bytes),
        ...(asset.role ? { role: asset.role } : {}),
      });
      selectedForManifest.push({
        assetId: asset.id || (asset.role === "wechat_cover" ? "wechat-cover" : asset.role || `asset-${index + 1}`),
        semanticRole: asset.role || asset.id || `asset-${index + 1}`,
        revisionId: "r001",
        path: asset.path,
        sha256: sha256(bytes),
        platformBindings: [platform],
      });
    }
    selectedAssets.sort((left, right) => left.path.localeCompare(right.path));
    payload.asset_paths = selectedAssets.map((asset) => asset.path);
    const contentPath = platform === "wechat"
      ? (payload.html_path || payload.copy_path)
      : deliveryKind === "execution_package"
        ? (payload.execution_package_path || payload.copy_path)
        : payload.copy_path;
    const content = Buffer.isBuffer(isTarget && options.content)
      ? options.content
      : Buffer.from(isTarget && options.content !== undefined ? options.content : nativeXhs && platform === 'xiaohongshu' ? nativeCopy : `body:${itemId}`, "utf8");
    await writeProjectFile(root, contentPath, content);
    const contentHash = sha256(content);
    const payloadHash = sha256(stableStringify({
      platform,
      item_id: itemId,
      delivery_kind: deliveryKind,
      payload,
      content_hash: contentHash,
      selected_asset_hashes: selectedAssets,
    }));
    const jobId = `draft_${sha256(`${RUN_ID}:${platform}:${itemId}:${payloadHash}`).slice(0, 20)}`;
    const job = {
      job_id: jobId,
      platform,
      item_id: itemId,
      item_label: itemId,
      delivery_kind: deliveryKind,
      adapter: override.adapter || adapter,
      ...(platform === "wechat" ? { fallback_adapter: "authorized_browser" } : {}),
      payload,
      payload_hash: payloadHash,
      content_hash: contentHash,
      selected_asset_hashes: selectedAssets,
      status: override.status || "pending",
      authorization_state: "not_checked",
      attempt_count: 0,
      retry_count: 0,
      events: [{ at: "2026-08-24T00:00:00.000Z", status: "pending", adapter }],
    };
    jobs.push(job);
    if (isTarget) selectedJob = job;
  }
  if (!selectedJob) throw new Error("fixture target is not in the fixed queue");
  const packageHash = sha256(packageBody);
  if (selectedForManifest.length === 0) {
    const defaultAssetPath = "pipeline/visual/demo/publish/r001/wechat-cover.png";
    const defaultAssetBody = Buffer.from("default approved cover", "utf8");
    await writeProjectFile(root, defaultAssetPath, defaultAssetBody);
    selectedForManifest.push({
      assetId: "wechat-cover",
      semanticRole: "wechat_cover",
      revisionId: "r001",
      path: defaultAssetPath,
      sha256: sha256(defaultAssetBody),
      platformBindings: ["wechat"],
    });
  }
  const selections = Object.fromEntries(selectedForManifest.map((asset) => [asset.semanticRole, asset]));
  const visualManifest = {
    schema: "aifios.visual-asset-manifest.v1",
    slug: "demo",
    sourceContentHash: packageHash,
    requiredRoles: Object.keys(selections),
    selections,
  };
  const visualBody = Buffer.from(`${JSON.stringify(visualManifest, null, 2)}\n`, "utf8");
  await writeProjectFile(root, visualManifestPath, visualBody);
  await writeProjectFile(root, "pipeline/visual/demo/recipes/r001.visual-recipe.json", `${JSON.stringify({
    slug: "demo",
    revision_id: "r001",
    source_package: packagePath,
    assets: selectedForManifest.map((asset) => ({ id: asset.assetId })),
  }, null, 2)}\n`);
  await writeProjectFile(root, "pipeline/visual/demo/revisions/r001.index.json", `${JSON.stringify({
    schema: "aifios.visual-publish.v1",
    slug: "demo",
    revision_id: "r001",
    outputs: selectedForManifest.map((asset) => ({
      id: asset.assetId,
      output: asset.path,
      sha256: asset.sha256,
      revision_id: asset.revisionId,
      status: "generated",
    })),
  }, null, 2)}\n`);
  const queue = {
    schema: "aifios.publication-draft-queue.v1",
    queue_id: `queue_${sha256(`${RUN_ID}:${packagePath}:${packageHash}`).slice(0, 20)}`,
    run_id: RUN_ID,
    run_slug: "demo",
    package_path: packagePath,
    package_sha256: packageHash,
    visual_manifest_path: visualManifestPath,
    visual_manifest_sha256: sha256(visualBody),
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    jobs,
    ...(targets ? { target_platforms: targets.map((platform) => platform === 'xhs' ? 'xiaohongshu' : platform) } : {}),
  };
  if (targets?.length === 1 && targets[0] === 'shipinhao') {
    delete queue.visual_manifest_path;
    delete queue.visual_manifest_sha256;
  }
  await writeProjectFile(root, QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`);

  const snapshotDir = `runs/${RUN_ID}/market-research/snapshot-001`;
  const normalizedPath = `${snapshotDir}/normalized.json`;
  const normalizedBody = Buffer.from('{"samples":3}\n', "utf8");
  await writeProjectFile(root, normalizedPath, normalizedBody);
  const rawEntries = [];
  const researchPlatforms = targets ? ['wechat', 'xhs', 'shipinhao'].filter((platform) => targets.includes(platform)).map((platform) => ({ wechat: 'wechat_mp', xhs: 'xiaohongshu', shipinhao: 'wechat_channels' })[platform]) : ["wechat_mp", "xiaohongshu", "wechat_channels"];
  for (const platform of researchPlatforms) {
    const rawPath = `${snapshotDir}/raw/${platform}.json`;
    const rawBody = Buffer.from(`${JSON.stringify({ platform, results: [{ url: `https://example.test/${platform}` }] })}\n`, "utf8");
    await writeProjectFile(root, rawPath, rawBody);
    rawEntries.push({ platform, path: rawPath, sha256: sha256(rawBody) });
  }
  const snapshotPath = `${snapshotDir}/snapshot.json`;
  const snapshotWithoutDigest = {
    schema_version: 3,
    kind: "aifios.tikomni.topic-research-snapshot",
    run_id: RUN_ID,
    source_path: materialPath,
    source_sha256: sha256(materialBody),
    required_platforms: researchPlatforms,
    douyin_research_proxy: "wechat_channels",
    no_fallback: true,
    used_cache: false,
    used_local_samples: false,
    creator_mode: false,
    platform_checks: {
      wechat_mp: { status: "available", sample_count: 1 },
      xiaohongshu: { status: "available", sample_count: 1 },
      wechat_channels: { status: "available", sample_count: 1 },
    },
    sufficiency: { sufficient: true },
    raw_entries: rawEntries,
    normalized_path: normalizedPath,
    normalized_sha256: sha256(normalizedBody),
  };
  const snapshotHash = sha256(canonicalJsonStringify(snapshotWithoutDigest));
  await writeProjectFile(root, snapshotPath, `${JSON.stringify({ ...snapshotWithoutDigest, sha256: snapshotHash }, null, 2)}\n`);
  const frozenAt = "2026-08-24T00:01:00.000+08:00";
  const frozenWithoutDigest = {
    schema_version: 3,
    kind: "aifios.tikomni.frozen-topic-research",
    run_id: RUN_ID,
    manifest_path: snapshotPath,
    snapshot_sha256: snapshotHash,
    frozen_at: frozenAt,
  };
  const frozenHash = sha256(canonicalJsonStringify(frozenWithoutDigest));
  await writeProjectFile(root, `runs/${RUN_ID}/market-research/frozen-snapshot.json`, `${JSON.stringify({
    ...frozenWithoutDigest,
    sha256: frozenHash,
  }, null, 2)}\n`);
  const approvedAt = "2026-08-24T00:02:00.000+08:00";
  const run = {
    run_id: RUN_ID,
    slug: "demo",
    status: "active",
    target_platforms: targets || ["wechat", "xhs", "shipinhao", "douyin", "moments"],
    ...(targets ? { selected_platforms: [...targets] } : {}),
    visual_template: "publish_template",
    current_step: "package",
    steps: {
      intake: { latest: materialPath },
      blueprint: { latest: blueprintPath },
      package: { latest: packagePath },
    },
    phase_artifacts: {
      visual_assets: { path: visualManifestPath, sha256: sha256(visualBody), version: 1 },
      draft_information: { path: QUEUE_PATH, sha256: draftQueueContractSha256(queue), version: 1 },
    },
    approvals: {
      topic_template: {
        scope: "topic_template",
        run_id: RUN_ID,
        run_slug: "demo",
        path: blueprintPath,
        sha256: sha256(blueprintBody),
        version: 1,
        approved_at: approvedAt,
        method: "human_review",
        market_snapshot_path: snapshotPath,
        market_snapshot_sha256: snapshotHash,
        market_snapshot_frozen_at: frozenAt,
        market_snapshot_freeze_sha256: frozenHash,
        visual_template: "publish_template",
      },
      content_package: {
        scope: "content_package", run_id: RUN_ID, run_slug: "demo", path: packagePath,
        sha256: packageHash, version: 1, approved_at: approvedAt, method: "human_review",
      },
      visual_assets: {
        scope: "visual_assets", run_id: RUN_ID, run_slug: "demo", path: visualManifestPath,
        sha256: sha256(visualBody), version: 1, approved_at: approvedAt, method: "human_review",
      },
      draft_information: {
        scope: "draft_information", run_id: RUN_ID, run_slug: "demo", path: QUEUE_PATH,
        sha256: draftQueueContractSha256(queue), version: 1, approved_at: approvedAt, method: "human_review",
      },
    },
    history: [
      { event: "created" },
      { step: "intake", path: materialPath },
      { step: "blueprint", path: blueprintPath },
      { step: "package", path: packagePath },
    ],
  };
  const runPath = `runs/${RUN_ID}.json`;
  if (targets?.length === 1 && targets[0] === 'shipinhao') {
    delete run.phase_artifacts.visual_assets;
    delete run.approvals.visual_assets;
    await rm(join(root, 'pipeline/visual'), { recursive: true, force: true });
  }
  if (options.researchMode === 'author_material') {
    run.research_mode = 'author_material';
    run.topic = '客户临时改需求：先写清变化';
    const context = { schema: 'aifios.material-analysis.v1', runId: RUN_ID, inputFingerprint: 'a'.repeat(64), analysisInputFingerprint: 'a'.repeat(64), analysisStatus: 'current', input: { rawMaterial: '先记录具体改动，再确认影响。只解释方法，不编造客户故事。', files: [], links: [] }, analysis: { summary: '作者处理需求变化的方法', risks: options.risks || [], facts: [], cases: [], opinions: ['先写清变化'], authorRequirements: ['不增加营销引导'] }, selection: null };
    await writeProjectFile(root, `sessions/material-analysis/${RUN_ID}.json`, JSON.stringify(context));
    const generated = spawnSync('python3', ['-c', [
      'import json,sys,hashlib',
      'from pathlib import Path',
      'sys.path.insert(0,sys.argv[1])',
      'import author_evidence as a',
      'run=json.load(sys.stdin); project=Path(sys.argv[2]).resolve()',
      'record={"schema":a.SCHEMA,"id":"author_"+"b"*32,"topic":run["topic"],**a.source_context(project,run)}',
      'raw=json.dumps(record,ensure_ascii=False,sort_keys=True,indent=2)+"\\n"',
      'path="runs/"+run["run_id"]+"/author-evidence/"+record["id"]+".json"',
      'pointer={"id":record["id"],"path":path,"sha256":hashlib.sha256(raw.encode()).hexdigest()}',
      'print(json.dumps({"raw":raw,"pointer":pointer,"binding":a.binding_lines({"author_evidence_path":path,"author_evidence_sha256":pointer["sha256"]})},ensure_ascii=False))',
    ].join('\n'), join(__dirname, '../../../skills/content-runtime/scripts'), root], { input: JSON.stringify(run), encoding: 'utf8', timeout: 10000 });
    assert.equal(generated.status, 0, generated.stderr);
    const author = JSON.parse(generated.stdout);
    await writeProjectFile(root, author.pointer.path, author.raw);
    run.author_evidence = author.pointer;
    const authorBlueprint = `# 本期写作方案\n${author.binding}\n`;
    await writeProjectFile(root, blueprintPath, authorBlueprint);
    run.approvals.topic_template = { ...run.approvals.topic_template, sha256: sha256(authorBlueprint), research_mode: 'author_material', author_evidence_path: author.pointer.path, author_evidence_sha256: author.pointer.sha256, author_evidence_frozen_at: approvedAt };
    for (const key of ['market_snapshot_path', 'market_snapshot_sha256', 'market_snapshot_frozen_at', 'market_snapshot_freeze_sha256']) delete run.approvals.topic_template[key];
    await rm(join(root, `runs/${RUN_ID}/market-research`), { recursive: true, force: true });
  } else if (targets) {
    // Use the production Python serializer and freeze verifier. Handwritten
    // fixtures must not invent fields which the actual producer never writes.
    await rm(join(root, `runs/${RUN_ID}/market-research`), { recursive: true, force: true });
    const required = options.researchPlatforms || researchPlatforms;
    const unavailable = options.unavailableResearchPlatforms || [];
    const ready = required.filter((platform) => !unavailable.includes(platform));
    const result = { status: 'ready', required_platforms: required, ready_platforms: ready,
      platform_checks: Object.fromEntries(required.map((platform) => [platform, { status: ready.includes(platform) ? 'available' : 'unavailable', sample_count: ready.includes(platform) ? 1 : 0 }])),
      sufficiency: { sufficient: ready.length === required.length },
      raw_payloads: ready.map((platform) => ({ platform, query: 'local fixture', payload: { items: [{ title: '本地测试参考，非真实采集', url: `https://example.test/${platform}` }] } })),
    };
    const generated = spawnSync('python3', ['-c', [
      'import json,sys',
      'from pathlib import Path',
      'sys.path.insert(0,sys.argv[1])',
      'from market_signal import persist_market_snapshot,freeze_market_snapshot',
      'data=json.load(sys.stdin); project=Path(sys.argv[2]).resolve()',
      'data["result"]["query_context"]={"score":1.0,"small":1e-8,"large":1000000000000000001,"zero":-0.0,"text":"中文，数值1.0不是字段值","nested":{"sha256":"nested-digest","𐀀":[],"\\ue000":True}}',
      'stored=persist_market_snapshot(project=project,run_id=data["runId"],topic="本地验收",source_path=data["materialPath"],result=data["result"])',
      'frozen=freeze_market_snapshot(project,data["runId"],stored["manifest_path"])',
      'print(json.dumps({"stored":stored,"frozen":frozen}))',
    ].join('\n'), join(__dirname, '../../../skills/content-runtime/scripts'), root], { input: JSON.stringify({ runId: RUN_ID, materialPath, result }), encoding: 'utf8', timeout: 10000 });
    assert.equal(generated.status, 0, generated.stderr);
    const research = JSON.parse(generated.stdout);
    Object.assign(run.approvals.topic_template, { market_snapshot_path: research.stored.manifest_path,
      market_snapshot_sha256: research.stored.snapshot_sha256, market_snapshot_frozen_at: research.frozen.frozen_at,
      market_snapshot_freeze_sha256: research.frozen.sha256 });
  }
  await writeProjectFile(root, runPath, `${JSON.stringify(run, null, 2)}\n`);
  return {
    queue,
    run,
    runPath,
    job: selectedJob,
    request: {
      queuePath: QUEUE_PATH,
      runId: RUN_ID,
      jobId: selectedJob.job_id,
      expectedPayloadHash: selectedJob.payload_hash,
    },
  };
}


module.exports = { QUEUE_PATH, RUN_ID, createQueueFixture, writeProjectFile, writePythonHashedRecord };
