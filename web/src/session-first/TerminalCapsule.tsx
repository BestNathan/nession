import type { ReactNode } from 'react';
import { ChevronUp, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type CapsuleMode = 'input' | 'commands';

export interface TerminalCapsuleProps {
  mode: CapsuleMode;
  onModeChange: (mode: CapsuleMode) => void;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  disabled?: boolean;
  inputPanel: ReactNode;
  commandsPanel: ReactNode;
}

export function TerminalCapsule({
  mode,
  onModeChange,
  expanded,
  onExpandedChange,
  disabled = false,
  inputPanel,
  commandsPanel,
}: TerminalCapsuleProps) {
  return (
    <div
      data-testid="terminal-capsule"
      data-disabled={disabled ? 'true' : undefined}
      className="absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-10 flex flex-col gap-2"
    >
      {expanded ? (
        <div
          data-testid="terminal-capsule-sheet"
          className={cn(
            'max-h-[28vh] overflow-auto rounded-2xl lg:max-h-[32vh]',
            'border border-border/60 bg-background/95 shadow-lg backdrop-blur-sm',
          )}
        >
          {mode === 'input' ? inputPanel : commandsPanel}
        </div>
      ) : null}

      <div
        className={cn(
          'flex flex-row items-center gap-1 rounded-full',
          'border border-border/60 bg-background/95 px-2 py-1.5 shadow-lg backdrop-blur-sm',
          'max-lg:min-h-11 max-lg:py-2',
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="max-lg:size-11 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]"
          data-testid="terminal-capsule-expand"
          disabled={disabled}
          aria-label={expanded ? 'Collapse capsule' : 'Expand capsule'}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? <ChevronUp className="size-4" /> : <Plus className="size-4" />}
        </Button>

        {!expanded ? (
          <span className="min-w-0 flex-1 truncate px-2 text-sm text-muted-foreground">
            {mode === 'input' ? 'Send input…' : 'Quick commands'}
          </span>
        ) : null}

        <Button
          type="button"
          variant={mode === 'input' ? 'secondary' : 'ghost'}
          size="sm"
          className="rounded-full max-lg:min-h-11 max-lg:px-3 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]"
          data-testid="terminal-capsule-mode-input"
          disabled={disabled}
          onClick={() => onModeChange('input')}
        >
          Input
        </Button>
        <Button
          type="button"
          variant={mode === 'commands' ? 'secondary' : 'ghost'}
          size="sm"
          className="rounded-full max-lg:min-h-11 max-lg:px-3 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]"
          data-testid="terminal-capsule-mode-commands"
          disabled={disabled}
          onClick={() => onModeChange('commands')}
        >
          Commands
        </Button>
      </div>
    </div>
  );
}
