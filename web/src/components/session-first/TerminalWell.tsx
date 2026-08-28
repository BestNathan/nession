import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function TerminalWell({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-testid="terminal-well"
      className={cn(
        'terminal-well flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl',
        className,
      )}
    >
      {children}
    </div>
  )
}
