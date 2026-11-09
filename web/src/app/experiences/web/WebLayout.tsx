import { useState, type ComponentProps, type ReactNode } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
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
const shellWidthTransition =
  'transition-[width] duration-[var(--nession-motion-shell-duration)] ease-[var(--nession-motion-shell-ease)] motion-reduce:transition-none';

function FloatingSidebarOpen({
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

/**
 * The Web experience: one frame holding the Session navigation and the work
 * surface.
 *
 * Wide screens render the sidebar as a column; below `lg` the same sidebar is
 * an overlay drawer. #2851 made the wide collapse **fully tuck away**: the
 * column reserves 0px, the work surface receives the width through its normal
 * resize path, and a single floating control returns the sidebar. The column
 * stays mounted while at 0px so selection, search and the list's scroll
 * position survive the round trip; `inert` removes the clipped controls from
 * keyboard and accessibility order until it returns.
 *
 * The narrow overlay exists as an explicit Web mode even though the default
 * narrow viewport is the App experience (see `WorkspaceRegion`). It closes on
 * selection, the top Close action or the scrim, and leaves a visible opening
 * control over the work surface.
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

  return (
    <div className="relative flex min-h-0 flex-1">
      {isWide ? (
        <div
          data-testid="sidebar-column"
          data-collapsed={sidebarCollapsed ? 'true' : undefined}
          aria-hidden={sidebarCollapsed ? true : undefined}
          inert={sidebarCollapsed ? true : undefined}
          className={cn(
            'flex min-h-0 shrink-0 overflow-hidden',
            shellWidthTransition,
            sidebarCollapsed ? 'w-0' : sidebarColumnWidth,
          )}
        >
          <Sidebar
            {...sidebarProps}
            className={sidebarColumnWidth}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
            onSelect={onSelect}
          />
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
        {isWide && sidebarCollapsed ? (
          <FloatingSidebarOpen
            testId="sidebar-open"
            label="Open sidebar"
            onClick={() => setSidebarCollapsed(false)}
          />
        ) : null}
        {!isWide && !showList && onBackToSessions ? (
          <FloatingSidebarOpen
            testId="session-drawer-open"
            label="Open sessions"
            onClick={onBackToSessions}
          />
        ) : null}
        {projectDetail ?? (
          <ShellMain
            {...mainShared}
            surface={surface}
            onOpenDrawer={() => onBackToSessions?.()}
            terminal={terminal}
          />
        )}
      </main>
    </div>
  );
}
