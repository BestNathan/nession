import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  labelClass: string;
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
  labelClass,
  onChange,
  onRemove,
}: SandboxKvRowProps) {
  const hint = option
    ? `${option.value_format} — e.g. ${option.example}`
    : 'Known keys and their native value formats appear here.';
  return (
    <div
      data-testid={`sandbox-${group}-row-${index}`}
      className="flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-surface)] bg-muted/30 p-2"
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label
            htmlFor={`sandbox-${group}-key-${index}`}
            className={cn(labelClass, 'text-muted-foreground')}
          >
            Key
          </label>
          <Input
            id={`sandbox-${group}-key-${index}`}
            data-testid={`sandbox-${group}-key-${index}`}
            list={listId}
            value={row.key}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => onChange({ key: event.target.value })}
          />
          {keyError ? (
            <p
              data-testid={`sandbox-${group}-key-error-${index}`}
              className={cn(chromeSansRole('caption'), 'text-destructive')}
            >
              {keyError}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label
            htmlFor={`sandbox-${group}-value-${index}`}
            className={cn(labelClass, 'text-muted-foreground')}
          >
            Value
          </label>
          <Input
            id={`sandbox-${group}-value-${index}`}
            data-testid={`sandbox-${group}-value-${index}`}
            value={row.value}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => onChange({ value: event.target.value })}
          />
          {valueError ? (
            <p
              data-testid={`sandbox-${group}-value-error-${index}`}
              className={cn(chromeSansRole('caption'), 'text-destructive')}
            >
              {valueError}
            </p>
          ) : null}
        </div>
      </div>
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
    </div>
  );
}
