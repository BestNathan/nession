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
  return {
    input: Number(usage?.inputTokens ?? 0),
    output: Number(usage?.outputTokens ?? 0),
    cache_read: Number(usage?.cacheReadTokens ?? 0),
    cache_write: Number(usage?.cacheWriteTokens ?? 0),
    reasoning: usage?.reasoningTokens == null ? null : Number(usage.reasoningTokens),
    total: usage?.totalTokens == null ? null : Number(usage.totalTokens),
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
  workspace, storePath, tools, customTools, prompt,
}) {
  if (!apiKey) throw new Error('Cursor API key is required');
  const sdk = await sdkLoader();
  const selected = selectCursorModel(await sdk.Cursor.models.list(), requestedModel);
  const agent = await sdk.Agent.create({
    apiKey, name, model: selected, tools,
    local: {
      cwd: workspace,
      settingSources: [],
      store: new sdk.JsonlLocalAgentStore(storePath),
      ...(customTools ? { customTools } : {}),
    },
  });
  const started = new Date();
  try {
    const run = await agent.send(prompt);
    const toolCalls = [];
    let availableTools = [];
    let turns = 0;
    for await (const event of run.stream()) {
      if (event.type === 'usage') turns += 1;
      if (event.type === 'system' && Array.isArray(event.tools)) availableTools = event.tools;
      if (event.type === 'tool_call' && event.status === 'running') toolCalls.push(event.name);
    }
    const result = await run.wait();
    let billed = null;
    try { billed = await agent.getUsage(); } catch {}
    return {
      result,
      meta: {
        model: { id: selected.id, fast: requestedModel.fast, params: selected.params ?? [] },
        agent_id: agent.agentId ?? null,
        run_id: result.id ?? run.id ?? null,
        request_id: result.requestId ?? run.requestId ?? null,
        turns, available_tools: availableTools, tool_calls: toolCalls,
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
    else agent.close?.();
  }
}
