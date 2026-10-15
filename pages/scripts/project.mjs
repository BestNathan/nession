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
function safeText(value, max = 120) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
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
export function makeProjection({ repository, agent, registry, issues, pulls, workflowRuns, issueTimelines, refs={}, meta={} }) {
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
      issues:list(issues,'issue').map(x=>({
        ...x, observed_agent_runs_7d:observedIssueCount(aw,x.number),
        pr_references:timelineReferences(x.number,issueTimelines?.[String(x.number)]),
      })),
      pulls:list(pulls,'pr').map(x=>{
        const source=Array.isArray(pulls)?pulls.find(p=>p.number===x.number):null;
        return {...x,workflow:prWorkflowEvidence(source,workflowRuns)};
      }),
    },
    evidence:{ stores:stores.map(([name,purpose])=>record(name,purpose)) },
  };
}
export function validateProjection(p) {
  if (p?.schema_version !== 1 || p?.source?.repository !== REPO || !safeDate(p.generated_at)) throw new Error('invalid public projection');
  if (!Array.isArray(p.agents?.roster) || !Array.isArray(p.evidence?.stores)) throw new Error('missing sections');
  // Schema is constructed by an allowlist. These keys would imply an accidental raw-data leak.
  const exported=JSON.stringify(p);
  if (/"(?:prompt|transcript|checkpoint_bytes|tool_arguments|tool_results|auth_token|secret|private_key|env)"\s*:/i.test(exported)) throw new Error('private field in projection');
  return p;
}
