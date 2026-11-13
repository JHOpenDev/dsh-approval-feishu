import { describe, expect, it } from 'vitest'
import { clamp, decidedCard, extractInfoMarkdown, pendingCard, sanitize, summarizeArguments } from '../src/card.ts'

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

  it('labels the buttons short so they stay on one row, allow first then reject', () => {
    const actions = (built.card.elements as Array<{ tag: string, actions: Array<{ text: { content: string }, type: string }> }>).at(-1)!
    expect(actions.actions.map(item => [item.text.content, item.type])).toEqual([['✅ 允许', 'primary'], ['❌ 拒绝', 'danger']])
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

describe('extractInfoMarkdown', () => {
  it('round-trips the first div lark_md and tolerates malformed cards', () => {
    const card = pendingCard({
      rid: 'r', request, call: undefined, origin: {}, reasonMaxChars: 100, commandMaxChars: 100, lang: 'zh',
    })
    expect(extractInfoMarkdown(card.card)).toBe(card.infoMarkdown)
    expect(extractInfoMarkdown(undefined)).toBe('')
    expect(extractInfoMarkdown({ elements: 'not-an-array' })).toBe('')
    expect(extractInfoMarkdown({ elements: [{ tag: 'note' }] })).toBe('')
  })
})

describe('decidedCard', () => {
  it('keeps the full info markdown so the decided card still shows what was approved', () => {
    const card = decidedCard({ infoMarkdown: '**工具** `bash`\n参数……', rid: 'r', decision: 'allowed-once', lang: 'zh' })
    const body = (card.elements as Array<{ text?: { content?: string } }>)[0]!
    expect(body.text!.content).toBe('**工具** `bash`\n参数……')
  })

  it('omits the body entirely when there is no info markdown', () => {
    const card = decidedCard({ infoMarkdown: '', rid: 'r', decision: 'stale', lang: 'zh' })
    const tags = (card.elements as Array<{ tag: string }>).map(element => element.tag)
    expect(tags).toEqual(['hr', 'note'])
  })

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
