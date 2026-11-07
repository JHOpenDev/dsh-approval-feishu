import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, resolveConfig, stateFilePath } from '../src/config.ts'

const tempState = (state: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'approval-feishu-')), 'state.json')
  writeFileSync(path, JSON.stringify(state))
  return path
}

describe('resolveConfig', () => {
  it('resolves schema defaults when neither patch nor state file is present', () => {
    const { config, fromPatch, fromState } = resolveConfig(undefined, join(tmpdir(), 'approval-feishu-missing.json'))
    expect(config.receiveId).toBe('')
    expect(config.cli).toBe('lark-cli')
    expect(fromPatch).toBe(false)
    expect(fromState).toBe(false)
  })

  it('fills unset keys from the state file written by the setup guide', () => {
    const state = tempState({
      cli: '/opt/lark-bot', receiveId: 'ou_state', allowedOpenIds: ['ou_state'], lang: 'en', note: 'ignored',
    })
    const { config, fromState } = resolveConfig(undefined, state)
    expect(config).toMatchObject({ cli: '/opt/lark-bot', receiveId: 'ou_state', allowedOpenIds: ['ou_state'], lang: 'en', timeoutSeconds: 600 })
    expect(fromState).toBe(true)
  })

  it('lets the profile patch entry win per key over the state file', () => {
    const state = tempState({ receiveId: 'ou_state', cli: '/opt/state-cli', timeoutSeconds: 60 })
    const { config, fromPatch } = resolveConfig({ receiveId: 'oc_patch' }, state)
    expect(config.receiveId).toBe('oc_patch')
    expect(config.cli).toBe('/opt/state-cli')
    expect(config.timeoutSeconds).toBe(60)
    expect(fromPatch).toBe(true)
  })

  it('survives a corrupt or non-object state file', () => {
    const broken = join(mkdtempSync(join(tmpdir(), 'approval-feishu-')), 'broken.json')
    writeFileSync(broken, '{not json')
    expect(resolveConfig(undefined, broken).config.receiveId).toBe('')
    expect(resolveConfig(undefined, tempState([1, 2])).config.receiveId).toBe('')
  })
})

describe('Config / stateFilePath', () => {
  it('keeps the schema defaults for a bare object', () => {
    expect(Config({} as never)).toMatchObject({ receiveIdType: 'open_id', onTimeout: 'rejected', lang: 'zh' })
    expect(stateFilePath()).toContain('.dsh')
    expect(stateFilePath()).toMatch(/dsh-approval-feishu\.json$/)
  })
})
