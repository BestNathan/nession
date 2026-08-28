import { FileCog, X } from 'lucide-react';
import type { ConnectionStatus } from '@/types';
import { ConnectionStatusBadge } from '@/components/ui/ConnectionStatusBadge';
import { ServerInfoMenu } from '@/components/ServerInfoMenu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { setSessionFirst } from '@/lib/sessionFirst';

export interface SessionFirstChromeProps {
  connectionStatus: ConnectionStatus;
  error: string | null;
  clearError: () => void;
  onOpenEnv: () => void;
  onLegacy: () => void;
}

export function SessionFirstChrome({
  connectionStatus,
  error,
  clearError,
  onOpenEnv,
  onLegacy,
}: SessionFirstChromeProps) {
  return (
    <>
      <header
        data-testid="session-first-chrome"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold">Nession</h1>
          <ConnectionStatusBadge status={connectionStatus} />
        </div>
        <div className="min-w-0 flex-1">
          <ServerInfoMenu />
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="session-first-env"
                  aria-label="Environment files"
                  className="min-h-9 min-w-9 md:min-h-7 md:min-w-0"
                  onClick={() => onOpenEnv()}
                />
              }
            >
              <FileCog className="size-4 md:mr-1" />
              <span className="hidden md:inline">Env Files</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Environment Files</TooltipContent>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="use-legacy-dashboard"
            onClick={() => {
              setSessionFirst(false);
              onLegacy();
            }}
          >
            Legacy
          </Button>
        </div>
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
