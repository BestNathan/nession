import type { ComponentProps } from 'react';
import { ShellMain } from '@/app/ShellMain';
import { Sidebar } from '@/app/Sidebar';
import { SessionDrawer } from '@/app/SessionDrawer';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { Session } from '@/types';

type SidebarProps = ComponentProps<typeof Sidebar>;
export type MainProps = ComponentProps<typeof ShellMain>;

export interface WebLayoutProps {
  /** Above the `lg` breakpoint the sidebar is a column; below it, an overlay. */
  isWide: boolean;
  /** Whether the narrow-width list overlay is open. */
  showList: boolean;
  onCloseDrawer: () => void;
  onBackToSessions?: () => void;
  /** Everything the sidebar needs except how it reports a selection. */
  sidebarProps: Omit<SidebarProps, 'onSelect' | 'collapsible'>;
  onSelect: (session: Session) => void;
  onConfigure: (session: Session) => void;
  /** Everything the work region needs except what differs per experience. */
  mainShared: Omit<MainProps, 'surface' | 'onOpenDrawer' | 'terminal'>;
  surface: Surface;
  /** Fixture/testing override for the terminal; see `ShellMain.terminal`. */
  terminal?: MainProps['terminal'];
}

/**
 * The Web experience: one frame holding the session list and the work surface,
 * with the list as either a column or an overlay depending on width.
 *
 * This is a composition, not a product meaning — it decides where things sit on
 * a wide screen, which is exactly what `docs/architecture/web.md` assigns to
 * `app/experiences/`. The App experience composes the same Product Patterns
 * into a spatial shell instead (`app/experiences/app/`); both are handed the
 * same `sidebarProps` / `mainShared` by `WorkspaceRegion`, so the two
 * arrangements cannot drift in what they are given.
 */
export function WebLayout(props: WebLayoutProps) {
  const { isWide, showList, onCloseDrawer, onBackToSessions, sidebarProps, onSelect, onConfigure, mainShared, surface, terminal } = props;

  return (
    <div className="relative flex min-h-0 flex-1">
      {isWide ? (
        /* Two columns above `lg` (the breakpoint the contract schema's enum
           permits and `useMobileNav` already uses). The sidebar is a
           real column here — it used to be an overlay drawer at every width,
           which meant the work surface never actually shared the frame. */
        <div
          data-testid="sidebar-column"
          /* No border: the sidebar carries the chrome surface and the work
             region sits on the canvas, so the background shift is the
             separator (visual-language.md P7 — background shift before
             border). The mockup draws no rule here either. */
          className="flex min-h-0 w-[min(var(--shell-sidebar-width),90vw)] shrink-0"
        >
          <Sidebar {...sidebarProps} onSelect={onSelect} />
        </div>
      ) : (
        /* Below `lg` the sidebar is still an overlay: there is no room for a
           column that the work surface would have to share. */
        <SessionDrawer
          open={showList}
          onClose={() => onCloseDrawer()}
          sidebar={
            <Sidebar
              {...sidebarProps}
              collapsible={false}
              onSelect={(session) => {
                onCloseDrawer();
                onSelect(session);
              }}
              onConfigure={(session) => {
                onCloseDrawer();
                onConfigure(session);
              }}
            />
          }
        />
      )}
      <main className="flex min-h-0 flex-1 flex-col">
        <ShellMain
          {...mainShared}
          surface={surface}
          onOpenDrawer={() => onBackToSessions?.()}
          terminal={terminal}
        />
      </main>
    </div>
  );
}
