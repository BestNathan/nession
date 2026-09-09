import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Wifi, WifiOff, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { AttachInfo, AttachMode, AddressLatency, Session, EnvFileInfo, EnvFileRef } from '@/types';
import { envApi } from '@/features/env';
import { sessionsApi } from '@/features/sessions';
import { loadAttachPrefs } from '@/services/attachPrefs';
import {
  candidateUrlsOf,
  loadSessionProfile,
  type SessionAttachProfile,
} from '@/services/sessionAttachProfile';
import { detectWebGLSupport } from '@/core/terminal-runtime/Renderer';
import { probeResultsAtom, probeRefreshRequestAtom } from '@/atoms/probe';
import { EnvFileMultiSelect } from '@/features/env/components/EnvFileMultiSelect';

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
  /** Which flow opened the dialog: attach (confirm → attach) or configure
   *  (Save → persist the profile only). Defaults to 'attach'. */
  intent?: 'attach' | 'configure';
  /** Called with the resolved attach choice; the flow shows the terminal. */
  onConfirm: (session: Session, choice: AttachChoice) => void;
}

const MODES: { value: AttachMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Test paths, pick fastest, fall back to relay' },
  { value: 'p2p', label: 'P2P', hint: 'Direct to agent (choose a path below)' },
  { value: 'relay', label: 'Relay', hint: 'Proxy through server (works behind NAT/firewalls)' },
];

const AUTO_URL = '__auto__';

/**
 * Attach dialog: pick connection mode and (for P2P) a candidate address. Latency
 * is read from the app-level probe results atom (written by useProbePolling) —
 * not measured live here — so the dialog never blocks on probing. A "Re-test"
 * control requests a fresh probe via probeRefreshRequestAtom.
 */
