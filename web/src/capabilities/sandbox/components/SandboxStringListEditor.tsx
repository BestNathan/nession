import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

export interface SandboxStringListEditorProps {
  title: string;
  items: string[];
  placeholder: string;
  addLabel: string;
  testIdPrefix: string;
  emptyText: string;
  disabledReason: string | null;
  onAdd: () => void;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}

/**
 * One managed string list (filesystem paths, egress destinations) (#3143).
 *
 * Each row is an explicit Add/Edit/Remove entry rather than an undifferentiated
 * text area. The value belongs to the canonical draft; this component owns no
 * policy interpretation of its own.
 */
export function SandboxStringListEditor({
  title,
  items,
  placeholder,
  addLabel,
  testIdPrefix,
  emptyText,
  disabledReason,
  onAdd,
  onChange,
  onRemove,
}: SandboxStringListEditorProps) {
  const disabled = disabledReason !== null;
  return (
    <div data-testid={testIdPrefix} className="flex min-w-0 flex-col gap-2">
      <span className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>{title}</span>
      {disabledReason ? (
        <p
          data-testid={`${testIdPrefix}-disabled`}
          className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
        >
          {disabledReason}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p
          data-testid={`${testIdPrefix}-empty`}
          className={cn(chromeSansRole('secondary'), 'text-muted-foreground')}
        >
          {emptyText}
        </p>
      ) : null}
      {items.map((item, index) => (
        <div
          key={index}
          data-testid={`${testIdPrefix}-row-${index}`}
          className="flex min-w-0 items-center gap-2"
        >
          <Input
            aria-label={`${title} ${index + 1}`}
            data-testid={`${testIdPrefix}-${index}`}
            value={item}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => onChange(index, event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid={`${testIdPrefix}-remove-${index}`}
            aria-label={`Remove ${title} ${index + 1}`}
            disabled={disabled}
            onClick={() => onRemove(index)}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`${testIdPrefix}-add`}
          disabled={disabled}
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}
