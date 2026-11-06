/* #2851: Visual-spec reviewer. Lives OUTSIDE the product device and reads real mock DOM. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const shell = $("n-shell");
  const device = document.querySelector("[data-np-device]");
  const review = $("review-root");
  if (!shell || !device || !$("spec-component-picker")) return;

  const specs = [
    {id:"sidebar",name:"Sidebar column",short:"Sidebar",kind:"SHELL GEOMETRY",selector:"#n-sidebar",hint:"246px",description:"Web 246px expanded → 0px collapsed. Narrow Web is an overlay drawer.",tokens:["--nession-shell-sidebar-width","--nession-sidebar","--nession-motion-shell-duration"],notes:"Layout is owned by WebLayout, never by a privately collapsed Sidebar. Width returns entirely to work. Narrow Web uses min(20rem,90vw) without a rail."},
    {id:"top",name:"Top action zone",short:"Top actions",kind:"CANDIDATE COMPOSITION",selector:".n-top-actions",hint:"52px min",description:"New arrangement: one toggle and New Session, no redundant permanent product header.",tokens:["--nession-shell-icon-button-size","--nession-shell-space-2"],notes:"52px is derived from a 36px control plus 8px top and bottom padding. This is a proposed layout, not a new global header token."},
    {id:"toggle",name:"Sidebar toggle",short:"Toggle",kind:"CONTROL",selector:"#sidebar-toggle",hint:"36×36",description:"One expand/collapse action in the Web sidebar; the work-area reopen control is shown after collapse.",tokens:["--nession-shell-icon-button-size","--nession-icon-md","--nession-radius-control"],notes:"36px hit box, 16px glyph, 10px control radius. Keyboard-focus uses the existing Nession focus ring."},
    {id:"new",name:"New Session",short:"New Session",kind:"CONTROL",selector:"#new-session",hint:"36px H",description:"An explicit action, separated from the navigation list and from infrastructure.",tokens:["--nession-shell-icon-button-size","--nession-typography-body-size","--nession-radius-control"],notes:"36px height; text uses 13px body role, not an invented action type scale. Opening the form has no side effect until submit."},
    {id:"search",name:"Session search field",short:"Search",kind:"INPUT",selector:".n-search-wrap",hint:"36px H",description:"Search Session identities; filter criteria do not redefine the unfiltered Session total.",tokens:["--nession-shell-space-2","--nession-typography-body-size","--nession-radius-control"],notes:"Minimum 36px control height, 10px corner radius. Empty matches remain distinct from an empty fleet."},
    {id:"actions",name:"Session actions trigger",short:"Actions ···",kind:"CONTROL / OVERFLOW",selector:".n-session-item[data-active='true'] .n-more",hint:"32px Web",description:"One anchored dropdown for every Session row. Desktop reveals it on hover/focus/selection; narrow Web keeps a 44px touch target.",tokens:["--nession-radius-control","--nession-typography-body-size","--nession-motion-shell-duration"],notes:"Choosing the menu trigger must not select a different Session. There are no inline gear/trash controls. The four menu actions are Session details, Edit details, Attach settings, Kill session."},
    {id:"menu",name:"Session actions menu",short:"Dropdown",kind:"OVERLAY / MENU",selector:"#session-row-menu:not([hidden])",hint:"4 actions",description:"Anchored action menu, rendered over the Session list without displacing or replacing it.",tokens:["--nession-background","--nession-border","--nession-radius-control","--nession-typography-body-size"],notes:"Session details / Edit details / Attach settings / Kill session. The last item is separated and destructive. Open a row menu to measure it."},
    {id:"session",name:"Session row",short:"Session row",kind:"PATTERN / SESSION ITEM",selector:".n-session-item[data-active='true']",hint:"7px pad",description:"Two-line content-sized row with a subdued selected fill, not a fixed-height chat bubble.",tokens:["--nession-shell-session-row-pad-y","--nession-shell-space-2","--nession-shell-session-row-radius","--nession-sidebar-accent"],notes:"Vertical padding 7px; horizontal padding 8px; radius 7px. Row height is content-derived. Agent location is metadata, not a navigation parent."},
    {id:"title",name:"Session title",short:"Title",kind:"TYPOGRAPHY / PRIMARY",selector:".n-session-item[data-active='true'] .n-session-name",hint:"14px",description:"The work's recognizable title is the highest-level text in a Session row.",tokens:["--nession-typography-primary-size","--nession-typography-primary-weight","--nession-typography-primary-line-height"],notes:"Web primary chrome role: 14px, weight 550, line-height 1.3. Title truncates gracefully in a narrow sidebar."},
    {id:"metadata",name:"Session metadata",short:"Metadata",kind:"TYPOGRAPHY / METADATA",selector:".n-session-item[data-active='true'] .n-session-sub",hint:"11.5px",description:"Foreground workload and execution location remain secondary to the work name.",tokens:["--nession-typography-metadata-size","--nession-typography-metadata-weight","--nession-typography-metadata-line-height"],notes:"Web metadata role: 11.5px, weight 475, line-height 1.3. A future technical workload name may use mono family while Agent/location stays product sans."},
    {id:"footer",name:"Infrastructure entry",short:"Agents entry",kind:"SECONDARY NAVIGATION",selector:"#agent-entry",hint:"On demand",description:"Agent context is available but no longer occupies prime Sidebar real estate.",tokens:["--nession-shell-space-2","--nession-typography-body-size","--nession-muted-foreground"],notes:"Agent disclosure never groups Sessions by node. A disconnected Agent does not change the Server-connected signal."},
    {id:"status",name:"Server status dot",short:"Status dot",kind:"STATUS / CONNECTION",selector:".n-sidebar-footer .n-status-dot",hint:"5×5",description:"A quiet Server transport state separate from individual Agent or Session health.",tokens:["--nession-shell-status-dot-size","--nession-muted-foreground"],notes:"5px dot, neutral when connected. Warnings apply only to the state they describe; no fleet health aggregation."},
    {id:"work",name:"Main work surface",short:"Work canvas",kind:"SHELL GEOMETRY",selector:".n-work",hint:"flex: 1",description:"The active Session receives width reclaimed from navigation; no decorative card around Terminal.",tokens:["--nession-background","--nession-shell-sidebar-width"],notes:"Main has min-width:0; shell owns resize. This DOM is a mock and does not establish a real xterm, tmux, attach or viewport measurement."},
    {id:"reopen",name:"Reopen affordance",short:"Reopen",kind:"CONTROL",selector:"#work-open",hint:"36×36",description:"When desktop navigation is tucked away, one quiet action returns to the Session list.",tokens:["--nession-shell-icon-button-size","--nession-icon-md","--nession-radius-control"],notes:"No permanent 50px rail. Only this small work-edge control is exposed while the Sidebar is collapsed; on narrow Web it opens the drawer."}
  ];
  const byId = Object.fromEntries(specs.map(s=>[s.id,s]));
  const order = ["menu","actions","title","metadata","session","search","new","toggle","reopen","status","footer","top","sidebar","work"];
  const tokenColors = [
    ["Sidebar", "--nession-sidebar"],
    ["Selected row", "--nession-sidebar-accent"],
    ["Work canvas", "--nession-background"],
    ["Primary text", "--nession-foreground"]
  ];
  const typeRoles = [
    ["Primary · 14px / 550","--nession-typography-primary-size","--nession-typography-primary-weight","--nession-typography-primary-line-height","Fix terminal reconnect"],
    ["Metadata · 11.5px / 475","--nession-typography-metadata-size","--nession-typography-metadata-weight","--nession-typography-metadata-line-height","Claude Code · devbox-01"],
    ["Secondary · 12.5px / 500","--nession-typography-secondary-size","--nession-typography-secondary-weight","--nession-typography-secondary-line-height","Sessions"]
  ];
  let selected="sidebar", inspecting=false, pending=false, lastHighlighted=null;
  const picker=$("spec-component-picker");
  const readToken=name=>getComputedStyle(shell).getPropertyValue(name).trim();
  const round=num=>Number.isFinite(num)?(Math.round(num*10)/10).toString():"—";
  function make(tag,cls,content) {
    const node=document.createElement(tag);
    if(cls)node.className=cls;
    if(content!==undefined)node.textContent=content;
    return node;
  }
  for(const item of specs) {
    const b=make("button","","");
    b.type="button";b.dataset.specId=item.id;
    b.setAttribute("aria-pressed",String(item.id===selected));
    b.append(make("span","",item.short),make("span","",item.hint));
    b.addEventListener("click",()=>choose(item.id,true));
    picker.append(b);
  }
  function selectTarget(item) {
    return shell.querySelector(item.selector) ||
       (item.id==="session"?shell.querySelector(".n-session-item"):item.id==="title"?shell.querySelector(".n-session-name"):item.id==="metadata"?shell.querySelector(".n-session-sub"):null);
  }
  function isVisible(el) {
    if(!el || el.closest("[hidden]"))return false;
    const r=el.getBoundingClientRect(), d=device.getBoundingClientRect();
    const style=getComputedStyle(el);
    if(style.display==="none" || style.visibility==="hidden" || r.width<1 || r.height<1)return false;
    if(r.right <= d.left || r.left >= d.right || r.bottom<=d.top || r.top>=d.bottom)return false;
    return true;
  }
  function choose(id, enableInspect) {
    selected=id;
    if(enableInspect && !inspecting) setInspecting(true);
    sync();
  }
  function setInspecting(next) {
    inspecting=next;
    shell.classList.toggle("n-spec-inspecting",inspecting);
    const btn=$("spec-inspect-toggle");
    btn.setAttribute("aria-pressed",String(inspecting));
    btn.textContent=inspecting?"退出点选 · 恢复交互":"在预览中点选元素";
    sync();
  }
  function fillText(id,content) {$(id).textContent=content;}
  function refreshRuler() {
    const frame=shell.getBoundingClientRect(),nav=$("n-sidebar").getBoundingClientRect(),main=shell.querySelector(".n-work").getBoundingClientRect();
    const mode=shell.dataset.mode, collapsed=shell.dataset.collapsed==="true",drawer=shell.dataset.drawerOpen==="true";
    const effectiveNav=mode==="wide"?nav.width:0;
    const effectiveMain=mode==="wide"?main.width:frame.width;
    const navBar=$("spec-ruler-nav"), workBar=$("spec-ruler-main");
    navBar.style.width=(frame.width>0?Math.max(0,Math.min(100,effectiveNav/frame.width*100)):0)+"%";
    workBar.style.width=(frame.width>0?Math.max(0,Math.min(100,effectiveMain/frame.width*100)):100)+"%";
    navBar.textContent=effectiveNav>=85?"Sidebar "+round(effectiveNav)+"px":"";
    workBar.textContent="Work "+round(effectiveMain)+"px";
    fillText("spec-viewport-label",(mode==="wide"?"Web":"Narrow Web")+" · "+round(frame.width)+" × "+round(frame.height));
    fillText("spec-ruler-note",mode==="wide"?(collapsed?"SIDEBAR TUCKED AWAY · 0PX RESERVED":"SIDEBAR + FLEX WORK AREA"):(drawer?"DRAWER OVERLAY · DOES NOT RESERVE WORK WIDTH":"DRAWER CLOSED · WORK OWNS FULL WIDTH"));
  }
  function refreshSwatches() {
    const swatches=$("spec-swatches");swatches.replaceChildren();
    for(const [label,token] of tokenColors){
      const cell=make("div","np-spec-swatch");
      const paint=make("div","np-spec-swatch-paint");
      paint.style.backgroundColor=readToken(token);
      const copy=make("div","np-spec-swatch-label");
      copy.append(make("b","",label),make("code","",token));
      cell.append(paint,copy);swatches.append(cell);
    }
    const types=$("spec-type-samples");types.replaceChildren();
    for(const [label,size,weight,line,sample]of typeRoles){
      const card=make("div","np-spec-type");
      card.append(make("div","np-spec-type-label",label));
      const text=make("div","np-spec-type-preview",sample);
      text.style.fontSize=readToken(size);text.style.fontWeight=readToken(weight);text.style.lineHeight=readToken(line);
      card.append(text);types.append(card);
    }
  }
  function sync(){
    pending=false;
    const item=byId[selected];
    for(const btn of picker.querySelectorAll("[data-spec-id]"))btn.setAttribute("aria-pressed",String(btn.dataset.specId===selected));
    const el=selectTarget(item),visible=isVisible(el);
    if(lastHighlighted)lastHighlighted.classList.remove("n-spec-highlight");
    lastHighlighted=null;
    if(el && inspecting && visible) {el.classList.add("n-spec-highlight");lastHighlighted=el;}
    fillText("spec-component-kind",item.kind);
    fillText("spec-component-name",item.name);
    fillText("spec-component-description",item.description);
    const visibility=$("spec-component-visibility");
    visibility.dataset.visible=String(visible);
    visibility.textContent=visible?"Visible in current preview":"Not visible in current state";
    const rect=el?.getBoundingClientRect(),style=el?getComputedStyle(el):null;
    const value=(k)=>style?style.getPropertyValue(k).trim():"—";
    fillText("spec-width",visible?round(rect.width)+"px":"—");
    fillText("spec-height",visible?round(rect.height)+"px":"—");
    fillText("spec-padding",visible?value("padding"):"—");
    fillText("spec-radius",visible?value("border-radius"):"—");
    fillText("spec-font",visible?value("font-size"):"—");
    fillText("spec-type-detail",visible?value("font-weight")+" / "+value("line-height"):"—");
    const tokens=$("spec-token-list");tokens.replaceChildren();
    for(const key of item.tokens) {
      const tag=make("code","",key);
      tag.title=readToken(key)||"Token absent from local snapshot; see source design";
      tokens.append(tag);
    }
    fillText("spec-state-notes",item.notes+(visible?" Computed from live prototype DOM.":" Current mode hides this target; open the corresponding Sidebar/Session view to measure it."));
    refreshRuler();
    refreshSwatches();
  }
  function schedule(){
    if(pending)return;pending=true;
    requestAnimationFrame(sync);
  }
  function afterTransition(){
    schedule();
    setTimeout(schedule,220);
  }
  $("spec-inspect-toggle").addEventListener("click",()=>setInspecting(!inspecting));
  shell.addEventListener("click",e=>{
    if(!inspecting)return;
    const hits=[];
    for(const id of order){
      const el=selectTarget(byId[id]);
      if(el && el.contains(e.target))hits.push(id);
    }
    if(!hits.length)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    choose(hits[0],false);
    document.getElementById("ui-spec")?.scrollIntoView({behavior:"smooth",block:"start"});
  },true);
  review.addEventListener("np:resize",afterTransition);
  review.addEventListener("nession:prototype-render",afterTransition);
  review.addEventListener("input",schedule);
  if(typeof ResizeObserver==="function"){
    const ro=new ResizeObserver(schedule);
    ro.observe(shell);ro.observe($("n-sidebar"));ro.observe(shell.querySelector(".n-work"));
  }
  window.addEventListener("resize",schedule);
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&inspecting)setInspecting(false);});
  sync();
})();