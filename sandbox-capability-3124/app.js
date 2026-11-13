/* Session-scoped Sandbox candidate for #3408 / #3407 / #3405.
 * All actions and assets are synthetic browser-only fixtures. No API or host I/O.
 * Replaces prior six peer policy tabs IN THE SAME #3124 prototype directory.
 */
(function () {
  "use strict";
  var root=document.querySelector("[data-np-root]");
  var device=document.querySelector("[data-np-device]");
  var view=document.getElementById("sandbox-product");
  var inspector=document.getElementById("sandbox-inspector");
  if(!root||!device||!view)return;
  function image(id,name,kind,letter){return {id:id,name:name,kind:kind,digest:"sha256:"+letter.repeat(64),status:"ready"};}
  var initialImages=[
    image("base","minimal-glibc-runtime","Base Runtime","a"),
    image("rust","rust-toolchain","Toolchain","b"),
    image("node","node-toolchain","Toolchain","c"),
    image("source","nession-source","Project Source","d")
  ];
  function initialWorkspaces(){return [
    {id:"project:nession",name:"Nession · Existing Location",kind:"project_location",project:"Nession",path:"/home/dev/projects/nession",status:"available"},
    {id:"ws:prior",name:"investigate-build",kind:"managed",project:"—",path:"Agent managed · ws:prior",status:"available"},
    {id:"ws:busy",name:"shared-build",kind:"managed",project:"—",path:"Agent managed · ws:busy",status:"in_use"}
  ];}
  function defaults(){
    return {mode:"web",width:1180,surface:"workspace",session:"sandbox-review",fixture:"linux",area:"overview",
      sub:{images:"library",workspaces:"list",policies:"filesystem"},depth:"root",
      images:initialImages.map(function(x){return Object.assign({},x)}),
      builds:[{id:"build-120",name:"nession-source",status:"completed",detail:"Digest verified and registered"}],
      cache:{base:"verified",rust:"absent",node:"absent",source:"verified"},
      workspaces:initialWorkspaces(),selectedWorkspace:"project:nession",newWorkspaceName:"",deletePending:null,
      rootMode:"image",rootImage:"base",tools:["rust"],toolTarget:"/opt/rust",workspaceLower:false,readPaths:"",writePaths:"",
      home:"ephemeral",network:"deny",namespace:{pid:true,ipc:true,user:true,uts:false,cgroup:false},
      cgroup:"",seccomp:false,preflight:"none",error:"",notice:"",inside:false,effective:null,selectedImage:"base",imageAction:"",
      step:0,tip:null};
  }
  var s=defaults();
  var sections=[["overview","Overview"],["images","Images"],["workspaces","Workspaces"],["policies","Policies"]];
  var subs={
    images:[["library","Image Library"],["builds","Builds"],["distribution","Distribution"]],
    workspaces:[["list","All Workspaces"],["details","Workspace Detail"]],
    policies:[["filesystem","Filesystem"],["network","Network"],["linux_namespace","Linux Namespace"],["cgroup_v2","Cgroup v2"],["seccomp","Seccomp"]]
  };
  function h(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
  function short(x){return x?"sha256:"+x.slice(7,17)+"…"+x.slice(-6):"—";}
  function online(){return s.fixture!=="offline"&&s.fixture!=="no-session";}
  function hasSession(){return s.fixture!=="no-session";}
  function macos(){return s.fixture==="macos";}
  function isEditable(){return online()&&!s.inside;}
  function imageBy(id){return s.images.find(function(x){return x.id===id;});}
  function currentWorkspace(){return s.workspaces.find(function(w){return w.id===s.selectedWorkspace;});}
  function nativeStatus(key){
    if(!online())return {state:"unknown",reason:"Agent offline; capability not measured"};
    if(key==="filesystem.composition")return macos()?{state:"unavailable",reason:"EROFS mount backend not available on macOS"}:{state:"available",reason:"erofsfuse, FUSE and overlay probes"};
    if(key==="filesystem.access")return macos()?{state:"unavailable",reason:"Host path isolation not measured for macOS Seatbelt"}:{state:"available",reason:"Linux bwrap path isolation"};
    if(key==="linux_namespace"||key==="cgroup_v2"||key==="seccomp"){
      if(macos())return {state:"unavailable",reason:"Linux native capability is not supported by macOS"};
      if(s.fixture==="no-cgroup"&&key==="cgroup_v2")return {state:"unavailable",reason:"controller_not_delegated"};
      if(s.fixture==="no-seccomp"&&key==="seccomp")return {state:"unavailable",reason:"profile_unavailable"};
    }
    return {state:"available",reason:s.fixture==="limited"&&key==="cgroup_v2"?"Only memory.* and pids.* controller fields available":"Agent-measured capability"};
  }
  function statusChip(value){return '<span class="cand-status '+h(value)+'">'+h(value)+'</span>';}
  function action(label,act,variant,disabled){
    return '<button type="button" class="cand-btn '+(variant||"")+'" data-action="'+h(act)+'"'+(disabled?' disabled aria-disabled="true"':'')+'>'+label+'</button>';
  }
  // Explanatory copy belongs behind a keyword. Hover/focus opens it on Web;
  // tapping the same accessible help button toggles it on App.
  function hint(term,description){
    if(!description)return "";
    var name=String(term||"Info").replace(/<[^>]*>/g,"").trim();
    var content=String(description)+"::"+name;
    var hash=0;
    for(var i=0;i<content.length;i++)hash=((hash<<5)-hash+content.charCodeAt(i))|0;
    var id="help-"+Math.abs(hash).toString(36);
    var open=s.tip===id;
    return '<span class="cand-tip-wrap" data-open="'+open+'">'+
      '<button type="button" class="cand-tip-trigger" data-action="hint:'+id+'" aria-label="About '+h(name)+'" aria-expanded="'+open+'" aria-controls="'+id+'">'+
        '<span class="cand-keyword">'+h(name)+'</span><span class="cand-tip-symbol" aria-hidden="true">ⓘ</span></button>'+
      '<span role="tooltip" class="cand-tip-body" id="'+id+'">'+h(description)+'</span></span>';
  }
  function meta(label,value,desc){return '<div class="cand-fact"><span>'+(desc?hint(label,desc):h(label))+'</span><strong>'+h(value)+'</strong></div>';}
  function card(title,desc,content){
    return '<section class="cand-card"><div class="cand-card-head"><h3>'+(desc?hint(title,desc):title)+'</h3></div>'+(content||"")+'</section>';
  }
  function alert(text,kind){return '<p class="cand-alert '+(kind||"info")+'" role="'+(kind==="danger"?"alert":"status")+'">'+h(text)+'</p>';}
  function sectionHead(title,sub,right){return '<div class="cand-section-head"><div><h2>'+(sub?hint(title,sub):title)+'</h2></div>'+(right||"")+'</div>';}
  function explainSupport(key){var x=nativeStatus(key);return '<div class="cand-support">'+statusChip(x.state)+' '+hint(key,x.reason)+'</div>';}
  function defaultWorkspaceHint(){
    if(s.session==="sandbox-review")return "Project Nession 在当前 Agent 的既有目录可默认使用。";
    return "无当前 Agent 的 Project Location；首次 Enter 时会按 Session 名自动分配 Managed Workspace。";
  }
  function resolveDefault(){
    if(s.selectedWorkspace!=="auto")return currentWorkspace();
    var name=s.session;
    var existing=s.workspaces.find(function(w){return w.kind==="managed"&&w.name===name;});
    return existing||{id:"pending",name:name,kind:"managed",status:"pending"};
  }
  function workspaceName(){var w=resolveDefault();return w?w.name:"none";}
  function effectiveDraft(){
    var w=resolveDefault(), mounted=s.tools.map(function(id){var im=imageBy(id);return {source:im?im.digest:"missing",target:id==="rust"?s.toolTarget:"/opt/node",read_only:true};});
    return {filesystem:{rootfs:{source:s.rootMode==="host"?{kind:"host"}:{kind:"image",digest:imageBy(s.rootImage).digest},implicit_target:"/"},
      mounts:mounted,workspace:{source:w?{kind:w.kind,id:w.id,name:w.name}:null,implicit_target:"/workspace",mount_mode:s.workspaceLower?"overlay":"bind",lower_image:s.workspaceLower?imageBy("source").digest:null},
      access:{read:s.readPaths.split("\n").filter(Boolean),write:s.writePaths.split("\n").filter(Boolean)},
      home:{kind:s.home}},network:{mode:s.network},
      linux_namespace:Object.assign({},s.namespace),cgroup_v2:s.cgroup?{"memory.max":s.cgroup}:{},seccomp:s.seccomp?{profile:"nession-interactive-v1"}:null};
  }
  function check(){
    if(!hasSession())return "A current Session is required to access Sandbox.";
    if(!online())return "Agent offline: capabilities and mounts cannot be verified.";
    if(s.fixture==="preflight-fail")return "Agent reported a failed preflight (mock).";
    if(s.rootMode==="image"&&nativeStatus("filesystem.composition").state!=="available")return "filesystem.composition unavailable on this Agent.";
    if(s.rootMode==="host"&&nativeStatus("filesystem.access").state!=="available")return "filesystem.access unavailable on this Agent.";
    if(s.rootMode==="image"&&(s.readPaths.trim()||s.writePaths.trim()))return "Current V1: EROFS root and access.read/write are mutually exclusive.";
    if(s.tools.length&&s.rootMode!=="image")return "Current V1: tool EROFS mounts require the prepared EROFS root.";
    if(s.tools.includes("rust")&&s.toolTarget!=="/opt/rust")return "V1 tool target must remain /opt/<name>; this Rust image is constrained to /opt/rust.";
    if(s.tools.some(function(t){return !imageBy(t)||imageBy(t).status!=="ready";}))return "Selected tool image is not Server Ready.";
    if(s.rootMode==="image"&&(!imageBy(s.rootImage)||imageBy(s.rootImage).status!=="ready"))return "Base Runtime image is not Server Ready.";
    var paths=[s.readPaths,s.writePaths].join("\n").split("\n").filter(Boolean);
    if(paths.some(function(p){return !p.startsWith("/")||p.indexOf("..")>=0}))return "access paths must be absolute normalized host paths.";
    if(s.network==="restricted"&&macos())return "This macOS backend does not support restricted network mode.";
    if(s.seccomp&&nativeStatus("seccomp").state!=="available")return "seccomp unavailable on current Agent.";
    if(s.cgroup&&nativeStatus("cgroup_v2").state!=="available")return "cgroup_v2 unavailable on current Agent.";
    if(Object.keys(s.namespace).some(function(k){return s.namespace[k]})&&nativeStatus("linux_namespace").state!=="available")return "linux_namespace unavailable on current Agent.";
    if(s.workspaceLower&&s.rootMode!=="image")return "Workspace EROFS lower requires an EROFS RootFS in current V1.";
    if(s.workspaceLower&&resolveDefault().kind!=="managed")return "EROFS Overlay Lower requires an Agent-managed writable Workspace; Project Location is bound directly.";
    if(s.workspaceLower&&macos())return "Workspace Overlay mounting is not supported by this macOS Agent.";
    if(s.selectedWorkspace!=="auto"&&!currentWorkspace())return "Selected Workspace is missing; choose a valid Agent resource.";
    if(s.selectedWorkspace!=="auto"&&currentWorkspace().status!=="available")return "Selected Workspace is not currently available.";
    return "";
  }
  function ensureAutoWorkspace(){
    if(s.selectedWorkspace!=="auto")return;
    var old=s.workspaces.find(function(w){return w.kind==="managed"&&w.name===s.session;});
    if(old){s.selectedWorkspace=old.id;return;}
    var id="ws:"+String(Date.now())+":"+s.workspaces.length;
    var name=s.session;
    s.workspaces.push({id:id,name:name,kind:"managed",project:"—",path:"Agent-managed / "+id,status:"available"});
    s.selectedWorkspace=id;
    s.notice="Workspace “"+name+"” ready.";
  }
  function nav(){
    return '<nav class="cand-primary" aria-label="Sandbox sections">'+sections.map(function(x){
      return '<button type="button" data-action="area:'+x[0]+'"'+(s.area===x[0]?' aria-current="page"':'')+'>'+x[1]+'</button>';
    }).join("")+'</nav>';
  }
  function subNav(area){
    var keys=subs[area]||[];
    return '<nav class="cand-sub" aria-label="'+h(area)+" sections"+'">'+
      '<span class="cand-sub-label">'+h(area)+'</span>'+keys.map(function(x){
        return '<button type="button" data-action="sub:'+area+":"+x[0]+'"'+(s.sub[area]===x[0]?' aria-current="page"':'')+'>'+h(x[1])+'</button>';
      }).join("")+'</nav>';
  }
  function layout(area,panel){
    return '<div class="cand-split">'+subNav(area)+'<div class="cand-main">'+panel+'</div></div>';
  }
  function overview(){
    var status=s.inside?"Verified Sandbox Pane":online()?"Native Pane":"Unverified · Agent offline";
    var w=resolveDefault();
    var lead=sectionHead("Overview","当前 Session 的隔离执行、资源和能力状态",statusChip(s.inside?"applied":online()?"available":"unknown"));
    var cards='<div class="cand-grid">'+
      '<button class="cand-tile" type="button" data-action="area:images"><strong>Images</strong><span>'+s.images.length+' Server registry entries</span><small>Library · Builds · Distribution</small></button>'+
      '<button class="cand-tile" type="button" data-action="area:workspaces"><strong>Workspaces</strong><span>'+s.workspaces.length+' resources on current Agent</span><small>'+h(w?w.name:"Auto allocation")+'</small></button>'+
      '<button class="cand-tile" type="button" data-action="area:policies"><strong>Policies</strong><span>5 capabilities</span><small>Filesystem · Network · Native isolation</small></button></div>';
    var facts='<div class="cand-facts">'+meta("Selected Session",s.session)+meta("Agent / Location","nession-dev",online()?(macos()?"macOS · Seatbelt":"Linux · Bubblewrap"):"Offline")+
      meta("Pane",status,s.inside?"Effective policy (read-only)":"Draft may be configured")+meta("Workspace",w?w.name:"Auto allocation",w?w.kind:"Not selected")+'</div>';
    var buttons=s.inside?'<div class="cand-actions">'+action("Return to Native Pane","return-native","primary")+
      action("Execution evidence","detail","","")+'</div>':
      '<div class="cand-actions">'+action("Validate policy","validate","",!online())+
      action("Enter Sandbox","enter","primary",s.preflight!=="passed"||!online())+'</div>';
    return lead+cards+card("Current execution","Scope: current Session / active tmux Pane; Sandbox is not global.",
      facts+(s.preflight==="passed"?alert("Validation passed.","success"):"")+
      (s.preflight==="failed"?alert(s.error,"danger"):"")+(s.notice?alert(s.notice):"")+buttons);
  }
  function imageLibrary(){
    var x=imageBy(s.selectedImage)||s.images[0];
    var left=s.images.map(function(im){return '<button class="cand-item '+(im.id===s.selectedImage?"selected":"")+'" data-action="image:'+im.id+'"><span><strong>'+h(im.name)+'</strong><small>'+h(im.kind)+' · '+short(im.digest)+'</small></span>'+statusChip(im.status)+'</button>';}).join("");
    var details=x?card("Image detail","Server-owned immutable image; selected Session is navigation context.",
      '<div class="cand-facts">'+meta("Name",x.name)+meta("Digest",short(x.digest))+meta("Server status",x.status)+meta("Agent cache",online()?(s.cache[x.id]||"absent"):"unknown")+'</div>'+
      '<div class="cand-actions">'+action("Use as RootFS","image-root:"+x.id,"",x.kind!=="Base Runtime"||!isEditable())+
      action("Mount in Filesystem","image-tool:"+x.id,"",x.kind!=="Toolchain"||!isEditable())+'</div>'):"";
    return sectionHead("Image Library","全局 Server 镜像列表；不随 Session 切换而复制")+
      '<div class="cand-list">'+left+'</div>'+details;
  }
  function imageBuilds(){
    return sectionHead("Builds","Server 构建任务、进度与失败诊断（均为模拟数据）",
      action("+ New build","build-start","primary"))+
      '<div class="cand-list">'+s.builds.map(function(b){return '<div class="cand-row"><div><strong>'+h(b.name)+'</strong><small>'+h(b.id)+' · '+h(b.detail)+'</small></div>'+statusChip(b.status)+
      (b.status==="building"?action("Complete","build-complete:"+b.id):"")+'</div>';}).join("")+'</div>';
  }
  function distribution(){
    return sectionHead("Distribution","按当前 Agent 观察缓存；Server Ready 不代表 Agent 已准备完成")+
      card("Server → Agent","按需授权、校验并缓存；不隐含自动广播到所有 Agent。",
      '<div class="cand-list">'+s.images.map(function(im){
        var cs=online()?(s.cache[im.id]||"absent"):"unknown";
        return '<div class="cand-row"><div><strong>'+h(im.name)+'</strong><small>Server: '+h(im.status)+' · '+short(im.digest)+'</small></div>'+statusChip(cs)+
          (online()&&cs!=="verified"?action("Prepare cache","cache:"+im.id,"",false):"")+'</div>';
      }).join("")+'</div>');
  }
  function imagesPanel(){return layout("images",s.sub.images==="builds"?imageBuilds():s.sub.images==="distribution"?distribution():imageLibrary());}
  function workspaceList(){
    var rows=s.workspaces.map(function(w){
      var selected=s.selectedWorkspace===w.id;
      return '<div class="cand-row"><div class="cand-wsrow"><strong>'+h(w.name)+'</strong><small>'+h(w.kind)+
        (w.kind==="project_location"?" · "+h(w.path):" · Agent-managed persistent")+'</small>'+
        '<small>'+h(w.project||"—")+' · nession-dev'+(selected?" · Selected for /workspace":"")+'</small></div>'+
        statusChip(online()?w.status:"unknown")+
        action(selected?"Selected":"Use","ws-use:"+w.id,selected?"muted":"",!online()||s.inside||w.status!=="available")+
        (w.kind==="managed"?action("Delete","ws-delete:"+w.id,"danger",selected||w.status!=="available"||!online()||s.inside):"")+'</div>';
    }).join("");
    var auto=s.workspaces.find(function(w){return w.kind==="managed"&&w.name===s.session;});
    return (s.notice?alert(s.notice):"")+sectionHead("Agent Workspaces","可命名、可发现、可复用。Workspace 资源数据由当前 Agent 管理。")+
      card("Default workspace","Explicit reference → matching Project Location → get_or_create(session.name). "+defaultWorkspaceHint(),
        '<div class="cand-actions">'+action(auto?"Reuse “"+h(s.session)+"”":"Allocate “"+h(s.session)+"”","ws-auto","",!online()||s.inside)+
        action("Configure Filesystem","area:policies")+'</div>')+
      card("Create Workspace","Name is a lookup alias; physical storage is keyed by an opaque Workspace ID.",
        '<div class="cand-inline"><input aria-label="Managed Workspace name" data-field="newWorkspaceName" placeholder="e.g. experiment-02" value="'+h(s.newWorkspaceName)+'"'+(!isEditable()?' disabled':'')+'>'+
        action("Create / Reuse","ws-create","primary",!online()||s.inside)+'</div>')+
      '<div class="cand-list">'+rows+'</div>'+
      (s.deletePending?alert("Delete Workspace “"+(s.workspaces.find(function(w){return w.id===s.deletePending;})||{}).name+"”? This deletes its stored data.","danger")+
        '<div class="cand-actions">'+action("Cancel","ws-delete-cancel")+action("Delete Workspace","ws-delete-confirm","danger")+'</div>':"");
  }
  function workspaceDetail(){
    var w=currentWorkspace();
    return sectionHead("Workspace Detail","Workspace 管理和 Filesystem 消费不重复登记资源")+
      card(w?h(w.name):"Auto-allocated Workspace","Current Agent is the authority for directory and mount state.",
      '<div class="cand-facts">'+meta("Kind",w?w.kind:"pending")+meta("Name",w?w.name:s.session)+meta("Agent","nession-dev")+
      meta("Physical source",w?w.path:"Allocated by Agent on first Enter")+meta("Mapping","Implicit /workspace")+
      meta("Lifecycle",w&&w.kind==="project_location"?"User-owned; never delete":"Managed: retained after Session ends")+'</div>'+
      '<div class="cand-actions">'+action("Configure in Filesystem","policy:filesystem","primary")+
      action("Back to list","sub:workspaces:list")+'</div>');
  }
  function workspacesPanel(){return layout("workspaces",s.sub.workspaces==="details"?workspaceDetail():workspaceList());}
  function field(label,control,help){
    // Help buttons must not be nested inside labels wrapping another control.
    if(!/aria-label=/.test(control))control=control.replace(/^<(input|textarea|select)(\s|>)/,'<$1 aria-label="'+h(label)+'"$2');
    return '<div class="cand-field"><div class="cand-field-label">'+(help?hint(label,help):h(label))+'</div>'+control+'</div>';
  }
  function selectField(key,options,disabled){
    return '<select data-field="'+key+'" aria-label="'+key+'"'+(disabled?' disabled':'')+'>'+options.map(function(o){
      return '<option value="'+h(o[0])+'"'+(String(s[key])===String(o[0])?' selected':'')+'>'+h(o[1])+'</option>';
    }).join("")+'</select>';
  }
  function fsPanel(){
    var locked=!isEditable(),w=resolveDefault(),accessConflict=s.rootMode==="image"&&(s.readPaths.trim()||s.writePaths.trim());
    var root=card("Root filesystem","The source is mounted to / automatically. A single Base Runtime image supplies the read-only root; no repackaging.",
      explainSupport(s.rootMode==="image"?"filesystem.composition":"filesystem.access")+
      field("Root source",selectField("rootMode",[["image","EROFS · Base Runtime"],["host","Host root / access policy"]],locked),
        "rootfs source → / (fixed target; no editable target field)")+
      (s.rootMode==="image"?'<div class="cand-row"><div><strong>minimal-glibc-runtime</strong><small>'+short(imageBy("base").digest)+'</small></div>'+statusChip("read-only")+'</div>':""));
    var mounts=card("Mounts","Tools use an explicit authorized image source and target, currently constrained to /opt/<name> and read-only.",
      field("Toolchain image",'<div class="cand-check">'+["rust","node"].map(function(id){
        var im=imageBy(id);return '<label><input data-tool="'+id+'" type="checkbox"'+(s.tools.includes(id)?" checked":"")+(locked?" disabled":"")+'> '+h(im.name)+' <small>('+short(im.digest)+')</small></label>';
      }).join("")+'</div>')+
      (s.tools.includes("rust")?field("Rust mount target",'<input data-field="toolTarget" value="'+h(s.toolTarget)+'"'+(locked?' disabled':'')+' aria-label="Rust mount target">',"Explicit target: /opt/rust. Unsupported targets fail preflight."):"")+
      '<div class="cand-map">'+s.tools.map(function(id){return '<div><code>'+h(imageBy(id).name)+'</code><span>→ '+h(id==="rust"?s.toolTarget:"/opt/node")+' · ro</span></div>';}).join("")+'</div>');
    var wOpts=[["auto","Auto · "+s.session]].concat(s.workspaces.map(function(x){return [x.id,x.name+" · "+x.kind];}));
    var wsSelected=s.selectedWorkspace==="auto"?"auto":s.selectedWorkspace;
    var wsSelect='<select data-field="selectedWorkspace" aria-label="Select workspace"'+(locked?' disabled':'')+'>'+wOpts.map(function(o){
      return '<option value="'+h(o[0])+'"'+(wsSelected===o[0]?' selected':'')+'>'+h(o[1])+'</option>';
    }).join("")+'</select>';
    var workspace=card("Workspace","An Agent Workspace is mounted at /workspace. Managed volumes can be reused; Project Location remains user-owned.",
      field("Workspace source",wsSelect,"Explicit choice > Project's current Agent location > named managed get-or-create")+
      '<label class="cand-check"><input type="checkbox" data-workspace-lower'+(s.workspaceLower?" checked":"")+(locked||!w||w.kind!=="managed"?" disabled":"")+'> EROFS lower + Overlay</label>'+
      (s.workspaceLower?'<div class="cand-map"><div><code>Lower</code><span>nession-source · '+short(imageBy("source").digest)+'</span></div><div><code>Upper</code><span>Managed Workspace · rw</span></div></div>':"")+
      '<div class="cand-small-note">'+hint("Overlay details","The Project image is immutable; Agent-managed upper/work directories preserve changes and pin the lower digest.")+'</div>'+
      '<div class="cand-facts">'+meta("Resolved source",w?w.name:"—")+meta("Map target","/workspace (implicit)")+meta("Owner",w&&w.kind==="project_location"?"External / Project Location":"Agent Workspace Manager")+'</div>'+
      '<div class="cand-actions">'+action("Manage Workspaces","area:workspaces")+'</div>');
    var access=card("Access","Read/write always map Agent path P to the identical Sandbox path P; they never accept a separate target.",
      '<div class="cand-pair">'+field("Read paths",'<textarea rows="2" data-field="readPaths" placeholder="/usr/share"'+(locked?' disabled':'')+'>'+h(s.readPaths)+'</textarea>',"P → P · read-only")+
      field("Write paths",'<textarea rows="2" data-field="writePaths" placeholder="/home/dev/project"'+(locked?' disabled':'')+'>'+h(s.writePaths)+'</textarea>',"P → P · read/write")+'</div>'+
      (accessConflict?alert("Current V1: filesystem.access and EROFS root composition cannot be combined. Clear paths or select Host.","danger"):"")+
      '<div class="cand-map">'+s.readPaths.split("\n").filter(Boolean).map(function(p){return '<div><code>'+h(p)+'</code><span>→ '+h(p)+' · ro</span></div>';}).join("")+
      s.writePaths.split("\n").filter(Boolean).map(function(p){return '<div><code>'+h(p)+'</code><span>→ '+h(p)+' · rw</span></div>';}).join("")+'</div>');
    var home=card("Home","Home is separate from /workspace. Current Linux execution uses a temporary /home tmpfs.",
      field("Home lifecycle",selectField("home",[["ephemeral","Ephemeral"],["session","Session persistent"]],locked),
        "Separate from /workspace; actual persistent Home requires future runtime implementation.")) ;
    return sectionHead("Filesystem","RootFS, mounts, Workspace and access mappings",statusChip(s.inside?"applied":"draft"))+
      root+mounts+workspace+access+home+
      card("Mount view","The map is a draft preview until Enter succeeds; applied details are read-only.",
        '<div class="cand-map"><div><code>/</code><span>← '+(s.rootMode==="image"?"Base Runtime EROFS · ro":"Host root view")+'</span></div>'+
        s.tools.map(function(id){return '<div><code>'+h(id==="rust"?s.toolTarget:"/opt/node")+'</code><span>← '+h(imageBy(id).name)+' · ro</span></div>';}).join("")+
        '<div><code>/workspace</code><span>← '+h(workspaceName())+(s.workspaceLower?" · EROFS lower + persistent Overlay":" · rw bind")+'</span></div><div><code>/home</code><span>← '+h(s.home==="ephemeral"?"tmpfs":"proposed Session directory")+'</span></div></div>');
  }
  function networkPanel(){
    var locked=!isEditable();
    return sectionHead("Network","Stable cross-platform contract. Backends expose only measured modes.")+
      card("Network isolation","Current Agent exposes supported modes; macOS Seatbelt does not support restricted.",
        explainSupport("network")+
        field("Network mode",selectField("network",[["allow","Allow"],["deny","Deny"],["restricted","Restricted (proxy rules)"]],locked),
          "Ingress remains denied in this V1 design.")+
        (s.network==="restricted"&&macos()?alert("restricted is unavailable on the macOS Seatbelt fixture.","danger"):""));
  }
  function nativePanel(key){
    var support=nativeStatus(key),locked=!isEditable()||support.state!=="available";
    var title=key==="linux_namespace"?"Linux Namespace":key==="cgroup_v2"?"Cgroup v2":"Seccomp";
    var content=explainSupport(key);
    if(key==="linux_namespace")content+='<div class="cand-check">'+Object.keys(s.namespace).map(function(k){
      return '<label><input type="checkbox" data-ns="'+k+'"'+(s.namespace[k]?" checked":"")+(locked?" disabled":"")+'> '+k.toUpperCase()+' namespace</label>';
    }).join("")+'</div>';
    if(key==="cgroup_v2")content+=field("memory.max · native cgroup value",'<input data-field="cgroup" value="'+h(s.cgroup)+'" placeholder="2147483648"'+(locked?' disabled':'')+'>',
      "Raw Linux controller value; partially delegated hosts may lack other fields.");
    if(key==="seccomp")content+='<label class="cand-check"><input type="checkbox" data-seccomp'+(s.seccomp?" checked":"")+(locked?" disabled":"")+'> Enable registered nession-interactive-v1 profile</label>';
    if(locked)content+=alert(nativeStatus(key).reason,"danger");
    return sectionHead(title,"Native capability key, not Process/Resource/Syscall group")+
      card(title+" policy","Current Agent controls support and allowed values.",content);
  }
  function policiesPanel(){
    var selected=s.sub.policies;
    var panel=selected==="filesystem"?fsPanel():selected==="network"?networkPanel():nativePanel(selected);
    var actions=s.inside?'<div class="cand-actions">'+action("Return Native","return-native","primary")+'</div>':
      '<div class="cand-actions">'+action("Validate policy","validate","",!online())+
      action("Enter Sandbox","enter","primary",s.preflight!=="passed"||!online())+'</div>';
    return layout("policies",panel+(s.preflight==="failed"?alert(s.error,"danger"):s.preflight==="passed"?alert("Validation passed.","success"):"")+
      card("Policy actions","Policy edits invalidate prior preflight; only the selected Agent determines native support.",actions));
  }
  function confirmation(){
    return sectionHead("Confirm Enter","One new isolated Pane in the current Session. Native Pane remains intact.")+
      alert("Native Pane will remain available.")+
      card("Prepared mapping summary","The Agent will resolve authorized sources to native paths; the Web never provides them.",
        '<pre class="cand-json">'+h(JSON.stringify(effectiveDraft(),null,2))+'</pre>'+
        '<div class="cand-actions">'+action("Cancel","cancel-enter")+action("Enter Sandbox","confirm-enter","primary")+'</div>');
  }
  function evidence(){
    return sectionHead("Execution evidence","Read-only observed Pane scope, not the entire tmux Session.")+
      card("Execution details","Verified scope: current Pane; security proof requires the Agent.",'<div class="cand-facts">'+meta("Pane","%8 · isolated")+
      meta("Execution","sandbox-demo-001")+meta("Backend",macos()?"Seatbelt":"Linux Bubblewrap")+
      meta("Verification","verified")+'</div>'+
      '<div class="cand-actions">'+action("Back to Overview","cancel-detail","primary")+'</div>');
  }
  function terminal(){
    if(!hasSession())return '<div class="terminal"><div class="terminal-head"><b>No selected Session</b></div><p class="cand-help">Sandbox requires an active Session. Choose a Session to discover this capability.</p></div>';
    return '<div class="terminal"><div class="terminal-head"><b>'+h(s.session)+'</b><span class="subtxt">Terminal · mock</span></div>'+
      '<pre class="term-output"><span class="prompt">➜</span> /workspace  git status --short\n M crates/nession-sandbox/src/policy.rs\n\n<span class="prompt">➜</span> /workspace  cargo test\nrunning... pass\n\n<span class="prompt">➜</span> /workspace ▌</pre>'+
      '<div class="cand-actions">'+action("Open Sandbox Workspace","open-sandbox","primary")+'</div></div>';
  }
  function sandbox(){
    if(!hasSession())return '<section class="workspace"><div class="workspace-inner">'+sectionHead("No selected Session","Select a Session to open Sandbox.")+'</div></section>';
    var pane=s.depth==="confirm"?confirmation():s.depth==="detail"?evidence():s.area==="overview"?overview():s.area==="images"?imagesPanel():s.area==="workspaces"?workspacesPanel():policiesPanel();
    var heading='<header class="cand-cap-header"><div class="cand-cap-title"><h2>Sandbox</h2><p>Session '+h(s.session)+' · Agent nession-dev'+(s.inside?" · Inside":" · Native")+'</p></div>'+nav()+'</header>';
    return '<section class="workspace cand-workspace"><div class="workspace-inner cand-wide">'+heading+
      (s.depth==="root"?pane:'<div class="cand-main">'+pane+'</div>')+'</div></section>';
  }
  function capsule(){
    return '<div class="bottom-zone">'+(s.mode==="web"?'<button class="round" type="button" data-action="to-terminal" aria-label="Return Terminal">↩</button>':"")+
      '<nav class="capsule workspace-cap" aria-label="Workspace capabilities"><div class="capsule-row">'+
      '<button class="cap-item" data-action="open-sandbox" aria-current="page">⬡ Sandbox</button>'+
      '<button class="cap-item" data-action="to-terminal">▣ Terminal</button></div></nav></div>';
  }
  function sidebar(){
    return '<aside class="sidebar"><div class="sidebar-head"><span class="wordmark">nession</span><span class="minor">⌘</span></div>'+
      '<div class="side-label">Sessions</div>'+
      '<button class="navrow '+(s.session==="sandbox-review"?"selected":"")+'" data-action="session:sandbox-review"><span>▣</span><span class="navtext">sandbox-review<br><small>Nession project · nession-dev</small></span></button>'+
      '<button class="navrow '+(s.session==="fix-terminal"?"selected":"")+'" data-action="session:fix-terminal"><span>▣</span><span class="navtext">fix-terminal<br><small>No project · nession-dev</small></span></button>'+
      '<div class="side-label">Projects</div><div class="navrow">◫ Nession</div>'+
      '<div class="side-label">Agents</div><div class="navrow">◉ nession-dev · '+(online()?"online":"offline")+'</div></aside>';
  }
  function render(){
    var prev=view.querySelector(".cand-main");
    var y=prev?prev.scrollTop:0;
    var main=s.surface==="terminal"?terminal():sandbox();
    view.setAttribute("data-mode",s.mode);
    view.innerHTML=s.mode==="web"?
      '<div class="shell">'+sidebar()+'<main class="main"><div class="main-content">'+main+'</div>'+capsule()+'</main></div>':
      '<div class="app"><header class="app-header"><button class="arrow" type="button" data-action="'+(s.depth!=="root"?"cancel-detail":s.surface==="workspace"?"to-terminal":"to-sessions")+'" aria-label="Back">←</button>'+
      '<span class="app-title">'+(s.surface==="terminal"?h(s.session):"Sandbox")+'</span><span class="minor">nession-dev</span></header>'+
      '<main class="app-body">'+main+'</main>'+(s.surface==="workspace"?capsule():"")+'</div>';
    if(inspector)inspector.textContent=JSON.stringify({mode:s.mode,selected_session:s.session,area:s.area,sub:s.sub,fixture:s.fixture,inside:s.inside,
      selected_workspace:s.selectedWorkspace,workspace_inventory:s.workspaces,images_registry:s.images.map(function(x){return {name:x.name,digest:x.digest,status:x.status};}),
      mock_preflight:s.preflight,filesystem:effectiveDraft().filesystem},null,2);
    if(s.mode==="web"){
      var current=view.querySelector(".cand-main");
      if(current)current.scrollTop=y;
    }
  }
  function dirty(){s.preflight="none";s.error="";s.notice="";}
  function handleField(t){
    var fieldName=t.getAttribute("data-field");
    if(fieldName){
      var val=t.value;
      if(fieldName==="newWorkspaceName")s.newWorkspaceName=val;
      else if(fieldName==="selectedWorkspace"){s.selectedWorkspace=val;dirty();}
      else if(["rootMode","rootImage","toolTarget","readPaths","writePaths","home","network","cgroup"].includes(fieldName)){
        s[fieldName]=val;dirty();
      }
      return true;
    }
    if(t.hasAttribute("data-tool")){var id=t.getAttribute("data-tool");s.tools=t.checked?Array.from(new Set(s.tools.concat(id))):s.tools.filter(function(x){return x!==id;});dirty();return true;}
    if(t.hasAttribute("data-ns")){s.namespace[t.getAttribute("data-ns")]=t.checked;dirty();return true;}
    if(t.hasAttribute("data-seccomp")){s.seccomp=t.checked;dirty();return true;}
    if(t.hasAttribute("data-workspace-lower")){s.workspaceLower=t.checked;dirty();return true;}
    return false;
  }
  function doAction(a){
    if(a.indexOf("hint:")===0){var id=a.slice(5);s.tip=s.tip===id?null:id;return;}
    s.tip=null;
    if(a.indexOf("area:")===0){s.area=a.slice(5);s.depth="root";return;}
    if(a.indexOf("sub:")===0){var p=a.split(":");if(subs[p[1]]&&subs[p[1]].some(function(x){return x[0]===p[2];})){s.area=p[1];s.sub[p[1]]=p[2];}return;}
    if(a.indexOf("policy:")===0){s.area="policies";s.sub.policies=a.slice(7);return;}
    if(a==="open-sandbox"){s.surface="workspace";s.depth="root";return;}
    if(a==="to-terminal"){s.surface="terminal";s.depth="root";return;}
    if(a==="to-sessions"){s.surface="terminal";return;}
    if(a.indexOf("session:")===0){
      s.session=a.slice(8);s.selectedWorkspace=s.session==="sandbox-review"?"project:nession":"auto";
      s.surface="workspace";s.area="overview";s.depth="root";s.inside=false;dirty();return;
    }
    if(a.indexOf("image:")===0){s.selectedImage=a.slice(6);return;}
    if(a.indexOf("image-root:")===0){var id=a.slice(11);if(imageBy(id)&&imageBy(id).kind==="Base Runtime"&&isEditable()){s.rootImage=id;s.rootMode="image";s.area="policies";s.sub.policies="filesystem";dirty();}return;}
    if(a.indexOf("image-tool:")===0){var id=a.slice(11);if(imageBy(id)&&imageBy(id).kind==="Toolchain"&&isEditable()){s.tools=Array.from(new Set(s.tools.concat(id)));s.area="policies";s.sub.policies="filesystem";dirty();}return;}
    if(a==="build-start"){
      var id="build-"+(121+s.builds.length);
      s.builds.unshift({id:id,name:"prototype-build-"+(s.builds.length+1),status:"building",detail:"EROFS build in progress"});
      s.sub.images="builds";return;
    }
    if(a.indexOf("build-complete:")===0){
      var b=s.builds.find(function(x){return x.id===a.slice(15);});
      if(b){b.status="completed";b.detail="Digest registered";s.images.push(image("built"+s.builds.length,b.name,"Toolchain","e"));}
      return;
    }
    if(a.indexOf("cache:")===0){if(online()){s.cache[a.slice(6)]="verified";s.notice="Cache verified on current Agent";}return;}
    if(a.indexOf("ws-use:")===0){if(isEditable()&&s.workspaces.some(function(w){return w.id===a.slice(7);})){s.selectedWorkspace=a.slice(7);dirty();}return;}
    if(a==="ws-auto"){
      if(!isEditable())return;
      dirty();s.selectedWorkspace="auto";ensureAutoWorkspace();s.sub.workspaces="details";return;
    }
    if(a==="ws-create"){
      if(!isEditable())return;
      var name=s.newWorkspaceName.trim();
      if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)){s.notice="Enter a valid workspace name: letters, digits, dot, underscore or hyphen.";return;}
      var old=s.workspaces.find(function(w){return w.kind==="managed"&&w.name===name;});
      dirty();
      if(old){s.selectedWorkspace=old.id;s.notice="Reused existing named Managed Workspace “"+name+"”.";}
      else{
        var id="ws:manual:"+String(s.workspaces.length+1);
        s.workspaces.push({id:id,name:name,kind:"managed",project:"—",path:"Agent-managed / "+id,status:"available"});
        s.selectedWorkspace=id;s.notice="Workspace “"+name+"” created.";
      }
      s.newWorkspaceName="";return;
    }
    if(a.indexOf("ws-delete:")===0){if(isEditable())s.deletePending=a.slice(10);return;}
    if(a==="ws-delete-cancel"){s.deletePending=null;return;}
    if(a==="ws-delete-confirm"){
      var w=s.workspaces.find(function(x){return x.id===s.deletePending;});
      if(w&&w.kind==="managed"&&s.selectedWorkspace!==w.id){s.workspaces=s.workspaces.filter(function(x){return x.id!==w.id;});s.notice="Workspace deleted";}
      s.deletePending=null;return;
    }
    if(a==="validate"){var error=check();s.preflight=error?"failed":"passed";s.error=error;return;}
    if(a==="enter"){if(s.preflight==="passed"&&!s.inside)s.depth="confirm";return;}
    if(a==="cancel-enter"||a==="cancel-detail"){s.depth="root";return;}
    if(a==="confirm-enter"){
      var error=check();
      if(error){s.preflight="failed";s.error=error;s.depth="root";return;}
      if(s.fixture==="enter-fail"){s.preflight="failed";s.error="Mock mount preparation failed; Native Pane remains selected.";s.depth="root";return;}
      ensureAutoWorkspace();s.effective=effectiveDraft();s.inside=true;s.depth="root";s.area="overview";s.preflight="none";
      s.notice="Sandbox entered · Native Pane retained.";return;
    }
    if(a==="return-native"){s.inside=false;s.preflight="none";s.depth="root";s.area="overview";return;}
    if(a==="detail"){s.depth="detail";return;}
  }
  view.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&s.tip){s.tip=null;render();}
  });
  view.addEventListener("click",function(e){
    var b=e.target.closest("[data-action]");
    if(!b||b.disabled){if(s.tip){s.tip=null;render();}return;}
    doAction(b.getAttribute("data-action"));
    render();
  });
  view.addEventListener("input",function(e){if(!handleField(e.target))return;
    var err=view.querySelector(".cand-alert.success");if(err)err.hidden=true;
    var enter=view.querySelector('[data-action="enter"]');if(enter)enter.disabled=true;
  });
  view.addEventListener("change",function(e){if(handleField(e.target))render();});
  root.querySelectorAll("[data-fixture]").forEach(function(b){
    b.addEventListener("click",function(){
      var newFixture=b.getAttribute("data-fixture");
      var previous=s;
      s=defaults();s.width=previous.width;s.mode=previous.mode;
      s.fixture=newFixture;
      if(newFixture==="inside"){s.inside=true;s.effective=effectiveDraft();}
      if(newFixture==="macos"){s.namespace={pid:false,ipc:false,user:false,uts:false,cgroup:false};s.network="deny";}
      if(newFixture==="no-session"){s.surface="terminal";}
      root.querySelectorAll("[data-fixture]").forEach(function(x){x.setAttribute("aria-pressed",String(x===b));});
      render();
    });
  });
  root.addEventListener("np:resize",function(e){
    s.width=Number(e.detail.width);s.mode=s.width>=600?"web":"app";
    device.style.setProperty("--np-device-height",s.mode==="web"?"760px":"844px");
    render();
  });
  // Frame initializes after this script, dispatching initial resize.
  window.__sandboxPrototype={getState:function(){return s;},reset:function(){s=defaults();render();},validate:check};
  render();
})();