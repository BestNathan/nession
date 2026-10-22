import { useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Bot, Monitor, Plus, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agentDisplayName } from '@/shared/lib/format';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { Agent, Session } from '@/types';
import { resolveUIIntent, type UIIntent } from './intent';

interface Turn {
  id: number;
  message: string;
  intent: UIIntent;
}

export interface AIExperienceProps {
  agents: Agent[];
  sessions: Session[];
  onCreateSession: (agentId?: string) => void;
  onOpenSession: (session: Session) => void;
}

/**
 * The prototype is a UI-capability dispatcher, not a generative chat client.
 * Each successful request reveals a predefined view over live Nession state.
 * All mutations and terminal attachment flow through the existing Shell.
 */
export function AIExperience({
  agents, sessions, onCreateSession, onOpenSession,
}: AIExperienceProps) {
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(0);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) { return; }

    const intent = resolveUIIntent(message, agents);
    const id = ++nextId.current;
    setTurns((current) => [...current, { id, message, intent }]);
    setDraft('');

    if (intent.type === 'session.create') {
      onCreateSession(intent.agentId);
    }
  };

  return (
    <section
      data-testid="ai-mode"
      aria-label="AI mode"
      className="flex min-h-0 w-full flex-1 flex-col bg-background"
    >
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 sm:px-6">
        <div
          data-testid="ai-transcript"
          aria-live="polite"
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto py-8',
            turns.length === 0 && 'justify-center',
          )}
        >
          {turns.length === 0 ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <Bot className="size-8 text-foreground" aria-hidden />
              <h1 className={cn('tracking-tight', chromeSansRole('title'))}>What can I do for you?</h1>
              <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
                Ask Nession to open a capability.
              </p>
            </div>
          ) : turns.map((turn) => (
            <div key={turn.id} className="flex flex-col gap-4">
              <div className="flex justify-end">
                <p className={cn(
                  'max-w-[85%] rounded-2xl bg-muted px-4 py-3 text-foreground',
                  chromeSansRole('body'),
                )}>{turn.message}</p>
              </div>
              <div className="flex min-w-0 flex-col gap-3">
                {turn.intent.type === 'agent.list' ? (
                  <>
                    <p className={chromeSansRole('body')}>
                      {agents.length} Agents · {agents.filter((agent) => agent.status === 'online').length} online
                    </p>
                    <div data-testid="ai-agent-list" className="divide-y rounded-xl border">
                      {agents.length === 0 ? (
                        <p className="p-4 text-muted-foreground">No agents are registered.</p>
                      ) : agents.map((agent) => (
                        <div key={agent.agent_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                          <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{agentDisplayName(agent)}</p>
                            <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
                              {agent.status} · {agent.session_count} sessions
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={agent.status !== 'online'}
                            onClick={() => onCreateSession(agent.agent_id)}
                            aria-label={`Create Session on ${agentDisplayName(agent)}`}
                          >
                            <Plus className="size-4" aria-hidden />
                            Create Session
                          </Button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {turn.intent.type === 'session.list' ? (
                  <>
                    <p className={chromeSansRole('body')}>{sessions.length} Sessions</p>
                    <div data-testid="ai-session-list" className="divide-y rounded-xl border">
                      {sessions.length === 0 ? (
                        <p className="p-4 text-muted-foreground">No sessions found.</p>
                      ) : sessions.map((session) => (
                        <div key={session.session_id} className="flex items-center gap-3 px-4 py-3">
                          <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{session.session_name}</p>
                            <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
                              {agentDisplayName(agents.find((agent) => agent.agent_id === session.agent_id) ?? { hostname: session.agent_id })}
                              {' · '}{session.status}
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => onOpenSession(session)}
                            aria-label={`Open Session ${session.session_name}`}
                          >
                            Open
                          </Button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {turn.intent.type === 'session.create' ? (
                  <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
                    Opened the existing Create Session dialog. Confirm there to create it.
                  </p>
                ) : null}
                {turn.intent.type === 'unsupported' ? (
                  <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
                    This prototype recognises Agent lists, Session lists and Create Session.
                    No action was performed.
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={submit} className="flex shrink-0 items-center gap-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3">
          <Input
            aria-label="Nession command"
            autoComplete="off"
            placeholder="Ask Nession…"
            className="h-12 rounded-xl px-4"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={!draft.trim()} className="size-12 shrink-0 rounded-xl">
            <ArrowUp className="size-4" aria-hidden />
          </Button>
        </form>
      </div>
    </section>
  );
}
