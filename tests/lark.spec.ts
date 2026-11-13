import { describe, expect, it } from 'vitest'
import { consumerRetry, extractConflictingPid, isNotReadyFailure, NOT_READY_MESSAGE, summarizeConsumerFailure } from '../src/lark.ts'

const CONFLICT_ENVELOPE = [
  '{',
  '  "ok": false,',
  '  "identity": "bot",',
  '  "error": {',
  '    "type": "validation",',
  '    "subtype": "failed_precondition",',
  '    "message": "cannot start consumer: another consumer (pid 89628) is already running for this subscription",',
  '    "hint": "EventKey card.action.trigger allows only one consumer; run `lark-cli event status` to find the running one, then stop it before retrying"',
  '  },',
  '  "_notice": {}',
  '}',
  '',
].join('\n')

describe('summarizeConsumerFailure', () => {
  it('recognizes the single-consumer conflict and names the pid and the fix', () => {
    const summary = summarizeConsumerFailure(2, false, CONFLICT_ENVELOPE)
    expect(summary).toContain('pid 89628')
    expect(summary).toContain('event stop --all')
    expect(summary).not.toMatch(/: }$/)
  })

  it('surfaces the envelope message and hint for other failures', () => {
    const envelope = `{\n  "ok": false,\n  "error": {\n    "message": "missing scope",\n    "hint": "enable im:message:readonly"\n  }\n}\n`
    const summary = summarizeConsumerFailure(3, false, envelope)
    expect(summary).toContain('missing scope')
    expect(summary).toContain('enable im:message:readonly')
  })

  it('falls back to the stderr tail when no envelope is present', () => {
    const summary = summarizeConsumerFailure(1, false, 'lark-cli: not found\n')
    expect(summary).toContain('not found')
  })

  it('keeps the raw tail when stderr is empty', () => {
    expect(summarizeConsumerFailure(1, false, '')).toContain('no diagnostics')
  })
})

describe('extractConflictingPid', () => {
  it('reads the pid from the plugin Chinese summary and the raw English message', () => {
    expect(extractConflictingPid('单消费者冲突：card.action.trigger 已被另一个消费者（pid 89628）占用。')).toBe('89628')
    expect(extractConflictingPid('cannot start consumer: another consumer (pid 12345) is already running')).toBe('12345')
    expect(extractConflictingPid('unrelated failure without a pid')).toBeNull()
  })
})

describe('isNotReadyFailure', () => {
  it('matches the bus-never-ready finding and nothing else', () => {
    expect(isNotReadyFailure(`${NOT_READY_MESSAGE}（lark-cli 输出：……）`)).toBe(true)
    expect(isNotReadyFailure('lark-cli：context canceled')).toBe(false)
    expect(isNotReadyFailure('单消费者冲突：card.action.trigger 已被另一个消费者（pid 1）占用。')).toBe(false)
    expect(NOT_READY_MESSAGE.length).toBeGreaterThan(0)
  })
})

describe('consumerRetry', () => {
  it('backs off from 1s to 60s and resets after a healthy run', () => {
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(1000, 1000)).toBe(2000)
    expect(consumerRetry(32_000, 1000)).toBe(60_000)
    expect(consumerRetry(60_000, 61_000)).toBe(1000)
  })
})
