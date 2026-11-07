#!/usr/bin/env node
/**
 * dsh-approval-feishu 一条龙引导脚本（扫码版）。
 *
 * 在装了本插件的机器上运行一次，完成飞书侧的全部接线：
 *   1. 机器人凭据：没有则弹出 OAuth 授权链接 —— 终端同时渲染二维码，飞书 App 扫码即授权
 *   2. 用户身份登录（可选）：再扫一次码；授权后直接取到你的 open_id，并列出你的群供选择
 *   3. 选择审批卡片发到哪里：私聊给自己，或某个群
 *   4. 写入 ~/.dsh/dsh-approval-feishu.json（插件启动时自动读取）
 *   5. 发一张测试审批卡片并监听按钮回调，验证全链路
 *
 * 用法：node bin/setup.mjs [--cli <lark-cli路径>] [--config-dir <lark-cli配置目录>] [--skip-test] [--skip-login]
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
const hasFlag = name => argv.includes(name)
const ask = question => new Promise(resolve => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
})

const say = message => console.log(message)
const die = message => { console.error(`\n✗ ${message}`); process.exit(1) }
const RULE = '═'.repeat(62)

const stateFile = join(homedir(), '.dsh', 'dsh-approval-feishu.json')
const configDir = flag('--config-dir') ?? process.env.LARK_APPROVAL_CONFIG_DIR ?? undefined
const withConfigDir = configDir ? { ...process.env, LARKSUITE_CLI_CONFIG_DIR: configDir } : process.env

// ── 定位 lark-cli ──────────────────────────────────────────────────
let cli = flag('--cli') ?? process.env.LARK_APPROVAL_CLI
if (!cli) {
  const local = join(homedir(), '.local', 'bin', 'lark-cli')
  for (const candidate of ['/opt/homebrew/bin/lark-cli', '/usr/local/bin/lark-cli', local]) {
    if (existsSync(candidate)) { cli = candidate; break }
  }
  if (!cli) cli = 'lark-cli'
}

const runAs = (args, timeoutMs = 90_000) => new Promise(resolve => {
  const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...withConfigDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  let stdout = ''; let stderr = ''
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  child.stdout.on('data', c => { stdout += c })
  child.stderr.on('data', c => { stderr += c })
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  child.once('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
})

/**
 * 运行一个会打印 OAuth 验证链接并阻塞等待授权的命令。
 * 每一行原样转发到终端；一旦出现 https 链接就额外渲染终端二维码，手机飞书扫码即可授权。
 */
const runAuthorized = (args, timeoutMs) => new Promise(resolve => {
  const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...withConfigDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  let stdout = ''; let stderr = ''
  let qrShown = false
  const relay = text => {
    stdout += text
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      say(`   | ${line}`)
      if (!qrShown) {
        const url = /https?:\/\/\S+/.exec(line)?.[0]
        if (url) {
          qrShown = true
          say('\n   ┌────────── 请用「飞书 App」扫描下面的二维码完成授权 ──────────┐')
          const qr = spawn(cli, ['auth', 'qrcode', url, '--ascii'], { stdio: ['ignore', 'inherit', 'inherit'], env: withConfigDir })
          qr.once('close', () => say('   └──────────────────────────────────────────────────────────┘'))
        }
      }
    }
  }
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  child.stdout.on('data', c => relay(String(c)))
  child.stderr.on('data', c => { stderr += String(c) })
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  child.once('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
})

const botReady = async () => {
  const { code, stdout } = await runAs(['auth', 'status', '--json'], 20_000)
  if (code !== 0) return false
  try { return JSON.parse(stdout)?.identities?.bot?.status === 'ready' } catch { return false }
}
const userReady = async () => {
  const { code, stdout } = await runAs(['auth', 'status', '--json'], 20_000)
  if (code !== 0) return false
  try { return JSON.parse(stdout)?.identities?.user?.status === 'ready' } catch { return false }
}

say(RULE)
say(' dsh-approval-feishu 飞书接线引导（扫码版）')
say(RULE)
say(`\n① lark-cli：${cli}${configDir ? `（配置目录 ${configDir}）` : ''}`)

// ── 1. 机器人凭据 ──────────────────────────────────────────────────
if (await botReady()) {
  say('   ✓ 机器人凭据已就绪')
} else {
  say('\n   需要创建（或登录）一个飞书自建应用作为机器人。下面会给出授权链接和二维码，')
  say('   用「飞书 App」扫码，按页面提示完成即可，完成后本命令自动继续。')
  const init = await runAuthorized(['config', 'init', '--new', '--brand', 'feishu'], 600_000)
  if (init.code !== 0 || !await botReady()) {
    die(`应用初始化未完成（exit ${init.code}）。可手动执行：\n` +
      `    ${configDir ? `LARKSUITE_CLI_CONFIG_DIR=${configDir} ` : ''}${cli} config init --new --brand feishu`)
  }
  say('   ✓ 机器人凭据已就绪')
}

