import * as React from "react"

import { cn } from "@/shared/lib/utils"

function Textarea({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"textarea"> & {
  /**
   * `field` is the compact single-line-start form-field variant (issue 3136):
   * it starts at the Experience's control band (32px Web / 44px App) with the
   * same padding band as `Input`, then grows downward with its content
   * (`field-sizing-content`) rather than forcing a fixed multi-row box.
   */
  variant?: "default" | "field"
}) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant}
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:outline-solid aria-invalid:focus-visible:outline-[length:var(--nession-focus-ring-width)] aria-invalid:focus-visible:outline-ring aria-invalid:focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))] md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50",
        variant === "field" &&
          "min-h-[length:var(--nession-control-md)] py-1",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
