import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DetailFact,
  DetailFacts,
  DetailNote,
  DetailSection,
} from '@/components/ui/resource-detail';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

import { credentialLabel, transportLabel } from '../model';
import type {
  McpInventory,
  McpProbeResult,
  McpProviderCapabilities,
  McpServerEntry,
} from '../types';

function reachabilityLabel(probe: McpProbeResult | null): string {
  if (!probe) {
    return 'Not probed';
  }
  switch (probe.status) {
    case 'ok':
      return 'Reachable';
    case 'refused':
      return 'Probe refused';
    case 'unsupported':
      return 'Probe unsupported';
    default:
      return 'Probe failed';
  }
}

function clientLoadLabel(probe: McpProbeResult | null): string {
  if (!probe || probe.status !== 'ok') {
    return 'Unknown';
  }
  switch (probe.clientLoad) {
    case 'loaded':
      return 'Loaded';
    case 'not_loaded':
      return 'Not loaded';
    default:
      return 'Unknown';
  }
}

function McpConnectionFacts({
  server,
  probe,
  probing,
}: {
  server: McpServerEntry;
  probe: McpProbeResult | null;
  probing: boolean;
}) {
  return (
    <DetailFacts>
      <DetailFact label="Configured" testId="mcp-connection-configured" inline>
        Yes · {server.scope} scope
      </DetailFact>
      <DetailFact label="Reachability" testId="mcp-connection-reachability" inline>
        {probing ? 'Probing…' : reachabilityLabel(probe)}
      </DetailFact>
      <DetailFact label="Loaded in client" testId="mcp-connection-loaded" inline>
        {clientLoadLabel(probe)}
      </DetailFact>
      <DetailFact label="Protocol version" testId="mcp-connection-protocol" inline>
        {probe?.status === 'ok' ? (probe.protocolVersion ?? 'Not reported') : 'Not negotiated'}
      </DetailFact>
      <DetailFact label="Credentials" testId="mcp-connection-credential" inline>
        {credentialLabel(server.credential)}
      </DetailFact>
      <DetailFact label="Transport" testId="mcp-connection-transport" inline>
        {transportLabel(server.transport)}
      </DetailFact>
    </DetailFacts>
  );
}

/**
 * Configured, independently probed, and client-loaded are three different
 * facts (#3772). This panel never derives one from another: the declaration
 * comes from the entry, the observation from an explicit probe, and the client
 * state from the adapter's answer.
 */
export function McpConnectionPanel({
  server,
  capabilities,
  inventoryState,
  probe,
  probing,
  error,
  onTest,
}: {
  server: McpServerEntry;
  capabilities: McpProviderCapabilities;
  inventoryState: McpInventory['state'] | undefined;
  probe: McpProbeResult | null;
  probing: boolean;
  error: string | null;
  onTest: (options: { allowStdio: boolean }) => void;
}) {
  const [consentOpen, setConsentOpen] = useState(false);
  const offline = inventoryState !== 'ready';
  const credentialMissing = server.credential === 'missing';
  const canProbe = capabilities.probe && !offline && !credentialMissing && !probing;
  const needsConsent = server.transport === 'stdio';

  const test = () => {
    if (!canProbe) {
      return;
    }
    if (needsConsent && !consentOpen) {
      setConsentOpen(true);
      return;
    }
    setConsentOpen(false);
    onTest({ allowStdio: needsConsent });
  };

  return (
    <DetailSection
      title="Connection"
      testId="mcp-connection"
      action={
        <span
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
          data-testid="mcp-connection-state"
        >
          {probing ? 'Probing…' : reachabilityLabel(probe)}
        </span>
      }
    >
      <McpConnectionFacts server={server} probe={probe} probing={probing} />

      {offline ? (
        <DetailNote data-testid="mcp-connection-offline">
          The current Session Agent is unavailable; the inventory is unavailable, not
          empty. Configuration reads and explicit actions are disabled.
        </DetailNote>
      ) : credentialMissing ? (
        <DetailNote data-testid="mcp-connection-credential-missing">
          A credential reference is missing. The kit never exports tokens implicitly.
        </DetailNote>
      ) : error ? (
        <DetailNote data-testid="mcp-connection-error">{error}</DetailNote>
      ) : (
        <DetailNote>
          A probe starts only by request. A stdio probe launches a process, so it
          asks for consent first; viewing a server never does.
        </DetailNote>
      )}

      {consentOpen ? (
        <div
          className="flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-control)] bg-muted p-2"
          data-testid="mcp-connection-consent"
        >
          <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Testing this stdio server launches <code>{server.command ?? 'the executable'}</code> on
            the current Session Agent. Continue?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setConsentOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" data-testid="mcp-connection-consent-confirm" onClick={test}>
              Allow and test
            </Button>
          </div>
        </div>
      ) : null}

      {!capabilities.probe ? (
        <DetailNote data-testid="mcp-connection-unsupported">
          This adapter cannot probe connections. The configured declaration is shown
          without inventing an observation.
        </DetailNote>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={probe?.status === 'ok' ? 'outline' : 'default'}
          disabled={!canProbe}
          data-testid="mcp-connection-test"
          onClick={test}
        >
          {probing ? 'Testing…' : probe?.status === 'ok' ? 'Test again' : 'Test connection'}
        </Button>
        {server.transport === 'stdio' ? (
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Requires explicit consent before launching.
          </span>
        ) : null}
      </div>
    </DetailSection>
  );
}
