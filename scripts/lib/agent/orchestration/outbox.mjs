import { createHash } from 'node:crypto';
import { resolveIdentity, validateRegistry } from '../harness/contract.mjs';
import { advanceWorkflow } from './transition.mjs';
import { SOURCE_V2 as QWEN_PREFLIGHT_FAILURE_V2,
  SOURCE_V3 as QWEN_PREFLIGHT_FAILURE_V3 } from './qwen-preflight-failure.mjs';
import {SOURCE as QWEN_CLI_FAILURE} from './qwen-cli-failure.mjs';
import {SOURCE as QWEN_REPAIR_TURNS_FAILURE} from './qwen-repair-turns-failure.mjs';
import {SOURCE as QWEN_TOOL_FAILURE} from './qwen-tool-policy-failure.mjs';
import {SOURCE as QWEN_TRACKED_SOURCE_FAILURE} from './qwen-tracked-source-failure.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ROLE_TASK = { developer: ['implement','repair'], reviewer: ['review'], acceptor: ['accept'] };
const SOURCE_WORKFLOW = Object.freeze({
  developer: { path: '.github/workflows/agent-develop.yml', name: 'Agent / Development' },
  reviewer: { path: '.github/workflows/agent-review.yml', name: 'Agent / Review' },
  quality: { path: '.github/workflows/ci-quality.yml', name: 'CI / Quality Gate' },
  acceptance: { path: '.github/workflows/acceptance-orchestrator.yml', name: 'Acceptance / Orchestrator' },
});
const ACTION_TYPES = new Set(['dispatch','verify','notify']);
const STATUSES = new Set(['pending','dispatching','dispatched','yielded','failed']);
const MAX_SLICES = 64;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_OUTBOX = 128;
const MAX_ATTEMPTS = 5;
const NATIVE_FAILED_RESUME='3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8';
const NATIVE_FAILED_RUN=39376331942;
const NATIVE_FAILURE_CODE='native_cursor_agent_not_found_before_send';
const CONTROLLED_REVIEW_ACTION='555b3351ddb8c7ddbc23ba789f8a8a9560a01cc3112834f15492382e13af4434';
const CONTROLLED_SKIPPED_REVIEW_RUN=39943178597;
const CONTROLLED_REVIEW_SHA='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const CONTROLLED_REPAIR_ACTION='d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
const CONTROLLED_REPAIR_FAILED_RUN=42020432271;
const CONTROLLED_REPAIR_FAILURE='cursor_native_read_missing_uncommitted';
const CONTROLLED_REPAIR_SUCCESSOR='ed14323e0466b23ec739a712ab63bfc16cbbbe225b1118a4cbeab64e419574a5';
const QWEN_PREFLIGHT_FAILURE=Object.freeze({
  issue:2817,
  action_id:'61bced6ae498054e883d8a52d7398e7877852ef6a3c41e93644138a4b47dacb3',
  run_id:42187623195,
  source_sha:'149df703ff383e7bb6958eb6d1448f6ad7248ca6',
  failure_code:'qwen_native_sealing_public_key_missing',
});

