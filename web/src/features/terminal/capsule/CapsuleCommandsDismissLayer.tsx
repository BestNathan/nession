import { capsuleCommandsDismissLayerClass } from '@/features/terminal/capsule/capsuleStyles';

interface CapsuleCommandsDismissLayerProps {
  bottomPx: number;
  onDismiss: () => void;
}

export function CapsuleCommandsDismissLayer({
  bottomPx,
  onDismiss,
}: CapsuleCommandsDismissLayerProps) {
  return (
    <button
      type="button"
      data-testid="capsule-commands-dismiss-layer"
      aria-label="Close commands menu"
      className={capsuleCommandsDismissLayerClass}
      style={{ bottom: bottomPx }}
      onClick={onDismiss}
    />
  );
}
