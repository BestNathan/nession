import { useMemo, useState } from 'react';
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
import { SidebarFooter } from '@/app/SidebarFooter';
import { appHeaderBandClass } from '@/app/patterns/SessionHeader';
import {
  shellIconButtonClass,
  shellMotionClass,
  shellRowControlMinClass,
} from '@/app/shellStyles';
import { bodyAppClass, secondaryAppClass, titleAppClass } from './appTypography';
import { bucketSessions } from './sessionHistory';
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
 * The Agents entry: infrastructure demoted to one row *below* history.
 *
 * The rows themselves are `SidebarAgents` unchanged — still inert, still flat,
 * still not a navigation parent for Sessions (`session-list.md`, anti-pattern
 * 1). What changed in #1083 is the entry, and it changed twice over:
 *
 * - **It sits below the list**, not above it. The screen is a navigator, and a
 *   navigator's first row is history; infrastructure that leads the page is the
 *   management console the issue is about. It renders through `SessionList`'s
 *   `footer` slot, so "below" is the scroll area's own order and an expanded
 *   disclosure is the container's problem rather than a second flex region
 *   competing with the list's floor (#1057).
 * - **It counts what it names.** The old head showed `agents.length` under the
 *   label "Agents", which is a total and reads as a count of the things you can
 *   reach. The entry says `3 online` because that is the set it is about, and
 *   it is the same number `createDisabled` is derived from below.
 *
 * The load-bearing invariant from #1050 survives: there is exactly **one**
 * Agents entry, not a label plus a separate trigger. It is re-expressed against
 * `app-agents-disclosure` rather than against the bare text "Agents", which is
 * no longer a whole label.
 */
