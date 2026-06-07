# Agent Bridge 需求与 TODO

这份文档记录 Agent Bridge 的产品需求、已完成能力和后续 TODO。开发新功能前先更新这里，避免实现方向和使用方式漂移。

## 目标

Agent Bridge 要让 Codex 可以把工作委托给本地 OMP 或 Codex，并保持 session-first 的交互模式。

核心原则：

- 会话**只能**通过 MCP tools 管理；会话活在每个客户端自己的 `agent-bridge mcp` 进程内（一个客户端 = 一个 MCP 进程 = 自管自己的会话）。
- CLI 只剩三条命令：`mcp`（server 入口）、`doctor`、`cleanup`（运维辅助）。没有会话命令，也没有 daemon/UI 命令。
- OMP/Codex session 必须显式关闭，避免后台进程残留；客户端退出时 MCP 进程退出，会一并清理它持有的后端会话。
- 委托 agent 默认只读，只有用户明确要求时才开启写权限。

## 已完成（当前能力）

- MCP tools：打开 session、发送消息、查看状态、读取结果、`wait`（阻塞 join，`all`/`any`）、中断、关闭、doctor。
- per-process 会话模型：会话活在每个客户端自己的 `agent-bridge mcp` 进程内，由该进程直接 spawn 并持有 OMP/Codex 后端；不跨客户端共享，无共享 daemon、无 UI、无监听端口（仅 stdio MCP）。
- OMP backend：通过 `omp --mode rpc` 保持 JSONL RPC 会话。
- Codex backend：通过 `codex app-server` 保持持久 JSON-RPC 会话。
- per-process 日志：每个 MCP server 一个 `~/.agent-bridge/logs/<runId>/` 目录，优雅退出删除本 run 目录，prune 只管自己这一份。
- 进程清理：记录 OMP/Codex 子进程，只跳过仍由活着的 `agent-bridge mcp` 进程拥有的子进程，`cleanup` 回收 owner 已死的孤儿子进程并清理 stale records。
- 中文 skill：指导主 agent 何时委托、优先使用 MCP tools，并说明会话生命周期与每客户端自管模型。

### v0.7.0 已移除

下列能力曾在 v0.5.x「共享 daemon + UI」期实现，已在 **v0.7.0** 随「daemon 塌缩进 MCP 进程」一并移除，仅作历史记录保留。背景与原因见 [docs/ARCHITECTURE.md](ARCHITECTURE.md)。

- **共享 daemon / session manager**：曾让 MCP / CLI / UI 复用同一个常驻 daemon 的内存 session map。现在每个 MCP 进程自管自己的会话，不再有 daemon、Unix socket 或 `requestDaemon` 转发。
- **CLI facade（会话命令）**：曾通过 daemon + Unix socket 让 `open`/`send`/`status`/`result`/`close` 跨命令复用 session。CLI 现仅剩 `mcp`/`doctor`/`cleanup`。
- **Web UI 实时监控**：曾由 `node scripts/agent-bridge.mjs ui` 启动只监听 `127.0.0.1` 的 HTTP/SSE monitor（session 列表、实时输出、abort/close、stop daemon 等）。整套 UI / `ui` 命令已删除。
- **HTTP API**：曾提供 `GET/POST /sessions`、`/sessions/:id/...`、`POST /daemon/stop` 等路由。已无任何 HTTP 路由（不监听端口）。
- **SSE 实时事件流**：曾向浏览器推送 session 状态与 assistant 可见文本（OMP `text_delta` / Codex `item/agentMessage/delta`）。`session.events` 仍在进程内缓冲以支撑 `status`/`result` 的 `recentEvents`，但不再向任何地方广播。
- **owner / `status` 的 `mine` 过滤**：曾用于在共享 daemon 里区分"哪个客户端开的"。会话不再共享，作用域天然隔离，已移除。

## TODO

### CLI watch 命令

> 注：此 TODO 是 v0.5.x「共享 daemon + UI」期提出的，假设有一个独立 CLI 进程能观察 daemon 里的 session。v0.7.0 后会话只活在各自的 MCP 进程内、不跨进程共享，所以独立的 `watch` CLI 已不适用；要保留这个能力需要重新设计成 MCP 工具或进程内观察。暂存档。

需求：提供一个轻量终端实时观察命令，作为日志之外的调试入口。

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
- 不默认暴露远程访问能力（不监听任何端口，仅 stdio MCP）。
- 不把 CLI 作为会话调用入口（会话只走 MCP tools）。
- 不默认对外暴露完整 thinking 或原始 raw event payload（thinking 已从日志剥离，`recentEvents` 已过滤噪声）。
