/* Interactive WorkContract design fixture (#2541). No fetch, storage or privileged side effects. */
(function () {
  "use strict";

  var product = document.getElementById("contract-product");
  var page = document.querySelector("[data-np-root]");
  if (!product || !page) return;

  var state = {
    fixture:"normal", tab:"overview", revision:1, published:1,
    mobile:false, list:false, expanded:null, compare:false, confirm:false,
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
  function top() {
    return '<div class="wc-top"><div class="wc-top-left">'+
      '<button type="button" class="wc-back" data-action="back" aria-label="Back to work context">← Work</button>'+
      '<span class="wc-divider"></span><span class="wc-wordmark">Nession</span><span class="wc-crumb">/ Current work / Contract</span></div>'+
      '<span class="wc-workspace">Workspace</span></div>';
  }
  function workList() {
    return '<div class="wc-body"><div class="wc-kicker">CURRENT WORK</div><h1>Continue your work</h1>'+
      '<p class="wc-subhead">Open an existing work contract to see its fixed definition, criteria, discussion and evidence.</p>'+
      '<section style="padding:22px 0;border-bottom:1px solid var(--nession-border);margin-top:30px">'+
      '<h2>Terminal reconnect content mismatch</h2><p class="wc-subhead">Existing WorkContract · wc_demo_terminal · Published v'+state.published+'</p>'+
      '<div style="margin-top:15px">'+action("Open contract","open","dark")+'</div></section></div>';
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
        (state.confirm?'<div class="wc-confirm"><h3>Adopt new Contract revision?</h3><p class="wc-section-note">v1 remains immutable. Existing executions and verification stay pinned to v1. This simulated action creates published v2 only in memory.</p>'+
          '<div class="wc-actions">'+action("Cancel","cancel")+
          action("Confirm adoption","adopt","dark")+'</div></div>':
          '<div class="wc-actions" style="justify-content:flex-start">'+action("Compare revisions","compare")+
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
  function render(preserve) {
    var oldScroll = preserve === false ? 0 : product.scrollTop;
    var mobile=state.mobile;
    product.classList.toggle("is-mobile",mobile);
    product.innerHTML = top()+(state.list?workList():
      '<div class="wc-body">'+intro()+banner()+nav()+
      '<div class="wc-layout"><div class="wc-main" role="tabpanel" aria-label="'+safe(state.tab)+'">'+content()+'</div>'+
      sidePanel()+'</div><p class="wc-footnote">External source is not an instruction or a grant of permission. Contract definition v'+state.revision+' is read-only.</p></div>')+
      (state.message?'<div class="wc-pop" role="status" aria-live="polite"><span>'+safe(state.message)+'</span></div>':"");
    product.scrollTop=oldScroll;
  }
  function apply(actionName,value) {
    state.message="";
    if(actionName==="tab") {state.tab=value;state.expanded=null;state.confirm=false;return render(false);}
    if(actionName==="back") {state.list=true;return render(false);}
    if(actionName==="open") {state.list=false;state.tab="overview";return render(false);}
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
      state.confirm=false;state.compare=false;state.expanded=null;state.list=false;state.message="";
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
