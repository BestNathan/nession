(() => {
  "use strict";
  const q = (id) => document.getElementById(id);
  const fixtures = [
    {id:"sess-01",title:"Fix terminal reconnect",kind:"Claude Code",agent:"devbox-01",group:"Today",state:"active",lines:["nession / session-01","Workspace: /work/demo","Connected to devbox-01","","Latest task: verify terminal continuity","✓ Last command completed"]},
    {id:"sess-02",title:"Design Files workspace",kind:"shell",agent:"macbook-demo",group:"Today",state:"idle",lines:["nession / session-02","Workspace: /work/files","Git status: clean","","Reviewing file navigator behavior"]},
    {id:"sess-03",title:"Sandbox policy review",kind:"shell",agent:"runner-02",group:"Earlier",state:"idle",lines:["nession / session-03","Workspace: /work/sandbox","Policy review in progress"]},
    {id:"sess-04",title:"Production diagnostics",kind:"zsh",agent:"runner-02",group:"Earlier",state:"offline",lines:["nession / session-04","Agent unreachable; work remains discoverable","Reconnect to recover the live terminal view."]},
    {id:"sess-05",title:"Environment proposal",kind:"Claude Code",agent:"devbox-01",group:"Earlier",state:"idle",lines:["nession / session-05","Workspace: /work/env","Proposal ready for review."]}
  ];
  let sessions = fixtures.map(s=>({...s,lines:s.lines.slice()}));
  let selectedId="sess-01", search="", collapsed=false, width=1280, drawerOpen=false, section="sessions", dialog=null, surface="terminal";
  const agents=[{name:"devbox-01",online:true,count:2},{name:"macbook-demo",online:true,count:1},{name:"runner-02",online:false,count:2}];
  const shell=q("n-shell"), sidebar=q("n-sidebar"), list=q("session-list"), input=q("session-search");
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
        const more=element("button","n-more","···");more.type="button";more.title="Session actions";more.setAttribute("aria-label","Actions for "+s.title);more.addEventListener("click",()=>{dialog={type:"actions",sessionId:s.id};section="sessions";render();});row.append(more);list.append(row);
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
      const actions=element("div","n-button-row");actions.append(button("Cancel","",closeDialog),button("Create session","n-primary",()=>{const title=name.e.value.trim();if(!title){error(box,"Enter a name.");name.e.focus();return;}if(!agents.find(a=>a.name===select.value)?.online){error(box,"This Agent is offline. Choose an online Agent.");return;}const id="mock-"+(sessions.length+1);sessions.unshift({id,title,kind:"shell",agent:select.value,group:"Today",state:"active",lines:["nession / "+id,"Session created in local preview.","No backend process has been launched."]});selectedId=id;search="";input.value="";dialog=null;render();}));box.append(actions);name.e.focus();return;
    }
    const s=sessions.find(v=>v.id===dialog.sessionId);if(!s){closeDialog();return;}
    if(dialog.type==="actions"){box.append(element("h3","",s.title),element("p","","Session actions"));box.append(button("Open session","",()=>{selectedId=s.id;closeDialog();}),button("Rename…","",()=>{dialog={type:"rename",sessionId:s.id};render();}),button("End session…","",()=>{dialog={type:"end",sessionId:s.id};render();}),button("Back to sessions","",closeDialog));return;}
    if(dialog.type==="rename"){box.append(element("h3","","Rename session"));const f=field("Display title","text",s.title);box.append(f.l,element("p","n-error",""));const a=element("div","n-button-row");a.append(button("Cancel","",closeDialog),button("Save","n-primary",()=>{const v=f.e.value.trim();if(!v){error(box,"Title must not be empty.");return;}s.title=v;closeDialog();}));box.append(a);f.e.focus();return;}
    if(dialog.type==="end"){box.append(element("h3","","End session?"),element("p","","This mock action removes the Session from the local preview. Real Nession must request explicit confirmation before ending a live Session."));const a=element("div","n-button-row");a.append(button("Cancel","",closeDialog),button("End session","n-danger",()=>{sessions=sessions.filter(v=>v.id!==s.id);if(selectedId===s.id)selectedId=sessions[0]?.id||null;closeDialog();}));box.append(a);}
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
  q("new-session").addEventListener("click",()=>{dialog={type:"new"};section="sessions";render();});
  q("agent-entry").addEventListener("click",()=>{section=section==="agents"?"sessions":"agents";dialog=null;render();});
  q("agent-back").addEventListener("click",()=>{section="sessions";render();});
  q("session-search").addEventListener("input",e=>{search=e.target.value;renderList();});
  q("surface-terminal").addEventListener("click",()=>{surface="terminal";renderWork();});
  q("surface-workspace").addEventListener("click",()=>{surface="workspace";renderWork();});
  q("capsule-form").addEventListener("submit",e=>{e.preventDefault();const v=q("capsule-input").value.trim();if(!v)return;const s=selected();if(s)s.lines.push("› "+v,"Local preview input recorded. No Agent or model call was made.");q("capsule-input").value="";renderWork();});
  const root=q("review-root");root.addEventListener("np:resize",e=>{width=Number(e.detail.width)||1280;drawerOpen=false;const h=({1280:800,1440:900,1180:760,1024:768,390:844,375:812})[width]||800;q("n-shell").parentElement.style.setProperty("--np-device-height",h+"px");render();});
  root.addEventListener("keydown",e=>{if(e.key==="Escape"&&dialog){closeDialog();return;}if(e.key==="Escape"&&drawerOpen){drawerOpen=false;render();}});
  render();
})();