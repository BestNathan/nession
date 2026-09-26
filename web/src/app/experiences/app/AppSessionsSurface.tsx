import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Filter, Plus } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { RefreshButton } from '@/components/ui/RefreshButton';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { SearchBar } from '@/product/session/components/SearchBar';
import { SessionList } from '@/product/session/patterns/SessionList';
import { SidebarAgents } from '@/app/patterns/SidebarAgents';
import { SidebarSectionHead } from '@/app/patterns/SidebarSectionHead';
import { SidebarFooter } from '@/app/SidebarFooter';
import { shellMotionClass, shellRowControlMinClass } from '@/app/shellStyles';
import { bodyAppClass } from './appTypography';
import type { SidebarProps } from '@/app/Sidebar';
import type { SortDirection, SortField, StatusFilter } from '@/app/useDashboard';

/**
 * The App Sessions surface's shape: the fields `Sidebar` needs, minus the two
 * that describe *a column in the Web shell* rather than the data.
 *
 * `collapsible` is omitted rather than defaulted to `false`. The App renders
 * this surface full-width inside its own overlay, so a rail would be a way to
 * hide navigation that nothing brings back — `SidebarRail` is not in this
 * composition and `AppLayout` has no re-expand affordance. Saying so in the type
 * means the App cannot be handed the prop at all, which is the failure Finding 1
 * of #1050 recorded: the App inherited `collapsible`'s `true` default and could
 * collapse itself inside its own overlay.
 */
export type AppSessionsSurfaceProps = Omit<
  SidebarProps,
  'className' | 'collapsible'
>;

/**
 * The Session list's floor.
 *
 * `flex-1` alone cannot keep the list on screen: its flex basis is 0, so when
 * the column is shorter than its chrome the list takes no share of the deficit
 * and absorbs all of it — measured at 844×390 the wrapper was exactly 0px tall
 * and no Session row could be reached (#1057).
 *
 * App-scoped by construction. The token is emitted only under
 * `[data-experience="app"]`, so the binding has to say which experience the
 * class belongs to (`nession/no-cross-experience-token`); outside the App the
 * variable would resolve to nothing and the declaration would be dropped
 * silently rather than failing.
 */
const sessionsListFloorAppClass =
  'min-h-[length:var(--shell-sessions-list-min-height)]';

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'online', label: 'Online' },
  { key: 'offline', label: 'Offline' },
];

function SortButton({
  label,
  field,
  activeField,
  direction,
  onToggle,
}: {
  label: string;
  field: SortField;
  activeField: SortField;
  direction: SortDirection;
  onToggle: (field: SortField) => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 hover:text-foreground"
      onClick={() => onToggle(field)}
    >
      {label}
      {activeField === field &&
        (direction === 'asc' ? (
          <ArrowUp className="size-3" />
        ) : (
          <ArrowDown className="size-3" />
        ))}
    </button>
  );
}

/**
 * The Agents section, demoted to a disclosure that starts closed.
 *
 * The rows themselves are `SidebarAgents` unchanged — still inert, still flat,
 * still not a navigation parent for Sessions (`session-list.md`, anti-pattern
 * 1). What changes is only their cost: one muted row until asked for. The
 * caller owns the head so the head can *be* the trigger instead of a second
 * "Agents" label appearing above the rows when it opens.
 */
