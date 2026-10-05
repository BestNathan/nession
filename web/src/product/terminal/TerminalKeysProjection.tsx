import { PhysKeyRow } from '@/product/terminal/capsule/PhysKeyRow';
import type { PhysKey } from '@/product/terminal/capsule/physKeys';
import { CapsuleChainBar } from '@/product/terminal/capsule/CapsuleChainBar';
import { usePhysKeyChain } from '@/product/terminal/capsule/usePhysKeyChain';

/**
 * Terminal Keys — the key row itself (`#826` §7, and a Peek since the accessory
 * family was retired by `#1347` SC-38).
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
  sendSeq,
  sendPhysKey,
  disabled,
}: {
  sendSeq: (seq: string) => void;
  sendPhysKey: (key: PhysKey) => void;
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
    completeChain,
  } = usePhysKeyChain(sendSeq, sendPhysKey);

  return (
    <div
      data-testid="terminal-keys-body"
      className="flex flex-col gap-[length:var(--nession-terminal-capsule-projection-item-gap)]"
    >
      {isChaining ? (
        <CapsuleChainBar buffer={chainBuffer} onCancel={cancelChain} onSend={sendChain} />
      ) : null}
      <PhysKeyRow
        onKey={handlePhysKey}
        disabled={disabled}
        isChaining={isChaining}
        onChainStart={handleChainStart}
        onChainAdd={handleChainAdd}
        onChainComplete={completeChain}
      />
    </div>
  );
}
