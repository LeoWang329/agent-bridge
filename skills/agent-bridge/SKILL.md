---
name: agent-bridge
description: 当用户希望把任务委托给本地 OMP 或 Codex，或需要第二个 coding agent 做独立复核时，使用 Agent Bridge 建立持久会话。
---

# Agent Bridge

当用户明确要求调用 OMP、Codex、本地 coding agent、第二代理，或一个复杂调试/审查/实现任务适合交给另一个 agent 独立看一遍时，使用 Agent Bridge。

Agent Bridge 是 session-first 的桥接器。不要把它当成一次性命令运行器。

## 调用方式

- 执行委托任务时，优先使用 `agent_bridge_*` MCP tools。
- CLI facade 只用于人工调试、烟测、查看/关闭后台 session、清理残留进程，或复现 MCP 外的问题。
- 当用户需要实时观察 OMP/Codex 输出时，可以用 `node scripts/agent-bridge.mjs ui` 启动本地监控页面；它复用 MCP/CLI 的同一个 daemon session manager。
- 需要 CLI 时，用 `node scripts/agent-bridge.mjs start` 启动 daemon，再用 `open`、`send`、`status`、`result`、`close` 与同一个后台 daemon 交互。
- 不要为了普通委托任务绕过 MCP 去直接调用 CLI；CLI、MCP 和 UI 共享同一套 session 语义，但 MCP 是首选入口。

## 基本流程

1. 先用 `agent_bridge_open_session` 打开持久会话。
2. 用返回的 `session_id` 调用 `agent_bridge_send_message`（**默认非阻塞**：立刻返回 ack，任务在后台 daemon 里跑）。
3. 用 `agent_bridge_wait` join 结果——**推荐设短 `timeout_ms`(如 5~10 分钟)**：没结束就返回当前状态,你可以先看进展、干别的、再 `wait` 一次,而不是死等到任务结束（详见下一节）。
4. 任何时候都能用 `agent_bridge_status` 看运行状态、`agent_bridge_result` 读最近一次 assistant 结果。
5. 只有需要中断当前 turn 时，才调用 `agent_bridge_abort`。
6. 用户不再需要该委托 agent 时，必须调用 `agent_bridge_close_session` 关闭会话。

## 推荐用法：非阻塞 + 短超时 wait（看进展，不死等）

委托给本地 agent 的一轮可能要几分钟甚至更久。**不要用阻塞调用死等**——会卡住主 agent、看不到中途进展、也不好被打断。推荐这套：

1. `agent_bridge_send_message`（默认非阻塞）→ 立刻拿到 ack，任务在后台 daemon 里跑。
2. `agent_bridge_wait` 传**短 `timeout_ms`**(如 `300000` = 5 分钟 / `600000` = 10 分钟)阻塞等：
   - 任务**在超时前结束** → 直接返回结果（含 `text`）。
   - **到点还没完** → 返回 `{ timed_out:true, settled, pending }`,**不报错**。这时你可以:看一眼 `agent_bridge_status`/`agent_bridge_result` 的当前进展、回报用户、去干别的,然后**再 `wait` 一次**继续等。
3. 如此「`wait`(短超时) → 查看/处理 → 再 `wait`」循环,直到完成。**既不死等,又能随时掌握进度。**

> 为什么不用 `wait:true` 死等:`send_message` 的 `wait:true`（或 `agent_bridge_wait` 不设超时）最长会阻塞到 30 分钟硬上限,期间主 agent 完全卡住。短超时 `wait` 把"等"切成可控的小段。
>
> 只有当一轮**确定很快**(几秒级、简单改动)时,才值得用 `send_message` 传 `wait:true` 图省事直接拿结果。

## 并行委托：同时跑多个 agent

要让多个 agent **并行**干活：

> `agent_bridge_send_message` **默认非阻塞**，直接发即可（无需显式传 `wait:false`，那只是把默认值写出来）。

