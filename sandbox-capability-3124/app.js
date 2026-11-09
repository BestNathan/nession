/* Sandbox Workspace prototype #3124. Deterministic, no network or backend mutations. */
(function(){
  "use strict";
  var root=document.querySelector("[data-np-root]");
  var device=document.querySelector("[data-np-device]");
  var mock=document.getElementById("sandbox-product");
  var output=document.getElementById("sandbox-inspector");
  if(!root||!device||!mock)return;
  var defaultDraft={workingDir:"/workspace/nession",readOnly:"/usr",write:"/workspace/nession",network:"restricted",egress:"github.com:443,api.anthropic.com:443",pid:true,ipc:true,user:true,mem:"2147483648",pids:"256",seccomp:true};
  var state={mode:"web",surface:"terminal",cap:"sandbox",depth:"root",fixture:"native",session:"sandbox-review",peek:false,draft:Object.assign({},defaultDraft),preflight:"none",preflightError:"",entered:false,pane:"native",effective:null,error:""};
  var titles={files:"Files",git:"Git",session:"Session",agent:"Agent",env:"Env",sandbox:"Sandbox"};
  var icons={files:"▤",git:"⑂",session:"▣",agent:"◉",env:"⌘",sandbox:"⬡"};
  var execution="sbx-70df40f4";
  var digest="sha256:9d8437a6e3c1…a26f";
  function settings(){
    var s=state.fixture;
    var offline=s==="offline",unsupported=s==="unsupported",stale=s==="recreated";
    var inside=!offline&&!unsupported&&!stale&&(s==="active"||state.entered&&state.pane==="sandbox");
    return {scenario:s,online:!offline,supported:!unsupported&&!offline&&!stale,verified:inside,inside:inside,native:!inside&&!offline&&!unsupported&&!stale,offline:offline,unsupported:unsupported,recreated:stale,macos:s==="macos",preflightFail:s==="preflight-fail",enterFail:s==="enter-fail"};
  }
  function escapeHtml(x){return String(x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
  function actualPolicy(){return state.entered&&state.effective?state.effective:defaultDraft;}
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
    var s=settings();
    var peek=state.peek?'<div class="peek" role="region" aria-label="Sandbox Peek"><div class="peekhead"><b>Sandbox · 当前 Pane</b><button class="close" data-action="toggle-peek" aria-label="Close Sandbox Peek">✕</button></div><p>'+(s.inside?'当前 Pane 在已验证 Sandbox 中；可查看实际生效配置。':s.native?'当前 Pane 在 Native 中；可配置策略并进入隔离 Pane。':'当前环境暂不可确认或 Sandbox 无法使用。')+'</p><button class="action" data-action="open-from-peek">打开 Sandbox Workspace →</button></div>':"";

    if(state.mode==="app"){
      return '<div class="app"><header class="app-header"><button class="action-small" data-action="sessions" aria-label="Open Sessions">☰ Sessions</button><span class="app-title">'+state.session+'</span><button class="action-small" data-action="workspace" aria-label="Open Workspace">Workspace ›</button></header><main class="terminal"><pre class="term-output">'+terminalOutput()+'</pre></main>'+peek+'<div class="bottom-zone"><div class="capsule compose"><button class="plus" data-action="toggle-peek" aria-label="Peek at Sandbox">+</button><span class="hint">Send to Terminal…</span><button class="send" disabled title="Terminal input is not simulated in this prototype" aria-label="Terminal input unavailable in mock">↑</button></div></div></div>';
    }
    return '<div class="terminal"><div class="terminal-head"><div><b>'+state.session+'</b><span class="subtxt"> · nession-dev</span></div><span class="minor">Terminal</span></div><pre class="term-output">'+terminalOutput()+'</pre></div>'+peek+'<div class="bottom-zone"><div class="capsule compose"><button class="plus" data-action="toggle-peek" aria-label="Peek at Sandbox">+</button><span class="hint">Send to Terminal…</span><button class="send" disabled title="Terminal input is not simulated in this prototype" aria-label="Terminal input unavailable in mock">↑</button></div><button class="round" data-action="workspace" aria-label="Open Workspace" title="Open Workspace">▦</button></div>';
  }

  function headline(){
    var s=settings();
    return s.inside?"Inside Sandbox":s.offline?"Agent Offline":s.unsupported?"Sandbox Unavailable":s.recreated?"Execution Unknown":"Outside Sandbox";
  }
  function summary(){
    var s=settings(),badges='<span class="pill strong">'+(s.inside?'Current Pane · Sandbox':s.native?'Current Pane · Native':s.offline?'Disconnected':s.unsupported?'Unsupported':'Unknown')+'</span>';
    if(s.inside)badges+='<span class="pill">Verified · '+(s.macos?'macOS Seatbelt':'Linux bwrap')+'</span>';
    if(s.native)badges+='<span class="pill">Enter available'+(s.macos?' · Seatbelt':'')+'</span>';
    return badges;
  }
  function message(){
    var s=settings();
    if(s.inside)return '<strong>当前生效：</strong>这个 Pane 由 Agent 已验证的 SandboxExecution 管理。只覆盖该 Pane 的进程树；原 Native Pane、共享 tmux server 和未来新建的 Pane/Window 不自动受此策略约束。';
    if(s.offline)return '<strong>无法感知：</strong>Agent 已离线，旧执行记录不作为当前隔离证明。可以保留配置草稿，但不能执行 Enter。';
    if(s.unsupported)return '<strong>能力不可用：</strong>宿主未提供可验证的 Sandbox backend；不能进入，也不会自动退回 Native。';
    if(s.recreated)return '<strong>证据已过期：</strong>Session instance 与历史执行记录不匹配。必须重新感知当前 Pane；不能继承旧的「Inside」状态。';
    return '<strong>当前不在 Sandbox：</strong>Agent'+(s.macos?' 提供受限的 Seatbelt 能力':' 可提供原生隔离机制')+'。配置 → 预检 → 确认 Enter 后才会新建隔离 Pane；目前的 Native shell 保持不变。';
  }
  function configInput(id,label,value,type,attr){
    var disabled=!!(attr&&attr.indexOf('unavailable')>=0);
    return '<div class="field '+(attr||'')+'"><label for="sandbox-'+id+'">'+label+'</label>'+
      (type==="select"?'<select id="sandbox-'+id+'" data-draft="'+id+'"><option value="allow"'+(value==="allow"?' selected':'')+'>allow · 继承宿主网络</option><option value="deny"'+(value==="deny"?' selected':'')+'>deny · 禁止外网</option><option value="restricted"'+(value==="restricted"?' selected':'')+'>restricted · 白名单</option></select>':
      '<input id="sandbox-'+id+'" data-draft="'+id+'" value="'+escapeHtml(value)+'" autocomplete="off" spellcheck="false"'+(disabled?' disabled title="Unavailable for this policy/backend"':'')+'>')+'</div>';
  }
  function toggler(id,label,checked,disabled){
    return '<label><input type="checkbox" data-draft="'+id+'" '+(checked?'checked':'')+' '+(disabled?'disabled':'')+'>'+label+'</label>';
  }
  function editor(){
    var d=state.draft,s=settings(),m=s.macos;
    var disabled=m?' disabled':'';
    return '<section class="policy-editor" data-testid="sandbox-policy-editor" aria-label="Sandbox Policy Draft">'+
      '<div class="policy-group"><div><h3>Filesystem</h3><div class="hint2">'+(m?'macOS 本地路径白名单不可保证':'绝对路径 · 按读写权限显式挂载')+'</div></div><div class="policy-fields">'+
      configInput('readOnly','Read-only paths',m?'':d.readOnly,'input','full'+(m?' unavailable':''))+
      configInput('write','Writable paths',m?'':d.write,'input','full'+(m?' unavailable':''))+
      '</div></div>'+
      '<div class="policy-group"><div><h3>Network</h3><div class="hint2">V1 仅支持 Ingress deny</div></div><div class="policy-fields">'+
      configInput('network','Network mode',d.network,'select')+
      configInput('egress','Restricted egress allow',d.egress,'input',d.network==='restricted'?'':'unavailable')+
      '</div></div>'+
      '<div class="policy-group"><div><h3>Process</h3><div class="hint2">Linux namespaces</div></div><div class="checkrow">'+
      toggler('pid','PID',d.pid,m)+toggler('ipc','IPC',d.ipc,m)+toggler('user','USER',d.user,m)+
      (m?'<span class="subtxt">macOS 不提供 Linux namespaces</span>':'')+'</div></div>'+
      '<div class="policy-group"><div><h3>Resource</h3><div class="hint2">'+(m?'macOS 不提供 cgroup v2':'cgroup v2 · 原生控制文件值')+'</div></div><div class="policy-fields">'+
      configInput('mem','memory.max (bytes)',m?'':d.mem,'input',m?'unavailable':'')+
      configInput('pids','pids.max',m?'':d.pids,'input',m?'unavailable':'')+
      '</div></div>'+
      '<div class="policy-group"><div><h3>Syscall</h3><div class="hint2">Linux seccomp</div></div><div class="checkrow">'+
      toggler('seccomp','nession-interactive-v1',d.seccomp,m)+
      (m?'<span class="subtxt">仅 Linux 支持这个 profile</span>':'')+'</div></div>'+
      '<div class="extra-dim">Enforcement: <strong>required</strong> · Draft Policy v1 · 目标：同一 Session 的新隔离 Pane。不会对已有 Native PID 追加限制。</div></section>';
  }
  function policyDescription(d){
    return '<div class="dimlist">'+
      '<div class="dimension"><div class="dimlabel">Filesystem</div><div class="dimval">'+escapeHtml(d.readOnly||'no explicit read')+' · read-only<span class="dimmer">'+escapeHtml(d.write||'none')+' · writable</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Network</div><div class="dimval">'+escapeHtml(d.network)+'<span class="dimmer">'+(d.network==='restricted'?'Allowed: '+escapeHtml(d.egress):'Ingress denied by V1 policy')+'</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Process</div><div class="dimval">'+(['pid','ipc','user'].filter(function(k){return d[k]}).join(' / ')||'no explicitly requested Linux namespaces')+'<span class="dimmer">当前执行上下文的实际机制，不是整个 Session</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Resource</div><div class="dimval mono">memory.max '+escapeHtml(d.mem||'(not requested)')+' · pids.max '+escapeHtml(d.pids||'(not requested)')+'</div></div>'+
      '<div class="dimension"><div class="dimlabel">Syscall</div><div class="dimval">'+(d.seccomp?'seccomp · nession-interactive-v1':'no additional profile requested')+'</div></div></div>';
  }
  function diagnostics(){
    return '<section class="info-section"><h3>执行时验证</h3><div class="info-grid">'+
       line('Backend',settings().macos?'macos-seatbelt':'linux-bwrap')+
       line('Active Pane','<span class="mono">%8 · sandbox interactive</span>')+
       line('Execution ID','<span class="mono">'+execution+'</span>')+
       line('Policy digest','<span class="mono">'+digest+'</span>')+
       line('Session instance','<span class="mono">instance-15f4</span>')+
       line('Enforcement','required · verified before shell execution')+
       '</div></section>';
  }
  function insideView(){
    return '<h3>Inside Sandbox</h3><div class="statusline">'+summary()+'</div><div class="notice warning">'+message()+'</div>'+
       '<section class="info-section"><h3>当前生效配置 · Effective Policy</h3><p class="subline">只读：由 Agent 的实际执行记录返回，不是上次保存的编辑草稿。</p>'+
       policyDescription(actualPolicy())+'</section>'+
       '<div class="actionline"><button class="action primary" data-action="detail">查看验证信息 →</button><button class="action" data-action="return-native">← 返回 Native Pane</button></div>'+
       '<p class="extra-dim">Return to Native 仅切换焦点。原 Sandbox Pane 保持运行，不是终止或清理命令。</p>';
  }
  function preflight(){
    var d=state.draft,s=settings();
    if(!s.online)return 'Agent 离线，无法预检或进入';
    if(s.unsupported)return 'Agent 无可用 Sandbox backend';
    if(s.recreated)return '当前 Session 实例未通过身份确认';
    if(!d.workingDir.startsWith('/')||d.workingDir.indexOf('..')>=0)return '工作目录需要是规范化的绝对路径';
    if(s.macos){
      if(d.network==='restricted')return 'macOS Seatbelt 不支持 restricted egress 代理';
    }else{
      var paths=(d.readOnly+','+d.write).split(',').filter(Boolean);
      if(paths.some(function(p){return !p.trim().startsWith('/')||p.includes('..')}))return 'Filesystem 路径必须是绝对、规范化路径';
      if(!/^[0-9]+$/.test(d.mem)||Number(d.mem)<1048576)return 'memory.max 需要至少 1048576 bytes';
      if(!/^[0-9]+$/.test(d.pids)||Number(d.pids)<1)return 'pids.max 必须为正整数';
    }
    if(d.network==='restricted'&&!d.egress.trim())return 'restricted 模式必须提供至少一个允许目标';
    if(s.preflightFail)return '当前 Agent cgroup v2 controllers 未委派；拒绝创建 Sandbox';
    return '';
  }
  function draftView(){
    var s=settings();
    var c='<h3>'+headline()+'</h3><div class="statusline">'+summary()+'</div><div class="notice '+(!s.online||s.unsupported||s.recreated?'danger':'')+'">'+message()+'</div>'+
      '<div class="info-grid">'+line('Agent / Location',s.offline?'nession-dev · offline':'nession-dev · '+(s.macos?'macOS':'Linux'))+
      line('当前 Pane','Native · %1')+'</div>'+
      '<div class="info-section"><h3>配置 Sandbox</h3><p class="subline">填写 Policy 草稿，预检后明确 Enter；启动新的隔离 Pane，原 Native Pane 不变。</p>'+
      '<div style="max-width:530px;margin-top:12px">'+configInput('workingDir','Start working directory',state.draft.workingDir,'input')+'</div>'+
      editor()+'</div>';
    if(state.preflight==='passed')c+='<div class="notice success validated"><strong>预检通过</strong> · Policy 语法与当前 Agent 能力匹配（仅模拟）。进入时还需重新校验实际主机并验证执行机制。</div>';
    if(state.preflight==='failed')c+='<div class="notice danger validated" role="alert"><strong>预检未通过</strong> · '+escapeHtml(state.preflightError)+'</div>';
    if(state.error)c+='<div class="notice danger validated" role="alert"><strong>Enter 失败</strong> · '+escapeHtml(state.error)+'。仍位于原 Native Pane，草稿已保留。</div>';
    c+='<div class="actionline"><button class="action" data-action="validate" '+(!s.supported?'disabled title="Agent unavailable"':'')+'>校验配置</button>'+
      '<button class="action primary" data-action="enter" '+(state.preflight!=='passed'||!s.supported?'disabled title="先完成预检"':'')+'>Enter Sandbox →</button>'+
      (state.entered?'<button class="action" data-action="switch-sandbox">切回已有 Sandbox Pane →</button>':'')+'</div>';
    return c;
  }
  function confirmation(){
    return '<div class="statusline"><span class="pill strong">Ready to Enter · explicit confirmation</span></div>'+
       '<div class="notice warning"><strong>确认进入隔离执行环境：</strong>将在当前 tmux Session 中新建 Sandbox Pane；Agent 必须在启动 shell 前验证请求的全部机制。原 Native Pane 保留。失败不会向原 Pane 发送命令，也不会声称已受保护。</div>'+
       '<section class="info-section"><h3>即将使用的 Policy 草稿</h3>'+policyDescription(state.draft)+'</section>'+
       '<div class="actionline"><button class="action" data-action="cancel-enter">返回修改</button><button class="action primary" data-action="confirm-enter">确认 Enter Sandbox</button></div>';
  }
  function detail(){
    if(!settings().inside)return '<div class="notice danger">当前 Pane 没有可验证的 SandboxExecution。</div>';
    return '<div class="notice warning">以下配置由当前 Pane 的 SandboxExecution 验证，并不约束 Native Pane 或共享 tmux server。</div>'+
      '<section class="info-section"><h3>生效策略 · 当前 Pane</h3>'+policyDescription(actualPolicy())+'</section>'+diagnostics()+
      '<div class="actionline"><button class="action" data-action="detail-back">← 返回 Sandbox 概览</button></div>';
  }
  function sandbox(){
    var s=settings(),detailMode=state.depth==='detail',confirmMode=state.depth==='confirm';
    var title=detailMode?'Execution details':confirmMode?'Confirm Enter':'Sandbox';
    var intro=detailMode?'当前 Pane 隔离执行的实际生效配置与证据。':confirmMode?'确认并进入新的 Sandbox Pane。':'感知当前 Pane；若已进入，查看生效配置；否则编辑并 Enter。';
    var first='<section class="workspace" data-testid="sandbox-view"><div class="workspace-inner">'+
      (state.mode==='web'?'<div class="crumb">Workspace / '+state.session+' / '+title+'</div>':'')+
      '<div class="titlebar"><div><h2>'+title+'</h2><p class="subline">'+intro+'</p></div></div>';
    var content=detailMode?detail():confirmMode?confirmation():s.inside?insideView():draftView();
    return first+content+'</div></section>';
  }
  function otherCapability(){
    var t=titles[state.cap]||"Workspace";
    return '<section class="workspace"><div class="workspace-inner"><div class="crumb">'+(state.mode==="web"?'Workspace / '+state.session+' / ':'')+t+'</div><h2>'+t+'</h2><p class="subline">此画面仅为 Workspace 能力切换上下文占位，不模拟 '+t+' 的全部功能。切回 Sandbox 可保留 Session/Location 上下文。</p><div class="actionline"><button class="action" data-action="cap:sandbox" '+(state.fixture==="unsupported"?'disabled title="Sandbox unavailable"':'')+'>返回 Sandbox</button></div></div></section>';
  }
  function workspace(){
    var current=(state.cap==="sandbox"?sandbox():otherCapability());
    if(state.mode==="app"){
      var title=state.depth==="detail"?"Execution details":state.depth==="confirm"?"Confirm Enter":titles[state.cap];
      return '<div class="app"><header class="app-header"><button type="button" class="arrow" data-action="'+(state.depth==="detail"?'detail-back':state.depth==="confirm"?'cancel-enter':'terminal')+'" aria-label="Back">←</button><span class="app-title">'+title+'</span><span style="width:40px"></span></header><main class="app-body">'+current+'</main>'+zone()+'</div>';
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
    if(output)output.textContent=JSON.stringify({mode:state.mode,surface:state.surface,capability:state.cap,depth:state.depth,fixture:state.fixture,session:state.session,current_pane:state.pane,inside_sandbox:settings().inside,preflight:state.preflight,draft:state.draft,execution_scope:"current managed Pane only; native and future Panes remain independent"},null,2);
    var target=mock.querySelector('.cap-item[aria-current="page"]');
    if(target&&typeof target.scrollIntoView==="function")target.scrollIntoView({inline:"nearest",block:"nearest"});
  }

  function setFixture(value){
    state.fixture=value;
    state.peek=false;
    state.depth="root";
    state.preflight="none";
    state.preflightError="";
    state.error="";
    state.draft=Object.assign({},defaultDraft);
    state.entered=false;
    state.pane=value==="active"?"sandbox":"native";
    state.effective=value==="active"?Object.assign({},defaultDraft):null;
    if(value==="macos"){state.draft.network="deny";state.draft.readOnly="";state.draft.write="";state.draft.pid=false;state.draft.ipc=false;state.draft.user=false;state.draft.mem="";state.draft.pids="";state.draft.seccomp=false;}
    document.querySelectorAll("[data-fixture]").forEach(function(button){button.setAttribute("aria-pressed",String(button.getAttribute("data-fixture")===value));});
    render();
  }
  mock.addEventListener("input",function(e){
    var t=e.target;
    if(!t||!t.hasAttribute||!t.hasAttribute("data-draft"))return;
    var field=t.getAttribute("data-draft");
    if(!Object.prototype.hasOwnProperty.call(state.draft,field))return;
    state.draft[field]=t.type==="checkbox"?!!t.checked:t.value;
    state.preflight="none";state.preflightError="";state.error="";
  });
  mock.addEventListener("change",function(e){
    var t=e.target;
    if(t&&t.hasAttribute&&t.hasAttribute("data-draft")){
      var field=t.getAttribute("data-draft");
      if(Object.prototype.hasOwnProperty.call(state.draft,field)){
        state.draft[field]=t.type==="checkbox"?!!t.checked:t.value;
        state.preflight="none";state.preflightError="";state.error="";
        render();
      }
    }
  });
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
    else if(action==="validate"){
      var err=preflight();state.preflight=err?"failed":"passed";state.preflightError=err;state.error="";
    }
    else if(action==="enter"){
      if(state.preflight==="passed"&&settings().supported)state.depth="confirm";
    }
    else if(action==="cancel-enter"){state.depth="root";}
    else if(action==="confirm-enter"){
      var validationError=preflight();
      if(state.preflight!=="passed"||validationError){state.preflight="failed";state.preflightError=validationError||"预检状态已过期";state.depth="root";}
      else if(settings().enterFail){state.error="Agent 启动屏障验证失败（模拟）。未切换 Pane";state.depth="root";}
      else{state.effective=Object.assign({},state.draft);state.entered=true;state.pane="sandbox";state.depth="root";state.preflight="none";state.error="";}
    }
    else if(action==="return-native"){state.pane="native";state.fixture="native";state.depth="root";state.preflight="none";state.error="";}
    else if(action==="switch-sandbox"){if(state.entered){state.pane="sandbox";state.depth="root";}}
    else if(action.indexOf("cap:")===0){state.cap=action.slice(4);state.depth="root";}
    else if(action.indexOf("session:")===0){
      var name=action.slice(8);state.session=name;state.surface="terminal";state.depth="root";state.peek=false;
      setFixture(name==="native-debug"?"native":"active");return;
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