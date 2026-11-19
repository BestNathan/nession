'use strict';
// Shared read-only Case verifier for #3953/#3964 deployed SC-04.
// The trusted Acceptance Runner independently chooses the deployed binding,
// verifies the exact source SHA, environment and immutable workload digests,
// and writes the only authoritative deployment-linked Acceptance record.
// This optional public-GitHub readback cross-check is never a substitute for it.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { targetSha } = require('./mcp-cases.cjs');

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ROLES = ['agent', 'server', 'ui'];
const PUBLISHED = [...ROLES, 'mcp'];
const ENV = 'staging';

class Unobservable extends Error {}
function checkRoles(items, label, expected = ROLES) {
  assert.ok(Array.isArray(items), label + ' must be an array');
  assert.deepEqual(items.map(x => x.role).sort(), [...expected].sort(),
    label + ' must have exactly the expected distinct roles');
}
function safeString(v) {
  return String(v ?? '').replace(/[\r\n\t]+/g,' ').slice(0,180);
}
function validateIndexAndRecord(index, record, sha) {
  assert.match(sha, SHA);
  assert.equal(index.schema_version, 1);
  assert.equal(index.mode, 'deployment');
  assert.equal(index.source.repository, REPO);
  assert.equal(index.target_sha, sha);
  assert.equal(index.environment_id, ENV);
  assert.match(index.gitops_revision, SHA);
  assert.match(index.execution_id, /^[a-f0-9]{64}$/);
  assert.equal(record.schema_version, 1);
  assert.equal(record.kind, 'nession_deployment_attestation');
  assert.equal(record.status, 'Attested');
  assert.equal(record.environment_id, ENV);
  assert.equal(record.source_sha, sha);
  assert.equal(record.gitops_revision, index.gitops_revision);
  assert.equal(record.execution_id, index.execution_id);
  assert.ok(Number.isFinite(Date.parse(record.observed_at)),
    'attestation observation timestamp missing');
  const source = record.provenance?.verified_source;
  assert.equal(source?.repository, REPO);
  assert.equal(source?.run_id, index.source.run_id);
  assert.equal(source?.run_attempt, index.source.run_attempt);
  assert.equal(source?.workflow_id, index.source.workflow_id);
  assert.equal(source?.head_sha, index.source.head_sha);
  assert.equal(source?.head_branch, 'main');
  assert.equal(source?.event, 'workflow_run');
  assert.ok(Number.isSafeInteger(source.run_id) && source.run_id > 0);
  assert.ok(Number.isSafeInteger(source.run_attempt) && source.run_attempt > 0);
  checkRoles(record.images, 'attested images');
  checkRoles(record.workloads, 'attested workloads');
  const digestByRole = new Map();
  for (const image of record.images) {
    assert.match(image.digest, DIGEST, 'immutable role digest');
    assert.equal(image.tag, image.role + '-' + sha.slice(0, 7));
    assert.ok(typeof image.repository === 'string' &&
      image.repository.endsWith('/n_public/nession'),
      'attested image requires approved ACR repository');
    digestByRole.set(image.role, image.digest);
  }
  for (const w of record.workloads) {
    assert.equal(w.namespace, 'nession');
    assert.equal(w.name, 'nession-' + w.role + '-staging');
    assert.equal(w.ready, true);
    assert.ok(typeof w.uid === 'string' && w.uid.length > 10);
    assert.ok(Number.isSafeInteger(w.generation) && w.generation > 0);
    assert.equal(w.observed_generation, w.generation);
    assert.equal(w.digest, digestByRole.get(w.role));
    assert.equal(w.image_id,
      w.repository + '@' + digestByRole.get(w.role));
    assert.equal(w.image,
      w.repository + ':' + w.role + '-' + sha.slice(0, 7));
  }
  const remote = record.remote_observation;
  assert.equal(remote?.kind, 'nession_remote_staging_observation');
  assert.equal(remote.status, 'Observed');
  assert.equal(remote.evaluation, null);
  assert.equal(remote.source_sha, sha);
  assert.equal(remote.gitops_revision, index.gitops_revision);
  assert.ok(Array.isArray(remote.samples) && remote.samples.length >= 1,
    'missing read-only Kubernetes readiness samples');
  for (const sample of remote.samples) {
    checkRoles(sample.workloads, 'remote sample workloads');
    for (const w of sample.workloads) {
      assert.equal(w.ready, true);
      assert.equal(w.generation, w.observed_generation);
      assert.equal(w.digest, digestByRole.get(w.role));
    }
  }
  return {sourceRun:source.run_id,sourceAttempt:source.run_attempt,
    gitops:index.gitops_revision,observed:record.observed_at,
    digests:Object.fromEntries(digestByRole)};
}
function offlineFixtures() {
  const sha='a'.repeat(40), gitops='b'.repeat(40), digest='sha256:'+'c'.repeat(64);
  const ims=ROLES.map(role=>({role,repository:'registry.example.com/n_public/nession',
    tag:role+'-'+sha.slice(0,7),digest}));
  const works=ROLES.map(role=>({role,namespace:'nession',name:'nession-'+role+'-staging',
    ready:true,uid:'uid-test-'+role+'-uuid',generation:7,observed_generation:7,digest,
    repository:'registry.example.com/n_public/nession',
    image:'registry.example.com/n_public/nession:'+role+'-'+sha.slice(0,7),
    image_id:'registry.example.com/n_public/nession@'+digest}));
  const idx={schema_version:1,mode:'deployment',
    source:{repository:REPO,run_id:55,run_attempt:1,workflow_id:44,
      head_sha:'d'.repeat(40),head_branch:'main'},
    target_sha:sha,environment_id:ENV,gitops_revision:gitops,execution_id:'e'.repeat(64)};
  const rec={schema_version:1,kind:'nession_deployment_attestation',
    status:'Attested',environment_id:ENV,source_sha:sha,gitops_revision:gitops,
    execution_id:idx.execution_id,observed_at:'2026-11-18T18:37:28.000Z',
    images:ims,workloads:works,
    provenance:{verified_source:{...idx.source,event:'workflow_run'}},
    remote_observation:{kind:'nession_remote_staging_observation',status:'Observed',
      evaluation:null,source_sha:sha,gitops_revision:gitops,
      samples:[{workloads:ROLES.map(role=>({role,digest,ready:true,generation:7,observed_generation:7}))}]}};
  assert.equal(validateIndexAndRecord(idx,rec,sha).sourceRun,55);
  const invalid=(fn)=>{const x=structuredClone(rec);fn(x);assert.throws(()=>validateIndexAndRecord(idx,x,sha))};
  invalid(x=>{x.images.push({...x.images[0]})});
  invalid(x=>{x.images[0].digest='sha256:invalid'});
  invalid(x=>{x.workloads[1].ready=false});
  invalid(x=>{x.workloads[0].image_id='untrusted@'+digest});
  invalid(x=>{x.workloads[2].observed_generation=6});
  invalid(x=>{x.remote_observation.samples[0].workloads[1].digest='sha256:'+'f'.repeat(64)});
  invalid(x=>{x.source_sha='e'.repeat(40)});
  invalid(x=>{x.gitops_revision='f'.repeat(40)});
  invalid(x=>{x.provenance.verified_source.run_id=99});
  invalid(x=>{x.provenance.verified_source.head_branch='staging'});
  process.stdout.write('deployed-identity-proof: immutable source/role/digest and negative fixtures passed\n');
}
async function get(url) {
  const response=await fetch(API+url,{headers:{
    Accept:'application/vnd.github+json', 'User-Agent':'nession-3953-3964-deployed-case'},
    signal:AbortSignal.timeout(20000)});
  if(!response.ok) {
    if([403,429,500,502,503,504].includes(response.status))
      throw new Unobservable('authenticated public readback temporarily unavailable');
    if(response.status===404)throw new Unobservable('source-aligned deployment receipt not yet visible');
    throw new Error('trusted source API status '+response.status);
  }
  return response.json();
}
function decode(file) {
  assert.equal(file.type,'file');
  assert.equal(file.encoding,'base64');
  assert.ok(typeof file.content==='string' && file.content.length<100000);
  return JSON.parse(Buffer.from(file.content.replace(/\s/g,''),'base64').toString('utf8'));
}
async function getJsonFile(path) {
  return decode(await get('/contents/'+path+'?ref=acceptance-results'));
}
function passed(jobs,name) {
  const m=jobs.filter(j=>j.name===name);
  assert.equal(m.length,1,'expected one trusted '+name+' job');
  assert.equal(m[0].status,'completed');
  assert.equal(m[0].conclusion,'success');
  return m[0];
}
function passedStep(job,name) {
  assert.equal((job.steps??[]).filter(x=>x.name===name&&x.conclusion==='success').length,1,
    'expected trusted '+name+' step');
}
async function jobsOf(id,attempt) {
  const x=await get('/actions/runs/'+id+'/attempts/'+attempt+'/jobs?per_page=100');
  assert.ok(Array.isArray(x.jobs)&&x.jobs.length>0&&x.jobs.length<=100);
  return x.jobs;
}
async function sourceAttestation(sha) {
  const list=await get('/contents/indexes/by-sha/'+sha+'/deployment?ref=acceptance-results');
  if(!Array.isArray(list)||list.length>40)throw Error('invalid bounded deployment index inventory');
  const indices=list.filter(x=>/^\d+-\d+-staging\.json$/.test(x.name)&&x.type==='file');
  if(!indices.length)throw new Unobservable('Staging attestation for exact source not yet ingested');
  const received=[];
  for(const entry of indices.slice(0,8)) {
    const index=await getJsonFile(entry.path);
    const match=/^(runs\/\d{4}-\d{2}-\d{2}\/\d+-\d+\/deployment\/staging\.json)$/.exec(index.record??'');
    assert.ok(match,'unsafe immutable deployment source record path');
    const record=await getJsonFile(match[1]);
    const props=validateIndexAndRecord(index,record,sha);
    received.push({index,record,props});
  }
  received.sort((a,b)=>Date.parse(b.props.observed)-Date.parse(a.props.observed));
  if(received.length>1&&received[0].props.observed===received[1].props.observed)
    throw Error('ambiguous latest exact-source deployment receipt');
  const selected=received[0];
  const run=await get('/actions/runs/'+selected.props.sourceRun);
  assert.equal(run.name,'Deploy / Identity');
  assert.equal(run.path?.split('@')[0],'.github/workflows/deploy-identity.yml');
  assert.equal(run.event,'workflow_run');
  assert.equal(run.head_branch,'main');
  assert.equal(run.repository?.full_name,REPO);
  assert.equal(run.head_repository?.full_name,REPO);
  assert.equal(run.status,'completed');
  assert.equal(run.conclusion,'success');
  assert.equal(run.run_attempt,selected.props.sourceAttempt);
  const jobs=await jobsOf(run.id,run.run_attempt);
  passedStep(passed(jobs,'attest'),'Wait boundedly for reconciled Staging workload identity');
  return selected;
}
async function fourRoleACR(sha) {
  const list=await get('/actions/workflows/deploy-staging-acr.yml/runs?head_sha='+sha+'&per_page=30');
  const matching=(list.workflow_runs??[]).filter(r=>
    r.name==='Deploy / Staging ACR' &&
    r.path?.split('@')[0]==='.github/workflows/deploy-staging-acr.yml' &&
    r.event==='push' && r.head_branch==='staging' && r.head_sha===sha &&
    r.repository?.full_name===REPO && r.head_repository?.full_name===REPO &&
    r.status==='completed' && r.conclusion==='success');
  if(!matching.length)throw new Unobservable('no completed source-aligned four-role ACR run yet');
  const selected=matching.sort((a,b)=>b.run_number-a.run_number)[0];
  const jobs=await jobsOf(selected.id,selected.run_attempt);
  for(const role of PUBLISHED) {
    passedStep(passed(jobs,'mirror-acr ('+role+')'),
      'Mirror and verify multi-arch '+role+' image');
  }
  passed(jobs,'verify-source');
  passed(jobs,'provenance');
  passed(jobs,'deploy-staging-gitops');
  return selected;
}
async function verify(issue) {
  if(![3953,3964].includes(issue))throw Error('unapproved deployed Case owner');
  offlineFixtures();
  const sha=targetSha();
  assert.match(sha,SHA);
  const fix=issue===3953
    ? '3123821ac51df3cea535a4150a1769ffa88e16d9' // four-role Provenance source
    : '737bb0a0abf92fc5e9fc96ae7247148c00fa6aa3'; // Pod containerName binding
  execFileSync('git',['merge-base','--is-ancestor',fix,sha],{stdio:'ignore'});
  const deployed=await sourceAttestation(sha);
  const acr=await fourRoleACR(sha);
  const ev=[
    {type:'provenance',value:'immutable deployment receipt '+deployed.index.record+
      ' execution='+deployed.index.execution_id+' source='+sha+
      ' GitOps='+deployed.props.gitops},
    {type:'ci',value:'trusted successful Deploy / Identity run '+deployed.props.sourceRun+
      '/'+deployed.props.sourceAttempt+' attest completed with exact Pod imageID role digests'},
    {type:'ci',value:'trusted source-aligned four-role ACR run '+acr.id+'/'+acr.run_attempt+
      ' verified mirror-acr agent/server/ui/mcp, provenance, deploy-staging-gitops'},
    {type:'runtime',value:'staging read-only samples verify 3 role UIDs/generations/readiness and immutable digests: '+
      ROLES.map(r=>r+'='+deployed.props.digests[r]).join(' ')},
    {type:'runtime',value:'Case original product source '+sha+' contains fix '+fix+
      '; trusted runner must separately validate environment=staging and exact SHA deployment binding'},
  ];
  return {status:'pass',summary:'source-aligned Staging attestation, role digests and four-role provenance verified for '+sha,evidence:ev};
}
function run(issue) {
  verify(issue).then(out=>{process.stdout.write(JSON.stringify(out)+'\n')}).catch(e=>{
    const pending=e instanceof Unobservable;
    process.stdout.write(JSON.stringify({status:pending?'pending':'fail',
      summary:pending?safeString(e.message):
        'deployed identity source verification rejected: '+safeString(e.message),
      evidence:[]})+'\n');
    if(!pending)process.exitCode=1;
  });
}
module.exports={run,verify,validateIndexAndRecord,offlineFixtures};

if (require.main === module) {
  if (process.argv[2] !== 'self-test') {
    process.stderr.write('Usage: deployed-identity-proof.cjs self-test\n');
    process.exitCode = 2;
  } else {
    offlineFixtures();
  }
}
