import type { CapabilityFacts } from './model';

/**
 * How many distinct commands a session is remembered as having run.
 *
 * The list exists so a provider can tell "this session used X earlier" from
 * "this session has never used X". Repeats do not grow it, and old entries fall
 * off the front, so a long-lived session stays bounded.
 */
export const MAX_OBSERVED_COMMANDS = 16;

/**
 * Fold one observation of a session's foreground command into its facts.
 *
 * Facts record what was seen; interpreting them (which command means which
 * capability) stays with the provider.
 */
export function observeSessionCommand(
  previous: CapabilityFacts | undefined,
  command: string | null | undefined,
): CapabilityFacts {
  const observed = previous?.sessionObservedCommands ?? [];
  const next = command
    ? [...observed.filter((seen) => seen !== command), command]
    : [...observed];

  return {
    ...previous,
    sessionForegroundCommand: command ?? null,
    sessionObservedCommands: next.slice(-MAX_OBSERVED_COMMANDS),
  };
}
