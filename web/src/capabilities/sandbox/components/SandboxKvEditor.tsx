import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  SandboxFieldEntry,
  SandboxKvEntry,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { SandboxKvRow } from './SandboxKvRow';

export interface SandboxKvEditorProps {
  group: 'resource' | 'syscall';
  title: string;
  description: string;
  rows: SandboxKvEntry[];
  options: SandboxFieldEntry[];
  /** Why this group's inputs are not available on the current Agent/backend. */
  disabledReason: string | null;
  /** Field errors keyed by `resource[0].key` and friends. */
  errors: Record<string, string>;
  onAdd: () => void;
  onChange: (index: number, patch: Partial<SandboxKvEntry>) => void;
  onRemove: (index: number) => void;
}

/**
 * The empty-first native Key/Value editor (#3124).
 *
 * Both optional groups use the same interaction: zero rows until the user
 * asks for one, Add inserts a blank row, Remove deletes it, and the key input
 * is a suggestion list fed by the Agent's measured catalog — not a hardcoded
 * array. Typing a key the catalog does not list is allowed here because the
 * Agent, not the UI, is the validator; its preflight then rejects it with a
 * field-level error.
 */
export function SandboxKvEditor({
  group,
  title,
  description,
  rows,
  options,
  disabledReason,
  errors,
  onAdd,
  onChange,
  onRemove,
}: SandboxKvEditorProps) {
  const disabled = disabledReason !== null;
  const listId = `sandbox-${group}-key-options`;
  const metadataClass = chromeSansRole('caption');
  return (
    <fieldset
      data-testid={`sandbox-${group}-editor`}
      className="flex min-w-0 flex-col gap-3 rounded-[var(--nession-radius-surface)] border border-border/60 p-3"
    >
      <legend className={cn(chromeSansRole('primary'), 'px-1')}>{title}</legend>
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
