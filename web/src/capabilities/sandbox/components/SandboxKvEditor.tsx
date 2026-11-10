import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  SandboxCapabilityCatalog,
  SandboxKvEntry,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
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
  const metadataClass = chromeSansRole('caption');
  return (
    <fieldset
      data-testid={`sandbox-${group}-editor`}
      className="flex min-w-0 flex-col gap-3 rounded-[var(--nession-radius-surface)] border border-border/60 p-3"
    >
      <legend className={cn(chromeSansRole('primary'), 'px-1')}>{title}</legend>
      <SandboxImplementationStatus
        catalog={catalog}
        path={implementationPath}
        label={title}
      />
      <p className={cn(metadataClass, 'text-muted-foreground')}>{description}</p>
      {disabled ? (
        <p
          data-testid={`sandbox-${group}-disabled`}
          className={cn(metadataClass, 'text-muted-foreground')}
        >
          {disabledReason}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p
          data-testid={`sandbox-${group}-empty`}
          className={cn(metadataClass, 'text-muted-foreground')}
        >
          No entries. Add a row only if you want this restriction.
        </p>
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
          labelClass={metadataClass}
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
    </fieldset>
  );
}
