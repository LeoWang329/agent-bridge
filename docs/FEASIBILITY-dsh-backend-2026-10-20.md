# DSH（DeepSeek Harness）能不能接到 Agent Bridge 里 —— 可行性评估

**日期**：2026-10-20
**评估对象**：DeepSeek Harness（DSH）0.2.1-rc.2（桌面版安装在本机；`dsh` CLI 在 PATH 上）
**问题**：把 DSH 接到 agent-bridge 这个项目里，可行吗？怎么接？

**怎么做的这份评估**：三条独立调研线 + 两组真机打样，结论逐条回到代码/实跑：

1. **桥这一侧**：读 `scripts/agent-bridge.mjs`（7425 行、零依赖）与三份已有后端设计文档（claude/cursor/kimi），提炼"新增一个后端到底要交什么"的契约。
2. **DSH 这一侧**：把安装包 `resources/app.asar` 里 306 个 `@deepseek-ai/*` 包（0.2.1-rc.2，含 README 与编译后源码）抽出来静态读；并**真机跑通** `dsh --profile acp` 的完整 ACP 握手、会话、流式、取消、跨进程恢复、权限、模型/推理强度、只读沙箱，以及 `dsh --profile headless` 挂 agent-bridge MCP 的端到端调用。
3. **反向方向**：DSH 当 agent-bridge 的**客户端**（挂 MCP server + 装 5 个 skills）——已真机验证跑通。

**证据标记**：`[实测]` = 本机真跑得到；`[源码]` = 读 DSH 0.2.1-rc.2 发布源码/文档得到；`[桥内]` = agent-bridge 代码/文档；`[推断]` = 有依据但未实测。详细证据见附录 A。

---

## 一句话结论

**能接，而且比预期顺。**

DSH 0.2.1-rc.2 自带一个**为自动化客户端设计的持久会话协议面**——`dsh --profile acp`（Agent Client Protocol，NDJSON JSON-RPC over stdio）。本机实测它把 agent-bridge 想要的几乎每件事都做到了：**一个进程多会话、每会话独立模型/推理强度、流式文本/思考/工具/上下文用量、优雅取消（取消后会话继续可用）、会话关闭、跨进程恢复、每会话真 system prompt 注入、Windows 上能真正拦住工具写盘的只读档（工具面边界，见 §4 R3）**。

按性价比给两条路：

| 方向 | 做什么 | 工作量 | 结论 |
|---|---|---|---|
| **A（主）** | 新增第六个后端 `dsh`：桥 → DSH | **1.4–1.8k 行 / 4–6 人日核心 + 2–3 人日评审/真机/文档** | **推荐**；**已实施（v0.12.0, 2026-10-20）**，见下 |
| **B（顺带）** | DSH 当客户端：给它挂 agent-bridge 的 MCP server + 装 5 个 skills | **纯配置，0 代码，20–40 分钟**（已实测跑通） | 顺手就能做，让 DSH 也能指挥现有多引擎 |

**状态更新（v0.12.0, 2026-10-20）：方向 A 已实施。** 第六个后端 `dsh` 已合入 `scripts/agent-bridge.mjs`：`DshAcpSession`（持久 ACP 进程、每会话 `model` + `reasoning_effort`、真 system prompt 的每会话 `--patch`、权限应答器、`usage_update` 上下文用量、cancel/abort/close 不变量）+ 注册表/`doctor`/launcher 解析（含 Windows 空格路径直起 Electron-in-node-mode）+ 清理 matcher（必须同时命中 `--profile acp`，不误杀桌面 GUI）+ pid record。证据：hermetic 套件 `tests/repro-dsh.mjs`（94 项，wire 级 fake 驱动真桥）与真机 e2e 用例 `tests/e2e-dsh.mjs`（有真 DSH 才跑，否则自动 skip）均已落地；同批修掉方向 B 暴露的 **R12**（Electron 宿主下 owner 存活判定误杀，回归 `tests/repro-owner-electron-argv0.mjs`）。设计与真机约束以 [DESIGN-dsh-backend-2026-10-20.md](DESIGN-dsh-backend-2026-10-20.md) 为准；**本评估其余内容保留为当时的可行性记录**（§二/§三/§八里"待 spike / 待决策"的条目按评估当时的口径读）。

**不推荐**把 `dsh --profile headless`（一次性任务）当主方案：它没有持久会话（每轮新进程；`--session-id` 只能恢复已存在会话）、默认不加载桌面保存的凭据（要 patch 才能恢复）、每轮多一次标题 LLM 调用。它只适合 v0 冒烟，或作为无 ACP 老版本的兜底。DSH 自己的 `--profile sdk` 面也被排除（无 cancel/close/逐轮结果，模型与强度是进程级，协议明确不承诺稳定——见 §2.3）。

---

## 一、先分清两个"接入方向"

"把 DSH 接进这个项目"有两种完全不同的含义，结论不同：

- **方向 A：DSH 成为 agent-bridge 的后端**（`agent_bridge_open_session({ agent: "dsh" })`）。收益：Claude Code / Codex / DSH 以及圆桌 / loop / graph 都能把活派给 DSH——尤其是**用 DSH（DeepSeek 官方 harness）做第二意见、异构评审、图节点引擎**；5 个消费方全部自动获得新引擎。
- **方向 B：DSH 成为 agent-bridge 的客户端**（DSH 里出现 `agent_bridge_*` 8 个工具 + 5 个 skill）。收益：日常用 DSH 当主 agent 的人，可以直接在 DSH 里指挥 OMP/Codex/Claude/Cursor/Kimi。

