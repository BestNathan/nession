import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DetailFact,
  DetailFacts,
  DetailHeader,
  DetailNote,
  DetailSection,
  DetailSurface,
} from '@/components/ui/resource-detail';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import { credentialLabel, scopeLabel, transportLabel } from '../model';
import type {
  McpInventory,
  McpProbeResult,
  McpProviderCapabilities,
  McpServerEntry,
} from '../types';
import { McpConnectionPanel } from './McpConnectionPanel';

function McpServerFacts({ server }: { server: McpServerEntry }) {
  return (
    <DetailFacts>
      <DetailFact label="Transport" testId="mcp-server-transport" inline>
        {transportLabel(server.transport)}
      </DetailFact>
      <DetailFact label="Config source" testId="mcp-server-origin" mono inline>
        {server.origin}
      </DetailFact>
      {server.transport === 'stdio' ? (
        <>
          <DetailFact label="Executable" testId="mcp-server-command" mono inline>
            {server.command ?? 'Not reported'}
          </DetailFact>
          <DetailFact label="Arguments" testId="mcp-server-arguments" inline>
            {server.argumentCount ?? 0} declared
          </DetailFact>
        </>
      ) : (
        <DetailFact label="Endpoint" testId="mcp-server-endpoint" mono inline>
          {server.endpoint ?? 'Not reported'}
        </DetailFact>
      )}
      <DetailFact label="Credential binding" testId="mcp-server-credential" inline>
        {credentialLabel(server.credential)}
      </DetailFact>
      {server.envNames && server.envNames.length > 0 ? (
        <DetailFact label="Environment names" testId="mcp-server-env-names" mono inline>
          {server.envNames.join(', ')}
        </DetailFact>
      ) : null}
      {server.headerNames && server.headerNames.length > 0 ? (
        <DetailFact label="Header names" testId="mcp-server-header-names" mono inline>
          {server.headerNames.join(', ')}
        </DetailFact>
      ) : null}
      <DetailFact label="Effective definition" testId="mcp-server-effective" inline>
        {server.effective
          ? 'Yes'
          : `No · shadowed${server.shadowedBy ? ` by ${server.shadowedBy}` : ''}`}
      </DetailFact>
    </DetailFacts>
  );
}

function McpConfigurationActions({
  server,
  capabilities,
  mutationBusy,
  onEdit,
  onRemove,
}: {
  server: McpServerEntry;
  capabilities: McpProviderCapabilities;
  mutationBusy: boolean;
  onEdit: () => void;
  onRemove: (server: McpServerEntry) => Promise<boolean>;
}) {
  const [removing, setRemoving] = useState(false);
  if (!capabilities.configuration) {
    return (
      <DetailNote data-testid="mcp-server-config-unsupported">
        This adapter does not support configuration changes.
      </DetailNote>
    );
  }
  if (server.readOnly) {
    return <DetailNote>No edit or remove action is offered for this definition.</DetailNote>;
  }
  if (!capabilities.scopes.includes(server.scope)) {
    return (
      <DetailNote data-testid="mcp-server-scope-unsupported">
        {scopeLabel(server.scope)} scope is not writable by this adapter.
      </DetailNote>
    );
  }
  if (!removing) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" data-testid="mcp-server-edit" onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="destructive"
          data-testid="mcp-server-remove"
          onClick={() => setRemoving(true)}
        >
          Remove
        </Button>
      </div>
    );
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-control)] bg-muted p-2"
      data-testid="mcp-server-remove-confirm"
    >
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        Remove <strong>{server.name}</strong> from {scopeLabel(server.scope)} configuration?
        Other scopes remain unchanged.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={mutationBusy}
          onClick={() => setRemoving(false)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="destructive"
          data-testid="mcp-server-remove-confirm-button"
          disabled={mutationBusy}
          onClick={() => {
            void onRemove(server).then((removed) => {
              if (removed) {
                setRemoving(false);
              }
            });
          }}
        >
          {mutationBusy ? 'Removing…' : 'Remove'}
        </Button>
      </div>
    </div>
  );
}

/**
 * One Server's declared configuration and its independently observed
 * connection state.
 *
 * The header and facts are ResourceDetail, not a form: a read-only definition
 * must not look editable, and an entry owned elsewhere says so instead of
 * offering an action the adapter would refuse.
 */
export function McpServerDetail({
  server,
  capabilities,
  inventoryState,
  probe,
  probing,
  probeError,
  mutationBusy,
  mutationError,
  mutationNotice,
  onTest,
  onEdit,
  onRemove,
}: {
  server: McpServerEntry;
  capabilities: McpProviderCapabilities;
  inventoryState: McpInventory['state'] | undefined;
  probe: McpProbeResult | null;
  probing: boolean;
  probeError: string | null;
  mutationBusy: boolean;
  mutationError: string | null;
  mutationNotice: string | null;
  onTest: (options: { allowStdio: boolean }) => void;
  onEdit: () => void;
  onRemove: (server: McpServerEntry) => Promise<boolean>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5 p-3" data-testid="mcp-server-detail">
      <DetailSurface>
        <DetailHeader
          eyebrow="MCP Server · Configuration"
          title={<span className="min-w-0 break-all">{server.name}</span>}
          titleTestId="mcp-server-title"
          badges={
            <span
              className={cn(
                'shrink-0 rounded-[var(--nession-radius-control)] bg-muted px-1.5 py-0.5 text-muted-foreground',
                chromeSansRole('caption'),
              )}
              data-testid="mcp-server-configured-badge"
            >
              Configured · {scopeLabel(server.scope)}
            </span>
          }
          description={`${transportLabel(server.transport)} · ${server.origin}`}
        />
        <McpServerFacts server={server} />

        {server.readOnly ? (
          <DetailNote data-testid="mcp-server-read-only">
            This definition is owned outside this capability (managed, plugin or another
            scope). It is inspectable and cannot be edited or removed here.
          </DetailNote>
        ) : null}
        {server.conflict ? (
          <DetailNote data-testid="mcp-server-conflict">
            Another scope defines this name with a different endpoint or command. Saving
            uses the reviewed definition&apos;s fingerprint.
          </DetailNote>
        ) : null}
        {mutationNotice ? (
          <DetailNote data-testid="mcp-server-notice">{mutationNotice}</DetailNote>
        ) : null}
        {mutationError ? (
          <DetailNote data-testid="mcp-server-mutation-error" className="text-destructive">
            {mutationError}
          </DetailNote>
        ) : null}

        <DetailSection title="Manage configuration" testId="mcp-server-configuration">
          <McpConfigurationActions
            server={server}
            capabilities={capabilities}
            mutationBusy={mutationBusy}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        </DetailSection>
      </DetailSurface>

      <DetailSurface>
        <McpConnectionPanel
          server={server}
          capabilities={capabilities}
          inventoryState={inventoryState}
          probe={probe}
          probing={probing}
          error={probeError}
          onTest={onTest}
        />
      </DetailSurface>
    </div>
  );
}
