/* Nession #3971 · App Workspace design prototype. Synthetic state only; no network, provider, files or terminal writes. */
(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const icons = {
  back:'<path d="m15 18-6-6 6-6"/>',forward:'<path d="m9 18 6-6-6-6"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  file:'<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M9 12h6M9 16h6"/>',
  files:'<path d="M7 3h12v16H7zM5 7H3v14h12"/>',
  git:'<circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 5v14M6 9a9 9 0 0 0 12-1"/>',
  bot:'<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M9 3h6"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 17h6"/>',
  shield:'<path d="M12 2 20 6v6c0 5-3.5 8.3-8 10-4.5-1.7-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/>',
  folder:'<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3z"/>',
  chevron:'<path d="m9 18 6-6-6-6"/>',down:'<path d="m6 9 6 6 6-6"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  terminal:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>',
  refresh:'<path d="M20 11a8 8 0 0 0-14-5L3 9"/><path d="M3 3v6h6M4 13a8 8 0 0 0 14 5l3-3"/><path d="M15 15h6v6"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  edit:'<path d="m4 20 4.5-1L20 7.5 16.5 4 5 15.5z"/><path d="m14 6 4 4"/>',
  save:'<path d="M4 3h14l3 3v15H3V3zM7 3v7h10V3M7 21v-8h10v8"/>',
  close:'<path d="M18 6 6 18M6 6l12 12"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  alert:'<path d="m12 3 10 18H2z"/><path d="M12 9v5M12 18h.01"/>',
  code:'<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3" cy="6" r=".7"/><circle cx="3" cy="12" r=".7"/><circle cx="3" cy="18" r=".7"/>',
  memory:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6m-6 4h6m-6 4h4"/>',
  settings:'<path d="M12 2v3m0 14v3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M2 12h3m14 0h3M4.9 19.1 7 17m10-10 2.1-2.1"/><circle cx="12" cy="12" r="4"/>',
  branch:'<path d="M7 3v12a4 4 0 0 0 4 4h4M7 8h8a3 3 0 0 0 3-3"/><circle cx="7" cy="3" r="2"/><circle cx="18" cy="3" r="2"/><circle cx="18" cy="19" r="2"/>',
  commit:'<circle cx="12" cy="12" r="4"/><path d="M2 12h6m8 0h6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link:'<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  bin:'<path d="M3 6h18M9 6V4h6v2m3 0-1 15H7L6 6M10 10v7m4-7v7"/>',
  filter:'<path d="M4 6h16M7 12h10M10 18h4"/>',
  play:'<path d="m8 5 11 7-11 7z"/>',
  external:'<path d="M13 5h6v6M19 5l-9 9"/><path d="M19 13v6H5V5h6"/>'
};
const icon = (name,size=18) => '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(icons[name]||icons.file)+'</svg>';
const e = (x) => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const capNames={claude:'Claude Code',git:'Git',sandbox:'Sandbox',files:'Files'};
const routeNames={root:null,conversations:'Conversations',transcripts:'Transcripts',transcript:'Session transcript',
  record:'Tool result',raw:'Raw JSON',memory:'Memory',mcp:'MCP Servers',config:'Configuration',
  diff:'AppPageHeader.tsx',history:'History',branches:'Branches',github:'GitHub',
  filesystem:'Filesystem',policy:'Policies',mounts:'Mounts',file:'AppPageHeader.tsx',edit:'Edit file',folder:'components'};
const initial=()=>({surface:'workspace',cap:'claude',history:[{kind:'root',scroll:0}],cursor:0,
  fixture:'normal',sessionNo:1,overlay:null,pending:null,dirty:false,editorValue:'// App workspace header\nexport const title = "Workspace";\n',last:'Opened Claude Code',actionCount:0});
let state=initial();
let move=null;let toastTimer=null;let suppressClicksUntil=0;
const active=()=>state.history[state.cursor];
const title=r=>r.kind==='root'?capNames[state.cap]:(r.title||routeNames[r.kind]||'Resource');
const root=()=>({kind:'root',scroll:0});
const fakeSession=()=>state.sessionNo===1?'session · nession-dev':'session · staging-build';
function saveScroll(){const sc=$('#app-content');if(sc&&active())active().scroll=sc.scrollTop;}
function record(info){state.last=info;const x=$('#inspector');if(x)x.textContent=JSON.stringify({surface:state.surface,capability:state.cap,
  route:state.history.map((r,i)=>(i===state.cursor?'▶ ':'  ')+title(r)).join('  /  '),
  index:state.cursor,forward:state.history.length-state.cursor-1,dirty:state.dirty,overlay:state.overlay,
  fixture:state.fixture,session:fakeSession(),last:state.last},null,2);}
function toast(s){const x=$('#app-toast');x.textContent=s;x.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>x.hidden=true,2200);}
function push(r){saveScroll();state.history=state.history.slice(0,state.cursor+1).concat([{...r,scroll:0}]);state.cursor++;render('Push '+title(r));}
function commitNav(op){saveScroll();if(op.type==='pop'){if(state.cursor>0){state.cursor--;render('Pop');}else if(state.surface==='workspace'){state.surface='terminal';render('Return to Terminal');}}
  if(op.type==='forward'&&state.cursor<state.history.length-1){state.cursor++;render('Forward');}
  if(op.type==='ancestor'){state.cursor=op.index;render('Jump to ancestor');}
  if(op.type==='cap'){state.cap=op.cap;state.history=[root()];state.cursor=0;state.fixture='normal';state.dirty=false;render('Capability switch: '+state.cap);}
  if(op.type==='browse'){state.history=[root(),{kind:op.route,scroll:0}];state.cursor=1;state.dirty=false;render('Browse '+op.route);}
  if(op.type==='terminal'){state.surface='terminal';render('Return to Terminal');}
  if(op.type==='sessions'){state.surface='sessions';render('Open Sessions');}
}
function navigate(op){if(state.overlay)closeOverlay();if(state.dirty&&active().kind==='edit'){
    state.pending=op;state.overlay='guard';renderOverlay();record('Unsaved changes: guard');return;
  }commitNav(op);}
