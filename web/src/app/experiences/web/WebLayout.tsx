import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { ShellMain } from '@/app/ShellMain';
import { Sidebar } from '@/app/Sidebar';
import { SessionDrawer } from '@/app/SessionDrawer';
import { SidebarRail } from '@/app/patterns/SidebarRail';
import { emptyProjectShell } from '@/product/project/types';
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
  sidebarProps: Omit<
    SidebarProps,
    'onSelect' | 'collapsible' | 'collapsed' | 'onCollapsedChange' | 'onCloseDrawer'
  >;
  onSelect: (session: Session) => void;
  onConfigure: (session: Session) => void;
  /** Everything the work region needs except what differs per experience. */
  mainShared: Omit<MainProps, 'surface' | 'onOpenDrawer' | 'terminal'>;
  surface: Surface;
  /** Fixture/testing override for the terminal; see `ShellMain.terminal`. */
  terminal?: MainProps['terminal'];
  /**
   * A standalone Project detail destination (#3025). It replaces the Session
   * work region without changing the selected Session, so the Terminal stays
   * mounted behind it in the App and selecting a Session returns to it.
   */
  projectDetail?: ReactNode;
}

const sidebarColumnWidth = 'w-[min(var(--nession-shell-sidebar-width),90vw)]';
const railColumnWidth = 'w-[length:var(--nession-shell-rail-width)]';
const shellWidthTransition =
  'transition-[width] duration-[var(--nession-motion-shell-duration)] ease-[var(--nession-motion-shell-ease)] motion-reduce:transition-none';

/** The narrow Web drawer's reopening control — the only floating control left. */
function FloatingDrawerOpen({
  testId,
  label,
  onClick,
}: {
  testId: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={() => onClick()}
      className={cn(
        'absolute left-[var(--nession-shell-space-3)] top-[var(--nession-shell-space-3)] z-20',
        'size-[length:var(--nession-shell-icon-button-size)] rounded-[var(--nession-radius-control)]',
        'bg-background text-muted-foreground shadow-[var(--nession-elevation-floating)] hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <PanelLeftOpen className="size-[length:var(--nession-icon-md)]" aria-hidden />
    </Button>
  );
}

/** The rail/column focus round trip (#3075). */
function useSidebarFocus(
  sidebarCollapsed: boolean,
  setSidebarCollapsed: (collapsed: boolean) => void,
) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const railExpandRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<'collapse' | 'search' | null>(null);

  // The collapsed rail moves focus to its own Expand; expanding moves focus to
  // the action the user chose (the column's collapse toggle, or Search). The
  // sidebar is never unmounted, so there is no restoration problem beyond this.
  useEffect(() => {
    if (sidebarCollapsed) {
      railExpandRef.current?.focus();
      return;
    }
    if (pendingFocus.current === 'collapse') {
      collapseButtonRef.current?.focus();
    } else if (pendingFocus.current === 'search') {
      searchInputRef.current?.focus();
    }
    pendingFocus.current = null;
  }, [sidebarCollapsed]);

  return {
    searchInputRef,
    collapseButtonRef,
    railExpandRef,
    expand: (focus: 'collapse' | 'search') => {
      pendingFocus.current = focus;
      setSidebarCollapsed(false);
    },
  };
}

/**
 * The Web experience: one frame holding the Session navigation and the work
 * surface.
 *
 * Wide screens render the sidebar as an in-flow column; below `lg` the same
 * sidebar is an overlay drawer. Collapse is one state owned here (#1195):
 * expanded reserves the Session-first 246px column, collapsed reserves the
 * **56px navigation rail** (#3075, superseding #2851's 0px tuck-away). The rail
 * is a real flex sibling — Main begins at its right edge and no control floats
 * over the work surface. The expanded Sidebar stays mounted and `inert` while
 * collapsed, so selection, search and the list's scroll position survive.
 *
 * The narrow overlay exists as an explicit Web mode even though the default
 * narrow viewport is the App experience (see `WorkspaceRegion`). It closes on
 * selection, the top Close action, Escape or the scrim, and keeps its own
 * floating opening control; it never reserves a rail.
 */
export function WebLayout(props: WebLayoutProps) {
  const {
    isWide,
    showList,
    onCloseDrawer,
    onBackToSessions,
    sidebarProps,
    onSelect,
    onConfigure,
    mainShared,
    surface,
    terminal,
    projectDetail,
  } = props;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { searchInputRef, collapseButtonRef, railExpandRef, expand } =
    useSidebarFocus(sidebarCollapsed, setSidebarCollapsed);

  const projectShell = sidebarProps.projectShell ?? emptyProjectShell();
  const createDisabled = sidebarProps.agents.every((agent) => agent.status !== 'online');

  return (
    <div className="relative flex min-h-0 flex-1">
      {isWide ? (
        <div
          data-testid="sidebar-column"
          data-collapsed={sidebarCollapsed ? 'true' : undefined}
          className={cn(
            'relative flex min-h-0 shrink-0 overflow-hidden',
            shellWidthTransition,
            sidebarCollapsed ? railColumnWidth : sidebarColumnWidth,
          )}
        >
          {/* The expanded column stays mounted while collapsed: `inert` and
              `invisible` remove it from focus and the accessibility tree
              without discarding its search, selection or list scroll. */}
          <div
            data-testid="sidebar-full"
            inert={sidebarCollapsed ? true : undefined}
            className={cn(
              'flex min-h-0',
              sidebarCollapsed
                ? cn('pointer-events-none invisible absolute inset-y-0 left-0', sidebarColumnWidth)
                : 'w-full',
            )}
          >
            <Sidebar
              {...sidebarProps}
              className="w-full"
              collapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
              onSelect={onSelect}
              searchInputRef={searchInputRef}
              collapseButtonRef={collapseButtonRef}
            />
          </div>
          {sidebarCollapsed ? (
            <SidebarRail
              expandRef={railExpandRef}
              onExpand={() => expand('collapse')}
              onCreate={() => sidebarProps.onCreate()}
              createDisabled={createDisabled}
              onSearch={() => expand('search')}
              connectionStatus={sidebarProps.connectionStatus}
              projectShell={projectShell}
            />
          ) : null}
        </div>
      ) : (
        <SessionDrawer
          open={showList}
          onClose={() => onCloseDrawer()}
          sidebar={
            <Sidebar
              {...sidebarProps}
              collapsible={false}
              onCloseDrawer={onCloseDrawer}
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
      {/* `min-w-0` is load-bearing. As a flex item this column defaults to
          `min-width: auto`, which floors it at the Terminal's fixed grid width;
          collapsing was fine, but expanding could leave the row wider than the
          viewport. Keep it explicit. */}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {!isWide && !showList && onBackToSessions ? (
          <FloatingDrawerOpen
            testId="session-drawer-open"
            label="Open sessions"
            onClick={onBackToSessions}
          />
        ) : null}
        {/* The Terminal stays mounted at its real size behind a standalone
            Project destination (#3025/#3075). Replacing ShellMain would
            unmount xterm and the attach state, turning "return to the same
            Session" into a reconnect. */}
        <ShellMain
          {...mainShared}
          surface={surface}
          onOpenDrawer={() => onBackToSessions?.()}
          terminal={terminal}
        />
        {projectDetail ? (
          <div
            data-testid="web-project-detail"
            className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-y-auto bg-background"
          >
            {projectDetail}
          </div>
        ) : null}
      </main>
    </div>
  );
}
