import { useState, useEffect, useCallback, useMemo } from 'react';
import { Wifi, WifiOff } from 'lucide-react';
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
import type { AttachInfo, AttachMode, AddressLatency, Session } from '../../types';
import { loadAttachPrefs } from '../../services/attachPrefs';
import { detectWebGLSupport } from '../../terminal/Renderer';
import { useWebSocket } from '../../hooks/useWebSocket';

/** Result handed back to the flow once the user confirms an attach. */
export interface AttachChoice {
  /** The mode the user picked in the dialog ('auto' | 'p2p'). */
  mode: AttachMode;
  attachInfo: AttachInfo;
  /** Browser-tested candidate URLs, best-first. Empty for relay. */
  orderedUrls: string[];
  /** Per-URL latency the BROWSER measured (not the server's probe). */
  latencies: AddressLatency[];
  /** Manual single-address override, or null for automatic (best) selection. */
  selectedUrl: string | null;
  /** Renderer the user picked (webgl/canvas). */
  renderer: 'webgl' | 'canvas';
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

// Relay is intentionally omitted as a forced mode: the server's relay attach
// path is not wired to return a response here, so "Auto" reaches relay only via
// P2P fallback. Users choose Auto (browser picks best P2P) or P2P (advanced).
const MODES: { value: AttachMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Test paths, pick fastest, fall back to relay' },
  { value: 'p2p', label: 'P2P', hint: 'Direct to agent (choose a path below)' },
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
  const [attachInfo, setAttachInfo] = useState<AttachInfo | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string>(AUTO_URL);
  const [error, setError] = useState<string | null>(null);
  const [renderer, setRenderer] = useState<'webgl' | 'canvas'>('webgl');

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
  }, [isOpen, webglSupported]);

  // Fetch attach info for the connection token + candidate list. No live probing
  // here — latency comes from the address probe cache.
  useEffect(() => {
    if (!isOpen || !session) {
      return;
    }
    let cancelled = false;
    setError(null);
    setAttachInfo(null);
    void (async () => {
      try {
        const info = await wsService.requestAttach(session.session_id, 'p2p');
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
  }, [isOpen, session, wsService]);

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
    onConfirm(session, { mode, attachInfo, orderedUrls, latencies: results, selectedUrl: manual, renderer });
  }, [session, attachInfo, selectedUrl, orderedUrls, results, mode, renderer, onConfirm]);

  const candidates = attachInfo?.addresses ?? [];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach{session ? `: ${session.session_name}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Connection Mode</Label>
            <ModeToggle mode={mode} onChange={setMode} />
          </div>

          {/* Candidate address list with cached browser-measured latency. */}
          {candidates.length > 1 ? (
            <PathList
              candidates={candidates}
              latencyByUrl={latencyByUrl}
              bestUrl={bestUrl}
              selectedUrl={selectedUrl}
              onSelect={setSelectedUrl}
              onRetest={agentId ? () => probeCache.refreshAgent(agentId) : undefined}
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
    <div className="grid grid-cols-2 gap-2">
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
    <div className="space-y-2">
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
}

/** The "Connection Path" section: Auto row + one row per candidate address. */
function PathList({ candidates, latencyByUrl, bestUrl, selectedUrl, onSelect, onRetest }: PathListProps) {
  const bestLatency = bestUrl ? latencyByUrl.get(bestUrl) : undefined;
  const autoSublabel = bestUrl
    ? `fastest reachable path${bestLatency !== null && bestLatency !== undefined ? ` · ${bestLatency}ms` : ''}`
    : 'browser will decide / relay';

  return (
    <div className="space-y-2">
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
      <div className="space-y-1 max-h-56 overflow-y-auto">
        <AddressRow
          label="Auto"
          sublabel={autoSublabel}
          selected={selectedUrl === AUTO_URL}
          onSelect={() => onSelect(AUTO_URL)}
        />
        {candidates.map((addr) => {
          const latency = latencyByUrl.get(addr.url);
          const reachable = latency !== null && latency !== undefined;
          return (
            <AddressRow
              key={addr.url}
              label={addr.label ?? addr.network_type}
              badge={addr.network_type}
              sublabel={addr.url}
              reachable={reachable}
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
  /** undefined = no cached probe; true/false = browser reachability. */
  reachable?: boolean;
  latencyMs?: number;
}

function AddressRow({ label, badge, sublabel, selected, onSelect, reachable, latencyMs }: AddressRowProps) {
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
    </button>
  );
}
