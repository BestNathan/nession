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