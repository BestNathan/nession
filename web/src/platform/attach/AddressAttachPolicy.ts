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
  private planUrlsKey = '';

  constructor(private config: AddressAttachPolicyConfig) {
    this.planUrlsKey = config.addressUrls.join(',');
  }

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
    const prevKey = this.planUrlsKey;
    this.config = { ...this.config, ...config };
    const nextKey = this.config.addressUrls.join(',');
    if (nextKey !== prevKey) {
      this.planUrlsKey = nextKey;
      this.addressIndex = 0;
      return { type: 'none' };
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
