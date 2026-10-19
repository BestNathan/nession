import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function normalizeCursorSdkModule(loaded) {
  if (loaded?.Cursor && loaded?.Agent) return loaded;
  if (loaded?.default?.Cursor && loaded?.default?.Agent) return loaded.default;
  throw new Error('Loaded @cursor/sdk module does not expose Cursor and Agent exports');
}

export async function loadCursorSdk(root = process.env.CURSOR_SDK_ROOT) {
  if (!root) throw new Error('CURSOR_SDK_ROOT is required');
  const resolveFromRoot = createRequire(path.join(root, 'package.json'));
  const entry = resolveFromRoot.resolve('@cursor/sdk');
  return normalizeCursorSdkModule(await import(pathToFileURL(entry).href));
}

export function selectCursorModel(models, requested) {
  const model = models.find((entry) => entry.id === requested.id);
  if (!model) throw new Error('Cursor model ' + requested.id + ' is unavailable; no fallback is allowed');
  if (!requested.fast) return { id: model.id };
  const parameter = model.parameters?.find((entry) => entry.id === 'fast');
  const value = parameter?.values?.find((entry) => String(entry.value) === 'true');
  if (!value) throw new Error('Cursor model ' + requested.id + ' does not expose fast=true; no fallback is allowed');
  return { id: model.id, params: [{ id: 'fast', value: String(value.value) }] };
}

export function normalizeCursorUsage(usage) {
  const observed = (value) => {
    if (value == null) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  return {
    input: observed(usage?.inputTokens),
    output: observed(usage?.outputTokens),
    cache_read: observed(usage?.cacheReadTokens),
    cache_write: observed(usage?.cacheWriteTokens),
    reasoning: observed(usage?.reasoningTokens),
    total: observed(usage?.totalTokens),
  };
}

export function normalizeCursorCost(value) {
  return {
    raw_usd: value?.cost?.rawCostCents == null ? null : Number(value.cost.rawCostCents) / 100,
    charged_usd: value?.cost?.chargedCents == null ? null : Number(value.cost.chargedCents) / 100,
  };
}

/** Run a Cursor session with task-supplied capability selection. */
export async function runCursorSession({
  sdkLoader = loadCursorSdk, apiKey, name, requestedModel,
  workspace, storePath, tools, customTools, prompt, resumeAgentId = null,
  sandbox = false,
}) {
  if (!apiKey) throw new Error('Cursor API key is required');
  const sdk = await sdkLoader();
  const selected = selectCursorModel(await sdk.Cursor.models.list(), requestedModel);
  // The exact same SDK-native JSONL store must be restored before resuming.
  // Re-declare model/tool policy on every call: SDK tool allowlists, custom tools,
  // and inline capabilities are not persisted with the session.
  if(typeof sandbox!=='boolean') throw new Error('Cursor sandbox flag must be boolean');
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string')) {
    throw new Error('Cursor requires an explicit tool allowlist on create and resume');
  }
  if (resumeAgentId != null && !/^agent-[a-zA-Z0-9-]{4,100}$/.test(resumeAgentId)) {
    throw new Error('Invalid local Cursor native resume agent ID');
  }
  const nativeOptions = {
    apiKey, model: selected, tools,
    local: {
      cwd: workspace,
      settingSources: [],
      ...(sandbox ? {sandboxOptions:{enabled:true}} : {}),
      store: new sdk.JsonlLocalAgentStore(storePath),
      ...(customTools ? { customTools } : {}),
    },
  };
  if (resumeAgentId && typeof sdk.Agent.resume !== 'function') {
    throw new Error('Cursor SDK has no native resume API; refusing fresh-session fallback');
  }
  const agent = resumeAgentId
    ? await sdk.Agent.resume(resumeAgentId, nativeOptions)
    : await sdk.Agent.create({ ...nativeOptions, name });
  if (resumeAgentId && agent.agentId !== resumeAgentId) {
    try { await agent.close?.(); } catch {}
    throw new Error('Cursor resumed a different native agent ID');
  }
  const started = new Date();
  try {
    const run = await agent.send(prompt);
    const toolCalls = [];
    // Store only bounded native event *metadata*. No tool arguments, result text,
    // system messages, or model-generated text enter the telemetry collector.
    const nativeEvents = [];
    let availableTools = [];
    let turns = 0;
    for await (const event of run.stream()) {
      if (event.type === 'usage') {
        turns += 1;
        if (nativeEvents.length < 10000) {
          const usage = event.usage ?? event;
          nativeEvents.push({ type: 'usage', requestId: event.requestId ?? null,
            usage: Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens']
              .filter(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0).map(k => [k, usage[k]])) });
        }
      }
      if (event.type === 'system' && Array.isArray(event.tools)) availableTools = event.tools;
      if (event.type === 'tool_call' && event.status === 'running') toolCalls.push(event.name);
      if (event.type === 'tool_call' && ['running','completed','error'].includes(event.status) &&
          typeof event.name === 'string' && nativeEvents.length < 10000) {
        nativeEvents.push({ type:'tool_call', status:event.status, name:event.name,
          call_id: String(event.callId ?? event.call_id ?? event.id ?? 'tool-' + nativeEvents.length),
          duration_ms: Number.isSafeInteger(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null });
      }
    }
    const result = await run.wait();
    let billed = null;
    try { billed = await agent.getUsage(); } catch {}
    return {
      result,
      meta: {
        model: { id: selected.id, fast: requestedModel.fast, params: selected.params ?? [] },
        agent_id: agent.agentId ?? null,
        resumed: resumeAgentId !== null,
        run_id: result.id ?? run.id ?? null,
        request_id: result.requestId ?? run.requestId ?? null,
        turns, available_tools: availableTools, tool_calls: toolCalls, native_events: nativeEvents,
        status: result.status, error: result.error ?? null,
        usage: normalizeCursorUsage(result.usage),
        cost: normalizeCursorCost(billed),
        started_at: started.toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: result.durationMs ?? run.durationMs ?? (Date.now() - started.getTime()),
      },
    };
  } finally {
    if (typeof agent[Symbol.asyncDispose] === 'function') await agent[Symbol.asyncDispose]();
    else await agent.close?.();
  }
}
