# DESIGN — DeepSeek Harness（DSH）作为 agent-bridge 第 6 后端（`dsh`）

状态：**v1.1 — as-built 更新（2026-10-20 15:1x）**。v1 与 `DshAcpSession` 主体对齐；v1.1 按落地后的实现与测试更新：§5.3/§8.3 的 GAP-1/2/5/7/8 全部 **CLOSED**（含固定回归测试），§4.4 补 `agentSpecific.launchVia`，§4.5/§4.6 补 patch 前置拒绝与 pid-record 保留语义，§6 按实际 `tests/repro-dsh.mjs` S1–S24 / `tests/e2e-dsh.mjs` E1–E5 重写，§8 补跨引擎评审结论。正文其余未改。
日期 2026-10-20。作者：主 agent。真理源：本文件（协议事实 §2、实现锚点 §4/§7、证据索引附录 A）。
证据标记：`[实测]` = 本机真跑（帧日志 `D:\cc\_dsh-eval\acp-spike-frames.log`、`notes\00-lead-spike.md`、`tests/e2e-dsh.mjs` 真机输出）；`[源码]` = 读桥或 DSH 0.2.1-rc.2 发布源码（`D:\cc\_dsh-eval\asar\node_modules\@deepseek-ai\`）；`[推断]` = 有依据未实测（§8.2 列待 spike）。

> ⚠️ **v1.1 更新说明**：§5.3 原"复审发现"已全部落地（GAP-1 abort wedge → fail+kill；GAP-2 read 档永不放行；GAP-5 `{{` 前置拒绝；GAP-7 reaping 归位；GAP-8 生产启动路径真机覆盖），§8.3 改为"偏差关闭状态"表。仅 Q-1（`contextUsage.live`）保留为设计口径说明（合同已定 `live:false`，E2 真机断言固定）。
> 行号说明：`scripts/agent-bridge.mjs` 行号为 2026-10-20 快照值（实现仍在演进）；定位以 §7.1 的符号名为准。

---

## 0. 一句话

把 `dsh --profile acp` 接成第 6 个后端：**一桥会话 = 一持久 ACP 进程**；`session/prompt` 整轮结算（无 turn-start ACK）、`session/cancel` 优雅取消且会话可复用（cancel 被无视的 wedge 则 fail+杀树，不伪装成功）；真 system prompt（生成 `--patch` 覆写 `system-prompt.personaSuffix`）、读写档（`DSH_PERMISSION_MODE` env）与模型/effort（`session/new` 后 `set_config_option` 钉住）都是**进程级/会话级原生能力**。read 档是 DSH **工具面的写围栏**（fs 策略围栏 + 部分 ACL），**不是**内核/OS 沙箱，文档口径必须如实。

---

## 1. 背景 / 目标 / 非目标

### 1.1 背景

- agent-bridge 现有 5 个后端（omp / codex / claude / cursor / kimi），都是 NDJSON-over-stdio；DSH 0.2.1-rc.2 自带为自动化客户端设计的 **ACP profile**（`dsh --profile acp`）：持久会话、一连接多会话、每会话模型/推理强度、流式文本/思考/工具/上下文用量、`session/cancel`、`session/close`、跨进程 `session/list`/`session/resume`、`session/request_permission`。
- 这正好是桥会话契约（`start/send/result/isSettled/abort/close/summary/contextUsage`）的一等公民映射，且消掉了 headless 路线「每轮新进程 + prompt 走 argv + 没有取消」的硬伤。

### 1.2 目标（v1）

1. `agent_bridge_open_session({ agent: "dsh" })` 能开一个**持久**委托会话；多轮 `send_message` 复用同一 DSH 会话。
2. `model` / `effort` / `access` / `append_system_prompt_file` 在 **open 时**按桥统一语义生效；非法值 fail-fast（不留孤儿进程）。
3. 真流式：`agent_message_chunk` → `lastAssistantText` + viz `progress`；`agent_thought_chunk` 只进事件/日志；`tool_call*` 只进事件；`usage_update` → 真 `contextUsage`。
4. `abort` 走 `session/cancel`，会话保持可复用；`close` 同步返回、后台拆除进程树；Windows 下无残留。
5. 与现有 5 后端同构：`AGENTS` 注册项 + matcher（安全边界）+ doctor + 公开 prose + hermetic fake/repro + 文档/skill rollout。

### 1.3 非目标（v1 明确不做）

- **不做 headless 兜底后端**（`--profile headless`）：一次性、无取消、无续聊、默认禁托管凭据、每轮多一次标题 LLM 调用；只作为老版本 DSH 的将来选项，见 §2.6。
- **不做 `--profile sdk`/`sdk-minimal` 后端**：无 cancel/close/逐轮结果，model/effort 只有进程级，协议自称 pre-release 不承诺兼容（§2.6）。
- **不支持 `schema`（结构化输出）**：沿用「codex-only」的既有门（`openSession` / `sendMessage` 的通用 `agent!=="codex"` 校验、类内再兜一层 `send`；按符号名定位，不押行号）。
- **不做共享进程多路复用**（P5 优化项）：persona/system prompt、工具集、读写档、env 都是进程级，`--patch` 在 ACP bundle 里 HMR 被禁用 ⇒ 同进程多会话只能共享同一 persona/档位；v1 一进程一会话（§3-D1）。
- **不使用 `session/resume` 跨进程恢复**：桥的重启恢复需要桥侧 transcript 配合，v1 不承诺；`session/list` 也不暴露给 MCP 调用方。
- **不做 DSH 的 MCP/skills 注入**：`session/new` 固定 `mcpServers: []`（无递归，见 §2.5）；被委托会话是否读到项目 `AGENTS.md`/`CLAUDE.md` 是 DSH 自身行为（§3-D14）。
- **不改用户 `~/.dsh` 的 profile patch**：只写每会话临时 `--patch` 文件（§4.5）。

---

## 2. 真机约束（2026-10-20，DSH 0.2.1-rc.2 / Windows）

> 本节 = DESIGN-kimi §2 的对等物：后续实现/复审一律回到这里，不靠记忆。

### 2.1 传输、握手与生命周期

| # | 事实 | 证据 |
|---|---|---|
| 1 | 传输 = **newline-delimited JSON-RPC 2.0 over stdio**（一行一条 JSON，无 LSP `Content-Length`）；源码直接 `ndJsonStream(Writable.toWeb(stdout), Readable.toWeb(stdin))`。 | `[实测]` 帧日志；`[源码]` `dsh-acp/lib/index.js:1361` |
| 2 | `initialize` 请求：`{protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}, clientInfo:{name,version}}`。服务端**忽略全部 params**；回 `{protocolVersion:1, agentInfo:{name:"deepseek-harness-acp",version:"0.0.1"}, agentCapabilities:{mcpCapabilities:{http:true}, promptCapabilities:{image:false,audio:false,embeddedContext:false}, sessionCapabilities:{close:{},list:{},resume:{}}}, authMethods:[]}`；`authenticate` 恒回 `{}`。 | `[实测]`；`[源码]` `:1183-1209` |
| 3 | `session/new` 参数：`{cwd:<绝对路径>, mcpServers:[...]}`；`cwd` 必须绝对，`additionalDirectories` 被拒；`mcpServers` 是**必填数组**（省略 → internal error），桥固定传 `[]`。回 `{sessionId:"<裸 uuid>", configOptions:[...]}`。 | `[实测]`；`[源码]` `:1210-1249, :1452-1455, :216-300` |
| 4 | 一个进程可并发多会话且互不串（实测 2 会话 A=pro / B=v4-flash 并发完成、update 按 sessionId 分流）；**单会话内同时只允许一个 prompt**，第二个回 `-32602 "a prompt is already in flight for this session"`。 | `[实测]`；`[源码]` `:798, :1116-1249` |
| 5 | `session/cancel` 是**通知**（无 `id`）：`{method:"session/cancel", params:{sessionId}}`；在途 prompt 以 `{stopReason:"cancelled"}` 结算（实测 **~11 ms**），**会话继续可用**。 | `[实测]`；`[源码]` `:869-873, :1005-1023, :1355-1358` |
| 6 | `session/close` 请求 `{sessionId}` → `{}`；只拆该 Agent scope，其他会话不受影响。关 stdin 后进程 exit 0（有界停机：5 s grace，超时强制退出；SIGTERM→0、SIGINT→130）。 | `[实测]`；`[源码]` `:1338-1350, :963-1001`；`dsh-acp-app/lib/index.js:33-36` |
| 7 | `session/resume` 请求 `{sessionId, cwd(绝对), mcpServers:[]}` → `{configOptions}`（**无 sessionId**）；拒绝 subagent/child、cwd 不符、本进程已活跃的会话；**不重放历史**。新进程 resume 实测 **~315 ms**，模型能回忆上一进程的暗号。 | `[实测]`；`[源码]` `:1250-1297`（v1 不使用） |
| 8 | `session/list`：`{cwd?, cursor?}` → `{sessions:[{sessionId,cwd}], nextCursor?}`；无 title/updatedAt；排除子会话/非绝对 cwd/本进程活跃会话；cursor 是 `[createdAt,sessionId]` 的 opaque base64url。 | `[源码]` `:1298-1327`（v1 不使用） |
| 9 | stdout 纯度是 best-effort：实测会话创建时出现一行非 JSON 诊断 `[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)`；`--patch` 禁 `llm-deepseek-account` 可消掉。桥解析器必须**跳过并记日志、绝不崩**。stderr 只作诊断（warn 有用，必须持续 drain）。 | `[实测]`；`[源码]` `dsh-llm-deepseek-account/lib/index.js:234` |
| 10 | 错误码：参数/schema `-32602`（带 data）；内部/回合失败 `-32603`（`turn failed: …`）；未知方法 `-32601`；未知会话 `-32602 "unknown session: <id>"`。**回合失败是 reject 该 JSON-RPC 请求**（不是换一个 stopReason）；取消则 resolve `cancelled`。 | `[源码]` `:1053-1064, :1128-1131` |
| 11 | `stopReason` 映射：`completed→end_turn`、`max-tokens→max_tokens`、`aborted→end_turn`、`interrupted→cancelled`、`blocked/error→end_turn`。 | `[源码]` `turnEndToStopReason :539-551` |
| 12 | 启动/握手耗时：spawn+initialize **≈2.2–3.3 s**；`session/new` **≈257–428 ms**；一轮 flash 回复 **≈1.0 s**、pro **≈1.8 s**、用工具的轮 **≈5 s**；`dsh -V` **≈238 ms**；`dsh --profile acp --help` exit 0 **≈1.7–2.0 s**（首次会初始化 profile）。 | `[实测]` `notes/00-lead-spike.md:26-54,100-107` |

### 2.2 会话选项：model 与 reasoning_effort

`session/new` 返回的 `configOptions`（原样摘录，实测）：

```json
{"id":"model","name":"Model","category":"model","type":"select",
 "currentValue":"[\"deepseek-official\",\"deepseek-v4-flash\"]",
 "options":[{"group":"deepseek-official","name":"DeepSeek","options":[
    {"value":"[\"deepseek-official\",\"deepseek-v4-flash\"]","name":"deepseek-v4-flash"},
    {"value":"[\"deepseek-official\",\"deepseek-flash\"]","name":"DeepSeek-V4.1-Flash"},
    {"value":"[\"deepseek-official\",\"deepseek-v4-pro\"]","name":"DeepSeek-V4-Pro","description":"…"}]},
  {"group":"deepseek-account","name":"DeepSeek Account","options":[…]}]}
{"id":"reasoning_effort","name":"Reasoning effort","category":"thought_level","type":"select",
 "currentValue":"high","options":[{"value":"off"},{"value":"low"},{"value":"high"},{"value":"max"}]}
```

| # | 事实 | 证据 |
|---|---|---|
| 1 | `model` 的 value 是**不透明字符串**：JSON 编码的 `[provider, model]`（如 `'["deepseek-official","deepseek-v4-pro"]'`）。`reasoning_effort` 的 value 是 `off/low/high/max`（默认 `high`；有的模型会多一档 `""`=provider default）。 | `[实测]`；`[源码]` `AcpModelControl.state() :418-513, modelValue() :525-527` |
| 2 | `session/set_config_option` 请求 `{sessionId, configId, value}`，**value 恒为字符串**；回 `{configOptions:[...]}`（完整新状态）；未知 id/value → `-32602`。 | `[实测]`；`[源码]` `:388-410, :1328-1337` |
| 3 | 修改在**下一轮**生效：prompt 在准入时快照并锁定选择。`config_option_update` update 会在模型拓扑变化时推送完整 `configOptions`。 | `[源码]` `:827-839, :352-365, :768-788` |
| 4 | 模型目录 = `initialize` 后 `session/new` 时 `ctx.llm.listProviders()/listModels()` **活值**：包含部署/GUI 保存的 `llm-deepseek` 设置（`deepseek-v4-flash` 就不在源码默认表里）⇒ **禁止硬编码模型 id**。 | `[实测]`；`[源码]` `:434-464`、`dsh-llm-deepseek/lib/index.js:42-54` |
| 5 | `deepseek-official`（API key 路由）与 `deepseek-account`（DSH 托管账号）互不 fallback；默认 advisory 目录含 `deepseek-flash`（V4.1-Flash，1 M ctx）与 `deepseek-v4-pro`。 | `[源码]` `dsh-llm-deepseek/README.md:53-63,87-91` |

### 2.3 回合与流式 `session/update`

请求：`{sessionId, prompt:[{type:"text", text}]}`（v1 只用 `text`）。**响应只在整轮结束返回** `{stopReason:"end_turn"}` ⇒ **没有 turn-start ACK**（与 codex `turn/start` 的本质差异）；结算要等根轮+受管子孙 idle 且 update 全部投递。update 是**已提交内容的投影**，不是逐 token delta（无 user message/retry/plan/title update）；通知形如 `{method:"session/update", params:{sessionId, update:{…}}}`。

| `update.sessionUpdate` | 字段 | 桥的动作 |
|---|---|---|
| `agent_message_chunk` | `{messageId, content:{type:"text", text}}`（空块被服务端跳过） | 追加 `lastAssistantText`；viz `firstBackendEvent`+`progress` |
| `agent_thought_chunk` | 同上（reasoning） | 压缩成 `{type:"thinking", chars}` 事件；**不并入答案** |
| `tool_call` | `{toolCallId, title, kind:"other", status:"in_progress", rawInput}` | 事件 |
| `tool_call_update` | `{toolCallId, status:"completed"|"failed", content:[…]}` | 事件（不落正文） |
| `usage_update` | `{used:<int>, size:<int>}`；`used`=tokenMeter 压力估算（非账单），`size`=contextWindow（默认 1,000,000）；**每轮可多条，取最后一条** | 更新 `tokenUsage`；`contextUsage()` 读数 |
| `config_option_update` | `{configOptions:[…]}` | 覆盖本地 `configOptions` 快照 |

证据：`[实测]`（帧日志：`agent_message_chunk`/`agent_thought_chunk`/`tool_call*`/`usage_update {used:8816,size:1000000}`）；`[源码]` `:562-644, :626-636`；`dsh-token-meter/README.md:36-68`。

### 2.4 权限 / 沙箱 / 只读边界（Windows 现实）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 服务端→客户端请求 `session/request_permission`：`{sessionId, toolCall:{toolCallId}, options:[{optionId:"allow-once",name:"Allow once",kind:"allow_once"},{optionId:"reject-once",name:"Reject",kind:"reject_once"}]}`；客户端回 `{result:{outcome:{outcome:"selected", optionId}}}`。`outcome.outcome==="cancelled"` → cancelled，`allow-once` → allowed-once，其余 → rejected。 | `[实测]`；`[源码]` `:1158-1181` |
| 2 | **该请求服务端没有超时**（`conn.request` 等客户端回包，审批决策在 Tool 内 await）⇒ **桥必须应答**，否则该轮挂到 cancel/close。 | `[源码]` `:1158-1181`、`dsh-user-approval/README.md:30-36,151-156` |
| 3 | 只读档实测：`DSH_PERMISSION_MODE=read-only` 时写文件被 `[sandbox: file access denied under read-only mode]` 拦下；但**若客户端把请求答成 allow-once，可升级写成功**（首轮 spike 真写成功过）⇒ read 档必须 reject 权限请求。 | `[实测]` |
| 4 | 机制来源：`DSH_PERMISSION_MODE`（默认 `workspace-write`）同时驱动 `sandbox-policy.mode`（`workspaceRoot=process.cwd()`）与 `user-approval.policy`（`danger-full-access`→`never`，否则 `ask`）；三档 preset：read-only/workspace-write/danger-full-access。组合不落在 preset 上会打一条非致命 warning。 | `[源码]` `dsh-base/cordis.patch.yml:240-276` |
| 5 | 文件工具：`dsh-fs-sandbox` 是**策略围栏**（canonicalize+contain，TOCTOU 收窄未消除）——"trusted code 里的 fence，不是内核边界"。 | `[源码]` `dsh-fs-sandbox/README.md:12,46,64,123` |
| 6 | shell：`pwsh-sandbox` → Windows ACL restricted token（`WRITE_RESTRICTED` low integrity）；read-only 无写 SID；enforcement 自报 **`partial`**（读/网络不限、硬链接可绕过、AppContainer 目录不可读）。bash 行在 win32 禁用。 | `[源码]` `dsh-sandbox-windows-acl/README.md:12,70,102,120-134,186-192`、`dsh-pwsh-sandbox/README.md:36-40` |
| 7 | 结论口径：read 档 = **被委派 agent 的工具写不出去**（文件工具硬拒 + shell 部分受限），**不是**"与 codex 的 OS 沙箱同级"。 | `[源码]+[实测]` |

### 2.5 凭据 / 环境 / 资源 / 注入机制

| # | 事实 | 证据 |
|---|---|---|
| 1 | **ACP profile 保留 DSH 托管凭据存储**（不像 headless 显式禁 `credentials`/`authorization`/`deepseek-account`）；实测无需 `DEEPSEEK_API_KEY`。解析优先级：`$DSH_HOME/.credentials.yaml` → 进程环境 → `<cwd>/.env` → `$DSH_HOME/.env` ⇒ **GUI 保存的 key 优先于桥注入的 env key**；要强制 env key 需 patch 禁三行凭据插件（`[推断]`，未在 ACP 实跑）。 | `[实测]`；`[源码]` `dsh-acp-app/cordis.patch.yml`、`dsh-credentials-local/README.md:71-80`、`dsh-headless/cordis.patch.yml:35-43` |
| 2 | 环境：`DSH_HOME`（本机 `C:\Users\leo.wang\.dsh`）共享 profile/sessions/storages/凭据；launcher 只在变量"尚未在继承 env 中"时加载 `.env` 层，且 `.env` 不得设 `DSH_*`/`PATH`/代理/TLS 名。 | `[源码]` `dsh-app-boot/lib/index.js:3610-3760` |
| 3 | 会话存储：每会话一份 append-only JSONL（zstd）在 `$DSH_HOME/sessions/<cwd-slug>/<encoded-id>/`；**同一 session id 只允许一个活写者**（进程内 claim + 内核锁）；ACP 拒绝 resume 本进程已活跃会话；`session-query-sqlite` 在所有 shipped profile 里是 `:memory:`+`openAt:never` ⇒ 无共享 SQLite 写者。 | `[源码]` `dsh-session-persistence-jsonl/README.md:48-73,168`；`[实测]` 2 进程并发未遇锁问题 |
| 4 | 进程内存：一条 ACP 进程树 ≈ `cmd.exe` 8 MB + `DeepSeek Harness.exe` **252 MB**（2 会话时）。roundtable 3–5 席没问题；graph 20 节点全并发 ≈ 5 GB。 | `[实测]` `notes/00-lead-spike.md:95-99` |
| 5 | 递归风险为零（默认）：ACP bundle 组合里**没有 `mcp-client` 行**（`--dump-config` 377 行只有 `mcp-resources`），DSH 全树没有 `.mcp.json` 读取器；`session/new` 传 `mcpServers:[]` ⇒ 被委托会话没有任何 MCP。 | `[实测]+[源码]` `dsh-base/cordis.patch.yml:492-493`、`dsh-mcp-client/README.md` |
| 6 | 项目指令：`dsh-agent-instructions` 自动读 `$DSH_HOME/AGENTS.md`→`~/.agents/AGENTS.md`→项目链（最近 `.git` 祖先到 cwd）的 `AGENTS.md`/`CLAUDE.md`（用户角色 `<system-reminder>`，非 system role）；**没有**任意绝对路径 instruction 文件配置。 | `[源码]` `dsh-agent-instructions/README.md:34-74` |
| 7 | skills 是进程/组合级（`customSkillDirs` 等），不能按 ACP 会话切换；桥 v1 不注入。 | `[源码]` `dsh-skill-filesystem/README.md:34-76` |
| 8 | **系统提示注入**：每会话 `--patch` 覆写 `system-prompt.personaSuffix` 是**真 system role**（模型按注入 persona 回答）；`personaPrefix/personaSuffix` 走 `{{…}}` 模板插值，未解析变量会在组装阶段失败；E2b 已用真机复证（模型答出 PINEAPPLE-42）。 | `[实测]`（Lead spike SECRET-CODE；`tests/e2e-dsh.mjs` E2b）；`[源码]` `dsh-system-prompt/README.md:44-52,70-78` |

### 2.6 为什么不选 SDK / headless

| 面 | 缺口 | 结论 |
|---|---|---|
| `--profile sdk` / `sdk-minimal` | 只有 `initialize/session/prompt/resume/wait/shutdown`（+工作目录 get/set）；**无 cancel、无 per-session close、无逐轮结果**；`model`/`reasoningEffort` 是 `initialize` 级、对所有会话生效；无 context usage 投影；server→client 请求是死能力（权限只能 fail-closed）；README 明写 pre-release 不承诺兼容。 | 不选 |
| `--profile headless` | 每轮新进程；`--session-id` 只能恢复已存在会话；默认禁托管凭据；`--json` 事件里无 usage；prompt 走 argv/位置参数（Windows 上要绕 cmd.exe 注入面）；每轮多一次标题 LLM 调用。 | 只作 v0 冒烟/老版本兜底 |

证据：`[源码]` `dsh-sdk-protocol/README.md:36-56,120-122`、`dsh-headless/README.md:12,155-162`、`02-dsh-runtime.md` §2/§3。

### 2.7 启动器事实（Windows）

- `where dsh` → `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`；`dsh.cmd` 设 `ELECTRON_RUN_AS_NODE=1` 后 exec `"…\DeepSeek Harness.exe" --expose-internals "…\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*`。`[源码]`（静态读 launcher）+`[实测]`（`-V` 可跑）。
- 标准安装路径**含空格**（`DeepSeek Harness\…`）；若经 `cmd.exe /d /s /c <引号 launcher>`，cmd 的重解析会带来引号/空格风险（`[推断]`，实现侧按"直起更稳"处理），且进程树多一层 `cmd.exe`。**v1 因此对标准布局绕过 .cmd，直接以 Electron-as-node 起真进程**（§3-D13）；`DSH_BIN` 覆盖/非标准布局才回退 `spawnPlan`（含只有 hermetic 测试会走到的 `fake-dsh.cmd` 分支）。

---

## 3. 设计决策（D1–D15，每条含"为什么"与"被否决的替代"）

### D1 一桥会话 = 一 ACP 进程（process-per-session）

- **决定**：`start()` spawn 一个 `dsh --profile acp [--patch <tmp>]`；该进程只服务这一个 ACP 会话。
- **为什么**：persona/system prompt、工具集、权限档、静态 MCP 行都是**进程组合**；`DSH_PERMISSION_MODE` 是 env（进程级）；ACP bundle 禁 HMR ⇒ patch 只能启动时一次性生效。只有 model/effort 是会话级。一进程一会话让"每会话独立真 system prompt + 档位"成立，语义与 claude/codex 一致。
- **否决**：共享进程多路复用（省 ~250 MB/会话，但同进程只能共享 persona/档位；把 persona 降级为首轮软注入不诚实；P5 可选、仅同 persona 大并发场景）。headless 每轮短进程（§2.6）。

### D2 ACP，而不是 headless/SDK

- **决定**：主后端走 `--profile acp`。
- **为什么**：唯一同时提供逐轮结果（`stopReason`）、cancel、per-session close、会话级 model/effort、usage 投影、真实权限往返、持久多轮的界面；传输与 codex 的 NDJSON 骨架同构（手写 ~100–150 行 JSON-RPC，零依赖）。**否决** SDK/headless（§2.6）。

### D3 `append_system_prompt_file` → 每会话临时 `--patch` 覆写 `system-prompt.personaSuffix`

- **决定**：open 时生成 `<STATE_ROOT>/dsh/<bridge-session-id>.yml`（`#writeSessionPatch`），spawn 时以 `--patch <file>` 传入；内容是 `- id: system-prompt / config: {personaPrefix: <ACP 出厂 persona 原文>, personaSuffix: |-\n <append 内容逐行缩进>}`；start 成功（或失败）后立即删除。append 内容含 `{{` 时在 **spawn 前**以可行动错误拒绝（DSH 模板插值会吃花括号，不猜转义规则）。
- **为什么**：这是**真 system prompt**（`personaSuffix` 在出厂 guidance 之后组装，实测模型答出了注入的 SECRET-CODE）；tier 与 omp/claude 同级，`summary().appendSystemPrompt.injectionMode="system"` 诚实。patch loader **整段替换 config**（非深合并）⇒ 必须重述 `personaPrefix`，否则出厂 ACP coding persona 会被 schema 默认 `""` 覆盖。E2b（`tests/e2e-dsh.mjs`，真机 DSH 0.2.1-rc.2）已复证：DSH 接受生成的 patch，且模型按注入 persona 答出 codeword PINEAPPLE-42。
- **否决**：首轮用户前缀软注入（不诚实、白丢真 system prompt 能力）；`agent-instructions` 文件通道（DSH 没有任意绝对路径 instruction 文件配置，且那是 user-role reminder）；patch 里用 `!!js readFileSync` 读角色文件（loader 支持 eval，但多行/转义未实测，v1 不引入 eval 面）。

### D4 access 档映射：env + 权限应答器；口径如实

- **决定**：`read` → child env `DSH_PERMISSION_MODE=read-only` + 权限应答器**永不放行**：按 `reject_once` → 任意 `reject*` 选一个 reject，都没有则回 `{outcome:{outcome:"cancelled"}}`；`write` → `DSH_PERMISSION_MODE=danger-full-access`（approval `never`，正常不发请求）+ 应答器按 `allow_once` → 任意 `allow*` 兜底。
- **为什么**：read 档有两条写通道（文件工具 + shell），单靠 env 时"客户端 auto-allow 可升级写"的实测漏洞必须由应答器堵死；write 档用 danger-full-access 免打扰且与 claude bypass 同级（该档已有完整权限，持久 allow 不增加授权）。口径：read = **工具面写围栏**（fs 策略围栏 + pwsh ACL partial），不是内核沙箱，不写成"与 codex OS 沙箱同级"。
- **否决**：中档 `workspace-write`（approval=ask，需自动 allow-once，等于默认放宽写）；只靠 `approval.policy=never` patch 不实现应答器（协议请求无超时，任何组合都可能发请求）。

### D5 模型：从 `session/new` 的 `configOptions` 动态映射，绝不硬编码

- **决定**：用户可传 `deepseek-v4-pro`、`deepseek-official/deepseek-v4-pro` 或原样 opaque 值；`resolveAcpModelValue()` 依次按 **value 精确匹配 → name 匹配 → `provider/model` 解码成 `[provider,model]` 比对 → 裸名匹配 pair[1]** 映射；解析不到 → `start()` 抛错（open_session 干净失败、无孤儿）。
- **为什么**：model 值是 CLI 私有 JSON 串、目录由部署/设置决定（实测多出 `deepseek-v4-flash`）；硬编码会在别的机器/版本漂移。`summary().model` 回显用户串，真实 opaque 值进 `agentSpecific.acpConfig.model`。
- **否决**：硬编码三个别名；把用户串直接塞 `set_config_option`（未知值只会拿到 `-32602`，且无法诊断可选值）。

### D6 effort 词汇映射：`minimal/low/medium/high/xhigh` → `off/low/high/high/max`

- **决定**：映射表见 `DSH_EFFORT_ALIASES`；`medium→high`、`xhigh→max`、`minimal→off`；映射后的值必须在 `reasoning_effort` 选项里被 advertised，否则 `start()` 抛错；不传则不动（DSH 默认 high）。
- **为什么**：桥的 effort 词汇是跨后端统一契约；DSH 的 `off/low/high/max` 是适配器私有 id，不能直接透传用户词汇。top-level `summary().effort` 回显桥词汇（契约枚举），真实值在 `agentSpecific.acpConfig.reasoningEffort`。
- **否决**：透传用户值（`medium`/`xhigh` 会被适配器以 `UNSUPPORTED_REASONING_EFFORT` 拒）；忽略 effort 回显 null（DSH 有真实旋钮，不该学 cursor/kimi）。

### D7 `contextUsage`：取最近一条 `usage_update`，`{tokens: used, live:false}`

- **决定**：`contextUsage()` 返回上一轮最后一次 `usage_update.used` 的绝对 token 数，`live:false`；每轮 `#beginTurn` 重置为 null（本轮无 usage 时不得回显上一轮数字）；`size` 不对外暴露（契约只允许绝对 tokens，无窗口/百分比）。
- **为什么**：`used` 是 tokenMeter 的上下文压力估算（不是账单），`usage_update` 只在已提交 assistant message 时出现 ⇒ 它是**上一轮快照**，与 codex/claude 的 `live:false` 定义一致；`STATE-session-viz.md` 只把 `live:true` 留给 OMP 的实时轮询读数。
- **口径定案（v1.1）**：任务书初稿写 `live:true`（`Q-1`），但合同 `STATE-session-viz.md` 把 `live:true` 定义为"实时轮询读数（仅 OMP）"、`false` 为"上一轮结束快照（codex/claude）"；DSH 的 `usage_update` 是每轮已提交消息的投影 → 取 `live:false`。已由 `tests/contract-invariants-session.mjs`（dsh 断言 `live===false`）与真机 E2 双重固定；若未来要改 `live:true`，需先改合同定义与夹具，不能在单后端篡改。

### D8 观测台（viz）语义：诚实边界 `pipe_enqueued`

- **决定**：`send()` 依次 `attempt()`（拒绝闸后、写管道前）→ 成功 `#write` 后 `#beginTurn` → `dispatch(attempt,{boundary:"pipe_enqueued", backendTurnId:<桥铸 turnId>})`；首个 `session/update` 触发 `firstBackendEvent`；`agent_message_chunk` 触发 `progress`（后端不节流，writer 负责）；`#settleTurn` 唯一 `settleOnce`；`#rejectAll`/abort 强制结算为 failed/aborted；`close()` 先 `sessionClosed`。
- **为什么**：ACP 没有 turn-start ACK（`session/prompt` 只在轮末回包），`pipe_enqueued` 是唯一诚实档位；发明 `turn_start_ack` 会让观测台对"派发证据"撒谎（合同禁止）。**否决**：把轮末响应冒充 ack；等首个 update 才 dispatch（漏掉无 update 失败轮的 attempted 可见性）。

### D9 轮次 id 本地铸造；`lastTurnId` 在写成功后提交

- **决定**：`send()` 铸 `turnId = <session-id>-t<turnCount+1>`；`#beginTurn(turnId)` 在 `session/prompt` 成功写入 stdin **之后**执行，写 `currentTurnId/lastTurnId/turnStartedAt`、清空正文与 tokenUsage。后端没有自己的轮次 id，`agentSpecific` 不暴露。
- **为什么**：共享 `sendTurn` 用"`lastTurnId` 是否变化"绑定 `turnSource` 与未收取债代际；写失败（stdin 死）不铸 id，就不会把没送达的轮记成已派发（见 `sendTurn` 的 `pendingTurnSource` / `lastTurnEpoch` 归属块）。

### D10 abort：`session/cancel` → 等 `cancelled` → 超时兜底

- **决定**：`session/cancel` 通知 → `withTimeout(turn.promise, DSH_ABORT_SETTLE_MS=8 s)` → 正常路径 ~11 ms 结算 `cancelled`、状态回 `idle`、**会话可复用**；迟到响应由 `#onPromptSettled` 的 `this.turn !== turn` 身份门丢弃。**超时（wedge）路径**：`#settleTurn(new Error(...))` → 状态 `failed`，随后 `#killWedgedProcess()`（`terminateProcessTree` 杀树、清 `acpSessionId`、删 pid record + patch），返回 `{aborted:true, killed:true, reusable:false}`——不伪装成一次成功取消，会话不可复用、需重开（与 kimi poison 同口径；S22 固定该行为）。
- **为什么**：DSH 的原生取消是最优路径（不杀进程、不丢会话），避免 cursor/kimi 那种整树 kill；但 cancel 无效时 backend 里仍有在途 prompt（下一次 `session/prompt` 会被 `-32602 "a prompt is already in flight"` 拒），所以必须有"失败+杀树"的诚实兜底。
- **否决**：直接杀进程当默认（丢会话且违反 ACP 的优雅取消能力）；不设兜底（后端 wedge 时 `abort` 永挂/假成功）。

### D11 close：同步返回，异步拆除

- **决定**：`close(opts)` 同步：viz `sessionClosed` → 状态 `closed` → 尽力发 `session/close`（fire-and-forget）→ `stdin.end()` → `#rejectAll`（结算在途轮与 RPC）→ 仅在自有 child handle 仍活时 `terminateProcessTree`+`scheduleForceKill(3000)` → 删 pid record/answer artifact/patch → `acpSessionId=null` → `{closed:true}`。
- **为什么**：桥的 `closeOne()` 不 await（返回形状不能被异步污染）；process 退出是后续事实，不是 close 前置条件。**否决**：await `session/close` 响应再拆进程（卡 5 s grace 且改写返回形状）。

### D12 子进程环境：保留 `DSH_HOME`，剥掉宿主 DSH 运行态变量

- **决定**：`#childEnv()` = `childEnv(this)`（`AGENT_BRIDGE_*` 标记）+ `DSH_PERMISSION_MODE`；删除 `DSH_SESSION_ID`/`DSH_WEB_URL`/`DSH_PROFILE`/`DSH_PROFILE_DIR`/`DSH_SHELL`；**保留 `DSH_HOME`**。
- **为什么**：桥自身可能被 DSH 桌面版以 Electron-as-node 拉起（方向 B）；被委托 ACP 服务必须启动自己的 profile/会话，不能继承宿主 run 的 session id/web URL/profile 指针；保留 `DSH_HOME` 才能共用同一套安装、模型配置与托管凭据（且桥会话会如实出现在用户 DSH 的 session 列表里）。**否决**：隔离 `DSH_HOME`（凭据/配置丢失、GUI 看不到会话；hermetic 测试另用临时 `DSH_HOME` 即可）；连 `DSH_HOME` 一起剥（退回 `~/.dsh` 默认，行为靠运气）。

### D13 启动器：`resolveDshBin()` + `resolveDshLaunch()`

- **决定**：惰性解析（绝不在 registry init；未安装必须报 doctor `missing` 而不是模块加载崩）：1) `DSH_BIN` = 已存在的 launcher 文件路径（`dsh.cmd`/`dsh.exe`/POSIX `dsh`，不接受裸名）；2) Windows 标准安装绝对路径 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（POSIX 试 `.app` bundle / `/usr/local/bin/dsh` / `~/.local/bin/dsh`）；3) PATH（Windows 仅 `dsh.cmd/dsh.exe/dsh.bat`）。解析到**标准布局 `dsh.cmd`** 时绕过批处理 shim，直接 spawn `"…\DeepSeek Harness.exe" --expose-internals "…app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" <args>` + env `ELECTRON_RUN_AS_NODE=1`；其他 launcher 走 `spawnPlan()`。
- **为什么**：标准路径含空格，cmd.exe 重解析（`[推断]`）+ 多一层 `cmd.exe` 让 pid/树 kill 变脏；直起让 pid record 的 root 就是真进程树根。ACP 的 prompt 永不走 argv，任何路径都无 prompt 注入面。实际走到的形态记录在 `session.launch.via`，并经 `summary().agentSpecific.launchVia` 暴露（E1 真机断言生产路径 = `electron-node`）。**否决**：只认 `.cmd`+`spawnPlan`；要求 native `.exe`（POSIX 布局未验证，且会像 kimi 那样把 hermetic 测试逼成编译 PE stub）。

