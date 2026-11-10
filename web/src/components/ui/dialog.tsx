import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/shared/lib/utils"
import { Button } from "@/components/ui/button"
import { PopupPortalContainerContext, usePopupPortalContainer } from "@/components/ui/popup-portal"
import {
  overlayDialogZClass,
  overlayScrimClass,
  overlaySizeClass,
  overlaySurfaceClass,
  overlayTitleClass,
  overlayViewportHeightClass,
  overlayViewportWidthClass,
  type OverlaySize,
} from "@/components/ui/overlayStyles"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "isolate duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        overlayScrimClass,
        overlayDialogZClass,
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  variant = "centered",
  size = "compact",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  /**
   * `centered` is the product's dialog. `fullscreen` is an App operation
   * depth (issue 3089): the whole viewport, one page, no surrounding scrim
   * gap. `sheet` is a full-width surface anchored to the bottom edge. All are
   * arrangements of the same primitive, so focus containment, Escape and
   * dismissal stay owned here rather than in a second overlay.
   */
  variant?: "centered" | "fullscreen" | "sheet"
  /**
   * The semantic width role of a centered overlay (issue 3142). Consumers pick the
   * role; the token decides the pixels. `fullscreen` and `sheet` ignore it.
   */
  size?: OverlaySize
}) {
  const [popupHost, setPopupHost] = React.useState<HTMLDivElement | null>(null);
  // The host replaces the outer Experience container for popups opened from
  // inside the modal, so it must state the same scope. The primitive still
  // learns only a DOM attribute value; it does not interpret "app".
  const inheritedScope = usePopupPortalContainer()?.getAttribute("data-experience") ?? undefined;
  const arrangement =
    variant === "centered"
      ? cn(
          "fixed top-1/2 left-1/2 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto p-4 text-sm duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          overlayDialogZClass,
          overlayViewportWidthClass,
          overlayViewportHeightClass,
          overlaySurfaceClass,
          overlaySizeClass(size)
        )
      : variant === "fullscreen"
        ? "fixed inset-0 z-[var(--nession-overlay-dialog-z)] flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-0 overflow-y-auto rounded-none bg-background p-0 text-sm text-foreground outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        : "fixed bottom-0 left-0 top-auto z-[var(--nession-overlay-dialog-z)] flex max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-4 overflow-y-auto rounded-b-none rounded-t-[var(--nession-radius-surface)] border-b-0 bg-popover p-4 text-sm text-popover-foreground outline-none data-open:animate-in data-open:slide-in-from-bottom-4 data-closed:animate-out data-closed:slide-out-to-bottom-4";
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-size={size}
        className={cn(arrangement, className)}
        {...props}
      >
        <PopupPortalContainerContext.Provider value={popupHost}>
          {children}
          {/*
            Anchored layers opened from inside a modal mount here rather than
            into the Experience's body-level container. The host is inside the
            dialog's floating tree, so base-ui's outside-content hiding, the
            focus trap and the Experience scope all apply to the popup; a
            body-level sibling would be aria-hidden and outside the trap.
            `contents` keeps the empty host out of the dialog's layout.
          */}
          <div
            ref={setPopupHost}
            data-slot="dialog-popup-portal"
            data-experience={inheritedScope}
            className="contents"
          />
        </PopupPortalContainerContext.Provider>
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  sticky = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
  /**
   * Pins the footer to the bottom of a scrolling dialog. A sticky footer is
   * opaque so form fields can never show through it, and it reaches the
   * dialog's padding edge so the band is flush with the surface instead of
   * floating above it.
   */
  sticky?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      data-sticky={sticky ? "true" : undefined}
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t p-4 sm:flex-row sm:justify-end",
        sticky ? "sticky -bottom-4 z-10 bg-muted" : "bg-muted/50",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(overlayTitleClass, className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
