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
import { Wifi, WifiOff, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { AttachInfo, AttachMode, AddressLatency, ProbedAddress, Session, EnvFileInfo, EnvFileRef } from '@/types';
import type { AgentProbe } from '@/product/agent/state';
import { EnvFileMultiSelect, envApi } from '@/capabilities/env';
import { sessionsApi } from '@/product/session';
import { loadAttachPrefs } from '@/platform/attach/attachPrefs';
import {
  candidateUrlsOf,
  loadSessionProfile,
  type SessionAttachProfile,
} from '@/platform/attach/sessionAttachProfile';
import { detectWebGLSupport } from '@/platform/terminal-runtime/Renderer';
import { useAgentProbe } from '@/product/agent/hooks/useAgentProbe';

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

/** What the path list renders, derived from the probe's answer. */
interface CandidateDisplay {
  results: AddressLatency[];
  orderedUrls: string[];
  latencyByUrl: Map<string, number | null>;
  /** Best URL measured *reachable*, or null when nothing was. */
  bestUrl: string | null;
  /** True once every candidate has a result — a total failure included. */
  measured: boolean;
}

/**
 * `bestUrl` is the best URL measured *reachable*, which `orderedUrls[0]` is not:
 * `orderByLatency` deliberately appends handshake-failed addresses rather than
 * dropping them, so when every candidate fails, index 0 is a failure. Reading
 * that as "the best path" is how a total failure came to be labelled "fastest
 * reachable path". `measured` is what distinguishes it from "nobody has looked".
 */
// Shared empty values, so a dialog with no probe hands out the *same* arrays
// every render. `results` and `orderedUrls` are dependencies of the confirm
// callback, and a fresh `[]` per render would rebuild that callback per render —
// which the lint rule catches as a genuine churn source, not a style nit.
const NO_LATENCIES: AddressLatency[] = [];
const NO_URLS: string[] = [];

function candidateDisplay(probe: AgentProbe | null, candidates: ProbedAddress[]): CandidateDisplay {
  const results = probe?.latencies ?? NO_LATENCIES;
  const orderedUrls = probe?.orderedUrls ?? NO_URLS;
  const latencyByUrl = new Map(results.map((r) => [r.url, r.latencyMs]));
  return {
    results,
    orderedUrls,
    latencyByUrl,
    measured: candidates.some((c) => latencyByUrl.has(c.url)),
    bestUrl: orderedUrls.find((url) => typeof latencyByUrl.get(url) === 'number') ?? null,
  };
}

/**
 * Attach dialog: pick connection mode and (for P2P) a candidate address.
 *
 * ## Why the measurement happens here (#1091)
 *
 * It used to be read from an app-level atom filled by a five-minute poll, so the
 * dialog never blocked on probing. That poll probed the *registry's* URLs, and
 * since #1013 the agent refuses an uncredentialed upgrade — so it had been
 * failing for every agent, and every address rendered as unreachable.
 *
 * A credential exists only after `requestAttach`, and this component is where
 * that reply lands. So the measurement moved to the one place that can hold a
 * credential, which is also the place the measurement is about: the reply's own
 * `addresses`. "Re-test" re-requests attach info rather than re-probing with the
 * token in hand — that token expires (`p2p_token_expiry_secs`, 300s by default),
 * and re-probing with a dead one would report a healthy network as unreachable.
 */
export function AttachDialog({ isOpen, intent = 'attach', onClose, session, onConfirm }: AttachDialogProps) {
  const [mode, setMode] = useState<AttachMode>('auto');
  // Attach info fetched for P2P so we get the connection token + candidate list.
  // Local state (not attachInfoAtom): this is dialog scratch space for the
  // session being PREVIEWED. attachInfoAtom holds the currently-ATTACHED
  // session and is only written by attachToSessionAtom on confirm. Writing it
  // here would tear down the live terminal the moment the dialog opens.
  const [attachInfo, setAttachInfo] = useState<AttachInfo | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string>(AUTO_URL);
  // Bumped by "Re-test" to re-request attach info, and with it a fresh
  // credential — which is what makes the probe below measure again.
  const [refreshNonce, setRefreshNonce] = useState(0);
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
  // True once the user picked ANY path row this open (including the explicit
  // Auto row, which also stores AUTO_URL) — the manual-url preselect must
  // never override that pick. Reset by the reset-per-open effect.
  const userPickedRef = useRef(false);

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
      userPickedRef,
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
      userPickedRef,
      prevRequestedMode,
      setAttachInfo,
      setSelectedUrl,
      setError,
    });
  }, [isOpen, session, mode, relayUrl, refreshNonce, setAttachInfo]);

  const candidates = attachInfo?.addresses ?? [];
  // P2P only. A relay reply carries no credential, and a probe without one can
  // only report every address unreachable — a statement about the probe.
  const isP2p = attachInfo?.mode === 'p2p';
  const { probe, probing } = useAgentProbe({
    agentId: isP2p ? agentId : null,
    addresses: isP2p ? candidates : [],
    credential: attachInfo?.connection_token,
    reprobeKey: refreshNonce,
  });

  const { results, orderedUrls, latencyByUrl, bestUrl, measured } = candidateDisplay(probe, candidates);

  const handleConfirm = useCallback(() => {
    if (!session || !attachInfo) {
      return;
    }
    const manual = selectedUrl === AUTO_URL ? null : selectedUrl;
    const relayUrl = mode === 'relay' ? manual : null;
    onConfirm(session, { mode, attachInfo, orderedUrls, latencies: results, selectedUrl: manual, relayUrl, renderer, envRefs: selectedEnv });
  }, [session, attachInfo, selectedUrl, orderedUrls, results, mode, renderer, onConfirm, selectedEnv]);

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
              measured={isP2p && measured}
              probing={isP2p && probing}
              selectedUrl={selectedUrl}
              onSelect={(url) => {
                // Any row click — including the explicit Auto row — is a user
                // pick that the profile preselect must never override.
                userPickedRef.current = true;
                setSelectedUrl(url);
              }}
              // Re-requests attach info for a fresh credential; the probe then
              // re-measures because the credential it keys on changed.
              onRetest={isP2p ? () => setRefreshNonce((n) => n + 1) : undefined}
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
  /** Cleared on every open so a pick in a previous open never counts. */
  userPickedRef: MutableRefObject<boolean>;
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
    userPickedRef,
    setMode,
    setRenderer,
    setAttachInfo,
    setSelectedUrl,
    setSelectedEnv,
    setError,
    setEnvFiles,
  } = options;
  prefillProfileRef.current = session ? loadSessionProfile(session) : null;
  userPickedRef.current = false;
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
  /** Set once the user clicked ANY path row this open (incl. the Auto row). */
  userPickedRef: MutableRefObject<boolean>;
  prevRequestedMode: MutableRefObject<string | null>;
  setAttachInfo: Dispatch<SetStateAction<AttachInfo | null>>;
  setSelectedUrl: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Fetch fresh attach info for the requested mode (connection token + candidate
 * list) and, once it lands, preselect the profile's saved manual path — but
 * only while the user has NOT picked any path row this open. An explicit Auto
 * row click also stores AUTO_URL, so selectedUrl alone cannot distinguish
 * "no pick" from "picked Auto"; the ref is the source of truth. Every arrival
 * re-checks it, so a pick made while a fetch was in flight is never
 * overridden. Returns a cleanup that voids the in-flight fetch.
 */
