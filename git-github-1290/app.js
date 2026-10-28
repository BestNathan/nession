/* Nession Git / GitHub #1290: deterministic public-safe interactive mock. No API calls. */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S = {surface:'terminal',context:false,section:'repository',tab:'changes',ghTab:'issues',scenario:'healthy',remote:'upstream',scope:'branch',filter:'open',search:'',detail:null,refresh:1,other:null,inspector:false,reading:false,mobileDetail:false,events:['Prototype ready · local fixture only']};
const files=[
{name:'web/src/capabilities/git/GitPlugin.ts',status:'M',meta:'+42 −17',diff:['@@ -112,7 +112,9 @@','-  return git.status(session);','+  const context = resolveRepositoryContext(session);','+  return git.status(context);']},
{name:'crates/nession-git/src/runtime/remote.rs',status:'A',meta:'+128',diff:['@@ -0,0 +1,3 @@','+pub fn discover_remotes(root: &Path) -> Result<Vec<Remote>> {','+  // typed remote fixture','+}']},
{name:'web/src/capabilities/git/components/GitWorkspace.tsx',status:'M',meta:'+83 −24',diff:['@@ -131,5 +131,5 @@','-type GitSection = "changes" | "history";','+type GitSection = "repository" | "github";']},
{name:'docs/design/workspace.md',status:'M',meta:'+14 −2',diff:['@@ -42,2 +42,3 @@','- Git contributes current changes.','+ Git contributes repository and hosting context.']}
];
// Real repository snapshots, provided as a standalone offline fixture.
const issues=NESSION_GITHUB_SNAPSHOT.issues;
const prs=NESSION_GITHUB_SNAPSHOT.prs;
const workflows=[
{name:'Quality / Focused',file:'ci-quality.yml',enabled:true,branch:'feature/git-context',status:'completed',conclusion:'success',when:'6m ago',sha:'a41b8c7',event:'pull_request'},
{name:'E2E / Full Regression',file:'e2e-full-regression.yml',enabled:true,branch:'main',status:'completed',conclusion:'success',when:'4h ago',sha:'7ea9180',event:'workflow_dispatch'},
{name:'Acceptance / Cases',file:'acceptance-cases.yml',enabled:true,branch:'feature/git-context',status:'in_progress',conclusion:null,when:'now',sha:'a41b8c7',event:'pull_request'},
{name:'Legacy Preview',file:'legacy-preview.yml',enabled:false,branch:null,status:null,conclusion:null,when:'Never',sha:'—',event:'—'}
];
const scenarios={healthy:['Connected','GitHub available'],ambiguous:['Multiple remotes','Choose a trusted remote'],noRemote:['No GitHub remote','Local repository still available'],auth:['Sign in required','Agent API identity unavailable'],denied:['Access denied','Private repository forbidden'],rate:['Rate limited','Retry later'],offline:['Network unavailable','Local repository still available'],empty:['Empty repository','Zero Issues / PRs'],noRuns:['Never executed','Workflows have no runs']};
const names={changes:'Changes',history:'History',branches:'Branches',worktrees:'Worktrees',issues:'Issues',prs:'Pull Requests',actions:'Actions'};
function log(message){S.events.unshift(message);S.events=S.events.slice(0,14)}
function reset(){Object.assign(S,{surface:'terminal',context:false,section:'repository',tab:'changes',ghTab:'issues',scenario:'healthy',remote:'upstream',scope:'branch',filter:'open',search:'',detail:null,refresh:1,other:null,inspector:false,reading:false,mobileDetail:false,events:['Reset to initial Session']});render()}
function isError(){return !['healthy','empty','noRuns'].includes(S.scenario)}
function repoIdentity(){return S.remote==='fork'?'demo-fork/nession':'BestNathan/nession'}
function stateText(){return scenarios[S.scenario][0]}
function btn(label,action,cls='',extra=''){return '<button type="button" class="'+cls+'" data-action="'+action+'" '+extra+'>'+label+'</button>'}
function chrome(){
return '<header class="topbar"><div class="brand"><span class="nmark">n</span><strong>nession</strong><span class="slash">/</span><span class="brand-sub">design lab</span></div>'+
'<div class="toplinks"><span class="mock-flag">SIMULATED · NO NETWORK</span><a href="https://github.com/BestNathan/nession/issues/1290" target="_blank" rel="noopener">Issue #1290 ↗</a>'+
'<a href="https://github.com/BestNathan/nession/tree/prototype/git-github-1290" target="_blank" rel="noopener">Source ↗</a></div></header>';
}
function terminal(){
return '<div class="terminal" data-testid="terminal-surface"><div class="terminal-top"><span class="terminal-dot"></span><span>Session / nession-dev</span><span class="terminal-host">agent-01 · feature/git-context</span></div>'+
'<div class="term-lines"><div><span class="term-muted">14:28:02</span> <span class="term-green">●</span> attached to nession-dev</div>'+
'<div><span class="term-muted">14:28:06</span> <span class="term-green">●</span> workspace: /workspace/nession</div>'+
'<div class="term-gap"><span class="term-prompt">nession</span> <span class="term-muted">git status --short</span></div>'+
'<div> M web/src/capabilities/git/GitPlugin.ts</div><div> M web/src/capabilities/git/components/GitWorkspace.tsx</div>'+
'<div>?? crates/nession-git/src/runtime/remote.rs</div><div class="term-gap"><span class="term-prompt">❯</span> <span class="cursor">▌</span></div>'+
'<p class="terminal-hint">Select Git from the Capsule. It opens Git Workspace directly — no Peek.</p></div></div>';
}
function context(){
if(!S.context)return '';
return '<div class="context-bubble" data-testid="context-capsule"><div class="context-title">Capabilities <span>Current Session</span></div>'+
'<button data-action="choose-git" class="context-row"><span class="glyph">⑂</span><span><strong>Git</strong><small>Repository and GitHub context</small></span><b>↗</b></button>'+
'<button data-action="choose-other" data-value="Agent" class="context-row"><span class="glyph">◎</span><span><strong>Agent</strong><small>Connected · agent-01</small></span><b>›</b></button>'+
'<button data-action="choose-other" data-value="Files" class="context-row"><span class="glyph">▤</span><span><strong>Files</strong><small>Current workspace files</small></span><b>›</b></button>'+
'</div>';
}
function terminalCapsule(){
return '<div class="capsule-dock" data-testid="terminal-capsule">'+context()+
'<div class="capsule-row"><div class="composer">'+btn('+','toggle-context','plus','aria-label="Open capabilities" aria-expanded="'+S.context+'"')+
'<span class="composer-prompt">Ask Nession…</span><span class="send-icon">↑</span></div>'+
btn('◫','open-workspace','circle','aria-label="Open Workspace"')+'</div></div>';
}
function footerCapsule(){
const tabs=[['Files','▤'],['Agent','◎'],['Git','⑂'],['Claude Code','✳']];
return '<div class="capsule-dock workspace-dock" data-testid="workspace-capsule"><div class="capsule-row">'+
btn('‹','back-terminal','circle','aria-label="Back to Terminal"')+
'<div class="workspace-capsule">'+tabs.map(([x,g])=>btn('<span class="cap-ico">'+g+'</span><span>'+esc(x)+'</span>','workspace-cap','cap-item '+((S.other===x||(!S.other&&x==='Git'))?'chosen':''),'data-value="'+esc(x)+'"')).join('')+'</div></div></div>';
}
function option(value,label,selected){return '<option value="'+value+'" '+(selected?'selected':'')+'>'+esc(label)+'</option>'}
function topControls(){
return '<div class="workspace-top"><div class="crumb"><span>Workspace</span><span>›</span><strong>'+(S.other?esc(S.other):'Git')+'</strong></div>'+
'<div class="top-meta"><span class="dot green"></span> agent-01 <span class="divider">/</span> nession-dev</div></div>';
}
function altWorkspace(){
return '<section class="alt-workspace"><div class="alt-icon">◇</div><h1>'+esc(S.other)+'</h1><p>This prototype focuses on the Git capability. The Capsule remains functional; select Git to return to its complete interactive mock.</p>'+
btn('Open Git capability','choose-git','primary')+'</section>';
}
function header(){
return '<section class="workspace-heading"><div class="heading-main"><span class="eyebrow">CURRENT SESSION / REPOSITORY</span><h1>Git <span class="h1-soft">workspace</span></h1>'+
'<div class="repo-context"><span class="repo-icon">⑂</span><strong>nession</strong><span class="sep">/</span><span>feature/git-context</span>'+
'<span class="context-count">4 changed</span></div></div>'+
'<div class="heading-tools">'+btn('↻ <span>Refresh</span>','refresh','soft')+'</div></section>';
}
function sectionNav(){
return '<div class="section-nav" role="tablist" aria-label="Git source"><button role="tab" aria-selected="'+(S.section==='repository')+'" class="section-button '+(S.section==='repository'?'active':'')+'" data-action="section" data-value="repository"><span class="section-symbol">⌘</span><span><strong>Repository</strong><small>Local Git</small></span></button>'+
'<button role="tab" aria-selected="'+(S.section==='github')+'" class="section-button '+(S.section==='github'?'active':'')+'" data-action="section" data-value="github"><span class="section-symbol">◈</span><span><strong>GitHub</strong><small>Hosting context</small></span></button></div>';
}
function tabNav(tabs,active,act){return '<div class="tabs" role="tablist">'+tabs.map(x=>btn(esc(names[x]),act,'tab '+(active===x?'active':''),'role="tab" aria-selected="'+(active===x)+'" data-value="'+x+'"')).join('')+'</div>'}
function row(title,sub,tag,action,value,selected){
return '<button class="data-row '+(selected?'selected':'')+'" data-action="'+action+'" data-value="'+esc(value)+'"><span class="row-copy"><strong>'+esc(title)+'</strong><small>'+esc(sub)+'</small></span><span class="row-trail">'+tag+' <span class="row-arrow">›</span></span></button>';
}
function empty(title,detail){return '<div class="empty"><span class="empty-icon">◌</span><strong>'+esc(title)+'</strong><p>'+esc(detail)+'</p></div>'}
function localView(){
let content='';
if(S.tab==='changes'){
let visible=files.filter(x=>!S.search||x.name.toLowerCase().includes(S.search.toLowerCase()));
let focus=files.find(x=>x.name===S.detail)||files[0];
content='<div class="split"><div class="list-panel"><div class="list-head"><strong>Working tree</strong><span>4 files</span></div>'+
(visible.map(x=>row(x.name,'Working tree · '+x.meta,'<span class="file-status">'+x.status+'</span>','select-file',x.name,focus.name===x.name)).join('')||empty('No matching files','Try another search.'))+'</div>'+
'<div class="detail-panel"><div class="detail-head"><span class="eyebrow">DIFF PREVIEW · READ ONLY</span><strong>'+esc(focus.name)+'</strong></div>'+
'<pre class="diff">'+focus.diff.map(x=>'<span class="'+(x.startsWith('+')?'diff-add':x.startsWith('-')?'diff-del':'diff-meta')+'">'+esc(x)+'</span>').join('\n')+'</pre></div></div>';
}else if(S.tab==='history'){
content='<div class="list-panel">'+row('feat: GitHub repository context','a41b8c7 · 2 hours ago · contributor','<span class="small-tag">HEAD</span>','select-history','a41',S.detail==='a41')+
row('fix: repository resolver timeouts','35caa19 · Yesterday · maintainer','','select-history','35c',S.detail==='35c')+
row('docs: capability architecture','9b7ac11 · 3 days ago · contributor','','select-history','9b7',S.detail==='9b7')+'</div>';
}else if(S.tab==='branches'){
content='<div class="list-panel">'+row('feature/git-context','Current · 2 ahead / 0 behind','<span class="small-tag">CURRENT</span>','select-branch','feature/git-context',S.detail==='feature/git-context')+
row('main','Upstream base branch','','select-branch','main',S.detail==='main')+
row('release/next','Local tracking branch','','select-branch','release/next',S.detail==='release/next')+'</div>';
}else {
content='<div class="list-panel">'+row('/workspace/nession','feature/git-context · active Session','<span class="small-tag">ACTIVE</span>','select-worktree','active',S.detail==='active')+
row('/workspace/nession-release','release/next · linked worktree','','select-worktree','release',S.detail==='release')+'</div>';
}
return '<div class="panel-toolbar"><div class="panel-intro"><strong>Local repository</strong><small>From the active Session · read only</small></div><span class="local-state"><span class="dot green"></span> Available</span></div>'+
tabNav(['changes','history','branches','worktrees'],S.tab,'local-tab')+
(S.tab==='changes'?'<div class="tools-row"><input data-input="search" aria-label="Search changed files" placeholder="Filter changed files…" value="'+esc(S.search)+'"></div>':'')+
content;
}
function ghState(){
if(S.scenario==='healthy'||S.scenario==='empty'||S.scenario==='noRuns') return '';
const msgs={
ambiguous:['Multiple GitHub remotes','Both origin and upstream are available, and no authoritative default can be selected. Choose a discovered remote below.'],
noRemote:['No GitHub remote','This Session has a valid local repository but no recognized GitHub hosting remote. Local Git continues to work.'],
auth:['Authentication required','The Agent cannot access GitHub API with its current credentials. No anonymous fallback has been attempted.'],
denied:['Repository access denied','The selected Agent identity cannot read this private repository. No GitHub data is displayed.'],
rate:['GitHub rate limited','GitHub rejected further requests. Retry later or return to Local Repository.'],
offline:['Network unavailable','The Agent could not reach the trusted GitHub endpoint. Local repository data remains available.']
};
const info=msgs[S.scenario];return '<div class="state-panel" data-testid="github-unavailable"><span class="state-icon">!</span><div><strong>'+info[0]+'</strong><p>'+info[1]+'</p>'+
(S.scenario==='ambiguous'?'<div class="remote-row"><button class="soft" data-action="resolve-ambiguity" data-value="upstream">Use upstream / demo-org</button><button class="soft" data-action="resolve-ambiguity" data-value="fork">Use origin / demo-fork</button></div>':
'<div class="remote-row">'+btn('Return to local Git','to-local','soft')+(S.scenario==='rate'||S.scenario==='offline'?btn('Retry request','refresh','soft'):'')+'</div>')+
'</div></div>';
}
function ghToolbar(){
const available=!isError();
return '<div class="github-context"><div class="repo-host"><span class="host-symbol">◈</span><div><span class="eyebrow">GITHUB REPOSITORY</span><strong>'+esc(repoIdentity())+'</strong><small>github.com · read only</small></div></div>'+
'<label class="remote-label">Remote <select data-select="remote" aria-label="Select discovered Git remote" '+(!available?'disabled':'')+'>'+
option('upstream','upstream · BestNathan/nession',S.remote==='upstream')+option('fork','origin · demo-fork',S.remote==='fork')+'</select></label></div>';
}

