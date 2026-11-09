import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type {
  AddressLatency,
  AttachInfo,
  AttachMode,
  ProbedAddress,
  Session,
} from '@/types';
import type { AgentProbe } from '@/product/agent/state';
import { sessionsApi } from '@/product/session';
import { loadAttachPrefs } from '@/platform/attach/attachPrefs';
import {
  candidateUrlsOf,
  loadSessionProfile,
  type SessionAttachProfile,
} from '@/platform/attach/sessionAttachProfile';
import { detectWebGLSupport } from '@/platform/terminal-runtime/webglSupport';
import { useAgentProbe } from '@/product/agent/hooks/useAgentProbe';

/** Result handed back to the flow once the user confirms an attach. */
export interface AttachChoice {
  /** The mode the user picked ('auto' | 'p2p' | 'relay'). */
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
}

export const AUTO_URL = '__auto__';

/** What the path list renders, derived from the probe's answer. */
export interface CandidateDisplay {
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
 * The Attach selection/probing/confirmation owner (#3089).
 *
 * Both experiences render this one owner; only their presentation differs.
 * The measurement happens here for #1091's reason: a credential exists only
 * after `requestAttach`, and this is where that reply lands. "Re-test"
 * re-requests attach info rather than re-probing with a token that expires.
 *
 * `attachInfo` is local (not `attachInfoAtom`): it is scratch space for the
 * Session being PREVIEWED. `attachInfoAtom` holds the currently-ATTACHED
 * Session and is written only by `attachToSessionAtom` on confirm; writing it
 * here would tear down the live terminal the moment the surface opens.
 */
export function useAttachConfiguration({
  isOpen,
  session,
}: {
  isOpen: boolean;
  session: Session | null;
}) {
  const [mode, setMode] = useState<AttachMode>('auto');
  const [attachInfo, setAttachInfo] = useState<AttachInfo | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string>(AUTO_URL);
  // Bumped by "Re-test" to re-request attach info, and with it a fresh
  // credential — which is what makes the probe below measure again.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [renderer, setRenderer] = useState<'webgl' | 'canvas'>('webgl');

  const agentId = session?.agent_id ?? session?.session_id.split(':')[0] ?? null;
  const webglSupported = detectWebGLSupport();

  // Profile captured at open time, used to prefill mode/renderer/URL. The
  // reset effect re-assigns it on every open and attach-info fetches are
  // cancelled-guarded, so a stale profile can never prefill a later open.
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
      setError,
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

  const display = candidateDisplay(probe, candidates);

  const selectUrl = useCallback((url: string) => {
    // Any row click — including the explicit Auto row — is a user pick that
    // the profile preselect must never override.
    userPickedRef.current = true;
    setSelectedUrl(url);
  }, []);

  const retest = useCallback(() => setRefreshNonce((n) => n + 1), []);

  const buildChoice = useCallback((): AttachChoice | null => {
    if (!session || !attachInfo) {
      return null;
    }
    const manual = selectedUrl === AUTO_URL ? null : selectedUrl;
    const selectedRelayUrl = mode === 'relay' ? manual : null;
    return {
      mode,
      attachInfo,
      orderedUrls: display.orderedUrls,
      latencies: display.results,
      selectedUrl: manual,
      relayUrl: selectedRelayUrl,
      renderer,
    };
  }, [session, attachInfo, selectedUrl, display, mode, renderer]);

  return {
    mode,
    setMode,
    attachInfo,
    selectedUrl,
    selectUrl,
    retest,
    error,
    renderer,
    setRenderer,
    webglSupported,
    candidates,
    ...display,
    isP2p,
    probing,
    buildChoice,
  };
}

/** State setters written by the open-prefill and attach-info routines. */
interface DialogStateSetters {
  setMode: Dispatch<SetStateAction<AttachMode>>;
  setRenderer: Dispatch<SetStateAction<'webgl' | 'canvas'>>;
  setAttachInfo: Dispatch<SetStateAction<AttachInfo | null>>;
  setSelectedUrl: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string | null>>;
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
 * the classic first-attach experience).
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
    setError,
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
  setError(null);
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
  // Otherwise the path list disappears while the re-fetch is in flight.
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

/** User-facing label for the mode the surface will confirm. */
export function attachModeLabel(mode: AttachMode): string {
  return mode === 'auto'
    ? 'Automatic connection'
    : mode === 'p2p'
      ? 'Direct P2P connection'
      : 'Relay connection';
}

/** The one-line description of what the current mode will do. */
export function attachModeHint(mode: AttachMode): string {
  return mode === 'auto'
    ? 'Choose the fastest reachable path; fall back to Relay.'
    : mode === 'p2p'
      ? 'Connect directly to the selected Agent.'
      : 'Route traffic through the Server relay.';
}
