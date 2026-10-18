// Strictly allowlisted, read-only public projection. No raw Agent events or private IDs.
const REPO = 'BestNathan/nession';
const GH = 'https://github.com/' + REPO;
const stores = [
  ['metrics', 'Repository and Agent telemetry'],
  ['acceptance-results', 'E2E and Acceptance evidence'],
  ['task-results', 'Verified Task execution records'],
  ['agent-store', 'Durable Agent checkpoints (only when provisioned)'],
];
const roles = new Set(['developer', 'reviewer', 'acceptor', 'auditor']);
function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
// Exclude private network addressing and machine-local paths from text fields.
const PRIVATE_TEXT = /(?:\b(?:10|127)\.(?:\d{1,3}\.){2}\d{1,3}\b|\b192\.168\.(?:\d{1,3}\.)\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}\b|\b(?:localhost|[a-z0-9.-]+\.internal)\b|\/(?:Users|home|etc|root)\/|[a-z]:\\\\(?:Users|Windows)\\\\|file:\/\/|\b(?:authorization|credential|private.key)\s*[:=])/i;
// Recognize credential-shaped strings by syntax only; no credential values or
// raw Agent inputs are ever needed for the public build.
const SENSITIVE_MARKER = new RegExp('(?:\\bgh[pousr]_|\\bgithub_pat_|\\b(?:sk|rk)-)[A-Za-z0-9_-]{16,}|\\b(?:api[_-]?key|access[_-]?token|password)\\s*[=:]\\s*[^\\s]+','i');
function safeText(value, max = 120) {
  if (typeof value!=='string')return '';
  const clean=value.replace(/<[^>]*>/g, ' ').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return PRIVATE_TEXT.test(clean)||SENSITIVE_MARKER.test(clean)?'[redacted public text]':clean.slice(0,max);
}
// A build timestamp never turns an old source measurement into a fresh one.
function sourceFreshness(sourceTime, builtAt, hours=8) {
  const source=safeDate(sourceTime), built=safeDate(builtAt);
  if (!source||!built)return {state:'unavailable',age_hours:null};
  const hoursOld=(Date.parse(built)-Date.parse(source))/3600000;
  if (hoursOld < -1/6)return {state:'unavailable',age_hours:null};
  return {state:hoursOld>hours?'stale':'fresh',age_hours:Math.round(Math.max(hoursOld,0)*10)/10};
}
function safeSha(value) { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null; }
function safeDate(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null; }
function canonIssue(entry, type) {
  if (!entry || !Number.isSafeInteger(entry.number) || entry.number <= 0) return null;
  const link = GH + '/' + (type === 'issue' ? 'issues/' : 'pull/') + entry.number;
  // Independent canonical URL, never publish arbitrary API-controlled links.
  return {
    number: entry.number, title: safeText(entry.title) || 'Untitled',
    url: link, state: entry.state === 'open' ? 'open' : 'unknown',
    updated_at: safeDate(entry.updated_at),
  };
}
function list(input, type) {
  if (!Array.isArray(input)) return [];
  return input.filter(x=>type !== 'issue' || !x.pull_request)
    .map(x=>canonIssue(x,type)).filter(Boolean)
    .sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||''))||a.number-b.number)
    .slice(0,12);
}
function countIn(obj,key) { return number(obj && obj[key]); }
function timelineReferences(issueId,source){
  const status=source?.status;
  if(!['available','truncated'].includes(status)||!Array.isArray(source?.events))
    return {status:'unavailable',prs:[]};
  const candidates=source.events.slice(0,100);
  const links=new Set();
  for(const e of candidates){
    if(e?.event!=='cross-referenced'||e?.source?.type!=='issue')continue;
    const item=e.source.issue,id=item?.number;
    if(!Number.isSafeInteger(id)||id<=0||item?.repository?.full_name!==REPO||
       !item.pull_request||item.url!== 'https://api.github.com/repos/'+REPO+'/issues/'+id||
       item.html_url!==GH+'/pull/'+id||
       item.pull_request.url!=='https://api.github.com/repos/'+REPO+'/pulls/'+id||
       item.pull_request.html_url!==GH+'/pull/'+id)continue;
    links.add(id);
  }
  const prs=[...links].sort((a,b)=>a-b).slice(0,6).map(number=>({
    number,url:GH+'/pull/'+number,relation:'github_cross_reference',
  }));
  return {status:status==='truncated'||source.events.length>=100?'truncated':'available',prs};
}
// A HEAD-bound review is an observed event, not an overall PR approval verdict.
// Historical APPROVED reviews on older commits must not be shown as current.
function reviewProof(raw, headSha, prNumber) {
  const id=raw?.id;
  if (!Number.isSafeInteger(id) || id<=0 ||
      raw.commit_id!==headSha ||
      raw.pull_request_url!=='https://api.github.com/repos/'+REPO+'/pulls/'+prNumber ||
      raw.html_url!==GH+'/pull/'+prNumber+'#pullrequestreview-'+id ||
      !['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'].includes(raw.state) ||
      !safeDate(raw.submitted_at))return null;
  return {review_id:id,commit_sha:headSha,state:raw.state.toLowerCase(),
    submitted_at:safeDate(raw.submitted_at),url:GH+'/pull/'+prNumber+'#pullrequestreview-'+id};
}
function prReviewEvidence(pr, source) {
  const sha=safeSha(pr?.head?.sha);
  if(!sha||pr?.head?.repo?.full_name!==REPO||
     !Number.isSafeInteger(pr?.number)||pr.number<=0 ||
     !['available','truncated'].includes(source?.status) ||
     !Array.isArray(source?.items))return {status:'unavailable',latest:null};
  const items=source.items.slice(0,100);
  const latest=items.map(x=>reviewProof(x,sha,pr.number)).filter(Boolean)
    .sort((a,b)=>b.submitted_at.localeCompare(a.submitted_at)||b.review_id-a.review_id)[0]||null;
  return {status:source.status==='truncated'||source.items.length>=100?'truncated':'available',latest};
}

