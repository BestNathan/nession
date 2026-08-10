import { Wifi, WifiOff, HelpCircle } from 'lucide-react';
import type { ProbedAddress, AddressLatency } from '../types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

/** Sentinel value for the automatic (latency-based) selection option. */
const AUTO_VALUE = '__auto__';

interface AddressSelectorProps {
  addresses: ProbedAddress[];
  /**
   * Per-URL latency THIS BROWSER measured at attach time. This — not the
   * server's probe status carried on `ProbedAddress` — is what the selector
   * displays, so the runtime view matches the attach dialog's numbers.
   */
  latencies: AddressLatency[];
  /** Currently active URL (null while auto-selecting or in relay). */
  activeUrl: string | null;
  /** True when the current selection is the automatic pick (not a manual one). */
  isAuto: boolean;
  /** Choose an address manually, or pass null to return to automatic. */
  onSelect: (url: string | null) => void;
  /** True while the connection for a manually-selected address is being established. */
  isSwitching: boolean;
  /** Current transport mode — used to determine icon colour on mobile. */
  effectiveMode: 'p2p' | 'relay';
}

/** Browser reachability for an address: true/false, or undefined if untested. */
function browserReachable(
  url: string,
  byUrl: Map<string, number | null>,
): boolean | undefined {
  if (!byUrl.has(url)) {
    return undefined;
  }
  return byUrl.get(url) !== null;
}

function ReachIcon({ reachable }: { reachable: boolean | undefined }) {
  if (reachable === undefined) {
    return <HelpCircle className="w-3 h-3 text-muted-foreground shrink-0" />;
  }
  return reachable ? (
    <Wifi className="w-3 h-3 text-green-500 shrink-0" />
  ) : (
    <WifiOff className="w-3 h-3 text-red-500 shrink-0" />
  );
}

/**
 * Header selector letting advanced users override the automatic P2P address
 * pick (issue #43). Reachability + latency shown are the BROWSER's own
 * attach-time measurements. "Auto" restores latency-based selection. Hidden
 * when there's nothing to choose between (≤1 address).
 */
export function AddressSelector({ addresses, latencies, activeUrl, isAuto, onSelect }: AddressSelectorProps) {
  if (addresses.length <= 1) {
    return null;
  }

  const latencyByUrl = new Map(latencies.map((l) => [l.url, l.latencyMs]));
  const value = isAuto ? AUTO_VALUE : (activeUrl ?? AUTO_VALUE);

  return (
    <Select
      value={value}
      onValueChange={(v) => onSelect(v === AUTO_VALUE ? null : v)}
    >
      <SelectTrigger className="h-7 w-auto gap-1 text-xs" aria-label="P2P route">
        <span className="text-muted-foreground">Route:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO_VALUE}>Auto (lowest latency)</SelectItem>
        {addresses.map((addr) => {
          const latency = latencyByUrl.get(addr.url);
          const reachable = browserReachable(addr.url, latencyByUrl);
          return (
            <SelectItem key={addr.url} value={addr.url}>
              <span className="flex items-center gap-1.5">
                <ReachIcon reachable={reachable} />
                <span className="font-medium">{addr.label ?? addr.network_type}</span>
                {latency !== null && latency !== undefined ? (
                  <span className="text-[10px] text-muted-foreground">{latency}ms</span>
                ) : null}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
