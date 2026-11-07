#!/usr/bin/env node
/**
 * dsh-approval-feishu 一条龙引导脚本。
 *
 * 在装了本插件的机器上运行一次，完成飞书侧的全部接线：
 *   1. 检测 lark-cli 与机器人凭据（没有则走 `config init --new`，浏览器里完成创建）
 *   2. 等你给机器人发一条私聊消息，抓取你的 open_id
 *   3. 写入 ~/.dsh/dsh-approval-feishu.json（插件启动时自动读取）
 *   4. 发一张测试审批卡片并监听按钮回调，验证全链路
 *
 * 用法：node bin/setup.mjs [--cli <lark-cli路径>] [--config-dir <lark-cli配置目录>] [--skip-test]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = name => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const ask = question => new Promise(resolve => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
})

const say = message => console.log(message)
const die = message => { console.error(`\n✗ ${message}`); process.exit(1) }

/** 运行一条 CLI 命令，返回 { code, stdout, stderr }。 */
const run = (cli, args, timeoutMs = 90_000) => new Promise(resolve => {
  const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  let stdout = ''; let stderr = ''
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  child.stdout.on('data', c => { stdout += c })
  child.stderr.on('data', c => { stderr += c })
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  child.once('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
})

const stateFile = join(homedir(), '.dsh', 'dsh-approval-feishu.json')
const defaultConfigDir = join(homedir(), '.lark-cli-dsh-approval')

say('═'.repeat(62))
say(' dsh-approval-feishu 飞书接线引导')
say('═'.repeat(62))

// ── 1. 定位 lark-cli ────────────────────────────────────────────────
let cli = flag('--cli') ?? process.env.LARK_APPROVAL_CLI
if (!cli) {
  const local = join(homedir(), '.local', 'bin', 'lark-cli')
  for (const candidate of ['/opt/homebrew/bin/lark-cli', '/usr/local/bin/lark-cli', local]) {
    if (existsSync(candidate)) { cli = candidate; break }
  }
  if (!cli) cli = 'lark-cli'
}
say(`\n① lark-cli：${cli}`)

const configDir = flag('--config-dir') ?? process.env.LARK_APPROVAL_CONFIG_DIR ?? undefined
const withConfigDir = configDir ? { ...process.env, LARKSUITE_CLI_CONFIG_DIR: configDir } : process.env
const runAs = (args, timeout) => new Promise(resolve => {
  const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...withConfigDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  let stdout = ''; let stderr = ''
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
  child.stdout.on('data', c => { stdout += c })
  child.stderr.on('data', c => { stderr += c })
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  child.once('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
})

const botReady = async () => {
  const { code, stdout } = await runAs(['auth', 'status', '--json'], 20_000)
  if (code !== 0) return false
  try { return JSON.parse(stdout)?.identities?.bot?.status === 'ready' } catch { return false }
}

if (!await botReady()) {
  say('\n   机器人凭据尚未配置。接下来会打开浏览器引导你创建（或登录）一个飞书自建应用；')
  say('   按页面提示完成后命令会自动继续。这一步会把 App Secret 写进本机 lark-cli 配置。')
  const args = ['config', 'init', '--new', '--brand', 'feishu']
  if (configDir) say(`   （使用独立配置目录 ${configDir}）`)
  const child = spawn(cli, args, { stdio: ['ignore', 'inherit', 'inherit'], env: withConfigDir })
  const code = await new Promise(resolve => { child.once('close', resolve); child.once('error', () => resolve(-1)) })
  if (code !== 0 || !await botReady()) {
    die(`lark-cli 应用初始化未完成（exit ${code}）。可手动执行：\n` +
      `    ${configDir ? `LARKSUITE_CLI_CONFIG_DIR=${configDir} ` : ''}${cli} config init --new --brand feishu`)
  }
  say('   ✓ 机器人凭据已就绪')
} else {
  say('   ✓ 机器人凭据已就绪')
}

// ── 2. 抓取用户的 open_id ──────────────────────────────────────────
say('\n② 现在请在飞书里搜索这个机器人（应用名），给它发一条私聊消息（内容任意）。')
say('   正在等待消息（最多 3 分钟）……')
let openId
{
  const { code, stdout, stderr } = await runAs(['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--max-events', '1', '--timeout', '180s'], 200_000)
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      const sender = event?.event?.sender?.sender_id?.open_id ?? event?.sender?.sender_id?.open_id
        ?? event?.sender_id?.open_id ?? event?.open_id
      if (typeof sender === 'string' && sender.startsWith('ou_')) { openId = sender; break }
    } catch { /* 非 JSON 行（ready 标记等） */ }
  }
  if (!openId) {
    die(`没有等到消息（exit ${code}${stderr.includes('ready') ? '' : '，事件订阅未就绪'}）。
    检查：应用是否已发布版本？你是否在可用范围里？然后重跑本脚本。`)
  }
}
say(`   ✓ 你的 open_id：${openId}`)

