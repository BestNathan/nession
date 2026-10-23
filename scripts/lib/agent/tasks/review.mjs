// #2137/#1664 SC-04: canonical Reviewer task contract. The task module owns
// the Prompt selection and the model-result schema; it never performs a
// provider call, GitHub/Issue write, Store write, merge or role transition.
import { renderAgentPrompt } from '../prompt/index.mjs';
import { assertReviewerAdmission } from '../reviewer/pr-admission.mjs';
import { parseModelJson } from './model-json.mjs';

const OUTCOMES=new Set(['approved','changes_requested']);
const RESULT_FIELDS=['outcome','summary','findings'];
const FINDING_FIELDS=['path','evidence'];
const MAX_FINDINGS=50, MAX_SUMMARY=2000, MAX_EVIDENCE=2000, MAX_PATH=400;
function fail(message){throw new Error('Review task: '+message);}
function only(value,fields){
  return value&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===fields.length&&Object.keys(value).every(k=>fields.includes(k));
}
function singleLine(value,label,max){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\r\n]/.test(value))
    fail('invalid '+label);
  return value;
}
function safePath(value){
  if(typeof value!=='string'||!value||value.length>MAX_PATH||
     value.startsWith('/')||value.startsWith('\\')||value.includes('..')||
     value.includes('\\')||/[\r\n]/.test(value))
    fail('invalid finding path');
  return value;
}

// Only the host-owned admission supplies identity and target. The model sees
// exactly what it must review and never an alternative role or approval path.
// `identity` is used only by an explicitly-labeled smoke admission; the
// canonical callers pass nothing and keep the #2177 cursor contract.
export function reviewModelView(admission,identity){
  assertReviewerAdmission(admission,identity);
  return Object.freeze({
    issue: admission.issue,
    pull_request: admission.pr_number,
    target_sha: admission.target_sha,
    base_sha_at_publication: admission.base_sha_at_publication,
    expected_file: admission.expected_file,
    expected_file_sha256: admission.expected_file_sha256,
    expected_file_mode: admission.expected_file_mode,
  });
}

export function renderReviewPrompt(admission,identity){
  const view=reviewModelView(admission,identity);
  return renderAgentPrompt({
    id:'review',version:'v2',
    context:{contextJson:JSON.stringify(view,null,2)},
  });
}

// Parse and validate the model verdict. The returned object deliberately binds
// the admission's Issue/PR/target SHA: a model cannot select another target,
// author a role, or substitute an approval.
export function reviewModelResult(admission,raw,identity){
  const view=reviewModelView(admission,identity);
  const parsed=parseModelJson(raw,'Reviewer Agent');
  if(!only(parsed,RESULT_FIELDS))fail('unexpected result fields');
  if(!OUTCOMES.has(parsed.outcome))fail('invalid review outcome');
  const summary=singleLine(parsed.summary,'summary',MAX_SUMMARY);
  if(!Array.isArray(parsed.findings)||parsed.findings.length>MAX_FINDINGS)
    fail('invalid findings');
  const findings=parsed.findings.map(item=>{
    if(!only(item,FINDING_FIELDS))fail('unexpected finding fields');
    return Object.freeze({
      path:safePath(item.path),
      evidence:singleLine(item.evidence,'finding evidence',MAX_EVIDENCE),
    });
  });
  if(parsed.outcome==='changes_requested'&&findings.length===0)
    fail('changes_requested requires at least one finding');
  return Object.freeze({
    kind:'reviewer',
    issue:view.issue,
    pr_number:view.pull_request,
    target_sha:view.target_sha,
    outcome:parsed.outcome,
    summary,
    findings:Object.freeze(findings),
  });
}
