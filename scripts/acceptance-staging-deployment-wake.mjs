#!/usr/bin/env node
// #3072: post-ingest, exact-source Staging Acceptance wake.
// The trusted deployment ingester emits a bounded hint only AFTER its
// append-only Store write. This verifier re-reads the native GitHub source,
// the immutable by-SHA record, and the original K8s attestation Run/Job before
// selecting the existing merged-Staging Acceptance evaluator. No SC writer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { indexRecord, validateStoredRecord } from './deployment-attestation-ingest.mjs';
import { normalizedPath, parseContents, verifySource } from './acceptance-staging-history-proof.mjs';

const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/;
const PATH = /^runs\/\d{4}-\d{2}-\d{2}\/([1-9][0-9]*)-([1-9][0-9]*)\/deployment\/(staging(?:-01)?)\.json$/;
const PREFIX = 'STAGING_ACCEPTANCE_WAKE_V1 ';
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_RECEIPTS = 2;

function fail(message) { throw Error('staging acceptance wake: ' + message); }
function positive(x) { return Number.isSafeInteger(x) && x > 0; }
function shape(r) {
  if (r?.schema_version !== 1 || r?.kind !== 'staging_deployment_ingested' ||
      r?.repository !== REPO ||
      !positive(r.ingest_run_id) || !positive(r.ingest_run_attempt) ||
      !positive(r.source_run_id) || !positive(r.source_run_attempt) ||
      !SHA.test(String(r.target_sha ?? '')) ||
      !['staging','staging-01'].includes(r.environment_id) ||
      !/^[a-f0-9]{64}$/.test(String(r.execution_id ?? '')) ||
      typeof r.record_path !== 'string') fail('invalid wake identity');
  const m = PATH.exec(r.record_path);
  if (!m || Number(m[1]) !== r.source_run_id ||
      Number(m[2]) !== r.source_run_attempt ||
      m[3] !== r.environment_id) fail('record path not source aligned');
  return r;
}

export function receiptFromRecord(record, ingestRunId, ingestAttempt) {
  const {item, source, record_path, execution_id} = validateStoredRecord(record);
  return shape({
    schema_version:1,kind:'staging_deployment_ingested',repository:REPO,
    ingest_run_id:Number(ingestRunId), ingest_run_attempt:Number(ingestAttempt),
    source_run_id:source.run_id, source_run_attempt:source.run_attempt,
    target_sha:item.source_sha, environment_id:item.environment_id,
    record_path, execution_id,
  });
}

export function parseWakeLog(log) {
  if (typeof log !== 'string' || log.length >= MAX_LOG_BYTES) fail('invalid wake job log');
  const found = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes(PREFIX)) continue;
    const match = line.match(/STAGING_ACCEPTANCE_WAKE_V1 (\{.*\})\s*$/);
    // An Actions command echo may contain the prefix as source text;
    // only a complete emitted JSON record is accepted.
    if (!match) continue;
    let entry;
    try { entry = JSON.parse(match[1]); }
    catch { fail('malformed framed wake record'); }
    found.push(shape(entry));
    if (found.length > MAX_RECEIPTS) fail('unbounded wake records');
  }
  const unique = new Set(found.map(r => r.record_path));
  if (unique.size !== found.length) fail('duplicate wake record');
  return found;
}

function trustedRun(run, expected) {
  return Boolean(run && expected &&
    run.id === expected.id && run.run_attempt === expected.run_attempt &&
    run.repository?.full_name === REPO && run.head_repository?.full_name === REPO &&
    run.name === 'Deploy / Identity Ingest' &&
    String(run.path ?? '').split('@')[0] === '.github/workflows/deploy-identity-ingest.yml' &&
    ['workflow_run','schedule','push'].includes(run.event) &&
    run.head_branch === 'main' && SHA.test(String(run.head_sha ?? '')) &&
    run.status === 'completed' && run.conclusion === 'success');
}

