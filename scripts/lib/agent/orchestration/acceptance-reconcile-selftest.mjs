import assert from 'node:assert/strict';
import {acceptanceResultMatches} from './acceptance-reconcile.mjs';
const sha='a'.repeat(40),contract='b'.repeat(64);
const context={issue:{number:42},stage:'pr',target_ref:sha,contract_sha256:contract,run_id:123,
  deployment:null,criteria:[{criterion:'SC-01'},{criterion:'SC-02'}]};
const q={kind:'pr_required_quality_v1',repository:'BestNathan/nession',workflow:'.github/workflows/ci-quality.yml',
  head_sha:sha,result:'success',run_id:100,run_attempt:1,scope_job_id:101,web_check_job_id:102,
  scope_step:'Classify the exact PR or main-push change',web_check_step:'Enforce applicable Quality results at the stable check name',
  job_outcomes:{'instruction-check':'skipped','workflow-check':'success','rust-check':'success','tooling-check':'success','web-tests':'skipped'}};
const doc={schema_version:1,issue:42,stage:'pr',target_ref:sha,contract_sha256:contract,run_id:123,deployment:null,source:'agent-qwen',
  selected_criteria:['SC-01','SC-02'],criteria:context.criteria.map(c=>({...c,result:'Pass',evidence:[{type:'test',value:'exact-head regression succeeded'}],summary:'verified'})),
  pr_required_quality_receipt:q};
assert.equal(acceptanceResultMatches(doc,context,q),true);
for(const bad of [{...doc,issue:43},{...doc,target_ref:'c'.repeat(40)},{...doc,contract_sha256:'c'.repeat(64)},
  {...doc,run_id:124},{...doc,stage:'post-merge'},{...doc,selected_criteria:['SC-01']},
  {...doc,criteria:[doc.criteria[0]]},{...doc,criteria:[doc.criteria[0],{...doc.criteria[1],result:'Pending'}]},
  {...doc,pr_required_quality_receipt:{...q,run_attempt:2}},{...doc,pr_required_quality_receipt:{...q,run_id:200}}])
  assert.equal(acceptanceResultMatches(bad,context,q),false);
console.log('Acceptance reconciliation: exact contract, complete SCs and Quality attempt negative fixtures passed');