### D14 matcher（安全边界）+ 不注入 MCP

- **决定**：`AGENTS.dsh.matchesCommand` 必须**同时**满足 `--profile acp` 独立 token **且** 出现真实入口形状之一（`app.asar` 路径 / `dsh-desktop-host\lib\cli.js` / `dsh`/`dsh.cmd`/`dsh.exe` token）。裸 `DeepSeek Harness.exe` 永不匹配（那正是桌面 GUI 进程）。
- **为什么**：cleanup 的 matcher 是安全边界（误杀用户 GUI 不可接受）；`dsh --profile desktop` 本身被 CLI 拒绝，`headless/web/sdk` run 不带 `--profile acp`，天然排除。**否决**：进程名匹配；只要求 `dsh` 字样（`fake-dsh.mjs` 这类无关路径也会命中）。
- **MCP**：`session/new` 固定 `mcpServers: []`，不 insert `mcp-client` 行 ⇒ 被委托 DSH 无 MCP、无递归（`DSH_*` 剥除见 D12）。项目 `AGENTS.md`/`CLAUDE.md` 会被 DSH 自动读入——与 claude 后端一致，属预期（文档写明）。

### D15 测试策略：wire 级 fake + hermetic repro；真机分层 e2e

- **决定**：`tests/fake-dsh.mjs`（+`.cmd`/`.sh`）实现完整 ACP 子集（含故障注入与 launch trace）；`tests/repro-dsh.mjs` 零 token 驱动真桥；真机 e2e 分两层——**open/close/doctor/cleanup 零 token**（不发 prompt），**一轮真 prompt 由 Lead 一次性跑**并留证。
- **为什么**：ACP 语义全在 wire 上，fake 可确定性覆盖时序/竞态；真机 open+close 已能验启动器、matcher、pid/清理。**否决**：只靠真机（不稳定且烧 token）；只靠 fake（启动器/版本/凭据永远验不到）。

