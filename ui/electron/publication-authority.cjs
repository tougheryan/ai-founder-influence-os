const { createHash } = require("node:crypto");
const { nativeXhsCopyMatches, XHS_COPY_MISMATCH } = require('./native-xhs-copy.cjs');
const { constants } = require("node:fs");
const { lstat, open, realpath } = require("node:fs/promises");
const { isAbsolute, relative, resolve, sep } = require("node:path");
const { internalOnlyRestrictions, intakeDisclosureEntries, INTERNAL_ONLY_MESSAGE } = require("./material-disclosure.cjs");

const QUEUE_SCHEMA = "aifios.publication-draft-queue.v1";
const PUBLICATION_AUTHORITY_CONTRACT_SCHEMA = "echo-founder.publication-authority.v1";
const MAX_QUEUE_BYTES = 5 * 1024 * 1024;
const MAX_RUN_BYTES = 5 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_ASSETS = 20;
const REQUEST_KEYS = new Set(["queuePath", "runId", "jobId", "expectedPayloadHash"]);
const PAYLOAD_KEYS = new Set([
  "title",
  "summary",
  "copy_path",
  "html_path",
  "asset_paths",
  "image_order",
  "execution_package_path",
  "metadata",
]);
const ASSET_KEYS = new Set(["id", "path", "sha256", "role"]);
const DRAFT_APPROVAL_TRANSIENT_KEYS = new Set([
  "adapter",
  "authorization_state",
  "attempt_count",
  "retry_count",
  "last_attempt_at",
  "last_error",
  "result_reference",
  "external_reference",
  "events",
  "status",
  "updated_at",
]);
const LEGACY_TARGET_PLATFORMS = ["wechat", "xiaohongshu", "shipinhao", "douyin", "moments"];
const SELECTED_JOB_IDS = new Map([["wechat", "wechat-article"], ["xiaohongshu", "xiaohongshu-opinion-1"], ["shipinhao", "shipinhao-video-execution-1"]]);
const APPROVAL_CONTRACT = Object.freeze({
  topic_template: Object.freeze({ step: "blueprint", roots: ["pipeline/blueprint/"] }),
  content_package: Object.freeze({ step: "package", roots: ["pipeline/package/"] }),
  visual_assets: Object.freeze({ step: null, roots: ["pipeline/visual/"], phaseRequired: true }),
  draft_information: Object.freeze({
    step: null,
    roots: ["materials/publication/drafts/", "pipeline/drafts/"],
    phaseRequired: true,
  }),
});
const SENSITIVE_KEY = /(?:secret|token|cookie|password|api[_-]?key|private[_-]?key|credential)/i;
const EXPECTED_JOBS = new Map([
  ["wechat-article", { platform: "wechat", deliveryKind: "draft_fill" }],
  ["xiaohongshu-opinion-1", { platform: "xiaohongshu", deliveryKind: "draft_fill" }],
  ["xiaohongshu-opinion-2", { platform: "xiaohongshu", deliveryKind: "draft_fill" }],
  ["xiaohongshu-opinion-3", { platform: "xiaohongshu", deliveryKind: "draft_fill" }],
  ["moments-opinion-1", { platform: "moments", deliveryKind: "draft_fill" }],
  ["moments-opinion-2", { platform: "moments", deliveryKind: "draft_fill" }],
  ["moments-opinion-3", { platform: "moments", deliveryKind: "draft_fill" }],
  ["shipinhao-video-execution-1", { platform: "shipinhao", deliveryKind: "execution_package" }],
  ["shipinhao-video-execution-2", { platform: "shipinhao", deliveryKind: "execution_package" }],
  ["douyin-video-execution-1", { platform: "douyin", deliveryKind: "execution_package" }],
  ["douyin-video-execution-2", { platform: "douyin", deliveryKind: "execution_package" }],
]);

class PublicationAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicationAuthorityError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function draftApprovalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => draftApprovalStringify(item)).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([key]) => !DRAFT_APPROVAL_TRANSIENT_KEYS.has(key))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${draftApprovalStringify(item)}`)
    .join(",")}}`;
}

function draftQueueContractSha256(queue) {
  return sha256(draftApprovalStringify(queue));
}

function strictString(value, label, pattern, maxBytes = 1024) {
  if (typeof value !== "string") {
    throw new PublicationAuthorityError("invalid_authority_request", `${label} is invalid.`);
  }
  const result = value.trim();
  if (!result || Buffer.byteLength(result, "utf8") > maxBytes || (pattern && !pattern.test(result))) {
    throw new PublicationAuthorityError("invalid_authority_request", `${label} is invalid.`);
  }
  return result;
}

function safeRelativePath(value, label) {
  const result = strictString(value, label, null).replace(/\\/g, "/");
  if (isAbsolute(result) || /^[A-Za-z]:\//.test(result) || result.includes("\0")
    || result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new PublicationAuthorityError("unsafe_project_file", `${label} must be a project-local path.`);
  }
  return result;
}

function isSubpath(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function assertOwnedRegularFile(info, label, maxBytes) {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1
    || (expectedUid !== null && info.uid !== expectedUid) || info.size > maxBytes) {
    throw new PublicationAuthorityError("unsafe_project_file", `${label} is not a safe project file.`);
  }
}

/**
 * Reads through the same O_NOFOLLOW file descriptor that was validated. Parent
 * identities and the final inode are checked again after the read so a path
 * swap cannot silently turn a project-local queue/body/asset into another file.
 */
