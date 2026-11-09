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
    locations: [
      {agent:'Build Agent',path:'/srv/workspaces/nession',online:true},
      {agent:'Test Agent',path:'/workspaces/nession-test',online:true}
    ],
    location: 0, env: new Set(['.env.development']), activeSession: 'dev-session',
    status: '', error: '', copyStatus:'', selectedAddress:0, locationOpen:false
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
  function projectLocation(idx, selected = false) {
    const loc = location(idx);
    const offline = isOffline() && idx === 0;
    return '<span class="choice-body"><strong>'+esc(loc.agent)+'</strong><span class="mono path">'+esc(visiblePath(loc.path))+'</span><span class="tiny '+(offline ? 'offline-chip' : 'muted')+'"><span class="dot '+(offline ? 'offline' : '')+'"></span>'+(offline?'Offline':'Online')+'</span></span>';
  }
  function locationSelector() {
    return '<button class="app-select-row" data-act="choose-location">'+projectLocation(s.location)+'<span class="tiny muted">Change location →</span></button>';
  }
  // An inline-anchored dropdown keeps the dialog body as the sole vertical
  // scroll owner. Both the selected trigger and menu rows have intrinsic height:
  // a long directory wraps instead of protruding from a 32px Select outline.
  function webLocationSelector() {
    const trigger = '<button type="button" class="location-trigger" data-location-trigger data-act="toggle-location" aria-haspopup="listbox" aria-controls="project-location-options" aria-expanded="'+s.locationOpen+'"><span class="location-trigger-text">'+projectLocation(s.location)+'</span><span class="location-chevron" aria-hidden="true">'+(s.locationOpen?'⌃':'⌄')+'</span></button>';
    const options = s.locationOpen ? '<div class="location-options" id="project-location-options" role="listbox" aria-label="Existing Location">'+s.locations.map((loc,i)=>
      '<button type="button" class="location-option '+(i===s.location?'current':'')+'" role="option" aria-selected="'+(i===s.location)+'" data-location-option data-act="select-location" data-idx="'+i+'">'+projectLocation(i)+'</button>'
    ).join('')+'</div>' : '';
    return '<div class="location-combobox" data-location-combobox>'+trigger+options+'</div>';
  }
  function envSelector() {
    return '<button class="app-select-row" data-act="choose-env"><strong>Environment files</strong><span class="twelve muted">'+(s.env.size ? esc([...s.env].join(', ')) : 'Optional · None selected')+'</span><span class="tiny muted">Manage selection →</span></button>';
  }
  function createFields(app) {
    const name = '<label class="field"><span class="label">Session name</span><input name="sessionName" maxlength="90" placeholder="e.g. feature-review" value="'+esc(s.sessionName)+'" autocomplete="off"></label>';
    const locations = s.projectContext
      ? app ? region('Existing location',locationSelector()) : region('Existing location',webLocationSelector())
      : region('Agent',app?locationSelector():'<button class="choice selected"><span class="radio"></span>'+projectLocation(s.location)+'</button>');
    const env = app ? envSelector() : '<div class="card stack" style="gap:9px"><div class="row between"><strong class="twelve">Environment files</strong><span class="tiny muted">Optional</span></div>'+['.env.development','.env.local','.env.test'].map(x=>'<label class="checkline"><input type="checkbox" name="env" value="'+esc(x)+'" '+(s.env.has(x)?'checked':'')+'>'+esc(x)+'</label>').join('')+'</div>';
    return '<div class="stack">'+name+locations+env+(s.error?'<p class="error" role="alert">'+esc(s.error)+'</p>':'')+'</div>';
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
    return '<div class="stack"><label class="field"><span class="label">Project name</span><input name="projectName" maxlength="72" value="'+esc(s.editedProjectName)+'" placeholder="Project name"></label>'+
      region('Existing Agent locations',
        '<div class="stack">'+s.locations.map((loc,i)=>'<div class="card location-editor"><label class="field"><span class="label">Agent</span><input aria-label="Agent '+(i+1)+'" name="agent-'+i+'" value="'+esc(loc.agent)+'"></label><label class="field"><span class="label">Working directory</span><textarea aria-label="Directory '+(i+1)+'" name="directory-'+i+'" rows="2">'+esc(visiblePath(loc.path))+'</textarea></label>'+button('Remove','remove-location','ghost','data-idx="'+i+'"')+'</div>').join('')+button('＋ Add location','add-location','')+'</div>'
      )+
      (s.error?'<p class="error" role="alert">'+esc(s.error)+'</p>':'')+'</div>';
  }
  function terminal() {
    return '<div class="terminal"><div class="muted tiny">Session / '+esc(s.activeSession)+'</div><div style="margin-top:22px"><span class="prompt">$</span> cd /workspace</div><div><span class="prompt">$</span> git status --short</div><div class="muted">On branch main · working tree clean</div><div><span class="prompt">$</span> <span class="cursor"></span></div><div class="terminal-capsule">＋ &nbsp; Ask Nession about this Session…</div></div>';
  }
  function projectDetail() {
    return '<div class="project-detail"><div class="project-banner"><div><div class="section-label">Project</div><h1>'+esc(s.projectName)+'</h1><div class="muted twelve">Source · github.com/example/nession</div></div>'+button('Settings','project-settings','')+'</div>'+
      '<div class="line"></div><div class="row between"><div><strong>Existing locations</strong><div class="muted twelve">Existing Agent workspace directories</div></div>'+button('New Session','create-project-session','primary')+'</div>'+
      '<div class="two-cols">'+s.locations.map((l,i)=>'<div class="card stack"><strong>'+esc(l.agent)+'</strong><div class="mono path">'+esc(visiblePath(l.path))+'</div><span class="muted tiny"><span class="dot '+(isOffline()&&i===0?'offline':'')+'"></span>'+(isOffline()&&i===0?'Offline':'Online')+'</span></div>').join('')+'</div>'+
      '<div class="card stack"><strong class="twelve">Project defaults</strong><div class="muted twelve">Shell · bash &nbsp; · &nbsp; Environment · optional</div></div></div>';
  }
  function webSidebar(){
    return '<aside class="web-sidebar"><div class="brand"><span class="brand-symbol">N</span> nession</div>'+
      '<div class="navgroup"><div class="navtitle">Sessions</div>'+
      '<div class="row"><button class="navrow grow" data-act="show-terminal"><span class="name">▣ &nbsp;'+esc(s.activeSession)+'</span></button><button class="btn ghost" data-act="session-menu" aria-label="Session actions">···</button></div>'+
      '<button class="navrow" data-act="create-ordinary-session">＋ &nbsp; New Session</button></div>'+
      '<div class="navgroup"><div class="navtitle">Projects</div><button class="navrow '+(s.page==='project'?'current':'')+'" data-act="show-project"><span class="name">◇ &nbsp;'+esc(s.projectName)+'</span></button><button class="navrow" data-act="project-create">＋ &nbsp; New Project</button></div>'+
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
      '<div class="row between"><div class="app-list-title">Projects</div>'+button('＋','project-create','ghost','aria-label="Create Project"')+'</div><button class="app-list-item" data-act="show-project"><span><strong>'+esc(s.projectName)+'</strong><small>2 existing locations</small></span><span>›</span></button>'+
      '<div class="app-list-title">Agents</div><div class="muted twelve" style="padding:10px">Build Agent · '+(isOffline()?'offline':'online')+'</div></div>'+
      '<nav class="app-bottom" aria-label="App navigation"><button class="selected-tab">Sessions</button><button data-act="show-terminal">Terminal →</button></nav>';
  }
  function appProject() {
    return appHeader(s.projectName,'show-sessions')+
      '<div class="app-contents">'+projectDetail()+'</div>';
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
      const body='<div class="stack"><div class="muted twelve">'+(s.projectContext?'Project / '+esc(s.projectName):'Session / No Project')+'</div>'+createFields(isApp())+'</div>';
      const foot=button('Create Session','create-submit','primary',isOffline()?'disabled':'');
      return isApp()?appFull('New Session',body,foot,'cancel'):webDialog(s.projectContext?'Create Session in '+s.projectName:'Create Session',body,button('Cancel','cancel','')+foot,640);
    }
    if(kind==='choose-location') {
      const body='<div class="stack">'+s.locations.map((loc,i)=>'<button class="choice '+(s.location===i?'selected':'')+'" data-act="select-child-location" data-idx="'+i+'"><span class="radio"></span>'+projectLocation(i)+'</button>').join('')+'</div>';
      return appFull('Existing location',body,button('Done','child-back','primary'),'child-back');
    }
    if(kind==='choose-env') {
      const body='<div class="stack"><div class="muted twelve">Select optional environment files</div>'+['.env.development','.env.local','.env.test'].map(env=>'<label class="checkline"><input type="checkbox" name="env" value="'+env+'" '+(s.env.has(env)?'checked':'')+'>'+env+'</label>').join('')+'</div>';
      return appFull('Environment files',body,button('Done','child-back','primary'),'child-back');
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
    if(inspector) inspector.textContent=JSON.stringify({experience:s.experience,width:s.width,page:s.page,operation:isApp()?s.depth:s.modal,scenario:s.scenario,attachMode:s.mode,configureOrigin:s.configureFrom,projectContext:s.projectContext,location:s.location,env:[...s.env],draftSessionName:s.sessionName,activeSession:s.activeSession,status:s.status,error:s.error},null,2);
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
      case 'choose-env':showOperation('choose-env');break;
      case 'select-child-location':s.location=idx;render();break;
      case 'child-back':s.depth='create-session';render();break;
      case 'create-submit':submitCreate();break;
      case 'project-create':s.editedProjectName='';showOperation('project-create');break;
      case 'project-settings':s.editedProjectName=s.projectName;showOperation('project-settings');break;
      case 'add-location':s.locations.push({agent:'New Agent',path:'/workspace/new',online:true});render();break;
      case 'remove-location':s.locations.splice(idx,1);if(!s.locations.length)s.locations.push({agent:'Build Agent',path:'/workspace',online:true});s.location=Math.min(s.location,s.locations.length-1);render();break;
      case 'project-submit':
        if(!s.editedProjectName.trim()){s.error='Enter a Project name.';render();return;}
        s.projectName=s.editedProjectName.trim();s.page='project';s.depth=null;s.modal=null;s.error='';s.status='Project saved · '+s.projectName;render();break;
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
  product.addEventListener('input',ev=>{
    const el=ev.target;
    if(!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))return;
    if(el.name==='sessionName')s.sessionName=el.value;
    else if(el.name==='projectName')s.editedProjectName=el.value;
    else if(el.name.startsWith('agent-')){const idx=Number(el.name.split('-')[1]);if(s.locations[idx])s.locations[idx].agent=el.value;}
    else if(el.name.startsWith('directory-')){const idx=Number(el.name.split('-')[1]);if(s.locations[idx])s.locations[idx].path=el.value;}
    else if(el.name==='env')el.checked?s.env.add(el.value):s.env.delete(el.value);
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