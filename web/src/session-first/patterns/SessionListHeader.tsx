import { Plus } from 'lucide-react';
import { SearchBar } from '@/components/SearchBar';
import { Button } from '@/components/ui/button';
import { RefreshButton } from '@/components/ui/RefreshButton';
import type { StatusFilter } from '@/hooks/useDashboard';

export interface SessionListHeaderProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
  onCreate: () => void;
  createDisabled: boolean;
  onRefresh: () => void;
  loadingSessions: boolean;
}

export function SessionListHeader({
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onlineCount,
  offlineCount,
  onCreate,
  createDisabled,
  onRefresh,
  loadingSessions,
}: SessionListHeaderProps) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b p-2">
      <SearchBar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
      />
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Sessions
        </h2>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            data-testid="session-first-create"
            aria-label="Create session"
            disabled={createDisabled}
            onClick={() => onCreate()}
          >
            <Plus className="size-4" />
          </Button>
          <RefreshButton
            onClick={() => onRefresh()}
            loading={loadingSessions}
            variant="ghost"
            ariaLabel="Refresh sessions"
          />
        </div>
      </div>
    </div>
  );
}