const WORKFLOWS = Object.freeze({
  ci:{name:'CI / Quality Gate',path:'.github/workflows/ci-quality.yml'},
  e2e:{name:'E2E / Tests',path:'.github/workflows/e2e-tests.yml'},
});
function runProof(raw,headSha,key){
  const canonical=WORKFLOWS[key];
  if(!raw||raw.name!==canonical.name||
     raw.path?.replace(/@refs\/heads\/[^\s]+$/,'')!==canonical.path||
     raw.event!=='pull_request'||raw.head_sha!==headSha||
     raw.repository?.full_name!==REPO||raw.head_repository?.full_name!==REPO||
     !Number.isSafeInteger(raw.id)||raw.id<=0||
     !Number.isSafeInteger(raw.run_attempt)||raw.run_attempt<=0||
     !['completed','queued','in_progress'].includes(raw.status))return null;
  const status=raw.status==='completed'&&
    ['success','failure','cancelled','timed_out'].includes(raw.conclusion)
      ? raw.conclusion : raw.status==='completed'?'unavailable':raw.status;
  return {run_id:raw.id,attempt:raw.run_attempt,head_sha:headSha,
    status,updated_at:safeDate(raw.updated_at),
    url:GH+'/actions/runs/'+raw.id};
}
function prWorkflowEvidence(raw,allRuns){
  const head=raw?.head;
  if(!head||head.repo?.full_name!==REPO||!safeSha(head.sha))return {head_sha:null,ci:null,e2e:null};
  const rows=Array.isArray(allRuns)?allRuns.slice(0,100):[];
  const pick=key=>rows.map(r=>runProof(r,head.sha,key)).filter(Boolean)
     .sort((a,b)=>b.run_id-a.run_id||b.attempt-a.attempt)[0]||null;
  return {head_sha:head.sha,ci:pick('ci'),e2e:pick('e2e')};
}

