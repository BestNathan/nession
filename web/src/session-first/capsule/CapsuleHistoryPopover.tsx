import { useState } from 'react';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { cn } from '@/lib/utils';

interface CapsuleHistoryPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  onSelect: (command: string) => void;
  triggerClassName?: string;
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export function CapsuleHistoryPopover({
  open,
  onOpenChange,
  disabled = false,
  onSelect,
  triggerClassName,
}: CapsuleHistoryPopoverProps) {
  const [query, setQuery] = useState('');
  const { filterHistory } = useCommandHistory();
  const entries = filterHistory(query);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            data-testid="capsule-history-trigger"
            className={cn('max-lg:min-h-11', triggerClassName)}
            aria-label="Command history"
          >
            <History className="size-4" />
            History
          </Button>
        }
      />
      <PopoverContent
        align="end"
        side="top"
        className="max-h-[45vh] w-80 overflow-hidden border-border/60 bg-[var(--sf-terminal-well)]/95 p-0 text-foreground"
      >
        <PopoverHeader className="gap-2 border-b border-border/60 p-2">
          <PopoverTitle>History</PopoverTitle>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search history…"
            className="h-8 text-xs"
            data-testid="capsule-history-search"
          />
        </PopoverHeader>
        <div className="max-h-[38vh] overflow-y-auto p-1">
          {entries.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No matching commands</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                data-testid="capsule-history-item"
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent/40"
                onClick={() => {
                  onSelect(entry.command);
                  onOpenChange(false);
                  setQuery('');
                }}
              >
                <span className="truncate font-mono">{entry.command}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {relativeTime(entry.timestamp)}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