---

## 4. 类成员与 summary 形状（`DshAcpSession`，锚点 §7.1）

### 4.1 关键字段

```
id, agent="dsh", cwd, access, write, model, effort, appendSystemPrompt,
status, isStreaming, lastAssistantText, lastError, lastStderr,
lastTurnError, lastTurnErrorMessage, events, proc, launch{command,args,env,via},
patchFile, pending(Map id→{resolve,reject}), nextId,
acpSessionId, configOptions, currentTurnId, lastTurnId,
turnStartedAt, turnEndedAt, turn{resolve,reject,promise,settled}, turnCount,
tokenUsage{used,size}|null, logFile, answerFile, pidFile,
_vizSawEvent, _vizDrafts
```

### 4.2 方法语义

| 成员 | 语义 |
|---|---|
| `async start()` | 写 patch（若有；内容含 `{{` 在 spawn 前直接抛）→ `resolveDshLaunch` → spawn（env 见 D12）→ stderr→log/`lastStderr`、stdout `readline`、stdin error/进程 error/close 三路兜底 → `initialize`（`DSH_READY_TIMEOUT_MS=30 s`）→ `session/new{cwd,mcpServers:[]}` → 按需 `set_config_option(model)`、`set_config_option(reasoning_effort)`（`DSH_CONFIG_TIMEOUT_MS=10 s`）→ 删 patch → `idle`；任一步失败走 `#teardownStart()`（杀树+删 patch；pid record 留给 openSession 的 `close({removePidRecord:false})` 与子进程 close handler）后抛。 |
| `async send(message, opts)` | 校验（非空/未关/进程活/无在途轮/已 start/schema 拒）→ `attempt` → `running` → 建 `this.turn`（pre-attach catch）→ 手写 `session/prompt` 请求并把 resolve/reject 接到 `#onPromptSettled` → 写失败：删 pending、`viz.reject`、回滚状态并抛 → 写成功：`#beginTurn(turnId)` + `viz.dispatch(pipe_enqueued)` → `wait:true` 时 `withTimeout(turn.promise, timeout_ms||DEFAULT_WAIT_TIMEOUT_MS)`（超时 abort 后抛），否则回 `{accepted:true, sessionId, status, turnId}`。 |
| `async result(opts)` | `buildSessionResult(this, lastAssistantText, opts)`（答案=正文 chunk 之和；thought 永不入正文；最后失败轮保留残件，语义同 codex/kimi）。 |
| `isSettled()` | `status==="idle" && !this.turn`（在途信号是 `this.turn`，不能只看 idle）。 |
| `refreshStatus()` | 同步 no-op（事件驱动；保持 status 快照相对流水线 RPC 同步）。 |
| `async abort()` | 无在途轮 → 返回 `{aborted:true}`（若状态残留 running 且进程活则回 idle；补 `turnEndedAt`）；有在途轮 → `session/cancel` → 等结算（8 s 上限）→ 正常则 idle、`{aborted:true}`；超时则结算 failed + `#killWedgedProcess()` + `{aborted:true,killed:true,reusable:false}`（见 D10）。 |
| `close(opts)` | 同步（D11）；`opts.removePidRecord===false` 时保留 pid record（进程级 shutdown 约定）。 |
| `contextUsage()` | D7；`null` = 未知，不是 0。 |
| `summary()` | §4.4 精确形状。 |