async function secureReadProjectFile(projectDir, inputPath, options = {}) {
  const label = options.label || "project file";
  const maxBytes = options.maxBytes || MAX_CONTENT_BYTES;
  const missingCode = options.missingCode || "project_file_missing";
  const relativePath = safeRelativePath(inputPath, label);
  let root;
  try {
    root = await realpath(resolve(projectDir));
  } catch {
    throw new PublicationAuthorityError("unsafe_project_root", "The active project directory is unavailable.");
  }
  const target = resolve(root, relativePath);
  if (!isSubpath(root, target)) {
    throw new PublicationAuthorityError("unsafe_project_file", `${label} is outside the active project.`);
  }

  const segments = relative(root, target).split(sep).filter(Boolean);
  const parentIdentities = [];
  let current = root;
  try {
    for (const segment of segments.slice(0, -1)) {
      current = resolve(current, segment);
      const info = await lstat(current);
      const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (!info.isDirectory() || info.isSymbolicLink()
        || (expectedUid !== null && info.uid !== expectedUid)) {
        throw new PublicationAuthorityError("unsafe_project_file", `${label} contains an unsafe parent directory.`);
      }
      parentIdentities.push({ path: current, info });
    }
  } catch (error) {
    if (error instanceof PublicationAuthorityError) throw error;
    throw new PublicationAuthorityError(missingCode, `${label} is unavailable.`);
  }

  let handle;
  let pathBeforeOpen;
  try {
    pathBeforeOpen = await lstat(target);
    assertOwnedRegularFile(pathBeforeOpen, label, maxBytes);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(target, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error instanceof PublicationAuthorityError) throw error;
    throw new PublicationAuthorityError(missingCode, `${label} is unavailable.`);
  }

  try {
    const before = await handle.stat();
    assertOwnedRegularFile(before, label, maxBytes);
    if (!sameIdentity(pathBeforeOpen, before)) {
      throw new PublicationAuthorityError("project_file_changed", `${label} changed before it could be verified.`);
    }
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(before, after) || buffer.length !== before.size) {
      throw new PublicationAuthorityError("project_file_changed", `${label} changed while it was being verified.`);
    }
    const finalPathInfo = await lstat(target);
    assertOwnedRegularFile(finalPathInfo, label, maxBytes);
    if (!sameIdentity(before, finalPathInfo)) {
      throw new PublicationAuthorityError("project_file_changed", `${label} changed while it was being verified.`);
    }
    for (const parent of parentIdentities) {
      const currentInfo = await lstat(parent.path);
      if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()
        || currentInfo.dev !== parent.info.dev || currentInfo.ino !== parent.info.ino) {
        throw new PublicationAuthorityError("project_file_changed", `${label} parent changed while it was being verified.`);
      }
    }
    const resolvedTarget = await realpath(target);
    if (!isSubpath(root, resolvedTarget)) {
      throw new PublicationAuthorityError("unsafe_project_file", `${label} resolves outside the active project.`);
    }
    return { target, relativePath, buffer, sha256: sha256(buffer) };
  } catch (error) {
    if (error instanceof PublicationAuthorityError) throw error;
    throw new PublicationAuthorityError("unsafe_project_file", `${label} could not be verified.`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PublicationAuthorityError("queue_contract_mismatch", `${label} contains an unsupported field.`);
    }
  }
}

function assertNoSensitiveKeys(value, path = "queue") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new PublicationAuthorityError("queue_contract_mismatch", `Sensitive data is not allowed in ${path}.`);
    }
    assertNoSensitiveKeys(nested, `${path}.${key}`);
  }
}

function contentPathForJob(job) {
  const payload = job.payload;
  if (job.platform === "wechat") return payload.html_path || payload.copy_path;
  if (job.delivery_kind === "execution_package") return payload.execution_package_path || payload.copy_path;
  return payload.copy_path;
}

function sameStringSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && new Set(left).size === left.length && left.every((item) => typeof item === "string" && right.includes(item));
}

function queueContract(queue) {
  const legacy = queue.target_platforms === undefined;
  const platforms = legacy ? LEGACY_TARGET_PLATFORMS : queue.target_platforms;
  if (!legacy && (!Array.isArray(platforms) || !platforms.length || new Set(platforms).size !== platforms.length
    || platforms.some((platform) => !SELECTED_JOB_IDS.has(platform)))) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "请核对本期平台，发布队列的平台范围不正确。");
  }
  return { legacy, platforms, visualRequired: legacy || platforms.some((platform) => platform === "wechat" || platform === "xiaohongshu") };
}

function validateQueueJobs(queue, contract) {
  const jobs = queue.jobs;
  const expectedJobs = contract.legacy ? EXPECTED_JOBS : new Map(contract.platforms.map((platform) => {
    const id = SELECTED_JOB_IDS.get(platform);
    return [id, EXPECTED_JOBS.get(id)];
  }));
  if (!Array.isArray(jobs) || jobs.length !== expectedJobs.size) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication queue is incomplete.");
  }
  const seenItems = new Set();
  const seenIds = new Set();
  for (const job of jobs) {
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      throw new PublicationAuthorityError("queue_contract_mismatch", "The publication queue contains an invalid job.");
    }
    const expected = expectedJobs.get(job.item_id);
    if (!expected || !/^draft_[a-f0-9]{20}$/.test(job.job_id || "") || expected.platform !== job.platform || expected.deliveryKind !== job.delivery_kind
      || seenItems.has(job.item_id) || seenIds.has(job.job_id)) {
      throw new PublicationAuthorityError("queue_contract_mismatch", "The publication queue job contract is invalid.");
    }
    seenItems.add(job.item_id);
    seenIds.add(job.job_id);
  }
}

