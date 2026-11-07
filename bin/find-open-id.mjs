#!/usr/bin/env node
/** Prints the open_id of the first person who messages the bot, so it can be pasted into receiveId. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const cli = args.find((value, index) => args[index - 1] === '--cli') ?? process.env.LARK_APPROVAL_CLI ?? 'lark-cli'
const timeout = Number(args.find((value, index) => args[index - 1] === '--timeout') ?? 180)

const child = spawn(cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--max-events', '1', '--timeout', `${timeout}s`],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })

console.log(`等待你在飞书里给机器人发一条私聊消息（最多 ${timeout} 秒）……`)
const stdout = createInterface({ input: child.stdout })
const stderr = createInterface({ input: child.stderr })
stderr.on('line', line => { if (line.startsWith('[event] ready')) console.log('已连接事件总线，请现在给机器人发消息。') })
stdout.on('line', line => {
  if (!line.trim()) return
  let event
  try { event = JSON.parse(line) } catch { return }
  const sender = event?.event?.sender?.sender_id?.open_id ?? event?.sender?.sender_id?.open_id
    ?? event?.sender_id?.open_id ?? event?.open_id
  if (typeof sender === 'string' && sender.startsWith('ou_')) {
    console.log(`\n你的 open_id：${sender}`)
    console.log(`把它填进 profile 的 cordis.patch.yml：\n\n- id: dsh-approval-feishu\n  disabled: false\n  config:\n    receiveId: ${sender}\n`)
    child.kill('SIGTERM')
    process.exit(0)
  }
})
child.once('close', code => {
  if (code !== 0) console.error(`事件消费退出（code ${code}）；检查 lark-cli 机器人配置后重试。`)
  else console.error('超时：没有收到消息。请在飞书里找到机器人（应用名搜索）并发送任意一条消息。')
})
