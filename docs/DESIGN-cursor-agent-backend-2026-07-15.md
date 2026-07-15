# DESIGN — Cursor Agent 作为 agent-bridge 第 4 后端（`cursor`）

状态：**v4 已实现 + 三轮复审收敛至 APPROVE（未提交）。** 日期 2026-07-15。作者：主 agent（Claude Opus）。
真理源：本文件。落地后回填 commit。

> **最终评审结论**：Codex gpt-5.6-sol 三轮（+一次针对 A 的定点复核）+ deepseek-v4-pro 一轮 → **双评 APPROVE**。15 hermetic + repro-health 回归 + 真 doctor + 真 e2e（happy path 改前跑通；改后遇 Cursor 云端 `[unavailable]` 持续抖动，桥按失败轮正确处理）。评审轮次：R1（1 blocker+5 major 全修）→ R2（blocker/ENOENT/matcher RESOLVED，另补 4 项：pipelined-close 竞态/logger 抛/中毒态谎报/close 删记录时机）→ R3（B/C/D RESOLVED，A 的守卫误清 this.proc 会废掉 close 的 force-kill 兜底 → 改为不动 this.proc 只 bail）→ R3b：**A RESOLVED, APPROVE**。

> **v4 更新（已实现 + 实现后双评 + 实测）**
>
> 实现落在 `scripts/agent-bridge.mjs`（未提交，~+600 行）：CURSOR_* 常量、AGENTS.cursor 注册项、`resolveCursorLauncher`/`cursorPickLauncherFromDir`/`cursorVersionKey`、`class CursorAgentSession`、`deriveHealth` isReusable 钩子、doctor cursor 分支、openSession append_system 拒绝、doctor/usage 文案。测试 `docs/repro-mcp-hang/fake-cursor-index.js` + `repro-cursor.mjs`（15 场景全过）。
>
> **验证**：hermetic 15/15；`repro-health` 回归通过（三旧后端 deriveHealth 字节级不变）；真 doctor `cursor: ok … 2026.07.09-a3815c0`；**真 e2e**（登录 cn-coding）：真 cursor 跑 read+shell 一轮、经 shellToolCall 读文件返回随机 nonce、contextUsage=null（发布前又遇 Cursor 云端 `Error:[unavailable]` 持续抖动——桥正确按失败轮/degraded/可复用处理，非代码问题，调用行完全正确）。
>
> **实现后双评**：deepseek-v4-pro=APPROVE（6 minor/nit，其中 stderr 4000 上限实与 claude 一致，非缺陷）；Codex gpt-5.6-sol=CHANGES-NEEDED（1 blocker + 5 major + minors），**已全部修复**：
> - [blocker] abort settle-timeout 兜底改为**中毒（poison）而非重置**：结算为 failed、保留 this.proc + pid 记录，send() 加 `if(this.proc)throw` 闸门，直到 wedged child 自身 close 才清 proc/记录——杜绝同 chat 并发轮/孤儿。
> - [major] create-chat child 挂 this.proc（close() 可杀）、确认 close 才删记录、start() 遇并发 close 早退不复活。
> - [major] `spawn()` 同步抛纳入 releaseUnbegun 清理；cmdline 改**带引号膨胀估算**。
> - [major] send() 加 **ENOENT 一次性重解析重试**（自动更新删版本目录）。
> - [major] matcher 只取 ` -- ` 前的头部（prompt 不参与）+ `[\\/]cursor-agent` 段边界 + 需 `-p`+stream-json+`--resume`；自定义根的清理局限已注明。
> - [minor] abort 空转清 lastTurnError/failed→idle；bare `agent.ps1` 先试精确名；chatId 锚定解析；summary 调 `this.contextUsage()`。
> - 新增 hermetic 场景：spawn 失败/NUL+超长/轮中 close/pid 隐私/**真 cleanup 匹配路径**/能力闸门。
>
> **Codex 二轮复审（复审修复）**：blocker/ENOENT/matcher 判 RESOLVED；再挑 4 项（均已修）：
> - [new race] pipelined `close()` 撞 send() 的 spawn-await 会复活已关会话 → send() 在 `#beginTurn` 前加 `if(status==="closed"||this.turn!==myTurn)` 守卫：SIGKILL 刚生的 child、bail，不写 pid/不 begin。
> - [#3 根因] `appendLog`/`writePidRecord` 未捕获 fs 抛 → 预 spawn 一行日志抛就把 `this.turn` 永占。**根因修**：两者整体 try/catch(与 removePidRecord 对齐,best-effort 诊断永不打断控制流;三旧后端仅"吞 IO 错"无行为变化,repro-health 回归过)。
> - [#6] 二次 abort 落在**中毒态**(turn=null 但 proc 仍活)会谎报 failed→idle/healthy → abort 空转归一化加 `!this.proc` 闸门,中毒态保持 failed/degraded。
> - [#2] 同步 close() 未确认杀死就删 pid 记录 → cursor 自有 close() 改为**杀活 child 时把删记录推迟到 child 的 close 事件**(杀失败也留可回收痕迹;removePidRecord:false 关机仍完全遵守)。
>
> **v4.1 追加（用户要求）**：**cursor 现支持 `append_system_prompt_file`** —— 无原生 system flag，故落地为**首轮用户前缀软注入**（openSession 不再拒、读文件；构造器存 content + `appendSystemPending`；`#composePrompt(msg, injectSystem)` 组 [会话指令(仅首轮)]→[read 只读策略]→[用户消息]；send 里 `injectSystem=appendSystemPending`，**仅在 turn 真正 begin 后**清 pending，故首轮 spawn 失败/too-long 会在重试重注；summary `injectionMode:"first-turn-user-prefix"` 诚实标注）。遵从看模型；**与消息共享 ~24K argv 预算**（大 system 会被 cmdline 闸门明确拒，不静默截断）。hermetic S16（首轮注、turn2 不注、summary 诚实）+ **真 e2e**：真 cursor 回复以注入要求的 `ZORB7_OK` 开头（模型确实遵从）。
>
> **未做（§9 rollout，另开）**：skills（dev/roundtable/loop 现**可**给 cursor 注角色了，但要清楚是 soft/首轮/受 argv 预算所限，长会话经压缩可能漂移；roundtable/loop 的 contextUsage.tokens 排序仍须把 null 当 unknown）+ README/INSTALL/SKILL 三→四后端 + 本文件回填 commit。

> **v3 更新（复审 + 探针结果）**
>
> **Codex 二轮复审判定「暂不能开工」，追加 5 个代码前必须定项 + 4 个新 bug（已折入下文）**：
> - 终止状态机要**统一**：abort/timeout/error 也必须等 child `close` 后才清 turn/proc（§2.1/§7）。
> - matcher 定稿为 turn/create-chat **两分支带共同 Cursor 路径约束**的完整正则（§5.1），防过宽误杀无关 `node index.js create-chat`。
> - **native resolver 统一** start/send/create-chat/doctor（§5.5/§5.9）。
> - **doctor 新 bug**：`CURSOR_AGENT_BIN=node.exe` 会把 Node 版本误报成 Cursor 版本 → doctor 不能拿 node.exe 跑 `--version`（§5.9）。
> - abort 后策略反映到 `isReusable()`（§7 探针已证安全，见下 → v1 不需 poisoned 标志）。
> - `isReusable` 命名/调用点、send 新顺序各失败路径一致性：已在 §5.2/§5.3 明确。
>
> **三个探针（登录 cn-coding，直起 `versions\<v>\node.exe index.js`，样本 scratchpad `cursor-spike/`）**：
> 1. **delta 语义**（§2.1）：带 `--stream-partial-output` 时 `assistant` 事件是**单 token 片段（append，非累积）**（实测 42 事件 len 1-3）。→ **v1 决定不加 `--stream-partial-output`**，用完整 assistant 块 + `result.result` 取终答，规避 delta 拼接（tail 略粗可接受）。
> 2. **§7 abort 幽灵**（§7）：长轮 shell 跑起来后整树 kill → **本地文件未写、0 残留进程；resume 同 chat → 模型答"上一轮被中断、未完成"，无幽灵完成结果**。→ **abort=树 kill 本地进程是安全的、chat 可复用**，isReusable 不需污染标志。kill 那刻子孙进程 **7 个**（cmd→powershell + node 助手 + conhost）→ **必须 `terminateProcessTree` 整树杀**。shell 冷启动到真正执行要 **~81s**（超时/延迟设计要留足）。
> 3. **§6.2 native edit 工具**（§6.2）：Cursor CLI **有**独立 `editToolCall`（"Write" 工具）≠ shell。但 per-session 禁它无干净途径（无 CLI flag；deny 仅在**全局** `~/.cursor/cli-config.json`，不可为桥会话改用户全局配置）→ **v1 read 维持软档（两档 `--force` + 角色纪律），edit-deny 列未来精化**。
>
> **附带验证**：**直起 `node.exe index.js` 方案可行**（create-chat + turn 均跑通，argv 直传含 `--` 正常）；`create-chat` 返裸 UUID 稳定；瞬时 `[unavailable]`/WebSocket 抖动在本环境偶发（重试即过）。

> **v2 评审修订摘要（Codex 结论「不能直接按 v1 开工」，已折入）**：
> - deriveHealth 改法漏了 `starting/running→healthy` early return（v1 会回归）→ §5.3 修正；hook 改名 `isReusable()`。
> - `matchesCommand` 的 `/\b--resume\b/` **匹配不到** ` --resume `（`--` 前无 `\b`）→ §5.1 改 `/(?:^|\s)--resume(?:\s|$)/`。
> - prompt 缺 `--` 分隔符（会把 `--help…`/`status`/`resume` 当 option/子命令）→ §5.5 加 `--`。
> - shim 回退带 prompt 不安全，必须 **fail-closed**（不是告警后继续）→ §5.5。
> - `result` 与进程 `close` 的终止边界矛盾 → §2.1/§5.2 定死状态机（result=语义结果，close=资源结算边界）。
> - read「deny 编辑工具=真只读」说法**错**（shell 仍能写=软 read）→ §5.4/§6.2 修正；角色提示注入点明确。
> - create-chat 子进程未纳入生命周期契约（超时/pid/清理）→ §5.9 补。
> - `close()` 必须**同步**且遵守 `removePidRecord:false`；契约漏列 `contextUsage()/isReusable()/finalAnswer/lastStderr/chatId` → §5.2。
> - Windows 整树 kill 直接复用 `terminateProcessTree`/`scheduleForceKill`，不新造 → §7。
> - §7 abort 后同 chat 可复用性是**发布门槛**，不能以「云端不管」略过。
> - 平台范围：v1 **Windows-only**，非 Windows fail-fast → §5/§9。

---

## 0. 一句话

给 agent-bridge 加第 4 后端 `cursor`（Cursor CLI，启动命令 `agent`/cursor-agent），因为**有些项目只能用 Cursor**、用不了 omp/codex/claude——覆盖面需求，不是"更强引擎"。四个后端里 Windows 上约束最多：会话形状不同（云端 chat + 每轮短命进程），且需动一处共享契约函数（`deriveHealth`）。

---

## 1. 动机与非目标

- **动机**：某些环境/仓库只授权 Cursor。为让 agent-bridge 在这些环境仍能委托，需要 `cursor` 后端。
- **非目标**：不追求默认/首选引擎；不实现 Cursor 云端 `worker`；不主动删 Cursor chat（无 `delete-chat`，接受残留）。
- **平台范围（v1）**：**仅 Windows**（本机安装形状 = `node.exe + versions\`）。非 Windows 在 `start()`/open 时 **fail-fast** 并给明确错误；POSIX 布局与启动策略留 TODO（§9）。

---

## 2. 登录后实测得到的硬约束（spike，Windows headless `-p`）

> 全部来自 2026-07-15 真跑（账号 cn-coding@innocellence.com）。样本在 scratchpad `cursor-spike/*.ndjson`。

1. **`-p/--print` 一次性**：喂 prompt→跑完→出 `result`→**进程退出**。无多轮 stdin 输入协议。续聊靠 `create-chat`（返裸 UUID）+ `--resume <chatId>`；两个不同 OS 进程可续同一 chat。→ 形状 B（§4）。
2. **prompt 只能走 argv**：`-p` 从 stdin 收 prompt 会**挂起（0 输出）**。`agent` = `.cmd`/`.ps1` shim（无 `agent.exe`），内部跑 `versions\<latest>\node.exe index.js`。
3. **Windows 无 OS 沙箱**：`--sandbox enabled` 在 Windows **直接报错**。写边界只能落审批层 = 软。
4. **read/shell 开关纠缠**：`--force` → shell 自动跑但**同时放开写**；不带 `--force`（即便 `--auto-review`）→ shell **全被拒**（原生读文件工具仍可用）。**没有"跑 shell 但禁写"的中间档**。
5. **stream-json 无 token 用量**：`result` 只有 `duration_ms/duration_api_ms/is_error/subtype/result`。
6. **延迟大**：单轮 78–190s。
7. **`create-chat`** = 裸 36 字符 UUID。

### 2.1 stream-json 事件 schema + 终止状态机（parser 地面真值）

一行一个 JSON，`session_id`=chatId。`type`：

| type | 关键字段 | parser 动作 |
|---|---|---|
| `system`(subtype init) | apiKeySource/cwd/session_id | 记 chatId；标记 turn 已开始 |
| `user` | 回显本轮输入 | 忽略；**不再落日志/不回显 prompt**（§5.5 隐私） |
| `thinking`(subtype delta) | text=推理流 | **不落日志** |
| `assistant` | message.content[].text | 累积到 `lastAssistantText`（增量规则见下★） |
| `tool_call`(started/completed) | tool_call.shellToolCall.args.command（call_id 内嵌换行） | 压 events（过滤高频） |
| `interaction_query` | 如 switchModeRequestQuery 审批回执 | 压 events |
| `connection`/`retry` | 网络层 | 压 events（诊断） |
| `result` | subtype:"success", is_error, duration_ms, **result=终答字符串** | 记语义结果（见状态机） |

**★ assistant 增量规则（探针已敲定）**：带 `--stream-partial-output` 时 `assistant` 是**单 token 片段（append）**（实测 42 事件 len 1-3）。**v1 决定：不加 `--stream-partial-output`** → `assistant` 为较完整块，避免逐 token 拼接；终答一律取 `result.result`，`assistant` 块仅喂 `lastAssistantText`/进度 tail（tail 略粗可接受）。若日后要更细 tail 再开 partial + append。

**终止状态机（v3——统一所有路径都"等 close 才结算"）**：
- `result` 事件 = **记录语义结果**（`finalAnswer`/失败标记），**不**立即释放 turn。
- 进程 `close`（stdout EOF + exit）= **唯一资源结算边界**：到此才 `#settleTurn`（释放 turn promise、`proc=null`、删 pid record、回 idle/failed）。
- **无 `result` 就 close** → 协议错误、失败结算（不拿 partial assistant text 冒充成功）；**非零 exit** → 失败；`result.is_error||subtype!=="success"` → 失败但仍等 close。
- **abort / timeout / error 路径同样只在 child `close` 后清 `turn/proc`**（Codex 二轮：不能只成功路径这么做；否则新轮可能在旧 child 退出前启动、旧 close handler 删新轮 pid record/清新 proc）。
- **单一幂等 `#settleTurn`**：error/result/close/abort/timeout 竞争下 promise 只 resolve/reject 一次；close handler 先判 `this.proc === child` 再动状态（§7 不变量）。

---

## 3. 用户已拍板的设计决定

1. **read 不用 `--mode plan`**（禁 shell）。要像 omp/claude 的 read=读+**能跑 shell**（软边界）→ read 也走 `--force`。
2. **read/write 都用 YOLO（`--force`）**；写边界软（Windows 无 OS 沙箱）。
3. **云端 worker/留存不考虑**（但 abort 后同 chat 可复用性仍是发布门槛，§7）。
4. **无 token 用量 → `contextUsage` 恒 `null`**；桥永不对 cursor "关旧开新"，依赖 Cursor 自压缩（这是**编排层假设，不硬编码**，§5.7）。

---

## 4. 架构：形状 B（逻辑 session 常驻 + OS 进程按轮短驻）

- **逻辑 session** 在 bridge 内常驻，身份=`chatId`。
- **OS 进程按轮短驻**：`send()` 每轮 spawn 一个 `node index.js -p --resume <chatId> …`，跑完退出；轮间 `this.proc=null`。
- 不采纳"常驻 broker 假装 proc 永在"（bridge 本身就是 broker）。

---

## 5. 具体实现

### 5.1 AGENTS 注册表新增（`scripts/agent-bridge.mjs` ~96-124）

```js
cursor: {
  label: "Cursor Agent",
  env: "CURSOR_AGENT_BIN",
  bin: "agent",
  role: "cursor-stream-json",
  versionArgs: ["--version"],        // doctor 预检（无需登录）——但见 §5.9 doctor node.exe 陷阱
  // 直起 node 后命令行 = node.exe <...cursor-agent...\versions\<v>\index.js> <子命令/flags>。
  // 共同约束(必须命中 cursor-agent 的 index.js) + 两分支(turn / create-chat)，防误杀无关 node。
  matchesCommand: cmd => {
    const isCursorEntry = /cursor-agent[\\/](?:versions[\\/][^\\/]+[\\/])?index\.js/i.test(cmd);
    if (!isCursorEntry) return false;
    const turnBranch =
      /--output-format\s+stream-json/.test(cmd) && /(?:^|\s)--resume(?:\s|$)/.test(cmd);
    const startBranch = /(?:^|\s)create-chat(?:\s|$)/.test(cmd);
    return turnBranch || startBranch;
  },
}
```

- **v1 bug 修正（Codex 一轮）**：`/\b--resume\b/` 匹配不到 ` --resume `（`--` 前无词边界），改 `/(?:^|\s)--resume(?:\s|$)/`。
- **create-chat 分支（Codex 二轮：防过宽）**：start 期短进程是 `node … index.js create-chat`（无 `--resume`）→ 单独一个 `create-chat` 正则会命中无关 `node index.js create-chat`；故 **create-chat 分支也挂在"必须是 cursor-agent 的 index.js"这个共同约束下**（`isCursorEntry` 前置门）。见 §5.9。

### 5.2 `CursorAgentSession` 类（实现隐式契约 banner :1349）

以 `ClaudeCodeSession` 为骨架（事件驱动、无状态轮询）。

**必须实现的成员（banner + 通用路径实际无条件调用的）**：
- `async start()` / `async send(msg,opts)` / `async result(opts)` / `isSettled()` / `refreshStatus()` / `async abort()` / **`close(opts)`（同步！）** / `summary()`
- **`contextUsage()`**（buildSessionResult:822、wait snapshot:3318 无条件调）→ 恒 `null`
- **`isReusable()`**（deriveHealth 新 hook，§5.3）→ `this.status!=="closed" && !!this.chatId`

**必须持有的字段（统一 summary/通用路径按名读）**：
```
id, agent, cwd, access, write, model, effort(=null 有效值),
status, isStreaming, lastAssistantText, finalAnswer,
lastError, lastStderr, lastTurnError,
events, proc, logFile, answerFile, pidFile,
createdAt, updatedAt,
currentTurnId, lastTurnId, turnStartedAt, turnEndedAt, turn, turnCount,
chatId
// name / returnMode 由 openSession(:3158) 赋值(openSession-owned)，returnMode 被 buildSessionResult(:808) 读；
// appendSystemPrompt 显式初始化 null；schema 被拒故无需 _requestedSchema
```

**`summary()` 精确统一 shape**（Codex 给定）：
```js
{
  id, agent, cwd, access, write, model,
  effort: null,
  status,
  pid: this.proc?.pid ?? null,
  createdAt, updatedAt, lastError,
  lastStderr: this.lastStderr ?? null,
  name: this.name ?? null,
  health: deriveHealth(this),
  contextUsage: null,
  appendSystemPrompt: null,
  logFile,
  lastTurn: lastTurnOf(this),
  agentSpecific: { chatId: this.chatId, turnCount: this.turnCount },
}
```

**关键方法语义**：
- `start()`：跑 `create-chat`（§5.9 生命周期）拿 chatId；解析裸 UUID（trim + UUID 形态校验，非法 fail-fast）；置 `idle`；proc=null。认证失败（未登录）给清晰错误。**非 Windows fail-fast**。
- `send()` **顺序（修正 v1 的 #beginTurn→spawn 错序）**：①同步占 `this.turn`（堵并发 send）→ ②spawn 短进程 + 挂 listeners → ③await `spawn` 成功 → ④`#beginTurn`（清本轮 finalAnswer/lastAssistantText + turn clock）→ 失败则释放 `this.turn`、**保留上一轮结果**、不 bump turnCount。
- `result()` → `buildSessionResult(this, finalAnswer||lastAssistantText, opts)`。
- `isSettled()` = `status==="idle" && !this.turn`（不看 proc）。
- `refreshStatus()` = 同步 no-op。
- `abort()`：见 §7（复用 terminateProcessTree/scheduleForceKill，不变量严格）。
- `close(opts)` **同步**（closeOne:3399 不 await；async 会污染返回 shape）：有活跃轮 kill child；**遵守 `removePidRecord`**：`if (options.removePidRecord !== false) removePidRecord(this.pidFile)`（进程级 shutdown :3824 传 `false` 以保留顽固子进程记录给下次 cleanup）；忘掉 chatId。
- `contextUsage()` = 恒 `null`。
- `lastTurnError`：成功轮清 `false`、失败轮置 `true`、用户 abort 清 `false`。

> banner(:1354) 应补列 `contextUsage()` 与 `isReusable()` 两个"通用路径无条件调用"的成员。

### 5.3 唯一共享代码改动：`deriveHealth()` liveness hook（:771）

**v1 bug**：v1 示例在 `closed` 后直接进 hook，**漏了现存 772-773 的 `starting/running→healthy` early return** → 会让"starting 无 proc 窗口""running 刚被 signal kill 窗口"更早/错误判 dead，**不是零回归**。

**正确改法（保留 772-773，只替换 settled liveness 777-779）**：
```js
function deriveHealth(session) {
  if (session.status === "closed") return "dead";
  if (session.status === "starting" || session.status === "running") return "healthy";

  const reusable =
    typeof session.isReusable === "function"
      ? session.isReusable()
      : (session.dead !== true && !!session.proc &&
         session.proc.exitCode == null && session.proc.signalCode == null);

  if (!reusable) return "dead";
  if (session.status === "failed" || session.lastTurnError === true) return "degraded";
  return "healthy";
}
```
- 命名 `isReusable()`（health 语义=可否复用；`!!chatId` 只证逻辑可续，非云端 alive）。
- **不 catch hook 异常偷偷返回 dead**（类内 hook 抛异常是实现 bug，由测试暴露）。
- omp/codex/claude **不定义** `isReusable` → 走 else 分支，行为字节级不变。

**全仓通用 `.proc` 读取只有三处**（已核，与主 agent 独立交叉核对一致）：
| 位置 | 形状 B 影响 |
|---|---|
| `deriveHealth:777` | **破坏** → 本节修 |
| `activeLogPaths:1128` | 不破坏（proc=null→procExited 假→活 session 日志继续受保护，正是所需） |
| `cleanupAndExit:3806` | 不破坏（轮间 journal `backendPid:null` 是真实状态；活跃轮记当前 pid） |

其余 `.proc` 都在三现有后端类内部，不读 Cursor。

### 5.4 access 映射（read/write 都 `--force`）

| 档 | Cursor flags | 边界性质 |
|---|---|---|
| write | `-p --force --trust --workspace <cwd>` | 软（Win 无 OS 沙箱），= omp/claude write@Win |
| read | `-p --force --trust --workspace <cwd>` + **read 策略**（下） | 软 read |

- 每轮带 `--trust --workspace <cwd>`。
- **v1 诚实修正**：`--force` 下 read/write flags 相同，且 Cursor 默认放开原生写工具 → 若无额外处理，Cursor read **比 omp/claude read 更宽**。read 档必须二选一（§6.2）：
  - (a) `--force` + `permissions.deny` 掉原生 Edit/Write 工具（**仍软**：shell 能 `Set-Content`/`Remove-Item`）；或
  - (b) 每轮 read prompt 前置一段 **bridge-owned "不要修改文件"指令**（承认是 user-layer policy，**不是** system prompt）。
- **不得**宣称"真只读"。文案：`原生写工具被禁、shell 仍可写；比全 YOLO 少误写，但非 OS 级只读`。

### 5.5 prompt 传参：**直起内部 node，绕 `.cmd` shim**

- **native 直起无注入**成立：spawnPlan(:435) 对 native exe 返 clean argv、不过 shell → `& % ^ | < >` 无 cmd 语义、libuv 负责 argv quoting。
- **参数序列必须加 `--`**（v1 漏，correctness blocker）：
  ```
  node index.js -p --resume <chatId> --output-format stream-json --stream-partial-output
    --force --trust --workspace <cwd> [--model <m>] -- <PROMPT>
  ```
  不加 `--`：`--help…` 开头会被当 option；prompt 恰为 `status`/`resume` 等会被当子命令。
- **shim 回退：带 prompt 必须 fail-closed**（v1 "告警后继续"不安全——`& | < > ^`/`%VAR%`/delayed `!VAR!`/引号换行/cwd 元字符）：
  - doctor 的 `--version` 可走 shim（无自由 prompt）；
  - **携带用户 prompt 的 send 绝不回退 cmd shim**；解析不到安全 native runner → 明确失败"安装布局不受支持"。
- **版本目录解析（4 坑，别只"照搬 agent.ps1"）**：
  1. 先查 shim 同目录 direct-sibling `node.exe/index.js`（agent.ps1 第 38 行分支），再进 `versions\`；
  2. 版本排序要含 `HH-MM-SS`（vendor Parse-VersionString 只按年月日，同日多 build "latest" 不定）→ 比完整 date+time；
  3. `CURSOR_AGENT_BIN` 指向 `.ps1` 时 resolveWindowsExecutable(:411) 默认不搜 `.ps1` → 需 **Cursor 专用 locator**（先精确文件、再 `.cmd/.ps1`、再 PATH）；明确 `CURSOR_AGENT_BIN` 接受形状（bare `agent`/`.cmd`/`.ps1`/安装根/版本目录/`node.exe`）；
  4. Cursor 自动更新会删旧版本目录 → **不永久缓存路径**，每轮验存在，ENOENT 重解析一次。
- **长度上限**：Windows 限的是完整 command line 的 **UTF-16 code units**（非 UTF-8 bytes），含 node/index.js/cwd/model/flags/quoting 膨胀 → v1 取保守静态上限（如 **24K UTF-16**），更好是估完整编码后 cmdline；**拒绝含 NUL 的 prompt**。
- **prompt 隐私**（argv 在 OS process list 可见不可免，但桥不再持久化泄露）：启动日志 `<prompt:redacted>`；**pid record 的 `processes[].command` 不含 prompt**；parser 不把 `user` echo 再落一次日志。

### 5.6 stream-json parser
按 §2.1 表 + 终止状态机实现 `#handleLine`。`thinking` 不落日志。assistant delta 规则由 spike 定死并多 chunk 测。

### 5.7 contextUsage = null + 永不重开
- `contextUsage()` 恒 `null`。**桥内无非-null 假设**（buildSessionResult:822/summary/wait:3318 均纯透传，无无保护 `.tokens`）→ 安全。
- **不硬编码**"依赖 Cursor 自压缩"（是编排/运维假设）；**不伪造** `{tokens:0}`/`autoCompactionEnabled:true`。
- **consumer/skill 侧真风险**（写进 skill）：`null≠0`；圆桌调度**不得**把 cursor 排成"上下文占用最低"持续派重活；"不按 token 重开"≠"永不重开"（新任务/遗忘约束/质量下降仍按通用规则换 session）；任何 `tokens>=400k` 阈值/排序逻辑须视 `null`=unknown、跳过数值比较。

### 5.8 abort / close
见 §7（Windows 整树 kill + 不变量）。

### 5.9 create-chat 生命周期 / doctor / bin / pid record
- **create-chat 也入生命周期契约**（v1 漏）：涉及认证/网络可能挂 → 硬超时；stdout/stderr 大小上限；整树终止；**临时 pid record**；matcher 识别 create-chat 分支（§5.1）。
- doctor 增列 `cursor`；文案（:335）从"OMP, Codex, and Node"更新含 cursor；cleanup CLI 文案（:345）同步。
- **doctor 陷阱（Codex 二轮新 bug）**：不能盲跑 `<bin> --version`——若 `CURSOR_AGENT_BIN=node.exe`（§5.5 接受形状之一），`node.exe --version` 会返回 **Node 版本冒充 Cursor 版本**。doctor 必须**经统一 native resolver 解析出 cursor 的 index.js 再验**（如 `node index.js --version`），或明确拒绝把裸 `node.exe` 当 cursor bin。
- **doctor 深度**：`--version` 成功 ≠ 安全 native launcher 可解析 → doctor 增 native-layout 检查，或 open_session 明确报 `safe native launcher unavailable`（否则 doctor=ok 但 open/send 才失败）。
- pid record turn 级（有活跃子进程才有意义）；`command` 字段**不含 prompt**（§5.5）。
- （`writePidRecord` 覆盖写 vs temp+rename：见 §附录B，**不**并入本次，保持"唯一共享改动=deriveHealth"。）

### 5.10 openSession 门控（:3119 附近）
- `agent` enum 由 `Object.keys(AGENTS)` 自动含 cursor。
- **非 Windows**：open 时 fail-fast。
- `schema`：cursor **拒**（spawn 前）。
- `append_system_prompt_file`：cursor **接受**（v4.1）——无原生 system flag，落地为**首轮用户前缀软注入**（`#composePrompt` 组 [会话指令(首轮)]→[read 策略]→[消息]；`appendSystemPending` 仅在 turn begin 后清，失败会重注；summary `injectionMode:"first-turn-user-prefix"`）。遵从看模型，非真 system；与消息共享 ~24K argv 预算（超限由 cmdline 闸门明确拒）。
- `effort`：**忽略**（不报错；有效值/ summary 回显 `null`，不伪装已生效）。
- `model`：sanitizeAgentArg 允许 `._:/@+-`，简单模型名（`gpt-5.3-codex-high`/`cursor-grok-4.5-high`）合法；参数化 `model[...]` 被拒，v1 不支持（注明）。

---

## 6. 开放决定（已定）

### 6.1 prompt 传参 → **选 A**（直起 node + `-- <PROMPT>` + 保守/动态 cmdline 上限 + 超限明确报错 + **不回退 cmd shim** + 不静默改文件式）。文件式 B 留作以后**显式 opt-in**，不做超限静默 fallback。

### 6.2 read 档 → **v1 软档（探针已定）**。实测：Cursor CLI **有**独立原生 Edit 工具（`editToolCall`/"Write" ≠ shell）。但 per-session 禁它无干净途径——`agent --help` 无 permission flag，deny 只在**全局** `~/.cursor/cli-config.json` 的 `permissions.deny`，**不可为桥会话改用户全局配置**；workspace 级 deny + 标识符未验证。且即便禁了原生 Edit，shell 仍能写 = 软 read。→ **v1：read/write 都 `--force`，read 靠 §5.4 的 (b) 每轮 prompt 前置 bridge-owned "不要修改文件"策略**（user-layer policy，诚实标注 soft、非 OS 级只读）。edit-deny（若日后验证 workspace 级 deny 可行）列未来精化。

---

## 7. abort / close 的 Windows 正确实现 + 云端一致性门槛

### 整树 kill —— 复用现有 helper（不新造）
- `terminateProcessTree`(:1080)：Windows `taskkill /pid <pid> /T`（SIGKILL 追加 `/F`）。
- `scheduleForceKill`(:1104)：3s 后强杀。
- 参照 claude close 示例(:3032)：
```js
const child = this.proc; const pid = child?.pid;
if (child && child.exitCode == null && child.signalCode == null) {
  terminateProcessTree(pid);
  scheduleForceKill(pid, 3000,
    () => this.proc === child && child.exitCode == null && child.signalCode == null);
}
```
**不变量**：
- abort **不能先** `this.proc=null`（force-kill verify 依赖它）；`proc=null` + 删 pid record 由**该 child 的 close handler** 做。
- close handler 必须先判 `this.proc === child`（防旧进程迟到事件清掉新轮状态）。
- 当前 turn promise **必须结算**（否则 `wait()` 永久挂）。
- abort 清 `lastTurnError`、stamp `turnEndedAt`。
- `close({removePidRecord:false})` **不能**借用一个无条件删 record 的 abort 实现。

### §7 云端一致性 = 发布门槛 → **已实测：安全**
2026-07-15 探针（长轮 shell 跑起来后整树 kill → 等过 sleep 窗口 → 同 chatId resume）：
- **本地文件未写、0 残留进程**（树 kill 有效）；
- **resume 同 chat → 模型答"上一轮被中断、未完成"，chat 无幽灵完成结果**。
- → **abort = 整树 kill 本地进程是安全的、chat 可复用**；`isReusable()` 用 `!closed && chatId` 即可，**v1 不需 poisoned 标志**。
- 仍保留一条防御：若将来遇到某轮 resume 出现幽灵结果，再引入 poisoned 标志 + 换 chat 兜底（附录 B）。回归测里保留该 §7 场景以防 Cursor 行为变更。

---

## 8. 验收

- **hermetic fake-Cursor 套件**（真 e2e 不足以稳定覆盖竞态；照现有 fake-claude 思路）：spawn 失败；多 chunk delta；result 后延迟 exit；exit 无 result；result error；abort；timeout abort；close 迟到；并发 send；stale close 不得影响新 child；health/contextUsage；cleanup matcher（含 ` --resume ` 与 create-chat 两分支）。
- **真 e2e（Windows）**：open(read)→"用 shell 算 data.txt 的 SHA256"→验 stream-json 有 shellToolCall + 拿到 hash；open(write)→"建 inside.txt"→验落盘；含 `& % "` 与多行的 prompt 一条（验 §5.5 不损坏）；abort（长跑中断）；close（无残留，`agent-bridge cleanup` 复核）。
- **门控/summary 测**：schema/append_system 在 spawn/读文件前被拒；effort 忽略可观察且诚实；name/returnMode/maxChars/ref；health/contextUsage(=null 四处：status/result/wait.results/pendingSnapshots)/lastTurn；pid 活跃轮有值、轮间 null。
- **回归测（deriveHealth）**：三旧后端 `starting/running/idle/failed/closed × proc null/live/exited/signaled` 行为不变；cursor `idle+chatId→healthy` / `failed+lastTurnError+chatId→degraded` / `无 chatId→dead`。
- **§7 云端一致性门槛** 单跑。
- **双评**：codex gpt-5.6-sol（本轮已一次）+ 另一独立引擎复核实现 diff。
- **dogfood**：用 `cursor` 真委托一个小任务跑通。

---

## 9. 触及文件 / 区域

- `scripts/agent-bridge.mjs`：AGENTS(:96)、`deriveHealth`(:771)、新 `CursorAgentSession`(接 ClaudeCodeSession 后 ~:2960)、late-bind(:3049)、openSession 门控(:3119)、doctor 文案(:335)、cleanup CLI 文案(:345)、非 Windows fail-fast。
- `skills/agent-bridge/SKILL.md`：Agent 与模型段加 cursor（形状 B、read/write 都软、read 非真只读、contextUsage 恒 null 且不按 token 重开但非永不重开、依赖 Cursor 自压缩、无 effort/append_system/schema、v1 Windows-only）。
- `README.md` / `INSTALLATION*` / `DEVELOPMENT*`：三后端→四后端。
- roundtable / dev / loop 三 skill：backend 列表、read 边界描述、contextUsage null 的排序/调度规则（§5.7 consumer 风险）。
- 本设计文档（真理源）。

---

## 附录 A：为什么不照抄 claude 后端
claude 能长驻＝`--input-format stream-json` + stdin 多轮 + 每轮一 result。Cursor 只有 `--output-format stream-json`、无多轮 stdin、`-p` 一次性 → 必须形状 B（每轮短进程 + `--resume`），并解耦"session 存活 ≠ 某 OS 进程存活"（§5.3）。

## 附录 B：不并入本次的项
- `writePidRecord` 覆盖写 → temp+rename（原子写）：真实风险但独立提交、独立测 Windows rename，避免破坏"唯一共享改动=deriveHealth"。
- 文件式 prompt（§6.1 方案 B）作为以后显式 opt-in。
- POSIX 平台支持。
