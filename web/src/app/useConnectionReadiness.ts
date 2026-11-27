import { useEffect, useState } from 'react';
import type { WebSocketService } from '@/platform/socket';

export interface ConnectionReadiness {
  /** The transport finished its handshake. 'connected' IS post-auth. */
  connected: boolean;
  /** Physical socket identity; changes when a transport is replaced. */
  generation: number;
}

/**
 * Reactive readiness of the one Server transport (#4602).
 *
 * A pull controller needs both facts as *values*: `enabled` gates reads on an
 * authenticated connection, and `generation` is part of the read context so a
 * replaced socket retires the previous one instead of letting its late reply
 * publish. Reading them off the service during render is not enough — nothing
 * would re-render when they change.
 */
export function useConnectionReadiness(service: WebSocketService | null): ConnectionReadiness {
  const [readiness, setReadiness] = useState<ConnectionReadiness>(() => ({
    connected: service?.connectionState === 'connected',
    generation: service?.physicalGeneration ?? 0,
  }));

  useEffect(() => {
    if (!service) {
      setReadiness({ connected: false, generation: 0 });
      return;
    }
    const sync = () => {
      setReadiness((prev) => {
        const connected = service.connectionState === 'connected';
        const generation = service.physicalGeneration;
        return prev.connected === connected && prev.generation === generation
          ? prev
          : { connected, generation };
      });
    };
    sync();
    return service.onConnectionStateChange(sync);
  }, [service]);

  return readiness;
}