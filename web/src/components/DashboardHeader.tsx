import { X, FileCog, Server, Clock, Cpu } from 'lucide-react';
import { useEffect, useState, useCallback, useRef } from 'react';
import type { ConnectionStatus, ServerInfo } from '../types';
import type { StatusFilter } from './useDashboardHandlers';
import { SearchBar } from './SearchBar';
import { ConnectionStatusBadge } from './ui/ConnectionStatusBadge';
import { RefreshButton } from './ui/RefreshButton';
import { Button } from './ui/button';
import { useWebSocket } from '../hooks/useWebSocket';

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

function formatUptimeCompact(seconds: number): string {
  if (seconds < 60) {return `${seconds}s`;}
  const m = Math.floor(seconds / 60);
  if (m < 60) {return `${m}m`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h${m % 60}m`;}
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

// Web UI version baked at build time (import from package.json works in Vite)
const WEB_VERSION = '0.10.0';

function ServerInfoInline({ refreshKey }: { refreshKey: number }) {
  const ws = useWebSocket();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  // Timestamp when the server info was fetched, used to compute live uptime.
  const fetchedAtRef = useRef<number>(0);
  const [, setTick] = useState(0);

  const fetch = useCallback(() => {
    ws.serverInfo().then((s) => {
      fetchedAtRef.current = Date.now();
      setInfo(s);
    }).catch(() => {});
  }, [ws]);

  // Fetch server info every 30s, plus immediately when refreshKey changes.
  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 30_000);
    return () => { clearInterval(id); };
  }, [fetch, refreshKey]);

  // Tick every second so uptime increments live.
  useEffect(() => {
    const id = setInterval(() => { setTick((n) => n + 1); }, 1000);
    return () => { clearInterval(id); };
  }, []);

  if (!info) {return null;}

  const liveUptime = info.uptime_seconds + Math.max(0, Math.floor((Date.now() - fetchedAtRef.current) / 1000));

  const imageTag = info.image_tag && info.image_tag !== 'dev' && info.image_tag !== 'unknown'
    ? info.image_tag
    : null;

  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
      <span className="flex items-center gap-1">
        <Server className="h-3 w-3" />
        srv v{info.version}{imageTag && <span className="font-mono">({imageTag})</span>}
      </span>
      <span className="text-border">·</span>
      <span className="flex items-center gap-1">
        web v{WEB_VERSION}{imageTag && <span className="font-mono">({imageTag})</span>}
      </span>
      <span className="text-border">·</span>
      <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatUptimeCompact(liveUptime)}</span>
      <span className="text-border">·</span>
      <span className="flex items-center gap-1"><Cpu className="h-3 w-3" />{info.online_agent_count}/{info.agent_count}</span>
      <span className="text-border">·</span>
      <span>{info.session_count} sessions</span>
    </div>
  );
}

export function DashboardHeader({
  connectionStatus,
  searchProps,
  actionsProps,
  error,
  serverRefreshKey,
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
          <ServerInfoInline refreshKey={serverRefreshKey ?? 0} />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onOpenEnv} className="min-h-11 md:min-h-7">
            <FileCog className="w-4 h-4 md:mr-1" /> <span className="hidden md:inline">Env Files</span>
          </Button>
          <RefreshButton onClick={fetchSessions} loading={loadingAgents} variant="default" />
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
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={clearError}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </>
  );
}
