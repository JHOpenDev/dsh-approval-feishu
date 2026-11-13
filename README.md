# dsh-approval-feishu

> 把 [DeepSeek Harness](https://www.deepseek.com/en/harness/)（DSH）的**权限审批**搬到飞书：每当 DeepSeek 要执行需要审批的操作（如沙箱提权命令），插件把审批请求发成一张飞书交互卡片，你在飞书里点「✅ 允许一次」或「❌ 拒绝」，DSH 立刻继续或停止。

```text
DSH 会话                       本插件                            飞书
────────                      ──────────────                    ────
工具需要审批
  └─ approval/request ──────▶ 发送交互卡片 ───────────────────▶ 🔐 权限审批卡
  （answerer 等待）            常驻监听 card.action.trigger ◀── 你点了「允许一次」
  ◀── allowed-once ────────── 回写卡片为「✅ 已允许」            卡片变绿
工具继续执行
```

## 工作原理

- DSH 的审批接缝是 `@deepseek-ai/dsh-user-approval` 的 `approval/request` **waterfall 事件**（宿主会把同一事件转发给已连接的 Web 面板）。本插件把自己的 answerer **prepend 到监听链最前**，然后**双通道并行**：飞书卡片和自己调起的下游本地应答者（打开中的 DSH 面板）同时等待，**先批的生效**，另一方自动收起（本地面板靠取消信号关闭，飞书卡片改写成结果态）。卡片发送失败时直接委派给本地，请求不会丢。
- 卡片按钮点击通过飞书开放平台的 **WebSocket 长连接**回来（`lark-cli event consume card.action.trigger`），不需要公网回调地址、不需要配置服务器。
- 决定落定后，插件用 `im messages patch` 把原卡片改写为结果态（绿色「已允许」/红色「已拒绝」/灰色「超时/取消/失效」），并去掉按钮，防止误点。
- 每次审批都会在会话日志里留下 `approval/asked` + `approval/decided` 审计对（由 DSH 本身保证），飞书卡片只是决定入口。

## 安装

前置：DSH `^0.2.1-rc.3`、Node `^22.19 || >=24`、pnpm，以及一个**机器人身份的 lark-cli 配置**（与 dsh-superagent 飞书 Source 共用同一个即可）。

### 方式一：从插件市场安装（推荐）

1. 打开 DSH 的 **设置 → 插件 → 发现**（Discover），添加索引 URL：

   ```text
   https://raw.githubusercontent.com/JHOpenDev/dsh-approval-feishu/master/index.json
   ```

2. 搜索「飞书审批」（或 `dsh-approval-feishu`）→ **安装**。安装走 npm（`dsh-approval-feishu@<version>`），由 DSH 的 plugin-manager 写入 profile。
3. 在 profile 的 `cordis.patch.yml` 里启用并配置 `receiveId`（见下文），重启 DSH。

### 方式二：本地源码安装

```bash
cd dsh-approval-feishu
pnpm install && pnpm check   # typecheck + 23 项测试 + 构建 lib/
```

然后在 profile 的 `package.json` 里声明 bundle 与依赖：

1. 在 profile 的 `package.json` 里声明 bundle 与依赖：

   ```jsonc
   // ~/.dsh/profiles/desktop/package.json
   "dsh": { "profile": { "bundles": [ /* …既有 bundle…, */ "dsh-approval-feishu" ] } },
   "dependencies": {
     /* …既有依赖…, */
     "dsh-approval-feishu": "file:/path/to/dsh-approval-feishu"
   }
   ```
2. `pnpm install`。
3. 在 profile 的 `cordis.patch.yml` 里启用并配置（bundle 层默认 `disabled: true`；从市场安装的包同样只需这一步）：

   ```yaml
   - id: dsh-approval-feishu
     disabled: false
     config:
       receiveId: ou_xxxx            # 你的 open_id（私聊审批）；或群 chat_id（oc_…）群内审批
       # cli: /Users/you/.local/bin/lark-bot   # 机器人身份的 lark-cli；默认 PATH 上的 lark-cli
       # allowedOpenIds: [ou_xxxx]   # 只允许这些人点按钮；留空不限制
       # timeoutSeconds: 600         # 等待审批超时（默认 10 分钟）
       # onTimeout: rejected         # 超时=拒绝；改为 unavailable 则交还给下游（如打开中的面板）
       # answerLocally: race         # race：本地面板与飞书并行、先批的生效；fallback：只在飞书失败/超时后交给本地
       # lang: zh                    # 卡片文案语言 zh/en
   ```
4. 重启 DSH。日志出现 `dsh-approval-feishu: active: approvals go to open_id ou_…` 即生效；配置前是 `waiting for configuration`（不接管任何审批）。

### 拿到你的 open_id

```bash
node bin/find-open-id.mjs --cli ~/.local/bin/lark-bot
# 然后在飞书里搜索机器人（应用名）并发送任意一条私聊消息
```

脚本会打印你的 `ou_…` 和可直接粘贴的配置片段。

## 从零开始：让审批卡片出现在你的飞书

插件本身只负责「转发审批」和「接收按钮点击」；飞书那一侧要**先有一个能收发消息的机器人**。

### 一条命令接线（推荐，全程扫码）

装好插件后（市场安装或本地安装均可），在终端运行一次：

```bash
node ~/.dsh/profiles/<你的profile>/node_modules/dsh-approval-feishu/bin/setup.mjs
```

脚本把飞书侧的接线变成两扫一选：

1. **扫第一下** —— 终端出现二维码，飞书 App 扫码，完成机器人应用的创建/授权（终端同时打印原链接，电脑上点开也可以）
2. **扫第二下** —— 用你自己的飞书身份授权；授权后脚本直接取到你的 open_id，并列出你的群
3. **选一下** —— 审批卡片发到哪里：私聊给你（默认）或选一个群；再确认是否只允许你自己点按钮

然后脚本把配置**直接写进所选 profile 的 `cordis.patch.yml`**（自动备份原文件为 `cordis.patch.yml.bak-setup`，可重复运行），并发一张测试卡片监听你的按钮点击，验证全链路。重启 DSH 即生效。

随时用 `node bin/setup.mjs --status` 查看插件的运行状态（active/passive、消费进程健康度、最后错误）——不需要去翻宿主日志。

不想扫码或企业策略不允许用户授权？跳过第二步，给机器人发一条私聊消息同样能拿到 open_id；手动流程见下文。

下面是脚本每一步背后的手动流程，适合想理解原理或脚本失败时手动排查的人。

### 手动流程

### ① 创建飞书应用（企业自建应用）

1. 打开 [飞书开放平台](https://open.feishu.cn/) → **开发者后台** → 创建**企业自建应用**，记下 `App ID`（`cli_` 开头）和 `App Secret`。
2. 在应用的 **添加应用能力** 里开启**机器人**。
3. 在 **权限管理** 里开通：
   - `im:message`（收发消息；发卡片、改写卡片用）
   - `im:message:readonly`（接收 `card.action.trigger` 按钮回调要求此权限）
4. 在 **事件与回调** 里：
   - 订阅方式选择**使用长连接接收事件**（无需公网回调地址）
   - 添加事件 **`card.action.trigger`（卡片回调）**——不加这个，点了按钮插件收不到
5. 在 **应用发布 → 版本管理与发布** 创建版本并发布；**可用范围**里要包含你自己（否则你搜不到这个机器人）。

### ② 安装并登录 lark-cli

lark-cli 是 Lark 官方 CLI（npm 包名 [`@larksuite/cli`](https://www.npmjs.com/package/@larksuite/cli)），插件通过它收发飞书消息：

```bash
npm install -g @larksuite/cli    # 需要 Node ≥ 22 在 PATH 上
```

注意：lark-cli 的启动 shim 依赖 `node` 在系统 PATH 上。如果 DSH 宿主的 PATH 里没有 Node（DSH 内置运行时不在系统 PATH），包装脚本里要显式注入（见下）。安装后用上一步的凭据初始化（Secret 从 stdin 喂，避免出现在进程列表里）：

```bash
lark-cli config init --app-id cli_xxxxxxxx --app-secret-stdin --brand feishu
# 粘贴 App Secret 后回车

lark-cli auth status        # identities.bot 应为 ready
lark-cli doctor             # 整体健康检查
```

如果这台机器上 lark-cli 还要供**你自己**（用户身份）使用，建议给机器人单独一个配置目录，写一个两行的包装脚本（插件的 `cli` 配置指向它）：

```bash
cat > ~/.local/bin/lark-bot <<'EOF'
#!/bin/sh
export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-approval"
# 若系统 PATH 没有 node（DSH 内置运行时场景），取消下一行注释并改成你的 node 路径：
# export PATH="/opt/homebrew/bin:$PATH"
exec "$HOME/.local/bin/lark-cli" "$@"
EOF
chmod +x ~/.local/bin/lark-bot
# 首次使用前：LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-dsh-approval lark-cli config init ...
```

### ③ 安装插件并配置接收者（或直接用上面的 setup.mjs）

插件默认启用：装好后即处于「静默待命」。**唯一的配置来源是 profile 的 `cordis.patch.yml` 里该插件的 `config`**（`receiveId` 为空 = 不接管任何审批）。

> 为什么没有配置文件可放？DSH 在把配置交给插件前会用插件导出的 schema 预填全部默认值，任何「外部状态文件兜底」的方案都会被默认值遮蔽（v0.2.x 的教训）。所以配置只走 profile patch 这一条被 DSH 官方支持、真机验证过的路径。

审批卡片发给谁，由 `receiveId` 决定：

- **发给你个人**（推荐）：`receiveIdType: open_id` + 你的 open_id。拿 open_id：

  ```bash
  node <插件目录>/bin/find-open-id.mjs --cli ~/.local/bin/lark-bot
  # 在飞书里给机器人发一条私聊消息，脚本会打印 ou_… 和配置片段
  ```

- **发到群里**：把机器人拉进群，`receiveIdType: chat_id` + 群的 chat_id（`lark-cli im +chat-list --as bot` 可查）。

```yaml
- id: dsh-approval-feishu
  disabled: false
  config:
    receiveId: ou_xxxx            # 上面拿到的 open_id 或 oc_ 群 id
    cli: /Users/you/.local/bin/lark-bot   # 机器人身份的 lark-cli；默认 PATH 上的 lark-cli
    allowedOpenIds: [ou_xxxx]     # 建议只允许自己点按钮
```

### ④ 重启 DSH 并验证

重启后看 DSH 日志：出现 `dsh-approval-feishu: active: approvals go to open_id ou_…` 即接入成功。然后在任意会话里让 DeepSeek 做一件需要审批的事（例如写工作区之外的文件），几秒内飞书应收到橙色审批卡片；点「✅ 允许一次」命令继续、卡片变绿，点「❌ 拒绝」操作被拒、卡片变红。

### 常见问题

| 现象 | 原因与处理 |
|---|---|
| 分不清插件是没配置、被动还是消费进程在崩 | 跑 `node bin/setup.mjs --status`（或看 `~/.dsh/dsh-approval-feishu.status.json`）：`state` 是 passive/active，`consumer` 是 running/restarting，`lastConsumerError` 有崩溃原因 |
| 日志停在 `waiting for configuration` | `receiveId` 没配或为空；按 ③ 配置 |
| 卡片发不出来，日志有 `lark-cli failed (99991672…)` 或 `missing_scopes` | 应用权限没开全；按报错里的 `missing_scopes` 列表在开发者后台补权限 |
| 卡片能收到，点按钮没反应 | 控制台没有订阅 `card.action.trigger` 事件，或没选「长连接」接收方式；补订阅后无需重启插件，消费进程会自动重连 |
| 点按钮的人不是你自己却生效了 | 未配置 `allowedOpenIds`；强烈建议配置 |
| 找不到机器人 | 应用未发布版本，或你不在可用范围里 |
| 审批迟迟不点，会话卡住 | 默认 10 分钟超时后自动拒绝（fail closed）；可在 `timeoutSeconds` 调整 |
| **点了卡片按钮没反应** | 按顺序排查：① `node bin/setup.mjs --status` 看 `lastCardAction`——有记录说明点击已到达插件（`blocked-by-allowedOpenIds` = 点击者不在白名单；`stale-card` = 卡片已失效）；② 无记录则手动挂监听 `lark-cli event consume card.action.trigger --as bot` 再点一次——仍无事件就是开发者后台缺订阅：**事件与回调 → 添加 `card.action.trigger`（长连接）→ 发布新版本生效**；③ 事件能到、插件也活跃，但 DSH 没恢复 → 看 DSH 会话里是否显示已恢复（race 模式下面板与飞书先到先得） |

## 行为细节

| 场景 | 行为 |
|---|---|
| 点击「允许一次」 | 本次工具调用放行（`allowed-once`），卡片变绿并显示决定人 |
| 点击「拒绝」 | 本次工具调用被拒（`rejected`），卡片变红 |
| 超时未处理 | 默认 `rejected` 拒绝（fail closed）；`onTimeout: unavailable` 时交还给下游 answerer |
| 会话被取消/中断（信号 abort） | 结果 `cancelled`，卡片变灰 |
| 插件重启时有未决审批 | 全部按 `cancelled` 结束，卡片变灰 |
| 点击来自旧进程的卡片 | 卡片被标记为「已失效」，不影响当前状态 |
| 本地面板先批（`answerLocally: race`，默认） | 立即按面板结果返回，飞书卡片改写成「已在 DSH 面板批准/拒绝」 |
| 飞书先批（`answerLocally: race`，默认） | 立即返回，向本地面板发取消信号收起它的审批弹窗 |
| 没有打开的面板 / 没有下游应答者 | 只等飞书，行为与单通道一致 |
| 卡片发送失败（CLI 缺失、网络等） | 记日志并 `next()` 委派给下游 answerer，面板兜底 |
| 同一会话并行多个审批 | 每个请求一张独立卡片，凭据（rid）互不相干 |
| `allowedOpenIds` 不含点击者 | 忽略该点击，日志记录 |

安全默认：**审批只放行一次**（与 DSH 语义一致）；点按钮者默认不限制，建议配置 `allowedOpenIds` 只允许自己。

## 开发

```bash
pnpm check        # tsc --noEmit + vitest + tsdown
pnpm test         # 32 项单元测试（卡片构造、审批桥接全流程、会话信息提取、配置校验）
```

结构：`src/index.ts`（插件入口与接线）· `src/answerer.ts`（审批→卡片→按钮的桥）· `src/card.ts`（卡片 JSON）· `src/lark.ts`（lark-cli 封装与事件消费循环）· `src/session-info.ts`（从会话日志提取工具调用参数）· `src/config.ts`（配置 schema）。

设计依据：`@deepseek-ai/dsh-user-approval` 的 answerer waterfall（`ctx.on('approval/request', …)`、作用域沿 scope 链向上派发）、lark-cli 卡片回调参考文档（`card.action.trigger`，WebSocket 投递、无需回调 URL）。
