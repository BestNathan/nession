import type { ReconnectBanner } from '../state/ui';

interface TerminalBannerProps {
  banner: ReconnectBanner;
  reconnectAttempt: number;
}

/**
 * Status overlay banner for the terminal area.
 *
 * Extracted from the inline JSX in components/Terminal.tsx. Renders a yellow
 * "Reconnecting…" banner with a spin icon and attempt counter while the
 * session re-establishes its connection, or a red "Connection lost" banner
 * once the session has failed permanently.
 */
export function TerminalBanner({ banner, reconnectAttempt }: TerminalBannerProps) {
  if (banner === 'none') { return null; }

  return (
    <div
      className={
        banner === 'reconnecting'
          ? 'absolute top-0 left-0 right-0 z-10 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-warning/90 text-warning-foreground'
          : 'absolute top-0 left-0 right-0 z-10 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-destructive/90 text-destructive-foreground'
      }
    >
      {banner === 'reconnecting' ? (
        <>
          <span className="inline-block animate-spin">{'⚡'}</span>
          Reconnecting… (attempt {reconnectAttempt}/10)
        </>
      ) : (
        <>
          <span>{'⚠'}</span>
          Connection lost. Please reload.
        </>
      )}
    </div>
  );
}
