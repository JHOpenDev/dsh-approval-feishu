import { describe, expect, it } from 'vitest'
import { humanizeReason } from '../src/reason.ts'
import { pendingCard } from '../src/card.ts'
import type { ApprovalRequestEvent } from '../src/types.ts'

const req = (overrides: Partial<ApprovalRequestEvent> = {}): ApprovalRequestEvent => ({
  toolName: 'bash',
  ...overrides,
})

const PLUGIN_MANAGER_REASON =
  'escalate sandbox to danger-full-access: plugin_manager {"action":"set_bundle","enabled":true,"target":"@local/jianhai-ai-workbench"}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.'

describe('humanizeReason', () => {
  it('returns undefined when there is no reason', () => {
    expect(humanizeReason(req(), 'zh')).toBeUndefined()
    expect(humanizeReason(req({ reason: '   ' }), 'zh')).toBeUndefined()
  })

  it('keeps a plain human-written reason verbatim', () => {
    expect(humanizeReason(req({ reason: '需要联网查询最新数据' }), 'zh')).toBe('需要联网查询最新数据')
  })

  it('lifts the escalation prefix off a human-written body', () => {
    expect(humanizeReason(req({ reason: 'escalate sandbox to danger-full-access: keones cli 启动需要写 ~/.keones 缓存' }), 'zh'))
      .toBe('需要完整权限（在沙箱外执行） · keones cli 启动需要写 ~/.keones 缓存')
  })

  it('translates a plugin_manager enable request', () => {
    expect(humanizeReason(req({ toolName: 'plugin_manager', reason: PLUGIN_MANAGER_REASON }), 'zh'))
      .toBe('需要完整权限（在沙箱外执行） · 启用插件「jianhai-ai-workbench」 · 长期有效、所有会话可用')
  })

  it('translates disable / install / remove plugin actions', () => {
    const make = (action: string, extra = '') =>
      `escalate sandbox to danger-full-access: plugin_manager {"action":"${action}","target":"@local/demo"${extra}}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.`
    expect(humanizeReason(req({ toolName: 'plugin_manager', reason: make('set_bundle', ',"enabled":false') }), 'zh'))
      .toContain('停用插件「demo」')
    expect(humanizeReason(req({ toolName: 'plugin_manager', reason: make('install_bundle') }), 'zh'))
      .toContain('安装并启用插件「demo」')
    expect(humanizeReason(req({ toolName: 'plugin_manager', reason: make('remove_bundle') }), 'zh'))
      .toContain('卸载插件「demo」')
  })

  it('falls back to the original body when the JSON cannot be parsed', () => {
    const broken = 'escalate sandbox to danger-full-access: plugin_manager {not valid json}. Profile changes persist across sessions'
    const out = humanizeReason(req({ toolName: 'plugin_manager', reason: broken }), 'zh')!
    expect(out.startsWith('需要完整权限（在沙箱外执行） · ')).toBe(true)
    expect(out).toContain('plugin_manager {not valid json}')
  })

  it('does not translate JSON that belongs to another tool', () => {
    const reason = 'escalate sandbox to danger-full-access: 处理数据 {"action":"set_bundle"}'
    expect(humanizeReason(req({ toolName: 'bash', reason }), 'zh'))
      .toBe('需要完整权限（在沙箱外执行） · 处理数据 {"action":"set_bundle"}')
  })

  it('prefers the localized displayReason', () => {
    const request = req({ reason: 'raw english', displayReason: { en: 'raw english', zh: '已经本地化的说明' } })
    expect(humanizeReason(request, 'zh')).toBe('已经本地化的说明')
  })

  it('renders English when asked', () => {
    expect(humanizeReason(req({ toolName: 'plugin_manager', reason: PLUGIN_MANAGER_REASON }), 'en'))
      .toBe('Needs full access (runs outside the sandbox) · Enable plugin "jianhai-ai-workbench" · persists across sessions and applies to every session')
  })

  it('handles a scoped target without the @local prefix', () => {
    const reason = 'escalate sandbox to danger-full-access: plugin_manager {"action":"set_bundle","enabled":true,"target":"@acme/tools"}. Profile changes persist across sessions'
    expect(humanizeReason(req({ toolName: 'plugin_manager', reason }), 'zh')).toContain('启用插件「tools」')
  })

  it('end to end: the pending card a user sees is plain language, not the raw justification', () => {
    const card = pendingCard({
      rid: 'r1',
      request: req({ toolName: 'plugin_manager', reason: PLUGIN_MANAGER_REASON }),
      call: undefined,
      origin: {},
      reasonMaxChars: 400,
      commandMaxChars: 400,
      lang: 'zh',
    })
    expect(card.infoMarkdown).toContain('需要完整权限')
    expect(card.infoMarkdown).toContain('启用插件「jianhai-ai-workbench」')
    expect(card.infoMarkdown).not.toContain('escalate sandbox')
    expect(card.infoMarkdown).not.toContain('set_bundle')
    expect(card.infoMarkdown).not.toContain('installed Host code')
  })
})
