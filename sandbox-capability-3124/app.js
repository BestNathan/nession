/* Sandbox Workspace prototype #3124. Deterministic, no network or backend mutations. */
(function(){
  "use strict";
  var root=document.querySelector("[data-np-root]");
  var device=document.querySelector("[data-np-device]");
  var mock=document.getElementById("sandbox-product");
  var output=document.getElementById("sandbox-inspector");
  if(!root||!device||!mock)return;
  var defaultDraft={workingDir:"/workspace/nession",readOnly:"/usr",write:"/workspace/nession",network:"restricted",egress:"github.com:443,api.anthropic.com:443",denyEgress:"",pid:true,ipc:true,user:true,uts:false,cgroup:false,resourceRows:[],syscallRows:[]};
  function cloneDraft(d){return Object.assign({},d,{
      resourceRows:(d.resourceRows||[]).map(function(r){return Object.assign({},r)}),
      syscallRows:(d.syscallRows||[]).map(function(r){return Object.assign({},r)}),
      pathItems:{readOnly:(d.pathItems?.readOnly||String(d.readOnly||"").split(",").filter(Boolean)).slice(),
        write:(d.pathItems?.write||String(d.write||"").split(",").filter(Boolean)).slice()},
      networkRules:{allow:(d.networkRules?.allow||String(d.egress||"").split(",").filter(Boolean)).slice(),
        deny:(d.networkRules?.deny||String(d.denyEgress||"").split(",").filter(Boolean)).slice()}
    });}
  var activeEffective=cloneDraft(Object.assign({},defaultDraft,{resourceRows:[{id:101,key:"memory.max",value:"2147483648"}],syscallRows:[{id:102,key:"seccomp.profile",value:"nession-interactive-v1"}]}));
  // Effective-only prepared filesystem readback fixture: safe mount targets,
  // not editable EROFS image sources, host paths or digests.
  var preparedEffective=cloneDraft(Object.assign({},activeEffective,{
    readOnly:"",write:"",
    preparedMounts:[
      {target:"/",source:"Base Runtime EROFS",mode:"ro"},
      {target:"/workspace",source:"Project source + writable workspace",mode:"mixed"},
      {target:"/opt/rust",source:"Rust toolchain EROFS",mode:"ro"}
    ]
  }));
  var state={mode:"web",surface:"terminal",cap:"sandbox",depth:"root",fixture:"native",session:"sandbox-review",peek:false,draft:cloneDraft(defaultDraft),nextRowId:1,openGroup:"filesystem",showPolicyJson:false,preflight:"none",preflightError:"",entered:false,pane:"native",effective:null,error:""};
  var titles={files:"Files",git:"Git",session:"Session",agent:"Agent",env:"Env",sandbox:"Sandbox"};
  var icons={files:"▤",git:"⑂",session:"▣",agent:"◉",env:"⌘",sandbox:"⬡"};
  var execution="sbx-70df40f4";
  var digest="sha256:9d8437a6e3c1…a26f";
  function settings(){
    var s=state.fixture;
    var offline=s==="offline",unsupported=s==="unsupported",stale=s==="recreated";
    var inside=!offline&&!unsupported&&!stale&&(s==="active"||s==="prepared"||state.entered&&state.pane==="sandbox");
    return {scenario:s,online:!offline,supported:!unsupported&&!offline&&!stale,verified:inside,inside:inside,native:!inside&&!offline&&!unsupported&&!stale,offline:offline,unsupported:unsupported,recreated:stale,macos:s==="macos",preflightFail:s==="preflight-fail",enterFail:s==="enter-fail"};
  }
  function escapeHtml(x){return String(x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
  function actualPolicy(){return state.effective||activeEffective;}
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

  // Synthetic Agent responses for the design prototype. Production must fetch this
  // typed catalog from the authenticated Agent, never from frontend literals.
  function agentFieldCatalog(){
    var s=settings(),scoped="mock-agent:nession-dev:"+state.fixture;
    if(!s.online||s.unsupported||s.recreated)
      return {status:"unknown",source:scoped,generation:"unavailable",resource:[],syscall:[],reason:"Agent/Session 观测不可用"};
    if(s.macos)
      return {status:"available",source:scoped,generation:"seatbelt-mock",resource:[],syscall:[],reason:"macOS 不提供 Linux cgroup v2/seccomp"};
    // Simulated *kernel child-cgroup directory scan*, not an application whitelist.
    // The real Agent must return the detected resource-controller files.
    var controllers=state.fixture==="limited"?["memory","pids"]:["cpu","memory","pids","io"];
    var childCgroupFiles=[
      {key:"memory.max",controller:"memory",format:"Linux native text",example:"2147483648"},
      {key:"memory.high",controller:"memory",format:"Linux native text",example:"1073741824"},
      {key:"memory.low",controller:"memory",format:"Linux native text",example:"1048576"},
      {key:"memory.oom.group",controller:"memory",format:"Linux native text",example:"1"},
      {key:"cpu.max",controller:"cpu",format:"Linux native text",example:"200000 100000"},
      {key:"cpu.weight",controller:"cpu",format:"Linux native text",example:"100"},
      {key:"pids.max",controller:"pids",format:"Linux native text",example:"256"},
      {key:"io.max",controller:"io",format:"Linux native text",example:"8:0 rbps=10485760"}
    ];
    return {status:"available",source:scoped,generation:"mock-cgroup2-scan-"+state.fixture,
      resource:childCgroupFiles.filter(function(file){return controllers.includes(file.controller)}),
      syscall:[{key:"seccomp.profile",format:"registered profile",example:"nession-interactive-v1",values:["nession-interactive-v1"]}],
      reason:"模拟 Agent 扫描受管子 cgroup: "+controllers.join(", ")};
  }
  function kvRows(kind,unavailable){
    var rows=state.draft[kind+"Rows"],resource=kind==="resource";
    var suggestionId=resource?"resource-key-suggestions":"syscall-key-suggestions";
    var catalog=agentFieldCatalog(),suggestions=resource?catalog.resource:catalog.syscall;
    var note=resource?"原生 cgroup v2 控制文件由 Agent 枚举；Value 原样传给 Linux 内核，不做字段级格式转换。":"Agent 注册的 seccomp profile，不提供任意 syscall/BPF 编辑。";
    var out='<div class="kv-editor" data-kv-editor="'+kind+'"><p class="hint2">'+note+'</p>'+'<p class="hint2"><strong>Agent 发现 · '+(catalog.status==="available"?"已探测":"无法查询")+'</strong> · '+suggestions.length+' 个候选 · '+escapeHtml(catalog.reason)+'</p>'+
      '<datalist id="'+suggestionId+'">'+suggestions.map(function(field){return '<option value="'+escapeHtml(field.key)+'" label="'+escapeHtml(field.format)+'"></option>';}).join('')+'</datalist>';
    if(!rows.length)out+='<p class="kv-empty">'+(resource?"未添加额外的 Resource 限制。":"未添加额外的 Syscall profile；后端基础防护仍生效。")+'</p>';
    rows.forEach(function(row){
      var label=resource?"cgroup v2":"seccomp";
      out+='<div class="kv-row" data-kv-row="'+kind+':'+row.id+'">'+
        '<div class="field"><label for="kv-'+kind+'-'+row.id+'-key">Key</label><input id="kv-'+kind+'-'+row.id+'-key" list="'+suggestionId+'" aria-label="'+label+' Key" data-kv-kind="'+kind+'" data-kv-id="'+row.id+'" data-kv-field="key" value="'+escapeHtml(row.key)+'" placeholder="'+(resource?"e.g. cpu.max":"seccomp.profile")+'"'+(unavailable?' disabled':'')+'></div>'+
        '<div class="field"><label for="kv-'+kind+'-'+row.id+'-value">Value</label><input id="kv-'+kind+'-'+row.id+'-value" aria-label="'+label+' Value" data-kv-kind="'+kind+'" data-kv-id="'+row.id+'" data-kv-field="value" value="'+escapeHtml(row.value)+'" placeholder="'+(resource?"native value":"nession-interactive-v1")+'"'+(unavailable?' disabled':'')+'></div>'+
        '<button type="button" class="action kv-remove" aria-label="Remove '+label+' entry" data-action="remove-kv:'+kind+':'+row.id+'"'+(unavailable?' disabled':'')+'>移除</button></div>';
    });
    out+='<div class="actionline"><button type="button" class="action" data-action="add-kv:'+kind+'"'+(unavailable?' disabled title="Backend does not support this dimension"':'')+'>＋ 添加条目</button></div></div>';
    return out;
  }
  function validateRows(rows,kind){
    var seen=new Set();
    var catalog=agentFieldCatalog(),fields=kind==="resource"?catalog.resource:catalog.syscall;
    var keys=fields.map(function(field){return field.key});
    for(var i=0;i<rows.length;i++){
      var key=rows[i].key.trim(),value=rows[i].value.trim();
      if(!key||!value)return (kind==="resource"?"Resource":"Syscall")+" 第 "+(i+1)+" 行的 Key 和 Value 都不能为空";
      if(!keys.includes(key))return "不支持的 "+(kind==="resource"?"cgroup v2":"Syscall")+" Key: "+key;
      if(seen.has(key))return "重复的 "+(kind==="resource"?"Resource":"Syscall")+" Key: "+key;
      seen.add(key);
      if(kind==="syscall"){
        var profile=fields.find(function(field){return field.key===key});
        if(key!=="seccomp.profile"||!profile||!profile.values.includes(value))return "seccomp.profile 只支持 Agent 注册的 nession-interactive-v1";
        continue;
      }
      // No app-specific parsing of native Resource values. Linux performs the
      // authoritative validation when writing inside the new owned cgroup.
      if(kind==="resource"&&(!/^[a-zA-Z0-9_.-]+$/.test(key)||key.startsWith("cgroup.")||key.includes("..")))
        return "Resource Key 必须是受管 cgroup 下的单个 controller 控制文件";

    }
    return "";
  }
  function policyProjection(d){
    var policy={version:1,enabled:true,enforcement:"required"};
    var reads=(d.readOnly||"").split(",").map(function(x){return x.trim()}).filter(Boolean);
    var writes=(d.write||"").split(",").map(function(x){return x.trim()}).filter(Boolean);
    // Optional groups absent in the draft are *omitted*, never silently
    // converted into claims about an installed OS-level restriction.
    if(reads.length||writes.length)policy.filesystem={access:{read:reads,write:writes}};
    if(d.network){
      policy.network={mode:d.network,ingress:"deny"};
      if(d.network==="restricted")policy.network.egress={
        allow:(d.egress||"").split(",").map(function(x){return x.trim()}).filter(Boolean),
        deny:[],private_network:"deny"};
    }
    var namespaces={};
    ["pid","ipc","user"].forEach(function(k){if(d[k])namespaces[k]=true});
    if(Object.keys(namespaces).length)policy.process={linux_namespaces:namespaces};
    if(d.resourceRows&&d.resourceRows.length)policy.resource={cgroup_v2:Object.fromEntries(d.resourceRows.map(function(x){return [x.key.trim(),x.value] }))};
    if(d.syscallRows&&d.syscallRows.length)policy.syscall={seccomp:{profile:d.syscallRows[0].value.trim()}};
    return policy;
  }
  function toggler(id,label,checked,disabled){
    return '<label><input type="checkbox" data-draft="'+id+'" '+(checked?'checked':'')+' '+(disabled?'disabled':'')+'>'+label+'</label>';
  }

  var compositionClusters=[
    {label:"执行环境",subtitle:"进程看到的文件与工作目录",groups:["filesystem"]},
    {label:"隔离边界",subtitle:"网络可达性与命名空间",groups:["network","process"]},
    {label:"执行约束",subtitle:"原生控制文件与安全过滤",groups:["resource","syscall"]}
  ];
  var dimensionNames={filesystem:"Filesystem",network:"Network",process:"Process",resource:"Resource",syscall:"Syscall"};
  function compositionState(d,id,observed){
    var s=settings(),unavailable=s.macos&&(id==="resource"||id==="syscall"||id==="process");
    var entries=[],active=false,description="";
    if(id==="filesystem"&&d.preparedMounts&&observed){
      active=true;
      description="Agent 预制 EROFS root · "+d.preparedMounts.length+" 个挂载目标（只读执行输入）";
    }else if(id==="filesystem"){
      var reads=(d.readOnly||"").split(",").filter(function(x){return !!x.trim()});
      var writes=(d.write||"").split(",").filter(function(x){return !!x.trim()});
      active=reads.length+writes.length>0;
      description=active?reads.length+" 只读路径 · "+writes.length+" 可写路径":"无额外路径白名单；仅后端基础挂载";
      if(s.macos)description="该 backend 的路径隔离能力需按 Agent 实测";
    }else if(id==="network"){
      active=true;
      description=(d.network||"allow")+" · "+(d.network==="restricted"?(d.egress||"").split(",").filter(Boolean).length+" 个允许目标":"无自定义 egress 列表");
    }else if(id==="process"){
      entries=["pid","ipc","user"].filter(function(k){return !!d[k]});
      active=entries.length>0;
      description=active?"Namespaces: "+entries.map(function(x){return x.toUpperCase()}).join(" / "):"没有额外申请 Linux namespace";
    }else{
      entries=d[id+"Rows"]||[];active=entries.length>0;
      description=active?entries.length+" 条 · "+entries.map(function(x){return x.key||"未填写 Key"}).slice(0,2).join("、")+(entries.length>2?" 等":""):"未添加额外控制";
    }
    var kind=unavailable?"unavailable":observed?(active?"observed":"not-requested"):(active?"requested":"not-requested");
    return {key:id,name:dimensionNames[id],kind:kind,summary:description,count:entries.length};
  }

  var moduleCopy={
    filesystem:"可见路径、读写权限和预制根文件系统",
    network:"网络模式及出站目标规则",
    process:"PID / IPC / USER / UTS / CGROUP 命名空间",
    resource:"Agent 发现的原生 cgroup v2 文件和写入值",
    syscall:"Agent 注册的 seccomp Profile"
  };
  function compositionOverview(d,observed){
    var labels=["filesystem","network","process","resource","syscall"];
    return '<section class="config-index" data-testid="sandbox-config-index" aria-label="Sandbox configuration destinations">'+
      '<div class="composition-header"><div><h3>配置与检查</h3><p class="subline">'+(observed?
      '逐项查看当前执行的实际生效配置；不能直接修改正在运行的隔离环境。':
      '每类配置都有自己的管理页面。修改会保存在同一份 Sandbox Policy 草稿中。')+
      '</p></div><span class="pill">'+(observed?'Inside · observed':'Outside · draft')+'</span></div>'+
      '<nav class="config-destinations" aria-label="Sandbox configuration sections">'+
      labels.map(function(id){
        var p=compositionState(d,id,observed),
          status=({unavailable:"不可用",observed:"已观测",requested:"已配置","not-requested":"未配置"})[p.kind];
        return '<button type="button" class="config-destination" data-action="open-module:'+id+'" data-testid="sandbox-nav-'+id+'" aria-label="Open '+dimensionNames[id]+'">'+
          '<span class="config-destination-copy"><strong>'+dimensionNames[id]+'</strong>'+
          '<span>'+moduleCopy[id]+'</span><small>'+escapeHtml(p.summary)+'</small></span>'+
          '<span class="config-destination-state '+p.kind+'">'+status+'</span>'+
          '<span class="config-destination-chevron" aria-hidden="true">›</span></button>';
      }).join('')+'</nav></section>';
  }
  function policyJson(d,title,always){
    var view=always||state.showPolicyJson;
    return '<section class="policy-json-section">'+
      (always?'<div class="policy-json-heading"><h3>'+title+'</h3><span class="subtxt">只读 · 合成协议视图</span></div>':
        '<button type="button" class="action policy-json-trigger" data-action="toggle-policy-json" aria-expanded="'+state.showPolicyJson+'">'+(view?"收起组合 Policy JSON":"查看组合 Policy JSON")+'</button>')+
      (view?(d.preparedMounts?'<div data-testid="sandbox-prepared-policy-notice" class="notice warning">Agent-prepared EROFS 的底层镜像 source/digest 不由这个客户端草稿编辑器暴露。此处只展示 Agent 返回的安全挂载目标，不伪造完整原生执行 JSON。</div>':
        '<pre data-testid="sandbox-composed-json" class="policy-json" aria-label="'+title+'">'+escapeHtml(JSON.stringify(policyProjection(d),null,2))+'</pre>'):'')+
      '</section>';
  }

  function listEditor(field,kind){
    var isPath=kind==="path",items=isPath?state.draft.pathItems[field]:state.draft.networkRules[field];
    var title=isPath?(field==="readOnly"?"Read-only paths":"Writable paths"):(field==="allow"?"Allowed destinations":"Denied destinations");
    var shortName=isPath?"路径":"目标";
    var disabled=isPath&&settings().macos;
    return '<section class="module-list" data-list-kind="'+kind+'" data-list-name="'+field+'">'+
      '<div class="module-list-head"><div><h4>'+title+'</h4><p class="subline">'+items.length+' 项 · 单独增删和编辑</p></div>'+
      '<button class="action" data-action="add-'+kind+':'+field+'"'+(disabled?' disabled':'')+'>＋ 添加'+shortName+'</button></div>'+
      (items.length?'<div class="module-items">'+items.map(function(value,index){
        return '<div class="module-item"><label for="module-'+kind+'-'+field+'-'+index+'">'+shortName+' '+(index+1)+'</label>'+
          '<div class="module-item-edit"><input id="module-'+kind+'-'+field+'-'+index+'" data-collection="'+kind+'" data-list-name="'+field+'" data-list-index="'+index+'" value="'+escapeHtml(value)+'" aria-label="'+title+' '+(index+1)+'" placeholder="'+(isPath?"/absolute/path":"example.com:443")+'"'+(disabled?' disabled':'')+'>'+
          '<button class="action" data-action="remove-'+kind+':'+field+':'+index+'" aria-label="Remove '+title+' '+(index+1)+'"'+(disabled?' disabled':'')+'>移除</button></div></div>';
      }).join('')+'</div>':'<p class="module-empty">尚未添加'+title+'；不会生成额外规则。</p>')+
      '</section>';
  }
  function filesystemEditor(){
    return '<section class="module-domain"><p class="subline">路径授权由当前 Sandbox 的 mount view 执行；Agent-prepared EROFS Root 是另一种互斥的文件系统输入，不在此编辑内核镜像文件。</p>'+
      '<div class="module-start-dir">'+configInput("workingDir","Shell working directory",state.draft.workingDir,"input","full")+'</div>'+
      listEditor("readOnly","path")+listEditor("write","path")+
      '<div class="module-hint">只有指定路径在 Sandbox 中可见；所有路径及权限最终由 Agent 校验。</div></section>';
  }
  function networkEditor(){
    var d=state.draft;
    return '<section class="module-domain"><div class="module-mode"><h4>网络模式</h4><p class="subline">选择模式后单独管理目标规则；不是一个自由格式的 KV。</p>'+
      configInput("network","Mode",d.network,"select")+'</div>'+
      (d.network==="restricted"?listEditor("allow","network")+listEditor("deny","network"):
        '<div class="module-hint">当前模式 '+escapeHtml(d.network)+' 不使用自定义 egress 列表。已有草稿保留，切回 restricted 可继续编辑。</div>')+
      '<p class="module-hint">V1 ingress: deny；restricted 的目标由后端代理执行，Agent 验证最终配置。</p></section>';
  }
  function processEditor(){
    var d=state.draft,m=settings().macos;
    var desc={pid:"隔离 PID 可见范围",ipc:"隔离 IPC 对象",user:"独立用户命名空间",uts:"独立 UTS 主机名空间",cgroup:"隔离 cgroup 命名空间；需要 USER"};
    return '<section class="module-domain"><p class="subline">这些是原生 Linux Namespace 能力，不是 Resource 文件，也不是可自由填写的 Key。</p>'+
      '<div class="namespace-items">'+["pid","ipc","user","uts","cgroup"].map(function(key){
        return '<label class="namespace-item"><span><strong>'+key.toUpperCase()+'</strong><small>'+desc[key]+'</small></span>'+
          '<input type="checkbox" data-draft="'+key+'"'+(d[key]?' checked':'')+(m?' disabled':'')+' aria-label="'+key.toUpperCase()+' namespace"></label>';
      }).join('')+'</div>'+
      (m?'<p class="module-hint">macOS Seatbelt 不提供这些 Linux Namespace 开关。</p>':'')+
      '<p class="module-hint">真实是否安装由 Agent 的执行验证报告决定；仅勾选不代表当前 Pane 已隔离。</p></section>';
  }
  function resourceEditor(){
    var catalog=agentFieldCatalog(),groups={};
    catalog.resource.forEach(function(item){if(!groups[item.controller])groups[item.controller]=[];groups[item.controller].push(item)});
    var selectors=Object.keys(groups).map(function(controller){
      return '<div class="resource-controller"><strong>'+escapeHtml(controller)+'</strong>'+
        '<div class="resource-available">'+groups[controller].map(function(item){
          var selected=state.draft.resourceRows.some(function(row){return row.key===item.key});
          return '<button type="button" class="resource-available-file" data-action="resource-add:'+escapeHtml(item.key)+'"'+(selected?' disabled':'')+'>'+escapeHtml(item.key)+(selected?' · 已配置':' ＋')+'</button>';
        }).join('')+'</div></div>';
    }).join('');
    return '<section class="module-domain" data-resource-manager><h4>Agent 发现的可配置文件</h4><p class="subline">从当前受管子 cgroup 的 controller 文件中发现；值不由 Nession 解析或换算。单击文件加入下方配置列表。</p>'+
      (selectors||'<p class="module-empty">此 Agent 暂无可用的原生 Resource 文件。</p>')+
      '<div class="module-list"><div class="module-list-head"><h4>待写入的 Resource 配置</h4><span class="subtxt">'+state.draft.resourceRows.length+' 条原生 KV</span></div>'+
      kvRows("resource",settings().macos)+'</div></section>';
  }
  function syscallEditor(){
    var values=agentFieldCatalog().syscall.find(function(x){return x.key==="seccomp.profile"});
    var picked=state.draft.syscallRows[0]?.value||"";
    return '<section class="module-domain" data-syscall-profiles><h4>Seccomp Profile</h4>'+
      '<p class="subline">通过 Agent 注册的 profile 选择完整过滤规则；与 cgroup v2 文件无关，不能填写任意 syscall 或 BPF。</p>'+
      (values?'<div class="profile-choice"><label for="sandbox-profile">当前选择</label><select id="sandbox-profile" data-sandbox-profile>'+
        '<option value="">不添加额外 Profile</option>'+
        values.values.map(function(v){return '<option value="'+escapeHtml(v)+'"'+(picked===v?' selected':'')+'>'+escapeHtml(v)+'</option>'}).join('')+
        '</select><p class="module-hint">选择只修改待执行的 Policy 草稿。Agent 会在执行时验证该 profile 是否实际安装。</p></div>':
        '<div class="module-empty">当前 Agent 未报告可用的 seccomp profile；无法选择。</div>')+
      (picked?'<div class="module-detail-note"><strong>已选 Profile</strong><code>'+escapeHtml(picked)+'</code><p>内核/Bubblewrap 的 seccomp 加载必须通过执行验证；本页不允许上传自定义过滤程序。</p></div>':'')+
      '</section>';
  }
  function editor(){
    var id=state.openGroup;
    return '<section class="module-editor" data-testid="sandbox-policy-editor" aria-label="'+dimensionNames[id]+' management">'+
      ({filesystem:filesystemEditor,network:networkEditor,process:processEditor,resource:resourceEditor,syscall:syscallEditor}[id])()+
      '</section>';
  }
  function policyDescription(d){
    return '<div class="dimlist">'+
      '<div class="dimension"><div class="dimlabel">Filesystem</div><div class="dimval">'+(d.preparedMounts?
        d.preparedMounts.map(function(m){return '<div class="mono">'+escapeHtml(m.target)+' · '+escapeHtml(m.source)+' · '+escapeHtml(m.mode)+'</div>';}).join(''):
        escapeHtml(d.readOnly||'no explicit read')+' · read-only<span class="dimmer">'+escapeHtml(d.write||'none')+' · writable</span>')+'</div></div>'+
      '<div class="dimension"><div class="dimlabel">Network</div><div class="dimval">'+escapeHtml(d.network)+'<span class="dimmer">'+(d.network==='restricted'?'Allowed: '+escapeHtml(d.egress):'Ingress denied by V1 policy')+'</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Process</div><div class="dimval">'+(['pid','ipc','user'].filter(function(k){return d[k]}).join(' / ')||'no explicitly requested Linux namespaces')+'<span class="dimmer">当前执行上下文的实际机制，不是整个 Session</span></div></div>'+
      '<div class="dimension"><div class="dimlabel">Resource</div><div class="dimval">'+(d.resourceRows.length?d.resourceRows.map(function(row){return '<div class="mono">'+escapeHtml(row.key)+' = '+escapeHtml(row.value)+'</div>'}).join(''):'未请求额外 cgroup v2 限制')+'</div></div>'+
      '<div class="dimension"><div class="dimlabel">Syscall</div><div class="dimval">'+(d.syscallRows.length?d.syscallRows.map(function(row){return '<div class="mono">'+escapeHtml(row.key)+' = '+escapeHtml(row.value)+'</div>'}).join(''):'未请求额外 seccomp profile；后端基础安全机制仍生效')+'</div></div></div>';
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
       '<section class="info-section">'+compositionOverview(actualPolicy(),true,false)+
       '<div class="effective-dimension-details"><h3>生效值明细</h3>'+policyDescription(actualPolicy())+'</div>'+
       policyJson(actualPolicy(),"Effective Policy JSON",false)+'</section>'+
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
      if(d.resourceRows.length||d.syscallRows.length)return 'macOS 不支持 Linux cgroup v2 或 seccomp 条目';
    }else{
      var paths=(d.readOnly+','+d.write).split(',').filter(Boolean);
      if(paths.some(function(p){return !p.trim().startsWith('/')||p.includes('..')}))return 'Filesystem 路径必须是绝对、规范化路径';
      var resourceError=validateRows(d.resourceRows,'resource');if(resourceError)return resourceError;
      var syscallError=validateRows(d.syscallRows,'syscall');if(syscallError)return syscallError;
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
      compositionOverview(state.draft,false,true)+
      editor()+
      policyJson(state.draft,"Composed Policy JSON",false)+'</div>';
    if(state.preflight==='passed')c+='<div data-preflight-status class="notice success validated"><strong>预检通过</strong> · Policy 语法与当前 Agent 能力匹配（仅模拟）。进入时还需重新校验实际主机并验证执行机制。</div>';
    if(state.preflight==='failed')c+='<div data-preflight-status class="notice danger validated" role="alert"><strong>预检未通过</strong> · '+escapeHtml(state.preflightError)+'</div>';
    if(state.error)c+='<div class="notice danger validated" role="alert"><strong>Enter 失败</strong> · '+escapeHtml(state.error)+'。仍位于原 Native Pane，草稿已保留。</div>';
    c+='<div class="actionline"><button class="action" data-action="validate" '+(!s.supported?'disabled title="Agent unavailable"':'')+'>校验配置</button>'+
      '<button class="action primary" data-action="enter" '+(state.preflight!=='passed'||!s.supported?'disabled title="先完成预检"':'')+'>Enter Sandbox →</button>'+
      (state.entered?'<button class="action" data-action="switch-sandbox">切回已有 Sandbox Pane →</button>':'')+'</div>';
    return c;
  }
  function confirmation(){
    return '<div class="statusline"><span class="pill strong">Ready to Enter · explicit confirmation</span></div>'+
       '<div class="notice warning"><strong>确认进入隔离执行环境：</strong>将在当前 tmux Session 中新建 Sandbox Pane；Agent 必须在启动 shell 前验证请求的全部机制。原 Native Pane 保留。失败不会向原 Pane 发送命令，也不会声称已受保护。</div>'+
       '<section class="info-section">'+compositionOverview(state.draft,false,false)+
       policyJson(state.draft,"确认提交 · 完整 Policy JSON",true)+
       '<p class="subline">Target: nession-dev · Native Pane %1 → 新隔离 Pane · policy revision v1 · Mock Agent generation '+escapeHtml(agentFieldCatalog().generation)+'</p></section>'+
       '<div class="actionline"><button class="action" data-action="cancel-enter">返回修改</button><button class="action primary" data-action="confirm-enter">确认 Enter Sandbox</button></div>';
  }
  function detail(){
    if(!settings().inside)return '<div class="notice danger">当前 Pane 没有可验证的 SandboxExecution。</div>';
    return '<div class="notice warning">以下配置由当前 Pane 的 SandboxExecution 验证，并不约束 Native Pane 或共享 tmux server。</div>'+
      '<section class="info-section">'+compositionOverview(actualPolicy(),true,false)+
      '<div class="effective-dimension-details"><h3>生效策略明细 · 当前 Pane</h3>'+policyDescription(actualPolicy())+'</div>'+
      policyJson(actualPolicy(),"Effective Policy JSON",false)+'</section>'+diagnostics()+
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
    if(output)output.textContent=JSON.stringify({mode:state.mode,surface:state.surface,capability:state.cap,depth:state.depth,fixture:state.fixture,session:state.session,current_pane:state.pane,inside_sandbox:settings().inside,preflight:state.preflight,draft:state.draft,policy:policyProjection(state.draft),catalog:agentFieldCatalog(),selected_policy_group:state.openGroup,show_policy_json:state.showPolicyJson,composition:compositionClusters.map(function(cluster){return {cluster:cluster.label,dimensions:cluster.groups.map(function(key){return compositionState(settings().inside?actualPolicy():state.draft,key,settings().inside)})}}),execution_scope:"current managed Pane only; native and future Panes remain independent"},null,2);
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
    state.draft=cloneDraft(defaultDraft);state.nextRowId=1;state.openGroup="filesystem";state.showPolicyJson=false;
    state.entered=false;
    state.pane=(value==="active"||value==="prepared")?"sandbox":"native";
    state.effective=value==="prepared"?cloneDraft(preparedEffective):value==="active"?cloneDraft(activeEffective):null;
    if(value==="macos"){state.draft.network="deny";state.draft.readOnly="";state.draft.write="";state.draft.pid=false;state.draft.ipc=false;state.draft.user=false;state.draft.resourceRows=[];state.draft.syscallRows=[];}
    document.querySelectorAll("[data-fixture]").forEach(function(button){button.setAttribute("aria-pressed",String(button.getAttribute("data-fixture")===value));});
    render();
  }
  mock.addEventListener("input",function(e){
    var t=e.target;
    if(!t||!t.hasAttribute||!(t.hasAttribute("data-draft")||t.hasAttribute("data-kv-kind")))return;
    var kind=t.getAttribute("data-kv-kind");
    if(kind==="resource"||kind==="syscall"){
      var entry=state.draft[kind+"Rows"].find(function(row){return String(row.id)===t.getAttribute("data-kv-id")});
      var prop=t.getAttribute("data-kv-field");
      if(!entry||(prop!=="key"&&prop!=="value"))return;
      entry[prop]=t.value;
    }else{
      var field=t.getAttribute("data-draft");
      if(!Object.prototype.hasOwnProperty.call(state.draft,field))return;
      state.draft[field]=t.type==="checkbox"?!!t.checked:t.value;
    }
    state.preflight="none";state.preflightError="";state.error="";
    var proof=mock.querySelector('[data-preflight-status]');if(proof)proof.hidden=true;
    var enter=mock.querySelector('[data-action="enter"]');if(enter)enter.disabled=true;
  });
  mock.addEventListener("change",function(e){
    var t=e.target;
    if(t&&t.hasAttribute&&(t.hasAttribute("data-draft")||t.hasAttribute("data-kv-kind"))){
      var kind=t.getAttribute("data-kv-kind");
      if(kind==="resource"||kind==="syscall"){
        var row=state.draft[kind+"Rows"].find(function(r){return String(r.id)===t.getAttribute("data-kv-id")});
        var prop=t.getAttribute("data-kv-field");
        if(row&&(prop==="key"||prop==="value"))row[prop]=t.value;
      }else{
        var field=t.getAttribute("data-draft");
        if(Object.prototype.hasOwnProperty.call(state.draft,field))state.draft[field]=t.type==="checkbox"?!!t.checked:t.value;
      }
      state.preflight="none";state.preflightError="";state.error="";
      render();
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
    else if(action.indexOf("select-policy:")===0){
      var group=action.slice("select-policy:".length);
      if(Object.prototype.hasOwnProperty.call(dimensionNames,group))state.openGroup=group;
    }
    else if(action==="toggle-policy-json"){state.showPolicyJson=!state.showPolicyJson;}
    else if(action.indexOf("add-kv:")===0){
      var kind=action.slice(7);
      if((kind==="resource"||kind==="syscall")&&!settings().macos){
        state.draft[kind+"Rows"].push({id:state.nextRowId++,key:"",value:""});state.openGroup=kind;
        state.preflight="none";state.preflightError="";state.error="";
      }
    }
    else if(action.indexOf("remove-kv:")===0){
      var args=action.split(":");var kind=args[1];
      if((kind==="resource"||kind==="syscall")&&!settings().macos){
        state.draft[kind+"Rows"]=state.draft[kind+"Rows"].filter(function(row){return String(row.id)!==args[2]});
        state.preflight="none";state.preflightError="";state.error="";
      }
    }
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
      else if(state.fixture==="kernel-reject"&&state.draft.resourceRows.length){
        state.error="Linux kernel write cpu.weight: EINVAL (Invalid argument)（模拟）。受管子 cgroup 已回滚，原 Native Pane 未修改";
        state.depth="root";
      }
      else{state.effective=cloneDraft(state.draft);state.entered=true;state.pane="sandbox";state.depth="root";state.preflight="none";state.error="";}
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