export const REVIEWER_PREMODEL_FAILURE=Object.freeze({
  issue:3433,
  action_id:'66a3bf916ce573adda08135524a2bb6d4db2a0a2125cab0bfdce2664e78614b6',
  run_id:43667393107,
  source_sha:'a9b3f9e1d78ef5c9ae0f97136d753da0ca6fc9ba',
  main_sha:'b0c3b58e5a39e48252f0c9be167be3985c283dad',
  publisher_run_id:43607502468,
  failure_code:'qwen_reviewer_publisher_trigger_pre_model_failure',
});
// #4001: separately authenticated pre-model Reviewer failure for #3784.
export const REVIEWER_PREMODEL_FAILURE_3784=Object.freeze({
  issue:3784,
  action_id:'1251328b3288d32c751a347a016ff5d25740704cd8b16e227bd49a6bdd672087',
  run_id:44431618028,
  source_sha:'5d7e9118b7e954e760cc680fff7d43b4f9e17612',
  main_sha:'65da9467375627baa6ea19359b3abedd4515f3ef',
  publisher_run_id:44281178406,
  failure_code:'qwen_reviewer_base_file_premodel_failure',
  state_version:12,
});
// #4097: the exact third-cycle Reviewer failed before its model stage.
export const REVIEWER_PREMODEL_FAILURE_3784_C=Object.freeze({
  issue:3784,
  action_id:'ad5899ead831233a22dcac8856c7029bfebb47d23bb3eb47f0c9e68afaf2c504',
  run_id:44500591865,
  source_sha:'d80e0827ad2d9f2dd548d20fc92b9462681c3094',
  main_sha:'b0a07c1f5a012b8d4814558c15d9df77cec0f887',
  publisher_run_id:44497822207,
  failure_code:'qwen_reviewer_owner_reconciler_premodel_failure',
  state_version:35,
});
// #4192: actual #4065/#4191 Reviewer prepare failed on a valid 161-KiB base.
// This is a terminal pre-model Run: no model or verdict artifacts were emitted.
export const REVIEWER_PREMODEL_FAILURE_4065=Object.freeze({
  issue:4065,
  action_id:'73e869fffc416a387c9058da0fcfa8804d339341e1f1daf89a9111fc57f63127',
  run_id:44744956936,
  source_sha:'f79547b0def78418e109aba82673d7f20edbc341',
  main_sha:'a1e9ae535f5581cfbfeaee6b0ce35a07aab40b3e',
  publisher_run_id:44744656206,
  failure_code:'qwen_reviewer_large_base_premodel_failure',
  state_version:9,
});
export const REVIEWER_TOOL_FAILURE_4065=Object.freeze({
  issue:4065,
  action_id:'320b1a854c198d7f10e2e348b595337ff3cd611e48a73ddbdf5592a8aa57ddde',
  run_id:44776788638,
  source_sha:'8d512ec934770944a208c9e1a797bc155a7a46d2',
  // The actual GitHub Run 44776788638/1 and BOTH original immutable
  // admission/claim Artifacts point to this exact main-owned workflow SHA,
  // not the main commit observed when the Issue was first triaged.
  main_sha:'cef947a7efdeb65bea3272e7797ade607387fe93',
  publisher_run_id:44776472241,
  failure_code:'qwen_reviewer_forbidden_tool_postmodel_failure',
  state_version:19,
});
export const REVIEWER_PREMODEL_FAILURE_SOURCES=Object.freeze([
  REVIEWER_PREMODEL_FAILURE,REVIEWER_PREMODEL_FAILURE_3784,
  REVIEWER_PREMODEL_FAILURE_3784_C,REVIEWER_PREMODEL_FAILURE_4065,
]);
export const REVIEWER_JSON_FAILURE=Object.freeze({
  issue:3433,
  action_id:'8a7bbc2f61ec3bd9b64d7a25281ad5b586e61401b971c02450c3c3ff8ad7faa7',
  run_id:43681851455,
  source_sha:'1159e58c19b927b4e53d4fe594174a50b6bbf092',
  main_sha:'af25010e06a4c39eb172d9ab1df7ab16c83853cd',
  publisher_run_id:43681716536,
  failure_code:'qwen_reviewer_invalid_json_after_model',
});
// #4016: second #3784 Reviewer was rejected after model output, before
// any authenticated Result could exist. This is NOT a changes_requested.
export const REVIEWER_JSON_FAILURE_3784=Object.freeze({
  issue:3784,
  action_id:'3655ed38e7e9247dfd916b6590a5dd3ad540cead5a2cf5c2fa416be7893a28f9',
  run_id:44458253065,
  source_sha:'51f82d64ec159397ea501e6cbb99e7039ee141bd',
  main_sha:'e2de724ddd659810cb4a88927d464f27ef698bb5',
  publisher_run_id:44457994853,
  failure_code:'qwen_reviewer_out_of_scope_finding_post_model',
  state_version:22,
});
export const REVIEWER_JSON_FAILURE_SOURCES=Object.freeze([
  REVIEWER_JSON_FAILURE,REVIEWER_JSON_FAILURE_3784,
]);
function reject(message) { throw new Error('agent outbox: ' + message); }
function isIssue(value) { return Number.isSafeInteger(value) && value > 0; }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) reject('invalid ' + label);
}
function boundRole(registry, agentId, role, task) {
  const instance = registry.instances[agentId];
  if (!instance || instance.role !== role) reject('role or ID is not registered');
  return resolveIdentity(registry, agentId, task, instance.environment);
}
function makeAction(issue, version, action, assignments, index) {
  onlyKeys(action, ['type','role','task','sha','resume','gate','when','reason'], 'transition action');
  if (!ACTION_TYPES.has(action.type) || (action.sha != null && !SHA.test(action.sha)) ||
      !Number.isSafeInteger(version) || version < 1) reject('invalid transition action');
  const role = action.role ?? null;
  if (action.type === 'dispatch' && (!ROLE_TASK[role]?.includes(action.task) || !assignments[role])) {
    reject('unexpected dispatch role/task');
  }
  if (action.type === 'verify' && !['quality','sc-acceptance'].includes(action.gate)) {
    reject('unexpected verification gate');
  }
  if (action.type === 'notify' && typeof action.reason !== 'string') reject('unexpected notification');
  const target = {
    ...action, agent_id: role && assignments[role] || null,
  };
  const id = hash([issue, version, index, target]);
  return { id, task: target, status: 'pending', attempts: 0, receipt: null };
}
export function validateDevelopmentState(state) {
  onlyKeys(state, ['schema_version','issue','version','phase','target_sha','repair_attempts',
    'transitions','outbox','assignments','merged_sha'], 'state');
  if (state.schema_version !== 1 || !isIssue(state.issue) || !positive(state.version) ||
      !['ready','review','repair','quality','acceptance','waiting-merge',
        'post-merge-acceptance','done','blocked'].includes(state.phase) ||
      !Number.isSafeInteger(state.repair_attempts) || state.repair_attempts < 0 ||
      !Array.isArray(state.transitions) || !Array.isArray(state.outbox) ||
      state.outbox.length > MAX_OUTBOX || (state.target_sha != null && !SHA.test(state.target_sha))) {
    reject('invalid state shape');
  }
  if (state.merged_sha != null && !SHA.test(state.merged_sha)) reject('invalid merged SHA');
  onlyKeys(state.assignments, ['developer','reviewer','acceptor'], 'role assignments');
  for (const role of ['developer','reviewer','acceptor']) {
    if (typeof state.assignments[role] !== 'string' ||
        !/^[a-z][a-z0-9-]{1,80}$/.test(state.assignments[role])) reject('missing agent assignment');
  }
  // A recovered Qwen Repair PR-B may be read back and committed by a
  // different successful Publisher Run than the original failed GitHub
  // writer. The extra history link is permitted ONLY on its exact
  // authenticated publisher transition; no alias for another role.
  for(const t of state.transitions){
    if(t.write_ahead_publisher_run_id!==undefined&&
       (t.kind!=='publisher'||t.outcome!=='published'||
        !positive(t.run_id)||!positive(t.write_ahead_publisher_run_id)||
        t.write_ahead_publisher_run_id>=t.run_id||
        !SHA.test(t.target_sha??'')))
      reject('invalid cross-Run Repair Publisher provenance');
  }
  const ids = new Set();
  for (const item of state.outbox) {
    onlyKeys(item, ['id','task','status','attempts','receipt'], 'outbox entry');
    if (!/^[a-f0-9]{64}$/.test(item.id) || ids.has(item.id) || !STATUSES.has(item.status) ||
        !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > MAX_ATTEMPTS) {
      reject('invalid/duplicate outbox entry');
    }
    ids.add(item.id);
    onlyKeys(item.task, ['type','role','task','sha','resume','gate','when','reason','agent_id',
      'continuation','repair_checkpoint'], 'outbox action');
    if(item.task.repair_checkpoint != null){
      // A Review/Quality-induced Repair is a different task and work SHA
      // from the original Developer Slice. Its immutable native checkpoint
      // comes from the previously published, already retired Developer chain,
      // not a synthetic yielded parent in the current Outbox.
      const c=item.task.repair_checkpoint;
      onlyKeys(c,['checkpoint_version','checkpoint_commit_sha',
        'ciphertext_sha256','source_sha','source_run_id'], 'Repair checkpoint');
      const historicalFailedRepair=item.status==='failed'&&(
        (item.id===CONTROLLED_REPAIR_ACTION&&
         item.receipt?.failure_code===CONTROLLED_REPAIR_FAILURE&&
         item.task.sha===CONTROLLED_REVIEW_SHA)||
        (item.id===QWEN_REPAIR_TURNS_FAILURE.action_id&&
         state.issue===QWEN_REPAIR_TURNS_FAILURE.issue&&
         item.receipt?.source_run_id===QWEN_REPAIR_TURNS_FAILURE.run_id&&
         item.receipt?.source_attempt===1&&
         item.receipt?.failure_code===QWEN_REPAIR_TURNS_FAILURE.failure_code&&
         item.task.sha===QWEN_REPAIR_TURNS_FAILURE.source_sha));
      if(Object.keys(c).length!==5||
          item.task.type!=='dispatch'||item.task.role!=='developer'||
          item.task.task!=='repair'||item.task.resume!==true||
          item.task.continuation!=null||
          ((item.task.sha!==state.target_sha||state.phase!=='repair')&&
            !historicalFailedRepair)||
          !positive(c.checkpoint_version)||
          !SHA.test(c.checkpoint_commit_sha??'')||
          !HEX64.test(c.ciphertext_sha256??'')||
          !SHA.test(c.source_sha??'')||c.source_sha===item.task.sha||
          !positive(c.source_run_id)||
          !state.transitions.some(t=>t.kind==='publisher'&&
            t.outcome==='published'&&t.target_sha===item.task.sha)||
          !state.transitions.some(t=>t.kind==='reviewer'&&
            t.outcome==='changes_requested'&&t.target_sha===item.task.sha))
        reject('unbound or invalid cross-phase Repair checkpoint');
    }
    if (item.task.continuation != null) {
      const c=item.task.continuation;
      onlyKeys(c,['parent_action_id','ordinal','checkpoint_version','checkpoint_commit_sha',
        'ciphertext_sha256'], 'Slice continuation');
      const parent=state.outbox.find(x=>x.id===c.parent_action_id && x.status==='yielded');
      if(item.task.type!=='dispatch'||item.task.resume!==true||
          !HEX64.test(c.parent_action_id??'')||!positive(c.ordinal)||c.ordinal>MAX_SLICES||
          !positive(c.checkpoint_version)||!SHA.test(c.checkpoint_commit_sha??'')||
          !HEX64.test(c.ciphertext_sha256??'') || !parent ||
          c.ordinal!==(parent.task.continuation?.ordinal??0)+1 ||
          c.checkpoint_version!==parent.receipt.checkpoint_version ||
          c.checkpoint_commit_sha!==parent.receipt.checkpoint_commit_sha ||
          c.ciphertext_sha256!==parent.receipt.ciphertext_sha256 ||
          item.task.role!==parent.task.role ||
          item.task.agent_id!==parent.task.agent_id ||
          item.task.task!==parent.task.task ||
          item.task.sha!==parent.task.sha ||
          !validNativeRecoveryLineage(state,item) ||
          state.outbox.filter(x=>x.task.continuation?.parent_action_id===parent.id &&
            x.status!=='failed').length!==1) {
        reject('unbound or invalid Slice continuation');
      }
    }
    if (!ACTION_TYPES.has(item.task.type)) reject('unknown action');
    if (item.status === 'dispatching') {
      const receipt=item.receipt;
      onlyKeys(receipt,['status','dispatch_id','issuer_run_id',
        'ticket_sha256'], 'write-ahead dispatch intent');
      if(Object.keys(receipt).length!==4||receipt.status!=='prepared'||
          receipt.dispatch_id!==item.id||!positive(receipt.issuer_run_id)||
          !HEX64.test(receipt.ticket_sha256??'')||
          item.task.type!=='dispatch'||item.attempts<1) {
        reject('invalid persisted dispatch intent');
      }
    } else if (item.status === 'dispatched') {
      if (!item.receipt || !plain(item.receipt) ||
          Object.keys(item.receipt).some(k=>!['status','dispatch_id','source_run_id',
            'rebound_from_run_id','reviewer_recovery'].includes(k)) ||
          !['accepted','verified'].includes(item.receipt.status) ||
          item.receipt.dispatch_id !== item.id ||
          (item.receipt.status === 'verified' && !positive(item.receipt.source_run_id)) ||
          (item.receipt.rebound_from_run_id !== undefined &&
            (item.receipt.status !== 'verified' ||
             !positive(item.receipt.rebound_from_run_id) ||
             item.receipt.rebound_from_run_id === item.receipt.source_run_id))) {
        reject('missing acknowledged dispatch receipt');
      }
      if(item.receipt.reviewer_recovery!==undefined){
        const c=item.receipt.reviewer_recovery;
        onlyKeys(c,['kind','skipped_run_id','issuer_run_id','ticket_sha256'],
          'one-time controlled Reviewer recovery intent');
        if(Object.keys(c).length!==4||
          c.kind!=='controlled_review_recovery_intent'||
          state.issue!==1997||item.id!==CONTROLLED_REVIEW_ACTION||
          item.task.role!=='reviewer'||item.task.sha!==CONTROLLED_REVIEW_SHA||
          item.receipt.source_run_id!==CONTROLLED_SKIPPED_REVIEW_RUN||
          item.receipt.status!=='verified'||item.attempts!==1||
          c.skipped_run_id!==CONTROLLED_SKIPPED_REVIEW_RUN||
          !positive(c.issuer_run_id)||!HEX64.test(c.ticket_sha256??''))
          reject('unbound controlled Reviewer recovery intent');
      }
    } else if (item.status === 'yielded') {
      const c=item.receipt;
      onlyKeys(c,['status','dispatch_id','source_run_id','source_attempt',
        'checkpoint_version','checkpoint_commit_sha','ciphertext_sha256'], 'yield receipt');
      if(c.status!=='yielded'||c.dispatch_id!==item.id||
          !positive(c.source_run_id)||!positive(c.source_attempt)||
          !positive(c.checkpoint_version)||!SHA.test(c.checkpoint_commit_sha??'')||
          !HEX64.test(c.ciphertext_sha256??'')||item.task.type!=='dispatch') {
        reject('invalid committed Slice yield receipt');
      }
    } else if(item.status==='failed') {
      const r=item.receipt;
      onlyKeys(r,['status','dispatch_id','source_run_id','source_attempt',
        'failure_code'],'attested failed Run');
      if(Object.keys(r).length!==5||r.status!=='failed'||
          r.dispatch_id!==item.id||
          !['native_sdk_sandbox_unavailable',NATIVE_FAILURE_CODE,
            CONTROLLED_REPAIR_FAILURE,
            QWEN_PREFLIGHT_FAILURE.failure_code,
            QWEN_PREFLIGHT_FAILURE_V2.failure_code,
            QWEN_PREFLIGHT_FAILURE_V3.failure_code,
            QWEN_CLI_FAILURE.failure_code,
            QWEN_REPAIR_TURNS_FAILURE.failure_code,
            QWEN_TOOL_FAILURE.failure_code,
            QWEN_TRACKED_SOURCE_FAILURE.failure_code,
            REVIEWER_PREMODEL_FAILURE.failure_code,
            REVIEWER_PREMODEL_FAILURE_3784.failure_code,
            REVIEWER_PREMODEL_FAILURE_3784_C.failure_code,
            REVIEWER_PREMODEL_FAILURE_4065.failure_code,
            REVIEWER_TOOL_FAILURE_4065.failure_code,
            REVIEWER_JSON_FAILURE.failure_code,
            REVIEWER_JSON_FAILURE_3784.failure_code].includes(r.failure_code)||
          (r.failure_code===QWEN_PREFLIGHT_FAILURE.failure_code&&(
            state.issue!==QWEN_PREFLIGHT_FAILURE.issue||
            item.id!==QWEN_PREFLIGHT_FAILURE.action_id||
            item.task.agent_id!=='dev-qwen-01'||
            item.task.task!=='implement'||item.task.sha!==QWEN_PREFLIGHT_FAILURE.source_sha||
            r.source_run_id!==QWEN_PREFLIGHT_FAILURE.run_id))||
          (r.failure_code===QWEN_PREFLIGHT_FAILURE_V2.failure_code&&(
            state.issue!==QWEN_PREFLIGHT_FAILURE_V2.issue||
            item.id!==QWEN_PREFLIGHT_FAILURE_V2.action_id||
            item.task.agent_id!=='dev-qwen-01'||
            item.task.task!=='implement'||
            item.task.sha!==QWEN_PREFLIGHT_FAILURE_V2.source_sha||
            r.source_run_id!==QWEN_PREFLIGHT_FAILURE_V2.run_id))||
          (REVIEWER_JSON_FAILURE_SOURCES.some(f=>
            f.failure_code===r.failure_code)&&
            !REVIEWER_JSON_FAILURE_SOURCES.some(f=>
              f.failure_code===r.failure_code&&state.issue===f.issue&&
              item.id===f.action_id&&item.task.role==='reviewer'&&
              item.task.agent_id==='review-qwen-01'&&item.task.task==='review'&&
              item.task.sha===f.source_sha&&r.source_run_id===f.run_id&&
              r.source_attempt===1))||
          (r.failure_code===REVIEWER_PREMODEL_FAILURE.failure_code&&(
            state.issue!==REVIEWER_PREMODEL_FAILURE.issue||
            item.id!==REVIEWER_PREMODEL_FAILURE.action_id||
            item.task.role!=='reviewer'||item.task.agent_id!=='review-qwen-01'||
            item.task.task!=='review'||
            item.task.sha!==REVIEWER_PREMODEL_FAILURE.source_sha||
            r.source_run_id!==REVIEWER_PREMODEL_FAILURE.run_id||
            r.source_attempt!==1))||
          (r.failure_code===REVIEWER_PREMODEL_FAILURE_3784.failure_code&&(
            state.issue!==REVIEWER_PREMODEL_FAILURE_3784.issue||
            item.id!==REVIEWER_PREMODEL_FAILURE_3784.action_id||
            item.task.role!=='reviewer'||item.task.agent_id!=='review-qwen-01'||
            item.task.task!=='review'||
            item.task.sha!==REVIEWER_PREMODEL_FAILURE_3784.source_sha||
            r.source_run_id!==REVIEWER_PREMODEL_FAILURE_3784.run_id||
            r.source_attempt!==1))||
          (r.failure_code===REVIEWER_TOOL_FAILURE_4065.failure_code&&(
            state.issue!==REVIEWER_TOOL_FAILURE_4065.issue||
            item.id!==REVIEWER_TOOL_FAILURE_4065.action_id||
            item.task.role!=='reviewer'||item.task.agent_id!=='review-qwen-01'||
            item.task.task!=='review'||item.task.sha!==REVIEWER_TOOL_FAILURE_4065.source_sha||
            r.source_run_id!==REVIEWER_TOOL_FAILURE_4065.run_id||
            r.source_attempt!==1))||
          (r.failure_code===REVIEWER_PREMODEL_FAILURE_4065.failure_code&&(
            state.issue!==REVIEWER_PREMODEL_FAILURE_4065.issue||
            item.id!==REVIEWER_PREMODEL_FAILURE_4065.action_id||
            item.task.role!=='reviewer'||item.task.agent_id!=='review-qwen-01'||
            item.task.task!=='review'||
            item.task.sha!==REVIEWER_PREMODEL_FAILURE_4065.source_sha||
            r.source_run_id!==REVIEWER_PREMODEL_FAILURE_4065.run_id||
            r.source_attempt!==1))||
          (r.failure_code===REVIEWER_PREMODEL_FAILURE_3784_C.failure_code&&(
            state.issue!==REVIEWER_PREMODEL_FAILURE_3784_C.issue||
            item.id!==REVIEWER_PREMODEL_FAILURE_3784_C.action_id||
            item.task.role!=='reviewer'||item.task.agent_id!=='review-qwen-01'||
            item.task.task!=='review'||
            item.task.sha!==REVIEWER_PREMODEL_FAILURE_3784_C.source_sha||
            r.source_run_id!==REVIEWER_PREMODEL_FAILURE_3784_C.run_id||
            r.source_attempt!==1))||
          (r.failure_code===QWEN_TRACKED_SOURCE_FAILURE.failure_code&&(
            state.issue!==QWEN_TRACKED_SOURCE_FAILURE.issue||
            item.id!==QWEN_TRACKED_SOURCE_FAILURE.action_id||
            item.task.agent_id!=='dev-qwen-01'||
            item.task.role!=='developer'||
            item.task.task!=='implement'||
            item.task.sha!==QWEN_TRACKED_SOURCE_FAILURE.source_sha||
            r.source_run_id!==QWEN_TRACKED_SOURCE_FAILURE.run_id||
            r.source_attempt!==1))||
          (r.failure_code===QWEN_TOOL_FAILURE.failure_code&&(
            state.issue!==QWEN_TOOL_FAILURE.issue||
            item.id!==QWEN_TOOL_FAILURE.action_id||
            item.task.agent_id!=='dev-qwen-01'||
            item.task.role!=='developer'||
            item.task.task!=='implement'||
            item.task.sha!==QWEN_TOOL_FAILURE.source_sha||
            r.source_run_id!==QWEN_TOOL_FAILURE.run_id||
            r.source_attempt!==1))||
          (r.failure_code===QWEN_REPAIR_TURNS_FAILURE.failure_code&&(
            state.issue!==QWEN_REPAIR_TURNS_FAILURE.issue||
            item.id!==QWEN_REPAIR_TURNS_FAILURE.action_id||
            item.task.agent_id!=='dev-qwen-01'||
            item.task.role!=='developer'||item.task.task!=='repair'||
            item.task.resume!==true||
            item.task.sha!==QWEN_REPAIR_TURNS_FAILURE.source_sha||
            item.task.repair_checkpoint?.checkpoint_version!==
              QWEN_REPAIR_TURNS_FAILURE.checkpoint_version||
            r.source_run_id!==QWEN_REPAIR_TURNS_FAILURE.run_id||
            r.source_attempt!==1))||
          (r.failure_code===QWEN_CLI_FAILURE.failure_code&&(
            state.issue!==QWEN_CLI_FAILURE.issue||
            item.id!==QWEN_CLI_FAILURE.action_id||
            item.task.agent_id!=='dev-qwen-01'||
            item.task.role!=='developer'||
            item.task.task!=='implement'||
            item.task.sha!==QWEN_CLI_FAILURE.source_sha||
            r.source_run_id!==QWEN_CLI_FAILURE.run_id||
            r.source_attempt!==1))||
          (r.failure_code===QWEN_PREFLIGHT_FAILURE_V3.failure_code&&(
            state.issue!==QWEN_PREFLIGHT_FAILURE_V3.issue||
            item.id!==QWEN_PREFLIGHT_FAILURE_V3.action_id||
            item.task.agent_id!=='dev-qwen-01'||
            item.task.task!=='implement'||
            item.task.sha!==QWEN_PREFLIGHT_FAILURE_V3.source_sha||
            r.source_run_id!==QWEN_PREFLIGHT_FAILURE_V3.run_id))||
          (r.failure_code===CONTROLLED_REPAIR_FAILURE&&(
            item.id!==CONTROLLED_REPAIR_ACTION||
            r.source_run_id!==CONTROLLED_REPAIR_FAILED_RUN||
            item.task.task!=='repair'||
            item.task.sha!==CONTROLLED_REVIEW_SHA||
            item.task.repair_checkpoint?.checkpoint_version!==3))||
          (r.failure_code===NATIVE_FAILURE_CODE &&
            (item.id!==NATIVE_FAILED_RESUME||r.source_run_id!==NATIVE_FAILED_RUN||
             item.task.continuation?.checkpoint_version!==1))||
          !positive(r.source_run_id)||!positive(r.source_attempt)||
          item.task.type!=='dispatch'||
          (item.task.role!=='developer'&&
            !(item.task.role==='reviewer'&&
              [REVIEWER_PREMODEL_FAILURE.failure_code,
                REVIEWER_PREMODEL_FAILURE_3784.failure_code,
                REVIEWER_PREMODEL_FAILURE_3784_C.failure_code,
                REVIEWER_PREMODEL_FAILURE_4065.failure_code,
                REVIEWER_TOOL_FAILURE_4065.failure_code,
                REVIEWER_JSON_FAILURE.failure_code,
                REVIEWER_JSON_FAILURE_3784.failure_code].includes(r.failure_code))))
        reject('invalid authenticated failure receipt');
    } else if (item.receipt !== null) reject('unacknowledged item has receipt');
  }
  return state;
}
// The caller independently authenticates the workflow_dispatch actor via GitHub.
// An Issue comment body, Agent tool response, or fork-originated event cannot
// be passed as the start authority.
export function startDevelopment(registry, request, authority) {
  validateRegistry(registry);
  onlyKeys(request, ['issue','sha','developer','reviewer','acceptor'], 'start request');
  if (!isIssue(request.issue) || !SHA.test(request.sha ?? '') ||
      !authority || authority.repository !== 'BestNathan/nession' ||
      authority.event !== 'workflow_dispatch' || authority.permission !== 'write' ||
      authority.ref !== 'refs/heads/main' || !positive(authority.run_id)) {
    reject('unauthorized start request');
  }
  const assignments = {};
  for (const role of ['developer','reviewer','acceptor']) {
    boundRole(registry, request[role], role, ROLE_TASK[role][0]);
    assignments[role] = request[role];
  }
  const state = {
    schema_version: 1, issue: request.issue, version: 1, phase: 'ready',
    target_sha: null, repair_attempts: 0, transitions: [], assignments,
    outbox: [makeAction(request.issue,1,
      { type:'dispatch',role:'developer',task:'implement',sha:request.sha },assignments,0)],
  };
  return validateDevelopmentState(state);
}
function expectedSource(state, result, source) {
  onlyKeys(result, ['kind','issue','run_id','run_attempt','target_sha','outcome','task_id'], 'task result');
  const expected = result.kind==='acceptance'&&source?.event==='workflow_run'&&
    source.path==='.github/workflows/acceptance-pr-quality-waker.yml'
    ? {path:'.github/workflows/acceptance-pr-quality-waker.yml',name:'Acceptance / PR Quality Waker'}
    : SOURCE_WORKFLOW[result.kind];
  if (!expected || !positive(result.run_id) || !positive(result.run_attempt) ||
      !isIssue(result.issue) || result.issue !== state.issue || !SHA.test(result.target_sha ?? '')) {
    reject('invalid result or source kind');
  }
  onlyKeys(source, ['repository','path','name','run_id','attempt','event','ref',
    'issue','task_id','agent_id','input_sha','output_sha','verified'], 'trusted source');
  if (source.verified !== true || source.repository !== 'BestNathan/nession' ||
      source.ref !== 'refs/heads/main' || source.path !== expected.path ||
      source.name !== expected.name || source.event !== 'workflow_dispatch' &&
      source.event !== 'pull_request' && source.event !== 'workflow_run' ||
      source.run_id !== result.run_id || source.attempt !== result.run_attempt ||
      source.issue !== result.issue || source.task_id !== result.task_id ||
      source.output_sha !== result.target_sha || !SHA.test(source.input_sha ?? '')) {
    reject('untrusted or mismatched source');
  }
  const candidates = state.outbox.filter(item =>
    item.id === result.task_id && item.status === 'dispatched');
  if (candidates.length !== 1) reject('task has not been dispatched or was already consumed');
  const previous = candidates[0];
  const expectedKind = previous.task.type === 'dispatch' ? previous.task.role :
    previous.task.gate === 'quality' ? 'quality' :
    previous.task.gate === 'sc-acceptance' ? 'acceptance' : null;
  // The native worker must echo this deterministic action ID in its runtime
  // inputs; a GitHub workflow_dispatch HTTP 204 contains no downstream run_id.
  if (previous.receipt?.dispatch_id !== result.task_id) reject('dispatch binding missing');
  if (result.kind !== expectedKind || source.input_sha !== previous.task.sha) {
    reject('result is not for the outstanding role or exact source SHA');
  }
  if (previous.task.type === 'dispatch' &&
      (source.agent_id !== state.assignments[result.kind] ||
       previous.task.agent_id !== source.agent_id)) reject('wrong Agent instance');
  if (previous.task.type === 'verify' && source.agent_id != null) reject('verification may not impersonate Agent');
  return previous;
}
export function acceptTaskResult(state, expectedVersion, result, source, registry) {
  validateDevelopmentState(state);
  validateRegistry(registry);
  if (expectedVersion !== state.version) reject('stale state CAS');
  const task = expectedSource(state,result,source);
  if (state.transitions.some(x => x.run_id === result.run_id && x.attempt === result.run_attempt &&
      x.kind === result.kind)) reject('source run already consumed');
  const attest = { workflow_run_id: result.run_id, attempt: result.run_attempt,
    issue: result.issue, source_sha: result.target_sha, role: result.kind };
  const advanced = advanceWorkflow(state,result,attest);
  if (advanced.duplicate) reject('duplicate event with inconsistent task correlation');
  const version = state.version + 1;
  // Immutable previous workflow states retain the audit trail. Once an
  // authenticated final Task result is consumed, prune its bounded chain of
  // yielded Slices so it cannot fill the Outbox or leave stale continuations.
  const completed = new Set([task.id]);
  let parentId=task.task.continuation?.parent_action_id;
  for(let i=0;parentId && i<MAX_SLICES;i++){
    const parent=state.outbox.find(x=>x.id===parentId);
    if(!parent || parent.status!=='yielded'||completed.has(parentId))
      reject('broken prior Slice lineage');
    completed.add(parentId);
    parentId=parent.task.continuation?.parent_action_id;
  }
  if(parentId)reject('exhausted Slice lineage');
  const outbox = advanced.state.outbox.filter(x => !completed.has(x.id));
  if (outbox.length + advanced.actions.length > MAX_OUTBOX) reject('outbox size limit exceeded');
  const spawned = advanced.actions.map((a,i) => {
    const entry = makeAction(state.issue,version,a,state.assignments,i);
    if (entry.task.type === 'dispatch') {
      boundRole(registry,entry.task.agent_id,entry.task.role,entry.task.task);
    }
    return entry;
  });
  return validateDevelopmentState({
    ...advanced.state, schema_version:1, version, outbox:[...outbox,...spawned],
  });
}
// The live Outbox keeps one proposal chain per Developer. A trusted
// publication retires that chain: the pending resume can never be dispatched
// again (#2137), and every yielded ancestor plus any failed attested sibling
// under it is pruned so no orphan continuation remains. The immutable prior
// state versions written by state-store retain the full audit trail.
function supersededProposalChain(state, pending) {
  const removed = new Set([pending.id]);
  let parentId = pending.task.continuation?.parent_action_id;
  for (let i = 0; parentId && i < MAX_SLICES; i++) {
    const parent = state.outbox.find(x => x.id === parentId);
    if (!parent || removed.has(parent.id) || parent.status !== 'yielded')
      reject('broken superseded Developer lineage');
    removed.add(parent.id);
    parentId = parent.task.continuation?.parent_action_id;
  }
  if (parentId) reject('exhausted superseded Developer lineage');
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of state.outbox) {
      if (removed.has(item.id)) continue;
      if (removed.has(item.task.continuation?.parent_action_id)) {
        removed.add(item.id);
        changed = true;
      }
    }
  }
  return removed;
}

