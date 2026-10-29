// #2031: durable shadow inbox for authenticated Acceptance evidence events.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const REPO='BestNathan/nession', SHA=/^[a-f0-9]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
export const SOURCE_WORKFLOWS=new Map([
  ['.github/workflows/acceptance-orchestrator.yml','Acceptance / Orchestrator'],
  ['.github/workflows/ci-run-store-fixture-evidence.yml','CI / Run Store Fixture Evidence'],
  ['.github/workflows/e2e-tests.yml','E2E / Tests'],
  ['.github/workflows/e2e-full-regression.yml','E2E / Full Regression'],
  ['.github/workflows/deploy-pages.yml','Deploy / Public Pages'],
]);
const fail=reason=>{throw Error('acceptance-event-relay: '+reason)};
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function verifyWebhook(raw,signature,secret){
  if(!Buffer.isBuffer(raw)||!raw.length||raw.length>1048576||
    typeof secret!=='string'||secret.length<32||
    !/^sha256=[a-f0-9]{64}$/.test(signature??''))return false;
  const supplied=Buffer.from(signature.slice(7),'hex');
  const expected=createHmac('sha256',secret).update(raw).digest();
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}

export function attestSource(payload,live){
  const p=payload?.workflow_run;
  if(payload?.action!=='completed'||payload?.repository?.full_name!==REPO||
    !p||!live||!positive(p.id)||!positive(p.run_attempt)||
    !SOURCE_WORKFLOWS.has(live.path)||
    p.id!==live.id||p.run_attempt!==live.run_attempt||
    p.path!==live.path||p.name!==live.name||
    live.name!==SOURCE_WORKFLOWS.get(live.path)||
    p.head_sha!==live.head_sha||!SHA.test(live.head_sha??'')||
    p.event!==live.event||p.head_branch!==live.head_branch||
    live.event!=='push'||live.head_branch!=='main'||
    live.status!=='completed'||live.conclusion!=='success'||
    p.conclusion!=='success'||
    live.repository?.full_name!==REPO||live.head_repository?.full_name!==REPO||
    p.head_repository?.full_name!==REPO)return null;
  return {repo:REPO,source_run_id:live.id,source_attempt:live.run_attempt,
    source_path:live.path,target_sha:live.head_sha,stage:'post-merge'};
}

// SQLite is private durable state on the relay host; Git orphan Store CAS
// does not provide a live queue/lease or crash-safe delayed event timer.
export class DurableInbox{
  constructor(file){
    if(!file||(file===':memory:'&&process.env.GITHUB_ACTIONS==='true'))
      fail('persistent SQLite file required on GitHub runners');
    this.db=new DatabaseSync(file,{timeout:5000});
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"+
      "CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,digest TEXT NOT NULL,at INTEGER NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS tasks("+
      "id TEXT PRIMARY KEY,repo TEXT NOT NULL,issue INTEGER NOT NULL,"+
      "target_sha TEXT NOT NULL,source_run_id INTEGER NOT NULL,"+
      "source_attempt INTEGER NOT NULL,source_path TEXT NOT NULL,"+
      "stage TEXT NOT NULL,contract_digest TEXT NOT NULL,"+
      "status TEXT NOT NULL CHECK(status IN ('pending','dispatching','confirmed','uncertain')),"+
      "attempts INTEGER NOT NULL DEFAULT 0,due_at INTEGER NOT NULL,"+
      "lease_until INTEGER,last_error TEXT,confirmed_at INTEGER);"+
      "CREATE INDEX IF NOT EXISTS task_due ON tasks(status,due_at);");
  }
  close(){this.db.close()}
  tx(fn){
    this.db.exec('BEGIN IMMEDIATE');
    try{const x=fn();this.db.exec('COMMIT');return x}
    catch(e){this.db.exec('ROLLBACK');throw e}
  }
  record(delivery,raw,source,eligible,now=Date.now()){
    if(!/^[0-9a-f-]{36}$/i.test(delivery??'')||
      !Buffer.isBuffer(raw)||!source||!Array.isArray(eligible)||
      !Number.isSafeInteger(now))fail('invalid delivery');
    return this.tx(()=>{
      const hash=sha256(raw);
      const old=this.db.prepare('SELECT digest FROM deliveries WHERE id=?').get(delivery);
      if(old){
        if(old.digest!==hash)fail('conflicting webhook delivery ID');
        return {duplicate:true,added:0};
      }
      this.db.prepare('INSERT INTO deliveries(id,digest,at) VALUES(?,?,?)').run(delivery,hash,now);
      let added=0;
      for(const item of eligible){
        if(!positive(item.issue)||!/^[a-f0-9]{64}$/.test(item.contract_digest??'')||
          source.repo!==REPO||!SHA.test(source.target_sha??'')||
          !positive(source.source_run_id)||!positive(source.source_attempt)||
          source.stage!=='post-merge'||!SOURCE_WORKFLOWS.has(source.source_path))
          fail('invalid attested task identity');
        const id=sha256(JSON.stringify([source.repo,source.source_run_id,
          source.source_attempt,source.target_sha,item.issue,source.stage,item.contract_digest]));
        const change=this.db.prepare(
          "INSERT OR IGNORE INTO tasks(id,repo,issue,target_sha,source_run_id,source_attempt,"+
          "source_path,stage,contract_digest,status,due_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)")
          .run(id,source.repo,item.issue,source.target_sha,source.source_run_id,
            source.source_attempt,source.source_path,source.stage,item.contract_digest,now);
        added+=Number(change.changes);
      }
      return {duplicate:false,added};
    });
  }
  // A lost dispatcher cannot blindly retry an API POST: a timeout may have
  // created a GitHub Actions run. An expired lease becomes UNCERTAIN instead.
  claim(now=Date.now(),lease=60000){
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(lease)||
      lease<10000||lease>300000)fail('invalid lease');
    return this.tx(()=>{
      this.db.prepare(
        "UPDATE tasks SET status='uncertain',last_error='dispatch lease expired' "+
        "WHERE status='dispatching' AND lease_until<=?").run(now);
      const row=this.db.prepare(
        "SELECT * FROM tasks WHERE status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 1").get(now);
      if(!row)return null;
      this.db.prepare(
        "UPDATE tasks SET status='dispatching',attempts=attempts+1,lease_until=? WHERE id=? AND status='pending'")
        .run(now+lease,row.id);
      return {...row,status:'dispatching',attempts:row.attempts+1};
    });
  }
  uncertain(id,reason){
    return this.db.prepare(
      "UPDATE tasks SET status='uncertain',last_error=?,lease_until=NULL WHERE id=? AND status='dispatching'")
      .run(String(reason).slice(0,200),id).changes===1;
  }
  confirm(id,now=Date.now()){
    return this.db.prepare(
      "UPDATE tasks SET status='confirmed',confirmed_at=?,lease_until=NULL "+
      "WHERE id=? AND status IN ('dispatching','uncertain')").run(now,id).changes===1;
  }
  // Only call after independent proof the original POST was never delivered;
  // 403/429/5xx/timeouts are not themselves such evidence.
  requeueKnownUnsent(id,dueAt){
    if(!Number.isSafeInteger(dueAt))fail('invalid next due');
    return this.db.prepare(
      "UPDATE tasks SET status='pending',due_at=?,lease_until=NULL "+
      "WHERE id=? AND status='uncertain' AND attempts<3").run(dueAt,id).changes===1;
  }
  get(id){return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)}
  count(){return this.db.prepare('SELECT COUNT(*) n FROM tasks').get().n}
}