function pop(){navigate({type:'pop'});}
function enterWorkspace(){state.surface='workspace';render('Open Workspace');}
function btn(action,ic,label,extra=''){return '<button type="button" class="h-action" data-action="'+action+'" aria-label="'+e(label)+'" title="'+e(label)+'" '+extra+'>'+icon(ic,20)+'</button>';}
function head(){const a=active();const ancestors=state.history.slice(0,state.cursor);
  const subtitle=state.cursor===0?fakeSession()+' · active agent':ancestors.map(x=>title(x)).join(' / ');
  const symbol=state.cursor===0?'grid':a.kind==='diff'||a.kind==='raw'?'copy':a.kind==='edit'?'save':'grid';
  const primary=state.cursor===0?'Browse resources':a.kind==='diff'||a.kind==='raw'?'Copy reference':a.kind==='edit'?'Save file':'Browse resources';
  const action=a.kind==='diff'||a.kind==='raw'?'copy':a.kind==='edit'?'save':'browse';
  return btn('back','back',state.cursor?'Back to '+title(state.history[state.cursor-1]):'Back to Terminal')+
    '<div class="h-title"><div class="h-primary '+(['raw','file','diff'].includes(a.kind)?'technical':'')+'">'+e(title(a))+'</div>'+
    '<button type="button" class="h-secondary" data-action="stack" aria-label="Navigation stack, '+e(subtitle)+'">'+icon('layers',12)+'<span class="h-path">'+e(subtitle)+'</span>'+icon('down',10)+'</button></div>'+
    btn(action,symbol,primary)+btn('more','more','More actions');
}
function row(ic,label,meta,action,arg,extra=''){return '<button type="button" class="row-item" data-action="'+action+'" '+(arg?'data-id="'+e(arg)+'"':'')+'><span class="row-icon">'+icon(ic,17)+'</span><span class="row-text"><span class="row-label">'+e(label)+'</span>'+(meta?'<span class="row-meta">'+e(meta)+'</span>':'')+'</span>'+(extra?'<span class="row-extra">'+e(extra)+'</span>':'')+'<span class="row-arrow">'+icon('chevron',16)+'</span></button>';}
function section(ic,label,desc,contents,shaded=false){return '<section class="surface '+(shaded?'shaded':'')+'"><div class="surface-head"><span class="surface-icon">'+icon(ic)+'</span><div class="head-copy"><div class="head-title">'+e(label)+'</div>'+(desc?'<div class="head-sub">'+e(desc)+'</div>':'')+'</div></div>'+contents+'</section>';}
function kicker(name,more){return '<div class="kicker"><span>'+e(name)+'</span>'+(more?'<button data-action="browse">Browse all '+icon('chevron',11)+'</button>':'')+'</div>';}
function facts(items){return '<div class="detail-facts">'+items.map(([k,v])=>'<div class="fact"><span class="key">'+e(k)+'</span><span class="value">'+e(v)+'</span></div>').join('')+'</div>';}
function emptyView(kind){return '<section class="surface"><div class="empty-block">'+icon(kind==='error'?'alert':'folder',26)+'<strong>'+(kind==='error'?'Resource unavailable':'Nothing here yet')+'</strong><p>'+(kind==='error'?'This mock fixture cannot read this resource. You can return or retry.':'No items in this resource group. Choose another resource from Browse.')+'</p><button type="button" class="secondary-button" data-action="'+(kind==='error'?'retry':'browse')+'">'+(kind==='error'?'Retry':'Browse resources')+'</button></div></section>';}
function activity(){return '<div class="pill"><span class="dot"></span> Idle · Read only</div>';}
function renderClaude(a){
  switch(a.kind){
  case 'root':return '<div class="surface main-surface">'+
    '<div class="surface-head"><span class="surface-icon">'+icon('bot')+'</span><div class="head-copy"><div class="head-title">Current conversation</div><div class="head-sub">Nession workspace design · synthetic sample</div></div>'+activity()+'</div>'+
    '<div class="conversation"><div class="message user"><div class="who">'+icon('file',13)+' Request</div><p>统一 App Workspace 的布局和交互，让能力共享同一套体验。</p></div>'+
    '<div class="message assistant"><div class="who">'+icon('bot',13)+' Claude · Transcript sample</div><p>我检查了 Workspace 的交互所有权。现在 Header 和内容布局分属不同层，推荐由 App Host 统一维护页面深度。</p><div class="tool-inline">'+icon('check')+'<span>Read · docs/design/interaction/app.md</span><b>Complete</b></div><p>页面主区应该让当前工作主导，辅助资源按需展示。</p><div class="code-block">App Experience\n  └─ Workspace Host\n      ├─ Stack Header\n      ├─ Content Surface\n      └─ Capability Capsule</div><p>资源入口不应该用五个顶部 Tab 占据空间。</p></div></div></div>'+
    kicker('Continue exploring',true)+section('list','Recent resources','Contextual, not a permanent top tab bar',
      '<div class="surface-body p0">'+row('file','Transcripts','2 recent session records','push','transcripts')+
      row('memory','Memory','Project and user context','push','memory')+'</div>')+
    '<p class="note">Other Claude resources are available in the Header Browse menu. The conversation remains the primary work surface.</p>';
  case 'conversations':return section('bot','Conversations','Session-bound history',
      '<div class="surface-body p0">'+row('bot','Workspace design session','Active · latest','push','transcript')+row('bot','E2E audit discussion','Previous conversation','push','transcript')+'</div>');
  case 'transcripts':return section('list','Transcripts','Recent observed records in current Session',
      '<div class="surface-body p0">'+row('file','2026-11-19 · Workspace layout','12 entries · current Session','push','transcript')+
      row('file','2026-11-18 · CI review','8 entries · previous','push','transcript')+'</div>');
  case 'transcript':return section('file','Session transcript','Read-only entries · complete record list',
    '<div class="surface-body p0">'+row('bot','Assistant message','Analysis of workspace layout','push','record')+
    row('terminal','Tool invocation','Read docs/design/interaction/app.md','push','record')+
    row('file','Tool result','Source excerpt · raw available','push','record')+'</div>');
  case 'record':return section('file','Tool result','Item 03 · 2026-11-19 08:12',
    facts([['Role','tool_result'],['Status','Completed'],['Type','text'],['Origin','Session transcript']])+
    '<div class="surface-body"><div class="code-block">{"type":"tool_result","content":"layout contract"}</div>'+
    '<div class="action-strip"><button class="secondary-button" data-action="push" data-id="raw">'+icon('code')+' View raw JSON</button></div></div>');
  case 'raw':return section('code','Raw event','Full unrecognized fields preserved',
    '<div class="surface-body"><pre class="code-block" data-swipe-owner tabindex="0">{\n  "type": "tool_result",\n  "session_id": "mock-session",\n  "timestamp": "2026-11-19T08:12:00Z",\n  "content": {\n    "kind": "text",\n    "text": "layout contract"\n  },\n  "unknown_field": { "retained": true }\n}</pre></div>');
  case 'memory':return section('memory','Memory','Current Session context',
    '<div class="surface-body"><p class="hero-title">Workspace principles</p><p class="note">Extensions provide capability. Nession owns the experience.</p><div class="tool-inline">'+icon('file')+'<span>MEMORY.md · read-only fixture</span></div></div>');
  case 'mcp':return section('link','MCP servers','Current agent configuration',
    '<div class="surface-body p0">'+row('check','nession','Connected · 12 tools','push','config')+
    row('link','context7','Connected · 3 tools','push','config')+'</div>');
  case 'config':return section('settings','Configuration','Scoped to the current Claude session',facts([['Model','Default'],['Permissions','Ask before operations'],['MCP','2 connections'],['Environment','Session-owned']]));
  default:return emptyView('empty');
 }}
