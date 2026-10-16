// Trusted-main, read-only Run Store policy OBSERVABILITY receipt; not a proof
// of protection and not a Store receipt.
//
// Store / Governance Audit exits non-zero whenever it cannot verify the live
// Ruleset policy. That fail-closed alert is correct and stays. But a failed run
// is the ONLY thing the Acceptance harness can see about it — acceptance
// evidence is compacted run metadata, and the harness never reads workflow
// artifacts — so "this read-only credential cannot observe the capability" was
// indistinguishable from "the policy is absent", and a criterion that is
// genuinely unproven was returned as Fail instead of Pending.
//
// This receipt carries the reason through the one channel that does reach an
// evaluator: the job log, re-read independently from GitHub exactly as the
// Metrics Replay denial receipt does.
//
// BOUNDED AUTHORITY: an unobservable capability is NEVER evidence of
// protection. A receipt is emitted only for an unobservable verdict and
// validation rejects any claim that protection is established, that a write
// test passed, or that an external anchor exists. The strongest thing a valid
// receipt can support is Pending instead of Fail. It can never support Pass.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {GOVERNED_REFS,UNOBSERVABLE_CAPABILITIES} from './run-store-policy.mjs';

export const POLICY_OBSERVABILITY_LOG_PREFIX='RUN_STORE_POLICY_OBSERVABILITY_V1 ';
export const POLICY_WORKFLOW='.github/workflows/store-governance-audit.yml';
export const POLICY_WORKFLOW_NAME='Store / Governance Audit';
export const POLICY_OBSERVE_JOB='observe';
// Exactly the triggers Store / Governance Audit declares and the producer's own
// assertTrustedAuditContext accepts. Restricting the collector to `push` was
// wrong: for a paths-filtered workflow, workflow_dispatch (and schedule) are
// legitimate producers, and on an unrelated merge SHA a dispatch is the ONLY way
// an audit exists at all — so the receipt was unreachable and the criterion fell
// back to reading a bare failed run. Trust does not rest on the event name: the
// producer refuses to emit a receipt outside trusted main, and the collector
// independently re-binds the run/attempt/SHA, the main branch and the observe
// job's failure.
export const POLICY_TRIGGER_EVENTS=Object.freeze(['push','workflow_dispatch','schedule']);
export const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const POS=x=>Number.isSafeInteger(x)&&x>0;
// Only a verdict that means "not observable here" may be receipted. A verified
// verdict is expressed by the run succeeding, never by this receipt.
export const UNOBSERVABLE_VERDICTS=Object.freeze([
  'unobservable_by_this_credential','partially_unobservable_by_this_credential']);
const CAPABILITY_NAMES=Object.freeze(Object.values(UNOBSERVABLE_CAPABILITIES));