function validateTargetJob(queue, request, forDelivery = false) {
  const job = queue.jobs.find((candidate) => candidate.job_id === request.jobId);
  if (!job) throw new PublicationAuthorityError("job_missing", "The requested publication job is not in the queue.");
  if (job.payload_hash !== request.expectedPayloadHash) {
    throw new PublicationAuthorityError("payload_hash_mismatch", "The publication job no longer matches the expected payload.");
  }
  if (!forDelivery && job.status !== "pending" && job.status !== "retryable_failure" && job.status !== "manual_intervention_required") {
    throw new PublicationAuthorityError("job_not_retryable", "The publication job cannot be filled in its current state.");
  }
  if (!Number.isSafeInteger(job.attempt_count) || job.attempt_count < 0) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication job attempt counter is invalid.");
  }
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication payload is invalid.");
  }
  assertOnlyKeys(job.payload, PAYLOAD_KEYS, "publication payload");
  if (!Array.isArray(job.payload.asset_paths) || job.payload.asset_paths.length > MAX_ASSETS) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication asset list is invalid.");
  }
  if (!Array.isArray(job.selected_asset_hashes) || job.selected_asset_hashes.length > MAX_ASSETS) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The selected asset evidence is invalid.");
  }
  const selectedPaths = job.selected_asset_hashes.map((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new PublicationAuthorityError("queue_contract_mismatch", "The selected asset evidence is invalid.");
    }
    assertOnlyKeys(asset, ASSET_KEYS, "selected asset evidence");
    strictString(asset.sha256, "selected asset hash", /^[a-f0-9]{64}$/i, 64);
    return safeRelativePath(asset.path, "selected asset path");
  });
  const payloadPaths = job.payload.asset_paths.map((path) => safeRelativePath(path, "publication asset path"));
  if (new Set(selectedPaths).size !== selectedPaths.length
    || stableStringify(selectedPaths) !== stableStringify(payloadPaths)) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication asset paths are not bound to selected evidence.");
  }
  strictString(job.content_hash, "content hash", /^[a-f0-9]{64}$/i, 64);
  strictString(job.payload_hash, "payload hash", /^[a-f0-9]{64}$/i, 64);
  const payloadHash = sha256(stableStringify({
    platform: job.platform,
    item_id: job.item_id,
    delivery_kind: job.delivery_kind,
    payload: job.payload,
    content_hash: job.content_hash,
    selected_asset_hashes: job.selected_asset_hashes,
  }));
  if (payloadHash !== job.payload_hash) {
    throw new PublicationAuthorityError("payload_hash_mismatch", "The publication queue payload hash is invalid.");
  }
  const expectedJobId = `draft_${sha256(`${queue.run_id}:${job.platform}:${job.item_id}:${payloadHash}`).slice(0, 20)}`;
  if (job.job_id !== expectedJobId) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication job identity is invalid.");
  }
  return job;
}

function parseJsonFile(file, code, label) {
  try {
    const value = JSON.parse(file.buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new PublicationAuthorityError(code, `${label} is not valid JSON.`);
  }
}

function canonicalJsonStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonStringify(item)}`)
    .join(",")}}`;
}

