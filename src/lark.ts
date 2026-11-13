/** lark-cli subprocess adapter: card send/patch calls and the card.action.trigger event consumer. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/** One parsed `card.action.trigger` event line (only the fields this plugin reads). */
export interface CardActionEvent {
  event_id?: string
  message_id?: string
  chat_id?: string
  operator_id?: string
  action_tag?: string
  action_value?: string
  timestamp?: string
}

export interface LarkResult<T> {
  ok: boolean
  data?: T
  error?: { code?: number, message?: string }
}

export interface LarkRunnerOptions {
  /** Environment overrides; defaults to process.env with the CLI's notifier noise disabled. */
  env?: Record<string, string>
}

/** The noop environment lark-cli accepts to keep its subprocesses quiet. */
const QUIET = { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }

/** Runs lark-cli commands as the bot identity, returning parsed `{ ok, data, error }` envelopes. */
export class LarkCli {
  constructor(private readonly cli: string, private readonly options: LarkRunnerOptions = {}) {}

  private run(args: string[], timeoutMs = 90_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, [...args, '--as', 'bot', '--format', 'json'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...QUIET, ...this.options.env } })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`lark-cli timed out after ${timeoutMs / 1000}s: ${args[0]} ${args[1] ?? ''}`))
      }, timeoutMs)
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        if (code === 0) { resolve(stdout); return }
        reject(new Error(`lark-cli exited with code ${code}: ${(stderr || stdout).slice(0, 600)}`))
      })
    })
  }

  private async call<T>(args: string[]): Promise<T> {
    const output = await this.run(args)
    let parsed: LarkResult<T>
    try { parsed = JSON.parse(output) as LarkResult<T> }
    catch { throw new Error(`lark-cli printed a non-JSON envelope: ${output.slice(0, 300)}`) }
    if (!parsed.ok) throw new Error(`lark-cli failed${parsed.error?.code ? ` (${parsed.error.code})` : ''}: ${parsed.error?.message ?? 'unknown error'}`)
    return parsed.data as T
  }

  /** Sends one interactive card; returns the new message id. */
  async sendCard(receiveIdType: 'open_id' | 'chat_id', receiveId: string, card: Record<string, unknown>, idempotencyKey: string): Promise<string> {
    const flag = receiveIdType === 'open_id' ? '--user-id' : '--chat-id'
    const data = await this.call<{ message_id?: string }>(['im', '+messages-send', flag, receiveId,
      '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', idempotencyKey.slice(0, 50)])
    if (!data?.message_id) throw new Error('lark-cli card send returned no message_id')
    return data.message_id
  }

  /** Replaces a previously sent card's content (works within 14 days of sending). */
  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.call<unknown>(['im', 'messages', 'patch', '--message-id', messageId,
      '--data', JSON.stringify({ content: JSON.stringify(card) })])
  }

  /** Fetches one interactive card message's parsed card JSON; undefined when it cannot be read. */
  async getCard(messageId: string): Promise<Record<string, unknown> | undefined> {
    const data = await this.call<{ items?: Array<{ body?: { content?: string } }> }>(
      ['api', 'GET', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`])
    const content = data.items?.[0]?.body?.content
    if (typeof content !== 'string') return undefined
    try { return JSON.parse(content) as Record<string, unknown> } catch { return undefined }
  }
}

/** What the consumer hands to its owner for each parsed event line. */
export type CardActionSink = (event: CardActionEvent) => void | Promise<void>

/** The ready marker lark-cli writes on stderr once the event bus is subscribed. */
export const READY_MARKER = '[event] ready event_key='

/** Extracts one double-quoted string field from a (possibly pretty-printed) JSON text. */
const quotedField = (text: string, name: string): string | undefined =>
  new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)?.[1]

/**
 * Builds the actionable diagnostic from a failed consumer run. lark-cli prints its JSON error
 * envelope pretty-printed across several stderr lines, so the last line alone is useless
 * (typically just `}`). This recognizes the one-consumer-per-key conflict explicitly and
 * otherwise surfaces the envelope's message and hint.
 */
export const summarizeConsumerFailure = (code: number | null, ready: boolean, stderrText: string): string => {
  const conflict = /another consumer \(pid (\d+)\)/.exec(stderrText)
  if (conflict !== null) {
    return `单消费者冲突：card.action.trigger 已被另一个消费者（pid ${conflict[1]}）占用。` +
      `执行 \`lark-cli event status\` 确认；若是残留进程可 kill 它，或 \`lark-cli event stop --all\` 后等本插件自动重连（≤60 秒）。` +
      `注意：多个 DSH 实例同时启用本插件会互相争抢，只保留一个。`
  }
  const message = quotedField(stderrText, 'message')
  const hint = quotedField(stderrText, 'hint')
  const detail = message === undefined ? hint : hint === undefined || hint === message ? message : `${message}（${hint}）`
  if (detail !== undefined) return `lark-cli：${detail}`
  return `consumer exited (code ${code}, ready=${ready}): ${stderrText.trim().slice(-600) || 'no diagnostics'}`
}

