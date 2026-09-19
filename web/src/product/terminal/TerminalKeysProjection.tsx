import { PhysKeyRow } from '@/product/terminal/capsule/PhysKeyRow';
import { CapsuleChainBar } from '@/product/terminal/capsule/CapsuleChainBar';
import { usePhysKeyChain } from '@/product/terminal/capsule/usePhysKeyChain';

/**
 * Terminal Keys — the accessory itself (`#826` §7).
 *
 * Left function and combination keys, right directional keys, above a composer
 * that is still there. Both of §7's requirements fall out of it being a
 * projection rather than a panel: the composer is still below it, and nothing
 * here dismisses on input, so keys can be sent repeatedly.
 *
 * The chord is `usePhysKeyChain`, the same hook the Commands panel uses, so
 * holding a key to build Ctrl-C behaves identically wherever the keys were
 * opened from. A second implementation would have been free to drift, and the
 * drift would read as "the keys work differently depending on where you opened
 * them".
 */
export function TerminalKeysProjection({
  sendText,
  disabled,
}: {
  sendText: (text: string) => void;
  disabled: boolean;
}) {
  const {
    chainBuffer,
    isChaining,
    handlePhysKey,
    handleChainStart,
    handleChainAdd,
    cancelChain,
    sendChain,
  } = usePhysKeyChain(sendText);

  return (
    <div
      data-testid="terminal-keys-body"
      className="flex flex-col gap-[length:var(--terminal-capsule-projection-item-gap)]"
    >
      {isChaining ? (
        <CapsuleChainBar buffer={chainBuffer} onCancel={cancelChain} onSend={sendChain} />
      ) : null}
      <PhysKeyRow
        onKey={handlePhysKey}
        disabled={disabled}
        chainBuffer={chainBuffer}
        isChaining={isChaining}
        onChainStart={handleChainStart}
        onChainAdd={handleChainAdd}
      />
    </div>
  );
}
