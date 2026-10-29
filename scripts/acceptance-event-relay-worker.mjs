// #2031: crash-recoverable, due-time-driven shadow webhook resolver.
// The Actions publisher is intentionally absent: zero downstream Actions posts.
export function retryDelay(attempts,retryAfterMs=null){
  const exponential=Math.min(3600000,Math.max(1000,1000*2**Math.min(attempts,11)));
  return Math.max(exponential,Number.isFinite(retryAfterMs)&&retryAfterMs>0
    ?Math.min(86400000,Math.ceil(retryAfterMs)):0);
}

// Safely claims a durable received event. Every effect before completeDelivery
// is a READ (GitHub API + canonical SC selection); expiry may replay it.
// Task dispatch has a separate uncertainty contract and MUST NOT use this path.
export async function processDueWebhook(inbox,resolve,{
  now=()=>Date.now(),onError=()=>{},
}={}){
  const receipt=inbox.claimDelivery(now());
  if(!receipt)return null;
  try{
    if(!receipt.raw||typeof receipt.event_name!=='string'||
      !Number.isSafeInteger(receipt.installation_id))
      throw Error('invalid durable receipt');
    const decoded=JSON.parse(Buffer.from(receipt.raw).toString('utf8'));
    if(decoded?.installation?.id!==receipt.installation_id)
      throw Error('stored installation mismatch');
    const decision=await resolve(decoded,receipt);
    if(!decision||!Array.isArray(decision.eligible)||(
      decision.source===null&&decision.eligible.length))
      throw Error('invalid resolver result');
    const result=inbox.completeDelivery(receipt.id,decision.source,
      decision.eligible,now());
    return {id:receipt.id,status:'done',...result};
  }catch(err){
    // Parse/API errors cannot mark an event done or forge Issue acceptance.
    const delay=retryDelay(receipt.attempts,err?.retryAfterMs??null);
    inbox.retryDelivery(receipt.id,now(),delay);
    onError({event:'retry',attempt:receipt.attempts,delay_ms:delay});
    return {id:receipt.id,status:'retry',delay_ms:delay};
  }
}

// In-process setTimeout is NOT an Actions cron. Due times are durable SQLite
// records; on restart kick() reads the earliest recorded next_at/lease_until.
export function startInboxWorker(inbox,resolve,{onError=()=>{},maxDelay=2147483647}={}){
  let stopped=false,timer=null,inFlight=null;
  const clear=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
  const kick=()=>{
    if(stopped||inFlight)return;
    clear();
    const at=inbox.nextDeliveryAt();
    if(at===null)return;
    timer=setTimeout(()=>{
      timer=null;
      inFlight=processDueWebhook(inbox,resolve,{onError});
      // A DB error is a crash-level failure, not a successful receipt.
      // Never turn it into an unhandled rejected Promise and lose the timer.
      inFlight.then(()=>{
        inFlight=null;
        if(!stopped)kick();
      },()=>{
        inFlight=null;
        onError({event:'worker-internal-error'});
        if(!stopped)kick();
      });
    },Math.min(maxDelay,Math.max(0,at-Date.now())));
    timer.unref?.();
  };
  kick();
  return {kick,stop:async()=>{
    stopped=true;clear();
    if(inFlight)await inFlight;
  }};
}
