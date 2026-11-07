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

## 安装（DSH 桌面端 / 任意 profile）

前置：DSH `^0.2.1-rc.3`、Node `^22.19 || >=24`、pnpm，以及一个**机器人身份的 lark-cli 配置**（与 dsh-superagent 飞书 Source 共用同一个即可）。

```bash
cd dsh-approval-feishu
pnpm install && pnpm check   # typecheck + 23 项测试 + 构建 lib/
```

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
3. 在 profile 的 `cordis.patch.yml` 里启用并配置（bundle 层默认 `disabled: true`）：

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
