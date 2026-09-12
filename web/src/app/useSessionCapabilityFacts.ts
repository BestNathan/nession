import { useEffect, useState } from 'react';
import { observeSessionCommand, type CapabilityFacts } from '@/features/capabilities';
import type { Session } from '@/types';

interface Observation {
  sessionId?: string;
  facts?: CapabilityFacts;
}

/**
 * Fold the selected session's runtime observations into capability facts.
 *
 * The agent reports the pane's foreground command with every session update;
 * this records what each session has been seen running, so a provider can tell
 * "this session uses X" from "this session never has". History is per session —
 * switching sessions must not carry the previous one's history over.
 */
export function useSessionCapabilityFacts(session: Session | null): CapabilityFacts | undefined {
  const sessionId = session?.session_id;
  const command = session?.foreground_command ?? null;
  const [observation, setObservation] = useState<Observation>({});

  useEffect(() => {
    setObservation((previous) => {
      if (!sessionId) {
        return {};
      }
      const history = previous.sessionId === sessionId ? previous.facts : undefined;
      return { sessionId, facts: observeSessionCommand(history, command) };
    });
  }, [sessionId, command]);

  return observation.sessionId === sessionId ? observation.facts : undefined;
}
