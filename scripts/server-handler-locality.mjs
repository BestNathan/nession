#!/usr/bin/env node
// Semantic locality gate (#1258). Canonical routes are parsed from routes.rs,
// never copied into a second metadata table.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const ROOT=process.cwd();
const FOLDER='crates/nession-server/src/server/handler';
const PATH=join(ROOT,FOLDER);
function fixture() {
  const files=new Map();
  for(const f of readdirSync(PATH).filter(f=>/^server_.*_v\d+\.rs$/.test(f)))
    files.set(f,readFileSync(join(PATH,f),'utf8'));
  return { routes:readFileSync(join(PATH,'routes.rs'),'utf8'),
    parent:readFileSync(join(PATH,'mod.rs'),'utf8'),
    websocket:readFileSync(join(ROOT,'crates/nession-server/src/server/websocket.rs'),'utf8'),files};
}
const fileName=(id,version)=>id.replace(/[.-]/g,'_')+'_v'+version+'.rs';
function check(input) {
  const errors=[];
  const fail=(ok,reason)=>{if(!ok)errors.push(reason)};
  const map=new Map(), seen=new Map(), expected=new Set();
  const modules=new Set([...input.parent.matchAll(/^mod (server_[a-z0-9_]+_v\d+);$/gm)].map(m=>m[1]+'.rs'));
  const arms=[];
  for(const line of input.routes.split('\n')){
    const s=line.trim();
    if(!/^"(server\.|control\.)/.test(s))continue;
    const m=/^"([^"]+)"\s*=>\s*"([^"]+)"\s*=>\s*(\d+)\s*=>\s*(.+)\s*=>\s*(.+),$/.exec(s);
    fail(!!m,'malformed route declaration: '+s);
    if(m)arms.push({wire:m[1],id:m[2],v:Number(m[3]),policy:m[4],target:m[5]});
  }
  fail(arms.length>0,'no Server routes parsed');
  fail((input.routes.match(/server_routes!\(/g)||[]).length===1,'routes.rs must have exactly one canonical route declaration');
  for(const a of arms){
    const key=a.id+'@v'+a.v, filename=fileName(a.id,a.v);
    fail(a.wire===a.id,'wire/identity mismatch: '+key);
    fail(a.wire.startsWith('server.'),'control/non-Server wire incorrectly modeled as versioned Unit: '+key);
    fail(a.v>0,'invalid Contract Version: '+key);
    fail(!map.has(key),'duplicate Unit × Version: '+key);
    map.set(key,a);
    const other=seen.get(filename);
    fail(!other||other===key,'canonical filename collision: '+other+' vs '+key+' -> '+filename);
    seen.set(filename,key);
    if(a.id==='server.session.relay.end'){
      // Relay mode consumes this wire in websocket.rs. Out of relay it is an idle no-op.
      fail(a.target==='Ok(HandlerAction::Reply(None))','relay.end idle fallback must not be a fake implementation');
      fail(input.websocket.includes('RELAY_END_WIRE')&&
        input.websocket.includes('ClientFrame::RelayEnd')&&
        input.websocket.includes('relay_end_inside_the_drain_window_ends_the_relay'),
        'relay.end active transition / regression missing in websocket.rs');
      continue;
    }
    expected.add(filename);
    const handler=/^handler\.(handle_[a-z0-9_]+)\(msg\)\.await$/.exec(a.target);
    fail(!!handler,'route must call exactly one leaf handler: '+key);
    const code=input.files.get(filename);
    fail(!!code,'missing implementation: '+filename);
    if(code&&handler){
      const names=[...code.matchAll(/async fn (handle_[a-z0-9_]+)\s*\(/g)].map(m=>m[1]);
      fail(names.length===1&&names[0]===handler[1],filename+' must implement only '+handler[1]+'; found '+names.join(','));
      fail(code.includes('impl ConnectionHandler'),filename+' missing ConnectionHandler implementation');
    }
    fail(modules.has(filename),'missing mod declaration: '+filename);
  }
  for(const filename of input.files.keys())fail(expected.has(filename),'orphan versioned handler file: '+filename);
  for(const filename of modules)fail(expected.has(filename),'orphan module declaration: '+filename);
  fail(!/^\s*(?:pub(?:\([^)]*\))?\s+)?async fn handle_(?!message|protocol_message)[a-z0-9_]+\s*\(/m.test(input.parent),
    'concrete Server Unit handler reintroduced into handler/mod.rs');
  fail(!input.parent.includes('server_routes!('),'duplicate route table in handler/mod.rs');
  fail(input.parent.includes('mod control;')&&input.parent.includes('mod relay;'),
    'control/relay mechanism must remain separate modules');
  for(const control of ['control.heartbeat','control.ping','control.pong'])
    fail(input.parent.includes('"'+control+'"'),'control dispatcher lost '+control);
  return errors;
}
function selftest(){
  const base=fixture(),valid=check(base);
  if(valid.length)throw Error('baseline broken: '+valid.join('; '));
  let count=0;
  function reject(name,mutate,needle){
    const f={...base,files:new Map(base.files)};
    mutate(f);
    const problems=check(f);
    if(!problems.some(x=>x.includes(needle)))
      throw Error('selftest '+name+' escaped gate: '+problems.join('; '));
    count++;
  }
  reject('missing',f=>f.files.delete('server_agent_register_v1.rs'),'missing implementation');
  reject('version',f=>{const v=f.files.get('server_agent_register_v1.rs');f.files.delete('server_agent_register_v1.rs');f.files.set('server_agent_register_v2.rs',v)},'missing implementation');
  reject('duplicate',f=>f.files.set('server_agent_list_v1.rs',f.files.get('server_agent_list_v1.rs')+'\nasync fn handle_agent_register() {}'),'must implement only');
  reject('orphan',f=>f.files.set('server_orphan_v1.rs',''),'orphan versioned');
  reject('module',f=>f.parent=f.parent.replace('mod server_agent_register_v1;',''),'missing mod');
  reject('monolith',f=>f.parent+='\nasync fn handle_wrong() {}\n','concrete Server Unit');
  const inject=(f,line)=>f.routes=f.routes.replace('server_routes!(handler, msg, payload;','server_routes!(handler, msg, payload;\n    '+line);
  reject('collision',f=>inject(f,'"server.session.capture.preview" => "server.session.capture.preview" => 1 => Query => handler.handle_client_session_capture_preview(msg).await,'),'canonical filename collision');
  reject('duplicate route',f=>inject(f,'"server.agent.register" => "server.agent.register" => 1 => Ordered => handler.handle_agent_register(msg).await,'),'duplicate Unit');
  reject('control as Unit',f=>inject(f,'"control.ping" => "control.ping" => 1 => Inline => handler.handle_client_auth(msg).await,'),'control/non-Server');
  reject('relay no-op change',f=>f.routes=f.routes.replace('=> Ok(HandlerAction::Reply(None)),','=> handler.handle_client_session_kill(msg).await,'),'relay.end idle fallback');
  console.log('server handler locality self-test OK ('+count+' negative mutations)');
}
try {
  if(process.argv.includes('--self-test'))selftest();
  else{
    const errors=check(fixture());
    if(errors.length){
      console.error('server handler locality FAIL:');
      for(const e of errors)console.error(' - '+e);
      console.error('Repair: change the canonical routes.rs declaration and its one versioned module; preserve the exceptional relay.end runtime owner.');
      process.exitCode=1;
    }else console.log('server handler locality OK');
  }
}catch(err){console.error('server handler locality ERROR: '+err.message);process.exitCode=2}
