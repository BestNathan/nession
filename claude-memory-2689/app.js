/* Nession Claude Code Memory interaction mock #2689.
 * Fixture-only. No backend, Claude API, Git, filesystem or AI connection. */
(function(){
"use strict";
const SESSIONS=[
{id:"nession",title:"Nession · terminal recovery",agent:"macbook-pro",cwd:"/workspace/nession",root:"/workspace/nession",repo:"BestNathan/nession",key:"nession",branch:"feat/reconnect",kind:"ready",claude:true},
{id:"worktree",title:"Nession · review worktree",agent:"macbook-pro",cwd:"/workspace/nession/.claude/worktrees/review",root:"/workspace/nession",repo:"BestNathan/nession",key:"nession",branch:"review/memory",kind:"ready",claude:true},
{id:"vol",title:"Vol · agent runtime",agent:"beijing-01",cwd:"/srv/vol/crates/runtime",root:"/srv/vol",repo:"BestNathan/vol",key:"vol",branch:"main",kind:"ready",claude:true},
{id:"clean",title:"New service",agent:"macbook-pro",cwd:"/workspace/new-service",root:"/workspace/new-service",repo:"demo/new-service",key:"clean",branch:"main",kind:"empty",claude:false},
{id:"offline",title:"Remote shell · unavailable",agent:"remote-dev",cwd:null,root:null,repo:null,key:null,branch:"—",kind:"unavailable",claude:false},
{id:"denied",title:"Restricted project",agent:"beijing-01",cwd:"/srv/restricted",root:"/srv/restricted",repo:"demo/restricted",key:"denied",branch:"main",kind:"denied",claude:false},
{id:"scratch",title:"Scratch directory",agent:"macbook-pro",cwd:"/home/demo/scratch",root:null,repo:null,key:"scratch",branch:"—",kind:"non_git_empty",claude:false}
];
const MEMORIES={
nession:[
{id:"MEMORY.md",title:"项目记忆索引",desc:"项目经验与反馈入口",index:true,intro:"这一份记忆跟随 Nession 仓库，而不是某一个 Terminal 或 Claude Conversation。具体主题在需要时打开。",parts:[["当前工作",["Nession 以 Session 为工作入口，Terminal 是当前实时工作表面。","能力由当前工作的相关性决定何时浮现，不因为注册就占据常驻导航。"]]]},
{id:"architecture.md",title:"架构约束",desc:"Session、tmux、Capability",parts:[["关键边界",["Session 保存持续工作的上下文，仓库身份从当前 Session 自动确定。","tmux 负责终端会话与 I/O，不拥有 Claude Code Memory。","同一个仓库下的多个 worktree 共享该仓库的 Memory。"]]]},
{id:"interaction.md",title:"交互原则",desc:"工作优先、渐进浮现",parts:[["已确认的交互",["默认保持 Terminal 安静。通过 TerminalCapsule 的 + 明确选择 Claude Code，然后进入 Peek。","用户需要详细记忆时，再进入 Workspace。仓库不会作为选择框出现。","手机端的 Sessions、Terminal、Workspace 是三个空间深度，不是压缩后的两栏桌面页面。"]]]},
{id:"verification.md",title:"验收上下文",desc:"源码与验证边界",parts:[["工程原则",["更改原型并不意味着代码已实现。","测试必须证明所影响的行为，不能把模拟状态当作生产运行证据。"]]]}
],
vol:[
{id:"MEMORY.md",title:"Vol · Memory",desc:"Agent Runtime 项目索引",index:true,intro:"这个 Session 来自另一仓库。其 Memory 独立于 Nession。",parts:[["项目背景",["Vol 是一个 Agent Runtime / Harness 实验项目。","Provider、Tool Registry、Task 和 Session 有独立边界。"]]]},
{id:"tools.md",title:"Tool Registry",desc:"工具注册与执行",parts:[["职责",["工具注册表提供可用工具的元数据。","调度层处理调用、结果与恢复。"]]]},
{id:"runtime.md",title:"Runtime 生命周期",desc:"Task / Session",parts:[["职责",["Task 表示一次明确目标的执行。","Session 表示持续的上下文与状态。"]]]}
]
};
const $=id=>document.getElementById(id);
const state={session:"nession",page:"terminal",previousPage:"terminal",context:"closed",peek:"claude",capability:"claude",tab:"memory",file:"MEMORY.md",phase:"ready",detail:false,origin:false,generation:0,reading:0,readingBusy:false,notice:""};
const S=()=>SESSIONS.find(x=>x.id===state.session),D=()=>MEMORIES[S().key]||[];
function h(x){return String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function doc(){return D().find(x=>x.id===state.file)||D()[0];}
function showPage(page){state.page=page;state.context="closed";render();}
function toWorkspace(cap="claude",tab="memory"){state.capability=cap;state.tab=tab;state.detail=false;showPage("workspace");}
function toggleContext(){state.context=state.context==="closed"?"list":"closed";renderContext();}
function switchSession(id){
 const next=SESSIONS.find(x=>x.id===id);if(!next)return;
 const prev=S();const shared=prev.key&&prev.key===next.key&&prev.kind==="ready"&&next.kind==="ready";
 state.generation++;state.reading++;state.session=id;state.page="terminal";state.context="closed";state.origin=false;state.detail=false;state.readingBusy=false;state.notice="";
 if(!shared||!MEMORIES[next.key]?.some(x=>x.id===state.file))state.file="MEMORY.md";
 state.phase="loading";render();
 const token=state.generation;setTimeout(()=>{if(token!==state.generation)return;state.phase=next.kind;renderWorkspace();renderContext();},350);
}
function openFile(id){
 if(state.phase!=="ready"||!D().some(x=>x.id===id))return;
 state.file=id;state.detail=true;state.readingBusy=true;const token=++state.reading,gen=state.generation;
 renderWorkspace();setTimeout(()=>{if(gen!==state.generation||token!==state.reading)return;state.readingBusy=false;renderWorkspace();},180);
}
function reset(){state.generation++;state.reading++;Object.assign(state,{session:"nession",page:"terminal",previousPage:"terminal",context:"closed",peek:"claude",capability:"claude",tab:"memory",file:"MEMORY.md",phase:"ready",detail:false,origin:false,readingBusy:false,notice:""});render();}
function renderTerminal(){
 const s=S(),cmd=s.claude?"claude":"pwd";
 const lines=s.kind==="unavailable"?'<span class="term-muted"># Agent unreachable · last snapshot retained</span>\nConnection unavailable.\n':'<span class="prompt">'+h(s.agent)+':'+h(s.cwd)+'$</span> <span class="cmd">git branch --show-current</span>\n'+h(s.branch)+'\n\n<span class="prompt">'+h(s.agent)+':'+h(s.cwd)+'$</span> <span class="cmd">'+cmd+'</span>\n'+(s.claude?"Claude Code\n\n<span class='term-muted'>  Working directory available. Existing TUI remains mounted.</span>\n":h(s.cwd)+"\n")+'\n<span class="prompt">'+h(s.agent)+':'+h(s.cwd)+'$</span> <span class="cursor"></span>';
 $("terminal-lines").innerHTML=lines;
}
function contextList(){
 const s=S();
 return '<div class="context-title">当前 Session 的能力</div>'+
 '<button class="context-row" data-peek="claude"><span class="context-icon">✳</span><span class="context-copy"><strong>Claude Code</strong><small>'+(s.claude?"在此 Session 中已打开 · 查看对话与 Memory":"查看当前工作可用的 Claude Code 信息")+'</small></span><span class="context-meta">›</span></button>'+
 (s.repo?'<button class="context-row" data-peek="git"><span class="context-icon">⌁</span><span class="context-copy"><strong>Git</strong><small>'+h(s.branch)+' · 当前仓库状态</small></span><span class="context-meta">›</span></button>':'');
}
function contextPeek(){
 const s=S(),isClaude=state.peek==="claude";
 const isReady=s.kind==="ready",count=isReady?D().length:0;
 return '<div class="peek-header"><strong>'+(isClaude?"✳ &nbsp; Claude Code":"⌁ &nbsp; Git")+'</strong><button class="close-peek" data-context-close aria-label="关闭 Peek">×</button></div>'+
 '<div class="peek-content"><div class="peek-current">当前 Session · '+h(s.title)+'</div>'+
 '<div class="peek-repo">'+h(s.repo||"仓库身份未确定")+'</div>'+
 '<p class="peek-note">'+(isClaude?(isReady?"Claude Code 已在当前 Session 中打开。自动关联到此仓库的 "+count+" 个 Memory 文件。":"当前无法读取项目 Memory 的完整状态。进入 Workspace 可查看具体原因。"):"分支 "+h(s.branch)+" · Repository 身份由 Session 自动决定。")+'</p>'+
 '<button class="peek-cta" data-context-deepen="'+(isClaude?"claude":"git")+'">'+(isClaude?"在 Workspace 查看 Memory":"在 Workspace 查看 Git")+' &nbsp; ↗</button></div>';
}
function renderContext(){
 $("context-surface").hidden=state.context==="closed"||state.page!=="terminal";
 $("context-trigger").setAttribute("aria-expanded",String(state.context!=="closed"));
 if(state.context==="closed")return;
 $("context-surface").innerHTML=state.context==="peek"?contextPeek():state.context==="notice"?'<div class="peek-content"><p class="peek-note">'+h(state.notice)+'</p><button class="peek-cta" data-context-deepen="claude">查看当前 Session Memory</button></div>':contextList();
}
function renderDock(){
 const choices=[["files","▤","Files"],["git","⌁","Git"],["claude","✳","Claude"]];
 $("capability-dock").innerHTML=choices.filter(x=>x[0]!=="git"||S().repo).map(x=>
 '<button class="capability-item '+(state.capability===x[0]?"active":"")+'" type="button" data-cap="'+x[0]+'" aria-current="'+(state.capability===x[0]?"page":"false")+'" aria-label="'+x[2]+'"><b>'+x[1]+'</b>'+x[2]+'</button>').join("");
}
function renderOrigins(){
 if(!state.origin)return "";
 const s=S();
 return '<div class="origin-details"><dl>'+
 [["Session",s.title],["Agent",s.agent],["Current CWD",s.cwd||"未知"],["Repository",s.repo||"未解析"],["Git root",s.root||"不可用"],["Auto Memory",s.kind==="ready"?"~/.claude/projects/<repo-key>/memory/":"未找到 / 无法确认"]]
 .map(x=>'<dt>'+h(x[0])+'</dt><dd>'+h(x[1])+'</dd>').join("")+'</dl>'+
 '<p class="origin-note">演示路径为模拟占位符。真实实现须按 Claude Code 的有效配置解析，不能根据字符串猜测 project key。</p></div>';
}
function memoryHeader(){
 const s=S();
 return '<div class="memory-context"><div><h2>Memory</h2><p>'+(s.repo?h(s.repo)+" · 自动关联当前 Session":"仓库或工作目录尚未确定")+'</p></div>'+
 '<button class="context-link" data-action="origin" aria-expanded="'+state.origin+'">来源 '+(state.origin?"⌃":"⌄")+'</button></div>'+renderOrigins();
}
function navFiles(){
 return '<aside class="memory-list" aria-label="Memory 文件索引"><div class="memory-list-label">INDEX</div>'+
 D().filter(x=>x.index).map(fileRow).join("")+
 '<div class="memory-list-label">TOPICS</div>'+D().filter(x=>!x.index).map(fileRow).join("")+'</aside>';
}
function fileRow(d){return '<button class="memory-file '+(state.file===d.id?"selected":"")+'" data-file="'+h(d.id)+'" type="button" aria-current="'+(state.file===d.id?"page":"false")+'">'+
 '<span class="file-glyph">▤</span><span class="file-copy"><strong>'+h(d.id)+'</strong><small>'+h(d.desc)+'</small></span></button>';}
function article(d){
 const intro='<p>'+h(d.intro||"此文件包含与当前 Repository 相关的 Claude Code 记忆，仅作为模拟阅读内容。")+'</p>';
 const parts=d.parts.map(([name,bullets])=>'<h3>'+h(name)+'</h3><ul>'+bullets.map(v=>'<li>'+h(v)+'</li>').join("")+'</ul>').join("");
 const index=d.index?'<h3>主题文件</h3>'+D().filter(x=>!x.index).map(x=>'<button class="index-link" data-file="'+h(x.id)+'" type="button"><span><strong>'+h(x.id)+'</strong><small>'+h(x.desc)+'</small></span><span>›</span></button>').join(""):"";
 return '<div class="reader-body"><h2>'+h(d.title)+'</h2>'+intro+parts+index+'<p class="article-note">只读 · 模拟 Markdown 记忆文件 · 不代表真实 Claude Code 数据</p></div>';
}
function reader(){
 const d=doc();
 return '<article class="memory-reader" aria-label="Memory 文件详情"><div class="reader-head">'+
 '<div style="display:flex;align-items:center;min-width:0"><span class="reader-path">'+h(d?.id||"MEMORY.md")+'</span></div><span class="read-only">READ ONLY</span></div>'+
 (state.readingBusy?'<div class="state-view"><div><p>正在读取文件…</p></div></div>':d?article(d):'<div class="state-view"><p>没有可读取的文件</p></div>')+'</article>';
}
function emptyState(){
 const messages={
 loading:["◌","正在解析当前 Session","根据工作目录定位 Repo 与 Claude Code Memory。"],
 empty:["▤","这个仓库尚无 Memory","仓库身份已确定，但还没有 Auto Memory 文件。"],
 unavailable:["⌁","无法解析当前工作目录","Agent 暂不可用，不会猜测项目或展示其他仓库的 Memory。"],
 denied:["⊘","无权读取 Memory","已经定位当前 Repository，但读取被拒绝。"],
 non_git_empty:["⌁","没有找到项目 Memory","当前目录不属于 Git Repository，模拟非 Git 项目规则后仍没有记忆。"]
 };
 const k=messages[state.phase]||messages.unavailable;
 return '<div class="state-view"><div><div class="state-icon">'+k[0]+'</div><h2>'+k[1]+'</h2><p>'+k[2]+'</p>'+
 (state.phase==="unavailable"||state.phase==="denied"?'<button class="retry" data-action="retry">重新尝试</button>':'')+'</div></div>';
}
function claudeContent(){
 const tabs=[["conversation","对话"],["memory","Memory"],["configuration","配置"]];
 return '<div class="capability-view"><div class="capability-heading"><div class="eyebrow">CURRENT SESSION / CLAUDE CODE</div><h1>Claude Code</h1></div>'+
 '<nav class="capability-subnav" aria-label="Claude Code 内部视图">'+tabs.map(x=>'<button type="button" data-tab="'+x[0]+'" class="'+(state.tab===x[0]?"active":"")+'">'+x[1]+'</button>').join("")+'</nav>'+
 (state.tab==="memory"?
 memoryHeader()+(state.phase==="ready"?'<div class="memory-layout '+(state.detail?"show-detail":"")+'">'+navFiles()+reader()+'</div>':emptyState()):
 '<div class="other-view"><h2>'+(state.tab==="conversation"?"当前 Session 的对话":"Claude Code 配置")+'</h2><p>'+(state.tab==="conversation"?"这是 Claude Code 专属的对话深度；Memory 按 Repository 共享，并不隶属于某一条对话。":"配置与 Memory 是不同的语义；Memory 从当前 Session 的 Repository 自动解析。")+'</p><button class="other-entry" data-tab="memory">查看关联 Memory<small>不需要选择 Repo 或重新选择 Session。</small></button></div>')+
 '</div>';
}
function otherCapability(){
 const name=state.capability==="git"?"Git":"Files";const s=S();
 return '<div class="capability-view"><div class="other-view"><div class="eyebrow">CURRENT SESSION / WORKSPACE CAPABILITY</div><h2>'+name+'</h2><p>'+
 (state.capability==="git"?"当前 Repo: "+h(s.repo||"未解析")+" · 分支 "+h(s.branch)+". 此原型只聚焦 Claude Code Memory 的产品路径。":"当前工作目录: "+h(s.cwd||"未知")+". 文件浏览是 Workspace 的另一个能力，而不是 Memory 的导航父层。")+
 '</p><button class="other-entry" data-cap="claude">返回 Claude Code<small>Memory 自动跟随当前 Session 的 Repository。</small></button></div></div>';
}
function renderWorkspace(){
 $("workspace-inner").innerHTML=state.capability==="claude"?claudeContent():otherCapability();
 renderDock();
}
function renderSessions(){
 $("session-list").innerHTML='<div class="session-group">CURRENT & RECENT</div>'+SESSIONS.map(x=>
 '<button type="button" data-session="'+x.id+'" class="session-row '+(x.id===state.session?"active":"")+'"><span class="session-indicator"></span><span><strong>'+h(x.title)+'</strong><small>'+h(x.claude?"Claude Code · ":"Shell · ")+h(x.agent)+'</small></span></button>').join("");
}
function render(){
 $("app").dataset.page=state.page;
 $("terminal").hidden=!(state.page==="terminal"||state.page==="sessions");
 $("workspace").hidden=state.page!=="workspace";
 $("sessions-layer").hidden=state.page!=="sessions";
 $("session-heading").textContent=state.page==="sessions"?"Sessions":state.page==="workspace"?(state.detail&&state.capability==="claude"&&state.tab==="memory"?state.file:"Claude Code"):S().title;
 $("sessions-open").textContent=state.page==="terminal"?"☰":"‹";
 $("sessions-open").setAttribute("aria-label",state.page==="terminal"?"打开 Sessions":state.page==="workspace"?(state.detail?"返回 Memory 列表":"返回 Terminal"):"返回 Terminal");
 renderTerminal();renderContext();renderWorkspace();renderSessions();
}
function retry(){
 state.generation++;state.reading++;state.phase="loading";renderWorkspace();
 const gen=state.generation;setTimeout(()=>{if(gen!==state.generation)return;state.phase=S().kind;renderWorkspace();},350);
}
function returnOneDepth(){
 if(state.page==="sessions"){showPage("terminal");return;}
 if(state.page==="workspace"){if(state.detail&&state.capability==="claude"&&state.tab==="memory"){state.detail=false;renderWorkspace();}else showPage("terminal");return;}
 if(state.page==="terminal"){state.previousPage="terminal";showPage("sessions");}
}
function simulateIntent(){
 const input=$("intent-input"),text=input.value.trim();if(!text)return;
 input.value="";if(/memory|记忆|记住|claude/i.test(text)){state.notice="离线意图模拟：在当前 Session 的 Claude Code 中查看 Memory。";toWorkspace("claude","memory");}
 else{state.notice="本原型仅模拟「查看 Memory」相关意图；没有调用真实 AI。";state.context="notice";renderContext();}
}
$("context-trigger").addEventListener("click",toggleContext);
$("to-workspace").addEventListener("click",()=>toWorkspace(state.capability,state.tab));
$("to-terminal").addEventListener("click",()=>showPage("terminal"));
$("intent-send").addEventListener("click",simulateIntent);
$("intent-input").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();simulateIntent();}});
$("sessions-open").addEventListener("click",returnOneDepth);
$("rail-expand").addEventListener("click",()=>showPage("sessions"));
$("sessions-close").addEventListener("click",()=>showPage("terminal"));
$("reset").addEventListener("click",reset);
$("session-list").addEventListener("click",e=>{const b=e.target.closest("[data-session]");if(b)switchSession(b.dataset.session);});
$("context-surface").addEventListener("click",e=>{
 const btn=e.target.closest("[data-peek],[data-context-close],[data-context-deepen]");if(!btn)return;
 if(btn.dataset.peek){state.peek=btn.dataset.peek;state.context="peek";renderContext();}
 if(btn.hasAttribute("data-context-close")){state.context="closed";renderContext();}
 if(btn.dataset.contextDeepen)toWorkspace(btn.dataset.contextDeepen,btn.dataset.contextDeepen==="claude"?"memory":"status");
});
$("capability-dock").addEventListener("click",e=>{const b=e.target.closest("[data-cap]");if(!b)return;state.capability=b.dataset.cap;state.tab="memory";state.detail=false;state.origin=false;renderWorkspace();});
$("workspace-inner").addEventListener("click",e=>{
 const btn=e.target.closest("[data-tab],[data-file],[data-action],[data-cap]");if(!btn)return;
 if(btn.dataset.tab){state.tab=btn.dataset.tab;state.detail=false;renderWorkspace();}
 else if(btn.dataset.file)openFile(btn.dataset.file);
 else if(btn.dataset.cap){state.capability=btn.dataset.cap;state.tab="memory";state.detail=false;renderWorkspace();}
 else if(btn.dataset.action==="origin"){state.origin=!state.origin;renderWorkspace();}
 else if(btn.dataset.action==="retry")retry();
});
document.addEventListener("keydown",e=>{if(e.key!=="Escape")return;if(state.context!=="closed"){state.context="closed";renderContext();}else if(state.page!=="terminal")returnOneDepth();});
let x0=0,y0=0,edge=false;
$("app").addEventListener("touchstart",e=>{
 if(window.innerWidth>700)return;
 const t=e.target;
 if(t.closest(".conversation-capsule,.context-surface,.memory-layout,.workspace-dock,.sessions-layer")){edge=false;return;}
 x0=e.touches[0].clientX;y0=e.touches[0].clientY;edge=x0<28||x0>window.innerWidth-28;
},{passive:true});
$("app").addEventListener("touchend",e=>{
 if(!edge||window.innerWidth>700)return;
 edge=false;
 const dx=e.changedTouches[0].clientX-x0,dy=e.changedTouches[0].clientY-y0;
 if(Math.abs(dx)<85||Math.abs(dx)<Math.abs(dy)*1.6)return;
 if(state.page==="terminal"&&dx>0&&x0<28)showPage("sessions");
 else if(state.page==="terminal"&&dx<0&&x0>window.innerWidth-28)toWorkspace("claude","memory");
 else if(state.page==="workspace"&&!state.detail&&dx>0&&x0<28)showPage("terminal");
},{passive:true});
window.__nessionMemoryMock={state:()=>({session:state.session,repo:S().repo,phase:state.phase,page:state.page,context:state.context,tab:state.tab,file:state.file,detail:state.detail,generation:state.generation}),setSession:switchSession,openFile,openWorkspace:()=>toWorkspace("claude","memory"),reset};
render();
})();