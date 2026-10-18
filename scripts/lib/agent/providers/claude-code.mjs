import { spawnSync } from 'node:child_process';

export function parseClaudeJson(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('Claude Code returned empty stdout');
  for (const line of [value, ...value.split('\n').reverse()]) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  throw new Error('Claude Code stdout did not contain parseable JSON');
}

export function normalizeClaudeUsage(envelope) {
  const usage = envelope?.usage ?? {};
  const models = Object.values(envelope?.modelUsage ?? {});
  const sum = (keys) => {
    let total = 0;
    let observed = false;
    for (const model of models) {
      for (const key of keys) {
        if (model?.[key] != null && Number.isFinite(Number(model[key]))) {
          total += Number(model[key]);
          observed = true;
          break;
        }
      }
    }
    return observed ? total : null;
  };
  const first = (...values) => {
    for (const value of values) {
      if (value != null && value !== '' && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  };
  return {
    input: first(usage.input_tokens, usage.inputTokens, sum(['inputTokens', 'input_tokens'])),
    output: first(usage.output_tokens, usage.outputTokens, sum(['outputTokens', 'output_tokens'])),
    cache_read: first(usage.cache_read_input_tokens, usage.cacheReadInputTokens, sum(['cacheReadInputTokens', 'cache_read_input_tokens'])),
    cache_write: first(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens, sum(['cacheCreationInputTokens', 'cache_creation_input_tokens'])),
    reasoning: null, total: null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildClaudeCliArgs({
  prompt, model, maxTurns, allowedTools, disallowedTools,
  sessionId = null, resumeSessionId = null, restricted = false, tools = null,
}) {
  // A resumed Agent is the SAME native session, never --continue or --fork-session.
  if (sessionId && resumeSessionId) throw new Error('Claude cannot seed and resume at once');
  const selected = sessionId ?? resumeSessionId;
  if (selected != null && !UUID.test(selected)) throw new Error('invalid Claude native session UUID');
  if (selected && !prompt) throw new Error('Claude native session requires a new prompt');
  const args = ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns),
    '--model', model, '--allowedTools', allowedTools, '--disallowedTools', disallowedTools];
  if (restricted) args.push('--restricted');
  if (tools !== null) {
    if (typeof tools !== 'string') throw new Error('invalid Claude explicit tools policy');
    args.push('--tools', tools, '--disallowedTools', 'mcp__*');
  }
  if (sessionId) args.push('--session-id', sessionId);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

export function runClaudeCli({
  prompt, model, maxTurns, allowedTools, disallowedTools, cwd, env,
  sessionId = null, resumeSessionId = null, configDir = null, restricted = false,
  tools = null, spawn = spawnSync,
}) {
  if ((sessionId || resumeSessionId) && !configDir) {
    throw new Error('Durable Claude requires an isolated CLAUDE_CONFIG_DIR');
  }
  const args = buildClaudeCliArgs({prompt,model,maxTurns,allowedTools,disallowedTools,
    sessionId,resumeSessionId,restricted,tools});
  const cliEnv = {...process.env,...env,DISABLE_AUTOUPDATER:'1',
    ANTHROPIC_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model};
  if (configDir) cliEnv.CLAUDE_CONFIG_DIR=configDir;
  if (sessionId || resumeSessionId) {
    // Do not honor an inherited "no persistence" or implicit fork policy.
    if (cliEnv.CLAUDE_CODE_SKIP_PROMPT_HISTORY === '1')
      throw new Error('Claude native session persistence is disabled');
  }
  const proc = spawn('claude', args, {
    cwd, encoding:'utf8', maxBuffer:20*1024*1024, env:cliEnv,
  });
  if (proc.error) throw proc.error;
  let parsed=null;
  try {parsed=parseClaudeJson(proc.stdout);}catch(error){if(proc.status===0)throw error;}
  const requested=sessionId??resumeSessionId;
  if (requested && proc.status===0 && parsed?.session_id!==requested &&
      parsed?.sessionId!==requested) {
    throw new Error('Claude CLI returned a different native Session ID');
  }
  return {proc,parsed};
}
