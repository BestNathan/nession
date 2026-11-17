/* Session Activity #3804 — synthetic, deterministic review-only behavior.
   No live Nession API, storage, shell, CLI, or network writes. */
(function () {
  "use strict";
  var root = document.getElementById("mock-shell");
  var review = document.getElementById("review-root");
  var device = document.querySelector("[data-np-device]");
  if (!root || !review || !device) return;

  var initial = [
    { id:"ci", name:"ci-workflow", title:"CI Workflow repair", command:"claude", agent:"devbox-01",
      ago:"2m", activity:"working", attention:null, capability:"claude-code", instance:"inc-ci-01", observation:"14:20:12" },
    { id:"shell", name:"production-shell", title:"Production shell", command:"zsh", agent:"macbook",
      ago:"12m", activity:"idle", attention:null, capability:"shell", instance:"inc-shell-01", observation:"14:18:40" },
    { id:"codex", name:"codex-runtime", title:"Codex runtime review", command:"codex", agent:"macbook",
      ago:"24m", activity:"working", attention:"input_required", capability:"codex", instance:"inc-codex-01", observation:"14:17:31" },
    { id:"unknown", name:"remote-debug", title:"Remote debug", command:"bash", agent:"sg-prod",
      ago:"1h", activity:"unknown", attention:null, capability:null, instance:"inc-remote-01", observation:null }
  ];

  var sessions = initial.map(function (s) { return Object.assign({}, s); });
  var selectedId = "ci";
  var online = { "devbox-01":true, "macbook":true, "sg-prod":true };
  var mode = "web";
  var webView = "terminal";
  var appLayer = "sessions";
  var search = { web:"", app:"" };
  var collapsed = false;
  var generation = 1;
  var menuTarget = null;
  var menuReturnFocus = null;
  var scenarioText = "初始：Claude 正在处理；Shell 空闲；Codex 需要输入；另一 Session 状态未知。";
  var log = ["Generation 1: initial synthetic Activity snapshot"];
  var toastHandle = null;
  var projectDialog = false;
  var dialogSessionId = null;

  function byId(id) { return document.getElementById(id); }
  function text(id, value) { var el = byId(id); if (el) el.textContent = value; }
  function encode(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function session(id) { return sessions.find(function(s) { return s.id === id; }); }
  function selected() { return session(selectedId) || sessions[0] || null; }
  function effective(s) {
    if (!online[s.agent]) return {state:"unknown", attention:null, stale:true};
    return {state:s.activity, attention:s.attention, stale:false};
  }
  function spoken(s) {
    var e = effective(s);
    if(e.stale) return "Unknown — Agent unreachable; last observation unverified";
    if(e.attention === "input_required") return "Working — needs user input";
    if(e.state === "working") return "Working";
    if(e.state === "idle") return "Idle";
    return "Unknown";
  }
  function symbol(s) {
    var e = effective(s);
    return e.attention === "input_required" ? "input" : e.state;
  }
  function listMarkup(s) {
    var e = effective(s);
    var meta = encode(s.command) + " · " + encode(s.agent) + " · " + encode(s.ago);
    var notice = "";
    if (e.stale) notice = '<span class="n-session-alert" data-type="offline">Agent unreachable</span>';
    else if (e.attention === "input_required") notice = '<span class="n-session-alert" data-type="input">Needs input</span>';
    var label = s.title + ". Activity: " + spoken(s) + ". " + s.command + ", " + s.agent;
    return '<div class="n-session-row" data-session-row="' + encode(s.id) + '" data-selected="' + (s.id === selectedId) +
      '" data-activity="' + encode(e.state) + '" data-attention="' + encode(e.attention || "none") + '">' +
      '<button type="button" class="n-session-select" data-select="' + encode(s.id) +
      '" aria-label="' + encode(label) + '" aria-current="' + (s.id === selectedId ? "true" : "false") + '">' +
        '<span class="n-session-title-line">' +
        '<span class="n-activity" data-activity="' + encode(symbol(s)) + '" aria-hidden="true" title="' + encode(spoken(s)) + '"></span>' +
        '<span class="n-session-title">' + encode(s.title) + '</span></span>' +
        '<span class="n-session-meta">' + meta + '</span>' + notice +
      '</button>' +
      '<button class="n-row-more" type="button" data-menu="' + encode(s.id) +
      '" aria-label="Session actions for ' + encode(s.title) + '" title="Session actions">···</button>' +
      '</div>';
  }

  function renderList(which) {
    var query = search[which].trim().toLowerCase();
    var filtered = sessions.filter(function(s) {
      return (s.title + " " + s.name + " " + s.agent + " " + s.command).toLowerCase().includes(query);
    });
    var target = byId(which === "web" ? "web-session-list" : "app-session-list");
    if (!target) return;
    if (filtered.length) target.innerHTML = filtered.map(listMarkup).join("");
    else target.innerHTML = '<div class="n-empty">' +
      '<span>No sessions match “' + encode(search[which]) + '”.</span>' +
      '<button type="button" data-clear-search="' + which + '">Clear search</button></div>';
    text("web-count", String(sessions.length));
  }

  function render() {
    renderList("web");
    renderList("app");
    var s = selected();
    if (!s) appLayer = "sessions";
    byId("web-composer").hidden = !s;
    byId("app-composer").hidden = !s;
    if (!s) {
      text("web-terminal-copy", "No Sessions yet. Use New Session to begin.\n");
      text("app-terminal-copy", "No Sessions yet. Use New Session to begin.\n");
    }
    text("web-active-title", s ? s.title : "Sessions");
    text("app-active-title", s ? s.title : "Sessions");
    text("web-workspace-title", s ? s.title : "Workspace");
    text("app-workspace-title", s ? s.title : "Workspace");
    byId("web-sidebar").dataset.collapsed = String(collapsed);
    byId("web-terminal").hidden = webView !== "terminal";
    byId("web-workspace").hidden = webView !== "workspace";
    byId("app-sessions").hidden = appLayer !== "sessions";
    byId("app-terminal").hidden = appLayer !== "terminal";
    byId("app-workspace").hidden = appLayer !== "workspace";
    var issue = !online["devbox-01"];
    byId("app-connection-problem").hidden = !issue;
    text("app-agent-health", issue ? "Unreachable" : "Connected");
    text("scenario-summary", scenarioText);
    text("scenario-revision", "generation " + generation);
    var inspector = {
      review_only:true, selected_session_id:selectedId, experience:mode,
      generation:generation,
      activity_for_ci: {reported:sessions[0] && sessions[0].activity, effective:sessions[0] && effective(sessions[0]),
        owner:sessions[0] && sessions[0].capability, last_verified_at:sessions[0] && sessions[0].observation},
      session_order:sessions.map(function(x){return x.id;}),
      recency_unmodified:sessions.map(function(x){return [x.id,x.ago];}),
      recent_events:log.slice(-7)
    };
    text("fixture-inspector", JSON.stringify(inspector,null,2));
  }

  function setMode(width) {
    mode = width <= 430 ? "app" : "web";
    root.dataset.experience = mode;
    root.dataset.surface = mode === "app" ? appLayer : webView;
    device.style.setProperty("--np-device-height", mode === "app" ? (width <= 375 ? "812px":"844px") : (width <= 1024 ? "680px":"700px"));
    closeMenu();
    closeDialog();
    render();
  }

  function closeMenu(restore) {
    byId("session-actions").hidden = true;
    byId("session-actions").replaceChildren();
    menuTarget = null;
    if (restore && menuReturnFocus && menuReturnFocus.isConnected) menuReturnFocus.focus();
    menuReturnFocus = null;
  }
  function openMenu(id, button) {
    if (menuTarget === id) { closeMenu(true); return; }
    closeMenu(false);
    var s = session(id);
    if (!s) return;
    menuTarget = id;
    menuReturnFocus = button;
    var menu = byId("session-actions");
    menu.innerHTML = '<button role="menuitem" type="button" data-menu-action="details">ⓘ <span>Session details</span></button>' +
      '<button role="menuitem" type="button" data-menu-action="edit">✎ <span>Edit details</span></button>' +
      '<button role="menuitem" type="button" data-menu-action="attach">⚙ <span>Attach settings</span></button>' +
      '<hr><button role="menuitem" class="n-destructive" type="button" data-menu-action="kill">× <span>Kill session</span></button>';
    menu.hidden = false;
    var sr = root.getBoundingClientRect();
    var br = button.getBoundingClientRect();
    var left = Math.min(Math.max(8,br.right - sr.left - 201),sr.width - 209);
    var top = Math.min(br.bottom - sr.top + 5,sr.height - menu.offsetHeight - 9);
    menu.style.left = Math.max(8,left) + "px";
    menu.style.top = Math.max(8,top) + "px";
    var first = menu.querySelector("button");
    if (first) first.focus();
  }

  function closeDialog() {
    var d = byId("dialog-layer");
    d.hidden = true;d.replaceChildren();projectDialog = false;dialogSessionId = null;
  }
  function dialog(title,body,footer,targetId) {
    closeMenu(false);
    var layer = byId("dialog-layer");
    dialogSessionId = targetId || selectedId;
    layer.innerHTML =
      '<section class="n-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">' +
      '<header class="n-dialog-head"><h2 id="dialog-title">' + encode(title) + '</h2>' +
      '<button type="button" class="n-icon" data-dialog="cancel" aria-label="Close dialog">×</button></header>' +
      '<div class="n-dialog-body">' + body + '</div>' +
      '<footer class="n-dialog-foot">' + footer + '</footer></section>';
    layer.hidden = false;
    var input = layer.querySelector("input");
    if (input) input.focus();
    else {var cancel=layer.querySelector('[data-dialog="cancel"]');if(cancel) cancel.focus();}
  }
  function field(id,label,value,placeholder) {
    return '<label for="' + id + '">' + encode(label) + '</label><input id="' + id +
      '" value="' + encode(value || "") + '" placeholder="' + encode(placeholder || "") + '" autocomplete="off">';
  }
  function footer(confirm,action,kind) {
    return '<button type="button" data-dialog="cancel">Cancel</button>' +
      '<button type="button" class="' + (kind || "n-primary") + '" data-dialog="' + action + '">' + encode(confirm) + '</button>';
  }

  function showDialog(kind,id) {
    var s = session(id || selectedId);
    if (kind === "details") {
      if (!s) return;
      var activity = effective(s);
      var description = '<dl><dt>tmux session</dt><dd>' + encode(s.name) +
        '</dd><dt>Agent</dt><dd>' + encode(s.agent) +
        '</dd><dt>Connection</dt><dd>' + (online[s.agent] ? "Online" : "Offline") +
        '</dd><dt>Activity</dt><dd>' + encode(spoken(s)) +
        '</dd><dt>Capability owner</dt><dd>' + encode(s.capability || "Unknown") +
        '</dd><dt>Observed at</dt><dd>' + encode(s.observation || "Not reported") +
        (activity.stale ? ' (last known, no longer verified)' : '') +
        '</dd><dt>Instance</dt><dd>' + encode(s.instance) + '</dd></dl>' +
        '<p>Activity is independent of Session lifecycle, attachment and Agent connectivity. Metadata is unchanged by state updates.</p>';
      dialog("Session details · " + s.title,description,'<button class="n-primary" type="button" data-dialog="cancel">Done</button>',s.id);
    } else if (kind === "edit" && s) {
      dialog("Edit Session details",field("title-field","Display title",s.title,"Title"),footer("Save title","save-title"),s.id);
    } else if (kind === "attach" && s) {
      dialog("Attach settings",'<p>Renderer: WebGL. This is a simulated configuration view for <strong>' +
        encode(s.name) + '</strong>; opening settings does not attach or select the Session.</p>',
        footer("Save settings","save-settings"),s.id);
    } else if (kind === "kill" && s) {
      dialog("Kill session",'<p>This only removes a synthetic row from the preview. Enter the exact tmux name:</p>' +
        field("kill-field","Exact Session name","",s.name),footer("Kill mock session","kill","n-danger"),s.id);
    } else if (kind === "new") {
      dialog("New Session",'<p>Create a local synthetic row; no real Agent or tmux will be changed.</p>' +
        field("new-field","Session name","","new-session"),footer("Create mock Session","create"));
    } else if (kind === "project") {
      projectDialog = true;
      dialog("Project · nession",'<p>Project is a sibling resource in Nession navigation. It does not take ownership of Session Activity or switch the active Session.</p>',
        '<button type="button" class="n-primary" data-dialog="cancel">Done</button>');
    } else if (kind === "capabilities") {
      dialog("Session capabilities",'<p>Shell, Claude Code and Codex can each contribute their own activity observations. Nession only aggregates their state; this mock does not execute a provider.</p>',
        '<button type="button" class="n-primary" data-dialog="cancel">Done</button>');
    }
  }

  function toast(message) {
    if (toastHandle) clearTimeout(toastHandle);
    var el = byId("toast");
    el.hidden = false;el.textContent = message;
    toastHandle=setTimeout(function(){el.hidden=true;},2500);
  }
  function setSurface(surface) {
    closeMenu(false);
    if (mode === "web") webView = surface === "workspace" ? "workspace" : "terminal";
    else appLayer = surface;
    root.dataset.surface = surface;
    render();
  }
  function navigateSession(id) {
    if (!session(id)) return;
    selectedId = id;
    var s = selected();
    var command = s && s.command || "shell";
    var output = "~/" + (s ? s.name : "workspace") + " $ " + command + "\n" +
      (command === "claude" ? "> Review the GitHub Actions workflow\nInspecting changes…\n" :
       command === "codex" ? "Reviewing repository files…\nWaiting for approval…\n" :
       "$ Ready in this Session.\n");
    text("web-terminal-copy", output);
    text("app-terminal-copy", output);
    setSurface("terminal");
  }
  function record(message) {log.push(message);if(log.length>20) log.shift();}
  function fixture(name) {
    var s = session("ci");
    if (!s) return;
    closeMenu(false);
    closeDialog();
    if(name === "stale") {
      scenarioText = "已忽略旧 incarnation/generation 的迟到报告；当前状态不变。";
      record("Rejected stale report: previous incarnation, previous owner generation.");
      render();return;
    }
    generation += 1;
    if(name === "offline") {
      online[s.agent] = false;
      scenarioText = "Agent 不可达：先前 Working 仅供详情追溯，当前活动显示 Unknown。";
    } else if(name === "reconnect") {
      online[s.agent] = true;s.activity="working";s.attention=null;s.observation="14:24:51";
      scenarioText = "Agent 重连并重新同步：新的权威快照确认 Claude Working。";
    } else {
      online[s.agent] = true;
      s.activity = name === "idle" ? "idle" : name === "unknown" ? "unknown" : "working";
      s.attention = name === "input" ? "input_required" : null;
      s.observation = "14:23:0" + (generation % 10);
      scenarioText = name === "idle" ? "Claude Turn 完成：进程仍在，但 Session Activity 已是 Idle。" :
        name === "input" ? "Claude 正等待用户确认：Working + Needs input。" :
        name === "unknown" ? "无法确认 Claude 当前 Turn：Unknown，不由 Shell 强行认定 Working。" :
        "Claude 开始新 Turn：Working；未改变 Session 最后用户活动时间。";
    }
    record("Generation " + generation + ": " + name + " => " + spoken(s));
    render();
  }

  function handleDialogAction(action) {
    if (action === "cancel") {closeDialog();return;}
    if (action === "save-title") {
      var edit = byId("title-field");
      var s = session(dialogSessionId || selectedId);
      if (!s || !edit || !edit.value.trim()) {toast("Enter a display title");return;}
      s.title = edit.value.trim();closeDialog();render();toast("Display title changed in mock");
      return;
    }
    if (action === "save-settings") {closeDialog();toast("Mock attach settings saved; no Session attached");return;}
    if (action === "create") {
      var input=byId("new-field");
      var val=input && input.value.trim();
      if(!val || !/^[a-zA-Z0-9_-]{2,40}$/.test(val)){toast("Use 2–40 letters, digits, - or _");return;}
      if(sessions.some(function(s){return s.name === val;})){toast("Session name already exists");return;}
      var id="new-" + (sessions.length+1);
      sessions.unshift({id:id,name:val,title:val,command:"zsh",agent:"macbook",ago:"now",
        activity:"idle",attention:null,capability:"shell",instance:"mock-"+id,observation:"14:26:00"});
      selectedId=id;closeDialog();navigateSession(id);toast("Mock Session created");
      return;
    }
    if (action === "kill") {
      var s = session(dialogSessionId || selectedId);
      var input = byId("kill-field");
      if(!s || !input || input.value.trim() !== s.name){toast("Enter the exact tmux Session name");return;}
      sessions=sessions.filter(function(x){return x.id !== s.id;});
      var wasSelected = selectedId === s.id;
      if (wasSelected) selectedId = sessions.length ? sessions[0].id : null;
      closeDialog();
      if (wasSelected && selectedId) navigateSession(selectedId);
      else render();
      toast("Mock Session removed");
    }
  }

  root.addEventListener("click",function(e){
    var menuAct=e.target.closest("[data-menu-action]");
    if(menuAct){var id=menuTarget;var kind=menuAct.dataset.menuAction;closeMenu(false);showDialog(kind,id);return;}
    var dialogAct=e.target.closest("[data-dialog]");
    if(dialogAct){handleDialogAction(dialogAct.dataset.dialog);return;}
    var select=e.target.closest("[data-select]");
    if(select){navigateSession(select.dataset.select);return;}
    var menu=e.target.closest("[data-menu]");
    if(menu){openMenu(menu.dataset.menu,menu);return;}
    var clear=e.target.closest("[data-clear-search]");
    if(clear){var key=clear.dataset.clearSearch;search[key]="";byId(key+"-search").value="";render();byId(key+"-search").focus();return;}
    var act=e.target.closest("[data-action]");
    if (act){
      var a=act.dataset.action;
      if(a==="sessions") setSurface("sessions");
      else if(a==="terminal"||a==="workspace") setSurface(a);
      else if(a==="new") showDialog("new");
      else if(a==="details") showDialog("details",selectedId);
      else if(a==="projects") showDialog("project");
      else if(a==="capabilities") showDialog("capabilities");
      return;
    }
    if(e.target.closest("#collapse-sidebar")){collapsed=true;render();return;}
    if(e.target.closest("#expand-sidebar")){collapsed=false;render();return;}
    if(e.target.closest("#rail-search")){collapsed=false;render();byId("web-search").focus();return;}
    if(e.target.closest("#web-menu")){collapsed=false;render();return;}
    if(!e.target.closest("#session-actions"))closeMenu(false);
  });
  root.addEventListener("input",function(e){
    if(e.target.id==="web-search"){search.web=e.target.value;renderList("web");}
    else if(e.target.id==="app-search"){search.app=e.target.value;renderList("app");}
  });
  for (var key of ["web-session-scroll","app-session-scroll"]) byId(key).addEventListener("scroll",function(){closeMenu(false);},{passive:true});
  root.addEventListener("submit",function(e){
    if(e.target.id!=="web-composer" && e.target.id!=="app-composer")return;
    e.preventDefault();
    var input=e.target.querySelector("input");
    if(!input || !input.value.trim())return;
    var target=e.target.id==="web-composer"?"web-terminal-copy":"app-terminal-copy";
    var el=byId(target);
    el.textContent += "\n> "+input.value.trim()+"\n(mock input only; no Agent submission)\n";
    el.scrollTop=el.scrollHeight;input.value="";
    toast("Preview only: input not sent to an Agent");
  });
  byId("dialog-layer").addEventListener("click",function(e){
    if(e.target===byId("dialog-layer"))closeDialog();
  });
  document.addEventListener("click",function(e){
    if(!root.contains(e.target) && !byId("session-actions").hidden)closeMenu(false);
  });
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"){
      if(!byId("dialog-layer").hidden){closeDialog();e.preventDefault();}
      else if(!byId("session-actions").hidden){closeMenu(true);e.preventDefault();}
    }
    if(e.key==="Enter" && e.target.id==="kill-field") {e.preventDefault();handleDialogAction("kill");}
    if(e.key==="Enter" && e.target.id==="title-field") {e.preventDefault();handleDialogAction("save-title");}
    if(e.key==="Enter" && e.target.id==="new-field") {e.preventDefault();handleDialogAction("create");}
  });
  review.addEventListener("click",function(e){
    var event=e.target.closest("[data-event]");
    if(event)fixture(event.dataset.event);
  });
  device.addEventListener("np:resize",function(e){setMode(Number(e.detail.width));});
  var initialWidth=Number(device.style.getPropertyValue("--np-device-width").replace("px",""))||1180;
  setMode(initialWidth);
})();