#!/usr/bin/env node
// #3072: historical exact-SHA Staging integration proof.
// The rolling current deployment and the newest three Deploy / Identity Runs
// cannot answer whether a *past* integration SHA actually ran. Read only the
// append-only, by-SHA deployment index and re-attest its source GitHub Run.
// This collector never grants an SC verdict or accepts a desired-state-only
// GitOps write as a deployment observation.
import assert from 'node:assert/strict';
import { enrichReceipt, indexRecord, validateStoredRecord } from './deployment-attestation-ingest.mjs';

const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/;
const INTEGRATION = /<!-- nession-convergence-batch:v1 branch=([a-z][a-z0-9-]{0,62}) main=([a-f0-9]{40}) lane=([a-f0-9]{40}) head=([a-f0-9]{40}) -->/;
const MAX_INDEX_ENTRIES = 100;
const MAX_VERIFIED = 3;
const NAME = /^([1-9][0-9]*)-([1-9][0-9]*)-([a-z][a-z0-9-]{0,62})\.json$/;

function reject(reason) { throw Error('staging-history-proof: ' + reason); }

export function exactBatch(body) {
  const matches = [...String(body ?? '').matchAll(new RegExp(INTEGRATION.source, 'g'))];
  if (matches.length === 0) return null;
  if (matches.length !== 1) reject('ambiguous exact batch identity');
  const [, branch, main, lane, head] = matches[0];
  if (new Set([main, lane, head]).size !== 3) reject('duplicate batch SHA');
  return Object.freeze({ branch, main, lane, head });
}

function parseContents(entry, expectedPath) {
  if (!entry || entry.type !== 'file' || entry.path !== expectedPath ||
      entry.encoding !== 'base64' || !Number.isSafeInteger(entry.size) ||
      entry.size < 1 || entry.size > 65536 ||
      !/^[A-Za-z0-9+/\r\n=]+$/.test(String(entry.content ?? ''))) {
    reject('invalid append-only record content: ' + expectedPath);
  }
  const raw = Buffer.from(entry.content.replace(/\s/g, ''), 'base64');
  if (raw.length !== entry.size) reject('append-only record size mismatch');
  try { return JSON.parse(raw.toString('utf8')); }
  catch { reject('invalid append-only record JSON'); }
}

function normalizedPath(path) {
  return '/repos/' + REPO + '/contents/' + path + '?ref=acceptance-results';
}

export function verifySource(record, index, nativeRun, nativeJobs) {
  const { item, source, execution_id, record_path } = validateStoredRecord(record);
  if (JSON.stringify(indexRecord(record)) !== JSON.stringify(index) ||
      index.execution_id !== execution_id || index.record !== record_path) {
    reject('index and immutable deployment record disagree');
  }
  if (!nativeRun || nativeRun.id !== source.run_id ||
      nativeRun.run_attempt !== source.run_attempt ||
      nativeRun.workflow_id !== source.workflow_id ||
      nativeRun.head_sha !== source.head_sha ||
      nativeRun.head_branch !== 'main' ||
      nativeRun.name !== 'Deploy / Identity' ||
      String(nativeRun.path ?? '').split('@')[0] !== '.github/workflows/deploy-identity.yml' ||
      nativeRun.event !== 'workflow_dispatch' ||
      nativeRun.status !== 'completed' || nativeRun.conclusion !== 'success' ||
      nativeRun.repository?.full_name !== REPO ||
      nativeRun.head_repository?.full_name !== REPO) {
    reject('historical source GitHub Run identity mismatch');
  }
  const jobs = Array.isArray(nativeJobs?.jobs) ? nativeJobs.jobs : [];
  const attest = jobs.filter(j => j.name === 'attest' &&
    j.run_id === nativeRun.id && j.run_attempt === nativeRun.run_attempt &&
    j.conclusion === 'success');
  if (attest.length !== 1) reject('missing exact-attempt attestation Job success');
  const steps = attest[0].steps ?? [];
  if (!steps.some(s => s.name === 'Verify read-only Kubernetes identity' &&
      s.conclusion === 'success') ||
      !steps.some(s => s.name === 'Observe deployed workloads' &&
        s.conclusion === 'success') ||
      !steps.some(s => ['Attest deployment identity',
        'Wait boundedly for reconciled Staging workload identity'].includes(s.name) &&
        s.conclusion === 'success')) {
    reject('no independently completed Kubernetes observation steps');
  }
  return Object.freeze({
    kind: 'verified_historical_staging_deployment',
    source_sha: item.source_sha,
    environment_id: item.environment_id,
    observed_at: item.observed_at,
    gitops_revision: item.gitops_revision,
    execution_id,
    source_run_id: source.run_id,
    source_run_attempt: source.run_attempt,
    source_workflow: 'Deploy / Identity',
    store_record: record_path,
    image_digests: Object.fromEntries(item.images.map(i => [i.role, i.digest])),
    workload_readiness: item.workloads.map(w => ({
      role: w.role, uid: w.uid, generation: w.generation,
      observed_generation: w.observed_generation, ready: w.ready,
    })),
  });
}

