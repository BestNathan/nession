import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {validateAgentWorkflowTelemetry,telemetryStoragePath} from '../../../agent-workflow-telemetry.mjs';
import {validateExecutionTrace,validateTraceSource,traceStoragePath,summarizeExecutionTrace} from './execution-trace.mjs';

const SHA40=/^[a-f0-9]{40}$/,SHA64=/^[a-f0-9]{64}$/;
const MAX_FILES=5000,MAX_RECORD=3*1024*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function deny(message){throw new Error('Agent experiment report: '+message);}
function positive(value){return Number.isSafeInteger(value)&&value>0;}
function only(obj,fields,label){
  if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!fields.includes(k)))deny('invalid '+label);
}
function known(value){return Number.isFinite(value)&&value>=0?value:null;}
function uniqueRun(record){
  return record.identity.github_run_id+':'+record.identity.github_run_attempt+':'+record.identity.unique_run_name;
}
function lineages(records,types){
  const manifest=records.map(x=>({kind:x.kind,path:x.path,sha256:x.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  if(new Set(manifest.map(x=>x.path)).size!==manifest.length)deny('duplicate source lineage');
  return {count:manifest.length,files:manifest,types};
}
function deterministicGroups(rows,keyOf){
  const result=new Map();
  for(const row of rows){
    const key=keyOf(row);
    if(!result.has(key))result.set(key,[]);
    result.get(key).push(row);
  }
  return [...result.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([id,values])=>({id,values}));
}
function average(values){
  if(!values.length)return null;
  if(values.some(v=>v==null))return null;
  return values.reduce((a,b)=>a+b,0)/values.length;
}
function summed(values){
  if(!values.length||values.some(x=>x==null))return null;
  return values.reduce((a,b)=>a+b,0);
}
function summarizeRows(rows){
  const tools=rows.map(r=>r.trace?.coverage?.tools==='observed'
    ? r.traceSummary.tools.observed_count : null);
  const skills=rows.map(r=>r.trace?.coverage?.skills==='observed'
    ? r.traceSummary.skills.observed_count : null);
  const mcp=rows.map(r=>r.trace?.coverage?.mcp==='observed'
    ? r.traceSummary.mcp.observed_count : null);
  const durations=rows.map(r=>known(r.summary.timing.agent_duration_ms));
  const tokens=rows.map(r=>known(r.summary.tokens?.total));
  const costs=rows.map(r=>known(r.summary.cost?.charged_usd??r.summary.cost?.estimated_usd));
  return {
    run_count:rows.length,
    run_refs:rows.map(x=>x.ref).sort(),
    tokens_total:summed(tokens),tokens_coverage:{observed:tokens.filter(x=>x!=null).length,total:rows.length},
    usd_total:summed(costs),usd_coverage:{observed:costs.filter(x=>x!=null).length,total:rows.length},
    cost_basis:rows.every(r=>r.summary.cost?.charged_usd!=null)?'charged':
      rows.some(r=>r.summary.cost?.charged_usd!=null)?'mixed_or_incomplete':'estimated_or_unknown',
    duration_avg_ms:average(durations),duration_coverage:{observed:durations.filter(x=>x!=null).length,total:rows.length},
    tool_calls_total:summed(tools),tool_coverage:{observed:tools.filter(x=>x!=null).length,total:rows.length},
    skill_invocations_total:summed(skills),skill_coverage:{observed:skills.filter(x=>x!=null).length,total:rows.length},
    mcp_calls_total:summed(mcp),mcp_coverage:{observed:mcp.filter(x=>x!=null).length,total:rows.length},
  };
}
function evidenceSnapshot(proof){
  if(proof===null)return {reviews:[],acceptances:[],checkpoints:[],issue:null};
  only(proof,['schema_version','kind','repository','reviews','acceptances','checkpoints'],'proof snapshot');
  if(proof.schema_version!==1||proof.kind!=='trusted_agent_evidence_snapshot'||
      proof.repository!=='BestNathan/nession')deny('invalid evidence snapshot source');
  for(const name of ['reviews','acceptances','checkpoints']){
    if(!Array.isArray(proof[name])||proof[name].length>3000)deny('invalid '+name+' evidence set');
  }
  for(const r of proof.reviews){
    only(r,['issue','pr','agent_id','sha','outcome','run_id','attempt','ordinal'],'review');
    if(!positive(r.issue)||!positive(r.pr)||!positive(r.run_id)||!positive(r.attempt)||
      !positive(r.ordinal)||!SHA40.test(r.sha??'')||
      !['approved','changes_requested'].includes(r.outcome))deny('invalid review proof');
  }
  for(const a of proof.acceptances){
    only(a,['issue','sc','sha','outcome','run_id','attempt'],'acceptance');
    if(!positive(a.issue)||!/^SC-\d{2,3}$/.test(a.sc??'')||!SHA40.test(a.sha??'')||
      !positive(a.run_id)||!positive(a.attempt)||!['Pass','Fail','Pending'].includes(a.outcome))deny('invalid SC proof');
  }
  for(const c of proof.checkpoints){
    only(c,['issue','agent_id','sha','recovered','run_id','attempt'],'checkpoint');
    if(!positive(c.issue)||!SHA40.test(c.sha??'')||
      typeof c.recovered!=='boolean'||!positive(c.run_id)||!positive(c.attempt))deny('invalid checkpoint proof');
  }
  const key=r=>r.issue+':'+r.run_id+':'+r.attempt+':'+(r.sc??r.pr??r.agent_id);
  for(const name of ['reviews','acceptances','checkpoints']){
    const rows=proof[name],ids=rows.map(key);
    if(new Set(ids).size!==ids.length)deny('duplicate/conflicting '+name+' evidence');
  }
  return proof;
}
export function buildExperimentReport(summaries,traces=[],proof=null,provenance={}){
  if(!Array.isArray(summaries)||!Array.isArray(traces)||summaries.length>MAX_FILES||traces.length>MAX_FILES)deny('oversized input');
  const evidence=evidenceSnapshot(proof),index=new Map(),source=[];
  for(const row of summaries){
    validateAgentWorkflowTelemetry(row);
    if(row.identity.repository!=='BestNathan/nession')deny('foreign summary repository');
    const id=uniqueRun(row);
    if(index.has(id))deny('duplicate run identity '+id);
    index.set(id,{summary:row,trace:null,traceSummary:null,ref:id});
  }
  for(const trace of traces){
    validateExecutionTrace(trace);
    const id=uniqueRun(trace),record=index.get(id);
    if(!record)deny('orphan trace');
    if(record.trace)deny('duplicate trace');
    validateTraceSource(trace,record.summary);
    record.trace=trace;
    record.traceSummary=summarizeExecutionTrace(trace);
  }
  const rows=[...index.values()].sort((a,b)=>a.ref.localeCompare(b.ref));
  const roles=deterministicGroups(rows,x=>[
    x.summary.task.issue??'unattributed',x.summary.agent.role??'unknown',
    x.summary.agent.id??'unknown',x.summary.agent.provider,
    x.summary.agent.model?.id??'unknown',x.summary.agent.harness_sha256??'unknown',
  ].join('|')).map(({id,values})=>({group:id,...summarizeRows(values)}));
  const byIssue=deterministicGroups(rows,x=>String(x.summary.task.issue??'unattributed'))
    .map(({id,values})=>({issue:id,...summarizeRows(values)}));
  const linked=(v)=>rows.filter(x=>x.summary.task.issue===v.issue&&
    x.summary.identity.github_run_id===v.run_id&&
    x.summary.identity.github_run_attempt===v.attempt&&
    x.summary.task.target_ref===v.sha);
  for(const family of ['reviews','acceptances','checkpoints']){
    for(const row of evidence[family]){
      if(!linked(row).length)deny('unmatched exact-SHA '+family+' evidence');
    }
  }
  const reviewed=new Map();
  for(const item of evidence.reviews){
    const key=item.issue+':'+item.pr;
    if(!reviewed.has(key))reviewed.set(key,[]);
    reviewed.get(key).push(item);
  }
  const firstPass=[...reviewed.values()].map(a=>{
    const ordered=[...a].sort((x,y)=>x.ordinal-y.ordinal);
    if(new Set(ordered.map(x=>x.ordinal)).size!==ordered.length)deny('conflicting review ordinal');
    if(ordered[0].ordinal!==1)deny('missing first review evidence');
    return ordered[0].outcome==='approved';
  });
  const accepted=evidence.acceptances.filter(x=>x.outcome==='Pass')
    .sort((a,b)=>a.issue-b.issue||a.sc.localeCompare(b.sc));
  const acceptedCosts=accepted.map(item=>{
    const items=linked(item);
    if(items.length!==1)deny('ambiguous accepted SC source attribution');
    return {issue:item.issue,sc:item.sc,sha:item.sha,run_ref:items[0].ref,
      token_total:known(items[0].summary.tokens?.total),
      usd:known(items[0].summary.cost?.charged_usd??items[0].summary.cost?.estimated_usd)};
  });
  return {
    schema_version:1,kind:'agent_experiment_report',repository:'BestNathan/nession',
    metrics_commit_sha:provenance.metrics_commit_sha??null,
    evidence_sha256:provenance.evidence_sha256??null,
    inputs:{run_count:rows.length,trace_count:traces.length,
      missing_trace_count:rows.length-traces.length,
      proof_review_count:evidence.reviews.length,
      proof_acceptance_count:evidence.acceptances.length,
      proof_checkpoint_count:evidence.checkpoints.length},
    groups:roles,issues:byIssue,
    review:{first_pass_rate:firstPass.length?firstPass.filter(Boolean).length/firstPass.length:null,
      review_pr_count:firstPass.length,repair_requests:evidence.reviews.length?
        evidence.reviews.filter(x=>x.outcome==='changes_requested').length:null},
    acceptance:{accepted_sc_count:accepted.length,accepted_sc_costs:acceptedCosts,
      accepted_tokens_total:summed(acceptedCosts.map(x=>x.token_total)),
      accepted_usd_total:summed(acceptedCosts.map(x=>x.usd))},
    recovery:{attempts:evidence.checkpoints.length,
      recovered:evidence.checkpoints.length?evidence.checkpoints.filter(x=>x.recovered).length:null,
      rate:evidence.checkpoints.length?
        evidence.checkpoints.filter(x=>x.recovered).length/evidence.checkpoints.length:null},
    limitations:[
      'Review and SC statistics are unavailable without independently authenticated exact-SHA evidence.',
      'Missing Provider observations remain null; events do not prove causal improvement.',
      'Estimated USD and charged USD are not interchangeable for provider cost comparisons.',
    ],
  };
}
// Read only a caller-pinned trusted Metrics worktree. Never fetch untrusted
// Issue comments or infer that a content hash alone proves GitHub authority.
export function loadPinnedMetrics(root,expectedSha){
  if(!SHA40.test(expectedSha??''))deny('expected Metrics commit SHA is required');
  const real=fs.realpathSync(root);
  const actual=execFileSync('git',['-C',real,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(actual!==expectedSha)deny('Metrics checkout SHA mismatch');
  const sources=[],summaries=[],traces=[];
  function walk(dir){
    const items=fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));
    for(const ent of items){
      const abs=path.join(dir,ent.name);
      const stat=fs.lstatSync(abs);
      if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))deny('symlink/nonregular Metrics path');
      if(stat.isDirectory()){walk(abs);continue;}
      if(!abs.endsWith('.json')||stat.size>MAX_RECORD)deny('unsafe Metrics record');
      const rel=path.relative(real,abs).split(path.sep).join('/');
      if(!/^raw\/(workflows|events)\/[a-z0-9._-]+\/\d{4}-\d{2}-\d{2}\/[a-z0-9._-]+\.json$/.test(rel))deny('unexpected Metrics path');
      let doc;
      const bytes=fs.readFileSync(abs);
      try{doc=JSON.parse(bytes.toString('utf8'));}catch{deny('invalid JSON at '+rel);}
      if(doc.kind==='agent_workflow_run'){
        if(telemetryStoragePath(doc)!==rel)deny('canonical summary storage path mismatch');
        summaries.push(doc);
      }else if(doc.kind==='agent_execution_trace'){
        if(traceStoragePath(doc)!==rel)deny('canonical trace storage path mismatch');
        traces.push(doc);
      }else deny('unexpected Metrics record kind');
      sources.push({kind:doc.kind,path:rel,sha256:sha(bytes)});
      if(sources.length>MAX_FILES)deny('Metrics input count exceeded');
    }
  }
  for(const family of ['workflows','events']){
    const folder=path.join(real,'raw',family);
    if(fs.existsSync(folder))walk(folder);
  }
  return {summaries,traces,sources:sources.sort((a,b)=>a.path.localeCompare(b.path))};
}
export function loadPinnedEvidence(file,expectedDigest){
  if(!SHA64.test(expectedDigest??''))deny('expected trusted Issue evidence digest required');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_RECORD)deny('unsafe Issue evidence snapshot');
  const bytes=fs.readFileSync(file);
  if(sha(bytes)!==expectedDigest)deny('Issue evidence digest mismatch');
  let data;
  try{data=JSON.parse(bytes.toString('utf8'));}catch{deny('malformed Issue evidence snapshot');}
  return evidenceSnapshot(data);
}
export function renderExperimentMarkdown(report){
  function metric(x){return x==null?'unobserved':String(x);}
  const lines=['# Agent experiment report','',
    'Metrics commit: '+metric(report.metrics_commit_sha),'',
    '| Group (Issue / Role / Agent / Provider / Model / Harness) | Runs | Tokens | USD | Tools | Skills | MCP |',
    '|---|---:|---:|---:|---:|---:|---:|'];
  for(const g of report.groups){
    lines.push('| '+g.group.replaceAll('|',' / ')+' | '+g.run_count+' | '+
      metric(g.tokens_total)+' | '+metric(g.usd_total)+' | '+
      metric(g.tool_calls_total)+' | '+metric(g.skill_invocations_total)+' | '+
      metric(g.mcp_calls_total)+' |');
  }
  lines.push('','First-pass Review: '+metric(report.review.first_pass_rate),
    ' (PR denominator '+report.review.review_pr_count+')',
    'Accepted SC: '+report.acceptance.accepted_sc_count,
    'Checkpoint recovery: '+metric(report.recovery.rate),
    '','## Measurement limitations',...report.limitations.map(x=>'- '+x),'');
  return lines.join('\n');
}
export function generatePinnedReport(root,metricsSha,evidenceFile,evidenceDigest){
  const input=loadPinnedMetrics(root,metricsSha);
  const proof=loadPinnedEvidence(evidenceFile,evidenceDigest);
  const report=buildExperimentReport(input.summaries,input.traces,proof,
    {metrics_commit_sha:metricsSha,evidence_sha256:evidenceDigest});
  return {report,manifest:{schema_version:1,kind:'agent_experiment_input_manifest',
    metrics_commit_sha:metricsSha,evidence_sha256:evidenceDigest,
    ...lineages(input.sources,['agent_workflow_run','agent_execution_trace'])}};
}
