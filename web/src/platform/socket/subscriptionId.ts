import { v4 as uuidv4 } from 'uuid';

let subscriptionId: string | null = null;

/**
 * The current page instance's subscription identity.
 *
 * Deliberately **not** persisted, and deliberately different from
 * `getOrCreateClientId`: the client id lives in localStorage and is therefore
 * shared by every same-origin tab, while this identifies one page's attach.
 * Two tabs must subscribe independently and receive the same broadcast; a
 * reconnect of one page keeps this value and replaces only its own
 * subscription.
 *
 * A reload is a new page instance with a new id. Its old socket's subscription
 * retires with that connection, which is what `retire_connection` does on the
 * Agent side.
 */
export function getOrCreateSubscriptionId(): string {
  subscriptionId ??= uuidv4();
  return subscriptionId;
}
