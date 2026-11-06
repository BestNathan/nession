/* Interactive WorkContract design fixture (#2541). No fetch, storage or privileged side effects. */
(function () {
  "use strict";

  var product = document.getElementById("contract-product");
  var page = document.querySelector("[data-np-root]");
  if (!product || !page) return;

  var state = {
    fixture:"normal", tab:"overview", revision:1, published:1,
    mobile:false, sidebarCollapsed:false, selectedSession:"dev-session", list:true, surface:"workspace", capability:"work", expanded:null, compare:false, confirm:false,
    draft:"", message:"",
    events:[
      {id:"evt-01",actor:"Nession",initial:"N",when:"Contract published · v1",body:"Initial work definition and two acceptance criteria were established.",origin:"Contract revision"},
      {id:"evt-02",actor:"Reviewer",initial:"R",when:"Review note · GitHub comment",body:"Please confirm interactive TUI behavior after reconnect, not only the displayed text.",origin:"External source comment"}
    ]
  };

  var criteria = [
    {id:"SC-01",text:"Reconnect restores consistent visible Terminal content.",checked:true,status:"Pending",proof:"No trusted Acceptance receipt has been verified.",origin:"Source body · lines 24–26"},
    {id:"SC-02",text:"TUI input works correctly after reconnect.",checked:false,status:"Pending",proof:"Waiting for targeted TUI interaction evidence.",origin:"Source body · lines 27–29"}
  ];
  var extraCriterion = {id:"SC-03",text:"The viewport remains consistent after switching between desktop and mobile.",checked:false,status:"Pending",proof:"This criterion is new in v2; no v1 result is inherited.",origin:"Proposed source edit · lines 30–32"};

  function safe(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g,function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function sourceName() {
    return state.fixture === "feishu" ? "Feishu document" : "GitHub Issue";
  }
  function sourceRef() {
    return state.fixture === "feishu" ? "feishu:example-tenant:doc:demo-42" :
      "github:github.com:example/nession:issue:42";
  }
  function isSourceReadable() {
    return state.fixture !== "denied" && state.fixture !== "unavailable";
  }
  function isCandidate() {
    return state.fixture === "changed" && state.published === 1;
  }
  function activeCriteria() {
    return state.revision === 2 ? criteria.concat([extraCriterion]) : criteria;
  }
  function badge(label, cls) {
    return '<span class="wc-label'+(cls ? " "+cls : "")+'">'+safe(label)+'</span>';
  }
  function action(label, actionName, cls, extra) {
    return '<button class="wc-btn'+(cls ? " "+cls : "")+'" type="button" data-action="'+safe(actionName)+'"'+(extra||"")+'>'+safe(label)+'</button>';
  }
  function smallSource() {
    return state.fixture === "feishu" ? "Feishu · demo document" : "GitHub · example/nession#42";
  }
  /* Nession owns the Workspace shell and capability capsule. The Work view
     only renders WorkContract content, never app-wide navigation. */
  function top() {
    if (!state.mobile || state.surface!=="workspace")return "";
    var detail=state.capability==="work"&&!state.list&&state.fixture!=="unbound";
    var title=detail?"Terminal reconnect content mismatch":state.capability==="work"?"Work":state.capability==="files"?"Files":"Git";
    var back=detail?"Back to Work":"Back to Terminal";
    return '<header class="wc-top" data-testid="app-page-header" aria-label="Workspace navigation">'+
      '<button type="button" class="wc-back" data-action="back" aria-label="'+back+'">‹</button>'+
      '<h1 class="wc-app-title">'+safe(title)+'</h1></header>';
  }
  function workList() {
    return '<div class="wc-body">'+
      (state.mobile?'':'<h1>Work</h1>')+'<p class="wc-subhead">Work contracts associated with this Workspace. Select one to inspect its immutable definition, criteria, discussion and evidence.</p>'+
      '<section class="wc-contract-entry"><div><h2>Terminal reconnect content mismatch</h2>'+
      '<p class="wc-subhead">WorkContract · wc_demo_terminal · Published v'+state.published+'</p>'+
      '<p class="wc-section-note">Bound via '+safe(smallSource())+' · Execution pinned to v1</p></div>'+
      action("Open contract","open","dark")+'</section></div>';
  }
  function workspaceCapability() {
    if (state.capability === "work") {
      if (state.fixture === "unbound")
        return '<div class="wc-body"><div class="wc-kicker">WORKSPACE / WORK</div>'+
          '<div class="wc-empty"><h3>Work is not available in this Workspace</h3>'+
          '<p>No eligible WorkContract or authorized source binding is present. The Work entry is hidden from the Workspace Capsule. Previously opened content stays explanatory until you select another capability.</p>'+
          action("Open Files","capability","", ' data-value="files"')+'</div></div>';
      return state.list?workList():
        '<div class="wc-body">'+(state.mobile?'':'<div class="wc-local-back"><button type="button" data-action="back">← Work contracts</button></div>')+
        intro()+banner()+nav()+
        '<div class="wc-layout"><div class="wc-main" role="tabpanel" aria-label="'+safe(state.tab)+'">'+content()+'</div>'+
        sidePanel()+'</div><p class="wc-footnote">Work is one Workspace capability. External source text is not permission; definition v'+state.revision+' is read-only.</p></div>';
    }
    var isFiles=state.capability==="files";
    return '<div class="wc-body"><div class="wc-kicker">WORKSPACE / '+(isFiles?'FILES':'GIT')+' CAPABILITY</div>'+
      '<h1>'+(isFiles?'Files':'Git')+'</h1>'+
      '<p class="wc-subhead">'+(isFiles?'Files in the current Workspace location.':'Repository context for the current Workspace.')+
      ' Opened in this Workspace.</p>'+
      '<div class="wc-definition" style="margin-top:25px"><h3>Current Workspace</h3>'+
      '<p>Session: dev-session · Location: development host · Repository: example/nession</p>'+
      '<p>Return to the Work capability using the Workspace Capsule. Its selected Contract and revision are preserved.</p></div></div>';
  }
  function terminalSurface() {
    return '<div class="wc-terminal"><div class="wc-terminal-head"><strong>dev-session</strong><span>Terminal</span></div>'+
      '<div class="wc-terminal-output"><p>~/workspace/nession $</p><p>Session remains available when Workspace is opened.</p></div>'+
      '<button type="button" class="wc-btn dark" data-action="open-workspace">Open Workspace</button></div>';
  }
  function workspaceDock() {
    if (state.surface !== "workspace") return "";
    var entries=[["files","Files","▤"],["git","Git","⑂"],["work","Work","▣"]].filter(function(entry){
      return entry[0]!=="work"||state.fixture!=="unbound";
    });
    return '<footer class="wc-dock-zone"><div class="wc-dock-pair">'+
      (!state.mobile?'<button class="wc-terminal-link" type="button" data-action="terminal" aria-label="Open Terminal">↩ <span>Terminal</span></button>':'')+
      '<nav class="wc-capability-capsule" aria-label="Workspace capabilities">'+entries.map(function(entry){
        return '<button type="button" class="wc-capability-entry" data-action="capability" data-value="'+entry[0]+'" data-capability-state="'+(entry[0]==="work"?"relevant":"available")+'" aria-current="'+(state.capability===entry[0]?'page':'false')+'">'+
          '<span class="wc-capability-symbol" aria-hidden="true">'+entry[2]+'</span><span>'+entry[1]+'</span></button>';
      }).join("")+'</nav></div></footer>';
  }
  function intro() {
    return '<div class="wc-intro"><div>'+
      '<div class="wc-kicker">WORK CONTRACT · BUG</div>'+
      '<h1>Terminal reconnect content mismatch</h1>'+
      '<p class="wc-subhead">Restore a correct Terminal viewport after reconnect without breaking interactive TUI applications.</p>'+
      '<p class="wc-idline">wc_demo_terminal · Definition v'+state.revision+' · SHA-256: '+(state.revision===1?"a3e71c9…":"b418c5a…")+'</p>'+
      '</div><div class="wc-actions">'+badge("Published v"+state.published,"green")+
      (state.revision !== state.published ? badge("Viewing history") : "")+
      action("Revisions","history","quiet")+'</div></div>'+
      '<div class="wc-context"><span>Kind <strong>Bug</strong></span><span>Source <strong>'+smallSource()+'</strong></span>'+
      '<span>Revision <strong>'+state.revision+' / '+state.published+'</strong></span>'+
      '<span>Execution <strong>Pinned to v1</strong></span></div>';
  }
  function banner() {
    if (state.fixture==="changed" && isCandidate())
      return '<div class="wc-banner"><div class="copy"><h3>Source changed · proposal available</h3><p>Source revision moved from s17 to s18. Published Contract v1 is unchanged until explicitly adopted.</p></div>'+
        action("Review changes","proposal","dark")+'</div>';
    if (state.fixture==="denied")
      return '<div class="wc-banner negative"><div class="copy"><h3>Source access denied</h3><p>This Contract revision remains viewable from the existing snapshot. No source refresh or write is permitted.</p></div>'+action("Source details","source")+'</div>';
    if (state.fixture==="unavailable")
      return '<div class="wc-banner neutral"><div class="copy"><h3>Source temporarily unavailable</h3><p>The published definition remains stable. Source freshness cannot be confirmed.</p></div>'+action("Source details","source")+'</div>';
    if (state.fixture==="feishu")
      return '<div class="wc-banner neutral"><div class="copy"><h3>Bound to a Feishu document</h3><p>Native block fixture maps to the same Contract and Criterion model, without GitHub Markdown semantics.</p></div>'+action("Source details","source")+'</div>';
    return "";
  }
  var tabs=[["overview","Overview"],["criteria","Criteria"],["thread","Thread"],["source","Source"],["history","Revisions"]];
  function nav() {
    return '<div class="wc-tabs" role="tablist" aria-label="WorkContract details">'+tabs.map(function(item){
      return '<button type="button" role="tab" class="wc-tab" data-action="tab" data-value="'+item[0]+'" aria-selected="'+(state.tab===item[0])+'">'+item[1]+'</button>';
    }).join("")+'</div>';
  }
  function overview() {
    return '<section><div class="wc-section-title"><h2>Contract definition · v'+state.revision+'</h2>'+
      badge("Immutable published definition")+'</div>'+
      '<div class="wc-definition"><h3>Goal</h3><p>Restore the correct Terminal viewport after reconnect and preserve interactive TUI behavior.</p></div></section>'+
      '<section><div class="wc-section-title"><h2>Scope &amp; constraints</h2></div>'+
      '<ul class="wc-list"><li>Reconnect and restore the current Terminal content.</li>'+
      '<li>Keep existing tmux/control-mode and Session identity boundaries.</li>'+
      '<li>Do not regress Vim, top or coding-agent TUI input.</li>'+
      (state.revision===2 ? '<li>Check desktop/mobile viewport transitions explicitly.</li>':"")+'</ul></section>'+
      '<section><div class="wc-section-title"><h2>Acceptance criteria</h2>'+action("View all criteria","criteria")+'</div>'+
      '<p class="wc-prose">'+activeCriteria().length+' defined criteria · All trusted verification results Pending. Author checkboxes are not proof.</p></section>'+
      '<section><div class="wc-section-title"><h2>Related work</h2></div>'+
      '<p class="wc-prose">Execution Task dev-01 and one review are associated with this Contract. Their references pin v1 even when viewing a later revision.</p></section>';
  }
  function criteriaPanel() {
    var cs=activeCriteria();
    var rows=cs.map(function(c) {
      return '<div class="wc-criterion"><button type="button" class="wc-criterion-header" data-action="criterion" data-value="'+c.id+'" aria-expanded="'+(state.expanded===c.id)+'">'+
        '<span class="wc-criterion-id">'+c.id+'</span><span class="wc-criterion-name">'+safe(c.text)+'</span>'+
        badge(c.status)+ '<span class="wc-criterion-arrow">'+(state.expanded===c.id?"−":"+")+'</span></button>'+
        (state.expanded===c.id?'<div class="wc-criterion-detail"><p><strong>Author checklist:</strong> '+(c.checked?"Checked [x]":"Unchecked [ ]")+' (not trusted Pass)</p>'+
        '<p><strong>Trusted verification:</strong> Pending — '+safe(c.proof)+'</p>'+
        '<p><strong>Definition source:</strong> '+safe(c.origin)+'</p>'+
        '<p><strong>Contract revision:</strong> v'+state.revision+'</p></div>':"")+'</div>';
    }).join("");
    return '<section><div class="wc-section-title"><h2>Success criteria · definition v'+state.revision+'</h2></div>'+
      '<p class="wc-section-note">The criteria wording is part of the immutable Contract revision. Verification results are associated separately and may only be published by trusted owners.</p>'+
      '<div class="wc-criteria">'+rows+'</div></section>';
  }
  function threadPanel() {
    return '<section><div class="wc-section-title"><h2>Work thread</h2>'+badge(state.events.length+" events")+'</div>'+
      '<p class="wc-section-note">Discussion, questions and decisions are not edits to the published Contract. External comments are untrusted source data.</p>'+
      '<div class="wc-thread">'+state.events.map(function(e){
        return '<div class="wc-event"><span class="wc-avatar">'+safe(e.initial)+'</span><div>'+
          '<h3>'+safe(e.actor)+' <small>· '+safe(e.when)+'</small></h3><p>'+safe(e.body)+'</p>'+
          '<small>'+safe(e.origin)+'</small></div></div>';
      }).join("")+'</div>'+
      '<form class="wc-compose" id="work-reply"><label for="work-reply-body"><strong>Add a reply</strong></label>'+
      '<textarea id="work-reply-body" name="reply" placeholder="Ask a question or add context…">'+safe(state.draft)+'</textarea>'+
      '<div class="wc-compose-actions"><button type="submit" class="wc-btn dark">Post reply</button></div></form></section>';
  }
  function sourceRow(label,value) {
    return '<div class="wc-source-row"><span>'+safe(label)+'</span><strong>'+safe(value)+'</strong></div>';
  }
  function sourcePanel() {
    var status=state.fixture==="denied"?"Access denied":state.fixture==="unavailable"?"Offline": "Authorized (fixture)";
    var sourceRevision=state.fixture==="changed"?"s18":state.fixture==="feishu"?"b07":"s17";
    var p='<section><div class="wc-section-title"><h2>Source binding</h2>'+badge(status,state.fixture==="denied"?"negative":state.fixture==="changed"?"attention":"")+'</div>'+
      '<p class="wc-section-note">Provider identity and the source revision are separate from WorkContract identity and Contract revision.</p>'+
      '<div class="wc-source-data">'+sourceRow("Provider",sourceName())+
      sourceRow("Source key",sourceRef())+
      sourceRow("Source revision",sourceRevision)+
      sourceRow("Definition", "Published contract v"+state.published)+
      sourceRow("Read state",status)+
      sourceRow("Parser profile","nession-bug@1")+'</div></section>';
    if (state.fixture==="denied" || state.fixture==="unavailable") {
      p+='<section class="wc-empty"><h3>'+safe(status)+'</h3><p>Cached published Contract remains readable; source refresh is unavailable. No silent change or privileged action occurs.</p></section>';
    } else if (isCandidate()) {
      p+='<section><div class="wc-section-title"><h2>Proposed revision · v2</h2>'+badge("Not published","attention")+'</div>'+
        '<p class="wc-section-note">The source change adds a new criterion. Reviewing a proposal is not equivalent to changing the published Contract.</p>'+
        '<div class="wc-diff"><div class="wc-diff-head">Definition v1 → candidate v2</div>'+
        '<p>SC-01 · Reconnect restores consistent visible Terminal content.</p>'+
        '<p>SC-02 · TUI input works correctly after reconnect.</p>'+
        '<p class="added">+ SC-03 · Desktop/mobile viewport transitions remain consistent.</p></div>'+
        (state.compare?'<div class="wc-definition"><h3>Version comparison</h3><p>Published v1: 2 criteria, SHA a3e71c9…; proposed v2: 3 criteria, unpublished. Existing executions and evidence remain pinned to v1.</p></div>':'')+
        (state.confirm?'<div class="wc-confirm"><h3>Adopt new Contract revision?</h3><p class="wc-section-note">v1 remains immutable. Existing executions and verification stay pinned to v1. This simulated action creates published v2 only in memory.</p>'+
          '<div class="wc-actions">'+action("Cancel","cancel")+
          action("Confirm adoption","adopt","dark")+'</div></div>':
          '<div class="wc-actions" style="justify-content:flex-start">'+action(state.compare?"Hide comparison":"Compare revisions","compare")+
          action("Review proposal","confirm","dark")+'</div>')+'</section>';
    } else {
      p+='<section><div class="wc-section-title"><h2>Source interpretation</h2></div>'+
        '<p class="wc-prose">No unadopted contract definition change. Source comments or formatting may change without altering the published Contract revision. Parsing is read-only.</p></section>';
    }
    return p;
  }
  function historyPanel() {
    var revs = state.published===2?[2,1]:[1];
    return '<section><div class="wc-section-title"><h2>Published revisions</h2></div>'+
      '<p class="wc-section-note">Published definitions are immutable. External source revisions and comment edits are not automatically revisions of this contract.</p>'+
      revs.map(function(v){
        return '<button type="button" class="wc-revision'+(state.revision===v?" current":"")+'" data-action="revision" data-value="'+v+'">'+
          '<span class="wc-dot"></span><span><strong>Revision v'+v+'</strong>'+
          (v===state.published?' '+badge("Latest"):"")+
          '<small>'+ (v===1?"Initial published definition · 2 criteria · SHA a3e71c9…":"Explicitly adopted source change · 3 criteria · SHA b418c5a…")+'</small>'+
          '<small>Open immutable definition '+(state.revision===v?"(currently viewing)":"")+'</small></span></button>';
      }).join("")+'</section>'+
      (isCandidate()?'<section><div class="wc-banner neutral"><div class="copy"><h3>Candidate v2 is not a published revision</h3>'+
        '<p>Source revision s18 is pending explicit review and does not appear in immutable history.</p></div>'+action("Review candidate","proposal")+'</div></section>':"");
  }
  function sidePanel() {
    return '<aside class="wc-side" aria-label="Related work and identity">'+
      '<h3>Contract context</h3><dl>'+
      '<dt>Identity</dt><dd><code>wc_demo_terminal</code></dd>'+
      '<dt>Source</dt><dd>'+safe(sourceName())+'</dd>'+
      '<dt>Published</dt><dd>Revision v'+state.published+'</dd>'+
      '<dt>Source status</dt><dd>'+safe(state.fixture==="denied"?"Access denied":state.fixture==="unavailable"?"Unavailable":state.fixture==="changed"?"Changed since v1":"Readable")+'</dd>'+
      '</dl><div class="wc-mini-link">'+action("Inspect binding","source")+'</div>'+
      '<div style="margin-top:26px"><h3>Execution references</h3><p class="wc-section-note">Developer task dev-01<br>Reviewer run rev-01<br>Both pin Contract v1</p></div>'+
      '<div style="margin-top:19px"><h3>Verification</h3><p class="wc-section-note">2 criteria · Pending<br>No trusted Pass projected<br>No v2 evidence inherited</p></div></aside>';
  }
  function content() {
    switch(state.tab) {
      case "criteria":return criteriaPanel();
      case "thread":return threadPanel();
      case "source":return sourcePanel();
      case "history":return historyPanel();
      default:return overview();
    }
  }
  function webSidebar() {
    var sessions=["dev-session","design-system","production-shell"];
    if(state.sidebarCollapsed)return '<aside class="wc-web-sidebar collapsed" data-testid="sidebar" data-collapsed="true"><div class="wc-sidebar-top">'+action("☷","sidebar-expand","",' aria-label="Expand sidebar"')+'</div><div class="wc-rail-count">3 Agents</div><div class="wc-rail-count">3 Sessions</div></aside>';
    return '<aside class="wc-web-sidebar" data-testid="sidebar"><div class="wc-sidebar-top"><strong>Agents</strong>'+action("☷","sidebar-collapse","",' aria-label="Collapse sidebar"')+'</div><div class="wc-agent-row">● devbox-01 <small>online</small></div><div class="wc-agent-row">● macbook <small>online</small></div><div class="wc-agent-row">○ sg-prod <small>offline</small></div><div class="wc-session-title">Sessions</div><div class="wc-session-list">'+sessions.map(function(name){return '<button type="button" data-action="select-session" data-value="'+safe(name)+'" class="wc-session-row'+(name===state.selectedSession?' selected':'')+'"><strong>'+safe(name)+'</strong><small>devbox-01 · '+(name==="dev-session"?"claude":"zsh")+'</small></button>';}).join("")+'</div><div class="wc-sidebar-status">● Connected <small>3 nodes</small></div></aside>';
  }
  function render(preserve) {
    var previous=product.querySelector?product.querySelector(".wc-surface"):null;
    var oldScroll=preserve===false?0:(previous?previous.scrollTop:0);
    product.classList.toggle("is-mobile",state.mobile);
    var inner=state.surface==="terminal"?terminalSurface():
      '<section class="wc-shell" data-testid="workspace-shell">'+top()+
      '<div class="wc-surface" data-testid="workspace-tool-content">'+workspaceCapability()+'</div>'+workspaceDock()+'</section>';
    product.innerHTML=(state.mobile?inner:'<div class="wc-web-layout" data-testid="web-layout">'+webSidebar()+'<main class="wc-web-main" data-testid="shell-main">'+inner+'</main></div>')+
      (state.message?'<div class="wc-pop" role="status" aria-live="polite"><span>'+safe(state.message)+'</span></div>':"");
    var surface=product.querySelector?product.querySelector(".wc-surface"):null;
    if(surface)surface.scrollTop=oldScroll;
  }
  function apply(actionName,value) {
    state.message="";
    if(actionName==="sidebar-collapse"){state.sidebarCollapsed=true;return render(true);}
    if(actionName==="sidebar-expand"){state.sidebarCollapsed=false;return render(true);}
    if(actionName==="select-session"){state.selectedSession=value;state.surface="terminal";return render(false);}
    if(actionName==="terminal") {state.surface="terminal";return render(false);}
    if(actionName==="open-workspace") {
      state.surface="workspace";
      if(state.fixture==="unbound" && state.capability==="work")state.capability="files";
      return render(false);
    }
    if(actionName==="capability") {
      if(["work","files","git"].indexOf(value)<0 || (value==="work" && state.fixture==="unbound"))return;
      state.capability=value;state.surface="workspace";return render(false);
    }
    if(actionName==="tab") {state.tab=value;state.expanded=null;state.confirm=false;return render(false);}
    if(actionName==="back") {if(state.capability==="work"&&!state.list&&state.fixture!=="unbound")state.list=true;else state.surface="terminal";return render(false);}
    if(actionName==="open") {if(state.capability!=="work"||state.fixture==="unbound")return;state.list=false;state.tab="overview";return render(false);}
    if(actionName==="history") {state.tab="history";return render(false);}
    if(actionName==="criteria") {state.tab="criteria";return render(false);}
    if(actionName==="source") {state.tab="source";return render(false);}
    if(actionName==="proposal") {state.tab="source";state.compare=true;return render(false);}
    if(actionName==="compare") {state.compare=!state.compare;state.message=state.compare?"Candidate compared with immutable v1":"Comparison closed";return render(true);}
    if(actionName==="criterion") {state.expanded=state.expanded===value?null:value;return render(true);}
    if(actionName==="revision") {
      var v=Number(value);
      if(!Number.isInteger(v)||v<1||v>state.published)return;
      state.revision=v;state.tab="overview";state.message="Viewing published definition v"+v;return render(false);
    }
    if(actionName==="confirm") {
      if(!isCandidate()||!isSourceReadable())return;
      state.confirm=true;return render(true);
    }
    if(actionName==="cancel") {state.confirm=false;return render(true);}
    if(actionName==="adopt") {
      if(!state.confirm||!isCandidate()||!isSourceReadable())return;
      state.published=2;state.revision=2;state.confirm=false;state.tab="history";
      state.events.push({id:"evt-03",actor:"Work owner",initial:"W",when:"Revision adopted · v2",body:"New definition v2 was adopted. Earlier definition v1 and its execution/verification references remain unchanged.",origin:"Simulated local revision decision"});
      state.message="Published revision v2 in local mock only";
      return render(false);
    }
  }
  product.addEventListener("click",function(event){
    var btn=event.target.closest("[data-action]");
    if(!btn || !product.contains(btn))return;
    apply(btn.getAttribute("data-action"),btn.getAttribute("data-value"));
  });
  product.addEventListener("input",function(event){
    if(event.target.id==="work-reply-body")state.draft=event.target.value;
  });
  product.addEventListener("submit",function(event){
    if(event.target.id!=="work-reply")return;
    event.preventDefault();
    var body=state.draft.trim();
    if(!body) {state.message="Write a reply before posting.";render(true);return;}
    if(body.length>1200) {state.message="Reply must be 1200 characters or fewer.";render(true);return;}
    state.events.push({id:"evt-local-"+state.events.length,actor:"You",initial:"Y",when:"Just now",body:body,origin:"Local draft · no external write"});
    state.draft="";
    state.message="Reply added to local Thread; Contract v"+state.published+" unchanged";
    render(true);
  });
  for(var btn of page.querySelectorAll("[data-fixture]")) {
    btn.addEventListener("click",function() {
      state.fixture=this.getAttribute("data-fixture");
      state.tab="overview";state.revision=1;state.published=1;
      state.confirm=false;state.compare=false;state.expanded=null;state.list=true;state.surface="workspace";state.capability="work";state.message="";
      state.events=state.events.filter(function(e){return e.id!=="evt-03";});
      for(var b of page.querySelectorAll("[data-fixture]")) b.setAttribute("aria-pressed",String(b===this));
      render(false);
    });
  }
  page.addEventListener("np:resize",function(event){
    var width=Number(event.detail && event.detail.width);
    if(!Number.isFinite(width))return;
    state.mobile=width<=600;
    render(true);
  });
  state.mobile=Number(page.querySelector("[data-np-device]").style.getPropertyValue("--np-device-width").replace("px",""))<=600;
  render(false);
})();
