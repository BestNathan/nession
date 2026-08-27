import {
  Server, Clock, Activity, Monitor, Copy, Check, FolderOpen,
  Cpu, Globe, Wifi, RefreshCw, Zap, Pencil, Trash2, Plus,
} from 'lucide-react';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import type { Agent, Session } from '../types';
import {
  formatRelativeTime, formatAbsoluteTime, getStatusVariant,
  agentDisplayName, computeUptime,
} from '../lib/format';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Separator } from './ui/separator';
import { Sheet, SheetContent } from './ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import { copyToClipboard } from '../lib/clipboard';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { ClaudeCodeSection } from '../extensions/claude-code/components/ClaudeCodeSection';

/** Max heartbeat entries to display in timeline. */
const MAX_HEARTBEATS = 5;

interface AgentDetailPanelProps {
  agent: Agent;
  heartbeatHistory: string[];  // ISO timestamps, oldest first
  sessions: Session[];         // sessions filtered for this agent
  onClose: () => void;
  onRefresh?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onCreateSession?: () => void;
}

// ── Heartbeat helpers ──────────────────────────────────────────────────────

function getHealthStatus(heartbeatHistory: string[]): { label: string; color: string; bg: string } {
  if (heartbeatHistory.length === 0) {
    return { label: 'No Data', color: 'text-muted-foreground', bg: 'bg-muted/10' };
  }
  const latest = heartbeatHistory[heartbeatHistory.length - 1];
  const diffMs = Date.now() - new Date(latest).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 30) {return { label: 'Healthy', color: 'text-success', bg: 'bg-success/10' };}
  if (seconds < 120) {return { label: 'Fair', color: 'text-warning', bg: 'bg-warning/10' };}
  return { label: 'Poor', color: 'text-destructive', bg: 'bg-destructive/10' };
}

// ── Copy helpers ────────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    copyToClipboard(text)
      .then(() => {
        setCopied(true);
        toast.success(label ? `${label} copied` : 'Copied');
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('Failed to copy'));
  }, [text, label]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0"
      onClick={handleCopy}
      title={`Copy ${label || text}`}
    >
      {copied
        ? <Check className="w-3 h-3 text-success" />
        : <Copy className="w-3 h-3" />}
    </Button>
  );
}

// ── Format helpers ──────────────────────────────────────────────────────────

function formatAgentDetails(agent: Agent, heartbeatHistory: string[], agentSessions: Session[]): string {
  const uptime = computeUptime(agent.registered_at);
  const health = getHealthStatus(heartbeatHistory);
  const lines = [
    `Agent: ${agentDisplayName(agent)}`,
    `Status: ${agent.status}`,
    `Agent ID: ${agent.agent_id}`,
    `Health: ${health.label}`,
    '',
    '── Stats ──',
    `Uptime: ${uptime || 'N/A'}`,
    `Active Sessions: ${agent.session_count}`,
    '',
    '── Network ──',
    `Hostname: ${agent.hostname}`,
    `IP Address: ${agent.ip_address}`,
    `Port: ${agent.port}`,
    '',
    '── Software ──',
    `Nession: ${agent.metadata?.nession_version ?? 'Unknown'}`,
    `Image: ${agent.metadata?.image_tag ?? 'unknown'}`,
    `tmux: ${agent.metadata?.tmux_version ?? 'Unknown'}`,
    `OS: ${agent.metadata?.os_version ?? 'Unknown'}`,
    '',
    '── Heartbeat History ──',
    ...(heartbeatHistory.length === 0
      ? ['No heartbeat data yet']
      : [...heartbeatHistory].reverse().slice(0, MAX_HEARTBEATS).map((iso) =>
          `${formatRelativeTime(iso)} — ${formatAbsoluteTime(iso)}`)),
    '',
    '── Sessions ──',
    ...(agentSessions.length === 0
      ? ['No sessions on this agent']
      : agentSessions.slice(0, 5).map((s) =>
          `  ${s.session_name}  status=${s.status}  last_activity=${formatRelativeTime(s.last_activity)}`)),
  ];
  return lines.join('\n');
}

function formatSessionDuration(lastActivity: string): string {
  const diffMs = Date.now() - new Date(lastActivity).getTime();
  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {return `${hours}h ${minutes}m`;}
  if (minutes > 0) {return `${minutes}m`;}
  return 'just now';
}

