// Pages deliberately has no dependency on nession/web, runtime APIs, or UI packages.
const root = document.getElementById('main');
const freshness = document.getElementById('freshness');
const routes = new Set(['/', '/agents', '/work', '/repository', '/evidence']);
let snapshot = null;

function node(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined && content !== null) item.textContent = String(content);
  return item;
}
function attach(parent, ...children) { for (const child of children) if (child) parent.append(child); return parent; }
function ext(text, url) {
  const a = node('a', '', text);
  // Build-time allowlisting is paired with browser-side URL checks.
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
      a.href = parsed.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    }
  } catch { /* inaccessible source deliberately remains plain text */ }
  return a;
}
function local(text, path, className) { const a = node('a', className || '', text); a.href = '#' + path; return a; }
function fmt(n) {
  if (n === null || n === undefined || typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  return Intl.NumberFormat('en-US', { notation: Math.abs(n) > 9999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}
function pct(n) { return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) + '%' : 'N/A'; }
function date(n) { if (!n || Number.isNaN(Date.parse(n))) return 'Unavailable'; return new Date(n).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' }); }
function section(kicker, title, hint) {
  const wrapper = node('section', 'section');
  const head = node('div', 'section-title');
  const left = node('div');
  attach(left, node('div', 'eyebrow', kicker), node('h2', '', title));
  attach(head, left, node('div', 'hint', hint));
  wrapper.append(head);
  return wrapper;
}
function grid(items, cols) { const wrap = node('div','grid ' + cols); items.forEach(x => wrap.append(x)); return wrap; }
function metric(label, value, note) {
  const m = node('article','metric');
  attach(m,node('div','label',label),node('div','value',value),node('div','note',note));
  return m;
}
function pageHead(kicker, title, description) {
  const wrap = node('div','page-head');
  attach(wrap,node('div','eyebrow',kicker),node('h1','',title),node('p','lede',description));
  return wrap;
}
function lineItem(title, subtitle, value, url, stamp) {
  const row = node('article','entry');
  const main = node('div','entry-main');
  const label = url ? ext(title, url) : node('span','',title);
  label.classList.add('entry-title');
  if (!url) label.classList.add('unlinked');
  const bold = node('strong','',title);
  if (url && label.tagName === 'A') label.textContent = '';
  if (url && label.tagName === 'A') label.append(bold);
  // For non-linked entries label remains a safe text node.
  attach(main,label,node('small','',subtitle));
  const right = node('div','entry-right');
  attach(right,node('strong','',value),node('span','',stamp || ''));
  attach(row,main,right);
  return row;
}
function empty(title, text) {
  const wrap = node('article','panel');
  attach(wrap,node('h3','',title),node('p','',text)); return wrap;
}
function renderHome() {
  const hero = node('section','hero');
  const copy = node('div');
  const title = node('h1'); attach(title,'An open space ',node('em','', 'for what comes next.'));
  const actions=node('div','actions');attach(actions,local('Explore the Agents  ↗','/agents','action'),local('See the engineering  ↗','/work','action outline'));
  attach(copy,node('div','eyebrow','OPEN SOURCE  /  DISTRIBUTED WORKSPACE'),title,
    node('p','lede','Work should continue across machines, terminals and AI agents without rebuilding your context. Nession is building that experience—and showing the engineering behind it.'),actions);
  const diagram = node('aside','diagram');
  const top=node('div','diagram-head');attach(top,node('span','eyebrow','COLLABORATION LOOP'),node('span','mono','01 / 05'));diagram.append(top);
  [['Issue','The shared work contract'],['Developer','Implement and checkpoint'],['Reviewer','Inspect, repair and verify'],['Quality + E2E','Exact revision, real tests'],['Acceptance','Evidence before completion']].forEach((s,i)=>{
    if(i)diagram.append(node('div','loop-arrow','↓'));
    const r=node('div','loop-step');attach(r,node('span','loop-no',String(i+1).padStart(2,'0')),attach(node('div'),node('strong','',s[0]),node('small','',s[1])));diagram.append(r);
  });
  const foot=node('div','loop-foot');attach(foot,node('i','dot'),node('span','', 'Documented workflow · actual progress depends on verified evidence'));diagram.append(foot);
  attach(hero,copy,diagram);root.append(hero);
  const r=snapshot.repository?.current, e=snapshot.repository?.efficiency, a=snapshot.agents?.summary;
  const pulse=section('PROJECT PULSE','The work, at a glance','A generated snapshot, not a live connection to the project.');
  pulse.append(grid([
    metric('Source lines',fmt(r?.loc),'main · ' + date(snapshot.repository?.generated_at)),
    metric('Open issues',fmt(e?.open_issues),'GitHub snapshot'),
    metric('Open pull requests',fmt(e?.open_prs),'GitHub snapshot'),
    metric('Observed AI runs · 7 days',fmt(a?.runs_7d),'Canonical workflow telemetry')
  ],'four'));root.append(pulse);
  const what=section('WHY NESSION','Less infrastructure. More continuity.','One product, distributed execution.');
  const p1=empty('One working context','Move between local machines, remote servers and terminals without turning connection management into your work.');
  const p2=empty('Open engineering','See issue requirements, code reviews, testing and acceptance evidence instead of a polished success counter.');
  const p3=empty('Agents with provenance','Explore registered AI roles and observed model runs. Missing measurements stay missing.');
  what.append(grid([p1,p2,p3],'three'));root.append(what);
  const latest=section('NOW BUILDING','Follow the work','Links point to the source GitHub Issues and pull requests.');
  const rows=(snapshot.work?.issues||[]).slice(0,4).map(x=>lineItem('#'+x.number+'  '+x.title,'Issue · '+x.state,'Updated',x.url,date(x.updated_at)));
  latest.append(rows.length?attach(node('div','list'),...rows):empty('No current Issue snapshot','GitHub activity could not be verified for this build.'));
  root.append(latest);
}
function renderAgents(){
  root.append(pageHead('THE AI TEAM','The agents behind the work.','Registered workflow Agents are not the Nession runtime node Agents. A role can exist without a successful run; usage is shown only where actually observed.'));
  const w=snapshot.agents||{}, s=w.summary||{};
  root.append(node('p','hint','Agent metrics source: '+(w.freshness?.state||'unavailable')+' · measured '+date(w.generated_at)+' · site built '+date(snapshot.generated_at)));

  const stats=section('OBSERVED USAGE','Work in numbers','7-day window · missing measurements are N/A, not zero.');
  stats.append(grid([metric('Agent runs',fmt(s.runs_7d),'workflow summary'),
    metric('Tokens',fmt(s.tokens_7d),'observed '+fmt(s.tokens_observed_runs)+' runs'),
    metric('Tool calls',fmt(s.tools_7d),'observed '+fmt(s.tools_observed_runs)+' runs'),
    metric('Cost in USD',s.cost_7d===null?'Unobserved':'$'+fmt(s.cost_7d),'no estimation inferred')],'four'));root.append(stats);
  const summary30=section('OBSERVED TIME WINDOWS','7 days and 30 days','Canonical workflow totals · generated '+date(w.generated_at)+' · metrics revision '+(snapshot.source?.metrics_sha?.slice(0,12)||'unavailable'));
  summary30.append(grid([metric('7-day runs',fmt(s.runs_7d),'observed workflow runs'),metric('30-day runs',fmt(s.runs_30d),'observed workflow runs')],'two'));
  root.append(summary30);
  const breakdown=section('SOURCE AGGREGATES','Who ran the work','By provider and workflow. Counts are measured totals, not individual Agent costs, real-time presence or success verdicts.');
  const distribution=w.distribution||{};
  const panelFor=(title,key)=>{
    const panel=node('article','panel');
    panel.append(node('h3','',title));
    const w7=distribution['7d']?.[key], w30=distribution['30d']?.[key];
    if(!w7?.available && !w30?.available){
      panel.append(node('p','', 'Breakdown unavailable for these windows.'));return panel;
    }
    const names=[...new Set([...(w7?.items||[]),...(w30?.items||[])].map(x=>x.name))].slice(0,12);
    const counts=(source,name)=>source?.items?.find(item=>item.name===name)?.count;
    const rows=names.map(name=>lineItem(name,'Canonical '+title.toLowerCase()+' aggregation',
      fmt(counts(w7,name))+' / '+fmt(counts(w30,name)),null,'runs · 7d / 30d'));
    if(rows.length)panel.append(attach(node('div','list'),...rows));
    else panel.append(node('p','','No valid observations in these source windows.'));
    return panel;
  };
  breakdown.append(grid([panelFor('Providers','providers'),panelFor('Workflows','workflows')],'two'));
  root.append(breakdown);
  const roster=section('ROLE REGISTRY','Who can do what','Registered instances · per-agent counts require observed identities.');
  const rows=(w.roster||[]).map(x=>lineItem(x.id,'Role: '+x.role+'  /  Provider: '+x.provider,
    x.observed_7d===null?'Not observed':fmt(x.observed_7d)+' runs',null,'7d source'));
  roster.append(rows.length?attach(node('div','list'),...rows):empty('No registry snapshot','Agent roles are unavailable; this does not indicate that Agents are offline.'));
  root.append(roster);
  const note=node('div','callout','Important: aggregate token and cost metrics cannot be allocated to individual Agents without authenticated per-Agent evidence. Workflow runs are not real-time presence.');
  root.append(note);
}
function renderWork(){
  root.append(pageHead('OPEN COLLABORATION','Work in progress.','A read-only view of recently updated public Issues and PRs. No stage or SC verdict is inferred from an Issue title or workflow name.'));
  const w=snapshot.work||{};
  const listing=(type,items,availability)=>{
    const issueRow=(x)=>{
      const row=lineItem('#'+x.number+'  '+x.title,
        x.state+' · source GitHub · observed Agent runs (7d): '+
        (x.observed_agent_runs_7d===null||x.observed_agent_runs_7d===undefined
          ?'Not observed':fmt(x.observed_agent_runs_7d)),
        'Issue',x.url,date(x.updated_at));
      const pane=node('div','issue-pr-evidence');
      const refs=x.pr_references||{},items=Array.isArray(refs.prs)?refs.prs:[];
      pane.append(node('span','issue-pr-source','GitHub Timeline · PR cross-references (not ownership or SC proof)'));
      if(refs.status==='unavailable')pane.append(node('span','', 'Timeline unavailable'));
      else {
        if(!items.length)pane.append(node('span','',refs.status==='truncated'
          ?'No PR references in this incomplete snapshot':'No PR cross-references observed'));
        for(const item of items)pane.append(ext('PR #'+item.number+' · GitHub cross-reference',item.url));
        if(refs.status==='truncated')pane.append(node('span','', 'Timeline truncated · other references may be missing'));
      }
      pane.append(node('span','issue-pr-source','Pinned Metrics · Issue Agent Runs · PR linkage: Unlinked'));
      const observed=Array.isArray(x.agent_runs)?x.agent_runs:[];
      if(w.agent_run_source==='unavailable'){
        pane.append(node('span','', 'Issue Agent source unavailable · no run verified'));
      } else if(!observed.length){
        pane.append(node('span','', 'Agent runs: Not observed in bounded source window'));
      } else {
        for(const item of observed){
          const agent=item.agent_id||'Unknown Agent', role=item.role||'Unknown role';
          const label='Agent '+role+' / '+agent+' · '+item.workflow+
            ' · run '+item.run_id+' / attempt '+item.attempt;
          pane.append(ext(label,item.url));
          pane.append(node('span','mono',
            'Target '+(item.target_sha?.slice(0,12)||'unknown')+
            ' · '+(item.verification==='github_run_verified'
              ?'GitHub Run identity verified':'Not independently verified')+
            ' · tokens '+fmt(item.tokens_total)+
            ' · duration '+(item.duration_ms===null?'N/A':item.duration_ms+'ms')));
        }
      }
      if(w.agent_run_source==='truncated')
        pane.append(node('span','', 'Agent source truncated · other runs may be missing'));
      pane.append(local('Inspect bounded Issue evidence  ↗','/work/issue/'+x.number,'source-link'));
      row.querySelector?.('.entry-main')?.append(pane);
      return row;
    };
    const evidenceRow=(x)=>{
      const row=lineItem('#'+x.number+'  '+x.title,x.state+' · GitHub source',
        'PR',x.url,date(x.updated_at));
      const pane=node('div','work-evidence');
      const sha=x.workflow?.head_sha;
      pane.append(node('span','mono',sha?'PR HEAD '+sha.slice(0,12):'PR HEAD unavailable'));
      for(const [k,label] of [['ci','Quality'],['e2e','E2E']]){
        const run=x.workflow?.[k];
        if(run)pane.append(ext(label+' · '+run.status+' · run '+run.run_id+
          ' / attempt '+run.attempt,run.url));
        else pane.append(node('span','',label+': Not observed'));
      }
      const reviews=x.review||{},event=reviews.latest;
      pane.append(node('span','issue-pr-source','PR Review · observed exact-HEAD event, not overall approval'));
      if(reviews.status==='unavailable')pane.append(node('span','', 'Review source unavailable'));
      else {
        if(event)pane.append(ext('Review · '+event.state.replaceAll('_',' ')+
          ' · review '+event.review_id+' · HEAD '+event.commit_sha.slice(0,12),event.url));
        else pane.append(node('span','', 'Review: Not observed at current HEAD'));
        if(reviews.status==='truncated')
          pane.append(node('span','', 'Reviews truncated · current-HEAD event may be missing'));
      }
      pane.append(local('Inspect exact-HEAD PR evidence  ↗','/work/pr/'+x.number,'source-link'));
      row.querySelector?.('.entry-main')?.append(pane);
      return row;
    };
    const s=section('GITHUB / '+type.toUpperCase(),type,'Recently updated · open items');
    if(availability!=='available')s.append(empty('Snapshot unavailable','GitHub API data could not be fetched or validated. This is not evidence of zero active items.'));
    else if(!items.length)s.append(empty('No open items','No items returned by the current bounded snapshot.'));
    else s.append(attach(node('div','list'),...items.map(x=>
      type==='Pull Requests'?evidenceRow(x):issueRow(x))));
    root.append(s);
  };
  listing('Issues',w.issues||[],w.issues_status);listing('Pull Requests',w.pulls||[],w.pulls_status);
  root.append(node('p','hint',w.workflow_runs_status==='available'
    ? 'Run evidence is sampled from the 100 most recent GitHub Actions runs. Not observed does not imply no historical run.'
    : 'CI/E2E workflow source unavailable; missing evidence is not a successful or failed run.'));
  root.append(node('div','callout','The trusted Issue → PR → Agent run/attempt → exact-SHA Acceptance graph is not yet publicly projected. Until that data is verified, it is intentionally not presented as complete.'));
}
// Evidence-only drilldown uses the already-validated, bounded public JSON.
// A GitHub Timeline mention or observed Issue Run is NEVER a causal PR edge.
function renderWorkDetail(kind, number){
  root.append(local('← All recent work','/work','source-link'));
  const issues=snapshot.work?.issues||[],pulls=snapshot.work?.pulls||[];
  const isIssue=kind==='issue',source=isIssue?issues:pulls;
  const sourceState=isIssue?snapshot.work?.issues_status:snapshot.work?.pulls_status;
  const item=sourceState==='available'&&source.find(x=>x.number===number);
  if(!item){
    root.append(empty('Evidence unavailable in this bounded snapshot',
      'The requested '+(isIssue?'Issue':'PR')+' is not among the recent public records. This is not evidence that it does not exist or was accepted.'));
    return;
  }
  root.append(pageHead(isIssue?'ISSUE EVIDENCE':'PR EVIDENCE',
    '#'+item.number+' · '+item.title,
    'Public source observations only · updated '+date(item.updated_at)+
    ' · site snapshot '+date(snapshot.generated_at)));
  const origin=section('CANONICAL SOURCE','GitHub record','Open authoritative source for the current state.');
  const header=node('article','panel');
  attach(header,ext((isIssue?'Issue':'PR')+' #'+number+' · '+item.state+' ↗',item.url),
    node('p','', 'This record is sampled from a bounded build-time GitHub snapshot. Owner, stage and SC approval are not inferred.'));
  origin.append(header);root.append(origin);
  if(isIssue){
    const rel=section('ISSUE REFERENCES','PR mentions only',
      'A GitHub cross-reference is NOT verified implementing PR ownership or Agent causality.');
    const pane=node('article','panel');
    const refs=item.pr_references,linked=refs?.prs||[];
    if(refs?.status==='unavailable')pane.append(node('p','', 'Timeline source unavailable'));
    else{
      if(!linked.length)pane.append(node('p','', 'No PR mention observed in the bounded Timeline window.'));
      for(const ref of linked)pane.append(ext('GitHub cross-reference · PR #'+ref.number+' ↗',ref.url));
      if(refs?.status==='truncated')pane.append(node('p','', 'Timeline truncated · references may be missing.'));
    }
    pane.append(node('p','', 'Implementation relationship: Unknown / Unlinked'));
    rel.append(pane);root.append(rel);
    const runs=section('METRICS SOURCE','Observed Agent Runs',
      'Canonical workflow Run/Attempt is independent of implementing PR/SC Acceptance.');
    const observations=node('article','panel');
    const sourceState=snapshot.work?.agent_run_source;
    if(sourceState==='unavailable')observations.append(node('p','', 'Source unavailable · do not infer zero Agent runs.'));
    else if(!item.agent_runs?.length)observations.append(node('p','', 'No Agent Run observed in the bounded window.'));
    for(const run of item.agent_runs||[]){
      const block=node('div','issue-pr-evidence');
      block.append(ext('Run '+run.run_id+' / attempt '+run.attempt+' ↗',run.url));
      block.append(node('span','',
        'Role '+(run.role||'Unknown')+' · Agent '+(run.agent_id||'Unknown')+
        ' · Provider '+(run.provider||'Unknown')+' · workflow '+run.github_workflow));
      block.append(node('span','mono','Target SHA '+(run.target_sha||'Unknown')+
        ' · '+(run.verification==='github_run_verified'?'Run identity verified':'Not independently verified')));
      block.append(node('span','',
        'Tokens '+fmt(run.tokens_total)+' · duration '+fmt(run.duration_ms)+'ms · PR linkage: Unlinked'));
      observations.append(block);
    }
    if(sourceState==='truncated')observations.append(node('p','',
      'Source truncated · more runs may exist beyond the sampled window.'));
    runs.append(observations);root.append(runs);
  }else{
    const head=item.workflow?.head_sha;
    const proof=section('EXACT HEAD','Workflow and Review evidence',
      'Only observed PR HEAD runs/events at the recorded SHA. No overall approval, SC verdict or implementation attribution.');
    const pane=node('article','panel');
    pane.append(node('p','mono', 'Observed HEAD: '+(head||'Unavailable')));
    for(const [key,label] of [['ci','Quality'],['e2e','E2E']]){
      const run=item.workflow?.[key];
      pane.append(run?ext(label+' · '+run.status+
          ' · Run '+run.run_id+' / attempt '+run.attempt+' ↗',run.url)
        :node('p','',label+': Not observed in sampled Actions window'));
    }
    const reviews=item.review||{};
    if(reviews.latest)pane.append(ext('Review event '+reviews.latest.state.replaceAll('_',' ')+
       ' · HEAD '+reviews.latest.commit_sha+' · review '+reviews.latest.review_id+' ↗',reviews.latest.url));
    else pane.append(node('p','',reviews.status==='unavailable'
      ? 'Review source unavailable':'No same-HEAD Review observed'));
    if(reviews.status==='truncated')pane.append(node('p','',
      'Review source truncated · additional reviews may exist.'));
    pane.append(node('p','', 'Issue implementation/Agent Slice: Unknown / Unlinked'));
    pane.append(node('p','', 'Acceptance SC verdict: Not independently observed here.'));
    proof.append(pane);root.append(proof);
  }
  root.append(node('div','callout',
    'No unverified Issue → implementing PR → Agent/Slice causality or orphan-store integrity is presented as established.'));
}
function renderRepository(){
  root.append(pageHead('ENGINEERING SIGNALS','Built in the open.','Repository health and engineering throughput come from the existing canonical metrics pipeline. Measured SHA and age remain visible.'));
  const r=snapshot.repository||{}, c=r.current||{}, e=r.efficiency||{};
  root.append(node('p','hint','Repository metrics source: '+(r.freshness?.state||'unavailable')+' · measured '+date(r.generated_at)+' · site built '+date(snapshot.generated_at)));

  const a=section('REPOSITORY METRICS','Structure and quality','Current measured main revision · '+(r.sha?r.sha.slice(0,12):'unavailable'));
  a.append(grid([metric('Tracked source lines',fmt(c.loc),fmt(c.files)+' files'),
    metric('Tests discovered',fmt(c.tests),'unit / integration / E2E'),
    metric('Rust coverage',pct(c.rust_coverage),'line-weighted coverage'),
    metric('Web coverage',pct(c.web_coverage),'measured source, not Pages'),
    metric('Protocol units',fmt(c.protocol_units),'canonical catalog'),
    metric('Unit test pass',pct(c.unit_pass),'excludes skipped')],'three'));root.append(a);
  const b=section('ENGINEERING EFFICIENCY','Flow and throughput','Rolling 7 days · window bound to metrics generation.');
  b.append(grid([metric('Commits',fmt(e.commits_7d),'last 7 days'),metric('Code additions',fmt(e.additions_7d),'lines · last 7 days'),
    metric('Code deletions',fmt(e.deletions_7d),'lines · last 7 days'),
    metric('Merged PRs',fmt(e.merged_7d),'last 7 days')],'four'));root.append(b);
  const proof=section('SOURCE','The measurements','Measurements are published outside main to avoid committing changing counters.');
  const box=node('div','panel');attach(box,node('p','', 'Snapshot: '+date(r.generated_at)+' · commit: '+(r.sha||'unavailable')),
    ext('Open the canonical metrics branch  ↗','https://github.com/BestNathan/nession/tree/metrics'));proof.append(box);root.append(proof);
}
function renderEvidence(){
  root.append(pageHead('TRUST AND RECORDS','Evidence, not claims.','Run Stores keep the records behind engineering activity. Their existence does not prove append-only protection or independent integrity attestation.'));
  const sectionEl=section('ORPHAN RUN STORES','Where evidence lives','Branch availability reflects a bounded read; integrity is a separate, stricter guarantee.');
  sectionEl.append(grid((snapshot.evidence?.stores||[]).map(s=>{
    const c=node('article','source-card');attach(c,node('div','eyebrow',s.name),
      node('strong','',s.purpose),node('p','',s.state==='present'?'Ref observed':'Ref not verified / unavailable'),
      node('p','', 'Integrity: not independently verified by this public site'));
    if(s.state==='present')c.append(ext('View public branch  ↗',s.url));return c;
  }),'two'));root.append(sectionEl);
  const caveat=section('PROVENANCE','Trust has boundaries','View the canonical requirements for writer authorization and integrity audits.');
  const p=node('div','panel');attach(p,node('p','', 'The current Pages build only shows branch metadata. Immutable records, authorized writers and signed independent anchors require their own live server-side evidence. This site never claims an audit passed merely because a ref exists.'),
    node('div','divider'),ext('Run Store governance — Issue #1690  ↗','https://github.com/BestNathan/nession/issues/1690'));caveat.append(p);root.append(caveat);
}
function render(){
  const raw=location.hash.replace(/^#/,'')||'/';
  const match=raw.match(/^\/work\/(issue|pr)\/([1-9][0-9]{0,8})$/);
  const detail=raw.startsWith('/work/')&&!routes.has(raw);
  const route=match?'/work':routes.has(raw)?raw:detail?'/work':raw==='/'
    ?'/':'/missing';
  document.querySelectorAll('[data-route]').forEach(link=>{
    if(link.dataset.route===route)link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
  root.replaceChildren();
  try {
    if(match)renderWorkDetail(match[1],Number(match[2]));
    else if(detail) {
      root.append(local('← All recent work','/work'));
      root.append(empty('Invalid evidence reference',
        'This address does not identify a bounded public Issue or PR. No source has been verified.'));
    }else if(route==='/missing')root.append(empty('Route unavailable','The requested public page does not exist.'));
    else ({'/':renderHome,'/agents':renderAgents,'/work':renderWork,'/repository':renderRepository,'/evidence':renderEvidence}[route])();
    document.title=(detail?'Evidence':route==='/'?'Overview':route==='/missing'?'Unavailable':route.slice(1).replace(/^\w/, x=>x.toUpperCase()))+' — Nession';
  } catch(error){
    console.error('Pages render failure',error);
    root.append(node('p','failure','The public snapshot could not be rendered. See the source repository for authoritative information.'));
  }
}
async function init(){
  try{
    const response=await fetch(new URL('data/site.json',document.baseURI),{cache:'no-cache'});
    if(!response.ok)throw new Error('snapshot unavailable');
    const parsed=await response.json();
    if(parsed.schema_version!==1||!parsed.source)throw new Error('invalid schema');
    snapshot=parsed;
    freshness.textContent='Generated '+date(parsed.generated_at)+' · public snapshot, not live presence';
    window.addEventListener('hashchange',render);
    render();
  } catch(error) {
    root.replaceChildren(node('p','failure','Engineering data is temporarily unavailable. View the authoritative GitHub repository for current activity.'));
    freshness.textContent='Snapshot unavailable';
  }
}
init();