**状态机**：`starting`（构造器）→ `idle`（ready）/ `failed`（start 失败由 openSession 清理，不再暴露）→ `running`（send）→ `idle`（end_turn）/ `failed`（turn error）/ `idle`（cancelled）→ `closed`（close 或进程 exit0）；进程非 0 退出 / stdin EPIPE / 进程 error → `failed`。所有写状态走 `setSessionStatus`（唯一漏斗）。

**单轮闸**：`sendTurn` 的 `pendingTurnSource`（桥级）+ `if (this.turn) throw`（后端级）双层；`wait:true` 的整段在途也被 `pendingTurnSource` 覆盖。

### 4.3 轮次时钟 / 未收取债（白送但不是自动的）

- 铸 `lastTurnId` 是**后端责任**（共享 `sendTurn` 靠它判"这一发是否真的存在"）。
- `result()` → `buildSessionResult` 注册交付来源（`DELIVERED_TURN`），未收取债装饰由共享层完成；后端只需保证：`lastTurnId` 只在请求成功写出后设置、`isSettled()` 精确、每个终结路径都清 `this.turn`。

### 4.4 `summary()` 精确形状（字段级，顺序即契约核心）

```js
{
  id, agent, cwd, access, write, model, effort, status,
  pid: this.proc?.pid || null,           // 持久进程：open 后恒有；close 后 null
  createdAt, updatedAt, lastError,
  lastStderr: this.lastStderr ?? null,
  name: this.name ?? null,
  health: deriveHealth(this),
  contextUsage: this.contextUsage(),     // {tokens,live:false}|null
  appendSystemPrompt: appendSystemPromptSummary(this, "system"),  // {file,bytes,injectionMode}|null
  logFile,
  lastTurn: lastTurnOf(this),
  agentSpecific: {
    acpSessionId: this.acpSessionId,     // DSH 的 uuid；close 后 null
    acpConfig: { model: <opaque JSON 串|null>, reasoningEffort: <'off'|'low'|'high'|'max'|null> },
    turnCount: this.turnCount,
    launchVia: this.launch?.via ?? null, // "electron-node"（标准安装直起主路径）| "launcher"（DSH_BIN/回退 shim）| null
  },
}
```

