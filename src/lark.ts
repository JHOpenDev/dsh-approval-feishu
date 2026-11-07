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
}

/** What the consumer hands to its owner for each parsed event line. */
export type CardActionSink = (event: CardActionEvent) => void | Promise<void>

/** The ready marker lark-cli writes on stderr once the event bus is subscribed. */
export const READY_MARKER = '[event] ready event_key='

/**
 * One bounded `event consume card.action.trigger` run: spawns the CLI, forwards each stdout
 * NDJSON line to the sink after the ready marker, and settles when the child exits or the
 * caller's signal aborts (stdin end + SIGTERM, like the upstream Feishu Source consumer).
 */
export function consumeCardActions(cli: string, sink: CardActionSink, signal: AbortSignal, options: LarkRunnerOptions = {}):
  Promise<{ received: number, diagnostic: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cli, ['event', 'consume', 'card.action.trigger', '--as', 'bot'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...QUIET, ...options.env } })
    const stdout = createInterface({ input: child.stdout! })
    const stderr = createInterface({ input: child.stderr! })
    let chain = Promise.resolve()
    let received = 0
    let diagnostic = ''
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
    const timeout = setTimeout(() => {
      diagnostic = 'Feishu card action consumer did not become ready within 45 seconds'
      stop()
    }, 45_000)
    signal.addEventListener('abort', stop, { once: true })
    stderr.on('line', (line: string) => {
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
      reject(new Error(`Feishu card action consumer exited (code ${code}, ready=${ready}): ${diagnostic}`))
    })
  })
}

/** Retry backoff for the consumer loop: 1s after a run that stayed up a minute, else doubling to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

/**
 * Keeps one card action consumer alive for the plugin's lifetime: restarts it with backoff
 * while the signal is live, and reports each failure through `report`.
 */
export async function runCardActionConsumer(cli: string, sink: CardActionSink, signal: AbortSignal,
  options: LarkRunnerOptions, report: (message: string) => void): Promise<void> {
  let retry: number | undefined
  while (!signal.aborted) {
    const began = Date.now()
    try {
      const { received } = await consumeCardActions(cli, sink, signal, options)
      if (signal.aborted) return
      report(`consumer exited after ${received} event(s); restarting`)
      retry = consumerRetry(retry, Date.now() - began)
    } catch (error) {
      if (signal.aborted) return
      report(`consumer failed: ${String(error)}`)
      retry = consumerRetry(retry, Date.now() - began)
    }
    await delay(retry ?? 1000, signal).catch(() => {})
  }
}
