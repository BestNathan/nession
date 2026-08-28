import { X } from 'lucide-react';
import type { ConnectionStatus } from '@/types';
import { ConnectionStatusBadge } from '@/components/ui/ConnectionStatusBadge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface SessionFirstChromeProps {
  connectionStatus: ConnectionStatus;
  error: string | null;
  clearError: () => void;
}

export function SessionFirstChrome({
  connectionStatus,
  error,
  clearError,
}: SessionFirstChromeProps) {
  return (
    <>
      <header
        data-testid="session-first-chrome"
        className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-background px-4 py-2"
      >
        <h1 className="text-lg font-semibold tracking-tight">Nession</h1>
        <ConnectionStatusBadge status={connectionStatus} />
      </header>
      {error ? (
        <div
          data-testid="session-first-error"
          className="flex shrink-0 items-center gap-2 bg-destructive/10 px-3 py-2 text-destructive text-sm"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  aria-label="Dismiss error"
                  onClick={() => clearError()}
                />
              }
            >
              <X className="size-3" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Dismiss</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </>
  );
}
