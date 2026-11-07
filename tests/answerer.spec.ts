import { describe, expect, it, vi } from 'vitest'
import { FeishuApprovalBridge, type BridgeLogger, type BridgeOptions } from '../src/answerer.ts'
import type { CardActionEvent } from '../src/lark.ts'
import type { ApprovalOutcome, ApprovalRequestEvent } from '../src/types.ts'

const quietLogger: BridgeLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** A scripted LarkCli double: records patches and optionally fails sends. */
function fakeLark(options: { failSend?: boolean } = {}) {
  const patches: Array<{ messageId: string, card: Record<string, unknown> }> = []
  return {
    patches,
    sendCard: vi.fn(async (_type: string, _id: string, card: Record<string, unknown>, _key: string): Promise<string> => {
      void card
      if (options.failSend) throw new Error('send failed')
      return `om_${patches.length + 1}`
    }),
    patchCard: vi.fn(async (messageId: string, card: Record<string, unknown>): Promise<void> => {
      patches.push({ messageId, card })
    }),
  }
}

const baseOptions: BridgeOptions = {
  receiveIdType: 'open_id',
  receiveId: 'ou_me',
  allowedOpenIds: [],
  timeoutSeconds: 0.05,
  onTimeout: 'rejected',
  reasonMaxChars: 100,
  commandMaxChars: 100,
  lang: 'zh',
}

const request = (overrides: Partial<ApprovalRequestEvent> = {}): ApprovalRequestEvent => ({
  toolName: 'bash',
  callId: 'call_1',
  reason: 'install deps',
  agent: { id: 'agent-1' },
  ...overrides,
})


/** The rid embedded in the first sent card's allow button value. */
const ridOfSend = (lark: ReturnType<typeof fakeLark>): string => {
  const card = lark.sendCard.mock.calls[0]![2] as { elements: Array<{ actions?: Array<{ value: { rid: string } }> }> }
  return card.elements.at(-1)!.actions![0]!.value.rid
}

const click = (rid: string, decision: 'allow' | 'reject', operator = 'ou_me'): CardActionEvent => ({
  event_id: `evt-${rid}-${decision}-${Math.random()}`,
  message_id: 'om_card',
  operator_id: operator,
  action_tag: 'button',
  action_value: JSON.stringify({ rid, decision }),
})

function bridgeWith(lark: ReturnType<typeof fakeLark>, overrides: Partial<typeof baseOptions> = {}): FeishuApprovalBridge {
  return new FeishuApprovalBridge({ ...baseOptions, ...overrides }, lark as never, quietLogger)
}

describe('FeishuApprovalBridge.answer', () => {
  it('resolves allowed-once when an allowed user clicks allow, and patches the card decided', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark)
    const waiting = bridge.answer(request(), async () => 'unavailable')
    await vi.waitFor(() => expect(lark.sendCard).toHaveBeenCalled())
    const rid = ridOfSend(lark)
    await bridge.handleAction(click(rid, 'allow'))
    await expect(waiting).resolves.toBe('allowed-once')
    await vi.waitFor(() => expect(lark.patchCard).toHaveBeenCalled())
    expect(lark.patches[0]!.card).toMatchObject({ header: { template: 'green' } })
    expect(bridge.pendingCount).toBe(0)
  })

  it('resolves rejected when the user clicks reject', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark)
    const waiting = bridge.answer(request(), async () => 'unavailable')
    await vi.waitFor(() => expect(lark.sendCard).toHaveBeenCalled())
    const rid = ridOfSend(lark)
    await bridge.handleAction(click(rid, 'reject'))
    await expect(waiting).resolves.toBe('rejected')
  })

  it('ignores clicks from users outside allowedOpenIds and later accepts a permitted one', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark, { allowedOpenIds: ['ou_me'] })
    const waiting = bridge.answer(request(), async () => 'unavailable')
    await vi.waitFor(() => expect(lark.sendCard).toHaveBeenCalled())
    const rid = ridOfSend(lark)
    await bridge.handleAction(click(rid, 'allow', 'ou_stranger'))
    expect(bridge.pendingCount).toBe(1)
    await bridge.handleAction({ ...click(rid, 'allow'), event_id: 'evt-second' })
    await expect(waiting).resolves.toBe('allowed-once')
  })

  it('deduplicates one event id', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark)
    const waiting = bridge.answer(request(), async () => 'unavailable')
    await vi.waitFor(() => expect(lark.sendCard).toHaveBeenCalled())
    const rid = ridOfSend(lark)
    const event = click(rid, 'allow')
    await bridge.handleAction(event)
    await expect(waiting).resolves.toBe('allowed-once')
    await bridge.handleAction(event)
    expect(lark.patchCard).toHaveBeenCalledTimes(1)
  })

  it('rejects on timeout by default and marks the card timed out', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark)
    const outcome = await bridge.answer(request(), async () => 'unavailable')
    expect(outcome).toBe('rejected')
    await vi.waitFor(() => expect(lark.patchCard).toHaveBeenCalled())
    expect(lark.patches[0]!.card).toMatchObject({ header: { template: 'grey' } })
  })

  it('delegates to the next answerer on timeout with onTimeout unavailable', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark, { onTimeout: 'unavailable' })
    const next = vi.fn(async (): Promise<ApprovalOutcome> => 'unavailable')
    const outcome = await bridge.answer(request(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toBe('unavailable')
  })

  it('delegates when the card send fails', async () => {
    const lark = fakeLark({ failSend: true })
    const bridge = bridgeWith(lark)
    const next = vi.fn(async (): Promise<ApprovalOutcome> => 'unavailable')
    const outcome = await bridge.answer(request(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toBe('unavailable')
  })

  it('resolves cancelled when the request signal aborts', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark)
    const controller = new AbortController()
    const waiting = bridge.answer(request({ signal: controller.signal }), async () => 'unavailable')
    await vi.waitFor(() => expect(lark.sendCard).toHaveBeenCalled())
    controller.abort()
    await expect(waiting).resolves.toBe('cancelled')
  })

  it('marks a stale click on an unknown card and leaves pending state alone', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark)
    await bridge.handleAction(click('gone1234', 'allow'))
    await vi.waitFor(() => expect(lark.patchCard).toHaveBeenCalled())
    expect(lark.patches[0]!.card).toMatchObject({ header: { template: 'grey' } })
    expect(bridge.pendingCount).toBe(0)
  })

  it('resolves every pending request as cancelled on dispose', async () => {
    const lark = fakeLark()
    const bridge = bridgeWith(lark)
    const waiting = bridge.answer(request(), async () => 'unavailable')
    await vi.waitFor(() => expect(lark.sendCard).toHaveBeenCalled())
    bridge.dispose()
    await expect(waiting).resolves.toBe('cancelled')
    expect(bridge.pendingCount).toBe(0)
  })
})
