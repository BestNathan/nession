import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { useP2PAttachTransport } from '@/product/terminal/hooks/useP2PAttachTransport';
import { useWebSocket } from '@/shared/hooks/useWebSocket';
import { envApi } from '@/capabilities/env';
import type { TerminalAgentApi } from '@/product/terminal/agent';
import type { ConnectionState } from '@/platform/socket/types';
import {
  relayServerHandle,
  type RelayServerHandle,
} from '@/platform/attach/relayServerConnection';
import type { EnvFileRef } from '@/types';
import {
  attachInfoAtom,
  envRefsAtom,
  manualOverrideAtom,
  orderedUrlsAtom,
  sessionIdAtom,
  sessionNameAtom,
} from '@/product/session/state';
import { terminalServerApi } from '@/product/terminal';
import { useTerminal } from '@/product/terminal/hooks/useTerminal';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';
import { detectProfile, PROFILES } from '@/platform/terminal-runtime/DeviceProfile';
import type { TerminalStatus } from '@/product/terminal/state/session';
import {
  inputDropAtomFamily,
  type ReconnectBanner,
} from '@/product/terminal/state/ui';
import { useTerminalControlBridge } from '@/product/terminal/hooks/useTerminalControlBridge';
import { useTerminalActivation } from '@/product/terminal/hooks/useTerminalActivation';

function useSessionEnvSourcing(opts: {
  envRefs: EnvFileRef[];
  sessionId: string;
  effectiveMode: 'p2p' | 'relay';
  agentTerminalApi: TerminalAgentApi | null;
  connectionState: ConnectionState;
}) {
  const { envRefs, sessionId, effectiveMode, agentTerminalApi, connectionState } = opts;
  const envSourcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!envRefs || envRefs.length === 0 || envSourcedRef.current === sessionId) {
      return;
    }
    const apply = () => {
      if (envSourcedRef.current === sessionId) {
        return;
      }
      envSourcedRef.current = sessionId;
      for (const ref of envRefs) {
        void envApi.applySessionEnv(sessionId, [ref]).catch(() => {});
      }
    };
    if (effectiveMode === 'relay') {
      apply();
      return;
    }
    // P2P: env refs are applied once the agent transport is up (the socket
    // being open is the legacy waitForConnection().then(apply) edge).
    if (agentTerminalApi && connectionState === 'connected') {
      apply();
    }
  }, [envRefs, sessionId, effectiveMode, agentTerminalApi, connectionState]);
}

/**
 * Adopt the live Session's authoritative width when the Agent states it on an
 * attach reply (#2487). A hook of its own so the composition's line budget is
 * about composition; the subscription's lifetime is the runtime/controller
 * pair, exactly as it would be inline.
 */
function useSessionTerminalCols(
  runtime: SessionRuntime | null,
  controller: TerminalController | null,
): void {
  useEffect(() => {
    if (!runtime || !controller) { return; }
    return runtime.subscribeRuntimeEvents((event) => {
      if (event.type === 'session-terminal-cols') {
        controller.adoptSessionCols(event.cols);
      }
    });
  }, [runtime, controller]);
}

function useReconnectBanner(opts: {
  sessionId: string;
  terminalState: TerminalStatus;
  effectiveMode: 'p2p' | 'relay';
  serverConnection: RelayServerHandle;
}): ReconnectBanner {
  const { sessionId, terminalState, effectiveMode, serverConnection } = opts;
  const [relayLost, setRelayLost] = useState(false);

  useEffect(() => {
    setRelayLost(false);
  }, [sessionId, effectiveMode]);

  useEffect(() => {
    if (effectiveMode !== 'relay' || !serverConnection) { return; }
    // UI-only bookkeeping: attach phase transitions are driven by the
    // SessionRuntime relay handler and mirrored through runtime events.
    // Only the durable edges touch relayLost — intra-budget loss shows as
    // 'reconnecting' via the runtime phase mirror (old facade collapsed it
    // onto 'connecting', which this hook ignored too).
    return serverConnection.onConnectionStateChange((state) => {
      if (state === 'connected') {
        setRelayLost(false);
      } else if (state === 'disconnected') {
        setRelayLost(true);
      }
    });
  }, [effectiveMode, serverConnection]);

  // Derived per render, never stored (#1309 SC-02): the banner atoms this used
  // to feed had exactly one reader — a view-model atom with no readers of its
  // own. The only live consumer is `inputDisabled` below.
  return terminalState === 'reconnecting'
    ? 'reconnecting'
    : terminalState === 'failed' || relayLost
      ? 'failed'
      : 'none';
}

