/* Nession Git / GitHub #1290: deterministic public-safe interactive mock. No API calls. */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S = {surface:'terminal',context:false,section:'repository',tab:'changes',ghTab:'issues',scenario:'healthy',remote:'upstream',scope:'branch',filter:'open',search:'',detail:null,refresh:1,other:null,inspector:false,events:['Prototype ready · local fixture only']};
const files=[
{name:'web/src/capabilities/git/GitPlugin.ts',status:'M',meta:'+42 −17',diff:['@@ -112,7 +112,9 @@','-  return git.status(session);','+  const context = resolveRepositoryContext(session);','+  return git.status(context);']},
{name:'crates/nession-git/src/runtime/remote.rs',status:'A',meta:'+128',diff:['@@ -0,0 +1,3 @@','+pub fn discover_remotes(root: &Path) -> Result<Vec<Remote>> {','+  // typed remote fixture','+}']},
{name:'web/src/capabilities/git/components/GitWorkspace.tsx',status:'M',meta:'+83 −24',diff:['@@ -131,5 +131,5 @@','-type GitSection = "changes" | "history";','+type GitSection = "repository" | "github";']},
{name:'docs/design/workspace.md',status:'M',meta:'+14 −2',diff:['@@ -42,2 +42,3 @@','- Git contributes current changes.','+ Git contributes repository and hosting context.']}
];
const issues=[
{n:1290,title:'Extend Git capability with GitHub context',author:'maintainer',tags:['enhancement','git'],updated:'2h ago',state:'open',sub:'Repository identity · typed provider · Actions'},
{n:2469,title:'Define Agent Session ownership boundary',author:'contributor',tags:['architecture'],updated:'Yesterday',state:'open',sub:'Session context and recovery'},
{n:2254,title:'Text-native interactive AI components',author:'maintainer',tags:['design'],updated:'2d ago',state:'open',sub:'Provider-neutral conversation rendering'},
{n:1009,title:'Git commit detail and pageable history',author:'contributor',tags:['git'],updated:'Sep 26',state:'closed',sub:'Readable commit history and details'}
];
const prs=[
{n:2534,title:'feat: typed GitHub provider boundary',author:'contributor',head:'upstream:feature/git-context',base:'main',draft:false,updated:'1h ago',state:'open',branch:true},
{n:2522,title:'perf: reduce CI dependency provisioning',author:'maintainer',head:'upstream:ci-cache',base:'main',draft:false,updated:'Yesterday',state:'open'},
{n:2518,title:'feat: prototype publication event bridge',author:'maintainer',head:'fork:prototype-publishing',base:'main',draft:true,updated:'2d ago',state:'open'},
{n:1008,title:'feat: git history and commit detail',author:'contributor',head:'upstream:history',base:'main',draft:false,updated:'Sep 25',state:'closed'}
];
const workflows=[
{name:'Quality / Focused',file:'ci-quality.yml',enabled:true,branch:'feature/git-context',status:'completed',conclusion:'success',when:'6m ago',sha:'a41b8c7',event:'pull_request'},
{name:'E2E / Full Regression',file:'e2e-full-regression.yml',enabled:true,branch:'main',status:'completed',conclusion:'success',when:'4h ago',sha:'7ea9180',event:'workflow_dispatch'},
{name:'Acceptance / Cases',file:'acceptance-cases.yml',enabled:true,branch:'feature/git-context',status:'in_progress',conclusion:null,when:'now',sha:'a41b8c7',event:'pull_request'},
{name:'Legacy Preview',file:'legacy-preview.yml',enabled:false,branch:null,status:null,conclusion:null,when:'Never',sha:'—',event:'—'}
];
const scenarios={healthy:['Connected','GitHub available'],ambiguous:['Multiple remotes','Choose a trusted remote'],noRemote:['No GitHub remote','Local repository still available'],auth:['Sign in required','Agent API identity unavailable'],denied:['Access denied','Private repository forbidden'],rate:['Rate limited','Retry later'],offline:['Network unavailable','Local repository still available'],empty:['Empty repository','Zero Issues / PRs'],noRuns:['Never executed','Workflows have no runs']};
const names={changes:'Changes',history:'History',branches:'Branches',worktrees:'Worktrees',issues:'Issues',prs:'Pull Requests',actions:'Actions'};
function log(message){S.events.unshift(message);S.events=S.events.slice(0,14)}
function reset(){Object.assign(S,{surface:'terminal',context:false,section:'repository',tab:'changes',ghTab:'issues',scenario:'healthy',remote:'upstream',scope:'branch',filter:'open',search:'',detail:null,refresh:1,other:null,inspector:false,events:['Reset to initial Session']});render()}
function isError(){return !['healthy','empty','noRuns'].includes(S.scenario)}
function repoIdentity(){return S.remote==='fork'?'demo-fork/nession':'demo-org/nession'}
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
option('upstream','upstream · demo-org',S.remote==='upstream')+option('fork','origin · demo-fork',S.remote==='fork')+'</select></label></div>';
}
function ghList(){
if(isError())return ghState();
if(S.ghTab==='issues'){
let arr=S.scenario==='empty'?[]:issues.filter(x=>(S.filter==='all'||x.state===S.filter)&&(!S.search||('#'+x.n+' '+x.title).toLowerCase().includes(S.search.toLowerCase())));
return '<div class="tools-row"><label>State <select data-select="filter" aria-label="Issue state filter">'+['open','closed','all'].map(x=>option(x,x[0].toUpperCase()+x.slice(1),S.filter===x)).join('')+'</select></label><input aria-label="Search issues" data-input="search" placeholder="Search issues…" value="'+esc(S.search)+'"></div>'+
(arr.length?'<div class="split"><div class="list-panel">'+arr.map(x=>row('#'+x.n+'  '+x.title,x.author+' · '+x.updated+' · '+x.state,x.tags.map(t=>'<span class="small-tag">'+esc(t)+'</span>').join(''),'select-gh','issue-'+x.n,S.detail==='issue-'+x.n)).join('')+'</div>'+
'<div class="detail-panel">'+detailGh('issues',arr)+'</div></div>':empty('No matching issues','This is an empty result, not an API failure.'));
}
if(S.ghTab==='prs'){
let arr=S.scenario==='empty'?[]:prs.filter(x=>(S.filter==='all'||x.state===S.filter)&&(!S.search||('#'+x.n+' '+x.title).toLowerCase().includes(S.search.toLowerCase())));
return '<div class="tools-row"><label>State <select data-select="filter" aria-label="Pull request state filter">'+['open','closed','all'].map(x=>option(x,x[0].toUpperCase()+x.slice(1),S.filter===x)).join('')+'</select></label><input aria-label="Search PRs" data-input="search" placeholder="Search pull requests…" value="'+esc(S.search)+'"></div>'+
'<div class="branch-note"><span class="dot green"></span> Current branch: feature/git-context <b>→</b> '+(S.remote==='fork'?'No matching PR for selected fork':'Matched PR #2534 by head repository + branch')+'</div>'+
(arr.length?'<div class="split"><div class="list-panel">'+arr.map(x=>row('#'+x.n+'  '+x.title,x.head+' → '+x.base+' · '+x.updated,(x.draft?'<span class="small-tag">Draft</span>':'')+(x.branch&&S.remote==='upstream'?'<span class="small-tag selected-tag">Current branch</span>':''),'select-gh','pr-'+x.n,S.detail==='pr-'+x.n)).join('')+'</div><div class="detail-panel">'+detailGh('prs',arr)+'</div></div>':empty('No matching pull requests','No open PR is a healthy state.'));
}
return actionsView();
}
function detailGh(type,arr){
const id=S.detail;let d=arr.find(x=>(type==='issues'?'issue-':'pr-')+x.n===id)||arr[0];
if(!d)return empty('Select a record','Choose a row to inspect its details.');
return '<div class="detail-head"><span class="eyebrow">'+(type==='issues'?'ISSUE DETAIL':'PULL REQUEST DETAIL')+' / MOCK</span><strong>#'+d.n+' · '+esc(d.title)+'</strong></div>'+
'<div class="detail-copy"><div class="detail-kv"><span>State</span><strong>'+esc(d.state)+'</strong></div><div class="detail-kv"><span>Author</span><strong>'+esc(d.author)+'</strong></div>'+
(type==='prs'?'<div class="detail-kv"><span>Head</span><strong>'+esc(d.head)+'</strong></div><div class="detail-kv"><span>Base</span><strong>'+esc(d.base)+'</strong></div>':'<div class="detail-kv"><span>Updated</span><strong>'+esc(d.updated)+'</strong></div>')+
'<p class="detail-narrative">Demonstration fixture only. Production will open a verified external GitHub URL for this resource, with no write actions.</p></div>';
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
(S.inspector?'<div class="inspector"><div><strong>UI state</strong><pre>'+esc(JSON.stringify({surface:S.surface,context:S.context,section:S.section,tab:S.section==='github'?S.ghTab:S.tab,scenario:S.scenario,remote:S.remote,scope:S.scope,selected:S.detail},null,2))+'</pre></div><div><strong>Recent actions</strong><ol>'+S.events.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ol></div></div>':'');
}
function render(){
$('app').innerHTML=chrome()+'<main class="app-stage">'+(S.surface==='terminal'?terminal()+terminalCapsule():workspace()+footerCapsule())+'</main>'+fixtureBar();
}
function chooseGit(){S.surface='workspace';S.context=false;S.other=null;S.section='repository';S.detail=null;log('Git selected → directly opened Git Workspace; no Peek');render();}
document.addEventListener('click', e=>{
let el=e.target.closest('[data-action]');if(!el)return;let a=el.dataset.action,v=el.dataset.value;
switch(a){
case 'toggle-context':S.context=!S.context;log('Terminal Capsule context '+(S.context?'opened':'closed'));break;
case 'choose-git':case 'open-git':chooseGit();return;
case 'open-workspace':S.surface='workspace';S.context=false;S.other=null;log('Opened Workspace via destination circle');break;
case 'back-terminal':S.surface='terminal';S.context=false;log('Returned to same Session Terminal');break;
case 'choose-other':case 'workspace-cap':if(v==='Git'){chooseGit();return;}S.surface='workspace';S.other=v;S.context=false;log('Selected capability '+v);break;
case 'section':S.section=v;S.search='';S.detail=null;log('Git section '+v);break;
case 'local-tab':S.tab=v;S.search='';S.detail=null;log('Local Git '+v);break;
case 'github-tab':S.ghTab=v;S.search='';S.filter='open';S.detail=null;log('GitHub view '+v);break;
case 'to-local':S.section='repository';S.detail=null;log('Returned to Local Repository');break;
case 'resolve-ambiguity':S.remote=v;S.scenario='healthy';S.section='github';log('Resolved remote from Agent-discovered choices: '+v);break;
case 'scope':S.scope=v;S.detail=null;log('Actions latest scope '+v);break;
case 'select-file':case 'select-gh':case 'select-branch':case 'select-worktree':case 'select-history':S.detail=v;log('Selected '+v);break;
case 'refresh':S.refresh++;log('Simulated refresh #'+S.refresh+' · no network calls');break;
case 'inspector':S.inspector=!S.inspector;break;
case 'reset':reset();return;
default:return;
}
render();
});
document.addEventListener('change',e=>{
const el=e.target;
if(el.dataset.select==='scenario'){S.scenario=el.value;S.remote='upstream';S.section=el.value==='healthy'?'github':S.section;S.ghTab='issues';S.detail=null;S.filter='open';S.search='';log('Fixture scenario: '+el.value);render()}
if(el.dataset.select==='remote'){S.remote=el.value;S.detail=null;log('Selected discovered remote '+el.value);render()}
if(el.dataset.select==='filter'){S.filter=el.value;S.detail=null;log('Filter '+el.value);render()}
});
document.addEventListener('input',e=>{if(e.target.dataset.input==='search'){const pos=e.target.selectionStart;const hadFocus=true;S.search=e.target.value;render();const target=document.querySelector('[data-input="search"]');if(target&&hadFocus){target.focus();target.setSelectionRange(pos,pos)}}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(S.inspector)S.inspector=false;else if(S.context)S.context=false;else if(S.surface==='workspace')S.surface='terminal';render()}});
render();
})();