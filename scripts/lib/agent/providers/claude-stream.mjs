// Claude Code stream-json parsing shared by the Developer canary, the Reviewer
// canary and the reviewer runner. One owner for the native event envelope.
export function parseNativeEvents(stdout){
  if(typeof stdout!=='string'||stdout.length>8*1024*1024)throw Error('invalid native event stream');
  const events=[];
  for(const line of stdout.split(/\r?\n/).filter(Boolean)){
    let value;
    try{value=JSON.parse(line);}catch{throw Error('malformed native event stream');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid native event envelope');
    events.push(value);
  }
  const result=events.filter(e=>e.type==='result');
  if(result.length!==1)throw Error('exactly one Provider result required');
  return {events,envelope:result[0]};
}
export function toolUseNames(events){
  return events.filter(x=>x?.type==='assistant'&&Array.isArray(x?.message?.content))
    .flatMap(x=>x.message.content)
    .filter(block=>block?.type==='tool_use'&&typeof block.id==='string')
    .map(block=>block.name);
}
