# Agent Bridge — 架构演进记录 (Architecture Evolution Log)

> 这份文档记录 Agent Bridge 关键架构决策的**演进脉络**:每个版本改了什么、**为什么**、移除了什么。
> 倒序排列(最新在上)。每次大的架构改动在顶部追加一节。给后续迭代的 agent 看,以理解"为什么现在长这样"。
>
> 当前架构权威说明见 [README.md](../README.md)(用户向)与 [DEVELOPMENT.md](DEVELOPMENT.md)(开发向)。

---

## v0.9.1 — 诊断日志单行封顶 + 正文不落盘(2026-07-18,根因修复)

**变更:** (1) `appendLog()` 内加**每次写入的字节上限** `AGENT_BRIDGE_LOG_LINE_MAX_BYTES`(默认 4096),超限写头部 + `…[+<n>B truncated]` 标记;(2) `stripThinking()` 扩为 `redactForLog()`——除原有的思维链字段外,还把**正文字段**(`aggregatedOutput` / `text` / `content` / `delta` / `displayContent`)换成尺寸标记,其余字符串按 `AGENT_BRIDGE_LOG_FIELD_MAX_CHARS`(默认 512)夹断。

**为什么:** 前两次(`message_update` 的 O(n²) 重序列化、v0.6.1 的 `get_state`/`get_last_assistant_text`)都是"**发现哪类事件刷量就加一条类型排除**"。这是打地鼠:单行本身**无上限**,每接一个新后端就重新开一个洞。codex 的洞一直敞着——`item/completed` 携带命令全量输出,实测单个会话日志 8.7MB、**最长单行 1,583,143 字节**。类型排除清单治标;`appendLog` 是所有日志写入的唯一漏斗,把上限放在这里才是普适下界,新后端绕不过。同时 codex/omp 由此对齐 claude/cursor/kimi 既有的"正文不逐字落盘"隐私策略(命令本身、exit code、item 类型等骨架保留,诊断价值不丢)。

**边界:** 只作用于诊断 `.log` / exit-journal。`answerFile` / `textRef` / MCP 返回的 `text` 仍是**完整未截断全文**——产品契约不变。回归见 `docs/repro-mcp-hang/repro-log-bounds.mjs`(19/19)。

---

## v0.7.0 — daemon 塌缩进 MCP 进程,移除 UI(2026-06-07)

**一句话:** 把"共享后台 daemon + Web UI"两层去掉,会话直接活在每个客户端自己的 MCP server 进程里。

### 变更
- **collapse daemon → MCP 进程**:不再有独立常驻 daemon、Unix socket、`requestDaemon` 转发。`agent-bridge mcp` 进程**自己持有** `sessions` Map,`callTool` 直接进程内调用 `openSession`/`sendMessage`/… 后端(omp/codex)作为 MCP 进程的**子进程**被 spawn。
- **移除整个 UI / HTTP / SSE 栈**:删掉 `startUiServer`/HTTP 路由/SSE 广播/`renderUiHtml` 等约 1000 行。不再监听任何端口;只走 stdio MCP。`session.events` 缓冲保留(供 `status`/`result` 的 `recentEvents`),只是不再向 SSE 广播。
- **per-process 作用域**:每个 MCP server 一个 `logs/<runId>/` 日志目录,prune 只管自己这一份 → 并发的多个 server 互不删日志。优雅退出删除本 run 目录;崩溃(code≠0)保留以便排查,但每个 run 目录带一个 `owner`(pid)文件,**下次任意 server 启动或 `cleanup` 会回收 owner 已死的遗留 run 目录**,所以崩溃残留不会累积。周期 prune 定时器搬进 `serveMcp`。
- **移除 owner / mine**:会话不再跨客户端共享,所以"哪个宿主开的"这个维度没意义了。删 `owner` 字段、`status` 的 `mine` 过滤、`mcpClientId()`。
- **CLI 瘦身**:只保留 `mcp` / `doctor` / `cleanup`。删掉 `daemon`/`start`/`stop`/`ui`/`sessions`/`open`/`send`/`status`/`result`/`wait`/`abort`/`close`。`cleanup` 只做"回收被 kill 的 server 残留的孤儿子进程"。
- **生命周期收尾**:`cleanupAndExit` 去掉 daemon socket/pid-file 清理;OMP `close()` 补 `scheduleForceKill` 兜底(与 codex 对齐);pid-record 的 owner 判活正则从 `mcp|daemon` 收为 `mcp`。

### 为什么
真实诉求是:**一个主 agent(一个客户端)通过 MCP 拉起 N 个外部 agent,只要能管理"自己拉起的这批"就够了。** 跨客户端共享、Web UI 都不是需求。

