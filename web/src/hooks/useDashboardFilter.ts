import { useState, useCallback } from 'react';

export type StatusFilter = 'all' | 'online' | 'offline' | 'degraded';
export type SortField = 'name' | 'activity';
export type SortDirection = 'asc' | 'desc';

/** Filter / sort state. Filtering itself lives in useDashboard
 *  because it needs the agents + sessions data which are fetched elsewhere. */
export function useDashboardFilter() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }, [sortField]);

  const isSearchActive = searchQuery !== '' || statusFilter !== 'all';

  return {
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort,
    isSearchActive,
  };
}
