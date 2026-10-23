// Trusted workflow-side selection of registered Agent defaults.
// GitHub Repository Variables are policy inputs, not credential bindings.
// Each invocation resolves the ID once; durable Tasks must persist that ID.
import {validateRegistry} from './harness/contract.mjs';

const ROLE_VARIABLES=Object.freeze({
  developer:'AGENT_DEFAULT_DEVELOPER',
  reviewer:'AGENT_DEFAULT_REVIEWER',
  acceptor:'AGENT_DEFAULT_ACCEPTOR',
  auditor:'AGENT_DEFAULT_AUDITOR',
});

function fail(message) { throw new Error('Agent defaults: '+message); }

export function resolveAgentDefault(registry,role,{configured='',override='',legacy=''}={}) {
  validateRegistry(registry);
  if (!Object.hasOwn(ROLE_VARIABLES,role)) fail('unsupported role: '+role);
  for(const [key,value] of Object.entries({configured,override,legacy}))
    if (typeof value !== 'string') fail('invalid '+key+' selection');
  // Empty means unset. Do not silently fall back when a non-empty ID is invalid.
  const agentId=override || configured || legacy;
  if (!agentId || !/^[a-z][a-z0-9-]{1,80}$/.test(agentId))
    fail('missing or invalid registered '+role+' Agent ID');
  const instance=registry.instances[agentId];
  if (!instance || instance.role!==role)
    fail('unregistered or wrong-role '+role+' Agent ID: '+agentId);
  return Object.freeze({agent_id:agentId,role,provider:instance.provider,
    environment:instance.environment});
}

export function roleVariable(role) {
  if(!Object.hasOwn(ROLE_VARIABLES,role))fail('unsupported role: '+role);
  return ROLE_VARIABLES[role];
}