旧的"共享 daemon + UI"模型带来的恰恰是不需要的复杂度和真实的运维痛点:
- daemon 永不退出,一个客户端退出后会留下**孤儿后端会话**,要等下次 daemon 启动或手动 `cleanup` 才回收。
- 多个客户端的会话混在一个 daemon 里,`status` 默认能看到别人的,才不得不引入 `owner`/`mine` 来区分——这是为"共享"这个非需求付出的成本。
- UI/HTTP 是 daemon 需要常驻的理由之一;既然不需要共享视图,UI 也一并去掉。

塌缩成"一个客户端 = 一个 MCP 进程 = 自管自己的后端会话"后:生命周期天然绑定主 agent(客户端退出→进程退出→子进程全清),作用域天然隔离(进程内 `sessions` 就只有自己的),`owner`/`mine`/UI/socket/daemon 全部消失。

### 迁移提示
升级后,旧的 0.6.x daemon **不会自动退出**(新版已无 daemon 感知代码)。残留的旧 daemon 可手动清掉一次:
```sh
pkill -f 'agent-bridge.mjs daemon'
```
0.7.0 的会话日志都写在 `logs/<runId>/` 子目录里;0.6.x 时期遗留在 `~/.agent-bridge/logs/` 根部的**扁平日志** `*.log`(及旧 `daemon.log`)新版不会再写、也不归 per-run prune 管,属一次性迁移残留,升级时清掉即可:
```sh
find "$HOME/.agent-bridge/logs" -maxdepth 1 -type f -name '*.log' -delete
```
(0.7.0 自身的崩溃残留 `logs/<runId>/` 目录由启动/`cleanup` 自动回收,无需手动处理。)

---

## v0.6.1 — OMP 日志膨胀修复(2026-06-07, issue #1)

**变更:** 停止把 OMP 的 `get_state` / `get_last_assistant_text` **响应**落盘(`#handleLine` 里跳过这两类 response);加单文件上限 `AGENT_BRIDGE_LOG_FILE_MAX_MB`(默认 200)与周期 prune `AGENT_BRIDGE_LOG_PRUNE_INTERVAL_MIN`(默认 30)。

**为什么:** `waitIdle` 每 750ms 轮询一次 `get_state`,其响应里 96–99% 是基本不变的 `dumpTools`(~89KB)+ `systemPrompt`(~20KB),逐条落盘把单个会话日志撑到近 1GB。治本是这类大而静态的响应不落盘。经 codex+deepseek 交叉评审,额外修了两个缺陷:孤儿活跃会话的判活(failed≠dead,改用 `procExited`)、start-time prune 与并发第二 daemon 的竞态。

---

## v0.6.0 — 消费侧反馈 schema 大改(P1–P6)

**变更:** 统一出参 schema——入参 snake_case、出参一律 camelCase;`session` 两后端**形状一致**(公共核心字段 + `lastTurn` + `agentSpecific` 收纳后端差异);`result`/`wait` 文本永远报 `charCount`/`byteCount`、完整全文写入 `textRef`、`max_chars` 截断不静默丢内容;`recentEvents` 过滤逐 token/心跳噪声。经交叉评审加固。

**为什么:** 消费方(主 agent)反馈出参形状随后端漂移、原始事件把上下文撑成"一团 blob"、长产出被静默截断。目标是让委托结果**可预测、可判断、不丢必读内容**。

---

## v0.5.x — 共享 daemon + 多后端期(后被 v0.7.0 取代)

这一系列围绕"共享 daemon + UI + 多后端"展开,其中很多机制在 v0.7.0 被移除,但解决的问题值得记录:

- **0.5.0:** 加 `agent_bridge_wait`(阻塞 join,`all`/`any`),用于并行 fan-out 收口。
- **0.5.1 / 0.5.7:** `send_message` 默认阻塞 ↔ 非阻塞来回调整,最终定为**非阻塞 + 短超时 wait 轮询**(避免主 agent 死等 30 分钟硬上限)。
- **0.5.2 / 0.5.3 / 0.5.4:** 一系列日志/产出瘦身——slim result payload、不落盘流式 delta 快照、绑定日志保留 + 从日志剥离 thinking。
- **0.5.5:** daemon 中途关闭连接时及时 reject,不再让请求挂到超时。
- **0.5.6:** 自动给会话盖 `owner`(开它的客户端)+ `status` 的 `mine` 过滤。**→ v0.7.0 移除**:不再共享,作用域天然隔离,owner/mine 失去意义。

### 更早:后端收敛(v0.4.0)
**移除 OpenCode 后端**(2026-06-06,因其重且不稳),桥只保留 `omp` + `codex` 两个后端。早期还修过一批 turn-boundary 污染 / 并发 send / start-abort 竞态。
