---
name: agent-bridge
description: Agent Bridge 的使用说明——通过 MCP 把任务委托给本地 OMP / Codex / Claude（或经 OMP 调用 deepseek 等模型）执行。仅当用户明确要求使用 agent-bridge、唤起其他 agent / LLM、要独立第二意见 / 复核 / 并行多开时使用（delegate / second opinion / review / parallel；OMP / Codex / Claude / deepseek）。普通编码、小修小补、自己能做的只读评审不要触发。
---

# Agent Bridge

**仅当用户明确要求**使用 agent-bridge、唤起其他 agent（OMP / Codex / Claude / deepseek）、或要独立第二意见 / 复核 / 并行多开时，才用 Agent Bridge。普通编码、小修小补、自己读几个文件就能做的评审，**不要**委托。

它是 session-first 的桥接器，不是一次性命令运行器：开一个持久会话、往里发消息、读结果、复用、关闭。执行委托任务**只用** `agent_bridge_*` MCP tools。

## TL;DR（最小流程）

```
open_session(agent, cwd, write)            →  拿 session_id
send_message(session_id, message)          →  默认非阻塞，立刻拿 ack
wait(session_ids, mode:"any", timeout_ms)  →  收结果；先完成先处理
close_session(session_id)                  →  用完必须关
```

- ⚠️ `wait` **必须显式传 `timeout_ms`**（建议 ≤ 8 分钟＝`480000`，简单任务再降）；**不传默认死等 30 分钟**。
- ⚠️ **别给 `send_message` / `open_session` 传 `wait:true`**——超时会 **abort 掉那轮 turn**（任务被中断，不是回头再取）；用非阻塞 send + `wait` 收口。
- 收口默认 `mode:"any"`（先完成先处理）；`wait` 的返回 shape 随 mode / 超时而不同，见「并行委托」。
- 要完整产出，在 `close_session` **之前**读 `textRef`（关会话会删它）。

## 核心机制

- 会话**活在 MCP server 进程内**：你所在的客户端启动了一个 `agent-bridge mcp` 进程，它直接 spawn 并持有你 open 的 OMP/Codex 后端。**没有共享 daemon、没有 UI、不跨客户端共享**；客户端退出，这些会话随之被清理。
- CLI 只剩三条：`mcp`（由插件拉起，你一般不手动跑）、`doctor`（查后端可用性）、`cleanup`（回收被 kill 的 server 残留的子进程）。**没有 CLI 会话命令，也没有 daemon/ui 命令**。

## 工作流：非阻塞 + 短超时 wait（看进展，不死等）

委托一轮可能要几分钟甚至更久。**不要用阻塞调用死等**——会卡住主 agent、看不到进展、也不好被打断。标准做法：

1. `agent_bridge_send_message`（默认非阻塞）→ 立刻拿到 ack，任务在后端会话里跑。
2. `agent_bridge_wait` 传**短 `timeout_ms`**（建议 ≤ 8 分钟＝`480000`，简单任务再降；**不传默认死等 30 分钟**）：
   - 超时前结束 → 直接返回结果（含 `text`）。
   - 到点没完 → 返回 `{ timedOut, settled, pending, pendingSnapshots }`，**不报错**。
3. 「`wait` → 看 `pendingSnapshots` → 再 `wait`」循环，直到完成。

`pendingSnapshots` 给每个还在跑的会话一个轻量进度快照：`{ sessionId, status, updatedAt, charCount, tail, lastEvent }`。

- `tail`：该会话**此刻在吐的部分文本的末尾**（默认末 240 字，用 `wait` 入参 `tail_chars` 调，0~4000）。
- `lastEvent`：最近一条生命周期事件（turn/工具）。
- 一次 `wait` 就能判断「还在动 vs 卡住、在做什么」，不必再单独调 `status`/`result`。

**为什么不死等：** `send_message`/`open_session` 的 `wait:true`（或 `wait` 不设超时）会阻塞到**默认上限 30 分钟**（不传 `timeout_ms` 时），期间主 agent 完全卡住；而且 **`wait:true` 超时会 abort 掉那一轮 turn**（这轮被中断，不是回头再取）。短超时 `agent_bridge_wait` 超时**不中断 turn**，任务继续在后台跑，再 `wait` 即可接着等。

