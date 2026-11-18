import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DetailEmpty, DetailNote } from '@/components/ui/resource-detail';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import { scopeLabel, transportLabel } from '../model';
import type { McpInventory, McpServerEntry } from '../types';

function McpServerRow({
  server,
  selected,
  onSelect,
}: {
  server: McpServerEntry;
  selected: boolean;
  onSelect: (server: McpServerEntry) => void;
}) {
  return (
    <button
      type="button"
      data-testid="mcp-server-row"
      data-server-name={server.name}
      data-server-scope={server.scope}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(server)}
      className={cn(
        'flex w-full min-w-0 flex-col gap-0.5 rounded-[var(--nession-radius-control)] px-2 py-1.5 text-left transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
        selected && 'bg-accent text-accent-foreground',
      )}
    >
      <span className={cn('min-w-0 truncate', chromeSansRole('primary'))}>{server.name}</span>
      <span
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground',
          chromeMonoRole('metadata'),
        )}
      >
        <span>{transportLabel(server.transport)}</span>
        <span>·</span>
        <span>{scopeLabel(server.scope)}</span>
        {server.readOnly ? <span>· read-only</span> : null}
        {server.conflict ? <span>· conflict</span> : null}
        {!server.effective ? (
          <span>· shadowed{server.shadowedBy ? ` by ${server.shadowedBy}` : ''}</span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The capability-local Server column.
 *
 * This is navigation *inside* the hosting capability, not a Workspace sidebar:
 * it never adds global chrome. The Add control exists only when the adapter
 * says configuration is writable; a read-only inventory says so rather than
 * showing a dead button.
 */
export function McpServerList({
  inventory,
  loading,
  error,
  selected,
  canConfigure,
  onSelect,
  onAdd,
}: {
  inventory: McpInventory | null;
  loading: boolean;
  error: string | null;
  selected: McpServerEntry | null;
  canConfigure: boolean;
  onSelect: (server: McpServerEntry) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState('');
  const servers = inventory?.servers ?? [];
  const filtered = servers.filter((server) =>
    server.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const ready = inventory?.state === 'ready';
  const selectedKey = selected ? `${selected.name}\u0000${selected.scope}` : null;

  return (
    <nav
      aria-label="MCP Servers"
      data-testid="mcp-server-list"
      className="flex min-h-0 min-w-0 flex-col border-b border-border lg:border-b-0 lg:border-r"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 pt-3">
        <h2 className={cn('min-w-0', chromeSansRole('secondary'))}>Servers</h2>
        {canConfigure ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="mcp-server-add"
            onClick={onAdd}
            disabled={!ready}
          >
            + Add
          </Button>
        ) : null}
      </div>
      <p className={cn('px-3 pt-1 text-muted-foreground', chromeSansRole('caption'))}>
        Managed on the current Session Agent
      </p>

      {loading ? (
        <div className="px-3 py-2" data-testid="mcp-inventory-loading">
          <DetailNote>Reading configuration…</DetailNote>
        </div>
      ) : !ready ? (
        <div className="px-3 py-2" data-testid="mcp-inventory-unavailable">
          <DetailEmpty>
            {inventory?.state === 'unsupported'
              ? 'This Session Agent cannot provide an MCP inventory.'
              : 'The MCP inventory is unavailable, not empty.'}
          </DetailEmpty>
          {error ? <DetailNote>{error}</DetailNote> : null}
        </div>
      ) : error ? (
        <div className="px-3 py-2" data-testid="mcp-inventory-error">
          <DetailNote>{error}</DetailNote>
        </div>
      ) : (
        <>
          <div className="px-3 py-2">
            <Input
              aria-label="Search MCP Servers"
              data-testid="mcp-server-search"
              value={query}
              placeholder="Search servers…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {filtered.length === 0 ? (
              <div className="px-2 py-2" data-testid="mcp-server-empty">
                <DetailEmpty>No MCP servers found.</DetailEmpty>
              </div>
            ) : (
              <ul className="flex min-w-0 flex-col">
                {filtered.map((server) => {
                  const key = `${server.name}\u0000${server.scope}`;
                  return (
                    <li key={key} className="min-w-0">
                      <McpServerRow
                        server={server}
                        selected={selectedKey === key}
                        onSelect={onSelect}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </nav>
  );
}
