import { useState, type RefObject } from 'react';
import { ArrowDown, ArrowUp, Filter, X } from 'lucide-react';
import { SearchBar } from '@/product/session/components/SearchBar';
import { Button } from '@/components/ui/button';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { shellMotionClass, shellRowControlMinClass } from '@/app/shellStyles';
import type { SortDirection, SortField, StatusFilter } from '@/app/useDashboard';

export interface SessionListHeaderProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
  sortField?: SortField;
  sortDirection?: SortDirection;
  toggleSort?: (field: SortField) => void;
  onRefresh: () => void;
  loadingSessions: boolean;
  /** The canonical Session search field, for the collapsed rail's Search action. */
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

const STATUS_FILTERS: {
  key: StatusFilter;
  label: string;
  countKey?: 'onlineCount' | 'offlineCount';
}[] = [
  { key: 'all', label: 'All' },
  { key: 'online', label: 'Online', countKey: 'onlineCount' },
  { key: 'offline', label: 'Offline', countKey: 'offlineCount' },
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
  activeField?: SortField;
  direction?: SortDirection;
  onToggle?: (field: SortField) => void;
}) {
  if (!onToggle) {
    return <span>{label}</span>;
  }
  return (
    <button
      type="button"
      className="flex items-center gap-1 hover:text-foreground"
      onClick={() => onToggle(field)}
    >
      {label}
      {activeField === field && (direction === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
}

function SessionFilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      data-testid="session-list-filter-chip"
      onClick={() => onClear()}
      className={cn(
        shellRowControlMinClass,
        shellMotionClass,
        'flex w-fit items-center gap-[var(--nession-shell-space-1)] rounded-full bg-muted px-[var(--nession-shell-space-2)] text-muted-foreground',
        chromeSansRole('metadata'),
      )}
    >
      {label}
      <X aria-hidden className="size-3" />
      <span className="sr-only">Clear filter</span>
    </button>
  );
}

function SessionFilterPanel({
  statusFilter,
  setStatusFilter,
  onlineCount,
  offlineCount,
  sortField,
  sortDirection,
  toggleSort,
  onRefresh,
  loadingSessions,
}: Omit<SessionListHeaderProps, 'searchQuery' | 'setSearchQuery'>) {
  const countForFilter = (filter: (typeof STATUS_FILTERS)[number]): number | undefined => {
    if (filter.countKey === 'onlineCount') { return onlineCount; }
    if (filter.countKey === 'offlineCount') { return offlineCount; }
    return undefined;
  };

  return (
    <div
      id="session-list-filters-panel"
      data-testid="session-list-filters-panel"
      className="flex flex-col gap-[var(--nession-shell-space-2)]"
    >
      <div className="flex flex-wrap items-center gap-1">
        {STATUS_FILTERS.map((filter) => {
          const count = countForFilter(filter);
          const isActive = statusFilter === filter.key;
          return (
            <Button
              key={filter.key}
              variant={isActive ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(filter.key)}
              aria-pressed={isActive}
              className={cn(shellRowControlMinClass, 'flex-shrink-0')}
            >
              {filter.label}
              {count !== undefined && (
                <span className={cn('ml-1 rounded-full bg-background/20 px-1.5 py-0.5', chromeSansRole('caption'))}>
                  {count}
                </span>
              )}
            </Button>
          );
        })}
      </div>
      <div className={cn('flex items-center gap-[var(--nession-shell-space-2)] text-muted-foreground', chromeSansRole('metadata'))}>
        {toggleSort ? (
          <>
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
          </>
        ) : null}
        <RefreshButton
          onClick={() => onRefresh()}
          loading={loadingSessions}
          variant="ghost"
          ariaLabel="Refresh sessions"
        />
      </div>
    </div>
  );
}

/**
 * Search and the secondary filter/sort disclosure (#2851).
 *
 * Search is the only persistent control above the list. Status filters, sort
 * and refresh live behind one field action so the navigation column opens with
 * Sessions rather than a toolbar. A chosen status filter stays visible as a
 * removable chip — progressive disclosure is not permission for an active
 * filter to become invisible.
 */
export function SessionListHeader({
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
  searchInputRef,
}: SessionListHeaderProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilter = STATUS_FILTERS.find(
    (filter) => filter.key === statusFilter && filter.key !== 'all',
  );

  return (
    <div
      data-testid="session-list-header"
      className="flex shrink-0 flex-col gap-[var(--nession-shell-space-2)] px-[var(--nession-shell-space-2)] pb-[var(--nession-shell-space-2)]"
    >
      <SearchBar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
        showStatusFilters={false}
        placeholder="Search sessions..."
        inputAriaLabel="Search sessions"
        inputClassName="h-[length:var(--nession-control-lg)] rounded-[var(--nession-radius-control)]"
        inputRef={searchInputRef}
        fieldAction={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="session-list-filters"
            aria-label="Filters"
            aria-expanded={filtersOpen}
            aria-controls="session-list-filters-panel"
            title="Filters"
            onClick={() => setFiltersOpen((open) => !open)}
            className={cn('text-muted-foreground hover:text-foreground', shellMotionClass)}
          >
            <Filter className="size-4" />
          </Button>
        }
      />
      {activeFilter ? (
        <SessionFilterChip
          label={activeFilter.label}
          onClear={() => setStatusFilter('all')}
        />
      ) : null}
      {filtersOpen ? (
        <SessionFilterPanel
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          onlineCount={onlineCount}
          offlineCount={offlineCount}
          sortField={sortField}
          sortDirection={sortDirection}
          toggleSort={toggleSort}
          onRefresh={onRefresh}
          loadingSessions={loadingSessions}
        />
      ) : null}
    </div>
  );
}
