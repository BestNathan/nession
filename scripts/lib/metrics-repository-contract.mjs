// Canonical structural contract for the privileged Repository Metrics workflow.
//
// #1789 review 2026-10-17: the checks used to match text and ban two trigger
// names (`workflow_dispatch`/`repository_dispatch`). An accidental `push:` or
// `pull_request_target:` would have passed a check written to prevent exactly
// that, and so would an added job holding write. These helpers ENUMERATE the
// declared triggers, jobs and per-job permissions instead.
//
// The structural helpers deliberately understand only the shapes this workflow
// is allowed to have and fail closed everywhere else. One owner: both Gate
// self-tests consume this module rather than keeping parallel copies that can
// drift apart.
import assert from 'node:assert/strict';

export const REPOSITORY_METRICS_ALLOWED_TRIGGERS=Object.freeze(['schedule','workflow_run']);
export const REPOSITORY_METRICS_ALLOWED_JOBS=Object.freeze(['authorize-replay','rust-health',
  'web-health','e2e-health','publish']);
export const REPOSITORY_METRICS_WRITER_JOB='publish';
// The most the publisher may ever hold. Every declared entry must equal this
// value; an added key or a widened scope fails.
export const REPOSITORY_METRICS_WRITER_CEILING=Object.freeze({actions:'read',
  contents:'write',issues:'read','pull-requests':'read'});

function columnZeroBlock(text,key){
  const lines=String(text).split('\n');
  const start=lines.findIndex(line=>new RegExp('^'+key+':').test(line));
  if(start<0)return null;
  const out=[];
  for(let i=start+1;i<lines.length;i+=1){
    const line=lines[i];
    if(line.trim()===''||line.startsWith('#')){out.push(line);continue;}
    if(/^\S/.test(line))break; // next column-0 key
    out.push(line);
  }
  return out.join('\n');
}
function keysAt(blockText,indent){
  const re=new RegExp('^'+' '.repeat(indent)+'([A-Za-z0-9_.-]+):');
  return String(blockText??'').split('\n').map(line=>line.match(re)?.[1]).filter(Boolean);
}
function jobBodies(workflow){
  const jobs=columnZeroBlock(workflow,'jobs');
  if(jobs===null)throw new Error('missing Metrics jobs block');
  const bodies=new Map();
  let current=null;
  for(const line of jobs.split('\n')){
    const key=line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
    if(key){current=key[1];bodies.set(current,[]);continue;}
    if(current)bodies.get(current).push(line);
  }
  return new Map([...bodies].map(([name,lines])=>[name,lines.join('\n')]));
}
function permissionBlocks(jobBody){
  const lines=String(jobBody).split('\n');
  const blocks=[];
  for(let i=0;i<lines.length;i+=1){
    if(!/^    permissions:\s*$/.test(lines[i]))continue;
    const entries=new Map();
    for(let j=i+1;j<lines.length;j+=1){
      if(lines[j].trim()==='')continue;
      const entry=lines[j].match(/^      ([a-z-]+):\s*(\S+)\s*$/);
      if(!entry)break;
      entries.set(entry[1],entry[2]);
    }
    blocks.push(entries);
  }
  return blocks;
}

