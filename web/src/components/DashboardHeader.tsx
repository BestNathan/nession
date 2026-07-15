import { RefreshCw, X, FileCog } from 'lucide-react';
import type { ConnectionStatus } from '../types';
import type { StatusFilter } from './useDashboardHandlers';
import { SearchBar } from './SearchBar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

export interface SearchProps {
  query: string;
  setQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
}

export interface HeaderActionsProps {
  fetchSessions: () => void;
  onOpenEnv: () => void;
  loadingAgents: boolean;
  clearError: () => void;
}

export interface DashboardHeaderProps {
  connectionStatus: ConnectionStatus;
  searchProps: SearchProps;
  actionsProps: HeaderActionsProps;
  error: string | null;
}

export function DashboardHeader({
  connectionStatus,
  searchProps,
  actionsProps,
  error,
}: DashboardHeaderProps) {
  const { fetchSessions, onOpenEnv, loadingAgents, clearError } = actionsProps;
  return (
    <>
      <header className="border-b px-6 py-3 flex flex-wrap items-center gap-4 flex-shrink-0">
        <h1 className="text-lg font-bold">Nession</h1>
        <Badge variant="outline" className="gap-1.5 py-1.5">
          <span className={cn('w-2 h-2 rounded-full',
            connectionStatus === 'authenticated' ? 'bg-green-500' : 'bg-red-500',
            connectionStatus === 'connecting' && 'animate-pulse bg-amber-500',
          )} />
          {connectionStatus}
        </Badge>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={onOpenEnv} className="min-h-11 md:min-h-7">
          <FileCog className="w-4 h-4 md:mr-1" /> <span className="hidden md:inline">Env Files</span>
        </Button>
        <Button size="sm" onClick={() => fetchSessions()} disabled={loadingAgents} className="min-h-11 min-w-11 md:min-h-7 md:min-w-0">
          <RefreshCw className={cn('w-4 h-4', loadingAgents && 'animate-spin')} />
        </Button>
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
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={clearError}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </>
  );
}
