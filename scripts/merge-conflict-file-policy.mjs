// #4140: single executable owner for text conflict path eligibility.
// Checked before any model input and again by the independent Publisher.
// Deliberately refuses dotfiles, GitHub workflows, Gates, instructions,
// credentials, secrets and nonportable/escaping path elements.
export function allowedConflictPath(value){
  if(typeof value!=='string'||value.length<1||value.length>230||
     !/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(value))return false;
  const parts=value.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))return false;
  if(['.github','gates','secrets','credentials','security','infra'].includes(parts[0]))
    return false;
  const filename=parts.at(-1);
  if(['AGENTS.md','CLAUDE.md','Cargo.lock'].includes(filename))return false;
  if(/(?:^|\.)(?:env|pem|key|p12|pfx|asc|age|secret|secrets|token|tokens)$/i.test(filename))
    return false;
  return true;
}
