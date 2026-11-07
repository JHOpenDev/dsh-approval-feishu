/** Feishu card JSON builders for the pending-approval and decided states (Card 1.0). */
import type { ApprovalRequestEvent } from './types.ts'

export type Decision = 'allow' | 'reject'

/** A tool-call summary attached to the card: what exactly is being approved. */
export interface ToolCallSummary {
  name: string
  arguments?: string
}

/** Where the request came from, for the card footer. */
export interface RequestOrigin {
  session?: string
  cwd?: string
}

export interface PendingCardInput {
  rid: string
  request: ApprovalRequestEvent
  call: ToolCallSummary | undefined
  origin: RequestOrigin
  reasonMaxChars: number
  commandMaxChars: number
  lang: 'zh' | 'en'
}

export interface PendingCard {
  /** The Card 1.0 JSON to send. */
  card: Record<string, unknown>
  /** The request summary markdown, reused verbatim in the decided card. */
  infoMarkdown: string
  rid: string
}

export interface DecidedCardInput {
  /** The pending card's summary markdown. */
  infoMarkdown: string
  rid: string
  decision: 'allowed-once' | 'rejected' | 'cancelled' | 'timeout' | 'stale'
  operator?: string
  lang: 'zh' | 'en'
}

/** Removes control characters that break card layout, keeping newlines and tabs. */
export const sanitize = (text: string): string =>
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\uFEFF]/g, '')

/** Truncates to a character budget with an ellipsis marker. */
export const clamp = (text: string, max: number): string =>
  [...text].length <= max ? text : [...text].slice(0, Math.max(0, max - 1)).join('') + '…'

/** One inline lark_md line: backticks would break the inline code span, newlines collapse. */
const oneLine = (text: string): string => sanitize(text).replace(/`/g, "'").replace(/\s*\n\s*/g, ' ')

/** Renders the tool call's raw argument payload as a compact code block. */
export const summarizeArguments = (raw: string | undefined, max: number): string | undefined => {
  if (raw === undefined) return undefined
  const text = sanitize(raw.trim())
  if (!text) return undefined
  return clamp(text, max)
}

const copy = {
  zh: {
    title: '🔐 DSH 权限审批',
    tool: '工具',
    reason: '原因',
    call: '调用参数',
    session: '会话',
    cwd: '目录',
    note: (rid: string) => `dsh-approval-feishu · 凭据 ${rid} · 点击按钮完成审批`,
    allowed: '✅ 已允许（允许一次）',
    rejected: '⛔ 已拒绝',
    cancelled: '🚫 已取消（请求方撤回）',
    timeout: '⌛ 已超时，未收到审批',
    stale: '🚫 已失效（审批已不在等待中）',
    decidedBy: (operator: string) => `决定人 ${operator}`,
  },
  en: {
    title: '🔐 DSH approval',
    tool: 'Tool',
    reason: 'Reason',
    call: 'Arguments',
    session: 'Session',
    cwd: 'Directory',
    note: (rid: string) => `dsh-approval-feishu · rid ${rid} · click a button to decide`,
    allowed: '✅ Allowed once',
    rejected: '⛔ Rejected',
    cancelled: '🚫 Cancelled by requester',
    timeout: '⌛ Timed out without a decision',
    stale: '🚫 Stale (no longer awaiting approval)',
    decidedBy: (operator: string) => `Decided by ${operator}`,
  },
} as const

type Copy = typeof copy.zh

/** Builds the interactive card shown while a decision is pending, with the two decision buttons. */
export function pendingCard(input: PendingCardInput): PendingCard {
  const t: Copy = copy[input.lang] as Copy
  const { rid, request } = input
  const lines: string[] = [`**${t.tool}** \`${oneLine(request.toolName).slice(0, 80)}\``]
  const args = input.call?.arguments !== undefined ? summarizeArguments(input.call.arguments, input.commandMaxChars) : undefined
  if (args !== undefined) lines.push(`**${t.call}**\n\`\`\`\n${args}\n\`\`\``)
  const reason = request.displayReason?.zh ?? request.reason ?? request.displayReason?.en
  if (reason) lines.push(`**${t.reason}** ${oneLine(clamp(reason, input.reasonMaxChars))}`)
  if (input.origin.cwd) lines.push(`**${t.cwd}** \`${oneLine(input.origin.cwd).slice(0, 200)}\``)
  if (input.origin.session) lines.push(`**${t.session}** \`${oneLine(input.origin.session).slice(0, 80)}\``)
  const infoMarkdown = lines.join('\n')
  return {
    infoMarkdown,
    rid,
    card: {
      config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: t.title } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: infoMarkdown } },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: t.note(rid) }] },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '✅ 允许一次' }, type: 'primary',
              value: { rid, decision: 'allow' satisfies Decision } },
            { tag: 'button', text: { tag: 'plain_text', content: '❌ 拒绝' }, type: 'danger',
              value: { rid, decision: 'reject' satisfies Decision } },
          ],
        },
      ],
    },
  }
}

/** Outcome presentation for the decided card. */
const DECIDED: Record<DecidedCardInput['decision'], { template: string, text: (t: Copy) => string }> = {
  'allowed-once': { template: 'green', text: t => t.allowed },
  'rejected': { template: 'red', text: t => t.rejected },
  'cancelled': { template: 'grey', text: t => t.cancelled },
  'timeout': { template: 'grey', text: t => t.timeout },
  'stale': { template: 'grey', text: t => t.stale },
}

/** Builds the card that replaces the pending one after a decision (or timeout): no buttons, one verdict. */
export function decidedCard(input: DecidedCardInput): Record<string, unknown> {
  const t: Copy = copy[input.lang] as Copy
  const state = DECIDED[input.decision]
  const notes = [t.note(input.rid)]
  if (input.operator) notes.push(t.decidedBy(oneLine(input.operator)))
  return {
    config: { wide_screen_mode: true },
    header: { template: state.template, title: { tag: 'plain_text', content: state.text(t) } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: input.infoMarkdown } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: notes.join(' · ') }] },
    ],
  }
}