1. 对每个会话各发**一次** `agent_bridge_send_message`（默认非阻塞），都立刻拿到 ack，任务在后台并行跑。
2. 再用**一次** `agent_bridge_wait`（带短 `timeout_ms`）收口，省去循环轮询 `agent_bridge_status`：
   - `mode:"all"`：等列表里**所有**会话都完成，一次返回全部结果（含 `text`）。
   - `mode:"any"`：**第一个**完成就返回（并给出 `pending`）。循环「`wait(any)` → 处理 → 用 `pending` 里剩下的 id 再 `wait(any)`」，即可按完成顺序逐个处理。**每次只传还在跑的 id**，别带已完成的（否则会立刻把它再返回）。
   - 同样建议设短 `timeout_ms`：到点没完会返回 `{ timed_out, settled, pending }`，可先处理已完成的、再继续等。
3. 返回的每条含 `session_id` / `status` / `text`；失败或被关闭的会话也按“已完成”返回（`status` 为 `failed`/`closed`），便于一并处理。

> 并发纪律：不要让两个 `write` 会话**同时改重叠文件**；要么串行，要么按不重叠的文件切分。

## 会话归属与多宿主可见性

daemon 是**共享单进程**：多个宿主（多个 Claude Code 窗口、Codex、CLI）开的会话都在同一个 daemon 里。

- `agent_bridge_status` **不传 `session_id`** 时**列出全部**会话——**可能包含其它宿主开的**。
- 每个会话带一个 **`owner`** 字段，由 MCP 进程**自动盖章**（形如 `claude-code:<pid>`），**你不需要传任何东西**；它标识“哪个宿主/客户端开的”。
- 想只看**自己开的**：`agent_bridge_status` 传 **`mine:true`**，只返回本客户端 `owner` 的会话。
- **纪律**:`owner` 用于排查/区分,但精确操作仍以你 `open` 拿到的 `session_id` 为准。**不要 `abort`/`close` 不是自己开的会话**（可能误伤其它宿主正在跑的任务）。宿主重启后 `owner` 里的 pid 会变,旧会话不再算“自己的”。

## 工具速查与典型场景

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| `agent_bridge_open_session` | 开一个持久会话(选 agent/model/effort/write/cwd) | 派活前。换模型/换角色就**新开**一个 |
| `agent_bridge_send_message` | 发一条消息进会话(**默认非阻塞**,返回 ack) | 派活、追问。同一任务的后续追问**复用同一 `session_id`** |
| `agent_bridge_wait` | 阻塞 join 一个/多个会话,带 `timeout_ms`、`mode:all/any` | 收结果的**主力**。配短超时轮询进度;并行收口 |
| `agent_bridge_status` | 看会话运行状态 + 最近事件;无 `session_id` 时**列会话** | 查进度;**`mine:true` 看"当前主 agent(本客户端)拉起了哪些 agent"** |
| `agent_bridge_result` | 读最近一次 assistant 文本 + 最近事件 | 想看目前为止产出了什么(含中途) |
| `agent_bridge_abort` | 中断当前 turn(会话仍可复用) | 要**真正停掉**正在跑的一轮(打断主 agent ≠ 停任务) |
| `agent_bridge_close_session` | 关会话、回收后端进程 | 用完**必须**关。只关自己开的 |
| `agent_bridge_doctor` | 检查 omp/codex/node 是否可用 | 排查"后端起不来" |

**场景示例:**

- **查看当前主 agent 拉起了哪些 agent**:`agent_bridge_status` 传 `mine:true` → 只列本客户端 `owner` 的会话(id、agent、model、status、cwd)。不传 `mine` 则是全局视图(可能含其它宿主的)。
- **委托一个较长任务又想随时知道进展**:`send_message`(非阻塞) → `wait`(`timeout_ms:300000`) → 没完就 `status`/`result` 看一眼、回报、再 `wait`。
- **同时派 3 个 agent 并行干**:逐个 `send_message`(非阻塞) → 一次 `wait`(`mode:"all"` 或 `any` 循环)收口。注意 write 会话别改重叠文件。
- **收尾自查**:`agent_bridge_status`(`mine:true`)确认自己开的都已 `close`;需要全局确认无残留时,用 CLI `node scripts/agent-bridge.mjs sessions --json`。

