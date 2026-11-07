/** Plugin entry: forwards DSH approval requests to Feishu cards and answers them from card button clicks. */
import type { Context } from '@deepseek-ai/cordis'
import { FeishuApprovalBridge, type BridgeLogger } from './answerer.ts'
import { parseConfig } from './config.ts'
import { LarkCli, runCardActionConsumer } from './lark.ts'

export const name = 'dsh-approval-feishu'
export { Config } from './config.ts'

/** Mounts the bridge when a receiver is configured; otherwise the plugin stays a logged no-op. */
export function apply(ctx: Context, config: unknown): void {
  const settings = parseConfig(config)
  const log: BridgeLogger = {
    info: message => ctx.logger.info(`dsh-approval-feishu: ${message}`),
    warn: message => ctx.logger.warn(`dsh-approval-feishu: ${message}`),
    error: message => ctx.logger.error(`dsh-approval-feishu: ${message}`),
  }
  if (!settings.receiveId.trim()) {
    log.info('waiting for configuration: set receiveId (open_id or chat_id) in the profile patch to take over approvals')
    return
  }
  const lark = new LarkCli(settings.cli)
  const bridge = new FeishuApprovalBridge({
    receiveIdType: settings.receiveIdType,
    receiveId: settings.receiveId.trim(),
    allowedOpenIds: settings.allowedOpenIds,
    timeoutSeconds: settings.timeoutSeconds,
    onTimeout: settings.onTimeout,
    reasonMaxChars: settings.reasonMaxChars,
    commandMaxChars: settings.commandMaxChars,
    lang: settings.lang,
  }, lark, log)
  // The card action consumer keeps the answer side alive for the plugin's lifetime.
  ctx.effect(() => {
    const controller = new AbortController()
    const stopped = runCardActionConsumer(settings.cli, bridge.handleAction, controller.signal, {}, message => {
      log.warn(`card action consumer: ${message}`)
    }).catch(error => { log.error(`card action consumer stopped: ${String(error)}`) })
    return async () => {
      controller.abort()
      bridge.dispose()
      await stopped
    }
  }, 'approval-feishu: card action consumer')
  // Prepended so this bridge claims the request before the host's UI forwarder: every approval
  // is decided in Feishu. A card send failure delegates (next()), so the panel still works as a fallback.
  ctx.on('approval/request', bridge.answer, true)
  log.info(`active: approvals go to ${settings.receiveIdType} ${settings.receiveId.trim()}`)
}
