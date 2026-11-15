/* Nession #3649: local, deterministic product mock. No network, credentials or ENV values. */
(() => {
  'use strict';
  const catalog = ['common.env', 'development.env', 'claude.env', 'production.env'];
  const state = {
    viewport: 1180, view: 'project', operation: null,
    defaults: ['common.env', 'development.env'], draft: [],
    unavailable: false, selectionMode: 'inherit', custom: ['claude.env'],
    sessionName: '', sessions: [], current: -1, error: '', notice: ''
  };
  const root = document.getElementById('product');
  const device = document.querySelector('[data-np-device]');
  const inspector = document.getElementById('debug');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
  const isAvailable = name => catalog.includes(name) && !(state.unavailable && name === 'development.env');
  const effective = () => state.selectionMode === 'inherit' ? [...state.defaults] :
    state.selectionMode === 'custom' ? [...state.custom] : [];
  const fileName = name => esc(name) + (isAvailable(name) ? '' : ' · missing');
  const fileList = (files, editing) => files.length
    ? files.map((name, i) => `
      <div class="file-row" data-testid="env-row">
        <span aria-hidden="true">◫</span>
        <span class="file-text"><strong>${esc(name)}</strong><span class="muted tiny">Server ENV · position ${i+1}</span></span>
        ${isAvailable(name) ? '' : '<span class="badge warn">Missing</span>'}
        ${editing ? `<span class="file-tools">
          <button type="button" class="btn icon" aria-label="Move ${esc(name)} up" data-action="move" data-index="${i}" data-delta="-1" ${i===0?'disabled':''}>↑</button>
          <button type="button" class="btn icon" aria-label="Move ${esc(name)} down" data-action="move" data-index="${i}" data-delta="1" ${i===files.length-1?'disabled':''}>↓</button>
          <button type="button" class="btn icon negative" aria-label="Remove ${esc(name)}" data-action="remove" data-index="${i}">×</button>
        </span>` : ''}
      </div>`).join('')
    : '<div class="empty" data-testid="env-empty">No default ENV profiles selected.</div>';
  const sidebar = () => `<aside class="sidebar" aria-label="Web navigation">
    <div class="sidebar-title"><span>◈ &nbsp; Nession</span><span class="muted">☰</span></div>
    <div class="sidebar-label">Sessions</div>
    <div class="sidebar-list" data-testid="web-sessions">${state.sessions.length
      ? state.sessions.map((s,i)=>`<button class="nav-item ${state.view==='session'&&state.current===i?'active':''}" data-action="session" data-index="${i}">▤ <span class="grow">${esc(s.name)}</span></button>`).join('')
      : '<span class="muted small" style="padding:8px">No Sessions yet</span>'}</div>
    <div class="sidebar-label">Projects</div>
    <div class="sidebar-list"><button class="nav-item ${state.view==='project'?'active':''}" data-action="project">▧ <span class="grow">Nession</span></button></div>
    <div class="sidebar-foot">Agent · linux-dev · online</div>
  </aside>`;
  const appHome = () => `<div class="page app-home" data-testid="app-sessions"><h1>Sessions</h1>
    <div class="section"><div class="section-head"><h2>Recent Sessions</h2></div>
    ${state.sessions.length ? state.sessions.map((s,i)=>`<button class="nav-item" data-action="session" data-index="${i}">▤ &nbsp; ${esc(s.name)}</button>`).join('') : '<div class="empty">No Sessions yet</div>'}</div>
    <div class="section"><div class="section-head"><h2>Projects</h2></div>
      <button class="nav-item" data-action="project">▧ &nbsp; Nession <span class="grow"></span><span class="muted">›</span></button></div></div>`;
  const detail = () => `<div class="page" data-testid="project-detail">
    <div class="crumb">Projects / Nession</div>
    <div class="headline">
      <div><h1>Nession</h1><p class="lead">Work declaration · Existing Location / Agent linux-dev</p></div>
      <div class="row"><button class="btn" data-action="settings">Settings</button><button class="btn primary" data-action="create">+ Create Session</button></div>
    </div>
    ${state.notice ? `<div class="notice success" role="status">${esc(state.notice)}</div>` : ''}
    <div class="section"><div class="section-head"><h2>Source &amp; location</h2></div>
      <div class="facts"><div class="fact"><span class="fact-label">Git source</span><span class="mono">github.com/example/nession · main</span></div>
        <div class="fact"><span class="fact-label">Existing Location</span><span class="mono">linux-dev · /workspace/nession</span></div></div>
    </div>
    <div class="section"><div class="section-head"><h2>Session defaults</h2><button class="btn quiet" data-action="settings">Edit defaults</button></div>
      <div class="facts"><div class="fact"><span class="fact-label">Shell</span><span class="mono">Unset</span></div>
      <div class="fact"><span class="fact-label">ENV profiles</span><div data-testid="project-default-env">
        ${fileList(state.defaults,false)}
        <p class="muted tiny" style="margin-top:8px">Applied only when creating a new Session. Existing Session Binding is unaffected.</p></div></div>
        <div class="fact"><span class="fact-label">Sandbox policy</span><span class="mono">Unset</span></div></div>
    </div>
    <div class="section"><div class="section-head"><h2>Related Sessions</h2></div>
      ${state.sessions.length ? state.sessions.map((s,i)=>`<div class="file-row"><span class="file-text"><strong>${esc(s.name)}</strong><span class="muted tiny">Binding revision ${s.revision} · ${s.profiles.length} ENV files</span></span><button class="btn" data-action="session" data-index="${i}">Open</button></div>`).join('') : '<div class="empty">Create a Session to start work in this Project.</div>'}
    </div></div>`;
  const sessionDetail = () => {
    const s = state.sessions[state.current];
    if (!s) {state.view='project';return detail();}
    return `<div class="page" data-testid="session-detail">
      <div class="crumb">Sessions / ${esc(s.name)}</div>
      <div class="headline"><div><h1>${esc(s.name)}</h1><p class="lead">Project · Nession · Agent linux-dev</p></div>
        <button class="btn" data-action="project">Open Project</button></div>
      <div class="notice success" role="status">Session created. Its Environment Binding belongs to this Session, not the Project.</div>
      <div class="section"><div class="section-head"><h2>Environment Binding</h2><span class="badge success">Desired revision ${s.revision}</span></div>
        ${s.profiles.length?fileList(s.profiles,false):'<div class="empty" data-testid="session-no-env">No environment bound — explicit empty selection.</div>'}
        <p class="muted small" style="margin-top:12px">Selection at creation: ${s.source==='inherit'?'Project defaults':s.source==='none'?'No environment':'Custom replacement'}. This mock does not simulate shell convergence.</p>
      </div>
      <div class="section"><div class="section-head"><h2>Continue working</h2></div>
        <div class="notice"><span class="mono">$ terminal session connected (simulated)</span><p class="muted tiny">Navigate back to Project and update defaults, then verify this Binding stays unchanged.</p></div>
        <button style="margin-top:12px" class="btn" data-action="create">Create another Session</button>
      </div></div>`;
  };
  const settings = () => `<form data-form="settings" class="operation" aria-label="Project settings">
    <div class="operation-head"><h2>Project settings</h2><p class="muted small">Session defaults</p></div>
    <div class="operation-body">
      <div class="form-section"><h3>Identity</h3><div class="field"><label>Name</label><input value="Nession" disabled><div class="field-help">Identity is outside this prototype's change scope.</div></div></div>
      <div class="form-section"><h3>Default Environment</h3>
        <p class="muted small" style="margin-bottom:13px">Ordered Server ENV references for newly created Sessions. Later files win on duplicate variable names.</p>
        <div data-testid="settings-default-list">${fileList(state.draft,true)}</div>
        <div class="field" style="margin-top:12px"><label for="add-default-env">Add Server ENV</label>
          <select id="add-default-env" data-change="add-default"><option value="">Choose ENV file…</option>
          ${catalog.filter(n=>!state.draft.includes(n)).map(n=>`<option value="${esc(n)}">${fileName(n)}</option>`).join('')}</select></div>
        <p class="field-help" style="margin-top:10px">Changing Project defaults never rebinds an existing Session. ENV contents are not displayed.</p>
      </div>
      <div class="form-section"><h3>Other defaults</h3><p class="muted small">Shell · Unset &nbsp; / &nbsp; Sandbox policy · Unset (preserved)</p></div>
    </div>
    <div class="operation-footer"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary" data-testid="settings-save">Save defaults</button></div>
  </form>`;
  const create = () => {
    const list = effective();
    return `<form data-form="create" class="operation" aria-label="Create Session">
      <div class="operation-head"><h2>Create Session in “Nession”</h2><p class="muted small">Existing location · linux-dev /workspace/nession</p></div>
      <div class="operation-body">
        <div class="field"><label for="session-name">Session Name</label><input id="session-name" name="name" maxlength="64" autocomplete="off" placeholder="my-session" value="${esc(state.sessionName)}" data-input="name" required>
          <span class="field-help">Agent: linux-dev · /workspace/nession</span></div>
        <div class="form-section"><h3>Environment</h3>
          <div class="choice ${state.selectionMode==='inherit'?'active':''}"><input type="radio" name="env-mode" id="mode-inherit" value="inherit" ${state.selectionMode==='inherit'?'checked':''}><label for="mode-inherit"><strong>Use Project defaults</strong><span>Automatically inherit the Project's current ordered ENV references.</span></label></div>
          <div class="choice ${state.selectionMode==='custom'?'active':''}"><input type="radio" name="env-mode" id="mode-custom" value="custom" ${state.selectionMode==='custom'?'checked':''}><label for="mode-custom"><strong>Custom ENV selection</strong><span>Replace Project defaults with only the files selected below.</span></label></div>
          <div class="choice ${state.selectionMode==='none'?'active':''}"><input type="radio" name="env-mode" id="mode-none" value="none" ${state.selectionMode==='none'?'checked':''}><label for="mode-none"><strong>No environment</strong><span>Explicitly bind zero ENV files, even when the Project has defaults.</span></label></div>
          ${state.selectionMode==='custom'?`<div class="form-section"><h3>Custom profiles</h3><div class="options-grid">
            ${catalog.map(n=>`<label class="option-check"><input type="checkbox" data-custom="${esc(n)}" ${state.custom.includes(n)?'checked':''}><span>${fileName(n)}</span></label>`).join('')}</div>
            <p class="field-help" style="margin-top:9px">Checked order: ${state.custom.map(esc).join(' → ')||'none'}. Selection order controls precedence.</p></div>`:''}
        </div>
        <div class="form-section"><div class="section-head"><h3>Effective Session Binding</h3><span class="badge">${state.selectionMode==='inherit'?'From Project':state.selectionMode==='none'?'Explicit empty':'Explicit replacement'}</span></div>
          ${list.length?fileList(list,false):'<div class="empty" data-testid="effective-empty">No ENV files will be bound to this Session.</div>'}
          <p class="field-help" style="margin-top:10px">The Server resolves snapshots at creation. Project changes later do not update the Session.</p>
        </div>
        ${state.error?`<div class="notice error" role="alert" style="margin-top:14px">${esc(state.error)}</div>`:''}
      </div>
      <div class="operation-footer"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary" data-testid="session-create-confirm">Create Session</button></div>
    </form>`;
  };
  const currentHeader = () => {
    if (state.operation) return {name:state.operation==='settings'?'Project settings':'Create Session',back:'close'};
    if (state.view==='session')return {name:state.sessions[state.current]?.name||'Session',back:'project'};
    if (state.view==='project')return {name:'Project',back:'home'};
    return {name:'Sessions',back:null};
  };
  const render = () => {
    const app = state.viewport <= 600;
    root.setAttribute('data-mode',app?'app':'web');
    root.setAttribute('data-view',state.view);
    const h = currentHeader();
    const content = state.view==='home' ? appHome() : state.view==='session' ? sessionDetail() : detail();
    root.innerHTML = `${app?'':sidebar()}<main class="main" aria-label="Nession work area">
      ${app?`<header class="app-head" data-testid="app-page-header">
        ${h.back?`<button class="btn quiet icon" data-action="${h.back}" aria-label="Back">‹</button>`:'<span style="width:36px"></span>'}
        <strong>${esc(h.name)}</strong></header>`:''}
      ${app&&state.operation?'':`<div class="main-scroll">${content}</div>`}
      ${state.operation?`<div class="operation-layer" data-testid="operation-layer">${state.operation==='settings'?settings():create()}</div>`:''}
    </main>`;
    inspector.textContent=JSON.stringify({
      viewport:state.viewport,experience:app?'App':'Web',view:state.view,operation:state.operation,
      project:{default_env_profile_ids:state.defaults},create:{env_selection_mode:state.selectionMode==='inherit'?'inherit':'replace',effective_env_files:effective()},
      missing_fixture:state.unavailable,sessions:state.sessions
    },null,2);
  };
  const openOperation = type => {
    state.operation=type;state.error='';state.notice='';
    if(type==='settings')state.draft=[...state.defaults];
    if(type==='create'){state.selectionMode='inherit';state.custom=['claude.env'];state.sessionName='';}
    render();
  };
  const closeOperation = () => {state.operation=null;state.error='';render();};
  root.addEventListener('click', event => {
    const btn=event.target.closest('button[data-action]');
    if(!btn)return;
    const act=btn.dataset.action;
    if(act==='settings'||act==='create'){openOperation(act);return;}
    if(act==='close'){closeOperation();return;}
    if(act==='home'){state.view='home';state.operation=null;render();return;}
    if(act==='project'){state.view='project';state.operation=null;state.notice='';render();return;}
    if(act==='session'){state.current=Number(btn.dataset.index);state.view='session';state.operation=null;render();return;}
    if(act==='move'){
      const i=Number(btn.dataset.index),j=i+Number(btn.dataset.delta);
      if(j>=0&&j<state.draft.length){[state.draft[i],state.draft[j]]=[state.draft[j],state.draft[i]];render();}
      return;
    }
    if(act==='remove'){state.draft.splice(Number(btn.dataset.index),1);render();}
  });
  root.addEventListener('input', event => {
    if(event.target.dataset.input==='name')state.sessionName=event.target.value;
  });
  root.addEventListener('change', event => {
    const e=event.target;
    if(e.name==='env-mode'){state.selectionMode=e.value;state.error='';render();return;}
    if(e.dataset.change==='add-default'&&e.value&&!state.draft.includes(e.value)){state.draft.push(e.value);render();return;}
    if(e.dataset.custom){
      if(e.checked&&!state.custom.includes(e.dataset.custom))state.custom.push(e.dataset.custom);
      if(!e.checked)state.custom=state.custom.filter(x=>x!==e.dataset.custom);
      state.error='';render();
    }
  });
  root.addEventListener('submit', event => {
    const form=event.target.closest('form[data-form]');
    if(!form)return;event.preventDefault();
    if(form.dataset.form==='settings'){
      state.defaults=[...state.draft];state.operation=null;state.notice='Project defaults saved. Existing Session bindings remain unchanged.';
      render();return;
    }
    const name=state.sessionName.trim();
    if(!/^[A-Za-z0-9_.-]+$/.test(name)){state.error='Enter a Session name using letters, digits, dot, underscore or hyphen.';render();return;}
    if(state.sessions.some(s=>s.name===name)){state.error='Session name already exists. Choose another name.';render();return;}
    const profiles=effective();
    const missing=profiles.find(n=>!isAvailable(n));
    if(missing){state.error=`Cannot create Session: ${missing} is unavailable. Resolve the Project default or select a different mode.`;render();return;}
    state.sessions.push({name,profiles:[...profiles],source:state.selectionMode,revision:profiles.length?1:0});
    state.current=state.sessions.length-1;state.operation=null;state.view='session';state.notice='';
    render();
  });
  document.querySelector('#fixture-missing').addEventListener('change',e=>{state.unavailable=e.target.checked;render();});
  document.querySelector('#fixture-empty').addEventListener('click',()=>{
    state.defaults=[];if(state.operation==='settings')state.draft=[];
    state.notice='Project default ENV references cleared (fixture). Existing Sessions preserved.';render();
  });
  device.addEventListener('np:resize', e=>{state.viewport=e.detail.width;if(e.detail.width>600&&state.view==='home')state.view='project';render();});
  render();
})();
