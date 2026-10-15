#!/usr/bin/env node
// Read-only #1828/#1690 evidence: never infer successful App CAS from a green
// Workflow. The independent consumer must have actually bound nonempty Git
// bytes to an authenticated source, ingester and publication receipt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'BestNathan/nession';
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PATHS = Object.freeze({
  source: '.github/workflows/acceptance-cases.yml',
  ingester: '.github/workflows/acceptance-case-ingest.yml',
  readback: '.github/workflows/store-receipt-readback.yml',
});
const roles = Object.freeze({
  source: ['Acceptance / Cases', 'push'],
  ingester: ['Acceptance / Case Ingest', 'workflow_run'],
  readback: ['Store / Receipt Readback', 'workflow_run'],
});
const numeric = n => Number.isSafeInteger(Number(n)) && Number(n) > 0;

function validRun(run, role, sha) {
  const [name, event] = roles[role];
  return run?.name === name &&
    run.path?.replace(/@refs\/heads\/main$/, '') === PATHS[role] &&
    run.event === event && run.status === 'completed' && run.conclusion === 'success' &&
    run.head_branch === 'main' && run.head_sha === sha &&
    run.repository?.full_name === REPO && run.head_repository?.full_name === REPO &&
    numeric(run.id) && numeric(run.run_attempt);
}
function requireArtifact(listing, run, name) {
  const items = listing?.artifacts;
  if (!Array.isArray(items) || items.length > 100) throw Error('untrusted artifact listing');
  const candidates = items.filter(x => x.name === name);
  if (candidates.length !== 1) throw Error('missing or duplicated authenticated artifact');
  const x = candidates[0];
  if (!numeric(x.id) || x.expired !== false || !DIGEST.test(x.digest || '') ||
      !numeric(x.size_in_bytes) || x.workflow_run?.id !== run.id ||
      x.workflow_run?.head_sha !== run.head_sha)
    throw Error('untrusted artifact provenance/expiry/digest');
  return x;
}

export function attestCaseReceipt({
  targetSha, source, ingester, readback, ingesterArtifacts,
  readbackArtifacts, statement,
}) {
  if (!SHA.test(targetSha)) throw Error('exact SHA required');
  for (const [role, run] of Object.entries({source, ingester, readback}))
    if (!validRun(run, role, targetSha)) throw Error('invalid ' + role + ' GitHub Run provenance');
  if (!(Date.parse(source.updated_at) <= Date.parse(ingester.created_at) &&
        Date.parse(ingester.updated_at) <= Date.parse(readback.created_at)))
    throw Error('readback ran before completed ingester/source');
  const publisher = requireArtifact(ingesterArtifacts, ingester,
    'run-store-receipt-' + ingester.id + '-' + ingester.run_attempt + '-case');
  const consumer = requireArtifact(readbackArtifacts, readback,
    'run-store-receipt-readback-' + readback.id + '-' + readback.run_attempt);
  if (statement?.kind !== 'run_store_receipt_readback' ||
      statement.trust_level !== 'github_actions_authenticated_not_independent_anchor' ||
      statement.store !== 'acceptance-results' ||
      statement.source_workflow !== PATHS.ingester ||
      String(statement.ingester_run_id) !== String(ingester.id) ||
      String(statement.ingester_attempt) !== String(ingester.run_attempt) ||
      String(statement.upstream_run_id) !== String(source.id) ||
      String(statement.source_run_id) !== String(source.id) ||
      Number(statement.artifact_id) !== publisher.id ||
      !SHA.test(String(statement.commit_sha || '')) ||
      !numeric(statement.checked_records) || !numeric(statement.changed_records) ||
      Number(statement.changed_records) > Number(statement.checked_records))
    throw Error('not a positive source-bound independently verified Git-byte receipt');
  return {
    schema_version: 1, kind: 'authenticated_positive_case_readback',
    target_sha: targetSha, source_run_id: source.id,
    source_run_attempt: source.run_attempt,
    source_artifact_workflow: PATHS.source,
    ingester_run_id: ingester.id, ingester_run_attempt: ingester.run_attempt,
    receipt_artifact_id: publisher.id, receipt_artifact_zip_sha256: publisher.digest.slice(7),
    readback_run_id: readback.id, readback_run_attempt: readback.run_attempt,
    readback_artifact_id: consumer.id, readback_artifact_zip_sha256: consumer.digest.slice(7),
    commit_sha: statement.commit_sha,
    checked_records: Number(statement.checked_records),
    changed_records: Number(statement.changed_records),
    attestation: 'separate successful main-owned read-only Workflow Git-byte verification; not an external independent anchor',
  };
}

