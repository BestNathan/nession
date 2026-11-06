// #2514 Agent capability information architecture + process-scope smoke.
// Uses built-in Node VM and a minimal deterministic DOM; not Chromium or E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('./product-ia.css',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);
function createProduct(){
 const listeners={};
 const node=(tag='div',name='')=>{
   const result={
     tag,name,children:[],events:{},dataset:{},attributes:{},style:{},
     hidden:false,disabled:false,textContent:'',className:'',open:false,
     appendChild(item){this.children.push(item);return item},
     replaceChildren(...items){this.children=[...items]},
     setAttribute(k,v){this.attributes[k]=v},
     addEventListener(t,fn){this.events[t]=fn},
     focus(){},scrollIntoView(){},querySelector(){return null},
   };
   const classes=new Set();
   result.classList={
     add(s){classes.add(s)},remove(s){classes.delete(s)},
     contains(s){return classes.has(s)},
     toggle(s,b){const yes=b===undefined?!classes.has(s):b;if(yes)classes.add(s);else classes.delete(s)}
   };
   return result;
 };
 const ids={};
 for(const id of ['toast','agent-detail-content','tree','inspector','host','subhost',
   'status','snapshot','refresh','session-name','session-summary','notice','empty',
   'split','tree-count','diag-body','scenario','back','agent-capability','ia-app-back'])
   ids[id]=node('div',id);
 ids.scenario.value='linux';
 const shell=node('section','shell'),work=node('section','work'),
       terminal=node('section','term'),context=node('div','context'),
       sidebar=node('aside','sidebar');
 const page={addEventListener(type,fn){listeners['page-'+type]=fn}};
 const document={
   getElementById(id){assert.ok(ids[id],'unknown ID '+id);return ids[id]},
   createElement(tag){return node(tag)},
   createElementNS(_ns,tag){return node(tag)},
   createTextNode(value){const x=node('#text');x.textContent=value;return x},
   querySelector(sel){
     if(sel==='.shell')return shell;
     if(sel==='.ia-workspace-shell')return work;
     if(sel==='.ia-terminal-root')return terminal;
     if(sel==='.ia-terminal-context')return context;
     if(sel==='.ia-session-sidebar')return sidebar;
     if(sel==='[data-np-root]')return page;
     if(sel.startsWith('[data-pid=')){
       const pid=sel.match(/"(\d+)"/)?.[1];
       return ids.tree.children.find(x=>x.dataset.pid===pid)||null;
     }
     return null;
   },
   querySelectorAll(){return []},
   addEventListener(type,fn){listeners[type]=fn},
 };
 runInNewContext(script,{document,setTimeout:()=>0,clearTimeout:()=>{},navigator:{}});
 const action=(ia)=>listeners.click({target:{closest(){return {dataset:{ia}}}}});
 return {listeners,ids,shell,work,terminal,context,sidebar,action};
}
test('current product owner tree and candidate boundary',()=>{
 assert.match(html,/data-testid="web-layout"/);
 assert.match(html,/data-testid="sidebar"/);
 assert.match(html,/data-testid="shell-main"/);
 assert.match(html,/data-testid="workspace-shell"/);
 assert.match(html,/data-testid="workspace-tool-content"/);
 assert.match(html,/data-testid="workspace-tool-bar"/);
 assert.match(html,/data-testid="app-page-header"/);
 assert.match(html,/data-testid="terminal-surface"/);
 assert.match(html,/href="\.\/product-ia\.css"/);
 assert.match(css,/@container \(max-width:430px\)/);
 assert.match(css,/\.ia-workspace-content/);
 assert.doesNotMatch(html,/<div class="shellbar">/);
 assert.doesNotMatch(html,/data-other="Files"/);
 assert.doesNotMatch(html,/<strong>infra<\/strong>/,'infra fixture must never appear as selectable Session');
 assert.ok(html.indexOf('id="refresh"')>html.indexOf('class="stage"'),'refresh is a Process action');
 assert.equal((html.match(/id="back"/g)||[]).length,1,'internal Process Back still exists');
 assert.equal((html.match(/id="ia-app-back"/g)||[]).length,1,'shell App Back is separate');
});
test('current Session processes, App inspector, Terminal and unavailable state',()=>{
 const {listeners,ids,shell,terminal,context,sidebar,action}=createProduct();
 assert.equal(shell.dataset.surface,'workspace');
 assert.equal(shell.dataset.experience,'web');
 assert.equal(ids.host.textContent,'dev-linux-01');
 assert.ok(ids.tree.children.length>=5);
 assert.match(ids.inspector.children[0]?.textContent||'',/请选择一个进程查看运行命令和资源/);
 assert.ok(ids.tree.children.every(x=>x.dataset.pid!=='9001'),'infra-private never leaks');
 action('collapse');
 assert.ok(sidebar.classList.contains('collapsed'));
 action('expand');
 assert.ok(!sidebar.classList.contains('collapsed'));
 listeners['page-np:resize']({detail:{width:390}});
 assert.equal(shell.dataset.experience,'app');
 const worker=ids.tree.children.find(x=>x.dataset.pid==='3401');
 assert.ok(worker,'reparented worker is a separate root');
 worker.events.click();
 assert.ok(ids.split.classList.contains('mobile-detail'));
 ids.back.events.click();
 assert.ok(!ids.split.classList.contains('mobile-detail'));
 action('terminal');
 assert.equal(shell.dataset.surface,'terminal');
 assert.equal(terminal.hidden,false);
 action('context');
 assert.equal(context.hidden,false);
 action('workspace');
 assert.equal(shell.dataset.surface,'workspace');
 action('other-session');
 assert.equal(ids.empty.hidden,false,'another Session cannot hijack current Agent scope');
 assert.equal(ids.split.hidden,true);
 assert.ok(ids.tree.children.every(x=>x.dataset.pid!=='9001'));
 ids.scenario.events.change({target:{value:'offline'}});
 assert.equal(ids.refresh.disabled,true,'offline refresh disabled');
 assert.equal(ids.empty.hidden,false);
});