// A publication is accepted only from an authenticated Publisher Run whose
// observed PR head is the event target. It supersedes exactly one pending
// Developer proposal and enqueues the single Reviewer dispatch selected by
// advanceWorkflow; the caller cannot choose the next role.
export function acceptPublisherPublication(state, expectedVersion, event, trusted, registry) {
  validateDevelopmentState(state);
  validateRegistry(registry);
  if (expectedVersion !== state.version) reject('stale state CAS');
  if (event?.kind !== 'publisher' || event?.outcome !== 'published' ||
      !positive(event?.run_id) || !positive(event?.run_attempt) ||
      !SHA.test(event?.target_sha ?? '') || event?.issue !== state.issue ||
      trusted?.role !== 'publisher' || trusted?.workflow_run_id !== event.run_id ||
      trusted?.attempt !== event.run_attempt || trusted?.issue !== event.issue ||
      trusted?.source_sha !== event.target_sha) reject('authenticated publication required');
  const prior = state.transitions.find(x => x.kind === 'publisher' &&
    x.run_id === event.run_id && x.attempt === event.run_attempt);
  if (prior) {
    if (prior.target_sha !== event.target_sha || prior.outcome !== event.outcome ||
        (prior.reviewer_agent_id ?? null) !== (event.reviewer_agent_id ?? null))
      reject('conflicting publication replay');
    return state; // the same authenticated publication is idempotent
  }
  if (state.phase !== 'ready' || state.target_sha != null)
    reject('publication requires the ready proposal phase');
  if (state.outbox.some(x => ['dispatching', 'dispatched'].includes(x.status)))
    reject('publication cannot race an in-flight dispatch');
  const proposals = state.outbox.filter(x =>
    x.status === 'pending' && x.task.type === 'dispatch' && x.task.role === 'developer');
  if (proposals.length !== 1) reject('exactly one pending Developer proposal is required');
  if (state.outbox.some(x =>
    x.status === 'pending' && x.task.type === 'dispatch' && x.task.role === 'reviewer'))
    reject('a Reviewer action is already pending');
  if (event.reviewer_agent_id != null) {
    const replacement = registry.instances?.[event.reviewer_agent_id];
    if (typeof event.reviewer_agent_id !== 'string' || !replacement ||
        replacement.role !== 'reviewer')
      reject('replacement reviewer is not a registered reviewer');
    resolveIdentity(registry, event.reviewer_agent_id, 'review', replacement.environment);
    if (state.assignments.reviewer === event.reviewer_agent_id)
      reject('replacement reviewer is already assigned');
  }
  const advanced = advanceWorkflow(state, event, trusted);
  if (advanced.duplicate) reject('duplicate publication event');
  const superseded = supersededProposalChain(state, proposals[0]);
  const version = state.version + 1;
  const outbox = advanced.state.outbox.filter(x => !superseded.has(x.id));
  if (outbox.length + advanced.actions.length > MAX_OUTBOX) reject('outbox size limit exceeded');
  const assignments = advanced.state.assignments ?? state.assignments;
  const spawned = advanced.actions.map((action, index) => {
    const entry = makeAction(state.issue, version, action, assignments, index);
    if (entry.task.type === 'dispatch') {
      boundRole(registry, entry.task.agent_id, entry.task.role, entry.task.task);
    }
    return entry;
  });
  return validateDevelopmentState({
    ...advanced.state, schema_version: 1, version, outbox: [...outbox, ...spawned],
  });
}
// #2274: The Qwen Developer produced a REAL authenticated Worker Run and
// immutable Store checkpoint, then the independently credentialed Publisher
// published its exact original patch. Unlike historical #1997 yielded Slices,
// the original Qwen Action stays dispatched until this publication is checked.
// Keep the canonical publisher->review transition (including the publisher
// transition required by native Repair); never fabricate a pending Developer.
export function acceptAttestedQwenPublication(state,expectedVersion,event,trusted,registry){
  validateDevelopmentState(state);
  validateRegistry(registry);
  if(state.version!==expectedVersion)reject('stale Qwen publication state CAS');
  if(event?.kind!=='publisher'||event.outcome!=='published'||
      event.issue!==state.issue||!positive(event.run_id)||
      event.run_attempt!==1||!SHA.test(event.target_sha??'')||
      trusted?.role!=='publisher'||trusted.workflow_run_id!==event.run_id||
      trusted.attempt!==1||trusted.issue!==event.issue||
      trusted.source_sha!==event.target_sha||
      !HEX64.test(trusted.developer_action_id??'')||
      !positive(trusted.developer_run_id)||trusted.developer_attempt!==1||
      !SHA.test(trusted.developer_source_sha??'')||
      !SHA.test(trusted.checkpoint_commit_sha??'')||
      typeof trusted.pr_number!=='number'||!positive(trusted.pr_number)||
      event.reviewer_agent_id!=null)
    reject('untrusted signed Qwen publication and PR/Checkpoint origin');
  const already=state.transitions.find(t=>t.kind==='publisher'&&
    t.run_id===event.run_id&&t.attempt===event.run_attempt);
  if(already){
    if(already.target_sha!==event.target_sha||
        already.outcome!=='published'||state.target_sha!==event.target_sha)
      reject('conflicting authenticated Qwen publication replay');
    return state;
  }
  if(state.phase!=='ready'||state.target_sha!=null||
      state.transitions.some(t=>t.kind==='publisher'))
    reject('Qwen publication requires unconsumed ready phase');
  const actions=state.outbox.filter(x=>x.task.type==='dispatch'&&
    x.task.role==='developer'&&x.status==='dispatched');
  if(actions.length!==1||actions[0].id!==trusted.developer_action_id||
      actions[0].task.task!=='implement'||
      actions[0].task.agent_id!=='dev-qwen-01'||
      state.assignments.developer!=='dev-qwen-01'||
      actions[0].task.sha!==trusted.developer_source_sha||
      actions[0].receipt?.status!=='verified'||
      actions[0].receipt?.source_run_id!==trusted.developer_run_id||
      actions[0].receipt?.dispatch_id!==actions[0].id||
      state.outbox.some(x=>x!==actions[0]&&
        ['dispatching','dispatched'].includes(x.status))||
      state.outbox.some(x=>x.task.role==='reviewer'))
    reject('Qwen Publisher source is not one signed in-flight Developer Run');
  const advanced=advanceWorkflow(state,event,{
    role:'publisher',workflow_run_id:event.run_id,attempt:1,
    issue:event.issue,source_sha:event.target_sha});
  if(advanced.duplicate||advanced.actions.length!==1||
      advanced.actions[0].role!=='reviewer'||
      advanced.state.phase!=='review'||
      advanced.state.target_sha!==event.target_sha)
    reject('Publisher did not produce one canonical Reviewer action');
  const outbox=advanced.state.outbox.filter(x=>x.id!==actions[0].id);
  if(outbox.length+1>MAX_OUTBOX)reject('Outbox exhausted');
  const child=makeAction(state.issue,state.version+1,advanced.actions[0],
    state.assignments,0);
  boundRole(registry,child.task.agent_id,child.task.role,child.task.task);
  return validateDevelopmentState({...advanced.state,version:state.version+1,
    outbox:[...outbox,child]});
}
// #3592. A previously authenticated pre-model Reviewer failure is terminal,
// not a competing live Reviewer. Keep its immutable evidence in Store, but
// require its exact known Run/Action/failure identity. Any other Reviewer
// still blocks a new Qwen Repair publication.
export function hasOnlyRetiredReviewerForQwenRepair(state){
  const entries=state?.outbox?.filter(x=>x.task?.role==='reviewer');
  if(!Array.isArray(entries))return false;
  if(entries.length===0)return true;
  // Each retired Reviewer must match a separately authenticated historical
  // failure. Two pinned #3784 failures can coexist; no arbitrary failed,
  // active, duplicate, or cross-Issue Reviewer is allowed.
  const allowed=[
    ...REVIEWER_PREMODEL_FAILURE_SOURCES,...REVIEWER_JSON_FAILURE_SOURCES,
    REVIEWER_TOOL_FAILURE_4065,
  ].filter(f=>f.issue===state?.issue);
  if(entries.length>allowed.length)return false;
  const seen=new Set();
  return entries.every(old=>{
    const f=allowed.find(source=>source.action_id===old.id);
    if(!f||seen.has(f.action_id))return false;
    seen.add(f.action_id);
    return old.status==='failed'&&old.task.type==='dispatch'&&
      old.task.task==='review'&&old.task.agent_id==='review-qwen-01'&&
      old.task.sha===f.source_sha&&old.attempts===1&&
      old.receipt?.status==='failed'&&old.receipt?.dispatch_id===f.action_id&&
      old.receipt?.source_run_id===f.run_id&&
      old.receipt?.source_attempt===1&&
      old.receipt?.failure_code===f.failure_code;
  });
}

