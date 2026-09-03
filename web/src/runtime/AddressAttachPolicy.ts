import type { AttachInfo } from '@/types';
import type { AddressPlan } from '@/hooks/useAddressPlan';

export type AddressPolicyAction =
  | { type: 'none' }
  | { type: 'next-candidate' }
  | { type: 'force-relay' };

export interface AddressAttachPolicyConfig {
  attachInfo: AttachInfo | null;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  forcedRelay: boolean;
  addressPlan: AddressPlan;
  addressIndex: number;
}

/**
 * Pure address rotation + relay fallback policy extracted from useP2PAttachTransport.
 */
export class AddressAttachPolicy {
  private addressIndex = 0;
  private planUrlsKey = '';

  constructor(private config: AddressAttachPolicyConfig) {
    this.planUrlsKey = config.addressPlan.urls.join(',');
  }

  get activeUrl(): string | null {
    const { attachInfo, forcedRelay, manualOverride, addressPlan } = this.config;
    const isP2P = attachInfo?.mode === 'p2p' && !forcedRelay;
    if (!isP2P || !addressPlan.ready) {
      return null;
    }
    if (manualOverride) {
      return manualOverride;
    }
    return addressPlan.urls[this.addressIndex] ?? null;
  }

  get currentIndex(): number {
    return this.addressIndex;
  }

  get isP2P(): boolean {
    const { attachInfo, forcedRelay } = this.config;
    return attachInfo?.mode === 'p2p' && !forcedRelay;
  }

  update(config: Partial<AddressAttachPolicyConfig>): AddressPolicyAction {
    const prevKey = this.planUrlsKey;
    this.config = { ...this.config, ...config };
    const nextKey = this.config.addressPlan.urls.join(',');
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
    const { attachInfo, manualOverride, addressPlan } = this.config;
    if (!attachInfo || manualOverride) {
      return { type: 'none' };
    }
    if (this.addressIndex + 1 < addressPlan.urls.length) {
      this.addressIndex += 1;
      return { type: 'next-candidate' };
    }
    return { type: 'force-relay' };
  }

  maxReconnectAttempts(): number {
    const { attachInfo, manualOverride, orderedUrls, addressPlan } = this.config;
    if (manualOverride) {
      return 2;
    }
    const hasMoreCandidates = this.addressIndex + 1 < addressPlan.urls.length;
    const singleLegacyFallback =
      addressPlan.urls.length === 1
      && addressPlan.urls[0] === attachInfo?.agent_address
      && (orderedUrls === null || orderedUrls.length === 0);
    if (hasMoreCandidates || singleLegacyFallback) {
      return 2;
    }
    return 10;
  }
}
