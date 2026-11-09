import { Copy, Wifi, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/shared/lib/utils';
import { copyText } from '@/shared/lib/clipboard';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { AttachInfo, AttachMode } from '@/types';
import { AUTO_URL, attachModeHint, attachModeLabel } from '@/product/session/hooks/useAttachConfiguration';

const MODES: { value: AttachMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Test paths, pick fastest, fall back to relay' },
  { value: 'p2p', label: 'P2P', hint: 'Direct to agent (choose a path below)' },
  { value: 'relay', label: 'Relay', hint: 'Proxy through server (works behind NAT/firewalls)' },
];

/** The mode choices, side by side on a wide Web dialog and stacked on App. */
export function ModeChoices({
  mode,
  onChange,
  layout = 'grid',
}: {
  mode: AttachMode;
  onChange: (mode: AttachMode) => void;
  layout?: 'grid' | 'stack';
}) {
  return (
    <div
      data-testid="attach-modes"
      className={cn(
        'grid gap-2',
        layout === 'grid' ? 'sm:grid-cols-3' : 'grid-cols-1',
      )}
      aria-label="Connection Mode"
    >
      {MODES.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={mode === option.value}
          data-testid={`attach-mode-${option.value}`}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex min-h-11 flex-col items-start rounded-[var(--nession-radius-surface)] border px-3 py-2 text-left transition-colors',
            mode === option.value
              ? 'border-primary bg-primary/10'
              : 'border-input hover:bg-accent/50',
          )}
        >
          <span className={chromeSansRole('body')}>{option.label}</span>
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            {option.hint}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The one-line summary an App quick sheet shows before confirming. */
export function AttachModeSummary({
  mode,
  probing,
  bestUrl,
  bestLatency,
  measured,
}: {
  mode: AttachMode;
  probing: boolean;
  bestUrl: string | null;
  bestLatency: number | null;
  measured: boolean;
}) {
  const detail =
    mode !== 'auto'
      ? attachModeHint(mode)
      : probing
        ? 'Measuring the fastest reachable path from this browser…'
        : bestUrl !== null
          ? `Fastest reachable path · ${bestLatency}ms; Relay fallback.`
          : measured
            ? 'Nothing answered from this browser; Relay fallback.'
            : 'Not measured yet; Relay fallback.';
  return (
    <div
      data-testid="attach-mode-summary"
      className="flex flex-col gap-1 rounded-[var(--nession-radius-surface)] border px-3 py-2"
    >
      <span className={chromeSansRole('body')}>{attachModeLabel(mode)}</span>
      <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>{detail}</span>
    </div>
  );
}

/** Renderer selection: WebGL (GPU) vs Canvas (compatibility). */
export function RendererChoices({
  renderer,
  onChange,
  webglSupported,
  layout = 'grid',
}: {
  renderer: 'webgl' | 'canvas';
  onChange: (renderer: 'webgl' | 'canvas') => void;
  webglSupported: boolean;
  layout?: 'grid' | 'stack';
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Renderer</Label>
      <div className={cn('grid gap-2', layout === 'grid' ? 'sm:grid-cols-2' : 'grid-cols-1')}>
        <button
          type="button"
          aria-pressed={renderer === 'webgl'}
          data-testid="attach-renderer-webgl"
          onClick={() => onChange('webgl')}
          disabled={!webglSupported}
          className={cn(
            'flex min-h-11 flex-col items-start rounded-[var(--nession-radius-surface)] border px-3 py-2 text-left transition-colors',
            renderer === 'webgl' ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
            !webglSupported && 'opacity-50 cursor-not-allowed',
          )}
        >
          <span className={chromeSansRole('body')}>WebGL</span>
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            {webglSupported ? 'GPU-accelerated' : 'not supported'}
          </span>
        </button>
        <button
          type="button"
          aria-pressed={renderer === 'canvas'}
          data-testid="attach-renderer-canvas"
          onClick={() => onChange('canvas')}
          className={cn(
            'flex min-h-11 flex-col items-start rounded-[var(--nession-radius-surface)] border px-3 py-2 text-left transition-colors',
            renderer === 'canvas' ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
          )}
        >
          <span className={chromeSansRole('body')}>Canvas</span>
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>compatibility</span>
        </button>
      </div>
    </div>
  );
}

interface PathChoicesProps {
  candidates: NonNullable<AttachInfo['addresses']>;
  latencyByUrl: Map<string, number | null>;
  /** Best URL measured *reachable*, or null when nothing was. */
  bestUrl: string | null;
  /** True once every candidate has a result — a total failure included. */
  measured: boolean;
  /** True while a measurement is in flight. */
  probing: boolean;
  selectedUrl: string;
  onSelect: (url: string) => void;
  /** Re-request attach info so the addresses are measured again. */
  onRetest?: () => void;
  /** When true, use server probe data (rtt_ms, Reachable/Unreachable) labels. */
  isRelay?: boolean;
  /** The dialog bounds its list; an App operation page lets the page scroll. */
  layout?: 'dialog' | 'page';
}

/**
 * The "Connection Path" section: Auto row + one row per candidate address.
 *
 * Candidate URLs wrap (`break-all`) rather than truncate: a complete address
 * the user cannot read is not selectable information. Each candidate also has
 * an explicit Copy action, whose text is the whole address.
 */
export function PathChoices({
  candidates,
  latencyByUrl,
  bestUrl,
  measured,
  probing,
  selectedUrl,
  onSelect,
  onRetest,
  isRelay,
  layout = 'dialog',
}: PathChoicesProps) {
  const bestLatency = bestUrl !== null ? latencyByUrl.get(bestUrl) : null;
  /**
   * Four states, not two, and the difference is the point: "measuring",
   * "measured — nothing reachable", "measured — this is the fastest", and
   * "not measured". Collapsing the last two into "no best URL" is what made a
   * total failure read as "browser will decide", i.e. as if nothing had been
   * tried.
   */
  const autoSublabel = isRelay
    ? 'server auto-selects (Reachable > Unknown > Unreachable)'
    : probing
      ? 'measuring from this browser…'
      : bestUrl !== null
        ? `fastest reachable path · ${bestLatency}ms`
        : measured
          ? 'nothing answered from this browser · relay fallback'
          : 'not measured yet';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Connection Path</Label>
        {onRetest ? (
          <button
            type="button"
            data-testid="attach-retest"
            onClick={onRetest}
            className={cn('text-muted-foreground hover:text-foreground underline', chromeSansRole('caption'))}
          >
            Re-test
          </button>
        ) : null}
      </div>
      <div
        data-testid="attach-path-list"
        className={cn(
          'flex flex-col gap-1',
          layout === 'dialog' && 'max-h-56 overflow-y-auto',
        )}
      >
        <AddressChoice
          label="Auto"
          sublabel={autoSublabel}
          selected={selectedUrl === AUTO_URL}
          onSelect={() => onSelect(AUTO_URL)}
        />
        {candidates.map((addr, index) => {
          const latency = latencyByUrl.get(addr.url);
          // Three states in both modes, because "we have no verdict" is not the
          // same claim as "this failed", and only the first is true when nobody
          // has looked. Relay mode's `unknown` is the server saying it has not
          // probed this address — it was drawn as a red failure.
          const reachable: boolean | undefined = isRelay
            ? addr.status === 'reachable'
              ? true
              : addr.status === 'unreachable'
                ? false
                : undefined
            : latencyByUrl.has(addr.url)
              ? latency !== null
              : undefined;
          const statusLabel = isRelay
            ? (addr.status === 'reachable' ? 'reachable' : addr.status === 'unreachable' ? 'unreachable' : 'unknown')
            : undefined;
          return (
            <AddressChoice
              key={addr.url}
              index={index}
              label={addr.label ?? addr.network_type}
              badge={addr.network_type}
              sublabel={addr.url}
              reachable={reachable}
              isCandidate
              statusLabel={statusLabel}
              latencyMs={latency ?? undefined}
              selected={selectedUrl === addr.url}
              onSelect={() => onSelect(addr.url)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface AddressChoiceProps {
  label: string;
  badge?: string;
  sublabel: string;
  selected: boolean;
  onSelect: () => void;
  index?: number;
  /** undefined = nobody measured this address; true/false = reachability. */
  reachable?: boolean;
  /**
   * Whether this row stands for a candidate address.
   *
   * The Auto row does not — it names the policy, not a host — so it must not
   * carry a reachability affordance at all. `reachable === undefined` already
   * means "not applicable" there, and drawing the unmeasured state for it would
   * both assert something untrue and put its `sr-only` text into the row's
   * accessible name (which is matched by name in the tests).
   */
  isCandidate?: boolean;
  latencyMs?: number;
  /** Server probe status label (relay mode). */
  statusLabel?: string;
}

function copyAddress(url: string): void {
  void copyText(url).then(
    (ok) => {
      if (ok) {
        toast.success('Full address copied');
      } else {
        toast.error('Could not copy the address');
      }
    },
    () => toast.error('Could not copy the address'),
  );
}

function AddressChoice({
  label,
  badge,
  sublabel,
  selected,
  onSelect,
  index,
  reachable,
  isCandidate,
  latencyMs,
  statusLabel,
}: AddressChoiceProps) {
  return (
    <div
      data-testid={index === undefined ? 'attach-path-auto' : `attach-path-${index}`}
      className={cn(
        'flex items-stretch rounded-[var(--nession-radius-surface)] border transition-colors',
        selected ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={index === undefined ? `Auto ${sublabel}` : `Use ${label} ${sublabel}`}
        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
      >
        <span className="mt-0.5 shrink-0">
          {reachable === undefined ? (
            // On a candidate, drawn rather than left blank: an empty slot reads as a
            // rendering gap, while a quiet icon reads as "no verdict", which is what
            // it is. `aria-hidden` with an `sr-only` twin keeps the state out of the
            // row's accessible name while still reaching a screen reader.
            isCandidate ? (
              <>
                <WifiOff className="w-3.5 h-3.5 text-muted-foreground/40" aria-hidden />
                <span className="sr-only">not measured</span>
              </>
            ) : (
              <span className="block w-3.5" />
            )
          ) : reachable ? (
            <Wifi className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-destructive" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className={cn('break-words', chromeSansRole('body'))}>{label}</span>
            {badge ? (
              <span className={cn('uppercase px-1 rounded-[var(--nession-radius-control)] bg-muted text-muted-foreground', chromeSansRole('caption'))}>
                {badge}
              </span>
            ) : null}
            {latencyMs !== undefined ? (
              <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>{latencyMs}ms</span>
            ) : null}
            {statusLabel ? (
              <span className={cn(
                chromeSansRole('caption'),
                // Only a measured failure is destructive. The server reporting that it
                // has not probed an address is not a failure, and colouring it like one
                // is the same defect as drawing it with the offline icon.
                statusLabel === 'unreachable' ? 'text-destructive' : 'text-muted-foreground',
              )}>{statusLabel}</span>
            ) : null}
          </span>
          <span
            data-testid={index === undefined ? 'attach-address-auto' : `attach-address-${index}`}
            className={cn('break-all text-muted-foreground', chromeMonoRole('caption'))}
          >
            {sublabel}
          </span>
        </span>
      </button>
      {index !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="m-1 self-center"
          aria-label={`Copy full address for ${label}`}
          title="Copy full address"
          data-testid={`attach-copy-${index}`}
          onClick={() => copyAddress(sublabel)}
        >
          <Copy className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