export async function collectExactStagingBatchProof({ repo, targetSha, body, get }) {
  if (repo !== REPO || !SHA.test(String(targetSha ?? '')) || typeof get !== 'function') {
    reject('invalid exact target or repository');
  }
  const batch = exactBatch(body);
  if (!batch) return null; // Ordinary Staging Issues keep their existing collector.
  const [mergeCommit, integration] = await Promise.all([
    get('/repos/' + REPO + '/commits/' + targetSha),
    get('/repos/' + REPO + '/commits/' + batch.head),
  ]);
  const mergeParents = (mergeCommit?.parents ?? []).map(p => p.sha);
  const headParents = (integration?.parents ?? []).map(p => p.sha);
  if (mergeCommit?.sha !== targetSha || integration?.sha !== batch.head ||
      mergeParents.length !== 2 ||
      mergeParents[0] !== batch.lane || mergeParents[1] !== batch.head ||
      headParents.length !== 2 ||
      headParents[0] !== batch.lane || headParents[1] !== batch.main) {
    reject('protected merge and source batch parent SHAs do not match');
  }
  const prefix = 'indexes/by-sha/' + targetSha + '/deployment/';
  let entries;
  try { entries = await get(normalizedPath(prefix.slice(0, -1))); }
  catch (error) {
    if (/^GitHub API 404\b/.test(String(error?.message ?? ''))) entries = [];
    else throw error;
  }
  if (!Array.isArray(entries) || entries.length > MAX_INDEX_ENTRIES) {
    reject('missing or unbounded historical deployment index listing');
  }
  const selected = entries
    .filter(entry => entry.type === 'file' && NAME.test(entry.name) &&
      entry.name.endsWith('-' + batch.branch + '.json'))
    .sort((a,b) => b.name.localeCompare(a.name, undefined, {numeric: true}))
    .slice(0, MAX_VERIFIED);
  const verified = [];
  for (const entry of selected) {
    const path = prefix + entry.name;
    if (entry.path !== path) reject('historical index path mismatch');
    const index = parseContents(await get(normalizedPath(path)), path);
    const match = NAME.exec(entry.name);
    if (!match || index.target_sha !== targetSha ||
        index.environment_id !== batch.branch ||
        index.source?.run_id !== Number(match[1]) ||
        index.source?.run_attempt !== Number(match[2]) ||
        !/^runs\/\d{4}-\d{2}-\d{2}\/\d+-\d+\/deployment\/[a-z0-9-]+\.json$/.test(index.record)) {
      reject('historical exact-SHA index mismatch');
    }
    const record = parseContents(
      await get(normalizedPath(index.record)), index.record);
    const [run, jobs] = await Promise.all([
      get('/repos/' + REPO + '/actions/runs/' + index.source.run_id),
      get('/repos/' + REPO + '/actions/runs/' + index.source.run_id +
        '/attempts/' + index.source.run_attempt + '/jobs?per_page=100'),
    ]);
    verified.push(verifySource(record, index, run, jobs));
  }
  return Object.freeze({
    kind: 'verified_source_bound_staging_integration',
    integration_sha: batch.head, main_sha: batch.main, lane_sha: batch.lane,
    protected_merge_sha: targetSha,
    merge_parents: mergeParents, integration_parents: headParents,
    historical_deployments: verified,
    missing_exact_deployment_attestation: verified.length === 0,
    // The evidence is read-only. Only the canonical Issue Acceptor may Pass.
  });
}

