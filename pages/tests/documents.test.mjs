import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DOCUMENT_CATALOG,loadDocuments,validPublicDocuments,unavailableDocuments}
  from '../scripts/documents-project.mjs';
import {documentsHref,documentsRoute,validDocumentsSnapshot,filterDocuments,renderDocuments}
  from '../documents.js';
import {NAV_ITEMS} from '../navigation.js';

const SHA='a'.repeat(40);
const AT='2026-11-10T10:00:00.000Z';
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'nession-pages-documents-'));
  for(const doc of DOCUMENT_CATALOG){
    const path=join(root,doc.path);
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,'# '+doc.title+'\n\nA **canonical** reference.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  }
  return root;
}
test('curated technical Documents project exact main source and reject missing provenance',async()=>{
  const root=await fixture();
  try{
    assert.deepEqual(DOCUMENT_CATALOG.map(x=>x.path).slice(0,3),[
      'docs/architecture/protocol.md','docs/architecture/protocol-identity.md',
      'docs/architecture/mcp.md']);
    const projected=await loadDocuments({directory:root,sha:SHA,generatedAt:AT});
    assert.equal(projected.status,'available');
    assert.equal(projected.source.sha,SHA);
    assert.equal(projected.documents.length,DOCUMENT_CATALOG.length);
    assert.ok(projected.documents.every(x=>x.source===
      'https://github.com/BestNathan/nession/blob/'+SHA+'/'+x.path));
    assert.equal(validPublicDocuments(projected),true);
    assert.equal(validDocumentsSnapshot(projected),true);
    const unknown=await loadDocuments({directory:root,generatedAt:AT});
    assert.deepEqual(unknown,unavailableDocuments(AT));
    assert.equal(validDocumentsSnapshot(unknown),true);
    const poisoned=structuredClone(projected);
    poisoned.documents[0].path='../.env';
    assert.equal(validDocumentsSnapshot(poisoned),false);
    assert.equal(validPublicDocuments(poisoned),false);
    const spoofed=structuredClone(projected);
    spoofed.documents[0].source='https://evil.example/file.md';
    assert.equal(validDocumentsSnapshot(spoofed),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('Documents build fails closed for missing, symlinked or oversized curated sources',async()=>{
  const root=await fixture();
  try{
    await rm(join(root,DOCUMENT_CATALOG[0].path));
    await assert.rejects(loadDocuments({directory:root,sha:SHA,generatedAt:AT}));
    await writeFile(join(root,DOCUMENT_CATALOG[0].path),'x'.repeat(160001));
    await assert.rejects(loadDocuments({directory:root,sha:SHA,generatedAt:AT}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('deep links, catalog filtering and app integration use canonical Documents route',async()=>{
  const doc=DOCUMENT_CATALOG[2];
  assert.equal(documentsHref(doc.path),'#/documents?doc='+encodeURIComponent(doc.path));
  assert.equal(documentsHref('../../secret'),'#/documents');
  assert.equal(documentsRoute('#/documents?doc='+encodeURIComponent(doc.path)).doc,doc.path);
  assert.equal(documentsRoute('#/documents?doc=../../secret').invalid,true);
  const docs=DOCUMENT_CATALOG.map(x=>({...x,body:'# '+x.title}));
  assert.equal(filterDocuments(docs,{query:'MCP'}).length,1);
  assert.equal(filterDocuments(docs,{category:'Protocols'}).length,2);
  assert.ok(NAV_ITEMS.some(x=>x.route==='/documents'&&x.label==='Documents'));
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const build=await readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8');
  assert.match(app,/renderDocuments\(root,documentsSnapshot,location\.hash\)/);
  assert.match(app,/loadDocumentsCatalog/);
  assert.match(build,/data\/documents\.json/);
  assert.match(build,/'documents\.js'/);
});

class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.nodes=[];this.attrs={};this.text='';}
  set textContent(value){this.text=String(value);this.nodes=[];}
  get textContent(){return this.text+this.nodes.map(x=>x.textContent||'').join('');}
  set className(value){this.classes=value;}
  setAttribute(name,value){this.attrs[name]=value;}
  addEventListener(){}
  append(...nodes){this.nodes.push(...nodes);}
  replaceChildren(...nodes){this.text='';this.nodes=nodes;}
  get lastChild(){return this.nodes.at(-1);}
}
function descendants(node){
  return [node,...(node.nodes||[]).flatMap(descendants)];
}
test('Documents reader renders Markdown as inert text, with tables and safe links',async()=>{
  const root=await fixture();
  const original=globalThis.document;
  globalThis.document={createElement:t=>new Element(t),
    createTextNode:s=>({textContent:s})};
  try{
    const data=await loadDocuments({directory:root,sha:SHA,generatedAt:AT});
    const target=data.documents[0];
    target.body='# Protocol\n\n<script>alert(1)</script>\n\n'+
      '| Heading | Value |\n| --- | --- |\n| A | B |\n\n'+
      '[unsafe](javascript:alert(1)) [MCP](mcp.md)\n\n'+
      '\x60\x60\x60js\nconsole.log(1)\n\x60\x60\x60';
    const ui=new Element('main');
    renderDocuments(ui,data,documentsHref(target.path));
    const elements=descendants(ui);
    assert.ok(elements.some(x=>x.tagName==='TABLE'));
    assert.ok(elements.some(x=>x.tagName==='PRE'));
    assert.ok(elements.some(x=>x.textContent?.includes('<script>alert(1)</script>')));
    assert.equal(elements.some(x=>x.tagName==='SCRIPT'),false);
    const anchors=elements.filter(x=>x.tagName==='A');
    assert.ok(anchors.some(x=>x.href===documentsHref('docs/architecture/mcp.md')));
    assert.equal(anchors.some(x=>x.href?.startsWith('javascript:')),false);
  }finally{
    globalThis.document=original;
    await rm(root,{recursive:true,force:true});
  }
});