两者不冲突，可以都做。§2–§4 是方向 A，§5 是方向 B。

---

## 二、方向 A 的证据：`dsh --profile acp`

### 2.1 协议面事实 `[源码+实测]`

- 入口：`dsh --profile acp`。profile 首次使用**自动初始化**到 `~/.dsh/profiles/acp`（bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-acp-app`），用户零配置。
- 传输：**newline-delimited JSON-RPC 2.0 over stdio** `[实测]`（`dsh-acp/lib/index.js` 直接 import ACP SDK 的 `ndJsonStream` `[源码]`）。这一条很关键：桥现有 Codex 后端就是手写 NDJSON JSON-RPC（`scripts/agent-bridge.mjs:3488-3516`），骨架可近乎 1:1 复用；桥零依赖（无 package.json），不能引 `@agentclientprotocol/sdk`，但需要手写的部分（~100–150 行）与现有 codex 代码同构。
- 方法集 `[实测]`：`initialize` / `session/new` / `session/prompt` / `session/cancel`（通知）/ `session/set_config_option` / `session/close`，另有 `session/list` / `session/resume`（DSH 在 ACP 标准上扩展了 close/list/resume）。服务端 → 客户端：`session/update` 通知、`session/request_permission` 请求。
- ACP profile 组合里**没有 `mcp-client` 行**（`dsh --profile acp --dump-config` 实测，377 行只看到 `mcp-resources`）⇒ 桥传 `mcpServers: []` 时，被委派会话默认**没有任何 MCP**，不会嵌套拉起 agent-bridge 自己。

### 2.2 逐项能力实测（2026-10-20，脚本与原始帧见附录 A）

| 能力 | 实测结果 |
|---|---|
| 握手/启动 | `initialize` → `{protocolVersion:1, agentInfo:{name:"deepseek-harness-acp",version:"0.0.1"}, agentCapabilities:{sessionCapabilities:{close:{},list:{},resume:{}}}}`；**进程启动+握手 ≈ 2.2–3.3 s** |
| 新建会话 | `session/new {cwd:"D:\\cc\\agent-bridge", mcpServers:[]}` → `{sessionId:"<uuid>", configOptions:[...]}`，**257–428 ms**；`cwd` 必须绝对路径，`additionalDirectories` 被拒 |
| 每会话模型 | `configOptions.model` 的值是**不透明 JSON 串**：`["deepseek-official","deepseek-v4-flash"]`（部署默认）、`["deepseek-official","deepseek-flash"]`（DeepSeek-V4.1-Flash）、`["deepseek-official","deepseek-v4-pro"]`；另有 `deepseek-account` provider 分组。`session/set_config_option {configId:"model", value:'["deepseek-official","deepseek-v4-pro"]'}` **实测生效** |
| 每会话推理强度 | `configOptions.reasoning_effort` = `off / low / high / max`（默认 high）；`set_config_option` 生效；prompt 会为整轮**快照并锁定**该选择，改变下一轮生效 |
| 流式输出 | `session/update`：`agent_message_chunk`（正文）、`agent_thought_chunk`（思考）、`tool_call` / `tool_call_update`（工具生命周期）、**`usage_update {used: 8813, size: 1000000}`**（上下文用量）。注意：update 是"已提交内容"的投影，**不是逐 token 流**；每轮 `agent_message_chunk` 条数取决于模型分块 |
| 取结果 | `session/prompt` 在**整轮结束时**才返回 `{stopReason:"end_turn"}` —— 没有 turn-start ACK，桥需自己 mint turn id |
| 取消 | `session/cancel` 通知 → 在途 `session/prompt` **11 ms** 内返回 `{stopReason:"cancelled"}`，**会话仍可继续用**（随后一轮正常返回） |
| 关闭 | `session/close` → `{}`；关 stdin 后进程 exit 0 |
| 跨进程恢复 | 新进程 `session/resume {sessionId,cwd,mcpServers}` → 315 ms 恢复，模型能回忆起上一个进程里记的暗号（KIWI-77） |
| 并发 | 同一进程 2 个会话并发：模型选择 A=pro / B=flash **互不串**，两轮 prompt 并发完成（≈2.1 s），更新按 sessionId 分流 |
| system prompt 注入 | 启动加 `--patch <yaml>`，把 `system-prompt.personaSuffix` 设为角色文本 → 模型答出注入的 SECRET-CODE（**真 system prompt**，非首轮软前缀） |
| 只读档 | env `DSH_PERMISSION_MODE=read-only` → 写文件被 `[sandbox: file access denied under read-only mode]` **拦下**（文件工具走 `dsh-fs-sandbox` 策略围栏，非内核沙箱；shell 走 ACL 受限令牌且 enforcement 报 `partial`——见 §4 R3）；若客户端把权限请求答成 allow-once，则**可通过升级写成功** ⇒ 只读档必须由桥拒绝权限请求（或 patch `approval.policy=never`，实测同样拦死且不再发权限请求） |
| 凭据 | ACP profile **保留桌面保存的凭据**（不需要 `DEEPSEEK_API_KEY` 环境变量）。注意：恢复凭据存储后，**保存的 GUI key 优先级高于环境变量**——想强制用 env key 就要 disable 三行凭据插件（见 §6） |
| 进程树/内存 | 一条 `dsh --profile acp` 进程树 ≈ `cmd.exe` 8 MB + `DeepSeek Harness.exe` **252 MB**（2 个会话时） |
| doctor 探测 | `dsh -V` → `0.2.1-rc.2`，**238 ms**；`dsh --profile acp --help` exit 0（≈1.7–2.0 s，首次会初始化 profile），可作"该版本支不支持 ACP"的能力探测 |

**两个必须处理的边上问题**：

1. **stdout 不纯** `[实测]`：会话创建时会有一行非 JSON 诊断（`[llm-deepseek-account] model listing from https://api.deepseek.com/models ...`）。桥解析器必须"跳过并记日志，不崩"；`--patch` 里 disable `llm-deepseek-account` 后该噪音消失（实测）。
2. **清理匹配器不能只看进程名** `[源码+桥内]`：`DeepSeek Harness.exe` 同时是桌面 GUI 的进程名。桥的 orphan 清理靠命令行签名匹配（`scripts/agent-bridge.mjs:289-291`，明确标为 SECURITY BOUNDARY），dsh 的 matcher 必须同时要求 `app.asar`/`cli.js` 片段 **且** `--profile acp`，否则可能把用户正在用的 GUI 杀掉（`dsh --profile desktop` 这条命令本身是被 CLI 拒绝的，这也是天然的保护）。

