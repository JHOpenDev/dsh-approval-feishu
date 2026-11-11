#!/usr/bin/env node
/**
 * dsh-approval-feishu 一条龙引导脚本（扫码版）。
 *
 * 在装了本插件的机器上运行一次，完成飞书侧的全部接线：
 *   1. 机器人凭据：没有则给出 OAuth 授权链接 —— 终端同时渲染二维码，飞书 App 扫码即授权
 *   2. 用户身份登录（可选）：再扫一次码；授权后直接取到你的 open_id，并列出你的群供选择
 *   3. 选择审批卡片发到哪里：私聊给自己，或某个群
 *   4. 把配置写进所选 profile 的 cordis.patch.yml（自动备份，可重复运行）
 *   5. 发一张测试审批卡片并监听按钮回调，验证全链路
 *
 * 查看插件运行状态：node bin/setup.mjs --status
 * 用法：node bin/setup.mjs [--cli <lark-cli路径>] [--config-dir <lark-cli配置目录>]
 *                          [--profile <名称>] [--profile-dir <绝对路径>] [--skip-test] [--skip-login]
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// ── --status：只读状态镜像，立即返回 ────────────────────────────────
const statusFile = join(homedir(), '.dsh', 'dsh-approval-feishu.status.json')
if (hasFlag('--status')) {
  say(`状态文件：${statusFile}`)
  if (!existsSync(statusFile)) {
    say('\n✗ 还没有状态记录：DSH 尚未加载过本插件（或版本 < 0.3.0）。')
    process.exit(1)
  }
  let status
  try { status = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { die('状态文件损坏（不是合法 JSON）。') }
  say(`\n插件状态：${status.state === 'active' ? 'active（已接管审批）' : 'passive（静默待命）'}`)
  for (const key of ['reason', 'receiveId', 'receiveIdType', 'consumer', 'lastConsumerError', 'pendingApprovals']) {
    if (status[key] !== undefined && status[key] !== '') say(`  ${key}: ${status[key]}`)
  }
  say(`  updatedAt: ${status.updatedAt}`)
  if (status.state === 'passive') say('\n提示：passive 表示还没配置接收者。重跑本脚本完成接线。')
  if (status.consumer === 'restarting') say('\n提示：消费进程在崩溃重启，lastConsumerError 里有原因（常见：lark-cli 缺失/无机器人凭据）。')
  process.exit(0)
}

// ── 定位 lark-cli ──────────────────────────────────────────────────
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profilesRoot = join(dshHome, 'profiles')

/** Reads the plugin block of every profile patch, so setup reuses what the runtime already uses. */
const readPluginEntries = () => {
  const entries = []
  try {
    for (const name of readdirSync(profilesRoot)) {
      const patch = join(profilesRoot, name, 'cordis.patch.yml')
      if (!existsSync(patch)) continue
      const lines = readFileSync(patch, 'utf8').split('\n')
      const start = lines.findIndex(line => /^- id: dsh-approval-feishu\s*$/.test(line))
      if (start < 0) continue
      const config = {}
      for (let index = start + 1; index < lines.length; index += 1) {
        if (/^\S/.test(lines[index])) break
        const match = /^\s+(cli|receiveIdType|receiveId|allowedOpenIds):\s*(.+?)\s*$/.exec(lines[index])
        if (!match) continue
        config[match[1]] = match[1] === 'allowedOpenIds'
          ? match[2].replace(/^\[|\]$/g, '').split(',').map(value => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
          : match[2].replace(/^['"]|['"]$/g, '')
      }
      entries.push({ name, dir: join(profilesRoot, name), config })
    }
  } catch { /* profiles root missing: nothing to reuse */ }
  return entries
}
const pluginEntries = readPluginEntries()
const knownProfiles = existsSync(profilesRoot)
  ? readdirSync(profilesRoot)
    .map(name => ({ name, dir: join(profilesRoot, name) }))
    .filter(item => existsSync(join(item.dir, 'cordis.patch.yml')))
  : []
const installed = knownProfiles.filter(item => {
  try {
    const manifest = JSON.parse(readFileSync(join(item.dir, 'package.json'), 'utf8'))
    return Boolean(manifest.dependencies?.['dsh-approval-feishu'])
  } catch { return false }
})
/** The configuration an already-wired profile gives us for free on a re-run. */
const reusedProfile = installed.find(item => pluginEntries.some(entry => entry.name === item.name && entry.config.receiveId))
const reusedConfig = reusedProfile ? pluginEntries.find(entry => entry.name === reusedProfile.name)?.config ?? {} : {}
const configuredCli = reusedProfile ? pluginEntries.find(entry => entry.name === reusedProfile.name)?.config.cli : undefined

let cli = flag('--cli') ?? process.env.LARK_APPROVAL_CLI
const cliFromProfile = !cli && Boolean(configuredCli) && (existsSync(configuredCli) || !configuredCli.includes('/'))
if (cliFromProfile) cli = configuredCli
if (!cli) {
  const local = join(homedir(), '.local', 'bin', 'lark-cli')
  for (const candidate of ['/opt/homebrew/bin/lark-cli', '/usr/local/bin/lark-cli', local]) {
    if (existsSync(candidate)) { cli = candidate; break }
  }
  if (!cli) cli = 'lark-cli'
}

const configDir = flag('--config-dir') ?? process.env.LARK_APPROVAL_CONFIG_DIR ?? undefined
const withConfigDir = configDir ? { ...process.env, LARKSUITE_CLI_CONFIG_DIR: configDir } : process.env
const ENV = { ...withConfigDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }

const runAs = (args, timeoutMs = 90_000) => new Promise(resolve => {
  const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], env: ENV })
  let stdout = ''; let stderr = ''
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  child.stdout.on('data', c => { stdout += c })
  child.stderr.on('data', c => { stderr += c })
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  child.once('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
})

/**
 * 运行一个会打印 OAuth 验证链接并阻塞等待授权的命令。
 * stdout 与 stderr 都原样转发（lark-cli 把验证链接写在 stderr）；一旦出现 https 链接就额外渲染终端二维码。
 */
const runAuthorized = (args, timeoutMs) => new Promise(resolve => {
  const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], env: ENV })
  let stdout = ''; let stderr = ''
  let qrShown = false
  const relay = text => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      say(`   | ${line}`)
      if (!qrShown) {
        const url = /https?:\/\/\S+/.exec(line)?.[0]
        if (url) {
          qrShown = true
          say('\n   ┌────────── 请用「飞书 App」扫描下面的二维码完成授权 ──────────┐')
          const qr = spawn(cli, ['auth', 'qrcode', url, '--ascii'], { stdio: ['ignore', 'inherit', 'inherit'], env: ENV })
          qr.once('close', () => say('   └──────────────────────────────────────────────────────────┘'))
        }
      }
    }
  }
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  child.stdout.on('data', c => { stdout += String(c); relay(String(c)) })
  child.stderr.on('data', c => { stderr += String(c); relay(String(c)) })
  child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  child.once('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
})

