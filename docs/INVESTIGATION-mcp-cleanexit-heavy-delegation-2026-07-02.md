# Investigation — MCP 会话在“重度委托 + 机器重载”下清净退出、工具无法恢复、且退出原因不可追溯

**日期:** 2026-07-02
**状态:** 现场复盘（field report）。**结论:bridge 未崩溃——它按设计做了 code 0 的优雅退出。** 本次没有代码 bug；暴露的是一个**取证盲点**（clean-exit 也删 run dir → 退出原因永久丢失）与一条**客户端侧 + 重载**的触发链。含一条可落地的修复建议（durable exit journal）。
**关联既有文档:** [INVESTIGATION-mcp-disconnect-2026-06-10.md](INVESTIGATION-mcp-disconnect-2026-06-10.md)（P1–P6 已修）、[PLAN-heavy-user-fixes-2026-07-02.md](PLAN-heavy-user-fixes-2026-07-02.md)、[变更说明-重度用户优化-2026-07-02.md](变更说明-重度用户优化-2026-07-02.md)。

---

## 1. 现场与症状

消费方（另一个 Claude Code 会话，跑一个 Next.js 项目的 P5 运维切片）用 agent-bridge 同时委托 **DeepSeek（omp, write）开发 + Codex（review/test）**。在 **DeepSeek 正跑 Task 2 的“直接模式冒烟”（`npm run build` + 起 standalone 服务，很重）** 时：

- 第一次 `agent_bridge_wait`（mode:all）在约 1 分钟异常地带着 `status:"running"` 提前返回；
- 紧接着第二次 `agent_bridge_wait` → **`MCP error -32000: Connection closed`**；
- 之后该会话里 **agent-bridge 的全部工具从可用集消失**（本 harness 里它们是 deferred / ToolSearch 加载的工具），`ToolSearch` 再也找不到，**同一会话内没有自动恢复**；
- 消费方遂**改用 `codex` CLI 直连**（`codex review --base`、`codex exec`）绕过，跑完了后续所有评审与 e2e。

用户的问题:“为什么会崩溃、无法重启,能查到原因吗?”

## 2. 关键证据:它没崩溃,是**清净退出**

`scripts/agent-bridge.mjs` 的退出语义（本次现读）:

- 崩溃类退出 `cleanupAndExit(1, …)`（`uncaughtException`/`unhandledRejection`,行 3621–3622；stdout error 行 3631）→ **保留** `logs/<runId>/` 留证（见 6-10 调查 P3 与行 1107 注释 “a hard exit … leaves it behind”）。
- 优雅退出 `cleanupAndExit(0, …)` → **删除** `logs/<runId>/`（行 1167）。

**取证:** 本次消费方会话的 `logs/mcp-mr3dqe6w-ywdiel/`（工具返回里记录过的 logFile 目录）**已不存在**。→ 该 MCP server 是 **code 0 的优雅退出**,不是 crash / OOM / 被 SIGKILL。

code 0 的触发点只有四条:①父进程（客户端）watchdog 判定消失（行 3499,P6）②stdin 关闭（行 3508/3535,P2）③SIGTERM/SIGINT（行 3619）④stdout EPIPE（行 3630）。结合当时**我方 `agent_bridge_wait` 正在飞（active request）**,最贴合的是 **P2 那条**:

```js
// serveMcp, 行 3528–3538 —— 这正是 6-10 调查的 P2 修复
rl.on("close", () => {                 // 客户端把 stdin 关了
  inputClosed = true;
  maybeExit();
  // stdin EOF means the client is gone … Don't let a wedged request
  // (e.g. a wait on a dying backend) pin a zombie server forever;
  if (activeRequests > 0) {
    setTimeout(() => cleanupAndExit(0, "stdin closed (grace expired with active requests)"), 5000);
  }
});
```

即:**客户端先关掉了到 bridge 的 stdio 管道 → bridge 侧 `rl.on("close")` 触发、我方 wait 仍在途 → 5 秒宽限 → `cleanupAndExit(0)` → 删除 run dir**。我方那次 wait 收到 `-32000 Connection closed`。**bridge 全程按 P2 设计正确行事**(它就是为了不留僵尸 server 才主动退出的)。

## 3. 为什么“超时”假设站不住 + 真正触发在客户端侧

6-10 调查已用证据否掉“CC 按 wait 时长杀连接”:实测 `agent_bridge_wait` 跑 2m14s / 2m26s / 4m52s / 5m13s **都完成**,“没有 ~60s 的 kill”。所以**不能**把本次归因为“我传了 7–8 分钟的 `timeout_ms` 越过某个 CC 请求超时”——至少 6-10 观测的 CC v2.1.170 不是这样。

**stdin 为什么被关,决定权在客户端(harness),不在 bridge。** 可能的客户端侧原因(本次无法从 bridge 侧证实,因证据已随 run dir 删除):
- harness 在重载下对该 MCP 传输做了 teardown/reset(本 harness 把 agent-bridge 当 deferred 工具,断连后**未**像 6-10 记录的 CC 那样 auto-respawn + auto-retry,而是直接把工具下架);
- 或 P6 parent-watchdog:重载中若客户端进程被判 gone 两拍 → `cleanupAndExit(0,"parent gone")`。但 `pidAlive` 用 `process.kill(pid,0)` 且**fail-safe**(只有确定性 `ESRCH` 才算 gone,EPERM/异常→当作活着),单纯 CPU 饥饿一般不会误触发,故此条概率低于 stdin-close。

