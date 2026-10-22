const TOOLS = Object.freeze({
  cursor: { read: 'repo.read', grep: 'repo.search', glob: 'repo.search', edit: 'repo.edit', bash: 'shell.test' },
  'claude-code': { Read: 'repo.read', Grep: 'repo.search', Glob: 'repo.search', Edit: 'repo.edit', Bash: 'shell.test' },
});
const EVENTS = new Set(['model.usage', 'tool.started', 'tool.completed', 'tool.failed',
  'skill.loaded', 'skill.invoked', 'mcp.tool.completed', 'checkpoint.saved', 'checkpoint.restored', 'agent.handoff']);
function reject(msg) { throw new Error('agent event: ' + msg); }
function numberOrNull(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
function tokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = {
    input: value.inputTokens ?? value.input_tokens, output: value.outputTokens ?? value.output_tokens,
    cache_read: value.cacheReadTokens ?? value.cache_read_input_tokens,
    cache_write: value.cacheWriteTokens ?? value.cache_creation_input_tokens,
    reasoning: value.reasoningTokens ?? value.reasoning_tokens,
  };
  return Object.fromEntries(Object.entries(fields).map(([k,v]) => [k, numberOrNull(v)]));
}
export function canonicalToolId(provider, name) {
  if (typeof name !== 'string' || !name || name.length > 180) reject('invalid native tool name');
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length < 3 || !parts[1] || !parts[2]) reject('invalid MCP tool name');
    return { id: 'mcp.tool', native_name: name, server: parts[1], tool: parts.slice(2).join('__') };
  }
  const id = TOOLS[provider]?.[name];
  return { id: id ?? null, native_name: name, observed: Boolean(id) };
}
export function makeExecutionEvent(context, type, sequence, data) {
  if (!EVENTS.has(type) || !Number.isInteger(sequence) || sequence < 0) reject('invalid event identity');
  if (!context || !/^[a-z][a-z0-9-]*$/.test(context.agent_id ?? '') ||
      !/^[a-z][a-z0-9-]*$/.test(context.role ?? '') ||
      !Number.isInteger(context.issue) || context.issue <= 0 ||
      !Number.isInteger(context.github_run_id) || context.github_run_id <= 0 ||
      !Number.isInteger(context.github_run_attempt) || context.github_run_attempt <= 0) reject('invalid execution identity');
  const allowedData = {
    'model.usage': ['usage', 'request_id', 'observation'],
    'tool.started': ['call_id', 'tool', 'observation'],
    'tool.completed': ['call_id', 'tool', 'status', 'duration_ms', 'observation'],
    'tool.failed': ['call_id', 'tool', 'status', 'duration_ms', 'observation'],
    'skill.loaded': ['skill_id', 'observation'],
    'skill.invoked': ['skill_id', 'observation'],
    'mcp.tool.completed': ['call_id', 'tool', 'server', 'status', 'duration_ms', 'observation'],
    'checkpoint.saved': ['checkpoint_id', 'observation'],
    'checkpoint.restored': ['checkpoint_id', 'observation'],
    'agent.handoff': ['to_role', 'result', 'observation'],
  }[type];
  if (!data || Object.keys(data).some((key) => !allowedData.includes(key))) reject('unsafe event payload fields');
  if (!['native-event', 'host-tool', 'loader', 'trusted-workflow'].includes(data.observation)) reject('missing observation source');
  return {
    schema_version: 1, kind: 'agent_execution_event', type, sequence,
    identity: { agent_id: context.agent_id, role: context.role, issue: context.issue,
      github_run_id: context.github_run_id, github_run_attempt: context.github_run_attempt },
    data,
  };
}

// Normalize only native events that have a concrete observation source.
// Unseen tool/skill execution must remain unknown, not an invented zero.
export function normalizeProviderEvent(provider, native, context, sequence) {
  if (!['cursor', 'claude-code'].includes(provider)) reject('unsupported provider');
  if (!native || typeof native !== 'object') return null;
  if (provider === 'cursor') {
    if (native.type === 'tool_call') {
      const status = native.status === 'running' ? 'tool.started' :
        native.status === 'completed' ? 'tool.completed' :
        native.status === 'error' ? 'tool.failed' : null;
      if (!status) return null;
      return makeExecutionEvent(context, status, sequence, { call_id: String(native.call_id ?? native.id ?? ''),
        tool: canonicalToolId(provider, native.name), ...(status === 'tool.started' ? {} :
          { status: native.status, duration_ms: numberOrNull(native.duration_ms) }), observation: 'native-event' });
    }
    if (native.type === 'usage') {
      return makeExecutionEvent(context, 'model.usage', sequence,
        { usage: tokenUsage(native.usage ?? native), request_id: native.requestId ?? null, observation: 'native-event' });
    }
  }
  if (provider === 'claude-code') {
    // stream-json assistant message exposes content blocks with tool_use entries.
    const block = native.type === 'assistant' && native.message?.content?.find?.(x => x.type === 'tool_use');
    if (block) {
      return makeExecutionEvent(context, 'tool.started', sequence, { call_id: String(block.id ?? ''),
        tool: canonicalToolId(provider, block.name), observation: 'native-event' });
    }
    if (native.type === 'result' && native.usage) {
      return makeExecutionEvent(context, 'model.usage', sequence,
        { usage: tokenUsage(native.usage), request_id: null, observation: 'native-event' });
    }
  }
  return null;
}