// #2137: The separately authenticated Qwen Repair Publisher has already
// verified the original PR and a non-force A->B update by exact GET readback.
// This state transition may ONLY retire the existing signed Repair Action and
// enqueue the same registered Reviewer at SHA B. Model-produced text, a new PR,
// or an unverified GitHub response cannot serve as this trusted source.
export function acceptAttestedQwenRepairPublication(
  state,expectedVersion,event,trusted,registry,
){
  validateDevelopmentState(state);
  validateRegistry(registry);
  if(state.version!==expectedVersion)reject('stale Qwen Repair Publisher CAS');
  if(event?.kind!=='publisher'||event.outcome!=='published'||
      event.issue!==state.issue||!positive(event.run_id)||
      event.run_attempt!==1||!SHA.test(event.target_sha??'')||
      trusted?.role!=='publisher'||
      trusted.workflow_run_id!==event.run_id||trusted.attempt!==1||
      trusted.issue!==event.issue||trusted.source_sha!==event.target_sha||
      !HEX64.test(trusted.developer_action_id??'')||
      !positive(trusted.developer_run_id)||
      trusted.developer_attempt!==1||
      !SHA.test(trusted.developer_source_sha??'')||
      !SHA.test(trusted.checkpoint_commit_sha??'')||
      !positive(trusted.original_publisher_run_id)||
      !positive(trusted.pr_number)||
      trusted.pr_previous_sha!==trusted.developer_source_sha||
      event.reviewer_agent_id!=null||
      (trusted.write_ahead_publisher_run_id!==undefined&&
        (!positive(trusted.write_ahead_publisher_run_id)||
         trusted.write_ahead_publisher_run_id>=event.run_id)))
    reject('Qwen Repair requires signed Worker, existing PR and exact readback');
  const previous=state.transitions.find(t=>
    t.kind==='publisher'&&t.run_id===event.run_id&&t.attempt===1);
  if(previous){
    if(previous.outcome!=='published'||
        previous.target_sha!==event.target_sha||
        state.target_sha!==event.target_sha)
      reject('conflicting Qwen Repair PR readback replay');
    return state;
  }
  if(state.phase!=='repair'||state.target_sha!==trusted.developer_source_sha||
      state.target_sha===event.target_sha||
      state.assignments.developer!=='dev-qwen-01'||
      state.assignments.reviewer!=='review-qwen-01')
    reject('Qwen Repair Publisher wrong Review phase or PR SHA A');
  const latest=state.transitions.at(-1);
  const original=state.transitions.filter(t=>t.kind==='publisher'&&
    t.outcome==='published'&&t.target_sha===state.target_sha);
  const first=state.transitions.filter(t=>t.kind==='publisher'&&
    t.outcome==='published'&&
    t.run_id===trusted.original_publisher_run_id);
  // #4030/#3885: current PR-B may be authored by a prior Repair Publisher.
  // Separately enforce the first immutable PR owner and the current SHA.
  if(latest?.kind!=='reviewer'||latest.outcome!=='changes_requested'||
      latest.target_sha!==state.target_sha||
      original.length!==1||original[0].attempt!==1||
      first.length!==1||first[0].attempt!==1||
      state.transitions.indexOf(first[0])>
        state.transitions.indexOf(original[0])||
      state.transitions.indexOf(original[0])>=
        state.transitions.indexOf(latest))
    reject('Qwen Repair missing latest authenticated Reviewer dispute');
  const tasks=state.outbox.filter(x=>x.task.type==='dispatch'&&
    x.task.role==='developer'&&x.status==='dispatched');
  if(tasks.length!==1||tasks[0].id!==trusted.developer_action_id||
      tasks[0].task.task!=='repair'||
      tasks[0].task.agent_id!=='dev-qwen-01'||
      tasks[0].task.sha!==state.target_sha||
      tasks[0].task.resume!==true||
      tasks[0].task.repair_checkpoint==null||
      tasks[0].receipt?.status!=='verified'||
      tasks[0].receipt.source_run_id!==trusted.developer_run_id||
      tasks[0].receipt.dispatch_id!==tasks[0].id||
      state.outbox.some(x=>x!==tasks[0]&&
        ['dispatching','dispatched'].includes(x.status))||
      !hasOnlyRetiredReviewerForQwenRepair(state))
    reject('Qwen Repair lacks one completed signed Developer dispatch');
  const next=advanceWorkflow(state,event,{
    role:'publisher',workflow_run_id:event.run_id,attempt:1,
    issue:event.issue,source_sha:event.target_sha});
  if(next.duplicate||next.actions.length!==1||
      next.actions[0].role!=='reviewer'||
      next.state.phase!=='review'||next.state.target_sha!==event.target_sha)
    reject('repair PR SHA B did not produce canonical Reviewer');
  const remaining=next.state.outbox.filter(x=>x.id!==tasks[0].id);
  if(remaining.length+1>MAX_OUTBOX)reject('Repair Outbox exhausted');
  const child=makeAction(state.issue,state.version+1,next.actions[0],
    state.assignments,0);
  boundRole(registry,child.task.agent_id,child.task.role,child.task.task);
  const transitions=next.state.transitions.map((transition,index)=>
    index===next.state.transitions.length-1&&
      trusted.write_ahead_publisher_run_id!==undefined
      ?{...transition,
        write_ahead_publisher_run_id:trusted.write_ahead_publisher_run_id}
      :transition);
  return validateDevelopmentState({...next.state,version:state.version+1,
    transitions,outbox:[...remaining,child]});
}

// Bind an independently verified immutable Developer checkpoint to a pending
// cross-phase Repair. Do not create a new Action or alter its identity: the
// signed ticket must refer to this exact Store-persisted origin and PR target.
// This is the only state transition allowed before a Repair dispatch intent.
const REPAIR_PROOF_FIELDS=['verified','checkpoint_version','checkpoint_commit_sha',
  'ciphertext_sha256','source_sha','source_run_id'];
export function bindVerifiedRepairCheckpoint(state,expectedVersion,actionId,proof){
  validateDevelopmentState(state);
  if(state.version!==expectedVersion)reject('stale Repair checkpoint CAS');
  onlyKeys(proof,REPAIR_PROOF_FIELDS,'authenticated Repair checkpoint proof');
  if(Object.keys(proof).length!==REPAIR_PROOF_FIELDS.length||
     proof.verified!==true||
     !positive(proof.checkpoint_version)||
     !SHA.test(proof.checkpoint_commit_sha??'')||
     !HEX64.test(proof.ciphertext_sha256??'')||
     !SHA.test(proof.source_sha??'')||!positive(proof.source_run_id))
    reject('missing independently authenticated Repair checkpoint');
  const item=state.outbox.find(x=>x.id===actionId);
  if(!item||item.status!=='pending'||item.task.type!=='dispatch'||
     item.task.role!=='developer'||item.task.task!=='repair'||
     item.task.resume!==true||item.task.sha!==state.target_sha||
     state.phase!=='repair'||state.outbox.filter(x=>
       x.status==='pending'&&x.task.role==='developer').length!==1)
    reject('Repair checkpoint can bind only one pending Developer Action');
  const origin={checkpoint_version:proof.checkpoint_version,
    checkpoint_commit_sha:proof.checkpoint_commit_sha,
    ciphertext_sha256:proof.ciphertext_sha256,
    source_sha:proof.source_sha,source_run_id:proof.source_run_id};
  if(item.task.repair_checkpoint){
    if(JSON.stringify(item.task.repair_checkpoint)!==JSON.stringify(origin))
      reject('conflicting Repair checkpoint origin');
    return state;
  }
  if(item.task.continuation!=null)
    reject('cross-phase Repair must not reuse a same-task Slice continuation');
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:state.outbox.map(x=>x.id===actionId?
      {...x,task:{...x.task,repair_checkpoint:origin}}:x)});
}

// Persist this transition *before* any non-idempotent workflow_dispatch API
// call. A crash after GitHub accepts but before its HTTP response is ambiguous:
// reconciliation must authenticate the original downstream Run, NEVER replay
// the POST from a write-ahead intent. Immutable prior state versions preserve
// the original unsigned pending action and its signed ticket hash.
export function recordDispatchIntent(state,expectedVersion,actionId,intent) {
  validateDevelopmentState(state);
  if(expectedVersion!==state.version)reject('stale state CAS');
  onlyKeys(intent,['status','dispatch_id','issuer_run_id','ticket_sha256'],
    'write-ahead intent');
  if(Object.keys(intent).length!==4||intent.status!=='prepared'||
      intent.dispatch_id!==actionId||!positive(intent.issuer_run_id)||
      !HEX64.test(intent.ticket_sha256??''))reject('invalid write-ahead intent');
  const item=state.outbox.find(x=>x.id===actionId);
  if(!item||item.task.type!=='dispatch')reject('write-ahead action missing');
  if(item.status==='dispatching'){
    if(JSON.stringify(item.receipt)!==JSON.stringify(intent))
      reject('conflicting write-ahead dispatch intent');
    return state;
  }
  if(item.status!=='pending')reject('write-ahead action not pending');
  if(item.attempts>=MAX_ATTEMPTS)reject('retry limit reached');
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:state.outbox.map(x=>x.id===actionId?{
      ...x,status:'dispatching',attempts:x.attempts+1,receipt:intent,
    }:x)});
}

export function recordDispatch(state, expectedVersion, actionId, receipt) {
  validateDevelopmentState(state);
  if (expectedVersion !== state.version) reject('stale state CAS');
  const old = state.outbox.find(item => item.id === actionId);
  if (!old) reject('outbox action absent');
  // A receipt is generated by a trusted dispatcher after the target API
  // accepted the dispatch. Never trust a model-generated receipt.
  onlyKeys(receipt,['status','dispatch_id','source_run_id'], 'dispatch receipt');
  if (!['accepted','verified'].includes(receipt.status) || receipt.dispatch_id !== actionId ||
      (receipt.status === 'verified' && !positive(receipt.source_run_id)) ||
      (receipt.status === 'accepted' && receipt.source_run_id != null)) {
    reject('invalid trusted dispatch receipt');
  }
  if (old.status === 'dispatched') {
    if (JSON.stringify(old.receipt) !== JSON.stringify(receipt)) reject('conflicting receipt');
    return state; // repeat confirmation of the same dispatch is idempotent
  }
  if (!['pending','dispatching'].includes(old.status))
    reject('cannot dispatch a yielded or nonpending action');
  if (old.attempts >= MAX_ATTEMPTS && old.status==='pending')
    reject('retry limit reached');
  return validateDevelopmentState({
    ...state,version: state.version+1,
    outbox:state.outbox.map(item => item.id === actionId ? {
      ...item,status:'dispatched',attempts:item.attempts+(item.status==='pending'?1:0),receipt,
    } : item),
  });
}