// Python's research writer keeps numeric lexemes such as 1.0, -0.0 and 1e-08.
// JSON.parse/stringify would erase them (and round large integers), rejecting
// a valid immutable snapshot. Parse the already JSON-validated token stream,
// sort object keys, and preserve numeric tokens exactly as the producer wrote
// them. Only the top-level self-digest is omitted; nested hashes are retained.
function canonicalResearchPayload(raw) {
  const tokens = raw.match(/"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g) || [];
  let offset = 0;
  const compareKeys = (left, right) => {
    const a = Array.from(left, (char) => char.codePointAt(0));
    const b = Array.from(right, (char) => char.codePointAt(0));
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  const parse = (root = false) => {
    const token = tokens[offset++];
    if (token === '{') {
      const entries = new Map();
      while (tokens[offset] !== '}') {
        const key = JSON.parse(tokens[offset++]);
        offset += 1; // Colon; the source was validated by JSON.parse above.
        const value = parse();
        if (!root || key !== 'sha256') entries.set(key, value);
        if (tokens[offset] !== ',') break;
        offset += 1;
      }
      offset += 1;
      return `{${[...entries.keys()].sort(compareKeys).map((key) => `${JSON.stringify(key)}:${entries.get(key)}`).join(',')}}`;
    }
    if (token === '[') {
      const values = [];
      while (tokens[offset] !== ']') {
        values.push(parse());
        if (tokens[offset] !== ',') break;
        offset += 1;
      }
      offset += 1;
      return `[${values.join(',')}]`;
    }
    return token.startsWith('"') ? JSON.stringify(JSON.parse(token)) : token;
  };
  const result = parse(true);
  if (offset !== tokens.length) throw new PublicationAuthorityError('topic_lineage_invalid', '无法核对研究记录中的内容摘要。');
  return result;
}

function canonicalRunId(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[^0-9A-Za-z._\-\u4e00-\u9fff]+/g, "-").replace(/^[.\-]+|[.\-]+$/g, "") || "untitled";
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function assertManagedRun(run, runId, runSlug, contract) {
  if (canonicalRunId(runId) !== runId || run.run_id !== runId || run.slug !== runSlug || run.status !== "active") {
    throw new PublicationAuthorityError("run_contract_mismatch", "The publication run is missing or is not the active queue owner.");
  }
  const normalizePlatforms = (value) => Array.isArray(value) ? value.map((item) => item === "xhs" ? "xiaohongshu" : item) : null;
  if (!sameStringSet(normalizePlatforms(run.target_platforms), contract.platforms)
    || (!contract.legacy && !sameStringSet(normalizePlatforms(run.selected_platforms ?? run.target_platforms), contract.platforms))) {
    throw new PublicationAuthorityError("run_contract_mismatch", "发布队列与本期已选平台不一致，请重新核对成品。");
  }
  if (run.research_mode !== undefined && !["platform", "author_material"].includes(run.research_mode)) {
    throw new PublicationAuthorityError("run_contract_mismatch", "本期写作依据无法核对，请重新确认写作方案。");
  }
  if (!run.steps || typeof run.steps !== "object" || Array.isArray(run.steps)
    || !run.approvals || typeof run.approvals !== "object" || Array.isArray(run.approvals)
    || !run.phase_artifacts || typeof run.phase_artifacts !== "object" || Array.isArray(run.phase_artifacts)) {
    throw new PublicationAuthorityError("run_contract_mismatch", "The publication run state is incomplete.");
  }
}

function currentScopePath(run, scope) {
  const registration = run.phase_artifacts[scope];
  if (registration && typeof registration === "object" && !Array.isArray(registration)
    && typeof registration.path === "string" && registration.path) return registration.path;
  const step = APPROVAL_CONTRACT[scope].step;
  const state = step ? run.steps[step] : null;
  return state && typeof state === "object" && !Array.isArray(state) && typeof state.latest === "string"
    ? state.latest
    : "";
}

function currentScopeVersion(run, scope, artifactPath) {
  const registration = run.phase_artifacts[scope];
  if (registration && typeof registration === "object" && !Array.isArray(registration)
    && registration.path === artifactPath && isPositiveInteger(registration.version)) return registration.version;
  const step = APPROVAL_CONTRACT[scope].step;
  if (!step) return 1;
  const versions = Array.isArray(run.history)
    ? run.history.filter((item) => item && typeof item === "object" && !Array.isArray(item)
      && item.step === step && item.path === artifactPath).length
    : 0;
  return Math.max(1, versions);
}

function assertScopePath(scope, artifactPath) {
  const safePath = safeRelativePath(artifactPath, `${scope} artifact path`);
  if (!APPROVAL_CONTRACT[scope].roots.some((root) => safePath.startsWith(root))) {
    throw new PublicationAuthorityError("approval_invalid", `The ${scope} artifact is outside its server-owned domain.`);
  }
  return safePath;
}

function validateApproval(run, scope, artifactPath, digest) {
  const config = APPROVAL_CONTRACT[scope];
  const safePath = assertScopePath(scope, artifactPath);
  const registration = run.phase_artifacts[scope];
  if (config.phaseRequired && (!registration || typeof registration !== "object" || Array.isArray(registration))) {
    throw new PublicationAuthorityError("approval_missing", `The ${scope} artifact was not registered by the server.`);
  }
  if (registration !== undefined) {
    if (!registration || typeof registration !== "object" || Array.isArray(registration)
      || registration.path !== safePath || registration.sha256 !== digest || !isPositiveInteger(registration.version)) {
      throw new PublicationAuthorityError("approval_invalid", `The ${scope} server artifact registration is stale.`);
    }
  }
  if (currentScopePath(run, scope) !== safePath) {
    throw new PublicationAuthorityError("approval_invalid", `The ${scope} artifact is no longer current.`);
  }
  const approval = run.approvals[scope];
  const version = currentScopeVersion(run, scope, safePath);
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    throw new PublicationAuthorityError("approval_missing", `The ${scope} artifact has not received human approval.`);
  }
  if (approval.scope !== scope || approval.run_id !== run.run_id || approval.run_slug !== run.slug
    || approval.path !== safePath || approval.method !== "human_review"
    || approval.invalidated_at || approval.invalidation_reason
    || approval.sha256 !== digest || approval.version !== version
    || typeof approval.approved_at !== "string" || !approval.approved_at.trim()) {
    throw new PublicationAuthorityError("approval_invalid", `The ${scope} human approval is stale or does not belong to this run.`);
  }
  return approval;
}

function visualSemanticRole(assetId) {
  if (/^wechat-cover(?:-alt-\d+)?$/i.test(assetId)) return "wechat_cover";
  if (/^wechat-share(?:-alt-\d+)?$/i.test(assetId)) return "wechat_share";
  return assetId;
}

async function validateVisualLineage(projectDir, run, visualPath, visualFile, packagePath, packageHash, queue) {
  const manifest = parseJsonFile(visualFile, "visual_lineage_invalid", "The approved visual manifest");
  const expectedPath = `pipeline/visual/${run.slug}/selected-assets.json`;
  if (visualPath !== expectedPath || manifest.schema !== "aifios.visual-asset-manifest.v1"
    || manifest.slug !== run.slug || manifest.sourceContentHash !== packageHash
    || !Array.isArray(manifest.requiredRoles) || manifest.requiredRoles.length === 0
    || new Set(manifest.requiredRoles).size !== manifest.requiredRoles.length
    || !manifest.selections || typeof manifest.selections !== "object" || Array.isArray(manifest.selections)
    || Object.keys(manifest.selections).length !== manifest.requiredRoles.length
    || manifest.requiredRoles.some((role) => typeof role !== "string" || !role || !(role in manifest.selections))) {
    throw new PublicationAuthorityError("visual_lineage_invalid", "The approved visual manifest is not bound to the current package and run.");
  }

  const evidenceByPath = new Map();
  const revisionRecords = new Map();
  for (const role of manifest.requiredRoles) {
    const selection = manifest.selections[role];
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw new PublicationAuthorityError("visual_lineage_invalid", "The approved visual selection is incomplete.");
    }
    const assetId = strictString(selection.assetId, "visual asset id", /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/, 101);
    const revisionId = strictString(selection.revisionId, "visual revision id", /^r\d{3,}$/, 64);
    const assetPath = safeRelativePath(selection.path, "visual asset path");
    const assetHash = strictString(selection.sha256, "visual asset hash", /^[a-f0-9]{64}$/i, 64);
    if (selection.semanticRole !== role || visualSemanticRole(assetId) !== role
      || !Array.isArray(selection.platformBindings)
      || !assetPath.startsWith(`pipeline/visual/${run.slug}/publish/${revisionId}/`)) {
      throw new PublicationAuthorityError("visual_lineage_invalid", "The approved visual selection does not match its semantic role.");
    }
    const assetFile = await secureReadProjectFile(projectDir, assetPath, {
      label: "approved visual asset",
      maxBytes: MAX_ASSET_BYTES,
    });
    if (assetFile.sha256 !== assetHash) {
      throw new PublicationAuthorityError("asset_changed", "An approved visual asset changed after human approval.");
    }
    evidenceByPath.set(assetPath, assetHash);
    if (!revisionRecords.has(revisionId)) {
      const recipePath = `pipeline/visual/${run.slug}/recipes/${revisionId}.visual-recipe.json`;
      const indexPath = `pipeline/visual/${run.slug}/revisions/${revisionId}.index.json`;
      const [recipeFile, indexFile] = await Promise.all([
        secureReadProjectFile(projectDir, recipePath, { label: "visual recipe", maxBytes: MAX_MANIFEST_BYTES }),
        secureReadProjectFile(projectDir, indexPath, { label: "visual publish index", maxBytes: MAX_MANIFEST_BYTES }),
      ]);
      const recipe = parseJsonFile(recipeFile, "visual_lineage_invalid", "The visual recipe");
      const index = parseJsonFile(indexFile, "visual_lineage_invalid", "The visual publish index");
      if (recipe.slug !== run.slug || recipe.revision_id !== revisionId || recipe.source_package !== packagePath
        || index.schema !== "aifios.visual-publish.v1" || index.slug !== run.slug || index.revision_id !== revisionId
        || !Array.isArray(recipe.assets) || !Array.isArray(index.outputs)) {
        throw new PublicationAuthorityError("visual_lineage_invalid", "The visual recipe or publish index is not bound to the current package.");
      }
      revisionRecords.set(revisionId, { recipe, index });
    }
    const revision = revisionRecords.get(revisionId);
    if (!revision.recipe.assets.some((item) => item && typeof item === "object" && item.id === assetId)
      || !revision.index.outputs.some((item) => item && typeof item === "object" && item.id === assetId
        && item.output === assetPath && item.sha256 === assetHash && item.revision_id === revisionId
        && item.status === "generated")) {
      throw new PublicationAuthorityError("visual_lineage_invalid", "The approved visual asset is absent from its recipe or publish index.");
    }
  }
  for (const job of queue.jobs) {
    for (const evidence of job.selected_asset_hashes || []) {
      if (evidenceByPath.get(evidence.path) !== evidence.sha256) {
        throw new PublicationAuthorityError("visual_lineage_invalid", "A queued asset is not present in the approved visual selection.");
      }
    }
  }
}