function renderGit(a){
  if(a.kind==='root')return '<section class="surface main-surface"><div class="surface-head"><span class="surface-icon">'+icon('git')+'</span><div class="head-copy"><div class="head-title">Working tree</div><div class="head-sub">BestNathan / nession · main</div></div>'+activity()+'</div><div class="stat-grid">'+
    '<div class="stat"><strong>4</strong><span>Modified</span></div><div class="stat"><strong>2</strong><span>Staged</span></div><div class="stat"><strong>1</strong><span>Untracked</span></div></div></section>'+
    kicker('Local changes',false)+section('files','Staged changes','Ready for commit',
      '<div class="surface-body p0">'+row('file','AppPageHeader.tsx','Modified · +34 −9','push','diff')+
      row('file','workspaceContext.ts','Modified · +18 −3','push','diff')+'</div>')+
      section('files','Unstaged changes','Working directory',
      '<div class="surface-body p0">'+row('file','AppLayers.tsx','Modified · +42 −11','push','diff')+
      row('file','workspaceLayout.tsx','Modified · +12 −5','push','diff')+'</div>')+
      '<p class="note">History, Branches and GitHub live in Browse, not parallel nested top tabs.</p>';
  if(a.kind==='diff')return section('code','Diff','web/src/app/patterns/AppPageHeader.tsx',
    '<div class="surface-body p0"><div class="editor" data-swipe-owner>'+
      '<div class="editor-line"><span class="ln">1</span><span class="src">export function AppPageHeader() {</span></div>'+
      '<div class="editor-line del"><span class="ln">2</span><span class="src">-  return &lt;h1&gt;Workspace&lt;/h1&gt;</span></div>'+
      '<div class="editor-line add"><span class="ln">3</span><span class="src">+  return &lt;StackHeader /&gt;</span></div>'+
      '<div class="editor-line"><span class="ln">4</span><span class="src">}</span></div></div></div>');
  if(a.kind==='history')return section('clock','Recent commits','Repository history',
    '<div class="surface-body p0">'+row('commit','Improve App navigation','e82d1c · 2 hours ago','push','diff')+
    row('commit','Fix layout consistency','ab182c · yesterday','push','diff')+'</div>');
  if(a.kind==='branches')return section('branch','Branches','Repository branches',
    '<div class="surface-body p0">'+row('git','main','Current branch','push','history')+
    row('git','staging','Integration branch','push','history')+'</div>');
  if(a.kind==='github')return section('link','GitHub','Read-only repository context',facts([['Repository','BestNathan/nession'],['Pull requests','3 open (mock)'],['Issues','12 open (mock)']]));
  return emptyView('empty');
}
function renderSandbox(a){
  if(a.kind==='root')return '<section class="surface main-surface"><div class="surface-head"><span class="surface-icon">'+icon('shield')+'</span><div class="head-copy"><div class="head-title">Execution environment</div><div class="head-sub">Current Session · Agent-owned runtime</div></div><span class="pill">Configured</span></div>'+
    facts([['Runtime','Host'],['Filesystem','EROFS + writable mounts'],['Workspace','/workspace']])+'</section>'+
    kicker('Environment structure',false)+section('folder','Filesystem','Rootfs, mounts and workspace',
      '<div class="surface-body p0">'+row('folder','Rootfs & mounts','Read-only image · writable layers','push','filesystem')+'</div>')+
    section('shield','Policies','Capability-based isolation',
      '<div class="surface-body p0">'+row('settings','Resource policy','linux_namespace · network · filesystem','push','policy')+'</div>')+
    '<p class="note">Management content is grouped into purpose-built surfaces; the root is not a wall of settings.</p>';
  if(a.kind==='filesystem')return section('folder','Filesystem','Session-scoped mount composition',
    '<div class="surface-body p0">'+row('folder','Rootfs','/ · host runtime','push','mounts')+
    row('files','Mounts','2 EROFS images','push','mounts')+
    row('folder','Workspace','/workspace · writable','push','mounts')+'</div>');
  if(a.kind==='mounts')return section('folder','Mount details','Readonly lower + writable upper',
    facts([['Mount point','/workspace'],['Lower','EROFS image'],['Upper','Session-owned overlay'],['State','Ready']]));
  if(a.kind==='policy')return section('settings','Resource policy','Controls are named for their capabilities',
    '<div class="field-list"><div class="field"><label>Linux namespaces</label><div class="value-field">Enabled '+icon('check',15)+'</div><div class="hint">Session isolation capability</div></div>'+
    '<div class="field"><label>Filesystem access</label><div class="value-field">Workspace read / write '+icon('chevron',15)+'</div></div>'+
    '<div class="field"><label>Network</label><div class="value-field">Restricted '+icon('chevron',15)+'</div></div></div>');
  return emptyView('empty');
}
function renderFiles(a){
  if(a.kind==='root'||a.kind==='folder')return '<section class="surface main-surface"><div class="surface-head"><span class="surface-icon">'+icon('folder')+'</span><div class="head-copy"><div class="head-title">'+(a.kind==='root'?'Workspace files':'components')+'</div><div class="head-sub">/workspace/nession/'+(a.kind==='folder'?'web/src/app':'')+'</div></div></div>'+
    '<div class="surface-body p0">'+row('folder','web','Source directory','push','folder')+
    row('file','AppPageHeader.tsx','TypeScript React · 1.6 KB','push','file')+
    row('file','workspaceContext.ts','TypeScript · 3.2 KB','push','file')+'</div></section>'+
    '<p class="note">Files owns its directory and editor semantics. Nession owns the App header, scroll area and leave behavior.</p>';
  if(a.kind==='file')return section('code','AppPageHeader.tsx','TypeScript React · read-only viewer',
    '<div class="surface-body p0"><div class="editor" data-swipe-owner>'+[
    'import { cn } from "@/shared/lib/utils";','',
    'export function AppPageHeader({ title }) {','  return (','    <header className="app-header">','      <h1>{title}</h1>','    </header>','  );','}'
    ].map((l,i)=>'<div class="editor-line"><span class="ln">'+(i+1)+'</span><span class="src">'+e(l)+'</span></div>').join('')+
    '</div><div class="surface-body"><div class="action-strip"><button class="primary-button" data-action="push" data-id="edit">'+icon('edit')+' Edit file</button></div></div></div>');
  if(a.kind==='edit')return section('edit','Edit file','AppPageHeader.tsx · local mock draft',
    '<div class="field-list"><div class="field"><label for="editor-input">File contents</label>'+
    '<textarea id="editor-input" data-swipe-owner spellcheck="false" style="width:100%;height:226px;resize:vertical;padding:12px;border:1px solid var(--nession-border);border-radius:9px;font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace">'+e(state.editorValue)+'</textarea>'+
    '<div class="hint">Edit and try Header Back, swipe Pop or Capability switch. Nothing is written to disk.</div></div>'+
    '<div class="action-strip"><button class="primary-button" data-action="save">'+icon('save')+' Save mock draft</button></div></div>');
  return emptyView('empty');
}
function content(){let a=active();if(state.fixture==='empty'&&a.kind!=='edit')return emptyView('empty');
  if(state.fixture==='error'&&a.kind!=='edit')return emptyView('error');
  return ({claude:renderClaude,git:renderGit,sandbox:renderSandbox,files:renderFiles})[state.cap](a);}
