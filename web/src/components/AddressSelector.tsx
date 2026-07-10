import { Wifi, WifiOff, HelpCircle } from 'lucide-react';
import type { ProbedAddress } from '../types';
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
  /** Currently active URL (null while auto-selecting or in relay). */
  activeUrl: string | null;
  /** True when the current selection is the automatic pick (not a manual one). */
  isAuto: boolean;
  /** Choose an address manually, or pass null to return to automatic. */
  onSelect: (url: string | null) => void;
}

function StatusIcon({ status }: { status: ProbedAddress['status'] }) {
  switch (status) {
    case 'reachable':
      return <Wifi className="w-3 h-3 text-green-500 shrink-0" />;
    case 'unreachable':
      return <WifiOff className="w-3 h-3 text-red-500 shrink-0" />;
    default:
      return <HelpCircle className="w-3 h-3 text-muted-foreground shrink-0" />;
  }
}

/**
 * Header selector letting advanced users override the automatic P2P address
 * pick (issue #43). Shows each candidate's network-type label and probe
 * status; "Auto" restores latency-based selection. Hidden when there's nothing
 * to choose between (≤1 address).
 */
export function AddressSelector({ addresses, activeUrl, isAuto, onSelect }: AddressSelectorProps) {
  if (addresses.length <= 1) {
    return null;
  }

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
        {addresses.map((addr) => (
          <SelectItem key={addr.url} value={addr.url}>
            <span className="flex items-center gap-1.5">
              <StatusIcon status={addr.status} />
              <span className="font-medium">{addr.label ?? addr.network_type}</span>
              {addr.rtt_ms !== undefined && addr.rtt_ms !== null ? (
                <span className="text-[10px] text-muted-foreground">{addr.rtt_ms}ms</span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
