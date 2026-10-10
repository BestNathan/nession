/**
 * Provider matrix runs are distinct immutable executions within one GitHub run.
 * Preserve the existing default telemetry path for all other workflows.
 */
export function providerScopedRunName({ workflowId, runId, runAttempt, taskId, provider }) {
  if (workflowId !== 'agent-provider-smoke') return undefined;
  if (!/^[1-9][0-9]*$/.test(String(runId)) || !/^[1-9][0-9]*$/.test(String(runAttempt))) {
    throw new Error('Provider Smoke requires positive GitHub run ID and attempt');
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(String(taskId))) {
    throw new Error('Provider Smoke requires a stable task ID');
  }
  if (!['cursor', 'deepseek'].includes(provider)) {
    throw new Error('Provider Smoke requires a declared Provider');
  }
  return [runId, runAttempt, taskId, provider].join('-');
}