function AgentsDisclosure({
  agents,
  activeAgentId,
}: {
  agents: AppSessionsSurfaceProps['agents'];
  activeAgentId: string | null;
}) {
  const [agentsOpen, setAgentsOpen] = useState(false);

  if (agents.length === 0) {
    return null;
  }

  return (
    <Collapsible
      open={agentsOpen}
      onOpenChange={setAgentsOpen}
      className="flex flex-col"
    >
      <CollapsibleTrigger
        data-testid="app-agents-disclosure"
        render={<button type="button" className="w-full text-left" />}
      >
        <SidebarSectionHead
          label="Agents"
          action={
            <span className="flex items-center gap-[var(--shell-space-1)]">
              <span data-testid="app-agents-count" className="tabular-nums">
                {agents.length}
              </span>
              <ChevronDown
                aria-hidden
                className={cn(
                  'size-3 transition-transform',
                  agentsOpen && 'rotate-180',
                )}
              />
            </span>
          }
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarAgents
          agents={agents}
          activeAgentId={activeAgentId}
          showSectionHead={false}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Status filters and sort behind one trigger, with Refresh opposite it.
 *
 * The chips carry no counts. They used to carry Agent counts while filtering
 * Sessions — the inconsistency #1050 Finding 2 recorded — and the App cannot
 * correct it by counting Sessions instead: `filterSessions` keys the filter off
 * each Session's Agent status (`useDashboard.ts`), and this surface receives
 * only the *already filtered* list, so it has no set to count. The remaining
 * candidate, `Agent.session_count`, is a heartbeat snapshot taken on the
 * Agent — stale for an Offline Agent, and not the list the filter runs on — so
 * summing it would swap one wrong number for another.
 *
 * A number that describes a different set from the one its control filters is
 * worse than no number, so the chips state the filter and nothing else. Giving
 * the App true Session counts means handing it the unfiltered Session list,
 * which is a change to what `WorkspaceRegion` passes rather than to this
 * composition; recorded for #1050 rather than smuggled in here. Web is
 * untouched: its chips are `SearchBar`'s own, and this surface renders none of
 * them (`showStatusFilters={false}`).
 */
function SessionsFilters({
  statusFilter,
  setStatusFilter,
  sortField,
  sortDirection,
  toggleSort,
  onRefresh,
  loadingSessions,
}: {
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  onRefresh: () => void;
  loadingSessions: boolean;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <div className="flex items-center justify-between gap-2">
      <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
        <CollapsibleTrigger
          data-testid="session-list-filters"
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                shellRowControlMinClass,
                'max-lg:min-h-11 text-muted-foreground hover:text-foreground',
                shellMotionClass,
                bodyAppClass,
              )}
            >
              <Filter className="size-4" />
              Filters
            </Button>
          }
        />
        <CollapsibleContent
          data-testid="session-list-filters-panel"
          className="mt-2 flex flex-col gap-2"
        >
          <div className="flex flex-wrap items-center gap-1">
            {STATUS_FILTERS.map((filter) => {
              const isActive = statusFilter === filter.key;
              return (
                <Button
                  key={filter.key}
                  variant={isActive ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setStatusFilter(filter.key)}
                  aria-pressed={isActive}
                  className={cn(shellRowControlMinClass, 'flex-shrink-0', bodyAppClass)}
                >
                  {filter.label}
                </Button>
              );
            })}
          </div>
          <div className={cn('flex items-center gap-2 font-medium text-muted-foreground', bodyAppClass)}>
            <SortButton
              label="Name"
              field="name"
              activeField={sortField}
              direction={sortDirection}
              onToggle={toggleSort}
            />
            <SortButton
              label="Activity"
              field="activity"
              activeField={sortField}
              direction={sortDirection}
              onToggle={toggleSort}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
      <RefreshButton
        onClick={() => onRefresh()}
        loading={loadingSessions}
        variant="ghost"
        ariaLabel="Refresh sessions"
      />
    </div>
  );
}

/**
 * The App's Session-navigation chrome: Agents (demoted), the Sessions head, the
 * search field, New Session, and the Filters disclosure.
 *
 * Split out of `AppSessionsSurface` rather than inlined so the surface reads as
 * what it is — chrome that yields, a list that does not, a foot that stays put.
 * The blocks are the same ones `Sidebar` and `SessionListHeader` compose; this
 * arrangement is App-specific and neither of those files moved for it.
 */
function SessionsChrome({
  agents,
  activeAgentId,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onlineCount,
  offlineCount,
  createDisabled,
  sortField,
  sortDirection,
  toggleSort,
  onCreate,
  onRefresh,
  loadingSessions,
}: {
  agents: AppSessionsSurfaceProps['agents'];
  activeAgentId: string | null;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
  createDisabled: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  onCreate: () => void;
  onRefresh: () => void;
  loadingSessions: boolean;
}) {
  return (
    /* The yielding region. `min-h-0` lets it shrink below its content and
       `overflow-y-auto` keeps what no longer fits reachable rather than
       clipped. It is the only child of the column that shrinks, so the deficit
       lands here instead of on the list. */
    <div
      data-testid="app-sessions-chrome"
      className="flex min-h-0 shrink flex-col overflow-y-auto"
    >
      <AgentsDisclosure agents={agents} activeAgentId={activeAgentId} />
      <div className="flex flex-col gap-[var(--shell-space-2)] px-[var(--shell-space-2)] pb-[var(--shell-space-2)] max-lg:gap-[var(--shell-space-3)]">
        <SidebarSectionHead label="Sessions" />
        <SearchBar
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          /* Carried because `SearchBar` requires them, not because this surface
             shows them: it renders its own chips (`showStatusFilters={false}`),
             and those carry no counts. They are still the real Agent counts, so
             they are not falsified to satisfy the type. */
          onlineCount={onlineCount}
          offlineCount={offlineCount}
          showStatusFilters={false}
          /* The App's own copy. `SearchBar`'s default advertises Agents, which
             this surface demotes to a disclosure and never filters; what it
             does filter — by name, and by Agent id through `filterSessions` —
             is the Session list below. The two experiences disagree about what
             this field promises, so neither is the other's default (#1050
             stage 3). */
          placeholder="Search sessions..."
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'justify-start rounded-none px-1 text-muted-foreground hover:text-foreground max-lg:min-h-11',
            shellMotionClass,
            bodyAppClass,
          )}
          data-testid="create-session"
          aria-label="Create session"
          disabled={createDisabled}
          onClick={() => onCreate()}
        >
          <Plus className="size-4" />
          New Session
        </Button>
        <SessionsFilters
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          sortField={sortField}
          sortDirection={sortDirection}
          toggleSort={toggleSort}
          onRefresh={onRefresh}
          loadingSessions={loadingSessions}
        />
      </div>
    </div>
  );
}