function telemetry(env){
  if(env?.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||
     !SHA.test(env.GITHUB_SHA??'')||!POS(Number(env.GITHUB_RUN_ID))||
     !POS(Number(env.GITHUB_RUN_ATTEMPT)))return null;
  return {run_id:Number(env.GITHUB_RUN_ID),run_attempt:Number(env.GITHUB_RUN_ATTEMPT),
    sha:env.GITHUB_SHA};
}
// The report is the only accepted source. A caller cannot assert a verdict.
export function makePolicyObservabilityReceipt(env,report){
  const id=telemetry(env);
  const observability=report?.policy_observability;
  if(!id||!observability||
     !UNOBSERVABLE_VERDICTS.includes(observability.verdict))return null;
  const capabilities=[...new Set(observability.unobservable_capabilities??[])];
  const refs=[...new Set(observability.refs_whose_policy_is_unobservable_here??[])];
  // A receipt that names nothing, or names something outside the governed
  // vocabulary, would be an unfalsifiable claim. Refuse to emit it.
  if(capabilities.length===0||capabilities.some(x=>!CAPABILITY_NAMES.includes(x))||
     refs.length===0||refs.some(x=>!GOVERNED_REFS.includes(x))||
     observability.establishes_neither_presence_nor_absence!==true||
     report.protected_by_server_ruleset!==false)return null;
  return Object.freeze({
    schema_version:1,kind:'run_store_policy_observability',
    repository:REPO,workflow:POLICY_WORKFLOW,
    run_id:id.run_id,run_attempt:id.run_attempt,sha:id.sha,ref:env.GITHUB_REF,
    verdict:observability.verdict,
    unobservable_capabilities:Object.freeze(capabilities),
    refs_whose_policy_is_unobservable_here:Object.freeze(refs),
    // These are the bounded facts. Anything that would read as proof of
    // protection is pinned false so a receipt can never be promoted.
    protected_by_server_ruleset:false,
    establishes_neither_presence_nor_absence:true,
    authorized_write_test_verified:false,
    denied_write_test_verified:false,
    externally_anchored:false,
    maximum_supported_result:'Pending',
  });
}
export function validatePolicyObservabilityReceipt(receipt){
  if(receipt?.schema_version!==1||
     receipt.kind!=='run_store_policy_observability'||
     receipt.repository!==REPO||receipt.workflow!==POLICY_WORKFLOW||
     !POS(receipt.run_id)||!POS(receipt.run_attempt)||!SHA.test(receipt.sha??'')||
     receipt.ref!=='refs/heads/main'||
     !UNOBSERVABLE_VERDICTS.includes(receipt.verdict)||
     !Array.isArray(receipt.unobservable_capabilities)||
     receipt.unobservable_capabilities.length===0||
     receipt.unobservable_capabilities.length>CAPABILITY_NAMES.length||
     new Set(receipt.unobservable_capabilities).size!==receipt.unobservable_capabilities.length||
     receipt.unobservable_capabilities.some(x=>!CAPABILITY_NAMES.includes(x))||
     !Array.isArray(receipt.refs_whose_policy_is_unobservable_here)||
     receipt.refs_whose_policy_is_unobservable_here.length===0||
     receipt.refs_whose_policy_is_unobservable_here.length>GOVERNED_REFS.length||
     new Set(receipt.refs_whose_policy_is_unobservable_here).size!==
       receipt.refs_whose_policy_is_unobservable_here.length||
     receipt.refs_whose_policy_is_unobservable_here.some(x=>!GOVERNED_REFS.includes(x))||
     receipt.protected_by_server_ruleset!==false||
     receipt.establishes_neither_presence_nor_absence!==true||
     receipt.authorized_write_test_verified!==false||
     receipt.denied_write_test_verified!==false||
     receipt.externally_anchored!==false||
     receipt.maximum_supported_result!=='Pending')
    throw Error('invalid Run Store policy observability receipt');
  const allowed=new Set(['schema_version','kind','repository','workflow','run_id',
    'run_attempt','sha','ref','verdict','unobservable_capabilities',
    'refs_whose_policy_is_unobservable_here','protected_by_server_ruleset',
    'establishes_neither_presence_nor_absence','authorized_write_test_verified',
    'denied_write_test_verified','externally_anchored','maximum_supported_result']);
  if(Object.keys(receipt).some(k=>!allowed.has(k)))
    throw Error('unexpected receipt fields');
  return receipt;
}
// The receipt is an untrusted claim until GitHub REST independently binds it to
// the exact run/attempt/SHA and to the fail-closed observe job that produced it.
export function attestPolicyObservability(receipt,run,job){
  validatePolicyObservabilityReceipt(receipt);
  if(run?.id!==receipt.run_id||run?.run_attempt!==receipt.run_attempt||
     run?.head_sha!==receipt.sha||run?.head_branch!=='main'||
     run?.name!==POLICY_WORKFLOW_NAME||
     String(run?.path??'').replace(/@refs\/heads\/[^\s]+$/,'')!==POLICY_WORKFLOW||
     run?.repository?.full_name!==REPO||
     run?.head_repository?.full_name!==REPO||
     run?.status!=='completed'||run?.conclusion!=='failure'||
     job?.name!==POLICY_OBSERVE_JOB||job?.run_id!==receipt.run_id||
     job?.run_attempt!==receipt.run_attempt||job?.head_sha!==receipt.sha||
     job?.status!=='completed'||job?.conclusion!=='failure')
    throw Error('Run Store policy observability Run/Attempt/job provenance mismatch');
  return Object.freeze({
    kind:'verified_run_store_policy_observability',
    run_id:receipt.run_id,run_attempt:receipt.run_attempt,sha:receipt.sha,
    verdict:receipt.verdict,
    unobservable_capabilities:receipt.unobservable_capabilities,
    refs_whose_policy_is_unobservable_here:receipt.refs_whose_policy_is_unobservable_here,
    // Restated at the attested layer so a consumer cannot miss it.
    protection_established:false,
    policy_absence_established:false,
    maximum_supported_result:'Pending',
    evidence:'GitHub API Run/Attempt/job outcomes + exact original trusted-main '+
      'observe job log receipt',
  });
}
// Only a trusted-main observe job may produce this, and only one line may.
// A duplicated or ambiguous framing is rejected rather than guessed.
export function parsePolicyObservabilityLog(log){
  if(typeof log!=='string'||log.length>1048576)
    throw Error('invalid Run Store policy observability log size');
  const candidates=log.split(/\r?\n/)
    .filter(line=>line.includes(POLICY_OBSERVABILITY_LOG_PREFIX));
  if(candidates.length!==1)return null;
  const match=candidates[0].match(/RUN_STORE_POLICY_OBSERVABILITY_V1 (\{.*\})\s*$/);
  if(!match||match[1].length>8192)
    throw Error('invalid Run Store policy observability record framing');
  return validatePolicyObservabilityReceipt(JSON.parse(match[1]));
}

