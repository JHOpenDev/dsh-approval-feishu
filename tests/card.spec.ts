import { describe, expect, it } from 'vitest'
import { clamp, decidedCard, pendingCard, sanitize, summarizeArguments } from '../src/card.ts'

const request = {
  toolName: 'bash',
  callId: 'call_1',
  reason: 'need to install dependencies',
  agent: { id: 'agent-1' },
}

describe('sanitize', () => {
  it('strips control characters but keeps newlines and tabs', () => {
    expect(sanitize('a\u0000b\u001fc\td\ne\u200bf')).toBe('abc\td\nef')
  })
})

describe('clamp', () => {
  it('keeps short text and truncates long text with an ellipsis', () => {
    expect(clamp('abc', 5)).toBe('abc')
    expect(clamp('abcdefgh', 5)).toBe('abcd…')
    expect([...clamp('abcdefgh', 5)]).toHaveLength(5)
  })
})

describe('summarizeArguments', () => {
  it('returns undefined for blank payloads and clamps long ones', () => {
    expect(summarizeArguments('   ', 10)).toBeUndefined()
    expect(summarizeArguments(undefined, 10)).toBeUndefined()
    expect(summarizeArguments('x'.repeat(30), 10)).toBe('x'.repeat(9) + '…')
  })
})

describe('pendingCard', () => {
  const built = pendingCard({
    rid: 'ab12cd34',
    request,
    call: { name: 'bash', arguments: '{"command":"npm test"}' },
    origin: { session: 'sess-1', cwd: '/tmp/work' },
    reasonMaxChars: 100,
    commandMaxChars: 100,
    lang: 'zh',
  })

  it('carries two decision buttons with the rid and decision in their values', () => {
    const actions = (built.card.elements as Array<{ tag: string, actions: Array<{ value: Record<string, string> }> }>).at(-1)!
    expect(actions.tag).toBe('action')
    expect(actions.actions.map(item => item.value)).toEqual([
      { rid: 'ab12cd34', decision: 'allow' },
      { rid: 'ab12cd34', decision: 'reject' },
    ])
  })

  it('renders the tool name, arguments code block, reason and origin', () => {
    const body = built.infoMarkdown
    expect(body).toContain('`bash`')
    expect(body).toContain('{"command":"npm test"}')
    expect(body).toContain('need to install dependencies')
    expect(body).toContain('/tmp/work')
    expect(body).toContain('sess-1')
  })

  it('falls back through displayReason and en reason text', () => {
    const localized = pendingCard({
      rid: 'r',
      request: { ...request, reason: undefined, displayReason: { en: 'escalation needed', zh: '需要提权' } },
      call: undefined,
      origin: {},
      reasonMaxChars: 100,
      commandMaxChars: 100,
      lang: 'zh',
    })
    expect(localized.infoMarkdown).toContain('需要提权')
    const englishOnly = pendingCard({
      rid: 'r',
      request: { ...request, reason: undefined, displayReason: { en: 'escalation needed' } },
      call: undefined,
      origin: {},
      reasonMaxChars: 100,
      commandMaxChars: 100,
      lang: 'zh',
    })
    expect(englishOnly.infoMarkdown).toContain('escalation needed')
  })
})

describe('decidedCard', () => {
  it('drops the buttons and colors the header by outcome', () => {
    for (const [decision, template] of [['allowed-once', 'green'], ['rejected', 'red'], ['cancelled', 'grey'], ['timeout', 'grey'], ['stale', 'grey']] as const) {
      const card = decidedCard({ infoMarkdown: 'info', rid: 'r', decision, operator: 'ou_me', lang: 'zh' })
      expect(card.header).toMatchObject({ template })
      const tags = (card.elements as Array<{ tag: string }>).map(element => element.tag)
      expect(tags).not.toContain('action')
      const note = (card.elements as Array<{ tag: string, elements?: Array<{ content: string }> }>).at(-1)!
      expect(note.elements![0]!.content).toContain('决定人 ou_me')
    }
  })
})