// A verified dispatch receipt that points at a skipped owner-guard Run may be
// re-bound exactly once to the authenticated replacement. The skipped Run is
// retained in the receipt for audit; later re-bindings are rejected.
const REBINDING_FIELDS=['schema_version','kind','action_id','issue','role',
  'skipped_run_id','replacement_run_id','verified_main_sha'];
export function recordReboundDispatch(state,expectedVersion,actionId,attestation){
  validateDevelopmentState(state);
  if(expectedVersion!==state.version)reject('stale state CAS');
  onlyKeys(attestation,REBINDING_FIELDS,'skipped dispatch rebinding');
  if(Object.keys(attestation).length!==REBINDING_FIELDS.length||
      attestation.schema_version!==1||
      attestation.kind!=='skipped_dispatch_rebinding'||
      attestation.action_id!==actionId||attestation.issue!==state.issue||
      !['developer','reviewer'].includes(attestation.role)||
      !positive(attestation.skipped_run_id)||
      !positive(attestation.replacement_run_id)||
      attestation.skipped_run_id===attestation.replacement_run_id||
      !SHA.test(attestation.verified_main_sha??''))
    reject('invalid skipped dispatch rebinding');
  const item=state.outbox.find(x=>x.id===actionId);
  if(!item||item.status!=='dispatched'||item.task.role!==attestation.role||
      item.receipt?.status!=='verified'||item.receipt.dispatch_id!==actionId)
    reject('rebinding action is not a verified dispatch');
  if(item.receipt.source_run_id===attestation.replacement_run_id&&
      item.receipt.rebound_from_run_id===attestation.skipped_run_id)return state;
  if(item.receipt.source_run_id!==attestation.skipped_run_id)
    reject('receipt does not point at the skipped Run');
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:state.outbox.map(x=>x.id===actionId?{...x,receipt:{
      status:'verified',dispatch_id:actionId,
      source_run_id:attestation.replacement_run_id,
      rebound_from_run_id:attestation.skipped_run_id,
    }}:x)});
}

// Historical #1997: persist one no-redelivery fence BEFORE replacing the
// owner-guard-skipped Review Run. The old receipt stays authoritative until a
// later, independently attested successful signed replacement is ingested.
export function recordControlledReviewerRecoveryIntent(state,expectedVersion,actionId,intent){
  validateDevelopmentState(state);
  if(state.version!==19||expectedVersion!==19||state.issue!==1997||
     state.phase!=='review'||state.target_sha!==CONTROLLED_REVIEW_SHA||
     actionId!==CONTROLLED_REVIEW_ACTION)
    reject('historical Reviewer recovery target has changed');
  onlyKeys(intent,['kind','skipped_run_id','issuer_run_id','ticket_sha256',
    'source_verified'],'controlled Reviewer recovery request');
  if(Object.keys(intent).length!==5||
     intent.kind!=='controlled_review_recovery_intent'||
     intent.skipped_run_id!==CONTROLLED_SKIPPED_REVIEW_RUN||
     intent.source_verified!==true||!positive(intent.issuer_run_id)||
     !HEX64.test(intent.ticket_sha256??''))
    reject('unverified historical Reviewer recovery request');
  const item=state.outbox.find(x=>x.id===actionId);
  if(item?.status!=='dispatched'||item.task.role!=='reviewer'||
     item.task.task!=='review'||item.task.agent_id!=='review-qwen-01'||
     item.task.sha!==CONTROLLED_REVIEW_SHA||item.attempts!==1||
     item.receipt?.status!=='verified'||
     item.receipt.source_run_id!==CONTROLLED_SKIPPED_REVIEW_RUN||
     item.receipt.dispatch_id!==actionId||
     item.receipt.reviewer_recovery!==undefined||
     state.transitions?.some(t=>t.kind==='reviewer'))
    reject('Reviewer action already changed or recovery already attempted');
  const recovery={kind:intent.kind,skipped_run_id:intent.skipped_run_id,
    issuer_run_id:intent.issuer_run_id,ticket_sha256:intent.ticket_sha256};
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:state.outbox.map(x=>x.id===actionId?{...x,
      receipt:{...x.receipt,reviewer_recovery:recovery}}:x)});
}
// #3578: an authenticated pre-model Reviewer failure gets one new Action ID.
// The previous signed dispatch and its Run are immutable; no replay of the old POST.
export function reviewerPremodelSuccessorId(issue,actionId,runId){
  const f=REVIEWER_PREMODEL_FAILURE_SOURCES.find(x=>
    x.issue===issue&&x.action_id===actionId&&x.run_id===runId);
  if(!f)reject('unrecognized Reviewer pre-model recovery source');
  return hash([issue,actionId,runId,'qwen-reviewer-admission-premodel-recovery-v1']);
}
export function recordAttestedReviewerPremodelFailure(state,version,proof){
  const f=REVIEWER_PREMODEL_FAILURE_SOURCES.find(x=>
    x.issue===proof?.issue&&x.action_id===proof?.action_id&&
    x.run_id===proof?.run_id);
  if(!f)reject('unrecognized Reviewer pre-model recovery source');
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','failure_code'],'Reviewer admission failure proof');
  const old=state.outbox.find(x=>x.id===f.action_id);
  if(f===REVIEWER_PREMODEL_FAILURE_3784_C){
    // Historical v35 C remains the only eligible replacement. Verify every
    // signed A→B→C transition and pre-existing reviewer/developer history
    // before committing one successor. A drifted PR is rejected separately
    // by the trusted Controller's exact-ref source verifier.
    const t=state.transitions, last=t.at(-1);
    const p=t.filter(x=>x.kind==='publisher'&&x.outcome==='published');
    const expectedPublished=[
      [44281178406,'5d7e9118b7e954e760cc680fff7d43b4f9e17612'],
      [44457994853,'51f82d64ec159397ea501e6cbb99e7039ee141bd'],
      [44497822207,f.source_sha],
    ];
    const history=state.outbox.filter(x=>x.id!==f.action_id);
    if(state.issue!==3784||state.version!==35||version!==35||
       state.phase!=='review'||state.target_sha!==f.source_sha||
       state.repair_attempts!==2||t.length!==5||p.length!==3||
       p.some((x,i)=>x.run_id!==expectedPublished[i][0]||
         x.target_sha!==expectedPublished[i][1]||x.attempt!==1)||
       t[1]?.kind!=='reviewer'||t[1].outcome!=='changes_requested'||
       t[1].run_id!==44457049411||
       t[3]?.kind!=='reviewer'||t[3].outcome!=='changes_requested'||
       t[3].run_id!==44466992692||
       last!==p[2]||last.write_ahead_publisher_run_id!==44476308903||
       state.assignments.developer!=='dev-qwen-01'||
       state.assignments.reviewer!=='review-qwen-01'||
       state.outbox.length!==6||history.length!==5||
       history.filter(x=>x.status==='failed').length!==5||
       proof.verified!==true||proof.issue!==f.issue||
       proof.action_id!==f.action_id||proof.run_id!==f.run_id||
       proof.attempt!==1||proof.source_sha!==f.source_sha||
       proof.failure_code!==f.failure_code||
       old?.status!=='dispatched'||old.attempts!==1||
       old.task.type!=='dispatch'||old.task.role!=='reviewer'||
       old.task.task!=='review'||old.task.agent_id!=='review-qwen-01'||
       old.task.sha!==f.source_sha||
       old.receipt?.status!=='verified'||
       old.receipt?.dispatch_id!==f.action_id||
       old.receipt?.source_run_id!==f.run_id||
       state.outbox.some(x=>x.id===reviewerPremodelSuccessorId(
         f.issue,f.action_id,f.run_id)))
      reject('unverified or already consumed #3784 C pre-model Reviewer source');
    const successorId=reviewerPremodelSuccessorId(f.issue,f.action_id,f.run_id);
    if(state.outbox.length>=MAX_OUTBOX)
      reject('bounded Reviewer successor Outbox exhausted');
    const failed={...old,status:'failed',receipt:{
      status:'failed',dispatch_id:old.id,source_run_id:f.run_id,
      source_attempt:1,failure_code:f.failure_code}};
    return validateDevelopmentState({...state,version:version+1,
      outbox:[...state.outbox.map(x=>x.id===f.action_id?failed:x),
        {id:successorId,task:{...old.task},status:'pending',
          attempts:0,receipt:null}]});
  }
  if(state.issue!==f.issue||version!==(f.state_version??6)||
     state.version!==version||
     state.phase!=='review'||state.target_sha!==f.source_sha||
     state.transitions.length!==1||
     !state.transitions.some(t=>t.kind==='publisher'&&
       t.run_id===f.publisher_run_id&&t.attempt===1&&
       t.target_sha===f.source_sha&&t.outcome==='published')||
     (f.issue===4065
       ?(state.outbox.length!==2||state.repair_attempts!==0||
         !state.outbox.some(x=>
           x.id===QWEN_TRACKED_SOURCE_FAILURE.action_id&&
           x.status==='failed'&&x.task.role==='developer'&&
           x.task.task==='implement'&&
           x.task.sha===QWEN_TRACKED_SOURCE_FAILURE.source_sha&&
           x.receipt?.source_run_id===QWEN_TRACKED_SOURCE_FAILURE.run_id&&
           x.receipt?.failure_code===QWEN_TRACKED_SOURCE_FAILURE.failure_code))
       :f.issue===3784
       ?(state.outbox.length!==3||
         !state.outbox.some(x=>x.id===QWEN_CLI_FAILURE.action_id&&x.status==='failed')||
         !state.outbox.some(x=>x.id===QWEN_TOOL_FAILURE.action_id&&x.status==='failed'))
       :state.outbox.length!==1)||
     state.assignments.developer!=='dev-qwen-01'||
     state.assignments.reviewer!=='review-qwen-01'||
     proof.verified!==true||proof.issue!==f.issue||
     proof.action_id!==f.action_id||proof.run_id!==f.run_id||
     proof.attempt!==1||proof.source_sha!==f.source_sha||
     proof.failure_code!==f.failure_code||
     old?.status!=='dispatched'||old.attempts!==1||
     old.task.type!=='dispatch'||old.task.role!=='reviewer'||
     old.task.task!=='review'||old.task.agent_id!=='review-qwen-01'||
     old.task.sha!==f.source_sha||
     old.receipt?.status!=='verified'||
     old.receipt?.dispatch_id!==f.action_id||
     old.receipt?.source_run_id!==f.run_id||
     state.transitions.some(t=>t.kind==='reviewer'))
    reject('unverified or already consumed Reviewer admission failure');
  const nextId=reviewerPremodelSuccessorId(f.issue,f.action_id,f.run_id);
  if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(x=>x.id===nextId))
    reject('Reviewer successor collision or bounded Outbox exhausted');
  const failed={...old,status:'failed',receipt:{
    status:'failed',dispatch_id:old.id,source_run_id:f.run_id,
    source_attempt:1,failure_code:f.failure_code}};
  const successor={id:nextId,task:{...old.task},status:'pending',
    attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[...state.outbox.map(x=>x.id===f.action_id?failed:x),
      successor]});
}

// #4211: an independently attested policy-denied post-model Reviewer may
// retire only the exact consumed Action and mint one new signed successor.
export function reviewerToolSuccessorId(issue,actionId,runId){
  const f=REVIEWER_TOOL_FAILURE_4065;
  if(issue!==f.issue||actionId!==f.action_id||runId!==f.run_id)
    reject('unrecognized Reviewer tool-policy source');
  return hash([issue,actionId,runId,'qwen-reviewer-readonly-denial-recovery-v1']);
}
export function recordAttestedReviewerToolFailure(state,version,proof){
  const f=REVIEWER_TOOL_FAILURE_4065;
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','failure_code'],'Reviewer native tool failure proof');
  const old=state.outbox.find(o=>o.id===f.action_id);
  const first=state.outbox.find(o=>
    o.id==='73e869fffc416a387c9058da0fcfa8804d339341e1f1daf89a9111fc57f63127');
  const developer=state.outbox.find(o=>
    o.id==='f085d5919b3277e4fb68d49f48f9a311a83ad5032a90ec651aba93392888eb44');
  const expected=[
    ['publisher',44744656206,'published','f79547b0def78418e109aba82673d7f20edbc341'],
    ['reviewer',44773349621,'changes_requested','f79547b0def78418e109aba82673d7f20edbc341'],
    ['publisher',f.publisher_run_id,'published',f.source_sha],
  ];
  const transitionsOk=Array.isArray(state.transitions)&&
    state.transitions.length===expected.length&&
    expected.every(([kind,run_id,outcome,target_sha],i)=>{
      const x=state.transitions[i];
      return x.kind===kind&&x.run_id===run_id&&x.attempt===1&&
        x.outcome===outcome&&x.target_sha===target_sha;
    });
  if(state.issue!==f.issue||state.version!==f.state_version||
     version!==f.state_version||state.phase!=='review'||
     state.target_sha!==f.source_sha||state.repair_attempts!==1||
     state.assignments?.developer!=='dev-qwen-01'||
     state.assignments?.reviewer!=='review-qwen-01'||
     !transitionsOk||state.outbox.length!==3||
     developer?.status!=='failed'||
     developer.receipt?.failure_code!=='qwen_tracked_source_gate_rejected'||
     developer.receipt?.source_run_id!==44733719096||
     first?.status!=='failed'||
     first.receipt?.failure_code!=='qwen_reviewer_large_base_premodel_failure'||
     first.receipt?.source_run_id!==44744956936||
     old?.status!=='dispatched'||old.attempts!==1||
     old.task.type!=='dispatch'||old.task.role!=='reviewer'||
     old.task.task!=='review'||old.task.agent_id!=='review-qwen-01'||
     old.task.sha!==f.source_sha||old.receipt?.status!=='verified'||
     old.receipt.dispatch_id!==f.action_id||
     old.receipt.source_run_id!==f.run_id||
     proof?.verified!==true||proof.issue!==f.issue||
     proof.action_id!==f.action_id||proof.run_id!==f.run_id||
     proof.attempt!==1||proof.source_sha!==f.source_sha||
     proof.failure_code!==f.failure_code)
    reject('unverified or consumed #4065 Reviewer tool-policy failure');
  const id=reviewerToolSuccessorId(f.issue,f.action_id,f.run_id);
  if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(o=>o.id===id))
    reject('Reviewer tool-policy successor collision');
  const failed={...old,status:'failed',receipt:{status:'failed',
    dispatch_id:old.id,source_run_id:f.run_id,source_attempt:1,
    failure_code:f.failure_code}};
  const successor={id,task:{...old.task},status:'pending',attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[...state.outbox.map(o=>o.id===f.action_id?failed:o),successor]});
}