async function validateFrozenTopicLineage(projectDir, run, materialPath, materialFile, approval, contract) {
  const snapshotPath = safeRelativePath(approval.market_snapshot_path, "approved market snapshot path");
  const snapshotHash = strictString(approval.market_snapshot_sha256, "approved market snapshot hash", /^[a-f0-9]{64}$/i, 64);
  const expectedPrefix = `runs/${run.run_id}/market-research/`;
  if (!snapshotPath.startsWith(expectedPrefix) || approval.visual_template !== (run.visual_template || "publish_template")) {
    throw new PublicationAuthorityError("topic_lineage_invalid", "The topic approval is not bound to this run's frozen research and visual template.");
  }
  const frozenPath = `${expectedPrefix}frozen-snapshot.json`;
  const [snapshotFile, frozenFile] = await Promise.all([
    secureReadProjectFile(projectDir, snapshotPath, { label: "TikOmni research snapshot", maxBytes: MAX_MANIFEST_BYTES }),
    secureReadProjectFile(projectDir, frozenPath, {
      label: "frozen TikOmni research pointer",
      maxBytes: MAX_MANIFEST_BYTES,
      missingCode: "topic_lineage_invalid",
    }),
  ]);
  const snapshot = parseJsonFile(snapshotFile, "topic_lineage_invalid", "The TikOmni research snapshot");
  const frozen = parseJsonFile(frozenFile, "topic_lineage_invalid", "The frozen TikOmni research pointer");
  const frozenDigest = strictString(frozen.sha256, "frozen snapshot hash", /^[a-f0-9]{64}$/i, 64);
  const frozenCanonical = { ...frozen };
  delete frozenCanonical.sha256;
  const supportedSchema = contract.legacy ? [3, 4] : [4];
  if (!supportedSchema.includes(frozen.schema_version) || frozen.kind !== "aifios.tikomni.frozen-topic-research"
    || frozen.run_id !== run.run_id || frozen.manifest_path !== snapshotPath
    || frozen.snapshot_sha256 !== snapshotHash
    || frozenDigest !== sha256(canonicalJsonStringify(frozenCanonical))
    || approval.market_snapshot_freeze_sha256 !== frozenDigest
    || approval.market_snapshot_frozen_at !== frozen.frozen_at) {
    throw new PublicationAuthorityError("topic_lineage_invalid", "The approved TikOmni research pointer is missing, changed, or belongs to another run.");
  }
  const requiredResearchPlatforms = contract.legacy ? ["wechat_mp", "xiaohongshu", "wechat_channels"]
    : ["wechat", "xiaohongshu", "shipinhao"].filter((platform) => contract.platforms.includes(platform))
      .map((platform) => ({ wechat: "wechat_mp", xiaohongshu: "xiaohongshu", shipinhao: "wechat_channels" })[platform]);
  const checks = snapshot.platform_checks;
  const validResearchPlatforms = ["wechat_mp", "xiaohongshu", "wechat_channels"];
  const declaredPlatforms = snapshot.required_platforms;
  const declaredReady = snapshot.ready_platforms;
  const platformScopeMatches = contract.legacy ? sameStringSet(declaredPlatforms, requiredResearchPlatforms)
    : Array.isArray(declaredPlatforms) && declaredPlatforms.length > 0 && new Set(declaredPlatforms).size === declaredPlatforms.length
      && declaredPlatforms.every((platform) => validResearchPlatforms.includes(platform))
      && requiredResearchPlatforms.every((platform) => declaredPlatforms.includes(platform))
      && Array.isArray(declaredReady) && new Set(declaredReady).size === declaredReady.length
      && declaredReady.every((platform) => declaredPlatforms.includes(platform))
      && requiredResearchPlatforms.every((platform) => declaredReady.includes(platform));
  if (snapshot.schema_version !== frozen.schema_version || snapshot.kind !== "aifios.tikomni.topic-research-snapshot"
    || snapshot.run_id !== run.run_id || snapshot.sha256 !== snapshotHash
    || sha256(canonicalResearchPayload(snapshotFile.buffer.toString("utf8"))) !== snapshotHash
    || snapshot.source_path !== materialPath || snapshot.source_sha256 !== materialFile.sha256
    || !platformScopeMatches
    || (snapshot.douyin_research_proxy !== undefined && snapshot.douyin_research_proxy !== "wechat_channels") || snapshot.no_fallback !== true
    || snapshot.used_cache || snapshot.used_local_samples || snapshot.creator_mode
    || !checks || typeof checks !== "object" || Array.isArray(checks)
    || requiredResearchPlatforms.some((platform) => !checks[platform] || checks[platform].status !== "available"
      || !Number.isInteger(checks[platform].sample_count) || checks[platform].sample_count < 1)
    || (contract.legacy && (!snapshot.sufficiency || snapshot.sufficiency.sufficient !== true))
    || !Array.isArray(snapshot.raw_entries) || snapshot.raw_entries.length < requiredResearchPlatforms.length
    || !requiredResearchPlatforms.every((platform) => snapshot.raw_entries.some((entry) => entry?.platform === platform))) {
    throw new PublicationAuthorityError("topic_lineage_invalid", "研究记录与本期平台或素材不一致，请重新核对写作依据。");
  }
  const snapshotDir = snapshotPath.slice(0, snapshotPath.lastIndexOf("/"));
  for (const entry of snapshot.raw_entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PublicationAuthorityError("topic_lineage_invalid", "The approved TikOmni raw evidence list is invalid.");
    }
    const rawPath = safeRelativePath(entry.path, "TikOmni raw evidence path");
    const rawHash = strictString(entry.sha256, "TikOmni raw evidence hash", /^[a-f0-9]{64}$/i, 64);
    if (!rawPath.startsWith(`${snapshotDir}/raw/`)) {
      throw new PublicationAuthorityError("topic_lineage_invalid", "TikOmni raw evidence is outside its immutable snapshot.");
    }
    const rawFile = await secureReadProjectFile(projectDir, rawPath, { label: "TikOmni raw evidence", maxBytes: MAX_MANIFEST_BYTES });
    if (rawFile.sha256 !== rawHash) {
      throw new PublicationAuthorityError("topic_lineage_invalid", "TikOmni raw evidence changed after topic approval.");
    }
  }
  const normalizedPath = safeRelativePath(snapshot.normalized_path, "TikOmni normalized evidence path");
  const normalizedHash = strictString(snapshot.normalized_sha256, "TikOmni normalized evidence hash", /^[a-f0-9]{64}$/i, 64);
  if (!normalizedPath.startsWith(`${snapshotDir}/`)) {
    throw new PublicationAuthorityError("topic_lineage_invalid", "TikOmni normalized evidence is outside its immutable snapshot.");
  }
  const normalizedFile = await secureReadProjectFile(projectDir, normalizedPath, {
    label: "TikOmni normalized evidence",
    maxBytes: MAX_MANIFEST_BYTES,
  });
  if (normalizedFile.sha256 !== normalizedHash) {
    throw new PublicationAuthorityError("topic_lineage_invalid", "TikOmni normalized evidence changed after topic approval.");
  }
}