/**
 * One bounded `event consume card.action.trigger` run: spawns the CLI, forwards each stdout
 * NDJSON line to the sink after the ready marker, and settles when the child exits or the
 * caller's signal aborts (stdin end + SIGTERM, like the upstream Feishu Source consumer).
 */
export function consumeCardActions(cli: string, sink: CardActionSink, signal: AbortSignal, options: LarkRunnerOptions = {}):
  Promise<{ received: number, diagnostic: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cli, ['event', 'consume', 'card.action.trigger', '--as', 'bot'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...QUIET, ...options.env } })
    const stdout = createInterface({ input: child.stdout! })
    const stderr = createInterface({ input: child.stderr! })
    let chain = Promise.resolve()
    let received = 0
    let diagnostic = ''
    let stderrText = ''
    let ready = false
    let settled = false
    const stop = (): void => { try { child.stdin?.end() } catch { /* already gone */ } child.kill('SIGTERM') }
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', stop)
      stdout.close()
      stderr.close()
      resolve({ received, diagnostic })
    }
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      diagnostic = 'Feishu card action consumer did not become ready within 45 seconds'
      stop()
    }, 45_000)
    signal.addEventListener('abort', stop, { once: true })
    stderr.on('line', (line: string) => {
      // Keep the whole stderr (bounded) so a multi-line JSON error envelope stays readable;
      // `diagnostic` keeps tracking the newest line for the ready-timeout message.
      stderrText = `${stderrText}${line}\n`.slice(-65_536)
      diagnostic = line.slice(0, 4000)
      if (line.startsWith(READY_MARKER)) { ready = true; clearTimeout(timeout) }
    })
    stdout.on('line', (line: string) => {
      chain = chain.then(async () => {
        if (line.length > 1_048_576) throw new Error('Feishu card action event exceeds 1 MiB')
        received += 1
        const parsed = JSON.parse(line) as CardActionEvent
        await sink(parsed)
      }).catch(error => { diagnostic = String(error) })
    })
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timeout); reject(error) } })
    child.once('close', code => {
      if (settled) return
      if (signal.aborted) { finish(); return }
      settled = true
      clearTimeout(timeout)
      if (timedOut) {
        // The readiness timeout fired: the shutdown envelope ("context canceled" & co) is noise,
        // the actual finding is that the bus never became ready.
        reject(new Error(`${NOT_READY_MESSAGE}（lark-cli 输出：${summarizeConsumerFailure(code, false, stderrText)}）`))
        return
      }
      reject(new Error(summarizeConsumerFailure(code, ready, stderrText)))
    })
  })
}

/** Retry backoff for the consumer loop: 1s after a run that stayed up a minute, else doubling to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

/** The finding when a consumer run was killed for never reaching the ready marker. */
export const NOT_READY_MESSAGE = '事件总线 45 秒内未就绪'

/** True when a failure diagnostic is the bus-never-ready finding. */
export const isNotReadyFailure = (message: string): boolean => message.includes(NOT_READY_MESSAGE)

