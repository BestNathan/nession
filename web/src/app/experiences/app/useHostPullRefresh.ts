import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  PULL_RESISTANCE,
  RELEASE_THRESHOLD_PX,
  createPullContact,
  movePullContact,
  releasePullContact,
  type PullContact,
  type PullSurface,
} from './pullRefreshGesture';

export type HostPullPhase = 'idle' | 'pulling' | 'ready' | 'busy';

export interface HostPullRefreshOptions {
  surface: PullSurface;
  /** The surface is the visible, connected list the user is holding. */
  enabled: boolean;
  /** A read is already in flight; the indicator reports it, the gesture waits. */
  refreshing: boolean;
  onRefresh: () => void;
}

export interface HostPullRefresh {
  hostRef: RefObject<HTMLDivElement | null>;
  /** Resisted indicator travel in CSS px. */
  distance: number;
  phase: HostPullPhase;
}

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

/**
 * Binds the host pull accelerator to one App scroll region (#4602 §4).
 *
 * The host owns the indicator, the release decision and the cancellation; a
 * capability contributes only its refresh callback and state. The gesture never
 * creates a second scroll container or page header, and it surrenders every
 * contact that belongs to the horizontal pager, a nested scroller, the Terminal
 * or an editor.
 *
 * The contact decisions live in `pullRefreshGesture.ts`, settled by the
 * published prototype before this port.
 */
export function useHostPullRefresh(options: HostPullRefreshOptions): HostPullRefresh {
  const { surface, enabled, refreshing, onRefresh } = options;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [distance, setDistance] = useState(0);
  const [pulling, setPulling] = useState(false);

  const contactRef = useRef<PullContact | null>(null);
  const pointerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) { return; }

    const primaryViewport = () => host.querySelector(VIEWPORT_SELECTOR);

    const onDown = (event: PointerEvent) => {
      if (!enabledRef.current || contactRef.current) { return; }
      const target = event.target as Element | null;
      const targetViewport = target?.closest?.(VIEWPORT_SELECTOR) ?? null;
      const primary = primaryViewport();
      // A nested collection scroller owns its own contact.
      const nested = targetViewport !== null && targetViewport !== primary;
      const atTop = primary ? primary.scrollTop <= 0 : false;
      contactRef.current = createPullContact({
        surface: nested ? 'nested' : surfaceRef.current,
        atTop,
      });
      pointerRef.current = event.pointerId;
      startRef.current = { x: event.clientX, y: event.clientY };
    };

    const onMove = (event: PointerEvent) => {
      const contact = contactRef.current;
      const start = startRef.current;
      if (!contact || !start || event.pointerId !== pointerRef.current) { return; }
      const result = movePullContact(
        contact,
        event.clientX - start.x,
        event.clientY - start.y,
      );
      if (result.action === 'pull') {
        // Only an accepted pull prevents the browser's own overscroll.
        event.preventDefault();
        setDistance(result.distance);
        setPulling(true);
      } else if (result.action !== 'pending') {
        setDistance(0);
        setPulling(false);
      }
    };

    const onUp = (event: PointerEvent) => {
      const contact = contactRef.current;
      if (!contact || event.pointerId !== pointerRef.current) { return; }
      const outcome = releasePullContact(contact);
      contactRef.current = null;
      pointerRef.current = null;
      startRef.current = null;
      setDistance(0);
      setPulling(false);
      if (outcome === 'commit') { refreshRef.current(); }
    };

    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove, { passive: false });
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onUp);
    host.addEventListener('pointerleave', onUp);
    return () => {
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      host.removeEventListener('pointerleave', onUp);
      contactRef.current = null;
      pointerRef.current = null;
      startRef.current = null;
    };
  }, []);

  // A page switch or an unmount mid-contact must not leave a held indicator.
  useEffect(() => {
    if (!enabled) {
      contactRef.current = null;
      setDistance(0);
      setPulling(false);
    }
  }, [enabled]);

  const phase: HostPullPhase = refreshing
    ? 'busy'
    : pulling
      ? (distance >= RELEASE_THRESHOLD_PX * PULL_RESISTANCE ? 'ready' : 'pulling')
      : 'idle';

  return { hostRef, distance, phase };
}
