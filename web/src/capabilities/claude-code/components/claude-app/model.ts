import type {
  ClaudeCodeConfigScope,
  ClaudeCodeResourceView,
  ClaudeCodeWorkspaceState,
} from '../../hooks/useClaudeCodeWorkspace';
import type {
  ClaudeCodeMcpEntry,
  ClaudeCodeMcpTool,
  ClaudeCodeTranscriptRecord,
} from '../../types';

/**
 * One depth the App composition has pushed over the conversation root.
 *
 * The routes are the App's resource hierarchy (#3829): a collection, one
 * resource, and the detail a resource owns (a record, Raw, a file, a tool).
 * They are deliberately not URLs — the Workspace has no route owner, and the
 * shell header reads the pushed depth from the capability through
 * `WorkspaceDepthControl`.
 */
export type AppRoute =
  | { kind: 'conversations' }
  | { kind: 'conversation'; id: string }
  | { kind: 'transcripts' }
  | { kind: 'transcript'; id: string }
  | { kind: 'record'; transcriptId: string; record: ClaudeCodeTranscriptRecord }
  | { kind: 'raw'; transcriptId: string; record: ClaudeCodeTranscriptRecord }
  | { kind: 'memory' }
  | { kind: 'memory-file' }
  | { kind: 'mcp' }
  | { kind: 'mcp-server' }
  | { kind: 'mcp-tool'; serverName: string; tool: ClaudeCodeMcpTool }
  | { kind: 'configuration' }
  | { kind: 'config-file'; scope: ClaudeCodeConfigScope; path: string };

export interface McpEditorIntent {
  mode: 'add' | 'edit';
  entry?: ClaudeCodeMcpEntry;
}

/** The navigation actions every pushed screen may use. */
export interface ClaudeAppActions {
  push: (route: AppRoute) => void;
  openCandidate: (id: string) => void;
  openTranscript: (id: string) => void;
  setMcpEditor: (editor: McpEditorIntent | null) => void;
  setMcpRemoving: (entry: ClaudeCodeMcpEntry | null) => void;
}

/** Everything a screen needs; it is the App composition's context. */
export interface ClaudeAppData {
  state: ClaudeCodeWorkspaceState;
  agentId: string;
  sessionId: string;
  agentOffline: boolean;
  actions: ClaudeAppActions;
}

/** The pushed page's own name, which is what the one App header shows. */
export function routeTitle(route: AppRoute): string {
  switch (route.kind) {
    case 'conversations':
      return 'Conversations';
    case 'conversation':
      return 'Conversation';
    case 'transcripts':
      return 'Transcripts';
    case 'transcript':
      return 'Transcript';
    case 'record':
      return 'Record';
    case 'raw':
      return 'Raw record';
    case 'memory':
      return 'Memory';
    case 'memory-file':
      return 'Memory file';
    case 'mcp':
      return 'MCP';
    case 'mcp-server':
      return 'MCP server';
    case 'mcp-tool':
      return 'Tool';
    case 'configuration':
      return 'Configuration';
    case 'config-file':
      return 'File';
  }
}

/**
 * A stable identity for a pushed layer.
 *
 * The layer stack keeps every pushed screen mounted under the one on top, so
 * back restores the list's scroll position and the reader's place in a
 * transcript rather than rebuilding them. Two routes of the same kind are
 * different layers, which is why the resource identity is part of the key.
 */
export function routeKey(route: AppRoute): string {
  switch (route.kind) {
    case 'conversation':
      return `conversation:${route.id}`;
    case 'transcript':
      return `transcript:${route.id}`;
    case 'record':
      return `record:${route.transcriptId}:${route.record.record_ref}`;
    case 'raw':
      return `raw:${route.transcriptId}:${route.record.record_ref}`;
    case 'mcp-tool':
      return `mcp-tool:${route.serverName}:${route.tool.name}`;
    case 'config-file':
      return `config-file:${route.scope}:${route.path}`;
    default:
      return route.kind;
  }
}

/** The fetch activation a route implies for the shared hook. */
export function resourceOfRoute(route: AppRoute | null): ClaudeCodeResourceView {
  switch (route?.kind) {
    case 'transcripts':
    case 'transcript':
    case 'record':
    case 'raw':
      return 'transcripts';
    case 'memory':
    case 'memory-file':
      return 'memory';
    case 'mcp':
    case 'mcp-server':
    case 'mcp-tool':
      return 'mcp';
    case 'configuration':
    case 'config-file':
      return 'configuration';
    default:
      return 'conversations';
  }
}

/** The transcript a route is reading, if it is reading one. */
export function transcriptIdOf(route: AppRoute | null): string | null {
  switch (route?.kind) {
    case 'transcript':
      return route.id;
    case 'record':
    case 'raw':
      return route.transcriptId;
    default:
      return null;
  }
}