**加重因素(已实测坐实):** 事发时机器被 DeepSeek 的 build+起服务榨得很重。事后同一台机上,**控制方自己 `npm run build` 一度从 25 秒飙到 5 分钟超时**;进程快照显示累计了 16+ 个孤儿 `next build/dev/start` + standalone 进程把机器拖垮(按命令行精准清理后 build 立即恢复 25 秒)。重载会让 bridge 的事件循环/响应回刷变慢,客户端侧更易先动手 teardown。

## 4. 真正暴露的问题:**clean-exit 也删 run dir → 退出原因永久丢失**（取证盲点）

6-10 的 P3 只保留 **crash（code≠0）** 的 run dir;**code 0 的优雅退出仍无条件删除整个 run dir**,而 bridge 唯一记录退出原因的地方——`bridge.log`（`beforeExit` 与 `cleanupAndExit` 都写它,行 3626–3627）——**就在这个 run dir 里**。

后果就是本次:一个**由客户端发起的清净 teardown**,退出后 run dir 连同 `bridge.log` 一起没了,**事后无法区分到底是 stdin-close(P2)还是 parent-watchdog(P6),也拿不到当时的 backend 状态**。用户问“为什么”,而 bridge 恰恰把“为什么”跟着 run dir 一起删了。这是 P3 只覆盖 crash、没覆盖 clean-exit 留下的缺口。

## 5. 修复建议

### R1（推荐,直接补 §4 盲点）— 持久化的退出 journal,独立于 run dir
在 **每一次** `cleanupAndExit`(code 0 **和** 1)时,向一个**不随 run dir 删除、也不被 sibling `reclaimStaleLogs` 回收**的 append-only 文件(例如 `~/.agent-bridge/exit-journal.jsonl`,带保留期轮转)追加一行:
```json
{"ts":"…","runId":"mcp-…","code":0,"reason":"stdin closed (grace expired with active requests)",
 "pid":1234,"ppid":5678,"uptimeSec":…,"activeRequests":1,
 "sessions":[{"id":"omp-…","status":"running","backendPid":…}]}
```
这样即便优雅退出把 run dir 删了,**“这个 server 为什么、在什么状态下退出”仍可追溯**——本次调查就不必靠“目录没了”反推。成本极低(单行 append),且直接服务重度用户的可诊断性。与 [PLAN-heavy-user-fixes] 的可观测性主线一致,建议并入。

### R2（可选）— 长 `wait` 期间给客户端心跳,降低重载下被 teardown 的概率
重载时若 bridge 长时间不向客户端回刷任何字节,客户端更可能判其“停滞”而 teardown。可在长 `wait` 未 settle 时按固定间隔向 stdout 发一个轻量 keepalive/进度通知(不改变 wait 语义),让客户端在重载下也能看到“还活着”。需先确认目标 harness 对 MCP 通知的容忍度,避免噪声。

### R3（客户端/消费方纪律,应写进 skill 指南)
- **`wait` 用短 `timeout_ms`(≤90–120s)+ 循环轮询**,而非一次阻塞 7–8 分钟;短请求让传输更快回到 idle,减少“长请求 × 重载”这个最危险组合的暴露面(6-10 已建议 ≤8 分钟,本次进一步收紧到 2 分钟级)。
- **别让控制方与被委托 agent 同时榨满机器**:本次 e2e 与 review 的 `next build`/`next dev` 并发互抢直接造成 next dev 120s 超时;委托重活期间控制方应避免自己也跑重构建。
- **孤儿进程会级联拖垮机器** → 定期 `node scripts/agent-bridge.mjs cleanup`;消费方侧也要清理自己 spawn 的 next/build 孤儿。

### R4（韧性,已被本次验证有效)— 桥死后的 fallback
底层 `codex` CLI(v0.142.3)提供 `codex review --base <branch>`(非交互评审)与 `codex exec -s <sandbox>`(非交互执行)。**MCP 桥不可用时,直接用 CLI 触达同一个 Codex 引擎**,是一条已跑通的兜底路径(本次靠它完成 5 轮独立评审 + e2e)。注意坑:`codex review` 的自主运行时探测在某些 Windows 环境会挂 → 复核类改用 `codex exec -s read-only` 静态审阅更稳。建议在 README/skill 里补一节“桥不可用时的 CLI 兜底”。

## 6. 一句话结论
**不是崩溃,是 bridge 按 P2 设计对“客户端在我 wait 在途时关掉了 stdio”做出的清净退出;真正的触发在客户端侧 + 机器重载,而非 wait 时长。唯一真正的产品缺口是:优雅退出连同 run dir 删掉了 `bridge.log`,导致退出原因不可追溯——建议加一个独立于 run dir 的持久 exit journal(R1)。**

## 附:证据索引
- run dir 已删:`logs/mcp-mr3dqe6w-ywdiel/`（工具返回 logFile 曾指向此）当前 `No such file or directory` → code-0 清净退出。
- 退出路径代码:`cleanupAndExit` 定义 3592;code-0 触发 3499(P6)/3508/3535(P2)/3619/3630;code-1 崩溃 3621–3622/3631;run dir 删除 1167;`bridge.log` 写入位于 RUN_LOG_DIR（3626–3627）。
- 并发实例佐证“多客户端各自 server”:`logs/mcp-mr3eo1zw-*`、`mcp-mr3eucdb-*` 的 `owner` 文件 PID(28872/22856/26588…)分属不同 live 实例,含一个非本会话开的 `omp-mr3eub99` 会话 → 与 6-10 “no cross-instance kill、pileup 来自 hang + 外部 mass-kill 的叠加”一致。
- 重载佐证:清理 16+ 孤儿 next 进程后,控制方 `npm run build` 由 5 分钟超时恢复到 25 秒。
- 前置结论沿用 6-10:CC 容忍多分钟 wait(2m14s–5m13s 均完成),故排除“wait 时长触发 kill”。
