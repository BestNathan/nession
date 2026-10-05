import { PanelLeftClose } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { SessionList } from '@/product/session/patterns/SessionList';
import { SessionListHeader } from '@/app/patterns/SessionListHeader';
import { SidebarAgents } from '@/app/patterns/SidebarAgents';
import { SidebarSectionSeparator } from '@/app/patterns/SidebarSectionHead';
import { SidebarRail } from '@/app/patterns/SidebarRail';
import { SidebarFooter } from '@/app/SidebarFooter';
import { shellIconButtonClass } from '@/app/shellStyles';
import type { SortDirection, SortField, StatusFilter } from '@/app/useDashboard';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/platform/socket';
import type { DomainState } from '@/product/session/model/domainState';

export interface SidebarProps {
  className?: string;
  agents: Agent[];
  filteredSessions: Session[];
  /**
   * Total Sessions before search/filter. The rail quotes this — a collapsed
   * rail saying "2 Sessions" because a hidden filter is active reads as a
   * work count, not as "2 current matches" (#1196 §3).
   */
  totalSessionCount: number;
  staleAgents: string[];
  selectedId: string | null;
  clientSessionId: string;
  loadingSessions: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  isSearchActive: boolean;
  connectionStatus: ConnectionState;
  /** The active Session's domain state, for the footer's status line. */
  domain: DomainState | null;
  /** False when the sidebar is an overlay drawer, where collapsing is meaningless. */
  collapsible?: boolean;
  /**
   * Controlled collapse state, owned by the composition (`WebLayout`) — the
   * column geometry and this rendering are two views of one state (#1196 §5),
   * never two booleans that can disagree.
   */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onSelect: (session: Session) => void;
  onConfigure: (session: Session) => void;
  onKill: (session: Session) => void;
}

/**
 * The Web shell's sidebar: three sections, and a rail.
 *
 * Top is infrastructure identity (Agents), middle is the flat Session list,
 * bottom is service status. That distribution is #748's answer to removing the
 * Web header — the header's duties moved here rather than disappearing:
 * Session identity to the selected row below, location context to Agents, and
 * service status to the footer.
 *
 * Sessions are **not** grouped under their Agent. `session-list.md` makes flat
 * the default and names Agent-grouped sections an anti-pattern; the Agents
 * section above reports infrastructure, it is not a hierarchy to file Sessions
 * into.
 *
 * Collapse is #1196's model: one control, in the Agents section head — the
 * same top-edge navigation zone the rail's Expand occupies — while the footer
 * keeps only service status. The state itself is the composition's, passed in
 * controlled, because collapsing changes the shell's column geometry (#1195).
 */
/**
 * The one collapse control (#1196 §1). It lives in the Agents section head —
 * the same top navigation zone the rail's Expand returns to — not in the
 * service footer, where it read as a service action and "jumped" to the rail's
 * top on collapse.
 */
function CollapseControl({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button
      type="button"
      data-testid="sidebar-collapse"
      aria-label="Collapse sidebar"
      title="Collapse sidebar"
      onClick={onCollapse}
      className={cn(shellIconButtonClass, 'rounded-[var(--radius-control)] hover:bg-accent hover:text-accent-foreground')}
    >
      <PanelLeftClose className="size-[length:var(--nession-icon-md)]" aria-hidden />
    </button>
  );
}

export function Sidebar({
  className,
  agents,
  filteredSessions,
  totalSessionCount,
  staleAgents,
  selectedId,
  clientSessionId,
  loadingSessions,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  sortField,
  sortDirection,
  toggleSort,
  isSearchActive,
  connectionStatus,
  domain,
  collapsible = true,
  collapsed = false,
  onCollapsedChange,
  onCreate,
  onRefresh,
  onSelect,
  onConfigure,
  onKill,
}: SidebarProps) {
  const onlineCount = agents.filter((agent) => agent.status === 'online').length;
  const offlineCount = agents.filter((agent) => agent.status !== 'online').length;
  const createDisabled = agents.every((agent) => agent.status !== 'online');

  const selectedSession = filteredSessions.find((s) => s.session_id === selectedId) ?? null;
  const activeAgentId = selectedSession?.agent_id ?? null;

  if (collapsible && collapsed) {
    return (
      <aside
        data-testid="sidebar"
        data-collapsed="true"
        /* No border anywhere in the collapsed state: the column wrapper no
           longer draws one, and the rail sits inside `shell.railWidth` exactly. */
        className="bg-sidebar flex h-full shrink-0 flex-col"
      >
        <SidebarRail
          connectionStatus={connectionStatus}
          agentCount={agents.length}
          onlineAgentCount={onlineCount}
          sessionCount={totalSessionCount}
          shownSessionCount={filteredSessions.length}
          onExpand={() => onCollapsedChange?.(false)}
        />
      </aside>
    );
  }

  return (
    <aside
      data-testid="sidebar"
      className={cn('bg-sidebar flex h-full w-full shrink-0 flex-col', className)}
    >
      <SidebarAgents
        agents={agents}
        activeAgentId={activeAgentId}
        action={
          collapsible ? (
            <CollapseControl onCollapse={() => onCollapsedChange?.(true)} />
          ) : undefined
        }
      />
      {/* Inset rule, not a full-bleed border: the mockup draws `margin: 8px`,
          so the sections read as divisions inside one column rather than as
          separate panels. */}
      <SidebarSectionSeparator />
      <SessionListHeader
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
        sortField={sortField}
        sortDirection={sortDirection}
        toggleSort={toggleSort}
        onCreate={onCreate}
        createDisabled={createDisabled}
        onRefresh={onRefresh}
        loadingSessions={loadingSessions}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SessionList
          sessions={filteredSessions}
          agents={agents}
          staleAgentIds={staleAgents}
          selectedId={selectedId}
          clientSessionId={clientSessionId}
          loading={loadingSessions}
          isSearchActive={isSearchActive}
          onSelect={onSelect}
          onConfigure={onConfigure}
          onKill={onKill}
        />
      </div>
      <div
        data-testid="sidebar-footer"
        className="flex shrink-0 items-center gap-[var(--nession-shell-foot-gap)] border-t px-[var(--nession-shell-space-3)] py-[var(--nession-shell-foot-pad-y)] pb-[max(var(--nession-shell-foot-pad-y),env(safe-area-inset-bottom))]"
      >
        {/* Service status only — the collapse control moved to the Agents
            section head (#1196 §1). */}
        <SidebarFooter
          domain={domain}
          connectionStatus={connectionStatus}
          nodeCount={agents.length}
        />
      </div>
    </aside>
  );
}
