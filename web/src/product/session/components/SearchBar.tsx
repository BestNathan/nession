import { useEffect, useRef, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useDebouncedInput } from '@/product/session/hooks/useDebouncedInput';
import type { StatusFilter } from '@/product/session/types';

interface SearchBarProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
  showStatusFilters?: boolean;
  /**
   * The field's copy. Defaults to the Web column's — see
   * `DEFAULT_PLACEHOLDER`.
   */
  placeholder?: string;
  /**
   * A control rendered opposite the field, inside its row.
   *
   * For a caller that wants its filters a tap away from what they filter rather
   * than in a row of their own (#1083). It sits *inside* the field's box, where
   * the search icon already is, rather than beside it: the App is always below
   * `md`, where this component's root stacks, so a sibling would fall under the
   * field instead of sharing its row.
   *
   * Absent, nothing is rendered and the field's own classes are unchanged — Web
   * passes nothing, so its DOM is what it was.
   */
  fieldAction?: ReactNode;
}

/**
 * The default copy: the Web column's, and still the literal it shipped with.
 *
 * It is a *default*, not a statement about what the field does — no experience
 * filters Agents today, and the App does not even render them as a section. It
 * stays as the default so Web's copy does not move as a side effect of an App
 * change: the two experiences disagree about what this field searches, so each
 * owns its own string (#1050 stage 3) and Web's reconciliation is a separate,
 * undecided question.
 */
const DEFAULT_PLACEHOLDER = 'Search agents and sessions...';

const FILTERS: { key: StatusFilter; label: string; countKey?: 'onlineCount' | 'offlineCount' }[] = [
  { key: 'all', label: 'All' },
  { key: 'online', label: 'Online', countKey: 'onlineCount' },
  { key: 'offline', label: 'Offline', countKey: 'offlineCount' },
];

export function SearchBar({
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onlineCount,
  offlineCount,
  showStatusFilters = true,
  placeholder = DEFAULT_PLACEHOLDER,
  fieldAction,
}: SearchBarProps) {
  const { value: localValue, setValue: setLocalValue, debouncedValue, syncValue } = useDebouncedInput(searchQuery, 200);
  const isFirstRender = useRef(true);
  const skipNextSync = useRef(false);
  const prevSearchQuery = useRef(searchQuery);

  // Sync external searchQuery prop back to local state when it changes externally
  useEffect(() => {
    if (prevSearchQuery.current === searchQuery) {
      return;
    }
    prevSearchQuery.current = searchQuery;
    skipNextSync.current = true;
    syncValue(searchQuery);
  }, [searchQuery, syncValue]);

  // Push debounced value to parent (skip initial mount and external syncs)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (skipNextSync.current) {
      skipNextSync.current = false;
      return;
    }
    setSearchQuery(debouncedValue);
  }, [debouncedValue, setSearchQuery]);

  const countForFilter = (filter: (typeof FILTERS)[number]): number | undefined => {
    if (filter.countKey === 'onlineCount') { return onlineCount; }
    if (filter.countKey === 'offlineCount') { return offlineCount; }
    return undefined;
  };

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={placeholder}
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          // The right inset only exists when something occupies it. Written as a
          // conditional rather than as a second class so that with no
          // `fieldAction` the string is exactly what it was.
          className={cn('pl-8', fieldAction !== undefined && 'pr-11')}
        />
        {fieldAction !== undefined ? (
          <div className="absolute right-0.5 top-1/2 -translate-y-1/2">
            {fieldAction}
          </div>
        ) : null}
      </div>
      {showStatusFilters ? (
        <div
          data-testid="filter-row"
          className="flex items-center gap-1 flex-wrap md:overflow-x-visible"
        >
          {FILTERS.map((filter) => {
            const count = countForFilter(filter);
            const isActive = statusFilter === filter.key;
            return (
              <Button
                key={filter.key}
                variant={isActive ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStatusFilter(filter.key)}
                aria-pressed={isActive}
                className="min-h-11 md:min-h-7 flex-shrink-0"
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
      ) : null}
    </div>
  );
}
