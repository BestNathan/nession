import {
  X, FileCog, Server, Clock, Cpu, Info, Layers, CalendarClock, Timer, List,
} from 'lucide-react';
import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import type { ConnectionStatus, ServerInfo } from '../types';
import type { StatusFilter } from '../hooks/useDashboard';
import { SearchBar } from './SearchBar';
import { ConnectionStatusBadge } from './ui/ConnectionStatusBadge';
import { RefreshButton } from './ui/RefreshButton';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useWebSocket } from '../hooks/useWebSocket';
import pkg from '../../package.json';

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

function formatBuildTime(isoString: string): string {
  if (!isoString || isoString === 'unknown') {return '';}
  const date = new Date(isoString);
  if (isNaN(date.getTime())) {return '';}
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

const WEB_VERSION = pkg.version;

function ServerInfo({ refreshKey }: { refreshKey: number }) {
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

  const buildTime = formatBuildTime(info.build_time ?? '');
  const srvVersion = `v${info.version}${imageTag ? ` (${imageTag})` : ''}`;
  const webVersion = `v${WEB_VERSION}${imageTag ? ` (${imageTag})` : ''}`;
  const uptime = formatUptimeCompact(liveUptime);

  /** The same details, shared by the desktop strip and the mobile dropdown. */
  const details: { icon: ReactNode; label: string; value: string }[] = [
    { icon: <Server className="h-3.5 w-3.5 flex-shrink-0" />, label: 'Server', value: srvVersion },
    { icon: <Layers className="h-3.5 w-3.5 flex-shrink-0" />, label: 'Web', value: webVersion },
    ...(buildTime
      ? [{ icon: <CalendarClock className="h-3.5 w-3.5 flex-shrink-0" />, label: 'Built', value: buildTime }]
      : []),
    { icon: <Timer className="h-3.5 w-3.5 flex-shrink-0" />, label: 'Uptime', value: uptime },
    { icon: <Cpu className="h-3.5 w-3.5 flex-shrink-0" />, label: 'Agents', value: `${info.online_agent_count}/${info.agent_count} online` },
    { icon: <List className="h-3.5 w-3.5 flex-shrink-0" />, label: 'Sessions', value: String(info.session_count) },
  ];

  return (
    <>
      {/* Desktop (md+): full inline strip — unchanged behavior. */}
      <div
        data-testid="server-info-inline"
        className="hidden md:flex items-center gap-2 text-[11px] text-muted-foreground/70"
      >
        <span className="flex items-center gap-1">
          <Server className="h-3 w-3" />
          srv {srvVersion}
        </span>
        <span className="text-border">·</span>
        <span className="flex items-center gap-1">web {webVersion}</span>
        {buildTime && (
          <>
            <span className="text-border">·</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />built {buildTime}
            </span>
          </>
        )}
        <span className="text-border">·</span>
        <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{uptime}</span>
        <span className="text-border">·</span>
        <span className="flex items-center gap-1"><Cpu className="h-3 w-3" />{info.online_agent_count}/{info.agent_count}</span>
        <span className="text-border">·</span>
        <span>{info.session_count} sessions</span>
      </div>
      {/* Mobile: version info collapsed behind an info icon — tap to expand. */}
      <div data-testid="server-info-mobile" className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                aria-label="Server info"
                className="min-h-9 min-w-9"
              />
            }
          >
            <Info className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-60">
            <div data-testid="server-info-details" className="px-2 py-1.5 space-y-1.5 text-xs">
              {details.map(({ icon, label, value }) => (
                <p key={label} className="flex items-center gap-2 text-muted-foreground">
                  {icon}
                  <span className="w-14 flex-shrink-0 text-muted-foreground/70">{label}</span>
                  <span className="font-medium text-foreground/90 truncate">{value}</span>
                </p>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
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
          <ServerInfo refreshKey={serverRefreshKey ?? 0} />
        </div>
        <div className="flex items-center gap-2">
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
