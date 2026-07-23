import { Server, Clock, Cpu } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import type { ServerInfo } from '../types';

function formatUptime(seconds: number): string {
  if (seconds < 60) {return `${seconds}s`;}
  const m = Math.floor(seconds / 60);
  if (m < 60) {return `${m}m`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ${m % 60}m`;}
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function ServerInfoBar() {
  const ws = useWebSocket();
  const [info, setInfo] = useState<ServerInfo | null>(null);

  const fetch = useCallback(() => {
    ws.serverInfo().then(setInfo).catch(() => {});
  }, [ws]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 30_000);
    return () => { clearInterval(id); };
  }, [fetch]);

  if (!info) {return null;}

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-xs text-muted-foreground bg-muted/30 border-b border-border/50 flex-wrap">
      <span className="flex items-center gap-1">
        <Server className="h-3 w-3" />
        Nession v{info.version}
      </span>
      <span className="text-muted-foreground/30">|</span>
      <span className="flex items-center gap-1">
        <Clock className="h-3 w-3" />
        up {formatUptime(info.uptime_seconds)}
      </span>
      <span className="text-muted-foreground/30">|</span>
      <span className="flex items-center gap-1">
        <Cpu className="h-3 w-3" />
        {info.online_agent_count}/{info.agent_count} agents
      </span>
      <span className="text-muted-foreground/30">|</span>
      <span>{info.session_count} sessions</span>
    </div>
  );
}
