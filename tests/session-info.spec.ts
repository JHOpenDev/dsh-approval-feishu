import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { describeToolCall, sessionOrigin } from '../src/session-info.ts'
import type { ApprovalRequestEvent } from '../src/types.ts'

const toolCall = (callId: string, name: string, args: string) => ({ type: 'tool/call', data: { callId, name, arguments: args } })

const sessionWith = (events: readonly unknown[], header: Record<string, unknown> = {}) => ({ ownEvents: () => events, header })

const requestWith = (session: unknown, callId?: string): ApprovalRequestEvent => ({ toolName: 'bash', callId, agent: { session } })

describe('describeToolCall', () => {
  it('finds the exact call by callId', () => {
    const session = sessionWith([
      toolCall('call_1', 'bash', '{"command":"ls"}'),
      toolCall('call_2', 'fs.read', '{"path":"/a"}'),
    ])
    expect(describeToolCall(requestWith(session, 'call_2'))).toEqual({ name: 'fs.read', arguments: '{"path":"/a"}' })
  })

  it('falls back to the last tool call when the request carries no callId', () => {
    const session = sessionWith([
      toolCall('call_1', 'bash', '{"command":"ls"}'),
      toolCall('call_2', 'bash', '{"command":"pwd"}'),
      { type: 'assistant/message', data: {} },
    ])
    expect(describeToolCall(requestWith(session))).toEqual({ name: 'bash', arguments: '{"command":"pwd"}' })
  })

  it('returns undefined when the callId is absent from the log, or there is no session', () => {
    const session = sessionWith([toolCall('call_1', 'bash', '{}')])
    expect(describeToolCall(requestWith(session, 'missing'))).toBeUndefined()
    expect(describeToolCall(requestWith(undefined, 'call_1'))).toBeUndefined()
  })

  it('survives sessions whose readers throw', () => {
    const session = { ownEvents: () => { throw new Error('boom') }, snapshotEvents: () => { throw new Error('boom') } }
    expect(describeToolCall(requestWith(session, 'call_1'))).toBeUndefined()
  })
})

describe('sessionOrigin', () => {
  it('reads the header id and cwd defensively', () => {
    expect(sessionOrigin(requestWith(sessionWith([], { id: 'sess-9', cwd: '/tmp/x' })))).toEqual({ session: 'sess-9', cwd: '/tmp/x' })
    expect(sessionOrigin(requestWith({ id: 'bare' }))).toEqual({ session: 'bare' })
    expect(sessionOrigin(requestWith(undefined))).toEqual({})
  })
})

describe('Config', () => {
  it('applies defaults and types the receiveId switch', () => {
    const parsed = Config({}) as Record<string, unknown>
    expect(parsed).toMatchObject({
      cli: 'lark-cli', receiveIdType: 'open_id', receiveId: '', allowedOpenIds: [],
      timeoutSeconds: 600, onTimeout: 'rejected', reasonMaxChars: 1200, commandMaxChars: 800, lang: 'zh',
    })
    expect(() => Config({ timeoutSeconds: 5 })).toThrow()
    expect(() => Config({ receiveIdType: 'email' } as never)).toThrow()
  })
})
