#!/usr/bin/env node
// #2358 SC-02. One-shot, main-owned, disposable-ref-only GitHub Ruleset canary.
// This is an operator write-probe, NEVER an Acceptance / Cases credential holder.
// The exact immutable good Knowledge transition is reused from the independently
// successful production publish Run 42583872613. No live Knowledge ref is mutated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'BestNathan/nession';
const CANARY = 'knowledge-probe/2358-sc02-20261109';
const CONTROL = 'knowledge-probe-control/2358-sc02-20261109';
const BASE = '5c479eb71b696a79c46a985d5fd42ca6240859c9';
const NEXT = '6e5a2d2eb23ec9839717b847c1e2e636c069b390';
const APP_ID = 5677350;
const SPECS = Object.freeze([
  {name:'Knowledge / Canary writer 2358',types:['creation','update'],bypass:'app'},
  {name:'Knowledge / Canary append 2358',
    types:['deletion','non_fast_forward','required_linear_history'],bypass:'none'},
]);
const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge-ledger-contract.mjs');
const fail = s => { throw Error('knowledge-canary-probe: ' + s); };

function enforceContext() {
  if (process.env.GITHUB_REPOSITORY !== REPO ||
      process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      process.env.GITHUB_ACTOR !== 'BestNathan' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_RUN_ATTEMPT !== '1' ||
      !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ||
      Number(process.env.KNOWLEDGE_PUBLISHER_APP_ID) !== APP_ID)
    fail('requires exact owner, main, first-attempt workflow and dedicated App ID');
  if (!process.env.RUNNER_TEMP || !path.isAbsolute(process.env.RUNNER_TEMP))
    fail('RUNNER_TEMP required');
}
async function api(token,method,endpoint,payload) {
  if (!token || !endpoint.startsWith('/repos/' + REPO + '/'))
    fail('missing token or unsafe GitHub endpoint');
  const response = await fetch('https://api.github.com'+endpoint,{
    method,headers:{Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      Authorization:'Bearer '+token,
      ...(payload ? {'Content-Type':'application/json'} : {})},
    body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(25000),
  });
  const text=await response.text();
  let body;
  try { body=text?JSON.parse(text):null; }
  catch { fail('invalid GitHub response for '+method+' '+endpoint); }
  return {status:response.status,ok:response.ok,body};
}
function requireOk(response,label) {
  if (!response.ok) fail(label+': GitHub HTTP '+response.status);
  return response.body;
}
const prefix = '/repos/' + REPO;
const refPath = branch => prefix+'/git/refs/heads/'+branch;
const branchPath = branch => prefix+'/branches/'+encodeURIComponent(branch);
const types = r => (r?.rules ?? []).map(x=>x.type).sort();

