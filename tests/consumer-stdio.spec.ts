import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consumeCardActions, READY_MARKER } from '../src/lark.ts'

/**
 * A fake lark-cli that mimics the newer behavior the bug report came from: it prints the ready marker, then exits as
 * soon as its stdin ends. With an ignored stdin (the old code) the consumer died right after ready; a piped stdin
 * keeps it alive until the caller aborts.
 */
const FAKE_CLI = `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(READY_MARKER)} + 'card.action.trigger\\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1000)
`

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('consumeCardActions stdin lifecycle', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

  it('keeps the consumer alive on a piped stdin, then stops on abort', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fake-lark-'))
    const cli = join(dir, 'lark-cli')
    writeFileSync(cli, FAKE_CLI)
    chmodSync(cli, 0o755)

    const controller = new AbortController()
    let settled = false
    const done = consumeCardActions(cli, () => {}, controller.signal)
      .then(value => { settled = true; return { ok: true as const, value } })
      .catch(error => { settled = true; return { ok: false as const, error } })

    // Long enough for a stdin-EOF-exiting consumer to have died; a healthy one must still be running.
    await sleep(800)
    expect(settled).toBe(false)

    controller.abort()
    const result = await done
    expect(result.ok).toBe(true)
  }, 10_000)
})
