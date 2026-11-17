/* Nession Images management · interactive prototype for #3799/#3795/#3798/#3796.
 * Image Catalog/Builds are Server resources; Distribution belongs to the selected Agent.
 * All data and mutations are synthetic. No APIs, shell, filesystem, credentials or network.
 * Intentionally consumes the owning Session-scoped Sandbox shell (#3408).
 */
(function () {
  "use strict";
  const ESC = /[&<>"']/g;
  const h = value => String(value == null ? "" : value).replace(ESC,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const digest = value => value ? "sha256:"+String(value).slice(7,19)+"…"+String(value).slice(-7) : "Not published";
  const bytes = n => n == null ? "Unknown" : n >= 1e9 ? (n/1e9).toFixed(2)+" GB" : n >= 1e6 ? (n/1e6).toFixed(1)+" MB" : n >= 1e3 ? (n/1e3).toFixed(1)+" KB" : n+" B";
  const act = (label,action,style="",disabled=false) => '<button type="button" class="im-action '+style+'" data-action="'+h(action)+'"'+(disabled?' disabled aria-disabled="true"':'')+'>'+h(label)+'</button>';
  const field = (label,control,help="") => '<label class="im-field"><span class="im-field-label">'+h(label)+'</span>'+control+(help?'<small>'+h(help)+'</small>':"")+'</label>';
  const input = (name,value,placeholder="",type="text") => '<input type="'+type+'" data-im-field="'+h(name)+'" aria-label="'+h(name)+'" placeholder="'+h(placeholder)+'" value="'+h(value)+'">';
  const select = (name,value,options) => '<select data-im-field="'+h(name)+'" aria-label="'+h(name)+'">'+options.map(o=>'<option value="'+h(o[0])+'"'+(value===o[0]?' selected':'')+'>'+h(o[1])+'</option>').join("")+'</select>';
  const flag = (value,kind="quiet") => '<span class="im-state '+kind+'">'+h(value)+'</span>';
  const note = (message,type="info") => message?'<p class="im-notice '+type+'" role="'+(type==="error"?"alert":"status")+'">'+h(message)+'</p>':"";
  const fact=(label,value,mono=false)=>'<div class="im-fact"><dt>'+h(label)+'</dt><dd'+(mono?' class="im-code"':'')+'>'+h(value)+'</dd></div>';
  const heading=(eyebrow,title,desc,right="")=>'<header class="im-heading"><div class="im-heading-copy"><span class="im-eyebrow">'+h(eyebrow)+'</span><h2>'+h(title)+'</h2><p>'+h(desc)+'</p></div>'+right+'</header>';
  const panel=(title,desc,contents)=>'<section class="im-panel"><header class="im-panel-title"><h3>'+h(title)+'</h3>'+(desc?'<p>'+h(desc)+'</p>':"")+'</header>'+contents+'</section>';
  const section=(title,contents)=>'<section class="im-detail-section"><h4>'+h(title)+'</h4>'+contents+'</section>';
  const rowAction=(label,action,disabled=false)=>'<button type="button" class="im-link" data-action="'+h(action)+'"'+(disabled?' disabled':'')+'>'+h(label)+'</button>';
  const agentName="nession-dev";
  const stateOf = s => {
    if(!s.im) s.im={query:"",role:"all",status:"all",libraryPage:0,librarySize:6,selected:null,
      tag:null,tagName:"",tagExpected:null,tagPhase:"edit",tagMessage:"",
      buildMode:"closed",buildKind:"github",buildAlias:"",buildRepo:"https://github.com/BestNathan/nession",
      buildRef:"main",buildDirectory:"/authorized/workspace",buildRepresentation:"flattened",
      compose:[{id:"rust",destination:"/opt/rust"},{id:"source",destination:"/workspace/source"}],
      buildError:"",buildStatus:"all",buildPage:0,buildPageSize:4,expandedBuild:null,
      cacheQuery:"",cacheFilter:"all",cacheSelected:null,notice:""};
    // Fixtures for a rich but explicitly synthetic catalog. Manifest/platform is NOT inferred from a legacy DTO.
    const overrides={
      base:{repository:"nession/base",platform:"linux/amd64",format:"single-layer EROFS",revision:"v1",refs:["Project: platform-lab"],created:"2026-11-12",source:"Build · Linux runtime",layers:1},
      base2:{repository:"nession/base",platform:"linux/amd64",format:"single-layer EROFS",revision:"alpine",refs:[],created:"2026-11-10",source:"Build · alpine",layers:1},
      rust:{repository:"nession/tools",platform:"linux/amd64",format:"single-layer EROFS",revision:"1.99",refs:["Project: nession","Session: sandbox-review"],created:"2026-11-15",source:"Directory snapshot · rust",layers:1},
      node:{repository:"nession/tools",platform:"linux/amd64",format:"single-layer EROFS",revision:"24",refs:["Project: nession"],created:"2026-11-15",source:"Directory snapshot · node",layers:1},
      source:{repository:"nession/projects",platform:"linux/amd64",format:"single-layer EROFS",revision:"main",refs:["Project: nession"],created:"2026-11-16",source:"GitHub · BestNathan/nession",layers:1},
      composite:{repository:"nession/composites",platform:"linux/amd64",format:"referenced multi-blob",revision:"r1",refs:[],created:"2026-11-17",source:"Compose · rust + node",layers:3},
      darwin:{repository:"nession/tools",platform:"darwin/arm64",format:"single-layer EROFS",revision:"mac",refs:[],created:"2026-11-17",source:"OCI · mac arm64",layers:1}
    };
    s.images.forEach(im=>{
      const extra=overrides[im.id]||{};
      if(!im.imMeta)im.imMeta={...extra};
      if(!im.tags)im.tags=im.revision?[im.revision]:[im.id];
      im.repository=extra.repository||im.repository||"nession/generated";
    });
    return s.im;
  };
  const serverUp = s => s.fixture!=="server-offline";
  const agentUp = s => s.fixture!=="offline"&&s.fixture!=="server-offline"&&s.fixture!=="no-session";
  const imageMeta=im=>im.imMeta||{};
  const statusOf=im=>im.status==="ready"?"Ready":im.status==="failed"?"Failed":"Building";
  const cacheOf=(s,im)=>!agentUp(s)?"Unknown":s.cache[im.id]||"Absent";
  const runtimeReason=(s,im)=>{
    if(!agentUp(s))return "Current Agent unavailable";
    const m=imageMeta(im);
    if(m.platform!=="linux/amd64")return "Platform is not compatible with linux/amd64";
    if(m.format==="referenced multi-blob")return "Sandbox referenced Composite mount closure not supported (#3784)";
    if(im.status!=="ready")return "Server image is not Ready";
    if(s.cache[im.id]!=="verified")return "Agent has not verified all required bytes";
    return "";
  };
  const viewFor=s=>stateOf(s);
  const catalog = s=>{
    const ui=viewFor(s);let all=s.images.slice();
    if(ui.role!=="all")all=all.filter(im=>im.kind===ui.role);
    if(ui.status!=="all")all=all.filter(im=>im.status===ui.status);
    if(ui.query.trim()){const q=ui.query.toLowerCase().trim();all=all.filter(im=>[im.name,im.repository,im.digest,im.kind,imageMeta(im).source,(im.tags||[]).join(" ")].some(z=>String(z||"").toLowerCase().includes(q)));}
    all.sort((a,b)=>a.name.localeCompare(b.name));
    return all;
  };
  const tagConflict=(s,owner,ui)=>s.fixture==="tag-conflict"||!!s.tagConflict||(owner?.digest||null)!==ui.tagExpected;
  function catalogDetail(s,im){
    const ui=viewFor(s),m=imageMeta(im),reason=runtimeReason(s,im),cache=cacheOf(s,im);
    const refs=m.refs||[];
    const tagHead=(im.tags||[]).length?im.tags.join(" · "):"Untagged";
    const details=
      '<div class="im-resource-identity"><div><span class="im-eyebrow">Immutable image revision</span><strong>'+h(im.name)+'</strong><code>'+h(im.digest)+'</code></div>'+
      '<div class="im-resource-actions">'+rowAction("Copy digest","im:copy:"+im.id)+rowAction("Manage tags","im:tag:"+im.id,!serverUp(s))+'</div></div>'+
      '<div class="im-detail-grid">'+
      section("Identity",'<dl class="im-facts">'+fact("Repository",im.repository)+fact("Tags",tagHead)+fact("Platform",m.platform||"Unknown")+fact("Representation",m.format||"Unknown")+fact("Created",m.created||"Unknown")+'</dl>')+
      section("Source & dependencies",'<dl class="im-facts">'+fact("Source",m.source||"Unknown")+fact("Layers",m.layers==null?"Unknown":String(m.layers))+fact("Size",bytes(im.size_bytes))+fact("Closure",m.format==="referenced multi-blob"?"Metadata + "+(m.layers-1)+" external blob(s)":"Self-contained image")+'</dl>')+
      section("References",'<p class="im-muted">A Tag is movable. Project and Session image references stay pinned to an immutable manifest.</p>'+
        (refs.length?'<ul class="im-reference-list">'+refs.map(x=>'<li>'+h(x)+'</li>').join("")+'</ul>':'<p class="im-empty-inline">No known active consumers</p>'))+
      section("Availability",'<dl class="im-facts">'+fact("Server",statusOf(im))+fact("Agent · "+agentName,cache)+fact("Runtime",reason||"Compatible with current Agent")+'</dl>')+
      '</div>';
    const consume=im.kind==="Base Runtime"?"Use as RootFS":"Mount in Filesystem";
    return '<div class="im-record-detail" id="im-detail-'+h(im.id)+'">'+details+
      (im.status==="failed"?note("The build failed. Retry it from Builds.","error"):"")+
      '<div class="im-detail-actions">'+act(consume,"im:consume:"+im.id,"primary",!!reason)+
      act("View Agent distribution","im:distribution:"+im.id,"",false)+
      act("Change tag","im:tag:"+im.id,"",!serverUp(s))+'</div>'+
      (ui.tag===im.id?tagEditor(s,im):"")+'</div>';
  }
  function tagEditor(s,im){
    const ui=viewFor(s),owner=s.images.find(x=>x.repository===im.repository&&(x.tags||[]).includes(ui.tagName));
    let body="";
    if(ui.tagPhase==="edit"){
      body=field("Tag name",input("tagName",ui.tagName,"stable"),
      "Repository-scoped mutable pointer. This operation never rewrites a Manifest.")+
      '<div class="im-operation-footer">'+act("Cancel","im:tag-cancel")+act("Review change","im:tag-review:"+im.id,"primary")+'</div>';
    } else {
      const unlink=ui.tagPhase==="unlink",impact=(im.imMeta?.refs||[]);
      body='<div class="im-operation-summary"><div><span>Repository</span><strong>'+h(im.repository)+'</strong></div>'+
        '<div><span>Tag</span><strong>'+h(ui.tagName)+'</strong></div>'+
        '<div><span>Expected revision</span><code>'+h(ui.tagExpected?digest(ui.tagExpected):"Unassigned")+'</code></div>'+
        (unlink?'<div><span>Mutation</span><strong>Unlink Tag only</strong></div>':'<div><span>New revision</span><code>'+h(digest(im.digest))+'</code></div>')+'</div>'+
        '<p class="im-muted im-impact">Impact · '+impact.length+' known pinned consumer(s). '+(impact.length?impact.map(h).join(" · "):"No active reference known")+
        '. Pinned Manifests, leased mounts and CAS bytes remain unchanged.</p>'+
        '<div class="im-operation-footer">'+act("Back","im:tag-back:"+im.id)+act(unlink?"Confirm unlink":"Confirm Tag move","im:"+(unlink?"tag-unlink:":"tag-save:")+im.id,unlink?"danger":"primary")+'</div>';
    }
    return '<section class="im-operation" aria-label="Manage repository tag"><div class="im-operation-head"><h4>'+h(ui.tagPhase==="edit"?"Edit repository Tag":ui.tagPhase==="unlink"?"Confirm Tag unlink":"Review Tag mutation")+'</h4>'+flag("Catalog · CAS")+'</div>'+
      note(ui.tagMessage,ui.tagMessage.startsWith("Conflict")||ui.tagMessage.startsWith("Invalid")?"error":"info")+body+'</section>';
  }
  function libraryRows(s){
    const ui=viewFor(s),all=catalog(s),pages=Math.max(1,Math.ceil(all.length/ui.librarySize));
    ui.libraryPage=Math.min(ui.libraryPage,pages-1);
    const current=all.slice(ui.libraryPage*ui.librarySize,(ui.libraryPage+1)*ui.librarySize);
    return '<div class="im-collection" data-im-collection="library">'+
      '<div class="im-list-head im-library-columns"><span>Image / Repository</span><span>Representation</span><span>Size</span><span>Server</span><span></span></div>'+
      (current.length?current.map(im=>{
        const meta=imageMeta(im),expanded=ui.selected===im.id;
        const brief=im.name+' · '+im.repository;
        return '<article class="im-record'+(expanded?' expanded':'')+'">'+
          '<button type="button" class="im-record-trigger im-library-columns" data-action="im:open:'+h(im.id)+'" aria-expanded="'+expanded+'" aria-controls="im-detail-'+h(im.id)+'" aria-label="'+h(brief)+'">'+
          '<span class="im-record-title"><strong>'+h(im.name)+'</strong><small>'+h(im.repository)+' · '+h((im.tags||[])[0]||"untagged")+'</small></span>'+
          '<span class="im-cell-muted">'+h(meta.format||"Unknown")+'</span><span class="im-cell-muted im-code">'+h(bytes(im.size_bytes))+'</span>'+
          '<span>'+flag(statusOf(im),im.status==="failed"?"error":im.status==="building"?"attention":"quiet")+'</span>'+
          '<span class="im-chevron" aria-hidden="true">'+(expanded?"⌃":"⌄")+'</span></button>'+
          (expanded?catalogDetail(s,im):"")+'</article>';
      }).join(""):'<div class="im-zero"><strong>No matching images</strong><p>Try another search or status filter.</p>'+rowAction("Reset filters","im:filters-reset")+'</div>')+
      '<footer class="im-list-footer"><span>'+all.length+' matching · '+(all.length?(ui.libraryPage*ui.librarySize+1)+"–"+(ui.libraryPage*ui.librarySize+current.length):"0")+' shown</span>'+
      '<div>'+act("Previous","im:library-page:-1","",ui.libraryPage===0)+
      '<span>Page '+(ui.libraryPage+1)+' / '+pages+'</span>'+act("Next","im:library-page:1","",ui.libraryPage>=pages-1)+'</div></footer></div>';
  }
  function library(s){
    const ui=viewFor(s);
    const count=s.images.filter(im=>im.status==="ready").length;
    return '<div class="im im-library">'+heading("Server · Registry","Image Library","One catalog of immutable images. Tags are mutable pointers; consumers pin revisions.",
      act("New image","im:go-builds","primary",!serverUp(s)))+
      '<div class="im-context-line"><strong>'+s.images.length+' images</strong><span>'+count+' Server Ready</span><span>Current Agent: '+h(agentName)+'</span></div>'+
      (!serverUp(s)?note("Server unavailable. This view is a stale local mock snapshot. Tag and Build mutations are disabled.","error"):"")+
      note(ui.notice,"info")+
      '<div class="im-toolbar im-library-toolbar">'+
      '<div class="im-search"><span aria-hidden="true">⌕</span>'+input("query",ui.query,"Search name, tag, repository or digest","search")+'</div>'+
      select("role",ui.role,[["all","All roles"],["Base Runtime","Base runtime"],["Toolchain","Toolchains"],["Project Source","Project source"]])+
      select("status",ui.status,[["all","All states"],["ready","Ready"],["building","Building"],["failed","Failed"]])+'</div>'+
      libraryRows(s)+'</div>';
  }
  function supportedKinds(s){
    const ui=viewFor(s);
    const opts=[["github","GitHub"],["local_directory","Directory"],["compose","Compose"],["archive","Archive · pending"],["oci","OCI · pending"]];
    return '<div class="im-source-types" role="group" aria-label="Image build source">'+opts.map(([id,label])=>
      '<button type="button" class="im-source-option" data-action="im:kind:'+id+'" aria-pressed="'+(ui.buildKind===id)+'"'+((id==="archive"||id==="oci")?' disabled title="Requires Server build protocol adapter (#3795)"':'')+'>'+h(label)+'</button>').join("")+'</div>';
  }
  function composeForm(s){
    const ui=viewFor(s),sources=s.images.filter(im=>im.status==="ready"),options=sources.map(im=>[im.id,im.name+" · "+digest(im.digest)]);
    return '<div class="im-compose">'+
      '<div class="im-form-section-title"><h4>Input images</h4><span>Ordered, immutable source revisions · 1–16</span></div>'+
      ui.compose.map((line,i)=>'<div class="im-compose-row" data-compose-index="'+i+'">'+
        '<span class="im-order">'+(i+1)+'</span>'+
        field("Catalog image",select("composeSource:"+i,line.id,options))+
        field("Destination prefix",input("composeDest:"+i,line.destination,"/opt/tool"))+
        '<div class="im-compose-actions">'+act("↑","im:source-up:"+i,"",i===0)+act("↓","im:source-down:"+i,"",i===ui.compose.length-1)+act("Remove","im:source-remove:"+i,"",ui.compose.length===1)+'</div></div>').join("")+
      act("+ Add source","im:source-add","",ui.compose.length>=16)+
      '<div class="im-form-section-title"><h4>Output representation</h4><span>Composition produces a new immutable Image, not a Workspace</span></div>'+
      '<div class="im-choice">'+act("Flattened","im:representation:flattened",ui.buildRepresentation==="flattened"?"selected":"")+
      act("Referenced multi-blob","im:representation:referenced",ui.buildRepresentation==="referenced"?"selected":"")+'</div>'+
      '<p class="im-muted">'+(ui.buildRepresentation==="referenced"?"Referenced requires compatible root source layouts and a complete device closure. Sandbox cannot yet consume it.":"Flattened produces a self-contained layer. Source image digests remain recorded as provenance.")+'</p></div>';
  }
  function buildForm(s){
    const ui=viewFor(s);
    const source = ui.buildKind==="github"?
      '<div class="im-form-grid">'+field("GitHub repository",input("buildRepo",ui.buildRepo,"https://github.com/owner/repo"))+
      field("Branch / commit",input("buildRef",ui.buildRef,"main"))+'</div>'+
      '<p class="im-muted">Only permitted public sources. No hooks, scripts or dependency installation are executed.</p>':
      ui.buildKind==="local_directory"?field("Authorized Server directory",input("buildDirectory",ui.buildDirectory,"/authorized/source"),"Agent-local paths and browser paths are not accepted without explicit Server authorization."):
      composeForm(s);
    return '<section class="im-operation im-build-form" aria-label="New Image build">'+
      '<div class="im-operation-head"><div><h3>New Image</h3><p>Select an existing authorized source, then submit a Server-owned durable build.</p></div>'+act("Close","im:build-close")+'</div>'+
      supportedKinds(s)+
      '<div class="im-form-body">'+source+
      field("Repository Tag / alias (optional)",input("buildAlias",ui.buildAlias,"stable"),
      "A successful Build publishes an immutable manifest and may move a mutable Tag.")+'</div>'+
      note(ui.buildError,"error")+
      '<div class="im-operation-footer"><span class="im-muted">No Agent download or Sandbox launch is triggered by Build.</span>'+act("Cancel","im:build-close")+act("Submit build","im:build-submit","primary",!serverUp(s))+'</div></section>';
  }
  function buildRow(s,b){
    const ui=viewFor(s),expanded=ui.expandedBuild===b.id,active=b.status==="running"||b.status==="queued";
    const status=b.status==="succeeded"?"Succeeded":b.status[0].toUpperCase()+b.status.slice(1);
    const progress=b.files!=null?b.files.toLocaleString()+" files · "+bytes(b.bytes):"Counts pending";
    return '<article class="im-record im-job'+(expanded?' expanded':'')+'">'+
      '<button type="button" class="im-record-trigger im-build-columns" data-action="im:build-open:'+h(b.id)+'" aria-expanded="'+expanded+'" aria-controls="im-build-detail-'+h(b.id)+'">'+
      '<span class="im-record-title"><strong>'+h(b.name)+'</strong><small>'+h(b.id)+' · Attempt '+h(b.attempt)+'</small></span>'+
      '<span class="im-cell-muted">'+h(b.stage||"Queued")+'</span>'+
      '<span>'+flag(status,b.status==="failed"?"error":active?"attention":"quiet")+'</span>'+
      '<span class="im-chevron">'+(expanded?"⌃":"⌄")+'</span></button>'+
      (expanded?'<div class="im-record-detail" id="im-build-detail-'+h(b.id)+'"><div class="im-detail-grid">'+
        section("Build execution",'<dl class="im-facts">'+fact("Stage",b.stage||"Queued")+fact("Attempt",String(b.attempt))+fact("Elapsed",Math.round((b.elapsed_ms||0)/1000)+" s")+fact("Measurements",progress)+'</dl>')+
        section("Source and diagnostics",'<dl class="im-facts">'+fact("Declared source",b.source_kind||"Historical source not recorded in mock")+fact("Diagnostic",b.diagnostic||"No events recorded")+'</dl>')+'</div>'+
        (active?'<div class="im-indeterminate" aria-label="Stage progress unknown"><span></span></div><p class="im-muted">Building · real file/byte counters shown above; packaging percentage unknown.</p>':"")+
        (b.status==="failed"?note(b.diagnostic||"Build failed","error"):"")+
        '<div class="im-detail-actions">'+
        (active?act("Cancel build","im:build-cancel:"+b.id,"",!serverUp(s)):"")+
        ((b.status==="failed"||b.status==="canceled")?act("Retry as new attempt","im:build-retry:"+b.id,"primary",!serverUp(s)):"")+
        (b.status==="succeeded"?act("Open published Image","im:build-image:"+b.id,"",false):"")+
        '</div></div>':"")+'</article>';
  }
  function buildRows(s){
    const ui=viewFor(s);
    let all=s.builds.filter(b=>ui.buildStatus==="all"||b.status===ui.buildStatus);
    const pages=Math.max(1,Math.ceil(all.length/ui.buildPageSize));
    ui.buildPage=Math.min(ui.buildPage,pages-1);
    const page=all.slice(ui.buildPage*ui.buildPageSize,(ui.buildPage+1)*ui.buildPageSize);
    return '<div class="im-collection" data-im-collection="builds"><div class="im-list-head im-build-columns"><span>Build / Attempt</span><span>Stage</span><span>State</span><span></span></div>'+
      (page.length?page.map(b=>buildRow(s,b)).join(""):'<div class="im-zero"><strong>No matching builds</strong><p>Change the status filter to show other jobs.</p></div>')+
      '<footer class="im-list-footer"><span>'+all.length+' records · durable Server history</span><div>'+
        act("Previous","im:build-page:-1","",ui.buildPage===0)+'<span>Page '+(ui.buildPage+1)+' / '+pages+'</span>'+
        act("Next","im:build-page:1","",ui.buildPage>=pages-1)+'</div></footer></div>';
  }
  function builds(s){
    const ui=viewFor(s),running=s.builds.filter(b=>b.status==="running"||b.status==="queued").length;
    return '<div class="im im-builds">'+heading("Server · Build directory","Builds","Create immutable images, inspect durable attempts and recover failed jobs.",
      act(ui.buildMode==="open"?"Close editor":"+ New image","im:build-toggle","primary",!serverUp(s)))+
      '<div class="im-context-line"><strong>'+running+' active</strong><span>'+s.builds.length+' recorded builds</span><span>Records survive navigation</span></div>'+
      (!serverUp(s)?note("Server unreachable. Active Build state cannot be refreshed and new jobs are disabled.","error"):"")+
      (ui.buildMode==="open"?buildForm(s):"")+
      '<div class="im-subhead"><div><h3>Build activity</h3><p>Measured counters and stage names. No fabricated packaging percentage.</p></div>'+
      select("buildStatus",ui.buildStatus,[["all","All states"],["queued","Queued"],["running","Running"],["succeeded","Succeeded"],["failed","Failed"],["canceled","Canceled"]])+'</div>'+
      buildRows(s)+'</div>';
  }
  const transfer=(s,im)=>{
    const t=s.transfers[im.id];if(!agentUp(s))return {phase:"Unknown",received:null,total:im.size_bytes};
    if(s.cache[im.id]==="verified")return {phase:"Verified",received:im.size_bytes,total:im.size_bytes};
    if(!t)return {phase:"Not cached",received:0,total:im.size_bytes};
    return {phase:t.state==="resumable"?"Resumable":t.state==="downloading"?"Downloading":t.state==="verifying"?"Verifying":t.state==="failed"?"Failed":"Not cached",received:t.received??0,total:t.total??im.size_bytes};
  };
  function distributionRows(s){
    const ui=viewFor(s),query=ui.cacheQuery.trim().toLowerCase();
    const images=s.images.filter(im=>(!query||[im.name,im.repository,im.digest].some(x=>String(x||"").toLowerCase().includes(query))) &&
      (ui.cacheFilter==="all"||transfer(s,im).phase===ui.cacheFilter));
    return '<div class="im-collection" data-im-collection="distribution"><div class="im-list-head im-distribution-columns"><span>Image / Digest</span><span>Server</span><span>Agent Cache</span><span></span></div>'+
      (images.length?images.map(im=>{
        const t=transfer(s,im),ready=t.phase==="Verified",opened=ui.cacheSelected===im.id,reason=runtimeReason(s,im);
        const canPrepare=serverUp(s)&&agentUp(s)&&im.status==="ready"&&!["Downloading","Verifying","Verified"].includes(t.phase);
        const label=t.phase==="Resumable"?"Resume":t.phase==="Failed"?"Retry":"Prepare";
        return '<article class="im-record'+(opened?' expanded':'')+'">'+
          '<button type="button" class="im-record-trigger im-distribution-columns" data-action="im:cache-open:'+im.id+'" aria-expanded="'+opened+'" aria-controls="im-cache-detail-'+im.id+'">'+
          '<span class="im-record-title"><strong>'+h(im.name)+'</strong><small class="im-code">'+h(digest(im.digest))+'</small></span>'+
          '<span>'+flag(statusOf(im),im.status==="failed"?"error":"quiet")+'</span><span>'+flag(t.phase,t.phase==="Failed"?"error":t.phase==="Downloading"||t.phase==="Verifying"?"attention":"quiet")+'</span>'+
          '<span class="im-chevron">'+(opened?"⌃":"⌄")+'</span></button>'+
          (opened?'<div class="im-record-detail" id="im-cache-detail-'+im.id+'"><div class="im-detail-grid">'+
            section("Current Agent",'<dl class="im-facts">'+fact("Agent",agentName)+fact("Manifest",digest(im.digest))+fact("Verified Cache",t.phase)+fact("Runtime compatibility",reason||"Compatible")+'</dl>')+
            section("Transfer evidence",'<dl class="im-facts">'+fact("Transferred",t.received==null?"Unknown":bytes(t.received))+fact("Image size",bytes(t.total))+fact("Checksum",ready?"SHA-256 matched":t.phase==="Verifying"?"Verifying · not mount-ready":"Not verified")+'</dl>')+'</div>'+
            (["Downloading","Resumable","Verifying"].includes(t.phase)&&t.total>0?
              '<div class="im-transfer"><progress value="'+Math.min(t.received||0,t.total)+'" max="'+t.total+'" aria-label="'+h(im.name)+' bytes transferred"></progress><span>'+h(bytes(t.received))+' / '+h(bytes(t.total))+' · byte transfer only</span></div>':"")+
            (reason&&t.phase==="Verified"?note(reason,"error"):"")+
            '<div class="im-detail-actions">'+act(label,"im:cache-prepare:"+im.id,"primary",!canPrepare)+
              act("Inspect in Library","im:cache-library:"+im.id)+act("Use in Filesystem","im:consume:"+im.id,"",!!reason)+'</div></div>':"")+
          '</article>';
      }).join(""):'<div class="im-zero"><strong>No matching cache observations</strong><p>Try another filter.</p></div>')+'</div>';
  }
  function distribution(s){
    const ui=viewFor(s);
    return '<div class="im im-distribution">'+heading("Agent · "+agentName,"Distribution","What this Agent has received and verified. The Server catalog remains global.")+
      '<div class="im-context-line"><strong>'+agentName+'</strong><span>'+ (agentUp(s)?"Agent reachable":"Agent offline / unknown")+'</span><span>On-demand digest preparation</span></div>'+
      (!agentUp(s)?note("Agent unavailable. Cache snapshots are unknown; no automatic fallback or global distribution claim.","error"):"")+
      '<div class="im-toolbar"><div class="im-search"><span aria-hidden="true">⌕</span>'+input("cacheQuery",ui.cacheQuery,"Search images or digests","search")+'</div>'+
      select("cacheFilter",ui.cacheFilter,[["all","All cache states"],["Verified","Verified"],["Not cached","Not cached"],["Resumable","Resumable"],["Downloading","Downloading"],["Verifying","Verifying"],["Failed","Failed"]])+'</div>'+
      distributionRows(s)+'</div>';
  }
  function render(s,tab){
    stateOf(s);
    return tab==="builds"?builds(s):tab==="distribution"?distribution(s):library(s);
  }
  function editField(s,target){
    if(!target?.getAttribute)return false;
    const key=target.getAttribute("data-im-field");
    if(!key)return false;
    const ui=viewFor(s),value=target.value;
    if(key==="query"){ui.query=value;ui.libraryPage=0;}
    else if(key==="role"){ui.role=value;ui.libraryPage=0;}
    else if(key==="status"){ui.status=value;ui.libraryPage=0;}
    else if(key==="tagName"){ui.tagName=value;ui.tagMessage="";}
    else if(key==="buildAlias")ui.buildAlias=value;
    else if(key==="buildRepo")ui.buildRepo=value;
    else if(key==="buildRef")ui.buildRef=value;
    else if(key==="buildDirectory")ui.buildDirectory=value;
    else if(key==="buildStatus"){ui.buildStatus=value;ui.buildPage=0;}
    else if(key==="cacheQuery")ui.cacheQuery=value;
    else if(key==="cacheFilter")ui.cacheFilter=value;
    else if(key.startsWith("composeSource:")){const n=Number(key.slice(14));if(ui.compose[n])ui.compose[n].id=value;}
    else if(key.startsWith("composeDest:")){const n=Number(key.slice(12));if(ui.compose[n])ui.compose[n].destination=value;}
    else return false;
    return true;
  }
  function liveUpdate(s,view,target){
    const key=target.getAttribute?.("data-im-field");
    if(!key||!["query","cacheQuery"].includes(key))return;
    const el=view.querySelector('[data-im-collection="'+(key==="query"?"library":"distribution")+'"]');
    if(!el)return;
    const holder=document.createElement("div");
    holder.innerHTML=key==="query"?libraryRows(s):distributionRows(s);
    el.replaceWith(holder.firstElementChild);
  }
  function handle(s,a){
    if(!a.startsWith("im:"))return false;
    const ui=viewFor(s),id=a.split(":")[2],part=a.split(":")[1];
    const find=()=>s.images.find(im=>im.id===id),build=()=>s.builds.find(b=>b.id===id);
    if(part==="go-builds"){s.sub.images="builds";ui.buildMode="open";}
    else if(part==="open"){ui.selected=ui.selected===id?null:id;ui.tag=null;ui.notice="";}
    else if(part==="filters-reset"){ui.query="";ui.role="all";ui.status="all";ui.libraryPage=0;}
    else if(part==="library-page"){ui.libraryPage=Math.max(0,ui.libraryPage+Number(id));ui.selected=null;}
    else if(part==="copy"){
      const revision=find()?.digest;
      if(!revision){ui.notice="No published Digest available.";return true;}
      if(typeof navigator!=="undefined"&&navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(revision).then(function(){
          ui.notice="Digest copied to clipboard.";
          const dest=document.querySelector(".im-library .im-notice");
          if(dest)dest.textContent=ui.notice;
        }).catch(function(){
          ui.notice="Clipboard permission denied. Select the Digest text in the detail to copy.";
          const dest=document.querySelector(".im-library .im-notice");
          if(dest)dest.textContent=ui.notice;
        });
      } else ui.notice="Clipboard unavailable. Select the Digest text in the detail to copy.";
    }
    else if(part==="tag"){const im=find();if(im&&serverUp(s)){ui.tag=id;ui.tagName=(im.tags||[])[0]||"stable";ui.tagExpected=(s.images.find(x=>x.repository===im.repository&&(x.tags||[]).includes(ui.tagName))||{}).digest||null;ui.tagPhase="edit";ui.tagMessage="";}}
    else if(part==="tag-cancel"){ui.tag=null;ui.tagMessage="";}
    else if(part==="tag-back"){ui.tagPhase="edit";ui.tagMessage="";}
    else if(part==="tag-review"){const im=find();if(!im||!serverUp(s))return true;if(!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(ui.tagName)){ui.tagMessage="Invalid Tag: use lower-case letters, digits, dot, underscore or hyphen.";return true;}const o=s.images.find(x=>x.repository===im.repository&&(x.tags||[]).includes(ui.tagName));ui.tagExpected=o?.digest||null;ui.tagPhase="review";ui.tagMessage="";}
    else if(part==="tag-save"){const im=find();if(!im||ui.tagPhase!=="review"||!serverUp(s))return true;const o=s.images.find(x=>x.repository===im.repository&&(x.tags||[]).includes(ui.tagName));if(tagConflict(s,o,ui)){ui.tagMessage="Conflict: Tag changed since review. Refresh the expected revision before retry.";return true;}if(o)o.tags=o.tags.filter(t=>t!==ui.tagName);if(!im.tags.includes(ui.tagName))im.tags.push(ui.tagName);ui.tag=null;ui.notice="Tag "+ui.tagName+" updated. Existing pinned consumers are unchanged.";}
    else if(part==="tag-remove"){const im=find();if(!im||!serverUp(s)||!(im.tags||[]).length)return true;ui.tag=id;ui.tagName=im.tags[0];ui.tagExpected=im.digest;ui.tagPhase="unlink";ui.tagMessage="";}
    else if(part==="tag-unlink"){const im=find();if(!im||ui.tagPhase!=="unlink"||!serverUp(s))return true;const o=s.images.find(x=>x.repository===im.repository&&(x.tags||[]).includes(ui.tagName));if(tagConflict(s,o,ui)){ui.tagMessage="Conflict: the Tag changed before unlink. Nothing was removed.";return true;}o.tags=o.tags.filter(t=>t!==ui.tagName);ui.tag=null;ui.notice="Tag unlinked; immutable Manifest, consumer pins and Blob Store remain.";
    } else if(part==="distribution"){s.sub.images="distribution";ui.cacheSelected=id;}
    else if(part==="cache-library"){s.sub.images="library";ui.query="";ui.role="all";ui.status="all";ui.selected=id;ui.libraryPage=Math.max(0,Math.floor(catalog(s).findIndex(im=>im.id===id)/ui.librarySize));}
    else if(part==="cache-open"){ui.cacheSelected=ui.cacheSelected===id?null:id;}
    else if(part==="cache-prepare"){const im=find();if(!im||!serverUp(s)||!agentUp(s)||im.status!=="ready")return true;const t=transfer(s,im);if(["Verified","Downloading","Verifying"].includes(t.phase))return true;s.transfers[im.id]={state:"downloading",received:t.received||0,total:im.size_bytes};s.cache[im.id]="preparing";ui.cacheSelected=id;}
    else if(part==="consume"){const im=find(),reason=im&&runtimeReason(s,im);if(!im||reason)return true;if(im.kind==="Base Runtime"){s.rootImage=id;s.rootMode="image";}else{s.tools=Array.from(new Set(s.tools.concat(id)));s.mountTargets[id]=s.mountTargets[id]||im.default_mount||"/opt/"+id;}s.area="policies";s.sub.policies="filesystem";s.preflight="none";s.error="";}
    else if(part==="build-toggle"){ui.buildMode=ui.buildMode==="open"?"closed":"open";ui.buildError="";}
    else if(part==="build-close"){ui.buildMode="closed";ui.buildError="";}
    else if(part==="kind"){if(["github","local_directory","compose"].includes(id)){ui.buildKind=id;ui.buildError="";}}
    else if(part==="representation"){if(["flattened","referenced"].includes(id))ui.buildRepresentation=id;}
    else if(part==="source-add"){if(ui.compose.length<16){const unused=s.images.find(im=>im.status==="ready"&&!ui.compose.some(x=>x.id===im.id));ui.compose.push({id:(unused||s.images[0]).id,destination:"/opt/new-source"});}ui.buildError="";}
    else if(part==="source-remove"){const n=Number(id);if(ui.compose.length>1&&n>=0&&n<ui.compose.length)ui.compose.splice(n,1);}
    else if(part==="source-up"||part==="source-down"){const n=Number(id),j=n+(part==="source-up"?-1:1);if(j>=0&&j<ui.compose.length){const v=ui.compose[n];ui.compose[n]=ui.compose[j];ui.compose[j]=v;}}
    else if(part==="build-submit"){
      if(!serverUp(s))return true;
      let error="";
      if(!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(ui.buildAlias)&&ui.buildAlias)error="Invalid Repository Tag/alias.";
      if(ui.buildKind==="github"&&(!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(ui.buildRepo)||!ui.buildRef.trim()))error="Provide a valid public GitHub URL and Branch or pinned Commit.";
      if(ui.buildKind==="local_directory"&&!ui.buildDirectory.startsWith("/authorized/"))error="Directory must be within an explicitly authorized Server source root.";
      if(ui.buildKind==="compose"){
        if(ui.compose.length<1)error="Select at least one Image.";
        if(ui.compose.some(line=>!s.images.some(im=>im.id===line.id&&im.status==="ready")))error="All Compose inputs must be Server Ready.";
        if(new Set(ui.compose.map(line=>line.id)).size!==ui.compose.length)error="Each source revision must be selected only once.";
        if(ui.compose.some(line=>!line.destination.startsWith("/")||line.destination.includes("..")))error="Compose destinations must be normalized absolute paths.";
        if(new Set(ui.compose.map(line=>line.destination)).size!==ui.compose.length)error="Compose destinations cannot overlap.";
        if(ui.buildRepresentation==="referenced"&&ui.compose.some(line=>line.destination!=="/"))error="Referenced Composite requires all source roots at /. Check source tree conflicts.";
      }
      if(error){ui.buildError=error;return true;}
      const id="build-"+(200+s.builds.length);
      const names={github:"GitHub snapshot",local_directory:"Authorized directory",compose:"Image Compose"};
      s.builds.unshift({id:id,name:ui.buildAlias||(ui.buildKind==="compose"?"composed-image":ui.buildKind==="github"?"github-source-image":"directory-source-image"),status:"queued",stage:null,elapsed_ms:0,files:null,bytes:null,attempt:1,
        source_kind:names[ui.buildKind]+" · "+(ui.buildKind==="compose"?ui.compose.map(x=>x.id+"→"+x.destination).join(", "):ui.buildKind==="github"?ui.buildRepo+" @ "+ui.buildRef:ui.buildDirectory),
        representation:ui.buildKind==="compose"?ui.buildRepresentation:"single-layer",
        diagnostic:"Queued in Server-owned durable Build directory (synthetic)"});
      ui.expandedBuild=id;ui.buildMode="closed";ui.buildStatus="all";ui.buildPage=0;s.sub.images="builds";
    }
    else if(part==="build-open"){ui.expandedBuild=ui.expandedBuild===id?null:id;}
    else if(part==="build-page"){ui.buildPage=Math.max(0,ui.buildPage+Number(id));ui.expandedBuild=null;}
    else if(part==="build-cancel"){const b=build();if(b&&["running","queued"].includes(b.status)){b.status="canceled";b.diagnostic="Canceled; snapshot retained according to Server retention (synthetic).";}}
    else if(part==="build-retry"){const b=build();if(b&&["failed","canceled"].includes(b.status)){b.status="queued";b.stage=null;b.attempt++;b.elapsed_ms=0;b.diagnostic="New attempt queued; previous diagnostic retained in durable record (synthetic).";}}
    else if(part==="build-image"){const b=build();s.sub.images="library";ui.query="";ui.role="all";ui.status="all";const im=s.images.find(im=>im.name===b?.name);ui.selected=im?.id||null;ui.libraryPage=im?Math.floor(catalog(s).findIndex(x=>x.id===im.id)/ui.librarySize):0;ui.notice=im?"Published Image selected.":"This historical mock does not contain a live Image for the completed build."; }
    return true;
  }
  window.NessionImagesDesign={create:function(getState){return {
    render:tab=>render(getState(),tab),
    handle:a=>handle(getState(),a),
    field:target=>editField(getState(),target),
    live:(view,target)=>liveUpdate(getState(),view,target),
    reset:()=>{const s=getState();delete s.im;stateOf(s);}
  };}};
}());