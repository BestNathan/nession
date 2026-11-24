import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NAV_ITEMS,currentNavRoute,navHref} from '../src/app/navigation.ts';

const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
const workflows=await readFile(new URL('../workflows.html',import.meta.url),'utf8');
const shell=await readFile(new URL('../src/layouts/Shell.tsx',import.meta.url),'utf8');
const build=await readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8');
const assemble=await readFile(new URL('../scripts/assemble.mjs',import.meta.url),'utf8');

test('both entrypoints use exactly one canonical navigation inventory',()=>{
  for(const [html,entry] of [[index,'main'],[workflows,'workflows-main']]){
    assert.match(html,/<nav class="navigation" aria-label="Main navigation"><\/nav>/);
    assert.match(html,new RegExp('<script type="module" src="/src/app/'+entry+'\\.tsx"></script>'));
    assert.doesNotMatch(html,/<a href="[^"]+" data-route=/);
  }
  assert.match(shell,/NAV_ITEMS\.map/);
  assert.match(shell,/navHref\(item, standalone\)/);
  assert.match(shell,/aria-current=\{active === item\.route \? 'page' : undefined\}/);
  assert.match(build,/assemblePages/);
  assert.match(assemble,/'styles\.css'/);
  assert.deepEqual(NAV_ITEMS.map(x=>x.label),[
    'Overview','AI Agents','Collaboration','Workflows',
    'Knowledge','Documents','Prototypes','Repository','Evidence'
  ]);
  assert.equal(new Set(NAV_ITEMS.map(x=>x.route)).size,NAV_ITEMS.length);
});

test('home and workflow page share the menu, but use correct cross-page hrefs',()=>{
  const home=NAV_ITEMS.map(item=>navHref(item,false));
  const standalone=NAV_ITEMS.map(item=>navHref(item,true));
  assert.equal(home.length,9);
  for(const [i,item] of NAV_ITEMS.entries()){
    assert.equal(home[i],item.file||'#'+item.route);
    assert.equal(standalone[i],item.file||'index.html#'+item.route);
  }
  assert.equal(currentNavRoute('/nession/','#/prototypes'),'/prototypes');
  assert.equal(currentNavRoute('/nession/workflows.html'),'/workflows');
  assert.equal(standalone[4],'index.html#/knowledge');
  assert.equal(standalone[5],'index.html#/documents');
  assert.equal(standalone[6],'index.html#/prototypes');
});

test('active route stays correct across nested and hash routes',()=>{
  assert.equal(currentNavRoute('/nession/','#/work/issue/42'),'/work');
  assert.equal(currentNavRoute('/nession/','#/agents/developer/dev-qwen-01?window=30d'),'/agents');
  assert.equal(currentNavRoute('/nession/','#/agents?window=30d'),'/agents');
  assert.equal(currentNavRoute('/nession/','#/knowledge?article=topic'),'/knowledge');
  assert.equal(currentNavRoute('/nession/','#/documents?doc=docs%2Farchitecture%2Fmcp.md'),'/documents');
  assert.equal(currentNavRoute('/nession/','#/documents/protocol?protocol=git.status&v=2'),'/documents');
  assert.equal(currentNavRoute('/nession/','#/documents/mcp?tool=nession_server_list_agents'),'/documents');
  assert.equal(currentNavRoute('/nession/workflows.html','#/prototypes'),'/workflows');
  assert.equal(currentNavRoute('/nession/','#/agents'),'/agents');
  assert.equal(currentNavRoute('/nession/','#/work/pr/123'),'/work');
});
