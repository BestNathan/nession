import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAtom } from 'jotai';
import { Wifi, WifiOff, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import type { AttachInfo, AttachMode, AddressLatency, Session, EnvFileInfo, EnvFileRef } from '../../types';
import { loadAttachPrefs } from '../../services/attachPrefs';
import { detectWebGLSupport } from '../../terminal/Renderer';
import { useWebSocket } from '../../hooks/useWebSocket';
import { attachInfoAtom } from '../../atoms/terminal';
import { EnvFileMultiSelect } from './EnvFileMultiSelect';

/** Result handed back to the flow once the user confirms an attach. */
export interface AttachChoice {
  /** The mode the user picked in the dialog ('auto' | 'p2p' | 'relay'). */
  mode: AttachMode;
  attachInfo: AttachInfo;
  /** Browser-tested candidate URLs, best-first. Empty for relay. */
  orderedUrls: string[];
  /** Per-URL latency the BROWSER measured (not the server's probe). */
  latencies: AddressLatency[];
  /** Manual single-address override, or null for automatic (best) selection. */
  selectedUrl: string | null;
  /** For relay mode: manually chosen relay endpoint, or null for auto. */
  relayUrl?: string | null;
  /** Renderer the user picked (webgl/canvas). */
  renderer: 'webgl' | 'canvas';
  /** Env files to source in the session after attach. */
  envRefs: EnvFileRef[];
}

interface AttachDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  /** Called with the resolved attach choice; the flow shows the terminal. */
  onConfirm: (session: Session, choice: AttachChoice) => void;
  /** Per-agent latency cache; supplies probe data without live testing. */
  probeCache: import('../../hooks/useAddressProbeCache').AddressProbeCache;
}

const MODES: { value: AttachMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Test paths, pick fastest, fall back to relay' },
  { value: 'p2p', label: 'P2P', hint: 'Direct to agent (choose a path below)' },
  { value: 'relay', label: 'Relay', hint: 'Proxy through server (works behind NAT/firewalls)' },
];

const AUTO_URL = '__auto__';

/**
 * Attach dialog: pick connection mode and (for P2P) a candidate address. Latency
 * is read from the app-level address probe cache — not measured live here — so
 * the dialog never blocks on probing. A "Re-test" control forces a fresh probe.
 */
