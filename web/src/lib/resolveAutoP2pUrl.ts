import type { AttachInfo } from '../types';

/** First P2P URL Auto mode would pick — mirrors activeUrlAtom / useAddressPlan sync path. */
export function resolveAutoP2pUrl(
  orderedUrls: string[],
  probeOrderedUrls: string[],
  attachInfo: AttachInfo | null,
): string | null {
  if (orderedUrls.length > 0) {
    return orderedUrls[0];
  }
  if (probeOrderedUrls.length > 0) {
    return probeOrderedUrls[0];
  }
  if (!attachInfo || attachInfo.mode !== 'p2p') {
    return null;
  }
  if (attachInfo.agent_address) {
    return attachInfo.agent_address;
  }
  const candidates = attachInfo.addresses ?? [];
  if (candidates.length > 0) {
    return candidates[0].url;
  }
  return null;
}
