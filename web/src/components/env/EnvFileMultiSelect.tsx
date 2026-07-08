import { useState, useMemo } from 'react';
import { Check, Search, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Badge } from '../ui/badge';
import type { EnvFileInfo, EnvFileRef } from '../../types';
import { refKey, toRef, sourceLabel } from './envRef';

interface EnvFileMultiSelectProps {
  files: EnvFileInfo[];
  selected: EnvFileRef[];
  onChange: (selected: EnvFileRef[]) => void;
  disabled?: boolean;
  /** Shown when the file list is empty. */
  emptyLabel?: string;
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
    <div className="space-y-2">
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
      <ScrollArea className="h-40 rounded-md border">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">
            {files.length === 0 ? emptyLabel : 'No files match your search'}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((file) => {
              const isSelected = selectedKeys.has(refKey(file));
              return (
                <button
                  type="button"
                  key={refKey(file)}
                  onClick={() => toggle(file)}
                  disabled={disabled}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-accent/50 transition-colors',
                    isSelected && 'bg-accent/30',
                  )}
                >
                  <span
                    className={cn(
                      'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0',
                      isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/40',
                    )}
                  >
                    {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                  </span>
                  <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="flex-1 text-sm truncate">{file.name}</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {sourceLabel(file)}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground w-10 text-right">
                    {file.var_count} var{file.var_count !== 1 ? 's' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
      {selected.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {selected.length} file{selected.length !== 1 ? 's' : ''} selected
        </p>
      )}
    </div>
  );
}
