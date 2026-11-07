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

- DSH 的审批接缝是 `@deepseek-ai/dsh-user-approval` 的 `approval/request` **waterfall 事件**（宿主会把同一事件转发给已连接的 Web 面板）。本插件把自己的 answerer **prepend 到监听链最前**：配置生效后，每次审批都先到飞书；卡片发送失败才回退给下游（面板仍可兜底）。
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

### 一条命令接线（推荐）

装好插件后（市场安装或本地安装均可），在终端运行一次：

```bash
node ~/.dsh/profiles/<你的profile>/node_modules/dsh-approval-feishu/bin/setup.mjs
```

脚本会依次完成：检测/创建机器人凭据（没有则弹出浏览器引导创建飞书应用）→ 等你给机器人发一条私聊消息以确认你的 open_id → 把配置写入 `~/.dsh/dsh-approval-feishu.json`（插件启动时自动读取，无需改任何 YAML）→ 发一张测试卡片并监听按钮点击，验证全链路。完成后重启 DSH 即可。

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

[lark-cli](https://github.com/larksuite/lark-cli) 是 Lark 官方 CLI，插件通过它收发飞书消息。安装后用上一步的凭据初始化（Secret 从 stdin 喂，避免出现在进程列表里）：

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
exec "$HOME/.local/bin/lark-cli" "$@"
EOF
chmod +x ~/.local/bin/lark-bot
# 首次使用前：LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-dsh-approval lark-cli config init ...
```

### ③ 安装插件并配置接收者（或直接用上面的 setup.mjs）

插件默认启用：装好后即处于「静默待命」，配置有三种来源，**优先级从高到低**：

1. profile 的 `cordis.patch.yml` 里该插件的 `config`（显式配置，适合固定部署）
2. `~/.dsh/dsh-approval-feishu.json`（`bin/setup.mjs` 写入的状态文件）
3. schema 默认值（`receiveId` 为空 = 不接管任何审批）

手动配置时在 profile 的 `cordis.patch.yml` 里写。审批卡片发给谁，由 `receiveId` 决定：

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
| 日志停在 `waiting for configuration` | `receiveId` 没配或为空；按 ③ 配置 |
| 卡片发不出来，日志有 `lark-cli failed (99991672…)` 或 `missing_scopes` | 应用权限没开全；按报错里的 `missing_scopes` 列表在开发者后台补权限 |
| 卡片能收到，点按钮没反应 | 控制台没有订阅 `card.action.trigger` 事件，或没选「长连接」接收方式；补订阅后无需重启插件，消费进程会自动重连 |
| 点按钮的人不是你自己却生效了 | 未配置 `allowedOpenIds`；强烈建议配置 |
| 找不到机器人 | 应用未发布版本，或你不在可用范围里 |
| 审批迟迟不点，会话卡住 | 默认 10 分钟超时后自动拒绝（fail closed）；可在 `timeoutSeconds` 调整 |

## 行为细节

| 场景 | 行为 |
|---|---|
| 点击「允许一次」 | 本次工具调用放行（`allowed-once`），卡片变绿并显示决定人 |
| 点击「拒绝」 | 本次工具调用被拒（`rejected`），卡片变红 |
| 超时未处理 | 默认 `rejected` 拒绝（fail closed）；`onTimeout: unavailable` 时交还给下游 answerer |
| 会话被取消/中断（信号 abort） | 结果 `cancelled`，卡片变灰 |
| 插件重启时有未决审批 | 全部按 `cancelled` 结束，卡片变灰 |
| 点击来自旧进程的卡片 | 卡片被标记为「已失效」，不影响当前状态 |
| 卡片发送失败（CLI 缺失、网络等） | 记日志并 `next()` 委派给下游 answerer，面板兜底 |
| 同一会话并行多个审批 | 每个请求一张独立卡片，凭据（rid）互不相干 |
| `allowedOpenIds` 不含点击者 | 忽略该点击，日志记录 |

安全默认：**审批只放行一次**（与 DSH 语义一致）；点按钮者默认不限制，建议配置 `allowedOpenIds` 只允许自己。

## 开发

```bash
pnpm check        # tsc --noEmit + vitest + tsdown
pnpm test         # 23 项单元测试（卡片构造、审批桥接全流程、会话信息提取、配置校验）
```

结构：`src/index.ts`（插件入口与接线）· `src/answerer.ts`（审批→卡片→按钮的桥）· `src/card.ts`（卡片 JSON）· `src/lark.ts`（lark-cli 封装与事件消费循环）· `src/session-info.ts`（从会话日志提取工具调用参数）· `src/config.ts`（配置 schema）。

设计依据：`@deepseek-ai/dsh-user-approval` 的 answerer waterfall（`ctx.on('approval/request', …)`、作用域沿 scope 链向上派发）、lark-cli 卡片回调参考文档（`card.action.trigger`，WebSocket 投递、无需回调 URL）。
