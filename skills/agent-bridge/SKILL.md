---
name: agent-bridge
description: 当用户希望把任务委托给本地 OMP 或 OpenCode，或需要第二个 coding agent 做独立复核时，使用 Agent Bridge 建立持久会话。
---

# Agent Bridge

当用户明确要求调用 OMP、OpenCode、本地 coding agent、第二代理，或一个复杂调试/审查/实现任务适合交给另一个 agent 独立看一遍时，使用 Agent Bridge。

Agent Bridge 是 session-first 的桥接器。不要把它当成一次性命令运行器。

## Codex 调用方式

- 在 Codex 内执行委托任务时，优先使用 `agent_bridge_*` MCP tools。
- CLI facade 只用于人工调试、烟测、查看/关闭后台 session、清理残留进程，或复现 MCP 外的问题。
- 当用户需要实时观察 OMP/OpenCode 输出时，可以用 `node scripts/agent-bridge.mjs ui` 启动本地监控页面；它复用 MCP/CLI 的同一个 daemon session manager。
- 需要 CLI 时，用 `node scripts/agent-bridge.mjs start` 启动 daemon，再用 `open`、`send`、`status`、`result`、`close` 与同一个后台 daemon 交互。
- 不要为了普通委托任务绕过 MCP 去直接调用 CLI；CLI、MCP 和 UI 共享同一套 session 语义，但 MCP 是 Codex 的主入口。

## 基本流程

1. 先用 `agent_bridge_open_session` 打开持久会话。
2. 用返回的 `session_id` 调用 `agent_bridge_send_message`。
3. 用 `agent_bridge_status` 查看进度和运行状态。
4. 用 `agent_bridge_result` 读取最近一次 assistant 结果。
5. 只有需要中断当前 turn 时，才调用 `agent_bridge_abort`。
6. 用户不再需要该委托 agent 时，必须调用 `agent_bridge_close_session` 关闭会话。

## Agent 选择

- OMP 使用 `agent: "omp"`。这会启动 `omp --mode rpc`，并保持 JSONL RPC 进程存活。
- OpenCode 使用 `agent: "opencode"`。这会启动 `opencode serve`，并直接走它的 HTTP/SSE API：建会话、订阅 `/event` 实时增量、用 `prompt_async` 发送每一轮。只读会话会禁用写工具（bash/edit/write/apply_patch/task）；写会话自动批准权限请求。
- Codex 使用 `agent: "codex"`。这会启动 `codex app-server`，走换行分隔的 JSON-RPC（initialize → thread/start → turn/start），逐 token 流式。只读用 `sandbox: read-only`，写用 `sandbox: workspace-write`，均为非交互（`approvalPolicy: never`）。

## 指定模型与推理强度

- 模型是**会话级**参数：在 `agent_bridge_open_session` 时用 `model` 指定，整个会话内固定；`agent_bridge_send_message` 不支持逐条切换模型。需要换模型就新开一个 session。
- `model` 字符串会原样传给后端的 `--model`，取值格式由后端自己决定（OMP 的模型名 / OpenCode 的 provider/model 写法）。
- 可选的 `effort`（推理强度）：OMP 映射为 `--thinking`，接受 `minimal|low|medium|high|xhigh`；OpenCode 映射为 `--variant`。
- 不传 `model` / `effort` 时，使用后端各自的默认值。

开会话时指定模型（可选）：

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false,
  "model": "<模型名>",
  "effort": "high"
}
```

## 安全规则

- `cwd` 必须传当前工作区的绝对路径。
- 代码审查、问题定位、方案设计、只读复核时，保持 `write: false`。
- 只有用户明确要求委托 agent 修改文件时，才设置 `write: true`。
- 如果委托 agent 修改了文件，Codex 自己仍然要检查 diff、运行必要测试，再向用户报告。
- 小任务不要委托；Codex 能直接完成的就直接完成。
- 完成后一定要关闭 session，避免留下后台 OMP/OpenCode 进程。

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
  "message": "请只读代码，审查这个模块的潜在 bug 和缺失测试。不要修改文件。",
  "wait": true
}
```

需要 OpenCode 复核时：

```json
{
  "agent": "opencode",
  "cwd": "/absolute/path/to/workspace",
  "write": false
}
```
