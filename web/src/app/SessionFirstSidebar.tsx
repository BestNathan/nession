import { useState } from 'react';
import { PanelLeftClose } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SessionList } from '@/features/sessions/components/SessionList';
import { SessionListHeader } from '@/app/patterns/SessionListHeader';
import { SidebarAgents } from '@/app/patterns/SidebarAgents';
import { SidebarRail } from '@/app/patterns/SidebarRail';
import { SessionFirstSidebarFooter } from '@/app/SessionFirstSidebarFooter';
import { shellIconButtonClass } from '@/app/shellStyles';
import type { SortDirection, SortField, StatusFilter } from '@/app/useDashboard';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/services/socket';

export interface SessionFirstSidebarProps {
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
export function SessionFirstSidebar({
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
  collapsible = true,
  onCreate,
  onRefresh,
  onSelect,
  onConfigure,
  onKill,
}: SessionFirstSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const onlineCount = agents.filter((agent) => agent.status === 'online').length;
  const offlineCount = agents.filter((agent) => agent.status !== 'online').length;
  const createDisabled = agents.every((agent) => agent.status !== 'online');

  const selectedSession = filteredSessions.find((s) => s.session_id === selectedId) ?? null;
  const activeAgentId = selectedSession?.agent_id ?? null;

  if (collapsible && collapsed) {
    return (
      <aside
        data-testid="session-first-sidebar"
        data-collapsed="true"
        /* No border here: the column wrapper draws it, and a second one would
           put the rail 1px over its 52px budget. */
        className="flex h-full shrink-0 flex-col"
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
      data-testid="session-first-sidebar"
      className={cn('flex h-full w-full shrink-0 flex-col', className)}
    >
      <SidebarAgents agents={agents} activeAgentId={activeAgentId} />
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
        collapseControl={
          collapsible ? (
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
          ) : null
        }
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
        data-testid="session-first-sidebar-footer"
        className="flex shrink-0 items-center justify-between gap-2 border-t px-[var(--shell-space-2)] py-[var(--shell-space-2)] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SessionFirstSidebarFooter />
      </div>
    </aside>
  );
}
