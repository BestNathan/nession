#!/usr/bin/env node
// Canonical, main-owned Run Store governance inventory. Only the read-only live
// probe claims GitHub protection state; source analysis is never enforcement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {RUN_STORE_REFS} from './run-store-integrity.mjs';

const REPO='BestNathan/nession',HEX40=/^[0-9a-f]{40}$/;
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifestPath=path.join(ROOT,'scripts/run-store-inventory.json');
const fail=m=>{throw Error('run-store-inventory: '+m)};
const read=p=>fs.readFileSync(p,'utf8');
const data=()=>JSON.parse(read(manifestPath));
const refPattern=/(?:refs\/heads\/)?(acceptance-results|task-results|agent-store|metrics)(?:\b|$)/g;

export function findStorePushes(workflow){
  const entries=[];
  for(const [i,line] of workflow.split(/\r?\n/).entries()){
    if(!/^\s*(?:-\s*run:\s*)?git(?:\s+-C\s+[^\s]+)?\s+push\b/.test(line))continue;
    const refs=[...line.matchAll(refPattern)].map(x=>x[1]);
    for(const ref of new Set(refs))
      entries.push({ref,line:i+1,command:line.trim()});
  }
  return entries;
}
export function checkInventory(manifest,workflows){
  if(manifest?.schema_version!==1||manifest.kind!=='run_store_writer_inventory'||
     manifest.repository!==REPO||!Array.isArray(manifest.stores))
    fail('invalid inventory schema or repository');
  const refs=manifest.stores.map(x=>x.ref);
  if(new Set(refs).size!==refs.length||
     JSON.stringify([...refs].sort())!==JSON.stringify([...RUN_STORE_REFS].sort()))
    fail('inventory stores diverge from canonical run-store-integrity refs');
  const seen=new Map();
  for(const store of manifest.stores){
    if(!['active','planned'].includes(store.lifecycle)||
       !Array.isArray(store.writers)||store.writers.length>20)
      fail('invalid Store state or writer inventory: '+store.ref);
    if(store.lifecycle==='active'&&!store.writers.length)
      fail('active orphan Store is missing writer inventory: '+store.ref);
    if(store.lifecycle==='planned'&&store.writers.length)
      fail('planned Store must not claim an active writer: '+store.ref);
    if(store.ref==='agent-store'&&store.lifecycle==='planned'&&
       !String(store.rollout_blocker??'').includes('Ruleset'))
      fail('private Agent Store deployment blocker must be explicit');
    for(const writer of store.writers){
      if(!/^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(writer.workflow)||
         writer.source!=='github-actions GITHUB_TOKEN'||
         !String(writer.execution).includes('main-owned')||
         !Array.isArray(writer.depends_on)||
         !Array.isArray(writer.permissions)||
         !writer.permissions.includes('contents: write'))
        fail('unclassified writer identity/authority/dependency: '+store.ref);
      const body=workflows.get(writer.workflow);
      if(typeof body!=='string')fail('writer workflow missing: '+writer.workflow);
      if(!/^\s+contents:\s*write\s*$/m.test(body)||
         !/secrets\.GITHUB_TOKEN/.test(body))
        fail('writer lacks declared contents:write/token source: '+writer.workflow);
      for(const perm of writer.permissions){
        if(!/^(?:contents|issues|pull-requests|actions): (?:read|write)$/.test(perm))
          fail('unknown writer permission');
        if(!new RegExp('^\\s+'+perm.replace(': ',':\\s*')+'\\s*$','m').test(body))
          fail('declared writer permissions differ: '+writer.workflow);
      }
      for(const dep of writer.depends_on){
        if(!/^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(dep)||
           !workflows.has(dep))
          fail('unclassified upstream dependency: '+dep);
      }
      const actual=findStorePushes(body);
      if(!actual.some(p=>p.ref===store.ref))
        fail('writer is not publishing the claimed Store: '+writer.workflow+' '+store.ref);
      const key=writer.workflow+'|'+store.ref;
      if(seen.has(key))fail('duplicate Store writer declaration: '+key);
      seen.set(key,writer);
    }
  }
  for(const [workflow,body] of workflows){
    for(const push of findStorePushes(body)){
      if(!seen.has(workflow+'|'+push.ref))
        fail('unknown privileged Store push '+workflow+':'+push.line+' -> '+push.ref);
    }
  }
  if(!manifest.governance||
     manifest.governance.ruleset_enforcement!=='unknown_until_live_probe'||
     manifest.governance.branch_protection!=='unknown_until_live_probe'||
     manifest.governance.independent_anchor!=='pending_offline_admin_control')
    fail('static inventory must not assert live protection or independent anchoring');
  return {schema_version:1,stores:refs.length,writers:seen.size,
    workflows_checked:workflows.size,
    status:'source-inventory-proven; remote Rulesets require authenticated live probe'};
}
function workflows(root=ROOT){
  const dir=path.join(root,'.github/workflows');
  return new Map(fs.readdirSync(dir).filter(x=>x.endsWith('.yml'))
    .map(x=>['.github/workflows/'+x,read(path.join(dir,x))]));
}
function selfTest(){
  const manifest=data(),sources=workflows(),success=checkInventory(manifest,sources);
  const trusted={GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main',
    GITHUB_SHA:'a'.repeat(40)};
  for(const event of ['push','schedule','workflow_dispatch'])
    assert.equal(assertTrustedLiveContext({...trusted,GITHUB_EVENT_NAME:event}),true);
  for(const invalid of [
    {...trusted,GITHUB_EVENT_NAME:'pull_request_target'},
    {...trusted,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/feature'},
    {...trusted,GITHUB_EVENT_NAME:'push',GITHUB_REPOSITORY:'attacker/fork'},
    {...trusted,GITHUB_EVENT_NAME:'push',GITHUB_SHA:'main'},
  ]) assert.throws(()=>assertTrustedLiveContext(invalid),/trusted main/);
  assert.equal(success.writers,6);
  const clone=x=>JSON.parse(JSON.stringify(x));
  const unmatched=clone(manifest);
  unmatched.stores.find(x=>x.ref==='metrics').writers.pop();
  assert.throws(()=>checkInventory(unmatched,sources),/unknown privileged Store push/);
  const foreign=clone(manifest);
  foreign.stores.find(x=>x.ref==='task-results').writers[0].source='attacker';
  assert.throws(()=>checkInventory(foreign,sources),/unclassified writer/);
  const undeclared=clone(manifest);
  undeclared.stores.push({ref:'private-secrets',lifecycle:'active',writers:[]});
  assert.throws(()=>checkInventory(undeclared,sources),/canonical/);
  const forged=clone(manifest);
  forged.governance.ruleset_enforcement='enforced';
  assert.throws(()=>checkInventory(forged,sources),/must not assert/);
  const unknownWorkflow=new Map(sources);
  unknownWorkflow.set('.github/workflows/unreviewed.yml',
    'on: push\npermissions:\n  contents: write\njobs:\n  writer:\n    steps:\n      - run: git push origin HEAD:metrics\n');
  assert.throws(()=>checkInventory(manifest,unknownWorkflow),/unknown privileged Store push/);
  const unsupported=new Map(sources);
  unsupported.delete('.github/workflows/e2e-tests.yml');
  assert.throws(()=>checkInventory(manifest,unsupported),/upstream dependency/);
  assert.deepEqual(findStorePushes('git -C result push origin acceptance-results\n'+
    'git push origin HEAD:metrics').map(x=>x.ref),['acceptance-results','metrics']);
  console.log('Run Store inventory: 4 classified refs, 6 authenticated writers, source/permission/token/unknown-push negatives passed');
}
function gh(endpoint){
  try{
    return JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],{
      encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
      stdio:['ignore','pipe','pipe'],
    }));
  }catch(e){return {unavailable:true,error_class:'permission-or-api-error',
    status:e.status??null};}
}
export function assertTrustedLiveContext(env){
  if(env.GITHUB_REPOSITORY!==REPO||
     env.GITHUB_REF!=='refs/heads/main'||
     !['push','schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||
     !HEX40.test(env.GITHUB_SHA??''))
    fail('live protection audit must run on trusted main source SHA');
  return true;
}
function live(out){
  assertTrustedLiveContext(process.env);
  const inventory=data();
  checkInventory(inventory,workflows());
  const rulesets=gh('rulesets?per_page=100');
  const rows=[];
  for(const store of inventory.stores){
    const branch=gh('branches/'+store.ref);
    const protection=gh('branches/'+store.ref+'/protection');
    rows.push({ref:store.ref,lifecycle:store.lifecycle,
      branch_exists:!branch.unavailable,
      branch_protected:branch.unavailable?null:branch.protected===true,
      protection_endpoint_available:!protection.unavailable,
      protection_error:protection.unavailable?protection.error_class:null,
      // A non-admin caller cannot prove configured permissions by querying
      // only a summary; this is explicitly NOT an enforcement attestation.
      authorization_verified:false});
  }
  const output={schema_version:1,kind:'run_store_governance_observation',
    repo:REPO,source_sha:process.env.GITHUB_SHA,
    action_run_id:process.env.GITHUB_RUN_ID??null,
    observed_at:new Date().toISOString(),
    rulesets_readable:!rulesets.unavailable,
    rulesets:rulesets.unavailable?[]:
      (Array.isArray(rulesets)?rulesets:[]).map(r=>({id:r.id,
        name:r.name,enforcement:r.enforcement,target:r.target})),
    stores:rows,
    verdict:'not-enforced-until-independent-admin-and-authorization-proof'};
  fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
  console.log('Run Store governance live snapshot written; no server-side enforcement claimed');
}
const [command,file]=process.argv.slice(2);
if(command==='self-test')selfTest();
else if(command==='check')console.log(JSON.stringify(checkInventory(data(),workflows())));
else if(command==='live'&&file&&path.isAbsolute(file))live(file);
else fail('usage: self-test | check | live ABS_OUTPUT_JSON');
