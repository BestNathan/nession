import { RefreshCw } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

interface RefreshButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'default' | 'outline' | 'ghost';
  className?: string;
  iconClassName?: string;
  ariaLabel?: string;
}

export function RefreshButton({
  onClick,
  disabled,
  loading,
  variant = 'outline',
  className,
  iconClassName,
  ariaLabel,
}: RefreshButtonProps) {
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      className={cn('min-h-11 min-w-11 md:min-h-7 md:min-w-0', className)}
    >
      <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin', iconClassName)} />
    </Button>
  );
}