// #3601: one exact *post-model* Reviewer output-format failure has no
// accepted result Artifact. Retire only its verified signed Run and add one
// deterministic successor. The original immutable repair Publisher and older
// pre-model Reviewer failure remain intact; do not fabricate a verdict.
export function reviewerJsonSuccessorId(issue,actionId,runId){
  const f=REVIEWER_JSON_FAILURE_SOURCES.find(f=>
    issue===f.issue&&actionId===f.action_id&&runId===f.run_id);
  if(!f)reject('unrecognized JSON Reviewer recovery source');
  return hash([issue,actionId,runId,'qwen-reviewer-json-failure-recovery-v1']);
}
export function recordAttestedReviewerJsonFailure(state,version,proof){
  const f=REVIEWER_JSON_FAILURE_SOURCES.find(f=>
    f.issue===proof?.issue&&f.action_id===proof?.action_id&&
    f.run_id===proof?.run_id);
  const p=REVIEWER_PREMODEL_FAILURE;
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','failure_code'],'Reviewer JSON failure proof');
  if(!f)reject('unknown Reviewer post-model failure source');
  if(f.issue===3784){
    const prem=REVIEWER_PREMODEL_FAILURE_3784;
    const old=state.outbox.find(x=>x.id===f.action_id);
    const history=state.outbox.find(x=>x.id===prem.action_id);
    const reviewers=state.outbox.filter(x=>x.task.role==='reviewer');
    const developers=state.outbox.filter(x=>x.task.role==='developer');
    const t=state.transitions;
    if(state.issue!==f.issue||state.version!==f.state_version||
       version!==f.state_version||state.phase!=='review'||
       state.target_sha!==f.source_sha||state.repair_attempts!==1||
       state.assignments.developer!=='dev-qwen-01'||
       state.assignments.reviewer!=='review-qwen-01'||
       t.length!==3||t[0].kind!=='publisher'||t[0].outcome!=='published'||
       t[0].target_sha!==prem.source_sha||t[0].run_id!==prem.publisher_run_id||
       t[1].kind!=='reviewer'||t[1].outcome!=='changes_requested'||
       t[1].run_id!==44457049411||t[1].target_sha!==prem.source_sha||
       t[2].kind!=='publisher'||t[2].outcome!=='published'||
       t[2].run_id!==f.publisher_run_id||t[2].target_sha!==f.source_sha||
       state.outbox.length!==4||reviewers.length!==2||developers.length!==2||
       ![44250586057,44256663685].every(runId=>developers.some(d=>
         d.status==='failed'&&d.task.task==='implement'&&
         d.receipt?.source_run_id===runId))||
       history?.status!=='failed'||history.task.sha!==prem.source_sha||
       history.receipt?.status!=='failed'||
       history.receipt?.source_run_id!==prem.run_id||
       history.receipt?.failure_code!==prem.failure_code||
       old?.status!=='dispatched'||old.attempts!==1||
       old.task.type!=='dispatch'||old.task.role!=='reviewer'||
       old.task.task!=='review'||old.task.agent_id!=='review-qwen-01'||
       old.task.sha!==f.source_sha||old.receipt?.status!=='verified'||
       old.receipt?.dispatch_id!==f.action_id||
       old.receipt?.source_run_id!==f.run_id||
       proof?.verified!==true||proof.issue!==f.issue||
       proof.action_id!==f.action_id||proof.run_id!==f.run_id||
       proof.attempt!==1||proof.source_sha!==f.source_sha||
       proof.failure_code!==f.failure_code)
      reject('unverified or already consumed #3784 post-model Reviewer failure');
    const id=reviewerJsonSuccessorId(f.issue,f.action_id,f.run_id);
    if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(x=>x.id===id))
      reject('Reviewer recovery Action collision');
    const failed={...old,status:'failed',receipt:{status:'failed',
      dispatch_id:f.action_id,source_run_id:f.run_id,source_attempt:1,
      failure_code:f.failure_code}};
    const successor={id,task:{...old.task},status:'pending',
      attempts:0,receipt:null};
    return validateDevelopmentState({...state,version:version+1,
      outbox:[...state.outbox.map(x=>x.id===f.action_id?failed:x),successor]});
  }
  const old=state.outbox.find(x=>x.id===f.action_id);
  const historical=state.outbox.find(x=>x.id===p.action_id);
  const current=state.transitions.at(-1);
  if(state.issue!==f.issue||state.version!==16||version!==16||
     state.phase!=='review'||state.target_sha!==f.source_sha||
     state.assignments.developer!=='dev-qwen-01'||
     state.assignments.reviewer!=='review-qwen-01'||
     state.transitions.length!==3||
     current?.kind!=='publisher'||current.outcome!=='published'||
     current.run_id!==f.publisher_run_id||current.attempt!==1||
     current.target_sha!==f.source_sha||
     current.write_ahead_publisher_run_id!==43678506569||
     state.transitions.some(t=>t.kind==='reviewer'&&
       t.target_sha===f.source_sha)||
     state.outbox.length!==2||
     historical?.status!=='failed'||
     historical.receipt?.source_run_id!==p.run_id||
     historical.receipt.failure_code!==p.failure_code||
     old?.status!=='dispatched'||old.attempts!==1||
     old.task.type!=='dispatch'||old.task.role!=='reviewer'||
     old.task.task!=='review'||old.task.agent_id!=='review-qwen-01'||
     old.task.sha!==f.source_sha||
     old.receipt?.status!=='verified'||
     old.receipt.dispatch_id!==f.action_id||
     old.receipt.source_run_id!==f.run_id||
     proof?.verified!==true||proof.issue!==f.issue||
     proof.action_id!==f.action_id||proof.run_id!==f.run_id||
     proof.attempt!==1||proof.source_sha!==f.source_sha||
     proof.failure_code!==f.failure_code)
    reject('unverified or already consumed JSON Reviewer failure');
  const id=reviewerJsonSuccessorId(f.issue,f.action_id,f.run_id);
  if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(x=>x.id===id))
    reject('JSON Reviewer recovery Action collision');
  const failed={...old,status:'failed',receipt:{status:'failed',
    dispatch_id:f.action_id,source_run_id:f.run_id,source_attempt:1,
    failure_code:f.failure_code}};
  const successor={id,task:{...old.task},status:'pending',
    attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[...state.outbox.map(x=>x.id===f.action_id?failed:x),successor]});
}

// A terminal failed continuation may have one replacement, but NEVER a second
// live sibling. Only this exact historically attested #1997 Run is eligible.
export function nativeResumeSuccessorId(issue,actionId,runId){
  if(issue!==1997||actionId!==NATIVE_FAILED_RESUME||runId!==NATIVE_FAILED_RUN)
    reject('unsupported native Resume recovery');
  return hash([issue,actionId,runId,'native-cursor-resume-lookup-recovery-v1']);
}
function validNativeRecoveryLineage(state,item){
  const c=item.task.continuation;
  const ordinary=hash([c.parent_action_id,c.checkpoint_version,c.ordinal,c.checkpoint_commit_sha]);
  if(item.id===ordinary)return true;
  if(state.issue!==1997||ordinary!==NATIVE_FAILED_RESUME||item.status==='failed')return false;
  const failed=state.outbox.find(x=>x.id===ordinary&&x.status==='failed'&&
    x.receipt?.failure_code===NATIVE_FAILURE_CODE&&x.receipt.source_run_id===NATIVE_FAILED_RUN);
  return Boolean(failed&&item.id===nativeResumeSuccessorId(state.issue,ordinary,NATIVE_FAILED_RUN)&&
    JSON.stringify(item.task)===JSON.stringify(failed.task));
}
// The Controller must attest the historical Run independently before this call.
// Pure state mutation: no Provider invocation, no GitHub POST.
export function recordAttestedNativeResumeFailure(state,expectedVersion,actionId,source){
  validateDevelopmentState(state);
  if(state.version!==expectedVersion)reject('stale native recovery CAS');
  onlyKeys(source,['verified','issue','run_id','attempt','failure_code'],
    'attested native Resume failure');
  const old=state.outbox.find(x=>x.id===actionId);
  if(source.verified!==true||source.issue!==1997||state.issue!==1997||
    source.run_id!==NATIVE_FAILED_RUN||source.attempt!==1||
    source.failure_code!==NATIVE_FAILURE_CODE||actionId!==NATIVE_FAILED_RESUME||
    old?.status!=='dispatched'||old.receipt?.status!=='verified'||
    old.receipt.source_run_id!==NATIVE_FAILED_RUN||old.attempts!==1||
    old.task.role!=='developer'||old.task.agent_id!=='dev-cursor-01'||
    old.task.task!=='implement'||old.task.resume!==true||
    old.task.sha!=='220266b9233ec97b1beacbc54e5cc7f82d3cece2'||
    old.task.continuation?.checkpoint_commit_sha!=='d812e3655c0ad6337b1003aa0c1794c12335adb0'||
    old.task.continuation?.checkpoint_version!==1||
    state.outbox.some(x=>x.id!==actionId&&x.task.continuation?.parent_action_id===
      old.task.continuation.parent_action_id))
    reject('unverified, conflicting or already recovered native Resume');
  const id=nativeResumeSuccessorId(state.issue,actionId,NATIVE_FAILED_RUN);
  if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(x=>x.id===id))
    reject('native recovery action collision or Outbox exhausted');
  const failed={...old,status:'failed',receipt:{status:'failed',dispatch_id:old.id,
    source_run_id:NATIVE_FAILED_RUN,source_attempt:1,failure_code:NATIVE_FAILURE_CODE}};
  const successor={id,task:{...old.task},status:'pending',attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:[...state.outbox.map(x=>x.id===actionId?failed:x),successor]});
}

// A bounded Worker may end at a Provider-safe checkpoint without declaring the
// Issue task complete. Caller MUST authenticate GitHub Run/Attempt/Artifact and
// verify that the checkpoint has already been committed at the remote Store SHA.
// This pure transition never writes a ref or mints a workflow dispatch token.
export function recordSliceYield(state,expectedVersion,actionId,checkpoint,source) {
  validateDevelopmentState(state);
  if (state.version!==expectedVersion) reject('stale state CAS');
  const old=state.outbox.find(item=>item.id===actionId);
  if (!old || old.task.type!=='dispatch') reject('Slice action absent or is not an Agent dispatch');
  onlyKeys(checkpoint,['version','commit_sha','ciphertext_sha256'], 'checkpoint receipt');
  onlyKeys(source,['verified','repository','workflow_path','workflow_name','role','agent_id',
    'issue','run_id','attempt','action_id','input_sha'], 'authenticated Slice source');
  if(!positive(checkpoint.version)||!SHA.test(checkpoint.commit_sha??'')||
      !HEX64.test(checkpoint.ciphertext_sha256??'')) reject('invalid committed checkpoint identity');
  const expected=SOURCE_WORKFLOW[old.task.role];
  if(source.verified!==true||source.repository!=='BestNathan/nession'||
      source.workflow_path!==expected?.path||source.workflow_name!==expected?.name||
      source.role!==old.task.role||source.agent_id!==old.task.agent_id||
      source.issue!==state.issue||source.action_id!==actionId||
      source.input_sha!==old.task.sha||!positive(source.run_id)||!positive(source.attempt))
    reject('untrusted or mismatched Slice source');
  if(old.receipt?.status==='verified' && old.receipt.source_run_id!==source.run_id)
    reject('Slice is not the acknowledged dispatched Run');
  const receipt={
    status:'yielded',dispatch_id:actionId,source_run_id:source.run_id,
    source_attempt:source.attempt,checkpoint_version:checkpoint.version,
    checkpoint_commit_sha:checkpoint.commit_sha,
    ciphertext_sha256:checkpoint.ciphertext_sha256,
  };
  // A lost acknowledgement can be adopted by the original authenticated Run.
  // Divergent or stale attempts must never spawn another continuation.
  if(old.status==='yielded'){
    if(JSON.stringify(old.receipt)!==JSON.stringify(receipt))
      reject('conflicting committed Slice yield');
    return state;
  }
  if(old.status!=='dispatched'||!['accepted','verified'].includes(old.receipt?.status))
    reject('Slice must yield from an acknowledged dispatch');
  const prior=old.task.continuation;
  const ordinal=(prior?.ordinal??0)+1;
  if(ordinal>MAX_SLICES||
      checkpoint.version!==(prior?.checkpoint_version??0)+1)
    reject('noncontiguous or exhausted Slice checkpoint');
  if(state.outbox.length>=MAX_OUTBOX)reject('outbox size limit exceeded');
  const continuation={
    parent_action_id:actionId,ordinal,checkpoint_version:checkpoint.version,
    checkpoint_commit_sha:checkpoint.commit_sha,
    ciphertext_sha256:checkpoint.ciphertext_sha256,
  };
  const nextId=hash([actionId,checkpoint.version,ordinal,checkpoint.commit_sha]);
  if(state.outbox.some(item=>item.id===nextId))reject('duplicate Slice continuation identity');
  const next={
    id:nextId,task:{...old.task,resume:true,continuation},
    status:'pending',attempts:0,receipt:null,
  };
  return validateDevelopmentState({
    ...state,version:state.version+1,
    outbox:[...state.outbox.map(item=>item.id===actionId?{...item,status:'yielded',receipt}:item),next],
  });
}