**何时才直接 `wait:true`：** 只有一轮**确定很快**（几秒级、简单改动）时图省事；`open_session` 同时传 `initial_prompt` + `wait:true` 可一步完成「开+发+等」。

## 并行委托：同时跑多个 agent

**任务能切成相互独立的子任务时，优先开多个会话并行跑**——能显著压缩总时长。前提是按真正独立的边界切分，并守住下面的并发纪律（`write` 会话别撞文件、同会话别并发 `send`）。

1. 对每个会话各发一次 `send_message`（默认非阻塞），都立刻拿到 ack，后台并行跑。
2. 用 `agent_bridge_wait` 收口，省去循环轮询 `status`。**推荐 `mode:"any"`**（先完成先处理，比 `all` 更早拿到结果、更早暴露问题）：
   - `mode:"any"`：第一个完成就返回 `{ completed, pending, pendingSnapshots }`。处理 `completed`，然后**直接拿 `pending`（纯 id 数组）当下一轮的 `session_ids`**，循环到 `pending` 空。别把 `completed.sessionId` 加回去，也别把 `pendingSnapshots`（对象）当 id 传。
   - `mode:"all"`：要等齐了一起处理（如对比双评）时才用，返回 `{ results: [...] }`。
3. 失败或被关闭的会话也按「已完成」返回（`status` 为 `failed`/`closed`），便于一并处理。

**`wait` 三种返回 shape 不同**——取错字段会拿到 `undefined`：

| 场景 | 顶层字段 | 结果在哪 |
|---|---|---|
| `mode:"all"` 全部完成 | `{ results }` | `results[i].text` |
| `mode:"any"` 首个完成 | `{ completed, pending, pendingSnapshots }` | `completed.text`；待处理 id 在 `pending` |
| 超时（两种 mode 都会） | `{ timedOut, settled, pending, pendingSnapshots }` | 已完成在 `settled[i].text`；还在跑在 `pendingSnapshots` |

> 并发纪律：
> - **同一会话别并发 `send`**：Codex 会报 `already has a running turn`，OMP 会排队搅乱上下文。追问前先 `wait` 到上一轮完成；要并行就开**多个**会话。
> - **`write` 会话别撞文件**：任一 `write:true` 会话运行期间，别让另一个 `write` 会话**或主 agent 自己**改同一批文件。无法保证不重叠就串行：第一个完成 → `git diff` → 把改动作为上下文写进第二个的 prompt。

## 工具速查

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| `agent_bridge_open_session` | 开持久会话（选 agent/model/effort/write/cwd） | 派活前。换模型/换角色就**新开**一个 |
| `agent_bridge_send_message` | 发一条消息（**默认非阻塞**，返回 ack） | 派活、追问（复用同一 `session_id`）。慎用 `wait:true`：超时会 abort 本轮 |
| `agent_bridge_wait` | 阻塞 join 一个/多个会话；**务必传 `timeout_ms`**（默认 30 分钟） | 收结果的**主力**，推荐 `mode:"any"`；返回 shape 随 mode/超时不同（见上） |
| `agent_bridge_status` | 看运行状态 + 最近事件；无 `session_id` 时返回 `{sessions:[…]}`（你开的全部） | 查进度；看「当前主 agent 拉起了哪些 agent」 |
| `agent_bridge_result` | 读**最近一轮** assistant 文本 + 最近事件（非全历史） | 想看目前为止的产出（含中途） |
| `agent_bridge_abort` | 中断当前 turn（会话仍可复用） | 要**真正停掉**正在跑的一轮（打断主 agent ≠ 停任务） |
| `agent_bridge_close_session` | 关会话、回收后端进程。单关返回 `{closed, sessionId}`；省略 `id` 批量关返回 `{closedAll, count, sessionIds, failed}` | 常规**显式传 `id`**；省略 `id` 仅作崩溃兜底，且要查 `closedAll`/`failed` |
| `agent_bridge_doctor` | 检查 omp/codex/claude/node 是否可用 | 排查「后端起不来」 |

