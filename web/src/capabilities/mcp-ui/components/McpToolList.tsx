import { useState } from 'react';

import { Input } from '@/components/ui/input';
import { DetailEmpty, DetailNote } from '@/components/ui/resource-detail';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import type { McpProbeResult, McpTool } from '../types';

/**
 * Tools are a discovery result, not configuration.
 *
 * Nothing here exists until an explicit probe answered; selecting a server or
 * viewing its facts never produces this list. A failed or refused probe says
 * what happened instead of rendering an empty list as "no tools".
 */
export function McpToolList({
  tools,
  selected,
  probe,
  probing,
  discoverySupported,
  hasServer,
  onSelect,
}: {
  tools: readonly McpTool[];
  selected: McpTool | null;
  probe: McpProbeResult | null;
  probing: boolean;
  discoverySupported: boolean;
  hasServer: boolean;
  onSelect: (tool: McpTool) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = tools.filter((tool) => {
    const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
    return text.includes(query.trim().toLowerCase());
  });

  return (
    <nav
      aria-label="MCP Tools"
      data-testid="mcp-tool-list"
      className="flex min-h-0 min-w-0 flex-col border-b border-border lg:border-b-0 lg:border-r"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 pt-3">
        <h2 className={cn('min-w-0', chromeSansRole('secondary'))}>Tools</h2>
        <span
          className={cn('text-muted-foreground', chromeMonoRole('metadata'))}
          data-testid="mcp-tool-count"
        >
          {probe?.status === 'ok' ? tools.length : '—'}
        </span>
      </div>

      {!hasServer ? (
        <div className="px-3 py-2" data-testid="mcp-tools-no-server">
          <DetailEmpty>Choose a server to inspect.</DetailEmpty>
        </div>
      ) : !discoverySupported ? (
        <div className="px-3 py-2" data-testid="mcp-tools-unsupported">
          <DetailNote>This adapter does not support Tool discovery.</DetailNote>
        </div>
      ) : probing ? (
        <div className="px-3 py-2" data-testid="mcp-tools-probing">
          <DetailNote>Probing connection and capabilities…</DetailNote>
        </div>
      ) : probe?.status === 'ok' ? (
        <>
          <div className="px-3 py-2">
            <Input
              aria-label="Search tools"
              data-testid="mcp-tool-search"
              value={query}
              placeholder="Search tools…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {filtered.length === 0 ? (
              <div className="px-2 py-2" data-testid="mcp-tools-empty">
                <DetailEmpty>
                  {tools.length === 0 ? 'The server advertised no Tools.' : 'No Tools match.'}
                </DetailEmpty>
              </div>
            ) : (
              <ul className="flex min-w-0 flex-col">
                {filtered.map((tool) => (
                  <li key={tool.name} className="min-w-0">
                    <button
                      type="button"
                      data-testid="mcp-tool-row"
                      data-tool-name={tool.name}
                      aria-current={selected?.name === tool.name ? 'true' : undefined}
                      onClick={() => onSelect(tool)}
                      className={cn(
                        'flex w-full min-w-0 flex-col gap-0.5 rounded-[var(--nession-radius-control)] px-2 py-1.5 text-left transition-colors',
                        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
                        selected?.name === tool.name && 'bg-accent text-accent-foreground',
                      )}
                    >
                      <span className={cn('min-w-0 break-all', chromeMonoRole('code'))}>
                        {tool.name}
                      </span>
                      {tool.description ? (
                        <span
                          className={cn(
                            'min-w-0 text-muted-foreground',
                            chromeSansRole('caption'),
                          )}
                        >
                          {tool.description}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="px-3 py-2" data-testid="mcp-tools-not-probed">
          <DetailNote>
            {probe
              ? `Tool discovery ${probe.status}. ${probe.error ?? probe.detail ?? ''}`.trim()
              : 'Tools appear after an explicit connection test. Viewing a server never probes.'}
          </DetailNote>
        </div>
      )}
    </nav>
  );
}
