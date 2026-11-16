const assert = require("node:assert/strict");
const { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const test = require("node:test");
const {
  draftQueueContractSha256,
  rebuildAuthoritativePublicationRequest,
  sha256,
  stableStringify,
} = require("./publication-authority.cjs");
const {
  createPublicationBridge,
  parsePublicationCredentialConfig,
} = require("./publication-bridge.cjs");
const { createPublicationTransactionManager, journalPathForIdentity } = require("./publication-transaction.cjs");

const { QUEUE_PATH, RUN_ID, createQueueFixture, writeProjectFile, writePythonHashedRecord } = require("./fixtures/publication-fixture.cjs");

async function changeJson(root, path, update) {
  const value = JSON.parse(await readFile(join(root, path), 'utf8'));
  update(value);
  await writeProjectFile(root, path, JSON.stringify(value));
}

async function resealResearchFixture(root, fixture, mutate = () => {}) {
  const approval = fixture.run.approvals.topic_template;
  const snapshot = JSON.parse(await readFile(join(root, approval.market_snapshot_path), 'utf8'));
  mutate(snapshot);
  const signed = await writePythonHashedRecord(root, approval.market_snapshot_path, snapshot);
  const frozenPath = `runs/${RUN_ID}/market-research/frozen-snapshot.json`;
  const frozen = JSON.parse(await readFile(join(root, frozenPath), 'utf8'));
  frozen.snapshot_sha256 = signed.sha256;
  const signedFrozen = await writePythonHashedRecord(root, frozenPath, frozen);
  approval.market_snapshot_sha256 = signed.sha256;
  approval.market_snapshot_freeze_sha256 = signedFrozen.sha256;
  await writeProjectFile(root, fixture.runPath, JSON.stringify(fixture.run));
}

for (const researchMode of ['platform', 'author_material']) {
  for (const platforms of [['wechat'], ['xhs'], ['shipinhao'], ['wechat', 'xhs'], ['wechat', 'shipinhao'], ['xhs', 'shipinhao'], ['wechat', 'xhs', 'shipinhao']]) {
    test(`selected publication contract: ${researchMode} / ${platforms.join('+')}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'echo-selected-publication-'));
      try {
        const fixture = await createQueueFixture(root, { platforms, researchMode });
        const authority = await rebuildAuthoritativePublicationRequest({ projectDir: root, request: fixture.request });
        assert.equal(authority.rawJob.job_id, fixture.job.job_id);
        assert.equal(fixture.queue.jobs.length, platforms.length);
        if (researchMode === 'author_material') await assert.rejects(lstat(join(root, `runs/${RUN_ID}/market-research`)), { code: 'ENOENT' });
        if (platforms.length === 1 && platforms[0] === 'shipinhao') await assert.rejects(lstat(join(root, 'pipeline/visual')), { code: 'ENOENT' });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}

for (const [label, code, mutate] of [
  ['changed raw material under the same fingerprint', 'author_lineage_invalid', async (root) => changeJson(root, `sessions/material-analysis/${RUN_ID}.json`, (value) => { value.input.rawMaterial = '另一份材料'; })],
  ['changed analysis', 'author_lineage_invalid', async (root) => changeJson(root, `sessions/material-analysis/${RUN_ID}.json`, (value) => { value.analysis.summary = '新的作者要求'; })],
  ['new internal-only restriction', 'material_internal_only', async (root) => changeJson(root, `sessions/material-analysis/${RUN_ID}.json`, (value) => { value.analysis.risks = ['不对外发布']; })],
  ['changed topic', 'author_lineage_invalid', async (root, fixture) => changeJson(root, fixture.runPath, (value) => { value.topic = '另一题目'; })],
  ['changed template', 'author_lineage_invalid', async (root, fixture) => changeJson(root, fixture.runPath, (value) => { value.visual_template = 'different'; })],
  ['missing author freeze', 'author_lineage_invalid', async (root, fixture) => changeJson(root, fixture.runPath, (value) => { delete value.approvals.topic_template.author_evidence_frozen_at; })],
  ['missing author record', 'author_lineage_invalid', async (root, fixture) => rm(join(root, fixture.run.author_evidence.path))],
  ['changed author record bytes', 'author_lineage_invalid', async (root, fixture) => changeJson(root, fixture.run.author_evidence.path, (value) => { value.topic = '另一题目'; })],
  ['cross-run author record path', 'author_lineage_invalid', async (root, fixture) => changeJson(root, fixture.runPath, (value) => { value.author_evidence.path = value.author_evidence.path.replace(RUN_ID, 'other-run'); })],
  ['implicit switch to platform research', 'topic_lineage_invalid', async (root, fixture) => changeJson(root, fixture.runPath, (value) => { value.research_mode = 'platform'; })],
  ['unknown source mode', 'run_contract_mismatch', async (root, fixture) => changeJson(root, fixture.runPath, (value) => { value.research_mode = 'fallback'; })],
  ['changed selected platform', 'run_contract_mismatch', async (root, fixture) => changeJson(root, fixture.runPath, (value) => { value.selected_platforms = ['xhs']; })],
  ['empty platform selection', 'run_contract_mismatch', async (root, fixture) => changeJson(root, fixture.runPath, (value) => { value.selected_platforms = []; })],
  ['extra queue platform', 'queue_contract_mismatch', async (root) => changeJson(root, QUEUE_PATH, (value) => { value.target_platforms.push('xiaohongshu'); })],
  ['legacy downgrade', 'queue_contract_mismatch', async (root) => changeJson(root, QUEUE_PATH, (value) => { delete value.target_platforms; })],
  ['duplicate queue platform', 'queue_contract_mismatch', async (root) => changeJson(root, QUEUE_PATH, (value) => { value.target_platforms.push('wechat'); })],
  ['missing blueprint source binding despite new human hash', 'author_lineage_invalid', async (root, fixture) => {
    const body = '# 人工确认过，但没有作者素材版本\n';
    await writeProjectFile(root, 'pipeline/blueprint/demo.md', body);
    await changeJson(root, fixture.runPath, (value) => { value.approvals.topic_template.sha256 = sha256(body); });
  }],
]) {
  test(`selected author queue rejects ${label} before external calls`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'echo-author-reject-'));
    try {
      const fixture = await createQueueFixture(root, { platforms: ['wechat'], researchMode: 'author_material' });
      await mutate(root, fixture);
      let calls = 0;
      const bridge = createPublicationBridge({ projectDir: () => root, getCredential: () => { calls += 1; return ''; }, fetchFn: async () => { calls += 1; return new Response('{}'); } });
      await assert.rejects(bridge.fill(fixture.request), (error) => error.code === code);
      assert.equal(calls, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const [label, mutate] of [
  ['a different selected platform', (value) => { value.required_platforms = ['xiaohongshu']; }],
  ['a selected lane absent from ready platforms', (value) => { value.ready_platforms = []; }],
  ['duplicate declared platforms', (value) => { value.required_platforms.push('wechat_mp'); }],
  ['unavailable research', (value) => { value.platform_checks.wechat_mp.status = 'unavailable'; }],
  ['unknown sample count', (value) => { delete value.platform_checks.wechat_mp.sample_count; }],
  ['cached research', (value) => { value.used_cache = true; }],
  ['missing selected raw evidence', (value) => { value.raw_entries = []; }],
]) {
  test(`selected research rejects ${label} even with internally consistent digests`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'echo-research-reject-'));
    try {
      const fixture = await createQueueFixture(root, { platforms: ['wechat'] });
      // The same reserialization must pass before mutating the semantic field.
      // Otherwise Unicode ordering or numeric conversion could mask a gap.
      await resealResearchFixture(root, fixture);
      await rebuildAuthoritativePublicationRequest({ projectDir: root, request: fixture.request });
      await resealResearchFixture(root, fixture, mutate);
      let calls = 0;
      const bridge = createPublicationBridge({ projectDir: () => root, getCredential: () => { calls += 1; return ''; }, fetchFn: async () => { calls += 1; return new Response('{}'); } });
      await assert.rejects(bridge.fill(fixture.request), (error) => error.code === 'topic_lineage_invalid');
      assert.equal(calls, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const [label, before, after] of [
  ['floating-point metadata', '"score":1.0', '"score":2.0'],
  ['large integer beyond JavaScript precision', '1000000000000000001', '1000000000000000002'],
  ['nested digest', 'nested-digest', 'modified-digest'],
  ['Chinese text', '中文，数值1.0不是字段值', '改变的中文内容'],
]) {
  test(`research snapshot rejects changed ${label} with unchanged declared digests`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'echo-research-bytes-'));
    try {
      const fixture = await createQueueFixture(root, { platforms: ['wechat'] });
      const path = fixture.run.approvals.topic_template.market_snapshot_path;
      const raw = await readFile(join(root, path), 'utf8');
      assert.ok(raw.includes(before), `fixture must contain ${label}`);
      await writeProjectFile(root, path, raw.replace(before, after));
      let calls = 0;
      const bridge = createPublicationBridge({ projectDir: () => root, getCredential: () => { calls += 1; return ''; }, fetchFn: async () => { calls += 1; return new Response('{}'); } });
      await assert.rejects(bridge.fill(fixture.request), (error) => error.code === 'topic_lineage_invalid');
      assert.equal(calls, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('a removed failing research lane does not block the remaining selected platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-partial-research-'));
  try {
    const fixture = await createQueueFixture(root, { platforms: ['wechat'], researchPlatforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'], unavailableResearchPlatforms: ['xiaohongshu', 'wechat_channels'] });
    const result = await rebuildAuthoritativePublicationRequest({ projectDir: root, request: fixture.request });
    assert.equal(result.rawJob.platform, 'wechat');
    const snapshot = JSON.parse(await readFile(join(root, fixture.run.approvals.topic_template.market_snapshot_path), 'utf8'));
    assert.equal(snapshot.sufficiency.sufficient, false);
    assert.equal(snapshot.douyin_research_proxy, undefined);
    assert.deepEqual(snapshot.ready_platforms, ['wechat_mp']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const researchMode of ['platform', 'author_material']) {
  test(`single WeChat ${researchMode} fills one draft through a local fake API`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'echo-wechat-one-'));
    try {
      const fixture = await createQueueFixture(root, { platforms: ['wechat'], researchMode, content: '<p>本地测试正文</p>' });
      const calls = [];
      const bridge = createPublicationBridge({ projectDir: () => root,
        getCredential: (id) => id === 'wechat_official_api' ? JSON.stringify({ appId: 'wx-local-fixture', appSecret: 'local-fixture' }) : '',
        fetchFn: async (url, init) => {
          calls.push({ url: String(url), body: init?.body });
          if (String(url).includes('/cgi-bin/token')) return new Response(JSON.stringify({ access_token: 'fixture-only' }));
          if (String(url).includes('/media/uploadimg')) return new Response(JSON.stringify({ url: 'https://example.test/local-fixture.png' }));
          return new Response(JSON.stringify({ media_id: String(url).includes('/draft/add') ? 'one-draft' : 'cover' }));
        },
      });
      const result = await bridge.fill(fixture.request);
      assert.equal(result.result.status, 'draft_filled', JSON.stringify(result.result));
      const writes = calls.filter((call) => call.url.includes('/draft/add'));
      assert.equal(writes.length, 1);
      assert.equal(JSON.parse(writes[0].body).articles[0].content, '<p>本地测试正文</p>');
      assert.equal(calls.some((call) => /mass\/send|freepublish\/submit/.test(call.url)), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('single video execution remains local and rejects added visual binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-video-local-'));
  try {
    const fixture = await createQueueFixture(root, { platforms: ['shipinhao'], researchMode: 'author_material' });
    let calls = 0;
    const bridge = createPublicationBridge({ projectDir: () => root, getCredential: () => { calls += 1; return ''; }, fetchFn: async () => { calls += 1; return new Response('{}'); } });
    const result = await bridge.fill(fixture.request);
    assert.equal(result.result.status, 'draft_filled');
    assert.equal(result.adapter, 'download');
    assert.equal(calls, 0);
    await changeJson(root, QUEUE_PATH, (value) => { value.visual_manifest_path = 'pipeline/visual/demo/selected-assets.json'; });
    await assert.rejects(rebuildAuthoritativePublicationRequest({ projectDir: root, request: fixture.request }), (error) => error.code === 'visual_lineage_invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("internal-only material cannot be sent by a previously approved desktop queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-publication-internal-"));
  try {
    const fixture = await createQueueFixture(root, {
      material: '## 7. 不可公开信息\n- 公开边界：【模拟验收，不对外发布】\n\n## 9. 素材质量判断\n',
      content: '<p>Internal draft</p>',
      assets: [{ path: 'pipeline/visual/demo/publish/r001/wechat-cover.png', body: 'cover', role: 'wechat_cover' }],
    });
    let calls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: () => { calls += 1; return ''; },
      fetchFn: async () => { calls += 1; return new Response('{}'); },
    });
    const before = await readFile(join(root, QUEUE_PATH), 'utf8');
    await assert.rejects(bridge.fill(fixture.request), (error) => error.code === 'material_internal_only');
    assert.equal(calls, 0);
    assert.equal(await readFile(join(root, QUEUE_PATH), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a corrected disclosure requires fresh approvals before a desktop draft can be transmitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-publication-corrected-"));
  try {
    const fixture = await createQueueFixture(root, { assets: [{ path: 'pipeline/visual/demo/publish/r001/wechat-cover.png', body: 'cover', role: 'wechat_cover' }] });
    const fingerprint = 'a'.repeat(64);
    await writeProjectFile(root, `sessions/material-analysis/${RUN_ID}.json`, JSON.stringify({ schema: 'aifios.material-analysis.v1', runId: RUN_ID, analysisStatus: 'current', inputFingerprint: fingerprint, analysisInputFingerprint: fingerprint, analysis: { risks: ['不对外发布'] } }));
    const id = `correction_${'c'.repeat(32)}`;
    const path = `runs/${RUN_ID}/material-corrections/${id}.json`;
    const raw = JSON.stringify({ schema: 'echo.material-correction.v1', run_id: RUN_ID, id, input_fingerprint: fingerprint, analysis: { risks: ['不公开客户姓名'] } });
    await writeProjectFile(root, path, raw);
    fixture.run.material_correction = { id, path, sha256: sha256(raw) };
    await writeProjectFile(root, fixture.runPath, JSON.stringify(fixture.run));
    let calls = 0;
    const bridge = createPublicationBridge({ projectDir: () => root, getCredential: () => { calls += 1; return ''; } });
    await assert.rejects(bridge.fill(fixture.request), (error) => error.code === 'approval_invalid');
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publication credential configuration is constrained to local supported bridges", () => {
  assert.deepEqual(
    parsePublicationCredentialConfig("xiaohongshu_browser_bridge", JSON.stringify({
      editorUrl: "https://creator.xiaohongshu.com/publish/publish",
    })),
    { editorUrl: "https://creator.xiaohongshu.com/publish/publish" },
  );
  assert.throws(
    () => parsePublicationCredentialConfig("moments_mobile_bridge", JSON.stringify({
      endpoint: "http://example.com/prefill",
      pairingToken: "pairing-token",
    })),
    /HTTPS or a local-network HTTP endpoint/,
  );
});

test("WeChat official API uses the authoritative queue job and never sends a public message", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-bridge-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Hello authoritative draft</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), role: "wechat_cover" }],
    });
    const calls = [];
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api" ? JSON.stringify({ appId: "wx-test", appSecret: "secret-value" }) : "",
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/cgi-bin/token")) return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 });
        if (String(url).includes("/material/add_material")) return new Response(JSON.stringify({ media_id: "cover-media" }), { status: 200 });
        if (String(url).includes("/media/uploadimg")) return new Response(JSON.stringify({ url: "https://mmbiz.example/inline.png" }), { status: 200 });
        if (String(url).includes("/draft/add")) return new Response(JSON.stringify({ media_id: "draft-media" }), { status: 200 });
        return new Response(JSON.stringify({ errcode: 1 }), { status: 500 });
      },
    });
    const result = await bridge.fill(fixture.request);
    assert.equal(result.job.jobId, fixture.job.job_id);
    assert.equal(result.job.payload.title, fixture.job.payload.title);
    assert.equal(result.adapter, "wechat_official_api");
    assert.equal(result.result.status, "draft_filled");
    assert.equal(result.result.externalReference, "wechat-draft:draft-media");
    assert.equal(calls.some((call) => call.url.includes("/draft/add")), true);
    assert.equal(calls.some((call) => /mass\/send|freepublish\/submit|message\/mass\/send/.test(call.url)), false);
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crash after draft/add is recovered as unknown without repeating any external call", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-crash-recovery-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Crash boundary</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: "approved-cover", role: "wechat_cover" }],
    });
    let calls = 0;
    const fetchFn = async (url) => {
      calls += 1;
      if (String(url).includes("/cgi-bin/token")) return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 });
      if (String(url).includes("/material/add_material")) return new Response(JSON.stringify({ media_id: "cover-media" }), { status: 200 });
      if (String(url).includes("/media/uploadimg")) return new Response(JSON.stringify({ url: "https://mmbiz.example/inline.png" }), { status: 200 });
      if (String(url).includes("/draft/add")) return new Response(JSON.stringify({ media_id: "draft-media" }), { status: 200 });
      return new Response("{}", { status: 500 });
    };
    const durable = createPublicationTransactionManager({ projectDir: () => root });
    const crashingManager = {
      beginAttempt: durable.beginAttempt,
      completeAttempt: async () => {
        throw new Error("simulated process exit after platform success");
      },
    };
    const firstBridge = createPublicationBridge({
      projectDir: () => root,
      publicationTransactionManager: crashingManager,
      getCredential: (id) => id === "wechat_official_api" ? JSON.stringify({ appId: "wx-test", appSecret: "secret" }) : "",
      fetchFn,
    });
    await assert.rejects(firstBridge.fill(fixture.request), /simulated process exit/);
    const callsAfterCrash = calls;
    assert.equal(callsAfterCrash > 0, true);

    const restartedBridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api" ? JSON.stringify({ appId: "wx-test", appSecret: "secret" }) : "",
      fetchFn,
    });
    const recovered = await restartedBridge.fill(fixture.request);
    assert.equal(recovered.result.status, "unknown_completion");
    assert.equal(recovered.result.code, "publication_attempt_interrupted");
    assert.equal(recovered.result.authorizationState, "requires_human_action");
    assert.equal(calls, callsAfterCrash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forged renderer jobs and missing queues fail before external API calls and produce no bridge result", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-authority-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Approved</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: "cover", role: "wechat_cover" }],
    });
    let calls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api" ? JSON.stringify({ appId: "wx-test", appSecret: "secret" }) : "",
      fetchFn: async () => { calls += 1; return new Response("{}", { status: 500 }); },
    });
    await assert.rejects(
      bridge.fill({ ...fixture.request, job: { ...fixture.job, payload: { title: "forged" } } }),
      /unsupported field/,
    );
    await assert.rejects(
      bridge.fill({ ...fixture.request, queuePath: "materials/publication/drafts/missing/draft-queue.json" }),
      (error) => error?.code === "queue_missing",
    );
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real queue without its canonical run record fails before every external side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-run-missing-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Approved</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: "cover", role: "wechat_cover" }],
    });
    // A renderer-controlled or legacy decoy path must not substitute for the
    // runtime's canonical runs/<run_id>.json authority record.
    await writeProjectFile(root, `sessions/runs/${RUN_ID}.json`, `${JSON.stringify(fixture.run, null, 2)}\n`);
    await rm(join(root, ...fixture.runPath.split("/")));
    let calls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api" ? JSON.stringify({ appId: "wx-test", appSecret: "secret" }) : "",
      fetchFn: async () => { calls += 1; return new Response("{}", { status: 500 }); },
    });
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "run_missing");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing, invalidated, or hash-drifted draft approvals fail closed before network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-approval-gate-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Approved</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: "cover", role: "wechat_cover" }],
    });
    let calls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api" ? JSON.stringify({ appId: "wx-test", appSecret: "secret" }) : "",
      fetchFn: async () => { calls += 1; return new Response("{}", { status: 500 }); },
    });

    const missingApproval = structuredClone(fixture.run);
    delete missingApproval.approvals.draft_information;
    await writeProjectFile(root, fixture.runPath, `${JSON.stringify(missingApproval, null, 2)}\n`);
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "approval_missing");

    const invalidatedApproval = structuredClone(fixture.run);
    invalidatedApproval.approvals.draft_information.invalidated_at = "2026-08-24T00:03:00.000+08:00";
    invalidatedApproval.approvals.draft_information.invalidation_reason = "platform_fields_changed";
    await writeProjectFile(root, fixture.runPath, `${JSON.stringify(invalidatedApproval, null, 2)}\n`);
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "approval_invalid");

    const driftedRegistration = structuredClone(fixture.run);
    driftedRegistration.phase_artifacts.draft_information.sha256 = "f".repeat(64);
    await writeProjectFile(root, fixture.runPath, `${JSON.stringify(driftedRegistration, null, 2)}\n`);
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "approval_invalid");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream material and topic hash drift invalidates the publication authority before network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-upstream-drift-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Approved</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: "cover", role: "wechat_cover" }],
    });
    let calls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api" ? JSON.stringify({ appId: "wx-test", appSecret: "secret" }) : "",
      fetchFn: async () => { calls += 1; return new Response("{}", { status: 500 }); },
    });
    await writeProjectFile(root, "pipeline/intake/demo.md", "changed material");
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "topic_lineage_invalid");
    await writeProjectFile(root, "pipeline/intake/demo.md", "authorized source material");
    await writeProjectFile(root, "pipeline/blueprint/demo.md", "changed topic");
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "approval_invalid");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job, run, and expected payload selectors must match the authoritative queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-selector-"));
  try {
    const fixture = await createQueueFixture(root);
    let calls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: () => "",
      fetchFn: async () => { calls += 1; return new Response("{}", { status: 500 }); },
    });
    await assert.rejects(bridge.fill({ ...fixture.request, jobId: `draft_${"0".repeat(20)}` }), (error) => error?.code === "job_missing");
    await assert.rejects(bridge.fill({ ...fixture.request, expectedPayloadHash: "f".repeat(64) }), (error) => error?.code === "payload_hash_mismatch");
    await assert.rejects(bridge.fill({ ...fixture.request, runId: "run-other" }), (error) => error?.code === "queue_contract_mismatch");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed content or selected assets fail closed before network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-tamper-"));
  try {
    const assetPath = "pipeline/visual/demo/publish/r001/wechat-cover.png";
    const fixture = await createQueueFixture(root, {
      content: "<p>Approved</p>",
      assets: [{ path: assetPath, body: "approved-cover", role: "wechat_cover" }],
    });
    let calls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api" ? JSON.stringify({ appId: "wx-test", appSecret: "secret" }) : "",
      fetchFn: async () => { calls += 1; return new Response("{}", { status: 500 }); },
    });
    await writeFile(join(root, fixture.job.payload.html_path), "<p>Changed</p>");
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "content_changed");
    await writeFile(join(root, fixture.job.payload.html_path), "<p>Approved</p>");
    await writeFile(join(root, assetPath), "changed-cover");
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "asset_changed");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queue symlinks and hardlinks are rejected before external access", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-link-"));
  try {
    const fixture = await createQueueFixture(root);
    const queueTarget = join(root, ...QUEUE_PATH.split("/"));
    const realQueue = `${queueTarget}.real`;
    await writeFile(realQueue, await readFile(queueTarget), { mode: 0o600 });
    await rm(queueTarget);
    await symlink(realQueue, queueTarget);
    const bridge = createPublicationBridge({ projectDir: () => root, getCredential: () => "" });
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "queue_missing" || error?.code === "unsafe_project_file");
    await rm(queueTarget);
    await link(realQueue, queueTarget);
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "unsafe_project_file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run-state symlinks and hardlinks are rejected before external access", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-publication-run-link-"));
  try {
    const fixture = await createQueueFixture(root);
    const runTarget = join(root, ...fixture.runPath.split("/"));
    const realRun = `${runTarget}.real`;
    await writeFile(realRun, await readFile(runTarget), { mode: 0o600 });
    await rm(runTarget);
    await symlink(realRun, runTarget);
    const bridge = createPublicationBridge({ projectDir: () => root, getCredential: () => "" });
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "run_missing" || error?.code === "unsafe_project_file");
    await rm(runTarget);
    await link(realRun, runTarget);
    await assert.rejects(bridge.fill(fixture.request), (error) => error?.code === "unsafe_project_file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WeChat API requests abort on timeout and return a retryable result", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-wechat-timeout-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Approved</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: "cover", role: "wechat_cover" }],
    });
    let requestSignal;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api"
        ? JSON.stringify({ appId: "wx-test", appSecret: "secret-value" })
        : "",
      networkTimeoutMs: 10,
      fetchFn: async (_url, init) => {
        requestSignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const result = await bridge.fill(fixture.request);
    assert.equal(requestSignal instanceof AbortSignal, true);
    assert.equal(requestSignal.aborted, true);
    assert.equal(result.adapter, "wechat_official_api");
    assert.equal(result.result.status, "retryable_failure");
    assert.equal(result.result.code, "network_timeout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a server-recorded timeout can be explicitly retried once and succeed as transaction attempt two", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-wechat-transaction-retry-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Approved</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: "cover", role: "wechat_cover" }],
    });
    let mode = "timeout";
    let tokenCalls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api"
        ? JSON.stringify({ appId: "wx-test", appSecret: "secret-value" })
        : "",
      networkTimeoutMs: 10,
      fetchFn: async (url, init) => {
        if (String(url).includes("/cgi-bin/token")) tokenCalls += 1;
        if (mode === "timeout") {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        if (String(url).includes("/cgi-bin/token")) return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 });
        if (String(url).includes("/material/add_material")) return new Response(JSON.stringify({ media_id: "cover-media" }), { status: 200 });
        if (String(url).includes("/draft/add")) return new Response(JSON.stringify({ media_id: "draft-media" }), { status: 200 });
        return new Response(JSON.stringify({ url: "https://mmbiz.example/image.png" }), { status: 200 });
      },
    });
    const first = await bridge.fill(fixture.request);
    assert.equal(first.result.status, "retryable_failure");
    assert.equal(tokenCalls, 1);

    fixture.job.status = "retryable_failure";
    fixture.job.attempt_count += 1;
    await writeProjectFile(root, QUEUE_PATH, `${JSON.stringify(fixture.queue, null, 2)}\n`);
    mode = "success";
    const second = await bridge.fill(fixture.request);
    assert.equal(second.result.status, "draft_filled");
    assert.equal(tokenCalls, 2);
    const transactionIdentity = {
      queuePath: QUEUE_PATH,
      runId: RUN_ID,
      jobId: fixture.job.job_id,
      payloadHash: fixture.job.payload_hash,
      adapter: fixture.job.adapter,
    };
    const journal = JSON.parse(await readFile(join(root, ...journalPathForIdentity(transactionIdentity).split("/")), "utf8"));
    assert.equal(journal.attempts.length, 2);
    assert.deepEqual(journal.attempts.map((attempt) => attempt.status), ["completed", "completed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent retries from one authoritative queue revision perform one external attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-wechat-concurrent-retry-"));
  try {
    const fixture = await createQueueFixture(root, {
      content: "<p>Approved</p>",
      assets: [{ path: "pipeline/visual/demo/publish/r001/wechat-cover.png", body: "cover", role: "wechat_cover" }],
    });
    let mode = "timeout";
    let tokenCalls = 0;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "wechat_official_api"
        ? JSON.stringify({ appId: "wx-test", appSecret: "secret-value" })
        : "",
      networkTimeoutMs: 10,
      fetchFn: async (url, init) => {
        if (String(url).includes("/cgi-bin/token")) tokenCalls += 1;
        if (mode === "timeout") {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        if (String(url).includes("/cgi-bin/token")) return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 });
        if (String(url).includes("/material/add_material")) return new Response(JSON.stringify({ media_id: "cover-media" }), { status: 200 });
        if (String(url).includes("/draft/add")) return new Response(JSON.stringify({ media_id: "draft-media" }), { status: 200 });
        return new Response(JSON.stringify({ url: "https://mmbiz.example/image.png" }), { status: 200 });
      },
    });

    const initial = await bridge.fill(fixture.request);
    assert.equal(initial.result.status, "retryable_failure");
    assert.equal(tokenCalls, 1);
    fixture.job.status = "retryable_failure";
    fixture.job.attempt_count = 1;
    await writeProjectFile(root, QUEUE_PATH, `${JSON.stringify(fixture.queue, null, 2)}\n`);

    const [retry, concurrentDuplicate] = await Promise.all([
      bridge.fill(fixture.request),
      bridge.fill(fixture.request),
    ]);
    assert.equal(retry.result.status, "retryable_failure");
    assert.equal(concurrentDuplicate.result.status, "retryable_failure");
    assert.equal(tokenCalls, 2);

    fixture.job.attempt_count = 2;
    await writeProjectFile(root, QUEUE_PATH, `${JSON.stringify(fixture.queue, null, 2)}\n`);
    mode = "success";
    const afterServerApply = await bridge.fill(fixture.request);
    assert.equal(afterServerApply.result.status, "draft_filled");
    assert.equal(tokenCalls, 3);

    const transactionIdentity = {
      queuePath: QUEUE_PATH,
      runId: RUN_ID,
      jobId: fixture.job.job_id,
      payloadHash: fixture.job.payload_hash,
      adapter: fixture.job.adapter,
    };
    const journal = JSON.parse(await readFile(join(root, ...journalPathForIdentity(transactionIdentity).split("/")), "utf8"));
    assert.equal(journal.attempts.length, 3);
    assert.deepEqual(journal.attempts.map((attempt) => attempt.queue_attempt_count), [0, 1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a server-recorded browser-login intervention can be retried after local configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-browser-transaction-retry-"));
  try {
    const fixture = await createQueueFixture(root, { itemId: "xiaohongshu-opinion-1", content: "XHS copy" });
    let configured = false;
    let opened = 0;
    class BrowserWindowMock {
      constructor() {
        opened += 1;
        this.destroyed = false;
        this.webContents = {
          setWindowOpenHandler: () => undefined,
          on: () => undefined,
          executeJavaScript: async () => ({
            titleFound: true, contentFound: true, fileSelector: "", titleFilled: true, contentFilled: true,
          }),
          debugger: { attach: () => undefined, detach: () => undefined, sendCommand: async () => ({}) },
        };
      }
      isDestroyed() { return this.destroyed; }
      show() {}
      focus() {}
      on() {}
      async loadURL() {}
      close() { this.destroyed = true; }
    }
    const bridge = createPublicationBridge({
      projectDir: () => root,
      BrowserWindow: BrowserWindowMock,
      getCredential: (id) => configured && id === "xiaohongshu_browser_bridge"
        ? JSON.stringify({ editorUrl: "https://creator.xiaohongshu.com/publish/publish" })
        : "",
    });
    const first = await bridge.fill(fixture.request);
    assert.equal(first.result.status, "manual_intervention_required");
    assert.equal(opened, 0);

    fixture.job.status = "manual_intervention_required";
    fixture.job.attempt_count += 1;
    await writeProjectFile(root, QUEUE_PATH, `${JSON.stringify(fixture.queue, null, 2)}\n`);
    configured = true;
    const second = await bridge.fill(fixture.request);
    assert.equal(second.result.status, "unknown_completion");
    assert.equal(second.result.code, "browser_save_confirmation_required");
    assert.equal(opened, 1);
    const transactionIdentity = {
      queuePath: QUEUE_PATH,
      runId: RUN_ID,
      jobId: fixture.job.job_id,
      payloadHash: fixture.job.payload_hash,
      adapter: fixture.job.adapter,
    };
    const journal = JSON.parse(await readFile(join(root, ...journalPathForIdentity(transactionIdentity).split("/")), "utf8"));
    assert.equal(journal.attempts.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Moments mobile bridge requests abort on timeout and return a retryable result", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-moments-timeout-"));
  try {
    const fixture = await createQueueFixture(root, { itemId: "moments-opinion-1", content: "Moments copy" });
    let requestSignal;
    const bridge = createPublicationBridge({
      projectDir: () => root,
      getCredential: (id) => id === "moments_mobile_bridge"
        ? JSON.stringify({ endpoint: "http://127.0.0.1:45678/prefill", pairingToken: "pairing-token" })
        : "",
      networkTimeoutMs: 10,
      fetchFn: async (_url, init) => {
        requestSignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const result = await bridge.fill(fixture.request);
    assert.equal(requestSignal instanceof AbortSignal, true);
    assert.equal(requestSignal.aborted, true);
    assert.equal(result.adapter, "mobile_bridge");
    assert.equal(result.result.status, "retryable_failure");
    assert.equal(result.result.code, "network_timeout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfigured browser connections never pretend a draft was filled", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-unconfigured-browser-"));
  try {
    const fixture = await createQueueFixture(root, { itemId: "xiaohongshu-opinion-1", content: "XHS copy" });
    const bridge = createPublicationBridge({ projectDir: () => root, getCredential: () => "" });
    const result = await bridge.fill(fixture.request);
    assert.equal(result.result.status, "manual_intervention_required");
    assert.equal(result.result.code, "browser_session_required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser DOM injection uses verified bytes and remains unknown until human confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "aifios-browser-draft-"));
  try {
    const assetPath = "pipeline/visual/demo/publish/r001/xhs_card.png";
    const approvedAsset = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let browserObservedAsset = null;
    let snapshotDirectory = "";
    const fixture = await createQueueFixture(root, {
      itemId: "xiaohongshu-opinion-1",
      content: "XHS authoritative copy",
      assets: [{ path: assetPath, body: approvedAsset, role: "xhs_card" }],
    });
    class BrowserWindowMock {
      constructor() {
        this.destroyed = false;
        this.webContents = {
          setWindowOpenHandler: () => undefined,
          on: () => undefined,
          executeJavaScript: async (script) => {
            if (script.includes("titleFilled")) {
              return { titleFound: true, contentFound: true, fileSelector: "input[type='file']", titleFilled: true, contentFilled: true };
            }
            if (script.includes("echoFounderClonePublicationFiles")) return { cloned: true, count: 1 };
            return "input[type='file']";
          },
          debugger: {
            attach: () => undefined,
            detach: () => undefined,
            sendCommand: async (command, payload) => {
              if (command === "DOM.getDocument") return { root: { nodeId: 1 } };
              if (command === "DOM.querySelector") return { nodeId: 2 };
              if (command === "DOM.setFileInputFiles") {
                // Reproduce the reviewer race after authority reconstruction.
                await writeProjectFile(root, assetPath, "renderer-raced-original-path");
                snapshotDirectory = dirname(payload.files[0]);
                browserObservedAsset = await readFile(payload.files[0]);
              }
              return {};
            },
          },
        };
      }
      isDestroyed() { return this.destroyed; }
      show() {}
      focus() {}
      on() {}
      async loadURL() {}
      close() { this.destroyed = true; }
    }
    const bridge = createPublicationBridge({
      projectDir: () => root,
      BrowserWindow: BrowserWindowMock,
      getCredential: (id) => id === "xiaohongshu_browser_bridge"
        ? JSON.stringify({ editorUrl: "https://creator.xiaohongshu.com/publish/publish" })
        : "",
    });
    const result = await bridge.fill(fixture.request);
    assert.equal(result.adapter, "authorized_browser");
    assert.equal(result.result.status, "unknown_completion");
    assert.equal(result.result.authorizationState, "requires_human_action");
    assert.equal(result.result.code, "browser_save_confirmation_required");
    assert.equal(result.result.externalReference, undefined);
    assert.deepEqual(browserObservedAsset, approvedAsset);
    assert.equal((await readFile(join(root, ...assetPath.split("/")))).toString("utf8"), "renderer-raced-original-path");
    await assert.rejects(lstat(snapshotDirectory), (error) => error?.code === "ENOENT");
    bridge.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
