import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { formatSchema } from '../../format';
import type { ClaudeCodeMcpTool } from '../../types';
import { McpView } from '../McpView';
import type { ClaudeAppData } from './model';
import { ResourceIntro, ScrollBody } from './primitives';

/** The scoped MCP connection inventory. */
export function McpRoute({ data }: { data: ClaudeAppData }) {
  const mcp = data.state.mcp;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-mcp">
      <McpView
        mcp={mcp}
        experience="app"
        showSelectionBack={false}
        onSelectEntry={(entry) => {
          void mcp.select(entry);
          data.actions.push({ kind: 'mcp-server' });
        }}
        onAdd={() => data.actions.setMcpEditor({ mode: 'add' })}
        onEdit={(entry) => data.actions.setMcpEditor({ mode: 'edit', entry })}
        onRemove={(entry) => data.actions.setMcpRemoving(entry)}
      />
    </div>
  );
}

/** One server's source, precedence and inspected tool list. */
export function McpServerRoute({ data }: { data: ClaudeAppData }) {
  const mcp = data.state.mcp;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-mcp-server">
      <McpView
        mcp={mcp}
        experience="app"
        showSelectionBack={false}
        onSelectEntry={(entry) => {
          void mcp.select(entry);
        }}
        onOpenTool={(tool) =>
          data.actions.push({
            kind: 'mcp-tool',
            serverName: mcp.selection?.name ?? 'MCP server',
            tool,
          })
        }
        onAdd={() => data.actions.setMcpEditor({ mode: 'add' })}
        onEdit={(entry) => data.actions.setMcpEditor({ mode: 'edit', entry })}
        onRemove={(entry) => data.actions.setMcpRemoving(entry)}
      />
    </div>
  );
}

/** One advertised tool's schema, read-only. */
export function McpToolRoute({
  tool,
  serverName,
}: {
  tool: ClaudeCodeMcpTool;
  serverName: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-mcp-tool">
      <ResourceIntro
        eyebrow="MCP tool"
        title={tool.name}
        description={`${serverName} · read-only inspection`}
      />
      <ScrollBody className="px-4 py-3">
        {tool.description ? (
          <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
            {tool.description}
          </p>
        ) : null}
        <p className={cn('mt-4', chromeLabelRole())}>Input schema</p>
        {tool.input_schema ? (
          <pre
            className={cn(
              'mt-2 whitespace-pre-wrap wrap-anywhere rounded-[var(--nession-radius-surface)] bg-muted p-3',
              chromeMonoRole('code'),
            )}
          >
            {formatSchema(tool.input_schema)}
          </pre>
        ) : (
          <p className={cn('mt-2 text-muted-foreground', chromeSansRole('secondary'))}>
            This server advertised no input schema.
          </p>
        )}
        <p className={cn('mt-4 text-muted-foreground', chromeSansRole('caption'))}>
          Tool execution is not offered here. Inspection is read-only.
        </p>
      </ScrollBody>
    </div>
  );
}
