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
  function image(id,name,kind,letter,mount){var sizes={base:24000000,base2:21000000,rust:104000000,node:48000000,source:58000000};return {id:id,name:name,kind:kind,digest:"sha256:"+letter.repeat(64),status:"ready",default_mount:mount||null,size_bytes:sizes[id]||35000000};}
  var initialImages=[
    image("base","minimal-glibc-runtime","Base Runtime","a"),
    image("base2","alpine-runtime","Base Runtime","f"),
    image("rust","rust-toolchain","Toolchain","b","/opt/rust"),
    image("node","node-toolchain","Toolchain","c","/opt/node"),
    image("source","nession-source","Project Source","d","/opt/nession-source")
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
      builds:[
        {id:"build-120",name:"nession-source",status:"running",stage:"packaging",elapsed_ms:68000,files:2317,bytes:58240000,attempt:1,diagnostic:"mkfs.erofs"},
        {id:"build-119",name:"rust-toolchain",status:"succeeded",stage:"publishing",elapsed_ms:93000,files:15290,bytes:104000000,attempt:1,diagnostic:"Digest published"},
        {id:"build-118",name:"node-toolchain",status:"failed",stage:"snapshotting",elapsed_ms:12000,files:null,bytes:null,attempt:1,diagnostic:"Snapshot failed: source unavailable"}
      ],
      cache:{base:"verified",base2:"absent",rust:"verified",node:"preparing",source:"verified"},
      transfers:{node:{state:"resumable",received:12000000,total:48000000},base2:{state:"absent",received:0,total:21000000}},
      workspaces:initialWorkspaces(),selectedWorkspace:"project:nession",newWorkspaceName:"",deletePending:null,
      rootMode:"image",rootImage:"base",tools:[],toolTarget:"/opt/rust",mountTargets:{rust:"/opt/rust",node:"/opt/node",source:"/opt/nession-source"},mountToAdd:"rust",workspaceLower:false,workspaceManualName:"",readPaths:"",writePaths:"",
      home:"ephemeral",network:"deny",namespace:{pid:true,ipc:true,user:true,uts:false,cgroup:false},
      cgroup:"",seccomp:false,preflight:"none",error:"",notice:"",inside:false,effective:null,selectedImage:null,imageAction:"",
      step:0,tip:null,fsInspect:false};
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
    if(s.selectedWorkspace!=="auto"&&s.selectedWorkspace!=="manual")return currentWorkspace();
    var name=s.selectedWorkspace==="manual"?s.workspaceManualName.trim():s.session;
    var existing=s.workspaces.find(function(w){return w.kind==="managed"&&w.name===name;});
    return existing||{id:"pending",name:name||"Custom name",kind:"managed",status:"pending"};
  }
  function workspaceName(){var w=resolveDefault();return w?w.name:"none";}
  // Proposed declaration: RootFS, additional mounts and selected Workspace
  // remain independent of access.read/write even when the current runtime
  // cannot yet enforce every combination.
  function effectiveDraft(){
    var w=resolveDefault();
    return {filesystem:{
        rootfs:{source:s.rootMode==="image"?{kind:"image",digest:imageBy(s.rootImage)?.digest||""}:{kind:"local"},target:"/"},
        mounts:s.tools.map(function(id){var im=imageBy(id);return {source:{kind:"image",digest:im?im.digest:""},target:s.mountTargets[id],read_only:true};}),
        workspace:{source:w?{kind:w.kind,id:w.id,name:w.name}:null,target:"/workspace",working_directory:"/workspace"},
        access:{read:s.readPaths.split("\n").map(function(p){return p.trim()}).filter(Boolean),write:s.writePaths.split("\n").map(function(p){return p.trim()}).filter(Boolean)}
      },network:{mode:s.network},linux_namespace:Object.assign({},s.namespace),cgroup_v2:s.cgroup?{"memory.max":s.cgroup}:{},seccomp:s.seccomp?{profile:"nession-interactive-v1"}:null};
  }
  function check(){
    if(!hasSession())return "A current Session is required to access Sandbox.";
    if(!online())return "Agent offline: capabilities and mounts cannot be verified.";
    if(s.fixture==="preflight-fail")return "Agent reported a failed preflight (mock).";
    if(s.rootMode==="image"&&nativeStatus("filesystem.composition").state!=="available")return "filesystem.composition unavailable on this Agent.";
    if(s.rootMode==="host"&&nativeStatus("filesystem.access").state!=="available")return "filesystem.access unavailable on this Agent.";


    if(s.rootMode==="image"&&(s.cache[s.rootImage]!=="verified"||!imageBy(s.rootImage)||imageBy(s.rootImage).kind!=="Base Runtime"))return "RootFS image must be verified in this Agent cache.";
    var targets=s.tools.map(function(id){return s.mountTargets[id]});
    if(targets.some(function(t){return !t||t[0]!=="/"||t.includes("..")||t.length>160}))return "Mount targets must be normalized absolute paths.";
    if(targets.some(function(t){return ["/","/workspace","/home","/proc","/dev","/tmp","/run/nession"].some(function(p){return t===p||t.startsWith(p+"/");})}))return "Mount target overlaps a reserved Sandbox path.";
    if(new Set(targets).size!==targets.length)return "Duplicate mount targets are not allowed.";
    if(targets.some(function(t){return !/^\/opt\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(t)}))return "Custom mount target requires backend support (current V1 supports /opt/<name>).";
    if(s.tools.some(function(t){return !imageBy(t)||imageBy(t).kind==="Base Runtime"||imageBy(t).status!=="ready";}))return "Mount image must be a Server Ready non-base_runtime EROFS.";
    if(s.tools.some(function(t){return s.cache[t]!=="verified";}))return "One or more mount images have not been loaded into the Agent cache.";
    if(s.rootMode==="host"&&s.tools.length)return "Mounting EROFS tools on a local root requires backend support (not in current V1).";
    if(s.rootMode==="image"&&(!imageBy(s.rootImage)||imageBy(s.rootImage).status!=="ready"))return "Base Runtime image is not Server Ready.";
    var paths=[s.readPaths,s.writePaths].join("\n").split("\n").filter(Boolean);
    if(paths.some(function(p){return !p.startsWith("/")||p.indexOf("..")>=0}))return "Access paths must be absolute normalized host paths.";
    if(s.rootMode==="image"&&paths.length)return "Combining access paths with EROFS RootFS requires an implementation update (current V1 is exclusive).";
    if(s.network==="restricted"&&macos())return "This macOS backend does not support restricted network mode.";
    if(s.seccomp&&nativeStatus("seccomp").state!=="available")return "seccomp unavailable on current Agent.";
    if(s.cgroup&&nativeStatus("cgroup_v2").state!=="available")return "cgroup_v2 unavailable on current Agent.";
    if(Object.keys(s.namespace).some(function(k){return s.namespace[k]})&&nativeStatus("linux_namespace").state!=="available")return "linux_namespace unavailable on current Agent.";
    if(s.workspaceLower&&s.rootMode!=="image")return "Workspace EROFS lower requires an EROFS RootFS in current V1.";
    if(s.rootMode==="image"&&s.workspaceLower&&resolveDefault().kind!=="managed")return "EROFS Overlay Lower requires an Agent-managed writable Workspace; Project Location is bound directly.";
    if(s.rootMode==="image"&&s.workspaceLower&&macos())return "Workspace Overlay mounting is not supported by this macOS Agent.";
    if(s.selectedWorkspace==="manual"&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(s.workspaceManualName.trim()))return "Enter a valid managed Workspace name.";
    if(s.rootMode==="image"&&s.selectedWorkspace!=="auto"&&s.selectedWorkspace!=="manual"&&!currentWorkspace())return "Selected Workspace is missing; choose a valid Agent resource.";
    if(s.rootMode==="image"&&s.selectedWorkspace!=="auto"&&s.selectedWorkspace!=="manual"&&currentWorkspace()&&currentWorkspace().status!=="available")return "Selected Workspace is not currently available.";
    return "";
  }
  function ensureAutoWorkspace(){
    if(s.selectedWorkspace!=="auto"&&s.selectedWorkspace!=="manual")return;
    var name=s.selectedWorkspace==="manual"?s.workspaceManualName.trim():s.session;
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name))return;
    var old=s.workspaces.find(function(w){return w.kind==="managed"&&w.name===name;});
    if(old){s.selectedWorkspace=old.id;return;}
    var id="ws:"+String(Date.now())+":"+s.workspaces.length;
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
    // A single list is the owning surface: detail expands inside its row.
    // Never render a second detail card below the entire list.
    var items=s.images.map(function(im,i){
      var expanded=s.selectedImage===im.id;
      var detailId="cand-image-detail-"+i;
      var cache=online()?(s.cache[im.id]||"absent"):"unknown";
      var details=expanded?
        '<div class="cand-image-detail" id="'+detailId+'" role="region" aria-label="'+h(im.name)+' details">'+
          '<div class="cand-image-details-grid">'+
            '<div><span>Digest</span><code>'+h(im.digest)+'</code></div>'+
            '<div><span>Type</span><strong>'+h(im.kind)+'</strong></div>'+
            '<div><span>Agent cache</span>'+statusChip(cache)+'</div>'+
            '<div><span>'+(im.kind==="Base Runtime"?"RootFS target":"Default mount")+'</span><code>'+h(im.kind==="Base Runtime"?"/":im.default_mount||"—")+'</code></div>'+
          '</div>'+
          '<div class="cand-actions">'+
            (im.kind==="Base Runtime"
              ? action("Use as RootFS","image-root:"+im.id,"primary",cache!=="verified"||!isEditable())
              : action("Mount in Filesystem","image-tool:"+im.id,"primary",!isEditable()))+
          '</div>'+
        '</div>':"";
      return '<div class="cand-image-entry'+(expanded?' expanded':'')+'">'+
        '<button type="button" class="cand-image-trigger" data-action="image:'+h(im.id)+'" aria-expanded="'+expanded+'"'+(expanded?' aria-controls="'+detailId+'"':"")+'>'+
          '<span class="cand-image-summary"><strong>'+h(im.name)+'</strong><small>'+h(im.kind)+' · '+short(im.digest)+'</small></span>'+
          statusChip(im.status)+'<span class="cand-image-chevron" aria-hidden="true">'+(expanded?'⌃':'⌄')+'</span>'+
        '</button>'+details+'</div>';
    }).join("");
    return sectionHead("Image Library","")+
      '<div class="cand-image-list">'+(items||'<div class="fs-empty">No images</div>')+'</div>';
  }
  function sizeLabel(bytes){
    if(bytes==null)return "—";
    if(bytes>=1000000000)return (bytes/1000000000).toFixed(2)+" GB";
    if(bytes>=1000000)return (bytes/1000000).toFixed(1)+" MB";
    if(bytes>=1000)return (bytes/1000).toFixed(1)+" KB";
    return bytes+" B";
  }
  function buildStageLabel(stage){return ({fetching:"Fetching source",snapshotting:"Snapshotting",validating:"Validating",packaging:"Packaging EROFS",publishing:"Publishing image"})[stage]||"Queued";}
  function transferFor(im){
    return s.transfers[im.id]||{state:s.cache[im.id]==="verified"?"verified":"absent",
      received:s.cache[im.id]==="verified"?im.size_bytes:0,total:im.size_bytes};
  }
  function imageBuilds(){
    var rows=s.builds.map(function(b){
      var active=b.status==="running"||b.status==="queued",terminal=!active;
      var counts=(b.files!=null?b.files.toLocaleString()+" files":"Files pending")+
        " · "+(b.bytes!=null?sizeLabel(b.bytes):"Bytes pending");
      return '<section class="cand-job" data-build-id="'+h(b.id)+'">'+
        '<div class="cand-job-head"><div><strong>'+h(b.name)+'</strong><small>'+h(b.id)+' · Attempt '+h(b.attempt||1)+'</small></div>'+statusChip(b.status)+'</div>'+
        '<div class="cand-job-stage"><span>'+h(active?buildStageLabel(b.stage):b.status==="succeeded"?"Published":b.status==="failed"?"Failed":b.status==="canceled"?"Canceled":b.status)+'</span>'+
        '<span>'+Math.round((b.elapsed_ms||0)/1000)+'s elapsed</span></div>'+
        (active?'<div class="cand-progress-track indeterminate" aria-label="Running build stage; no reliable percentage"><span></span></div>':"")+
        '<div class="cand-job-measure">'+h(counts)+'</div>'+
        (b.diagnostic?'<div class="cand-job-diagnostic '+(b.status==="failed"?"error":"")+'">'+h(b.diagnostic)+'</div>':"")+
        '<div class="cand-actions">'+(active?action("Cancel","build-cancel:"+b.id,"",!online()):"")+
          (b.status==="failed"||b.status==="canceled"?action("Retry","build-retry:"+b.id,"",!online()):"")+'</div></section>';
    }).join("");
    return sectionHead("Builds","",action("+ New build","build-start","primary",!online()))+
      '<div class="cand-job-list">'+rows+'</div>';
  }
  function distribution(){
    var rows=s.images.map(function(im){
      var cacheStatus=online()?(s.cache[im.id]||"absent"):"unknown";
      var transfer=transferFor(im),ready=cacheStatus==="verified";
      var label=!online()?"Unknown":ready?"Verified":transfer.state==="downloading"?"Downloading":
        transfer.state==="verifying"?"Verifying":transfer.state==="resumable"?"Resumable":
        transfer.state==="failed"?"Failed":"Not cached";
      var received=ready?im.size_bytes:Math.min(transfer.received||0,im.size_bytes);
      var total=im.size_bytes;
      var measurable=!ready&&online()&&(transfer.state==="downloading"||transfer.state==="resumable"||transfer.state==="verifying");
      var pct=measurable&&total>0?Math.round(received/total*100):null;
      var measure=measurable?'<div class="cand-transfer-measure"><span>'+h(sizeLabel(received))+' / '+h(sizeLabel(total))+'</span><strong>'+pct+'%</strong></div>'+
        '<progress class="cand-transfer-progress" aria-label="'+h(im.name)+' transfer bytes" value="'+received+'" max="'+total+'"></progress>':"";
      var verified=ready?'<div class="cand-job-measure">Verified · '+h(sizeLabel(total))+' · SHA-256 matched</div>':"";
      return '<section class="cand-job" data-transfer-image="'+h(im.id)+'">'+
        '<div class="cand-job-head"><div><strong>'+h(im.name)+'</strong><small>'+short(im.digest)+'</small></div>'+statusChip(label.toLowerCase().replaceAll(" ","-"))+'</div>'+
        '<div class="cand-job-stage"><span>'+label+'</span><span>Agent · nession-dev</span></div>'+
        measure+verified+
        (transfer.state==="verifying"?'<div class="cand-job-measure">Checking SHA-256 · not mount-ready</div>':"")+
        (transfer.state==="resumable"?'<div class="cand-job-measure">Partial file preserved · transfer not active</div>':"")+
        (!ready&&online()&&transfer.state!=="downloading"&&transfer.state!=="verifying"?
          '<div class="cand-actions">'+action(transfer.state==="resumable"?"Resume":"Prepare","cache:"+im.id,"",false)+'</div>':"")+
        '</section>';
    }).join("");
    return sectionHead("Distribution","",statusChip(online()?"available":"unknown"))+
      '<div class="cand-distribution-context"><span>Current Agent</span><strong>nession-dev</strong><span>Server source: ready registry</span></div>'+
      '<div class="cand-job-list">'+rows+'</div>';
  }
  function demoBuildStep(){
    var b=s.builds.find(function(item){return item.status==="queued"||item.status==="running"});
    if(!b)return;
    var stages=["fetching","snapshotting","validating","packaging","publishing"];
    var index=stages.indexOf(b.stage);
    if(b.status==="queued"){b.status="running";b.stage="fetching";}
    else if(index===stages.length-1){
      b.status="succeeded";b.elapsed_ms+=8000;b.diagnostic="Verified Digest published";
      var id="built"+b.id.replace("build-","");
      s.images.push(image(id,b.name,"Toolchain","e","/opt/"+b.name.slice(0,24)));
    }else {
      b.stage=stages[index+1]||"fetching";b.elapsed_ms+=8000;
      if(b.stage==="validating"){b.files=2317;b.bytes=58240000;}
      b.diagnostic=b.stage==="packaging"?"mkfs.erofs (no native percent)":buildStageLabel(b.stage);
    }
  }
  function demoTransferStep(){
    var im=s.images.find(function(item){return (s.transfers[item.id]||{}).state==="downloading"||(s.transfers[item.id]||{}).state==="verifying"});
    if(!im)return;
    var t=s.transfers[im.id];
    if(t.state==="verifying"){t.state="verified";s.cache[im.id]="verified";return;}
    t.received=Math.min(t.total,(t.received||0)+Math.ceil(t.total*0.30));
    if(t.received>=t.total)t.state="verifying";
  }
  function imagesPanel(){return layout("images",s.sub.images==="builds"?imageBuilds():s.sub.images==="distribution"?distribution():imageLibrary());}
  function workspaceList(){
    var rows=s.workspaces.map(function(w){
      var selected=s.selectedWorkspace===w.id;
      return '<div class="cand-row"><div class="cand-wsrow"><strong>'+h(w.name)+'</strong><small>'+h(w.kind)+
        (w.kind==="project_location"?" · "+h(w.path):" · Agent-managed persistent")+'</small>'+
        '<small>'+h(w.project||"—")+' · nession-dev'+(selected?" · Selected for /workspace":"")+'</small></div>'+
        statusChip(online()?w.status:"unknown")+
        action(selected?"Selected":"Use","ws-use:"+w.id,selected?"muted":"",!online()||s.inside||w.status!=="available"||(w.kind==="project_location"&&s.session!=="sandbox-review"))+
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
  // Canonical five-part Filesystem information architecture for #3405.
  // Runtime implementation remains separate from this client-side design.
  function fsBlock(key,title,content,subtitle){
    return '<section class="fs-block" data-fs-section="'+h(key)+'"><header class="fs-block-heading">'+
      '<h3>'+h(title)+'</h3>'+(subtitle?'<span class="fs-section-note">'+h(subtitle)+'</span>':"")+
      '</header><div class="fs-block-body">'+content+'</div></section>';
  }
  function fsImageOptions(kind,options,selected,disabled,attribute){
    return '<select aria-label="'+h(kind)+'" '+attribute+(disabled?' disabled':'')+'>'+
      options.map(function(im){return '<option value="'+h(im.id)+'"'+(selected===im.id?' selected':'')+'>'+h(im.name)+'</option>'}).join("")+'</select>';
  }
  function fsPathGroup(key,label){
    var locked=!isEditable(),value=s[key],entries=value===""?[""]:value.split("\n");
    return '<div class="fs-path-group"><div class="fs-subheading">'+h(label)+'</div>'+
      '<div class="fs-path-list">'+entries.map(function(path,i){return '<div class="fs-path-row">'+
        '<input type="text" data-fs-path="'+(key==="readPaths"?"read":"write")+'" data-fs-index="'+i+'" aria-label="'+h(label)+' '+(i+1)+'" value="'+h(path)+'" placeholder="/absolute/agent/path"'+(locked?' disabled':'')+'>'+
        action("×","fs-path-remove:"+(key==="readPaths"?"read":"write")+":"+i,"compact",locked)+'</div>'}).join("")+'</div>'+
      '<div class="fs-actions">'+action("+ Add path","fs-path-add:"+(key==="readPaths"?"read":"write"),"",locked)+'</div></div>';
  }
  function fsPreviewRows(){
    var isImage=s.rootMode==="image",isProject=s.selectedWorkspace.startsWith("project:");
    var selectedBase=s.images.find(function(im){return im.id===s.rootImage&&s.cache[im.id]==="verified"&&online()&&im.kind==="Base Runtime"});
    var ws=resolveDefault();
    var projectLocation=s.session==="sandbox-review"?s.workspaces.find(function(w){return w.id==="project:nession"}):null;
    var rows=[{target:"/",source:isImage?(selectedBase?selectedBase.name:"No cached Base Runtime"):"Local filesystem",mode:isImage?"RO":"Local"}];
    s.tools.forEach(function(id){var im=imageBy(id);if(im)rows.push({target:s.mountTargets[id]||im.default_mount||"",source:im.name,mode:"RO"});});
    rows.push({target:"/workspace",source:isProject&&projectLocation?projectLocation.path:ws?ws.name:"Auto · "+s.session,mode:"RW"});
    s.readPaths.split("\n").map(function(p){return p.trim()}).filter(Boolean).forEach(function(p){rows.push({target:p,source:p,mode:"RO"});});
    s.writePaths.split("\n").map(function(p){return p.trim()}).filter(Boolean).forEach(function(p){rows.push({target:p,source:p,mode:"RW"});});
    return rows;
  }
  function fsPreviewMarkup(){
    return fsPreviewRows().map(function(row){return '<div class="fs-preview-row">'+
      '<code>'+h(row.target)+'</code><span>'+h(row.source)+'</span><span class="fs-mode-pill">'+h(row.mode)+'</span></div>';}).join("");
  }
  function fsPanel(){
    var locked=!isEditable(),isImage=s.rootMode==="image",ws=resolveDefault();
    var cachedBases=s.images.filter(function(im){return im.kind==="Base Runtime"&&im.status==="ready"&&online()&&s.cache[im.id]==="verified"});
    var selectedBase=cachedBases.find(function(im){return im.id===s.rootImage});
    var isProject=s.selectedWorkspace.startsWith("project:");
    var projectLocation=s.session==="sandbox-review"?s.workspaces.find(function(w){return w.id==="project:nession"}):null;
    var rootMode='<div class="fs-choice" role="group" aria-label="RootFS source">'+
      '<button type="button" data-action="fs-mode:host" aria-pressed="'+(!isImage)+'"'+(locked?' disabled':'')+'>Local</button>'+
      '<button type="button" data-action="fs-mode:image" aria-pressed="'+isImage+'"'+(locked?' disabled':'')+'>Base Runtime EROFS</button></div>';
    var root=fsBlock("rootfs","1 · RootFS",
      '<div class="fs-fixed-mount"><span>Mount point</span><code>/</code></div>'+rootMode+
      (isImage?
        '<div class="fs-form-row"><label>Agent-cached Base Runtime</label>'+
        fsImageOptions("Agent-cached Base Runtime",cachedBases,s.rootImage,locked||!cachedBases.length,'data-field="rootImage"')+
        (selectedBase?'<small>'+short(selectedBase.digest)+' · cached</small>':'<div class="fs-empty">No cached Base Runtime available on this Agent</div>')+'</div>'
      :'<div class="fs-mode-result">Local filesystem</div>')+
      (nativeStatus(isImage?"filesystem.composition":"filesystem.access").state!=="available"?
         alert(nativeStatus(isImage?"filesystem.composition":"filesystem.access").reason,"danger"):""),
      statusChip(isImage?(selectedBase&&nativeStatus("filesystem.composition").state==="available"?"available":"unavailable"):"local"));
    var rows=s.tools.map(function(id){
      var im=imageBy(id);if(!im)return "";
      var loaded=online()&&s.cache[id]==="verified";
      return '<div class="fs-mount-row" data-fs-mount="'+h(id)+'">'+
        '<div class="fs-mount-source"><strong>'+h(im.name)+'</strong><small>'+short(im.digest)+' · '+(loaded?"Cached":"Not cached")+'</small></div>'+
        '<div class="fs-mount-target"><input data-mount-target="'+h(id)+'" type="text" value="'+h(s.mountTargets[id]||im.default_mount||"")+'" aria-label="'+h(im.name)+' mount target"'+(locked?' disabled':'')+'></div>'+
        '<span class="fs-mode-pill">RO</span>'+action("×","mount-remove:"+id,"compact",locked)+'</div>';
    }).join("");
    var available=s.images.filter(function(im){return im.kind!=="Base Runtime"&&im.status==="ready"&&!s.tools.includes(im.id)});
    var selectable='<div class="fs-add-mount">'+fsImageOptions("Add EROFS image",available,s.mountToAdd,locked||!available.length,'data-field="mountToAdd"')+
      action("+ Add mount","mount-add","",locked||!available.length)+'</div>';
    var mounts=fsBlock("mounts","2 · Mounts",
      '<div class="fs-mount-head"><span>EROFS image</span><span>Mount point</span><span>Mode</span></div>'+
      '<div class="fs-mount-list">'+(rows||'<div class="fs-empty">No mounts</div>')+'</div>'+selectable,
      "0 or more · source → target");
    var managed=s.workspaces.filter(function(w){return w.kind==="managed"&&w.status==="available"});
    var managedChoice=isProject?"auto":s.selectedWorkspace;
    var managedOptions=[{id:"auto",name:"Auto · "+s.session}].concat(managed).concat([{id:"manual",name:"New named Workspace…"}]);
    var projectUI='<div class="fs-form-row"><label>Project Location</label>'+
      '<input aria-label="Project Location" type="text" readonly value="'+h(projectLocation?projectLocation.path:"Not configured for this Agent")+'">'+
      '<small>Read-only · Project configuration</small></div>';
    var managedUI='<div class="fs-form-row"><label>Managed Workspace</label>'+
      '<select data-field="selectedWorkspace" aria-label="Managed Workspace"'+(locked?' disabled':'')+'>'+
      managedOptions.map(function(w){return '<option value="'+h(w.id)+'"'+(managedChoice===w.id?' selected':'')+'>'+h(w.name)+'</option>'}).join("")+'</select></div>'+
      (managedChoice==="manual"?'<div class="fs-form-row"><label>Workspace name</label><input data-field="workspaceManualName" aria-label="New Workspace name" type="text" value="'+h(s.workspaceManualName)+'" placeholder="e.g. build-experiment"'+(locked?' disabled':'')+'></div>':"")+
      '<div class="fs-actions">'+action("Manage Workspaces","area:workspaces")+'</div>';
    var choices='<div class="fs-choice" role="group" aria-label="Workspace source">'+
      '<button type="button" data-action="fs-ws:project" aria-pressed="'+isProject+'"'+(locked||!projectLocation?' disabled':'')+'>Project Location</button>'+
      '<button type="button" data-action="fs-ws:managed" aria-pressed="'+(!isProject)+'"'+(locked?' disabled':'')+'>Agent Workspace</button></div>';
    var workspace=fsBlock("workspace","3 · Workspace",
      '<div class="fs-fixed-mount"><span>Mount point</span><code>/workspace</code><span class="fs-cwd">Default working directory</span></div>'+
      choices+(isProject?projectUI:managedUI),"Read/write");
    var access=fsBlock("access","4 · Access",
      '<div class="fs-path-columns">'+fsPathGroup("readPaths","Read-only paths")+
      fsPathGroup("writePaths","Read/write paths")+'</div>',"Same-path mapping");
    var preview=fsBlock("preview","5 · Preview",
      '<div class="fs-preview-header"><span>Path in Sandbox</span><span>Source</span><span>Mode</span></div>'+
      '<div class="fs-preview-list">'+fsPreviewMarkup()+'</div>');
    return '<div class="fs-editor">'+sectionHead("Filesystem","",statusChip(s.inside?"applied":"draft"))+
      root+mounts+workspace+access+preview+'</div>';
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
      else if(["rootMode","rootImage","toolTarget","mountToAdd","workspaceManualName","readPaths","writePaths","home","network","cgroup"].includes(fieldName)){
        s[fieldName]=val;dirty();
      }
      return true;
    }
    if(t.hasAttribute("data-fs-path")){
      var key=t.getAttribute("data-fs-path")==="read"?"readPaths":"writePaths";
      var index=Number(t.getAttribute("data-fs-index"));
      var parts=s[key]===""?[""]:s[key].split("\n");
      if(!Number.isInteger(index)||index<0||index>=parts.length)return false;
      parts[index]=t.value;s[key]=parts.join("\n");dirty();return true;
    }
    if(t.hasAttribute("data-mount-target")){
      var mount=t.getAttribute("data-mount-target");
      if(!s.tools.includes(mount))return false;
      s.mountTargets[mount]=t.value;dirty();return true;
    }
    if(t.hasAttribute("data-tool")){var id=t.getAttribute("data-tool");s.tools=t.checked?Array.from(new Set(s.tools.concat(id))):s.tools.filter(function(x){return x!==id;});dirty();return true;}
    if(t.hasAttribute("data-ns")){s.namespace[t.getAttribute("data-ns")]=t.checked;dirty();return true;}
    if(t.hasAttribute("data-seccomp")){s.seccomp=t.checked;dirty();return true;}
    if(t.hasAttribute("data-workspace-lower")){s.workspaceLower=t.checked;dirty();return true;}
    return false;
  }
  function doAction(a){
    if(a==="fs-inspect"){s.fsInspect=!s.fsInspect;return;}
    if(a.indexOf("fs-mode:")===0){if(isEditable()){s.rootMode=a.slice(8);dirty();}return;}
    if(a==="fs-ws:project"){if(isEditable()&&s.session==="sandbox-review"){s.selectedWorkspace="project:nession";dirty();}return;}
    if(a==="fs-ws:managed"){if(isEditable()){s.selectedWorkspace="auto";dirty();}return;}
    if(a.indexOf("fs-path-add:")===0){
      if(!isEditable())return;
      var k=a.slice(12)==="read"?"readPaths":"writePaths";
      s[k]=s[k]===""?"\n":s[k]+"\n";dirty();return;
    }
    if(a.indexOf("fs-path-remove:")===0){
      if(!isEditable())return;
      var parts=a.split(":"),k=parts[1]==="read"?"readPaths":"writePaths",index=Number(parts[2]);
      var vals=s[k]===""?[""]:s[k].split("\n");vals.splice(index,1);s[k]=vals.join("\n");dirty();return;
    }
    if(a==="mount-add"){
      if(!isEditable())return;
      var available=s.images.filter(function(x){return x.kind!=="Base Runtime"&&x.status==="ready"&&!s.tools.includes(x.id)});
      var target=available.find(function(x){return x.id===s.mountToAdd})||available[0];
      if(target){s.tools.push(target.id);s.mountTargets[target.id]=s.mountTargets[target.id]||target.default_mount||"/opt/"+target.id;s.mountToAdd=(available.find(function(x){return x.id!==target.id})||{}).id||"";dirty();}
      return;
    }
    if(a.indexOf("mount-remove:")===0){if(isEditable()){s.tools=s.tools.filter(function(x){return x!==a.slice(13)});dirty();}return;}
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
    if(a.indexOf("image:")===0){var id=a.slice(6);s.selectedImage=s.selectedImage===id?null:id;return;}
    if(a.indexOf("image-root:")===0){var id=a.slice(11);if(imageBy(id)&&imageBy(id).kind==="Base Runtime"&&s.cache[id]==="verified"&&isEditable()){s.rootImage=id;s.rootMode="image";s.area="policies";s.sub.policies="filesystem";dirty();}return;}
    if(a.indexOf("image-tool:")===0){var id=a.slice(11),im=imageBy(id);if(im&&im.kind!=="Base Runtime"&&isEditable()){s.tools=Array.from(new Set(s.tools.concat(id)));s.mountTargets[id]=s.mountTargets[id]||im.default_mount||"/opt/"+id;s.area="policies";s.sub.policies="filesystem";dirty();}return;}
    if(a==="build-start"){
      if(!online())return;
      var id="build-"+(121+s.builds.length);
      s.builds.unshift({id:id,name:"new-source-"+(s.builds.length+1),status:"queued",stage:null,elapsed_ms:0,files:null,bytes:null,attempt:1,diagnostic:"Awaiting worker"});
      s.sub.images="builds";return;
    }
    if(a.indexOf("build-cancel:")===0){var b=s.builds.find(function(x){return x.id===a.slice(13)});if(b&&(b.status==="running"||b.status==="queued")){b.status="canceled";b.diagnostic="Canceled by user";}return;}
    if(a.indexOf("build-retry:")===0){var b=s.builds.find(function(x){return x.id===a.slice(12)});if(b&&(b.status==="failed"||b.status==="canceled")){b.status="queued";b.stage=null;b.attempt++;b.elapsed_ms=0;b.diagnostic="Awaiting worker";}return;}
    if(a.indexOf("cache:")===0){
      if(!online())return;
      var id=a.slice(6),im=imageBy(id);if(!im||s.cache[id]==="verified")return;
      var previous=transferFor(im);
      s.transfers[id]={state:"downloading",received:previous.received||0,total:im.size_bytes};
      s.cache[id]="preparing";return;
    }
    if(a.indexOf("ws-use:")===0){var selected=s.workspaces.find(function(w){return w.id===a.slice(7)});if(isEditable()&&selected&&selected.status==="available"&&(selected.kind!=="project_location"||s.session==="sandbox-review")){s.selectedWorkspace=selected.id;dirty();}return;}
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
    var selectedAction=b.getAttribute("data-action");
    doAction(selectedAction);
    render();
    // Re-render must not drop the keyboard-help focus target.
    if(selectedAction.indexOf("hint:")===0){
      var tip=view.querySelector('[data-action="'+selectedAction+'"]');
      if(tip&&typeof tip.focus==="function")tip.focus({preventScroll:true});
    }
  });
  view.addEventListener("input",function(e){if(!handleField(e.target))return;
    var preview=view.querySelector(".fs-preview-list");
    if(preview)preview.innerHTML=fsPreviewMarkup();
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
  root.querySelectorAll("[data-demo-progress]").forEach(function(button){
    button.addEventListener("click",function(){
      var command=button.getAttribute("data-demo-progress");
      if(command==="build-next")demoBuildStep();
      if(command==="transfer-next")demoTransferStep();
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