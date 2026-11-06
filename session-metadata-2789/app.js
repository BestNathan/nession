/* Deterministic in-memory design simulator. No network access or persistent state. */
(function () {
'use strict';
var root=document.getElementById('n-product');
var device=document.querySelector('[data-np-device]');
var normal=[
 {uid:'ses-r1',id:'agent-dev:terminal-reconnect',name:'terminal-reconnect',title:'Terminal reconnect reliability',description:'修复跨设备重连后的 Terminal 显示错位，并验证 tmux control mode 与 xterm.js 的恢复一致性。',tags:['nession','terminal','bugfix'],agent:'devbox-01',command:'claude',cwd:'/workspace/nession',activity:'2m',revision:4},
 {uid:'ses-d1',id:'agent-dev:design-review',name:'design-review',title:'',description:'',tags:[],agent:'devbox-01',command:'bash',cwd:'/workspace/design',activity:'14m',revision:1},
 {uid:'ses-c1',id:'agent-cloud:ci-analysis',name:'ci-analysis',title:'CI performance review',description:'分析核心工作流耗时及缓存命中情况。',tags:['ci'],agent:'cloud-agent',command:'bash',cwd:'/workspace/nession',activity:'1h',revision:2}
];
function clone(x){return JSON.parse(JSON.stringify(x))}
var state={sessions:clone(normal),selected:0,width:1180,screen:'workspace',mode:'web',edit:false,draft:null,tagInput:'',notice:'',noticeKind:'',fixture:'normal',offline:false,conflict:false,conflictResolved:false,modal:null,collapsed:false,appSessions:false,terminalContext:false};
function esc(x){return String(x==null?'':x).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function active(){return state.sessions[state.selected]}
function display(s){return s.title&&s.title.trim()?s.title:s.name}
function icon(label,action,extra){return '<button type="button" class="n-btn is-ghost is-icon" data-action="'+action+'" aria-label="'+label+'" title="'+label+'" '+(extra||'')+'>'+esc(label==='Collapse sidebar'?'‹':label==='Expand sidebar'?'›':'⋯')+'</button>'}
function sessionRow(s,i){return '<button class="n-session" type="button" data-action="select" data-index="'+i+'" aria-current="'+(i===state.selected)+'"><span class="n-session-title">'+esc(display(s))+'</span><span class="n-session-sub">'+esc(s.command)+' · '+esc(s.agent)+' · '+esc(s.activity)+'</span></button>'}
function sidebar(){
if(state.collapsed)return '<aside class="n-sidebar is-collapsed" data-testid="sidebar" data-collapsed="true">'+icon('Expand sidebar','expand')+'<div class="n-rail-note">Agents<br>2</div><div class="n-rail-note">Sessions<br>3</div><div class="n-bottom">●</div></aside>';
return '<aside class="n-sidebar" data-testid="sidebar"><div class="n-side-head"><h2>Agents</h2>'+icon('Collapse sidebar','collapse')+'</div><div class="n-agent">◉ <b>devbox-01</b></div><div class="n-agent">◉ <b>cloud-agent</b></div><div class="n-separator"></div><h2>Sessions</h2><div class="n-sessions">'+state.sessions.map(sessionRow).join('')+'</div><div class="n-bottom">Connected · 2 Agents</div></aside>'}
function notice(){return state.notice?'<div class="n-notice '+(state.noticeKind==='error'?'is-error':state.noticeKind==='success'?'is-success':'')+'" role="status">'+esc(state.notice)+'</div>':''}
function tagsView(tags){
if(!tags.length)return '<div class="n-tags"><span class="n-inline-subtle">未添加标签</span></div>';
return '<div class="n-tags">'+tags.map(t=>'<span class="n-tag">#'+esc(t)+'</span>').join('')+'</div>'}
function detail(){
 var s=active();
 var disabled=state.offline?'<div class="n-notice is-error" role="status">Agent unreachable · 当前展示已知的 Session 信息，无法保存更改。</div>':'';
 // Match staging SessionDetails → SessionMetadataSection content ownership.
 // Work-context fields are not the global Session heading, nor a second App page.
 var summary='<div class="n-session-overview"><h2 class="n-heading" data-testid="session-title">'+esc(display(s))+'</h2>'+
  '<p class="n-session-id n-mono">'+esc(s.id)+'</p></div>'+
  '<div class="n-session-connection" data-testid="session-connection">'+(state.offline?'○ Agent offline':'● Connected')+'</div>'+
  '<dl class="n-runtime-facts" aria-label="Session runtime facts">'+datum('Windows','1')+datum('Last activity',s.activity)+'</dl>';
 var body=state.edit?editDetail(s,disabled):
  '<div data-testid="session-metadata-view"><p class="n-description '+(!s.description?'is-empty':'')+'">'+esc(s.description||'This Session has no saved details yet.')+'</p>'+
  tagsView(s.tags)+'</div>'+notice()+disabled;
 return '<div class="n-content" data-testid="session-details">'+summary+
  '<section class="n-metadata-section" data-testid="session-metadata" aria-labelledby="n-work-context">'+
  '<div class="n-metadata-head"><h3 id="n-work-context">Work context</h3>'+
  (state.edit?'':'<button class="n-btn" type="button" data-action="edit" data-testid="session-metadata-edit">Edit details</button>')+'</div>'+
  body+'</section></div>';
}
function datum(label,val,mono){return '<div class="n-data"><dt class="n-data-label">'+esc(label)+'</dt><dd class="n-data-value '+(mono?'n-mono':'')+'">'+esc(val)+'</dd></div>'}
function editorTags(){
var tags=state.draft.tags;
var chips=tags.map((tag,i)=>'<span class="n-tag is-editing">#'+esc(tag)+' <button class="n-tag-remove" type="button" data-action="remove-tag" data-index="'+i+'" aria-label="Remove '+esc(tag)+' tag">×</button></span>').join('');
return '<div class="n-tags">'+(chips||'<span class="n-inline-subtle">尚无标签</span>')+'</div><div class="n-tag-edit"><input id="n-new-tag" data-testid="tag-entry" aria-label="Add tag" value="'+esc(state.tagInput)+'" placeholder="添加标签…" maxlength="64"><button class="n-btn" type="button" data-action="add-tag">添加</button></div><div class="n-help">最多 12 个标签，大小写不区分重复，每个标签不超过 32 字。</div>'}
function editDetail(s,disabled){
 return '<div class="n-editor" data-testid="session-metadata-editor">'+notice()+disabled+
 '<div class="n-field"><label for="n-title">Title</label><input id="n-title" data-testid="title-input" value="'+esc(state.draft.title)+'" maxlength="160" autocomplete="off" placeholder="'+esc(s.name)+'"><div class="n-help">Shown in navigation. The tmux name is not renamed. · 120 characters max</div></div>'+
 '<div class="n-field"><label for="n-description">Description</label><textarea id="n-description" data-testid="description-input" maxlength="2200" placeholder="What is this work about?">'+esc(state.draft.description)+'</textarea><div class="n-help">Plain text · 2,000 characters max</div></div>'+
 '<div class="n-field"><label for="n-new-tag">Tags</label>'+editorTags()+'</div>'+
 '<div class="n-edit-actions"><button class="n-btn is-primary" type="button" data-action="save">保存</button><button class="n-btn" type="button" data-action="cancel">取消</button>'+(state.conflict&&state.noticeKind==='error'?'<button type="button" class="n-btn" data-action="refresh-conflict">放弃草稿并加载最新版本</button>':'')+'</div></div>';
}
// Product owner tree: WebLayout( Sidebar + ShellMain ), WorkspacePanel/WorkspaceShell,
// AppLayout/AppLayers( Terminal root, Sessions layer, Workspace layer with ONE page header ).
function dock(){
 return '<div class="n-dock" data-testid="workspace-tool-bar" aria-label="Workspace capabilities">'+
   (state.mode==='web'?'<button class="n-dock-circle" data-action="terminal" type="button" aria-label="Open terminal" title="Open terminal">⌁</button>':'')+
   '<nav class="n-dock-pill" aria-label="Workspace capabilities"><button type="button" data-testid="workspace-tool-session" data-action="workspace" aria-current="page">▤ &nbsp; Session</button></nav></div>';
}
function terminal(){
 var s=active();return '<div class="n-terminal" aria-label="Terminal simulation" data-testid="terminal-surface"><p>Last login: 2026-11-05 on '+esc(s.agent)+'</p><p><span class="n-prompt">'+esc(s.name)+' $</span> pwd</p><p>'+esc(s.cwd)+'</p><p><span class="n-prompt">'+esc(s.name)+' $</span> git status --short</p><p> M web/src/product/session/components/SessionDetails.tsx</p><p><span class="n-prompt">'+esc(s.name)+' $</span> █</p></div>';
}
function terminalCapsule(){
 return '<div class="n-terminal-dock" data-testid="terminal-capsule-zone">'+
   (state.terminalContext?'<div class="n-context-peek"><strong>Available for this Session</strong><button type="button" data-action="workspace">▤ Session</button></div>':'')+
   '<div class="n-conversation-capsule"><button type="button" data-action="toggle-context" aria-label="Open capabilities">＋</button><span>Ask Nession…</span><span class="n-send-mark">↑</span></div>'+
   '<button class="n-dock-circle n-terminal-destination" type="button" data-action="workspace" aria-label="Open workspace" title="Open workspace">▣</button></div>';
}
function appHeader(title,back){
 return '<header class="n-app-top" data-testid="app-page-header"><button type="button" class="n-btn is-ghost" data-action="'+back+'" aria-label="Back to terminal">‹</button><strong>'+esc(title)+'</strong></header>';
}
function appSessionList(){
 return '<section class="n-app-session-layer" data-testid="app-layer-sessions"><header class="n-app-top" data-testid="app-sessions-header"><button type="button" class="n-btn is-ghost" data-action="terminal" aria-label="Back to terminal">‹</button><strong>Sessions</strong></header><div class="n-sessions-page">'+state.sessions.map(sessionRow).join('')+'</div></section>';
}
function workspaceShell(content){
 return '<section class="n-workspace-shell" data-testid="workspace-shell">'+
   (state.mode==='app'?appHeader('Session','terminal'):'')+
   '<div class="n-workspace-content" data-testid="workspace-tool-content"><div class="n-view">'+content+'</div></div>'+dock()+'</section>';
}
function appContent(){
 if(state.appSessions)return appSessionList();
 if(state.screen==='terminal')return '<section class="n-terminal-layer" data-testid="app-layer-terminal">'+terminal()+terminalCapsule()+'</section>';
 return '<section class="n-app-workspace-layer" data-testid="app-layer-workspace">'+workspaceShell(detail())+'</section>';
}
function webContent(){
 return '<div class="n-web-layout" data-testid="web-layout">'+sidebar()+
   '<main class="n-main" data-testid="shell-main">'+
   (state.screen==='workspace'?workspaceShell(detail()):terminal()+terminalCapsule())+
   '</main></div>';
}
function dialog(){if(!state.modal)return '';return '<div class="n-modal-backdrop"><div class="n-dialog" role="dialog" aria-modal="true" aria-label="Unsaved changes"><h2>放弃未保存的修改？</h2><p>当前 Session 的 Title、Description 或 Tags 尚未保存。继续将丢弃这些更改。</p><div class="n-actions"><button class="n-btn" data-action="stay">继续编辑</button><button class="n-btn is-primary" data-action="discard">放弃更改</button></div></div></div>'}
function render(){
state.mode=state.width<=430?'app':'web';
root.className='n-product '+(state.mode==='app'?'n-app':'n-web');
root.innerHTML='<div class="n-shell">'+(state.mode==='app'?'<div class="n-app-layers" data-testid="app-layer-root">'+appContent()+'</div>':webContent())+dialog()+'</div>';
}
function resetFixture(which){
state.sessions=clone(normal);state.selected=0;state.screen='workspace';state.edit=false;state.draft=null;state.notice='';state.noticeKind='';state.conflict=false;state.offline=false;state.conflictResolved=false;state.modal=null;state.appSessions=false;state.collapsed=false;state.terminalContext=false;state.tagInput='';state.fixture=which;
if(which==='legacy')state.selected=1;
if(which==='offline')state.offline=true;
if(which==='conflict')state.conflict=true;
if(which==='reused'){state.sessions[0].uid='ses-r2';state.sessions[0].title='';state.sessions[0].description='';state.sessions[0].tags=[];state.sessions[0].revision=1}
document.querySelectorAll('[data-fixture]').forEach(function(btn){btn.setAttribute('aria-pressed',String(btn.getAttribute('data-fixture')===which))});render();
}
function readDraft(){if(!state.edit||!state.draft)return;var title=root.querySelector('#n-title'), desc=root.querySelector('#n-description'), tag=root.querySelector('#n-new-tag');if(title)state.draft.title=title.value;if(desc)state.draft.description=desc.value;if(tag)state.tagInput=tag.value}
function changed(){if(!state.edit||!state.draft)return false;readDraft();var s=active();return state.draft.title!==s.title||state.draft.description!==s.description||state.draft.tags.join('\u0000')!==s.tags.join('\u0000')||Boolean(state.tagInput.trim())}
function transition(fn){if(changed()){state.modal={after:fn};render()}else{state.edit=false;state.draft=null;fn();render()}}
function addTag(){readDraft();var t=state.tagInput.trim();if(!t){state.notice='请输入非空标签。';state.noticeKind='error';render();return}if(t.length>32||state.draft.tags.length>=12||state.draft.tags.some(function(x){return x.toLocaleLowerCase()===t.toLocaleLowerCase()})){state.notice='标签重复、过长或已达到数量上限。';state.noticeKind='error';render();return}state.draft.tags.push(t);state.tagInput='';state.notice='';state.noticeKind='';render();var f=root.querySelector('#n-new-tag');if(f)f.focus()}
function save(){
readDraft();var s=active(),d=state.draft;if(state.tagInput.trim()){state.notice='请先添加输入中的标签，或清空该输入框。';state.noticeKind='error';render();return}
if(d.title.trim().length>120||d.description.trim().length>2000){state.notice='标题最多 120 字，描述最多 2000 字。';state.noticeKind='error';render();return}
if(state.offline){state.notice='Agent unreachable · 无法保存。草稿仍然保留。';state.noticeKind='error';render();return}
if(state.conflict&&!state.conflictResolved){state.notice='Session 信息已在其他设备更新。请加载最新版本后重新确认修改。';state.noticeKind='error';render();return}
s.title=d.title.trim();s.description=d.description.trim();s.tags=d.tags.slice();s.revision++;state.edit=false;state.draft=null;state.notice='已保存 Session 信息；tmux 名称保持不变。';state.noticeKind='success';state.conflict=false;render()}
function eventAction(action,el){
if(action==='edit'){state.edit=true;state.draft={title:active().title,description:active().description,tags:active().tags.slice()};state.tagInput='';state.notice='';state.noticeKind='';render();var input=root.querySelector('#n-title');if(input)input.focus();return}
if(action==='add-tag'){addTag();return}
if(action==='remove-tag'){readDraft();state.draft.tags.splice(Number(el.getAttribute('data-index')),1);state.notice='';render();return}
if(action==='save'){save();return}
if(action==='cancel'){state.edit=false;state.draft=null;state.notice='修改已取消。';state.noticeKind='';render();return}
if(action==='refresh-conflict'){var current=active();current.title='Terminal reconnect — updated elsewhere';current.description='另一台设备刚刚更新了这项工作说明。';current.tags=['nession','terminal'];current.revision++;state.draft=null;state.edit=false;state.tagInput='';state.conflict=false;state.conflictResolved=false;state.notice='已加载其他设备的最新信息，之前的草稿已按选择放弃。';state.noticeKind='';render();return}
if(action==='stay'){state.modal=null;render();return}
if(action==='discard'){var next=state.modal.after;state.modal=null;state.edit=false;state.draft=null;state.notice='';state.noticeKind='';next();render();return}
if(action==='toggle-context'){state.terminalContext=!state.terminalContext;render();return}
if(action==='collapse'){state.collapsed=true;render();return}
if(action==='expand'){state.collapsed=false;render();return}
if(action==='select'){var index=Number(el.getAttribute('data-index'));transition(function(){state.selected=index;state.appSessions=false;state.notice='';state.noticeKind='';state.screen='workspace'});return}
if(action==='workspace'){transition(function(){state.terminalContext=false;state.appSessions=false;state.screen='workspace'});return}
if(action==='terminal'){transition(function(){state.terminalContext=false;state.appSessions=false;state.screen='terminal'});return}
if(action==='app-sessions'){transition(function(){state.appSessions=true});return}
}
root.addEventListener('click',function(e){var el=e.target.closest('[data-action]');if(el&&root.contains(el))eventAction(el.getAttribute('data-action'),el)});
root.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.id==='n-new-tag'){e.preventDefault();addTag()}if(e.key==='Escape'&&state.modal){state.modal=null;render()}});
document.querySelectorAll('[data-fixture]').forEach(function(btn){btn.addEventListener('click',function(){resetFixture(btn.getAttribute('data-fixture'))})});
var page=document.querySelector('[data-np-root]');
page.addEventListener('np:resize',function(e){state.width=e.detail.width;device.style.setProperty('--np-device-height',state.width<=430?'844px':'720px');state.appSessions=false;state.notice='';state.noticeKind='';render()});
render();
})();