function AgentsDisclosure({
  agents,
  activeAgentId,
  onlineCount,
}: {
  agents: AppSessionsSurfaceProps['agents'];
  activeAgentId: string | null;
  onlineCount: number;
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
        aria-expanded={agentsOpen}
        render={
          <button
            type="button"
            className={cn(
              shellRowControlMinClass,
              shellMotionClass,
              'flex w-full items-center gap-[var(--shell-space-1)] rounded-[var(--shell-session-row-radius)] px-[var(--shell-space-2)] text-left text-muted-foreground hover:text-foreground',
              bodyAppClass,
            )}
          />
        }
      >
        <span>Agents</span>
        <span aria-hidden>·</span>
        <span data-testid="app-agents-count" className="tabular-nums">
          {onlineCount} online
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'ml-auto size-4 transition-transform',
            agentsOpen && 'rotate-180',
          )}
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
 * The Sessions page header (#1083): the title, and the one creation action.
 *
 * The App has no bar above this layer — `AppLayers` stacks the Sessions layer
 * over the whole root — so the surface draws its own. It draws it from the same
 * band `SessionHeader` and `AppHomeHeader` use, so moving between a Session and
 * this list does not move the chrome; the three bars replace one another at one
 * position, which is what `appHeaderBandClass` is exported for.
 *
 * `Sessions` is an `h1` in the App's title role — a page title, not the muted
 * section label this screen used to open with. The action is a `+` in the
 * header rather than a row in the list: "start new work" is a page action, and
 * as a list row it sat between search and filters, reading as another item in a
 * catalogue rather than the one thing you can always do.
 *
 * `aria-label="New Session"` is spelled out because the control is an icon. The
 * `create-session` testid is reused from `SessionListHeader` rather than
 * renamed: the ids name the controls, not the layout, and this is the same
 * control — the two experiences are exclusive branches of `WorkspaceRegion`, so
 * the ids never meet in one document.
 */
function SessionsHeader({
  createDisabled,
  onCreate,
}: {
  createDisabled: boolean;
  onCreate: () => void;
}) {
  return (
    <header
      data-testid="app-sessions-header"
      className={cn(appHeaderBandClass, 'justify-between')}
    >
      <h1 className={cn('min-w-0 truncate font-semibold', titleAppClass)}>
        Sessions
      </h1>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={shellIconButtonClass}
        aria-label="New Session"
        data-testid="create-session"
        disabled={createDisabled}
        onClick={() => onCreate()}
      >
        <Plus className="size-5" />
      </Button>
    </header>
  );
}

/**
 * The App's Session-navigation chrome: the search field and the Filters
 * disclosure.
 *
 * Split out of `AppSessionsSurface` rather than inlined so the surface reads as
 * what it is — chrome that yields, a list that does not, a foot that stays put.
 * The blocks are the same ones `Sidebar` and `SessionListHeader` compose; this
 * arrangement is App-specific and neither of those files moved for it.
 */
function SessionsChrome({
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onlineCount,
  offlineCount,
  sortField,
  sortDirection,
  toggleSort,
  onRefresh,
  loadingSessions,
}: {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
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
      <div className="flex flex-col gap-[var(--shell-space-2)] px-[var(--shell-space-2)] pb-[var(--shell-space-2)] max-lg:gap-[var(--shell-space-3)]">
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
 * It differs from the Web column in these ways, each a consequence of where it
 * renders — a full-width overlay on a phone, not a 246px column beside a work
 * surface:
 *
 * 1. **Nothing collapses to a rail.** See `AppSessionsSurfaceProps`.
 * 2. **The chrome yields; the list does not.** The column it replaces was three
 *    `shrink-0` blocks against one `flex-1`, so a surface shorter than its
 *    chrome was absorbed entirely by the list — at 844×390 it measured 0px and
 *    no Session row could be reached (#1057). Here the chrome shrinks and
 *    scrolls, and the list keeps `sessionsListFloorAppClass`.
 * 3. **It opens with a page header, not a section label** (#1083). `Sessions`
 *    is an `h1` in the title role and New Session is its action; the Web column
 *    keeps its section head and its `SessionListHeader`.
 * 4. **History is grouped by time**, and rows then drop their recency slot —
 *    never both, and the two are driven from one boolean below. Web stays flat
 *    and keeps the third slot, which is what `session-lifecycle.spec.ts` pins.
 * 5. **Agents are one collapsed entry below the list**, not a section above it:
 *    infrastructure that leads the page is the management console #1083 is
 *    about. See `AgentsDisclosure`.
 * 6. **Its copy describes what it does.** The search field says "Search
 *    sessions..." rather than inheriting Web's "Search agents and sessions...",
 *    and the filter chips carry no counts. Both used to name a set they did not
 *    act on — Agents are neither searched nor filtered here — and neither had a
 *    true replacement available to this composition (`SessionsFilters` records
 *    what one would cost). The copy each experience shows is its own, so the
 *    shared default does not move: Web's field, Web's string and Web's
 *    baselines are untouched.
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

  // `Date.now()` is read when the *list* changes, not on every render: the
  // buckets are derived from it, and re-reading it per render would re-bucket
  // mid-scroll for no reason. `filteredSessions` is memoised by both callers
  // (`useDashboard`, `FixtureApp`), so this recomputes exactly when the data or
  // the filters do — which is also the only time the buckets could move.
  const buckets = useMemo(
    () => bucketSessions(filteredSessions, Date.now()),
    [filteredSessions],
  );
  // One bucket means grouping has nothing to say — one label over the whole
  // list is noise, and the issue allows the flat fallback. Derived once, then
  // driving both the labels *and* the per-row recency, so "never both" is a
  // property of this line rather than of two props agreeing.
  const grouped = buckets.length > 1;

  return (
    <div
      data-testid="app-sessions-surface"
      className="bg-sidebar flex h-full min-h-0 w-full flex-col"
    >
      <SessionsHeader createDisabled={createDisabled} onCreate={onCreate} />
      <SessionsChrome
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
          groups={
            grouped
              ? buckets.map((bucket) => ({
                  key: bucket.key,
                  // The label's element, role and type class are the App's, so
                  // the shared pattern stays free of type decisions: on App
                  // `secondary` outranks the `metadata` its rows use.
                  header: (
                    <h2
                      data-testid="session-group-label"
                      className={cn(
                        'px-[var(--shell-space-2)] pt-[var(--shell-space-3)] pb-[var(--shell-space-1)] text-muted-foreground',
                        secondaryAppClass,
                      )}
                    >
                      {bucket.label}
                    </h2>
                  ),
                  sessions: bucket.sessions,
                }))
              : undefined
          }
          showRowRecency={!grouped}
          footer={
            <AgentsDisclosure
              agents={agents}
              activeAgentId={activeAgentId}
              onlineCount={onlineCount}
            />
          }
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
