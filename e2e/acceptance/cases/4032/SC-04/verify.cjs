'use strict';
// #4032 SC-04: GHCR-only staging GitOps + real, immutable Deployment Identity.
// No credentials, registry writes, kubectl actions or ACR-success dependency.
// The trusted deployed Acceptance runner independently requires a fresh,
// environment/SHA-bound attestation before this compatibility Case can run.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/mcp-cases.cjs');

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const REGISTRY = 'ghcr.io/bestnathan/nession';
const FIX = '4366711e41dbbac056ba7644de176f5dc7c5ea32'; // #4035 merged source
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEPLOYED = ['agent', 'server', 'ui'];
const PUBLISHED = ['agent', 'mcp', 'server', 'ui'];

class Unobservable extends Error {}
const safe = x => String(x ?? '').replace(/[^A-Za-z0-9 .,_:/@()-]/g, ' ').slice(0, 170);

async function get(route) {
  let response;
  try {
    response = await fetch(API + route, {
      headers: { Accept: 'application/vnd.github+json',
        'User-Agent': 'nession-4032-ghcr-deployed-case' },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Unobservable('read-only GitHub evidence temporarily unavailable');
  }
  if (!response.ok) {
    if ([403, 404, 408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Unobservable('source-aligned deployment evidence not yet readable');
    }
    throw Error('unexpected GitHub read status ' + response.status);
  }
  return response.json();
}

function rolesExactly(list, expected, label) {
  assert.ok(Array.isArray(list), label + ' must be an array');
  assert.deepEqual(list.map(x => x.role).sort(), [...expected].sort(),
    label + ' must include exactly the required roles');
}

function overlayImages(yaml, expected) {
  const records = [];
  let current = null;
  for (const line of String(yaml).split(/\r?\n/)) {
    const name = line.match(/^\s*-\s+name:\s*(\S+)\s*$/);
    if (name) {
      current = { name: name[1] };
      records.push(current);
      continue;
    }
    const field = line.match(/^\s+(newName|newTag):\s*(\S+)\s*$/);
    if (field && current) current[field[1]] = field[2];
  }
  const byRole = new Map();
  for (const role of expected) {
    const name = 'ghcr.io/bestnathan/nession-' + role;
    const entries = records.filter(x => x.name === name);
    assert.equal(entries.length, 1, role + ' must have exactly one GitOps image mapping');
    byRole.set(role, entries[0]);
  }
  return byRole;
}

function assertGHCRDesired(yaml, roles, sha) {
  const images = overlayImages(yaml, roles);
  for (const role of roles) {
    const item = images.get(role);
    assert.equal(item.newName, REGISTRY, role + ' GitOps must deploy GHCR');
    assert.equal(item.newTag, role + '-' + sha.slice(0, 7),
      role + ' GitOps tag must match immutable source');
  }
}

// The canonical trusted policy attests the Nession Agent/Server/UI pods;
// standalone MCP uses its own GitOps overlay, not a fabricated 4th receipt.
function attestation(index, record, sha) {
  assert.match(sha, SHA);
  assert.equal(index.schema_version, 1);
  assert.equal(index.mode, 'deployment');
  assert.equal(index.environment_id, 'staging');
  assert.equal(index.target_sha, sha);
  assert.match(index.gitops_revision, SHA);
  assert.match(index.execution_id, /^[0-9a-f]{64}$/);
  assert.equal(index.source.repository, REPO);
  assert.equal(record.schema_version, 1);
  assert.equal(record.kind, 'nession_deployment_attestation');
  assert.equal(record.status, 'Attested');
  assert.equal(record.environment_id, 'staging');
  assert.equal(record.source_sha, sha);
  assert.equal(record.gitops_revision, index.gitops_revision);
  assert.equal(record.execution_id, index.execution_id);
  assert.ok(Number.isFinite(Date.parse(record.observed_at)));
  const source = record.provenance?.verified_source;
  for (const key of ['repository','run_id','run_attempt','workflow_id',
    'head_sha','head_branch']) {
    assert.equal(source?.[key], index.source[key],
      'immutable Deploy Identity Run provenance ' + key);
  }
  assert.equal(source.event, 'workflow_run');
  assert.equal(source.head_branch, 'main');
  rolesExactly(record.images, DEPLOYED, 'observed image roles');
  rolesExactly(record.workloads, DEPLOYED, 'ready workloads');
  const digests = new Map();
  for (const image of record.images) {
    assert.equal(image.declared_repository, REGISTRY);
    assert.equal(image.repository, REGISTRY,
      'ACR mirror is not a deployed source');
    assert.equal(image.tag, image.role + '-' + sha.slice(0, 7));
    assert.match(image.digest, DIGEST);
    digests.set(image.role, image.digest);
  }
  for (const workload of record.workloads) {
    assert.equal(workload.ready, true);
    assert.equal(workload.namespace, 'nession');
    assert.equal(workload.name, 'nession-' + workload.role + '-staging');
    assert.ok(typeof workload.uid === 'string' && workload.uid.length > 10);
    assert.ok(Number.isSafeInteger(workload.generation) &&
      workload.generation > 0);
    assert.equal(workload.observed_generation, workload.generation);
    assert.equal(workload.repository, REGISTRY);
    assert.equal(workload.digest, digests.get(workload.role));
    assert.equal(workload.image,
      REGISTRY + ':' + workload.role + '-' + sha.slice(0, 7));
    assert.equal(workload.image_id, REGISTRY + '@' + digests.get(workload.role));
  }
  const remote = record.remote_observation;
  assert.equal(remote?.kind, 'nession_remote_staging_observation');
  assert.equal(remote.status, 'Observed');
  assert.equal(remote.source_sha, sha);
  assert.equal(remote.gitops_revision, index.gitops_revision);
  assert.ok(Array.isArray(remote.samples) && remote.samples.length > 0);
  for (const sample of remote.samples) {
    rolesExactly(sample.workloads, DEPLOYED, 'remote workload samples');
    for (const workload of sample.workloads) {
      assert.equal(workload.ready, true);
      assert.equal(workload.generation, workload.observed_generation);
      assert.equal(workload.digest, digests.get(workload.role));
    }
  }
  return { gitops: index.gitops_revision, digests, sourceRun: source.run_id,
    sourceAttempt: source.run_attempt, observed: record.observed_at };
}

function fixtures() {
  const sha = 'a'.repeat(40);
  const digest = 'sha256:' + 'b'.repeat(64);
  const gitops = 'c'.repeat(40);
  const images = DEPLOYED.map(role => ({role,declared_repository: REGISTRY,
    repository: REGISTRY,tag: role + '-aaaaaaa',digest}));
  const workloads = DEPLOYED.map(role => ({role,ready:true,namespace:'nession',
    name:'nession-'+role+'-staging',uid:'uuid-1234567890-'+role,
    generation:2,observed_generation:2,repository:REGISTRY,digest,
    image:REGISTRY+':'+role+'-aaaaaaa',image_id:REGISTRY+'@'+digest}));
  const source = {repository:REPO,run_id:101,run_attempt:1,workflow_id:99,
    head_sha:'d'.repeat(40),head_branch:'main',event:'workflow_run'};
  const idx = {schema_version:1,mode:'deployment',environment_id:'staging',
    target_sha:sha,gitops_revision:gitops,execution_id:'e'.repeat(64),
    source:{...source}};
  const record={schema_version:1,kind:'nession_deployment_attestation',
    status:'Attested',environment_id:'staging',source_sha:sha,
    gitops_revision:gitops,execution_id:idx.execution_id,
    observed_at:'2026-11-19T00:00:00Z',images,workloads,
    provenance:{verified_source:{...source}},
    remote_observation:{kind:'nession_remote_staging_observation',
      status:'Observed',source_sha:sha,gitops_revision:gitops,
      samples:[{workloads:DEPLOYED.map(role=>({
        role,ready:true,generation:2,observed_generation:2,digest}))}]}};
  assert.equal(attestation(idx,record,sha).sourceRun,101);
  function rejects(fn) {
    const copy = structuredClone(record);
    fn(copy);
    assert.throws(() => attestation(idx,copy,sha));
  }
  rejects(x=>{x.images[0].repository='registry.example.com/acr'});
  rejects(x=>{x.images.pop()});
  rejects(x=>{x.workloads[0].ready=false});
  rejects(x=>{x.workloads[1].image_id='registry.example.com@'+digest});
  rejects(x=>{x.workloads[2].observed_generation=1});
  rejects(x=>{x.remote_observation.samples[0].workloads[0].digest =
    'sha256:'+'f'.repeat(64)});
  rejects(x=>{x.source_sha='f'.repeat(40)});
  rejects(x=>{x.provenance.verified_source.run_id=102});
  assertGHCRDesired(
    'images:\n- name: ghcr.io/bestnathan/nession-mcp\n  newName: '+REGISTRY+
    '\n  newTag: mcp-aaaaaaa\n', ['mcp'],sha);
  assert.throws(()=>assertGHCRDesired(
    'images:\n- name: ghcr.io/bestnathan/nession-mcp\n'+
    '  newName: registry.example.com/acr\n  newTag: mcp-aaaaaaa\n',
    ['mcp'],sha));
  assert.throws(()=>assertGHCRDesired('images: []', ['mcp'], sha));
}

async function fileAt(path, rev) {
  assert.ok(SHA.test(rev) || rev === 'acceptance-results',
    'only an immutable GitOps commit or canonical deployment-store ref is allowed');
  const file = await get('/contents/' + path + '?ref=' + rev);
  assert.equal(file.type, 'file');
  assert.equal(file.encoding, 'base64');
  assert.ok(typeof file.content === 'string' && file.content.length < 120000);
  return Buffer.from(file.content.replace(/\s/g,''), 'base64').toString('utf8');
}
async function jsonAt(path, rev) {
  return JSON.parse(await fileAt(path, rev));
}
function passed(jobs, name, step) {
  const matches = jobs.filter(x=>x.name===name);
  assert.equal(matches.length,1,'exactly one trusted job '+name);
  const job=matches[0];
  assert.equal(job.status,'completed');
  assert.equal(job.conclusion,'success');
  if(step) assert.equal((job.steps??[]).filter(x=>
    x.name===step && x.status==='completed' && x.conclusion==='success').length,
    1,name+' must complete '+step);
  return job;
}
async function jobsOf(run) {
  const x=await get('/actions/runs/'+run.id+'/attempts/'+run.run_attempt+
    '/jobs?per_page=100');
  assert.ok(Array.isArray(x.jobs) && x.jobs.length>0 && x.jobs.length<=100);
  return x.jobs;
}
function authenticateRun(run,name,path,sha,event='push') {
  return run?.name===name && run.path?.split('@')[0]===path &&
    run.event===event && run.head_branch==='staging' &&
    run.head_sha===sha &&
    run.repository?.full_name===REPO &&
    run.head_repository?.full_name===REPO &&
    Number.isSafeInteger(run.id) && run.id>0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt>0;
}
async function sourceRun(name,workflow,sha) {
  const data=await get('/actions/workflows/'+workflow+
    '/runs?head_sha='+sha+'&per_page=30');
  assert.ok(Array.isArray(data.workflow_runs) &&
    data.workflow_runs.length<=30);
  const runs=data.workflow_runs.filter(x=>authenticateRun(x,name,
    '.github/workflows/'+workflow,sha))
    .sort((a,b)=>b.run_number-a.run_number ||
      b.run_attempt-a.run_attempt);
  if(!runs.length)throw new Unobservable(name+' has no source-aligned run');
  const run=runs[0];
  if(run.status!=='completed')throw new Unobservable(name+' still running');
  assert.equal(run.conclusion,'success',name+' did not succeed');
  return run;
}
async function deployedAttestation(sha) {
  const list=await get('/contents/indexes/by-sha/'+sha+
    '/deployment?ref=acceptance-results');
  assert.ok(Array.isArray(list) && list.length<=80);
  const entries=list.filter(x=>/^\d+-\d+-staging\.json$/.test(x.name) &&
    x.type==='file').slice(0,12);
  if(!entries.length)throw new Unobservable('identity not yet ingested');
  const all=[];
  for (const entry of entries) {
    const index=await jsonAt(entry.path,'acceptance-results');
    assert.ok(/^runs\/\d{4}-\d{2}-\d{2}\/\d+-\d+\/deployment\/staging\.json$/
      .test(index.record),'unsafe attestation record path');
    const record=await jsonAt(index.record,'acceptance-results');
    const data=attestation(index,record,sha);
    all.push({index,record,data});
  }
  all.sort((a,b)=>Date.parse(b.data.observed)-Date.parse(a.data.observed));
  if(all.length>1 && all[0].data.observed===all[1].data.observed)
    throw Error('ambiguous latest identity observation');
  const chosen=all[0];
  const run=await get('/actions/runs/'+chosen.data.sourceRun);
  assert.equal(run.name,'Deploy / Identity');
  assert.equal(run.path?.split('@')[0],'.github/workflows/deploy-identity.yml');
  assert.equal(run.event,'workflow_run');
  assert.equal(run.head_branch,'main');
  assert.equal(run.repository?.full_name,REPO);
  assert.equal(run.head_repository?.full_name,REPO);
  assert.equal(run.status,'completed');
  assert.equal(run.conclusion,'success');
  assert.equal(run.run_attempt,chosen.data.sourceAttempt);
  passed(await jobsOf(run),'attest',
    'Wait boundedly for reconciled Staging workload identity');
  return chosen;
}
async function verify() {
  fixtures();
  const sha=targetSha();
  const comparison=await get('/compare/'+FIX+'...'+sha);
  assert.equal(comparison.merge_base_commit?.sha,FIX,
    'source must include #4035 GHCR-only deployment change');
  assert.equal(comparison.behind_by,0);
  const [release,deploy,observed]=await Promise.all([
    sourceRun('Release / Staging Artifacts','release-staging.yml',sha),
    sourceRun('Deploy / Staging GHCR','deploy-staging-ghcr.yml',sha),
    deployedAttestation(sha),
  ]);
  const releaseJobs=await jobsOf(release);
  for(const role of PUBLISHED)for(const arch of ['amd64','arm64'])
    passed(releaseJobs,'docker-'+role+'-'+arch);
  passed(releaseJobs,'merge');
  passed(releaseJobs,'provenance','Emit GHCR build provenance');
  const deployJobs=await jobsOf(deploy);
  passed(deployJobs,'verify-source',
    'Authenticate successful exact-SHA GHCR publishing run');
  passed(deployJobs,'deploy-staging-gitops',
    'Verify exact-source GHCR digests and update Staging GitOps');
  const rev=observed.data.gitops;
  const [nession,mcp]=await Promise.all([
    fileAt('environments/staging/nession/kustomization.yaml',rev),
    fileAt('environments/staging/mcp/kustomization.yaml',rev),
  ]);
  assertGHCRDesired(nession,DEPLOYED,sha);
  assertGHCRDesired(mcp,['mcp'],sha);
  const digests=[...observed.data.digests].map(([role,digest])=>
    role+'='+digest).join(' ');
  return {status:'pass',
    summary:'GHCR-only immutable Staging GitOps and real ready workload identity attested at '+sha,
    evidence:[
      {type:'ci',value:'authenticated GHCR eight-platform release Run/Attempt '+
        release.id+'/'+release.run_attempt+'; no ACR dependency'},
      {type:'ci',value:'source-pinned GHCR GitOps writer Run/Attempt '+
        deploy.id+'/'+deploy.run_attempt+' successful'},
      {type:'provenance',value:'immutable deployed receipt '+
        observed.index.record+' execution '+observed.index.execution_id+
        ' GitOps '+rev},
      {type:'runtime',value:'read-only Deployment Identity verified ready GHCR '+
        'Server/Agent/UI imageIDs: '+digests},
      {type:'provenance',value:'both GitOps overlays pin GHCR Server/Agent/UI/MCP '+
        'tags from the same exact Staging source SHA; MCP desired-state verified '+
        '(not claimed as an independently attested Pod)'},
    ]};
}
if (process.argv.includes('--self-test')) {
  fixtures();
  process.stdout.write('4032 GHCR deployed Case offline mutation fixtures passed\n');
} else {
  verify().then(v=>process.stdout.write(JSON.stringify(v)+'\n')).catch(e=>{
    const pending=e instanceof Unobservable;
    process.stdout.write(JSON.stringify({status:pending?'pending':'fail',
      summary:pending?safe(e.message):'GHCR deployed Case rejected: '+safe(e.message),
      evidence:[]})+'\n');
    if(!pending)process.exitCode=1;
  });
}
