/** Reads the pending tool call's raw arguments out of the requesting agent's session log. */
import type { ToolCallSummary } from './card.ts'
import type { ApprovalRequestEvent } from './types.ts'

/** The session-log event shapes this reader relies on (defensive: anything else is skipped). */
interface ToolCallRecord {
  type: string
  data?: { callId?: string, name?: string, arguments?: string }
}

interface SessionHeaderLike {
  cwd?: string
  id?: string
}

/** Reads the session's event snapshot and its header without depending on dsh-session types. */
interface SessionLike {
  snapshotEvents?: (from?: number, to?: number) => readonly unknown[]
  ownEvents?: () => readonly unknown[]
  header?: SessionHeaderLike
  id?: string
}

/** The session identity and working directory shown on the card footer. */
export function sessionOrigin(request: ApprovalRequestEvent): { session?: string, cwd?: string } {
  const session = request.agent?.session as SessionLike | undefined
  if (!session) return {}
  const origin: { session?: string, cwd?: string } = {}
  const id = session.header?.id ?? session.id
  if (typeof id === 'string') origin.session = id
  if (typeof session.header?.cwd === 'string') origin.cwd = session.header.cwd
  return origin
}

/** Extracts one session event snapshot, tolerating deprecation-shape drift across runtime versions. */
const eventsOf = (session: SessionLike): readonly unknown[] => {
  try {
    const own = session.ownEvents?.()
    if (Array.isArray(own)) return own
    const snapshot = session.snapshotEvents?.()
    if (Array.isArray(snapshot)) return snapshot
  } catch { /* a failed read only costs card detail */ }
  return []
}

/**
 * Finds the tool call the request is about: the `tool/call` record matching `callId`, or the
 * log's last `tool/call` when the asker supplied none. Scanning backwards is cheap because
 * the ask always follows the call it decides.
 */
export function describeToolCall(request: ApprovalRequestEvent): ToolCallSummary | undefined {
  const session = request.agent?.session as SessionLike | undefined
  if (!session) return undefined
  const events = eventsOf(session) as readonly ToolCallRecord[]
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/call') continue
    if (request.callId !== undefined && event.data?.callId !== request.callId) continue
    return { name: event.data?.name ?? request.toolName, arguments: event.data?.arguments }
  }
  return undefined
}