注意：`model`/`effort` 顶层回显**用户输入**（桥词汇）；真实生效值只在 `agentSpecific.acpConfig`（model 是 opaque 串、effort 是 DSH id）。`appendSystemPrompt` 只含路径/字节/注入档，**绝不回显正文**。

### 4.5 patch 生命周期

| 时机 | 动作 |
|---|---|
| `#writeSessionPatch()`（start 在内） | append 内容含 `{{` → **直接抛错**（spawn 前，不写 patch、不启进程、open 干净失败；S23 固定） |
| `start()` 开头 | 有 `appendSystemPrompt` → 创建 `<STATE_ROOT>/dsh/<id>.yml`（内容见 D3；CRLF→LF、`trimEnd`、每行 6 空格缩进块标量）；无 → 不创建、不加 `--patch` |
| `resolveDshLaunch` 抛错 | 删 patch 后抛 |
| start 成功 / start 失败 | 删 patch（`#removePatchFile`；失败路径经 `#teardownStart`） |
| `close()` / `#killWedgedProcess()` | 兜底再删一次（idempotent） |

理由：ACP bundle HMR 禁用，patch 在 boot 时读一次即生效，`initialize` 回包时组合已就绪，删文件不影响在跑进程（**已由 E2b 真机证实**：patch 注入的 persona 在 start 后删文件仍对后续轮生效）。

### 4.6 pid 记录

- 一条记录/会话：`{id, agent:"dsh", ownerPid, cwd, createdAt, processes:[{role:"dsh-acp", pid:<root pid>, command:[launch.command, ...launch.args], spawnedAt}]}`。
- `command` 含 `--profile acp --patch <临时路径>`，**不含任何 prompt/角色正文**；`pid` 是启动根（标准布局 = Electron 真进程；回退布局 = cmd.exe 或 fake shim）。
- 删除时机：cleanup/close（`removePidRecord!==false`）、进程 close 事件；`cleanupSessions({removePidRecord:false})` 在桥退出时**保留**记录，供下次启动 sweep 收割顽固子进程。
- **start 失败路径的保留语义（v1.1 明确）**：`#teardownStart()` **故意不删** pid record——openSession 的 start-failure 收尾调用 `close({removePidRecord:false})`，让 TERM/SIGKILL 抗拒的子进程保留唯一的收割指针；真正退出的子进程在自己的 process `close` handler 里删除记录。急删会丢"仍活孤儿"的线索。
- Windows kill 只在自己 handle 仍活时发起（`terminateProcessTree` + `scheduleForceKill(3000, verify)`），防 pid 复用误杀。

### 4.7 一轮的 wire 时序（首轮，摘录）

```jsonl
>> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"agent-bridge","version":"<ver>"}}}
<< {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},"agentCapabilities":{"sessionCapabilities":{"close":{},"list":{},"resume":{}},…},"authMethods":[]}}
>> {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"D:\\cc\\agent-bridge","mcpServers":[]}}
<< {"jsonrpc":"2.0","id":2,"result":{"sessionId":"<uuid>","configOptions":[…]}}
>> {"jsonrpc":"2.0","id":3,"method":"session/set_config_option","params":{"sessionId":"<uuid>","configId":"model","value":"[\"deepseek-official\",\"deepseek-v4-pro\"]"}}
<< {"jsonrpc":"2.0","id":3,"result":{"configOptions":[…]}}
>> {"jsonrpc":"2.0","id":5,"method":"session/prompt","params":{"sessionId":"<uuid>","prompt":[{"type":"text","text":"<user turn>"}]}}
<< {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<uuid>","update":{"sessionUpdate":"agent_message_chunk","messageId":"…","content":{"type":"text","text":"<answer>"}}}}
<< {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<uuid>","update":{"sessionUpdate":"usage_update","used":8816,"size":1000000}}}
<< {"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}

>> {"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<uuid>"}}          # abort()
<< {"jsonrpc":"2.0","id":5,"result":{"stopReason":"cancelled"}}
>> {"jsonrpc":"2.0","id":6,"method":"session/close","params":{"sessionId":"<uuid>"}}     # close()（fire-and-forget）
<< {"jsonrpc":"2.0","id":6,"result":{}}                                                    # 随后 stdin.end() → exit 0
```

### 4.8 共享管道：白送的与必须自己做的

- **白送**：`childEnv` 诊断标记、pid 记录/startup 收割、日志分文件与截断、watchdog、`sendTurn` 单漏斗、未收取债、`buildSessionResult`/`textRef`/`ref`/`max_chars`、viz `attempt/dispatch/firstBackendEvent/progress/settleOnce/sessionOpened/sessionOpenFailed/sessionClosed`、`deriveHealth`（`isReusable` 由 `proc` 活性推断，无需自定义）。
- **必须自己做**：mint `lastTurnId`/轮次时钟（ACP 无早 ACK）；`session/update` 变体映射；权限应答器；cancel 结算与迟到响应身份门；usage 映射；patch/launcher 生命周期；`#rejectAll` 的 viz 收口；`send()` 的 `pipe_enqueued` dispatch。

---

## 5. abort / close / Windows 不变量与行为矩阵

### 5.1 不变量（实现与复审按此逐条核）

1. **一进程一会话**；`acpSessionId` 只由本进程创建/关闭，不跨桥共享；不使用 `session/resume`。
2. **`close()` 同步**：不 await 任何网络/进程事件；返回前完成 viz `sessionClosed`、状态 `closed`、`#rejectAll`；返回后不变量：会话从 `sessions` 删除（由 `closeOne` 做）。
3. **`abort()` 必须结算在途轮 promise**：正常路径由 `cancelled` 响应结算（回 idle、可复用）；超时路径由本地 `#settleTurn(err)` 结算为 `failed` 并 `#killWedgedProcess()`（本次调用返回 `killed:true,reusable:false`，会话之后不可复用）。任一情况下 `this.turn=null`、`turnEndedAt` 有值、等待者被 resolve/reject，不能永挂。
4. **迟到/陈旧事件不能污染新轮**：`#onUpdate` 在 `!this.turn` 时只记日志；`#onPromptSettled` 用 `this.turn===turn` 身份门丢弃迟到 prompt 响应。
5. **所有死亡路径收敛**：stdin error / proc error / proc close / close() 全部进 `#rejectAll`（拒绝所有 pending RPC + 在途轮 + viz 收口为 failed），不允许"某个 promise 无人管"（unhandledRejection 在桥里是致命的）。
6. **pid record 与进程树**：只在自有 handle 表明仍活时杀；`taskkill /T` 收整树；记录在 close/进程退出时删除、桥退出时保留；**start 失败时不急删**（留给 `close({removePidRecord:false})` / 子进程自己的 close handler，保住仍活孤儿的收割指针）。
7. **patch 文件必删**（成功/失败/close 三路都删）；pid record 的 command 不含 prompt/角色正文。
8. **进程退出码语义**：`session/close` + stdin EOF → exit 0；非 0 ⇒ 会话 `failed`（`code === 0 && status !== "failed"` 才 `closed`）。
9. **环境**：delegated ACP 进程的 `DSH_PERMISSION_MODE` 恒被显式设置；宿主 `DSH_*` 运行态变量被剥除、`DSH_HOME` 保留。
10. **abort 后可用性**：正常取消后会话必须可继续（实测）；走超时兜底时**不得**声称可复用——必须按 D10 结算为 `failed` + 杀树 + 清 `acpSessionId`（S22 断言 `killed:true, reusable:false`，且进程已死、后续 send 被拒）。

