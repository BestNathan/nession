import { Wifi, WifiOff, HelpCircle, Loader2 } from 'lucide-react';
import { useState, useCallback } from 'react';
import type { ProbedAddress, AddressLatency } from '../types';
import { useMediaQuery } from '../hooks/useMediaQuery';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

/** Sentinel value for the automatic (latency-based) selection option. */
const AUTO_VALUE = '__auto__';

interface AddressSelectorProps {
  addresses: ProbedAddress[];
  latencies: AddressLatency[];
  activeUrl: string | null;
  isAuto: boolean;
  onSelect: (url: string | null) => void;
  isSwitching: boolean;
  effectiveMode: 'p2p' | 'relay';
}

type Reachable = boolean | undefined;

function browserReachable(
  url: string,
  byUrl: Map<string, number | null>,
): Reachable {
  if (!byUrl.has(url)) {
    return undefined;
  }
  return byUrl.get(url) !== null;
}

function ReachIcon({ reachable }: { reachable: Reachable }) {
  if (reachable === undefined) {
    return <HelpCircle className="w-3 h-3 text-muted-foreground shrink-0" />;
  }
  return reachable ? (
    <Wifi className="w-3 h-3 text-green-500 shrink-0" />
  ) : (
    <WifiOff className="w-3 h-3 text-red-500 shrink-0" />
  );
}

// ── Mobile icon states ──────────────────────────────────────────────

function mobileIcon(
  isSwitching: boolean,
  effectiveMode: 'p2p' | 'relay',
): { icon: typeof Wifi; className: string } {
  if (isSwitching) {
    return { icon: Loader2, className: 'animate-spin text-muted-foreground' };
  }
  if (effectiveMode === 'relay') {
    return { icon: WifiOff, className: 'text-amber-500' };
  }
  return { icon: Wifi, className: 'text-green-500' };
}

// ── Shared address list content ──────────────────────────────────────

function AddressListItems({
  addresses,
  latencies,
  activeUrl,
  isAuto,
  onSelect,
}: {
  addresses: ProbedAddress[];
  latencies: AddressLatency[];
  activeUrl: string | null;
  isAuto: boolean;
  onSelect: (url: string | null) => void;
}) {
  const latencyByUrl = new Map(latencies.map((l) => [l.url, l.latencyMs]));

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-accent rounded-md min-h-11',
          isAuto && 'bg-accent',
        )}
        onClick={() => onSelect(null)}
      >
        <Wifi className="w-4 h-4 text-green-500 shrink-0" />
        <span className="text-sm font-medium">Auto (lowest latency)</span>
      </div>
      {addresses.map((addr) => {
        const latency = latencyByUrl.get(addr.url);
        const reachable = browserReachable(addr.url, latencyByUrl);
        const isSelected = !isAuto && activeUrl === addr.url;
        return (
          <div
            key={addr.url}
            className={cn(
              'flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-accent rounded-md min-h-11',
              isSelected && 'bg-accent',
            )}
            onClick={() => onSelect(addr.url)}
          >
            <ReachIcon reachable={reachable} />
            <span className="text-sm font-medium flex-1">
              {addr.label ?? addr.network_type}
            </span>
            {latency !== null && latency !== undefined ? (
              <span className="text-xs text-muted-foreground">{latency}ms</span>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

// ── Desktop variant (≥640px) — existing Select ───────────────────────

function AddressSelectorDesktop({
  addresses,
  latencies,
  activeUrl,
  isAuto,
  onSelect,
}: AddressSelectorProps) {
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
        {addresses.map((addr) => {
          const latencyByUrl = new Map(latencies.map((l) => [l.url, l.latencyMs]));
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

// ── Mobile variant (<640px) — icon button + bottom sheet ────────────

function AddressSelectorMobile({
  addresses,
  latencies,
  activeUrl,
  isAuto,
  isSwitching,
  effectiveMode,
  onSelect,
}: AddressSelectorProps) {
  const [open, setOpen] = useState(false);
  const { icon: Icon, className } = mobileIcon(isSwitching, effectiveMode);

  const handleSelect = useCallback(
    (url: string | null) => {
      onSelect(url);
      setOpen(false);
    },
    [onSelect],
  );

  if (addresses.length <= 1) {
    return null;
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            aria-label="P2P route"
          >
            <Icon className={cn('size-4', className)} data-icon />
          </Button>
        }
      />
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className="text-left mb-2">
          <SheetTitle>Select Route</SheetTitle>
        </SheetHeader>
        <div className="px-2 flex flex-col gap-0.5">
          <AddressListItems
            addresses={addresses}
            latencies={latencies}
            activeUrl={activeUrl}
            isAuto={isAuto}
            onSelect={handleSelect}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Entry point — responsive switch ──────────────────────────────────

export function AddressSelector(props: AddressSelectorProps) {
  const isDesktop = useMediaQuery('(min-width: 640px)');

  if (isDesktop) {
    return <AddressSelectorDesktop {...props} />;
  }
  return <AddressSelectorMobile {...props} />;
}
