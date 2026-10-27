import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const publisher = await readFile(new URL('../scripts/publish-prototypes.mjs', import.meta.url), 'utf8');
const fnStart=app.indexOf('function validPrototypeCatalog(');
const fnEnd=app.indexOf('async function loadPrototypeCatalog(',fnStart);
assert.ok(fnStart>0 && fnEnd>fnStart);
const valid = runInNewContext(
  'const PROTOTYPE_SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]+$/;\n' +
  app.slice(fnStart,fnEnd) + '\nvalidPrototypeCatalog'
);
const SHA='a'.repeat(40);
const item=(slug)=>({
  slug, preview:'prototypes/'+slug+'/index.html',
  source:'https://github.com/BestNathan/nession/blob/'+SHA+'/'+slug+'/index.html',
  assets:3,
});
const catalog=(entries)=>({
  schema_version:1,source:{branch:'prototype',sha:SHA},entries,
});

test('native Pages navigation owns the Prototypes route and homepage discovery',()=>{
  assert.match(index,/href="#\/prototypes" data-route="\/prototypes"/);
  assert.doesNotMatch(index,/href="prototypes\/"/);
  assert.match(app,/function renderPrototypes\(/);
  assert.match(app,/\x27\/prototypes\x27:renderPrototypes/);
  assert.match(app,/local\(\x27Browse interactive prototypes/);
  assert.match(app,/pageHead\(\x27PRODUCT \/ INTERACTIVE LAB\x27/);
  assert.match(styles,/\.prototype-card\{/);
  assert.match(styles,/\.prototype-teaser\{/);
  assert.match(publisher,/function integratedGalleryRedirect\(/);
  assert.match(publisher,/http-equiv="refresh" content="0;url=\.\.\/#\/prototypes"/);
});

test('catalog source and routes are exact, bounded and trusted',()=>{
  const items=[item('ai-workspace-2221'),item('terminal-fixed-cols-2487')];
  assert.equal(valid(catalog(items)),true);
  assert.equal(valid(catalog([items[0],items[0]])),false);
  assert.equal(valid(catalog([{...items[0],preview:'https://evil.example/'}])),false);
  assert.equal(valid(catalog([{...items[0],source:'https://github.com/BestNathan/nession/blob/other/file'}])),false);
  assert.equal(valid(catalog([{...items[0],slug:'../bad-1'}])),false);
  assert.equal(valid({...catalog(items),source:{branch:'main',sha:SHA}}),false);
  assert.equal(valid({...catalog(items),source:{branch:'prototype',sha:'prototype'}}),false);
  assert.equal(valid(catalog(Array.from({length:101},(_,i)=>item('example-'+i)))),false);
});

test('published mocks remain discoverable and source is secondary',()=>{
  assert.match(app,/Open interactive HTML/);
  assert.match(app,/new URL\(entry\.preview,document\.baseURI\)/);
  assert.match(app,/preview\.target='_blank'/);
  assert.match(app,/preview\.rel='noopener noreferrer'/);
  assert.match(app,/Open '\+info\.title\+' interactive HTML in a new tab/);
  assert.match(app,/View source/);
  assert.match(publisher,/Back to Nession prototype gallery/);
  assert.match(publisher,/View source ↗/);
  assert.doesNotMatch(app.slice(app.indexOf('function renderPrototypes('),app.indexOf('function renderAgents(')),/innerHTML/);
});
