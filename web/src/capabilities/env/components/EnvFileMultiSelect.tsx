import { useState, useMemo } from 'react';
import { ArrowDown, ArrowUp, Check, FileText, Search, X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import type { EnvFileInfo, EnvFileRef } from '@/types';
import { refKey, toRef, sourceLabel } from '@/capabilities/env/model/envRef';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

interface EnvFileMultiSelectProps {
  files: EnvFileInfo[];
  selected: EnvFileRef[];
  onChange: (selected: EnvFileRef[]) => void;
  disabled?: boolean;
  /** Shown when the file list is empty. */
  emptyLabel?: string;
  /**
   * The list's own scroll box height (#3089). A roomy dialog can show more
   * than the original 160px; an App operation page passes `scroll={false}` so
   * the page, not a nested box, is the one scroll owner.
   */
  listClassName?: string;
  scroll?: boolean;
  /**
   * Render the selection as an ordered list above the picker (#3649).
   *
   * The selection order is semantic — later files win — so a consumer that
   * declares an ordered reference list needs move controls, not just the
   * picker's insertion order. A selected ref absent from `files` stays in the
   * list and is marked missing rather than silently dropped.
   */
  reorderable?: boolean;
}

function SelectedOrder({
  selected,
  files,
  disabled,
  onChange,
}: {
  selected: EnvFileRef[];
  files: EnvFileInfo[];
  disabled?: boolean;
  onChange: (selected: EnvFileRef[]) => void;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    const next = [...selected];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onChange(next);
  };
  const missing = selected.filter(
    (ref) => !files.some((file) => refKey(file) === refKey(ref)),
  );

  return (
    <div className="flex flex-col gap-2">
      <ol
        data-testid="env-selected-order"
        className="divide-y divide-border rounded-[var(--nession-radius-surface)] border"
      >
        {selected.map((ref, index) => (
          <li
            key={refKey(ref)}
            data-testid={`env-selected-${refKey(ref)}`}
            className="flex items-center gap-2 px-2 py-1.5"
          >
            <span className={cn('w-5 shrink-0 text-muted-foreground', chromeSansRole('metadata'))}>
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn('block truncate', chromeSansRole('primary'))}
                title={ref.name}
              >
                {ref.name}
              </span>
              <span className={cn('block truncate text-muted-foreground', chromeSansRole('metadata'))}>
                {sourceLabel(ref)}
                {missing.some((candidate) => refKey(candidate) === refKey(ref))
                  ? ' · missing'
                  : ''}
              </span>
            </span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Move ${ref.name} earlier`}
              data-testid={`env-selected-up-${refKey(ref)}`}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Move ${ref.name} later`}
              data-testid={`env-selected-down-${refKey(ref)}`}
              disabled={disabled || index === selected.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${ref.name}`}
              data-testid={`env-selected-remove-${refKey(ref)}`}
              disabled={disabled}
              onClick={() => onChange(selected.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ol>
      {missing.length > 0 ? (
        <p
          data-testid="env-selected-missing"
          className={cn('text-destructive', chromeSansRole('caption'))}
        >
          Not in the ENV Library: {missing.map((ref) => ref.name).join(', ')}. A Session
          cannot inherit a missing file.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Searchable multi-select list of env files. Kept as a self-contained list
 * (not a popover) so it drops cleanly into dialogs. Files with the same name
 * from different sources are shown separately with source badges (EC6), and the
 * search box keeps large lists usable (EC12).
 */
export function EnvFileMultiSelect({
  files,
  selected,
  onChange,
  disabled,
  emptyLabel = 'No env files available',
  listClassName = 'h-40',
  scroll = true,
  reorderable = false,
}: EnvFileMultiSelectProps) {
  const [query, setQuery] = useState('');

  const selectedKeys = useMemo(() => new Set(selected.map(refKey)), [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {return files;}
    return files.filter(
      (f) => f.name.toLowerCase().includes(q) || sourceLabel(f).toLowerCase().includes(q),
    );
  }, [files, query]);

  const toggle = (file: EnvFileInfo) => {
    if (disabled) {return;}
    const key = refKey(file);
    if (selectedKeys.has(key)) {
      onChange(selected.filter((r) => refKey(r) !== key));
    } else {
      onChange([...selected, toRef(file)]);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {reorderable && selected.length > 0 ? (
        <SelectedOrder
          selected={selected}
          files={files}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search env files…"
          className="pl-8 h-8"
          disabled={disabled}
        />
      </div>
      <EnvFileList
        filtered={filtered}
        total={files.length}
        selectedKeys={selectedKeys}
        disabled={disabled}
        emptyLabel={emptyLabel}
        onToggle={toggle}
        scroll={scroll}
        listClassName={listClassName}
      />
      {selected.length > 0 && !reorderable && (
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          {selected.length} file{selected.length !== 1 ? 's' : ''} selected
        </p>
      )}
    </div>
  );
}

function EnvFileList({
  filtered,
  total,
  selectedKeys,
  disabled,
  emptyLabel,
  onToggle,
  scroll,
  listClassName,
}: {
  filtered: EnvFileInfo[];
  total: number;
  selectedKeys: Set<string>;
  disabled?: boolean;
  emptyLabel: string;
  onToggle: (file: EnvFileInfo) => void;
  scroll: boolean;
  listClassName: string;
}) {
  const list = (
    <div className={cn('divide-y divide-border', !scroll && 'rounded-[var(--nession-radius-surface)] border')}>
      {filtered.length === 0 ? (
        <p className={cn('py-6 text-center text-muted-foreground', chromeSansRole('metadata'))}>
          {total === 0 ? emptyLabel : 'No files match your search'}
        </p>
      ) : (
        filtered.map((file) => {
          const isSelected = selectedKeys.has(refKey(file));
          return (
            <button
              type="button"
              key={refKey(file)}
              onClick={() => onToggle(file)}
              disabled={disabled}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-accent/50 transition-colors',
                isSelected && 'bg-accent/30',
              )}
            >
              <span
                className={cn(
                  'w-4 h-4 rounded-[var(--nession-radius-control)] border flex items-center justify-center flex-shrink-0',
                  isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/40',
                )}
              >
                {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
              </span>
              <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              <span className={cn('flex-1 min-w-0 break-words', chromeSansRole('secondary'))}>{file.name}</span>
              <Badge variant="outline" className={cn('px-1.5 py-0', chromeSansRole('caption'))}>
                {sourceLabel(file)}
              </Badge>
              <span className={cn('w-10 text-right text-muted-foreground', chromeSansRole('caption'))}>
                {file.var_count} var{file.var_count !== 1 ? 's' : ''}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
  if (!scroll) {
    return list;
  }
  return <ScrollArea className={cn('rounded-[var(--nession-radius-surface)] border', listClassName)}>{list}</ScrollArea>;
}
