#!/usr/bin/env node
// Single read-only live governance entrypoint; reuses the canonical
// scripts/audit-live-run-stores.mjs lineage auditor rather than duplicating
// store-specific validation. Report status is never an Acceptance verdict.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {auditLiveRunStores} from './audit-live-run-stores.mjs';
import {GOVERNED_REFS,UNOBSERVABLE_CAPABILITIES,evaluateStoreRules,
  validateMigrationBaseline,assertTrustedAuditContext,
  withRuleParameters} from './run-store-policy.mjs';

const REPO='BestNathan/nession';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fail=reason=>{throw Error('run-store-governance-live: '+reason);};
function api(endpoint){
  const raw=execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],{
    encoding:'utf8',maxBuffer:2*1024*1024,timeout:30000,
    stdio:['ignore','pipe','pipe'],
  });
  return JSON.parse(raw);
}
// REST omits the update rule's parameters entirely, so read the stored value
// from GraphQL. Any failure returns null: the policy then stays unverified
// (fail closed) instead of aborting the audit and losing its independent,
// genuinely passing history/five-mode observation along with it.
function updateRuleParameter(id){
  const query='query($id:Int!){repository(owner:"BestNathan",name:"nession")'+
    '{ruleset(databaseId:$id){rules(first:50){nodes{type parameters{'+
    '... on UpdateParameters{updateAllowsFetchAndMerge}}}}}}}';
  let raw;
  try{
    raw=execFileSync('gh',['api','graphql','-f','query='+query,'-F','id='+id],{
      encoding:'utf8',maxBuffer:2*1024*1024,timeout:30000,stdio:['ignore','pipe','pipe']});
  }catch(error){
    // An unreadable parameter and an absent one are different facts. Swallowing
    // this is how the original check stayed silently unsatisfiable, so report
    // the reason and keep the policy unverified (fail closed) without aborting
    // the audit and discarding its independent observation.
    console.error('::warning::Run Store Ruleset '+id+
      ' update-rule parameter unreadable via GraphQL: '+
      String(error?.message??error).split('\n')[0]+
      ' — policy stays unverified (fail closed)');
    return null;
  }
  // Every branch reports *why* the value is unavailable and returns null. This
  // runs for every ruleset in the repository, including ones unrelated to the
  // governed refs (e.g. a disabled "main" ruleset with no update rule), so an
  // unexpected shape here is an absent parameter — not grounds for aborting the
  // whole audit and discarding its independent observation.
  const ruleset=JSON.parse(raw)?.data?.repository?.ruleset;
  const nodes=ruleset?.rules?.nodes;
  if(!Array.isArray(nodes)){
    console.error('::warning::Run Store Ruleset '+id+' not readable via GraphQL (ruleset='+
      (ruleset===null?'null':'malformed')+') — policy stays unverified (fail closed)');
    return null;
  }
  const update=nodes.filter(node=>node?.type==='UPDATE');
  if(update.length!==1){
    console.error('::warning::Run Store Ruleset '+id+' exposes '+update.length+
      ' UPDATE rule(s); no fetch-and-merge parameter to read — policy stays unverified');
    return null;
  }
  const value=update[0]?.parameters?.updateAllowsFetchAndMerge;
  if(typeof value!=='boolean'){
    console.error('::warning::Run Store Ruleset '+id+
      ' exposes no boolean updateAllowsFetchAndMerge — policy stays unverified');
  }
  return typeof value==='boolean'?value:null;
}
export function summarizeGovernance(manifest,rulesets,appId,history){
  validateMigrationBaseline(manifest);
  if(!Array.isArray(rulesets))fail('unavailable GitHub Ruleset details');
  const decisions=GOVERNED_REFS.map(ref=>evaluateStoreRules(ref,rulesets,appId));
  const records=history?.records??[];
  const coverage=records.length===GOVERNED_REFS.length&&
    new Set(records.map(x=>x.store)).size===GOVERNED_REFS.length&&
    records.every(x=>GOVERNED_REFS.includes(x.store)&&
      x.api_ref_verified===true&&x.mode==='anchored-history');
  const policy=decisions.every(x=>x.configuration_verified);
  // "The policy is not configured" and "this credential cannot see the policy"
  // kept rendering as the same line, so a live, actively enforced Ruleset was
  // indistinguishable from an absent one and every reader had to fall back to
  // the log to tell them apart. The report names the unobservable capability
  // instead. This is deliberately NOT a Pass and NOT a relaxation: the verdict,
  // protected_by_server_ruleset and the non-zero alert are unchanged; only the
  // *reason* stops being reported as evidence of absence.
  const unverified=decisions.filter(x=>!x.configuration_verified);
  const unobservable=unverified.filter(x=>x.unobservable_capabilities.length>0);
  const capabilities=[...new Set(unobservable.flatMap(x=>x.unobservable_capabilities))];
  const observability=policy?'verified':unobservable.length===0?'observable':
    unobservable.length===unverified.length?'unobservable_by_this_credential'
    :'partially_unobservable_by_this_credential';
  const observation=history?.anchoring==='repository_main_migration_observation_only';
  if(!observation)fail('governance observation must not reuse a falsely independent anchor');
  return {
    schema_version:1,kind:'run_store_governance_integrity_observation',
    repository:REPO,
    protected_by_server_ruleset:policy,
    authorized_positive_negative_write_attempts_proven:false,
    externally_controlled_checkpoint_proven:false,
    actual_history_checked_against_unanchored_baseline:coverage,
    run_store_integration_verdict:'Pending',
    baseline_class:'repository_main_observation_only; not independently durable',
    stores:decisions.map((d,i)=>({
      ...d,branch_observed_sha:records.find(x=>x.store===d.ref)?.observed??null,
      checked_commits:records.find(x=>x.store===d.ref)?.checked_commits??null,
      checked_changes:records.find(x=>x.store===d.ref)?.checked_changes??null,
      // Absence of a new author/ingester receipt means authorship of older
      // commits is NOT independently authenticated by this observation.
      commit_writer_identity_attested:false,
    })),
    verified_mutation_drill:'offline fixtures only; no real server-side denied writes',
    alert_channel:'GitHub Actions failed status and retained artifacts only; external WORM alert pending',
    policy_observability:{
      verdict:observability,
      unobservable_capabilities:capabilities,
      refs_whose_policy_is_unobservable_here:unobservable.map(x=>x.ref),
      establishes_neither_presence_nor_absence:unobservable.length>0,
      note:'An unobservable capability is not evidence that the governing policy'+
        ' is absent, and it is not a Pass: it is a bounded limitation of this'+
        ' read-only credential. Resolve it with an identity that can read the'+
        ' named field, or record it as an unsupported administration capability.',
    },
    result:!coverage?'ERROR: incomplete exact-ref history scan':
      policy?'PENDING: real authorized/denied writes and independent external checkpoint':
      observability==='observable'?
        'PENDING: no fully enforced exact-ref App-only write Ruleset':
      'PENDING: unsupported administration capability — this read-only credential cannot observe '+
        capabilities.join(', ')+' on '+unobservable.map(x=>x.ref).join(', ')+
        '; the App-only policy is neither established nor disproven here',
  };
}
async function live(out){
  assertTrustedAuditContext(process.env);
  if(!path.isAbsolute(out))fail('absolute output file required');
  const manifest=JSON.parse(fs.readFileSync(
    path.join(ROOT,'scripts/run-store-migration-baseline.json'),'utf8'));
  validateMigrationBaseline(manifest);
  const records=manifest.stores.map(x=>[x.ref,x.head_sha]);
  const anchors=Object.fromEntries(records);
  const rulesetSummary=api('rulesets?per_page=100');
  if(!Array.isArray(rulesetSummary))fail('GitHub Rulesets are unreadable');
  const details=rulesetSummary.map(row=>{
    if(!Number.isSafeInteger(row.id)||row.id<1)fail('invalid Ruleset ID');
    const detail=api('rulesets/'+row.id);
    // GitHub omits bypass_actors unless the requesting identity has write access
    // to the ruleset, so an absent list means "unreadable here", never "no
    // bypass configured". Without it the App-only bypass cannot be verified at
    // all, which is the difference between a real policy gap and a credential
    // that cannot see the policy.
    if(!Array.isArray(detail?.bypass_actors))
      console.error('::warning::Run Store Ruleset '+row.id+
        ' returns no bypass_actors; the requesting token lacks ruleset write access,'+
        ' so the App-only bypass cannot be verified — policy stays unverified');
    return withRuleParameters(detail,updateRuleParameter(row.id));
  });
  const history=await auditLiveRunStores({
    checkout:ROOT,sourceSha:process.env.GITHUB_SHA,
    anchors,token:process.env.GH_TOKEN??process.env.GITHUB_TOKEN,
    anchorTrust:'main_migration_observation',
    baselineTrees:Object.fromEntries(manifest.stores.map(x=>[x.ref,x.tree_sha])),
  });
  const appId=Number(process.env.STORE_WRITER_APP_ID??0);
  const report=summarizeGovernance(manifest,details,appId,history);
  report.observed_at=new Date().toISOString();
  report.trusted_main_sha=process.env.GITHUB_SHA;
  report.audit_run_id=process.env.GITHUB_RUN_ID??null;
  report.policy_summary=details.map(r=>({id:r.id,enforcement:r.enforcement,
    target:r.target,name:r.name}));
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    '## Store Governance Live Read-only Audit\n\n'+
    '| Branch | Audited changes | App-only branch policy |\n|---|---:|---|\n'+
    report.stores.map(x=>'| '+x.ref+' | '+x.checked_changes+' | '+
      (x.configuration_verified?'configured'
        :x.unobservable_capabilities.length>0?'NOT OBSERVABLE HERE'
        :'NOT CONFIGURED')+' |').join('\n')+
    '\n\n**'+report.result+'**. This is not a true external anchor, writer denial, or SC Pass.\n'+
    (report.policy_observability.establishes_neither_presence_nor_absence?
      '\nBounded limitation: '+report.policy_observability.note+'\n':''));
  console.log('Store governance: '+report.result);
  // Explicit fail-closed alert status on unprotected branch policies. Caller
  // uploads the report even on failure, with zero write permissions.
  if(!report.actual_history_checked_against_unanchored_baseline||
     !report.protected_by_server_ruleset)process.exitCode=1;
}
function selfTest(){
  const sha='a'.repeat(40);
  const migration={schema_version:1,kind:'unanchored_run_store_migration_baseline',
    repository:REPO,trust_level:'repository_main_observation_only',
    independently_anchored:false,stores:GOVERNED_REFS.map(ref=>({
      ref,head_sha:sha,tree_sha:'b'.repeat(40),
      baseline_kind:'pre_enforcement_observation'}))};
  const history={anchoring:'repository_main_migration_observation_only',
    records:GOVERNED_REFS.map(store=>({
      store,observed:sha,api_ref_verified:true,mode:'anchored-history',
      checked_commits:1,checked_changes:2}))};
  const report=summarizeGovernance(migration,[],0,history);
  assert.equal(report.protected_by_server_ruleset,false);
  assert.equal(report.actual_history_checked_against_unanchored_baseline,true);
  assert.equal(report.externally_controlled_checkpoint_proven,false);
  assert.equal(report.authorized_positive_negative_write_attempts_proven,false);
  assert.equal(report.run_store_integration_verdict,'Pending');
  assert.equal(summarizeGovernance(migration,[],0,
    {...history,records:history.records.slice(1)}).actual_history_checked_against_unanchored_baseline,false);
  assert.equal(summarizeGovernance(migration,[],0,
    {...history,records:[history.records[0],history.records[0],history.records[2]]})
    .actual_history_checked_against_unanchored_baseline,false);
  assert.throws(()=>summarizeGovernance(migration,[],0,
    {...history,anchoring:'separately_supplied_secret'}),/falsely independent anchor/);
  // Report layer: an unreadable capability and a real policy gap must not
  // render as the same line. Both stay fail-closed (policy false, alert
  // non-zero); only the reason differs, so a reader can choose Pending over
  // Fail without ever being able to read it as a Pass.
  const refs=GOVERNED_REFS,app=77881;
  const shape=over=>({id:25248129,name:'run-store',target:'branch',
    source_type:'Repository',source:REPO,enforcement:'active',
    conditions:{ref_name:{include:refs.map(r=>'refs/heads/'+r),exclude:[]}},
    rules:['creation','update','deletion','non_fast_forward','required_linear_history']
      .map(type=>type==='update'?{type,parameters:{update_allows_fetch_and_merge:false}}:{type}),
    bypass_actors:[{actor_id:app,actor_type:'Integration',bypass_mode:'always'}],...over});
  // A credential that can read every required field and finds a real match:
  // verified, and the bounded-limitation note stays out of the report.
  const readable=summarizeGovernance(migration,[shape({})],app,history);
  assert.equal(readable.protected_by_server_ruleset,true);
  assert.equal(readable.policy_observability.verdict,'verified');
  assert.equal(readable.policy_observability
    .establishes_neither_presence_nor_absence,false);
  // A bypass the credential can read but that is wrong is a REAL gap.
  const wrong=summarizeGovernance(migration,
    [shape({bypass_actors:[{actor_id:app+1,actor_type:'Integration',bypass_mode:'always'}]})],
    app,history);
  assert.equal(wrong.protected_by_server_ruleset,false);
  assert.equal(wrong.policy_observability.verdict,'observable');
  assert.deepEqual(wrong.policy_observability.unobservable_capabilities,[]);
  assert.match(wrong.result,/no fully enforced exact-ref App-only write Ruleset/);
  // A bypass GitHub withholds is an unsupported capability, not an absence.
  const blind=summarizeGovernance(migration,[shape({bypass_actors:undefined})],app,history);
  assert.equal(blind.protected_by_server_ruleset,false);
  assert.equal(blind.policy_observability.verdict,'unobservable_by_this_credential');
  assert.deepEqual(blind.policy_observability.unobservable_capabilities,
    [UNOBSERVABLE_CAPABILITIES.bypass]);
  assert.deepEqual(blind.policy_observability.refs_whose_policy_is_unobservable_here,refs);
  assert.equal(blind.policy_observability
    .establishes_neither_presence_nor_absence,true);
  assert.match(blind.result,/unsupported administration capability/);
  assert.match(blind.result,/neither established nor disproven/);
  assert.doesNotMatch(blind.result,/no fully enforced/);
  // Mixed: one ref blind, the others a readable failure — both facts survive.
  const mixed=summarizeGovernance(migration,[
    {...shape({bypass_actors:undefined,id:1}),
      conditions:{ref_name:{include:['refs/heads/'+refs[0]],exclude:[]}}},
    {...shape({bypass_actors:[{actor_id:app+1,actor_type:'Integration',
      bypass_mode:'always'}],id:2}),
    conditions:{ref_name:{include:refs.slice(1).map(r=>'refs/heads/'+r),exclude:[]}}},
  ],app,history);
  assert.equal(mixed.policy_observability.verdict,'partially_unobservable_by_this_credential');
  assert.deepEqual(mixed.policy_observability.refs_whose_policy_is_unobservable_here,
    [refs[0]]);
  assert.equal(mixed.protected_by_server_ruleset,false);
  console.log('Run Store governance live summary: incomplete coverage, unprotected refs, unobservable capabilities and no independent checkpoint fail closed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='live'&&process.argv[3])
    await live(process.argv[3]).catch(e=>{
      const out=process.argv[3];
      const incident={schema_version:1,kind:'run_store_governance_integrity_observation',
        repository:REPO,source_sha:process.env.GITHUB_SHA??null,
        audit_run_id:process.env.GITHUB_RUN_ID??null,result:'ERROR',
        store_mutation_performed:false,error:e.message,
        note:'Read-only run failed; no ref repair and no acceptance claim.'};
      if(path.isAbsolute(out)&&fs.existsSync(path.dirname(out))&&!fs.existsSync(out))
        fs.writeFileSync(out,JSON.stringify(incident,null,2)+'\n',{flag:'wx'});
      console.error('::error::'+e.message);
      process.exitCode=1;
    });
  else fail('usage: self-test | live ABS_REPORT');
}
