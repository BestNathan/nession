import type { ReconnectBanner } from '../terminal';

interface TerminalBannerProps {
  banner: ReconnectBanner;
  reconnectAttempt: number;
}

/**
 * Status overlay banner for the terminal area.
 *
 * Renders an absolutely-positioned banner that overlays the terminal during
 * reconnection or permanent connection-loss states. Uses amber/red color
 * tokens consistent with ConnectionStatusBadge and the shadcn destructive
 * semantic color.
 */
export function TerminalBanner({ banner, reconnectAttempt }: TerminalBannerProps) {
  if (banner === 'none') { return null; }

  const isReconnecting = banner === 'reconnecting';

  return (
    <div
      className={
        isReconnecting
          ? 'absolute top-0 left-0 right-0 z-10 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-warning/90 text-warning-foreground'
          : 'absolute top-0 left-0 right-0 z-10 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-destructive/90 text-destructive-foreground'
      }
    >
      {isReconnecting ? (
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
