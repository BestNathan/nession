/* Nession Claude Code Memory — standalone prototype #2689.
 * All fixtures are public-safe synthetic examples. No network or filesystem calls.
 */
(function () {
  "use strict";

  const SESSIONS = [
    { id:"dev", name:"dev-session", hint:"MacBook Pro · nession · feat/memory", agent:"macbook-pro", cwd:"/workspace/nession", root:"/workspace/nession", repo:"BestNathan/nession", memoryKey:"nession", kind:"ready", shell:"claude", branch:"feat/memory" },
    { id:"review", name:"review-worktree", hint:"macOS · nession worktree · review", agent:"macbook-pro", cwd:"/workspace/nession/.claude/worktrees/review", root:"/workspace/nession", repo:"BestNathan/nession", memoryKey:"nession", kind:"ready", shell:"claude", branch:"review/memory" },
    { id:"vol", name:"vol-agent", hint:"Beijing Server · different repo", agent:"beijing-01", cwd:"/srv/vol/crates/runtime", root:"/srv/vol", repo:"BestNathan/vol", memoryKey:"vol", kind:"ready", shell:"claude", branch:"main" },
    { id:"clean", name:"clean-repo", hint:"Agent · valid repo · no memory", agent:"macbook-pro", cwd:"/workspace/new-service", root:"/workspace/new-service", repo:"demo/new-service", memoryKey:"clean", kind:"empty", shell:"zsh", branch:"main" },
    { id:"offline", name:"offline-shell", hint:"Agent unreachable · CWD unknown", agent:"remote-dev", cwd:null, root:null, repo:null, memoryKey:null, kind:"unavailable", shell:"zsh", branch:"—" },
    { id:"restricted", name:"restricted", hint:"Resolved repo · read denied", agent:"beijing-01", cwd:"/srv/restricted", root:"/srv/restricted", repo:"demo/restricted", memoryKey:"restricted", kind:"denied", shell:"zsh", branch:"main" },
    { id:"scratch", name:"scratch", hint:"No Git repo · fallback empty", agent:"macbook-pro", cwd:"/home/demo/scratch", root:null, repo:null, memoryKey:"scratch", kind:"non_git_empty", shell:"zsh", branch:"—" }
  ];

  const MEMORY = {
    nession: [
      {id:"MEMORY.md",title:"项目记忆",desc:"索引 · 3 个主题文件",subtitle:"Claude Code Auto Memory / index",lead:"此索引记录与当前仓库相关、可在不同 Session 之间复用的长期上下文。主题文件只会在需要时读取。",index:true,sections:[
        {title:"当前项目",items:["Nession 是跨设备持续工作的 Session-first 工作区。","Terminal 是实时工作表面；Capability 只在当前上下文相关时浮现。"]},
        {title:"记忆索引",items:[]}
      ]},
      {id:"architecture.md",title:"架构边界",desc:"Session · Agent · tmux",subtitle:"Memory / project",lead:"记录无法直接从源代码推导的架构约束，避免在多个会话中反复讨论。",sections:[
        {title:"Session 是工作入口",items:["当前 Session 决定相关的 Repository、终端和工作上下文。","多个 Session 可以属于同一个 Repository；不为每个 Session 复制项目 Memory。"]},
        {title:"边界约定",items:["tmux 只管理交互会话，不负责业务记忆或仓库选择。","Provider 负责发现自己的文件布局，Nession 负责呈现当前工作的相关能力。"]}
      ]},
      {id:"interaction.md",title:"交互偏好",desc:"少干扰 · 渐进浮现",subtitle:"Memory / feedback",lead:"记录用户明确确认过的交互原则。",sections:[
        {title:"工作优先",items:["默认保持终端安静，不把全部工具常驻在侧边栏。","用户从当前 Session 打开 Claude Code 时直接获得当前上下文，不能要求重新选择 Repo。"]},
        {title:"细节呈现",items:["Memory 内容只读；需要时可展开查看来源，不展示一整屏文件系统路径。","手机端列表进入详情，避免把两栏压缩成难以阅读的窄列。"]}
      ]},
      {id:"verification.md",title:"验证约定",desc:"CI · Acceptance",subtitle:"Memory / project",lead:"仅作为原型测试用的示例记忆，并非仓库当前真实策略的权威来源。",sections:[
        {title:"边界",items:["验证应对准实际修改的行为，不在普通 PR 上重复整套全量测试。","原型验证不能替代 Production Acceptance 或 GitHub Actions 证据。"]}
      ]}
    ],
    vol: [
      {id:"MEMORY.md",title:"Vol · 项目记忆",desc:"索引 · 2 个主题文件",subtitle:"Claude Code Auto Memory / index",lead:"当前 Session 属于另一个 Repository，展示独立的 Memory 索引，而不是 Nession 记忆。",index:true,sections:[{title:"当前项目",items:["Vol 是 Agent Runtime / Harness 的实验性工程项目。","Tool Registry 与 Session/Task 都有独立的边界。"]},{title:"记忆索引",items:[]}]},
      {id:"tools.md",title:"工具调用模型",desc:"Tool registry · defer",subtitle:"Memory / project",lead:"面向 Runtime 的工具调用约束。",sections:[{title:"Tool Registry",items:["工具注册、协议描述与执行结果应保持分层。","延迟加载工具定义时，优先保障可追踪和可恢复的调用边界。"]}]},
      {id:"sessions.md",title:"任务与会话",desc:"Session · Task",subtitle:"Memory / project",lead:"说明任务运行与长期会话的关系。",sections:[{title:"生命周期",items:["Session 保存持续执行的上下文。","Task 表示具有明确目标与运行阶段的一次工作。"]}]}
    ]
  };

  const $ = (id) => document.getElementById(id);
  const app = $("app"), surface = $("surface"), menu = $("session-menu");
  const state = {
    sessionId:"dev", tab:"memory", surface:"workspace", phase:"ready",
    file:"MEMORY.md", docLoading:false, mobileDetail:false, source:false,
    menu:false, generation:0, readGeneration:0, event:""
  };
  function session() { return SESSIONS.find((item) => item.id === state.sessionId); }
  function docs() { return MEMORY[session().memoryKey] || []; }
  function esc(value) {
    return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch];
    });
  }
  function currentDocument() { return docs().find((d) => d.id === state.file) || docs()[0]; }
  function readyKind(kind) { return kind === "ready" || kind === "empty" || kind === "denied" || kind === "non_git_empty" || kind === "unavailable"; }
  function setSurface(view) {
    state.surface=view;
    app.classList.toggle("show-workspace",view==="workspace");
    renderWorkspace();
  }
  function renderSessionMenu() {
    $("session-label").textContent=session().name;
    $("session-toggle").setAttribute("aria-expanded",String(state.menu));
    menu.hidden=!state.menu;
    if (!state.menu) return;
    menu.innerHTML='<div class="menu-caption">切换当前 Session · 模拟数据</div>'+
      SESSIONS.map(function (s) {
        return '<button type="button" class="session-option '+(s.id===state.sessionId?"active":"")+'" data-session="'+esc(s.id)+'" aria-current="'+(s.id===state.sessionId?"true":"false")+'">'+
        '<span class="select-bullet">'+(s.id===state.sessionId?"✓":"")+'</span><span class="option-copy"><span class="option-name">'+esc(s.name)+'</span><span class="option-sub">'+esc(s.hint)+'</span></span></button>';
      }).join("")+'<div class="menu-note">原型场景切换仅改变当前 Session。Repository 不可手动选择。</div>';
  }
  function terminalText(s) {
    let lines=[];
    if(s.kind==="unavailable") {
      lines=[["term-comment","# Simulated terminal snapshot"],["term-output","Agent temporarily unreachable"],["term-output","Last known Session: "+s.name],["term-comment","# CWD cannot be resolved at this time"]];
    } else {
      lines=[["term-path","~ "+(s.cwd||"")],["term-cmd","$ git branch --show-current"],["term-output",s.branch],["term-cmd","$ "+(s.shell==="claude"?"claude":"pwd")]];
      if(s.shell==="claude"){
        lines.push(["term-output","╭────────────────────────────╮"]);
        lines.push(["term-output","│        Claude Code         │"]);
        lines.push(["term-output","╰────────────────────────────╯"]);
        lines.push(["term-comment","# Continuing work in current Session"]);
      } else {
        lines.push(["term-output",s.cwd||""]);
      }
      lines.push(["term-cmd","$ "]);
    }
    return lines.map((pair,idx)=>'<span class="'+pair[0]+'">'+esc(pair[1])+'</span>'+(idx===lines.length-1&&s.kind!=="unavailable"?"<span class='term-current'></span>":"")+"<br>").join("");
  }
  function renderTerminal() {
    const s=session();
    $("terminal-content").innerHTML=terminalText(s);
    $("terminal-state").textContent=s.kind==="unavailable"?"Agent unreachable":"Session attached";
  }
  function setSession(id) {
    const next=SESSIONS.find((s)=>s.id===id);
    if(!next || id===state.sessionId){state.menu=false;renderSessionMenu();return;}
    const previous=session();
    const share=previous.kind==="ready"&&next.kind==="ready"&&previous.memoryKey===next.memoryKey;
    state.sessionId=id;
    state.menu=false;state.source=false;state.mobileDetail=false;
    state.generation++;state.readGeneration++;state.docLoading=false;
    if(!share || !MEMORY[next.memoryKey] || !MEMORY[next.memoryKey].some((d)=>d.id===state.file))state.file="MEMORY.md";
    state.phase="loading";
    state.event=share?"same_repository":"session_changed";
    render();
    const generation=state.generation;
    setTimeout(function () {
      if(generation!==state.generation)return;
      state.phase=readyKind(next.kind)?next.kind:"unavailable";
      renderWorkspace();
    },460);
  }
  function selectFile(id) {
    if(state.phase!=="ready"||!docs().some((f)=>f.id===id))return;
    state.file=id;state.docLoading=true;state.mobileDetail=true;state.readGeneration++;
    const generation=state.generation,readGeneration=state.readGeneration;
    renderWorkspace();
    setTimeout(function () {
      if(generation!==state.generation || readGeneration!==state.readGeneration)return;
      state.docLoading=false;
      renderWorkspace();
    },230);
  }
  function memoryHeading(s) {
    let repoText=s.repo ? s.repo : s.kind==="non_git_empty"?"非 Git 工作目录":"身份不可用";
    let status=s.kind==="unavailable"?"unknown":"derived";
    return '<div class="memory-heading">'+
      '<div><div class="overline">CLAUDE CODE / CURRENT SESSION</div>'+
      '<div class="memory-title-line"><h1>Memory</h1><span class="repo-context '+(status==="unknown"?"unknown":"")+'"><strong>'+esc(repoText)+'</strong> · 自动关联</span></div>'+
      '<p>来自当前 Session 的项目上下文。索引自动关联，主题文件按需查看。</p></div>'+
      '<button type="button" class="source-toggle" data-action="source" aria-expanded="'+state.source+'">来源 <span aria-hidden="true">'+(state.source?"⌃":"⌄")+'</span></button></div>';
  }
  function sourceDrawer(s) {
    if(!state.source)return "";
    const entries=[
      ["当前 Session",s.name],
      ["工作目录",s.cwd||"尚不可用"],
      ["Git 根目录",s.root||"未检测到或不可用"],
      ["仓库身份",s.repo||"未解析"],
      ["Memory 来源",s.memoryKey==="nession"?"~/.claude/projects/<nession-project>/memory/":s.memoryKey==="vol"?"~/.claude/projects/<vol-project>/memory/":s.memoryKey?"未发现或不可读":"未解析"]
    ];
    return '<div class="source-drawer"><dl class="source-grid">'+entries.map((it)=>'<dt>'+esc(it[0])+'</dt><dd>'+esc(it[1])+'</dd>').join("")+'</dl>'+
      '<div class="source-note">展示的是模拟推导结果。目录键为示意值，不代表已验证 Claude Code 实际配置或路径。</div></div>';
  }
  function fileNav() {
    const list=docs();
    const groups=[
      {label:"INDEX",items:list.filter((f)=>f.index)},
      {label:"TOPIC FILES",items:list.filter((f)=>!f.index)}
    ];
    return '<aside class="file-nav" role="navigation" aria-label="当前仓库的记忆文件">'+
      groups.map((g)=>'<div class="list-group"><h2 class="list-heading">'+g.label+'</h2>'+g.items.map((f)=>
        '<button type="button" class="file-item '+(state.file===f.id?"active":"")+'" data-file="'+esc(f.id)+'" aria-current="'+(state.file===f.id?"page":"false")+'">'+
        '<span class="file-icon" aria-hidden="true">'+(f.index?"▤":"≡")+'</span><span class="file-labels"><span class="file-name">'+esc(f.id)+'</span><span class="file-desc">'+esc(f.desc)+'</span></span></button>'
      ).join("")+'</div>').join("")+'</aside>';
  }
  function docArticle(doc) {
    const sections=doc.sections.map((sec)=>{
      const links=doc.index && sec.title==="记忆索引"
       ? '<div class="link-directory">'+docs().filter((d)=>!d.index).map((d)=>
            '<button type="button" class="index-row" data-file="'+esc(d.id)+'"><span><span class="index-title">'+esc(d.id)+'</span><span class="index-desc">'+esc(d.title)+' · '+esc(d.desc)+'</span></span><span class="arrow" aria-hidden="true">›</span></button>'
          ).join("")+'</div>'
       : '<ul>'+sec.items.map((it)=>'<li>'+esc(it)+'</li>').join("")+'</ul>';
      return '<section><h3>'+esc(sec.title)+'</h3>'+links+'</section>';
    }).join("");
    return '<div class="reader-article"><div class="article-eyebrow">'+esc(doc.subtitle)+'</div>'+
      '<h2>'+esc(doc.title)+'</h2><p class="lead">'+esc(doc.lead)+'</p>'+sections+
      '<div class="reader-meta">只读 · Markdown · 本次查看为模拟文件读取</div></div>';
  }
  function fileReader() {
    const doc=currentDocument();
    const title=doc?doc.id:"MEMORY.md";
    const content=state.docLoading
      ? '<div class="reader-article"><div class="loading-line short"></div><div class="loading-line medium"></div><div class="loading-line"></div></div>'
      : doc?docArticle(doc):'<div class="reader-placeholder">未选择记忆文件</div>';
    return '<article class="file-reader" role="region" aria-label="Memory 文件阅读区">'+
      '<div class="reader-toolbar"><div style="min-width:0;display:flex;align-items:center">'+
      '<button type="button" class="back-list" data-action="back-list" aria-label="返回 Memory 文件列表">← 返回列表</button>'+
      '<span class="reader-crumb">'+esc(title)+'</span></div><span class="read-only"><span class="tiny-lock" aria-hidden="true">◇</span> 只读</span></div>'+content+'</article>';
  }
  function statusCard(kind,s) {
    const dict={
      loading:{glyph:"◌",title:"正在解析当前 Session",desc:"读取工作目录并定位对应的 Claude Code Memory。"},
      empty:{glyph:"▤",title:"此仓库还没有 Memory",desc:"已确定当前 Session 所属仓库，但尚未发现 Claude Code Auto Memory 文件。"},
      unavailable:{glyph:"⌁",title:"暂时无法确定工作目录",desc:"当前 Agent 或 Session 的 CWD 不可用。不会猜测仓库，也不会展示其他项目的记忆。"},
      denied:{glyph:"⊘",title:"无法读取 Memory",desc:"仓库身份已确定，但文件访问被拒绝。其他仓库的内容不会作为替代。"},
      non_git_empty:{glyph:"⌁",title:"未发现项目记忆",desc:"当前目录不是 Git Repository。模拟采用 Claude Code 非 Git 项目规则定位，但没有找到 Memory。"}
    };
    const m=dict[kind]||dict.unavailable;
    return '<div class="status-content"><div class="status-card"><div class="status-symbol" aria-hidden="true">'+m.glyph+'</div>'+
      '<h2>'+esc(m.title)+'</h2><p>'+esc(m.desc)+'</p>'+
      (kind==="denied"||kind==="unavailable"?'<button type="button" class="soft-button" data-action="retry">重新尝试</button>':'')+
      '<div class="status-minor">'+(kind==="loading"?"正在读取上下文":kind==="empty"?"不需要手动选择仓库":"只影响此 Session 的 Memory 显示")+'</div></div></div>';
  }
  function renderMemory() {
    const s=session();
    let content;
    if(state.phase==="ready") {
      content='<div class="memory-browser">'+fileNav()+fileReader()+'</div><div class="memory-bottomline">Auto Memory · 当前 Session 自动确定仓库 · 不提供编辑</div>';
    } else {
      content=statusCard(state.phase,s);
    }
    return '<div class="memory-screen '+(state.mobileDetail?"detail-open":"")+'">'+memoryHeading(s)+sourceDrawer(s)+content+'</div>';
  }
  function renderOther(tab) {
    const s=session();
    if(tab==="conversations") {
      return '<div class="placeholder-view"><div class="overline">CLAUDE CODE / CURRENT SESSION</div><h1>对话</h1>'+
        '<p>当前 Session 的 Claude Code 对话与历史。这里仅演示视图关系，不读取真实 Transcript。</p>'+
        '<div class="placeholder-entry"><button type="button" data-tab-target="memory">继续查看项目记忆 <small>Memory 属于当前 Session 对应的仓库，而不是某一条 Conversation。</small></button>'+
        '<button type="button" data-action="source">查看来源 <small>'+esc(s.name)+' · '+esc(s.repo||"未解析")+'</small></button></div></div>';
    }
    return '<div class="placeholder-view"><div class="overline">CLAUDE CODE / CURRENT SESSION</div><h1>配置</h1>'+
      '<p>Instructions、Settings 和 Skills 保持各自原有的配置语义。Auto Memory 不会作为全局配置文件夹混入此处。</p>'+
      '<div class="placeholder-entry"><button type="button" data-tab-target="memory">返回 Memory <small>由当前 Session 自动关联仓库。</small></button></div></div>';
  }
  function renderWorkspace() {
    const tabs=document.querySelectorAll("[data-tab]");
    tabs.forEach((btn)=>btn.setAttribute("aria-selected",String(btn.dataset.tab===state.tab)));
    $("workspace-content").innerHTML=state.tab==="memory"?renderMemory():renderOther(state.tab);
  }
  function render() {
    renderSessionMenu(); renderTerminal();renderWorkspace();
    app.classList.toggle("show-workspace",state.surface==="workspace");
  }
  function openFileFromEvent(target) {
    const btn=target.closest("[data-file]");
    if(btn) {selectFile(btn.dataset.file);return true;}
    return false;
  }
  function handleContentClick(event) {
    const target=event.target;
    if(openFileFromEvent(target))return;
    const tabTarget=target.closest("[data-tab-target]");
    if(tabTarget){state.tab=tabTarget.dataset.tabTarget;state.mobileDetail=false;renderWorkspace();return;}
    const action=target.closest("[data-action]");
    if(!action)return;
    if(action.dataset.action==="source") {
      state.source=!state.source;
      if(state.tab!=="memory")state.tab="memory";
      renderWorkspace();
    }
    if(action.dataset.action==="back-list") {
      state.mobileDetail=false;renderWorkspace();
    }
    if(action.dataset.action==="retry") {
      state.generation++;state.readGeneration++;state.docLoading=false;state.mobileDetail=false;
      state.phase="loading";renderWorkspace();
      const gen=state.generation,id=state.sessionId;
      setTimeout(function(){if(gen!==state.generation || id!==state.sessionId)return;state.phase=session().kind;renderWorkspace();},460);
    }
  }
  function reset() {
    state.generation++;state.readGeneration++;
    state.sessionId="dev";state.tab="memory";state.surface="workspace";state.phase="ready";
    state.file="MEMORY.md";state.docLoading=false;state.mobileDetail=false;
    state.source=false;state.menu=false;state.event="reset";render();
  }
  $("session-toggle").addEventListener("click",function(e){
    e.stopPropagation();state.menu=!state.menu;renderSessionMenu();
  });
  menu.addEventListener("click",function(e){
    const btn=e.target.closest("[data-session]");
    if(btn){setSession(btn.dataset.session);}
  });
  $("reset-demo").addEventListener("click",reset);
  $("open-workspace").addEventListener("click",function(){state.tab="memory";setSurface("workspace");});
  $("close-workspace").addEventListener("click",function(){state.mobileDetail=false;setSurface("terminal");});
  $("workspace-content").addEventListener("click",handleContentClick);
  document.querySelector(".workspace-tabs").addEventListener("click",function(e){
    const b=e.target.closest("[data-tab]");
    if(!b)return;
    state.tab=b.dataset.tab;state.mobileDetail=false;state.source=false;renderWorkspace();
  });
  document.addEventListener("click",function(e){
    if(state.menu&&!e.target.closest(".session-anchor")){state.menu=false;renderSessionMenu();}
  });
  document.addEventListener("keydown",function(e){
    if(e.key!=="Escape")return;
    if(state.menu){state.menu=false;renderSessionMenu();$("session-toggle").focus();return;}
    if(state.source){state.source=false;renderWorkspace();return;}
    if(state.mobileDetail && state.surface==="workspace" && state.tab==="memory"){state.mobileDetail=false;renderWorkspace();return;}
    if(state.surface==="workspace"){setSurface("terminal");$("open-workspace").focus();}
  });
  window.__nessionMemoryMock={
    snapshot:function(){return {session:state.sessionId,repo:session().repo,memoryKey:session().memoryKey,phase:state.phase,file:state.file,tab:state.tab,mobileDetail:state.mobileDetail,surface:state.surface,generation:state.generation};},
    chooseSession:setSession,openFile:selectFile,reset:reset
  };
  render();
})();