// Per-Issue source-bound Agent run observation; never an implementing-PR join.
// Only an independent exact GitHub Workflow Run match certifies Run identity.
const AGENT_RUN_WORKFLOWS=Object.freeze({
  'issue-audit':{name:'Agent / Issue Audit',path:'.github/workflows/issue-audit.yml'},
  'requirement-acceptance':{name:'Acceptance / Orchestrator',path:'.github/workflows/acceptance-orchestrator.yml'},
  'agent-provider-smoke':{name:'Agent / Provider Smoke',path:'.github/workflows/agent-provider-smoke.yml'},
});
function issueAgentObservations(number, source, allRuns) {
  if(!['available','truncated'].includes(source?.status)||!Array.isArray(source?.records))
    return [];
  const actions=Array.isArray(allRuns)?allRuns.slice(0,100):[];
  return source.records.filter(r=>r.issue===number).slice(0,3).map(r=>{
    const workflow=AGENT_RUN_WORKFLOWS[r.workflow];
    const run=actions.find(x=>x.id===r.run_id);
    const verified=!!(workflow && run &&
      run.id===r.run_id && run.run_attempt===r.attempt &&
      run.name===workflow.name &&
      run.path?.replace(/@refs\/heads\/[^\s]+$/,'')===workflow.path &&
      run.repository?.full_name===REPO && run.head_repository?.full_name===REPO &&
      run.event===r.event && (!r.target_sha||run.head_sha===r.target_sha));
    return {
      run_id:r.run_id,attempt:r.attempt,workflow:r.workflow,
      target_sha:r.target_sha,agent_id:r.agent_id,role:r.role,provider:r.provider,
      tokens_total:r.tokens_total,duration_ms:r.duration_ms,
      observed_at:r.observed_at,verification:verified?'github_run_verified':'not_independently_verified',
      pr_linkage:'unlinked',url:GH+'/actions/runs/'+r.run_id,
    };
  });
}