const resourceMap={claude:[['WORK','bot','Conversations','conversations'],['WORK','list','Transcripts','transcripts'],['RESOURCES','memory','Memory','memory'],['RESOURCES','link','MCP','mcp'],['SETUP','settings','Configuration','config']],
 git:[['REPOSITORY','files','Changes','root'],['REPOSITORY','clock','History','history'],['REPOSITORY','branch','Branches','branches'],['HOSTING','link','GitHub','github']],
 sandbox:[['EXECUTION','shield','Overview','root'],['EXECUTION','folder','Filesystem','filesystem'],['EXECUTION','settings','Policies','policy'],['RESOURCES','files','Mounts','mounts']],
 files:[['FILES','folder','Directory','root'],['FILES','file','AppPageHeader.tsx','file']]};
function sheetRow(ic,label,meta,action,id){return row(ic,label,meta,action,id);}
function overlayHtml(){
 if(state.overlay==='browse'){let old='';
 return '<div class="sheet" role="dialog" aria-modal="true" aria-label="Browse capability resources"><div class="sheet-grab"></div><div class="sheet-head"><strong>Browse '+e(capNames[state.cap])+'</strong>'+btn('close','close','Close browse')+'</div><div class="sheet-scroll">'+
 resourceMap[state.cap].map(([group,ic,label,id])=>{let g=group!==old;old=group;return (g?'<div class="group-name">'+e(group)+'</div>':'')+sheetRow(ic,label,'Open resource','resource',id);}).join('')+'</div></div>';
 }
 if(state.overlay==='stack'){return '<div class="sheet" role="dialog" aria-modal="true" aria-label="Navigation stack"><div class="sheet-grab"></div><div class="sheet-head"><strong>Navigation stack</strong>'+btn('close','close','Close stack')+'</div><div class="sheet-scroll"><div class="group-name">CURRENT PATH</div>'+
    state.history.slice(0,state.cursor+1).map((r,i)=>sheetRow(i===0?'grid':'layers',title(r),i===state.cursor?'Current location':'Jump to this level','ancestor',String(i))).join('')+'</div></div>';}
 if(state.overlay==='more')return '<div class="sheet" role="dialog" aria-modal="true" aria-label="More actions"><div class="sheet-grab"></div><div class="sheet-head"><strong>More actions</strong>'+btn('close','close','Close more actions')+'</div><div class="sheet-scroll">'+
   sheetRow('refresh','Refresh','Refresh local mock view','refresh','')+
   sheetRow('copy','Copy resource reference','Copy the simulated resource reference','copy','')+
   sheetRow('layers','Navigation stack','Jump to an ancestor level','stack','')+'</div></div>';
 if(state.overlay==='guard')return '<div class="sheet" role="alertdialog" aria-modal="true" aria-label="Unsaved changes"><div class="sheet-grab"></div><div class="dialog-sheet">'+icon('alert',25)+
   '<h3>Discard unsaved changes?</h3><p>Your local draft has changed. Leaving this editor would discard it. Cancel to keep editing.</p>'+
   '<div class="dialog-actions"><button class="secondary-button" data-action="guard-cancel">Keep editing</button><button class="primary-button" data-action="guard-discard">Discard &amp; leave</button></div></div></div>';
 return '';}
