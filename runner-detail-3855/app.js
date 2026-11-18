(() => {
'use strict';
const root=document.getElementById('runner'),review=document.getElementById('review'),toast=document.getElementById('toast'),dialog=document.getElementById('confirm');
const s={mode:'web',page:'runner',tab:'overview',detail:'steps',fixture:'busy',job:'a',step:0,filter:'all',query:'',service:'running'};
const jobs=[
{id:'a',workflow:'Deploy / ACR Mirror',name:'mirror',run:'4821',attempt:1,time:'12:41',duration:'1m 52s',status:'Running',steps:[['Set up job','4s'],['Checkout','12s'],['Verify prerequisites','7s'],['Copy selected OCI images','1m 29s'],['Upload artifact','—']]},
{id:'b',workflow:'CI / Quality Gate',name:'web-tests',run:'4818',attempt:1,time:'10:36',duration:'3m 48s',status:'Success',steps:[['Set up job','5s'],['Checkout','12s'],['Run web tests','3m 31s']]},
{id:'c',workflow:'Acceptance / Cases',name:'browser-check',run:'4792',attempt:2,time:'Yesterday',duration:'2m 14s',status:'Failed',steps:[['Set up job','5s'],['Checkout','8s'],['Browser case failed','2m 1s']]}
];
const lines=['12:41:03  Job received by Runner','12:41:08  Preparing workspace','12:41:21  regctl version verified','12:41:35  Copying OCI image layers','12:42:04  linux/amd64 manifest transferred','12:42:45  Waiting for linux/arm64','12:42:55  No completion event yet'];
const esc=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function btn(label,action,cls){return '<button type="button" class="'+(cls||'button')+'" data-action="'+action+'">'+label+'</button>';}
function notice(v){toast.hidden=!v;toast.textContent=v||'';}
function head(title,sub,end){return '<div class="headrow"><div><div class="eyebrow">Agent · macbook-pro</div><h2>'+title+'</h2><p>'+sub+'</p></div><div class="head-actions">'+(end||'')+'</div></div>';}
function back(){if(s.page==='job'){s.page='runner';s.tab='jobs';}else if(s.page==='runner'){s.page='agent';}else if(s.page==='agent'){s.page='terminal';}else{s.page='agent';}}
function overview(){
const unavailable=s.fixture==='offline',partial=s.fixture==='partial',idle=s.fixture==='idle';
const values=unavailable?['—','—','—','—']:idle?['2%','164 MiB','0 B/s','12.4 GB']:partial?['28%','1.6 GiB','—','12.4 GB']:['28%','1.6 GiB','24 MB/s','12.4 GB'];
const names=['CPU','Memory (RSS)','Disk I/O','Runner work dir'];
let cards='<div class="metric-grid">'+values.map((v,i)=>'<div class="metric"><small>'+names[i]+'</small><strong>'+v+'</strong><span>'+['Observed group','Listener + workers','Read / write','Owned directory'][i]+'</span><div class="bar"><i style="width:'+(v==='—'?0:28+i*8)+'%"></i></div></div>').join('')+'</div>';
const status=unavailable?'Local process sample unavailable':partial?'Partial metrics · I/O unsupported':'Snapshot 12:42:56 · Partial process-tree attribution';
const active=['busy','partial','error'].includes(s.fixture);
return cards+'<p class="footnote">'+status+' · No per-Job CPU attribution.</p><div class="section"><div class="section-header"><h3>Current Job</h3>'+btn('All Jobs ›','jobs','quiet')+'</div>'+
(active?'<div class="sheet"><strong>'+jobs[0].workflow+'</strong><p class="footnote">mirror · Run #4821 · Running</p>'+btn('View Job','open-a')+'</div>':'<div class="sheet"><div class="empty"><strong>No active Job</strong>Runner is not executing a GitHub Job.</div></div>')+'</div>'+
'<details><summary>Observed Runner processes</summary><pre class="tree">'+(unavailable?'No local process snapshot':'Runner.Listener\n └ Runner.Worker\n    └ bash\n       └ regctl')+'</pre><p class="footnote">Verified descendants only; detached tasks may be absent.</p></details>';
}
function jobsView(){
if(s.fixture==='error')return '<div class="sheet"><strong>Jobs unavailable</strong><p class="footnote">GitHub API request failed; history is not known to be empty.</p>'+btn('Retry','retry')+'</div>';
let list=s.fixture==='idle'?[]:s.fixture==='offline'?jobs.slice(1):jobs;
if(s.filter==='running')list=list.filter(j=>j.status==='Running');
if(s.filter==='finished')list=list.filter(j=>j.status!=='Running');
const filter='<select class="select" aria-label="Filter Job history" data-filter><option value="all"'+(s.filter==='all'?' selected':'')+'>All statuses</option><option value="running"'+(s.filter==='running'?' selected':'')+'>Running</option><option value="finished"'+(s.filter==='finished'?' selected':'')+'>Completed</option></select>';
const rows=list.map(j=>'<button type="button" class="item" data-action="open-'+j.id+'"><span><strong>'+esc(j.workflow)+'</strong><small>'+esc(j.name)+' · Run #'+j.run+' · attempt '+j.attempt+' · '+j.time+'</small></span><span class="end"><span class="duration">'+j.duration+'</span><span class="status '+(j.status==='Failed'?'error':'')+'">'+j.status+'</span><span class="chevron">›</span></span></button>').join('');
return '<div class="section-header"><h3>Recent Jobs</h3>'+filter+'</div>'+(rows||'<div class="empty"><strong>No matching Jobs</strong>Nothing observed in this bounded window.</div>')+'<p class="footnote">Observed history only · bounded GitHub Run → Jobs lookup · older Jobs may be missing.</p>';
}
function settings(){const rows=[['Repository','BestNathan/nession'],['Runner ID','2842 (fixture)'],['Platform','macOS / ARM64'],['Labels','self-hosted, macOS, ARM64, hs-mac'],['Version','Official Runner (fixture)'],['Working directory','~/.nession/agent/runners/hs-mac'],['Local service',s.service]];
return rows.map(r=>'<div class="settings-row"><span>'+esc(r[0])+'</span><strong>'+esc(r[1])+'</strong></div>').join('')+'<div class="section">'+btn('Restart','restart')+' '+btn(s.service==='running'?'Stop':'Start','stop')+' '+btn('Unregister','remove','button danger')+'</div><p class="footnote">All actions are simulated. GitHub owns Job scheduling.</p>';}
function runnerView(){
const state=s.fixture==='offline'?'Offline':s.fixture==='idle'?'Idle':'Busy';
return '<button class="back" type="button" data-action="agent">‹ Agent / Runners</button>'+head('hs-mac','BestNathan/nession · macOS ARM64 · Local service '+s.service,'<span class="status '+(state==='Offline'?'warn':'')+'">'+state+'</span> '+btn('Refresh','retry'))+
'<div class="tabs" role="tablist">'+['overview','jobs','settings'].map(t=>'<button role="tab" type="button" data-tab="'+t+'" aria-selected="'+(s.tab===t)+'">'+t[0].toUpperCase()+t.slice(1)+'</button>').join('')+'</div>'+(s.tab==='overview'?overview():s.tab==='jobs'?jobsView():settings());
}
function jobView(){
const j=jobs.find(v=>v.id===s.job)||jobs[0];
let body='';
if(s.detail==='steps') body=j.steps.map((step,i)=>'<button type="button" class="item" data-action="step-'+i+'"><span><strong>'+esc(step[0])+'</strong><small>Step '+(i+1)+'</small></span><span class="end"><span class="duration">'+step[1]+'</span><span class="chevron">›</span></span></button>').join('');
else if(s.fixture==='error')body='<div class="sheet"><strong>Logs unavailable</strong><p class="footnote">GitHub logs could not be retrieved.</p>'+btn('Retry','retry')+'</div>';
else{
const step=j.steps[s.step],pending=step[1]==='—';
const selected=pending?[]:(j.id==='c'?['10:42:51  Error: browser timeout','10:43:16  Process exited 1']:lines);
const shown=selected.filter(l=>l.toLowerCase().includes(s.query.toLowerCase()));
body='<div class="log-control"><label for="step-select">Step</label><select id="step-select" class="select" data-step>'+j.steps.map((v,i)=>'<option value="'+i+'"'+(i===s.step?' selected':'')+'>'+esc(v[0])+'</option>').join('')+'</select></div><div class="log-control"><input data-search class="search" aria-label="Search loaded logs" placeholder="Search loaded logs" value="'+esc(s.query)+'">'+btn('Copy','copy')+'<a class="button" href="https://github.com/BestNathan/nession/actions" target="_blank" rel="noopener noreferrer">GitHub</a></div><div class="log-box" role="region" tabindex="0" aria-label="Log output">'+(shown.length?shown.map(esc).join('\n'):pending?'No log output for a pending step.':'No matching log lines')+'</div><p class="footnote">'+shown.length+' of '+selected.length+' synthetic lines · On-demand snapshot, not a live stream.</p>';
}
return '<button type="button" class="back" data-action="back">‹ hs-mac / Jobs</button>'+head(esc(j.workflow),esc(j.name)+' · Run #'+j.run+' · attempt '+j.attempt,'<span class="status '+(j.status==='Failed'?'error':'')+'">'+j.status+'</span>')+'<div class="tabs" role="tablist"><button type="button" data-detail="steps" role="tab" aria-selected="'+(s.detail==='steps')+'">Steps</button><button type="button" data-detail="logs" role="tab" aria-selected="'+(s.detail==='logs')+'">Logs</button></div>'+body;
}
function agentView(){return head('Agent','macbook-pro · Connected','')+'<div class="section"><div class="section-header"><h3>Runners</h3>'+btn('Add Runner','register')+'</div><button type="button" class="item" data-action="runner"><span><strong>hs-mac</strong><small>BestNathan/nession · macOS ARM64</small></span><span class="end"><span class="status">'+(s.fixture==='offline'?'Offline':'Online')+'</span><span class="chevron">›</span></span></button></div><div class="section"><div class="section-header"><h3>Agent details</h3></div><div class="sheet">Connected · macOS ARM64</div></div>';}
function terminalView(){return head('Terminal','CI investigation','')+'<div class="sheet"><pre class="tree">~/nession $ git status --short\n~/nession $ ▋</pre>'+btn('Open Agent Workspace','agent')+'</div>';}
function render(){
root.dataset.mode=s.mode;
const title={runner:'hs-mac',job:'Job details',agent:'Agent',terminal:'Terminal'}[s.page];
document.getElementById('web-title').textContent=title;
document.getElementById('app-title').textContent=title;
const out=s.page==='runner'?runnerView():s.page==='job'?jobView():s.page==='agent'?agentView():terminalView();
for(const e of [document.getElementById('web-content'),document.getElementById('app-content')])e.innerHTML='<div class="page">'+out+'</div>';
document.getElementById('fixture-desc').textContent='Fixture: '+s.fixture+' · mock only';
review.querySelectorAll('[data-fixture]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.fixture===s.fixture)));
}
function ask(action){dialog.hidden=false;dialog.innerHTML='<div class="dialog" role="dialog" aria-modal="true"><h3>'+(action==='remove'?'Unregister hs-mac?':'Restart hs-mac?')+'</h3><p>This is a mock. No GitHub runner or local service will change.</p><div class="actions">'+btn('Cancel','cancel')+' '+btn('Confirm','confirm-'+action,'button danger')+'</div></div>';}
root.addEventListener('click',async e=>{
const b=e.target.closest('[data-action],[data-tab],[data-detail]');if(!b)return;
if(b.dataset.tab){s.tab=b.dataset.tab;render();return;}
if(b.dataset.detail){s.detail=b.dataset.detail;render();return;}
const a=b.dataset.action;notice('');
if(a==='back')back();else if(a==='agent'||a==='runner'||a==='terminal'){s.page=a;}
else if(a==='jobs')s.tab='jobs';
else if(a.startsWith('open-')){s.job=a.slice(5);s.page='job';s.step=0;s.detail='steps';s.query='';}
else if(a.startsWith('step-')){s.step=Number(a.slice(5));s.detail='logs';}
else if(a==='stop'){s.service=s.service==='running'?'stopped':'running';notice('Local service changed in mock only.');}
else if(a==='restart'||a==='remove'){ask(a);return;}
else if(a==='cancel'){dialog.hidden=true;dialog.innerHTML='';return;}
else if(a.startsWith('confirm-')){dialog.hidden=true;dialog.innerHTML='';notice('Confirmed in mock only. No real operation.');}
else if(a==='retry')notice('Synthetic snapshot refreshed. No API request.');
else if(a==='register')notice('Registration is covered by the parent Requirement, outside this detail prototype.');
else if(a==='copy'){try{await navigator.clipboard.writeText(lines.join('\n'));notice('Synthetic log text copied.');}catch(_){notice('Clipboard unavailable.');}}
render();
});
root.addEventListener('change',e=>{if(e.target.matches('[data-filter]'))s.filter=e.target.value;if(e.target.matches('[data-step]'))s.step=Number(e.target.value);render();});
root.addEventListener('input',e=>{if(!e.target.matches('[data-search]'))return;const pos=e.target.selectionStart;s.query=e.target.value;render();const input=(s.mode==='web'?document.getElementById('web-content'):document.getElementById('app-content')).querySelector('[data-search]');input.focus();input.setSelectionRange(pos,pos);});
review.addEventListener('click',e=>{const b=e.target.closest('[data-fixture]');if(!b)return;s.fixture=b.dataset.fixture;s.page='runner';s.tab='overview';s.query='';notice('');dialog.hidden=true;render();});
review.addEventListener('np:resize',e=>{s.mode=e.detail.width<=430?'app':'web';render();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!dialog.hidden){dialog.hidden=true;dialog.innerHTML='';}});
render();
})();