(() => {
'use strict';
const root = document.getElementById('timer-product');
const webContent = document.getElementById('web-content');
const appContent = document.getElementById('app-content');
const overlay = document.getElementById('web-overlay');
const appTitle = document.getElementById('app-title');
const webCrumb = document.getElementById('web-crumb');
const toast = document.getElementById('toast');
const seed = [
  {id:'timer-01',name:'Daily code review',owner:'nession',schedule:'daily',time:'09:00',tz:'Asia/Shanghai',action:'claude.submit',input:'Review current changes and report findings',placement:'agent',agent:'devbox-01',location:'devbox-location',target:'session-review',enabled:true,revision:3,runs:[{at:'Today 09:00',status:'Succeeded',duration:'2m 18s'}]},
  {id:'timer-02',name:'Repository health check',owner:'nession',schedule:'interval',time:'01:00',tz:'UTC',action:'shell.execute',input:'cargo test --workspace',placement:'agent',agent:'macbook-offline',location:'macbook-location',target:'',enabled:true,revision:1,runs:[]},
  {id:'timer-03',name:'Nightly session report',owner:'infrastructure',schedule:'daily',time:'23:00',tz:'Asia/Singapore',action:'project.create_session',input:'Session report',placement:'affinity',agent:'devbox-01',location:'devbox-location',target:'',enabled:false,revision:2,runs:[]},
  {id:'timer-04',name:'Session status snapshot',owner:'nession',schedule:'daily',time:'08:30',tz:'Asia/Shanghai',action:'claude.submit',input:'Report current session state',placement:'affinity',agent:'devbox-01',location:'devbox-location',target:'stale-session',enabled:true,revision:1,runs:[]}
];
let state = {timers:JSON.parse(JSON.stringify(seed)),selected:'timer-01',screen:'list',detailTab:'overview',filter:'all',search:'',draft:null,editId:null,error:'',notice:'',macOnline:false,empty:false,appLayer:'workspace',webTerminal:false,collapsed:false};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function timer(id){return state.timers.find(x=>x.id===id);}
function agentFor(t){return t.placement==='affinity'?(t.location==='macbook-location'?'macbook-offline':'devbox-01'):t.agent;}
function isOnline(agent){return agent==='devbox-01'||(agent==='macbook-offline'&&state.macOnline);}
function status(t){if(!t.enabled)return {value:'Paused',kind:''};if(t.target==='stale-session')return {value:'Blocked',kind:'danger'};if(!isOnline(agentFor(t)))return {value:'Pending · Agent offline',kind:'warn'};return {value:'Ready',kind:''};}
function schedule(t){return t.schedule==='interval'?'Every hour':t.schedule==='once'?'Once · '+t.time:'Every day · '+t.time;}
function button(a,label,kind,extra){return '<button type="button" class="t-btn '+(kind||'')+'" data-action="'+a+'" '+(extra||'')+'>'+label+'</button>';}
function name(t){return '<span class="t-primary">'+esc(t.name)+'</span>';}
function report(){const el=document.getElementById('review-state');if(el)el.textContent='macbook: '+(state.macOnline?'online':'offline')+' · '+state.timers.length+' mock timer definitions';}
function showToast(s){toast.textContent=s;toast.hidden=false;}
function renderList(){
 const list=state.empty?[]:state.timers.filter(t=>(state.filter==='all'||(state.filter==='nession'&&t.owner==='nession')||(state.filter==='pending'&&status(t).value.startsWith('Pending')))&&((t.name+' '+t.owner+' '+t.action).toLowerCase().includes(state.search.toLowerCase())));
 let rows=list.map(t=>{const s=status(t);return '<button type="button" class="t-resource-row" data-action="detail" data-id="'+esc(t.id)+'"><div>'+name(t)+'<div class="t-secondary">'+esc(t.owner)+' · '+esc(t.action)+'</div></div><div class="t-meta-col">'+esc(schedule(t))+'<div class="t-secondary">'+esc(t.tz)+'</div></div><div class="t-meta-col">'+esc(agentFor(t))+'</div><div style="display:flex;align-items:center;gap:8px"><span class="t-status '+s.kind+'">'+esc(s.value)+'</span><span class="t-arrow">›</span></div></button>';}).join('');
 const h='<div class="t-row-between t-content-head"><div><h1 class="t-page-title">Timers</h1><p class="t-page-desc">Schedules are saved on Server; each Agent reports deployment separately.</p></div>'+button('new','＋ New Timer','primary')+'</div>';
 const bar='<div class="t-toolbar"><input class="t-input t-search" id="timer-search" aria-label="Search Timers" placeholder="Search timers…" value="'+esc(state.search)+'"><select id="timer-filter" class="t-select t-filter" aria-label="Filter Timers"><option value="all"'+(state.filter==='all'?' selected':'')+'>All timers</option><option value="nession"'+(state.filter==='nession'?' selected':'')+'>Project: nession</option><option value="pending"'+(state.filter==='pending'?' selected':'')+'>Pending</option></select></div>';
 const foot='<div class="t-section"><div class="t-row-between"><div><h3 style="margin:0">Agent deployment</h3><p class="t-secondary">Inspect installed Timers and the local scheduler provider.</p></div>'+button('agent','View Agent →')+'</div></div>';
 return h+bar+(list.length?'<div class="t-resource-list">'+rows+'</div>':'<div class="t-empty"><h3>'+(state.search?'No timers match your search':'Create a Timer')+'</h3><p>'+(state.search?'Change your search or clear the filter.':'Schedule work and assign an Agent to execute it.')+'</p></div>')+foot;
}
function runRows(t){return t.runs.length?t.runs.map(r=>'<div class="t-run-row"><div><strong>'+esc(r.status)+'</strong><div class="t-secondary">'+esc(r.at)+'</div></div><span>'+esc(r.duration)+'</span><span class="t-run-time">Run record</span></div>').join(''):'<p class="t-page-desc">No runs yet. The task has not reported an execution.</p>';}
function detail(){
 const t=timer(state.selected);if(!t)return renderList();const s=status(t);
 const top='<div class="t-detail-top"><button type="button" class="t-link" data-action="list">← All Timers</button><div class="t-row-between"><div>'+name(t)+'<div class="t-secondary">'+esc(t.owner)+' · '+esc(t.id)+'</div></div><span class="t-status '+s.kind+'">'+esc(s.value)+'</span></div></div>';
 const banner=s.value==='Ready'?'': '<div class="t-banner '+s.kind+'">'+(s.value.startsWith('Pending')?'Server has saved the definition. '+esc(agentFor(t))+' is offline; scheduler installation has not been confirmed.':s.value==='Blocked'?'The Session target no longer exists. No alternative Session is selected.':'Timer is paused on Server. The Agent will reconcile its disabled state.')+'</div>';
 const actions='<div class="t-inline-actions">'+button('edit','Edit')+button('toggle',t.enabled?'Pause':'Resume')+button('run','Run now','',s.value==='Ready'?'':'disabled title="A ready target is required"')+button('delete','Delete','danger')+'</div>';
 const tabs='<div class="t-detail-tabs"><button type="button" class="t-tab '+(state.detailTab==='overview'?'active':'')+'" data-action="tab-overview">Overview</button><button type="button" class="t-tab '+(state.detailTab==='runs'?'active':'')+'" data-action="tab-runs">Runs ('+t.runs.length+')</button></div>';
 const obs='<div class="t-grid-facts"><div class="t-fact"><label>Schedule</label><div>'+esc(schedule(t))+' · '+esc(t.tz)+'</div></div><div class="t-fact"><label>Action</label><div>'+esc(t.action)+'</div></div><div class="t-fact"><label>Placement</label><div>'+esc(t.placement==='agent'?'Fixed Agent':'Location affinity')+' · '+esc(agentFor(t))+'</div></div><div class="t-fact"><label>Definition revision</label><div>r'+t.revision+' · Server desired</div></div><div class="t-fact"><label>Deployment state</label><div>'+esc(s.value)+'</div></div><div class="t-fact"><label>Provider</label><div>'+esc(agentFor(t)==='devbox-01'?'systemd (user)':'launchd (user)')+(s.value==='Ready'?' · Observed':' · Not confirmed')+'</div></div></div>';
 const advanced='<details class="t-section"><summary style="cursor:pointer;font-weight:600">Deployment diagnostics</summary><div class="t-grid-facts"><div class="t-fact"><label>Assignment</label><div>'+esc(agentFor(t))+' / epoch 1</div></div><div class="t-fact"><label>Applied revision</label><div>'+(s.value==='Ready'?'r'+t.revision:'Unknown / pending')+'</div></div><div class="t-fact"><label>Target</label><div>'+esc(t.target||'No Session target')+'</div></div><div class="t-fact"><label>Connectivity</label><div>'+(isOnline(agentFor(t))?'Agent connected':'Agent offline')+'</div></div></div></details>';
 return top+banner+actions+tabs+(state.detailTab==='runs'?'<div class="t-section"><h3>Execution history</h3>'+runRows(t)+'</div>':'<div class="t-section"><h3>Definition and current realization</h3>'+obs+'</div>'+advanced+'<div class="t-section"><h3>Recent runs</h3>'+runRows(t)+'</div>');
}
function agentDetails(){
 const list=state.timers.filter(t=>agentFor(t)==='devbox-01');
 return '<button class="t-link" type="button" data-action="list">← All Timers</button><div class="t-row-between t-content-head"><div><h1 class="t-page-title">devbox-01</h1><p class="t-page-desc">Agent deployment · Linux · user systemd</p></div><span class="t-status">Connected</span></div><div class="t-grid-facts"><div class="t-fact"><label>Scheduler provider</label><div>systemd user manager</div></div><div class="t-fact"><label>Availability</label><div>Available · mock observation</div></div><div class="t-fact"><label>Installed assignments</label><div>'+list.filter(t=>status(t).value==='Ready').length+' confirmed / '+list.length+' assigned</div></div><div class="t-fact"><label>Last observation</label><div>Just now · fixture</div></div></div><div class="t-section"><h3>Assigned Timers</h3>'+list.map(t=>{let s=status(t);return '<div class="t-agent-row"><div>'+name(t)+'<div class="t-secondary">'+esc(schedule(t))+'</div></div><span class="t-status '+s.kind+'">'+esc(s.value)+'</span></div>';}).join('')+'</div><div class="t-banner">This view is the Agent’s observed realization. Timer definitions remain managed on Server.</div>';
}
function options(items,current){return items.map(x=>'<option value="'+esc(x[0])+'"'+(current===x[0]?' selected':'')+'>'+esc(x[1])+'</option>').join('');}
function field(id,label,value,help){return '<label class="t-field"><span>'+label+'</span><input id="'+id+'" class="t-input" value="'+esc(value)+'" '+(id==='draft-name'?'required maxlength="80"':'')+'>'+(help?'<div class="t-hint">'+help+'</div>':'')+'</label>';}
function formBody(){
 const d=state.draft; if(!d)return '';
 const scheduleOptions=[['daily','Daily'],['interval','Every hour'],['once','Once']];
 const actionOptions=[['claude.submit','Claude · submit'],['shell.execute','Shell · execute'],['project.create_session','Project · create Session']];
 const placementOptions=[['agent','Specific Agent'],['affinity','Project Location affinity']];
 const tzOptions=[['Asia/Shanghai','Asia/Shanghai'],['Asia/Singapore','Asia/Singapore'],['UTC','UTC']];
 return '<form class="t-form" id="timer-form" novalidate><div class="t-form-body">'+
 '<div class="t-form-section"><h3>Basics</h3>'+field('draft-name','Name',d.name,'Visible across the workspace; belongs to Server Timer Registry.')+
 '<label class="t-field"><span>Owner</span><select class="t-select" id="draft-owner">'+options([['nession','Project · nession'],['infrastructure','Infrastructure']],d.owner)+'</select></label></div>'+
 '<div class="t-form-section"><h3>Schedule</h3><div class="t-form-cols"><label class="t-field"><span>Frequency</span><select class="t-select" id="draft-schedule">'+options(scheduleOptions,d.schedule)+'</select></label><label class="t-field"><span>Time (HH:MM)</span><input class="t-input" id="draft-time" value="'+esc(d.time)+'" placeholder="09:00"></label></div><label class="t-field"><span>Timezone</span><select class="t-select" id="draft-tz">'+options(tzOptions,d.tz)+'</select></label></div>'+
 '<div class="t-form-section"><h3>Action</h3><label class="t-field"><span>Registered action</span><select class="t-select" id="draft-action">'+options(actionOptions,d.action)+'</select></label>'+field('draft-target','Session target (optional)',d.target,'A missing Session never silently selects another Session.')+
 '<label class="t-field"><span>Input</span><textarea class="t-textarea" id="draft-input">'+esc(d.input)+'</textarea></label></div>'+
 '<div class="t-form-section"><h3>Placement</h3><label class="t-field"><span>Selection mode</span><select class="t-select" id="draft-placement">'+options(placementOptions,d.placement)+'</select></label>'+
 (d.placement==='agent'?'<label class="t-field"><span>Agent</span><select class="t-select" id="draft-agent">'+options([['devbox-01','devbox-01 · Linux / systemd'],['macbook-offline','macbook-offline · macOS / launchd']],d.agent)+'</select></label>':'<label class="t-field"><span>Project Location</span><select class="t-select" id="draft-location">'+options([['devbox-location','nession · devbox location'],['macbook-location','nession · macbook location']],d.location)+'</select></label>')+
 '<div class="t-banner '+(isOnline(agentFor(d))?'':'warn')+'">Resolved Agent: <strong>'+esc(agentFor(d))+'</strong> · '+(isOnline(agentFor(d))?'Connected; installation will be requested after save.':'Offline; definition saves as Pending, no automatic fallback.')+'</div></div>'+
 '<details class="t-form-section"><summary style="cursor:pointer;font-weight:600">Advanced execution</summary><label class="t-field"><span>Offline policy</span><select id="draft-offline" class="t-select">'+options([['online_required','Require Server online'],['offline_allowed','Allow bounded offline execution']],d.offline||'online_required')+'</select></label><div class="t-hint">Offline operation is subject to short-lived authorization; simulated only.</div></details>'+
 (state.error?'<p class="t-error" role="alert">'+esc(state.error)+'</p>':'')+
 '</div><div class="t-form-footer">'+button('cancel','Cancel')+'<button class="t-btn primary" type="submit">'+(state.editId?'Save changes':'Create Timer')+'</button></div></form>';
}
function confirmation(){const t=timer(state.selected);return '<div><h1 class="t-page-title">Delete Timer</h1><p class="t-confirm-copy">Delete <strong>'+esc(t?t.name:'Timer')+'</strong>? The Server will record a deletion tombstone; an offline Agent may not stop until its existing authorization expires.</p><div class="t-stacked-actions">'+button('cancel-delete','Cancel')+button('confirm-delete','Delete Timer','danger')+'</div></div>';}
function render(){
 const mobile=root.dataset.mode==='app';
 let content=state.screen==='list'?renderList():state.screen==='detail'?detail():state.screen==='agent'?agentDetails():state.screen==='confirm'?confirmation():formBody();
 webContent.innerHTML=mobile?'':content;
 appContent.innerHTML=mobile?content:'';
 if(mobile){appTitle.textContent=state.screen==='form'?(state.editId?'Edit Timer':'New Timer'):state.screen==='detail'?'Timer details':state.screen==='agent'?'Agent details':state.screen==='confirm'?'Delete Timer':'Timers';}
 webCrumb.textContent=state.screen==='detail'?'Timer details':state.screen==='agent'?'Agent details':state.screen==='form'?'New Timer':'Timers';
 overlay.hidden=true;overlay.innerHTML='';
 if(!mobile&&(state.screen==='form'||state.screen==='confirm')){
   webContent.innerHTML=state.screen==='form'?renderList():detail();
   overlay.hidden=false;
   overlay.innerHTML='<section class="t-dialog" role="dialog" aria-modal="true" aria-label="'+(state.screen==='confirm'?'Delete Timer':state.editId?'Edit Timer':'New Timer')+'"><div class="t-dialog-title"><h2>'+(state.screen==='confirm'?'Delete Timer':state.editId?'Edit Timer':'New Timer')+'</h2><button type="button" class="t-icon" data-action="cancel" aria-label="Close">×</button></div>'+(state.screen==='form'?formBody():'<div class="t-form-body">'+confirmation()+'</div>')+'</section>';
 }
 document.getElementById('review-state')&&report();
}
function openForm(edit){const t=edit?timer(state.selected):null;state.editId=t?t.id:null;state.draft=t?JSON.parse(JSON.stringify(t)):{id:'',name:'',owner:'nession',schedule:'daily',time:'09:00',tz:'Asia/Shanghai',action:'claude.submit',input:'',placement:'agent',agent:'devbox-01',location:'devbox-location',target:'',enabled:true,revision:0,offline:'online_required',runs:[]};state.error='';state.screen='form';render();}
function back(){if(state.screen==='form'){state.screen=state.editId?'detail':'list';state.draft=null;}else if(state.screen==='confirm'){state.screen='detail';}else if(state.screen==='list'){state.appLayer='terminal';showToast('Returned to Terminal context (mock).');}else state.screen='list';render();}
function save(){const d=state.draft;if(!d)return;d.name=d.name.trim();if(!d.name){state.error='Name is required.';render();return;}if(d.name.length>80){state.error='Name is too long.';render();return;}if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)){state.error='Enter a valid time, for example 09:00.';render();return;}if(d.placement==='affinity'&&d.owner!=='nession'){state.error='This owner has no Project Location to resolve.';render();return;}if(d.target==='stale-session'){state.error='Target Session is no longer available. Select a valid target.';render();return;}
 if(state.editId){const old=timer(state.editId);d.id=old.id;d.revision=old.revision+1;d.runs=old.runs;state.timers=state.timers.map(x=>x.id===d.id?d:x);state.selected=d.id;showToast('Desired revision saved on Server (mock).');}
 else{d.id='timer-'+String(Date.now()).slice(-5);d.revision=1;d.runs=[];state.timers.unshift(d);state.selected=d.id;showToast('Timer saved on Server · '+status(d).value);}
 state.draft=null;state.editId=null;state.screen='detail';render();
}
function run(){const t=timer(state.selected);if(!t||status(t).value!=='Ready')return;t.runs.unshift({at:'Just now',status:'Succeeded · mock',duration:'4s'});state.detailTab='runs';showToast('Simulated run completed. No actual command executed.');render();}
function action(a,id){
 if(a==='new'){openForm(false);return;}
 if(a==='edit'){openForm(true);return;}
 if(a==='cancel'){back();return;}
 if(a==='app-back'){back();return;}
 if(a==='list'){state.screen='list';state.search='';state.filter='all';render();return;}
 if(a==='detail'){state.selected=id;state.screen='detail';state.detailTab='overview';render();return;}
 if(a==='agent'){state.screen='agent';render();return;}
 if(a==='tab-overview'){state.detailTab='overview';render();return;}
 if(a==='tab-runs'){state.detailTab='runs';render();return;}
 if(a==='toggle'){const t=timer(state.selected);if(!t)return;t.enabled=!t.enabled;t.revision+=1;showToast(t.enabled?'Resume saved on Server':'Pause saved on Server');render();return;}
 if(a==='run'){run();return;}
 if(a==='delete'){state.screen='confirm';render();return;}
 if(a==='cancel-delete'){state.screen='detail';render();return;}
 if(a==='confirm-delete'){state.timers=state.timers.filter(t=>t.id!==state.selected);state.screen='list';showToast('Deletion tombstone saved on Server (mock).');render();return;}
 if(a==='collapse'){document.querySelector('.t-sidebar').classList.toggle('compact');return;}
 if(a==='terminal'){showToast('Terminal context retained; Timers are accessible from Workspace.');return;}
 if(a==='session'||a==='project'||a==='new-session'){showToast('Context entry only; no Session or Project is created in this mock.');return;}
}
function syncDraft(key,value){
 if(!state.draft)return;
 const m={'draft-name':'name','draft-owner':'owner','draft-schedule':'schedule','draft-time':'time','draft-tz':'tz','draft-action':'action','draft-target':'target','draft-input':'input','draft-placement':'placement','draft-agent':'agent','draft-location':'location','draft-offline':'offline'};
 if(m[key])state.draft[m[key]]=value;
}
root.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(!el)return;e.preventDefault();action(el.dataset.action,el.dataset.id);});
root.addEventListener('input',e=>{if(e.target.id==='timer-search'){state.search=e.target.value;const pos=e.target.selectionStart;render();const i=document.getElementById('timer-search');if(i){i.focus();i.setSelectionRange(pos,pos);}return;}syncDraft(e.target.id,e.target.value);});
root.addEventListener('change',e=>{if(e.target.id==='timer-filter'){state.filter=e.target.value;render();return;}syncDraft(e.target.id,e.target.value);if(['draft-placement','draft-agent','draft-location','draft-owner','draft-schedule'].includes(e.target.id))render();});
root.addEventListener('submit',e=>{if(e.target.id==='timer-form'){e.preventDefault();save();}});
document.getElementById('review-root').addEventListener('np:resize',e=>{root.dataset.mode=e.detail.width<=500?'app':'web';render();});
document.querySelectorAll('[data-review-action]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.reviewAction==='online')state.macOnline=true;if(b.dataset.reviewAction==='offline')state.macOnline=false;if(b.dataset.reviewAction==='empty')state.empty=!state.empty;showToast('Mock infrastructure state updated');render();}));
render();
})();