export async function verifyWake({event,get,getText}) {
  const candidate = event?.workflow_run;
  if (typeof get !== 'function' || typeof getText !== 'function' ||
      !positive(candidate?.id) || !positive(candidate?.run_attempt)) {
    fail('missing trusted workflow_run identity');
  }
  const run = await get('/repos/' + REPO + '/actions/runs/' + candidate.id);
  if (!trustedRun(run, candidate)) fail('untrusted deployment-ingest source');
  const jobs = await get('/repos/' + REPO + '/actions/runs/' + run.id +
    '/attempts/' + run.run_attempt + '/jobs?per_page=100');
  const matches = (jobs?.jobs ?? []).filter(j => j.name === 'ingest' &&
    j.run_id === run.id && j.run_attempt === run.run_attempt &&
    j.conclusion === 'success');
  if (matches.length !== 1) fail('missing or ambiguous successful ingester Job');
  const steps = matches[0].steps ?? [];
  for (const name of [
    'Append compact immutable records and SHA indexes',
    'Verify immutable Git bytes before uploading Run Store receipts',
    'Emit source-aligned Staging Acceptance wake',
  ]) {
    if (!steps.some(s => s.name === name && s.conclusion === 'success')) {
      // No-op schedule/push ingester has no emit step, so it cannot wake an SC.
      return null;
    }
  }
  const log = await getText('/repos/' + REPO + '/actions/jobs/' + matches[0].id + '/logs');
  const receipts = parseWakeLog(log);
  if (!receipts.length) fail('successful wake step did not produce a receipt');
  if (receipts.some(r => r.ingest_run_id !== run.id ||
      r.ingest_run_attempt !== run.run_attempt)) fail('wake receipt/run mismatch');
  // Current staging Issue selector accepts a single SHA per run. A source
  // identity run is per environment; mixed SHA evidence must not be combined.
  const targets = new Set(receipts.map(r => r.target_sha));
  if (targets.size !== 1) fail('ambiguous deployment source SHAs');
  for (const receipt of receipts) {
    const path = 'indexes/by-sha/' + receipt.target_sha + '/deployment/' +
      receipt.source_run_id + '-' + receipt.source_run_attempt + '-' +
      receipt.environment_id + '.json';
    const idx = parseContents(await get(normalizedPath(path)), path);
    if (idx.record !== receipt.record_path || idx.execution_id !== receipt.execution_id ||
        idx.target_sha !== receipt.target_sha ||
        idx.environment_id !== receipt.environment_id) {
      fail('wake/store SHA index mismatch');
    }
    const record = parseContents(
      await get(normalizedPath(receipt.record_path)), receipt.record_path);
    const [sourceRun, sourceJobs] = await Promise.all([
      get('/repos/' + REPO + '/actions/runs/' + receipt.source_run_id),
      get('/repos/' + REPO + '/actions/runs/' + receipt.source_run_id +
        '/attempts/' + receipt.source_run_attempt + '/jobs?per_page=100'),
    ]);
    const verified = verifySource(record, idx, sourceRun, sourceJobs);
    if (verified.source_sha !== receipt.target_sha ||
        verified.environment_id !== receipt.environment_id ||
        verified.execution_id !== receipt.execution_id) {
      fail('wake/store/source immutable identity mismatch');
    }
  }
  return Object.freeze({
    target_sha: receipts[0].target_sha,
    environment_id: receipts[0].environment_id,
    source_ingest_run_id: run.id,
    source_ingest_attempt: run.run_attempt,
    verified_attestations: receipts.length,
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'self-test') {
    const sample = {
      schema_version:1,kind:'staging_deployment_ingested',repository:REPO,
      ingest_run_id:50,ingest_run_attempt:1,source_run_id:30,source_run_attempt:1,
      target_sha:'a'.repeat(40),environment_id:'staging',
      record_path:'runs/2026-11-08/30-1/deployment/staging.json',
      execution_id:'b'.repeat(64),
    };
    assert.deepEqual(parseWakeLog('noise\n'+PREFIX+JSON.stringify(sample)+'\n'),[sample]);
    assert.deepEqual(parseWakeLog('noise'),[]);
    assert.throws(() => parseWakeLog(PREFIX+JSON.stringify(sample)+'\n'+
      PREFIX+JSON.stringify(sample)),/duplicate/);
    assert.throws(() => parseWakeLog(PREFIX+JSON.stringify({...sample,
      target_sha:'short'})),/invalid wake/);
    assert.throws(() => parseWakeLog(PREFIX+JSON.stringify({...sample,
      record_path:'../staging.json'})),/record path/);
    await assert.rejects(() => verifyWake({event:{workflow_run:{id:50,run_attempt:1}},
      get:async() => ({id:50,run_attempt:1,name:'other'}),
      getText:async()=>''}),/untrusted deployment-ingest/);
    console.log('staging deployment wake: source, SHA, duplicate and forged receipt fixtures passed');
    return;
  }
  if (mode === 'emit') {
    const [ingestId,attempt,root,list] = process.argv.slice(3);
    if (!/^[1-9][0-9]*$/.test(String(ingestId)) ||
        !/^[1-9][0-9]*$/.test(String(attempt)) ||
        !root || !list) fail('emit requires native ingester identity and records');
    const names = fs.readFileSync(list,'utf8').split(/\r?\n/).filter(Boolean);
    if (names.length < 1 || names.length > MAX_RECEIPTS) fail('invalid persisted-record count');
    for (const name of names) {
      if (!PATH.test(name) || path.normalize(name) !== name) fail('invalid emit record path');
      const record = JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
      const receipt = receiptFromRecord(record,ingestId,attempt);
      const idxName = 'indexes/by-sha/' + receipt.target_sha + '/deployment/' +
        receipt.source_run_id + '-' + receipt.source_run_attempt + '-' +
        receipt.environment_id + '.json';
      const index = JSON.parse(fs.readFileSync(path.join(root,idxName),'utf8'));
      if (JSON.stringify(index) !== JSON.stringify(indexRecord(record))) {
        fail('missing immutable by-SHA index before wake emission');
      }
      process.stdout.write(PREFIX + JSON.stringify(receipt) + '\n');
    }
    return;
  }
  if (mode === 'verify') {
    const [eventPath,out] = process.argv.slice(3);
    if (!eventPath || !out) fail('verify requires event and output file');
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) fail('trusted GitHub API token required');
    const getResponse = async (route, raw = false) => {
      const response = await fetch('https://api.github.com'+route,{
        headers:{'Accept':'application/vnd.github+json',
          'Authorization':'Bearer '+token,'User-Agent':'nession-staging-acceptance-wake',
          'X-GitHub-Api-Version':'2022-11-28'},
        signal:AbortSignal.timeout(30000),
      });
      if (!response.ok) fail('GitHub API '+response.status+' for '+route);
      const data = await (raw ? response.text() : response.json());
      if (raw && data.length >= MAX_LOG_BYTES) fail('oversized source log');
      return data;
    };
    const result = await verifyWake({
      event:JSON.parse(fs.readFileSync(eventPath,'utf8')),
      get:route=>getResponse(route), getText:route=>getResponse(route,true),
    });
    fs.writeFileSync(out,JSON.stringify(result) + '\n');
    process.stdout.write(result
      ? 'Authenticated Staging deploy ingestion for '+result.target_sha+'\n'
      : 'No eligible deployed receipt from the trusted source\n');
    return;
  }
  fail('usage: self-test | emit INGEST_ID ATTEMPT STORE_ROOT RECORD_PATHS | verify EVENT_JSON OUTPUT_JSON');
}
if (process.argv[1]?.endsWith('acceptance-staging-deployment-wake.mjs')) {
  main().catch(e => { console.error(e); process.exitCode=2; });
}