// A Reviewer-originated Repair is a separate task from the original
// Developer Slice. This exact failed Run restored the committed v3 native
// state, but produced NO accepted result/checkpoint/PR change. A model call
// may have occurred, so this is not represented as a "pre-send" failure.
// The disposable Worker cannot commit a PR or Store result. Authorize one
// new, independently attested, bounded Repair action; never resend the old.
export function repairRuntimeSuccessorId(issue,actionId,runId){
  if(issue!==1997||actionId!==CONTROLLED_REPAIR_ACTION||
     runId!==CONTROLLED_REPAIR_FAILED_RUN)
    reject('unsupported native Repair runtime recovery');
  const next=hash([issue,actionId,runId,'native-repair-uncommitted-runtime-recovery-v1']);
  if(next!==CONTROLLED_REPAIR_SUCCESSOR)reject('Repair successor identity drift');
  return next;
}
export function recordAttestedRepairRuntimeFailure(state,expectedVersion,actionId,source){
  validateDevelopmentState(state);
  onlyKeys(source,['verified','issue','run_id','attempt','failure_code'],
    'attested Repair runtime failure');
  if(state.issue!==1997||state.version!==25||expectedVersion!==25||
     state.phase!=='repair'||state.target_sha!==CONTROLLED_REVIEW_SHA||
     actionId!==CONTROLLED_REPAIR_ACTION||source.verified!==true||
     source.issue!==1997||source.run_id!==CONTROLLED_REPAIR_FAILED_RUN||
     source.attempt!==1||source.failure_code!==CONTROLLED_REPAIR_FAILURE)
    reject('stale or unauthenticated Repair failure');
  const item=state.outbox.find(x=>x.id===actionId);
  if(item?.status!=='dispatched'||item.attempts!==1||
     item.task.type!=='dispatch'||item.task.role!=='developer'||
     item.task.agent_id!=='dev-cursor-01'||item.task.task!=='repair'||
     item.task.sha!==CONTROLLED_REVIEW_SHA||item.task.resume!==true||
     item.task.repair_checkpoint?.checkpoint_version!==3||
     item.task.repair_checkpoint?.checkpoint_commit_sha!==
       'eb891ee2154d02ddb758d50f0f694e70a343ffdf'||
     item.task.repair_checkpoint?.source_run_id!==39448549052||
     item.receipt?.status!=='verified'||
     item.receipt?.source_run_id!==CONTROLLED_REPAIR_FAILED_RUN||
     item.receipt?.dispatch_id!==actionId||
     state.outbox.some(x=>x.id!==actionId&&x.status==='pending'&&
       x.task.role==='developer')||state.outbox.length>=MAX_OUTBOX)
    reject('Repair Action is not one uniquely failed Run');
  const nextId=repairRuntimeSuccessorId(1997,actionId,source.run_id);
  if(state.outbox.some(x=>x.id===nextId))reject('Repair successor collision');
  const failed={...item,status:'failed',receipt:{
    status:'failed',dispatch_id:actionId,source_run_id:source.run_id,
    source_attempt:1,failure_code:CONTROLLED_REPAIR_FAILURE}};
  const successor={id:nextId,task:{...item.task},status:'pending',
    attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:[...state.outbox.map(x=>x.id===actionId?failed:x),successor]});
}

// A conclusively FAILED Worker may be retried only as a NEW Action ID with
// immutable old Run evidence retained. A 204, timeout, in-progress or unknown
// result must never use this path. Caller independently authenticates the
// original GitHub Run, exact failed step, absence of checkpoint and identity.
export function failedDeveloperRetryActionId(issue,actionId,runId) {
  if(!isIssue(issue)||!HEX64.test(actionId??'')||!positive(runId))
    reject('invalid failed Run deterministic retry identity');
  return hash([issue,actionId,runId,'native-sdk-sandbox-isolation-retry-v1']);
}

export function recordAttestedDeveloperFailure(state,expectedVersion,actionId,source) {
  validateDevelopmentState(state);
  if(state.version!==expectedVersion)reject('stale failed-Run recovery CAS');
  onlyKeys(source,['verified','issue','run_id','attempt','failure_code'],
    'authenticated failed Developer source');
  const old=state.outbox.find(x=>x.id===actionId);
  if(source.verified!==true||source.issue!==state.issue||
      source.failure_code!=='native_sdk_sandbox_unavailable'||
      !positive(source.run_id)||source.attempt!==1||
      old?.task.type!=='dispatch'||old.task.role!=='developer'||
      old.status!=='dispatched'||old.receipt?.status!=='verified'||
      old.receipt.source_run_id!==source.run_id||old.attempts>=MAX_ATTEMPTS)
    reject('failure recovery requires exactly the authenticated failed Worker Run');
  const nextId=failedDeveloperRetryActionId(state.issue,actionId,source.run_id);
  if(state.outbox.length>=MAX_OUTBOX||
      state.outbox.some(x=>x.id===nextId)||
      state.outbox.some(x=>x.id!==actionId&&x.status==='pending'&&
        x.task.type==='dispatch'&&x.task.role==='developer'))
    reject('retry already scheduled, collision or bounded Outbox exhausted');
  const failed={...old,status:'failed',receipt:{
    status:'failed',dispatch_id:old.id,source_run_id:source.run_id,
    source_attempt:source.attempt,failure_code:source.failure_code,
  }};
  const next={id:nextId,task:{...old.task},status:'pending',attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:[...state.outbox.map(x=>x.id===actionId?failed:x),next]});
}

// A single source-attested, pre-model Qwen canary setup failure can be
// retired in Store with an immutable successor. It never re-POSTs the
// already acknowledged Worker Run, grants model authority or reuses a
// ciphertext checkpoint. Generalizing failures requires new evidence.
export function qwenPreflightSuccessorId(issue,actionId,runId){
  if(issue!==QWEN_PREFLIGHT_FAILURE.issue||
     actionId!==QWEN_PREFLIGHT_FAILURE.action_id||
     runId!==QWEN_PREFLIGHT_FAILURE.run_id)
    reject('unrecognized Qwen preflight recovery identity');
  return hash([issue,actionId,runId,'qwen-native-key-preflight-recovery-v1']);
}
export function recordAttestedQwenPreflightFailure(state,version,proof){
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','failure_code'],'Qwen preflight failure evidence');
  const source=QWEN_PREFLIGHT_FAILURE;
  const old=state.outbox.find(x=>x.id===source.action_id);
  if(state.version!==version||state.version!==3||
     state.issue!==source.issue||state.phase!=='ready'||
     state.target_sha!==null||state.transitions.length!==0||
     state.outbox.length!==1||state.assignments.developer!=='dev-qwen-01'||
     proof.verified!==true||proof.issue!==source.issue||
     proof.action_id!==source.action_id||proof.run_id!==source.run_id||
     proof.attempt!==1||proof.source_sha!==source.source_sha||
     proof.failure_code!==source.failure_code||
     old?.status!=='dispatched'||old.attempts!==1||
     old.task.role!=='developer'||old.task.task!=='implement'||
     old.task.agent_id!=='dev-qwen-01'||old.task.sha!==source.source_sha||
     old.receipt?.status!=='verified'||
     old.receipt?.dispatch_id!==source.action_id||
     old.receipt?.source_run_id!==source.run_id)
    reject('Qwen preflight recovery lacks exact failed Run/Store lineage');
  const nextId=qwenPreflightSuccessorId(source.issue,source.action_id,source.run_id);
  const failed={...old,status:'failed',receipt:{
    status:'failed',dispatch_id:old.id,source_run_id:source.run_id,
    source_attempt:1,failure_code:source.failure_code,
  }};
  const successor={id:nextId,task:{...old.task},
    status:'pending',attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[failed,successor]});
}

// One live #3784 failed post-model CLI Run is preserved as immutable evidence.
// Only a trusted, independent original Run/Job/Artifact/Log attestation grants
// one new action ID; never repeat the original ticket or GitHub attempt.
export function qwenCliSuccessorId(issue,actionId,runId){
  if(issue!==QWEN_CLI_FAILURE.issue||
     actionId!==QWEN_CLI_FAILURE.action_id||
     runId!==QWEN_CLI_FAILURE.run_id)
    reject('unrecognized Qwen CLI runtime failure source');
  return hash([issue,actionId,runId,'qwen-node-cli-runtime-recovery-v1']);
}
export function recordAttestedQwenCliFailure(state,version,proof){
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','run_head_sha','failure_code'],
    'independently attested Node CLI failure');
  const f=QWEN_CLI_FAILURE,old=state.outbox.find(x=>x.id===f.action_id);
  if(state.version!==version||version!==3||state.issue!==f.issue||
     state.phase!=='ready'||state.target_sha!==null||
     state.transitions.length!==0||state.outbox.length!==1||
     state.assignments.developer!=='dev-qwen-01'||
     state.assignments.reviewer!=='review-qwen-01'||
     proof.verified!==true||proof.issue!==f.issue||
     proof.action_id!==f.action_id||proof.run_id!==f.run_id||
     proof.attempt!==1||proof.source_sha!==f.source_sha||
     proof.run_head_sha!==f.run_head_sha||
     proof.failure_code!==f.failure_code||
     old?.status!=='dispatched'||old.attempts!==1||
     old.task.type!=='dispatch'||old.task.role!=='developer'||
     old.task.task!=='implement'||old.task.agent_id!=='dev-qwen-01'||
     old.task.sha!==f.source_sha||old.task.resume!=null||
     old.receipt?.status!=='verified'||
     old.receipt.dispatch_id!==f.action_id||
     old.receipt.source_run_id!==f.run_id)
    reject('Node Qwen CLI failure has no exact original Store lineage');
  const nextId=qwenCliSuccessorId(f.issue,f.action_id,f.run_id);
  if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(x=>x.id===nextId))
    reject('Qwen CLI failure successor already scheduled');
  const failed={...old,status:'failed',receipt:{
    status:'failed',dispatch_id:old.id,source_run_id:f.run_id,
    source_attempt:1,failure_code:f.failure_code}};
  const successor={id:nextId,task:{...old.task},status:'pending',
    attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[failed,successor]});
}

// #3885: one authenticated second native Repair model exited on the bounded
// turn cap AFTER successful Store Restore. The v2 ciphertext is untouched;
// terminal failed Run cannot be retried, and a new Action keeps same task.
export function qwenRepairTurnsSuccessorId(issue,actionId,runId){
  const f=QWEN_REPAIR_TURNS_FAILURE;
  if(issue!==f.issue||actionId!==f.action_id||runId!==f.run_id)
    reject('unrecognized Qwen second-Repair turn-budget recovery source');
  return hash([issue,actionId,runId,'qwen-native-repair-max-turns-recovery-v1']);
}
export function recordAttestedQwenRepairTurnsFailure(state,version,proof){
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','run_head_sha','failure_code'],
    'verified Qwen second-Repair max-turns failure');
  const f=QWEN_REPAIR_TURNS_FAILURE;
  const old=state.outbox.find(x=>x.id===f.action_id);
  const origin=old?.task.repair_checkpoint;
  if(state.version!==version||version!==f.state_version||
     state.issue!==f.issue||state.phase!=='repair'||
     state.target_sha!==f.source_sha||state.repair_attempts!==2||
     state.outbox.length!==5||state.transitions.length!==4||
     state.transitions.at(-1)?.kind!=='reviewer'||
     state.transitions.at(-1)?.run_id!==44466992692||
     state.transitions.at(-1)?.outcome!=='changes_requested'||
     state.transitions.at(-1)?.target_sha!==f.source_sha||
     !state.transitions.some(t=>t.kind==='publisher'&&
       t.run_id===44457994853&&t.outcome==='published'&&
       t.target_sha===f.source_sha)||
     state.assignments.developer!=='dev-qwen-01'||
     state.assignments.reviewer!=='review-qwen-01'||
     proof?.verified!==true||proof.issue!==f.issue||
     proof.action_id!==f.action_id||proof.run_id!==f.run_id||
     proof.attempt!==1||proof.source_sha!==f.source_sha||
     proof.run_head_sha!==f.run_head_sha||
     proof.failure_code!==f.failure_code||
     old?.status!=='dispatched'||old.attempts!==1||
     old.task.type!=='dispatch'||old.task.role!=='developer'||
     old.task.task!=='repair'||old.task.agent_id!=='dev-qwen-01'||
     old.task.resume!==true||old.task.sha!==f.source_sha||
     origin?.checkpoint_version!==f.checkpoint_version||
     origin.checkpoint_commit_sha!==f.checkpoint_commit_sha||
     origin.ciphertext_sha256!==f.checkpoint_ciphertext_sha256||
     origin.source_sha!==f.checkpoint_source_sha||
     origin.source_run_id!==f.checkpoint_source_run_id||
     old.receipt?.status!=='verified'||
     old.receipt.dispatch_id!==f.action_id||
     old.receipt.source_run_id!==f.run_id||
     state.outbox.some(x=>x.id!==f.action_id&&
       ['pending','dispatching','dispatched'].includes(x.status)))
    reject('Qwen second Repair source is not the exact failed v29 Worker');
  const nextId=qwenRepairTurnsSuccessorId(f.issue,f.action_id,f.run_id);
  if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(x=>x.id===nextId))
    reject('Qwen Repair max-turns successor collision or replay');
  const failed={...old,status:'failed',receipt:{
    status:'failed',dispatch_id:f.action_id,source_run_id:f.run_id,
    source_attempt:1,failure_code:f.failure_code}};
  const next={id:nextId,task:{...old.task},status:'pending',
    attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[...state.outbox.map(x=>x.id===f.action_id?failed:x),next]});
}

