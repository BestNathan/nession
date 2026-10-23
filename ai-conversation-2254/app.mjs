import {parseText, directiveText, referenceText} from "./content-parser.mjs";

const AGENTS = [
  {id:"beijing", name:"Beijing Server", hostname:"beijing-node", os:"Ubuntu 24.04", online:true, sessions:2},
  {id:"home", name:"Home Server", hostname:"pve-homelab", os:"Debian 13", online:true, sessions:1},
  {id:"office", name:"Office PC", hostname:"dev-workstation", os:"Windows 11", online:false, sessions:0}
];
const initialSessions = [
  {id:"beijing:main", name:"main", agentId:"beijing", status:"running", windows:2},
  {id:"home:research", name:"research", agentId:"home", status:"running", windows:1}
];
const $ = id => document.getElementById(id);
const state = {messages:[], instances:new Map(), placements:new Map(), semantic:new Map(), sessions:initialSessions.map(x=>({...x})), refCounter:0, messageCounter:0, activeRef:null, activeMessage:null, inspectorTab:"state", events:[], streaming:false};
function node(tag, cls="", text) {const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;}
function button(label, className="btn", click, disabled=false) {const b=node("button",className,label);b.type="button";b.disabled=disabled;if(click)b.addEventListener("click",click);return b;}
function emit(kind,detail){state.events.unshift({time:new Date().toLocaleTimeString(),kind,detail});state.events.length=Math.min(state.events.length,50);inspect();}
function toast(text){const e=$("toast");e.textContent=text;e.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>e.hidden=true,2100);}
function labelForAgent(id){return AGENTS.find(x=>x.id===id)?.name ?? id ?? "未选择";}
function findAgent(id){return AGENTS.find(x=>x.id===id);}
function initInstance(def) {
 const c=def.component, input=def.input || {};
 const semanticKey=c+"|"+JSON.stringify(input);
 const existing=state.semantic.get(semanticKey);
 if(existing&&state.instances.has(existing))return state.instances.get(existing);
 const ref="cmp_"+String(++state.refCounter).padStart(3,"0");
 const inst={ref,component:c,input:{...input},selectedAgentId:input.agentId||null,name:input.name||"",status:"idle",createdSessionId:null,scope:"demo"};
 state.instances.set(ref,inst);state.semantic.set(semanticKey,ref);
 emit("instance.created",{ref,component:c});
 return inst;
}
function instanceFromDirective(def,message,seg) {
 if(def.op==="reference"){
   const existing=state.instances.get(def.ref);
   return existing?.component===def.component ? existing : null;
 }
 const key=message.id+":"+seg.key;
 const oldRef=state.placements.get(key);
 if(oldRef&&state.instances.has(oldRef))return state.instances.get(oldRef);
 const inst=initInstance(def);
 state.placements.set(key,inst.ref);
 return inst;
}
function contextFor(inst) {
 if(!inst)return null;
 const base={component:inst.component,ref:inst.ref};
 if(inst.component==="agent.list")return {...base,state:{selectedAgentId:inst.selectedAgentId,selectedAgentStatus:findAgent(inst.selectedAgentId)?.online?"online":(inst.selectedAgentId?"offline":null)},actions:inst.selectedAgentId?(findAgent(inst.selectedAgentId)?.online?["agent.inspect","session.create"]:["agent.inspect"]):["agent.select"]};
 if(inst.component==="session.create.form")return {...base,state:{agentId:inst.selectedAgentId,name:inst.name,valid:!!(inst.name.trim()&&findAgent(inst.selectedAgentId)?.online),status:inst.status,createdSessionId:inst.createdSessionId},actions:inst.status==="created"?["session.inspect"]:(inst.name.trim()&&findAgent(inst.selectedAgentId)?.online?["session.create.submit"]:[])};
 if(inst.component==="session.list")return {...base,state:{filter:inst.input,visibleSessionIds:state.sessions.filter(x=>!inst.input.agentId||x.agentId===inst.input.agentId).map(x=>x.id)},actions:["session.select"]};
 return {...base,state:{...inst.input},actions:[]};
}
function inspect() {
 const target=state.instances.get(state.activeRef);
 const message=state.messages.find(x=>x.id===state.activeMessage)||state.messages.at(-1);
 const tab=state.inspectorTab;
 let content;
 if(tab==="state") content=target?JSON.stringify(contextFor(target),null,2):"点击某个业务组件，检查它的状态与动作空间。";
 else if(tab==="source")content=message?JSON.stringify({role:message.role,content:[{type:"text",text:message.text}]},null,2):"暂无消息";
 else if(tab==="segments")content=message?JSON.stringify(parseText(message.text,message.status!=="streaming").map(x=>({kind:x.kind,key:x.key,...(x.kind==="component"?{value:x.value}:x.kind==="error"?{error:x.error}:x.kind==="pending"?{pending:true}:{text:x.text?.slice(0,160)})})),null,2):"暂无消息";
 else content=JSON.stringify(state.events,null,2);
 $("inspect-output").textContent=content;
 document.querySelectorAll("[data-inspect-tab]").forEach(x=>x.classList.toggle("active",x.dataset.inspectTab===tab));
}
function toggleInspector(visible){
 $("inspector").hidden=!visible;$("toggle-inspector").classList.toggle("active",visible);
 $("toggle-inspector").setAttribute("aria-expanded",String(visible));inspect();
}
function addMessage(role,text="",status="settled") {
 const msg={id:"m"+ ++state.messageCounter,role,text,status,cache:new Map(),body:null};
 state.messages.push(msg);
 const article=node("article","message "+role);article.dataset.messageId=msg.id;article.setAttribute("aria-busy",String(status==="streaming"));
 const head=node("div","message-head");
 head.append(node("span","role",role==="user"?"You":"Nession"),node("span","time",new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})));
 const body=node("div","message-body");msg.body=body;msg.article=article;
 article.append(head,body);article.addEventListener("click",()=>{state.activeMessage=msg.id;inspect();});
 $("feed").append(article);$("app").classList.remove("is-empty");
 renderMessage(msg);state.activeMessage=msg.id;emit("message."+role,{id:msg.id,contentType:"text",status});
 scrollDown();return msg;
}
function scrollDown(){const feed=$("conversation");const nearBottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<320;if(nearBottom||state.messages.length<4)requestAnimationFrame(()=>feed.scrollTop=feed.scrollHeight);}
function renderMessage(msg){
 const segs=parseText(msg.text,msg.status!=="streaming");const cache=new Map();
 const fragment=document.createDocumentFragment();
 for(const seg of segs){
   const signature=seg.kind==="text"?seg.text:seg.kind==="component"?JSON.stringify(seg.value):seg.raw;
   const old=msg.cache.get(seg.key);
   let view=old&&old.signature===signature ? old.view:null;
   if(!view){
     if(seg.kind==="text")view=node("div","markdown-text",seg.text);
     else if(seg.kind==="pending")view=node("div","pending","正在接收组件描述…");
     else if(seg.kind==="error"){
       view=node("details","parse-error");
       view.append(node("summary","","UI 指令未渲染 · "+seg.error),node("pre","",seg.raw));
       emit("parser.fallback",{messageId:msg.id,reason:seg.error});
     } else view=renderUI(seg.value,msg,seg);
   }
   cache.set(seg.key,{signature,view});fragment.append(view);
 }
 msg.cache=cache;msg.body.replaceChildren(fragment);msg.article.setAttribute("aria-busy",String(msg.status==="streaming"));inspect();scrollDown();
}
function wrapCard(inst,title,glyph,note) {
 const root=node("div","ui-instance");root.dataset.ref=inst.ref;root.addEventListener("click",()=>{state.activeRef=inst.ref;inspect();});
 const header=node("div","card-head");const left=node("div","card-title");left.append(node("span","component-icon",glyph),node("span","",title));
 header.append(left,node("span","tag",note));root.append(header);
 const body=node("div","card-body");const foot=node("div","card-foot");root.append(body,foot);
 return {root,body,foot};
}
function footActions(foot,inst,note,extra=[]){
 foot.append(node("span","meta",note));
 const group=node("div");group.style.display="flex";group.style.gap="7px";
 for(const b of extra)group.append(b);
 group.append(button("发给 AI ↗","btn slim",()=>sendReference(inst.ref)));
 foot.append(group);
}
function agentList(inst) {
 const c=wrapCard(inst,"Agent 列表","⌁","agent.list");
 const filter=inst.input.status||"all";
 const agents=AGENTS.filter(a=>filter==="all"||(filter==="online"&&a.online)||(filter==="offline"&&!a.online));
 c.body.append(node("div","meta",agents.length+" 个节点 · 点击节点选择 · 状态实时投影（Mock）"));
 for(const a of agents) {
   const b=node("button","row-entry"+(inst.selectedAgentId===a.id?" selected":""));b.type="button";
   const circle=node("span","radio",inst.selectedAgentId===a.id?"◉":"○");
   const dot=node("span","dot "+(a.online?"online":""));
   const summary=node("span","row-text");summary.append(node("strong","",a.name),node("small","",a.hostname+" · "+a.os));
   b.append(circle,dot,summary,node("span","row-side",a.online?"在线":"离线"));
   b.addEventListener("click",()=>{inst.selectedAgentId=a.id;state.activeRef=inst.ref;emit("agent.selected",{ref:inst.ref,id:a.id});updatePlacements(inst.ref);});
   c.body.append(b);
 }
 const a=findAgent(inst.selectedAgentId);
 footActions(c.foot,inst,a?"已选择 "+a.name:"请选择一个 Agent",[
   button("创建 Session","btn primary slim",()=>openSessionForm(inst.selectedAgentId),!a?.online)
 ]);
 return c.root;
}
function agentDetail(inst){
 const a=findAgent(inst.input.agentId);if(!a)return simpleError(inst,"找不到 Agent");
 const c=wrapCard(inst,a.name,"◈","agent.detail");
 for(const [k,v] of [["ID",a.id],["Hostname",a.hostname],["System",a.os],["Status",a.online?"Online":"Offline"]]){
   const row=node("div","kv");row.append(node("span","",k),node("strong","",v));c.body.append(row);
 }
 footActions(c.foot,inst,"来自 Agent Registry",[button("创建 Session","btn primary slim",()=>openSessionForm(a.id),!a.online)]);
 return c.root;
}
function sessionList(inst){
 const c=wrapCard(inst,"Session 列表","▣","session.list");
 const sessions=state.sessions.filter(s=>!inst.input.agentId||s.agentId===inst.input.agentId);
 for(const s of sessions){
   const b=node("button","row-entry");b.type="button";
   const t=node("span","row-text");t.append(node("strong","",s.name),node("small","",labelForAgent(s.agentId)+" · "+s.id));
   b.append(node("span","dot online"),t,node("span","row-side","运行中"));
   b.addEventListener("click",()=>assistantStream("这是 Session 的当前信息。\n\n"+directiveText({v:1,op:"render",component:"session.detail",input:{sessionId:s.id}})));
   c.body.append(b);
 }
 if(!sessions.length)c.body.append(node("div","empty-rows","当前没有符合条件的 Session。"));
 footActions(c.foot,inst,sessions.length+" 个 Session");
 return c.root;
}
function sessionDetail(inst){
 const s=state.sessions.find(x=>x.id===inst.input.sessionId);if(!s)return simpleError(inst,"会话不存在或已不可用");
 const c=wrapCard(inst,"Session · "+s.name,"▣","session.detail");
 for(const [k,v] of [["Session ID",s.id],["Agent",labelForAgent(s.agentId)],["Status",s.status],["Windows",String(s.windows)]]) {
   const r=node("div","kv");r.append(node("span","",k),node("strong","",v));c.body.append(r);
 }
 footActions(c.foot,inst,"Mock 业务实体 · 未连接终端");
 return c.root;
}
function sessionForm(inst){
 const c=wrapCard(inst,"创建 Session","＋","session.create.form");
 if(inst.status==="created"){
   c.body.append(node("div","success-note","已创建（Mock）："+inst.createdSessionId));
   footActions(c.foot,inst,"提交已完成 · 不可重复执行",[button("查看详情","btn slim",()=>assistantStream("刚创建的 Session：\n\n"+directiveText({v:1,op:"render",component:"session.detail",input:{sessionId:inst.createdSessionId}})))]);
   return c.root;
 }
 const form=node("form","fields");
 const agentField=node("div","field");agentField.append(node("label","","Agent"));
 const select=node("select");select.setAttribute("aria-label","Agent");
 for(const a of AGENTS.filter(x=>x.online)){const opt=node("option","",a.name);opt.value=a.id;select.append(opt);}
 select.value=AGENTS.some(a=>a.id===inst.selectedAgentId&&a.online)?inst.selectedAgentId:"beijing";inst.selectedAgentId=select.value;
 select.addEventListener("change",()=>{inst.selectedAgentId=select.value;emit("form.changed",contextFor(inst));});
 agentField.append(select);
 const nameField=node("div","field");nameField.append(node("label","","Session Name"));
 const input=node("input");input.type="text";input.value=inst.name;input.placeholder="dev-session";input.maxLength=48;input.setAttribute("aria-label","Session Name");
 input.addEventListener("input",()=>{inst.name=input.value;emit("form.changed",contextFor(inst));});
 nameField.append(input);
 form.append(agentField,nameField);
 const hint=node("p","hint","显式提交才会执行创建。此原型仅更新模拟数据，不调用真实 Server。");
 const submit=button("创建 Session","btn primary",()=>submitSession(inst),false);
 submit.type="submit";form.addEventListener("submit",ev=>{ev.preventDefault();submitSession(inst);});
 c.body.append(form,hint);
 footActions(c.foot,inst,"待填写 · 提交需确认",[submit]);
 return c.root;
}
function gitChanges(inst){
 const c=wrapCard(inst,"Git 变更","⑂","git.changes");
 c.body.append(node("div","meta","当前 Session 的模拟仓库 · 只读"));
 const changes=[["M","web/src/shared/ai-conversation/components/ConversationMessage.tsx"],["A","web/src/shared/ai-conversation/content/ContentParser.ts"],["M","docs/design/design-system/patterns/conversation.md"]];
 for(const [status,path] of changes){const r=node("div","row-entry");r.append(node("span","tag",status),node("span","row-text",path));c.body.append(r);}
 footActions(c.foot,inst,"3 个文件 · 不开放 commit 或写入动作");
 return c.root;
}
function simpleError(inst,text){const c=wrapCard(inst,"资源不可用","!","unavailable");c.body.append(node("div","empty-rows",text));return c.root;}
function viewFor(inst){
 if(inst.component==="agent.list")return agentList(inst);
 if(inst.component==="agent.detail")return agentDetail(inst);
 if(inst.component==="session.list")return sessionList(inst);
 if(inst.component==="session.detail")return sessionDetail(inst);
 if(inst.component==="session.create.form")return sessionForm(inst);
 if(inst.component==="git.changes")return gitChanges(inst);
 return simpleError(inst,"该组件尚未在 Prototype 中实现");
}
function validInput(def){
 const input=def.input||{};
 const schemas={
  "agent.list": ["status"],"agent.detail":["agentId"],"session.list":["agentId","status"],"session.detail":["sessionId"],"session.create.form":["agentId","name","workingDir"],"git.changes":["sessionId"],"git.diff":["sessionId","path"]
 };
 const keys=schemas[def.component];
 if(!keys)return "未注册的业务组件";
 if(Object.keys(input).some(x=>!keys.includes(x)))return "未知组件参数";
 if("status" in input && !["online","offline","all","running"].includes(input.status))return "无效状态过滤参数";
 for(const k of ["agentId","name","sessionId","path","workingDir"])if(k in input && typeof input[k]!=="string")return "参数 "+k+" 必须是字符串";
 return null;
}
function renderUI(def,msg,seg){
 const wrap=node("div");
 const error=validInput(def);
 if(error){wrap.className="parse-error";wrap.textContent=error+" · "+def.component;return wrap;}
 const inst=instanceFromDirective(def,msg,seg);
 if(!inst) {
   const c=node("div","ui-instance");const h=node("div","card-head","历史组件引用不可用 · "+def.component);
   c.append(h,node("div","card-body","引用 "+def.ref+" 未找到。原始上下文只能用于提示，不能授予业务操作权限。"));
   return c;
 }
 state.activeRef=inst.ref;
 const surface=viewFor(inst);
 surface.dataset.ref=inst.ref;
 surface.dataset.placement=msg.id+":"+seg.key;
 if(def.op==="reference")surface.prepend(node("div","reference-note","↪ 引用已有实例 "+inst.ref+" · 状态由同一 Runtime 共享"));
 return surface;
}
function updatePlacements(ref){
 for(const x of document.querySelectorAll(".ui-instance")){
  if(x.dataset.ref!==ref)continue;
  const inst=state.instances.get(ref);if(!inst)continue;
  const next=viewFor(inst);next.dataset.ref=ref;next.dataset.placement=x.dataset.placement||"";
  if(x.querySelector(".reference-note"))next.prepend(node("div","reference-note","↪ 引用已有实例 "+ref+" · 共享状态"));
  x.replaceWith(next);
 }
 inspect();
}
function sendReference(ref) {
 const inst=state.instances.get(ref);if(!inst)return;
 const projection=contextFor(inst);
 const context=inst.component==="agent.list"?{selectedAgentId:inst.selectedAgentId}:inst.component==="session.create.form"?{agentId:inst.selectedAgentId,name:inst.name}:{resource:inst.input};
 const instruction=inst.component==="agent.list"?"基于我选中的 Agent，帮我创建一个 Session。": "请参考这个组件的当前状态继续。";
 const text=instruction+"\n\n"+referenceText(inst,context);
 emit("component.serialize",{ref,projection});submitText(text);
}
function openSessionForm(agentId) {
 if(!agentId||!findAgent(agentId)?.online)return toast("请先选择一个在线 Agent");
 assistantStream("好的，在 "+labelForAgent(agentId)+" 上可以创建 Session。请检查信息后提交：\n\n"+
   directiveText({v:1,op:"render",component:"session.create.form",input:{agentId,name:"dev-session"}}));
}
function submitSession(inst) {
 const name=inst.name.trim(),agent=findAgent(inst.selectedAgentId);
 if(!agent?.online||!name){toast("请选择在线 Agent，并输入 Session 名称");return;}
 if(state.sessions.some(s=>s.agentId===agent.id&&s.name===name)){toast("该节点已存在同名 Session");return;}
 inst.status="created";inst.createdSessionId=agent.id+":"+name;
 state.sessions.unshift({id:inst.createdSessionId,name,agentId:agent.id,status:"running",windows:1});
 emit("business.mock.confirmed",{operation:"session.create",sessionId:inst.createdSessionId});
 updatePlacements(inst.ref);
 addMessage("user","（组件操作）确认创建 Session："+name+" · "+agent.name);
 assistantStream("Session 已创建（Mock）。你可以在这里直接查看结果：\n\n"+
  directiveText({v:1,op:"render",component:"session.detail",input:{sessionId:inst.createdSessionId}})+
  "\n\n这一动作由表单明确提交；单纯渲染文本不会创建真实资源。");
}
function assistantStream(text) {
 state.streaming=true;$("send").disabled=true;
 const msg=addMessage("assistant","","streaming");
 const sizes=[7,13,5,19,11,29,17,9];let pos=0,count=0;
 const timer=setInterval(()=>{
  const amount=sizes[count++%sizes.length];pos=Math.min(text.length,pos+amount);
  msg.text=text.slice(0,pos);if(pos===text.length){msg.status="settled";clearInterval(timer);state.streaming=false;$("send").disabled=false;emit("stream.settled",{id:msg.id,bytes:text.length});}
  renderMessage(msg);
 },30);
}
function routeUser(text) {
 const parsed=parseText(text);
 const ref=parsed.find(x=>x.kind==="component"&&x.value.op==="reference");
 if(ref){
  const inst=state.instances.get(ref.value.ref);
  if(!inst||inst.component!==ref.value.component){assistantStream("这个历史组件引用已失效。请重新请求对应业务组件，当前不执行任何操作。");return;}
  if(inst.component==="agent.list"){
   const id=inst.selectedAgentId;
   if(!id){assistantStream("你发送了 Agent 列表，但还没有选择一个 Agent。请先选中节点。");return;}
   if(!findAgent(id)?.online){assistantStream("你选择的节点当前离线，无法创建 Session。");return;}
   openSessionForm(id);return;
  }
  assistantStream("我收到了组件引用 "+inst.ref+"。这是同一个实例，状态保持同步：\n\n"+referenceText(inst,ref.value.context||{}));return;
 }
 const lower=text.toLowerCase();
 if(/异常|非法|invalid|schema|malformed/.test(lower)){
  const fence=String.fromCharCode(96).repeat(3);
  assistantStream("下面是一个格式非法的指令，必须安全回退，而不是执行：\n\n"+fence+"nession-ui\n"+'{"v":1,"op":"execute","component":"session.create.form","extra":true}'+"\n"+fence+"\n\n原始文本仍然可查看。");return;
 }
 if(/重新|再看|之前|复用|reuse/.test(lower)){
  const inst=[...state.instances.values()].find(x=>x.component==="agent.list");
  if(inst){assistantStream("我重新呈现之前的 Agent 组件实例（不是复制业务状态）：\n\n"+referenceText(inst,{selectedAgentId:inst.selectedAgentId}));return;}
 }
 if(/git|diff|变更|代码/.test(lower)){assistantStream("这里是当前 Session 的 Git 变更（模拟数据）：\n\n"+directiveText({v:1,op:"render",component:"git.changes",input:{}}));return;}
 if(/session|会话/.test(lower)&&/创建|新建|create/.test(lower)){
  const inst=[...state.instances.values()].find(x=>x.component==="agent.list"&&x.selectedAgentId);
  openSessionForm(inst?.selectedAgentId||"beijing");return;
 }
 if(/session|会话/.test(lower)){assistantStream("目前的 Session 如下，你可以选择一条查看详情：\n\n"+directiveText({v:1,op:"render",component:"session.list",input:{}}));return;}
 assistantStream("当前有这些节点，你可以直接选择并继续操作：\n\n"+
 directiveText({v:1,op:"render",component:"agent.list",input:{status:"online"}})+
 "\n\n在对话中选择节点后，可以把这个组件发送给我，继续创建 Session。");
}
function submitText(text){
 const value=text.trim();if(!value||state.streaming)return;
 $("prompt").value="";addMessage("user",value);emit("composer.submit",{contentType:"text",length:value.length});
 routeUser(value);
}
function reset(){
 state.messages.length=0;state.instances.clear();state.placements.clear();state.semantic.clear();
 state.sessions=initialSessions.map(x=>({...x}));state.activeRef=null;state.activeMessage=null;state.events.length=0;state.messageCounter=0;state.refCounter=0;
 $("feed").replaceChildren();$("app").classList.add("is-empty");toggleInspector(false);inspect();$("prompt").focus();
}
$("composer").addEventListener("submit",ev=>{ev.preventDefault();submitText($("prompt").value);});
$("prompt").addEventListener("keydown",ev=>{if(ev.key==="Enter"&&!ev.shiftKey){ev.preventDefault();submitText(ev.currentTarget.value);}});
document.querySelectorAll("[data-prompt]").forEach(b=>b.addEventListener("click",()=>submitText(b.dataset.prompt)));
$("reset").addEventListener("click",reset);
$("show-invalid").addEventListener("click",()=>submitText("演示非法 schema"));
$("toggle-inspector").addEventListener("click",()=>toggleInspector($("inspector").hidden));
$("close-inspector").addEventListener("click",()=>toggleInspector(false));
document.querySelectorAll("[data-inspect-tab]").forEach(b=>b.addEventListener("click",()=>{state.inspectorTab=b.dataset.inspectTab;inspect();}));
window.__nessionConversationPrototype={state,parseText,directiveText,submitText,reset,contextFor};
inspect();
