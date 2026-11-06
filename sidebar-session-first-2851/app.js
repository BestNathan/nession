(() => {
  "use strict";
  const q = (id) => document.getElementById(id);
  const fixtures = [
    {id:"sess-01",sessionName:"fix-terminal-reconnect",title:"Fix terminal reconnect",kind:"Claude Code",agent:"devbox-01",group:"Today",state:"active",lines:["nession / session-01","Workspace: /work/demo","Connected to devbox-01","","Latest task: verify terminal continuity","✓ Last command completed"]},
    {id:"sess-02",sessionName:"design-files",title:"Design Files workspace",kind:"shell",agent:"macbook-demo",group:"Today",state:"idle",lines:["nession / session-02","Workspace: /work/files","Git status: clean","","Reviewing file navigator behavior"]},
    {id:"sess-03",sessionName:"sandbox-policy",title:"Sandbox policy review",kind:"shell",agent:"runner-02",group:"Earlier",state:"idle",lines:["nession / session-03","Workspace: /work/sandbox","Policy review in progress"]},
    {id:"sess-04",sessionName:"production-diag",title:"Production diagnostics",kind:"zsh",agent:"runner-02",group:"Earlier",state:"offline",lines:["nession / session-04","Agent unreachable; work remains discoverable","Reconnect to recover the live terminal view."]},
    {id:"sess-05",sessionName:"environment-proposal",title:"Environment proposal",kind:"Claude Code",agent:"devbox-01",group:"Earlier",state:"idle",lines:["nession / session-05","Workspace: /work/env","Proposal ready for review."]}
  ];
  let sessions = fixtures.map(s=>({...s,lines:s.lines.slice()}));
  let selectedId="sess-01", search="", collapsed=false, width=1280, drawerOpen=false, section="sessions", dialog=null, surface="terminal";
  const agents=[{name:"devbox-01",online:true,count:2},{name:"macbook-demo",online:true,count:1},{name:"runner-02",online:false,count:2}];

  const shell=q("n-shell"), sidebar=q("n-sidebar"), list=q("session-list"), input=q("session-search");
  const rowMenu=q("session-row-menu"), actionOverlay=q("session-action-overlay");
  let menuId=null, menuTrigger=null, actionTarget=null;
  const actionItems=[
    {type:"view",label:"Session details",icon:"view"},
    {type:"edit",label:"Edit details",icon:"edit"},
    {type:"settings",label:"Attach settings",icon:"settings"},
    {type:"kill",label:"Kill session",icon:"kill"}
  ];
  const glyph=(name)=>{
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");
    svg.innerHTML=name==="view"
      ? '<circle cx="12" cy="12" r="2.5"/><path d="M2.5 12s3.7-6 9.5-6 9.5 6 9.5 6-3.7 6-9.5 6-9.5-6-9.5-6z"/>'
      : name==="edit"
      ? '<path d="M12 20h9M16.7 3.7l3.6 3.6-11 11-4.7 1.1 1.1-4.7zM14.4 6l3.6 3.6"/>'
      : name==="settings"
      ? '<circle cx="12" cy="12" r="3"/><path d="M9.5 3.8 10.2 2h3.6l.7 1.8 1.9.8 1.8-.8 2.5 2.5-.8 1.8.8 1.9 1.8.7v3.6l-1.8.7-.8 1.9.8 1.8-2.5 2.5-1.8-.8-1.9.8-.7 1.8h-3.6l-.7-1.8-1.9-.8-1.8.8-2.5-2.5.8-1.8-.8-1.9L2 13.8v-3.6l1.8-.7.8-1.9-.8-1.8 2.5-2.5 1.8.8z"/>'
      : '<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6M10 10v7m4-7v7"/>';
    return svg;
  };
  function closeMenu(restoreFocus=false){
    const prior=menuTrigger;
    if(prior?.isConnected)prior.setAttribute("aria-expanded","false");
    menuId=null;menuTrigger=null;rowMenu.hidden=true;rowMenu.replaceChildren();
    if(restoreFocus&&prior?.isConnected)prior.focus();
  }
  function openModal(type,s,origin){
    closeMenu(false);actionTarget=origin;
    actionOverlay.replaceChildren();actionOverlay.hidden=false;
    const cover=element("button","n-action-backdrop");cover.type="button";cover.setAttribute("aria-label","Close dialog");cover.addEventListener("click",closeModal);
    const panel=element("div","n-action-panel");
    panel.setAttribute("role",type==="kill"?"alertdialog":"dialog");panel.setAttribute("aria-modal","true");
    const heading=element("h2","",type==="kill"?"Kill Session":type==="settings"?"Attach settings":type==="edit"?"Edit Session details":"Session details");
    heading.id="n-session-action-heading";panel.setAttribute("aria-labelledby",heading.id);panel.append(heading);
    panel.append(element("p","n-action-description",type==="kill"
      ?"This will terminate session "+(s.sessionName||s.title)+" on "+s.agent+" and cannot be undone."
      :type==="settings"?"Configure attach settings for "+s.title+". Preview only; no backend calls."
      :type==="edit"?"Update the display title, description and tags. The tmux Session name remains unchanged."
      :"Metadata and runtime identity for this Session. This preview uses local fixture data."));
    if(type==="kill"){
      const label=element("label","n-action-label","Type "+(s.sessionName||s.title)+" to confirm");
      const field=element("input","n-action-field");field.type="text";field.autocomplete="off";field.placeholder=s.sessionName||s.title;
      label.append(field);panel.append(label);
      const hint=element("p","n-action-hint","");panel.append(hint);
      const buttons=element("div","n-action-buttons");const confirm=button("Kill Session","n-action-danger",()=>{
        if(field.value.trim()!==(s.sessionName||s.title))return;
        sessions=sessions.filter(v=>v.id!==s.id);
        if(selectedId===s.id)selectedId=sessions[0]?.id||null;
        closeModal();render();
      });confirm.disabled=true;
      field.addEventListener("input",()=>{const valid=field.value.trim()===(s.sessionName||s.title);confirm.disabled=!valid;hint.textContent=field.value&&!valid?"Name doesn't match yet.":"";field.setAttribute("aria-invalid",String(Boolean(field.value&&!valid)));});
      buttons.append(button("Cancel","",closeModal),confirm);panel.append(buttons);
      actionOverlay.append(cover,panel);field.focus();return;
    }
    if(type==="view"||type==="edit"){
      const details=element("div","n-meta-summary");
      const line=(key,value)=>{const item=element("div","n-meta-summary-line");item.append(element("span","",key),element("strong","",value));details.append(item);};
      line("tmux name",s.sessionName||s.title);line("Agent / location",s.agent);
      line("Workload",s.kind);line("Session state",s.state);
      if(type==="view"){
        line("Display title",s.title);
        line("Description",s.description||"No description yet.");
        line("Tags",s.tags?.length?s.tags.join(", "):"No tags");
        panel.append(details);
        const acts=element("div","n-action-buttons");
        acts.append(button("Close","",closeModal),button("Edit details","n-action-primary",()=>openModal("edit",s,actionTarget)));
        panel.append(acts);actionOverlay.append(cover,panel);acts.querySelector("button")?.focus();return;
      }
      if(s.state==="offline"||!agents.find(a=>a.name===s.agent)?.online){
        panel.append(details,element("p","n-action-error","This Agent is offline. Metadata cannot be saved until it is available."));
        const acts=element("div","n-action-buttons");acts.append(button("Close","",closeModal));panel.append(acts);
        actionOverlay.append(cover,panel);acts.querySelector("button")?.focus();return;
      }
      const titleLabel=element("label","n-action-label","Display title");
      const titleInput=element("input","n-action-field");titleInput.type="text";titleInput.value=s.title===s.sessionName?"":s.title;
      titleInput.placeholder=s.sessionName||s.title;titleInput.maxLength=120;
      titleLabel.append(titleInput);
      const help=element("p","n-action-hint","Shown in navigation. The tmux name is not renamed.");
      const descLabel=element("label","n-action-label","Description");
      const descInput=element("textarea","n-action-field n-action-textarea");
      descInput.value=s.description||"";descInput.maxLength=2000;descInput.placeholder="What is this work about?";descLabel.append(descInput);
      const tagsLabel=element("label","n-action-label","Tags");
      const tagsInput=element("input","n-action-field");
      tagsInput.type="text";tagsInput.value=(s.tags||[]).join(", ");tagsInput.placeholder="comma-separated tags";tagsLabel.append(tagsInput);
      const tagsHelp=element("p","n-action-hint","Up to 12 tags, 32 characters each; duplicates are ignored regardless of case.");
      const error=element("p","n-action-error","");error.setAttribute("role","alert");
      const acts=element("div","n-action-buttons");
      const save=button("Save details","n-action-primary",()=>{
        const title=titleInput.value.trim(),description=descInput.value.trim();
        const rawTags=tagsInput.value.split(",").map(x=>x.trim()).filter(Boolean);
        const tags=[...new Map(rawTags.map(x=>[x.toLocaleLowerCase(),x])).values()];
        const length=x=>[...x].length;
        if(length(title)>120){error.textContent="Title must be at most 120 characters.";return;}
        if(length(description)>2000){error.textContent="Description must be at most 2000 characters.";return;}
        if(tags.length>12){error.textContent="Use at most 12 tags.";return;}
        if(tags.some(x=>length(x)>32)){error.textContent="Each tag must be at most 32 characters.";return;}
        s.title=title||s.sessionName;s.description=description;s.tags=tags;
        closeModal();render();
      });
      acts.append(button("Cancel","",closeModal),save);
      panel.append(titleLabel,help,descLabel,tagsLabel,tagsHelp,error,acts);actionOverlay.append(cover,panel);
      titleInput.focus();return;
    }
    const modeLabel=element("label","n-action-label","Connection mode");
    const mode=element("select","n-action-field");
    for(const name of ["Auto","P2P","Relay"]){const opt=element("option","",name);opt.value=name.toLowerCase();mode.append(opt);}
    mode.value=s.attachMode||"auto";modeLabel.append(mode);panel.append(modeLabel);
    const rendererLabel=element("label","n-action-label","Renderer");
    const renderer=element("select","n-action-field");
    for(const name of ["WebGL","Canvas"]){const opt=element("option","",name);opt.value=name.toLowerCase();renderer.append(opt);}
    renderer.value=s.renderer||"webgl";rendererLabel.append(renderer);panel.append(rendererLabel);
    const buttons=element("div","n-action-buttons");
    buttons.append(button("Cancel","",closeModal),button("Save settings","n-action-primary",()=>{s.attachMode=mode.value;s.renderer=renderer.value;closeModal();}));
    panel.append(buttons);actionOverlay.append(cover,panel);mode.focus();
  }
  function closeModal(){
    actionOverlay.hidden=true;actionOverlay.replaceChildren();
    const origin=actionTarget;actionTarget=null;if(origin?.isConnected)origin.focus();
  }
  function openMenu(s,trigger){
    if(menuId===s.id){closeMenu(true);return;}
    closeMenu(false);menuId=s.id;menuTrigger=trigger;trigger.setAttribute("aria-expanded","true");
    rowMenu.replaceChildren();rowMenu.setAttribute("role","menu");rowMenu.setAttribute("aria-label","Session actions for "+s.title);
    for(const a of actionItems){
      if(a.type==="kill")rowMenu.append(element("div","n-row-menu-separator"));
      const item=element("button","n-row-menu-item"+(a.type==="kill"?" n-row-menu-danger":""));
      item.type="button";item.setAttribute("role","menuitem");item.tabIndex=-1;
      item.setAttribute("data-action",a.type);
      item.append(glyph(a.icon),document.createTextNode(a.label));
      item.addEventListener("click",()=>openModal(a.type,s,trigger));rowMenu.append(item);
    }
    rowMenu.hidden=false;
    const r=trigger.getBoundingClientRect(),host=shell.getBoundingClientRect(),w=rowMenu.offsetWidth,h=rowMenu.offsetHeight;
    rowMenu.style.left=Math.max(8,Math.min(host.width-w-8,r.right-host.left-w))+"px";
    rowMenu.style.top=(r.bottom-host.top+h+8>host.height?Math.max(8,r.top-host.top-h-4):r.bottom-host.top+4)+"px";
    rowMenu.querySelector('[role="menuitem"]')?.focus();
  }
  const escapeText = (s) => { const el=document.createElement("span");el.textContent=String(s);return el.textContent; };
  const element=(tag,cl,content) => {const e=document.createElement(tag);if(cl)e.className=cl;if(content!==undefined)e.textContent=content;return e;};
  const selected = () => sessions.find(s=>s.id===selectedId) || sessions[0];
  function renderList(){
    list.replaceChildren();
    const filtered=sessions.filter(s=>(s.title+" "+s.kind+" "+s.agent).toLowerCase().includes(search.toLowerCase()));
    q("session-count").textContent=String(sessions.length);
    q("session-empty").hidden=filtered.length>0;
    for(const g of ["Today","Earlier"]){
      const group=filtered.filter(s=>s.group===g);if(!group.length)continue;
      list.append(element("div","n-time-label",g));
      for(const s of group){
        const row=element("div","n-session-item");row.dataset.active=String(selectedId===s.id);row.setAttribute("role","listitem");
        const open=element("button","n-session-button");open.type="button";open.setAttribute("aria-label","Open "+s.title);
        const dot=element("span","n-session-mark");dot.dataset.state=s.state;dot.setAttribute("aria-hidden","true");open.append(dot);
        const copy=element("span","n-session-copy");
        copy.append(element("span","n-session-name",s.title),element("span","n-session-sub",s.kind+" · "+s.agent));
        open.append(copy);open.addEventListener("click",()=>{selectedId=s.id;drawerOpen=false;section="sessions";dialog=null;render();});
        row.append(open);
        const more=element("button","n-more","···");more.type="button";more.title="Session actions";
        more.setAttribute("aria-label","Session actions for "+s.title);more.setAttribute("aria-haspopup","menu");more.setAttribute("aria-expanded","false");
        more.addEventListener("click",e=>{e.stopPropagation();openMenu(s,more);});row.append(more);list.append(row);
      }
    }
  }
  function renderAgents(){
    const box=q("agent-list");box.replaceChildren();
    for(const a of agents){const row=element("div","n-agent-row");const dot=element("span","n-status-dot");if(!a.online)dot.dataset.offline="true";dot.setAttribute("aria-hidden","true");const copy=element("span");copy.append(element("strong","",a.name),element("small","",a.online?"Online · "+a.count+" sessions":"Offline · "+a.count+" sessions"));row.append(dot,copy);box.append(row);}
  }
  function field(label,type,value){const l=element("label");l.append(document.createTextNode(label));const e=element("input");e.type=type;e.value=value||"";l.append(e);return {l,e};}
  function error(box,txt){const e=box.querySelector(".n-error");if(e)e.textContent=txt;}
  function button(text,cl,fn){const b=element("button",cl,text);b.type="button";b.addEventListener("click",fn);return b;}
  function closeDialog(){dialog=null;render();}
  function renderDialog(){
    const box=q("session-dialog");box.replaceChildren();box.hidden=!dialog;
    q("session-navigation").hidden=Boolean(dialog)||section!=="sessions";
    q("agent-navigation").hidden=Boolean(dialog)||section!=="agents";
    if(!dialog)return;
    if(dialog.type==="new"){
      box.append(element("h3","","New session"),element("p","","Create a persistent Session. This is a local preview with no backend request."));
      const name=field("Session name","text","");name.e.maxLength=80;name.e.autocomplete="off";box.append(name.l);
      const agentLabel=element("label","", "Agent / location");const select=element("select");for(const a of agents){const option=element("option","",a.name+(a.online?"":" (offline)"));option.value=a.name;select.append(option);}agentLabel.append(select);box.append(agentLabel);
      const em=element("p","n-error","");box.append(em);
      const actions=element("div","n-button-row");actions.append(button("Cancel","",closeDialog),button("Create session","n-primary",()=>{const title=name.e.value.trim();if(!title){error(box,"Enter a name.");name.e.focus();return;}if(!agents.find(a=>a.name===select.value)?.online){error(box,"This Agent is offline. Choose an online Agent.");return;}const id="mock-"+(sessions.length+1);sessions.unshift({id,sessionName:title,title,kind:"shell",agent:select.value,group:"Today",state:"active",lines:["nession / "+id,"Session created in local preview.","No backend process has been launched."]});selectedId=id;search="";input.value="";dialog=null;render();}));box.append(actions);name.e.focus();return;
    }
  }
  function renderWork(){
    const s=selected();q("terminal-command").textContent=s?"nession status":"";
    const lines=q("terminal-lines");lines.replaceChildren();
    if(s){for(const t of s.lines){const div=element("div",s.state==="offline"&&t.includes("unreachable")?"n-terminal-notice":"",t||"\u00a0");lines.append(div);}}
    else lines.append(element("div","","No Sessions yet. Create one to begin work."));
    q("workspace-title").textContent=s?s.title:"No selected Session";
    q("surface-terminal").setAttribute("aria-pressed",String(surface==="terminal"));
    q("surface-workspace").setAttribute("aria-pressed",String(surface==="workspace"));
    q("terminal-surface").hidden=surface!=="terminal";
    q("workspace-surface").hidden=surface!=="workspace";
  }
  function render(){
    closeMenu(false);
    shell.dataset.mode=width>=1024?"wide":"narrow";
    shell.dataset.collapsed=String(collapsed);
    shell.dataset.drawerOpen=String(drawerOpen);
    q("drawer-scrim").hidden=!drawerOpen||width>=1024;
    q("session-search").value=search;
    q("session-navigation").hidden=section!=="sessions"||Boolean(dialog);
    q("agent-navigation").hidden=section!=="agents"||Boolean(dialog);
    q("agent-entry").setAttribute("aria-pressed",String(section==="agents"));
    q("sidebar-toggle").title=collapsed?"Expand sidebar":"Collapse sidebar";
    renderList();renderAgents();renderDialog();renderWork();
    shell.dispatchEvent(new CustomEvent("nession:prototype-render",{bubbles:true}));
  }
  q("sidebar-toggle").addEventListener("click",()=>{collapsed=!collapsed;render();});
  q("work-open").addEventListener("click",()=>{if(width>=1024)collapsed=false;else drawerOpen=true;render();});
  q("drawer-close").addEventListener("click",()=>{drawerOpen=false;render();});
  q("drawer-scrim").addEventListener("click",()=>{drawerOpen=false;render();});
  rowMenu.addEventListener("keydown",e=>{
    if(e.key==="Escape"){e.preventDefault();closeMenu(true);return;}
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){
      e.preventDefault();const items=[...rowMenu.querySelectorAll('[role="menuitem"]')];
      const i=items.indexOf(document.activeElement),step=e.key==="ArrowDown"?1:-1;
      items[(i+step+items.length)%items.length]?.focus();
    }
  });
  document.addEventListener("pointerdown",e=>{
    if(menuId&&!rowMenu.contains(e.target)&&!menuTrigger?.contains(e.target))closeMenu(false);
  },true);
  shell.addEventListener("scroll",e=>{if(menuId&&e.target.closest(".n-scroll"))closeMenu(false);},true);
  q("new-session").addEventListener("click",()=>{dialog={type:"new"};section="sessions";render();});
  q("agent-entry").addEventListener("click",()=>{section=section==="agents"?"sessions":"agents";dialog=null;render();});
  q("agent-back").addEventListener("click",()=>{section="sessions";render();});
  q("session-search").addEventListener("input",e=>{search=e.target.value;renderList();});
  q("surface-terminal").addEventListener("click",()=>{surface="terminal";renderWork();});
  q("surface-workspace").addEventListener("click",()=>{surface="workspace";renderWork();});
  q("capsule-form").addEventListener("submit",e=>{e.preventDefault();const v=q("capsule-input").value.trim();if(!v)return;const s=selected();if(s)s.lines.push("› "+v,"Local preview input recorded. No Agent or model call was made.");q("capsule-input").value="";renderWork();});
  const root=q("review-root");root.addEventListener("np:resize",e=>{width=Number(e.detail.width)||1280;drawerOpen=false;const h=({1280:800,1440:900,1180:760,1024:768,390:844,375:812})[width]||800;q("n-shell").parentElement.style.setProperty("--np-device-height",h+"px");render();});
  root.addEventListener("keydown",e=>{
    if(e.key!=="Escape")return;
    if(!actionOverlay.hidden){closeModal();return;}
    if(menuId){closeMenu(true);return;}
    if(dialog){closeDialog();return;}
    if(drawerOpen){drawerOpen=false;render();}
  });
  render();
})();