function validateRuleSetDetails(list,details) {
  if (!Array.isArray(list) || list.length >= 100) fail('Ruleset list incomplete');
  const ref='refs/heads/'+CANARY, ids=[];
  for(const spec of SPECS) {
    const matches=list.filter(x=>x.name===spec.name &&
      x.source_type==='Repository' && x.target==='branch');
    if(matches.length!==1) fail(spec.name+': expected one repository Ruleset');
    const r=details.find(x=>x.id===matches[0].id);
    if(!r || r.enforcement!=='active' || r.target!=='branch' ||
       JSON.stringify(r.conditions?.ref_name?.include)!==JSON.stringify([ref]) ||
       JSON.stringify(r.conditions?.ref_name?.exclude)!=='[]' ||
       JSON.stringify(types(r))!==JSON.stringify([...spec.types].sort()))
      fail(spec.name+': inactive, wrong ref or rule types');
    if (Array.isArray(r.bypass_actors)) {
      if(spec.bypass==='none' && r.bypass_actors.length)fail('canary append Rule must have zero bypass');
      if(spec.bypass==='app' &&
        (r.bypass_actors.length!==1 || Number(r.bypass_actors[0].actor_id)!==APP_ID ||
         r.bypass_actors[0].actor_type!=='Integration' ||
         r.bypass_actors[0].bypass_mode!=='always'))
        fail('canary writer Rule does not bypass only dedicated App');
    }
    ids.push(r.id);
  }
  return {writer_ruleset_id:ids[0],append_ruleset_id:ids[1]};
}
async function readConfig(token) {
  const list=requireOk(await api(token,'GET',prefix+'/rulesets?per_page=100'),'rulesets');
  if(!Array.isArray(list))fail('invalid Ruleset enumeration');
  const matching=list.filter(x=>SPECS.some(s=>s.name===x.name));
  const details=[];
  for(const r of matching) details.push(requireOk(await api(token,'GET',
    prefix+'/rulesets/'+r.id),'ruleset detail'));
  const ids=validateRuleSetDetails(list,details);
  const branch=requireOk(await api(token,'GET',branchPath(CANARY)),'canary branch');
  if(branch.protected!==true)fail('canary ref not protected by Ruleset');
  return ids;
}
async function head(token,branch) {
  const response=await api(token,'GET',refPath(branch));
  const v=requireOk(response,'read '+branch);
  if(v?.ref!=='refs/heads/'+branch || !/^[a-f0-9]{40}$/.test(v.object?.sha||''))
    fail('unexpected GitHub ref response: '+branch);
  return v.object.sha;
}
async function setHead(token,branch,sha,force=false) {
  if(![CANARY,CONTROL].includes(branch) || ![BASE,NEXT].includes(sha))
    fail('attempted ref mutation outside the pinned disposable canary');
  return api(token,'PATCH',refPath(branch),{sha,force});
}
function hasRulesetDenial(response) {
  if(response.ok || ![403,422].includes(response.status))return false;
  const body=JSON.stringify(response.body??{});
  return /GH013|repository rule|ruleset|rule violation|protected|non.fast.forward|force.push/i.test(body);
}
function requireDenial(response,operation) {
  if(!hasRulesetDenial(response))
    fail(operation+': expected explicit Ruleset denial, got HTTP '+response.status);
}
function receiptPath(name) { return path.join(process.env.RUNNER_TEMP,'knowledge-canary-'+name+'.json'); }
function receipt(data,name) {
  fs.writeFileSync(receiptPath(name),JSON.stringify({
    schema_version:1,run_id:process.env.GITHUB_RUN_ID,
    run_attempt:process.env.GITHUB_RUN_ATTEMPT,main_sha:process.env.GITHUB_SHA,
    canary_ref:'refs/heads/'+CANARY,control_ref:'refs/heads/'+CONTROL,
    app_id:APP_ID,base_sha:BASE,proposed_sha:NEXT,...data,
  },null,2)+'\n',{mode:0o600});
}
async function ordinary() {
  enforceContext();
  const token=process.env.GH_TOKEN, ids=await readConfig(token);
  if(await head(token,CANARY)!==BASE || await head(token,CONTROL)!==BASE)
    fail('disposable refs must begin at exact pinned base');
  const controlWrite=await setHead(token,CONTROL,NEXT);
  requireOk(controlWrite,'ordinary control ref write');
  if(await head(token,CONTROL)!==NEXT)fail('ordinary control readback mismatch');
  const denied=await setHead(token,CANARY,NEXT);
  requireDenial(denied,'ordinary writer against canary');
  if(await head(token,CANARY)!==BASE)fail('unauthorized writer mutated canary');
  receipt({...ids,ordinary_writer_control:'success',
    ordinary_writer_canary:'denied_by_ruleset',
    denial_http_status:denied.status,canary_sha_after_denial:BASE},'ordinary');
  console.log('ordinary write-capable actor: unprotected control succeeded, protected canary denied');
}
function validateCandidate() {
  const result=spawnSync('git',['cat-file','-e',NEXT+'^{commit}'],{encoding:'utf8'});
  if(result.status!==0)fail('pinned candidate commit missing from trusted main checkout');
  const parents=spawnSync('git',['rev-list','--parents','-n','1',NEXT],{encoding:'utf8'});
  if(parents.status!==0 || parents.stdout.trim()!==NEXT+' '+BASE)
    fail('candidate must be one valid parent-child Knowledge transaction');
  const temp=path.join(process.env.RUNNER_TEMP,'knowledge-canary-candidate');
  if(fs.existsSync(temp))fail('candidate worktree path not fresh');
  const worktree=spawnSync('git',['worktree','add','--detach',temp,NEXT],{encoding:'utf8'});
  if(worktree.status!==0)fail('cannot create read-only candidate worktree');
  const validate=spawnSync(process.execPath,[CHECKER,'check',temp,BASE],{
    encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});
  if(validate.status!==0||validate.error)
    fail('Knowledge contract rejected pinned candidate: '+(validate.stderr||'').slice(0,500));
}
async function app() {
  enforceContext();
  const ordinaryProof=JSON.parse(fs.readFileSync(receiptPath('ordinary'),'utf8'));
  if(ordinaryProof.run_id!==process.env.GITHUB_RUN_ID ||
     ordinaryProof.ordinary_writer_control!=='success' ||
     ordinaryProof.ordinary_writer_canary!=='denied_by_ruleset' ||
     ordinaryProof.base_sha!==BASE || ordinaryProof.proposed_sha!==NEXT)
    fail('missing same-run ordinary actor proof');
  const adminToken=process.env.GH_TOKEN,appToken=process.env.KNOWLEDGE_CANARY_APP_TOKEN;
  const ids=await readConfig(adminToken);
  if(ids.writer_ruleset_id!==ordinaryProof.writer_ruleset_id ||
     ids.append_ruleset_id!==ordinaryProof.append_ruleset_id)
    fail('canary Rulesets changed since ordinary proof');
  if(await head(adminToken,CANARY)!==BASE || await head(adminToken,CONTROL)!==NEXT)
    fail('unexpected ref change between ordinary and App phases');
  validateCandidate();
  requireOk(await setHead(appToken,CANARY,NEXT),'dedicated App normal fast-forward');
  if(await head(adminToken,CANARY)!==NEXT)
    fail('authorized App fast-forward readback mismatch');
  // This is an explicitly disposable ref. Never probe non-FF/delete on Knowledge.
  const force=await setHead(appToken,CANARY,BASE,true);
  requireDenial(force,'dedicated App non-fast-forward');
  if(await head(adminToken,CANARY)!==NEXT)
    fail('canary changed after denied force-push');
  const deletion=await api(appToken,'DELETE',refPath(CANARY));
  requireDenial(deletion,'dedicated App deletion');
  if(await head(adminToken,CANARY)!==NEXT)
    fail('canary changed after denied deletion');
  receipt({...ids,ordinary_writer_control:'success',
    ordinary_writer_canary:'denied_by_ruleset',
    dedicated_app_fast_forward:'success',
    dedicated_app_non_fast_forward:'denied_by_ruleset',
    dedicated_app_deletion:'denied_by_ruleset',
    force_denial_http_status:force.status,
    deletion_denial_http_status:deletion.status,
    final_canary_sha:NEXT},'result');
  console.log('dedicated App normal fast-forward passed; force and deletion denied; exact ref unchanged');
}
function selfTest() {
  const f=()=>({id:11,name:SPECS[0].name,target:'branch',source_type:'Repository'});
  const g=()=>({id:12,name:SPECS[1].name,target:'branch',source_type:'Repository'});
  const first={...f(),enforcement:'active',conditions:{ref_name:{include:['refs/heads/'+CANARY],exclude:[]}},
    rules:[{type:'creation'},{type:'update'}],bypass_actors:[{actor_id:APP_ID,actor_type:'Integration',bypass_mode:'always'}]};
  const second={...g(),enforcement:'active',conditions:{ref_name:{include:['refs/heads/'+CANARY],exclude:[]}},
    rules:[{type:'deletion'},{type:'non_fast_forward'},{type:'required_linear_history'}],bypass_actors:[]};
  const list=[f(),g()];
  assert.deepEqual(validateRuleSetDetails(list,[first,second]),{writer_ruleset_id:11,append_ruleset_id:12});
  for(const docs of [
    [first,{...second,bypass_actors:[{actor_id:APP_ID}]}],
    [{...first,bypass_actors:[{actor_id:123,actor_type:'Integration',bypass_mode:'always'}]},second],
    [{...first,enforcement:'evaluate'},second],
    [{...first,conditions:{ref_name:{include:['refs/heads/knowledge'],exclude:[]}}},second],
    [first,{...second,rules:[{type:'deletion'}]}],
  ])assert.throws(()=>validateRuleSetDetails(list,docs));
  assert.equal(hasRulesetDenial({ok:false,status:422,body:{message:'GH013 Repository rule violations found'}}),true);
  assert.equal(hasRulesetDenial({ok:false,status:403,body:{message:'Resource not accessible by integration'}}),false);
  assert.equal(hasRulesetDenial({ok:false,status:409,body:{message:'not fast forward'}}),false);
  assert.equal(hasRulesetDenial({ok:true,status:200,body:{message:'okay'}}),false);
  console.log('knowledge-canary-probe: actor, exact target and explicit denial fixtures passed');
}
try {
  const cmd=process.argv[2];
  if(cmd==='self-test')selfTest();
  else if(cmd==='ordinary')await ordinary();
  else if(cmd==='app')await app();
  else fail('usage: self-test | ordinary | app');
}catch(err){console.error(err.message);process.exitCode=1;}
