import 'server-only';
import { lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PROJECT_DIR } from './project-root';
import type { RuntimeRun } from './runtime-run-resolver';
import { readPublicationRestrictions, secureReadProjectFile } from '@/electron/publication-authority.cjs';
import { classifyDisclosureEntries, intakeDisclosureEntries, internalOnlyRestrictions } from '@/electron/material-disclosure.cjs';

export type OutputDisclosure = {
  status: 'internal_only' | 'restricted_details' | 'no_whole_draft_limit' | 'unverified';
  restrictions: string[];
  runId?: string;
  fingerprint?: string;
};

const RUN_ID = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
type VerifiedRun = { run: RuntimeRun & { run_id: string }; sha256: string };
const unverified = (runId?: string): OutputDisclosure => ({ status: 'unverified', restrictions: [], ...(runId ? { runId } : {}) });

function isRelativePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 2048
    && !/[\\\x00-\x1f]/.test(path) && !/^[A-Za-z]:/.test(path)
    && path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validRun(value: unknown, runId: string): value is VerifiedRun['run'] {
  return isRecord(value) && value.run_id === runId
    && (value.steps === undefined || (isRecord(value.steps) && Object.values(value.steps).every((step) => (
      isRecord(step) && (step.latest === undefined || step.latest === null || isRelativePath(step.latest))
    ))))
    && (value.phase_artifacts === undefined || (isRecord(value.phase_artifacts) && Object.values(value.phase_artifacts).every((artifact) => (
      isRecord(artifact) && (artifact.path === undefined || artifact.path === null || isRelativePath(artifact.path))
    ))))
    && (value.history === undefined || (Array.isArray(value.history) && value.history.every((entry) => (
      isRecord(entry) && (entry.path === undefined || entry.path === null || isRelativePath(entry.path))
    ))));
}

async function readRun(runId: string): Promise<VerifiedRun> {
  if (!RUN_ID.test(runId)) throw new Error('Invalid run ID');
  const file = await secureReadProjectFile(PROJECT_DIR, `runs/${runId}.json`, { maxBytes: MAX_RECORD_BYTES });
  const run: unknown = JSON.parse(file.buffer.toString('utf8'));
  if (!validRun(run, runId)) throw new Error('Invalid run record');
  return { run, sha256: file.sha256 };
}

