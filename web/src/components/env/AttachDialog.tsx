import { useState, useEffect, useCallback } from 'react';
import { Loader2, Wifi, WifiOff } from 'lucide-react';
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
import type { WebSocketService } from '../../services/websocket';
import { loadAttachPrefs } from '../../services/attachPrefs';
import { testAddresses, orderByLatency } from '../../services/addressSelection';

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
}

interface AttachDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  wsService: WebSocketService;
  /** Called with the resolved attach choice; the flow shows the terminal. */
  onConfirm: (session: Session, choice: AttachChoice) => void;
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
 * Attach dialog: pick connection mode, then — for P2P — the server returns the
 * agent's candidate addresses which THIS BROWSER latency-tests directly (the
 * server's own probe is a different vantage point and only shown as a hint).
 * The user connects on the fastest browser-reachable path, or overrides it.
 */
export function AttachDialog({ isOpen, onClose, session, wsService, onConfirm }: AttachDialogProps) {
  const [mode, setMode] = useState<AttachMode>('auto');
  // Attach info fetched for P2P so we can enumerate + test candidate addresses.
  const [attachInfo, setAttachInfo] = useState<AttachInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<AddressLatency[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string>(AUTO_URL);
  const [error, setError] = useState<string | null>(null);

  // Reset per open, pre-filling the last-used mode.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const prefs = loadAttachPrefs();
    setMode(prefs.mode === 'relay' ? 'auto' : prefs.mode);
    setAttachInfo(null);
    setResults([]);
    setSelectedUrl(AUTO_URL);
    setError(null);
    setTesting(false);
  }, [isOpen]);

  // When P2P/Auto is chosen, fetch the address list and browser-test it. Relay
  // needs no probing. Re-runs when the user toggles mode inside the dialog.
  useEffect(() => {
    if (!isOpen || !session) {
      return;
    }
    let cancelled = false;
    setError(null);
    setResults([]);
    setAttachInfo(null);

    void (async () => {
      try {
        setTesting(true);
        // Ask for a P2P attach to learn the candidate addresses. (Auto also
        // starts from P2P; it only differs by falling back to relay on failure.)
        const info = await wsService.requestAttach(session.session_id, 'p2p');
        if (cancelled) {
          return;
        }
        setAttachInfo(info);
        const candidates = info.addresses ?? [];
        if (candidates.length === 0) {
          // Legacy single-address server: nothing to rank.
          setResults(
            info.agent_address ? [{ url: info.agent_address, latencyMs: null }] : [],
          );
          setTesting(false);
          return;
        }
        const tested = await testAddresses(candidates);
        if (!cancelled) {
          setResults(tested);
          setTesting(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to query agent addresses');
          setTesting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, session, wsService]);

  const orderedUrls = orderByLatency(results);
  const bestUrl = orderedUrls[0] ?? null;

  const handleConfirm = useCallback(() => {
    if (!session || !attachInfo) {
      return;
    }
    const manual = selectedUrl === AUTO_URL ? null : selectedUrl;
    // Auto mode with zero browser-reachable paths still hands over the order
    // (may be empty) — the connection layer then falls back to relay.
    onConfirm(session, { mode, attachInfo, orderedUrls, latencies: results, selectedUrl: manual });
  }, [session, attachInfo, selectedUrl, orderedUrls, results, mode, onConfirm]);

  const latencyByUrl = new Map(results.map((r) => [r.url, r.latencyMs]));
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

          {/* Candidate address list with browser-measured latency. */}
          {candidates.length > 1 ? (
            <PathList
              candidates={candidates}
              latencyByUrl={latencyByUrl}
              bestUrl={bestUrl}
              testing={testing}
              selectedUrl={selectedUrl}
              onSelect={setSelectedUrl}
            />
          ) : null}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!attachInfo || testing}>
            {testing ? 'Testing…' : 'Attach'}
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

interface PathListProps {
  candidates: NonNullable<AttachInfo['addresses']>;
  latencyByUrl: Map<string, number | null>;
  bestUrl: string | null;
  testing: boolean;
  selectedUrl: string;
  onSelect: (url: string) => void;
}

/** The "Connection Path" section: Auto row + one row per candidate address. */
function PathList({ candidates, latencyByUrl, bestUrl, testing, selectedUrl, onSelect }: PathListProps) {
  const bestLatency = bestUrl ? latencyByUrl.get(bestUrl) : undefined;
  const autoSublabel = bestUrl
    ? `fastest reachable path${bestLatency !== null && bestLatency !== undefined ? ` · ${bestLatency}ms` : ''}`
    : 'browser will decide / relay';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Connection Path</Label>
        {testing ? (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> testing…
          </span>
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
              reachable={testing ? undefined : reachable}
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
  /** undefined = not yet tested; true/false = browser reachability. */
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