**典型场景：**

- **看主 agent 拉起了哪些 agent**：`agent_bridge_status` 不传 `session_id`。
- **委托长任务又想知道进展**：`send_message`（非阻塞）→ `wait`（短超时）→ 没完看一眼 `pendingSnapshots`、回报、再 `wait`。
- **同时派多个 agent**：逐个 `send_message`（非阻塞）→ `wait`（推荐 `mode:"any"` 循环，先完成先处理）收口。
- **兜底清场**：确认无其他活任务后，`close_session` 不传 `session_id` 可一次清空；之后查 `closedAll`/`failed`，有残留提示用户 `cleanup`。

## 会话归属（每个客户端自管自己的）

- `agent_bridge_status` 不传 `session_id` 时，列出的就是**你自己开的全部**会话，不会出现别的客户端的（它们在各自进程里）。
- 精确操作以你 `open` 拿到的 `session_id` 为准；没有 `owner`/`mine` 这类跨宿主参数。
- 客户端退出 → 你的 MCP server 进程退出 → 你开的所有后端会话被一并清理。

## 返回值要点

> 字段级定义由各 tool 的 schema 描述给出，这里只讲**怎么判断、怎么取**。**入参 snake_case**（`session_id`、`timeout_ms`、`max_chars`…），**出参一律 camelCase**（`sessionId`、`logFile`、`timedOut`…）。

- `text`：本轮 assistant 全文，**必读内容**。
- `charCount` / `byteCount`：成功结果里**总会返回**的长度——这是「罗盘针」，先看长度再决定要不要全量取。
- `textRef`：一个文件路径，里面是**完整未截断**的全文。⚠️ `close_session` 会删除它——**要完整内容就先读 `textRef`、再关会话**；读不到时重新 `result`（调大或去掉 `max_chars`）。
- `max_chars`：给 `text` 设上限；超限时 `text` 截断、`truncated:true`，但 `charCount` 仍报全长、`textRef` 仍是全文。**核心：必读内容绝不静默丢失。** 大产出（改代码/长文档）建议传个 `max_chars`（如 4000）只看头部，细节用 `git diff` / `textRef` 取。
- `recentEvents`（`status`/`result` 带）：已**过滤掉逐 token、心跳等噪声**的精简生命周期串；要全量原始事件看 `logFile`。

## Agent 与模型

- **OMP**：`agent: "omp"`，启动 `omp --mode rpc`（JSONL RPC 长驻）。可经 `--model` 触达多种模型。
- **Codex**：`agent: "codex"`，启动 `codex app-server`（JSON-RPC，逐 token 流式）。读写权限由 `write` 控制，均非交互。
- **Claude**：`agent: "claude"` — a fresh-context Claude Code worker; good for an independent second opinion / review or an isolated write workspace.（独立 Claude Code worker；适合独立复核或隔离写作业；read-only 不含 shell；默认模型为 claude 自身配置默认，思考强度默认 xhigh）
- **模型是会话级参数**：在 `open_session` 用 `model` 指定，整个会话固定；`send_message` 不能逐条切模型，换模型就新开 session。`model` 原样传后端 `--model`。
- ⚠️ **`model` 必须用 `provider/模型名` 全限定形式**（如 `deepseek/deepseek-v4-pro`、`minimax-code-cn/MiniMax-M3`），**不要传裸别名**（如 `deepseek-v4-pro`、`minimax-m3`）——裸名可能被路由到非预期的 provider，拿到的不是你要的模型。全限定 ID 以 `omp --list-models <关键字>` 的输出为准。
- **`effort`（可选，推理强度）**：OMP 映射为 `--thinking`（`minimal|low|medium|high|xhigh`）；Codex 作为该轮 effort（`none|minimal|low|medium|high|xhigh`，其中 `none`/`minimal`/`low` 用于简单改动的评审，实施任务不建议）。不传则用后端默认；Claude 映射到 --effort，默认 xhigh。

