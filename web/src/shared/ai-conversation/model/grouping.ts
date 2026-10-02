/**
 * Turning a flat transcript into the rows a reader sees.
 *
 * ## Why grouping exists at all
 *
 * A turn that read three files, ran two commands and searched the codebase is
 * seven rows of work between the question and the answer. Rendered flat, the
 * answer is seven rows away from the thing it answers — `#1005` criterion 10's
 * "tool use must not drown the conversation", stated as a layout problem.
 *
 * So consecutive work collapses into one row whose summary describes the work,
 * and the reader opens it only when they want to.
 *
 * ## Why the key is anchored to the *first* item
 *
 * This is the load-bearing detail, and it is the same one the runtime already
 * applies to items. A group that is still being appended to must keep its
 * identity, or every new tool call remounts the group and loses its disclosure
 * state mid-read. Keying by the first item's id means appending mutates the
 * group's contents and leaves its identity alone.
 *
 * The other end is the problem, and it is not the scroller's to solve:
 * prepending older history across a group's start makes a *different* call the
 * first, so the key changes and the row is a new element. It remounts — the
 * reader's expanded group closes under them, anything focused inside it is gone,
 * and `MessageScrollerItem` is handed a different `messageId` for content that
 * did not move. [`carryGroupKeys`] is what keeps the key still; this function
 * cannot, because a group's identity across a prepend is history, not something
 * derivable from the items in front of it.
 *
 * ## A lone call is not a group
 *
 * One tool call gets its own row, not a summary line wrapped around a single
 * child. A disclosure that discloses one thing is a click for nothing, and it
 * would make a transcript that used one tool look busier than one that used
 * six.
 */

import type { AIConversationItem, AIToolCategory, AIToolItem } from './conversation'

export type ConversationRow =
  | { kind: 'item'; key: string; item: AIConversationItem }
  | { kind: 'tools'; key: string; items: AIToolItem[]; summary: ToolGroupSummary }

export interface ToolGroupSummary {
  /** e.g. `3 reads · 1 command`. Never a list of tool names. */
  text: string
  /** How many of the group's calls are still running. */
  running: number
  /** How many failed. Only failures are called out; success is the quiet default. */
  failed: number
}

/**
 * The order categories are reported in.
 *
 * Fixed, and deliberately not first-seen order: a group whose calls arrive in a
 * different order — which is what happens when the transcript is read
 * backwards, or when a provider reports a subcall before its parent — must not
 * describe itself differently. A summary that reshuffles under a poll is worse
 * than one that is slightly arbitrary.
 */
const CATEGORY_ORDER: AIToolCategory[] = [
  'command',
  'read',
  'edit',
  'write',
  'search',
  'fetch',
  'other',
]

/**
 * Nession's own words for the categories.
 *
 * Authored here rather than copied from either upstream: `#1363` asks for the
 * upstream *hierarchy and interaction*, and its example strings
 * (`Read files · Searched code · Ran commands`) are not what the source emits —
 * they are an illustration. Copying an illustration would be inventing a spec.
 */
const CATEGORY_LABEL: Record<AIToolCategory, [singular: string, plural: string]> = {
  command: ['command', 'commands'],
  read: ['file read', 'file reads'],
  edit: ['edit', 'edits'],
  write: ['write', 'writes'],
  search: ['search', 'searches'],
  fetch: ['fetch', 'fetches'],
  other: ['action', 'actions'],
}

function categoryOf(item: AIToolItem): AIToolCategory {
  return item.category ?? 'other'
}

/**
 * Describe a run of tool calls.
 *
 * Categories in a fixed order, counts only where there is something to count,
 * and failures appended — because a failed call is the one thing a collapsed
 * summary must not hide. Success is not called out at all: a row full of green
 * ticks is noise that stops meaning anything.
 */
export function summarizeTools(items: AIToolItem[]): ToolGroupSummary {
  const counts = new Map<AIToolCategory, number>()
  let running = 0
  let failed = 0
  for (const item of items) {
    const category = categoryOf(item)
    counts.set(category, (counts.get(category) ?? 0) + 1)
    if (item.status === 'running') {
      running += 1
    }
    if (item.status === 'error') {
      failed += 1
    }
  }

  const parts = CATEGORY_ORDER.filter((category) => counts.has(category)).map((category) => {
    const count = counts.get(category) as number
    const [one, many] = CATEGORY_LABEL[category]
    return count === 1 ? `1 ${one}` : `${count} ${many}`
  })

  return { text: parts.join(' · '), running, failed }
}

/**
 * The transcript as rows.
 *
 * One pass, because the alternative — grouping and then re-scanning to place
 * summaries — is two chances to disagree about where a group ended.
 */
export function groupRows(items: AIConversationItem[]): ConversationRow[] {
  const rows: ConversationRow[] = []
  let run: AIToolItem[] = []

  const flush = () => {
    if (run.length === 0) {
      return
    }
    // A single call is its own row; see the module note.
    if (run.length === 1) {
      rows.push({ kind: 'item', key: (run[0] as AIToolItem).id, item: run[0] as AIToolItem })
    } else {
      rows.push({
        kind: 'tools',
        key: `tools:${(run[0] as AIToolItem).id}`,
        items: run,
        summary: summarizeTools(run),
      })
    }
    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool') {
      run.push(item)
      continue
    }
    // Anything that is not work ends the run: a message between two calls is
    // the assistant speaking, and swallowing it into a work group would move
    // the answer inside the thing it answers.
    flush()
    rows.push({ kind: 'item', key: item.id, item })
  }
  flush()

  return rows
}

/**
 * Give a group back the key it was last rendered under.
 *
 * `groupRows` derives a group's key from its first call. That is the right
 * anchor for the case that happens constantly — a live conversation appends a
 * call, the run grows at its end, and the group must keep its identity while it
 * is being appended to — and the wrong one for a prepend, where the run grows at
 * its start and the anchor moves.
 *
 * So identity is *carried* rather than re-derived. Every grouped item remembers
 * the key it was rendered under, and a group adopts the remembered key of any
 * item it already held. A group that is genuinely new has no remembered item and
 * keeps the derived key.
 *
 * Reading only — [`rememberGroups`] is the write, and it belongs in an effect
 * rather than in render, so a render that never commits cannot leave a trace.
 */
export function carryGroupKeys(
  rows: ConversationRow[],
  remembered: ReadonlyMap<string, string>,
): ConversationRow[] {
  return rows.map((row) => {
    if (row.kind !== 'tools') {
      return row
    }
    let key = row.key
    for (const item of row.items) {
      const held = remembered.get(item.id)
      if (held !== undefined) {
        key = held
        break
      }
    }
    return key === row.key ? row : { ...row, key }
  })
}

/**
 * Remember which key each grouped item was rendered under.
 *
 * Ids that are no longer in a group are forgotten. Without that the map is a
 * leak proportional to the conversation; with it, it holds exactly the items on
 * screen. A stale id could not be adopted anyway — an item is only ever in one
 * group — so forgetting costs nothing.
 */
export function rememberGroups(
  rows: readonly ConversationRow[],
  remembered: Map<string, string>,
): void {
  const live = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'tools') {
      continue
    }
    for (const item of row.items) {
      remembered.set(item.id, row.key)
      live.add(item.id)
    }
  }
  for (const id of [...remembered.keys()]) {
    if (!live.has(id)) {
      remembered.delete(id)
    }
  }
}