### 2.3 为什么不用 DSH 的另外两个面 `[源码]`

| 面 | 结论 |
|---|---|
| `--profile sdk` / `sdk-minimal` | **不适合**：只有 `initialize/session/prompt/resume/wait/shutdown`（外加 `session/working-directory/get\|set`）；**没有 cancel、没有 per-session close、没有逐轮结果**（客户端得自己定义"一轮结束"）；`model`/`reasoningEffort` 是 `initialize` 级、**进程级**（对所有会话生效）；无上下文用量投影；服务端→客户端请求是死能力（权限只能 fail-closed）；协议标注"pre-release，不承诺兼容"；`sdk-minimal` 默认 `danger-full-access` 且缺 base 服务 |
| `--profile headless`（一次性） | **只作兜底**：每轮新进程；`--json` 是 NDJSON（`session/status/text/thinking/tool_call/tool_result/final/error`，除 `final` 外字符串截断 8 KiB、单行 32 KiB）；`--session-id` 只能恢复**已存在**会话（且拒绝 preset/subagent/cwd 不符）；默认禁用存下来的凭据（env → `<cwd>/.env` → `$DSH_HOME/.env`，可用 patch 恢复——本次实测过）；模型/强度只能靠 `--patch` 改 `agent-default-model`；每轮多一次标题 LLM 调用 |

---

## 三、方向 A 的设计：一个 `DshAcpSession`（持久 JSON-RPC）

**选型**：持久 ACP（模板 = `CodexAppServerSession`，`scripts/agent-bridge.mjs:3312-4134`，823 行），**不是** headless 每轮一进程（模板 = `KimiCodeSession`，`:5347-5950`）。理由：会话/模型/推理强度/取消/上下文用量/权限都是桥现有语义里的一等公民，而 ACP 全部原生支持；kimi 设计文档附录 A 本来就把 ACP 列为"将来需要持久进程 + 标准协议时再做"，DSH 正是这个场景。

### 3.1 会话 ↔ 协议映射（全部 `[实测]`）

