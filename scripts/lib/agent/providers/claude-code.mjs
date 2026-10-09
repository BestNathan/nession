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
  const sum = (keys) => models.reduce((acc, model) => {
    for (const key of keys) {
      if (model?.[key] != null && Number.isFinite(Number(model[key]))) return acc + Number(model[key]);
    }
    return acc;
  }, 0);
  const first = (...values) => {
    for (const value of values) {
      if (value != null && value !== '' && Number.isFinite(Number(value))) return Number(value);
    }
    return 0;
  };
  return {
    input: first(usage.input_tokens, usage.inputTokens, sum(['inputTokens', 'input_tokens'])),
    output: first(usage.output_tokens, usage.outputTokens, sum(['outputTokens', 'output_tokens'])),
    cache_read: first(usage.cache_read_input_tokens, usage.cacheReadInputTokens, sum(['cacheReadInputTokens', 'cache_read_input_tokens'])),
    cache_write: first(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens, sum(['cacheCreationInputTokens', 'cache_creation_input_tokens'])),
    reasoning: null, total: null,
  };
}

export function buildClaudeCliArgs({ prompt, model, maxTurns, allowedTools, disallowedTools }) {
  return ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns), '--model', model,
    '--allowedTools', allowedTools, '--disallowedTools', disallowedTools];
}

export function runClaudeCli({ prompt, model, maxTurns, allowedTools, disallowedTools, cwd, env }) {
  const proc = spawnSync('claude', buildClaudeCliArgs({ prompt, model, maxTurns, allowedTools, disallowedTools }), {
    cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...env, DISABLE_AUTOUPDATER: '1', ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model },
  });
  if (proc.error) throw proc.error;
  let parsed = null;
  try { parsed = parseClaudeJson(proc.stdout); } catch (error) { if (proc.status === 0) throw error; }
  return { proc, parsed };
}
