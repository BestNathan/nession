import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NAV_ITEMS,currentNavRoute,mountNavigation} from '../navigation.js';

const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
const workflows=await readFile(new URL('../workflows.html',import.meta.url),'utf8');
const build=await readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8');

function harness(pathname,hash=''){
  const nav={children:[],replaceChildren(...links){this.children=links;}};
  const listeners={};
  const location={pathname,hash};
  const doc={
    querySelector:selector=>selector==='nav.navigation'?nav:null,
    createElement:tag=>({
      tagName:tag.toUpperCase(),dataset:{},attrs:{},
      setAttribute(name,value){this.attrs[name]=value;},
      removeAttribute(name){delete this.attrs[name];}
    }),
  };
  const win={location,addEventListener(name,cb){listeners[name]=cb;}};
  mountNavigation(doc,win);
  return {nav,location,listeners};
}

test('both entrypoints use exactly one canonical navigation inventory',()=>{
  for(const html of [index,workflows]){
    assert.match(html,/<nav class="navigation" aria-label="Main navigation"><\/nav>/);
    assert.match(html,/<script src="navigation\.js" type="module"><\/script>/);
    assert.doesNotMatch(html,/<a href="[^"]+" data-route=/);
  }
  assert.match(build,/'navigation\.js'/);
  assert.deepEqual(NAV_ITEMS.map(x=>x.label),[
    'Overview','AI Agents','Collaboration','Workflows',
    'Knowledge','Prototypes','Repository','Evidence'
  ]);
  assert.equal(new Set(NAV_ITEMS.map(x=>x.route)).size,NAV_ITEMS.length);
});

test('home and workflow page share the menu, but use correct cross-page hrefs',()=>{
  const home=harness('/nession/','#/prototypes');
  const standalone=harness('/nession/workflows.html');
  assert.deepEqual(home.nav.children.map(x=>x.textContent),standalone.nav.children.map(x=>x.textContent));
  assert.equal(home.nav.children.length,8);
  for(const [i,item] of NAV_ITEMS.entries()){
    assert.equal(home.nav.children[i].href,item.file||'#'+item.route);
    assert.equal(standalone.nav.children[i].href,item.file||'index.html#'+item.route);
  }
  assert.equal(home.nav.children[5].attrs['aria-current'],'page');
  assert.equal(standalone.nav.children[3].attrs['aria-current'],'page');
  assert.equal(standalone.nav.children[4].href,'index.html#/knowledge');
  assert.equal(standalone.nav.children[5].href,'index.html#/prototypes');
});

test('active route stays correct across nested and hash routes',()=>{
  assert.equal(currentNavRoute('/nession/','#/work/issue/42'),'/work');
  assert.equal(currentNavRoute('/nession/','#/knowledge?article=topic'),'/knowledge');
  assert.equal(currentNavRoute('/nession/workflows.html','#/prototypes'),'/workflows');
  const h=harness('/nession/','#/agents');
  assert.equal(h.nav.children[1].attrs['aria-current'],'page');
  h.location.hash='#/work/pr/123';
  h.listeners.hashchange();
  assert.equal(h.nav.children[2].attrs['aria-current'],'page');
  assert.equal(h.nav.children[1].attrs['aria-current'],undefined);
});
