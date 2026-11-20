// #4108: source-fenced positive/negative closure evidence fixtures.
// The real #3784 record is intentionally a negative, not a fabricated Pass.
import assert from 'node:assert/strict';
import {auditFinalSource} from './final-source-audit.mjs';
import {assertReviewerRecoveryPrLease} from './controller-dispatch.mjs';
import {REVIEWER_PREMODEL_FAILURE_3784_C} from './outbox.mjs';

const REPO='BestNathan/nession';
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
const action='d'.repeat(64);
const fence=String.fromCharCode(96).repeat(3);
const issueBody=[
  '## Success Criteria',
  '- [x] SC-01 exact-source behavior proven',
  '- [x] SC-02 negative source binding proven',
  '',
  '## Acceptance Plan',
  fence+'yaml',
  'acceptance:',
  '  SC-01:',
  '    when: pr',
  '    method: agent',
  '  SC-02:',
  '    when: pr',
  '    method: agent',
  fence,
  '',
  '## Acceptance Report',
  '| Criterion | Result | Evidence |',
  '|---|---|---|',
  '| SC-01 | Pass | trusted source-aligned receipt A |',
  '| SC-02 | Pass | trusted source-aligned receipt B |',
].join('\n');
const source={repository:REPO,
  issue:{number:3784,state:'open',body:issueBody},
  pr:{number:3919,state:'closed',merged_at:'2026-11-19T19:35:15Z',
    merge_commit_sha:c,head:{sha:a,repo:{full_name:REPO}},
    base:{ref:'main',repo:{full_name:REPO}}},
  merge:{sha:c,parents:[b,a]},
  store:{issue:3784,pr_number:3919,version:35,source_sha:a,
    review_action_id:action},
  reviewer:{issue:3784,pr_number:3919,source_sha:a,
    action_id:action,run_id:400,verdict:'approved',signed_result_verified:true},
  scResults:[
    {id:'SC-01',result:'Pass',source_sha:a,run_id:401,
      trusted_ingest_verified:true},
    {id:'SC-02',result:'Pass',source_sha:a,run_id:402,
      trusted_ingest_verified:true}],
  ci:{quality:{head_sha:a,conclusion:'success'},
    e2e:{head_sha:a,conclusion:'success'},
    caseSmoke:{head_sha:a,conclusion:'success',selected_case_executed:false}},
};
assert.deepEqual(auditFinalSource(source).reasons,[]);
assert.equal(auditFinalSource(source).status,'merged/verified');
for(const [mutation,needle] of [
  [{repository:'fork/repo'},'repository identity'],
  [{pr:{...source.pr,number:3918}},'signed Store source identity'],
  [{store:{...source.store,source_sha:b}},'differs from signed Publisher'],
  [{store:{...source.store,version:0}},'signed Store source identity'],
  [{store:{...source.store,review_action_id:'bad'}},'signed Store source identity'],
  [{pr:{...source.pr,head:{...source.pr.head,sha:b}}},'differs from signed Publisher'],
  [{merge:{...source.merge,parents:[b,b]}},'merge commit'],
  [{pr:{...source.pr,merge_commit_sha:b}},'merge commit'],
  [{reviewer:null},'approved Reviewer'],
  [{reviewer:{...source.reviewer,verdict:'changes_requested'}},'approved Reviewer'],
  [{reviewer:{...source.reviewer,signed_result_verified:false}},'approved Reviewer'],
  [{reviewer:{...source.reviewer,action_id:'0'.repeat(64)}},'approved Reviewer'],
  [{reviewer:{...source.reviewer,source_sha:b}},'approved Reviewer'],
  [{scResults:source.scResults.map(x=>({...x,source_sha:b}))},'stale'],
  [{scResults:[source.scResults[0],source.scResults[0]]},'missing or duplicate'],
  [{scResults:[...source.scResults,{id:'SC-03',result:'Pass',source_sha:a,run_id:403,
    trusted_ingest_verified:true}]},'unrecognized'],
  [{scResults:source.scResults.map(x=>({...x,trusted_ingest_verified:false}))},'unauthenticated'],
  [{ci:{...source.ci,quality:{head_sha:b,conclusion:'success'}}},'Quality/E2E'],
  [{ci:{...source.ci,caseSmoke:{head_sha:a,conclusion:'skipped'}}},'Quality/E2E'],
  [{issue:{...source.issue,body:issueBody.replace(
    '| SC-02 | Pass |', '| SC-02 | Pending |')}},'Issue Success Criteria'],
]) {
  const result=auditFinalSource({...source,...mutation});
  assert.equal(result.status,'merged/source-unverified',needle);
  assert.ok(result.reasons.some(x=>x.includes(needle)),needle+': '+result.reasons.join('; '));
}
assert.equal(auditFinalSource({...source,pr:{...source.pr,state:'open',merged_at:null}})
  .status,'still-open/blocked');

// Exact historical #3919: native Store C, final rewritten HEAD E, and
// Reviewer Run #44500591865 failed before its review job. All final CI
// succeeded, but no signed Reviewer Result or accepted source-aligned SC
// receipts exist. Past Issue checkbox/Pass rows must not count.
const originalC=REVIEWER_PREMODEL_FAILURE_3784_C;
const actualHead='4cd3e3a25e6d1344f25a99f22ecde00288a4844a';
const actualMerge='ceae3e15a5a9d3cc65de4a99b791e081ced12f7a';
const historical=auditFinalSource({...source,
  pr:{...source.pr,head:{...source.pr.head,sha:actualHead},
    merge_commit_sha:actualMerge},
  merge:{sha:actualMerge,parents:[b,actualHead]},
  store:{...source.store,version:originalC.state_version,
    source_sha:originalC.source_sha,
    review_action_id:originalC.action_id},
  reviewer:null,scResults:[],
  ci:{quality:{head_sha:actualHead,conclusion:'success'},
    e2e:{head_sha:actualHead,conclusion:'success'},
    caseSmoke:{head_sha:actualHead,conclusion:'success',selected_case_executed:false}}});
assert.equal(historical.status,'merged/source-unverified');
assert.ok(historical.reasons.some(x=>x.includes('differs from signed Publisher')));
assert.ok(historical.reasons.some(x=>x.includes('approved Reviewer')));
assert.ok(historical.reasons.some(x=>x.includes('SC receipt')));
// Existing main-owned Controller must deny ANY attempt to recycle the
// consumed C pre-model Action on the now-merged, rewritten #3919.
const branch='agent/3784/qwen-39c01222a8d00fa3';
const mergedPr={number:3919,state:'closed',draft:false,
  merged_at:'2026-11-19T19:35:15Z',
  head:{sha:actualHead,ref:branch,repo:{full_name:REPO}},
  base:{ref:'main',repo:{full_name:REPO}}};
const oldRef={ref:'refs/heads/'+branch,object:{sha:originalC.source_sha}};
for(const wrong of [
  mergedPr,
  {...mergedPr,head:{...mergedPr.head,sha:originalC.source_sha}},
  {...mergedPr,state:'open',merged_at:null},
])assert.throws(()=>assertReviewerRecoveryPrLease(originalC,wrong,oldRef),
  /immutable #3784 Store v35 C/);
console.log('Final-source audit: positive, stale HEAD/merge/Review/SC/replay denial and exact #3919 merged negative passed');
