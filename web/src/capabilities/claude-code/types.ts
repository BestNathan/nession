/**
 * The claude-code capability's names for the wire types (#593).
 *
 * **Aliases, not mirrors** — see `capabilities/git/types.ts` for the argument.
 * These were hand-copied from the legacy `services/websocket/plugins/` before
 * `#678` Phase 5, and `ClaudeCodeReadResponse` shows what that cost: the wire is
 * a two-variant union (`ReadOkV1 | ReadFailureV1`), and the copy flattened it
 * into one interface with an optional `error` field. Every reader of
 * `response.content` got `undefined` on a failure with nothing to say so.
 */

import type {
  ListRequest,
  ListResponse,
} from '@/generated/protocol/claude-code/list/v1';
import type {
  ReadFailureV1,
  ReadOkV1,
  ReadRequest,
  ReadResponse,
} from '@/generated/protocol/claude-code/read/v1';

/**
 * Requests, with the routing field the contract does not carry — `agent_id` is
 * how the server finds the target, not part of what the target is asked.
 */
export type ClaudeCodeListRequest = ListRequest & { agent_id: string };
export type ClaudeCodeReadRequest = ReadRequest & { agent_id: string };

/** The capability's names for the responses. */
export type ClaudeCodeListResponse = ListResponse;
export type ClaudeCodeReadResponse = ReadResponse;

/**
 * The two halves of `claude-code.read`'s answer.
 *
 * The wire distinguishes them by *shape* — `ReadResponseV1` is `#[serde(untagged)]`,
 * so there is no discriminator to switch on and the test is `'error' in
 * response`. The hand-written mirror this replaced flattened the pair into one
 * interface with `error?: string`, which made `response.error` look like a
 * field of the success shape too, and made `response.content` look present on a
 * failure.
 */
export type ClaudeCodeReadOk = ReadOkV1;
export type ClaudeCodeReadFailure = ReadFailureV1;
