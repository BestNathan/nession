"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"

import { cn } from "@/shared/lib/utils"
import { usePopupPortalContainer } from "@/components/ui/popup-portal"
import {
  overlayAnchoredZClass,
  popupMenuItemBandClass,
} from "@/components/ui/overlayStyles"
import { resourceChoiceItemClass } from "@/components/ui/choice-itemStyles"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

const Select = SelectPrimitive.Root

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  /**
   * `content` is the multi-line variant (issue 3089): no fixed height and no
   * nowrap/line-clamp, so a selected record with several lines sets the
   * control's height instead of overflowing it. `field` is the compact
   * single-line form-field variant (issue 3136): it uses the Experience's
   * control band (`control.md`, 32px Web / 44px App) with the same padding
   * band as `Input`, so a Select and a neighbouring single-line field share a
   * control baseline. Single-line `default`/`sm` triggers are unchanged.
   */
  size?: "sm" | "default" | "content" | "field"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm transition-colors outline-none select-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:outline-solid aria-invalid:focus-visible:outline-[length:var(--nession-focus-ring-width)] aria-invalid:focus-visible:outline-ring aria-invalid:focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))] data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        size === "content"
          ? "items-start whitespace-normal *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-start *:data-[slot=select-value]:gap-1.5"
          : size === "field"
            ? "items-center whitespace-nowrap min-h-[length:var(--nession-control-md)] py-1 data-[size=field]:rounded-lg *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5"
            : "items-center whitespace-nowrap data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-md *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </SelectPrimitive.Trigger>
  )
}

/**
 * Standard anchored Select placement (issue 3246): the popup opens below the
 * trigger with its start edge on the trigger's start edge, `sideOffset` away.
 * `alignItemWithTrigger` stays opt-in for a future caller that genuinely wants
 * the selected row to overlap the trigger. Item-aligned mode writes
 * viewport-fixed coordinates and therefore double-offsets when its required
 * host is a Dialog's translated popup container; normal anchored mode is the
 * one that survives the host. Collision flip/shift remains Base UI's.
 */
function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = false,
  width = "anchor",
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  > & {
    /**
     * `anchor` keeps the list at the trigger's width. `content` lets a
     * resource-rich list grow beyond a narrow trigger up to the shared choice
     * width role, clamped by Base UI's available width (issue 3164). The list
     * never gets narrower than its trigger.
     */
    width?: "anchor" | "content"
  }) {
  // A Select opened inside an Experience scope mounts into that scope's
  // container, so its rows resolve the same control band as their trigger.
  const container = usePopupPortalContainer() ?? undefined
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className={cn(overlayAnchoredZClass, "outline-none")}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn("relative", overlayAnchoredZClass, "max-h-(--available-height) origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", width === "content" ? "w-max min-w-(--anchor-width) max-w-[calc(min(var(--nession-overlay-choice-max-width),calc(100vw-1.5rem)))]" : "w-(--anchor-width) min-w-36", className )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  anatomy = "action",
  ...props
}: SelectPrimitive.Item.Props & {
  /**
   * The row's job. `action` keeps the single-line PopupMenu action band.
   * `resource` is the rich-choice anatomy (issue 3164): the row wraps, keeps the
   * Experience control band as its minimum, and reserves a stable trailing
   * check. Use it only when the options carry a resource identity/metadata,
   * not for a plain action list.
   */
  anatomy?: "action" | "resource"
}) {
  const resource = anatomy === "resource"
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      data-anatomy={anatomy}
      className={cn(
        resource
          ? resourceChoiceItemClass
          : cn(
              popupMenuItemBandClass,
              "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
            ),
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText
        data-slot="select-item-text"
        className={cn(
          "flex flex-1 gap-2",
          resource
            ? "min-w-0 whitespace-normal"
            : "shrink-0 whitespace-nowrap",
        )}
      >
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span
            data-slot="select-item-indicator"
            className={cn(
              "pointer-events-none absolute right-2 flex size-4 items-center justify-center",
              resource && "top-1/2 -translate-y-1/2",
            )}
          />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon
      />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon
      />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
