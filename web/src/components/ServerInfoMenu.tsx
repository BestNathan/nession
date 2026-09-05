import {
  Server, Clock, Cpu, Info, Layers, CalendarClock, Timer, List,
} from 'lucide-react';
import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import type { ServerInfo } from '@/types';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { serverApi } from '@/features/server';
import pkg from '../../package.json';

function formatUptimeCompact(seconds: number): string {
  if (seconds < 60) { return `${seconds}s`; }
  const m = Math.floor(seconds / 60);
  if (m < 60) { return `${m}m`; }
  const h = Math.floor(m / 60);
  if (h < 24) { return `${h}h${m % 60}m`; }
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

function formatBuildTime(isoString: string): string {
  if (!isoString || isoString === 'unknown') { return ''; }
  const date = new Date(isoString);
  if (isNaN(date.getTime())) { return ''; }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

const WEB_VERSION = pkg.version;

export interface ServerInfoMenuProps {
  refreshKey?: number;
}

export function ServerInfoMenu({ refreshKey = 0 }: ServerInfoMenuProps) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const fetchedAtRef = useRef<number>(0);
  const [, setTick] = useState(0);

  const fetch = useCallback(() => {
    serverApi.serverInfo().then((s) => {
      fetchedAtRef.current = Date.now();
      setInfo(s);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 30_000);
    return () => { clearInterval(id); };
  }, [fetch, refreshKey]);

  useEffect(() => {
    const id = setInterval(() => { setTick((n) => n + 1); }, 1000);
    return () => { clearInterval(id); };
  }, []);

  if (!info) { return null; }

  const liveUptime = info.uptime_seconds + Math.max(0, Math.floor((Date.now() - fetchedAtRef.current) / 1000));
  const imageTag = info.image_tag && info.image_tag !== 'dev' && info.image_tag !== 'unknown'
    ? info.image_tag
    : null;
  const buildTime = formatBuildTime(info.build_time ?? '');
  const srvVersion = `v${info.version}${imageTag ? ` (${imageTag})` : ''}`;
  const webVersion = `v${WEB_VERSION}${imageTag ? ` (${imageTag})` : ''}`;
  const uptime = formatUptimeCompact(liveUptime);

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
      <div
        data-testid="server-info-inline"
        className="hidden min-w-0 items-center gap-2 text-[11px] text-muted-foreground/70 md:flex"
      >
        <span className="flex items-center gap-1">
          <Server className="h-3 w-3" />
          srv {srvVersion}
        </span>
        <span className="text-border">·</span>
        <span className="flex items-center gap-1">web {webVersion}</span>
        {buildTime ? (
          <>
            <span className="text-border">·</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />built {buildTime}
            </span>
          </>
        ) : null}
        <span className="text-border">·</span>
        <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{uptime}</span>
        <span className="text-border">·</span>
        <span className="flex items-center gap-1"><Cpu className="h-3 w-3" />{info.online_agent_count}/{info.agent_count}</span>
        <span className="text-border">·</span>
        <span>{info.session_count} sessions</span>
      </div>
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
            <div data-testid="server-info-details" className="space-y-1.5 px-2 py-1.5 text-xs">
              {details.map(({ icon, label, value }) => (
                <p key={label} className="flex items-center gap-2 text-muted-foreground">
                  {icon}
                  <span className="w-14 flex-shrink-0 text-muted-foreground/70">{label}</span>
                  <span className="truncate font-medium text-foreground/90">{value}</span>
                </p>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
