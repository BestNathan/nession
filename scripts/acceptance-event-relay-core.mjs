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
    // Existing shadow ledgers have a digest-only deliveries table. Add
    // receipt/processing fields without invalidating previously committed IDs.
    const columns=new Set(this.db.prepare('PRAGMA table_info(deliveries)').all().map(x=>x.name));
    for(const [field,definition] of [
      ['raw','BLOB'],['event_name','TEXT'],['installation_id','INTEGER'],
      ['state',"TEXT NOT NULL DEFAULT 'done'"],
      ['attempts','INTEGER NOT NULL DEFAULT 0'],
      ['next_at','INTEGER'],['lease_until','INTEGER'],['last_error','TEXT'],
    ])if(!columns.has(field))this.db.exec('ALTER TABLE deliveries ADD COLUMN '+field+' '+definition);
    this.db.exec("CREATE INDEX IF NOT EXISTS delivery_due ON deliveries(state,next_at)");
    const taskColumns=new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(x=>x.name));
    for(const [name,type] of [
      ['dispatch_run_id','INTEGER'],['suppression_reason','TEXT'],
    ])if(!taskColumns.has(name))
      this.db.exec('ALTER TABLE tasks ADD COLUMN '+name+' '+type);
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
  // The receiving HTTP request commits just this signed envelope. No GitHub
  // read, Issue parsing or downstream dispatch may block acknowledgement.
  receive(delivery,raw,eventName,installationId,now=Date.now()){
    if(!/^[0-9a-f-]{36}$/i.test(delivery??'')||!Buffer.isBuffer(raw)||
      !raw.length||raw.length>1048576||eventName!=='workflow_run'||
      !positive(installationId)||!Number.isSafeInteger(now))
      fail('invalid durable webhook envelope');
    return this.tx(()=>{
      const digest=sha256(raw);
      const old=this.db.prepare('SELECT digest FROM deliveries WHERE id=?').get(delivery);
      if(old){
        if(old.digest!==digest)fail('conflicting webhook delivery ID');
        return {duplicate:true};
      }
      this.db.prepare(
        "INSERT INTO deliveries(id,digest,at,raw,event_name,installation_id,state,next_at) "+
        "VALUES(?,?,?,?,?,?,'received',?)")
        .run(delivery,digest,now,raw,eventName,installationId,now);
      return {duplicate:false};
    });
  }
  // Selection has no external side effects. A crashed read lease is safely
  // retried, unlike an ambiguous Actions POST on a task-dispatch lease.
  claimDelivery(now=Date.now(),lease=900000){
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(lease)||
      lease<10000||lease>900000)fail('invalid inbox lease');
    return this.tx(()=>{
      this.db.prepare(
        "UPDATE deliveries SET state='received',lease_until=NULL "+
        "WHERE state='processing' AND lease_until<=?").run(now);
      const row=this.db.prepare(
        "SELECT * FROM deliveries WHERE state='received' AND next_at<=? "+
        "ORDER BY next_at,id LIMIT 1").get(now);
      if(!row)return null;
      this.db.prepare(
        "UPDATE deliveries SET state='processing',attempts=attempts+1,lease_until=? "+
        "WHERE id=? AND state='received'").run(now+lease,row.id);
      return {...row,state:'processing',attempts:row.attempts+1};
    });
  }
  completeDelivery(id,source,eligible,now=Date.now()){
    if(!Array.isArray(eligible)||!Number.isSafeInteger(now))fail('invalid resolution');
    return this.tx(()=>{
      const row=this.db.prepare(
        "SELECT state,digest,raw FROM deliveries WHERE id=?").get(id);
      if(row?.state!=='processing'||!row.raw||
        row.digest!==sha256(Buffer.from(row.raw)))fail('untrusted claim or payload digest');
      if(!source&&eligible.length)fail('unattested eligible work');
      let added=0;
      for(const item of eligible){
        if(!positive(item.issue)||!/^[a-f0-9]{64}$/.test(item.contract_digest??'')||
          source.repo!==REPO||!SHA.test(source.target_sha??'')||
          !positive(source.source_run_id)||!positive(source.source_attempt)||
          source.stage!=='post-merge'||!SOURCE_WORKFLOWS.has(source.source_path))
          fail('invalid attested task identity');
        const taskId=sha256(JSON.stringify([source.repo,source.source_run_id,
          source.source_attempt,source.target_sha,item.issue,source.stage,item.contract_digest]));
        added+=Number(this.db.prepare(
          "INSERT OR IGNORE INTO tasks(id,repo,issue,target_sha,source_run_id,source_attempt,"+
          "source_path,stage,contract_digest,status,due_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)")
          .run(taskId,source.repo,item.issue,source.target_sha,
            source.source_run_id,source.source_attempt,source.source_path,
            source.stage,item.contract_digest,now).changes);
      }
      this.db.prepare(
        "UPDATE deliveries SET state='done',raw=NULL,lease_until=NULL,next_at=NULL,last_error=NULL "+
        "WHERE id=?").run(id);
      return {added,eligible:eligible.length};
    });
  }
  retryDelivery(id,now=Date.now(),delayMs=30000){
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(delayMs)||
      delayMs<1000||delayMs>86400000)fail('invalid retry delay');
    return this.tx(()=>{
      const row=this.db.prepare(
        "SELECT attempts FROM deliveries WHERE id=? AND state='processing'").get(id);
      if(!row)return false;
      this.db.prepare(
        "UPDATE deliveries SET state=?,next_at=?,lease_until=NULL,last_error=? WHERE id=?")
        .run(row.attempts>=12?'dead':'received',
          row.attempts>=12?null:now+delayMs,
          row.attempts>=12?'retry budget exhausted':'transient-source-read',id);
      return true;
    });
  }
  getDelivery(id){return this.db.prepare(
    'SELECT id,digest,state,attempts,next_at,lease_until FROM deliveries WHERE id=?').get(id)}
  nextDeliveryAt(){
    const row=this.db.prepare(
      "SELECT MIN(due) AS due FROM ("+
      "SELECT next_at AS due FROM deliveries WHERE state='received' "+
      "UNION ALL SELECT lease_until AS due FROM deliveries WHERE state='processing')").get();
    return row?.due??null;
  }
  // A lost dispatcher cannot blindly retry an API POST: a timeout may have
  // created a GitHub Actions run. An expired lease becomes UNCERTAIN instead.
  claim(now=Date.now(),lease=60000){
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(lease)||
      lease<10000||lease>300000)fail('invalid lease');
    return this.tx(()=>{
      this.db.prepare(
        "UPDATE tasks SET status='uncertain',due_at=?,lease_until=NULL,"+
        "last_error='dispatch lease expired' "+
        "WHERE status='dispatching' AND lease_until<=?").run(now+30000,now);
      const row=this.db.prepare(
        "SELECT * FROM tasks WHERE status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 1").get(now);
      if(!row)return null;
      this.db.prepare(
        "UPDATE tasks SET status='dispatching',attempts=attempts+1,lease_until=? WHERE id=? AND status='pending'")
        .run(now+lease,row.id);
      return {...row,status:'dispatching',attempts:row.attempts+1};
    });
  }
  uncertain(id,reason,now=Date.now()){
    if(!Number.isSafeInteger(now))fail('invalid uncertain transition time');
    return this.db.prepare(
      "UPDATE tasks SET status='uncertain',last_error=?,lease_until=NULL,due_at=? "+
      "WHERE id=? AND status='dispatching'")
      .run(String(reason).slice(0,200),now+30000,id).changes===1;
  }
  confirm(id,now=Date.now()){
    return this.db.prepare(
      "UPDATE tasks SET status='confirmed',confirmed_at=?,lease_until=NULL "+
      "WHERE id=? AND status IN ('dispatching','uncertain')").run(now,id).changes===1;
  }
  // `confirmed` means a task has a *known terminal routing outcome*.
  // An actual dispatch additionally has a positive immutable dispatch_run_id.
  // Suppression keeps a reason and a null Run ID; it is NOT an SC Pass.
  suppress(id,reason='current-contract-ineligible',now=Date.now()){
    if(!Number.isSafeInteger(now)||!reason)fail('invalid suppression');
    return this.db.prepare(
      "UPDATE tasks SET status='confirmed',suppression_reason=?,confirmed_at=?,lease_until=NULL "+
      "WHERE id=? AND status='dispatching' AND dispatch_run_id IS NULL")
      .run(String(reason).slice(0,200),now,id).changes===1;
  }
  acknowledgeDispatch(id,runId,now=Date.now()){
    if(!positive(runId)||!Number.isSafeInteger(now))fail('invalid dispatch receipt');
    return this.tx(()=>{
      const row=this.db.prepare(
        "SELECT status,dispatch_run_id FROM tasks WHERE id=?").get(id);
      if(row?.status==='confirmed')
        return row.dispatch_run_id===runId;
      if(!row||!['dispatching','uncertain'].includes(row.status)||
        row.dispatch_run_id!==null)return false;
      this.db.prepare(
        "UPDATE tasks SET status='confirmed',dispatch_run_id=?,confirmed_at=?,"+
        "lease_until=NULL,suppression_reason=NULL,last_error=NULL WHERE id=?")
        .run(runId,now,id);
      return true;
    });
  }
  // A definitive HTTP 403/429 response rejected the API POST. No Workflow
  // Run was created; reschedule the same singleflight task at its durable due.
  deferRejectedDispatch(id,dueAt,httpStatus){
    if(!Number.isSafeInteger(dueAt)||![403,429].includes(httpStatus))
      fail('not a definitive quota rejection');
    return this.db.prepare(
      "UPDATE tasks SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'uncertain' END,"+
      "due_at=?,lease_until=NULL,last_error=? "+
      "WHERE id=? AND status='dispatching' AND dispatch_run_id IS NULL")
      .run(dueAt,'rejected-http-'+httpStatus,id).changes===1;
  }
  // All preflight operations are read-only. A failure before POST cannot have
  // created a run; its retry is safe but still bounded by the task budget.
  deferPreflight(id,dueAt){
    if(!Number.isSafeInteger(dueAt))fail('invalid preflight due');
    return this.db.prepare(
      "UPDATE tasks SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'uncertain' END,"+
      "due_at=?,lease_until=NULL,last_error='preflight-read-failed' "+
      "WHERE id=? AND status='dispatching' AND dispatch_run_id IS NULL")
      .run(dueAt,id).changes===1;
  }
  // Reconciliation is *read-only*. It can safely repeat but never turns an
  // absent GitHub API listing into evidence that the original POST failed.
  claimUncertain(now=Date.now(),delay=60000){
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(delay)||
      delay<10000||delay>86400000)fail('invalid reconciliation schedule');
    return this.tx(()=>{
      const row=this.db.prepare(
        "SELECT * FROM tasks WHERE status='uncertain' AND due_at<=? "+
        "ORDER BY due_at,id LIMIT 1").get(now);
      if(!row)return null;
      this.db.prepare(
        "UPDATE tasks SET due_at=? WHERE id=? AND status='uncertain'")
        .run(now+delay,row.id);
      return row;
    });
  }
  nextTaskDue(){
    const row=this.db.prepare(
      "SELECT MIN(t) AS due FROM ("+
      "SELECT due_at AS t FROM tasks WHERE status IN ('pending','uncertain') "+
      "UNION ALL SELECT lease_until AS t FROM tasks WHERE status='dispatching')").get();
    return row?.due??null;
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