function sourceLink(url,label){
  if(!/^https:\/\/github\.com\/BestNathan\/nession\/(issues|pull)\/\d+$/.test(url||''))return '';
  return '<a class="primary record-source" target="_blank" rel="noopener noreferrer" href="'+esc(url)+'">'+esc(label)+' ↗</a>';
}
function mdInline(raw){
  return esc(raw).replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>')
    .replace(/\[([^\]]{1,120})\]\((https:\/\/[^\s)]+)\)/g,(_x,label,url)=>'<a target="_blank" rel="noopener noreferrer" href="'+esc(url)+'">'+label+'</a>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
}
function renderMarkdown(raw){
  let code=false;let chunk=[];let list=null;const out=[];
  const close=()=>{if(list){out.push('</'+list+'>');list=null;}};
  for(const line of String(raw||'').split(/\r?\n/)){
    if(/^\s*\x60{3}/.test(line)){close();if(code){out.push('<pre class="md-code"><code>'+esc(chunk.join('\n'))+'</code></pre>');chunk=[]}code=!code;continue}
    if(code){chunk.push(line);continue}
    if(!line.trim()){close();continue}
    const h=/^(#{1,5})\s+(.+)/.exec(line);
    if(h){close();const level=Math.min(4,h[1].length+1);out.push('<h'+level+'>'+mdInline(h[2])+'</h'+level+'>');continue}
    const bullet=/^\s*[-*]\s+(.*)/.exec(line),order=/^\s*\d+[.)]\s+(.*)/.exec(line);
    if(bullet||order){const next=bullet?'ul':'ol';if(list!==next){close();out.push('<'+next+'>');list=next}
      let value=(bullet||order)[1];const ch=/^\[(x| )\]\s*/i.exec(value);
      if(ch){value=value.slice(ch[0].length);value='<span class="md-check">'+(ch[1].toLowerCase()==='x'?'☑':'☐')+'</span> '+mdInline(value)}
      else value=mdInline(value);
      out.push('<li>'+value+'</li>');continue;
    }
    close();
    if(/^\|.*\|/.test(line))out.push('<div class="md-table-line">'+mdInline(line)+'</div>');
    else if(/^>\s?/.test(line))out.push('<blockquote>'+mdInline(line.replace(/^>\s?/,''))+'</blockquote>');
    else if(/^[-_]{3,}$/.test(line.trim()))out.push('<hr>');
    else out.push('<p>'+mdInline(line)+'</p>');
  }
  close();if(code)out.push('<pre class="md-code"><code>'+esc(chunk.join('\n'))+'</code></pre>');
  return out.join('');
}
function recordStatus(x){return x.state==='merged'?'Merged':x.state==='closed'?'Closed':x.draft?'Draft':'Open'}
function recordRow(x,type,selected){
  const id=(type==='issues'?'issue-':'pr-')+x.n;
  const summary=String(x.body||'').split('\n').find(v=>v.trim()&&!/^\s*[#|]/.test(v))||'';
  return '<button type="button" data-testid="github-record" data-action="select-gh" data-value="'+esc(id)+'" aria-current="'+(selected===id)+'" class="gh-record '+(selected===id?'selected':'')+'">'+
    '<span class="gh-record-id">#'+x.n+' <span class="gh-record-status '+esc(x.state)+'">'+recordStatus(x)+'</span></span>'+
    '<strong class="gh-record-title">'+esc(x.title)+'</strong>'+
    '<span class="gh-record-preview">'+esc(summary.replace(/[\x2a\x60]/g,'').slice(0,120))+'</span>'+
    '<span class="gh-record-meta">'+esc(x.author)+' · '+esc(String(x.updated||'').slice(0,10))+'</span></button>';
}
function recordDetail(type,arr,id){
  const x=arr.find(v=>(type==='issues'?'issue-':'pr-')+v.n===id)||arr[0];
  if(!x)return empty('Nothing selected','Select a record');
  const metadata=type==='issues'
    ?[['Labels',(x.labels||[]).join(' · ')||'None'],['Comments at capture',x.comments||'0']]
    :[['Source branch',(x.headRepo||'unknown')+' : '+(x.head||'—')],['Target branch',x.base||'—'],['Changes',x.changedFiles+' files · +'+x.additions+' / −'+x.deletions]];
  return '<div class="gh-detail-content" data-testid="github-detail">'+
    '<div class="gh-detail-top">'+btn('← Back to list','back-gh-list','gh-back')+'<span class="gh-detail-crumb">'+(type==='issues'?'Issue':'Pull request')+' #'+x.n+'</span>'+btn(S.reading?'Show list':'Focus reading','toggle-reading','soft reader-toggle')+'</div>'+
    '<div class="gh-detail-heading"><div class="gh-detail-kicker"><span class="gh-record-status '+esc(x.state)+'">'+recordStatus(x)+'</span><span>REAL GITHUB SNAPSHOT · '+esc(NESSION_GITHUB_SNAPSHOT.source.capturedDate)+'</span></div>'+
    '<h2>'+esc(x.title)+'</h2><div class="gh-detail-byline">'+esc(x.author)+' · updated '+esc(x.updated||'')+'</div><div class="gh-detail-actions">'+sourceLink(x.url,'Open on GitHub')+'<span>Read only · saved snapshot</span></div></div>'+
    '<div class="gh-metadata"><div><span>Repository</span><strong>BestNathan/nession</strong></div>'+metadata.map(v=>'<div><span>'+esc(v[0])+'</span><strong>'+esc(v[1])+'</strong></div>').join('')+'</div>'+
    '<article class="gh-markdown" aria-label="Original GitHub description">'+renderMarkdown(x.body)+'</article>'+
    '<div class="gh-bottom"><span>End of recorded body · the live GitHub record can change</span>'+sourceLink(x.url,'View live record')+'</div></div>';
}
function githubRecordView(type,items){
  const shown=items.filter(x=>(S.filter==='all'||(S.filter==='closed'?['closed','merged'].includes(x.state):x.state==='open'))&&(!S.search||('#'+x.n+' '+x.title+' '+x.body).toLowerCase().includes(S.search.toLowerCase())));
  const id=shown.find(x=>(type==='issues'?'issue-':'pr-')+x.n===S.detail)?S.detail:(shown.length?(type==='issues'?'issue-':'pr-')+shown[0].n:null);
  const label=type==='issues'?'issues':'pull requests';
  const filters='<div class="tools-row gh-filters"><label>State <select data-select="filter" aria-label="'+label+' state filter">'+['open','closed','all'].map(x=>option(x,x[0].toUpperCase()+x.slice(1),S.filter===x)).join('')+'</select></label>'+
    '<input aria-label="Search '+label+'" data-input="search" placeholder="Search '+label+'…" value="'+esc(S.search)+'"></div>';
  if(!shown.length)return filters+empty('No matching '+label,'No records match this offline snapshot filter.');
  return filters+'<div class="gh-reader '+(S.mobileDetail?'mobile-detail-open ':'')+(S.reading?'is-reading':'')+'" data-testid="github-reader">'+
    '<aside class="gh-list" aria-label="'+label+' list" data-testid="github-list-pane"><div class="gh-list-heading"><strong>'+shown.length+' '+label+'</strong><span>Captured on '+esc(NESSION_GITHUB_SNAPSHOT.source.capturedDate)+'</span></div>'+shown.map(x=>recordRow(x,type,id)).join('')+'</aside>'+
    '<section class="gh-detail" aria-label="Selected GitHub details">'+recordDetail(type,shown,id)+'</section></div>';
}
function ghList(){
  if(isError())return ghState();
  if(S.remote==='fork')return '<div class="state-panel" data-testid="fork-snapshot-unavailable"><span class="state-icon">i</span><div><strong>Fork snapshot not captured</strong><p>Issue and PR content was captured from the real BestNathan/nession repository only. The origin fork is a mock choice with no authorized source data; it must not display upstream records under a different identity.</p>'+btn('Use BestNathan/nession upstream','resolve-ambiguity','soft','data-value="upstream"')+'</div></div>';
  if(S.scenario==='empty' && (S.ghTab==='issues'||S.ghTab==='prs'))return empty('No '+(S.ghTab==='issues'?'issues':'pull requests'),'This scenario is an intentional empty successful result.');

  if(S.ghTab==='issues')return githubRecordView('issues',issues);
  if(S.ghTab==='prs'){
    const exact=prs.find(x=>x.state==='open'&&x.head==='feature/git-context'&&x.headRepo==='BestNathan/nession'&&S.remote==='upstream');
    return '<div class="branch-note"><span class="dot"></span> Mock Session branch: feature/git-context · '+(exact?'Exact open PR #'+exact.n:'No open PR in snapshot matches both head repo and branch')+'</div>'+githubRecordView('prs',prs);
  }
  return '<div class="snapshot-disclaimer">Actions runs are simulated fixtures; only Issues and Pull Requests use recorded GitHub content.</div>'+actionsView();
}
function actionsView(){
let arr=workflows;
return '<div class="tools-row"><div class="scope-title">Latest run scope</div><div class="scope-switch">'+btn('Current branch','scope','scope '+(S.scope==='branch'?'active':''),'data-value="branch"')+btn('Repository','scope','scope '+(S.scope==='repo'?'active':''),'data-value="repo"')+'</div></div>'+
'<div class="scope-note">'+(S.scope==='branch'?'Only runs for feature/git-context qualify this view. A green main run is not current-branch success.':'Most recent run across all branches, labeled with its actual branch.')+'</div>'+
'<div class="list-panel">'+arr.map(x=>{
let match=S.scope==='repo'||x.branch==='feature/git-context',state=S.scenario==='noRuns'?'No runs yet':!x.enabled?'Disabled':!match?'No runs for current branch':x.status==='in_progress'?'Running':x.conclusion==='success'?'Success':'Failed';
return row(x.name,x.file+' · '+(match?x.when:'no matching branch run')+' · '+(S.scenario==='noRuns'?'not executed':esc(x.branch||'—')),'<span class="run-state '+(state==='Success'?'ok':state==='Running'?'working':'')+'">'+esc(state)+'</span>','select-gh','workflow-'+x.file,S.detail==='workflow-'+x.file);
}).join('')+'</div>'+
(S.detail&&S.detail.startsWith('workflow-')?'<div class="workflow-foot">Selected: '+esc(S.detail.slice(9))+' · Run details are read-only and mocked.</div>':'');
}
function githubView(){
return ghToolbar()+ (isError()?ghState():tabNav(['issues','prs','actions'],S.ghTab,'github-tab')+ghList());
}
function workspace(){
return '<div class="workspace" data-testid="workspace-surface">'+topControls()+(S.other?altWorkspace():header()+sectionNav()+
'<section class="content-card"><div class="card-content">'+(S.section==='repository'?localView():githubView())+'</div></section>')+
'<div class="work-bottom-space"></div></div>';
}
function fixtureBar(){
return '<div class="fixture-panel"><div class="fixture-name"><span class="fixture-indicator">◉</span><span><strong>Prototype controls</strong><small>Mock scenario / deterministic</small></span></div>'+
'<label>Scenario <select data-select="scenario" aria-label="Mock GitHub scenario">'+Object.keys(scenarios).map(x=>option(x,scenarios[x][0],S.scenario===x)).join('')+'</select></label>'+
btn('Reset','reset','soft small-btn')+
btn(S.inspector?'Hide state':'Inspect state','inspector','soft small-btn')+
'<span class="fixture-counter">Snapshot #'+S.refresh+'</span></div>'+
(S.inspector?'<div class="inspector"><div><strong>UI state</strong><pre>'+esc(JSON.stringify({surface:S.surface,context:S.context,section:S.section,tab:S.section==='github'?S.ghTab:S.tab,scenario:S.scenario,remote:S.remote,scope:S.scope,selected:S.detail,mobileDetail:S.mobileDetail,reading:S.reading},null,2))+'</pre></div><div><strong>Recent actions</strong><ol>'+S.events.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ol></div></div>':'');
}
function render(){
$('app').innerHTML=chrome()+'<main class="app-stage">'+(S.surface==='terminal'?terminal()+terminalCapsule():workspace()+footerCapsule())+'</main>'+fixtureBar();
}
function chooseGit(){S.surface='workspace';S.context=false;S.other=null;S.section='repository';S.detail=null;S.mobileDetail=false;S.reading=false;log('Git selected → directly opened Git Workspace; no Peek');render();}
document.addEventListener('click', e=>{
let el=e.target.closest('[data-action]');if(!el)return;let a=el.dataset.action,v=el.dataset.value;
switch(a){
case 'toggle-context':S.context=!S.context;log('Terminal Capsule context '+(S.context?'opened':'closed'));break;
case 'choose-git':case 'open-git':chooseGit();return;
case 'open-workspace':S.surface='workspace';S.context=false;S.other=null;log('Opened Workspace via destination circle');break;
case 'back-terminal':S.surface='terminal';S.context=false;log('Returned to same Session Terminal');break;
case 'choose-other':case 'workspace-cap':if(v==='Git'){chooseGit();return;}S.surface='workspace';S.other=v;S.context=false;log('Selected capability '+v);break;
case 'section':S.section=v;S.search='';S.detail=null;S.mobileDetail=false;S.reading=false;log('Git section '+v);break;
case 'local-tab':S.tab=v;S.search='';S.detail=null;log('Local Git '+v);break;
case 'github-tab':S.ghTab=v;S.search='';S.filter='open';S.detail=null;S.mobileDetail=false;S.reading=false;log('GitHub view '+v);break;
case 'to-local':S.section='repository';S.detail=null;S.mobileDetail=false;S.reading=false;log('Returned to Local Repository');break;
case 'resolve-ambiguity':S.remote=v;S.scenario='healthy';S.section='github';log('Resolved remote from Agent-discovered choices: '+v);break;
case 'scope':S.scope=v;S.detail=null;log('Actions latest scope '+v);break;
case 'select-gh':S.detail=v;S.mobileDetail=true;S.reading=false;log('Opened real GitHub snapshot '+v);break;
case 'back-gh-list':S.mobileDetail=false;log('Returned to GitHub list');break;
case 'toggle-reading':S.reading=!S.reading;log('Reading layout '+(S.reading?'focused':'split'));break;
case 'select-file':case 'select-branch':case 'select-worktree':case 'select-history':S.detail=v;log('Selected '+v);break;
case 'refresh':S.refresh++;log('Simulated refresh #'+S.refresh+' · no network calls');break;
case 'inspector':S.inspector=!S.inspector;break;
case 'reset':reset();return;
default:return;
}
render();
});
document.addEventListener('change',e=>{
const el=e.target;
if(el.dataset.select==='scenario'){S.scenario=el.value;S.remote='upstream';S.section=el.value==='healthy'?'github':S.section;S.ghTab='issues';S.detail=null;S.mobileDetail=false;S.reading=false;S.filter='open';S.search='';log('Fixture scenario: '+el.value);render()}
if(el.dataset.select==='remote'){S.remote=el.value;S.detail=null;S.mobileDetail=false;S.reading=false;log('Selected discovered remote '+el.value);render()}
if(el.dataset.select==='filter'){S.filter=el.value;S.detail=null;S.mobileDetail=false;S.reading=false;log('Filter '+el.value);render()}
});
document.addEventListener('input',e=>{if(e.target.dataset.input==='search'){const pos=e.target.selectionStart;const hadFocus=true;S.search=e.target.value;render();const target=document.querySelector('[data-input="search"]');if(target&&hadFocus){target.focus();target.setSelectionRange(pos,pos)}}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(S.inspector)S.inspector=false;else if(S.context)S.context=false;else if(S.mobileDetail)S.mobileDetail=false;else if(S.reading)S.reading=false;else if(S.surface==='workspace')S.surface='terminal';render()}});
render();
})();