## Agent 选择

- OMP 使用 `agent: "omp"`。这会启动 `omp --mode rpc`，并保持 JSONL RPC 进程存活。
- Codex 使用 `agent: "codex"`。这会启动 `codex app-server`，走换行分隔的 JSON-RPC（initialize → thread/start → turn/start），逐 token 流式。只读用 `sandbox: read-only`，写用 `sandbox: workspace-write`，均为非交互（`approvalPolicy: never`）。

## 指定模型与推理强度

- 模型是**会话级**参数：在 `agent_bridge_open_session` 时用 `model` 指定，整个会话内固定；`agent_bridge_send_message` 不支持逐条切换模型。需要换模型就新开一个 session。
- `model` 字符串会原样传给后端的 `--model`，取值格式由后端自己决定（OMP 的模型名 / Codex 的模型名）；OMP 尤其可以通过 `omp --model <name>` 触达多种模型（如 `deepseek-v4-pro`、`claude`、`gpt`）。
- 可选的 `effort`（推理强度）：OMP 映射为 `--thinking`，接受 `minimal|low|medium|high|xhigh`；Codex 作为该轮的 effort 传入，接受 `none|minimal|low|medium|high|xhigh`。
- 不传 `model` / `effort` 时，使用后端各自的默认值。

开会话时指定模型（可选，通用模板）：

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false,
  "model": "<模型名>",
  "effort": "high"
}
```

### 常用 OMP 模型速查

> OMP 的 `--model` 支持模糊匹配，用 `omp --list-models <关键字>` 可查可用模型及各自支持的 thinking 级别。注意**不同模型的最高 thinking 级别不同**——给模型传它不支持的级别会被忽略或报错。

**MiniMax 3.0** —— 选择子 `minimax-m3`（即 `minimax-code-cn/MiniMax-M3`），thinking 最高到 `high`（无 `xhigh`）。

MCP：

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false,
  "model": "minimax-m3",
  "effort": "high"
}
```

CLI：

```sh
node scripts/agent-bridge.mjs open --agent omp --model minimax-m3 --effort high --cwd "$PWD" --json
```

**DeepSeek v4 pro（max 思考）** —— 选择子 `deepseek-v4-pro`（即 `deepseek/deepseek-v4-pro`），thinking 最高到 `xhigh`，所以「max 思考」就是 `effort: "xhigh"`。

MCP：

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false,
  "model": "deepseek-v4-pro",
  "effort": "xhigh"
}
```

CLI：

```sh
node scripts/agent-bridge.mjs open --agent omp --model deepseek-v4-pro --effort xhigh --cwd "$PWD" --json
```

> 提醒：MiniMax-M3 的 abort 行为容易在中止一个长生成任务后「接着干旧任务」（模型行为，不是桥的问题）；需要稳定的中止/复核体验时优先用 `deepseek-v4-pro`。

## 安全规则

- `cwd` 必须传当前工作区的绝对路径。
- 代码审查、问题定位、方案设计、只读复核时，保持 `write: false`。
- 只有用户明确要求委托 agent 修改文件时，才设置 `write: true`。
- 如果委托 agent 修改了文件，调用方仍需检查 diff、运行必要测试，再向用户报告。
- 小任务不要委托。
- 完成后一定要关闭 session，避免留下后台 OMP/Codex 进程。

## Prompt 写法

- 给委托 agent 的 prompt 要具体、有边界。
- 明确说明完成标准。
- 如果是只读任务，明确写“不要修改文件”。
- 如果允许修改文件，要求对方报告改动文件、验证方式和剩余风险。
- 后续追问默认复用同一个 `session_id`，除非用户明确要求开一个全新的独立会话。

## 常见模式

只读审查：

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false
}
```

发送任务：

```json
{
  "session_id": "omp-...",
  "message": "请只读代码，审查这个模块的潜在 bug 和缺失测试。不要修改文件。"
}
```

需要 Codex 复核时：

```json
{
  "agent": "codex",
  "cwd": "/absolute/path/to/workspace",
  "write": false
}
```