/** Restarts the local event bus: `lark-cli event stop --all` (best-effort, bounded). */
const stopAllBus = (cli: string): Promise<void> => new Promise(resolve => {
  const child = spawn(cli, ['event', 'stop', '--all'], { stdio: 'ignore', env: { ...process.env, ...QUIET } })
  const timer = setTimeout(() => { child.kill('SIGTERM'); resolve() }, 15_000)
  child.once('close', () => { clearTimeout(timer); resolve() })
  child.once('error', () => { clearTimeout(timer); resolve() })
})

const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

/**
 * Extracts the conflicting consumer's pid from a failure diagnostic, in either the plugin's own
 * Chinese summary or lark-cli's raw English message.
 */
export const extractConflictingPid = (message: string): string | null =>
  /(?:消费者（pid|consumer \(pid) (\d+)\)?/.exec(message)?.[1] ?? null

/**
 * True when `pid` is a live `lark-cli event consume card.action.trigger` process — i.e. a
 * duplicate of this plugin's own channel that only exists as a leftover from an earlier plugin
 * generation, the setup script's test listener, or a manual terminal run.
 */
const isStaleCardActionConsumer = async (pid: string): Promise<boolean> => {
  if (process.platform === 'win32') return false
  const command = await new Promise<string>(resolve => {
    const child = spawn('ps', ['-p', pid, '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.once('close', () => resolve(out))
    child.once('error', () => resolve(''))
  })
  return command.includes('event consume') && command.includes('card.action.trigger')
}

/** Terminates one stale duplicate consumer; resolves false when it could not be signalled. */
const killProcess = (pid: string): Promise<boolean> => new Promise(resolve => {
  const child = spawn('kill', [pid], { stdio: 'ignore' })
  child.once('close', code => resolve(code === 0))
  child.once('error', () => resolve(false))
})

/**
 * Keeps one card action consumer alive for the plugin's lifetime: restarts it with backoff
 * while the signal is live, and reports each failure through `report`. A single-consumer
 * conflict is healed automatically: the holding process, when it is a duplicate of this very
 * channel, is terminated and the plugin re-attaches right away (the retry backoff still caps
 * the pace so two live plugin instances would alternate instead of hot-looping).
 */
export async function runCardActionConsumer(cli: string, sink: CardActionSink, signal: AbortSignal,
  options: LarkRunnerOptions, report: (message: string) => void): Promise<void> {
  let retry: number | undefined
  let notReadyRuns = 0
  while (!signal.aborted) {
    const began = Date.now()
    try {
      const { received } = await consumeCardActions(cli, sink, signal, options)
      if (signal.aborted) return
      notReadyRuns = 0
      report(`consumer exited after ${received} event(s); restarting`)
      retry = consumerRetry(retry, Date.now() - began)
    } catch (error) {
      if (signal.aborted) return
      const message = String(error)
      const pid = extractConflictingPid(message)
      if (pid !== null && await isStaleCardActionConsumer(pid) && await killProcess(pid)) {
        report(`cleared the stale duplicate consumer (pid ${pid}); re-attaching now`)
        notReadyRuns = 0
        retry = undefined
      } else if (isNotReadyFailure(message)) {
        notReadyRuns += 1
        if (notReadyRuns >= 2) {
          // Two consecutive bus-never-ready runs mean the shared bus daemon is stuck (typically
          // its WebSocket died without recovering): stop it, and the next run starts a fresh bus.
          notReadyRuns = 0
          report(`the event bus looked stuck (${NOT_READY_MESSAGE} twice); running \`lark-cli event stop --all\` and re-attaching on a fresh bus`)
          await stopAllBus(cli)
          retry = undefined
        } else {
          report(`consumer failed: ${message}`)
          retry = consumerRetry(retry, Date.now() - began)
        }
      } else {
        notReadyRuns = 0
        report(`consumer failed: ${message}`)
        retry = consumerRetry(retry, Date.now() - began)
      }
    }
    await delay(retry ?? 1000, signal).catch(() => {})
  }
}
