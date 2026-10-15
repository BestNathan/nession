// Read-only server-side policy evaluator. A green source Gate is NOT evidence
// of remote write authorization: only live GitHub REST state can establish
// configured rules, and real positive/negative write tests remain separate.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

export const GOVERNED_REFS=Object.freeze(['acceptance-results','task-results','metrics']);
const REPO='BestNathan/nession';
const positive=x=>Number.isSafeInteger(x)&&x>0;
const SHA=/^[a-f0-9]{40}$/;
function fail(message){throw Error('run-store-policy: '+message);}

// Only accept exact named refs. A wildcard/include-empty ruleset is not
// silently assumed to cover the protected ref; that needs a separate review.
export function coversStoreRef(rule,ref){
  if(!GOVERNED_REFS.includes(ref)||rule?.target!=='branch'||
     rule?.source_type!=='Repository'||rule?.source!==REPO)
    return false;
  const c=rule.conditions?.ref_name;
  if(!Array.isArray(c?.include)||!Array.isArray(c?.exclude))return false;
  const name='refs/heads/'+ref;
  return c.include.includes(name)&&!c.exclude.includes(name)&&
    !c.exclude.includes('~ALL');
}

// Only a dedicated Integration bypass is acceptable. RepoRole/Admin/User
// bypass permits unrelated writes; 'pull_request' cannot append an orphan
// branch, and 'exempt' is unauditable.
export function evaluateStoreRules(ref,rulesets,approvedAppId){
  if(!GOVERNED_REFS.includes(ref)||!Array.isArray(rulesets))
    fail('invalid target or GitHub ruleset response');
  const applicable=rulesets.filter(r=>coversStoreRef(r,ref));
  const candidates=applicable.filter(r=>r.enforcement==='active');
  const required=['creation','update','deletion','non_fast_forward','required_linear_history'];
  const accepted=candidates.find(rule=>{
    const types=new Set((rule.rules??[]).map(x=>x.type));
    const bypass=rule.bypass_actors;
    return required.every(x=>types.has(x))&&positive(approvedAppId)&&
      Array.isArray(bypass)&&bypass.length===1&&
      bypass[0].actor_type==='Integration'&&
      bypass[0].actor_id===approvedAppId&&bypass[0].bypass_mode==='always';
  });
  return {
    ref,configuration_verified:!!accepted,approved_writer_app_id:approvedAppId??null,
    matching_active_ruleset_ids:candidates.map(x=>x.id).filter(positive),
    qualifying_ruleset_id:accepted?.id??null,
    missing_requirements:accepted?[]:[
      'active exact-ref Ruleset','creation/update/deletion/non_fast_forward/required_linear_history',
      'exactly one trusted GitHub App Integration bypass with mode always',
    ],
    // A configuration match is not a live denial test or externally
    // controlled anchor; do not collapse distinct security proofs.
    authorized_write_test_verified:false,
    denied_write_test_verified:false,
    externally_anchored:false,
  };
}
export function validateMigrationBaseline(manifest){
  if(manifest?.schema_version!==1||
     manifest.kind!=='unanchored_run_store_migration_baseline'||
     manifest.repository!==REPO||manifest.trust_level!=='repository_main_observation_only'||
     manifest.independently_anchored!==false||!Array.isArray(manifest.stores))
    fail('invalid baseline or unsupported independence claim');
  const refs=manifest.stores.map(x=>x.ref);
  if(JSON.stringify(refs)!==JSON.stringify(GOVERNED_REFS)||
     new Set(refs).size!==GOVERNED_REFS.length)fail('baseline ref inventory mismatch');
  for(const store of manifest.stores){
    if(!SHA.test(store.head_sha??'')||!SHA.test(store.tree_sha??'')||
       store.baseline_kind!=='pre_enforcement_observation')
      fail('untrusted baseline head/tree identity');
  }
  return true;
}
export function assertTrustedAuditContext(env){
  if(env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||
     !['push','schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||
     !SHA.test(env.GITHUB_SHA??''))fail('audit may run only on trusted main');
  return true;
}
export function runTests(){
  const ref=GOVERNED_REFS[0],app=77881;
  const rule={id:44,target:'branch',source_type:'Repository',source:REPO,
    enforcement:'active',
    conditions:{ref_name:{include:['refs/heads/'+ref],exclude:[]}},
    rules:['creation','update','deletion','non_fast_forward','required_linear_history']
      .map(type=>({type})),
    bypass_actors:[{actor_id:app,actor_type:'Integration',bypass_mode:'always'}]};
  assert.equal(evaluateStoreRules(ref,[rule],app).configuration_verified,true);
  assert.equal(evaluateStoreRules(ref,[rule],app).denied_write_test_verified,false);
  for(const mutation of [
    {...rule,enforcement:'disabled'},
    {...rule,conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}}},
    {...rule,conditions:{ref_name:{include:['refs/heads/'+ref],exclude:['refs/heads/'+ref]}}},
    {...rule,rules:rule.rules.filter(x=>x.type!=='update')},
    {...rule,rules:rule.rules.filter(x=>x.type!=='deletion')},
    {...rule,bypass_actors:[]},
    {...rule,bypass_actors:[{actor_id:app,actor_type:'RepositoryRole',bypass_mode:'always'}]},
    {...rule,bypass_actors:[{actor_id:app,actor_type:'Integration',bypass_mode:'exempt'}]},
    {...rule,bypass_actors:[...rule.bypass_actors,{actor_id:1,actor_type:'User',bypass_mode:'always'}]},
  ])assert.equal(evaluateStoreRules(ref,[mutation],app).configuration_verified,false);
  assert.equal(evaluateStoreRules(ref,[rule],app+1).configuration_verified,false);
  assert.equal(evaluateStoreRules(ref,[{...rule,source:'attacker/repo'}],app).configuration_verified,false);
  assert.throws(()=>evaluateStoreRules('other',[],app),/invalid target/);
  const baseline={schema_version:1,kind:'unanchored_run_store_migration_baseline',
    repository:REPO,trust_level:'repository_main_observation_only',
    independently_anchored:false,stores:GOVERNED_REFS.map(ref=>({
      ref,head_sha:'a'.repeat(40),tree_sha:'b'.repeat(40),
      baseline_kind:'pre_enforcement_observation'}))};
  assert.equal(validateMigrationBaseline(baseline),true);
  assert.throws(()=>validateMigrationBaseline({...baseline,independently_anchored:true}),/baseline/);
  assert.throws(()=>validateMigrationBaseline({...baseline,stores:baseline.stores.slice(1)}),/inventory/);
  assert.equal(assertTrustedAuditContext({GITHUB_REPOSITORY:REPO,
    GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_EVENT_NAME:'schedule'}),true);
  assert.throws(()=>assertTrustedAuditContext({GITHUB_REPOSITORY:REPO,
    GITHUB_REF:'refs/heads/attacker',GITHUB_SHA:'a'.repeat(40),
    GITHUB_EVENT_NAME:'workflow_dispatch'}),/trusted main/);
  console.log('Run Store policy: strict GitHub App Ruleset, migration baseline and untrusted-context fixtures passed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]==='self-test')runTests();
  else fail('usage: self-test');
}