const identityReady = which => runAs(['auth', 'status', '--json'], 20_000).then(({ code, stdout }) => {
  if (code !== 0) return false
  try { return JSON.parse(stdout)?.identities?.[which]?.status === 'ready' } catch { return false }
})

say(RULE)
say(' dsh-approval-feishu 飞书接线引导（扫码版）')
say(RULE)
say(`\n① lark-cli：${cli}${configDir ? `（配置目录 ${configDir}）` : ''}${cliFromProfile ? '（沿用 profile 里已配置的 CLI）' : ''}`)

// ── 1. 机器人凭据 ──────────────────────────────────────────────────
if (await identityReady('bot')) {
  say('   ✓ 机器人凭据已就绪')
} else {
  say('\n   需要创建（或登录）一个飞书自建应用作为机器人。下面会给出授权链接和二维码，')
  say('   用「飞书 App」扫码，按页面提示完成即可，完成后本命令自动继续。')
  const init = await runAuthorized(['config', 'init', '--new', '--brand', 'feishu'], 600_000)
  if (init.code !== 0 || !await identityReady('bot')) {
    die(`应用初始化未完成（exit ${init.code}）。可手动执行：\n` +
      `    ${configDir ? `LARKSUITE_CLI_CONFIG_DIR=${configDir} ` : ''}${cli} config init --new --brand feishu`)
  }
  say('   ✓ 机器人凭据已就绪')
}

