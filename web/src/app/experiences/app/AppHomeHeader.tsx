import { appHeaderBandClass, SessionsMenuButton } from '@/app/patterns/SessionHeader';

/**
 * The App's bar before a Session exists (#1082).
 *
 * Not `AppPageHeader`: that one is a **depth's** bar and Back is its point —
 * "one leave per depth", and a home is the depth everything else is opened
 * from, so a Back there would either do nothing or duplicate the Sessions
 * affordance sitting next to it.
 *
 * What it does carry is the one thing the no-Session root needs and could not
 * otherwise reach: Sessions. It deliberately does **not** carry the Workspace
 * affordance, because Workspace is the depth *around* a piece of work and there
 * is no work yet — `AppLayout` does not even mount that layer.
 *
 * The bar is the same band `SessionHeader` draws, from the same exports, so
 * selecting a Session swaps the contents without moving the chrome.
 */
export function AppHomeHeader({ onOpenDrawer }: { onOpenDrawer?: () => void }) {
  if (!onOpenDrawer) {
    return null;
  }
  return (
    <header data-testid="app-home-header" className={appHeaderBandClass}>
      <SessionsMenuButton onClick={onOpenDrawer} />
    </header>
  );
}