// The readback's own verified.jsonl is produced AFTER its authenticated
// Git tree/record SHA256 checks. It is an independently uploaded artifact,
// NOT a comment, Issue body, PR result, or untrusted source-run artifact.
function downloadVerified(readback, repo) {
  const artifactName = 'run-store-receipt-readback-' + readback.id + '-' + readback.run_attempt;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-case-readback-'));
  try {
    execFileSync('gh', ['run', 'download', String(readback.id), '--repo', repo,
      '--name', artifactName, '--dir', tmp], {
      encoding: 'utf8', timeout: 35000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const file = path.join(tmp, 'verified.jsonl');
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() ||
        fs.statSync(file).size > 256 * 1024) return [];
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    if (!lines.length || lines.length > 40) return [];
    return lines.map(line => JSON.parse(line));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function collectAuthenticatedCaseReadbacks({
  repo, targetSha, runs, request, download = downloadVerified,
}) {
  if (repo !== REPO || !SHA.test(targetSha)) throw Error('unsupported repo/target SHA');
  const known = (Array.isArray(runs) ? runs : []).filter(x => x?.head_sha === targetSha);
  const sources = known.filter(x => validRun(x, 'source', targetSha));
  const ingesters = known.filter(x => validRun(x, 'ingester', targetSha));
  const readbacks = known.filter(x => validRun(x, 'readback', targetSha))
    .sort((a,b) => b.id - a.id).slice(0, 4);
  if (!sources.length || !ingesters.length || !readbacks.length) return [];
  const positives = [];
  for (const readback of readbacks) {
    const listing = await request('/repos/' + repo + '/actions/runs/' + readback.id +
      '/artifacts?per_page=100');
    // Green readbacks are legal no-ops; without a real verification artifact,
    // an empty verified.jsonl, or no matched Case source, do not issue a claim.
    let readbackArtifact;
    try {
      readbackArtifact = requireArtifact(listing, readback,
        'run-store-receipt-readback-' + readback.id + '-' + readback.run_attempt);
    } catch { continue; }
    if (!readbackArtifact) continue;
    const statements = await download(readback, repo);
    for (const statement of statements) {
      const ingester = ingesters.find(x => String(x.id) === String(statement?.ingester_run_id));
      const source = sources.find(x => String(x.id) === String(statement?.upstream_run_id));
      if (!ingester || !source) continue;
      const receipts = await request('/repos/' + repo + '/actions/runs/' + ingester.id +
        '/artifacts?per_page=100');
      // A malformed positive statement is an integrity failure. An absent
      // source-bound statement is simply missing evidence (Pending).
      positives.push(attestCaseReceipt({
        targetSha, source, ingester, readback,
        ingesterArtifacts: receipts, readbackArtifacts: listing, statement,
      }));
    }
    if (positives.length >= 4) break;
  }
  return positives.slice(0, 4);
}

export function selfTestCaseReceipts() {
  const sha = 'a'.repeat(40), base = {
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success',
    run_attempt: 1,
  };
  const source = {...base, id: 11, name: roles.source[0], event: roles.source[1],
    path: PATHS.source, updated_at: '2026-10-15T12:01:00Z'};
  const ingester = {...base, id: 12, name: roles.ingester[0], event: roles.ingester[1],
    path: PATHS.ingester, created_at: '2026-10-15T12:02:00Z',
    updated_at: '2026-10-15T12:03:00Z'};
  const readback = {...base, id: 13, name: roles.readback[0], event: roles.readback[1],
    path: PATHS.readback, created_at: '2026-10-15T12:04:00Z'};
  const artifact = (id, run, name) => ({id, name, expired:false, digest:'sha256:'+'b'.repeat(64),
    size_in_bytes:100, workflow_run:{id:run.id,head_sha:sha}});
  const ia={artifacts:[artifact(14,ingester,'run-store-receipt-12-1-case')]};
  const ra={artifacts:[artifact(15,readback,'run-store-receipt-readback-13-1')]};
  const statement={kind:'run_store_receipt_readback',
    trust_level:'github_actions_authenticated_not_independent_anchor',
    store:'acceptance-results',source_workflow:PATHS.ingester,
    ingester_run_id:'12',ingester_attempt:'1',upstream_run_id:'11',
    source_run_id:'11',artifact_id:14,commit_sha:'c'.repeat(40),
    checked_records:2,changed_records:2};
  const good={targetSha:sha,source,ingester,readback,ingesterArtifacts:ia,
    readbackArtifacts:ra,statement};
  assert.equal(attestCaseReceipt(good).changed_records,2);
  assert.equal(attestCaseReceipt(good).receipt_artifact_id,14);
  for(const changed of [
    {...good, targetSha:'d'.repeat(40)},
    {...good, source:{...source,status:'in_progress'}},
    {...good, source:{...source,head_sha:'d'.repeat(40)}},
    {...good, readback:{...readback,event:'repository_dispatch'}},
    {...good, readback:{...readback,path:PATHS.ingester}},
    {...good, readback:{...readback,repository:{full_name:'foreign/repo'}}},
    {...good, ingester:{...ingester,created_at:'2026-10-15T12:00:00Z'}},
    {...good, ingesterArtifacts:{artifacts:[]}},
    {...good, ingesterArtifacts:{artifacts:ia.artifacts.map(x=>({...x,expired:true}))}},
    {...good, readbackArtifacts:{artifacts:ra.artifacts.map(x=>({...x,digest:'bad'}))}},
    ...[
      {changed_records:0},{changed_records:3},{checked_records:0},
      {source_run_id:'19'},{ingester_attempt:'2'},{artifact_id:999},
      {trust_level:'independent_anchor'},{commit_sha:'fake'},
      {source_workflow:PATHS.source},
    ].map(p=>({...good,statement:{...statement,...p}})),
  ]) assert.throws(()=>attestCaseReceipt(changed),/invalid|untrusted|positive|before|exact/);
  console.log('authenticated Case receipt provenance, positive and negative self-tests passed');
}
