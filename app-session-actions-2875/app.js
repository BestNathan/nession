/* #2875 App Sessions action review. All data/effects are local browser mocks. */
(() => {
  "use strict";
  const $=id=>document.getElementById(id);
  const app=$("app-shell"), device=document.querySelector("[data-np-device]"), root=$("review-root");
  if(!app||!device||!root)return;
  const icons={
    more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    edit:'<path d="m15 5 4 4M4 20l5-.9L20 7.1 16.9 4 5 15.9z"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="m10 2 .6 2.4 2.8.1L14 2l2.8 1.3-.8 2.4 2 2 2.4-.8L22 10l-2.5.6.1 2.8L22 14l-1.3 2.8-2.4-.8-2 2 .8 2.4L14 22l-.6-2.5-2.8.1L10 22l-2.8-1.3.8-2.4-2-2-2.4.8L2 14l2.5-.6-.1-2.8L2 10l1.3-2.8 2.4.8 2-2-.8-2.4z"/>',
    trash:'<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v7m4-7v7"/>',
    chevron:'<path d="m6 9 6 6 6-6"/>',
  };
  const fixture=[
    {id:"sess-01",sessionName:"fix-terminal-reconnect",title:"Fix terminal reconnect",desc:"Check that terminal output remains continuous after reconnection.",tags:["terminal","reliability"],kind:"claude",agent:"devbox-01",online:true,state:"active",group:"Today",revision:3,mode:"auto",renderer:"webgl"},
    {id:"sess-02",sessionName:"review-files",title:"Design Files workspace",desc:"Review file navigation and preview behavior.",tags:["files"],kind:"zsh",agent:"macbook-demo",online:true,state:"active",group:"Today",revision:2,mode:"auto",renderer:"canvas"},
    {id:"sess-03",sessionName:"sandbox-policy",title:"Sandbox policy review",desc:"",tags:[],kind:"bash",agent:"devbox-01",online:true,state:"active",group:"Today",revision:0,mode:"p2p",renderer:"webgl"},
    {id:"sess-04",sessionName:"prod-diag",title:"Production diagnostics",desc:"Read-only investigation of connection issues.",tags:["ops"],kind:"zsh",agent:"runner-02",online:false,state:"unknown",group:"Previous 7 days",revision:4,mode:"relay",renderer:"canvas"},
    {id:"sess-05",sessionName:"env-proposal",title:"Environment proposal",desc:"Review environment inheritance choices.",tags:["proposal"],kind:"claude",agent:"macbook-demo",online:true,state:"active",group:"Previous 7 days",revision:3,mode:"auto",renderer:"webgl"},
    {id:"sess-06",sessionName:"old-terminal",title:"Old terminal",desc:"Historical shell context.",tags:[],kind:"bash",agent:"devbox-01",online:true,state:"exited",group:"Older",revision:0,mode:"auto",renderer:"webgl"}
  ];
  const agentNames=["devbox-01","macbook-demo","runner-02"];
  const copy=()=>fixture.map(s=>({...s,tags:s.tags.slice()}));
  let sessions=copy(), activeId="sess-01", layer="sessions", query="", statusFilter="all", sortBy="activity", filtersOpen=false, agentsOpen=false;
  let scenario="normal", conflictPending=false, menuId=null, menuOrigin=null, dialog=null, dialogOrigin=null;
  let selectedInspector=null, nextMockId=1;
  const menu=$("session-menu"), dialogRoot=$("dialog-root"), list=$("session-list"), scroll=$("session-scroll");
  const E=(tag,className,text)=>{
    const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;
  };
  const B=(label,className,fn)=>{
    const b=E("button",className,label);b.type="button";b.addEventListener("click",fn);return b;
  };
  const icon=name=>{
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");svg.innerHTML=icons[name];return svg;
  };
  const byId=id=>sessions.find(s=>s.id===id)||null;
  const active=()=>byId(activeId);
  const display=s=>s.title||s.sessionName;
  const codepoints=s=>[...s].length;
  const offline=s=>scenario==="offline"||!s.online;
  const notice=message=>{const n=$("product-toast");n.textContent=message;n.hidden=false;};
  const clearNotice=()=>$("product-toast").hidden=true;
  function setLayer(next){
    closeMenu(false);layer=next;app.dataset.layer=layer;
    for(const [id,shown] of [["sessions-layer",next==="sessions"],["workspace-layer",next==="workspace"]]){
      const node=$(id);node.setAttribute("aria-hidden",String(!shown));
    }
    $("terminal-layer").setAttribute("aria-hidden",String(next!=="terminal"));
    if(next==="sessions")renderList();
    refreshInspector();
  }
  function closeMenu(restoreFocus){
    const origin=menuOrigin;
    if(origin?.isConnected)origin.setAttribute("aria-expanded","false");
    menuId=null;menuOrigin=null;menu.hidden=true;menu.replaceChildren();
    if(restoreFocus&&origin?.isConnected)origin.focus();
    refreshInspector();
  }
  function openMenu(s,origin){
    if(menuId===s.id){closeMenu(true);return;}
    closeMenu(false);clearNotice();
    menuId=s.id;menuOrigin=origin;origin.setAttribute("aria-expanded","true");
    menu.setAttribute("aria-label","Session actions for "+display(s));
    const actions=[
      {type:"details",label:"Session details",icon:"info"},
      {type:"edit",label:"Edit details",icon:"edit"},
      {type:"settings",label:"Attach settings",icon:"settings"},
      {type:"kill",label:"Kill session",icon:"trash"}
    ];
    actions.forEach(a=>{
      if(a.type==="kill")menu.append(E("div","n-menu-separator"));
      const b=B("", "",()=>openDialog(a.type,s,origin));
      b.setAttribute("role","menuitem");b.setAttribute("data-action",a.type);b.tabIndex=-1;
      if(a.type==="kill")b.dataset.destructive="true";
      b.append(icon(a.icon),document.createTextNode(a.label));
      menu.append(b);
    });
    menu.hidden=false;
    const ar=app.getBoundingClientRect(),tr=origin.getBoundingClientRect(),mr=menu.getBoundingClientRect();
    menu.style.left=Math.min(ar.width-mr.width-9,Math.max(9,tr.right-ar.left-mr.width))+"px";
    const below=tr.bottom-ar.top+5;
    menu.style.top=(below+mr.height>ar.height-12?Math.max(12,tr.top-ar.top-mr.height-5):below)+"px";
    menu.querySelector('[role="menuitem"]')?.focus();
    refreshInspector();
  }
  function selectSession(s){
    activeId=s.id;clearNotice();closeMenu(false);renderActive();renderList();setLayer("terminal");
  }
  function renderActive(){
    const s=active();
    $("terminal-session-title").textContent=s?display(s):"No Session";
    $("workspace-title").textContent=s?display(s):"No Session";
  }
  function renderList(){
    if(menuId)closeMenu(false);
    const originQuery=query.trim().toLocaleLowerCase();
    const found=sessions.filter(s=>{
      if(statusFilter==="online"&&offline(s))return false;
      if(statusFilter==="offline"&&!offline(s))return false;
      return (display(s)+" "+s.sessionName+" "+s.kind+" "+s.agent).toLocaleLowerCase().includes(originQuery);
    });
    if(sortBy==="name")found.sort((a,b)=>display(a).localeCompare(display(b)));
    list.replaceChildren();
    if(found.length===0){
      const box=E("div","n-empty");
      box.append(E("strong","",sessions.length===0?"No Sessions yet":"No sessions match"),E("p","",sessions.length===0?"Create a Session to begin work.":originQuery?"No sessions match “"+query+"”.":"Try changing the Agent status filter."));
      box.append(B(sessions.length===0?"New Session":originQuery?"Clear search":"Clear filter","n-small-action",()=>{
        if(sessions.length===0)openDialog("new",null,$("new-session"));
        else if(originQuery){query="";$("session-search").value="";renderList();}
        else{statusFilter="all";renderControls();renderList();}
      }));
      list.append(box);renderAgents();refreshInspector();return;
    }
    const grouped=sortBy!=="name"&&new Set(found.map(s=>s.group)).size>1;
    const groups=grouped?["Today","Previous 7 days","Older"]:[""];
    for(const key of groups){
      const rows=grouped?found.filter(s=>s.group===key):found;
      if(!rows.length)continue;
      if(grouped)list.append(E("h2","n-group-label",key));
      for(const s of rows){
        const row=E("div","n-session-row");row.dataset.selected=String(s.id===activeId);row.setAttribute("role","listitem");row.dataset.session=s.id;
        const enter=B("","n-session-enter",()=>selectSession(s));
        enter.setAttribute("aria-label","Open "+display(s));if(s.id===activeId)enter.setAttribute("aria-current","true");
        enter.append(E("span","n-session-title",display(s)));
        const meta=E("span","n-session-meta");meta.append(E("span","n-session-workload",s.kind),document.createTextNode(" · "+s.agent+(grouped?"":" · "+s.group)));
        enter.append(meta);
        if(offline(s))enter.append(E("span","n-session-warning","Agent unreachable"));
        else if(s.state==="exited")enter.append(E("span","n-session-warning","Exited"));
        const more=E("button","n-more");more.type="button";
        // Separate entry from row activation: clicking menu never selects a Session.
        more.addEventListener("click",event=>{event.stopPropagation();openMenu(s,more);});
        more.append(icon("more"));more.title="Session actions";
        more.setAttribute("aria-label","Session actions for "+display(s));
        more.setAttribute("aria-haspopup","menu");more.setAttribute("aria-expanded","false");
        row.append(enter,more);list.append(row);
      }
    }
    renderAgents();refreshInspector();
  }
  function renderAgents(){
    const box=$("agents-section");box.replaceChildren();
    if(sessions.length===0)return;
    const onCount=agentNames.filter(a=>sessions.some(s=>s.agent===a&&!offline(s))).length;
    const toggle=B("", "n-agents-button",()=>{agentsOpen=!agentsOpen;renderAgents();});
    toggle.setAttribute("aria-expanded",String(agentsOpen));
    toggle.append(document.createTextNode("Agents · "+onCount+" online"),icon("chevron"));
    box.append(toggle);
    if(agentsOpen)agentNames.forEach(name=>{
      const a=E("div","n-agent-entry");
      a.append(E("strong","",name),E("span","",scenario==="offline"||name==="runner-02"?"Offline":"Online"));
      box.append(a);
    });
  }
  function renderControls(){
    $("filter-panel").hidden=!filtersOpen;
    $("filter-trigger").setAttribute("aria-expanded",String(filtersOpen));
    for(const b of root.querySelectorAll("[data-filter]"))b.setAttribute("aria-pressed",String(b.dataset.filter===statusFilter));
    for(const b of root.querySelectorAll("[data-sort]"))b.setAttribute("aria-pressed",String(b.dataset.sort===sortBy));
    const chip=$("active-filter");chip.hidden=statusFilter==="all";chip.replaceChildren();
    if(statusFilter!=="all")chip.append(B(statusFilter==="online"?"Online ×":"Offline ×","",()=>{statusFilter="all";renderControls();renderList();}));
    $("connection-alert").hidden=scenario!=="offline";
  }
  function closeDialog(){
    dialog=null;dialogRoot.hidden=true;dialogRoot.replaceChildren();
    const origin=dialogOrigin;dialogOrigin=null;
    if(origin?.isConnected)origin.focus();
    refreshInspector();
  }
  function dialogPair(box,label,value){
    const row=E("div","n-modal-pair");
    row.append(E("span","",label),E("strong","",value));
    box.append(row);
  }
  function textField(label,value,placeholder,multi){
    const l=E("label","n-form-label",label),input=E(multi?"textarea":"input","");
    if(!multi)input.type="text";input.value=value||"";input.placeholder=placeholder||"";
    l.append(input);return {label:l,input};
  }
  function actionBar(){
    const row=E("div","n-modal-actions");
    return row;
  }
  function addAction(row,label,fn,type){
    const b=B(label,"",fn);if(type)b.dataset[type==="danger"?"danger":"primary"]="true";row.append(b);return b;
  }
  function openDialog(type,s,origin){
    closeMenu(false);clearNotice();dialog={type,id:s?.id||null,revision:s?.revision||0};
    dialogOrigin=origin;dialogRoot.replaceChildren();dialogRoot.hidden=false;
    const backdrop=B("","n-modal-backdrop",closeDialog);backdrop.setAttribute("aria-label","Close dialog");
    const panel=E("div","n-modal");panel.setAttribute("role",type==="kill"?"alertdialog":"dialog");panel.setAttribute("aria-modal","true");
    const title=E("h2","n-modal-title",{
      details:"Session details",edit:"Edit Session details",settings:"Attach settings",kill:"Kill Session",new:"New Session"}[type]||"Session");
    title.id="n-modal-title";panel.setAttribute("aria-labelledby","n-modal-title");panel.append(title);
    const message=type==="kill"?"This permanently terminates the underlying tmux Session.":type==="edit"?"Update Session work context. The tmux name stays unchanged.":type==="settings"?"Choose the preferences used for future attachments.":type==="new"?"Create a new local demo Session.":"Runtime identity and work context for this Session.";
    panel.append(E("p","n-modal-copy",message));
    if(type==="details"){
      const info=E("div","n-modal-summary");
      for(const [k,v] of [["Display title",display(s)],["tmux Session name",s.sessionName],["Session ID",s.id],["Agent / location",s.agent],["Workload",s.kind],["State",offline(s)?"Agent offline":s.state],["Description",s.desc||"No description yet"],["Tags",s.tags.length?s.tags.join(", "):"No tags"]])dialogPair(info,k,v);
      panel.append(info);
      const acts=actionBar();const close=addAction(acts,"Close",closeDialog);
      if(!offline(s))addAction(acts,"Edit details",()=>openDialog("edit",s,origin),"primary");
      panel.append(acts);dialogRoot.append(backdrop,panel);close.focus();refreshInspector();return;
    }
    if(type==="edit"){
      if(offline(s)){
        panel.append(E("div","n-modal-summary","This Agent is offline. You can view Session details, but editing is unavailable until it reconnects."));
        const acts=actionBar();addAction(acts,"Close",closeDialog);panel.append(acts);dialogRoot.append(backdrop,panel);acts.querySelector("button")?.focus();return;
      }
      const titleField=textField("Display title",s.title,s.sessionName,false);
      titleField.input.maxLength=120;
      const titleHint=E("p","n-form-hint","Only the navigation alias changes. Leave blank to use the tmux name.");
      const descField=textField("Description",s.desc,"What is this work about?",true);descField.input.maxLength=2000;
      const tagsField=textField("Tags",s.tags.join(", "),"comma-separated tags",false);
      const tagsHint=E("p","n-form-hint","Max 12 tags, 32 characters each. Duplicates ignored regardless of case.");
      const error=E("p","n-form-error","");error.setAttribute("role","alert");
      const acts=actionBar();addAction(acts,"Cancel",closeDialog);
      const save=addAction(acts,"Save details",()=>{
        const title=titleField.input.value.trim(),desc=descField.input.value.trim();
        const tags=[...new Map(tagsField.input.value.split(",").map(x=>x.trim()).filter(Boolean).map(x=>[x.toLocaleLowerCase(),x])).values()];
        error.textContent="";
        if(codepoints(title)>120){error.textContent="Title must be at most 120 characters.";return;}
        if(codepoints(desc)>2000){error.textContent="Description must be at most 2000 characters.";return;}
        if(tags.length>12){error.textContent="Use at most 12 tags.";return;}
        if(tags.some(x=>codepoints(x)>32)){error.textContent="Each tag must be at most 32 characters.";return;}
        if(conflictPending){conflictPending=false;s.revision+=1;error.textContent="Remote revision conflict. Discard the draft and load latest before saving.";
          if(!panel.querySelector("[data-reload]")){
            const reload=B("Discard draft and load latest","n-small-action",()=>openDialog("edit",s,origin));
            reload.dataset.reload="true";panel.insertBefore(reload,acts);
          }
          return;
        }
        if(s.revision!==dialog.revision){error.textContent="Remote revision conflict: reload current metadata.";return;}
        s.title=title;s.desc=desc;s.tags=tags;s.revision+=1;
        closeDialog();renderActive();renderList();list.querySelector('[data-session="'+s.id+'"] .n-more')?.focus();notice("Session details saved");refreshInspector();
      },"primary");
      panel.append(titleField.label,titleHint,descField.label,tagsField.label,tagsHint,error,acts);
      dialogRoot.append(backdrop,panel);titleField.input.focus();refreshInspector();return;
    }
    if(type==="settings"){
      const modeLabel=E("label","n-form-label","Connection mode"),mode=E("select","");
      for(const value of ["auto","p2p","relay"]){const opt=E("option","",value==="p2p"?"P2P":value[0].toUpperCase()+value.slice(1));opt.value=value;mode.append(opt);}
      mode.value=s.mode;modeLabel.append(mode);
      const rendererLabel=E("label","n-form-label","Renderer"),renderer=E("select","");
      for(const value of ["webgl","canvas"]){const opt=E("option","",value==="webgl"?"WebGL":"Canvas");opt.value=value;renderer.append(opt);}
      renderer.value=s.renderer;rendererLabel.append(renderer);
      const acts=actionBar();addAction(acts,"Cancel",closeDialog);addAction(acts,"Save settings",()=>{
        s.mode=mode.value;s.renderer=renderer.value;closeDialog();notice("Attach settings saved locally");
      },"primary");
      panel.append(modeLabel,rendererLabel,acts);dialogRoot.append(backdrop,panel);mode.focus();refreshInspector();return;
    }
    if(type==="kill"){
      const input=textField("Type "+s.sessionName+" to confirm","","Exact tmux name",false);
      input.input.autocomplete="off";const error=E("p","n-form-error","");error.setAttribute("role","alert");
      const acts=actionBar();addAction(acts,"Cancel",closeDialog);
      const confirm=addAction(acts,"Kill Session",()=>{
        if(input.input.value!==s.sessionName)return;
        sessions=sessions.filter(item=>item.id!==s.id);
        if(activeId===s.id)activeId=sessions[0]?.id||null;
        closeDialog();renderActive();renderList();setLayer("sessions");notice("Session removed from local preview");
      },"danger");confirm.disabled=true;
      input.input.addEventListener("input",()=>{
        const valid=input.input.value===s.sessionName;confirm.disabled=!valid;
        error.textContent=input.input.value&&!valid?"Session name does not match.":"";input.input.setAttribute("aria-invalid",String(Boolean(input.input.value&&!valid)));
      });
      panel.append(input.label,E("p","n-form-hint","The display title is not a valid confirmation value."),error,acts);
      dialogRoot.append(backdrop,panel);input.input.focus();refreshInspector();return;
    }
    if(type==="new"){
      const f=textField("Session name","","e.g. fix-task",false);f.input.maxLength=80;
      const l=E("label","n-form-label","Agent / location"),sel=E("select","");
      for(const agent of agentNames){const opt=E("option","",agent+(scenario==="offline"||agent==="runner-02"?" (offline)":""));opt.value=agent;sel.append(opt);}
      l.append(sel);
      const err=E("p","n-form-error","");err.setAttribute("role","alert");const acts=actionBar();addAction(acts,"Cancel",closeDialog);
      addAction(acts,"Create Session",()=>{
        const name=f.input.value.trim();
        if(!name){err.textContent="Enter a Session name.";return;}
        if(sessions.some(x=>x.sessionName===name&&x.agent===sel.value)){err.textContent="A Session with this name already exists on this Agent.";return;}
        if(scenario==="offline"||sel.value==="runner-02"){err.textContent="This Agent is offline.";return;}
        const id="mock-"+(nextMockId++);
        sessions.unshift({id,sessionName:name,title:"",desc:"",tags:[],kind:"shell",agent:sel.value,online:true,state:"active",group:"Today",revision:0,mode:"auto",renderer:"webgl"});
        activeId=id;query="";$("session-search").value="";closeDialog();renderActive();renderList();setLayer("terminal");notice("Session created in local preview");
      },"primary");
      panel.append(f.label,l,err,acts);dialogRoot.append(backdrop,panel);f.input.focus();refreshInspector();
    }
  }
  function setScenario(next){
    scenario=next;nextMockId=1;sessions=next==="empty"?[]:copy();activeId=sessions[0]?.id||null;
    query="";statusFilter="all";sortBy="activity";filtersOpen=false;agentsOpen=false;conflictPending=next==="conflict";
    closeMenu(false);if(dialog)closeDialog();clearNotice();
    $("session-search").value="";renderControls();renderActive();renderList();setLayer("sessions");
    for(const b of root.querySelectorAll("[data-fixture]"))b.setAttribute("aria-pressed",String(b.dataset.fixture===next));
  }
  function updateSize(width){
    const h={375:812,390:844,430:932}[width]||844;
    device.style.setProperty("--np-device-height",h+"px");
    closeMenu(false);refreshInspector();
  }
  function refreshInspector(){
    if(!selectedInspector)return;
    const target=app.querySelector(selectedInspector);
    const output=$("inspector-output");
    if(!target){output.textContent="Element not available in this state.";return;}
    const cs=getComputedStyle(target),r=target.getBoundingClientRect(),hidden=target.hidden||cs.display==="none"||r.width===0;
    output.textContent=selectedInspector+"\n"+
      (hidden?"Hidden in current state\n":"Visible in preview\n")+
      "Bounding box: "+r.width.toFixed(1)+" × "+r.height.toFixed(1)+" CSS px\n"+
      "Font: "+cs.fontSize+" / "+cs.fontWeight+" · line-height "+cs.lineHeight+"\n"+
      "Padding: "+cs.padding+" · radius "+cs.borderRadius+"\n"+
      "Background: "+cs.backgroundColor+"\n"+
      "App touch token: "+getComputedStyle(app).getPropertyValue("--nession-control-sm").trim();
  }
  $("open-sessions").addEventListener("click",()=>setLayer("sessions"));
  $("open-workspace").addEventListener("click",()=>setLayer("workspace"));
  $("workspace-back").addEventListener("click",()=>setLayer("terminal"));
  $("new-session").addEventListener("click",()=>openDialog("new",null,$("new-session")));
  $("session-search").addEventListener("input",e=>{query=e.target.value;renderList();});
  $("filter-trigger").addEventListener("click",()=>{filtersOpen=!filtersOpen;renderControls();});
  for(const b of root.querySelectorAll("[data-filter]"))b.addEventListener("click",()=>{statusFilter=b.dataset.filter;renderControls();renderList();});
  for(const b of root.querySelectorAll("[data-sort]"))b.addEventListener("click",()=>{sortBy=b.dataset.sort;renderControls();renderList();});
  for(const b of root.querySelectorAll("[data-fixture]"))b.addEventListener("click",()=>setScenario(b.dataset.fixture));
  for(const b of root.querySelectorAll("[data-inspect]"))b.addEventListener("click",()=>{
    selectedInspector=b.dataset.inspect;
    for(const sibling of root.querySelectorAll("[data-inspect]"))sibling.setAttribute("aria-pressed",String(sibling===b));
    refreshInspector();
  });
  $("retry-connection").addEventListener("click",()=>notice("No network in this preview. Select Normal fixture to restore mock connectivity."));
  $("capsule-plus").addEventListener("click",()=>notice("Capabilities are outside the #2875 review scope."));
  $("terminal-capsule").addEventListener("submit",e=>{
    e.preventDefault();const field=$("capsule-input"),value=field.value.trim();if(!value)return;
    $("terminal-copy").append(E("div","","> "+value),E("div","","Local preview: no Terminal command was executed."));
    field.value="";$("terminal-copy").scrollTop=$("terminal-copy").scrollHeight;
  });
  scroll.addEventListener("scroll",()=>{if(menuId)closeMenu(false);},{passive:true});
  document.addEventListener("pointerdown",e=>{
    if(menuId&&!menu.contains(e.target)&&!menuOrigin?.contains(e.target))closeMenu(false);
  },true);
  menu.addEventListener("keydown",e=>{
    if(e.key==="Escape"){e.preventDefault();closeMenu(true);return;}
    const items=[...menu.querySelectorAll('[role="menuitem"]')],i=items.indexOf(document.activeElement);
    if(e.key==="ArrowDown"||e.key==="ArrowUp"||e.key==="Home"||e.key==="End"){
      e.preventDefault();const n=e.key==="Home"?0:e.key==="End"?items.length-1:(i+(e.key==="ArrowDown"?1:-1)+items.length)%items.length;
      items[n]?.focus();
    }
  });
  root.addEventListener("keydown",e=>{
    if(e.key!=="Escape")return;
    if(dialog){e.preventDefault();closeDialog();}
    else if(menuId){e.preventDefault();closeMenu(true);}
    else if(layer!=="terminal"){e.preventDefault();setLayer("terminal");}
  });
  // Spatial navigation demonstration: gesture commits on release, without
  // claiming to reproduce Nession's real App pager physics or TUI touch ownership.
  let gesture=null;
  app.addEventListener("pointerdown",e=>{
    if(e.pointerType!=="touch"||dialog||menuId)return;
    if(e.target.closest("input,textarea,select,[role='dialog'],[role='menu']"))return;
    gesture={id:e.pointerId,x:e.clientX,y:e.clientY};
  });
  app.addEventListener("pointerup",e=>{
    if(!gesture||gesture.id!==e.pointerId)return;
    const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;gesture=null;
    if(Math.abs(dx)<85||Math.abs(dx)<Math.abs(dy)*1.8)return;
    if(layer==="terminal")setLayer(dx>0?"sessions":"workspace");
    else if(layer==="sessions"&&dx<0)setLayer("terminal");
    else if(layer==="workspace"&&dx>0)setLayer("terminal");
  });
  app.addEventListener("pointercancel",()=>{gesture=null;});
  device.addEventListener("np:resize",e=>updateSize(Number(e.detail.width)));
  renderControls();renderActive();renderList();setLayer("sessions");updateSize(390);
})();