| 桥的语义 | DSH ACP 对应 |
|---|---|
| `open_session`（含 model/effort/access/append_system_prompt_file） | spawn `dsh --profile acp --patch <临时patch>`；env `DSH_PERMISSION_MODE=<read/write 档>`；`initialize`；`session/new {cwd, mcpServers:[]}`；对返回的 `configOptions` 做断言/映射后 `session/set_config_option` 钉 model 与 reasoning_effort |
| `send_message` | `session/prompt {sessionId, prompt:[{type:"text",text}]}`；桥层立即回 ack（协议层 `session/prompt` 要到**轮末**才返回——见下行） |
| 流式/progress | `session/update` → `lastAssistantText` 追加正文；`agent_thought_chunk` 只进事件/日志；`tool_call*` 进事件 |
| `wait`/`result` | `session/prompt` 返回 `{stopReason}` 即本轮结算；`end_turn` → 正常，`cancelled` → aborted，其余（max_tokens/refusal…）→ failed（带原因） |
| `contextUsage` | 取最后一个 `usage_update` → `{tokens: used, live: true}`（会成为**第 4 个能给非 null 值的后端**，比 cursor/kimi 的恒 `null` 强） |
| `abort` | `session/cancel` 通知 → 等 `prompt` 返回 cancelled（11 ms）；会话保留可复用 |
| `close_session` | `session/close` → stdin EOF → 等进程 exit 0；超时/强杀兜底 `taskkill /T`。**注意桥的 `close()` 是同步语义**：协议清理要"先返回、后台异步收尾"，不能 await 整个退出流程 |
| `append_system_prompt_file` | 生成临时 `--patch`，把文件内容写进 `system-prompt.personaSuffix`（**真 system prompt**，档位与 omp/claude 同级，优于 cursor/kimi 的首轮软前缀） |
| `access: "read"` | env `DSH_PERMISSION_MODE=read-only` + **拒绝**所有 `session/request_permission`（或 patch `approval.policy=never`）→ **工具面只读**：文件工具由 `dsh-fs-sandbox` 策略围栏拦写（非内核边界），shell 走 ACL 受限令牌且 enforcement 报 `partial`（Windows 实测拦写；边界细节见 §4 R3）。**不宣称"与 codex 同级"** |
| `access: "write"` | env `DSH_PERMISSION_MODE=danger-full-access`（approval 自动 `never`，不会弹权限请求），与 claude 的 bypass 档同级 |
| `schema` | 不支持（与 cursor/kimi 一样在 open/send 明确拒绝；不要静默忽略） |
| `model` | 接受 `deepseek-v4-pro` / `deepseek-official/deepseek-v4-pro` 这类人类可读串，按 `session/new` 返回的 `configOptions` 表映射成不透明 JSON 值；**不要硬编码模型 id**（`deepseek-v4-flash` 来自部署目录而非源码默认）；非法值在 `start()` 阶段失败（桥的"fail fast、不留孤儿进程"规则） |
| `effort` | 桥词汇 `minimal/low/medium/high/xhigh` → DSH `off/low/high/high/max`（medium→high，xhigh→max） |
| viz 边界 | 没有 turn-start ACK ⇒ 诚实档位用 `pipe_enqueued`（写完 prompt 请求后派发）；首个 `session/update` 触发 `firstBackendEvent`；不要发明不存在的 ACK 档位 |

**权限应答器是必须项，不是可选项** `[源码]`：`session/request_permission` 的服务端请求**没有超时**（`dsh-acp` 用 `conn.request` 等客户端回包），没人应答就会一直挂到取消/关闭（"是否真会无限挂起"本身尚未单独实测，但源码无超时是确定的）。桥必须实现：read 档一律 `reject-once`（写操作拿到 rejected，模型继续收尾）；write 档要么用 danger-full-access 让服务端不发起请求，要么 `allow-once`。

### 3.2 启动行与每会话 patch

启动行（Windows；桥已有 `spawnPlan` 处理 `.cmd`，`scripts/agent-bridge.mjs:744-754`）：

```sh
dsh --profile acp --patch <临时目录>\session-patch.yml
# 建议解析顺序：DSH_BIN → %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd → PATH
```

因为 **prompt 只走 stdin、永不进 argv**，ACP 路线不需要像 cursor/kimi 那样绕开 `.cmd`/cmd.exe 的注入面；argv 里只有 `--profile acp` 和临时 patch 路径（临时目录需避开 `& | ^` 等 cmd 元字符）。这是 ACP 相对 headless 的一个隐藏优势。

每会话 patch 示例（桥生成到临时目录，spawn 后删除；注意 patch 是**整段 config 覆盖**，所以 personaPrefix 要连同 personaSuffix 一起重述）：

```yaml
- id: llm-deepseek-account     # 可选：去掉 stdout 上的模型列表噪音（实测有效）
  disabled: true
- id: system-prompt
  config:
    personaPrefix: 'You are a coding agent powered by the {{model}} model.'
    personaSuffix: |-
      <append_system_prompt_file 的全文>
- id: approval                  # 只读档建议加：权限请求确定性拒绝，模型不会反复尝试升级
  config:
    policy: never
```

（等价替代：角色文件写到临时路径，patch 里用 `!!js` 表达式 `process.getBuiltinModule('node:fs').readFileSync(...)` 读取，避免 YAML 转义问题；patch loader 支持 `!!js`。此写法 `[推断]`，未实跑，列入待 spike。）

### 3.3 为什么是"一后端会话一进程"

`[源码]` persona/system prompt、工具集、权限模式、静态 MCP 行都是**进程级组合**（`--patch`/env 是进程级；ACP bundle 还禁了 HMR），而 ACP 的一条连接本身能安全多路复用多个会话（实测 2 会话并发互不串）。因此：

- **v1 推荐一桥会话一 ACP 进程**：实现简单、语义与 claude/codex 后端一致，每个会话可以有独立的真 system prompt、读写档位、模型。
- **优化项（P5，可选）**：只有在"同 persona + 同档位"的多个会话之间才值得共享一个进程（省 ~250 MB/进程）；这会把 persona 降级为首轮软注入，是否值得由 graph 大并发场景决定。

### 3.4 要改的桥内文件与测试（与 cursor/kimi 两次后端 PR 同构）

