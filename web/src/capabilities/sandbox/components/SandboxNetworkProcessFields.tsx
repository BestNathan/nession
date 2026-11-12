import { Checkbox } from '@/components/ui/checkbox';
import {
  FormField,
  FormGrid,
  FormSection,
} from '@/components/ui/configuration-form';
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
    <FormSection
      title="Network"
      description="Restricted mode applies the explicit egress allow/deny lists; the other modes use the backend's baseline."
    >
      <SandboxImplementationStatus
        catalog={catalog}
        path={IMPLEMENTATION_PATHS.network}
        label="Network policy"
      />
      <FormField
        id="sandbox-network-mode"
        label="Mode"
        description={selectedModeReason}
        descriptionTestId="sandbox-network-mode-reason"
      >
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
      </FormField>
      {mode === 'restricted' ? (
        <FormGrid>
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
        </FormGrid>
      ) : null}
    </FormSection>
  );
}

export function SandboxProcessFields({ draft, catalog }: SandboxFieldsetProps) {
  const namespaces = draft.draft.process?.linux_namespaces;
  const namespacesEditable = implementationEditable(
    catalog,
    IMPLEMENTATION_PATHS.linuxNamespaces,
  );
  return (
    <FormSection
      title="Process namespaces"
      description="Linux-native. The backend baseline namespaces are always present; these are explicit additional requests."
    >
      <SandboxImplementationStatus
        catalog={catalog}
        path={IMPLEMENTATION_PATHS.linuxNamespaces}
        label="Linux namespaces"
      />
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
        <p
          role="alert"
          data-recipe-part="form-error"
          className={cn(chromeSansRole('caption'), 'text-destructive')}
        >
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
    </FormSection>
  );
}
