// Canonical model selection for the trusted CI Agent workflows.
// A model identity is supplied by the selected GitHub Environment Variables,
// never by a workflow literal and never by a fallback to another Provider.
// Missing or malformed values fail closed before any Provider invocation.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]@+-]{0,127}$/;
const QWEN = /^qwen[a-z0-9._-]*$/i;
const CLAUDE_GATEWAY_PROVIDERS = Object.freeze(['qwen', 'deepseek']);

function fail(message) { throw new Error('Agent model selection: ' + message); }

function explicitModel(value, variable) {
  const selected = typeof value === 'string' ? value : '';
  if (!selected)
    fail('missing ' + variable + ' from the selected GitHub Environment; ' +
      'no Provider or model fallback is allowed');
  if (!MODEL.test(selected))
    fail('malformed ' + variable + ' from the selected GitHub Environment');
  return selected;
}

export function cursorModel(env = process.env) {
  return Object.freeze({
    id: explicitModel(env?.CURSOR_MODEL, 'CURSOR_MODEL'),
    fast: String(env?.CURSOR_MODEL_FAST || 'true').toLowerCase() !== 'false',
  });
}

export function claudeGatewayModel(value, {provider, variable = 'ANTHROPIC_MODEL'} = {}) {
  if (!CLAUDE_GATEWAY_PROVIDERS.includes(provider))
    fail('unsupported Claude Gateway provider: ' + provider);
  const model = explicitModel(value, variable);
  if (provider === 'qwen' && !QWEN.test(model))
    fail('Qwen Environment must declare a Qwen model via ' + variable +
      '; a Claude alias is not a Provider fallback');
  return model;
}
