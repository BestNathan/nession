import type { AttachInfo } from '@/types';

export type AddressPolicyAction =
  | { type: 'none' }
  | { type: 'next-candidate' }
  | { type: 'force-relay' }
  | { type: 'transport-exhausted'; manualRoute: boolean };

export interface AddressAttachPolicyConfig {
  attachInfo: AttachInfo | null;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  forcedRelay: boolean;
  /** Ordered candidate URLs, best-first — `useAddressPlan`'s value (#1430). */
  addressUrls: string[];
  addressIndex: number;
}

/**
 * Pure address rotation + relay fallback policy extracted from useP2PAttachTransport.
 */
export class AddressAttachPolicy {
  private addressIndex = 0;

  constructor(private config: AddressAttachPolicyConfig) {}

  get activeUrl(): string | null {
    const { attachInfo, forcedRelay, manualOverride, addressUrls } = this.config;
    const isP2P = attachInfo?.mode === 'p2p' && !forcedRelay;
    if (!isP2P) {
      return null;
    }
    if (manualOverride) {
      return manualOverride;
    }
    return addressUrls[this.addressIndex] ?? null;
  }

  get currentIndex(): number {
    return this.addressIndex;
  }

  get isP2P(): boolean {
    const { attachInfo, forcedRelay } = this.config;
    return attachInfo?.mode === 'p2p' && !forcedRelay;
  }

  /**
   * Whether the address was pinned by the user rather than chosen from a plan.
   *
   * This is the one route with no next candidate: `onCandidateDisconnected`
   * sends it straight to `transport-exhausted`, so a spent budget there is
   * terminal unless the transport keeps probing by itself (#1263).
   */
  get isManualRoute(): boolean {
    return this.config.manualOverride !== null;
  }

  update(config: Partial<AddressAttachPolicyConfig>): AddressPolicyAction {
    const previousUrls = this.config.addressUrls;
    const currentUrl = previousUrls[this.addressIndex] ?? null;
    this.config = { ...this.config, ...config };
    const nextUrls = this.config.addressUrls;
    // #4618 SC-04: a latency-only reorder or a membership change recomputes the
    // STANDBY plan, but never migrates the current selection while it is still a
    // member. The healthy/progressing socket keeps its candidate; only a removed
    // current address (or an explicit route intent, which calls resetIndex)
    // restarts from the best candidate. This is what stops latency jitter — and
    // a newly reachable sibling — from tearing down a healthy Relay or P2P route.
    if (currentUrl && nextUrls.includes(currentUrl)) {
      this.addressIndex = nextUrls.indexOf(currentUrl);
    } else {
      this.addressIndex = 0;
    }
    return { type: 'none' };
  }

  resetIndex(): void {
    this.addressIndex = 0;
  }

  onCandidateDisconnected(): AddressPolicyAction {
    const { attachInfo, manualOverride, addressUrls } = this.config;
    if (!attachInfo) {
      return { type: 'none' };
    }
    if (manualOverride) {
      return { type: 'transport-exhausted', manualRoute: true };
    }
    if (this.addressIndex + 1 < addressUrls.length) {
      this.addressIndex += 1;
      return { type: 'next-candidate' };
    }
    return { type: 'force-relay' };
  }

  maxReconnectAttempts(): number {
    const { attachInfo, manualOverride, orderedUrls, addressUrls } = this.config;
    if (manualOverride) {
      return 2;
    }
    const hasMoreCandidates = this.addressIndex + 1 < addressUrls.length;
    const singleLegacyFallback =
      addressUrls.length === 1
      && addressUrls[0] === attachInfo?.agent_address
      && (orderedUrls === null || orderedUrls.length === 0);
    if (hasMoreCandidates || singleLegacyFallback) {
      return 2;
    }
    return 10;
  }
}
