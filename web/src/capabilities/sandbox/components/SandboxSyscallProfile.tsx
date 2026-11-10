import { FormField, FormSection } from '@/components/ui/configuration-form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import type { SandboxCapabilityCatalog } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import {
  implementationSupport,
  IMPLEMENTATION_PATHS,
  syscallDisabledReason,
} from '../model';
import { SandboxImplementationStatus } from './SandboxImplementationStatus';

const NONE = '__none__';

export interface SandboxSyscallProfileProps {
  draft: SandboxDraftState;
  catalog: SandboxCapabilityCatalog;
}

/**
 * The registered seccomp profile choice (#3143).
 *
 * Only profiles the Agent measured as loadable are selectable; "No profile"
 * clears the optional Syscall group. This never exposes arbitrary syscall
 * names, expressions or BPF to the client.
 */
export function SandboxSyscallProfile({ draft, catalog }: SandboxSyscallProfileProps) {
  const implementation = implementationSupport(catalog, IMPLEMENTATION_PATHS.seccomp);
  const options = implementation?.options ?? [];
  const selected = draft.draft.syscall[0]?.value ?? NONE;
  const disabledReason = syscallDisabledReason(catalog);
  const disabled = disabledReason !== null || options.length === 0;
  const change = (value: string | null) => {
    if (!value) {
      return;
    }
    draft.patch({
      syscall: value === NONE ? [] : [{ key: 'seccomp.profile', value }],
    });
  };
  return (
    <FormSection
      title="Syscall profile"
      description="Optional. Select one Agent-registered profile, or leave the group empty. Arbitrary syscall lists and external BPF are not part of this contract."
    >
      <SandboxImplementationStatus
        catalog={catalog}
        path={IMPLEMENTATION_PATHS.seccomp}
        label="seccomp"
      />
      <FormField
        id="sandbox-syscall-profile"
        label="Profile"
        description={disabledReason}
        descriptionTestId="sandbox-syscall-disabled"
      >
        <Select value={selected} onValueChange={change} disabled={disabled}>
          <SelectTrigger id="sandbox-syscall-profile" data-testid="sandbox-syscall-profile">
            <span>{selected === NONE ? 'No profile' : selected}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} data-testid="sandbox-syscall-profile-none">
              No profile
            </SelectItem>
            {options.map((option) => (
              <SelectItem
                key={option.id}
                value={option.id}
                disabled={option.status !== 'available'}
                data-testid={`sandbox-syscall-profile-${option.id}`}
              >
                {option.id}
                {option.status === 'available' ? '' : ' (unavailable)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </FormSection>
  );
}