### 5.2 行为矩阵（状态 × 操作）

| 状态 \ 操作 | `abort()` | `close()`（默认拒绝在途） | `close({forced:true})` | `wait` 超时 |
|---|---|---|---|---|
| `starting`（spawn→ready 窗口） | 无在途轮：返回 `{aborted:true}`；若进程已活则补 `idle`（随后 start 会再置 idle，无害）。 | `closeOne` 前置检查若认为在途（`sessionSettled` false）会 `blocked`；force 则：closed + kill 树 → 在途 `initialize/session/new` promise 被 `#rejectAll` → start 抛错 → openSession 走 `sessionOpenFailed`；pid record 由 `close({removePidRecord:false})` 保留给 sweep。 | 同左（`forced` 进 viz 记录）。 | 不适用（open 尚未返回）。 |
| `idle` | 无在途轮：`{aborted:true}`，状态不变；清可能残留的 `turnEndedAt` 悬挂。 | 正常关闭：`closed`，进程树拆除，pid/answer/patch 删除。 | 同左。 | 不适用。 |
| `running`（prompt 在途） | `session/cancel` → 等 `{stopReason:"cancelled"}`（~11 ms）→ 结算 aborted → `idle`；**会话可复用**。超时 → 结算 failed + `#killWedgedProcess()` + `{killed:true,reusable:false}`（S22）。 | `blocked`（`runningSessionIds`），一个都不关。 | 强制：`sessionClosed` → `closed` → 取消 fire-and-forget + stdin.end + rejectAll + kill 树；在途轮被本地 reject（`session closed`），可能来不及收到 `cancelled`（无所谓）。 | `send(wait:true)` 超时 → `abort()` → 抛 timeout；轮次结算 aborted；会话可复用（正常取消路径）。**wait 超时本身不销毁后端**；若取消也 wedge，则走 killed/failed 分支。 |
| `failed`（回合失败/进程非 0 退出） | 无在途轮：`{aborted:true}`；进程死则状态保持。 | 清理：`closed`；pid/answer/patch 删除（幂等）。 | 同左。 | 会话已 settle（`failed` 短路），返回失败结果。 |
| `closed` | `{aborted:true}`（幂等，不再写协议帧）。 | 幂等：再次 close 不抛、不重复杀。 | 同左。 | 不适用。 |

补充：`wait` 超时**非破坏性**（`waitSessions` 超时后任务继续跑，调用方再 `wait`）；`abortSession` 只在"确认在跑"时调 `session.abort()`。关闭中的 abort 由 `closeOne` 的前置检查拦截，不并发进 backend。

### 5.3 复审发现的状态（v1.1：ALL CLOSED）

> v1 设计期提出的 5 个缺口已在 as-built 中全部关闭，并各有**固定回归测试**；原"待处理/签字"表述作废。

| 编号 | 原问题 | 实现（as-built） | 固定测试 |
|---|---|---|---|
| **GAP-1** | abort 超时只强结算为 idle、不杀进程 → 会话可复用声明不成立 | 超时 → `#settleTurn(new Error(...))`（状态 `failed`）→ `#killWedgedProcess()`（`terminateProcessTree`、清 `acpSessionId`、删 pid record + patch）；`abort()` 返回 `{aborted:true, killed:true, reusable:false}`；会话需重开 | `repro-dsh.mjs` **S22** + fake 模式 `ignorecancel`（断言 failed+dead、进程已死、后续 send 被拒） |
| **GAP-2** | read 档找不到 reject 时可能退到 allow / `options[0]` | `#respondPermission`：write 档 `allow_once`→`allow*`；read 档 `reject_once`→`reject*`→否则 `{outcome:"cancelled"}`——**read 档任何情况下不选 allow** | **S24a**（read→reject-once）/ **S24b**（write→allow-once）/ **S24c**（read + 仅 `allow_always` → cancelled）+ fake 模式 `perm_always` |
| **GAP-5** | append 内容含 `{{…}}` 未校验，会在 system prompt 组装阶段失败 | `#writeSessionPatch()` 在 **spawn 前**检测 `{{` 并抛可行动错误（不写 patch、不启进程；open_session 干净失败） | **S23**（错误含 `{{`；trace 断言"什么都没 spawn"） |
| **GAP-7** | reap 场景的 fake 命令形状不满足 matcher | S20 在临时目录造 `dsh.cmd` launcher 副本（命令行含 `dsh.cmd` token）+ 一条 owner 已死的 pid record，走**真** `cleanup` CLI 收割并删记录；GUI 形状/owner 活着的记录不动 | **S20**（真 cleanup 路径；`diag match` 正反例见 **S17**） |
| **GAP-8** | 标准布局 Electron-as-node 直起分支无覆盖 | `summary().agentSpecific.launchVia` 暴露实际启动形态；`e2e-dsh.mjs` **E1** 在 Windows 真机断言 `launchVia==="electron-node"`（生产主路径 live 覆盖），并验 pid/状态/关闭无残留 | `e2e-dsh.mjs` **E1/E5** |

剩余设计口径说明：**Q-1 `contextUsage.live`** 按 `STATE-session-viz.md` 取 `live:false`（上一轮快照语义），真机 **E2** 也断言 `live === false`；若未来要改 `live:true`，必须先改合同与夹具（§8.3）。

---

## 6. 验收矩阵

### 6.1 hermetic `tests/repro-dsh.mjs`（零 token，fake 驱动真桥；编号 = 实现侧场景号）

| 场景 | 覆盖点 / fake 模式 |
|---|---|
| S1 基础生命周期 | `ok`：persistent pid、`acpSessionId`、启动 argv/`--profile acp`、read tier env、无 patch 时无 `--patch`、`session/new{cwd,mcpServers:[]}`、首轮文本、`contextUsage{8816,live:false}`、close 后进程消失 |
| S2 model/effort + append patch | 友好名回显、`appendSystemPrompt.injectionMode==="system"`、patch 含 `personaPrefix`+角色正文、opaque model 值 `["deepseek-official","deepseek-v4-pro"]`、`xhigh→max` |
| S3 非法 model/effort | fail-fast（`not offered` / `reasoning effort`），无孤儿进程 |
| S4 write tier | `access:"write"` → `DSH_PERMISSION_MODE=danger-full-access` |
| S5 流式/工具/噪音 | `echo,streamchunks,toolcall,noisy,badjson,stderrwarn`：分块顺序累积、tool 事件上抛、stderr 记录不致命、非 JSON stdout 容忍 |
| S6 usage 变体 | `nousage`→null；`usageonly`→取最后一条 `{8816,live:false}` |
| S7 正常取消/复用 | `cancel`：abort→cancelled、同 pid、下一轮可用 |
| S8 wait 超时恢复 | `cancel` + inline `wait:true,timeout_ms`：超时 abort、会话可再用 |
| S9 并发 send | `hangprompt`：第二发被 `already has a running turn` 拒 |
| S10 close 在途/空闲 | 默认 `blocked`；`force:true` 关闭且假进程被杀；空闲 close |
| S11 回合错误/崩溃 | `promptfail`（-32603 后仍可复用）、`exitnonzero`（残件保留、进程死、后续 send 拒） |
| S12 open 失败三连 | `initfail`/`newfail`/`hanginit`：干净报错、无孤儿、hanginit 有界（ready timeout） |
| S13 环境清洗 | 宿主 `DSH_SESSION_ID/PROFILE/PROFILE_DIR/WEB_URL/SHELL` 全被剥、`DSH_HOME` 保留、桥诊断标记在 |
| S14 迟到事件 | `lateevents`：结算后的 chunk 不折叠进答案/下一轮 |
| S15 同 flush | `sameflush`：整轮一个 write 仍正确结算 |
| S16 schema 门 | `ok`：open + send 均以 `not supported for backend "dsh"` 拒 |
| S17 matcher 安全边界 | `diag match dsh-acp`：正例（dsh.cmd/Electron-cli.js/POSIX dsh + `--profile acp`）与反例（裸 GUI、headless/web/sdk、无 dsh 入口的 `--profile acp`） |
| S18 doctor | 假 launcher 下 dsh 行 `available:true, version:"0.2.1-rc.2"` |
| S19 pid record | `role:"dsh-acp"` + ownerPid；close 后记录删除 |
| S20 真 cleanup 收割 | 临时 `dsh.cmd` 副本 + owner 已死 pid record → 真 `cleanup` 杀孤儿并删记录（GAP-7） |
| S21 close 不可复用 | close 后 send 被拒 |
| **S22 wedge abort** | **`ignorecancel`**：cancel 被无视 → `abort` 返回 `{killed:true,reusable:false}`、进程死、状态 failed+dead、后续 send 被拒、超时有界（GAP-1） |
| **S23 模板花括号** | **`ok` + append 内容含 `{{`**：open 以含 `{{` 的可行动错误失败，且 trace 断言"未 spawn 任何进程"（GAP-5） |
| **S24 权限应答器** | **S24a `perm`** read→`reject-once` 且 turn 仍 end_turn；**S24b `perm`** write→`allow-once`；**S24c `perm_always`** read→`{outcome:"cancelled"}`（绝不选 allow），turn 仍 end_turn（GAP-2） |

### 6.2 fake 模式清单（`FAKE_DSH_MODES`，逗号组合；源码即文档见 `tests/fake-dsh.mjs` 头部 MODES/TRACE 段）

`ok`、`echo`、`streamchunks`、`slow`、`slowfirsttoken`、`toolcall`、`perm`(alias `permission`)、`perm_always`、`cancel`、`hangprompt`(alias `hang`)、`ignorecancel`、`hanginit`、`initfail`、`slowinit`、`newfail`(alias `sessionnewfail`)、`promptfail`、`crashturn`、`exitnonzero`、`crashready`、`stoprefusal`、`sameflush`、`lateevents`、`nochunks`、`empty`、`usageonly`、`nousage`、`ctxusage`、`noisy`、`badjson`(alias `badline`)、`stderrwarn`。
trace（`FAKE_DSH_TRACE`）：startup 行（argv/envProbe/patch 内容）+ 每请求行 + permission 回包行，是 §6.1 里所有"启动参数/环境/patch 注入/权限决策"断言的唯一来源。