1. `scripts/agent-bridge.mjs`：`AGENTS` 加 `dsh` 条目（bin/env/role/versionArgs/matchesCommand）＋ `DshAcpSession` 类（700–850 行，主体抄 Codex 骨架，删掉 codex 的 turn-start ACK/ambiguous 分支与 schema stash，加 `session/update` 映射、权限应答器、cancel、usage 映射）＋ `AGENTS.dsh.Session = DshAcpSession;`（:~5952-5960）＋ doctor 一行 ＋ TOOLS 的 prose（agent 枚举/effort/access/append 说明，`:383`、`:419-428`、`:642`）。
2. 测试：`tests/fake-dsh.mjs`（假 ACP 后端，~250–350 行，仿 `tests/fake-kimi.mjs`）＋ `tests/repro-dsh.mjs`（25–30 个场景：握手/会话/流式/权限允许与拒绝/取消后复用/close 期间 abort 被拒与 force/跨进程 resume/模型与 effort 传参/system prompt 注入方式/contextUsage/ref/max_chars/pid 记录与清理 matcher 矩阵/doctor/uncollected 债）。**必改的既有测试（否则套件会红或 viz 契约说谎）**：`tests/contract-invariants-session.mjs`（AGENTS 闭环/合法后端集合）、`tests/e2e-viz.mjs` 的 boundary 映射、`tests/repro-viz-bridge.mjs` 的边界行、`tests/probe-doctor-timeout.mjs` 的后端探测清单；contextUsage 还要接进 viz/wait 的展示链路。现有 `repro-kimi` S17 与 `diag match` 是 matcher 安全边界的回归模板。
3. 设计文档 `docs/DESIGN-dsh-backend-<date>.md`（~300–400 行；本次评估 §2 可直接作为其"§2 真机约束"底稿）。
4. 文档/技能：README（Usage/Backends/Notes）、`docs/INSTALLATION.md`、`docs/DEVELOPMENT.md`、`docs/ARCHITECTURE.md`、`skills/agent-bridge/SKILL.md`（后端清单/access 边界/contextUsage/model-effort）；另 4 个消费 skill 只在 contextUsage 非空/read 边界不同时需要一句话更新。

**白送的共享管道**（无需改）：`childEnv` 诊断标记、pid 记录与 startup/`cleanup` 收割、日志分文件与截断、watchdog、`sendTurn` 单一漏斗、uncollected 债、`buildSessionResult`/textRef/ref/max_chars、viz 五连（`sessionOpened`/`attempt`/`dispatch`/`firstBackendEvent`/`settleOnce`/`sessionClosed`）。**不算白送、必须做的**：后端要在接收一轮时**自己 mint `lastTurnId`** 并维护 turn 时钟字段（ACP 没有早 ACK），否则 uncollected 债与 `turnSource` 归因失效。

### 3.5 工期 `[桥内锚点]`

cursor 后端 PR = +1642 行、kimi = +1851 行（含评审修正）。ACP 后端估算 **1.4–1.8k 行、4–6 人日核心 + hermetic，再 +2–3 人日跨引擎评审、真机 e2e、Windows 清理调试与文档**。分阶段：① 半天 spike（本次已完成大半，剩 12 项待确认清单）→ ② 注册+doctor+resolver 半天 → ③ 类核心 2–3 天 → ④ hermetic 套件 1 天 → ⑤ 评审/真机/文档 2–3 天。

---

## 四、方向 A 的风险与缺口

