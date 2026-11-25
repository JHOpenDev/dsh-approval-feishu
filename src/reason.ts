/** Turns DSH's technical approval reasons into plain language for the card, falling back to the original text. */
import type { ApprovalRequestEvent } from './types.ts'

type Lang = 'zh' | 'en'

/** DSH's fixed prefix on a reason that asks to escalate the sandbox to full access. */
const ESCALATE = 'escalate sandbox to danger-full-access:'
/**
 * DSH's own localized wording of the same request (its `displayReason.zh`), such as
 * "允许本次操作使用 danger-full-access 权限：…". The plugin prefers `displayReason`, so this is what most cards carry.
 */
const ESCALATE_ZH = /^允许(?:本次|这次|此)?操作(?:使用|以)?\s*danger-full-access\s*(?:权限)?\s*[：:]\s*/

const copy = {
  zh: {
    fullAccess: '需要完整权限（在沙箱外执行）',
    enable: (name: string) => `启用插件「${name}」`,
    disable: (name: string) => `停用插件「${name}」`,
    install: (name: string) => `安装并启用插件「${name}」`,
    remove: (name: string) => `卸载插件「${name}」`,
    exemption: (name: string) => `为插件「${name}」授予版本豁免`,
    impact: '长期有效、所有会话可用',
  },
  en: {
    fullAccess: 'Needs full access (runs outside the sandbox)',
    enable: (name: string) => `Enable plugin "${name}"`,
    disable: (name: string) => `Disable plugin "${name}"`,
    install: (name: string) => `Install and enable plugin "${name}"`,
    remove: (name: string) => `Remove plugin "${name}"`,
    exemption: (name: string) => `Grant a version exemption for plugin "${name}"`,
    impact: 'persists across sessions and applies to every session',
  },
} as const

/**
 * Extracts the first balanced JSON object from `s`, tolerating braces inside its string values.
 * Returns the object text and whatever follows it, so a trailing fixed sentence can be translated too.
 */
const extractJson = (s: string): { json: string, rest: string } | undefined => {
  const start = s.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (escaped) { escaped = false; continue }
    if (c === '\\') { escaped = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { json: s.slice(start, i + 1), rest: s.slice(i + 1) }
    }
  }
  return undefined
}

/** Strips the npm scope (`@local/`, `@scope/`) so the card shows a readable plugin name. */
const bareName = (target: unknown): string | undefined =>
  typeof target === 'string' && target ? target.replace(/^@[^/]+\//, '') : undefined

/**
 * Translates a tool's own fixed justification into plain language. Returns undefined when the body is not a
 * recognized machine-written format, so the caller keeps the original text (often already a human-written reason).
 */
const translateByTool = (toolName: string, body: string, lang: Lang): string | undefined => {
  const t = copy[lang]
  if (toolName === 'plugin_manager') {
    const extracted = extractJson(body)
    if (!extracted) return undefined
    let args: { action?: unknown, target?: unknown, enabled?: unknown }
    try { args = JSON.parse(extracted.json) } catch { return undefined }
    const name = bareName(args.target)
    if (!name) return undefined
    const action = typeof args.action === 'string' ? args.action : ''
    let verb: string | undefined
    switch (action) {
      case 'set_bundle':
      case 'set_plugin':
        verb = args.enabled === false ? t.disable(name) : t.enable(name)
        break
      case 'install_bundle': verb = t.install(name); break
      case 'remove_bundle': verb = t.remove(name); break
      case 'set_version_exemption': verb = t.exemption(name); break
      default: return undefined
    }
    // The fixed trailing sentence about profiles and the sandbox becomes a short impact note.
    const impact = /persist across sessions/i.test(extracted.rest) ? ` · ${t.impact}` : ''
    return `${verb}${impact}`
  }
  return undefined
}

/**
 * The card's human-readable reason. Prefers the asker's localized text; otherwise lifts the escalation prefix into a
 * plain-language note and translates machine-written justifications, keeping any human-written body verbatim.
 * Returns undefined only when the request carries no reason at all.
 */
export function humanizeReason(request: ApprovalRequestEvent, lang: Lang): string | undefined {
  const t = copy[lang]
  const raw = request.displayReason?.[lang] ?? request.displayReason?.zh ?? request.reason ?? request.displayReason?.en
  if (!raw || !raw.trim()) return undefined

  let body = raw.trim()
  let escalated = false
  if (body.toLowerCase().startsWith(ESCALATE)) {
    escalated = true
    body = body.slice(ESCALATE.length).trim()
  } else {
    const localized = ESCALATE_ZH.exec(body)
    if (localized) {
      escalated = true
      body = body.slice(localized[0].length).trim()
    }
  }

  const specific = translateByTool(request.toolName, body, lang)
  const parts: string[] = []
  if (escalated) parts.push(t.fullAccess)
  parts.push(specific ?? body)
  return parts.join(' · ')
}
