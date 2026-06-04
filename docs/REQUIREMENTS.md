# Agent Bridge 需求与 TODO

这份文档记录 Agent Bridge 的产品需求、已完成能力和后续 TODO。开发新功能前先更新这里，避免实现方向和使用方式漂移。

## 目标

Agent Bridge 要让 Codex 可以把工作委托给本地 OMP 或 OpenCode，并保持 session-first 的交互模式。

核心原则：

- Codex 的主入口是 MCP tools。
- CLI facade 用于人工调试、烟测、清理、运维和复现问题。
- OMP/OpenCode session 必须显式关闭，避免后台进程残留。
- 委托 agent 默认只读，只有用户明确要求时才开启写权限。

## 已完成

- MCP tools：打开 session、发送消息、查看状态、读取结果、中断、关闭、doctor。
- 共享 daemon/session manager：MCP tools、CLI facade、Web UI monitor 复用同一个本地 daemon。
- OMP backend：通过 `omp --mode rpc` 保持 JSONL RPC 会话。
- OpenCode backend：通过 `opencode serve` 和 `opencode run --attach` 保持持久后端。
- OpenCode 结果兜底：从本地 SQLite 数据库只读提取最新 assistant 文本。
- CLI facade：通过本地 daemon 和 Unix socket 支持跨命令复用 session。
- UI 实时监控页面：`node scripts/agent-bridge.mjs ui` 启动只监听 `127.0.0.1` 的 HTTP/SSE monitor。
- HTTP API：支持查看、打开、发送、结果、中断、关闭 session，以及停止 daemon。
- SSE 实时事件流：向浏览器推送 session 状态变化、OMP text_delta、OpenCode JSON 输出中的 assistant 可见文本。
- 进程清理：记录 OMP/OpenCode 子进程，跳过仍由 MCP/daemon 拥有的进程，清理 stale records。
- 中文 skill：指导 Codex 优先使用 MCP tools，并把 CLI facade 限定为调试/运维入口。

### UI 实时监控页面验收记录

入口：

```sh
node scripts/agent-bridge.mjs ui
```

已实现能力：

- 自动启动或复用 `agent-bridge daemon`。
- 启动只监听本机的 HTTP 服务：`127.0.0.1:<port>`。
- 默认打开浏览器；`--no-open --json` 可用于自动化测试。
- 提供 HTTP API 用于查看 session、打开 session、发送消息、中断、关闭、停止 daemon。
- 提供 SSE 实时事件流，用于向浏览器推送 OMP/OpenCode 的状态和输出。

API：

```text
GET    /sessions
POST   /sessions
GET    /sessions/:id
POST   /sessions/:id/messages
GET    /sessions/:id/result
GET    /sessions/:id/events
POST   /sessions/:id/abort
DELETE /sessions/:id
POST   /daemon/stop
```

UI 页面包含：

- session 列表：显示 agent 类型、状态、cwd、PID、创建时间。
- 实时输出区：默认展示 assistant 可见文本和关键状态变化。
- raw events/debug 面板：可折叠展示原始 JSON events 和 log file 路径。
- 操作区：发送消息、abort 当前 turn、close session、stop daemon。
- 安全提示：写权限 session 必须有明显标识。

验收结果：

- 打开 UI 后能看到 daemon 内已有 OMP/OpenCode sessions。
- OMP `text_delta` 或等价事件能实时追加到页面。
- OpenCode `--format json` 输出能实时追加到页面。
- `status` 从 running 到 idle 的变化能实时显示。
- `close session` 后对应后端进程退出，页面状态同步更新。
- UI 只监听 `127.0.0.1`，默认不暴露到局域网。
- 不默认展示完整 thinking/raw internal payload；raw JSON 只放在 Debug 面板，并移除 thinking/reasoning-like 字段。

### HTTP/SSE facade 与现有 daemon 复用

已实现：HTTP/SSE facade 不另建 session manager，而是运行在当前 daemon 内部，复用同一份内存 session map。

验收结果：

- MCP 打开的 session 能在 UI 中看到。
- CLI 打开的 session 能在 UI 中看到。
- UI 打开的 session 能被 CLI `sessions/status/result/close` 看到和管理。

## TODO

### CLI watch 命令

需求：提供一个轻量终端实时观察命令，作为 UI 之外的调试入口。

建议入口：

```sh
node scripts/agent-bridge.mjs watch <session_id>
```

验收标准：

- 能持续输出 session 状态变化和 assistant 文本增量。
- 支持 Ctrl+C 退出 watch，但不关闭 session。
- 支持 `--raw` 输出原始事件。

## 非目标

- 不把 Agent Bridge 变成通用公网服务。
- 不默认暴露远程访问能力。
- 不把 CLI facade 作为 Codex 的主调用入口。
- 不在 UI 中默认展示敏感 thinking 或完整 raw event payload。