// ── 3. 写入状态文件 ────────────────────────────────────────────────
const allowOthers = (await ask('\n③ 只允许你自己点审批按钮吗？[Y/n] ')).toLowerCase()
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
state.cli = cli
if (configDir) state.configDir = configDir
state.receiveIdType = 'open_id'
state.receiveId = openId
state.allowedOpenIds = allowOthers === 'n' ? [] : [openId]
writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
say(`   ✓ 已写入 ${stateFile}`)
say('   （DSH 里的插件启动时会自动读取；也可以改为在 profile 的 cordis.patch.yml 里配置，优先级更高）')

// ── 4. 全链路测试（发卡 + 监听按钮回调） ────────────────────────────
if (flag('--skip-test')) {
  say('\n④ 已跳过测试。重启 DSH 后即生效。')
  process.exit(0)
}
say('\n④ 正在发送一张测试审批卡片……请在飞书里点「✅ 允许一次」或「❌ 拒绝」（90 秒内）。')

const card = {
  config: { wide_screen_mode: true },
  header: { template: 'orange', title: { tag: 'plain_text', content: '🔐 dsh-approval-feishu 接线测试' } },
  elements: [
    { tag: 'div', text: { tag: 'lark_md', content: '如果你能看到这张卡片并点击按钮，说明**发送与按钮回调都已打通**。' } },
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '测试卡片 · 与真实审批无关' }] },
    { tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '✅ 打通了' }, type: 'primary', value: { test: 'allow' } },
      { tag: 'button', text: { tag: 'plain_text', content: '❌ 没打通' }, type: 'danger', value: { test: 'reject' } },
    ] },
  ],
}

// 先挂上按钮回调监听，再发卡片，避免竞态。
const consumer = spawn(cli, ['event', 'consume', 'card.action.trigger', '--as', 'bot'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...withConfigDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
const lines = createInterface({ input: consumer.stdout })
let clicked = false
lines.on('line', line => {
  try {
    const event = JSON.parse(line)
    if (event?.operator_id === openId && event?.action_value) clicked = true
  } catch { /* ready 标记等 */ }
})

const send = await runAs(['im', '+messages-send', '--user-id', openId, '--msg-type', 'interactive',
  '--content', JSON.stringify(card), '--idempotency-key', `setup-${Date.now()}`])
if (send.code !== 0) {
  consumer.kill('SIGTERM')
  die(`测试卡片发送失败：\n${(send.stderr || send.stdout).slice(0, 800)}\n    多半是应用缺 im:message 发送权限，去开发者后台补齐后重跑。`)
}
say('   ✓ 卡片已发出，等待你的点击……')

setTimeout(() => {
  consumer.kill('SIGTERM')
  consumer.once('close', () => {
    if (clicked) {
      say('\n' + '═'.repeat(62))
      say(' ✅ 全链路打通！卡片发送 + 按钮回调都正常。')
    } else {
      say('\n' + '═'.repeat(62))
      say(' ⚠ 卡片已发送，但 90 秒内没收到按钮回调。')
      say('   卡片能收到 = 发送链路 OK；点按钮没反应通常是控制台缺一步：')
      say('   事件与回调 → 添加事件 card.action.trigger（使用长连接接收），并确认已开 im:message:readonly 权限。')
      say('   补好后无需重跑本脚本，直接在 DSH 里触发一次真实审批即可验证。')
    }
    say(' 最后一步：重启 DSH，让插件读到新配置。')
    say('═'.repeat(62))
    process.exit(0)
  })
}, 90_000)
