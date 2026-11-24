import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assemblePages} from '../scripts/assemble.mjs';
import {computeArtifactManifest,verifyManifestShape,verifyArtifactFiles,
  writeArtifactManifest,sha256,MANIFEST_FILE} from '../scripts/artifact-manifest.mjs';
import {verifyPublishedArtifact} from '../scripts/verify-published-artifact.mjs';

const DATA={};
for(const name of ['site','workflows','knowledge','documents','mcp']){
 DATA[name]=JSON.stringify({schema_version:1,status:'available',name})+'\n';
}
async function fixture(){
 const base=await mkdtemp(join(tmpdir(),'pages-artifact-'));
 const ui=join(base,'ui'),data=join(base,'data'),out=join(base,'out');
 await mkdir(join(ui,'assets'),{recursive:true});
 await mkdir(join(data,'data'),{recursive:true});
 await writeFile(join(ui,'assets','index-abc.js'),
  'import{x}from"./App-def.js";const lazy=()=>import("./chunk-ghi.js");export default lazy;\n');
 await writeFile(join(ui,'assets','App-def.js'),'export const x=1;\n');
 await writeFile(join(ui,'assets','chunk-ghi.js'),'export const y=2;\n');
 await writeFile(join(ui,'index.html'),
  '<!doctype html><html><head><title>Nession</title>'+
  '<link rel="icon" href="./favicon.svg">'+
  '<link rel="stylesheet" href="./styles.css">'+
  '<script type="module" crossorigin src="./assets/index-abc.js"></script>'+
  '<link rel="modulepreload" crossorigin href="./assets/App-def.js"></head><body></body></html>\n');
 await writeFile(join(ui,'workflows.html'),
  '<!doctype html><html><head><title>GitHub Workflows</title>'+
  '<link rel="stylesheet" href="./workflows.css">'+
  '<script type="module" src="./assets/index-abc.js"></script></head><body></body></html>\n');
 await writeFile(join(ui,'styles.css'),"@import url('https://fonts.googleapis.com/css2?family=DM+Sans');\nbody{background:url('./banner.svg')}\n");
 await writeFile(join(ui,'workflows.css'),'body{color:#123}\n');
 await writeFile(join(ui,'banner.svg'),'<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
 await writeFile(join(ui,'favicon.svg'),'<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
 for(const [name,body] of Object.entries(DATA)) await writeFile(join(data,'data',name+'.json'),body);
 return {base,ui,data,out};
}
test('assembly copies validated UI and data into a fresh collision-checked output',async()=>{
 const f=await fixture();
 try{
  const result=await assemblePages({uiDir:f.ui,dataDir:f.data,outDir:f.out});
  assert.equal(result.dataFiles.length,5);
  for(const file of ['index.html','workflows.html','styles.css','workflows.css','favicon.svg',
    'assets/index-abc.js','data/site.json','data/mcp.json']){
   assert.ok(result.uiFiles.includes(file)||result.dataFiles.includes(file),file);
  }
  await assert.rejects(()=>readFile(join(f.out,'.vite','manifest.json')),/ENOENT/);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('assembly rejects symlinks, unknown artifacts, missing data and collisions',async()=>{
 const f=await fixture();
 try{
  await symlink(join(f.ui,'styles.css'),join(f.ui,'linked.css'));
  await assert.rejects(()=>assemblePages({uiDir:f.ui,dataDir:f.data,outDir:f.out}),/Symlink/);
  await rm(join(f.ui,'linked.css'));
  await writeFile(join(f.ui,'stray.txt'),'unknown');
  await assert.rejects(()=>assemblePages({uiDir:f.ui,dataDir:f.data,outDir:f.out}),/Unknown Pages UI artifact/);
  await rm(join(f.ui,'stray.txt'));
  await rm(join(f.data,'data','mcp.json'));
  await assert.rejects(()=>assemblePages({uiDir:f.ui,dataDir:f.data,outDir:f.out}),/exactly/);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('trusted artifact manifest covers entrypoints, dynamic imports and local CSS assets',async()=>{
 const f=await fixture();
 try{
  const {manifest}=await computeArtifactManifest(f.ui);
  verifyManifestShape(manifest);
  const paths=manifest.files.map(file=>file.path);
  assert.deepEqual(manifest.entrypoints,['index.html','workflows.html']);
  for(const file of ['assets/index-abc.js','assets/App-def.js','assets/chunk-ghi.js',
    'styles.css','workflows.css','favicon.svg','banner.svg']) assert.ok(paths.includes(file),file);
  const external=manifest.files.map(file=>file.path).filter(file=>/fonts\.googleapis/.test(file));
  assert.deepEqual(external,[]);
  await writeArtifactManifest(f.ui);
  const written=JSON.parse(await readFile(join(f.ui,MANIFEST_FILE),'utf8'));
  assert.equal(written.closure_sha256,manifest.closure_sha256);
  await verifyArtifactFiles(f.ui,written);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('manifest generation rejects external refs, missing chunks, traversal and unknown files',async()=>{
 const f=await fixture();
 try{
  await writeFile(join(f.ui,'index.html'),'<script src="https://evil.example/app.js"></script>');
  await assert.rejects(()=>computeArtifactManifest(f.ui),/External asset reference/);
  await writeFile(join(f.ui,'index.html'),
   '<link rel="stylesheet" href="./styles.css"><script src="./assets/index-abc.js"></script>');
  await rm(join(f.ui,'assets','chunk-ghi.js'));
  await assert.rejects(()=>computeArtifactManifest(f.ui),/ENOENT/);
  await writeFile(join(f.ui,'assets','chunk-ghi.js'),'export const y=2;\n');
  await writeFile(join(f.ui,'debug.map'),'{}');
  await assert.rejects(()=>computeArtifactManifest(f.ui),/Unknown Pages artifact|Unexpected asset type/);
  await rm(join(f.ui,'debug.map'));
  await writeFile(join(f.ui,'index.html'),
   '<link rel="stylesheet" href="../../etc/passwd"><script src="./assets/index-abc.js"></script>');
  await assert.rejects(()=>computeArtifactManifest(f.ui),/escapes the Pages artifact|Unexpected asset type/);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('manifest verifier rejects tampered bytes, bad paths and unknown closure',async()=>{
 const f=await fixture();
 try{
  const {manifest}=await computeArtifactManifest(f.ui);
  await writeArtifactManifest(f.ui);
  await writeFile(join(f.ui,'assets','chunk-ghi.js'),'export const y=3;\n');
  await assert.rejects(()=>verifyArtifactFiles(f.ui,manifest),/digest mismatch/);
  await writeFile(join(f.ui,'assets','chunk-ghi.js'),'tampered\n');
  await assert.rejects(()=>verifyArtifactFiles(f.ui,manifest),/size\/type mismatch/);
  await writeFile(join(f.ui,'assets','chunk-ghi.js'),'export const y=2;\n');
  assert.throws(()=>verifyManifestShape({
   ...manifest,files:manifest.files.map((file,index)=>index?file:{...file,path:'../escape.js'})}),/Unsafe/);
  assert.throws(()=>verifyManifestShape({...manifest,closure_sha256:'f'.repeat(64)}),/closure digest/);
  assert.throws(()=>verifyManifestShape({...manifest,entrypoints:['index.html']}),/entrypoints/);
  const duplicate=manifest.files[0];
  assert.throws(()=>verifyManifestShape({...manifest,files:[...manifest.files,duplicate]}),/Duplicate/);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
function toArrayBuffer(body){
 const copy=Uint8Array.from(body);
 return copy.buffer;
}
function fetcher(files){
 return async url=>{
  const path=new URL(url).pathname.replace(/^\//,'');
  const body=files[path];
  if(body===undefined)return {ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)};
  return {ok:true,status:200,arrayBuffer:async()=>toArrayBuffer(body)};
 };
}
test('anonymous HTTPS readback requires the trusted manifest digest and every compiled byte',async()=>{
 const f=await fixture();
 try{
  const written=await writeArtifactManifest(f.ui);
  const files={};
  for(const file of written.manifest.files) files[file.path]=await readFile(join(f.ui,file.path));
  files[MANIFEST_FILE]=Buffer.from(written.json);
  const fetchImpl=fetcher(files);
  const result=await verifyPublishedArtifact({base:'https://example.test',expectedManifestSha:written.sha256,
   revision:'a'.repeat(40),fetchImpl,attempts:1});
  assert.equal(result.files,written.manifest.files.length);
  await assert.rejects(()=>verifyPublishedArtifact({base:'https://example.test',
   expectedManifestSha:'f'.repeat(64),revision:'a'.repeat(40),fetchImpl,attempts:1}),/bounded readback/);
  const tampered={...files,[written.manifest.files.find(file=>file.path.endsWith('chunk-ghi.js')).path]:Buffer.from('tampered')};
  await assert.rejects(()=>verifyPublishedArtifact({base:'https://example.test',
   expectedManifestSha:written.sha256,revision:'a'.repeat(40),fetchImpl:fetcher(tampered),attempts:1}),/bounded readback/);
  const moved={schema_version:1,entrypoints:['index.html','workflows.html'],
   files:[{path:'../secret.js',sha256:'a'.repeat(64),bytes:1}],closure_sha256:'a'.repeat(64)};
  const movedBytes=Buffer.from(JSON.stringify(moved));
  const movedFiles={...files,[MANIFEST_FILE]:movedBytes};
  await assert.rejects(()=>verifyPublishedArtifact({base:'https://example.test',
   expectedManifestSha:sha256(movedBytes),revision:'a'.repeat(40),fetchImpl:fetcher(movedFiles),attempts:1}),/bounded readback/);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
