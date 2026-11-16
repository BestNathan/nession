(function () {
"use strict";
const product=document.getElementById("product"), review=document.getElementById("review");
const svg={
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
 assistant:'<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M8 13h.01M16 13h.01M8 17h8"/>',
 tool:'<path d="m14.7 6.3 3-3a5 5 0 0 1-6.4 6.4L5 16l3 3 6.4-6.3a5 5 0 0 1 6.3-6.4l-3 3"/>',
 result:'<path d="m4 7 5 5-5 5M12 17h8"/>',
 system:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
 attachment:'<path d="m9 17 7-7a3 3 0 0 0-4-4l-8 8a5 5 0 0 0 7 7l9-9"/>',
 metadata:'<path d="M4 4h9l7 7-9 9-7-7z"/><circle cx="9" cy="9" r="1"/>',
 generic:'<path d="M7 3h9l5 5v13H7zM16 3v6h5M3 8v10"/>',
 invalid:'<path d="M12 3 2 21h20zM12 9v5M12 17h.01"/>'
};
const icon=k=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(svg[k]||svg.generic)+'</svg>';
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function rawObj(obj){return JSON.stringify(obj);}
function item(id,obj){return{id,raw:rawObj(obj)};}
const shared=[
item("r01",{type:"user",uuid:"u-01",timestamp:"2026-11-16T10:22:01Z",message:{role:"user",content:"请检查这次的 CI 异常。"}}),
item("r02",{type:"assistant",uuid:"a-02",timestamp:"2026-11-16T10:22:03Z",message:{role:"assistant",content:[{type:"thinking",thinking:"先确认最新 workflow 和失败 job。"}]}}),
item("r03",{type:"assistant",uuid:"a-03",timestamp:"2026-11-16T10:22:05Z",message:{role:"assistant",content:[{type:"tool_use",id:"toolu_11",name:"Bash",input:{command:"gh run list --limit 5"}}]}}),
item("r04",{type:"user",uuid:"u-04",timestamp:"2026-11-16T10:22:06Z",message:{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_11",content:"build / test / deploy: test failed"}]}}),
item("r05",{type:"assistant",uuid:"a-05",timestamp:"2026-11-16T10:22:09Z",message:{role:"assistant",content:[{type:"text",text:"失败集中在测试阶段；接下来检查日志。"}]}}),
item("r06",{type:"system",subtype:"turn_duration",timestamp:"2026-11-16T10:22:10Z",durationMs:4900}),
item("r07",{type:"attachment",timestamp:"2026-11-16T10:22:12Z",attachment:{type:"hook_permission_decision",hook:"PreToolUse",decision:"allow"}}),
item("r08",{type:"ai-title",timestamp:"2026-11-16T10:22:13Z",title:"排查 CI 测试失败"}),
item("r09",{type:"new-runtime-diagnostic",subtype:"context-probe-v2",timestamp:"2026-11-16T10:22:14Z",payload:{trace:{frames:[1,2,3]},status:"future",unknownNestedField:{hello:"world"}}}),
{id:"r10",raw:'{"type": "user", "message": {"content": "partial text", }'},
item("r11",{type:"user",timestamp:"2026-11-16T10:22:17Z",message:{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_99",content:"Large, preserved source: "+("line content · ".repeat(1800))}]}})
];
const side=[
item("s01",{type:"assistant",timestamp:"2026-11-16T10:22:02Z",message:{role:"assistant",content:[{type:"text",text:"Subagent: checking file-level changes."}]}}),
item("s02",{type:"progress",subtype:"agent",timestamp:"2026-11-16T10:22:07Z",data:{status:"working",toolUseID:"s-tool-9"}}),
item("s03",{type:"summary",timestamp:"2026-11-16T10:22:11Z",summary:"Reviewed 12 files"})
];
const s={width:1180,mode:"web",session:"dev",transcript:"primary",depth:"timeline",loadedOlder:false,expanded:null,rawId:null,rawMode:"tree",extra:[],notice:""};
const transcripts=[{id:"primary",title:"排查 CI 测试失败",subtitle:"Session · primary transcript"},{id:"side",title:"agent-7c2",subtitle:"Subagent · sidechain"}];
function list(){return(s.transcript==="primary"?shared.concat(s.extra):side);}
function visible(){const all=list();return s.loadedOlder?all:all.slice(Math.max(0,all.length-7));}
function decode(r){try{return JSON.parse(r.raw);}catch{return null;}}
function blocks(o){const c=o?.message?.content;return Array.isArray(c)?c:(typeof c==="string"?[{type:"text",text:c}]:[]);}
function classify(r){
const o=decode(r);
if(!o)return{kind:"invalid",title:"Raw text",summary:"无法解析 JSON；原始记录仍然保留",detail:"JSON 语法错误。此记录可以在 Raw 中查看原始文本。"};
const bs=blocks(o), b=bs[0],type=o.type||"record", sub=o.subtype;
if(type==="user"&&b?.type==="tool_result")return{kind:"result",title:"Tool result",summary:"↳ "+(b.tool_use_id||"tool_result")+" · "+String(b.content||"").slice(0,95),detail:JSON.stringify(b,null,2)};
if(type==="user")return{kind:"user",title:"User",summary:typeof o.message?.content==="string"?o.message.content:bs.map(x=>x.text||x.type).join(" · "),detail:typeof o.message?.content==="string"?o.message.content:JSON.stringify(bs,null,2)};
if(type==="assistant"){
const use=bs.find(x=>x.type==="tool_use"),thinking=bs.find(x=>x.type==="thinking"),txt=bs.filter(x=>x.type==="text").map(x=>x.text).join("\n");
if(use)return{kind:"tool",title:use.name||"Tool use",summary:use.input?.command||JSON.stringify(use.input||{}),detail:"Tool "+(use.id||"")+"\n"+JSON.stringify(use.input||{},null,2)};
if(thinking)return{kind:"assistant",title:"Assistant · thinking",summary:thinking.thinking||"Reasoning content",detail:thinking.thinking||""};
return{kind:"assistant",title:"Assistant",summary:txt||"Assistant message",detail:txt||JSON.stringify(bs,null,2)}
}
if(type==="system")return{kind:"system",title:"System · "+(sub||"event"),summary:typeof o.durationMs==="number"?"Duration "+o.durationMs+" ms":(sub||"System event"),detail:JSON.stringify(o,null,2)};
if(type==="attachment")return{kind:"attachment",title:"Attachment · "+(o.attachment?.type||sub||"content"),summary:JSON.stringify(o.attachment||{}).slice(0,100),detail:JSON.stringify(o.attachment||o,null,2)};
if(["ai-title","last-prompt","mode","permission-mode","pr-link","agent-name","atis-latch","cost-state","worktree-state"].includes(type))return{kind:"metadata",title:type,summary:o.title||o.value||"Session metadata",detail:JSON.stringify(o,null,2)};
if(type==="progress")return{kind:"system",title:"Progress"+(sub?" · "+sub:""),summary:JSON.stringify(o.data||{}).slice(0,110),detail:JSON.stringify(o,null,2)};
if(type==="summary")return{kind:"metadata",title:"Summary",summary:o.summary||"",detail:JSON.stringify(o,null,2)};
return{kind:"generic",title:type+(sub?" · "+sub:""),summary:"原始记录 · "+Object.keys(o).filter(x=>!["type","subtype","timestamp"].includes(x)).join(" / "),detail:"此记录没有专用渲染器。查看 Raw 可读取完整内容。"};
}
function time(r){const o=decode(r);return o?.timestamp?o.timestamp.slice(11,19):"";}
function recordRow(r){const m=classify(r),expanded=s.expanded===r.id;return '<div class="record" data-record="'+esc(r.id)+'"><div class="record-title"><button class="rec-main" type="button" data-act="expand" data-id="'+esc(r.id)+'" aria-expanded="'+expanded+'" aria-label="展开 '+esc(m.title)+'"><span class="rec-icon">'+icon(m.kind)+'</span><span class="rec-copy"><span class="rec-label">'+esc(m.title)+'</span><span class="rec-preview">'+esc(m.summary)+'</span></span><span class="rec-time">'+esc(time(r))+'</span></button><button class="raw-button" data-act="raw" data-id="'+esc(r.id)+'" aria-label="查看 '+esc(m.title)+' 的 Raw JSON">Raw</button></div>'+(expanded?'<div class="rec-details"><span class="muted">Record '+esc(r.id)+'</span><pre>'+esc(m.detail)+'</pre></div>':"")+'</div>';}
function treeNode(value,key,depth){if(depth>30)return'<span>…</span>';const k=key===null?"":'<span class="raw-key">'+esc(key)+': </span>';
if(value!==null&&typeof value==="object"){const keys=Array.isArray(value)?value.map((_,i)=>i):Object.keys(value);return '<details '+(depth<2?"open":"")+'><summary>'+k+(Array.isArray(value)?"Array("+value.length+")":"Object("+keys.length+")")+'</summary>'+keys.map(x=>treeNode(value[x],String(x),depth+1)).join("")+'</details>';}
return'<div class="raw-primitive">'+k+'<span class="raw-value">'+esc(JSON.stringify(value))+'</span></div>';}
function rawPanel(){if(!s.rawId)return"";const r=list().find(x=>x.id===s.rawId);if(!r)return"";const value=decode(r),meta=classify(r),treeEnabled=value!==null;
return'<div class="raw-overlay" role="presentation"><section class="raw-panel" role="dialog" aria-modal="true" aria-label="Raw record '+esc(r.id)+'"><div class="raw-head"><button type="button" data-act="close-raw" aria-label="关闭 Raw">‹</button><h2>Raw · '+esc(meta.title)+'</h2><button type="button" data-act="copy" aria-label="复制原始 JSONL 行">复制</button><button type="button" data-act="close-raw" aria-label="关闭 Raw">×</button></div><div class="raw-mode">'+(treeEnabled?'<button data-act="tree" class="'+(s.rawMode==="tree"?"active":"")+'">JSON 树</button>':"")+'<button data-act="text" class="'+(s.rawMode==="text"||!treeEnabled?"active":"")+'">原始文本</button></div><div class="raw-body">'+(s.rawMode==="tree"&&treeEnabled?treeNode(value,null,0):'<pre>'+esc(r.raw)+'</pre>')+'</div><div class="raw-foot">Record '+esc(r.id)+' · '+r.raw.length+' chars · '+(treeEnabled?"保留原始文本；树形视图仅改变展示":"无法解析 JSON；显示原始文本")+'</div></section></div>';}
function sideNav(){return'<aside class="shell-side"><strong>Nession</strong><small>SESSION NAVIGATION</small><button data-act="session" data-session="dev" class="'+(s.session==="dev"?"active":"")+'">● dev · nession</button><button data-act="session" data-session="review" class="'+(s.session==="review"?"active":"")+'">○ review · nession</button><div class="sidebar-note">WebLayout · Session navigation<br/>Mock context only</div></aside>';}
function transcriptNav(){return'<div class="transcript-list"><div class="list-h">Transcripts</div><div class="transcripts-scroll">'+transcripts.map(t=>'<button class="transcript-link '+(s.transcript===t.id?"selected":"")+'" data-act="transcript" data-id="'+esc(t.id)+'"><span class="rec-icon">'+icon(t.id==="primary"?"assistant":"tool")+'</span><span class="txt"><strong>'+esc(t.title)+'</strong><span class="subtle">'+esc(t.subtitle)+'</span></span></button>').join("")+'</div></div>';}
function timeline(){const v=visible(),all=list();const t=transcripts.find(x=>x.id===s.transcript);return'<div class="timeline"><div class="timeline-head"><strong>'+esc(t.title)+'</strong><span class="count">'+v.length+' / '+all.length+' records</span></div><div class="timeline-scroll">'+(!s.loadedOlder&&all.length>v.length?'<div class="load-wrap"><button class="secondary-button" data-act="older">加载更早记录 · '+(all.length-v.length)+'</button></div>':'')+'<div class="records">'+v.map(recordRow).join("")+'</div>'+(s.extra.length?'<div class="empty">模拟新增的记录已追加；之前加载的记录保留。</div>':"")+'</div></div>';}
function render(){
s.mode=s.width<=430?"app":"web";product.dataset.mode=s.mode;product.dataset.depth=s.rawId?"raw":s.depth;
const appTitle=s.rawId?"Raw record":s.depth==="list"?"Claude Code":s.depth==="timeline"?"Transcripts":"Claude Code";
product.innerHTML=sideNav()+'<div class="mainwork">'+(s.mode==="app"?'<div class="app-head"><button data-act="back" aria-label="返回上一层">‹</button><span>'+esc(appTitle)+'</span></div>':"")+'<div class="capability"><div class="cap-top"><h1>Claude Code</h1><small>'+esc(s.session==='dev'?'dev / nession':'review / nession')+'</small></div><nav class="cap-tabs" aria-label="Claude view"><button data-act="other">Conversations</button><button class="current" aria-current="page">Transcripts</button><button data-act="other">Memory</button><button data-act="other">MCP</button><button data-act="other">Configuration</button></nav><div class="cap-content">'+transcriptNav()+timeline()+'</div></div><div class="dock"><button data-act="terminal">⌘ Terminal</button><button class="current">Claude Code</button></div></div>'+rawPanel();
document.getElementById("inspector").textContent=JSON.stringify({experience:s.mode,width:s.width,session:s.session,transcript:s.transcript,depth:product.dataset.depth,sourceRecords:list().length,visibleRecords:visible().length,expanded:s.expanded,rawId:s.rawId,rawMode:s.rawMode},null,2);
document.getElementById("fixture-info").textContent=s.notice||"只使用内存中的模拟 JSONL。";
}
function resetSelection(){s.transcript="primary";s.depth=s.mode==="app"?"list":"timeline";s.loadedOlder=false;s.rawId=null;s.expanded=null;s.rawMode="tree";s.extra=[];}
function back(){if(s.rawId){s.rawId=null;}else if(s.mode==="app"&&s.depth==="timeline"){s.depth="list";s.expanded=null;}else{s.notice="回到 Session Terminal（原型仅显示 Claude Workspace）。";}render();}
product.addEventListener("click",e=>{
const b=e.target.closest("button");if(!b||!product.contains(b))return;
const act=b.dataset.act,id=b.dataset.id;
if(act==="session"){if(s.session!==b.dataset.session){s.session=b.dataset.session;resetSelection();s.notice="Session changed; previous Transcript and Raw selection cleared.";}render();return;}
if(act==="transcript"){s.transcript=id;s.loadedOlder=false;s.expanded=null;s.rawId=null;s.depth="timeline";render();return;}
if(act==="older"){s.loadedOlder=true;render();return;}
if(act==="expand"){s.expanded=s.expanded===id?null:id;render();return;}
if(act==="raw"){s.rawId=id;s.rawMode=decode(list().find(r=>r.id===id))===null?"text":"tree";render();return;}
if(act==="close-raw"||act==="back"){back();return;}
if(act==="tree"||act==="text"){s.rawMode=act;render();return;}
if(act==="copy"){const record=list().find(r=>r.id===s.rawId);if(record){if(navigator.clipboard?.writeText){navigator.clipboard.writeText(record.raw).then(()=>{s.notice="已复制原始记录";render();}).catch(()=>{s.notice="浏览器不允许自动复制；可切换原始文本手动选择。";render();});}else{s.rawMode="text";s.notice="当前浏览器无 Clipboard API，请手动复制原始文本。";render();}}return;}
if(act==="other"||act==="terminal"){s.notice="当前原型只覆盖 Claude Transcripts；其他能力保留现有产品行为。";render();}
});
review.addEventListener("np:resize",e=>{s.width=e.detail.width;s.mode=s.width<=430?"app":"web";s.depth=s.mode==="app"?"list":"timeline";s.rawId=null;s.expanded=null;render();});
document.getElementById("append-fixture").addEventListener("click",()=>{s.extra.push(item("new-"+(s.extra.length+1),{type:"future-run-status",subtype:"new-upstream-event",timestamp:"2026-11-16T10:22:20Z",payload:{sequence:s.extra.length+1}}));s.notice="Added a new unknown record; older pages remain loaded.";render();});
document.getElementById("switch-fixture").addEventListener("click",()=>{s.session=s.session==="dev"?"review":"dev";resetSelection();s.notice="Fixture Session switched; old record selection invalidated.";render();});
render();
})();