### 6.3 真机 e2e：`tests/e2e-dsh.mjs` E1–E5（真 DSH；缺安装时 clean skip → exit 0）

| 场景 | 覆盖点 |
|---|---|
| **E1 真机 open（覆盖 GAP-8）** | 真 `dsh --profile acp` open（read、`effort:"low"`，不发消息）：idle+healthy、persistent pid、`acpSessionId`、`launchVia==="electron-node"`（**仅 Windows 断言**，生产直起主路径 live 覆盖）、effort 回显、model 由 DSH 默认 |
| **E2 真机一轮** | 文本往返（`DSH-E2E-OK`）、`turnSettled`、**`contextUsage{tokens>0, live:false}`**、idle+healthy、`turnCount/lastTurn` |
| **E2b append persona（真机）** | 生成 `--patch` 被 DSH 0.2.1-rc.2 接受；`appendSystemPrompt.injectionMode==="system"`；模型按注入 persona 答出 **PINEAPPLE-42**（§2.5-8 / D3 的 live 证据） |
| E3 多轮同进程 | 第二轮成功、pid 不变 |
| E4 abort + 复用 | 真长轮 abort → aborted 结算、同 pid 存活、再跑一轮成功 |
| E5 close 无残留 | close 返回 closed、进程树消失、pid record 清空 |

保留真机证据：命令、帧、耗时、进程树前后快照写到 `D:\cc\_dsh-eval\notes\`（feasibility 附录 A 格式）。fake 侧覆盖 wire/时序/竞态，E1–E5 覆盖真实启动器、凭据、persona 注入与进程树。

### 6.4 doctor / matcher / cleanup / 既有夹具（as-built）

- `doctor`：dsh 行 `{agent:"dsh", label:"DeepSeek Harness", available, version:"0.2.1-rc.2"}`；未安装/`DSH_BIN` 不存在 → `available:false` + 可行动错误（不崩 module load）。hermetic **S18** 用 fake launcher 验证；probe 有界性在 `tests/probe-doctor-timeout.mjs`（`DSH_BIN` 指 hang 包装器，`HANGABLE` 已含 dsh）。
- `tests/contract-invariants-session.mjs`：`AGENTS` 闭集加 `dsh`；injection 期望 `dsh: 'system'`；对 `dsh` 断言 `contextUsage.live === false`（合同侧钉住 Q-1 口径）。
- `tests/e2e-viz.mjs` 边界表：`dsh: ["pipe_enqueued"]`（附注释"ACP 无 turn-start ACK"）。
- `tests/repro-viz-bridge.mjs` **V6b**：真桥 + fake 会话断言 dsh 的派发证据只能是 `pipe_enqueued`（不冒充 ack）。
- `tests/repro-dsh.mjs` **S17** 用只读 `diag match dsh-acp` 跑正反例矩阵；**S20** 走真 `cleanup` CLI 验证收割。
- 未改：`tests/repro-context-usage.mjs`、`tests/e2e-append-system.mjs`（dsh 的 usage/append 已由 `repro-dsh` S1/S2/S6 与真机 E2/E2b 覆盖，故未重复加组）；`repro-health` / `repro-multiturn` / `repro-wait-shape` 期望天然过（`deriveHealth` 未改、未定义 `isReusable` 走 proc 活性）。

### 6.5 文档 / skill rollout（as-built：核心已落地）

已落地：`README.md`（Usage/Backends/Notes 的 dsh 条目）、`docs/INSTALLATION.md`（依赖、`DSH_BIN`、权限档、profile/凭据、清理）、`docs/DEVELOPMENT.md`（后端清单/形态、push-gate 夹具）、`docs/ARCHITECTURE.md`（版本节 + 差异）、`skills/agent-bridge/SKILL.md`（后端清单、真 system prompt、read 边界口径、contextUsage 非 null/live:false、model/effort 语义）。
待定（发布前检查）：`skills/agent-bridge-{roundtable,loop,graph,dev}` 中凡列"contextUsage 恒 null"的后端清单处，是否统一改为"dsh 非空"一句——按消费侧需要再补，不在本后端 PR 强制。

---

## 7. 触碰文件清单与分阶段计划

### 7.1 文件表（以符号名/文件名定位；行号快照会随实现漂移）

**新增**

| 文件 | 内容 |
|---|---|
| `docs/DESIGN-dsh-backend-2026-10-20.md` | 本文件（真理源） |
| `tests/fake-dsh.mjs` + `tests/fake-dsh.cmd` + `tests/fake-dsh.sh` | wire 级 ACP fake（882 行 + 2 行 shim、30 模式、trace；含 `ignorecancel` / `perm_always`） |
| `tests/repro-dsh.mjs` | hermetic 套件 S1–S24（零 token；含 S22/S23/S24 三个 v1.1 修复的固定测试） |
| `tests/e2e-dsh.mjs` | 真机 e2e E1–E5（缺 DSH 时 clean skip；E1 覆盖生产启动路径、E2b 覆盖真机 persona 注入） |

**修改 `scripts/agent-bridge.mjs`（已在 working tree 落地，符号名）**

| 符号 / 区域 | 内容 |
|---|---|
| `DSH_READY_TIMEOUT_MS / DSH_ABORT_SETTLE_MS / DSH_CONFIG_TIMEOUT_MS` | 30 s / 8 s / 10 s（env 可覆盖） |
| `AGENTS.dsh` | label/env/bin/role=`dsh-acp`/versionArgs/matchesCommand（D14） |
| `resolveDshBin()` / `resolveDshLaunch()` | D13 |
| `DshAcpSession` | 类本体（§4） |
| `#respondPermission` | D4 + GAP-2 加固（read 档永不 allow，S24a/b/c） |
| `AGENTS.dsh.Session = DshAcpSession` | late-bind |
| `openSession` / `sendMessage` | schema 门为通用 `agent!=="codex"`（自动覆盖 dsh）；S16 固定 |
| `doctor()` | dsh 分支：lazy resolve + `resolveDshLaunch` 探 `--version` |
| `TOOLS[0].description` / effort / append_system_prompt_file / doctor 描述 | DSH 段落（按符号名定位：`TOOLS` 的 open_session/effort/append/doctor description） |
| 其他引用（cleanup 文案等） | 视 rollout 补一句 |

**测试/文档更新**：见 §6.4/§6.5。

### 7.2 分阶段（P1/P2/P3）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 可行性评估 + 真机 spike（ACP 全握手/取消/权限/只读/patch/凭据）+ **owner-liveness Electron 修复**（`ownerStillRunning` 识别任意 `agent-bridge.mjs mcp` argv0，回归 `tests/repro-owner-electron-argv0.mjs`） | 已完成（本设计依赖 P0） |
| **P1** | 本设计文档 + `fake-dsh` harness + 字段映射表 | **已完成**（文档 v1.1 as-built；fake-dsh 30 模式 + trace） |
| **P2** | `DshAcpSession` + registry/resolver/launcher/matcher + doctor + prose + hermetic `repro-dsh` + 夹具更新 | **已完成**：核心 + fake-dsh（30 模式）+ repro-dsh S1–S24 + 夹具（contract-invariants / e2e-viz / repro-viz-bridge V6b / probe-doctor-timeout）+ 文档/skill rollout 均落地；GAP-1/2/5/7/8 已 CLOSED |
| **P3** | 跨引擎评审 → 修 → 真机 e2e + 发布 | **评审完成**：OMP deepseek-v4-pro（2026-10-20）判 **SHIP-WITH-FIXES，无 MAJOR**；MINOR（权限测试缺失）+ 4 NITs（pid-record teardown 顺序 / `allow*` 注释 / `DSH_SHELL` 测试缺口 / GAP 表过期）已全部处理（对应 S24a/b/c、§4.6、D4、S13、§5.3）。真机 e2e E1–E5 已落地；剩发布清单（版本号 bump、真机留证归档） |
| **P5（可选，不在 v1）** | 同 persona/档位的多会话共享一个 ACP 进程（省 ~250 MB/会话）；前置：把 persona 降级为首轮软前缀并明确标注，或等 DSH 支持 per-session system prompt/policy | 未决 |

---

## 8. 未决 / 风险

> **跨引擎评审结论（2026-10-20，OMP `deepseek-v4-pro`，reviewer 角色）**：**SHIP-WITH-FIXES，无 MAJOR**。MINOR（权限应答器缺测试）+ 4 NITs（pid-record teardown 顺序、`allow*` 注释、`DSH_SHELL` 测试缺口、GAP 表过期）已全部修入 as-built：S24a/b/c、§4.6、D4、S13、§5.3。

### 8.1 风险表