// ── Sub-components ──────────────────────────────────────────────────────────

/** Pulse dot for online status indicator. */
function PulseDot({ className }: { className?: string }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      <span className={cn(
        'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
        className || 'bg-agent-online',
      )} />
      <span className={cn(
        'relative inline-flex rounded-full h-2.5 w-2.5',
        className || 'bg-agent-online',
      )} />
    </span>
  );
}

function StatCard({
  icon: iconComp,
  label,
  value,
  sub,
  colorClass,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  colorClass?: string;
}) {
  const Icon = iconComp;
  return (
    <Card size="sm" className="flex-1 min-w-0">
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <Icon className={cn('w-3.5 h-3.5 shrink-0', colorClass || 'text-muted-foreground')} />
          <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
        </div>
        <p className={cn('text-lg font-bold leading-tight', colorClass)}>{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
      </CardContent>
    </Card>
  );
}

/** Horizontal heartbeat timeline showing last N heartbeats. */
function HeartbeatTimeline({ history }: { history: string[] }) {
  if (history.length === 0) {
    return <p className="text-sm text-muted-foreground">No heartbeat data yet</p>;
  }

  const recent = [...history].reverse().slice(0, MAX_HEARTBEATS);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {recent.map((iso, i) => {
          const diffMs = Date.now() - new Date(iso).getTime();
          const seconds = Math.floor(diffMs / 1000);
          return (
            <div key={i} className="flex items-center gap-1.5 flex-1 last:flex-[0_0_auto]">
              <div
                className={cn(
                  'h-2.5 w-2.5 rounded-full shrink-0',
                  seconds < 60 ? 'bg-success' : seconds < 180 ? 'bg-warning' : 'bg-muted-foreground',
                )}
                title={formatAbsoluteTime(iso)}
              />
              {i < recent.length - 1 && (
                <div className="h-px flex-1 bg-border min-w-[8px]" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{formatRelativeTime(recent[0])}</span>
        <span>{formatRelativeTime(recent[recent.length - 1])}</span>
      </div>
    </div>
  );
}

/** Truncated agent ID with copy. */
function AgentIdRow({ agentId }: { agentId: string }) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      <span className="text-xs text-muted-foreground font-mono truncate" title={agentId}>
        {agentId.length > 24 ? `${agentId.slice(0, 12)}...${agentId.slice(-8)}` : agentId}
      </span>
      <CopyButton text={agentId} label="Agent ID" />
    </div>
  );
}

/** System information card with two-column grid. */
function SystemInfoCard({ agent }: { agent: Agent }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Cpu className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">System Information</h3>
      </div>
      <Card size="sm">
        <CardContent className="flex flex-col p-3 gap-2.5">
          {/* Network */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Network</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              <InfoChip label="Hostname" value={agent.hostname} copy />
              <InfoChip label="IP Address" value={agent.ip_address} copy />
              <InfoChip label="Port" value={String(agent.port)} />
            </div>
          </div>
          <Separator />
          {/* Software */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Software</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              <InfoChip
                label="Nession"
                value={agent.metadata?.nession_version ? `v${agent.metadata.nession_version}` : 'Unknown'}
              />
              <InfoChip label="Image" value={agent.metadata?.image_tag ?? 'unknown'} />
              <InfoChip label="tmux" value={agent.metadata?.tmux_version ?? 'Unknown'} />
              <InfoChip label="OS" value={agent.metadata?.os_version ?? 'Unknown'} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function InfoChip({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-1.5 min-w-0">
      <span className="text-[11px] text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-center gap-0.5 min-w-0">
        <span className="text-xs font-mono truncate max-w-[140px]" title={value}>{value}</span>
        {copy && <CopyButton text={value} label={label} />}
      </div>
    </div>
  );
}

/** Recent sessions list for this agent. */
function RecentSessions({ sessions }: { sessions: Session[] }) {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-4">
        <Monitor className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No active sessions</p>
        <p className="text-xs text-muted-foreground/70">Create a session to get started</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {sessions.slice(0, 5).map((s) => (
        <div
          key={s.session_id}
          className="flex items-center gap-2 p-2 rounded-md hover:bg-accent transition-colors group"
        >
          <div className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            s.status === 'active' ? 'bg-session-active' : s.status === 'detached' ? 'bg-session-active/60' : 'bg-session-unknown',
          )} />
          <span className="text-sm font-mono truncate flex-1 min-w-0">{s.session_name}</span>
          <span className="text-[11px] text-muted-foreground shrink-0">{formatSessionDuration(s.last_activity)}</span>
          <Badge
            variant={s.status === 'active' ? 'default' : s.status === 'detached' ? 'secondary' : 'outline'}
            className="text-[10px] capitalize shrink-0"
          >
            {s.status}
          </Badge>
        </div>
      ))}
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview' as const, label: 'Overview', icon: Monitor },
  { id: 'claude-code' as const, label: 'Claude Code', icon: FolderOpen },
];
type TabId = (typeof TABS)[number]['id'];

// ── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({
  agent,
  heartbeatHistory,
  sessions,
}: {
  agent: Agent;
  heartbeatHistory: string[];
  sessions: Session[];
}) {
  const uptime = computeUptime(agent.registered_at);
  const health = getHealthStatus(heartbeatHistory);
  const lastHb = heartbeatHistory.length > 0
    ? heartbeatHistory[heartbeatHistory.length - 1]
    : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Stats Cards */}
      <div className="flex gap-2 flex-wrap sm:flex-nowrap">
        <StatCard
          icon={Clock}
          label="Uptime"
          value={uptime || 'N/A'}
          sub={agent.registered_at ? `since ${formatAbsoluteTime(agent.registered_at)}` : undefined}
        />
        <StatCard
          icon={Monitor}
          label="Sessions"
          value={String(agent.session_count)}
          sub={`${agent.active_sessions ?? agent.session_count} active`}
        />
        <StatCard
          icon={Activity}
          label="Health"
          value={health.label}
          sub={lastHb ? `Last heartbeat ${formatRelativeTime(lastHb)}` : 'No data'}
          colorClass={health.color}
        />
      </div>

      <Separator />

      {/* System Information */}
      <SystemInfoCard agent={agent} />

      {/* Heartbeat Timeline */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Activity className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Heartbeat Timeline</h3>
          {heartbeatHistory.length > 0 && (
            <span className={cn(
              'text-[11px] px-1.5 py-0.5 rounded-full font-medium',
              health.bg, health.color,
            )}>
              {health.label}
            </span>
          )}
        </div>
        <HeartbeatTimeline history={heartbeatHistory} />
      </div>

      <Separator />

      {/* Recent Sessions */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Recent Sessions</h3>
          </div>
          <span className="text-xs text-muted-foreground">
            {sessions.length} session{sessions.length !== 1 ? 's' : ''} on this agent
          </span>
        </div>
        <RecentSessions sessions={sessions} />
      </div>
    </div>
  );
}

// ── Quick Actions Bar ───────────────────────────────────────────────────────

function QuickActionsBar({
  onCopyAll,
  onRefresh,
  onRename,
  onDelete,
  onCreateSession,
  isAgentOffline,
}: {
  onCopyAll: () => void;
  onRefresh?: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCreateSession: () => void;
  isAgentOffline: boolean;
}) {
  return (
    <div className="flex items-center gap-1 p-2 border-t border-border bg-card/50">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 text-xs gap-1.5 flex-1"
        onClick={onCopyAll}
      >
        <Copy className="w-3 h-3" />
        Copy All
      </Button>
      {onRefresh && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs gap-1.5 flex-1"
          onClick={onRefresh}
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </Button>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Rename agent"
              onClick={onRename}
            />
          }
        >
          <Pencil className="w-3.5 h-3.5" />
        </TooltipTrigger>
        <TooltipContent>Rename agent</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title={isAgentOffline ? 'Delete agent' : 'Agent must be offline to delete'}
              disabled={!isAgentOffline}
              onClick={onDelete}
            />
          }
        >
          <Trash2 className="w-3.5 h-3.5 text-destructive" />
        </TooltipTrigger>
        <TooltipContent>{isAgentOffline ? 'Delete agent' : 'Agent must be offline to delete'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title={isAgentOffline ? 'Agent must be online to create sessions' : 'Create session'}
              disabled={isAgentOffline}
              onClick={onCreateSession}
            />
          }
        >
          <Plus className="w-3.5 h-3.5" />
        </TooltipTrigger>
        <TooltipContent>{isAgentOffline ? 'Agent must be online to create sessions' : 'Create session'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled
            />
          }
        >
          <Zap className="w-3.5 h-3.5" />
        </TooltipTrigger>
        <TooltipContent>Not yet available</TooltipContent>
      </Tooltip>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export function AgentDetailPanel({
  agent,
  heartbeatHistory,
  sessions,
  onClose,
  onRefresh,
  onRename,
  onDelete,
  onCreateSession,
}: AgentDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  // Tick every second so relative timestamps stay live.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const hasClaudeCode = useMemo(() => agent.metadata?.nession_version !== undefined, [agent]);

  const handleCopyAll = useCallback(() => {
    copyToClipboard(formatAgentDetails(agent, heartbeatHistory, sessions))
      .then(() => toast.success('Agent details copied'))
      .catch(() => toast.error('Failed to copy'));
  }, [agent, heartbeatHistory, sessions]);

  return (
    <Sheet open onOpenChange={(open) => { if (!open) {onClose();} }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[400px] md:w-[640px] lg:w-[720px] max-w-[100vw] flex flex-col p-0 pb-[env(safe-area-inset-bottom)]"
      >
        {/* ── Header ── */}
        <div className="flex flex-col p-4 pb-2 flex-shrink-0 gap-2">
          {/* Status + quick stats */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {agent.status === 'online' && <PulseDot />}
              <Badge variant={getStatusVariant(agent.status)} className="capitalize text-xs">
                {agent.status}
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {agent.registered_at && (
                <span title={`Registered ${formatAbsoluteTime(agent.registered_at)}`}>
                  <Clock className="w-3 h-3 inline mr-1" />
                  {computeUptime(agent.registered_at)}
                </span>
              )}
              <span>
                <Monitor className="w-3 h-3 inline mr-1" />
                {agent.session_count} session{agent.session_count !== 1 ? 's' : ''}
              </span>
              {heartbeatHistory.length > 0 && (
                <span title={`Last heartbeat ${formatAbsoluteTime(heartbeatHistory[heartbeatHistory.length - 1])}`}>
                  <Wifi className="w-3 h-3 inline mr-1" />
                  {formatRelativeTime(heartbeatHistory[heartbeatHistory.length - 1])}
                </span>
              )}
            </div>
          </div>

          {/* Agent name + copy */}
          <div className="flex items-center gap-1.5">
            <h2 className="font-semibold text-lg text-foreground truncate">{agentDisplayName(agent)}</h2>
            <CopyButton text={formatAgentDetails(agent, heartbeatHistory, sessions)} label="Agent details" />
          </div>

          {/* Agent ID + hostname */}
          <div>
            <AgentIdRow agentId={agent.agent_id} />
            {agent.display_name && (
              <div className="flex items-center gap-1 mt-0.5">
                <Globe className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground font-mono truncate" title={agent.hostname}>
                  {agent.hostname}
                </span>
                <CopyButton text={agent.hostname} label="Hostname" />
              </div>
            )}
          </div>
        </div>

        {/* ── Sticky Tab Bar ── */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)} className="flex-shrink-0 sticky top-0 z-10 bg-background -mx-4 px-4">
          <TabsList
            variant="line"
            className="h-auto gap-0 rounded-none border-b border-border bg-transparent p-0 w-full justify-start"
          >
              {TABS.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium h-auto rounded-none
                    border-b-2 border-transparent
                    data-active:border-primary data-active:text-foreground data-active:shadow-none
                    text-muted-foreground hover:text-foreground relative"
                >
                  <tab.icon className="w-3.5 h-3.5" />
                  {tab.label}
                  {tab.id === 'claude-code' && hasClaudeCode && (
                    <span className="absolute -top-0.5 -right-1 w-1.5 h-1.5 rounded-full bg-primary" />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

        {/* ── Tab Content (scrollable) ── */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {activeTab === 'overview' && (
            <OverviewTab agent={agent} heartbeatHistory={heartbeatHistory} sessions={sessions} />
          )}
          {activeTab === 'claude-code' && <ClaudeCodeSection agent={agent} />}
        </div>

        {/* ── Quick Actions Bar (sticky bottom) ── */}
        <div className="flex-shrink-0 sticky bottom-0">
          <QuickActionsBar
            onCopyAll={handleCopyAll} onRefresh={onRefresh}
            onRename={() => onRename?.()} onDelete={() => onDelete?.()}
            onCreateSession={() => onCreateSession?.()}
            isAgentOffline={agent.status === 'offline'}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
