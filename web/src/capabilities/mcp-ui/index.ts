/**
 * Shared MCP UI kit (#3772).
 *
 * Consumers (#3251 AI, #3600 Claude Code) supply an `McpUiProvider` and the
 * authoritative Session/Agent context; this package owns the interaction
 * grammar only. It deliberately has no transport, no WebSocket dependency and
 * no process execution.
 */
export { McpKitView } from './components/McpKitView';
export { McpServerList } from './components/McpServerList';
export { McpServerDetail } from './components/McpServerDetail';
export { McpServerConfigEditor } from './components/McpServerConfigEditor';
export { McpConnectionPanel } from './components/McpConnectionPanel';
export { McpToolList } from './components/McpToolList';
export { McpToolInspector } from './components/McpToolInspector';
export { McpSchemaViewer } from './components/McpSchemaViewer';
export { McpToolRunner } from './components/McpToolRunner';
export { McpToolResult } from './components/McpToolResult';
export { McpCallHistory } from './components/McpCallHistory';
export { useMcpKit } from './hooks/useMcpKit';
export type { McpRunOutcome, McpRunStatus } from './hooks/useMcpKit';
export {
  boundedJson,
  credentialLabel,
  defaultArguments,
  hasOutputSchema,
  outputSchemaNote,
  parseArgumentsDraft,
  readSchema,
  redactSecrets,
  redactText,
  scopeLabel,
  transportLabel,
  validateArguments,
} from './model';
export type { McpReadableSchema, McpSchemaField } from './model';
export type {
  McpCallRecord,
  McpCallResult,
  McpClientLoadState,
  McpContentBlock,
  McpCredentialState,
  McpInventory,
  McpMutationResult,
  McpProbeResult,
  McpProviderCapabilities,
  McpProviderContext,
  McpScope,
  McpServerEntry,
  McpServerMutation,
  McpTool,
  McpTransport,
  McpUiExperience,
  McpUiProvider,
} from './types';
