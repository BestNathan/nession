import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  FormField,
  FormGrid,
  FormRow,
} from '@/components/ui/configuration-form';
import { Input } from '@/components/ui/input';
import type {
  SandboxFieldEntry,
  SandboxKvEntry,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

export interface SandboxKvRowProps {
  group: 'resource' | 'syscall';
  title: string;
  index: number;
  row: SandboxKvEntry;
  option: SandboxFieldEntry | undefined;
  keyError: string | undefined;
  valueError: string | undefined;
  disabled: boolean;
  listId: string;
  onChange: (patch: Partial<SandboxKvEntry>) => void;
  onRemove: () => void;
}

/** One native Key/Value row; the editor owns add/remove, this owns the inputs. */
export function SandboxKvRow({
  group,
  title,
  index,
  row,
  option,
  keyError,
  valueError,
  disabled,
  listId,
  onChange,
  onRemove,
}: SandboxKvRowProps) {
  const optionUnavailable = option !== undefined && !option.available;
  const valueDisabled = disabled || optionUnavailable;
  const exampleHint = option?.example ? ` — current: ${option.example}` : '';
  const hint = option
    ? optionUnavailable
      ? `${option.value_format} — unavailable: ${option.reason ?? 'not measured on this Agent'}`
      : `${option.value_format}${exampleHint}`
    : 'Discovered native keys and their current values appear here; a key without a hint can still be configured.';
  return (
    <FormRow data-testid={`sandbox-${group}-row-${index}`}>
      <FormGrid>
        <FormField
          id={`sandbox-${group}-key-${index}`}
          label="Key"
          error={keyError}
          errorTestId={`sandbox-${group}-key-error-${index}`}
        >
          <Input
            id={`sandbox-${group}-key-${index}`}
            data-testid={`sandbox-${group}-key-${index}`}
            list={listId}
            value={row.key}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => onChange({ key: event.target.value })}
          />
        </FormField>
        <FormField
          id={`sandbox-${group}-value-${index}`}
          label="Value"
          description={
            optionUnavailable
              ? (option.reason ?? 'This key is not installable on this Agent.')
              : undefined
          }
          descriptionTestId={`sandbox-${group}-value-unavailable-${index}`}
          error={valueError}
          errorTestId={`sandbox-${group}-value-error-${index}`}
        >
          <Input
            id={`sandbox-${group}-value-${index}`}
            data-testid={`sandbox-${group}-value-${index}`}
            value={row.value}
            disabled={valueDisabled}
            autoComplete="off"
            onChange={(event) => onChange({ value: event.target.value })}
          />
        </FormField>
      </FormGrid>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className={cn(chromeSansRole('caption'), 'min-w-0 flex-1 text-muted-foreground')}>
          {hint}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={`sandbox-${group}-remove-${index}`}
          aria-label={`Remove ${title} row ${index + 1}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
          Remove
        </Button>
      </div>
    </FormRow>
  );
}