`open_session` 必传 `agent` + `cwd`；`write` / `model` / `effort` 按需。

**模型以活查为准**：`omp --list-models <关键字>` 查可用模型（输出即全限定 `provider/模型名`，直接拿来当 `model`）及各自支持的 thinking 上限。**不同模型最高 thinking 级别不同**，传它不支持的级别会被忽略或报错。下表 `model` 列即应传的全限定值，只是常用举例：

| `model`（全限定，直接传这个） | 说明 | `effort` 上限 |
|---|---|---|
| `minimax-code-cn/MiniMax-M3` | MiniMax 3.0 | `high`（无 `xhigh`） |
| `deepseek/deepseek-v4-pro` | DeepSeek v4 pro | `xhigh`（即「max 思考」） |

> 提醒：MiniMax-M3 中止长生成后容易「接着干旧任务」（观察于早期版本的模型行为，非桥的问题，若已更新以实际为准）；需要稳定中止/复核时优先 `deepseek-v4-pro`。

## 编排策略

> **桥不预设「谁干什么」。用户显式指定 agent / model / effort / 读写时优先遵循；没指定就按任务性质自己判断。**

**先探后派（doctor → list-models）：**

- 派活前、尤其依赖某个特定后端时，先 `agent_bridge_doctor` 确认哪些后端可用——「有没有那个后端」靠查不靠猜。注意 `doctor` 只是 `--version` 预检，不验证登录 / 能否真启动；真能跑以 `open_session` 为准。
- **`doctor` 之后、或第一次派 OMP 会话前，先用 `omp --list-models <关键字>` 探一下可用模型及各自 thinking 上限**（用你的 shell 执行，不是 MCP tool；`doctor` 也不列模型）。据此选 `model`/`effort`，避免传后端不认的模型或它不支持的强度。

**评审独立性：** 评审者必须 ≠ 实施者（引擎或模型不同才算真第二意见）。别用同模型同会话评自己刚写的代码。选评审后端时，换一个与实施者不同的引擎 / `model` + 新开独立会话，保住「独立第二意见」。

**effort 量体裁衣：** 重活（复杂实施/评审）用 `xhigh`；改小范围、跑定位用 `medium`。别把 `xhigh` 当全局默认。

**上下文卫生（长任务降智 → 关旧开新）：**

- 同一任务线的追问/迭代复用同一 `session_id`。出现下面任一情况就 `close_session` 旧的、`open_session` 新的，避免上下文越攒越胖拖垮效果：**①新任务且与前面无关；②委托方开始遗漏 prompt 里的关键约束**。
- reopen 时按「交接物」带上下文（文件路径、规格、上一步 diff 写进新 prompt），不靠旧会话记忆——新 session 不记得旧 session 聊过什么。
- 一条任务线结束就及时关，别攒到最后。

**委托后主 agent 仍自查：** 委托方改完文件，主 agent 必须自己 `git diff` + 跑必要测试再向用户报告，不盲信。

**关键改动并行双评（可选）：** 重要 diff 同时发两个不同引擎 / 模型的后端，并行 `wait(mode:"all")` 对比分歧——意见不一致处往往是真问题。

## 安全规则

- `cwd` 必须是当前工作区的绝对路径——桥不校验 workspace root，主 agent 自己负责别传 home / 父目录 / 临时目录。
- 代码审查、问题定位、方案设计、只读复核 → `write: false`。只有用户明确要求改文件才 `write: true`。
- 委托方与被委托 agent **共享 `cwd`**：审查/实现让对方自己 `git diff`、自己读文件，别把整坨 diff/代码塞进 `message`（省 token）。
- 委托 agent 改了文件，调用方仍需检查 diff、跑必要测试，再向用户报告。
- 小任务不要委托。
- 完成后一定要 `close_session`，避免留下后台后端进程。

## Prompt 写法

- 给委托 agent 的 prompt 要具体、有边界，明确完成标准。
- 只读任务明确写「不要修改文件」。
- 允许改文件时，要求对方报告改动文件、验证方式和剩余风险。
- 后续追问默认复用同一 `session_id`，除非用户明确要求开全新独立会话。