export function AttachDialog({ isOpen, onClose, session, onConfirm, probeCache }: AttachDialogProps) {
  const wsService = useWebSocket();
  const [mode, setMode] = useState<AttachMode>('auto');
  // Attach info fetched for P2P so we get the connection token + candidate list.
  const [attachInfo, setAttachInfo] = useAtom(attachInfoAtom);
  const [selectedUrl, setSelectedUrl] = useState<string>(AUTO_URL);
  const [error, setError] = useState<string | null>(null);
  const [renderer, setRenderer] = useState<'webgl' | 'canvas'>('webgl');
  const [envFiles, setEnvFiles] = useState<EnvFileInfo[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<EnvFileRef[]>([]);

  const agentId = session?.agent_id ?? session?.session_id.split(':')[0] ?? null;
  const webglSupported = detectWebGLSupport();

  // Reset per open, pre-filling the last-used mode + renderer.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const prefs = loadAttachPrefs();
    setMode(prefs.mode === 'relay' ? 'auto' : prefs.mode);
    setRenderer(webglSupported ? prefs.renderer : 'canvas');
    setAttachInfo(null);
    setSelectedUrl(AUTO_URL);
    setError(null);
    // Load available env files and clear the previous selection on each open.
    wsService.listEnvFiles()
      .then((resp) => setEnvFiles(resp.files))
      .catch(() => {});
    setSelectedEnv([]);
  }, [isOpen, webglSupported, wsService, setAttachInfo]);

  // Manual relay URL override — only relevant in relay mode.
  const relayUrl = useMemo(
    () => (mode === 'relay' && selectedUrl !== AUTO_URL ? selectedUrl : undefined),
    [mode, selectedUrl],
  );

  // Track previous requested mode so we only clear attachInfo when switching
  // modes (e.g. Auto → Relay), not when re-selecting an address in the list.
  const prevRequestedMode = useRef<string | null>(null);

  // Fetch attach info for the connection token + candidate list.
  useEffect(() => {
    if (!isOpen || !session) {
      return;
    }
    let cancelled = false;
    setError(null);
    const requestedMode = mode === 'auto' ? 'p2p' : mode;
    // Only clear attachInfo on mode/session change, not on address re-select.
    // Otherwise PathList disappears while the re-fetch is in flight.
    if (prevRequestedMode.current !== null && prevRequestedMode.current !== requestedMode) {
      setAttachInfo(null);
    }
    prevRequestedMode.current = requestedMode;
    void (async () => {
      try {
        const info = await wsService.requestAttach(session.session_id, requestedMode, relayUrl);
        if (!cancelled) {
          setAttachInfo(info);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to query agent addresses');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, session, wsService, mode, relayUrl, setAttachInfo]);

  const cached = agentId ? probeCache.getProbe(agentId) : undefined;
  const results = useMemo<AddressLatency[]>(() => cached?.latencies ?? [], [cached]);
  const orderedUrls = useMemo<string[]>(() => cached?.orderedUrls ?? [], [cached]);
  const bestUrl = orderedUrls[0] ?? null;
  const latencyByUrl = new Map(results.map((r) => [r.url, r.latencyMs]));

  const handleConfirm = useCallback(() => {
    if (!session || !attachInfo) {
      return;
    }
    const manual = selectedUrl === AUTO_URL ? null : selectedUrl;
    const relayUrl = mode === 'relay' ? manual : null;
    onConfirm(session, { mode, attachInfo, orderedUrls, latencies: results, selectedUrl: manual, relayUrl, renderer, envRefs: selectedEnv });
  }, [session, attachInfo, selectedUrl, orderedUrls, results, mode, renderer, onConfirm, selectedEnv]);

  const candidates = attachInfo?.addresses ?? [];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach{session ? `: ${session.session_name}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Connection Mode</Label>
            <ModeToggle mode={mode} onChange={setMode} />
          </div>

          {/* Env files to source after attach (collapsible, remembers open state). */}
          <EnvPickerSection files={envFiles} selected={selectedEnv} onChange={setSelectedEnv} />

          {/* Candidate address list.
              P2P mode: browser-measured latency.
              Relay mode: server TCP probe results (RTT + Reachable/Unreachable). */}
          {candidates.length > 0 ? (
            <PathList
              candidates={candidates}
              latencyByUrl={mode === 'relay'
                ? new Map(candidates.map(a => [a.url, a.rtt_ms ?? null]))
                : latencyByUrl}
              bestUrl={bestUrl}
              selectedUrl={selectedUrl}
              onSelect={setSelectedUrl}
              onRetest={mode !== 'relay' && agentId ? () => probeCache.refreshAgent(agentId) : undefined}
              isRelay={mode === 'relay'}
            />
          ) : null}

          <RendererToggle renderer={renderer} onChange={setRenderer} webglSupported={webglSupported} />

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!attachInfo}>
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The two connection-mode buttons (Auto / P2P). */
function ModeToggle({ mode, onChange }: { mode: AttachMode; onChange: (m: AttachMode) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => onChange(m.value)}
          className={cn(
            'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
            mode === m.value ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
          )}
        >
          <span className="text-sm font-medium">{m.label}</span>
          <span className="text-[10px] text-muted-foreground leading-tight">{m.hint}</span>
        </button>
      ))}
    </div>
  );
}

/** Renderer selection: WebGL (GPU) vs Canvas (compatibility). */
function RendererToggle({
  renderer,
  onChange,
  webglSupported,
}: {
  renderer: 'webgl' | 'canvas';
  onChange: (r: 'webgl' | 'canvas') => void;
  webglSupported: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Renderer</Label>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onChange('webgl')}
          disabled={!webglSupported}
          className={cn(
            'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
            renderer === 'webgl' ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
            !webglSupported && 'opacity-50 cursor-not-allowed',
          )}
        >
          <span className="text-sm font-medium">WebGL</span>
          <span className="text-[10px] text-muted-foreground leading-tight">
            {webglSupported ? 'GPU-accelerated' : 'not supported'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChange('canvas')}
          className={cn(
            'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
            renderer === 'canvas' ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
          )}
        >
          <span className="text-sm font-medium">Canvas</span>
          <span className="text-[10px] text-muted-foreground leading-tight">compatibility</span>
        </button>
      </div>
    </div>
  );
}

interface PathListProps {
  candidates: NonNullable<AttachInfo['addresses']>;
  latencyByUrl: Map<string, number | null>;
  bestUrl: string | null;
  selectedUrl: string;
  onSelect: (url: string) => void;
  /** Force a fresh probe of the agent's addresses; hidden when unavailable. */
  onRetest?: () => void;
  /** When true, use server probe data (rtt_ms, Reachable/Unreachable) labels. */
  isRelay?: boolean;
}

/** The "Connection Path" section: Auto row + one row per candidate address. */
function PathList({ candidates, latencyByUrl, bestUrl, selectedUrl, onSelect, onRetest, isRelay }: PathListProps) {
  const bestLatency = bestUrl ? latencyByUrl.get(bestUrl) : undefined;
  const autoSublabel = isRelay
    ? 'server auto-selects (Reachable > Unknown > Unreachable)'
    : bestUrl
      ? `fastest reachable path${bestLatency !== null && bestLatency !== undefined ? ` · ${bestLatency}ms` : ''}`
      : 'browser will decide / relay';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Connection Path</Label>
        {onRetest ? (
          <button
            type="button"
            onClick={onRetest}
            className="text-[10px] text-muted-foreground hover:text-foreground underline"
          >
            Re-test
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
        <AddressRow
          label="Auto"
          sublabel={autoSublabel}
          selected={selectedUrl === AUTO_URL}
          onSelect={() => onSelect(AUTO_URL)}
        />
        {candidates.map((addr) => {
          const latency = latencyByUrl.get(addr.url);
          // Relay mode: use server probe status (Reachable/Unreachable/Unknown).
          // P2P mode: use browser test result (latency != null → reachable).
          const reachable = isRelay
            ? addr.status === 'reachable'
            : latency !== null && latency !== undefined;
          const statusLabel = isRelay
            ? (addr.status === 'reachable' ? 'reachable' : addr.status === 'unreachable' ? 'unreachable' : 'unknown')
            : undefined;
          return (
            <AddressRow
              key={addr.url}
              label={addr.label ?? addr.network_type}
              badge={addr.network_type}
              sublabel={addr.url}
              reachable={reachable}
              statusLabel={statusLabel}
              latencyMs={latency ?? undefined}
              selected={selectedUrl === addr.url}
              onSelect={() => onSelect(addr.url)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface AddressRowProps {
  label: string;
  badge?: string;
  sublabel: string;
  selected: boolean;
  onSelect: () => void;
  /** undefined = no cached probe; true/false = reachability. */
  reachable?: boolean;
  latencyMs?: number;
  /** Server probe status label (relay mode). */
  statusLabel?: string;
}

function AddressRow({ label, badge, sublabel, selected, onSelect, reachable, latencyMs, statusLabel }: AddressRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
        selected ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
      )}
    >
      {reachable === undefined ? (
        <span className="w-3.5 shrink-0" />
      ) : reachable ? (
        <Wifi className="w-3.5 h-3.5 text-green-500 shrink-0" />
      ) : (
        <WifiOff className="w-3.5 h-3.5 text-red-500 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{label}</span>
          {badge ? (
            <span className="text-[10px] uppercase px-1 rounded bg-muted text-muted-foreground">
              {badge}
            </span>
          ) : null}
        </div>
        <div className="text-[10px] text-muted-foreground truncate">{sublabel}</div>
      </div>
      {latencyMs !== undefined ? (
        <span className="text-[10px] text-muted-foreground shrink-0">{latencyMs}ms</span>
      ) : null}
      {statusLabel ? (
        <span className={cn(
          'text-[10px] shrink-0',
          statusLabel === 'reachable' ? 'text-green-500' : 'text-red-500',
        )}>{statusLabel}</span>
      ) : null}
    </button>
  );
}

/**
 * Collapsible env-file picker for the attach dialog. Tracks its own expanded
 * state (persisted to localStorage) so the dialog stays out of the way until
 * the user opts in. Selected files are sourced in the session after attach.
 */
function EnvPickerSection({
  files,
  selected,
  onChange,
}: {
  files: EnvFileInfo[];
  selected: EnvFileRef[];
  onChange: (selected: EnvFileRef[]) => void;
}) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem('attach-env-expanded') === 'true');
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem('attach-env-expanded', String(next));
  };
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Environment Files
        {selected.length > 0 && (
          <span className="text-[10px] text-muted-foreground ml-1">
            ({selected.length} selected)
          </span>
        )}
      </button>
      {expanded && (
        <EnvFileMultiSelect
          files={files}
          selected={selected}
          onChange={onChange}
        />
      )}
    </div>
  );
}