async function readPublicationRestrictions(projectDir, run, materialFile) {
  const runId = strictString(run.run_id, "run id", /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/, 100);
  const contextPath = `sessions/material-analysis/${runId}.json`;
  let contextExists = true;
  try { await lstat(resolve(projectDir, contextPath)); }
  catch (error) { if (error.code === "ENOENT") contextExists = false; else throw error; }
  if (!contextExists) {
    if (run.material_correction) throw new PublicationAuthorityError("material_disclosure_unavailable", "无法核对素材公开限制，请重新读取本期素材。");
    const file = materialFile || await secureReadProjectFile(projectDir, safeRelativePath(run.steps?.intake?.latest, "material path"), { maxBytes: MAX_PACKAGE_BYTES });
    return { restrictions: internalOnlyRestrictions(intakeDisclosureEntries(file.buffer.toString("utf8"))), sha256: file.sha256 };
  }
  const file = await secureReadProjectFile(projectDir, contextPath, { maxBytes: MAX_PACKAGE_BYTES });
  const context = parseJsonFile(file, "material_disclosure_unavailable", "Material disclosure context");
  if (context.schema !== "aifios.material-analysis.v1" || context.runId !== runId
    || context.analysisStatus !== "current" || !/^[a-f0-9]{64}$/.test(context.inputFingerprint || "")
    || context.inputFingerprint !== context.analysisInputFingerprint) {
    throw new PublicationAuthorityError("material_disclosure_unavailable", "素材已变化或无法核对，请重新整理后确认公开限制。");
  }
  let analysis = context.analysis;
  let digest = file.sha256;
  let correctionId = "";
  if (run.material_correction) {
    const pointer = run.material_correction;
    const id = strictString(pointer.id, "material correction id", /^correction_[a-f0-9]{32}$/, 43);
    const path = `runs/${runId}/material-corrections/${id}.json`;
    if (pointer.path !== path) throw new PublicationAuthorityError("material_disclosure_unavailable", "素材修正不属于本期，请重新读取。");
    const correctionFile = await secureReadProjectFile(projectDir, path, { maxBytes: MAX_PACKAGE_BYTES });
    const record = parseJsonFile(correctionFile, "material_disclosure_unavailable", "Material correction");
    if (pointer.sha256 !== correctionFile.sha256 || record.schema !== "echo.material-correction.v1"
      || record.run_id !== runId || record.id !== id) {
      throw new PublicationAuthorityError("material_disclosure_unavailable", "素材修正无法核对，请重新读取。");
    }
    if (record.input_fingerprint === context.inputFingerprint) {
      analysis = record.analysis;
      correctionId = id;
      digest = sha256(`${digest}:${correctionFile.sha256}`);
    }
  }
  if (!analysis || !Array.isArray(analysis.risks) || analysis.risks.some((item) => typeof item !== "string")) {
    throw new PublicationAuthorityError("material_disclosure_unavailable", "无法核对素材公开限制，请重新整理本期素材。");
  }
  return { restrictions: internalOnlyRestrictions(analysis.risks), sha256: digest, correctionId,
    material: { input_fingerprint: context.inputFingerprint, input: context.input ?? null, analysis, correction_id: correctionId, selection: context.selection ?? null } };
}

