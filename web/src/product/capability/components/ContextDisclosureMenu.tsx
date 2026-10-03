import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/shared/lib/utils';
import type { CapabilityId } from '@/product/capability';
import type { SensedCapabilityItem } from '@/product/terminal/capsule/types';

export type { SensedCapabilityItem };
import { capsuleCaptionTextClass } from '@/product/terminal/capsule/capsuleStyles';
import {
  CapabilityEntryRows,
  type CapabilityDisclosureMenuEntry,
} from './CapabilityDisclosureMenu';

/**
 * One sensed capability, as Nession renders it in the Context Disclosure.
 *
 * Built by the composition that knows both halves — the sense (a work signal,
 * a context signal) and the capability's display identity — because neither
 * the sensing layer nor the capability owns both. `title` and `icon` are the
 * capability's *display* identity, never its raw id as product copy (#1347
 * SC-19); `reason` is the one line saying why it is here.
 */
export interface ContextDisclosureLabels {
  /** Heading over the sensed section, e.g. "Working now". */
  sensed: string;
  /** The secondary in-surface path to the ordinary list. */
  all: string;
  /** Heading of the ordinary list when nothing is sensed. */
  capabilities: string;
}

export interface ContextDisclosureMenuProps {
  /** Currently sensed capabilities, sensed-first order (work, then context). */
  sensed: readonly SensedCapabilityItem[];
  /** The ordinary capability list behind the secondary path. */
  entries: readonly CapabilityDisclosureMenuEntry[];
  /** Ordinary selection: the capability's Signal depth. */
  onSelect: (id: CapabilityId) => void;
  /**
   * Sensed selection: the capability opens directly at Peek depth (#1347
   * SC-20). Sensing already said "this one is doing something", so a Signal
   * would ask the user to re-find what the surface just named.
   */
  onChooseSensed: (id: CapabilityId) => void;
  /** The affordance that opens the surface — supplied with its own geometry. */
  trigger: ReactElement;
  labels: ContextDisclosureLabels;
  /** Prefix for the ordinary rows' test ids, e.g. `capsule-capability-picker`. */
  testIdPrefix: string;
}

/**
 * The Context Disclosure — one anchored surface for sensed capabilities and
 * ordinary capability discovery (#1347 SC-18, SC-33, SC-35, SC-36).
 *
 * It belongs to the same class of surface as {@link CapabilityDisclosureMenu}:
 * anchored to its trigger (`side="top"`), floating over the work, with no
 * backdrop, no centered modal geometry and no focus trap. What it adds is the
 * sensed layer above the list:
 *
 * ```text
 * sensed?  Working now   Claude Code  Working in this Session  ›
 *          ────────────────────────────────────────────────────
 *          All capabilities  ›        (the ordinary list)
 *
 * quiet    Capabilities   Files · Session · … (the ordinary list)
 * ```
 *
 * Lifecycle (SC-36): the surface is bounded and lists every sensed item in one
 * place; when the sense that opened it disappears, it dismisses itself —
 * unless the user has already deepened into a capability, which is their own
 * open Peek to close, not this surface's.
 */
export function ContextDisclosureMenu({
  sensed,
  entries,
  onSelect,
  onChooseSensed,
  trigger,
  labels,
  testIdPrefix,
}: ContextDisclosureMenuProps) {
  const [open, setOpen] = useState(false);
  // Whether this *opening* has ever shown a sensed section. Dismissing on
  // "sensed is empty" alone would close the quiet list the moment it opened;
  // dismissing only when a sensed section came and went is the rule the owner
  // stated: work ends while the disclosure is open -> dismiss.
  const sawSensed = useRef(false);

  useEffect(() => {
    if (!open) {
      sawSensed.current = false;
      return;
    }
    if (sensed.length > 0) {
      sawSensed.current = true;
    } else if (sawSensed.current) {
      setOpen(false);
    }
  }, [open, sensed.length]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent
        side="top"
        align="center"
        className="w-60"
        data-testid="capsule-context-disclosure"
      >
        {sensed.length > 0 ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>{labels.sensed}</DropdownMenuLabel>
              {sensed.map((item) => {
                const Icon = item.icon;
                return (
                  <DropdownMenuItem
                    key={item.capabilityId}
                    data-testid={`capsule-context-item-${item.capabilityId}`}
                    onClick={() => onChooseSensed(item.capabilityId)}
                  >
                    {Icon ? <Icon /> : null}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-foreground">{item.title}</span>
                      <span className={cn('truncate', capsuleCaptionTextClass)}>
                        {item.reason}
                      </span>
                    </span>
                    <ChevronRight aria-hidden className="ml-auto size-4 shrink-0" />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="capsule-context-all">
                {labels.all}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                className="w-52"
                data-testid="capsule-context-all-menu"
              >
                <CapabilityEntryRows
                  entries={entries}
                  onSelect={onSelect}
                  testIdPrefix={testIdPrefix}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : (
          <CapabilityEntryRows
            entries={entries}
            onSelect={onSelect}
            testIdPrefix={testIdPrefix}
            label={labels.capabilities}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