export async function selfTest() {
  const main = 'a'.repeat(40), lane = 'b'.repeat(40),
    head = 'c'.repeat(40), target = 'd'.repeat(40);
  const batch = '<!-- nession-convergence-batch:v1 branch=staging main=' +
    main + ' lane=' + lane + ' head=' + head + ' -->';
  assert.deepEqual(exactBatch(batch), {branch:'staging', main, lane, head});
  assert.equal(exactBatch('no marker'), null);
  assert.throws(() => exactBatch(batch + batch), /ambiguous/);
  const commit = {sha:target,parents:[{sha:lane},{sha:head}]};
  const integrated = {sha:head,parents:[{sha:lane},{sha:main}]};
  const missing = await collectExactStagingBatchProof({
    repo:REPO,targetSha:target,body:batch,
    get: async p => {
      if (p.endsWith('/commits/' + target)) return commit;
      if (p.endsWith('/commits/' + head)) return integrated;
      throw Error('GitHub API 404 for ' + p);
    },
  });
  assert.equal(missing.missing_exact_deployment_attestation, true);
  assert.deepEqual(missing.merge_parents, [lane,head]);
  await assert.rejects(() => collectExactStagingBatchProof({
    repo:REPO,targetSha:target,body:batch,
    get: async p => p.endsWith('/commits/' + target)
      ? {...commit,parents:[{sha:lane},{sha:main}]} : integrated,
  }), /parent SHAs/);
  await assert.rejects(() => collectExactStagingBatchProof({
    repo:REPO,targetSha:target,body:batch,
    get: async p => p.endsWith('/commits/' + target) ? commit :
      p.endsWith('/commits/' + head) ? integrated :
      [{type:'file',name:'1-1-staging.json',path:'forged'}],
  }), /historical index path mismatch/);
  // Positive example: the SAME immutable bytes are indexed by exact target,
  // and the independent native Run/Job/Step facts must corroborate them.
  const repository = 'ghcr.io/bestnathan/nession';
  const roles = ['agent', 'server', 'ui'];
  const receipt = {
    schema_version: 1, kind: 'nession_deployment_attestation',
    status: 'Attested', environment_id: 'staging', namespace: 'nession',
    cluster_context: 'ci', gitops_revision: 'e'.repeat(40),
    observed_at: '2026-11-08T14:03:30Z', source_sha: target,
    images: roles.map((role,i) => ({
      role, repository, declared_repository: repository,
      tag: role + '-ddddddd', digest: 'sha256:' + String(i+1).repeat(64),
    })),
    workloads: roles.map((role,i) => ({
      role, name: 'nession-' + role + '-staging', namespace: 'nession',
      uid: 'uid-' + role, generation: 3, observed_generation: 3, ready: true,
      image: repository + ':' + role + '-ddddddd',
      image_id: repository + '@sha256:' + String(i+1).repeat(64),
      repository, declared_repository: repository,
      digest: 'sha256:' + String(i+1).repeat(64),
    })),
  };
  const source = { repository:REPO, run_id:123, run_attempt:1, workflow_id:42,
    event:'workflow_dispatch', head_sha:main, head_branch:'main' };
  const durable = 'runs/2026-11-08/123-1/deployment/staging.json';
  const stored = enrichReceipt(receipt, {
    source, recordPath: durable,
    workflowUrl:'https://github.com/BestNathan/nession/actions/runs/123',
  });
  const index = indexRecord(stored);
  const indexPath = 'indexes/by-sha/' + target + '/deployment/123-1-staging.json';
  const content = (path,value) => ({
    type:'file', path, encoding:'base64',
    size:Buffer.byteLength(JSON.stringify(value)),
    content:Buffer.from(JSON.stringify(value)).toString('base64'),
  });
  const run = {id:123,run_attempt:1,workflow_id:42,head_sha:main,head_branch:'main',
    name:'Deploy / Identity',path:'.github/workflows/deploy-identity.yml',
    event:'workflow_dispatch',status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const jobs = {jobs:[{name:'attest',run_id:123,run_attempt:1,conclusion:'success',
    steps:[
      {name:'Verify read-only Kubernetes identity',conclusion:'success'},
      {name:'Observe deployed workloads',conclusion:'success'},
      {name:'Attest deployment identity',conclusion:'success'},
    ]}]};
  const get = async p => {
    if (p.endsWith('/commits/' + target)) return commit;
    if (p.endsWith('/commits/' + head)) return integrated;
    if (p === normalizedPath(indexPath.slice(0,-'123-1-staging.json'.length))) {
      return [{type:'file',path:indexPath,name:'123-1-staging.json'}];
    }
    if (p === normalizedPath(indexPath)) return content(indexPath,index);
    if (p === normalizedPath(durable)) return content(durable,stored);
    if (p.endsWith('/actions/runs/123')) return run;
    if (p.includes('/actions/runs/123/attempts/1/jobs')) return jobs;
    throw Error('unexpected historical proof API request: ' + p);
  };
  const actual = await collectExactStagingBatchProof({repo:REPO,
    targetSha:target,body:batch,get});
  assert.equal(actual.historical_deployments.length,1);
  assert.equal(actual.missing_exact_deployment_attestation,false);
  assert.deepEqual(actual.historical_deployments[0].image_digests, {
    agent:'sha256:'+'1'.repeat(64), server:'sha256:'+'2'.repeat(64),
    ui:'sha256:'+'3'.repeat(64),
  });
  await assert.rejects(() => collectExactStagingBatchProof({
    repo:REPO,targetSha:target,body:batch,
    get:p => p.endsWith('/actions/runs/123')
      ? Promise.resolve({...run,conclusion:'failure'}) : get(p),
  }), /source GitHub Run identity mismatch/);
  await assert.rejects(() => collectExactStagingBatchProof({
    repo:REPO,targetSha:target,body:batch,
    get:p => p.includes('/actions/runs/123/attempts/1/jobs')
      ? Promise.resolve({jobs:[]}) : get(p),
  }), /missing exact-attempt attestation Job/);
  console.log('staging history proof: exact merge ancestry, immutable Run/Job proof, missing/stale/forged cases passed');
}

if (process.argv[1]?.endsWith('acceptance-staging-history-proof.mjs')) {
  if (process.argv[2] === 'self-test') selfTest().catch(e => {
    console.error(e); process.exitCode = 2;
  });
  else { console.error('usage: self-test'); process.exitCode = 2; }
}
