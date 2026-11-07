/** Plugin configuration schema and the resolved runtime view of it. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import s from '@deepseek-ai/schemastery'

export interface ApprovalFeishuConfig {
  cli: string
  receiveIdType: 'open_id' | 'chat_id'
  receiveId: string
  allowedOpenIds: string[]
  timeoutSeconds: number
  onTimeout: 'rejected' | 'unavailable'
  reasonMaxChars: number
  commandMaxChars: number
  lang: 'zh' | 'en'
}

/** Plugin configuration. Empty `receiveId` keeps the plugin loaded but passive: no answerer, no Feishu calls. */
export const Config = s.object({
  cli: s.string().default('lark-cli').description('lark-cli 命令名或绝对路径，须以机器人身份可用（例如 ~/.local/bin/lark-bot 包装脚本）。'),
  receiveIdType: s.union(['open_id', 'chat_id'] as const).default('open_id')
    .description('审批卡片的接收者类型：open_id 私聊给某个人，chat_id 发进某个群。'),
  receiveId: s.string().default('').description('审批卡片接收者：用户 open_id（ou_…）或群 chat_id（oc_…）。留空表示未配置，插件不接管任何审批。'),
  allowedOpenIds: s.array(s.string()).default([]).description('允许点击审批按钮的飞书 open_id 列表；留空表示不限制（凡是能看到卡片的人都能决定）。'),
  timeoutSeconds: s.number().min(10).max(86_400).step(1).default(600)
    .description('等待审批的超时秒数；超时后按 onTimeout 处理，并把卡片标记为超时。'),
  onTimeout: s.union(['rejected', 'unavailable'] as const).default('rejected')
    .description('超时结果：rejected 直接拒绝本次调用；unavailable 交还给下游应答者（例如打开中的 DSH 面板），没有下游则失败关闭。'),
  reasonMaxChars: s.number().min(50).max(4000).step(1).default(1200)
    .description('卡片上展示的审批原因最大字符数，超出截断。'),
  commandMaxChars: s.number().min(50).max(4000).step(1).default(800)
    .description('卡片上展示的工具调用参数最大字符数，超出截断。'),
  lang: s.union(['zh', 'en'] as const).default('zh').description('卡片文案语言。'),
}).description('把 DeepSeek Harness 的权限审批转发成飞书卡片，点击卡片按钮完成「允许一次 / 拒绝」。')

/** Validate one configuration object against the schema, returning the typed view. */
export const parseConfig = (config: unknown): ApprovalFeishuConfig => Config(config as never) as ApprovalFeishuConfig

/** Every configuration key the schema accepts, for merging and unknown-key stripping. */
const KNOWN_KEYS = ['cli', 'receiveIdType', 'receiveId', 'allowedOpenIds', 'timeoutSeconds', 'onTimeout', 'reasonMaxChars', 'commandMaxChars', 'lang']

/** Absolute path of the shared setup state file the `bin/setup.mjs` guide writes. */
export const stateFilePath = (): string => join(homedir(), '.dsh', 'dsh-approval-feishu.json')

/** Reads the setup state file, returning `{}` when absent or unparsable. */
export const readStateFile = (path = stateFilePath()): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Effective configuration: the profile patch entry wins per key, the setup state file fills the
 * rest, and schema defaults apply last. A fresh install with neither source configured resolves to
 * the empty `receiveId` passive mode.
 */
export function resolveConfig(patchConfig: unknown, statePath = stateFilePath()): { config: ApprovalFeishuConfig, fromPatch: boolean, fromState: boolean } {
  const patch = typeof patchConfig === 'object' && patchConfig !== null && !Array.isArray(patchConfig)
    ? { ...patchConfig as Record<string, unknown> } : {}
  const state = readStateFile(statePath)
  const merged: Record<string, unknown> = {}
  for (const key of KNOWN_KEYS) {
    if (key in patch) merged[key] = patch[key]
    else if (key in state) merged[key] = state[key]
  }
  return {
    config: parseConfig(merged),
    fromPatch: KNOWN_KEYS.some(key => key in patch),
    fromState: KNOWN_KEYS.some(key => key in state),
  }
}
