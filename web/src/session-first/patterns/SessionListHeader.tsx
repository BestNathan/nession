import { useState } from 'react';
import { ArrowDown, ArrowUp, Filter, Plus } from 'lucide-react';
import { SearchBar } from '@/components/SearchBar';
import { Button } from '@/components/ui/button';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { SortDirection, SortField, StatusFilter } from '@/hooks/useDashboard';

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
  onCreate: () => void;
  createDisabled: boolean;
  onRefresh: () => void;
  loadingSessions: boolean;
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
  onCreate,
  createDisabled,
  onRefresh,
  loadingSessions,
}: SessionListHeaderProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  const countForFilter = (filter: (typeof STATUS_FILTERS)[number]): number | undefined => {
    if (filter.countKey === 'onlineCount') { return onlineCount; }
    if (filter.countKey === 'offlineCount') { return offlineCount; }
    return undefined;
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b p-3 max-lg:gap-2.5 lg:p-2">
      <SearchBar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
        showStatusFilters={false}
      />
      <Button
        type="button"
        className="w-full rounded-lg max-lg:min-h-11"
        data-testid="session-first-create"
        aria-label="Create session"
        disabled={createDisabled}
        onClick={() => onCreate()}
      >
        <Plus className="size-4" />
        New Session
      </Button>
      <div className="flex items-center justify-between gap-2">
        <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
          <CollapsibleTrigger
            data-testid="session-list-filters"
            render={
              <Button type="button" variant="outline" size="sm" className="min-h-8 max-lg:min-h-11">
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
                const count = countForFilter(filter);
                const isActive = statusFilter === filter.key;
                return (
                  <Button
                    key={filter.key}
                    variant={isActive ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setStatusFilter(filter.key)}
                    aria-pressed={isActive}
                    className="min-h-8 flex-shrink-0"
                  >
                    {filter.label}
                    {count !== undefined && (
                      <span className="ml-1 rounded-full bg-background/20 px-1.5 py-0.5 text-xs">
                        {count}
                      </span>
                    )}
                  </Button>
                );
              })}
            </div>
            {toggleSort ? (
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
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
            ) : null}
          </CollapsibleContent>
        </Collapsible>
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