// ── 2. 用户身份登录（拿 open_id + 列群） ───────────────────────────
let openId
let chats = []
if (!hasFlag('--skip-login')) {
  if (await userReady()) {
    say('   ✓ 检测到用户身份已登录')
  } else {
    say('\n② 再扫一次码，用你自己的飞书身份授权（用于自动获取你的 open_id 并列出可选择的群）。')
    say('   不想授权也可以跳过：之后给机器人发一条私聊消息同样能拿到 open_id。')
    const skip = await ask('   输入 s 跳过，回车继续扫码：')
    if (skip.toLowerCase() !== 's') {
      const login = await runAuthorized(['auth', 'login', '--domain', 'im,contact'], 600_000)
      if (login.code !== 0) say(`   ⚠ 用户授权未完成（exit ${login.code}），改为私聊消息方式获取 open_id。`)
    }
  }
  if (await userReady()) {
    const info = await runAs(['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user'])
    try {
      const data = JSON.parse(info.stdout)?.data
      openId = data?.open_id ?? data?.user?.open_id
      if (openId) say(`   ✓ 你的 open_id：${openId}`)
    } catch { /* fall through to DM capture */ }
    const list = await runAs(['im', '+chat-list', '--as', 'user', '--types', 'group', '--page-size', '15'])
    try {
      chats = (JSON.parse(list.stdout)?.data?.chats ?? []).filter(chat => chat?.chat_id && chat?.name)
    } catch { /* group choice simply stays unavailable */ }
  }
}

// ── 3. 选择接收者 ─────────────────────────────────────────────────
say('\n③ 审批卡片发到哪里？')
let receiveIdType = 'open_id'
if (openId === undefined) {
  say('   请在飞书里给这个机器人发一条私聊消息（内容任意），正在等待（最多 3 分钟）……')
  const { code, stdout, stderr } = await runAs(['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--max-events', '1', '--timeout', '180s'], 200_000)
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      const sender = event?.event?.sender?.sender_id?.open_id ?? event?.sender?.sender_id?.open_id
        ?? event?.sender_id?.open_id ?? event?.open_id
      if (typeof sender === 'string' && sender.startsWith('ou_')) { openId = sender; break }
    } catch { /* ready 标记等非 JSON 行 */ }
  }
  if (!openId) {
    die(`没有等到消息（exit ${code}${stderr.includes('ready') ? '' : '，事件订阅未就绪'}）。
    检查：应用是否已发布版本？你是否在可用范围里？然后重跑本脚本。`)
  }
  say(`   ✓ 你的 open_id：${openId}`)
}
if (chats.length > 0) {
  say('   [1] 私聊给我（推荐）')
  for (const [index, chat] of chats.entries()) say(`   [${index + 2}] 群：${chat.name}`)
  const choice = await ask(`   选择 [1-${chats.length + 1}]，回车默认 1：`)
  const picked = Number.parseInt(choice, 10)
  if (Number.isInteger(picked) && picked >= 2 && picked <= chats.length + 1) {
    receiveIdType = 'chat_id'
    openId = chats[picked - 2].chat_id
    say(`   ✓ 已选择群：${chats[picked - 2].name}`)
  } else {
    say(`   ✓ 私聊发给 ${openId}`)
  }
} else {
  say(`   ✓ 私聊发给 ${openId}（想发到群？完成用户授权后重跑本脚本即可选择）`)
}

// ── 4. 写入状态文件 ───────────────────────────────────────────────
const allowOthers = (await ask('\n④ 只允许你自己点审批按钮吗？[Y/n] ')).toLowerCase()
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
state.cli = cli
if (configDir) state.configDir = configDir
state.receiveIdType = receiveIdType
state.receiveId = openId
state.allowedOpenIds = allowOthers === 'n' ? [] : receiveIdType === 'open_id' ? [openId] : []
writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
say(`   ✓ 已写入 ${stateFile}`)
say('   （DSH 里的插件启动时自动读取；也可改为在 profile 的 cordis.patch.yml 里配置，优先级更高）')

// ── 5. 全链路测试（发卡 + 监听按钮回调） ───────────────────────────
if (hasFlag('--skip-test')) {
  say('\n⑤ 已跳过测试。重启 DSH 后即生效。')
  process.exit(0)
}
say('\n⑤ 正在发送一张测试审批卡片……请在飞书里点「✅ 打通了」或「❌ 没打通」（90 秒内）。')

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
    if (event?.operator_id && event?.action_value) clicked = true
  } catch { /* ready 标记等 */ }
})

const send = await runAs(['im', '+messages-send', receiveIdType === 'open_id' ? '--user-id' : '--chat-id', openId,
  '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', `setup-${Date.now()}`])
if (send.code !== 0) {
  consumer.kill('SIGTERM')
  die(`测试卡片发送失败：\n${(send.stderr || send.stdout).slice(0, 800)}\n    多半是应用缺 im:message 发送权限，去开发者后台补齐后重跑。`)
}
say('   ✓ 卡片已发出，等待你的点击……')

setTimeout(() => {
  consumer.kill('SIGTERM')
  consumer.once('close', () => {
    if (clicked) {
      say(`\n${RULE}`)
      say(' ✅ 全链路打通！卡片发送 + 按钮回调都正常。')
    } else {
      say(`\n${RULE}`)
      say(' ⚠ 卡片已发送，但 90 秒内没收到按钮回调。')
      say('   卡片能收到 = 发送链路 OK；点按钮没反应通常是控制台缺一步：')
      say('   事件与回调 → 添加事件 card.action.trigger（使用长连接接收），并确认已开 im:message:readonly 权限。')
      say('   补好后无需重跑本脚本，直接在 DSH 里触发一次真实审批即可验证。')
    }
    say(' 最后一步：重启 DSH，让插件读到新配置。')
    say(RULE)
    process.exit(0)
  })
}, 90_000)