function renderOverlay(){const o=$('#app-overlay');if(state.overlay){o.hidden=false;o.innerHTML=overlayHtml();const initial=o.querySelector('[data-action="close"],[data-action="guard-cancel"]');if(initial)initial.focus({preventScroll:true});}else{o.hidden=true;o.innerHTML='';}}
function closeOverlay(){state.overlay=null;state.pending=null;renderOverlay();}
function renderTerminal(){
 const term=$('#terminal');term.hidden=state.surface==='workspace';$('#workspace').hidden=state.surface!=='workspace';
 if(state.surface==='terminal')term.innerHTML='<div class="term-top"><strong>'+e(fakeSession())+'</strong><span class="pill">Connected</span></div>'+
   '<div class="term-body"><span class="dim">nession @ workspace</span>\n$ git status --short\n M web/src/app/patterns/AppPageHeader.tsx\n M web/src/app/experiences/app/AppLayers.tsx\n\n$ echo "Active Session"\nActive Session\n\n<span class="dim">Terminal is the persistent work surface.</span>\n<span class="dim">Open Workspace to inspect context.</span>\n\n$ ▍</div>'+
   '<div class="term-composer"><div class="term-field">Ask Nession…</div><button data-action="open-workspace" aria-label="Open Workspace" title="Open Workspace">'+icon('layers')+'</button></div>';
 if(state.surface==='sessions')term.innerHTML='<div class="term-top"><strong>Sessions</strong><button class="h-action" data-action="open-terminal" aria-label="Back to Terminal">'+icon('close')+'</button></div>'+
   '<div style="padding:22px">'+section('terminal','Current Sessions','Pick a work session',
      '<div class="surface-body p0">'+row('terminal','nession-dev','Active · local Agent','open-terminal','')+
      row('terminal','staging-build','Recent · remote Agent','open-terminal','')+'</div>')+'</div>';
}
function render(message='Rendered'){
  const body=$('#app-content');if(state.surface==='workspace'){
    $('#app-header').innerHTML=head();
    body.innerHTML=content();body.scrollTop=Math.max(0,active().scroll||0);
    $('#capsule-zone').innerHTML='<nav class="cap-capsule" aria-label="Workspace capabilities">'+
      Object.entries(capNames).map(([k,n])=>'<button class="cap-item '+(state.cap===k?'active':'')+'" data-action="cap" data-id="'+k+'" aria-label="Open '+n+'" aria-pressed="'+(state.cap===k)+'">'+icon(k,17)+'<span class="cap-name">'+e(k==='claude'?'Claude':n)+'</span></button>').join('')+'</nav>';
  }else{$('#app-header').innerHTML='';body.innerHTML='';}
  renderTerminal();renderOverlay();
  const p=$('#page-frame');p.style.transform='';p.style.transition='';
  $('#workspace-underlay').style.opacity='0';
  record(message);
}
function openOverlay(which){state.overlay=which;renderOverlay();record('Open '+which+' sheet');}
function handle(action,id){
  if(Date.now()<suppressClicksUntil)return;
  switch(action){
    case 'back':pop();break;
    case 'browse':openOverlay('browse');break;
    case 'stack':openOverlay('stack');break;
    case 'more':openOverlay('more');break;
    case 'close':closeOverlay();record('Close sheet');break;
    case 'push':push({kind:id});break;
    case 'resource':closeOverlay();if(id==='root'){navigate({type:'ancestor',index:0});}else navigate({type:'browse',route:id});break;
    case 'ancestor':closeOverlay();navigate({type:'ancestor',index:Number(id)});break;
    case 'cap':navigate({type:'cap',cap:id});break;
    case 'refresh':closeOverlay();toast('Mock view refreshed');record('Refresh');break;
    case 'retry':state.fixture='normal';updateReviewFixtures();render('Retry mock source');break;
    case 'copy': { closeOverlay(); const reference='mock://nession/'+state.cap+'/'+active().kind; record('Copy mock reference'); if(typeof navigator!=='undefined'&&navigator.clipboard?.writeText){navigator.clipboard.writeText(reference).then(()=>toast('Mock reference copied')).catch(()=>toast('Clipboard unavailable in preview'));} else {toast('Clipboard unavailable in preview');} break; }
    case 'save':state.dirty=false;state.editorValue=$('#editor-input')?.value??state.editorValue;toast('Mock draft saved locally');record('Mock draft saved');break;
    case 'guard-cancel':closeOverlay();record('Guard cancelled');break;
    case 'guard-discard':{const op=state.pending;state.dirty=false;state.editorValue='// App workspace header\nexport const title = "Workspace";\n';closeOverlay();if(op)commitNav(op);break;}
    case 'open-workspace':enterWorkspace();break;
    case 'open-terminal':state.surface='terminal';render('Back to Terminal');break;
    default:break;
  }
}
$('#product').addEventListener('click',(ev)=>{
 if(ev.target=== $('#app-overlay')){if(state.overlay!=='guard')closeOverlay();return;}
 const b=ev.target.closest('button[data-action]');if(!b)return;
 ev.preventDefault();handle(b.dataset.action,b.dataset.id||'');
});
$('#product').addEventListener('input',ev=>{
 if(ev.target.id==='editor-input'){state.dirty=ev.target.value!=='// App workspace header\nexport const title = "Workspace";\n';record('Edit mock file');}
});
document.querySelectorAll('[data-fixture]').forEach(b=>b.addEventListener('click',()=>{
 const v=b.dataset.fixture;
 if(v==='terminal'){navigate({type:'terminal'});return;}
 if(v==='session'){state.sessionNo=state.sessionNo===1?2:1;state.history=[root()];state.cursor=0;state.cap='claude';state.dirty=false;state.fixture='normal';state.overlay=null;render('Session context invalidated');updateReviewFixtures();return;}
 state.fixture=v;state.overlay=null;render('Fixture: '+v);updateReviewFixtures();
}));
function updateReviewFixtures(){document.querySelectorAll('[data-fixture]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.fixture===state.fixture)));}
document.addEventListener('keydown',ev=>{
 if(ev.key==='Escape'&&state.overlay){ev.preventDefault();if(state.overlay!=='guard')closeOverlay();return;}
 if(ev.altKey&&ev.key==='ArrowLeft'){ev.preventDefault();if(!state.overlay)pop();}
 if(ev.altKey&&ev.key==='ArrowRight'&&!state.overlay&&state.cursor<state.history.length-1){ev.preventDefault();navigate({type:'forward'});}
});
/* One-contact gesture router; the mock only claims horizontal drags in its own content canvas.
 * The real product will reuse #2724's shell-owned arbitration and platform edge guards. */
const gestureExclusion='button,input,textarea,select,a,[role="dialog"],[contenteditable="true"],[data-swipe-owner],.row-item,.cap-capsule,.editor,.code-block';
function targetAt(ev){const el=ev.target;return el instanceof Element?el:el.parentElement;}
function point(ev){return ev.changedTouches?ev.changedTouches[0]:ev;}
function begin(ev,kind){
 if(state.surface!=='workspace'||state.overlay||move)return;
 if(kind==='touch'&&ev.touches.length!==1)return;
 if(kind==='pointer'&&ev.pointerType!=='mouse')return;
 const t=targetAt(ev);if(!t||!t.closest('#app-content')||t.closest(gestureExclusion))return;
 const pt=point(ev);const bounds=$('#product').getBoundingClientRect();
 // Outer 18px remains platform owned. The meaningful body is otherwise gesture-enabled.
 if(pt.clientX<bounds.left+18||pt.clientX>bounds.right-18)return;
 move={kind,id:kind==='touch'?pt.identifier:ev.pointerId,x:pt.clientX,y:pt.clientY,
   lastX:pt.clientX,lastY:pt.clientY,start:Date.now(),phase:'candidate',dx:0,dir:null};
}
function motion(ev,kind){
 if(!move||move.kind!==kind)return;
 if(kind==='touch'&&ev.touches.length!==1){cancelSwipe();return;}
 const pt=kind==='touch'?[...ev.changedTouches].find(t=>t.identifier===move.id):ev;
 if(!pt)return;
 const dx=pt.clientX-move.x,dy=pt.clientY-move.y;
 if(move.phase==='candidate'){
   if(Math.max(Math.abs(dx),Math.abs(dy))<14)return;
   if(Math.abs(dy)>Math.abs(dx)*.85){cancelSwipe();return;}
   if(Math.abs(dx)<Math.abs(dy)*1.25)return;
   const allow=dx>0?(state.cursor>0||state.surface==='workspace'):(state.cursor<state.history.length-1);
   move.phase=allow?'navigate':'resist';move.dir=dx>0?'right':'left';
 }
 if(move.dir&&(dx>0?'right':'left')!==move.dir)return;
 if(kind==='touch'&&ev.cancelable&&move.phase==='navigate')ev.preventDefault();
 move.dx=dx;move.lastX=pt.clientX;move.lastY=pt.clientY;
 const amt=move.phase==='navigate'?Math.max(-125,Math.min(125,dx)):(dx>0?Math.min(18,dx/7):Math.max(-18,dx/7));
 const frame=$('#page-frame');frame.style.transition='none';frame.style.transform='translateX('+amt+'px)';
 const u=$('#workspace-underlay');u.style.opacity=String(Math.min(.95,Math.abs(amt)/110));
 u.innerHTML='<div class="under-icon">'+icon(move.dir==='right'?'back':'forward',25)+'</div>'+
   '<div class="under-label">'+(move.phase==='resist'?'No forward destination':move.dir==='right'?(state.cursor>0?'Previous resource':'Terminal'):'Forward resource')+'</div>'+
   '<div class="under-sub">Release to '+(move.phase==='resist'?'cancel':'navigate')+'</div>';
 record('Swipe '+move.phase+' '+Math.round(dx)+'px');
}
function settle(ev,kind){
 if(!move||move.kind!==kind)return;
 const pt=kind==='touch'?[...ev.changedTouches].find(t=>t.identifier===move.id):ev;if(!pt)return;
 const m=move;move=null;
 const valid=m.phase==='navigate'&&Math.abs(m.dx)>75&&Math.sign(m.dx)===(m.dir==='right'?1:-1);
 const frame=$('#page-frame');
 frame.style.transition='transform .18s ease';frame.style.transform='';
 $('#workspace-underlay').style.opacity='0';
 if(valid){suppressClicksUntil=Date.now()+220;const op=m.dir==='right'?{type:'pop'}:{type:'forward'};setTimeout(()=>{navigate(op);},130);}
 else {record('Swipe cancelled / snap back');setTimeout(()=>{frame.style.transition='';},200);}
}
function cancelSwipe(){if(move){move=null;$('#page-frame').style.transform='';$('#workspace-underlay').style.opacity='0';record('Swipe yielded to content');}}
const prod=$('#product');
prod.addEventListener('touchstart',ev=>begin(ev,'touch'),{passive:true});
prod.addEventListener('touchmove',ev=>motion(ev,'touch'),{passive:false});
prod.addEventListener('touchend',ev=>settle(ev,'touch'),{passive:true});
prod.addEventListener('touchcancel',cancelSwipe,{passive:true});
prod.addEventListener('pointerdown',ev=>begin(ev,'pointer'));
prod.addEventListener('pointermove',ev=>motion(ev,'pointer'));
prod.addEventListener('pointerup',ev=>settle(ev,'pointer'));
prod.addEventListener('pointercancel',cancelSwipe);
$('#review').addEventListener('np:resize',ev=>{if(ev.detail&&ev.detail.width){prod.dataset.previewWidth=ev.detail.width;record('Viewport: '+ev.detail.width);}});
render('Default · Claude current conversation');
})();