| # | 问题 | 现状/影响 | 建议 |
|---|---|---|---|
| R1 | **清理匹配器误杀 GUI** | `DeepSeek Harness.exe` 是 GUI 进程名；桥 matcher 是安全边界 | matcher 同时要求 `app.asar`/`cli.js` token + `--profile acp`；按 repo 惯例用 `diag match` 专门回归（假 GUI 形状不能被匹配） |
| R2 | **只读档的权限升级通道 + 权限应答器必须实现** | 实测：客户端允许 allow-once 时 read-only 也能写成功；`[源码]` 服务端权限请求**没有超时**（无人应答会挂到取消/关闭；"无限挂起"本身未单独实测） | 只读档一律 reject 权限请求，或 patch `approval.policy=never`（实测都能拦；后者体验更干净，但会有半条 preset 警告日志，可再配 `permission.defaultPreset` 消掉）。**权限应答器必须实现** |
| R3 | **只读是"工具面边界"，不是"进程/内核沙箱"** | `[源码]` 文件工具的拒写来自 `dsh-fs-sandbox` 的**策略围栏**（canonicalize+contain，非内核边界，TOCTOU 收窄未消除）；shell 才走 Windows ACL 受限令牌，且 enforcement 报 **`partial`**（读/网络不限、硬链接可绕过、AppContainer 目录不可读）。所以不能表述成"和 codex 的 OS 沙箱同级" | 文档如实写"read 档 = 被委派 agent 的**工具**写不出去"，机制与 codex 的 OS 沙箱分开描述 |
| R4 | **进程内存 ~250 MB/会话** | roundtable（3–5 席）没问题；graph 20 节点全并发 ≈ 5 GB | v1 一后端一会话（与 claude 同级）；共享进程优化留 P5 |
| R5 | **模型值是 CLI 私有格式 + 目录可变** | `["provider","model"]` JSON 串；`deepseek-v4-flash` 来自部署目录而非源码默认 | 后端内做别名映射并**从 `session/new` 的 configOptions 动态解析**；不在 open_session 暴露原始串 |
| R6 | **stdout 噪音 / 非 JSON 行** | 实测存在 | 解析器跳过并记日志 + patch disable `llm-deepseek-account` 双保险 |
| R7 | **DSH 版本门槛** | ACP profile（`dsh-acp`/`dsh-acp-app`）在 0.1.0-rc.6 与 0.2.x 的包集里都有，但各版本语义可能不同；目标机器仍是 0.2.1-rc.2 | doctor 用 `dsh -V` + `dsh --profile acp --help` 双探测；版本过低/不支持 ACP 时给明确报错 |
| R8 | **环境继承与 DSH_HOME** | 若桥本身从 DSH 的 shell 启动，`childEnv` 会继承 `DSH_HOME/DSH_PROFILE/DSH_SESSION_ID/DSH_WEB_URL`；所有 ACP 进程共享 `~/.dsh` 的 sessions/storages/凭据 | 生产沿用用户 DSH_HOME（凭据/模型配置一致）；hermetic 测试用临时 `DSH_HOME` + `--patch` 隔离；文档写明桥会话会出现在用户 DSH 的 session 列表里 |
| R9 | **会话存储单写者** | `[源码]` 每会话一份 append-only JSONL，**同一 session id 只允许一个活写者**（进程内 claim + 内核锁），ACP 也拒绝 resume 自己进程里活着的会话 | 桥一后端会话一进程、只用自己的 session id ⇒ 天然安全；禁止两个桥进程驱动同一 DSH 会话 id |
| R10 | **嵌套行为** | ACP 会话默认无 MCP（无递归风险）；但 base 会自动加载项目 `AGENTS.md/CLAUDE.md`、并带 DSH 原生 subagent/compaction 工具 | 与 claude 后端一致：读项目指令是想要的；subagent 不禁止（属 DSH 内部实现），但设计文档写清"桥只观测根会话" |
| R11 | **`--patch` 临时文件与转义** | 角色提示词含 YAML 特殊字符/`{{...}}` 插值 | 严格块标量或 `!!js` readFileSync；临时文件 spawn 后删；patch 是整段 config 覆盖，personaPrefix 一并重述 |
| R12 | **Electron 宿主下 owner 存活判定误杀（本次方向 B 实测暴露，v0.12.0 已修复）** | 桥的 `ownerStillRunning`（`scripts/agent-bridge.mjs:2019-2032`）只认 `node` 开头的 owner；DSH 桌面版用 Electron-as-node 启动桥，嵌套桥（被 `.mcp.json` 拉起）启动清理会把外层桥的后端子进程误判为孤儿杀掉：`omp` 会话在含 `.mcp.json` 的 cwd 下 ~5-6 s 后 `OMP RPC exited with code 1`（A/B 复现见证据索引） | **已于 v0.12.0 修复**：owner 命令含 `agent-bridge.mjs` + `\bmcp\b` 即视为存活（误判为"活着"只会延迟清理，是安全方向）；回归测试用改名后的 node 副本模拟 Electron argv0（`tests/repro-owner-electron-argv0.mjs`）。修复后委托 cwd 不必再避开含 `.mcp.json` 的目录 |

---

## 五、方向 B：DSH 当 agent-bridge 的客户端（**已实测跑通**）

**结论：纯配置，0 代码改动，20–40 分钟。** 完整安装步骤已落地到 [docs/INSTALLATION.md](INSTALLATION.md) 第 6 节（2026-10-20 完成；含可粘贴的 patch 片段、skills junction 命令、验证与回滚、FAQ）。**同日已在本机 DSH 桌面版真机启用并验证**：往桌面 profile patch 层插入一行后 HMR 热加载生效 → 8 个工具直接进入正在运行的会话 → `agent_bridge_doctor` 五项 ok → 5 个 skill 经 `~/.dsh/skills` junction 上线 → 打开 `omp` 只读会话发一条消息，1.3 s 内拿回 `DSH-BRIDGE-OK`。过程中还发现并定位了一个**与本方向无关、但被它暴露的桥缺陷**（R12，Electron 宿主下的 owner 存活判定误杀；**v0.12.0 已修**，见上文状态更新）。本机实测（2026-10-20，**已复跑两次，原始命令与输出存证** `D:\cc\_dsh-eval\notes\04-direction-b-live-run.log`）：
`dsh --profile headless --patch D:\cc\_dsh-eval\agent-bridge-mcp.yml "Call the agent-bridge MCP server's doctor tool ..."` → **exit 0（7.2 s）**，模型成功调用 `mcp__agent-bridge__agent_bridge_doctor` 并原样输出了 agent-bridge 的体检结果（OMP/Codex/Claude/Cursor/Kimi 全部 ok）。同一 patch 里顺带恢复了 headless 默认禁用的凭据存储（`credentials/authorization/deepseek-account` 三行 `disabled: false`）——所以"headless 不能用保存的 key"是可绕过的。

**怎么配**（DSH 0.2.1-rc.2；主 agent 用桌面 GUI 时改用户 patch 层）。下面是**实测过的 headless 变体**：

```yaml
# headless：存成外部 overlay 用 --patch 传入；desktop 就追加到 ~\.dsh\profiles\desktop\cordis.patch.yml
- id: credentials               # 仅 headless 需要：恢复 GUI 保存的凭据存储
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false

- insert:
    - id: mcp-agent-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-bridge            # 工具名 → mcp__agent-bridge__agent_bridge_*
        transport: stdio
        command: node                       # 实测变体；Electron 桌面进程里建议改 !!js process.execPath + env ELECTRON_RUN_AS_NODE=1（此变体 [推断]，未实跑）
        args:
          - 'D:\cc\agent-bridge\scripts\agent-bridge.mjs'   # <REPO>
          - mcp
        cwd: 'D:\cc\agent-bridge'
        toolCallTimeoutMs: 900000           # ⚠ 必改：默认 60s < 桥 wait 的 10 分钟默认值
        failOnStartupError: false
```

