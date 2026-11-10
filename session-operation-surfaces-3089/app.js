/* Public-safe deterministic product interaction prototype for Nession Issue #3089. No API calls. */
(() => {
  'use strict';
  const product = document.getElementById('nession-product');
  const root = document.querySelector('[data-np-root]');
  const device = document.querySelector('[data-np-device]');
  if (!product || !root || !device) return;

  const s = {
    experience: 'web', width: 1440, page: 'project', depth: null, modal: null,
    scenario: 'normal', mode: 'auto', configureFrom: null, projectContext: true,
    sessionName: 'feature-review', projectName: 'Nession', editedProjectName: 'Nession',
    projectDescription:'', sourceUrl:'', sourceRef:'', imageDigest:'',
    draftDescription:'', draftSourceUrl:'', draftSourceRef:'', draftImageDigest:'', projectDraftLocations:[],
    locations: [
      {agent:'Build Agent',path:'/srv/workspaces/nession',online:true},
      {agent:'Test Agent',path:'/workspaces/nession-test',online:true}
    ],
    location: 0, env: new Set(['.env.development']), activeSession: 'dev-session',
    status: '', error: '', copyStatus:'', selectedAddress:0, locationOpen:false, envQuery:''
  };
  const paths = ['wss://agent.example.test:8443/ws/session', 'wss://relay.example.test/attach'];
  const longPath = '/srv/workspaces/nession/infrastructure/experiments/agent-workspaces/very-long-nested-source-root/feature-branches/session-runtime';
  const longAddress = 'wss://gateway-01.example.test:8443/nession/connection/candidate/sessions/dev-session/long-readable-address/endpoint';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isApp = () => s.experience === 'app';
  const isOffline = () => s.scenario === 'offline';
  const location = idx => s.locations[idx];
  const visiblePath = path => s.scenario === 'long' ? longPath : path;
  const addr = idx => s.scenario === 'long' ? longAddress : paths[idx];
  const button = (label, action, variant = '', extra = '') => '<button type="button" class="btn '+variant+'" data-act="'+action+'" '+extra+'>'+label+'</button>';
  const region = (title, body) => '<div class="stack"><div class="section-label">'+title+'</div>'+body+'</div>';
  /* #3137 ConfigurationForm: named sections own the form rhythm. */
  const formSection = (title, body, help, action) => '<section class="form-section"><div class="form-section-head"><h3>'+title+'</h3>'+(help?'<p class="form-help">'+help+'</p>':'')+'</div>'+(action?'<div class="form-section-action">'+action+'</div>':'')+body+'</section>';
  const envFiles = [
    {name:'.env.development', source:'server', count:14},
    {name:'.env.local', source:'agent:build-agent', count:7},
    {name:'.env.test', source:'server', count:3}
  ];
  // Source anatomy: ProjectLocationDetails. Only the selected Web trigger and
  // App location rows carry status; Web SelectItem options are Agent + path.
  function projectLocation(idx, showStatus = true) {
    const loc = location(idx);
    if (!loc) return '<span class="location-details"><span class="location-agent">Select a location</span></span>';
    const offline = isOffline() && idx === 0;
    return '<span class="location-details"><span class="location-agent">'+esc(loc.agent)+'</span>'+
      '<span class="location-path">'+esc(visiblePath(loc.path))+'</span>'+
      (showStatus ? '<span class="location-status '+(offline?'offline-chip':'muted')+'">'+(offline?'Agent offline':'Agent online')+'</span>' : '')+
      '</span>';
  }
  function locationSelector() {
    return '<button type="button" class="app-select-row app-location-row" data-act="choose-location">'+
      '<span class="app-location-value">'+projectLocation(s.location)+'</span>'+
      '<span class="app-chevron" aria-hidden="true">›</span></button>';
  }
  function webLocationSelector() {
    if (!s.locations.length) return '<div class="form-empty">No Existing Location. Add an Agent directory in Project settings.</div>';
    const trigger = '<button type="button" class="location-trigger" data-location-trigger data-act="toggle-location" aria-haspopup="listbox" aria-controls="project-location-options" aria-expanded="'+s.locationOpen+'">'+
      '<span class="location-trigger-text">'+projectLocation(s.location,true)+'</span>'+
      '<span class="location-chevron" aria-hidden="true">'+(s.locationOpen?'⌃':'⌄')+'</span></button>';
    const options = s.locationOpen ? '<div class="location-options" id="project-location-options" role="listbox" aria-label="Existing Location">'+s.locations.map((loc,i)=>
      '<button type="button" class="location-option '+(i===s.location?'current':'')+'" role="option" aria-selected="'+(i===s.location)+'" data-location-option data-act="select-location" data-idx="'+i+'">'+
        projectLocation(i,false)+'<span class="location-item-check" aria-hidden="true">'+(i===s.location?'✓':'')+'</span></button>'
    ).join('')+'</div>' : '';
    return '<div class="location-combobox" data-location-combobox>'+trigger+options+'</div>';
  }
  function envSelector() {
    const names=envFiles.filter(f=>s.env.has(f.name)).map(f=>f.name);
    const summary=names.length ? names.join(', ') : 'Optional · None selected';
    return '<button type="button" class="app-select-row app-env-row" data-act="choose-env">'+
      '<span class="app-env-summary">'+esc(summary)+'</span><span class="app-chevron" aria-hidden="true">›</span></button>';
  }
  // Source anatomy: EnvFileMultiSelect — 32px search, independently scrolling
  // 224px Web list, 16px selection marks, file icon, source badge and var count.
  function envMultiSelect(scroll = true) {
    const q=s.envQuery.trim().toLowerCase();
    const filtered=envFiles.filter(f=>!q||f.name.toLowerCase().includes(q)||f.source.toLowerCase().includes(q));
    const rows=filtered.map(f=> {
      const selected=s.env.has(f.name);
      return '<button type="button" class="env-file-row '+(selected?'is-selected':'')+'" data-act="toggle-env" data-env-name="'+esc(f.name)+'" aria-pressed="'+selected+'">'+
        '<span class="env-check-box '+(selected?'is-checked':'')+'" aria-hidden="true">'+(selected?'✓':'')+'</span>'+
        '<span class="env-file-icon" aria-hidden="true">▤</span>'+
        '<span class="env-file-label">'+esc(f.name)+'</span>'+
        '<span class="env-source-badge">'+esc(f.source)+'</span>'+
        '<span class="env-var-count">'+f.count+' var'+(f.count===1?'':'s')+'</span></button>';
    }).join('');
    return '<div class="env-multi" data-env-multi>'+
      '<label class="env-search"><span class="env-search-icon" aria-hidden="true">⌕</span>'+
      '<input type="search" name="envQuery" placeholder="Search env files…" value="'+esc(s.envQuery)+'" autocomplete="off" aria-label="Search env files"></label>'+
      '<div class="env-file-list '+(scroll?'env-scroll':'env-unscrolled')+'" role="group" aria-label="Environment files">'+
      (rows||'<p class="env-no-files">'+(envFiles.length?'No files match your search':'No env files — create one in Env Files')+'</p>')+
      '</div>'+
      (s.env.size?'<p class="env-selected-count">'+s.env.size+' file'+(s.env.size===1?'':'s')+' selected</p>':'')+
      '</div>';
  }
  function createFields(app) {
    const locations = s.projectContext
      ? '<div class="field"><span class="label">Existing Location</span>'+(app?locationSelector():webLocationSelector())+'</div>'
      : '<div class="field"><span class="label">Agent</span>'+(app?locationSelector():'<button type="button" class="location-trigger" aria-label="Agent selection">'+projectLocation(s.location,false)+'</button>')+'</div>';
    const name = '<label class="field"><span class="label">Session Name</span><input type="text" name="sessionName" maxlength="90" placeholder="my-session" value="'+esc(s.sessionName)+'" autocomplete="off"></label>';
    const env = app
      ? '<div class="field"><span class="label">Environment files</span>'+envSelector()+'</div>'
      : '<div class="field"><span class="label">Env Files (optional)</span>'+envMultiSelect(true)+'</div>';
    return '<div class="dialog-form" data-form="new-session">'+(app?name+locations+env:locations+name+env)+(s.error?'<p class="error" role="alert">'+esc(s.error)+'</p>':'')+'</div>';
  }
  function attachModes(app) {
    const modes = [
      ['auto','Auto','Test routes; prefer fastest, fall back to Relay'],
      ['p2p','P2P','Connect directly to a reachable Agent'],
      ['relay','Relay','Route traffic through the server']
    ];
    return '<div class="'+(app?'stack':'mode-grid')+'" style="gap:9px">'+modes.map(([value,title,hint])=>
      '<button class="choice '+(s.mode===value?'selected':'')+'" data-act="select-mode" data-value="'+value+'"><span class="radio"></span><span class="choice-body"><strong>'+title+'</strong><span class="muted twelve">'+hint+'</span></span></button>').join('')+'</div>';
  }
  function attachPaths() {
    return region('Available paths',
      '<div class="row between"><span class="muted twelve">Choose a candidate or leave Auto selected</span>'+button('↻ Re-test','retest','ghost')+'</div>'+
      '<div class="stack" style="gap:9px">'+
      [0,1].map(i=>'<div class="card stack" style="gap:7px"><div class="row between"><strong class="twelve">'+(i===0?'Direct / private network':'Relay endpoint')+'</strong><span class="pill">'+(i===0?'12 ms':'48 ms')+'</span></div><div class="mono path" tabindex="0">'+esc(addr(i))+'</div><div class="row between"><span class="tiny '+(isOffline()?'offline-chip':'success')+'">'+(isOffline()?'Agent unreachable':'Reachable')+'</span>'+button('Copy full address','copy-address','ghost','data-idx="'+i+'"')+'</div></div>').join('')+'</div>'+
      (s.copyStatus?'<div class="muted tiny" role="status">'+esc(s.copyStatus)+'</div>':'')
    );
  }
  function projectFields(app) {
    const locations = s.projectDraftLocations;
    const rows = locations.length ? '<div class="locations-stack">'+locations.map((loc,i)=>
      '<div class="location-editor" data-location-editor="'+i+'">'+
      '<label class="field"><span class="label">Agent</span><select name="agent-'+i+'" aria-label="Agent '+(i+1)+'"><option'+(loc.agent==='Build Agent'?' selected':'')+'>Build Agent</option><option'+(loc.agent==='Test Agent'?' selected':'')+'>Test Agent</option></select></label>'+
      '<label class="field"><span class="label">Directory</span><textarea class="project-path-input" aria-label="Directory '+(i+1)+'" name="directory-'+i+'" rows="1" placeholder="/workspace/project">'+esc(loc.path)+'</textarea></label>'+
      button(app?'Remove':'×','remove-location','ghost remove-location','data-idx="'+i+'" aria-label="Remove Existing Location '+(i+1)+'"')+
      '</div>').join('')+'</div>' :
      '<p class="form-empty">No Existing Locations. You can create a Project now and add one later.</p>';
    return '<div class="dialog-form" data-form="new-project">'+
      formSection('Identity',
        '<label class="field"><span class="label">Name</span><input name="projectName" maxlength="72" value="'+esc(s.editedProjectName)+'" placeholder="Nession" autocomplete="off"></label>'+
        '<label class="field"><span class="label">Description (optional)</span><textarea name="projectDescription" rows="2" placeholder="What is this Project for?">'+esc(s.draftDescription)+'</textarea></label>')+
      formSection('Git source',
        '<div class="source-fields">'+
          '<label class="field"><span class="label">Git repository URL (optional)</span><input name="repositoryUrl" value="'+esc(s.draftSourceUrl)+'" placeholder="https://github.com/owner/repo.git" autocomplete="off"></label>'+
          '<label class="field"><span class="label">Branch or full commit SHA</span><input name="repositoryRef" value="'+esc(s.draftSourceRef)+'" placeholder="main" '+(!s.draftSourceUrl.trim()?'disabled':'')+' autocomplete="off"></label>'+
        '</div>','Optional. The Project declares the source; the Session checks it out.')+
      formSection('Existing Locations', rows, 'Optional. Agent directories this Project can start Sessions from.', button('＋ Add Location','add-location','ghost'))+
      formSection('Image',
        '<label class="field"><span class="label">Image digest reference (optional)</span><input name="imageDigest" value="'+esc(s.draftImageDigest)+'" placeholder="sha256:…"><span class="form-help">A reference only. The Project never owns image bytes.</span></label>')+
      (s.error?'<p class="error" role="alert">'+esc(s.error)+'</p>':'')+'</div>';
  }
  function terminal() {
    return '<div class="terminal"><div class="muted tiny">Session / '+esc(s.activeSession)+'</div><div style="margin-top:22px"><span class="prompt">$</span> cd /workspace</div><div><span class="prompt">$</span> git status --short</div><div class="muted">On branch main · working tree clean</div><div><span class="prompt">$</span> <span class="cursor"></span></div><div class="terminal-capsule">＋ &nbsp; Ask Nession about this Session…</div></div>';
  }
  function projectDetail(inApp = false) {
    const heading = inApp ? '' : '<div class="section-label">Project</div><h1>'+esc(s.projectName)+'</h1>';
    return '<div class="project-detail"><div class="project-banner"><div>'+heading+'<div class="muted twelve">Source · '+esc(s.sourceUrl || 'not configured')+'</div></div>'+button('Settings','project-settings','')+'</div>'+
      '<div class="line"></div><div class="row between"><div><strong>Existing locations</strong><div class="muted twelve">Existing Agent workspace directories</div></div>'+button('New Session','create-project-session','primary')+'</div>'+
      '<div class="two-cols">'+s.locations.map((l,i)=>'<div class="card stack"><strong>'+esc(l.agent)+'</strong><div class="mono path">'+esc(visiblePath(l.path))+'</div><span class="muted tiny"><span class="dot '+(isOffline()&&i===0?'offline':'')+'"></span>'+(isOffline()&&i===0?'Offline':'Online')+'</span></div>').join('')+'</div>'+
      '<div class="card stack"><strong class="twelve">Project defaults</strong><div class="muted twelve">Shell · bash &nbsp; · &nbsp; Environment · optional</div></div></div>';
  }
  function webSidebar(){
    return '<aside class="web-sidebar"><div class="brand"><span class="brand-symbol">N</span> nession</div>'+
      '<div class="navgroup"><div class="navtitle">Sessions</div>'+
      '<div class="row"><button class="navrow grow" data-act="show-terminal"><span class="name">▣ &nbsp;'+esc(s.activeSession)+'</span></button><button class="btn ghost" data-act="session-menu" aria-label="Session actions">···</button></div>'+
      '<button class="navrow nav-create" data-act="create-ordinary-session"><span class="nav-icon" aria-hidden="true">＋</span><span>New Session</span></button></div>'+
      '<div class="navgroup"><div class="navtitle">Projects</div><button class="navrow '+(s.page==='project'?'current':'')+'" data-act="show-project"><span class="name">◇ &nbsp;'+esc(s.projectName)+'</span></button><button class="navrow nav-create" data-act="project-create"><span class="nav-icon" aria-hidden="true">＋</span><span>New Project</span></button></div>'+
      '<div style="margin-top:auto" class="muted twelve">Agents · 2 configured</div></aside>';
  }
  function webShell() {
    const inProject = s.page === 'project';
    return webSidebar()+'<div class="web-main"><div class="web-top"><span>'+ (inProject ? 'Projects / '+esc(s.projectName) : 'Sessions / '+esc(s.activeSession))+'</span>'+button('＋ New Session',inProject?'create-project-session':'create-ordinary-session','ghost')+'</div>'+
      (inProject?'<div class="work-zone">'+projectDetail()+'</div>':terminal())+'</div>';
  }
  function appHeader(title,back,secondary) {
    return '<header class="app-header">'+(back?'<button class="btn ghost" data-act="'+back+'" aria-label="Back" style="padding:8px 11px">‹</button>':'')+
      '<h1>'+esc(title)+'</h1>'+(secondary||'')+'</header>';
  }
  function appSessions() {
    return appHeader('Sessions','show-terminal',button('＋','create-ordinary-session','ghost','aria-label="New Session"'))+
      '<div class="app-contents"><div class="app-list-title">Today</div>'+
      '<div class="app-list-item"><button class="grow" style="text-align:left;border:0;background:none;padding:0" data-act="show-terminal"><strong>'+esc(s.activeSession)+'</strong><small>Shell · Build Agent</small></button>'+button('···','session-menu','ghost','aria-label="Session actions"')+'</div>'+
      '<div class="row between"><div class="app-list-title">Projects</div>'+button('＋','project-create','ghost','aria-label="Create Project"')+'</div><button class="app-list-item" data-act="show-project"><span><strong>'+esc(s.projectName)+'</strong><small>'+s.locations.length+' existing locations</small></span><span>›</span></button>'+
      '<div class="app-list-title">Agents</div><div class="muted twelve" style="padding:10px">Build Agent · '+(isOffline()?'offline':'online')+'</div></div>'+
      '<nav class="app-bottom" aria-label="App navigation"><button class="selected-tab">Sessions</button><button data-act="show-terminal">Terminal →</button></nav>';
  }
  function appProject() {
    return appHeader(s.projectName,'show-sessions')+
      '<div class="app-contents">'+projectDetail(true)+'</div>';
  }
  function appTerminal() {
    return appHeader(s.activeSession,'show-sessions',button('···','session-menu','ghost'))+terminal();
  }
  function appShell() {
    return '<div class="app-shell">'+(s.page==='project'?appProject():s.page==='terminal'?appTerminal():appSessions())+'</div>';
  }
  function webDialog(title,body,footer,max){
    return '<div class="veil" data-act="dismiss-overlay"><section class="web-dialog" role="dialog" aria-modal="true" aria-label="'+esc(title)+'" style="--dialog-max:'+max+'px" data-stop="true"><header class="dialog-head"><h2>'+esc(title)+'</h2>'+button('✕','cancel','ghost','aria-label="Close"')+'</header><div class="dialog-body">'+body+'</div><footer class="dialog-footer">'+footer+'</footer></section></div>';
  }
  function appFull(title,body,foot,back) {
    return '<section class="app-overlay app-operation" role="dialog" aria-modal="true" aria-label="'+esc(title)+'">'+appHeader(title,back)+
      '<div class="app-contents scroll-region">'+body+'</div><footer class="app-cta">'+foot+'</footer></section>';
  }
  function appSheet(title,body,foot){
    return '<div class="app-sheet-veil" data-act="dismiss-overlay"><section class="app-sheet" role="dialog" aria-modal="true" aria-label="'+esc(title)+'" data-stop="true"><div class="sheet-grip"></div><div class="sheet-top"><strong class="title">'+esc(title)+'</strong>'+button('✕','cancel','ghost','aria-label="Close"')+'</div><div class="sheet-content">'+body+'</div><div class="sheet-footer">'+foot+'</div></section></div>';
  }
  function renderOverlay() {
    const kind = isApp()?s.depth:s.modal;
    if (!kind) return '';
    const offlineMsg = isOffline()?'<div class="error" role="alert">Build Agent is offline. Try again when the Agent reconnects.</div>':'';
    if(kind==='session-menu') {
      const body='<div class="stack">'+button('Attach Session','open-attach','')+button('Attach settings','open-configure','')+'</div>';
      return isApp()?appSheet('Session actions',body,button('Cancel','cancel','')):webDialog('Session actions',body,button('Cancel','cancel',''),350);
    }
    if(kind==='attach-quick') {
      return appSheet('Attach Session',
        '<div class="stack"><div><strong>'+esc(s.activeSession)+'</strong><div class="muted twelve">Build Agent</div></div>'+
        '<div class="card stack"><div class="row between"><strong class="twelve">'+(s.mode==='auto'?'Automatic connection':s.mode==='p2p'?'Direct P2P connection':'Relay connection')+'</strong><span class="success">✓</span></div><div class="muted twelve">'+(s.mode==='auto'?'Choose fastest reachable path; Relay fallback.':s.mode==='p2p'?'Connect directly to the selected Agent.':'Connect through the Server relay.')+'</div></div>'+
        '<button class="app-select-row" data-act="attach-advanced"><span class="path-detail"><strong>Connection settings</strong><span>›</span></span><span class="muted twelve">Auto · P2P · Relay · Candidate paths</span></button>'+offlineMsg+'</div>',
        button('Attach','attach-submit','primary',isOffline()?'disabled':'')
      );
    }
    if(kind==='attach-config' || kind==='attach') {
      const title=s.configureFrom==='direct'?'Attach settings':'Connection settings';
      const body='<div class="stack">'+region('Connection mode',attachModes(isApp()))+attachPaths()+offlineMsg+(s.error?'<p class="error" role="alert">'+esc(s.error)+'</p>':'')+'</div>';
      const saving=s.configureFrom==='direct';
      const foot=button(saving?'Save settings':'Use this mode','attach-config-submit','primary',isOffline()?'disabled':'');
      return isApp()?appFull(title,body,foot,'attach-back'):webDialog(saving?'Attach settings':'Attach Session',body,button('Cancel','cancel','')+button(saving?'Save settings':'Attach','attach-config-submit','primary',isOffline()?'disabled':''),720);
    }
    if(kind==='create-session') {
      const body=createFields(isApp());
      const foot=button('Create Session','create-submit','primary',(isOffline()||(s.projectContext&&!s.locations.length))?'disabled':'');
      return isApp()?appFull('New Session',body,foot,'cancel'):webDialog(s.projectContext?'Create Session in '+s.projectName:'Create Session',body,button('Cancel','cancel','')+foot,640);
    }
    if(kind==='choose-location') {
      const body='<div class="stack">'+s.locations.map((loc,i)=>'<button class="choice '+(s.location===i?'selected':'')+'" data-act="select-child-location" data-idx="'+i+'"><span class="radio"></span>'+projectLocation(i)+'</button>').join('')+'</div>';
      return appFull('Existing location',body,button('Done','child-back','primary'),'child-back');
    }
    if(kind==='choose-env') {
      return appFull('Environment files',envMultiSelect(false),button('Done','child-back','primary'),'child-back');
    }
    if(kind==='project-create' || kind==='project-settings'){
      const creating=kind==='project-create';
      const title=creating?'New Project':'Project settings';
      const body=projectFields(isApp());
      const save=button(creating?'Create Project':'Save changes','project-submit','primary');
      return isApp()?appFull(title,body,save,'cancel'):webDialog(title,body,button('Cancel','cancel','')+save,720);
    }
    return '';
  }
  function render() {
    product.setAttribute('data-experience',s.experience);
    product.innerHTML=(isApp()?appShell():webShell())+renderOverlay()+(s.status?'<div class="toast" role="status">'+esc(s.status)+'</div>':'');
    const inspector=document.getElementById('state-inspector');
    if(inspector) inspector.textContent=JSON.stringify({experience:s.experience,width:s.width,page:s.page,operation:isApp()?s.depth:s.modal,scenario:s.scenario,attachMode:s.mode,configureOrigin:s.configureFrom,projectContext:s.projectContext,location:s.location,projectDraftLocations:s.projectDraftLocations,env:[...s.env],draftSessionName:s.sessionName,activeSession:s.activeSession,status:s.status,error:s.error},null,2);
  }
  function showOperation(kind){
    s.error='';s.copyStatus='';s.status='';s.locationOpen=false;
    if(isApp()) s.depth=kind;else s.modal=kind;
    render();
  }
  function cancel(){
    s.depth=null;s.modal=null;s.error='';s.status='';s.configureFrom=null;s.locationOpen=false;render();
  }
  function submitCreate(){
    if(!s.sessionName.trim()){s.error='Enter a Session name.';render();return;}
    if(s.projectContext&&!s.locations.length){s.error='Add an Existing Location in Project settings first.';render();return;}
    if(isOffline()){s.error='Build Agent is offline.';render();return;}
    s.activeSession=s.sessionName.trim();s.page='terminal';s.depth=null;s.modal=null;s.error='';
    s.status='Session created · '+s.activeSession;render();
  }
  function confirmAttach(){
    if(isOffline()){s.error='Build Agent is offline.';render();return;}
    const save=s.configureFrom==='direct';
    const toQuick=isApp() && s.configureFrom==='quick' && s.depth==='attach-config';
    s.depth=toQuick?'attach-quick':null;s.modal=null;s.error='';
    s.page=save||toQuick?s.page:'terminal';
    s.status=save?'Connection preference saved · Session not attached':toQuick?'Connection mode selected · confirm Attach':'Attached · '+s.activeSession+' · '+s.mode;
    if(!toQuick)s.configureFrom=null;
    render();
  }
  function action(kind,el){
    s.status='';s.copyStatus='';
    const idx=Number(el.dataset.idx||0);
    switch(kind){
      case 'show-terminal':s.page='terminal';cancel();break;
      case 'show-project':s.page='project';cancel();break;
      case 'show-sessions':s.page='sessions';cancel();break;
      case 'session-menu':showOperation('session-menu');break;
      case 'open-attach':s.configureFrom='quick';showOperation(isApp()?'attach-quick':'attach');break;
      case 'open-configure':s.configureFrom='direct';showOperation('attach-config');break;
      case 'attach-advanced':s.configureFrom='quick';showOperation('attach-config');break;
      case 'select-mode':s.mode=el.dataset.value||'auto';render();break;
      case 'retest':s.copyStatus='Simulated connection probe completed.';render();break;
      case 'copy-address':{
        const path=addr(idx);
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(path).then(()=>{s.copyStatus='Full address copied.';render();},()=>{s.copyStatus='Clipboard unavailable. Select the visible full address to copy.';render();});
        } else {s.copyStatus='Clipboard unavailable. Select the visible full address to copy.';render();}
        break;
      }
      case 'attach-back':if(s.configureFrom==='quick'&&isApp()){s.depth='attach-quick';s.error='';render();}else cancel();break;
      case 'attach-submit':case 'attach-config-submit':confirmAttach();break;
      case 'create-ordinary-session':s.projectContext=false;s.sessionName='new-session';showOperation('create-session');break;
      case 'create-project-session':s.projectContext=true;s.sessionName='feature-review';showOperation('create-session');break;
      case 'toggle-location':
        s.locationOpen=!s.locationOpen;render();
        (s.locationOpen ? product.querySelector('[data-location-option][aria-selected="true"]') : product.querySelector('[data-location-trigger]'))?.focus();
        break;
      case 'select-location':
        s.location=idx;s.locationOpen=false;render();
        product.querySelector('[data-location-trigger]')?.focus();
        break;
      case 'choose-location':showOperation('choose-location');break;
      case 'choose-env':s.envQuery='';showOperation('choose-env');break;
      case 'toggle-env':{
        const name=el.dataset.envName||'';
        if(s.env.has(name))s.env.delete(name);else s.env.add(name);
        render();break;
      }
      case 'select-child-location':s.location=idx;render();break;
      case 'child-back':s.depth='create-session';render();break;
      case 'create-submit':submitCreate();break;
      case 'project-create':
        s.editedProjectName='';s.draftDescription='';s.draftSourceUrl='';s.draftSourceRef='';s.draftImageDigest='';
        s.projectDraftLocations=[];showOperation('project-create');break;
      case 'project-settings':
        s.editedProjectName=s.projectName;s.draftDescription=s.projectDescription;
        s.draftSourceUrl=s.sourceUrl;s.draftSourceRef=s.sourceRef;s.draftImageDigest=s.imageDigest;
        s.projectDraftLocations=s.locations.map(x=>({...x}));showOperation('project-settings');break;
      case 'add-location':
        s.projectDraftLocations.push({agent:'Build Agent',path:''});render();break;
      case 'remove-location':
        s.projectDraftLocations.splice(idx,1);render();break;
      case 'project-submit':
        if(!s.editedProjectName.trim()){s.error='Enter a Project name.';render();return;}
        s.projectName=s.editedProjectName.trim();s.projectDescription=s.draftDescription;
        s.sourceUrl=s.draftSourceUrl;s.sourceRef=s.draftSourceRef;s.imageDigest=s.draftImageDigest;
        s.locations=s.projectDraftLocations.map(x=>({...x}));
        s.location=Math.min(s.location,Math.max(0,s.locations.length-1));
        s.page='project';s.depth=null;s.modal=null;s.error='';s.status='Project saved · '+s.projectName;render();break;
      case 'dismiss-overlay':case 'cancel':cancel();break;
      default:break;
    }
  }
  product.addEventListener('click',ev=>{
    const target=ev.target;
    if(!(target instanceof Element))return;
    const act=target.closest('[data-act]');
    if(!act)return;
    if(act.dataset.act==='dismiss-overlay' && target.closest('[data-stop]'))return;
    if(act===target || !target.closest('[data-stop]') || act.dataset.act!=='dismiss-overlay')action(act.dataset.act,act);
  });
  product.addEventListener('change',ev=>{
    const el=ev.target;
    if(el instanceof HTMLSelectElement && el.name.startsWith('agent-')){
      const idx=Number(el.name.split('-')[1]);
      if(s.projectDraftLocations[idx])s.projectDraftLocations[idx].agent=el.value;
    }
  });
  product.addEventListener('input',ev=>{
    const el=ev.target;
    if(!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement))return;
    if(el.name==='sessionName')s.sessionName=el.value;
    else if(el.name==='envQuery'){
      s.envQuery=el.value;const caret=el.selectionStart;
      render();const search=product.querySelector('[name="envQuery"]');
      if(search){search.focus();try{search.setSelectionRange(caret,caret);}catch{}}
    }
    else if(el.name==='projectName')s.editedProjectName=el.value;
    else if(el.name==='projectDescription')s.draftDescription=el.value;
    else if(el.name==='repositoryUrl'){
      s.draftSourceUrl=el.value;
      const input=product.querySelector('[name="repositoryRef"]');
      if(input)input.disabled=!el.value.trim();
    }
    else if(el.name==='repositoryRef')s.draftSourceRef=el.value;
    else if(el.name==='imageDigest')s.draftImageDigest=el.value;
    else if(el.name.startsWith('agent-')){const idx=Number(el.name.split('-')[1]);if(s.projectDraftLocations[idx])s.projectDraftLocations[idx].agent=el.value;}
    else if(el.name.startsWith('directory-')){const idx=Number(el.name.split('-')[1]);if(s.projectDraftLocations[idx])s.projectDraftLocations[idx].path=el.value;}

  });
  document.addEventListener('keydown',ev=>{
    if(s.locationOpen && ev.key==='Escape'){
      ev.preventDefault();s.locationOpen=false;render();
      product.querySelector('[data-location-trigger]')?.focus();return;
    }
    const focused=ev.target;
    if(s.locationOpen && focused instanceof Element && focused.matches('[data-location-option]') && (ev.key==='ArrowDown'||ev.key==='ArrowUp')){
      ev.preventDefault();
      const options=[...product.querySelectorAll('[data-location-option]')];
      const next=(options.indexOf(focused)+(ev.key==='ArrowDown'?1:-1)+options.length)%options.length;
      options[next]?.focus();return;
    }
    if(ev.key==='Escape'&&(s.depth||s.modal)){
    ev.preventDefault();
    if(s.depth==='choose-location'||s.depth==='choose-env')action('child-back',product);
    else if(s.depth==='attach-config'&&s.configureFrom==='quick')action('attach-back',product);
    else cancel();
  }});
  root.addEventListener('np:resize',ev=>{
    const selected=[...root.querySelectorAll('[data-np-size]')].find(x=>x.getAttribute('aria-pressed')==='true');
    const experience=selected?.dataset.npExperience||(ev.detail.width<=500?'app':'web');
    s.experience=experience;s.width=ev.detail.width;
    device.style.setProperty('--np-device-height',ev.detail.width===844&&experience==='app'?'390px':experience==='app'?(ev.detail.width===375?'812px':ev.detail.width===430?'932px':'844px'):'900px');
    s.depth=null;s.modal=null;s.error='';s.status='';s.locationOpen=false;
    s.page=experience==='app'?'sessions':'project';
    render();
  });
  root.querySelectorAll('[data-fixture]').forEach(btn=>btn.addEventListener('click',()=>{
    root.querySelectorAll('[data-fixture]').forEach(x=>x.setAttribute('aria-pressed',String(x===btn)));
    s.scenario=btn.dataset.fixture||'normal';s.error='';s.status='';s.locationOpen=false;render();
  }));
  render();
})();