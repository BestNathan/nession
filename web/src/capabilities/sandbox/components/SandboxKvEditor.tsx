import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormSection } from '@/components/ui/configuration-form';
import { DetailEmpty } from '@/components/ui/resource-detail';
import type {
  SandboxCapabilityCatalog,
  SandboxKvEntry,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  catalogOptions,
  resourceDisabledReason,
  syscallDisabledReason,
} from '../model';
import { SandboxImplementationStatus } from './SandboxImplementationStatus';
import { SandboxKvRow } from './SandboxKvRow';

export interface SandboxKvEditorProps {
  group: 'resource' | 'syscall';
  title: string;
  description: string;
  /** Canonical implementation path this editor composes. */
  implementationPath: string;
  rows: SandboxKvEntry[];
  catalog: SandboxCapabilityCatalog;
  /** Field errors keyed by `resource[0].key` and friends. */
  errors: Record<string, string>;
  onAdd: () => void;
  onChange: (index: number, patch: Partial<SandboxKvEntry>) => void;
  onRemove: (index: number) => void;
}

/**
 * The empty-first native Key/Value editor (#3124, #3161).
 *
 * Both optional groups use the same interaction: zero rows until the user
 * asks for one, Add inserts a blank row, Remove deletes it, and the key input
 * is a suggestion list fed by the Agent's measured implementation catalog —
 * not a hardcoded array. A measured-unavailable key can be typed or kept, but
 * its value is not editable and preflight rejects the row with the Agent's
 * field error; the UI never silently drops it.
 */
export function SandboxKvEditor({
  group,
  title,
  description,
  implementationPath,
  rows,
  catalog,
  errors,
  onAdd,
  onChange,
  onRemove,
}: SandboxKvEditorProps) {
  const options = catalogOptions(catalog, group);
  const disabledReason =
    group === 'resource' ? resourceDisabledReason(catalog) : syscallDisabledReason(catalog);
  const disabled = disabledReason !== null;
  const listId = `sandbox-${group}-key-options`;
  return (
    <FormSection
      title={title}
      description={description}
      testId={`sandbox-${group}-editor`}
    >
      <SandboxImplementationStatus
        catalog={catalog}
        path={implementationPath}
        label={title}
      />
      {disabled ? (
        <DetailEmpty data-testid={`sandbox-${group}-disabled`}>{disabledReason}</DetailEmpty>
      ) : null}
      {rows.length === 0 ? (
        <DetailEmpty data-testid={`sandbox-${group}-empty`}>
          No entries. Add a row only if you want this restriction.
        </DetailEmpty>
      ) : null}
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.value_format}
            {option.available ? '' : ` — unavailable: ${option.reason ?? 'not measured'}`}
          </option>
        ))}
      </datalist>
      {rows.map((row, index) => (
        <SandboxKvRow
          key={index}
          group={group}
          title={title}
          index={index}
          row={row}
          option={options.find((candidate) => candidate.key === row.key)}
          keyError={errors[`${group}[${index}].key`]}
          valueError={errors[`${group}[${index}].value`]}
          disabled={disabled}
          listId={listId}
          onChange={(patch) => onChange(index, patch)}
          onRemove={() => onRemove(index)}
        />
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`sandbox-${group}-add`}
          disabled={disabled}
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
          Add entry
        </Button>
      </div>
    </FormSection>
  );
}
