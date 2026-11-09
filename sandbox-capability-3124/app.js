/* Sandbox Workspace prototype #3124. Deterministic, no network or backend mutations. */
(function(){
  "use strict";
  var root=document.querySelector("[data-np-root]");
  var device=document.querySelector("[data-np-device]");
  var mock=document.getElementById("sandbox-product");
  var output=document.getElementById("sandbox-inspector");
  if(!root||!device||!mock)return;
  var state={mode:"web",surface:"terminal",cap:"sandbox",depth:"root",fixture:"active",session:"sandbox-review",peek:false};
  var titles={files:"Files",git:"Git",session:"Session",agent:"Agent",env:"Env",sandbox:"Sandbox"};
  var icons={files:"▤",git:"⑂",session:"▣",agent:"◉",env:"⌘",sandbox:"⬡"};
  var execution="sbx-70df40f4";
  var digest="sha256:9d8437a6e3c1…a26f";
  function settings(){
    var s=state.fixture;
    return {
      scenario:s,
      online:s!=="offline",
      supported:s!=="unsupported",
      verified:s==="active"||s==="partial",
      fresh:s!=="recreated",
      running:s==="active"||s==="partial",
      warning:s==="partial"?"仅初始 Pane 已验证隔离；后续 Window/Pane 不属于 V1 的强制范围。":"",
      native:s==="native",
      offline:s==="offline",
      unsupported:s==="unsupported",
      recreated:s==="recreated"
    };
  }
  function line(title,value,sub){
    return '<div class="fact"><small>'+title+'</small><b>'+value+'</b>'+(sub?'<div class="subtxt">'+sub+'</div>':'')+'</div>';
  }
  function zone(){
    var btn='<button type="button" class="round" data-action="terminal" aria-label="Return to Terminal" title="Return to Terminal">↩</button>';
    var list=['files','git','session','agent','env','sandbox'];
    if(state.fixture==="unsupported")list=list.filter(function(v){return v!=="sandbox";});
    var items=list.map(function(id){return '<button type="button" class="cap-item" data-action="cap:'+id+'" aria-label="'+titles[id]+'"'+(state.cap===id?' aria-current="page"':'')+'><span aria-hidden="true">'+icons[id]+'</span><span>'+titles[id]+'</span></button>';}).join("");
    return '<div class="bottom-zone">'+(state.mode==="web"?btn:"")+'<nav aria-label="Workspace capabilities" class="capsule workspace-cap" data-testid="workspace-capability-capsule"><div class="capsule-row">'+items+'</div></nav></div>';
  }
  function terminalOutput(){
    return '<span class="prompt">➜</span>  /workspace/nession  git status --short\n'+
      ' M crates/nession-agent/src/sandbox_runtime.rs\n'+
      ' M web/src/app/workspace/capabilities.ts\n\n'+
      '<span class="prompt">➜</span>  /workspace/nession  cargo test -p nession-sandbox\n'+
      'running 14 tests\n'+
      'test result: ok. 14 passed; 0 failed\n\n'+
      '<span class="prompt">➜</span>  /workspace/nession  ▌';
  }
  function terminal(){
    var peek=state.peek?'<div class="peek" role="region" aria-label="Sandbox Peek"><div class="peekhead"><b>Sandbox · 当前 Session</b><button class="close" data-action="toggle-peek" aria-label="Close Sandbox Peek">✕</button></div><p>'+(settings().verified?'已观察到按需隔离执行，仅覆盖已验证的初始 Pane。':settings().offline?'Agent 离线，无法确认当前执行状态。':settings().native?'Agent 支持 Sandbox；当前 Session 是 Native。':settings().unsupported?'宿主无法提供可用 Sandbox backend。':'没有与当前实例匹配的执行证明。')+'</p><button class="action" data-action="open-from-peek">在 Workspace 查看 Sandbox →</button></div>':"";
    if(state.mode==="app"){
      return '<div class="app"><header class="app-header"><button class="action-small" data-action="sessions" aria-label="Open Sessions">☰ Sessions</button><span class="app-title">'+state.session+'</span><button class="action-small" data-action="workspace" aria-label="Open Workspace">Workspace ›</button></header><main class="terminal"><pre class="term-output">'+terminalOutput()+'</pre></main>'+peek+'<div class="bottom-zone"><div class="capsule compose"><button class="plus" data-action="toggle-peek" aria-label="Peek at Sandbox">+</button><span class="hint">Send to Terminal…</span><button class="send" disabled title="Terminal input is not simulated in this prototype" aria-label="Terminal input unavailable in mock">↑</button></div></div></div>';
    }
    return '<div class="terminal"><div class="terminal-head"><div><b>'+state.session+'</b><span class="subtxt"> · nession-dev</span></div><span class="minor">Terminal</span></div><pre class="term-output">'+terminalOutput()+'</pre></div>'+peek+'<div class="bottom-zone"><div class="capsule compose"><button class="plus" data-action="toggle-peek" aria-label="Peek at Sandbox">+</button><span class="hint">Send to Terminal…</span><button class="send" disabled title="Terminal input is not simulated in this prototype" aria-label="Terminal input unavailable in mock">↑</button></div><button class="round" data-action="workspace" aria-label="Open Workspace" title="Open Workspace">▦</button></div>';
  }
  function headline(){
    var s=settings();
    if(s.verified)return 'On-demand Sandbox execution';
    if(s.native)return 'Native Session';
    if(s.offline)return 'Agent unreachable';
    if(s.unsupported)return 'Sandbox unavailable';
    if(s.recreated)return 'Execution evidence not verified';
    return 'Sandbox status unknown';
  }
  function summary(){
    var s=settings();
    var badges='<span class="pill strong">'+(s.verified?'Execution verified':s.native?'Host supported':s.offline?'Offline':s.unsupported?'Unsupported':'Not verified')+'</span>';
    if(s.verified)badges+='<span class="pill">On-demand · initial Pane</span>';
    if(s.verified)badges+='<span class="pill">linux-bwrap</span>';
    if(s.offline||s.unsupported)badges+='<span class="pill error">'+(s.offline?'Live state unknown':'No backend')+'</span>';
    return badges;
  }
  function message(){
    var s=settings();
    if(s.verified)return '<strong>隔离边界：</strong>Agent 报告初始 Pane 的隔离机制已在启动前验证。tmux server、Agent、未来新创建的 Pane/Window 并不因此自动进入同一个安全域。'+(s.warning?'<br><strong>范围提示：</strong>'+s.warning:'');
    if(s.native)return '<strong>没有 Sandbox 执行：</strong>当前 Session 是 Native；Agent 支持请求 Sandbox，但尚无该 Session 的隔离执行记录。这不是 Sandbox 启动失败。';
    if(s.offline)return '<strong>当前不可确认：</strong>Agent 已离线。历史快照只能作为上次观察，不得显示「正在受保护」。连接恢复后重新查询，不创建额外执行。';
    if(s.unsupported)return '<strong>没有可安装的隔离后端：</strong>此 Location 的能力探测返回 unsupported。当前已打开的说明可保留，但 Sandbox 不再占用 Workspace Capsule 的导航槽。';
    return '<strong>已拒绝过期证据：</strong>同名 Session 已重建，实例 ID 与旧执行记录不匹配。不得沿用先前的 policy digest / execution id 或显示「受保护」。';
  }
  function dimensionRows(){
    var s=settings();
    if(!s.verified)return '<div class="empty-cap">'+(s.native?'该 Native Session 没有应用 Sandbox Policy。':s.offline?'没有当前有效的 Agent 观测。':s.unsupported?'宿主探测不提供对应机制。':'当前实例没有已验证执行记录。')+'</div>';
    return '<div class="dimlist">'+
      '<div class="dimension"><div class="dimlabel">Filesystem</div><div class="dimval">/workspace · writable<span class="dimmer">/usr · read-only，其他主机路径不可见</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Network</div><div class="dimval">Restricted egress<span class="dimmer">允许 api.anthropic.com:443、github.com:443；ingress denied</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Process</div><div class="dimval">PID / IPC / User namespaces<span class="dimmer">当前 SandboxExecution 内的进程继承隔离</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Resource</div><div class="dimval mono">memory.max 2147483648 · pids.max 256<span class="dimmer">真实 cgroup v2；不是整台 Agent 的限制</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Syscall</div><div class="dimval mono">seccomp: nession-interactive-v1<span class="dimmer">启动前安装固定 Profile</span></div></div>'+
    '</div>';
  }
  function detail(){
    var s=settings();
    if(!s.verified)return '<div class="notice '+(s.offline||s.unsupported?'danger':'')+'">'+message()+'</div><div class="actionline"><button class="action" data-action="detail-back">返回 Sandbox 概览</button></div>';
    return '<div class="notice warning">该报告描述单个 <strong>SandboxExecution</strong>，不是整个 tmux Session 的 enforced policy。</div>'+
      '<div class="info-section"><h3>已验证机制（执行时观测）</h3><div class="dimlist">'+
      ['Filesystem bind/mount restrictions','Network egress proxy + deny bypass','Linux PID/IPC/User namespaces','cgroup v2 memory/pids controllers','seccomp pinned profile'].map(function(x){return '<div class="dimension"><div class="dimlabel">✓ Verified</div><div class="dimval">'+x+'</div></div>';}).join('')+'</div></div>'+
      '<section class="info-section"><h3>Execution identity</h3><div class="info-grid">'+
      line('Execution ID','<span class="mono">'+execution+'</span>')+
      line('Backend','linux-bwrap')+
      line('Policy digest','<span class="mono">'+digest+'</span>')+
      line('Session instance','<span class="mono">instance-15f4</span>')+
      line('Effective cgroup path','Private · see Agent diagnostics')+
      line('Warnings',s.warning?'<span>'+s.warning+'</span>':'No reported warning')+
      '</div></section><div class="actionline"><button class="action" data-action="detail-back">返回 Sandbox 概览</button></div>';
  }
  function sandbox(){
    var s=settings();
    var title=state.depth==="detail"?'Execution details':'Sandbox';
    var intro=state.depth==="detail"?'当前 Session / SandboxExecution 的只读已验证详情。':'当前工作位置上的 Sandbox 能力和实际执行状态。';
    var first='<section class="workspace" data-testid="sandbox-view"><div class="workspace-inner">'+
      (state.mode==="web"?'<div class="crumb">Workspace / '+state.session+' / '+title+'</div>':'')+
      '<div class="titlebar"><div><h2>'+title+'</h2><p class="subline">'+intro+'</p></div></div>';
    if(state.depth==="detail")return first+detail()+'</div></section>';
    return first+'<div class="statusline">'+summary()+'</div>'+
      '<div class="notice '+(s.verified?'warning':s.offline||s.unsupported?'danger':'')+'">'+message()+'</div>'+
      '<section class="info-section"><h3>'+headline()+'</h3><div class="info-grid">'+
      line('Agent / Location',s.offline?'nession-dev · offline':'nession-dev · linux')+
      line('Session',state.session)+
      line('Execution mode',s.verified?'Sandbox · on-demand':s.native?'Native':s.unsupported?'Unsupported':s.offline?'Unknown (offline)':'Unknown (new instance)')+
      line('Backend',s.unsupported?'None':s.verified?'linux-bwrap':s.offline?'Last known: linux-bwrap':'Available: linux-bwrap')+
      '</div></section><section class="info-section"><h3>Policy dimensions / 运行约束</h3>'+dimensionRows()+'</section>'+
      (s.verified?'<div class="actionline"><button class="action primary" data-action="detail">查看已验证执行详情 →</button></div>':'<div class="extra-dim">当前无可读取的已验证执行详情。能力支持与执行成功是两个独立事实。</div>')+
      '</div></section>';
  }
  function otherCapability(){
    var t=titles[state.cap]||"Workspace";
    return '<section class="workspace"><div class="workspace-inner"><div class="crumb">'+(state.mode==="web"?'Workspace / '+state.session+' / ':'')+t+'</div><h2>'+t+'</h2><p class="subline">此画面仅为 Workspace 能力切换上下文占位，不模拟 '+t+' 的全部功能。切回 Sandbox 可保留 Session/Location 上下文。</p><div class="actionline"><button class="action" data-action="cap:sandbox" '+(state.fixture==="unsupported"?'disabled title="Sandbox unavailable"':'')+'>返回 Sandbox</button></div></div></section>';
  }
  function workspace(){
    var current=(state.cap==="sandbox"?sandbox():otherCapability());
    if(state.mode==="app"){
      var title=state.depth==="detail"?"Execution details":titles[state.cap];
      return '<div class="app"><header class="app-header"><button type="button" class="arrow" data-action="'+(state.depth==="detail"?'detail-back':'terminal')+'" aria-label="Back">←</button><span class="app-title">'+title+'</span><span style="width:40px"></span></header><main class="app-body">'+current+'</main>'+zone()+'</div>';
    }
    return '<div class="main-content">'+current+'</div>'+zone();
  }
  function side(){
    return '<aside class="sidebar"><div class="sidebar-head"><span class="wordmark">nession</span><span aria-hidden="true">☷</span></div>'+
      '<div class="side-label">Sessions</div>'+
      '<button class="navrow '+(state.session==="sandbox-review"?'selected':'')+'" data-action="session:sandbox-review"><span>▣</span><span class="navtext">sandbox-review<br><span class="subtxt">shell · nession-dev</span></span></button>'+
      '<button class="navrow '+(state.session==="native-debug"?'selected':'')+'" data-action="session:native-debug"><span>▣</span><span class="navtext">native-debug<br><span class="subtxt">shell · nession-dev</span></span></button>'+
      '<div class="side-label">Projects</div><div class="navrow"><span>◫</span><span class="navtext">Nession</span></div>'+
      '<div class="side-label">Agents</div><div class="navrow"><span>◉</span><span class="navtext">nession-dev<br><span class="subtxt">'+(settings().offline?'Offline':'Online')+'</span></span></div></aside>';
  }
  function sessions(){
    return '<div class="app"><header class="app-header"><button type="button" class="arrow" data-action="terminal" aria-label="Back to Terminal">←</button><span class="app-title">Sessions</span><span style="width:40px"></span></header><main class="app-body"><h2>Sessions</h2><p class="subline">Today</p><div class="info-section"><button class="navrow" data-action="session:sandbox-review"><span>▣</span><span>sandbox-review · nession-dev</span></button><button class="navrow" data-action="session:native-debug"><span>▣</span><span>native-debug · nession-dev</span></button></div></main></div>';
  }
  function render(){
    var content=state.surface==="workspace"?workspace():state.surface==="sessions"?sessions():terminal();
    mock.setAttribute("data-mode",state.mode);
    mock.innerHTML=state.mode==="web"?'<div class="shell">'+side()+'<main class="main">'+content+'</main></div>':content;
    if(output)output.textContent=JSON.stringify({mode:state.mode,surface:state.surface,capability:state.cap,depth:state.depth,fixture:state.fixture,session:state.session,known_execution:settings().verified,execution_scope:"on-demand initial Pane, not enforced Session"},null,2);
    var target=mock.querySelector('.cap-item[aria-current="page"]');
    if(target&&typeof target.scrollIntoView==="function")target.scrollIntoView({inline:"nearest",block:"nearest"});
  }
  function setFixture(value){
    state.fixture=value;
    state.peek=false;
    if(value==="unsupported"&&state.cap!=="sandbox")state.depth="root";
    document.querySelectorAll("[data-fixture]").forEach(function(button){button.setAttribute("aria-pressed",String(button.getAttribute("data-fixture")===value));});
    render();
  }
  mock.addEventListener("click",function(e){
    var button=e.target.closest("[data-action]");
    if(!button||button.disabled)return;
    var action=button.getAttribute("data-action");
    if(action==="workspace"||action==="open-from-peek"){state.surface="workspace";state.cap="sandbox";state.depth="root";state.peek=false;}
    else if(action==="terminal"){state.surface="terminal";state.depth="root";state.peek=false;}
    else if(action==="sessions"){state.surface="sessions";state.peek=false;}
    else if(action==="toggle-peek"){state.peek=!state.peek;}
    else if(action==="detail"){state.depth="detail";}
    else if(action==="detail-back"){state.depth="root";}
    else if(action.indexOf("cap:")===0){state.cap=action.slice(4);state.depth="root";}
    else if(action.indexOf("session:")===0){
      var name=action.slice(8);state.session=name;state.surface="terminal";state.depth="root";state.peek=false;
      if(name==="native-debug")state.fixture="native";else state.fixture="active";
      document.querySelectorAll("[data-fixture]").forEach(function(b){b.setAttribute("aria-pressed",String(b.getAttribute("data-fixture")===state.fixture));});
    }
    render();
  });
  root.querySelectorAll("[data-fixture]").forEach(function(button){
    button.addEventListener("click",function(){setFixture(button.getAttribute("data-fixture"));});
  });
  function resize(width){
    state.mode=width>=600?"web":"app";
    device.style.setProperty("--np-device-height",state.mode==="web"?"760px":"844px");
    if(state.mode==="app"&&state.surface==="sessions")state.surface="terminal";
    render();
  }
  root.addEventListener("np:resize",function(e){resize(e.detail.width);});
  resize(1180);
})();