import { X, FileCog } from 'lucide-react';
import type { ConnectionStatus } from '../types';
import type { StatusFilter } from '../hooks/useDashboard';
import { SearchBar } from './SearchBar';
import { ServerInfoMenu } from './ServerInfoMenu';
import { ConnectionStatusBadge } from './ui/ConnectionStatusBadge';
import { RefreshButton } from './ui/RefreshButton';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { setSessionFirst } from '../lib/sessionFirst';

export interface SearchProps {
  query: string;
  setQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
}

export interface HeaderActionsProps {
  /** Triggers a force refresh — the server re-queries every online agent. */
  fetchSessions: (opts?: { force?: boolean }) => void;
  onOpenEnv: () => void;
  loadingAgents: boolean;
  clearError: () => void;
}

export interface DashboardHeaderProps {
  connectionStatus: ConnectionStatus;
  searchProps: SearchProps;
  actionsProps: HeaderActionsProps;
  error: string | null;
  onSessionFirst?: () => void;
}

export function DashboardHeader({
  connectionStatus,
  searchProps,
  actionsProps,
  error,
  serverRefreshKey,
  onSessionFirst,
}: DashboardHeaderProps & { serverRefreshKey?: number }) {
  const { fetchSessions, onOpenEnv, loadingAgents, clearError } = actionsProps;
  return (
    <>
      <header className="border-b px-6 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold">Nession</h1>
          <ConnectionStatusBadge status={connectionStatus} />
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <ServerInfoMenu refreshKey={serverRefreshKey ?? 0} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="use-session-first"
            className="min-h-9 md:min-h-7"
            onClick={() => {
              if (onSessionFirst) {
                onSessionFirst();
              } else {
                setSessionFirst(true);
              }
            }}
          >
            Session-first preview
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="sm" variant="outline" onClick={onOpenEnv} className="min-h-9 md:min-h-7" />
              }
            >
              <FileCog className="w-4 h-4 md:mr-1" /> <span className="hidden md:inline">Env Files</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Environment Files</p>
            </TooltipContent>
          </Tooltip>
          <RefreshButton onClick={() => fetchSessions({ force: true })} loading={loadingAgents} variant="default" />
        </div>
      </header>
      <SearchBar
        searchQuery={searchProps.query}
        setSearchQuery={searchProps.setQuery}
        statusFilter={searchProps.statusFilter}
        setStatusFilter={searchProps.setStatusFilter}
        onlineCount={searchProps.onlineCount}
        offlineCount={searchProps.offlineCount}
      />
      {error && (
        <div className="px-6 py-2 bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <span>{error}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={clearError} />
              }
            >
              <X className="h-3 w-3" />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Dismiss</p>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </>
  );
}