| # | 风险 | 现状 / 缓解 |
|---|---|---|
| R1 | **matcher 误杀桌面 GUI**（`DeepSeek Harness.exe` 同名） | matcher 要求 `--profile acp` + 入口 token；`diag match dsh-acp` 矩阵回归；残留风险：正则对命令行做子串判断（非 tokenize），但清理还叠加 pid-record/role/启动时间校验，误杀方向已被多道闸约束。 |
| R2 | **权限应答器必须实现 + read 档升级通道** | **已关闭**：应答器实现 + read 档硬保证"永不选 allow"（找不到 reject 就 `cancelled`）；S24a/b/c + fake `perm_always` 固定。请求无超时是源码事实，不是"可能"。 |
| R3 | **read ≠ 内核沙箱** | 文档口径已定（D4）；README/SKILL 不得写"与 codex 同级"。 |
| R4 | **内存 ~252 MB/会话** | roundtable 3–5 席可行；graph 大并发需限制 dsh 节点数（文档写明）；P5 共享进程是唯一缓解。 |
| R5 | **model 值为 opaque JSON + 目录可变** | 动态解析 + open 时 fail-fast（D5）；不硬编码；`agentSpecific.acpConfig` 暴露真实值便于诊断。 |
| R6 | **stdout 非 JSON 行** | 解析器跳过+记日志（已实现）；可选后续在 patch 里加 `- id: llm-deepseek-account / disabled: true` 消噪（实测有效，但会让模型目录少一组选项，v1 不加）。 |
| R7 | **版本门槛** | doctor 只探 `-V`（快）；`--profile acp` 不存在时 `initialize` 超时/失败 + 可行动错误（含"升级 DSH"提示）。未在 doctor 里加 `--profile acp --help` 能力探测（+2 s 且会 profile 首启）——作为可选项记录。 |
| R8 | **环境继承 / DSH_HOME** | D12 策略；桥会话会出现在用户 DSH GUI 的 session 列表（预期，文档写明）；hermetic 测试用临时 `DSH_HOME` 隔离。 |
| R9 | **会话存储单写者** | 一桥会话一进程、只驱动自己创建的 session id；不使用 `--session-id`/resume；禁止两个桥进程驱动同一 DSH 会话（文档写明）。 |
| R10 | **嵌套行为** | ACP 默认无 MCP（§2.5-5）；但 base 会自动读项目 `AGENTS.md`/`CLAUDE.md`、带 DSH 原生 subagent/compaction 工具——桥只观测根会话（与 claude 后端一致），文档写明。 |
| R11 | **patch YAML 转义 / `{{…}}`** | 块标量+逐行缩进已实现；**`{{` 在 spawn 前拒绝**（S23，fail-fast，不写 patch/不启进程）；临时路径含空格/元字符时，标准布局直起无 cmd 重解析（回退布局才有，hermetic 路径无空格）。 |
| R12 | **Electron 宿主下 owner 存活误杀**（P0 暴露） | **已修复**：`ownerStillRunning` 改为"命令行含 `agent-bridge.mjs` + `\bmcp\b`"即视为存活（不再看 argv0；按符号名定位），回归 `tests/repro-owner-electron-argv0.mjs`；dsh 后端继承该修复（方向 B 嵌套桥不再误杀外层子进程）。 |
| R13 | **DSH 桌面 GUI 共存** | 共享 `DSH_HOME`/凭据/会话目录；只写每会话 temp patch、不改用户 profile patch；并发 2 进程实测无锁问题。未验证：首次使用 acp profile 自动初始化与 GUI 同时写 profile 目录的竞态 [推断]（§8.2-3）。 |
| R14 | **abort wedge** | **已关闭**：超时 → 结算 failed + 杀树 + 清 `acpSessionId`，返回 `{killed:true,reusable:false}`；不再可能出现"声称取消成功但 backend 还在跑"（S22）。 |
| R15 | **contextUsage `live` 语义** | 决定 `live:false`（上一轮快照，合同 `STATE-session-viz.md` 定义）；真机 E2 与合同夹具均断言 `live:false`。若未来改 `live:true` 必须先改合同。 |
| R16 | **平台范围** | 真机只验证 Windows；`resolveDshBin` 的 POSIX 候选路径是 [推断]。文档口径：v1 Windows 已验证、POSIX 尽力支持（hermetic 的 `.sh` fake 覆盖 wire，不覆盖安装布局）。 |
| R17 | **关闭竞态** | `close()` 发 `session/close` 后立刻 `stdin.end()` + kill；ACP 有界停机 5 s。若 `session/close` 响应来不及，靠进程退出兜底——不影响正确性（状态已 closed）。 |
| R18 | **usage 语义** | `used` 是 tokenMeter 重放估算（非账单/非真实计费），`size` 是 contextWindow；只作为"上下文卫生"信号，不做计费/限额承诺。 |

### 8.2 待 spike（真机确认；按风险排序）

1. `--patch` 删除时机：**已由 E2b 真机证实**——patch 注入 persona 在 start 后删文件仍对后续轮生效（真机 DSH 0.2.1-rc.2）。
2. `!!js` 表达式注入角色（本设计未采用；若将来要支持超长角色文件再验）。
3. `DSH_HOME` 隔离 + profile 自动初始化的并发竞态（2 进程同时首启）——未验；hermetic 用临时 `DSH_HOME`。
4. 凭据 override 组合（禁 `credentials`/`authorization`/`deepseek-account`）在 ACP profile 能 boot 且 env key 生效（本设计默认用托管存储，不强制）。
5. 真机 `--profile acp --help` 作为 doctor 能力探测的取舍（当前不做，只探 `-V`）。
6. ~~角色文本含 `{{…}}` 的真实失败路径~~ **已不需要**：桥在 spawn 前拒绝 `{{`（S23），DSH 收不到该输入。
7. ~~标准布局直起分支覆盖~~ **已关闭**：E1 真机断言 `launchVia==="electron-node"`，E5 验进程树无残留。
8. 只读档 shell 的 enforcement `partial` 在具体工具集下的实际边界（文档只承诺"工具面写围栏"）。

### 8.3 偏差关闭状态（相对本设计/任务书；v1.1 as-built）

| 编号 | 原偏差 | 状态 | 关闭依据（实现 + 固定测试） |
|---|---|---|---|
| GAP-1 | abort 超时只强结算为 idle、不杀进程 | **CLOSED** | 超时 → `#settleTurn(err)`（failed）+ `#killWedgedProcess()`；返回 `{killed:true,reusable:false}`；**S22** + `ignorecancel` |
| GAP-2 | read 档权限兜底可能 allow | **CLOSED** | read 档 `reject_once→reject*→cancelled`，永不选 allow；**S24a/S24b/S24c** + `perm_always` |
| GAP-5 | append 内容 `{{…}}` 未校验 | **CLOSED** | `#writeSessionPatch()` spawn 前含 `{{` 即抛；**S23**（trace 断言未 spawn） |
| GAP-7 | reap 场景 fake 命令形状不匹配 matcher | **CLOSED** | **S20** 临时 `dsh.cmd` 副本 + 死 owner pid record → 真 `cleanup` 收割；matcher 未放宽 |
| GAP-8 | 标准布局直起分支无覆盖 | **CLOSED** | `summary().agentSpecific.launchVia`；**E1**（Windows 断言 `electron-node`）+ **E5** 无残留 |
| Q-1 | `contextUsage.live`（任务书初稿 true） | **按合同定案** | `live:false`（`STATE-session-viz.md` 快照语义）；合同夹具与真机 **E2** 均断言 `live:false`；改 true 需先改合同 |
| — | 跨引擎评审 MINOR/NITs | **CLOSED** | 权限测试（S24）、pid-record teardown（§4.6）、`allow*` 注释（D4）、`DSH_SHELL` 测试（S13）、GAP 表过期（本节） |

> 无阻塞项残留；发布剩余动作是常规清单（版本号 bump、真机 e2e 输出归档、发布说明），不是设计缺口。

---

## 附录 A：证据索引

- 真机 ACP 帧/时序：`D:\cc\_dsh-eval\notes\00-lead-spike.md`（140 行）、`acp-spike-frames.log`、`spike-acp.mjs`/`spike2-acp.mjs`/`spike3-concurrent.mjs`；本文 §2 的 `[实测]` 全部可从这里复跑。
- 落地验证（v1.1）：`tests/repro-dsh.mjs`（S1–S24，零 token）、`tests/e2e-dsh.mjs`（E1–E5，真机；E2b 为 persona 注入 live 证据）、`tests/fake-dsh.mjs`（wire fake + trace 格式）。跨引擎评审（OMP `deepseek-v4-pro`，2026-10-20）= SHIP-WITH-FIXES，无 MAJOR；MINOR+4 NITs 已修（见 §8.3）。
- 桥契约（注册表/类接口/共享管道/viz/测试惯例/file:line 地图）：`D:\cc\_dsh-eval\notes\01-bridge-contract.md`（366 行）。
- DSH 运行时（ACP wire 精确形状、SDK/headless 对比、patch/persona/instructions/权限沙箱源码证明、锁与 DSH_HOME）：`D:\cc\_dsh-eval\notes\02-dsh-runtime.md`（569 行，SRC/DUMP/LIVE/INFER/SPIKE 标签）。
- 反向方向（DSH 当客户端；R12 的起源）：`D:\cc\_dsh-eval\notes\03-dsh-client.md`、`04-direction-b-live-run.log`、`06-direction-b-applied.log.md`。
- DSH 源码（0.2.1-rc.2，从 `resources/app.asar` 抽出，306 包可 grep）：`D:\cc\_dsh-eval\asar\node_modules\@deepseek-ai\`；关键包：`dsh-acp`、`dsh-acp-app`、`dsh-base`、`dsh-system-prompt`、`dsh-user-approval`、`dsh-fs-sandbox`、`dsh-sandbox-windows-acl`、`dsh-session-persistence-jsonl`、`dsh-token-meter`、`dsh-llm-deepseek`、`dsh-headless`、`dsh-sdk-protocol`。
- 配置快照：`D:\cc\_dsh-eval\acp-config.yml`（`dsh --profile acp --dump-config`，377 行）、`headless-config.yml`。
- 上游评估：`docs/FEASIBILITY-dsh-backend-2026-10-20.md`（证据标记与路线图）。
- 同类设计模板：`docs/DESIGN-kimi-code-backend-2026-07-18.md`（§2 真机约束、§5 实现、§7 abort/close、§8 验收）、`docs/DESIGN-cursor-agent-backend-2026-07-15.md`。

## 附录 B：与另两个后端的形状对比（一屏）

| 维度 | codex（模板 A） | kimi（模板 B） | **dsh（本设计）** |
|---|---|---|---|
| 进程 | 持久 1 进程 | 每轮短进程 | **持久 1 进程/会话** |
| 传输 | NDJSON JSON-RPC | stream-json stdout | **NDJSON JSON-RPC（ACP v1）** |
| 轮末信号 | `turn/completed` 通知 | child exit + meta | **`session/prompt` 响应 `{stopReason}`** |
| 取消 | `turn/interrupt` 请求 | 整树 kill | **`session/cancel` 通知（会话可复用）** |
| 模型/effort | 每轮参数 | `-m` / 忽略 | **会话级 `set_config_option`** |
| system prompt | developerInstructions（真） | 首轮软前缀 | **`--patch` `personaSuffix`（真）** |
| contextUsage | live:false 快照 | null | **live:false 快照（唯一 ACP 通道）** |
| viz 边界 | `turn_start_ack`/通知 | `os_spawned` | **`pipe_enqueued`（无 ACK 的诚实档）** |
| access read | OS read-only 沙箱 | 提示软约束 | **工具面写围栏（非内核）** |
