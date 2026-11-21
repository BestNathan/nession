// #4108: read-only final-source alignment, after existing trusted readers attest
// GitHub PR/commit, signed Store, Review Result and SC Result receipts.
// This is an evidence join, NOT an authenticator: callers MUST authenticate
// those records independently. Never write Store, Issue, PR or a status check.
import {extractSection,parseSuccessCriteria,parseAcceptanceReport,
  validateRequirementBody} from '../../../requirement-acceptance.mjs';

const SHA=/^[a-f0-9]{40}$/;
const ACTION=/^[a-f0-9]{64}$/;
const SUCCESS='success';

function sha(value){return typeof value==='string'&&SHA.test(value);}
function positive(value){return Number.isSafeInteger(value)&&value>0;}
function same(a,b){return sha(a)&&sha(b)&&a===b;}
function reason(reasons,condition,message){
  if(!condition)reasons.push(message);
}
function verifiedCI(ci,head){
  return ci&&same(ci.head_sha,head)&&ci.conclusion===SUCCESS;
}

// Deterministic relation ONLY; authenticated source readers own every input.
// No boolean such as "reviewed:true" or a green CI status can supply a
// missing independently ingested signed Review/SC Result. The function also
// does not infer merge ancestry from equal file blobs or commit messages.
export function auditFinalSource({repository,issue,pr,merge,store,reviewer,
  scResults,ci}={}) {
  const reasons=[];
  const finalSha=pr?.head?.sha;
  const merged=pr?.state==='closed'&&pr?.merged_at!=null&&pr?.merged===true;
  const status=()=>merged?'merged/source-unverified':'still-open/blocked';
  reason(reasons,repository==='BestNathan/nession','repository identity mismatch');
  reason(reasons,positive(issue?.number)&&issue?.state==='open',
    'source Issue missing or not open');
  reason(reasons,positive(pr?.number)&&pr?.head?.repo?.full_name===repository&&
    pr?.base?.repo?.full_name===repository&&pr?.base?.ref==='main'&&sha(finalSha),
    'PR repository/base/head identity missing');
  reason(reasons,merged&&sha(pr?.merge_commit_sha),
    'PR not merged at an independently attested merge commit');
  reason(reasons,merge?.sha===pr?.merge_commit_sha&&Array.isArray(merge?.parents)&&
    merge.parents.length===2&&merge.parents[1]===finalSha&&
    sha(merge.parents[0])&&merge.parents[0]!==finalSha,
    'merge commit does not bind final PR head as parent');
  reason(reasons,store?.issue===issue?.number&&store?.pr_number===pr?.number&&
    positive(store?.version)&&sha(store?.source_sha)&&ACTION.test(store?.review_action_id??''),
    'signed Store source identity absent');
  reason(reasons,same(store?.source_sha,finalSha),
    'final PR head differs from signed Publisher/Store target');
  reason(reasons,reviewer?.issue===issue?.number&&reviewer?.pr_number===pr?.number&&
    same(reviewer?.source_sha,finalSha)&&reviewer?.action_id===store?.review_action_id&&
    positive(reviewer?.run_id)&&reviewer?.verdict==='approved'&&
    reviewer?.signed_result_verified===true,
    'no independently ingested approved Reviewer Result for final PR head/action');
  // Canonical Requirement validator proves structural Report completion, but
  // historical Pass rows by themselves cannot authenticate their source SHA.
  const acceptance=validateRequirementBody(issue?.body??'',
    {mode:'closure'});
  reason(reasons,acceptance.ok,'Issue Success Criteria or Report not complete');
  const criteria=parseSuccessCriteria(extractSection(issue?.body,'Success Criteria')).criteria;
  const rows=parseAcceptanceReport(extractSection(issue?.body,'Acceptance Report')).rows;
  const proofs=Array.isArray(scResults)?scResults:[];
  reason(reasons,proofs.length===criteria.size&&criteria.size>0,
    'one independently attested SC receipt required per criterion');
  const ids=new Set();
  for(const [id] of criteria){
    const matching=proofs.filter(x=>x?.id===id);
    if(matching.length!==1){
      reasons.push(id+' missing or duplicate source-aligned SC receipt');
      continue;
    }
    const proof=matching[0];ids.add(id);
    reason(reasons,proof?.result==='Pass'&&
      same(proof?.source_sha,finalSha)&&positive(proof?.run_id)&&
      proof?.trusted_ingest_verified===true&&
      rows.get(id)?.result?.toLowerCase()==='pass',
      id+' is stale, unauthenticated or not Pass at final source');
  }
  reason(reasons,proofs.every(x=>ids.has(x?.id)),
    'unrecognized SC result receipt');
  reason(reasons,verifiedCI(ci?.quality,finalSha)&&
    verifiedCI(ci?.e2e,finalSha)&&verifiedCI(ci?.caseSmoke,finalSha),
    'exact-final-HEAD Quality/E2E/Case status missing or failed');
  // Case Smoke success (possibly with selected Cases skipped) is just CI
  // metadata. It cannot replace any SC receipt or a Reviewer Result.
  return Object.freeze({
    status:reasons.length===0?'merged/verified':status(),
    issue:issue?.number??null,pr:pr?.number??null,
    final_sha:sha(finalSha)?finalSha:null,
    merge_sha:sha(merge?.sha)?merge.sha:null,
    signed_target_sha:sha(store?.source_sha)?store.source_sha:null,
    reasons:Object.freeze(reasons),
  });
}