function fetchAttachInfo(options: AttachFetchOptions): () => void {
  const {
    session,
    mode,
    relayUrl,
    prefillProfileRef,
    userPickedRef,
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
        // Without a user pick, the current value is either AUTO_URL or a value
        // this same code auto-set — a direct set cannot override a choice.
        const savedUrl = prefillProfileRef.current?.choice.selectedUrl;
        if (
          !userPickedRef.current &&
          savedUrl !== undefined &&
          savedUrl !== null &&
          candidateUrlsOf(info).includes(savedUrl)
        ) {
          setSelectedUrl(savedUrl);
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
  /** Best URL measured *reachable*, or null when nothing was. */
  bestUrl: string | null;
  /** True once every candidate has a result — a total failure included. */
  measured: boolean;
  /** True while a measurement is in flight. */
  probing: boolean;
  selectedUrl: string;
  onSelect: (url: string) => void;
  /** Re-request attach info so the addresses are measured again. */
  onRetest?: () => void;
  /** When true, use server probe data (rtt_ms, Reachable/Unreachable) labels. */
  isRelay?: boolean;
}

/** The "Connection Path" section: Auto row + one row per candidate address. */
function PathList({ candidates, latencyByUrl, bestUrl, measured, probing, selectedUrl, onSelect, onRetest, isRelay }: PathListProps) {
  const bestLatency = bestUrl !== null ? latencyByUrl.get(bestUrl) : null;
  /**
   * Four states, not two, and the difference is the point: "measuring",
   * "measured — nothing reachable", "measured — this is the fastest", and
   * "not measured". Collapsing the last two into "no best URL" is what made a
   * total failure read as "browser will decide", i.e. as if nothing had been
   * tried.
   */
  const autoSublabel = isRelay
    ? 'server auto-selects (Reachable > Unknown > Unreachable)'
    : probing
      ? 'measuring from this browser…'
      : bestUrl !== null
        ? `fastest reachable path · ${bestLatency}ms`
        : measured
          ? 'nothing answered from this browser · relay fallback'
          : 'not measured yet';

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
          // Three states in both modes, because "we have no verdict" is not the
          // same claim as "this failed", and only the first is true when nobody
          // has looked. Relay mode's `unknown` is the server saying it has not
          // probed this address — it was drawn as a red failure.
          const reachable: boolean | undefined = isRelay
            ? addr.status === 'reachable'
              ? true
              : addr.status === 'unreachable'
                ? false
                : undefined
            : latencyByUrl.has(addr.url)
              ? latency !== null
              : undefined;
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
              isCandidate
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
  /** undefined = nobody measured this address; true/false = reachability. */
  reachable?: boolean;
  /**
   * Whether this row stands for a candidate address.
   *
   * The Auto row does not — it names the policy, not a host — so it must not
   * carry a reachability affordance at all. `reachable === undefined` already
   * means "not applicable" there, and drawing the unmeasured state for it would
   * both assert something untrue and put its `sr-only` text into the row's
   * accessible name (which is matched by name in the tests).
   */
  isCandidate?: boolean;
  latencyMs?: number;
  /** Server probe status label (relay mode). */
  statusLabel?: string;
}

function AddressRow({ label, badge, sublabel, selected, onSelect, reachable, isCandidate, latencyMs, statusLabel }: AddressRowProps) {
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
        // On a candidate, drawn rather than left blank: an empty slot reads as a
        // rendering gap, while a quiet icon reads as "no verdict", which is what
        // it is. `aria-hidden` with an `sr-only` twin keeps the state out of the
        // row's accessible name while still reaching a screen reader.
        isCandidate ? (
          <>
            <WifiOff className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" aria-hidden />
            <span className="sr-only">not measured</span>
          </>
        ) : (
          <span className="w-3.5 shrink-0" />
        )
      ) : reachable ? (
        <Wifi className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
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
          // Only a measured failure is destructive. The server reporting that it
          // has not probed an address is not a failure, and colouring it like one
          // is the same defect as drawing it with the offline icon.
          statusLabel === 'unreachable' ? 'text-destructive' : 'text-muted-foreground',
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