// ── 2. 用户身份登录（拿 open_id + 列群） ───────────────────────────
let userOpenId
let chats = []
// strict-mode=bot 的配置根本不允许用户身份，别让用户白扫一次码。
const strictMode = await runAs(['config', 'strict-mode'], 15_000).then(({ code, stdout }) => code === 0 ? stdout.trim() : '')
const botOnly = /strict-mode:\s*bot/i.test(strictMode)
if (botOnly && !hasFlag('--skip-login') && !await identityReady('user')) {
  say('   ⓘ lark-cli 的 strict-mode 是 bot：用不了用户身份授权，跳过扫码。')
  say('     接收者将沿用 profile 里的配置；没有配置时改为给机器人发一条私聊消息获取 open_id。')
} else if (!hasFlag('--skip-login')) {
  if (await identityReady('user')) {
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
  if (await identityReady('user')) {
    const info = await runAs(['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user'])
    try {
      const data = JSON.parse(info.stdout)?.data
      userOpenId = data?.open_id ?? data?.user?.open_id
      if (userOpenId) say(`   ✓ 你的 open_id：${userOpenId}`)
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
let receiveId = userOpenId
if (receiveId === undefined && reusedConfig.receiveId) {
  receiveId = reusedConfig.receiveId
  receiveIdType = reusedConfig.receiveIdType === 'chat_id' ? 'chat_id' : 'open_id'
  say(`   沿用 profile 里已配置的接收者：${receiveIdType} ${receiveId}`)
}
if (receiveId === undefined) {
  say('   请在飞书里给这个机器人发一条私聊消息（内容任意），正在等待（最多 3 分钟）……')
  const { code, stdout, stderr } = await runAs(['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--max-events', '1', '--timeout', '180s'], 200_000)
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      const sender = event?.event?.sender?.sender_id?.open_id ?? event?.sender?.sender_id?.open_id
        ?? event?.sender_id?.open_id ?? event?.open_id
      if (typeof sender === 'string' && sender.startsWith('ou_')) { receiveId = sender; userOpenId = sender; break }
    } catch { /* ready 标记等非 JSON 行 */ }
  }
  if (!receiveId) {
    die(`没有等到消息（exit ${code}${stderr.includes('ready') ? '' : '，事件订阅未就绪'}）。
    检查：应用是否已发布版本？你是否在可用范围里？然后重跑本脚本。`)
  }
  say(`   ✓ 你的 open_id：${receiveId}`)
}
if (chats.length > 0) {
  say('   [1] 私聊给我（推荐）')
  for (const [index, chat] of chats.entries()) say(`   [${index + 2}] 群：${chat.name}`)
  const choice = await ask(`   选择 [1-${chats.length + 1}]，回车默认 1：`)
  const picked = Number.parseInt(choice, 10)
  if (Number.isInteger(picked) && picked >= 2 && picked <= chats.length + 1) {
    receiveIdType = 'chat_id'
    receiveId = chats[picked - 2].chat_id
    say(`   ✓ 已选择群：${chats[picked - 2].name}`)
  } else {
    say(`   ✓ 私聊发给 ${receiveId}`)
  }
} else {
  say(receiveIdType === 'chat_id'
    ? `   ✓ 发到群：${receiveId}（想改成私聊？完成用户授权后重跑本脚本即可选择）`
    : `   ✓ 私聊发给 ${receiveId}（想发到群？完成用户授权后重跑本脚本即可选择）`)
}

// ── 4. 选择 profile 并把配置写进 cordis.patch.yml ─────────────────
say('\n④ 配置要写进哪个 DSH profile？')
let target
const flagProfileDir = flag('--profile-dir')
if (flagProfileDir) {
  target = { name: flagProfileDir.split('/').pop(), dir: flagProfileDir }
} else if (installed.length === 1) {
  target = installed[0]
  say(`   ✓ 检测到已安装本插件的 profile：${target.name}`)
} else if (installed.length > 1 || knownProfiles.length > 0) {
  const options = installed.length > 0 ? installed : knownProfiles
  for (const [index, item] of options.entries()) {
    const mark = installed.includes(item) ? '' : '（未安装本插件）'
    say(`   [${index + 1}] ${item.name}${mark}`)
  }
  const choice = Number.parseInt(await ask(`   选择 [1-${options.length}]：`), 10)
  target = options[Number.isInteger(choice) && choice >= 1 ? choice - 1 : 0]
} else {
  die(`在 ${profilesRoot} 下没有找到任何 DSH profile。可先用 --profile-dir <绝对路径> 指定。`)
}
if (!installed.includes(target)) {
  die(`profile「${target.name}」还没有安装 dsh-approval-feishu。请先在 DSH 插件市场安装，或在 profile 的 package.json 依赖里加上它。`)
}

const patchPath = join(target.dir, 'cordis.patch.yml')
copyFileSync(patchPath, `${patchPath}.bak-setup`)
const allowedOpenIds = userOpenId
  ? [userOpenId]
  : reusedConfig.allowedOpenIds?.length
    ? reusedConfig.allowedOpenIds
    : receiveId.startsWith('ou_') ? [receiveId] : []
const configLines = [
  `    cli: ${cli}`,
  `    receiveIdType: ${receiveIdType}`,
  `    receiveId: ${receiveId}`,
  `    allowedOpenIds: [${allowedOpenIds.join(', ')}]`,
]
const block = [
  '# dsh-approval-feishu: 审批转飞书（由 bin/setup.mjs 写入）',
  '- id: dsh-approval-feishu',
  '  disabled: false',
  '  config:',
  ...configLines,
].join('\n')

const original = readFileSync(patchPath, 'utf8')
const lines = original.split('\n')
const entryIndex = lines.findIndex(line => /^- id: dsh-approval-feishu\s*$/.test(line))
let kept = lines
if (entryIndex >= 0) {
  // 移除旧块：含其上方紧邻的注释行，以及其后所有缩进行/空行，直到下一个顶层构造。
  let start = entryIndex
  while (start > 0 && /^#/.test(lines[start - 1])) start -= 1
  let end = entryIndex + 1
  while (end < lines.length && (lines[end] === '' || /^[ \t]/.test(lines[end]))) end += 1
  kept = [...lines.slice(0, start), ...lines.slice(end)]
}
// 追加到文件末尾（顶层列表项），保持一个空行分隔。
const body = kept.join('\n').replace(/\n+$/, '')
writeFileSync(patchPath, `${body}\n\n${block}\n`)
say(`   ✓ 已写入 ${patchPath}（原文件备份为 cordis.patch.yml.bak-setup）`)

// ── 5. 全链路测试（发卡 + 监听按钮回调） ───────────────────────────
if (hasFlag('--skip-test')) {
  say('\n⑤ 已跳过测试。重启 DSH 后即生效；之后可用 `node bin/setup.mjs --status` 查看插件状态。')
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
  { stdio: ['ignore', 'pipe', 'pipe'], env: ENV })
const consumerLines = createInterface({ input: consumer.stdout })
let clicked = false
consumerLines.on('line', line => {
  try {
    const event = JSON.parse(line)
    if (event?.operator_id && event?.action_value) clicked = true
  } catch { /* ready 标记等 */ }
})

// 必须显式 --as bot：插件运行时始终用机器人身份发卡（见 lib/lark.ts）。
// 少了它，lark-cli 会跟随默认身份（auto 优先用户），于是索要用户态 scope
// im:message.send_as_user —— 那本来就不是插件需要的权限。
const send = await runAs(['im', '+messages-send', receiveIdType === 'open_id' ? '--user-id' : '--chat-id', receiveId,
  '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', `setup-${Date.now()}`, '--as', 'bot'])
if (send.code !== 0) {
  consumer.kill('SIGTERM')
  die(`测试卡片发送失败：\n${(send.stderr || send.stdout).slice(0, 800)}\n` +
    '    本步用机器人身份（--as bot）发卡，只需应用的机器人发消息权限：\n' +
    '    确认已添加机器人能力、开通 im:message、应用版本已发布且在可用范围内。')
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
    say(' 最后一步：重启 DSH。之后用 `node bin/setup.mjs --status` 确认插件已 active。')
    say(RULE)
    process.exit(0)
  })
}, 90_000)
