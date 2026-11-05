import { useQuickCommands } from '@/capabilities/commands';
import {
  capsuleCaptionTextClass,
  capsuleCommandActionClass,
  capsuleCommandListClass,
  capsuleCommandRowClass,
  capsuleHistoryCommandClass,
  contextCapsuleTitleClass,
} from '@/product/terminal/capsule/capsuleStyles';

/**
 * Quick Commands — the saved-command half of the terminal-tools slot (#2710).
 *
 * The stored list is the session's saved commands from the server owner
 * (`server.commands.list`); this view adds no storage, no ordering and no shell
 * registry of its own. Every row has two explicit actions: **Insert** puts the
 * command in the composer without executing it, and **Run** sends the command
 * with Return. Merely expanding the view never executes anything.
 *
 * Unavailable states are stated rather than papered over: a disconnected server
 * disables Run (Insert still edits local text), and an uncontrollable Session
 * disables both, because a fake successful local echo is the failure mode
 * SC-05 names.
 */
export function QuickCommandsProjection({
  insertText,
  runCommand,
  disabled,
}: {
  insertText: (text: string) => void;
  runCommand: (text: string) => void;
  disabled: boolean;
}) {
  const { commands, status, connected, refresh } = useQuickCommands();

  const unavailableReason = disabled
    ? 'Terminal input is unavailable while this Session is not under your control.'
    : !connected
      ? 'Server connection lost — Run is unavailable until it reconnects.'
      : status === 'error'
        ? 'Saved commands could not be loaded.'
        : null;

  return (
    <div data-testid="quick-commands-body" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between">
        <span className={capsuleCaptionTextClass}>Saved commands</span>
        {status === 'ready' ? (
          <span data-testid="quick-commands-count" className={capsuleCaptionTextClass}>
            {commands.length} {commands.length === 1 ? 'command' : 'commands'}
          </span>
        ) : null}
      </div>

      {status === 'loading' ? (
        <p data-testid="quick-commands-loading" className={capsuleCaptionTextClass}>
          Loading saved commands…
        </p>
      ) : status === 'error' ? (
        <div
          data-testid="quick-commands-error"
          className="flex items-center justify-between gap-[length:var(--nession-terminal-capsule-projection-item-gap)]"
        >
          <span className={capsuleCaptionTextClass}>
            {connected
              ? 'Saved commands could not be loaded.'
              : 'Saved commands cannot load while the server is disconnected.'}
          </span>
          <button
            type="button"
            data-testid="quick-commands-retry"
            onClick={() => refresh()}
            className={capsuleCommandActionClass}
          >
            Retry
          </button>
        </div>
      ) : commands.length === 0 ? (
        <p data-testid="quick-commands-empty" className={capsuleCaptionTextClass}>
          No saved commands yet.
        </p>
      ) : (
        <div data-testid="quick-commands-list" className={capsuleCommandListClass}>
          {commands.map((command) => (
            <div
              key={command.id}
              data-testid={`quick-command-${command.id}`}
              className={capsuleCommandRowClass}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={contextCapsuleTitleClass}>{command.label}</span>
                <code className={capsuleHistoryCommandClass}>{command.command}</code>
              </div>
              <button
                type="button"
                data-testid={`quick-command-insert-${command.id}`}
                aria-label={`Insert ${command.label}`}
                disabled={disabled}
                onClick={() => insertText(command.command)}
                className={capsuleCommandActionClass}
              >
                Insert
              </button>
              <button
                type="button"
                data-testid={`quick-command-run-${command.id}`}
                aria-label={`Run ${command.label}`}
                disabled={disabled || !connected}
                onClick={() => runCommand(command.command)}
                className={capsuleCommandActionClass}
              >
                Run
              </button>
            </div>
          ))}
        </div>
      )}

      {unavailableReason ? (
        <p
          data-testid="quick-commands-unavailable"
          role="status"
          className={capsuleCaptionTextClass}
        >
          {unavailableReason}
        </p>
      ) : null}

      <p className={capsuleCaptionTextClass}>
        Insert edits the composer. Run sends the command with Return.
      </p>
    </div>
  );
}