// #3885: the second real Node Qwen Developer completed tool activity but
// invoked the read-only Grep discovery tool, which the old policy denied.
export function qwenToolSuccessorId(issue,actionId,runId){
  if(issue!==QWEN_TOOL_FAILURE.issue||
     actionId!==QWEN_TOOL_FAILURE.action_id||
     runId!==QWEN_TOOL_FAILURE.run_id)
    reject('unrecognized real Qwen readonly-tool failure source');
  return hash([issue,actionId,runId,'qwen-readonly-discovery-recovery-v1']);
}
export function recordAttestedQwenToolFailure(state,version,proof){
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','run_head_sha','failure_code'],
    'independently attested Qwen readonly-tool failure');
  const f=QWEN_TOOL_FAILURE;
  const original=state.outbox.find(x=>x.id===QWEN_CLI_FAILURE.action_id);
  const old=state.outbox.find(x=>x.id===f.action_id);
  if(state.version!==version||version!==6||state.issue!==f.issue||
     state.phase!=='ready'||state.target_sha!==null||
     state.transitions.length!==0||state.outbox.length!==2||
     state.assignments.developer!=='dev-qwen-01'||
     state.assignments.reviewer!=='review-qwen-01'||
     original?.status!=='failed'||
     original.receipt?.source_run_id!==QWEN_CLI_FAILURE.run_id||
     original.receipt?.failure_code!==QWEN_CLI_FAILURE.failure_code||
     proof.verified!==true||proof.issue!==f.issue||
     proof.action_id!==f.action_id||proof.run_id!==f.run_id||
     proof.attempt!==1||proof.source_sha!==f.source_sha||
     proof.run_head_sha!==f.run_head_sha||
     proof.failure_code!==f.failure_code||
     old?.status!=='dispatched'||old.attempts!==1||
     old.task.type!=='dispatch'||old.task.role!=='developer'||
     old.task.task!=='implement'||old.task.agent_id!=='dev-qwen-01'||
     old.task.sha!==f.source_sha||old.task.resume!=null||
     old.receipt?.status!=='verified'||old.receipt.dispatch_id!==f.action_id||
     old.receipt.source_run_id!==f.run_id)
    reject('Qwen readonly-tool failure lacks exact Store lineage');
  const nextId=qwenToolSuccessorId(f.issue,f.action_id,f.run_id);
  if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(x=>x.id===nextId))
    reject('Qwen readonly-tool successor already scheduled');
  const failed={...old,status:'failed',receipt:{
    status:'failed',dispatch_id:old.id,source_run_id:f.run_id,
    source_attempt:1,failure_code:f.failure_code}};
  const successor={id:nextId,task:{...old.task},status:'pending',
    attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[...state.outbox.map(x=>x.id===old.id?failed:x),successor]});
}

// #4174: original signed Developer proposal failed the immutable tracked-file
// gate. Preserve the failed Run and grant only one NEW Qwen Action after
// separate GitHub Run/Job/Artifact/log verification. The original model's
// untracked bytes never become an accepted Store Result.
export function qwenTrackedSourceSuccessorId(issue,actionId,runId){
  const f=QWEN_TRACKED_SOURCE_FAILURE;
  if(issue!==f.issue||actionId!==f.action_id||runId!==f.run_id)
    reject('unrecognized Qwen tracked-source failure source');
  return hash([issue,actionId,runId,'qwen-tracked-existing-source-recovery-v1']);
}
export function recordAttestedQwenTrackedSourceFailure(state,version,proof){
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','run_head_sha','failure_code'],
    'independently attested Qwen tracked-source failure');
  const f=QWEN_TRACKED_SOURCE_FAILURE;
  const old=state.outbox.find(x=>x.id===f.action_id);
  if(state.version!==version||version!==3||
     state.issue!==f.issue||state.phase!=='ready'||state.target_sha!==null||
     state.transitions.length!==0||state.outbox.length!==1||
     state.assignments.developer!=='dev-qwen-01'||
     state.assignments.reviewer!=='review-qwen-01'||
     proof.verified!==true||proof.issue!==f.issue||
     proof.action_id!==f.action_id||proof.run_id!==f.run_id||
     proof.attempt!==1||proof.source_sha!==f.source_sha||
     proof.run_head_sha!==f.run_head_sha||
     proof.failure_code!==f.failure_code||
     old?.status!=='dispatched'||old.attempts!==1||
     old.task.type!=='dispatch'||old.task.role!=='developer'||
     old.task.task!=='implement'||old.task.agent_id!=='dev-qwen-01'||
     old.task.sha!==f.source_sha||old.task.resume!=null||
     old.receipt?.status!=='verified'||
     old.receipt.dispatch_id!==f.action_id||
     old.receipt.source_run_id!==f.run_id)
    reject('Qwen tracked-source failure lacks original signed Store/Run lineage');
  const nextId=qwenTrackedSourceSuccessorId(f.issue,f.action_id,f.run_id);
  if(state.outbox.length>=MAX_OUTBOX||state.outbox.some(x=>x.id===nextId))
    reject('Qwen tracked-source failure already has a successor');
  const failed={...old,status:'failed',receipt:{
    status:'failed',dispatch_id:old.id,source_run_id:f.run_id,
    source_attempt:1,failure_code:f.failure_code}};
  const successor={id:nextId,task:{...old.task},status:'pending',
    attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[...state.outbox.map(x=>x.id===old.id?failed:x),successor]});
}

// The second exact pre-model Qwen failure: current main had no dedicated
// Restore private key when the first successor Worker ran. This is a new,
// independently attested source and therefore gets its own bounded successor
// domain; it never re-POSTs an acknowledged Action.
export function qwenPreflightSuccessorIdV2(issue,actionId,runId){
  if(issue!==QWEN_PREFLIGHT_FAILURE_V2.issue||
     actionId!==QWEN_PREFLIGHT_FAILURE_V2.action_id||
     runId!==QWEN_PREFLIGHT_FAILURE_V2.run_id)
    reject('unrecognized Qwen Restore-key preflight recovery identity');
  return hash([issue,actionId,runId,'qwen-native-restore-key-preflight-recovery-v1']);
}
export function recordAttestedQwenPreflightFailureV2(state,version,proof){
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','run_head_sha','failure_code'],
  'Qwen Restore-key preflight failure evidence');
  const source=QWEN_PREFLIGHT_FAILURE_V2;
  const first=state.outbox.find(x=>x.id===
    '61bced6ae498054e883d8a52d7398e7877852ef6a3c41e93644138a4b47dacb3');
  const current=state.outbox.find(x=>x.id===source.action_id);
  if(state.version!==version||state.version!==6||
     state.issue!==source.issue||state.phase!=='ready'||
     state.target_sha!==null||state.transitions.length!==0||
     state.outbox.length!==2||state.assignments.developer!=='dev-qwen-01'||
     first?.status!=='failed'||
     first.receipt?.source_run_id!==42187623195||
     first.receipt?.failure_code!=='qwen_native_sealing_public_key_missing'||
     proof.verified!==true||proof.issue!==source.issue||
     proof.action_id!==source.action_id||proof.run_id!==source.run_id||
     proof.attempt!==1||proof.source_sha!==source.source_sha||
     proof.run_head_sha!==source.run_head_sha||
     proof.failure_code!==source.failure_code||
     current?.status!=='dispatched'||current.attempts!==1||
     current.task.role!=='developer'||current.task.task!=='implement'||
     current.task.agent_id!=='dev-qwen-01'||
     current.task.sha!==source.source_sha||
     current.receipt?.status!=='verified'||
     current.receipt?.dispatch_id!==source.action_id||
     current.receipt?.source_run_id!==source.run_id)
    reject('Qwen Restore-key recovery lacks exact failed Run/Store lineage');
  const nextId=qwenPreflightSuccessorIdV2(source.issue,source.action_id,
    source.run_id);
  if(state.outbox.some(x=>x.id===nextId))
    reject('Qwen Restore-key successor already exists');
  const failed={...current,status:'failed',receipt:{
    status:'failed',dispatch_id:current.id,source_run_id:source.run_id,
    source_attempt:1,failure_code:source.failure_code,
  }};
  const successor={id:nextId,task:{...current.task},
    status:'pending',attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[...state.outbox.map(x=>x.id===current.id?failed:x),successor]});
}

// Third exact pre-model failure: the pinned Claude Code package was installed
// with --ignore-scripts, so the native binary was absent and the isolated
// Worker image could not be built. Retire only that acknowledged Action and
// create one pending successor; never call the model or re-POST the Run.
export function qwenPreflightSuccessorIdV3(issue,actionId,runId){
  if(issue!==QWEN_PREFLIGHT_FAILURE_V3.issue||
     actionId!==QWEN_PREFLIGHT_FAILURE_V3.action_id||
     runId!==QWEN_PREFLIGHT_FAILURE_V3.run_id)
    reject('unrecognized Qwen Worker-image preflight recovery identity');
  return hash([issue,actionId,runId,'qwen-worker-image-preflight-recovery-v1']);
}
export function recordAttestedQwenPreflightFailureV3(state,version,proof){
  validateDevelopmentState(state);
  onlyKeys(proof,['verified','issue','action_id','run_id','attempt',
    'source_sha','run_head_sha','failure_code'],
  'Qwen Worker-image preflight failure evidence');
  const source=QWEN_PREFLIGHT_FAILURE_V3;
  const v1=state.outbox.find(x=>x.id===
    '61bced6ae498054e883d8a52d7398e7877852ef6a3c41e93644138a4b47dacb3');
  const v2=state.outbox.find(x=>x.id===QWEN_PREFLIGHT_FAILURE_V2.action_id);
  const current=state.outbox.find(x=>x.id===source.action_id);
  if(state.version!==version||state.version!==9||
     state.issue!==source.issue||state.phase!=='ready'||
     state.target_sha!==null||state.transitions.length!==0||
     state.outbox.length!==3||state.assignments.developer!=='dev-qwen-01'||
     v1?.status!=='failed'||
     v1.receipt?.source_run_id!==42187623195||
     v1.receipt?.failure_code!=='qwen_native_sealing_public_key_missing'||
     v2?.status!=='failed'||
     v2.receipt?.source_run_id!==42339656510||
     v2.receipt?.failure_code!=='qwen_native_restore_private_key_missing'||
     proof.verified!==true||proof.issue!==source.issue||
     proof.action_id!==source.action_id||proof.run_id!==source.run_id||
     proof.attempt!==1||proof.source_sha!==source.source_sha||
     proof.run_head_sha!==source.run_head_sha||
     proof.failure_code!==source.failure_code||
     current?.status!=='dispatched'||current.attempts!==1||
     current.task.role!=='developer'||current.task.task!=='implement'||
     current.task.agent_id!=='dev-qwen-01'||
     current.task.sha!==source.source_sha||
     current.receipt?.status!=='verified'||
     current.receipt?.dispatch_id!==source.action_id||
     current.receipt?.source_run_id!==source.run_id)
    reject('Qwen Worker-image recovery lacks exact failed Run/Store lineage');
  const nextId=qwenPreflightSuccessorIdV3(source.issue,source.action_id,
    source.run_id);
  if(state.outbox.some(x=>x.id===nextId))
    reject('Qwen Worker-image successor already exists');
  const failed={...current,status:'failed',receipt:{
    status:'failed',dispatch_id:current.id,source_run_id:source.run_id,
    source_attempt:1,failure_code:source.failure_code,
  }};
  const successor={id:nextId,task:{...current.task},
    status:'pending',attempts:0,receipt:null};
  return validateDevelopmentState({...state,version:version+1,
    outbox:[...state.outbox.map(x=>x.id===current.id?failed:x),successor]});
}

export function failedDispatch(state, expectedVersion, actionId) {
  validateDevelopmentState(state);
  if (state.version !== expectedVersion) reject('stale state CAS');
  const old = state.outbox.find(x => x.id === actionId);
  if (!old || old.status !== 'pending' || old.attempts >= MAX_ATTEMPTS) reject('cannot retry dispatched/exhausted task');
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:state.outbox.map(x => x.id === actionId ? {...x,attempts:x.attempts+1} : x)});
}
export function reconcileOutbox(state) {
  validateDevelopmentState(state);
  return {
    pending:state.outbox.filter(x => x.status === 'pending' && x.attempts < MAX_ATTEMPTS),
    exhausted:state.outbox.filter(x => x.status === 'pending' && x.attempts >= MAX_ATTEMPTS),
    awaiting_evidence:state.outbox.filter(x => x.status === 'dispatched'),
    awaiting_dispatch_receipt:state.outbox.filter(x => x.status === 'dispatching'),
    yielded:state.outbox.filter(x => x.status === 'yielded'),
    failed:state.outbox.filter(x => x.status === 'failed'),
  };
}