// Canonical aggregate metrics are not exact-SHA Issue/PR/Agent-Run proofs.
// Strictly allowlist public category names and bounded integer counts.
function observedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function observedSegments(window, key) {
  const raw = window?.runs?.[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {available:false, items:[]};
  return {
    available:true,
    items:Object.entries(raw)
      .filter(([name,value]) => /^[a-z][a-z0-9_-]{0,47}$/.test(name) && observedCount(value) !== null)
      .map(([name,count]) => ({name,count}))
      .sort((a,b) => b.count-a.count || a.name.localeCompare(b.name))
      .slice(0,12),
  };
}
function observedIssueCount(window, issueNumber) {
  const counts = window?.runs?.by_issue;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const key=String(issueNumber);
  return Object.hasOwn(counts,key) ? observedCount(counts[key]) : null;
}
function rosterFrom(registry, agentWindow) {
  const known = registry && typeof registry.instances === 'object' && registry.instances || {};
  const usage = agentWindow?.runs?.by_agent_id || {};
  return Object.entries(known).filter(([id,item])=>
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) &&
    item && roles.has(item.role)
  ).slice(0,40).map(([id,item])=>({
    id, role:item.role, provider:safeText(item.provider,32)||'unavailable',
    // The summary only observes IDs with records. No record is not an observed zero.
    observed_7d: Object.hasOwn(usage,id) ? number(usage[id]) : null,
  })).sort((a,b)=>a.role.localeCompare(b.role)||a.id.localeCompare(b.id));
}
export function makeProjection({ repository, agent, registry, issues, pulls, workflowRuns, issueTimelines, prReviews, issueRunSource, refs={}, meta={} }) {
  const r = repository?.schema_version === 2 ? repository : null;
  const a = agent?.schema_version === 1 && agent?.kind === 'agent_metrics_aggregate' ? agent : null;
  const current = r?.repository || {}, efficiency = r?.efficiency || {};
  const aw = a?.windows?.['7d'] || {};
  const aw30 = a?.windows?.['30d'] || {};
  const tok = aw?.tokens?.total || {}, tool=aw?.tools||{}, cost=aw?.cost_usd?.charged || {};
  const record = (name,purpose)=>{
    const v=refs[name];
    return {
      name, purpose,
      state: v?.state === 'present' && safeSha(v.sha) ? 'present' : v?.state === 'missing' ? 'missing' : 'unavailable',
      sha: safeSha(v?.sha),
      url:GH+'/tree/'+name
    };
  };
  return {
    schema_version:1,
    generated_at: safeDate(meta.generated_at) || new Date(0).toISOString(),
    source: {
      repository:REPO,
      main_sha:safeSha(meta.main_sha),
      metrics_sha:safeSha(meta.metrics_sha),
      issues_status:Array.isArray(issues)?'available':'unavailable',
      pulls_status:Array.isArray(pulls)?'available':'unavailable',
      workflow_runs_status:Array.isArray(workflowRuns)?'available':'unavailable',
    },
    repository: {
      available:!!r,
      sha:safeSha(r?.commit_sha),
      generated_at:safeDate(r?.generated_at),
      freshness:sourceFreshness(r?.generated_at,meta.generated_at),
      current: {
        loc:countIn(current.source,'loc'),
        files:countIn(current.source,'files'),
        tests:countIn(current.tests,'total'),
        rust_coverage:number(current.coverage?.rust?.lines?.rate),
        web_coverage:number(current.coverage?.web?.lines?.rate),
        protocol_units:countIn(current.protocols?.units,'total'),
        unit_pass:number(current.execution?.unit?.pass_rate),
      },
      efficiency: {
        commits_7d:countIn(efficiency.commits,'last_7d'),
        additions_7d:countIn(efficiency.source_churn,'additions'),
        deletions_7d:countIn(efficiency.source_churn,'deletions'),
        merged_7d:countIn(efficiency.pull_requests,'merged_7d'),
        open_issues:countIn(efficiency.issues,'open'),
        open_prs:countIn(efficiency.pull_requests,'open')
      },
    },
    agents: {
      available:!!a,
      generated_at:safeDate(a?.generated_at),
      freshness:sourceFreshness(a?.generated_at,meta.generated_at),
      roster:rosterFrom(registry,aw),
      distribution: {
        '7d': {providers:observedSegments(aw,'by_provider'), workflows:observedSegments(aw,'by_workflow')},
        '30d': {providers:observedSegments(aw30,'by_provider'), workflows:observedSegments(aw30,'by_workflow')},
      },
      summary: {
        runs_7d:countIn(aw.runs,'total'),
        runs_30d:countIn(aw30.runs,'total'),
        tokens_7d:number(tok.total),
        tokens_observed_runs:number(tok.observed_runs),
        tools_7d:number(tool.total),
        tools_observed_runs:number(tool.observed_runs),
        cost_7d:cost.observed_runs > 0 ? number(cost.total) : null,
      },
    },
    work: {
      issues_status:Array.isArray(issues)?'available':'unavailable',
      pulls_status:Array.isArray(pulls)?'available':'unavailable',
      workflow_runs_status:Array.isArray(workflowRuns)?'available':'unavailable',
      agent_run_source:['available','truncated'].includes(issueRunSource?.status)?issueRunSource.status:'unavailable',
      issues:list(issues,'issue').map(x=>({
        ...x, observed_agent_runs_7d:observedIssueCount(aw,x.number),
        pr_references:timelineReferences(x.number,issueTimelines?.[String(x.number)]),
        agent_runs:issueAgentObservations(x.number,issueRunSource,workflowRuns),
      })),
      pulls:list(pulls,'pr').map(x=>{
        const source=Array.isArray(pulls)?pulls.find(p=>p.number===x.number):null;
        return {...x,workflow:prWorkflowEvidence(source,workflowRuns),review:prReviewEvidence(source,prReviews?.[String(x.number)])};
      }),
    },
    evidence:{ stores:stores.map(([name,purpose])=>record(name,purpose)) },
  };
}
// Only exported public contract keys are permitted. This is a release gate,
// independent of the read-only producer's allowlisting.
function allowedFields(item,keys,where) {
  if (!item||typeof item!=='object'||Array.isArray(item))throw Error('invalid public '+where);
  for (const key of Object.keys(item))
    if(!keys.includes(key))throw Error('disallowed public field '+where+'.'+key);
}
function checkFreshness(item) {
  allowedFields(item,['state','age_hours'],'freshness');
  if(!['fresh','stale','unavailable'].includes(item.state)||
     (item.age_hours!==null&&(!Number.isFinite(item.age_hours)||item.age_hours<0)))
    throw Error('invalid metric freshness');
}
export function validateProjection(p) {
  if (p?.schema_version !== 1 || p?.source?.repository !== REPO || !safeDate(p.generated_at)) throw new Error('invalid public projection');
  if (!Array.isArray(p.agents?.roster) || !Array.isArray(p.evidence?.stores)) throw new Error('missing sections');
  // Schema is constructed by an allowlist. These keys would imply an accidental raw-data leak.
  allowedFields(p,['schema_version','generated_at','source','repository','agents','work','evidence'],'root');
  allowedFields(p.source,['repository','main_sha','metrics_sha','issues_status','pulls_status','workflow_runs_status'],'source');
  allowedFields(p.repository,['available','sha','generated_at','freshness','current','efficiency'],'repository');
  allowedFields(p.agents,['available','generated_at','freshness','roster','distribution','summary'],'agents');
  allowedFields(p.work,['issues_status','pulls_status','workflow_runs_status','agent_run_source','issues','pulls'],'work');
  allowedFields(p.evidence,['stores'],'evidence');
  allowedFields(p.repository.current,['loc','files','tests','rust_coverage','web_coverage','protocol_units','unit_pass'],'repository.current');
  allowedFields(p.repository.efficiency,['commits_7d','additions_7d','deletions_7d','merged_7d','open_issues','open_prs'],'repository.efficiency');
  allowedFields(p.agents.summary,['runs_7d','runs_30d','tokens_7d','tokens_observed_runs','tools_7d','tools_observed_runs','cost_7d'],'agents.summary');
  allowedFields(p.agents.distribution,['7d','30d'],'agents.distribution');
  for(const period of ['7d','30d']){
    allowedFields(p.agents.distribution[period],['providers','workflows'],'distribution');
    for(const key of ['providers','workflows']){
      const segment=p.agents.distribution[period][key];
      allowedFields(segment,['available','items'],'distribution segment');
      if(!Array.isArray(segment.items)||segment.items.length>12)throw Error('unbounded public distribution');
      segment.items.forEach(x=>allowedFields(x,['name','count'],'distribution entry'));
    }
  }
  p.agents.roster.forEach(x=>allowedFields(x,['id','role','provider','observed_7d'],'Agent roster'));
  p.evidence.stores.forEach(x=>allowedFields(x,['name','purpose','state','sha','url'],'store'));
  checkFreshness(p.repository.freshness);
  checkFreshness(p.agents.freshness);
  if(!Array.isArray(p.work.issues)||p.work.issues.length>12||
     !Array.isArray(p.work.pulls)||p.work.pulls.length>12||
     p.agents.roster.length>40||p.evidence.stores.length>4)
    throw Error('unbounded public data');
  const issueFields=['number','title','url','state','updated_at','observed_agent_runs_7d','pr_references','agent_runs'];
  if(!['available','truncated','unavailable'].includes(p.work.agent_run_source))
    throw Error('invalid Issue Agent source status');
  const prFields=['number','title','url','state','updated_at','workflow','review'];
  for(const item of p.work.issues){
    allowedFields(item,issueFields,'issue');
    allowedFields(item.pr_references,['status','prs'],'issue references');
    if(!Array.isArray(item.agent_runs)||item.agent_runs.length>3)
      throw Error('unbounded public Agent runs');
    if(p.work.agent_run_source==='unavailable' && item.agent_runs.length)
      throw Error('unavailable Agent source cannot produce runs');
    for(const r of item.agent_runs){
      allowedFields(r,['run_id','attempt','workflow','target_sha','agent_id','role','provider','tokens_total','duration_ms','observed_at','verification','pr_linkage','url'],'Issue Agent event');
      if(!Number.isSafeInteger(r.run_id)||r.run_id<=0||!Number.isSafeInteger(r.attempt)||r.attempt<=0||
         !Object.hasOwn(AGENT_RUN_WORKFLOWS,r.workflow)||
         (r.target_sha!==null&&!safeSha(r.target_sha))||
         (r.agent_id!==null&&!/^[a-z][a-z0-9-]{0,62}$/.test(r.agent_id))||
         (r.role!==null&&!['developer','reviewer','acceptor','auditor'].includes(r.role))||
         (r.provider!==null&&!/^[a-z][a-z0-9_-]{0,31}$/.test(r.provider))||
         !safeDate(r.observed_at)||
         !['github_run_verified','not_independently_verified'].includes(r.verification)||
         r.pr_linkage!=='unlinked'||r.url!==GH+'/actions/runs/'+r.run_id||
         [r.tokens_total,r.duration_ms].some(n=>n!==null&&(!Number.isSafeInteger(n)||n<0)))
        throw Error('invalid Issue Agent source evidence');
    }
    if(!Array.isArray(item.pr_references.prs)||item.pr_references.prs.length>6)
      throw Error('unbounded public Issue links');
  }
  for(const item of p.work.pulls)allowedFields(item,prFields,'PR');
  for(const item of p.work.issues){
    item.pr_references.prs.forEach(ref=>allowedFields(ref,['number','url','relation'],'Issue PR source'));
  }
  for(const item of p.work.pulls){
    allowedFields(item.review,['status','latest'],'PR review');
    if(!['available','truncated','unavailable'].includes(item.review.status))throw Error('invalid review source status');
    if(item.review.status==='unavailable'&&item.review.latest!==null)
      throw Error('unavailable review source cannot certify an event');
    if(item.review.latest!==null){
      const review=item.review.latest;
      allowedFields(review,['review_id','commit_sha','state','submitted_at','url'],'PR review event');
      if(!Number.isSafeInteger(review.review_id)||review.review_id<=0||
        !['approved','changes_requested','commented','dismissed'].includes(review.state)||
        !safeDate(review.submitted_at) ||
        !safeSha(review.commit_sha)||review.commit_sha!==item.workflow.head_sha||
        review.url!==GH+'/pull/'+item.number+'#pullrequestreview-'+review.review_id)
          throw Error('invalid exact-HEAD review proof');
    }
    allowedFields(item.workflow,['head_sha','ci','e2e'],'PR workflow');
    for(const key of ['ci','e2e'])if(item.workflow[key]!==null)
      allowedFields(item.workflow[key],['run_id','attempt','head_sha','status','updated_at','url'],'workflow Run');
  }
  let serializedBytes=0;
  const scan=(data,key='')=>{
    if(data===null||data===undefined)return;
    if(typeof data==='number'&&(!Number.isFinite(data)||data<0))
      throw Error('invalid public metric');
    if(typeof data==='string'){
      serializedBytes+=Buffer.byteLength(data);
      if(serializedBytes>128*1024)throw Error('public projection exceeds release limit');
      if(PRIVATE_TEXT.test(data)||SENSITIVE_MARKER.test(data))throw Error('private field value in public projection');
      if(key==='url'&&!/^https:\/\/github\.com\/BestNathan\/nession\/(?:issues\/[1-9]\d*|pull\/[1-9]\d*|actions\/runs\/[1-9]\d*|pull\/[1-9]\d*#pullrequestreview-[1-9]\d*|tree\/(?:metrics|acceptance-results|task-results|agent-store))$/.test(data))
        throw Error('untrusted public URL');
    } else if(Array.isArray(data))data.forEach(x=>scan(x,key));
    else if(typeof data==='object'){
      for(const [name,value] of Object.entries(data)){
        if(/^(?:prompt|transcript|checkpoint_bytes|tool_arguments|tool_results|auth_token|secret|private_key|env|session_id|hostname)$/i.test(name))
          throw Error('private field in projection');
        scan(value,name);
      }
    }
  };
  scan(p);
  return p;
}
