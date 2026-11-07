import { describe, expect, it } from 'vitest'
import { Config, parseConfig } from '../src/config.ts'
import { maskId, statusFilePath } from '../src/status.ts'

describe('Config', () => {
  it('applies defaults and types the receiveId switch', () => {
    const parsed = Config({} as never) as Record<string, unknown>
    expect(parsed).toMatchObject({
      cli: 'lark-cli', receiveIdType: 'open_id', receiveId: '', allowedOpenIds: [],
      timeoutSeconds: 600, onTimeout: 'rejected', reasonMaxChars: 1200, commandMaxChars: 800, lang: 'zh',
    })
    expect(() => Config({ timeoutSeconds: 5 })).toThrow()
    expect(() => Config({ receiveIdType: 'email' } as never)).toThrow()
  })

  it('parseConfig surfaces the empty receiveId that marks the passive state', () => {
    // The host passes schema-filled defaults when the profile entry has no config; the empty
    // receiveId is the passive marker either way.
    expect(parseConfig(undefined).receiveId).toBe('')
    expect(parseConfig({}).receiveId).toBe('')
    expect(parseConfig({ receiveId: 'ou_x' }).receiveId).toBe('ou_x')
  })
})

describe('status helpers', () => {
  it('masks long identifiers and keeps short ones', () => {
    expect(maskId('ou_fbb4ecde883b9ad18f4c41c2eabc0931')).toBe('ou_fbb…0931')
    expect(maskId('oc_short')).toBe('oc_short')
  })

  it('names the status file under ~/.dsh', () => {
    expect(statusFilePath()).toMatch(/[/\\]\.dsh[/\\]dsh-approval-feishu\.status\.json$/)
  })
})
