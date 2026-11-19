import { useEffect, useRef } from 'react';

/**
 * Retire the previous provider space when the Session/Agent changes (#3829).
 *
 * The App composition's pushed stack, forward history and write dialogs belong
 * to one provider space. The reset runs once per actual change, not on every
 * render that observes the same key.
 */
export function useClaudeAppContextReset(
  contextKey: string | null,
  reset: () => void,
): void {
  const previousContext = useRef(contextKey);
  useEffect(() => {
    if (previousContext.current === contextKey) {
      return;
    }
    previousContext.current = contextKey;
    reset();
  }, [contextKey, reset]);
}
