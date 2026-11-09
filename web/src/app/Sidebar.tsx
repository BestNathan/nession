import { useMemo, type RefObject } from 'react';
import { SearchX } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { Button } from '@/components/ui/button';
import { SessionList, type SessionGroup } from '@/product/session/patterns/SessionList';
import { bucketSessions, type SessionBucket } from '@/product/session/model/sessionHistory';
import { SidebarSectionHead } from '@/app/patterns/SidebarSectionHead';
import { SidebarAgentsEntry } from '@/app/patterns/SidebarAgentsEntry';
import { SidebarServerStatus } from '@/app/patterns/SidebarServerStatus';
import { SidebarTopActions } from '@/app/patterns/SidebarTopActions';
import { SessionListHeader } from '@/app/patterns/SessionListHeader';
import { ProjectNavSection } from '@/app/patterns/ProjectsSection';
import { emptyProjectShell, type ProjectShellProps } from '@/product/project/types';
import type { SortDirection, SortField, StatusFilter } from '@/app/useDashboard';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/platform/socket';
import type { DomainState } from '@/product/session/model/domainState';

export interface SidebarProps {
  className?: string;
  agents: Agent[];
  filteredSessions: Session[];
  /**
   * Total Sessions before search/filter. Retained for the App's composition,
   * which owns its own counts; the Web column states the rows it actually
   * shows.
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
  /** Kept for the shared SidebarProps contract; the Web footer shows server state only. */
  domain: DomainState | null;
  /** False in the narrow overlay, where there is no column to collapse. */
  collapsible?: boolean;
  /**
   * Controlled collapse state. The WebLayout owns the column geometry; this is
   * only the sidebar's view of it, used for `data-collapsed` and accessibility.
   */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** The narrow overlay's close path. */
  onCloseDrawer?: () => void;
  onCreate: () => void;
  onRefresh: () => void;
  onSelect: (session: Session) => void;
  onConfigure: (session: Session) => void;
  onKill: (session: Session) => void;
  onViewDetails?: (session: Session) => void;
  onEditDetails?: (session: Session) => void;
  onAssociateProject?: (session: Session) => void;
  /** Projects are a first-class sibling destination, not a Session parent (#3025). */
  projectShell?: ProjectShellProps;
  /** The canonical search input, focused when the rail's Search shortcut expands. */
  searchInputRef?: RefObject<HTMLInputElement | null>;
  /** Focus target after the rail expands the column (#3075). */
  collapseButtonRef?: RefObject<HTMLButtonElement | null>;
}

function WebSearchMiss({
  searchQuery,
  onClearSearch,
  onClearFilter,
}: {
  searchQuery: string;
  onClearSearch: () => void;
  onClearFilter: () => void;
}) {
  const searching = searchQuery.trim().length > 0;
  return (
    <div
      data-testid="session-search-miss"
      className="flex flex-col items-center gap-[var(--nession-shell-space-2)] px-[var(--nession-shell-space-4)] py-8 text-center text-muted-foreground"
    >
      <SearchX aria-hidden className="size-8" />
      <p className={chromeSansRole('secondary')}>
        {searching ? `No sessions match “${searchQuery}”` : 'No sessions match this filter.'}
      </p>
      <Button
        type="button"
        variant="ghost"
        onClick={() => (searching ? onClearSearch() : onClearFilter())}
        data-testid={searching ? 'session-search-clear' : 'session-filter-clear'}
        className={chromeSansRole('body')}
      >
        {searching ? 'Clear search' : 'Clear filter'}
      </Button>
    </div>
  );
}


function sessionGroups(buckets: SessionBucket[]): SessionGroup[] {
  return buckets.map((bucket) => ({
    key: bucket.key,
    header: (
      <h2
        data-testid="session-group-label"
        className={cn(
          'px-[var(--nession-shell-space-2)] pt-[var(--nession-shell-space-3)] pb-[var(--nession-shell-space-1)] text-muted-foreground',
          chromeSansRole('secondary'),
        )}
      >
        {bucket.label}
      </h2>
    ),
    sessions: bucket.sessions,
  }));
}

/**
 * The Web shell's Session-first navigation column (#2851).
 *
 * Sessions lead: one top row with the shell toggle and explicit creation, a
 * single search field, then flat history grouped by when the work last
 * happened. Agents are infrastructure, revealed from one entry below history;
 * the Server footer reports only the server link. No Agent roster occupies the
 * top of the column.
 *
 * Collapse is the composition's state (`WebLayout`), never a second sidebar
 * boolean: when the column is tucked away its width goes to zero and this
 * component stays mounted so search, selection and the list's scroll position
 * survive. The narrow overlay renders the same content with the close action
 * in place of the collapse toggle.
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
  collapsible = true,
  collapsed = false,
  onCollapsedChange,
  onCloseDrawer,
  onCreate,
  onRefresh,
  onSelect,
  onConfigure,
  onKill,
  onViewDetails,
  onEditDetails,
  onAssociateProject,
  projectShell = emptyProjectShell(),
  searchInputRef,
  collapseButtonRef,
}: SidebarProps) {
  const onlineCount = agents.filter((agent) => agent.status === 'online').length;
  const createDisabled = agents.every((agent) => agent.status !== 'online');
  const selectedSession = filteredSessions.find((s) => s.session_id === selectedId) ?? null;
  const activeAgentId = selectedSession?.agent_id ?? null;

  // One read of the clock per list input, like the App's history navigator: a
  // re-render must not move rows between buckets mid-scroll.
  const buckets = useMemo(
    () => bucketSessions(filteredSessions, Date.now()),
    [filteredSessions],
  );
  const grouped = buckets.length > 1;
  const groups = grouped ? sessionGroups(buckets) : undefined;

  return (
    <aside
      data-testid="sidebar"
      data-collapsed={collapsed ? 'true' : undefined}
      aria-label="Session navigation"
      className={cn('bg-sidebar flex h-full w-full shrink-0 flex-col overflow-hidden', className)}
    >
      <SidebarTopActions
        collapsible={collapsible}
        onCollapse={() => onCollapsedChange?.(true)}
        onCloseDrawer={onCloseDrawer}
        onCreate={onCreate}
        createDisabled={createDisabled}
        collapseButtonRef={collapseButtonRef}
      />
      <SessionListHeader
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={agents.length - onlineCount}
        sortField={sortField}
        sortDirection={sortDirection}
        toggleSort={toggleSort}
        onRefresh={onRefresh}
        loadingSessions={loadingSessions}
        searchInputRef={searchInputRef}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SidebarSectionHead
          label="Sessions"
          action={
            <span
              data-testid="sidebar-session-count"
              className={cn('tabular-nums text-muted-foreground', chromeSansRole('caption'))}
            >
              {filteredSessions.length}
            </span>
          }
        />
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
          onViewDetails={onViewDetails}
          onEditDetails={onEditDetails}
          onAssociateProject={onAssociateProject}
          groups={groups}
          showRowRecency={!grouped}
          searchMissState={
            <WebSearchMiss
              searchQuery={searchQuery}
              onClearSearch={() => setSearchQuery('')}
              onClearFilter={() => setStatusFilter('all')}
            />
          }
        />
      </div>
      <ProjectNavSection shell={projectShell} />
      <SidebarAgentsEntry
        agents={agents}
        activeAgentId={activeAgentId}
        onlineCount={onlineCount}
      />
      <SidebarServerStatus connectionStatus={connectionStatus} />
    </aside>
  );
}