> 在 Electron 桌面进程里 `node` 不一定在 PATH 上；官方推荐的 Electron 安全写法是 `command: !!js process.execPath` + `env: {ELECTRON_RUN_AS_NODE: '1'}`（与 in-box OpenViking 插件同形，`!!js` 是 patch 文档支持的特性），但这一具体变体只做过**配置组装验证**，没有真跑过。

要点：

- **`@deepseek-ai/dsh-mcp-client` 在 DSH 里但没有任何 shipped bundle 挂它**；它没有设置页/设置文件，只能通过 profile patch（或 ACP 的 `session/new.mcpServers`）挂一行。
- **`.mcp.json` 对 DSH 完全无效**（DSH 全树没有 `.mcp.json` 读取器）——repo 里的 `.mcp.json` 必须翻译成上面的 YAML。
- **环境变量清洗**：MCP 子进程的环境会剥掉 `/KEY|PASSWORD|SECRET|TOKEN/i` 与所有 `DSH_*`；`PATH` 保留（能拉起 CLIs），需要 API key 的后端要在 `env:` 里显式重述。
- **skills 全部原样兼容**：5 个 `SKILL.md` 的 frontmatter 只有 `name`+`description`，kebab 名合法、描述 224–408 字符（<500 上限），解析通过。安装只需把 5 个目录 junction 到 `C:\Users\leo.wang\.dsh\skills\`（用户级，所有 profile 生效，且保持 "git pull 即更新"）；或用 `customSkillDirs: ['D:\cc\agent-bridge\skills']`（非 desktop profile）。
- **工具名是命名空间形**：`mcp__agent-bridge__agent_bridge_*`（与 Claude Code 同形）；skill 正文写的是裸 `agent_bridge_*`，模型需要自行映射（Claude Code 已有先例，实际可行但属已知摩擦点）。
- **递归/冲突风险**：host-plane 插入会让**所有** DSH 会话（含 DSH 自己的 subagent）看到这 8 个工具；DSH 侧没有直接环（桥的后端里没有 dsh），但"桥 → 委派的 Claude Code 读到项目的 `.mcp.json` → 再拉起桥"这种间接环存在（与 DSH 无关的既有风险）。想要收紧作用域就把这行插进 desktop 的各个 agent preset（而非 host plane），代价是新建会话才生效。
- **其他 caveat**：skill 正文 9–22 KB > desktop 标准 preset 的 tool-result-pruner 阈值 8192（压缩压力下中间可能被剪，可调阈值）；desktop 的 `cordis.patch.yml` 可能被 app 的 profile 自愈/Plugin Manager 备份重命名（本机已有 `.bak-*`），改动前留副本；Windows 路径用**单引号**（YAML 双引号里 `\c` 是非法转义）。
- **剩余未实测**：模型对命名空间工具（`mcp__agent-bridge__*`）的映射质量（doctor 与一次 OMP 委托已实测通过）；skill 正文在压缩压力下被剪的实际频率。

---

## 六、与 headless 路线的对比（为什么它只作兜底）

| 维度 | ACP（推荐） | headless 一次性 |
|---|---|---|
| 多轮连续 | 原生持久会话（同进程或 `session/resume` 跨进程） | 每轮新进程；`--session-id` 只能恢复**已存在**会话 |
| 取消 | `session/cancel`，11 ms、会话保留 | 只能杀进程，部分输出/状态有风险 |
| 权限策略 | ACP 请求由桥应答（或 approval never） | 无客户端可应答：env 沙箱 + 非交互策略，升级请求 fail-closed |
| 上下文用量 | `usage_update` 真值 | `--json` 事件里没有 usage（要读会话日志） |
| 凭据 | 用桌面保存的 key | **默认不用**（env/.env only），但可用 patch 恢复（实测：三行 `disabled: false` 后 headless 正常跑通） |
| 启动/传输 | 2–3 s 一次，之后每轮近零开销 | 每轮 2–3 s 启动；prompt 走 argv/stdin，Windows 上要绕 cmd 注入面；每轮多一次标题 LLM 调用 |
| 复杂度 | 高一点（持久 RPC + 权限应答） | 低一点（但 launcher/resolver 更脏） |

---

## 七、建议路线图

1. **P0（已完成）**：本评估 + 两组真机打样（`D:\cc\_dsh-eval\spike*.mjs` 可复跑；方向 B 的 headless 端到端已跑通并留证 `notes\04-direction-b-live-run.log`）。
2. **P1（1–2 天）**：设计文档 + `fake-dsh` + 字段映射表定稿；补 12 项待确认 spike（见 §八）。
3. **P2（3–5 天）**：`DshAcpSession` 主体 + registry/doctor/resolver + hermetic 套件；`repro-dsh` 全绿 ×3。
4. **P3（2–3 天）**：跨引擎评审（repo 惯例 R1→APPROVE）+ 真机 e2e（read/write/abort/reuse/清理无残留）+ 文档/skill 更新 + 版本号。
5. **P4（已完成 2026-10-20）**：方向 B 的配置文档已落地到 [docs/INSTALLATION.md](INSTALLATION.md) 第 6 节（含注册、skills、验证、回滚、已知摩擦与 FAQ）；并已在本机 DSH 桌面版真机启用、跑通「doctor + 5 skills + 一次 OMP 委托」（见 R12 的附带发现）。

**实际执行（2026-10-20）**：P1→P3 已随 **v0.12.0** 落地（`DshAcpSession`、`fake-dsh`/`repro-dsh`、`e2e-dsh`、文档与 skill rollout；R12 已修）。上面的工期估算保留为当时的预估，不作事后校准。

---

## 八、未决问题 / 待确认 spike（需要你拍板或真机确认）

1. **只读档的表述**：DSH read-only = 文件工具由 fs 策略围栏拦写 + shell 由 ACL 受限令牌限制（报 `partial`），是"工具面"边界而非内核沙箱；比 omp/claude/cursor/kimi 的软只读强，但**不要**写成"与 codex 的 OS 沙箱同级"。README/SKILL 的"只有 codex 是硬只读"措辞要改。
2. **模型命名**：只暴露 `deepseek-v4-pro / deepseek-v4-flash / deepseek-flash` 三个稳定别名，还是允许 `provider/model` 与 `deepseek-account` 路由？provider 要不要独立参数？
3. **内存预算**：graph 大并发是否接受 ~250 MB/会话；要不要为"同角色多节点"预留进程共享优化（P5）。
4. **方向 B 的默认开关**：要不要把方向 B 写进 README 安装节（涉及隐式嵌套委托的说明）。
5. **版本支持下限**：只支持带 ACP profile 的 DSH 0.2.x，还是也兼容更老版本的 headless 兜底。
6. **待真机确认的 12 项** `[源码→待spike]`：opaque model 值精确帧、disable account 的确定性、`!!js readFileSync` 注入角色、凭据覆盖组合、隔离 DSH_HOME、cmd.exe 下 patch 路径引号、read 档 reject 权限不挂起、turn 错误路径、cancel 竞态、退出/强杀、版本门槛、persona 里的 `{{` 花括号。

---

## 附录 A：证据索引

- 桥内契约：`D:\cc\_dsh-eval\notes\01-bridge-contract.md`（366 行，全部 `file:line` 引用）：AGENTS 注册、Session 隐式接口、sendTurn 漏斗、turn 时钟、uncollected 债、result/textRef/ref、childEnv/spawnPlan/pid/cleanup/matcher、viz 五连、hermetic 测试惯例、文档 rollout 清单、工期锚点（cursor +1642 行 / kimi +1851 行）。
- DSH 运行时与协议：`D:\cc\_dsh-eval\notes\02-dsh-runtime.md`（569 行，带 SRC/DUMP/LIVE/INFER/SPIKE 置信标签）：ACP 全 wire 契约、SDK/headless 对比、`--patch`/persona/instructions 机制、权限沙箱源码证明、模型目录与 effort 语义、单写者锁与 DSH_HOME 并发、推荐 recipe。
- 方向 B：`D:\cc\_dsh-eval\notes\03-dsh-client.md`（663 行，VERIFIED/INFERRED 分离）：MCP row 的精确 schema 与组装验证、desktop/headless/ACP 各自的配置文件、skills 发现规则与 frontmatter 契约、5 个 skill 的兼容性实测、递归风险分析、精确步骤与 caveat。
- 真机打样（方向 A）：`D:\cc\_dsh-eval\notes\00-lead-spike.md` + `spike-acp.mjs` / `spike2-acp.mjs` / `spike3-concurrent.mjs` + 原始帧日志 `acp-spike-frames.log`、`tmp/spike2-*.log`、`tmp/spike3-concurrent.log`。
- 真机打样（方向 B）：`D:\cc\_dsh-eval\agent-bridge-mcp.yml`（headless overlay，含恢复凭据的三行）+ **`D:\cc\_dsh-eval\notes\04-direction-b-live-run.log`**（复跑命令、exit 0、7.2 s、doctor 原始输出存证）；安装章节落地后的复核日志见 `D:\cc\_dsh-eval\notes\05-install-doc-verify.log`（`--dump-config` 组装 + 端到端：doctor 五项 ok + DSH 会话列出 5 个 skill）；**桌面版真机启用/验证 + R12 缺陷 A/B 复现证据**见 `D:\cc\_dsh-eval\notes\06-direction-b-applied.log.md` 与 `hermetic-omp-mcpjson.mjs`。
- DSH 源码（0.2.1-rc.2，从 `resources/app.asar` 抽出，306 包，可直接 grep）：`D:\cc\_dsh-eval\asar\node_modules\@deepseek-ai\`。关键包：`dsh-acp`、`dsh-acp-app`、`dsh-headless`、`dsh-system-prompt`、`dsh-agent-instructions`、`dsh-user-approval`、`dsh-permission-presets`、`dsh-mcp-client`、`dsh-skill-filesystem`。
- 机器可读配置快照：`D:\cc\_dsh-eval\acp-config.yml`（`dsh --profile acp --dump-config`，377 行）与 `headless-config.yml`。