/**
 * The App's Sessions surface (#1050 stage 1).
 *
 * A composition, not a second `Sidebar`. Both experiences are handed the same
 * `sidebarProps` by `WorkspaceRegion`, and `Sidebar` has no App-specific prop —
 * so moving the App meant either moving Web with it or giving the App its own
 * arrangement of the same primitives. This is that arrangement; `Sidebar` is
 * untouched and `SidebarSections.test.tsx` still covers the Web column.
 *
 * It differs from the Web column in four ways, each a consequence of where it
 * renders — a full-width overlay on a phone, not a 246px column beside a work
 * surface:
 *
 * 1. **Nothing collapses to a rail.** See `AppSessionsSurfaceProps`.
 * 2. **The chrome yields; the list does not.** The column it replaces was three
 *    `shrink-0` blocks against one `flex-1`, so a surface shorter than its
 *    chrome was absorbed entirely by the list — at 844×390 it measured 0px and
 *    no Session row could be reached (#1057). Here the chrome shrinks and
 *    scrolls, and the list keeps `sessionsListFloorAppClass`.
 * 3. **Agents are a collapsed disclosure.** Infrastructure identity is not what
 *    this surface is for; the list is. They stay reachable — opening the
 *    disclosure renders the same inert `SidebarAgents` rows, unchanged — but
 *    cost one muted row until asked for.
 * 4. **Filters sit behind one trigger**, as on Web, instead of a chip row
 *    competing with the list for what is left of a short surface.
 * 5. **Its copy describes what it does.** The search field says "Search
 *    sessions..." rather than inheriting Web's "Search agents and sessions...",
 *    and the filter chips carry no counts. Both used to name a set they did not
 *    act on — Agents are neither searched nor filtered here — and neither had a
 *    true replacement available to this composition (`SessionsFilters` records
 *    what one would cost). The copy each experience shows is its own, so the
 *    shared default does not move: Web's field, Web's string and Web's
 *    baselines are untouched by this stage.
 *
 * `data-testid="create-session"` and the filter testids are reused from
 * `SessionListHeader` rather than renamed: they name the controls, not the
 * layout, and these are the same controls. The two experiences are exclusive
 * branches of `WorkspaceRegion`, so the ids never meet in one document.
 */
export function AppSessionsSurface({
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
  onCreate,
  onRefresh,
  onSelect,
  onConfigure,
  onKill,
}: AppSessionsSurfaceProps) {
  const onlineCount = agents.filter((agent) => agent.status === 'online').length;
  const createDisabled = agents.every((agent) => agent.status !== 'online');

  const selectedSession =
    filteredSessions.find((s) => s.session_id === selectedId) ?? null;
  const activeAgentId = selectedSession?.agent_id ?? null;

  return (
    <div
      data-testid="app-sessions-surface"
      className="bg-sidebar flex h-full min-h-0 w-full flex-col"
    >
      <SessionsChrome
        agents={agents}
        activeAgentId={activeAgentId}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={agents.length - onlineCount}
        createDisabled={createDisabled}
        sortField={sortField}
        sortDirection={sortDirection}
        toggleSort={toggleSort}
        onCreate={onCreate}
        onRefresh={onRefresh}
        loadingSessions={loadingSessions}
      />
      <div
        data-testid="app-sessions-list"
        className={cn(
          'flex flex-1 flex-col overflow-hidden',
          sessionsListFloorAppClass,
        )}
      >
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
      </div>
    </div>
  );
}
