import type { AppRoute, ClaudeAppData } from './model';
import { ConversationRoute, ConversationsRoute } from './ConversationRoutes';
import { TranscriptRoute, TranscriptsRoute, RecordRoute, RawRoute } from './TranscriptRoutes';
import { MemoryFileRoute, MemoryRoute } from './MemoryRoutes';
import { McpRoute, McpServerRoute, McpToolRoute } from './McpRoutes';
import { ConfigFileRoute, ConfigurationRoute } from './ConfigurationRoutes';

/**
 * Which screen a pushed depth draws.
 *
 * One switch, no navigation: the route already names the depth, and each
 * screen owns only its content and the actions that push the next one.
 */
export function ClaudeAppRouteLayer({
  route,
  data,
}: {
  route: AppRoute;
  data: ClaudeAppData;
}) {
  switch (route.kind) {
    case 'conversations':
      return <ConversationsRoute data={data} />;
    case 'conversation':
      return <ConversationRoute id={route.id} data={data} />;
    case 'transcripts':
      return <TranscriptsRoute data={data} />;
    case 'transcript':
      return <TranscriptRoute id={route.id} data={data} />;
    case 'record':
      return (
        <RecordRoute
          transcriptId={route.transcriptId}
          record={route.record}
          data={data}
        />
      );
    case 'raw':
      return <RawRoute record={route.record} data={data} />;
    case 'memory':
      return <MemoryRoute data={data} />;
    case 'memory-file':
      return <MemoryFileRoute data={data} />;
    case 'mcp':
      return <McpRoute data={data} />;
    case 'mcp-server':
      return <McpServerRoute data={data} />;
    case 'mcp-tool':
      return <McpToolRoute tool={route.tool} serverName={route.serverName} />;
    case 'configuration':
      return <ConfigurationRoute data={data} />;
    case 'config-file':
      return <ConfigFileRoute scope={route.scope} data={data} />;
  }
}