async function validateAuthorTopicLineage(projectDir, run, materialPath, materialFile, topicFile, approval, disclosure) {
  const pointer = run.author_evidence;
  const fail = () => { throw new PublicationAuthorityError("author_lineage_invalid", "作者素材、题目或平台已变化，请重新核对写作方案及后续内容。"); };
  if (!pointer || typeof pointer !== "object" || !/^author_[a-f0-9]{32}$/.test(pointer.id || "")) fail();
  const path = `runs/${run.run_id}/author-evidence/${pointer.id}.json`;
  if (pointer.path !== path || !/^[a-f0-9]{64}$/.test(pointer.sha256 || "")
    || approval.research_mode !== "author_material" || approval.author_evidence_path !== path
    || approval.author_evidence_sha256 !== pointer.sha256
    || typeof approval.author_evidence_frozen_at !== "string" || !approval.author_evidence_frozen_at.trim()
    || approval.visual_template !== (run.visual_template || "publish_template") || !disclosure.material) fail();
  const recordFile = await secureReadProjectFile(projectDir, path, { label: "author material evidence", maxBytes: MAX_PACKAGE_BYTES, missingCode: "author_lineage_invalid" });
  const record = parseJsonFile(recordFile, "author_lineage_invalid", "Author material evidence");
  if (recordFile.sha256 !== pointer.sha256 || record.schema !== "echo.author-evidence.v1"
    || record.run_id !== run.run_id || record.id !== pointer.id || record.topic !== run.topic
    || record.intake_path !== materialPath || record.intake_sha256 !== materialFile.sha256
    || canonicalJsonStringify(record.target_platforms) !== canonicalJsonStringify(run.target_platforms)
    || !disclosure.material.analysis?.summary || !disclosure.material.input
    || record.material_sha256 !== sha256(canonicalJsonStringify(disclosure.material))
    || record.material_sha256 !== sha256(canonicalJsonStringify(record.material ?? null))) fail();
  const body = topicFile.buffer.toString("utf8");
  const lines = (pattern) => [...body.matchAll(pattern)].map((match) => match[1]);
  if (canonicalJsonStringify(lines(/^- 作者素材快照：([^\r\n]+)$/gm)) !== canonicalJsonStringify([path])
    || canonicalJsonStringify(lines(/^- 作者素材 SHA-256：([a-f0-9]{64})$/gm)) !== canonicalJsonStringify([recordFile.sha256])
    || canonicalJsonStringify(lines(/^- 写作依据：([^\r\n]+)$/gm)) !== canonicalJsonStringify(["作者素材（未进行平台研究）"])) fail();
}

async function validateRunAuthority(options) {
  const { projectDir, runId, runSlug, queuePath, queue, queueFile, packagePath, packageFile, visualPath, visualFile, contract } = options;
  const runFile = await secureReadProjectFile(projectDir, `runs/${canonicalRunId(runId)}.json`, {
    label: "publication run state",
    maxBytes: MAX_RUN_BYTES,
    missingCode: "run_missing",
  });
  const run = parseJsonFile(runFile, "run_contract_mismatch", "The publication run state");
  assertManagedRun(run, runId, runSlug, contract);
  if (queue.invalidated_at || queue.invalidation_reason || queue.status === "invalidated") {
    throw new PublicationAuthorityError("approval_invalid", "The publication queue has been invalidated.");
  }

  const materialPath = safeRelativePath(run.steps?.intake?.latest, "current material artifact path");
  if (!materialPath.startsWith("pipeline/intake/")) {
    throw new PublicationAuthorityError("material_lineage_invalid", "The publication run has no current material-boundary artifact.");
  }
  const materialFile = await secureReadProjectFile(projectDir, materialPath, {
    label: "current material-boundary artifact",
    maxBytes: MAX_PACKAGE_BYTES,
  });
  const disclosure = await readPublicationRestrictions(projectDir, run, materialFile);
  const targetJob = queue.jobs.find((job) => job.job_id === options.jobId);
  if ((options.forDelivery || targetJob?.delivery_kind === "draft_fill") && disclosure.restrictions.length) {
    throw new PublicationAuthorityError("material_internal_only", INTERNAL_ONLY_MESSAGE);
  }
  const topicPath = assertScopePath("topic_template", run.steps?.blueprint?.latest);
  const topicFile = await secureReadProjectFile(projectDir, topicPath, {
    label: "approved topic/template artifact",
    maxBytes: MAX_PACKAGE_BYTES,
  });
  if (run.steps?.package?.latest !== packagePath || currentScopePath(run, "content_package") !== packagePath
    || (contract.visualRequired && currentScopePath(run, "visual_assets") !== visualPath)
    || currentScopePath(run, "draft_information") !== queuePath) {
    throw new PublicationAuthorityError("approval_invalid", "The draft queue is not bound to the current package, visual selection, and run state.");
  }

  const topicApproval = validateApproval(run, "topic_template", topicPath, topicFile.sha256);
  validateApproval(run, "content_package", packagePath, packageFile.sha256);
  if (contract.visualRequired) validateApproval(run, "visual_assets", visualPath, visualFile.sha256);
  validateApproval(run, "draft_information", queuePath, draftQueueContractSha256(queue));
  const approvedScopes = ["topic_template", "content_package", "draft_information", ...(contract.visualRequired ? ["visual_assets"] : [])];
  if (disclosure.correctionId !== undefined && approvedScopes.some(
    (scope) => (run.approvals[scope]?.material_correction_id || "") !== disclosure.correctionId,
  )) throw new PublicationAuthorityError("approval_invalid", "素材公开限制已变化，请重新核对后续内容。");
  if (run.research_mode === "author_material") {
    await validateAuthorTopicLineage(projectDir, run, materialPath, materialFile, topicFile, topicApproval, disclosure);
  } else {
    if (topicApproval.research_mode === "author_material") throw new PublicationAuthorityError("topic_lineage_invalid", "本期写作依据已改变，请重新确认方案。");
    await validateFrozenTopicLineage(projectDir, run, materialPath, materialFile, topicApproval, contract);
  }
  if (contract.visualRequired) await validateVisualLineage(projectDir, run, visualPath, visualFile, packagePath, packageFile.sha256, queue);
  return {
    schema: PUBLICATION_AUTHORITY_CONTRACT_SCHEMA,
    runFileSha256: runFile.sha256,
    materialDisclosureSha256: disclosure.sha256,
  };
}

