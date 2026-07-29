import { Server, Clock, Terminal, Activity, Monitor, Copy, Check, FolderOpen } from 'lucide-react';
import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import type { Agent } from '../types';
import { formatRelativeTime, formatAbsoluteTime, getStatusVariant, agentDisplayName } from '../lib/format';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Sheet, SheetContent } from './ui/sheet';
import { cn } from '../lib/utils';
import { ClaudeCodeSection } from '../extensions/claude-code/components/ClaudeCodeSection';

/** Max heartbeat entries to track and display. */
const MAX_HEARTBEATS = 5;

interface AgentDetailPanelProps {
  agent: Agent;
  heartbeatHistory: string[];  // ISO timestamps, oldest first
  onClose: () => void;
}

function computeUptime(registeredAt?: string): string | null {
  if (!registeredAt) {return null;}
  const diffMs = Date.now() - new Date(registeredAt).getTime();
  if (diffMs < 0) {return null;}
  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function getHeartbeatColor(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {return 'bg-green-500';}
  if (seconds < 180) {return 'bg-amber-500';}
  return 'bg-gray-500';
}

function formatAgentDetails(agent: Agent, heartbeatHistory: string[]): string {
  const uptime = computeUptime(agent.registered_at);
  const lines = [
    `Agent: ${agentDisplayName(agent)}`,
    `Status: ${agent.status}`,
    `Agent ID: ${agent.agent_id}`,
    '',
    '── Connection ──',
    `Hostname: ${agent.hostname}`,
    `IP Address: ${agent.ip_address}`,
    `Port: ${agent.port}`,
    '',
    '── Versions ──',
    `Nession: ${agent.metadata?.nession_version ?? 'Unknown'}`,
    `Image: ${agent.metadata?.image_tag ?? 'unknown'}`,
    `tmux: ${agent.metadata?.tmux_version ?? 'Unknown'}`,
    `OS: ${agent.metadata?.os_version ?? 'Unknown'}`,
    '',
    '── Uptime ──',
    uptime
      ? `${uptime} (since ${formatAbsoluteTime(heartbeatHistory[0])})`
      : 'N/A',
    '',
    '── Heartbeat History ──',
    ...(heartbeatHistory.length === 0
      ? ['No heartbeat data yet']
      : [...heartbeatHistory].reverse().slice(0, MAX_HEARTBEATS).map((iso) =>
          `${formatRelativeTime(iso)} — ${formatAbsoluteTime(iso)}`)),
    '',
    `Active Sessions: ${agent.session_count}`,
  ];
  return lines.join('\n');
}

/** Copy text via clipboard API with execCommand fallback. */
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for non-HTTPS / older browsers
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      if (document.execCommand('copy')) { resolve(); }
      else { reject(new Error('execCommand returned false')); }
    } catch (e) {
      reject(e);
    } finally {
      document.body.removeChild(ta);
    }
  });
}

function SectionHeader(props: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  const { icon: IconComponent, title } = props;
  return (
    <div className="flex items-center gap-2 mb-2">
      <IconComponent className="w-4 h-4 text-muted-foreground" />
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 gap-2">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm font-medium truncate max-w-[200px]" title={value}>
        {value}
      </span>
    </div>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview', icon: Monitor },
  { id: 'claude-code', label: 'Claude Code', icon: FolderOpen },
] as const;
type TabId = (typeof TABS)[number]['id'];

function TabBar({ active, onSelect }: { active: TabId; onSelect: (id: TabId) => void }) {
  return (
    <div className="flex border-b border-border bg-muted/30 -mx-4 px-4">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-[1px]',
            active === tab.id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <tab.icon className="w-3.5 h-3.5" />
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function OverviewTab({ agent, heartbeatHistory }: { agent: Agent; heartbeatHistory: string[] }) {
  const uptime = computeUptime(agent.registered_at);

  return (
    <div className="space-y-3">
      <div>
        <SectionHeader icon={Monitor} title="Connection" />
        <InfoRow label="Hostname" value={agent.hostname} />
        <InfoRow label="IP Address" value={agent.ip_address} />
        <InfoRow label="Port" value={String(agent.port)} />
      </div>
      <Separator />
      <div>
        <SectionHeader icon={Terminal} title="Versions" />
        <InfoRow label="Nession" value={agent.metadata?.nession_version ?? 'Unknown'} />
        <InfoRow label="Image" value={agent.metadata?.image_tag ?? 'unknown'} />
        <InfoRow label="tmux" value={agent.metadata?.tmux_version ?? 'Unknown'} />
        <InfoRow label="OS" value={agent.metadata?.os_version ?? 'Unknown'} />
      </div>
      <Separator />
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
      <div>
        <SectionHeader icon={Activity} title="Heartbeat History" />
        {heartbeatHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">No heartbeat data yet</p>
        ) : (
          <div className="space-y-1">
            {[...heartbeatHistory].reverse().slice(0, MAX_HEARTBEATS).map((iso, i) => (
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
      <div>
        <SectionHeader icon={Server} title="Sessions" />
        <p className="text-sm text-muted-foreground">
          {agent.session_count} active sessions on this agent
        </p>
      </div>
    </div>
  );
}

export function AgentDetailPanel({ agent, heartbeatHistory, onClose }: AgentDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [copied, setCopied] = useState(false);
  // Tick every second so relative timestamps ("Xs ago") stay live.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => { setTick((n) => n + 1); }, 1000);
    return () => { clearInterval(id); };
  }, []);

  const handleCopy = useCallback(() => {
    copyToClipboard(formatAgentDetails(agent, heartbeatHistory))
      .then(() => {
        setCopied(true);
        toast.success('Agent details copied');
        setTimeout(() => { setCopied(false); }, 1500);
      })
      .catch(() => { toast.error('Failed to copy'); });
  }, [agent, heartbeatHistory]);

  return (
    <Sheet open onOpenChange={(open) => { if (!open) { onClose(); } }}>
      <SheetContent side="right" className="w-full sm:w-[400px] md:w-[640px] lg:w-[720px] max-w-[100vw] flex flex-col pb-[env(safe-area-inset-bottom)]">
        {/* Header — fixed */}
        <div className="p-4 pb-2 flex-shrink-0">
          <Badge variant={getStatusVariant(agent.status)} className="capitalize mb-2">
            {agent.status}
          </Badge>
          <div className="flex items-center gap-1.5">
            <h2 className="font-semibold text-lg text-foreground">{agentDisplayName(agent)}</h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleCopy}
              title="Copy agent details"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            </Button>
          </div>
          {agent.display_name && (
            <p className="text-sm text-muted-foreground font-mono">{agent.hostname}</p>
          )}
        </div>

        {/* Tab bar — fixed */}
        <div className="flex-shrink-0">
          <TabBar active={activeTab} onSelect={setActiveTab} />
        </div>

        {/* Tab content — scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {activeTab === 'overview' && <OverviewTab agent={agent} heartbeatHistory={heartbeatHistory} />}
          {activeTab === 'claude-code' && <ClaudeCodeSection agent={agent} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
