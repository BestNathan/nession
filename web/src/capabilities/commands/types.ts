/**
 * The saved-command wire shapes, read from the generated bindings.
 *
 * `server.commands.*` is the one saved-command data owner (#95/#2710 SC-05):
 * the server stores the list, orders it (`sort_order`, then `created_at`) and
 * pushes `server.commands.changed`. This slice adapts that owner for the Web;
 * it does not persist or reorder anything itself.
 */
export type {
  QuickCommandItem,
  ClientCommandsListResponsePayload,
} from '@/generated/protocol/core/server-commands-list/v1';