export interface UseTerminalOrchestrationOptions {
  onError: (error: Error) => void;
  rendererType?: 'webgl' | 'canvas';
  scrollbackMode?: 'legacy' | 'local-buffer';
  /**
   * Whether the Terminal surface is the foreground surface for the selected
   * session. Hidden surfaces stay attached; only a foreground one may take the
   * ControlLease automatically (#2286).
   */
  foreground?: boolean;
}

export function useTerminalOrchestration({
  onError,
  rendererType = 'canvas',
  scrollbackMode = 'local-buffer',
  foreground = true,
}: UseTerminalOrchestrationOptions) {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [envRefs] = useAtom(envRefsAtom);

  const wsService = useWebSocket();
  // One relay handle per service instance, shared by every relay consumer —
  // the runtime (begin/endRelay + state), the transport factory (relay I/O),
  // and the banner. Rebuilt only when the service does.
  const relayServer = useMemo(() => relayServerHandle(wsService, terminalServerApi), [wsService]);
  // The bootstrap question (#321) is answered by the live Terminal, which does
  // not exist yet at this point in the hook — so the runtime is handed a reader
  // over a ref that the controller assignment below fills in. Reading through a
  // ref is what makes the answer current at *attach* time rather than at the
  // time this closure was built, and the controller outlives every runtime
  // rewire, so there is exactly one authority for it.
  const controllerRef = useRef<TerminalController | null>(null);
  const hasSessionOutput = useCallback(
    () => controllerRef.current?.hasSessionOutput ?? false,
    [],
  );
  // The narrower question the attach must ask (#2194): a replacement renderer
  // holds live output as soon as a transport is bound, but holds no history
  // until a capture parses into it. Reading it through the same ref keeps the
  // answer about the renderer that is mounted now.
  const hasSessionHistory = useCallback(
    () => controllerRef.current?.hasParsedCapture ?? false,
    [],
  );
  const { agentTerminalApi, connectionState, runtime, snapshot, fileOps } = useP2PAttachTransport({
    attachInfo,
    sessionName,
    orderedUrls,
    manualOverride,
    serverConnection: relayServer,
    hasSessionOutput,
    hasSessionHistory,
  });

  // The effective transport mode, derived — never stored (#1309 SC-02): the
  // static intent comes from the attach choice, and a runtime that fell back
  // to relay says so on its own snapshot. The lease follows the same route
  // (#2157): the direct Agent API on P2P, the Server relay plugin on Relay.
  const effectiveMode: 'p2p' | 'relay' =
    (snapshot?.forcedRelay ?? false) || attachInfo?.mode !== 'p2p' ? 'relay' : 'p2p';
  const controlSource = agentTerminalApi
    ?? (effectiveMode === 'relay' ? terminalServerApi : null);
  const { control: terminalControl, takeControl, adoptControl } = useTerminalControlBridge(
    sessionName,
    controlSource,
  );

  // The runtime snapshot is the only attach-phase source: the runtime selects
  // its session at construction and drives every transition itself (#1309
  // SC-01) — there is no React mirror to fall back to. No runtime yet (no
  // session, or the address plan is still resolving) means nothing is
  // attaching: idle, zero attempts.
  const terminalState = snapshot?.phase ?? 'idle';
  const reconnectCount = snapshot?.reconnectCount ?? 0;

  useSessionEnvSourcing({ envRefs, sessionId, effectiveMode, agentTerminalApi, connectionState });
  const [inputDrop, setInputDrop] = useAtom(inputDropAtomFamily(sessionId));
  const [deviceProfile] = useState(() => detectProfile(window.innerWidth));
  const controller = useTerminal({
    sessionId,
    sessionName,
    mode: effectiveMode,
    // Canvas avoids WebGL context exhaustion when the viewport remounts during
    // address-plan resolution / StrictMode — lost GL contexts render blank.
    rendererType,
    // The profile seeds the initial type size and owns leading and scrollback.
    // The first two resolve from the Experience tokens rather than being
    // authored here (terminal-surface.md §Resize and typography). Since #2592
    // the font size is only the initial render: the measured fixed-column fit
    // derives the final size from width and columns, with no App minimum.
    fontSize: PROFILES[deviceProfile].fontSize,
    lineHeight: PROFILES[deviceProfile].lineHeight,
    scrollback: PROFILES[deviceProfile].scrollback,
    deviceProfile,
    scrollbackMode,
    terminalCols: attachInfo?.terminal_cols,
    runtime,
  });
  // Filled here rather than in an effect: `useTerminal` memoizes the
  // controller, so this is the same instance every render, and an effect would
  // leave the reader answering `false` for the whole first commit — including
  // the viewport's layout-effect attach, which is what starts the first
  // `client.attach` this flag is read by.
  controllerRef.current = controller;

  // The Agent's attach reply states the live Session's authoritative width
  // (#2487); the Server's value above is the new-Session policy.
  useSessionTerminalCols(runtime, controller);

  // Automatic takeover on meaningful foreground activation (#2286). The hook
  // owns the triggers that are not a DOM gesture (open/attach, surface return,
  // window focus, visibility); the composition adds the terminal-surface
  // gesture. Adopting the lease is also what makes this client state its own
  // measured viewport: the pane follows the active device, not the last packet.
  const adoptViewport = useCallback(() => {
    controllerRef.current?.adoptControl();
  }, []);
  const { onTerminalGesture } = useTerminalActivation({
    sessionName,
    foreground,
    attached: terminalState === 'attached',
    adoptControl,
    onAdopted: adoptViewport,
  });
  // The retained manual fallback is a takeover too: it must state this
  // client's measured viewport rather than leave the pane at the previous
  // controller's size (#2286).
  const takeControlAndAdopt = useCallback(async () => {
    if (await takeControl()) {
      adoptViewport();
    }
  }, [takeControl, adoptViewport]);

  const banner = useReconnectBanner({
    sessionId, terminalState, effectiveMode, serverConnection: relayServer,
  });
  // The Agent enforces the lease on every route; the UI must tell the same
  // truth on every route (#2157).
  const observerReadOnly = terminalControl.role === 'observer';
  // A manual route is being switched while its transport is not yet connected
  // (#1309 SC-02 — read from the runtime's live connection state instead of
  // the deleted p2pStateAtom mirror; a failed session never counts as
  // switching, matching the old atom's guard).
  const isSwitching =
    terminalState !== 'failed' && manualOverride !== null && connectionState !== 'connected';
  const inputDisabled = banner !== 'none' || isSwitching || observerReadOnly;
  const modeGateOk = !(effectiveMode === 'p2p' && !agentTerminalApi);
  // #1430: the address plan resolves synchronously, so there is no
  // "waiting for the plan" state left to gate the viewport on.
  const viewportReady = modeGateOk;

  useEffect(() => {
    if (!controller) { return; }
    controller.onError = onError;
  }, [controller, onError]);

  useEffect(() => {
    if (!controller) {
      return;
    }
    // ControlLease, not ResizeObserver, owns the shared pane dimensions.
    // A displaced client must follow Agent/tmux resize notifications rather
    // than its own passive browser layout until foreground takeover (#2286).
    controller.setObserverReadOnly(terminalControl.role === 'observer');
    const remoteEnabled = !(effectiveMode === 'p2p' && terminalControl.role === 'observer');
    controller.setRemoteInputEnabled(remoteEnabled);
  }, [controller, effectiveMode, terminalControl.role]);

  return {
    sessionId,
    controller,
    isSwitching,
    viewportReady,
    inputDisabled,
    terminalState,
    reconnectCount,
    /** Observed output loss, for the surface's quiet notice (#2155). */
    historyDegraded: snapshot?.historyDegraded ?? false,
    streamState: snapshot?.streamState ?? 'unavailable',
    fileOps,
    terminalControl,
    onTakeControl: takeControlAndAdopt,
    /** A real pointer/key gesture on the terminal surface (auto takeover). */
    onTerminalGesture,
    /**
     * Input this Session lost, for the surface to state (#1307 SC-09), and how
     * to put it away. The dismissal is the whole action: the bytes are already
     * gone and the client deliberately did not keep them, so there is nothing
     * to offer but the user's own decision about what to type next.
     */
    inputDrop,
    dismissInputDrop: () => setInputDrop(null),
  };
}