export function AttachDialog({ isOpen, intent = 'attach', onClose, session, onConfirm }: AttachDialogProps) {
  const [mode, setMode] = useState<AttachMode>('auto');
  // Attach info fetched for P2P so we get the connection token + candidate list.
  // Local state (not attachInfoAtom): this is dialog scratch space for the
  // session being PREVIEWED. attachInfoAtom holds the currently-ATTACHED
  // session and is only written by attachToSessionAtom on confirm. Writing it
  // here would tear down the live terminal the moment the dialog opens.
  const [attachInfo, setAttachInfo] = useState<AttachInfo | null>(null);
  // Browser-latency probe results for this agent come from the app-level atom
  // (written by useProbePolling), never probed live here.
  const probeResults = useAtomValue(probeResultsAtom);
  const setRefreshRequest = useSetAtom(probeRefreshRequestAtom);
  const [selectedUrl, setSelectedUrl] = useState<string>(AUTO_URL);
  const [error, setError] = useState<string | null>(null);
  const [renderer, setRenderer] = useState<'webgl' | 'canvas'>('webgl');
  const [envFiles, setEnvFiles] = useState<EnvFileInfo[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<EnvFileRef[]>([]);

  const agentId = session?.agent_id ?? session?.session_id.split(':')[0] ?? null;
  const webglSupported = detectWebGLSupport();

  // Profile captured at open time, used to prefill mode/renderer/env/URL.
  // Both the env-list and the attach-info continuations consume it, in either
  // resolution order, so it is NOT cleared between them; the reset effect
  // re-assigns it on every open and attach-info fetches are cancelled-guarded,
  // so a stale profile can never prefill a later open.
  const prefillProfileRef = useRef<SessionAttachProfile | null>(null);

  // Reset per open, prefilling from the session profile when one exists (else
  // legacy global prefs). Only explicit confirms create profiles, so a missing
  // profile keeps the classic first-attach experience.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    prefillOnOpen({
      session,
      webglSupported,
      prefillProfileRef,
      setMode,
      setRenderer,
      setAttachInfo,
      setSelectedUrl,
      setSelectedEnv,
      setError,
      setEnvFiles,
    });
  }, [isOpen, webglSupported, session, setAttachInfo]);

  // Manual relay URL override — only relevant in relay mode.
  const relayUrl = useMemo(
    () => (mode === 'relay' && selectedUrl !== AUTO_URL ? selectedUrl : undefined),
    [mode, selectedUrl],
  );

  // Track previous requested mode so we only clear attachInfo when switching
  // modes (e.g. Auto → Relay), not when re-selecting an address in the list.
  const prevRequestedMode = useRef<string | null>(null);

  // Fetch attach info for the connection token + candidate list. Cancels the
  // previous in-flight fetch on mode/session change.
  useEffect(() => {
    if (!isOpen || !session) {
      return;
    }
    return fetchAttachInfo({
      session,
      mode,
      relayUrl,
      prefillProfileRef,
      prevRequestedMode,
      setAttachInfo,
      setSelectedUrl,
      setError,
    });
  }, [isOpen, session, mode, relayUrl, setAttachInfo]);

  const cached = agentId ? probeResults.get(agentId) : undefined;
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
              onRetest={mode !== 'relay' && agentId
                ? () => setRefreshRequest({ agentId, nonce: Date.now() })
                : undefined}
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
            {intent === 'configure' ? 'Save' : 'Attach'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** State setters written by the open-prefill and attach-info routines. */
interface DialogStateSetters {
  setMode: Dispatch<SetStateAction<AttachMode>>;
  setRenderer: Dispatch<SetStateAction<'webgl' | 'canvas'>>;
  setAttachInfo: Dispatch<SetStateAction<AttachInfo | null>>;
  setSelectedUrl: Dispatch<SetStateAction<string>>;
  setSelectedEnv: Dispatch<SetStateAction<EnvFileRef[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setEnvFiles: Dispatch<SetStateAction<EnvFileInfo[]>>;
}

interface OpenPrefillOptions extends DialogStateSetters {
  session: Session | null;
  webglSupported: boolean;
  /** Profile captured at open time; re-assigned by every open. */
  prefillProfileRef: MutableRefObject<SessionAttachProfile | null>;
}

/**
 * Reset dialog state for a fresh open: prefill mode (relay kept as-is) and
 * renderer (webgl → canvas fallback) from the session profile when one
 * exists, else from the legacy global prefs (relay prefs still map to Auto —
 * the classic first-attach experience). The env file list loads async, so the
 * profile's env selection is restored once it arrives, filtered to files that
 * still exist.
 */
function prefillOnOpen(options: OpenPrefillOptions): void {
  const {
    session,
    webglSupported,
    prefillProfileRef,
    setMode,
    setRenderer,
    setAttachInfo,
    setSelectedUrl,
    setSelectedEnv,
    setError,
    setEnvFiles,
  } = options;
  prefillProfileRef.current = session ? loadSessionProfile(session) : null;
  const source = prefillProfileRef.current?.choice;
  const prefs = loadAttachPrefs();
  setMode(source ? source.mode : prefs.mode === 'relay' ? 'auto' : prefs.mode);
  setRenderer(
    source
      ? source.renderer === 'webgl' && !webglSupported
        ? 'canvas'
        : source.renderer
      : webglSupported
        ? prefs.renderer
        : 'canvas',
  );
  setAttachInfo(null);
  setSelectedUrl(AUTO_URL);
  setSelectedEnv([]);
  setError(null);
  envApi.listEnvFiles()
    .then((resp) => {
      setEnvFiles(resp.files);
      const prof = prefillProfileRef.current;
      if (prof) {
        setSelectedEnv(
          prof.choice.envRefs.filter((ref) =>
            resp.files.some(
              (f) =>
                f.name === ref.name &&
                f.source === ref.source &&
                (!ref.agent_id || f.agent_id === ref.agent_id),
            ),
          ),
        );
      }
    })
    .catch(() => {});
}

interface AttachFetchOptions {
  session: Session;
  mode: AttachMode;
  /** Manual relay endpoint override, or undefined for auto. */
  relayUrl: string | undefined;
  prefillProfileRef: MutableRefObject<SessionAttachProfile | null>;
  prevRequestedMode: MutableRefObject<string | null>;
  setAttachInfo: Dispatch<SetStateAction<AttachInfo | null>>;
  setSelectedUrl: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Fetch fresh attach info for the requested mode (connection token + candidate
 * list) and, once it lands, preselect the profile's saved manual path when
 * this open still offers it (functional updater keeps any path the user
 * already picked). Returns a cleanup that voids the in-flight fetch.
 */
function fetchAttachInfo(options: AttachFetchOptions): () => void {
  const {
    session,
    mode,
    relayUrl,
    prefillProfileRef,
    prevRequestedMode,
    setAttachInfo,
    setSelectedUrl,
    setError,
  } = options;
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
      const info = await sessionsApi.requestAttach(session.session_id, requestedMode, relayUrl);
      if (!cancelled) {
        setAttachInfo(info);
        const savedUrl = prefillProfileRef.current?.choice.selectedUrl;
        if (
          savedUrl !== undefined &&
          savedUrl !== null &&
          candidateUrlsOf(info).includes(savedUrl)
        ) {
          setSelectedUrl((current) => (current === AUTO_URL ? savedUrl : current));
        }
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
        <Wifi className="w-3.5 h-3.5 text-success shrink-0" />
      ) : (
        <WifiOff className="w-3.5 h-3.5 text-destructive shrink-0" />
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
          statusLabel === 'reachable' ? 'text-success' : 'text-destructive',
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
