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
var state={sessions:clone(normal),selected:0,width:1180,screen:'workspace',mode:'web',edit:false,draft:null,tagInput:'',notice:'',noticeKind:'',fixture:'normal',offline:false,conflict:false,conflictResolved:false,modal:null,collapsed:false,appSessions:false};
function esc(x){return String(x==null?'':x).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function active(){return state.sessions[state.selected]}
function display(s){return s.title&&s.title.trim()?s.title:s.name}
function icon(label,action,extra){return '<button type="button" class="n-btn is-ghost is-icon" data-action="'+action+'" aria-label="'+label+'" title="'+label+'" '+(extra||'')+'>'+esc(label==='Collapse sidebar'?'‹':label==='Expand sidebar'?'›':'⋯')+'</button>'}
function sessionRow(s,i){return '<button class="n-session" type="button" data-action="select" data-index="'+i+'" aria-current="'+(i===state.selected)+'"><span class="n-session-title">'+esc(display(s))+'</span><span class="n-session-sub">'+esc(s.command)+' · '+esc(s.agent)+' · '+esc(s.activity)+'</span></button>'}
function sidebar(){
if(state.collapsed)return '<aside class="n-sidebar is-collapsed">'+icon('Expand sidebar','expand')+'<div class="n-rail-note">Agents<br>2</div><div class="n-rail-note">Sessions<br>3</div><div class="n-bottom">●</div></aside>';
return '<aside class="n-sidebar"><div class="n-side-head"><h2>Agents</h2>'+icon('Collapse sidebar','collapse')+'</div><div class="n-agent">◉ <b>devbox-01</b></div><div class="n-agent">◉ <b>cloud-agent</b></div><div class="n-separator"></div><h2>Sessions</h2><div class="n-sessions">'+state.sessions.map(sessionRow).join('')+'</div><div class="n-bottom">Connected · 2 Agents</div></aside>'}
function notice(){return state.notice?'<div class="n-notice '+(state.noticeKind==='error'?'is-error':state.noticeKind==='success'?'is-success':'')+'" role="status">'+esc(state.notice)+'</div>':''}
function tagsView(tags){
if(!tags.length)return '<div class="n-tags"><span class="n-inline-subtle">未添加标签</span></div>';
return '<div class="n-tags">'+tags.map(t=>'<span class="n-tag">#'+esc(t)+'</span>').join('')+'</div>'}
function detail(){
var s=active();
var disabled=state.offline?'<div class="n-notice is-error" role="status">Agent unreachable · 当前展示已知的 Session 信息，无法保存更改。</div>':'';
if(state.edit)return editDetail(s,disabled);
return '<div class="n-content" data-testid="session-details"><div class="n-identity"><div><h1 class="n-heading" data-testid="session-title">'+esc(display(s))+'</h1><p class="n-description '+(!s.description?'is-empty':'')+'">'+esc(s.description||'还没有工作描述。')+'</p>'+tagsView(s.tags)+'</div><button class="n-btn" type="button" data-action="edit">编辑信息</button></div>'+notice()+disabled+
'<section class="n-data-list" aria-label="Session context">'+datum('运行位置',s.agent)+datum('工作目录',s.cwd,true)+datum('运行程序',s.command,true)+datum('上次活动',s.activity)+datum('tmux 名称',s.name,true)+datum('Session ID',s.id,true)+'</section><div class="n-meta-foot">标题仅用于展示；Session ID 与 tmux 名称保持不变。</div></div>'}
function datum(label,val,mono){return '<div class="n-data"><div class="n-data-label">'+esc(label)+'</div><div class="n-data-value '+(mono?'n-mono':'')+'">'+esc(val)+'</div></div>'}
function editorTags(){
var tags=state.draft.tags;
var chips=tags.map((tag,i)=>'<span class="n-tag is-editing">#'+esc(tag)+' <button class="n-tag-remove" type="button" data-action="remove-tag" data-index="'+i+'" aria-label="Remove '+esc(tag)+' tag">×</button></span>').join('');
return '<div class="n-tags">'+(chips||'<span class="n-inline-subtle">尚无标签</span>')+'</div><div class="n-tag-edit"><input id="n-new-tag" data-testid="tag-entry" aria-label="Add tag" value="'+esc(state.tagInput)+'" placeholder="添加标签…" maxlength="64"><button class="n-btn" type="button" data-action="add-tag">添加</button></div><div class="n-help">最多 12 个标签，大小写不区分重复，每个标签不超过 32 字。</div>'}
function editDetail(s,disabled){
return '<div class="n-content" data-testid="session-metadata-editor"><div class="n-edit-head"><h2>编辑 Session 信息</h2><div class="n-help">只是展示信息，不会修改正在运行的终端或 Session 名称。</div></div>'+notice()+disabled+
'<div class="n-field"><label for="n-title">Title</label><input id="n-title" data-testid="title-input" value="'+esc(state.draft.title)+'" maxlength="160" autocomplete="off" placeholder="'+esc(s.name)+'"><div class="n-help">留空时显示 tmux 名称 · 不超过 120 字</div></div>'+
'<div class="n-field"><label for="n-description">Description</label><textarea id="n-description" data-testid="description-input" maxlength="2200" placeholder="记录当前工作目标或说明…">'+esc(state.draft.description)+'</textarea><div class="n-help">纯文本 · 不超过 2000 字</div></div>'+
'<div class="n-field"><label for="n-new-tag">Tags</label>'+editorTags()+'</div>'+
'<div class="n-edit-actions"><button class="n-btn is-primary" type="button" data-action="save">保存</button><button class="n-btn" type="button" data-action="cancel">取消</button>'+(state.conflict&&state.noticeKind==='error'?'<button type="button" class="n-btn" data-action="refresh-conflict">加载最新版本</button>':'')+'</div>'+
'<section class="n-data-list" aria-label="Immutable Session identifiers">'+datum('tmux 名称（不可编辑）',s.name,true)+datum('Session ID（不可编辑）',s.id,true)+'</section></div>'}
function dock(){return '<div class="n-dock" aria-label="Workspace navigation"><button class="n-dock-circle" data-action="terminal" type="button" aria-label="Open terminal" title="Open terminal">⌁</button><div class="n-dock-pill"><button type="button" data-action="workspace" aria-current="page">▤ &nbsp; Session</button></div></div>'}
function terminal(){
var s=active();return '<div class="n-terminal" aria-label="Terminal simulation"><p>Last login: 2026-11-05 on '+esc(s.agent)+'</p><p><span class="n-prompt">'+esc(s.name)+' $</span> pwd</p><p>'+esc(s.cwd)+'</p><p><span class="n-prompt">'+esc(s.name)+' $</span> git status --short</p><p> M web/src/product/session/components/SessionDetails.tsx</p><p><span class="n-prompt">'+esc(s.name)+' $</span> █</p></div>'}
function appHeader(title,back){return '<div class="n-app-top"><button type="button" class="n-btn is-ghost" data-action="'+back+'" aria-label="Back">‹</button><strong>'+esc(title)+'</strong><span style="width:42px"></span></div>'}
function appSessionList(){return appHeader('Sessions','terminal')+'<div class="n-sessions-page">'+state.sessions.map(sessionRow).join('')+'</div>'}
function appContent(){if(state.appSessions)return appSessionList(); if(state.screen==='terminal')return appHeader('Terminal','app-sessions')+'<div class="n-main">'+terminal()+'<div class="n-dock"><button class="n-dock-circle" data-action="app-sessions" aria-label="Open sessions" title="Sessions">☰</button><div class="n-dock-pill"><button data-action="workspace">▤ &nbsp; Workspace</button></div></div></div>';return appHeader('Session','terminal')+'<div class="n-main"><div class="n-view">'+detail()+'</div>'+dock()+'</div>'}
function webContent(){return sidebar()+'<div class="n-main">'+(state.screen==='workspace'?'<div class="n-view">'+detail()+'</div>'+dock():terminal()+'<div class="n-dock"><button class="n-dock-circle" type="button" data-action="workspace" aria-label="Open workspace" title="Open workspace">▤</button><div class="n-dock-pill"><button type="button" data-action="workspace">+ &nbsp; Ask Nession…</button></div></div>')+'</div>'}
function dialog(){if(!state.modal)return '';return '<div class="n-modal-backdrop"><div class="n-dialog" role="dialog" aria-modal="true" aria-label="Unsaved changes"><h2>放弃未保存的修改？</h2><p>当前 Session 的 Title、Description 或 Tags 尚未保存。继续将丢弃这些更改。</p><div class="n-actions"><button class="n-btn" data-action="stay">继续编辑</button><button class="n-btn is-primary" data-action="discard">放弃更改</button></div></div></div>'}
function render(){
state.mode=state.width<=430?'app':'web';
root.className='n-product '+(state.mode==='app'?'n-app':'n-web');
root.innerHTML='<div class="n-shell">'+(state.mode==='app'?'<div class="n-main">'+appContent()+'</div>':webContent())+dialog()+'</div>';
}
function resetFixture(which){
state.sessions=clone(normal);state.selected=0;state.screen='workspace';state.edit=false;state.draft=null;state.notice='';state.noticeKind='';state.conflict=false;state.offline=false;state.conflictResolved=false;state.modal=null;state.appSessions=false;state.collapsed=false;state.tagInput='';state.fixture=which;
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
if(action==='refresh-conflict'){readDraft();state.conflictResolved=true;state.conflict=false;active().revision++;state.notice='已加载最新版本号，请检查草稿并再次保存。';state.noticeKind='';render();return}
if(action==='stay'){state.modal=null;render();return}
if(action==='discard'){var next=state.modal.after;state.modal=null;state.edit=false;state.draft=null;state.notice='';state.noticeKind='';next();render();return}
if(action==='collapse'){state.collapsed=true;render();return}
if(action==='expand'){state.collapsed=false;render();return}
if(action==='select'){var index=Number(el.getAttribute('data-index'));transition(function(){state.selected=index;state.appSessions=false;state.notice='';state.noticeKind='';state.screen='workspace'});return}
if(action==='workspace'){transition(function(){state.appSessions=false;state.screen='workspace'});return}
if(action==='terminal'){transition(function(){state.appSessions=false;state.screen='terminal'});return}
if(action==='app-sessions'){transition(function(){state.appSessions=true});return}
}
root.addEventListener('click',function(e){var el=e.target.closest('[data-action]');if(el&&root.contains(el))eventAction(el.getAttribute('data-action'),el)});
root.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.id==='n-new-tag'){e.preventDefault();addTag()}if(e.key==='Escape'&&state.modal){state.modal=null;render()}});
document.querySelectorAll('[data-fixture]').forEach(function(btn){btn.addEventListener('click',function(){resetFixture(btn.getAttribute('data-fixture'))})});
var page=document.querySelector('[data-np-root]');
page.addEventListener('np:resize',function(e){state.width=e.detail.width;device.style.setProperty('--np-device-height',state.width<=430?'844px':'720px');state.appSessions=false;state.notice='';state.noticeKind='';render()});
render();
})();
