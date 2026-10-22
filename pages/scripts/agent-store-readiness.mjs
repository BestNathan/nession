// Public, read-only evidence of agent-store *source readiness* only.
// A valid branch or tree entry cannot certify a v2 implementing PR receipt.
const SHA=/^[a-f0-9]{40}$/;
const SOURCE='https://github.com/BestNathan/nession/tree/agent-store';
const unavailable={status:'unavailable',sha:null,url:SOURCE};
const missing={status:'missing',sha:null,url:SOURCE};
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function agentStoreReadiness(ref,entries,verifiedRef){
  if(ref?.state==='missing')return {...missing};
  if(ref?.state!=='present'||typeof ref.sha!=='string'||!SHA.test(ref.sha))
    return {...unavailable};
  if(!verifiedRef||verifiedRef.state!=='present'||verifiedRef.sha!==ref.sha)
    return {...unavailable}; // Source ref moved during a multi-call snapshot.
  if(!Array.isArray(entries)||entries.length>30)return {...unavailable};
  const seen=new Set();
  for(const item of entries){
    if(!isObject(item)||typeof item.name!=='string'||
       !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,78}$/.test(item.name)||
       item.name==='.'||item.name==='..'||item.path!==item.name||
       !['file','dir'].includes(item.type)||!SHA.test(item.sha||'')||
       seen.has(item.name))return {...unavailable};
    seen.add(item.name);
  }
  // "empty" is a true empty Git source tree at an exact pinned commit.
  // Any nonempty tree is UNVERIFIED, not evidence of an authenticated result.
  return {status:entries.length?'present_unverified':'empty',sha:ref.sha,url:SOURCE};
}
export function validateAgentStoreReadiness(info){
  if(!isObject(info)||Object.keys(info).sort().join(',')!=='sha,status,url'||
     !['missing','empty','present_unverified','unavailable'].includes(info.status)||
     info.url!==SOURCE||
     (info.status==='empty'||info.status==='present_unverified'
       ?typeof info.sha!=='string'||!SHA.test(info.sha)
       :info.sha!==null))
    throw Error('invalid public Agent Store source readiness');
  return info;
}
