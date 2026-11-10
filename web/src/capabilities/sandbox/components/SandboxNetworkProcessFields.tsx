import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import type {
  SandboxCapabilityCatalog,
  SandboxNetworkMode,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import {
  implementationDisabledReason,
  implementationEditable,
  IMPLEMENTATION_PATHS,
  namespaceDisabledReason,
  networkModeDisabledReason,
} from '../model';
import { SandboxImplementationStatus } from './SandboxImplementationStatus';
import { SandboxStringListEditor } from './SandboxStringListEditor';

const NETWORK_MODES: readonly SandboxNetworkMode[] = ['allow', 'deny', 'restricted'];
const NAMESPACES = ['pid', 'ipc', 'user', 'uts', 'cgroup'] as const;

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
    >
      {children}
    </label>
  );
}

export interface SandboxFieldsetProps {
  draft: SandboxDraftState;
  catalog: SandboxCapabilityCatalog;
}

export function SandboxNetworkFields({
  draft,
  catalog,
}: SandboxFieldsetProps) {
  const mode = draft.draft.network?.mode ?? 'allow';
  const networkDisabled =
    implementationDisabledReason(catalog, IMPLEMENTATION_PATHS.network) !== null;
  const selectedModeReason = networkModeDisabledReason(catalog, mode);
  const changeMode = (value: SandboxNetworkMode | null) => {
    if (!value || networkModeDisabledReason(catalog, value)) {
      return;
    }
    draft.patch({
      network:
        value === 'restricted'
          ? {
              mode: value,
              ingress: 'deny',
              egress: draft.draft.network?.egress ?? {
                allow: [],
                deny: [],
                private_network: 'deny',
              },
            }
          : { mode: value, ingress: 'deny' },
    });
  };
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-[var(--nession-radius-surface)] border border-border/60 p-3">
      <legend className={cn(chromeSansRole('primary'), 'px-1')}>Network</legend>
      <SandboxImplementationStatus
        catalog={catalog}
        path={IMPLEMENTATION_PATHS.network}
        label="Network policy"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel htmlFor="sandbox-network-mode">Mode</FieldLabel>
        <Select value={mode} onValueChange={changeMode}>
          <SelectTrigger
            id="sandbox-network-mode"
            data-testid="sandbox-network-mode"
            disabled={networkDisabled}
          >
            <span>{mode}</span>
          </SelectTrigger>
          <SelectContent>
            {NETWORK_MODES.map((candidate) => {
              const reason = networkModeDisabledReason(catalog, candidate);
              return (
                <SelectItem
                  key={candidate}
                  value={candidate}
                  disabled={reason !== null}
                  data-testid={`sandbox-network-mode-${candidate}`}
                >
                  {candidate}
                  {reason ? ' (unavailable)' : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {selectedModeReason ? (
          <p
            data-testid="sandbox-network-mode-reason"
            className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
          >
            {selectedModeReason}
          </p>
        ) : null}
      </div>
      {mode === 'restricted' ? (
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <SandboxStringListEditor
              title="Allowed destinations"
              items={draft.draft.network?.egress?.allow ?? []}
              placeholder="api.example.com:443"
              addLabel="Add allowed rule"
              testIdPrefix="sandbox-egress-allow"
              emptyText="No destinations are allowed."
              disabledReason={
                networkDisabled
                  ? implementationDisabledReason(catalog, IMPLEMENTATION_PATHS.network)
                  : null
              }
              onAdd={() => draft.addEgressRule('allow')}
              onChange={(index, value) => draft.updateEgressRule('allow', index, value)}
              onRemove={(index) => draft.removeEgressRule('allow', index)}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <SandboxStringListEditor
              title="Denied destinations"
              items={draft.draft.network?.egress?.deny ?? []}
              placeholder="*.internal.example"
              addLabel="Add denied rule"
              testIdPrefix="sandbox-egress-deny"
              emptyText="No extra destinations are denied."
              disabledReason={
                networkDisabled
                  ? implementationDisabledReason(catalog, IMPLEMENTATION_PATHS.network)
                  : null
              }
              onAdd={() => draft.addEgressRule('deny')}
              onChange={(index, value) => draft.updateEgressRule('deny', index, value)}
              onRemove={(index) => draft.removeEgressRule('deny', index)}
            />
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

export function SandboxProcessFields({ draft, catalog }: SandboxFieldsetProps) {
  const namespaces = draft.draft.process?.linux_namespaces;
  const namespacesEditable = implementationEditable(
    catalog,
    IMPLEMENTATION_PATHS.linuxNamespaces,
  );
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-[var(--nession-radius-surface)] border border-border/60 p-3">
      <legend className={cn(chromeSansRole('primary'), 'px-1')}>Process namespaces</legend>
      <SandboxImplementationStatus
        catalog={catalog}
        path={IMPLEMENTATION_PATHS.linuxNamespaces}
        label="Linux namespaces"
      />
      <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
        Linux-native. The backend baseline namespaces are always present; these are explicit
        additional requests.
      </p>
      <div className="flex flex-wrap gap-4">
        {NAMESPACES.map((namespace) => {
          const optionReason = namespaceDisabledReason(catalog, namespace);
          return (
            <label
              key={namespace}
              className="flex min-h-11 items-center gap-2"
              htmlFor={`sandbox-namespace-${namespace}`}
            >
              <Checkbox
                id={`sandbox-namespace-${namespace}`}
                data-testid={`sandbox-namespace-${namespace}`}
                checked={namespaces?.[namespace] ?? false}
                disabled={
                  optionReason !== null ||
                  (namespace === 'cgroup' && !(namespaces?.user ?? false))
                }
                onCheckedChange={() => draft.toggleNamespace(namespace)}
              />
              <span className={chromeSansRole('secondary')}>{namespace}</span>
            </label>
          );
        })}
      </div>
      {namespaces?.cgroup && !namespaces.user ? (
        <p className={cn(chromeSansRole('caption'), 'text-destructive')}>
          The cgroup namespace requires the user namespace.
        </p>
      ) : null}
      {namespacesEditable
        ? NAMESPACES.map((namespace) => {
            const reason = namespaceDisabledReason(catalog, namespace);
            return reason ? (
              <p
                key={namespace}
                data-testid={`sandbox-namespace-reason-${namespace}`}
                className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
              >
                {namespace}: {reason}
              </p>
            ) : null;
          })
        : null}
    </fieldset>
  );
}
