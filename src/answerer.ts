/** The approval answerer: turns one `approval/request` into a Feishu card and a button click into the outcome. */
import { randomUUID } from 'node:crypto'
import { decidedCard, pendingCard, type PendingCard } from './card.ts'
import type { CardActionEvent, LarkCli } from './lark.ts'
import { describeToolCall, sessionOrigin } from './session-info.ts'
import type { ApprovalOutcome, ApprovalRequestEvent } from './types.ts'

/** Structured logging surface, satisfied by the Cordis context logger. */
export interface BridgeLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface BridgeOptions {
  receiveIdType: 'open_id' | 'chat_id'
  receiveId: string
  allowedOpenIds: readonly string[]
  timeoutSeconds: number
  onTimeout: 'rejected' | 'unavailable'
  reasonMaxChars: number
  commandMaxChars: number
  lang: 'zh' | 'en'
}

/** One answerer-side pending approval. */
interface PendingEntry {
  settle: (outcome: Exclude<ApprovalOutcome, 'unavailable'> | typeof TIMEOUT) => void
  timer: NodeJS.Timeout
  messageId: string
  infoMarkdown: string
  rid: string
}

/** The promise marker separating "a decision arrived" from "the wait expired". */
const TIMEOUT = 'approval-feishu/timeout' as const

const OUTCOME_BY_DECISION = { allow: 'allowed-once', reject: 'rejected' } as const

/** Bridges the host's approval waterfall to Feishu cards and card action clicks. */
export class FeishuApprovalBridge {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly seenEvents = new Set<string>()
  private disposed = false

  constructor(private readonly options: BridgeOptions, private readonly lark: LarkCli, private readonly log: BridgeLogger) {}

  /** The pending request count, for diagnostics. */
  get pendingCount(): number { return this.pending.size }

  /**
   * The waterfall answerer. Sends the card and waits for the click, the timeout, or the
   * request's cancellation signal. A card send failure delegates to `next()` so the rest of
   * the answerer chain (for example an open DSH panel) still sees the request.
   */
  readonly answer = async (request: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    const rid = randomUUID().slice(0, 8)
    let card: PendingCard
    try {
      card = pendingCard({
        rid,
        request,
        call: describeToolCall(request),
        origin: sessionOrigin(request),
        reasonMaxChars: this.options.reasonMaxChars,
        commandMaxChars: this.options.commandMaxChars,
        lang: this.options.lang,
      })
    } catch (error) {
      this.log.error(`building the approval card failed: ${String(error)}`)
      return next()
    }
    let messageId: string
    try {
      messageId = await this.lark.sendCard(this.options.receiveIdType, this.options.receiveId, card.card, rid)
    } catch (error) {
      this.log.warn(`sending the approval card failed (${request.toolName}); delegating to the next answerer: ${String(error)}`)
      return next()
    }
    this.log.info(`approval for ${request.toolName} sent to Feishu as ${messageId} (rid ${rid})`)
    const outcome = await new Promise<Exclude<ApprovalOutcome, 'unavailable'> | typeof TIMEOUT>(resolve => {
      const settle = (value: Exclude<ApprovalOutcome, 'unavailable'> | typeof TIMEOUT): void => {
        clearTimeout(entry.timer)
        request.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(rid)
        resolve(value)
      }
      const onAbort = (): void => settle('cancelled')
      const entry: PendingEntry = {
        settle,
        timer: setTimeout(() => settle(TIMEOUT), this.options.timeoutSeconds * 1000),
        messageId,
        infoMarkdown: card.infoMarkdown,
        rid,
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(rid, entry)
    })
    if (outcome === TIMEOUT) {
      this.log.warn(`approval ${rid} for ${request.toolName} timed out`)
      void this.markDecided(rid, messageId, card.infoMarkdown, 'timeout').catch(error => {
        this.log.warn(`updating the timed-out card failed: ${String(error)}`)
      })
      return this.options.onTimeout === 'unavailable' ? next() : 'rejected'
    }
    // The agent resumes at once; the card catch-up happens in the background.
    void this.markDecided(rid, messageId, card.infoMarkdown, outcome).catch(error => {
      this.log.warn(`updating the decided card failed: ${String(error)}`)
    })
    return outcome
  }

  /** Handles one parsed `card.action.trigger` event line from the consumer. */
  readonly handleAction = async (event: CardActionEvent): Promise<void> => {
    if (this.disposed) return
    if (event.event_id) {
      if (this.seenEvents.has(event.event_id)) return
      this.seenEvents.add(event.event_id)
      if (this.seenEvents.size > 256) {
        const oldest = this.seenEvents.values().next().value
        if (oldest !== undefined) this.seenEvents.delete(oldest)
      }
    }
    const operator = event.operator_id ?? ''
    if (!this.permitted(operator)) {
      this.log.warn(`card action from ${operator || 'an unknown user'} is not on allowedOpenIds; ignored`)
      return
    }
    let value: { rid?: string, decision?: string }
    try { value = JSON.parse(event.action_value ?? '{}') as { rid?: string, decision?: string } }
    catch { return }
    const rid = typeof value.rid === 'string' ? value.rid : undefined
    if (rid === undefined) return
    const entry = this.pending.get(rid)
    if (entry === undefined) {
      // A click on a card this process no longer tracks (restart or expiry): tell the clicker instead of staying silent.
      if (event.message_id) {
        await this.lark.patchCard(event.message_id, decidedCard({
          infoMarkdown: '', rid, decision: 'stale', operator, lang: this.options.lang,
        })).catch(() => {})
      }
      return
    }
    if (value.decision !== 'allow' && value.decision !== 'reject') return
    this.log.info(`approval ${rid} decided by ${operator || 'unknown'}: ${value.decision}`)
    entry.settle(OUTCOME_BY_DECISION[value.decision])
  }

  /** Resolves every pending request and retires the bridge; the plugin unmount path. */
  dispose(): void {
    this.disposed = true
    for (const entry of [...this.pending.values()]) {
      clearTimeout(entry.timer)
      void this.lark.patchCard(entry.messageId, decidedCard({
        infoMarkdown: entry.infoMarkdown, rid: entry.rid, decision: 'cancelled', lang: this.options.lang,
      })).catch(() => {})
      entry.settle('cancelled')
    }
  }

  /** True when the operator may decide, i.e. the allowlist is empty or contains them. */
  private permitted(operator: string): boolean {
    if (this.options.allowedOpenIds.length === 0) return true
    return operator !== '' && this.options.allowedOpenIds.includes(operator)
  }

  /** Replaces the pending card with its decided state; failures are the caller's log concern. */
  private async markDecided(rid: string, messageId: string, infoMarkdown: string,
    outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'timeout'): Promise<void> {
    await this.lark.patchCard(messageId, decidedCard({ infoMarkdown, rid, decision: outcome, lang: this.options.lang }))
  }
}
