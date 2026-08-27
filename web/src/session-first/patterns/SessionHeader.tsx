import { AgentContext } from '@/session-first/patterns/AgentContext';
import { ConnectionStatus } from '@/session-first/patterns/ConnectionStatus';
import {
  SurfaceSwitcher,
  type Surface,
} from '@/session-first/patterns/SurfaceSwitcher';
import type { DomainState } from '@/session-first/domainState';

export type { Surface };

export interface SessionHeaderProps {
  sessionName: string;
  agentLabel: string;
  state: DomainState;
  surface: Surface;
  onSurfaceChange: (surface: Surface) => void;
  onOpenAgent: () => void;
}

export function SessionHeader({
  sessionName,
  agentLabel,
  state,
  surface,
  onSurfaceChange,
  onOpenAgent,
}: SessionHeaderProps) {
  return (
    <header className="flex flex-row flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
      <h1 className="text-sm font-semibold">{sessionName}</h1>
      <AgentContext agentLabel={agentLabel} state={state} onOpenAgent={onOpenAgent} />
      <div className="text-xs [&_[data-testid^=channel-]]:gap-x-2">
        <ConnectionStatus state={state} />
      </div>
      <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
    </header>
  );
}
