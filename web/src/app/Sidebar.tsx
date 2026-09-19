import { useState } from 'react';
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
 */
export function Sidebar({
  className,
  agents,
  filteredSessions,
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
  onCreate,
  onRefresh,
  onSelect,
  onConfigure,
  onKill,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

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
          onExpand={() => setCollapsed(false)}
        />
      </aside>
    );
  }

  return (
    <aside
      data-testid="sidebar"
      className={cn('bg-sidebar flex h-full w-full shrink-0 flex-col', className)}
    >
      <SidebarAgents agents={agents} activeAgentId={activeAgentId} />
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
        className="flex shrink-0 items-center gap-[var(--shell-foot-gap)] border-t px-[var(--shell-space-3)] py-[var(--shell-foot-pad-y)] pb-[max(var(--shell-foot-pad-y),env(safe-area-inset-bottom))]"
      >
        <SidebarFooter
          domain={domain}
          connectionStatus={connectionStatus}
          nodeCount={agents.length}
        />
        {/* The collapse control lives in the foot, not in the list header. In
            the header it took a row of its own, right-aligned, with an empty
            left half — it read as an icon floating in a gap. The mockup puts
            it here, opposite the service line. */}
        {collapsible ? (
          <button
            type="button"
            data-testid="sidebar-collapse"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            onClick={() => setCollapsed(true)}
            className={cn(shellIconButtonClass, 'rounded-md hover:bg-accent hover:text-accent-foreground')}
          >
            <PanelLeftClose className="size-[length:var(--icon-md)]" aria-hidden />
          </button>
        ) : null}
      </div>
    </aside>
  );
}