function selfTest(){
  const sha='a'.repeat(40);
  const env={GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,
    GITHUB_RUN_ID:'39000000001',GITHUB_RUN_ATTEMPT:'1'};
  const report={protected_by_server_ruleset:false,policy_observability:{
    verdict:'unobservable_by_this_credential',
    unobservable_capabilities:[UNOBSERVABLE_CAPABILITIES.bypass],
    refs_whose_policy_is_unobservable_here:[...GOVERNED_REFS],
    establishes_neither_presence_nor_absence:true}};
  const receipt=makePolicyObservabilityReceipt(env,report);
  assert.equal(validatePolicyObservabilityReceipt(receipt).verdict,
    'unobservable_by_this_credential');
  assert.equal(receipt.maximum_supported_result,'Pending');
  assert.equal(receipt.protected_by_server_ruleset,false);
  assert.equal(receipt.denied_write_test_verified,false);
  const run={id:Number(env.GITHUB_RUN_ID),run_attempt:1,name:POLICY_WORKFLOW_NAME,
    path:POLICY_WORKFLOW,head_branch:'main',head_sha:sha,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion:'failure'};
  const job={name:POLICY_OBSERVE_JOB,run_id:Number(env.GITHUB_RUN_ID),run_attempt:1,
    head_sha:sha,status:'completed',conclusion:'failure'};
  assert.equal(attestPolicyObservability(receipt,run,job).maximum_supported_result,
    'Pending');
  assert.equal(attestPolicyObservability(receipt,
    {...run,path:POLICY_WORKFLOW+'@refs/heads/main'},job).protection_established,
    false);
  const reject=(rr,rn,jb)=>assert.throws(
    ()=>attestPolicyObservability(rr,rn,jb),/mismatch|invalid|unexpected/);
  reject(receipt,{...run,head_sha:'b'.repeat(40)},job);
  reject(receipt,{...run,conclusion:'success'},job);
  reject(receipt,{...run,head_branch:'feature'},job);
  reject(receipt,{...run,name:'Store / Receipt Readback',
    path:'.github/workflows/store-receipt-readback.yml'},job);
  reject(receipt,run,{...job,conclusion:'success'});
  reject(receipt,run,{...job,name:'publish'});
  reject(receipt,run,{...job,run_attempt:2});
  // A verified verdict is expressed by a SUCCESSFUL run, never by a receipt.
  assert.equal(makePolicyObservabilityReceipt(env,{protected_by_server_ruleset:true,
    policy_observability:{verdict:'verified',unobservable_capabilities:[],
      refs_whose_policy_is_unobservable_here:[],
      establishes_neither_presence_nor_absence:false}}),null);
  assert.equal(makePolicyObservabilityReceipt(env,{protected_by_server_ruleset:false,
    policy_observability:{verdict:'observable',unobservable_capabilities:[],
      refs_whose_policy_is_unobservable_here:[],
      establishes_neither_presence_nor_absence:false}}),null);
  // A receipt with nothing named is unfalsifiable.
  assert.equal(makePolicyObservabilityReceipt(env,{protected_by_server_ruleset:false,
    policy_observability:{verdict:'unobservable_by_this_credential',
      unobservable_capabilities:[],refs_whose_policy_is_unobservable_here:[...GOVERNED_REFS],
      establishes_neither_presence_nor_absence:true}}),null);
  assert.equal(makePolicyObservabilityReceipt(env,{protected_by_server_ruleset:false,
    policy_observability:{verdict:'unobservable_by_this_credential',
      unobservable_capabilities:[UNOBSERVABLE_CAPABILITIES.bypass],
      refs_whose_policy_is_unobservable_here:['not-a-store'],
      establishes_neither_presence_nor_absence:true}}),null);
  assert.equal(makePolicyObservabilityReceipt(env,{protected_by_server_ruleset:false,
    policy_observability:{verdict:'unobservable_by_this_credential',
      unobservable_capabilities:['invented_capability'],
      refs_whose_policy_is_unobservable_here:[...GOVERNED_REFS],
      establishes_neither_presence_nor_absence:true}}),null);
  // Untrusted context never produces a receipt.
  assert.equal(makePolicyObservabilityReceipt({...env,GITHUB_REF:'refs/heads/feature'},
    report),null);
  assert.equal(makePolicyObservabilityReceipt({...env,GITHUB_REPOSITORY:'attacker/x'},
    report),null);
  assert.equal(makePolicyObservabilityReceipt({...env,GITHUB_SHA:'short'},report),null);
  assert.equal(makePolicyObservabilityReceipt({...env,GITHUB_RUN_ATTEMPT:'x'},report),null);
  // A receipt may never be mutated into a proof of protection.
  for(const mutation of [
    {...receipt,proof_of_protection:true},
    {...receipt,protected_by_server_ruleset:true},
    {...receipt,establishes_neither_presence_nor_absence:false},
    {...receipt,denied_write_test_verified:true},
    {...receipt,authorized_write_test_verified:true},
    {...receipt,externally_anchored:true},
    {...receipt,maximum_supported_result:'Pass'},
    {...receipt,verdict:'verified'},
    {...receipt,unobservable_capabilities:[]},
    {...receipt,unobservable_capabilities:['invented_capability']},
    {...receipt,refs_whose_policy_is_unobservable_here:[]},
    {...receipt,refs_whose_policy_is_unobservable_here:['refs/heads/main']},
    {...receipt,run_id:0},
    {...receipt,ref:'refs/heads/feature'},
    {...receipt,workflow:'.github/workflows/evil.yml'},
    {...receipt,repository:'attacker/x'},
    {...receipt,private_key:'secret'},
  ])assert.throws(()=>validatePolicyObservabilityReceipt(mutation),
    /invalid|unexpected/);
  const log='2026-10-16T00:00:00Z '+POLICY_OBSERVABILITY_LOG_PREFIX+
    JSON.stringify(receipt)+'\n';
  assert.deepEqual(parsePolicyObservabilityLog(log),receipt);
  assert.equal(parsePolicyObservabilityLog('other job log'),null);
  assert.equal(parsePolicyObservabilityLog(log+log),null);
  console.log('Run Store policy observability receipt: unbounded-to-Pending only, '+
    'independent readback required, owner/verdict/protection mutations rejected');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  selfTest();
