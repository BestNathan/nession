import { ChevronLeft } from 'lucide-react';
import { AgentContext } from '@/session-first/patterns/AgentContext';
import { ConnectionStatus } from '@/session-first/patterns/ConnectionStatus';
import {
  SurfaceSwitcher,
  type Surface,
} from '@/session-first/patterns/SurfaceSwitcher';
import { Button } from '@/components/ui/button';
import type { DomainState } from '@/session-first/domainState';

export type { Surface };

export interface SessionHeaderProps {
  sessionName: string;
  agentLabel: string;
  state: DomainState;
  surface: Surface;
  onSurfaceChange: (surface: Surface) => void;
  onOpenAgent: () => void;
  onBackToSessions?: () => void;
}

export function SessionHeader({
  sessionName,
  agentLabel,
  state,
  surface,
  onSurfaceChange,
  onOpenAgent,
  onBackToSessions,
}: SessionHeaderProps) {
  return (
    <header className="flex flex-row flex-wrap items-center gap-x-[var(--sf-space-3)] gap-y-[var(--sf-space-2)] border-b px-[var(--sf-space-3)] py-[var(--sf-space-3)] max-lg:gap-x-[var(--sf-space-2)] lg:px-[var(--sf-space-4)] lg:py-[var(--sf-space-3)]">
      {onBackToSessions ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 shrink-0 max-lg:size-11 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)] lg:hidden"
          aria-label="Back to sessions"
          data-testid="session-first-back-to-list"
          onClick={() => onBackToSessions()}
        >
          <ChevronLeft className="size-5" />
        </Button>
      ) : null}
      <h1 className="min-w-0 text-base font-semibold">{sessionName}</h1>
      <AgentContext agentLabel={agentLabel} state={state} onOpenAgent={onOpenAgent} />
      <div className="hidden text-xs sm:block [&_[data-testid^=channel-]]:gap-x-2">
        <ConnectionStatus state={state} />
      </div>
      <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
    </header>
  );
}