export function verifyRepositoryMetricsTrustedSource(workflow) {
  const triggerText=columnZeroBlock(workflow,'on')??'';
  const triggers=keysAt(triggerText,2);
  const unexpectedTrigger=triggers.find(name=>!REPOSITORY_METRICS_ALLOWED_TRIGGERS.includes(name));
  if(unexpectedTrigger||triggers.length!==REPOSITORY_METRICS_ALLOWED_TRIGGERS.length)
    throw new Error('repository Metrics source must be scheduled or default-main attested-only: unexpected trigger '+
      (unexpectedTrigger??('count '+triggers.length)));
  // The trigger bodies themselves must still name the Replay Request workflow.
  if(!/^  schedule:\s*$/m.test(triggerText) ||
      !/^  workflow_run:\s*\n    workflows: \["Metrics \/ Replay Request"\]\s*\n    types: \[completed\]/m.test(triggerText)) {
    throw new Error('repository Metrics source must be scheduled or default-main attested-only: trigger body drift');
  }
  // Workflow-level default token: every declared scope must be read.
  const workflowPermissions=(columnZeroBlock(workflow,'permissions')??'').split('\n')
    .map(line=>line.match(/^  ([a-z-]+):\s*(\S+)\s*$/)).filter(Boolean).map(m=>[m[1],m[2]]);
  if(!workflowPermissions.length||workflowPermissions.some(([,value])=>value!=='read')) {
    throw new Error('repository Metrics source must be read-only by default');
  }
  const bodies=jobBodies(workflow);
  const unexpectedJob=[...bodies.keys()].find(name=>!REPOSITORY_METRICS_ALLOWED_JOBS.includes(name));
  const missingJob=REPOSITORY_METRICS_ALLOWED_JOBS.find(name=>!bodies.has(name));
  if(unexpectedJob||missingJob||bodies.size!==REPOSITORY_METRICS_ALLOWED_JOBS.length)
    throw new Error('unsafe Metrics source job: '+
      (unexpectedJob?'unexpected job '+unexpectedJob:'missing job '+missingJob));
  // Per-job ceiling: only the publisher may declare write, and exactly once.
  for(const [name,body] of bodies){
    const blocks=permissionBlocks(body);
    if(blocks.length>1)
      throw new Error('Metrics writer contents:write must be scoped to publish only: duplicate permissions in '+name);
    if(name===REPOSITORY_METRICS_WRITER_JOB)continue;
    const declared=blocks[0];
    if(declared&&[...declared.values()].some(value=>value!=='read'))
      throw new Error('Metrics writer contents:write must be scoped to publish only: job '+name);
  }
  const writerBlocks=permissionBlocks(bodies.get(REPOSITORY_METRICS_WRITER_JOB)??'');
  if(writerBlocks.length!==1)
    throw new Error('Metrics writer contents:write must be scoped to publish only: publish permission count');
  const writerPermissions=writerBlocks[0];
  const outsideCeiling=[...writerPermissions].find(([key,value])=>REPOSITORY_METRICS_WRITER_CEILING[key]!==value);
  if(outsideCeiling||writerPermissions.get('contents')!=='write')
    throw new Error('Metrics writer contents:write must be scoped to publish only: '+
      (outsideCeiling?('unexpected permission '+outsideCeiling[0]):'contents must be write'));
  const auth=bodies.get('authorize-replay')??'';
  if(!auth.includes("github.event_name == 'schedule' || github.event_name == 'workflow_run'") ||
      !auth.includes('node scripts/metrics-replay-source.mjs authorize')||
      !/^\s+permissions:\s*\n\s+contents: read\s*\n\s+actions: read\s*$/m.test(auth)||
      !auth.includes('persist-credentials: false')){
    throw new Error('Metrics authorization must be read-only and main-source-attested');
  }
  for(const job of ['rust-health','web-health','e2e-health','publish']) {
    const jobBody=bodies.get(job);
    if(jobBody===undefined)throw new Error('missing Metrics source job '+job);
    const line=jobBody.split(/^    steps:/m)[0];
    for(const constraint of ["needs.authorize-replay.result == 'success'",
      "github.ref == 'refs/heads/main'",
      "github.repository == 'BestNathan/nession'"]) {
      if(!line.includes(constraint))throw new Error('unsafe Metrics source job '+job);
    }
    if(job==='publish'&&!line.includes('needs: [authorize-replay, rust-health, web-health, e2e-health]'))
      throw new Error('unsafe Metrics source job '+job);
    if(job!=='publish'&&!line.includes('needs: authorize-replay'))
      throw new Error('unsafe Metrics source job '+job);
  }
  const writer=bodies.get(REPOSITORY_METRICS_WRITER_JOB)??'';
  if((writer.match(/^    permissions:/gm)||[]).length!==1 ||
      !/^\s+permissions:\s*\n      actions: read\s*\n      contents: write\s*$/m.test(writer)) {
    throw new Error('Metrics writer contents:write must be scoped to publish only');
  }
  if(!writer.includes('node "${GITHUB_WORKSPACE}/scripts/run-store-integrity.mjs" staged metrics "${GITHUB_WORKSPACE}/metrics-store"')) {
    throw new Error('trusted Metrics publisher omitted staged Run Store integrity validation');
  }
  return true;
}

// Invariant: the shared Store writer group may only be joined by a *job*.
// GitHub cancels every previously pending job or workflow in a group as soon as
// a newer one queues, even with `cancel-in-progress: false`. Run-level
// membership made a one-shot replay wake evictable by ordinary `metrics-writer`
// traffic before `authorize-replay` was ever scheduled, so the request was
// neither authorized nor denied and no denial receipt existed (#1690 SC-09).
export function assertWriterGroupIsJobScoped(file,yaml){
  assert.doesNotMatch(yaml,/^concurrency:/m,
    file+': run-level metrics-writer membership can evict a pending replay authorization');
}
