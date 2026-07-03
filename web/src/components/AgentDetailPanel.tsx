import { Server, Clock, Terminal, Activity, Monitor } from 'lucide-react';
import type { Agent } from '../types';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { Sheet, SheetContent } from './ui/sheet';

interface AgentDetailPanelProps {
  agent: Agent;
  heartbeatHistory: string[];  // ISO timestamps, oldest first
  onClose: () => void;
}

function getStatusVariant(status: Agent['status']): 'default' | 'secondary' | 'outline' {
  switch (status) {
    case 'online':   return 'default';
    case 'degraded': return 'secondary';
    case 'offline':  return 'outline';
  }
}

function computeUptime(heartbeatHistory: string[]): string | null {
  if (heartbeatHistory.length === 0) return null;
  const diffMs = Date.now() - new Date(heartbeatHistory[0]).getTime();
  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function getHeartbeatColor(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'bg-green-500';
  if (seconds < 180) return 'bg-amber-500';
  return 'bg-gray-500';
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function SectionHeader({ icon: Icon, title }: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="w-4 h-4 text-muted-foreground" />
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

export function AgentDetailPanel({ agent, heartbeatHistory, onClose }: AgentDetailPanelProps) {
  const uptime = computeUptime(heartbeatHistory);

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-[400px] sm:w-[480px] overflow-y-auto">
        <div className="p-4 space-y-4">
          {/* Header: Status badge + hostname */}
          <div>
            <Badge variant={getStatusVariant(agent.status)} className="capitalize mb-2">
              {agent.status}
            </Badge>
            <h2 className="font-semibold text-lg text-foreground">{agent.hostname}</h2>
          </div>

          <Separator />

          {/* Connection */}
          <div>
            <SectionHeader icon={Monitor} title="Connection" />
            <InfoRow label="Hostname" value={agent.hostname} />
            <InfoRow label="IP Address" value={agent.ip_address} />
            <InfoRow label="Port" value={String(agent.port)} />
          </div>

          <Separator />

          {/* Versions */}
          <div>
            <SectionHeader icon={Terminal} title="Versions" />
            <InfoRow label="Nession" value={agent.metadata?.nession_version ?? 'Unknown'} />
            <InfoRow label="tmux" value={agent.metadata?.tmux_version ?? 'Unknown'} />
            <InfoRow label="OS" value={agent.metadata?.os_version ?? 'Unknown'} />
          </div>

          <Separator />

          {/* Uptime */}
          <div>
            <SectionHeader icon={Clock} title="Uptime" />
            {uptime ? (
              <>
                <p className="text-lg font-medium">{uptime}</p>
                <p className="text-sm text-muted-foreground">
                  since {formatAbsoluteTime(heartbeatHistory[0])}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">N/A</p>
            )}
          </div>

          <Separator />

          {/* Heartbeat History */}
          <div>
            <SectionHeader icon={Activity} title="Heartbeat History" />
            {heartbeatHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No heartbeat data yet</p>
            ) : (
              <div className="space-y-1">
                {[...heartbeatHistory].reverse().slice(0, 10).map((iso, i) => (
                  <div key={i} className="flex items-center gap-2 py-1">
                    <span className={`w-2 h-2 rounded-full ${getHeartbeatColor(iso)}`} />
                    <span className="text-sm">{formatRelativeTime(iso)}</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {formatAbsoluteTime(iso)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Separator />

          {/* Sessions */}
          <div>
            <SectionHeader icon={Server} title="Sessions" />
            <p className="text-sm text-muted-foreground">
              {agent.session_count} active sessions on this agent
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