async function rebuildAuthoritativePublicationRequest(options) {
  const request = options.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new PublicationAuthorityError("invalid_authority_request", "Publication bridge request is invalid.");
  }
  assertOnlyKeys(request, REQUEST_KEYS, "publication bridge request");
  assertNoSensitiveKeys(request, "request");
  const queuePath = safeRelativePath(request.queuePath, "queuePath");
  const queueMatch = /^materials\/publication\/drafts\/([A-Za-z0-9_\-\u4e00-\u9fff]+)\/draft-queue\.json$/.exec(queuePath);
  if (!queueMatch) throw new PublicationAuthorityError("invalid_authority_request", "queuePath is not a supported draft queue path.");
  const runId = strictString(request.runId, "runId", /^[A-Za-z0-9_.:\-\u4e00-\u9fff]{1,256}$/, 256);
  const jobId = strictString(request.jobId, "jobId", /^draft_[a-f0-9]{20}$/, 64);
  const expectedPayloadHash = strictString(request.expectedPayloadHash, "expectedPayloadHash", /^[a-f0-9]{64}$/i, 64);

  const queueFile = await secureReadProjectFile(options.projectDir, queuePath, {
    label: "publication queue",
    maxBytes: MAX_QUEUE_BYTES,
    missingCode: "queue_missing",
  });
  let queue;
  try {
    queue = JSON.parse(queueFile.buffer.toString("utf8"));
  } catch {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication queue is not valid JSON.");
  }
  assertNoSensitiveKeys(queue);
  if (!queue || typeof queue !== "object" || Array.isArray(queue) || queue.schema !== QUEUE_SCHEMA
    || queue.run_id !== runId || queue.run_slug !== queueMatch[1]) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication queue does not belong to the requested run.");
  }
  const contract = queueContract(queue);
  validateQueueJobs(queue, contract);
  const packagePath = safeRelativePath(queue.package_path, "package_path");
  const packageHash = strictString(queue.package_sha256, "package_sha256", /^[a-f0-9]{64}$/i, 64);
  const expectedQueueId = `queue_${sha256(`${queue.run_id}:${packagePath}:${packageHash}`).slice(0, 20)}`;
  if (queue.queue_id !== expectedQueueId) {
    throw new PublicationAuthorityError("queue_contract_mismatch", "The publication queue identity is invalid.");
  }
  const packageFile = await secureReadProjectFile(options.projectDir, packagePath, {
    label: "content package",
    maxBytes: MAX_PACKAGE_BYTES,
  });
  if (packageFile.sha256 !== packageHash) {
    throw new PublicationAuthorityError("content_changed", "The approved content package changed after queue creation.");
  }
  let visualPath = "";
  let visualFile;
  if (contract.visualRequired) {
    visualPath = safeRelativePath(queue.visual_manifest_path, "visual_manifest_path");
    const visualHash = strictString(queue.visual_manifest_sha256, "visual_manifest_sha256", /^[a-f0-9]{64}$/i, 64);
    visualFile = await secureReadProjectFile(options.projectDir, visualPath, { label: "visual manifest", maxBytes: MAX_MANIFEST_BYTES });
    if (visualFile.sha256 !== visualHash) throw new PublicationAuthorityError("asset_changed", "The approved visual manifest changed after queue creation.");
  } else if (queue.visual_manifest_path !== undefined || queue.visual_manifest_sha256 !== undefined
    || queue.jobs.some((job) => !Array.isArray(job.selected_asset_hashes) || job.selected_asset_hashes.length || job.payload?.asset_paths?.length)) {
    throw new PublicationAuthorityError("visual_lineage_invalid", "仅视频号执行稿不应绑定图文平台的视觉资产。");
  }

  const authorityContract = await validateRunAuthority({
    projectDir: options.projectDir,
    runId,
    runSlug: queue.run_slug,
    queuePath,
    queue,
    queueFile,
    packagePath,
    packageFile,
    visualPath,
    visualFile,
    jobId,
    contract,
    forDelivery: options.forDelivery === true,
  });

  const targetJob = validateTargetJob(queue, { jobId, expectedPayloadHash }, options.forDelivery === true);
  const verifiedFiles = new Map();
  const contentPath = safeRelativePath(contentPathForJob(targetJob), "publication content path");
  const contentFile = await secureReadProjectFile(options.projectDir, contentPath, {
    label: "publication content",
    maxBytes: MAX_CONTENT_BYTES,
  });
  if (contentFile.sha256 !== targetJob.content_hash) {
    throw new PublicationAuthorityError("content_changed", "The publication content changed after queue creation.");
  }
  if (queue.target_platforms?.includes('xiaohongshu') && targetJob.platform === 'xiaohongshu'
    && !nativeXhsCopyMatches(packageFile.buffer.toString('utf8'), contentFile.buffer.toString('utf8'), targetJob.payload)) {
    throw new PublicationAuthorityError('native_copy_mismatch', XHS_COPY_MISMATCH);
  }
  verifiedFiles.set(contentPath, contentFile);
  for (const evidence of targetJob.selected_asset_hashes) {
    const assetPath = safeRelativePath(evidence.path, "publication asset path");
    const assetFile = await secureReadProjectFile(options.projectDir, assetPath, {
      label: "publication asset",
      maxBytes: MAX_ASSET_BYTES,
    });
    if (assetFile.sha256 !== evidence.sha256) {
      throw new PublicationAuthorityError("asset_changed", "A selected publication asset changed after queue creation.");
    }
    verifiedFiles.set(assetPath, assetFile);
  }
  return { queuePath, runId, rawJob: targetJob, verifiedFiles, authorityContract };
}

module.exports = {
  PUBLICATION_AUTHORITY_CONTRACT_SCHEMA,
  PublicationAuthorityError,
  canonicalJsonStringify,
  draftQueueContractSha256,
  rebuildAuthoritativePublicationRequest,
  readPublicationRestrictions,
  secureReadProjectFile,
  sha256,
  stableStringify,
};
