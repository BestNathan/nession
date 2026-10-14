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
  return typeof value === 'string' ? value.replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
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
export function makeProjection({ repository, agent, registry, issues, pulls, refs={}, meta={} }) {
  const r = repository?.schema_version === 2 ? repository : null;
  const a = agent?.schema_version === 1 && agent?.kind === 'agent_metrics_aggregate' ? agent : null;
  const current = r?.repository || {}, efficiency = r?.efficiency || {};
  const aw = a?.windows?.['7d'] || {};
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
    },
    repository: {
      available:!!r,
      sha:safeSha(r?.commit_sha),
      generated_at:safeDate(r?.generated_at),
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
      roster:rosterFrom(registry,aw),
      summary: {
        runs_7d:countIn(aw.runs,'total'),
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
      issues:list(issues,'issue'),pulls:list(pulls,'pr'),
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
