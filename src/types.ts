/**
 * Minimal wire types for the approval seam, mirroring `@deepseek-ai/dsh-user-approval/types`
 * so this package typechecks without depending on the runtime bundle. The Cordis event
 * augmentation keeps the same signature shape as the runtime's declaration; at runtime the
 * objects arrive from the host's own ApprovalService dispatch.
 * @module types
 */

/** The closed approval outcome vocabulary; only `allowed-once` grants. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The agent surface this plugin reads: the session (for tool-call context) and its identity. */
export interface ApprovalAgent {
  readonly id?: string
  readonly session?: unknown
}

/** Client-safe approval request payload, as dispatched on the `approval/request` waterfall. */
export interface ApprovalRequestEvent {
  /** Agent on whose behalf the question is asked; requests without one fail closed upstream. */
  readonly agent?: ApprovalAgent
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /** Localized presentation supplied by the asker; never persisted. */
  readonly displayReason?: { readonly en: string, readonly [locale: string]: string }
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for one approval decision. Return an outcome to claim the
     * request or call `next()` to delegate; the host's fail-closed tail answers
     * `unavailable`. Dispatched as a waterfall scoped to the requesting agent.
     */
    'approval/request'(this: unknown, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
  }
}
