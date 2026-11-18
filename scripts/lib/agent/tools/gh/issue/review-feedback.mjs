// Owner of a single bot-maintained Issue Audit needs-review status comment.
// Human comments are never edited; runtime errors remain operational failures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const REPO='BestNathan/nession',MARK='<!-- nession-issue-audit-needs-review:v1 -->';
const SAFE_CODE=/^ISSUE_AUDIT_[A-Z0-9_]{3,70}$/;
const ACTIONS='https://github.com/'+REPO+'/actions/runs/';

function gh(path,{method=null,body=null}={}){
  const args=['api',path];
  if(method)args.push('--method',method);
  if(body!=null)args.push('-f','body='+body);
  return JSON.parse(execFileSync('gh',args,{encoding:'utf8',env:process.env,
    maxBuffer:2*1024*1024,timeout:15_000}));
}
export const defaultIssueAuditFeedbackApi={
  list:(number)=>gh('repos/'+REPO+'/issues/'+number+'/comments?per_page=100'),
  post:(number,body)=>gh('repos/'+REPO+'/issues/'+number+'/comments',{method:'POST',body}),
  edit:(id,body)=>gh('repos/'+REPO+'/issues/comments/'+id,{method:'PATCH',body}),
};
export function formatIssueAuditFeedback({issueNumber,runId,attempt,code,reason}){
  if(!Number.isSafeInteger(issueNumber)||issueNumber<=0||
     !Number.isSafeInteger(runId)||runId<=0||
     !Number.isSafeInteger(attempt)||attempt<=0||!SAFE_CODE.test(code))
    throw Error('Invalid trusted Issue Audit feedback identity');
  const next=code==='ISSUE_AUDIT_E2E_PROTECTED'
    ? 'Check the source E2E Verification/Report against the real test catalog. Normalize malformed IDs and Pending rows only through the approved Issue/E2E owner. If the selected test set would change, use the trusted E2E proposal/approval path. Then request /audit again.'
    : 'Review the canonical Issue Contract and the rejected candidate, correct only the original Issue, then request /audit again.';
  // Reasons come from the typed rejection map, never from model prose.
  const label=String(reason??'Trusted pre-write validation rejected the candidate')
    .slice(0,320).replace(/[\r\n\`<>]/g,' ');
  return [MARK,'**Issue Audit: needs review — no Issue changes applied**','',
    '- Source: [Run '+runId+'/'+attempt+']('+ACTIONS+runId+')',
    '- Rejection: \`'+code+'\`',
    '- Reason: '+label,
    '- Action: '+next,
    '',
    'This is a rejected candidate, **not** an Audit repair, CI Gate Pass or E2E result. The authoritative run log retains the full context.',
  ].join('\n');
}
export async function publishIssueAuditFeedback(record,api=defaultIssueAuditFeedbackApi){
  const issueNumber=record?.issue?.number,review=record?.review;
  if(record?.result!=='needs-review'||!SAFE_CODE.test(String(review?.code??'')))
    throw Error('Only typed needs-review can publish an Audit feedback comment');
  const runId=Number(process.env.GITHUB_RUN_ID),attempt=Number(process.env.GITHUB_RUN_ATTEMPT);
  const body=formatIssueAuditFeedback({issueNumber,runId,attempt,
    code:review.code,reason:review.reason});
  const items=await api.list(issueNumber);
  if(!Array.isArray(items)||items.length>=100)
    throw Error('Incomplete Issue comment history; refusing duplicate status write');
  const previous=items.filter(x=>x?.user?.login==='github-actions[bot]' &&
    typeof x.body==='string' && x.body.startsWith(MARK));
  if(previous.length>1)throw Error('Multiple Audit review status comments; owner reconciliation required');
  if(previous.length===1){
    if(previous[0].body===body)return {action:'unchanged',id:previous[0].id};
    await api.edit(previous[0].id,body);
    return {action:'updated',id:previous[0].id};
  }
  const created=await api.post(issueNumber,body);
  if(!Number.isSafeInteger(created?.id)||created.id<1)
    throw Error('Audit review status comment missing authenticated ID');
  return {action:'created',id:created.id};
}
// Only a trusted post-readback success may resolve a previously posted
// needs-review comment. Never create a success comment on an untouched Issue.
export async function resolveIssueAuditFeedback(record,api=defaultIssueAuditFeedbackApi){
  const issueNumber=record?.issue?.number;
  if(!['repaired','contract-pass'].includes(record?.result)||
     (record.errors??[]).length>0||
     !Number.isSafeInteger(issueNumber)||issueNumber<1)
    throw Error('Only authenticated, fully valid Audit results can resolve feedback');
  const runId=Number(process.env.GITHUB_RUN_ID),attempt=Number(process.env.GITHUB_RUN_ATTEMPT);
  if(!Number.isSafeInteger(runId)||runId<1||!Number.isSafeInteger(attempt)||attempt<1)
    throw Error('Missing exact Issue Audit success run identity');
  const items=await api.list(issueNumber);
  if(!Array.isArray(items)||items.length>=100)
    throw Error('Incomplete Issue comment history; refusing ambiguous status reconciliation');
  const previous=items.filter(x=>x?.user?.login==='github-actions[bot]'&&
    typeof x.body==='string'&&x.body.startsWith(MARK));
  if(previous.length>1)throw Error('Multiple Audit review status comments; owner reconciliation required');
  if(!previous.length)return {action:'absent',id:null};
  const description=record.result==='repaired'
    ? 'repaired and independently revalidated'
    : 'canonical Issue Contract passed without modification';
  const body=[MARK,'**Issue Audit: resolved — '+description+'**','',
    '- Source: [Run '+runId+'/'+attempt+']('+ACTIONS+runId+')',
    '- Outcome: \`'+record.result+'\`',
    '- Validation: canonical Issue Contract and verification tier confirmed by trusted runner',
    '- E2E: This status does not attest execution, changes to selected tests or any Pass receipt.',
    '',
    'This status supersedes the earlier needs-review diagnosis; original audit run and diagnostics remain available in its Actions log.',
  ].join('\n');
  if(previous[0].body===body)return {action:'unchanged',id:previous[0].id};
  await api.edit(previous[0].id,body);
  return {action:'resolved',id:previous[0].id};
}

export async function selfTestIssueAuditFeedback(){
  const oldId=process.env.GITHUB_RUN_ID,oldAttempt=process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ID='44242491392';
  process.env.GITHUB_RUN_ATTEMPT='1';
  try{
    const issueNumber=3855;
    const record={issue:{number:issueNumber},result:'needs-review',
      review:{code:'ISSUE_AUDIT_E2E_PROTECTED',
        reason:'Proposed E2E Verification / Report mutation rejected before write'}};
    const comments=[];let writes=0,edits=0;
    const api={list:async n=>{assert.equal(n,issueNumber);return comments;},
      post:async(n,body)=>{writes++;assert.equal(n,issueNumber);
        const c={id:7,user:{login:'github-actions[bot]'},body};comments.push(c);return c;},
      edit:async(id,body)=>{edits++;assert.equal(id,7);comments[0].body=body;}};
    assert.equal((await publishIssueAuditFeedback(record,api)).action,'created');
    assert.equal((await publishIssueAuditFeedback(record,api)).action,'unchanged');
    assert.equal(writes,1);
    const body=comments[0].body;
    assert.match(body,/44242491392/);
    assert.match(body,/trusted E2E proposal\/approval/);
    assert.equal((await publishIssueAuditFeedback({...record,
      review:{...record.review,code:'ISSUE_AUDIT_CONTRACT_REJECTED'}},api)).action,'updated');
    assert.equal(edits,1);
    const resolved={issue:{number:issueNumber},result:'repaired',errors:[]};
    assert.equal((await resolveIssueAuditFeedback(resolved,api)).action,'resolved');
    assert.equal((await resolveIssueAuditFeedback(resolved,api)).action,'unchanged');
    assert.equal(edits,2);
    assert.match(comments[0].body,/Issue Audit: resolved/);
    assert.equal(writes,1,'success only edits the preexisting bot comment');
    assert.equal((await publishIssueAuditFeedback(record,api)).action,'updated');
    assert.equal(edits,3,'later rejection reopens the same bot comment');
    await assert.rejects(resolveIssueAuditFeedback({...resolved,errors:['invalid E2E']},api),
      /Only authenticated/);
    assert.throws(()=>formatIssueAuditFeedback({issueNumber,runId:0,attempt:1,
      code:record.review.code}),/Invalid trusted/);
    await assert.rejects(publishIssueAuditFeedback({...record,result:'repaired'},api),
      /Only typed needs-review/);
    comments[0].user.login='BestNathan';
    assert.equal((await publishIssueAuditFeedback(record,api)).action,'created',
      'human-owned matching comment never edited');
    assert.equal(writes,2);
    const full=Array.from({length:100},()=>({id:1,body:'status'}));
    await assert.rejects(publishIssueAuditFeedback(record,{...api,list:async()=>full}),
      /Incomplete Issue comment history/);
    assert.ok(!body.includes('raw model output'));
  }finally{
    if(oldId==null)delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID=oldId;
    if(oldAttempt==null)delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT=oldAttempt;
  }
  console.log('Issue Audit feedback: source-bound comments, idempotency and negative fixtures passed');
}
