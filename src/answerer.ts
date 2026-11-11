/** The approval answerer: turns one `approval/request` into a Feishu card and a button click into the outcome. */
import { randomUUID } from 'node:crypto'
import { decidedCard, pendingCard, type DecidedCardInput, type PendingCard } from './card.ts'
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
  /**
   * Whether the downstream (local) answerer runs in parallel with the Feishu card.
   * `race`: both channels are live and the first decision wins.
   * `fallback`: the card answers alone; the local answerer only sees the request when Feishu fails or times out.
   */
  answerLocally: 'race' | 'fallback'
}

/** The two decisions the card offers. */
type CardDecision = 'allowed-once' | 'rejected'

/** One answerer-side pending approval. */
interface PendingEntry {
  settle: (outcome: CardDecision) => void
  cancel: () => void
  timer: NodeJS.Timeout
  messageId: string
  infoMarkdown: string
  rid: string
}

/** How the Feishu channel settled. */
type CardSettlement =
  | { kind: 'click', outcome: CardDecision }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

/** How the downstream (local) channel settled. */
type LocalSettlement =
  | { kind: 'local', outcome: ApprovalOutcome }
  | { kind: 'unsettled' }

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
   * The waterfall answerer. It runs the Feishu card and the local answerer side by side and
   * returns whichever decides first; the losing channel is cancelled so nobody is left
   * looking at an approval that can no longer be settled.
   *
   * A card send failure delegates to `next()` (the local panel alone answers) so the request
   * is never lost when Feishu is unreachable.
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

    // The local answerer (an open DSH panel) must see the same request, but through a signal we
    // own: the host's remote-event bridge watches this signal and, when it aborts, sends the
    // panel a `cancel` frame that dismisses its dialog. That is how the losing side is closed.
    const localCancel = new AbortController()
    const upstream = request.signal
    ;(request as { signal?: AbortSignal }).signal = upstream === undefined
      ? localCancel.signal
      : AbortSignal.any([upstream, localCancel.signal])

    const local: Promise<LocalSettlement> = this.options.answerLocally === 'race'
      ? Promise.resolve().then(() => next()).then(
        outcome => ({ kind: 'local', outcome }) as LocalSettlement,
        error => {
          // A cancellation we caused (Feishu already decided) is expected, not a failure.
          if (!localCancel.signal.aborted) {
            this.log.warn(`the local answerer failed for ${request.toolName}: ${String(error)}`)
          }
          return { kind: 'unsettled' } as LocalSettlement
        })
      : Promise.resolve({ kind: 'unsettled' } as LocalSettlement)

    const cardSettlement = new Promise<CardSettlement>(resolve => {
      let done = false
      const finish = (settlement: CardSettlement): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(rid)
        resolve(settlement)
      }
      const onAbort = (): void => finish({ kind: 'aborted' })
      const timer = setTimeout(() => finish({ kind: 'timeout' }), this.options.timeoutSeconds * 1000)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(rid, {
        settle: outcome => finish({ kind: 'click', outcome }),
        cancel: () => finish({ kind: 'aborted' }),
        timer,
        messageId,
        infoMarkdown: card.infoMarkdown,
        rid,
      })
    })

    let settlement: CardSettlement | LocalSettlement = await Promise.race([cardSettlement, local])
    // A downstream answerer that answered `unavailable` did not decide anything: keep waiting on Feishu.
    if (settlement.kind === 'local' && settlement.outcome === 'unavailable') settlement = await cardSettlement
    else if (settlement.kind === 'unsettled') settlement = await cardSettlement

    /** Closes the local dialog when Feishu produced the decision. */
    const silenceLocal = (): void => {
      if (!localCancel.signal.aborted) localCancel.abort(new Error('approval was already decided in Feishu'))
    }

    if (settlement.kind === 'local') {
      // Stop the card wait without touching the card: the patch below is the verdict.
      this.pending.get(rid)?.cancel()
      this.log.info(`approval ${rid} for ${request.toolName} decided in the local panel: ${settlement.outcome}`)
      const outcome = settlement.outcome
      const decision: DecidedCardInput['decision'] = outcome === 'cancelled'
        ? 'cancelled'
        : outcome === 'rejected' ? 'local-rejected' : 'local-allowed-once'
      void this.markDecided(rid, messageId, card.infoMarkdown, decision).catch(error => {
        this.log.warn(`updating the panel-decided card failed: ${String(error)}`)
      })
      return outcome
    }

    if (settlement.kind === 'aborted') {
      silenceLocal()
      this.log.info(`approval ${rid} for ${request.toolName} was cancelled by the requester`)
      void this.markDecided(rid, messageId, card.infoMarkdown, 'cancelled').catch(error => {
        this.log.warn(`updating the cancelled card failed: ${String(error)}`)
      })
      return 'cancelled'
    }
    if (settlement.kind === 'timeout') {
      this.log.warn(`approval ${rid} for ${request.toolName} timed out`)
      void this.markDecided(rid, messageId, card.infoMarkdown, 'timeout').catch(error => {
        this.log.warn(`updating the timed-out card failed: ${String(error)}`)
      })
      if (this.options.onTimeout !== 'unavailable') {
        silenceLocal()
        return 'rejected'
      }
      // Fallback mode still owns the untouched local chain: hand the request over exactly once.
      if (this.options.answerLocally === 'fallback') return next()
      silenceLocal()
      return 'unavailable'
    }
    silenceLocal()
    // The agent resumes at once; the card catch-up happens in the background.
    this.log.info(`approval ${rid} for ${request.toolName} decided in Feishu: ${settlement.outcome}`)
    void this.markDecided(rid, messageId, card.infoMarkdown, settlement.outcome).catch(error => {
      this.log.warn(`updating the decided card failed: ${String(error)}`)
    })
    return settlement.outcome
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
      void this.lark.patchCard(entry.messageId, decidedCard({
        infoMarkdown: entry.infoMarkdown, rid: entry.rid, decision: 'cancelled', lang: this.options.lang,
      })).catch(() => {})
      entry.cancel()
    }
  }

  /** True when the operator may decide, i.e. the allowlist is empty or contains them. */
  private permitted(operator: string): boolean {
    if (this.options.allowedOpenIds.length === 0) return true
    return operator !== '' && this.options.allowedOpenIds.includes(operator)
  }

  /** Replaces the pending card with its decided state; failures are the caller's log concern. */
  private async markDecided(rid: string, messageId: string, infoMarkdown: string,
    decision: DecidedCardInput['decision']): Promise<void> {
    await this.lark.patchCard(messageId, decidedCard({ infoMarkdown, rid, decision, lang: this.options.lang }))
  }
}