async function disclosureForRun(verified: VerifiedRun): Promise<OutputDisclosure> {
  const { run } = verified;
  const disclosure = await readPublicationRestrictions(PROJECT_DIR, run, undefined);
  // The publication reader ignores corrections for previous inputs. Exporting
  // must surface that unresolved author version instead of implying clearance.
  if (run.material_correction && disclosure.correctionId !== run.material_correction.id) {
    throw new Error('Author correction no longer matches the material');
  }
  let entries: string[];
  if (disclosure.material) {
    entries = disclosure.material.analysis.risks;
  } else {
    const intakePath = run.steps?.intake?.latest;
    if (!isRelativePath(intakePath)) throw new Error('Missing material record');
    const intake = await secureReadProjectFile(PROJECT_DIR, intakePath, { maxBytes: MAX_RECORD_BYTES });
    if (intake.sha256 !== disclosure.sha256) throw new Error('Material changed during reading');
    const body = intake.buffer.toString('utf8');
    if (!/^## 7\. 不可公开信息\s*$/m.test(body)) throw new Error('Legacy disclosure section is missing');
    entries = intakeDisclosureEntries(body);
  }
  const classified = classifyDisclosureEntries(entries);
  // The source requirements stay intact. Only proven writing-only entries are
  // omitted from the export notice; ambiguous entries still travel with it.
  const restrictions = [...classified.restrictions, ...classified.unresolved];
  const currentDisclosure = await readPublicationRestrictions(PROJECT_DIR, run, undefined);
  if (currentDisclosure.sha256 !== disclosure.sha256 || currentDisclosure.correctionId !== disclosure.correctionId) {
    throw new Error('Material changed during reading');
  }
  if ((await readRun(run.run_id)).sha256 !== verified.sha256) throw new Error('Run changed during reading');
  return {
    status: internalOnlyRestrictions(restrictions).length ? 'internal_only'
      : classified.unresolved.length ? 'unverified'
        : restrictions.length ? 'restricted_details' : 'no_whole_draft_limit',
    restrictions,
    runId: run.run_id,
    fingerprint: createHash('sha256').update(`${verified.sha256}:${disclosure.sha256}`).digest('hex'),
  };
}

export async function getRunDisclosure(runId: string): Promise<OutputDisclosure> {
  try { return await disclosureForRun(await readRun(runId)); }
  catch { return unverified(RUN_ID.test(runId) ? runId : undefined); }
}

function pathOwnership(run: Record<string, unknown>, path: string): 'exact' | 'derived' | null {
  if ((isRecord(run.steps) && Object.values(run.steps).some((step) => isRecord(step) && step.latest === path))
    || (isRecord(run.phase_artifacts) && Object.values(run.phase_artifacts).some((artifact) => isRecord(artifact) && artifact.path === path))
    || (Array.isArray(run.history) && run.history.some((entry) => isRecord(entry) && entry.path === path))) return 'exact';
  const slug = run.slug;
  if (!isRelativePath(slug) || slug.includes('/')) return null;
  return (path.startsWith(`pipeline/publish-assets/${slug}/`)
    || path.startsWith(`pipeline/visual/${slug}/`)
    || path === `pipeline/publish-assets/${slug}-publish-assets.md`
    || path === `pipeline/publish-assets/${slug}-platform-deliverables.json`) ? 'derived' : null;
}

async function findOutputOwner(path: string): Promise<VerifiedRun | null> {
  const directory = join(PROJECT_DIR, 'runs');
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return null;
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  const candidates: Array<VerifiedRun & { ownership: 'exact' | 'derived' }> = [];
  let unknownRecord = false;
  let invalidClaim = false;
  for (const name of names) {
    const runId = name.slice(0, -5);
    if (!RUN_ID.test(runId)) continue;
    let file;
    let run: unknown;
    try {
      file = await secureReadProjectFile(PROJECT_DIR, `runs/${name}`, { maxBytes: MAX_RECORD_BYTES });
      run = JSON.parse(file.buffer.toString('utf8'));
    } catch {
      unknownRecord = true;
      continue;
    }
    if (!isRecord(run)) { unknownRecord = true; continue; }
    const ownership = pathOwnership(run, path);
    if (!ownership) continue;
    if (!validRun(run, runId)) { invalidClaim = true; continue; }
    candidates.push({ run, sha256: file.sha256, ownership });
  }
  if (invalidClaim || candidates.length !== 1) return null;
  const candidate = candidates[0];
  // A valid explicit registration is evidence even when an unrelated old run
  // is unreadable. Slug-only inference cannot exclude an unreadable namesake.
  if (unknownRecord && candidate.ownership !== 'exact') return null;
  return candidate;
}

async function verifyOutputLocation(path: string): Promise<void> {
  // Do not read or hash large images just to identify their owner. The output
  // route performs the byte read; these checks reject links and missing files.
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    const info = await lstat(join(PROJECT_DIR, ...parts.slice(0, index)));
    if (info.isSymbolicLink() || (index < parts.length ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw new Error('Unsafe output path');
    }
  }
}

export async function getOutputDisclosure(relativePath: string): Promise<OutputDisclosure> {
  try {
    if (!isRelativePath(relativePath)) return unverified();
    await verifyOutputLocation(relativePath);
    const attempt = relativePath.match(/^runs\/([^/]+)\/content-attempts\/(attempt_[a-f0-9]{32})\.json$/);
    if (attempt) {
      const record = await secureReadProjectFile(PROJECT_DIR, relativePath, { maxBytes: MAX_RECORD_BYTES });
      const body: unknown = JSON.parse(record.buffer.toString('utf8'));
      if (!isRecord(body) || body.schema !== 'echo.content-attempt.v1'
        || body.runId !== attempt[1] || body.id !== attempt[2]) return unverified();
      const disclosure = await getRunDisclosure(attempt[1]);
      const current = await secureReadProjectFile(PROJECT_DIR, relativePath, { maxBytes: MAX_RECORD_BYTES });
      return current.sha256 === record.sha256 ? disclosure : unverified();
    }
    const owner = await findOutputOwner(relativePath);
    if (!owner) return unverified();
    const disclosure = await disclosureForRun(owner);
    const currentOwner = await findOutputOwner(relativePath);
    if (!currentOwner || currentOwner.run.run_id !== owner.run.run_id || currentOwner.sha256 !== owner.sha256) return unverified();
    await verifyOutputLocation(relativePath);
    return disclosure;
  } catch { return unverified(); }
}
