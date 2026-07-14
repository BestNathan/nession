import { useState, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import type { StatusFilter } from './useDashboardHandlers';

interface SearchBarProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
}

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
}: SearchBarProps) {
  const [localValue, setLocalValue] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external searchQuery prop back to local state when it changes externally
  useEffect(() => {
    // Cancel any pending debounce — the external value takes precedence
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLocalValue(searchQuery);
  }, [searchQuery]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setLocalValue(value);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setSearchQuery(value);
    }, 200);
  };

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const countForFilter = (filter: (typeof FILTERS)[number]): number | undefined => {
    if (filter.countKey === 'onlineCount') { return onlineCount; }
    if (filter.countKey === 'offlineCount') { return offlineCount; }
    return undefined;
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search agents and sessions..."
          value={localValue}
          onChange={handleChange}
          className="pl-8"
        />
      </div>
      <div
        data-testid="filter-row"
        className="flex items-center gap-1 overflow-x-auto flex-nowrap sm:overflow-x-visible"
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
              className="min-h-11 sm:min-h-7 flex-shrink-0"
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
    </div>
  );
}
