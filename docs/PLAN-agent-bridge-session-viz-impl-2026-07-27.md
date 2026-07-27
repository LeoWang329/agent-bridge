# 委托会话史可视化 —— 实施计划 v4

**日期** 2026-07-27 · **状态** 待施工 · **修订** v4（codex 四轮复审，见 §10）
**上游** `docs/DESIGN-agent-bridge-session-viz-2026-07-26.md`（v4）、`docs/UIREQ-agent-bridge-session-viz-2026-07-26.md`

**本文相对 DESIGN 的结构性改动**：数据面换双槽快照（§3）、turn 语义改「桥已派发」（§2.1）、结算改 ledger 状态机（§4）、**默认关**（§8）。DESIGN 其余部分仍作数。

**本文是自动化实施的合同。** 每条验收必须机器可判，不接受"看起来对"。

---

## 0. 三处结构性改动

| 改什么 | 从 | 到 | 为什么 |
|---|---|---|---|
| 数据面 | `transcript.jsonl` append-only + `seq` | **双槽快照** + 保留 progress sidecar | UI 只渲染当前状态、从不按序回放。事件流是照抄圆桌的**路径依赖**（圆桌的辩论确实需要时序叙事，这里不需要） |
| turn 语义 | `turn:started`（宣称"后端已接受"） | **`turn:dispatched`** + `boundary` 证据 | 五后端里只有 OMP/Codex 有协议级确认；Claude 是裸 `stdin.write`、Cursor/Kimi 只是 OS spawn |
| 结算 | 精确 hook + 1 Hz poller | **ledger 状态机 + `settleOnce()` + 退出 O(1) 封账** | 进程退出是同步 `close all → exit`，**没有下一拍**给 poller |

**默认开关：`AGENT_BRIDGE_VIZ` 默认关，`=on` 显式开**（用户 2026-07-27 拍板，覆盖 DESIGN §10 的"默认开"）。

---

## 1. 已核实的源码事实

我抽查 17 处 + codex 三轮独立核链，**DESIGN 的技术判断全部成立**：X9（OMP 多发 RPC 经 `unresponsiveSince` 会话级共享 `:2327` → `#markUnresponsive` → `terminateProcessTree`）；五后端流语义（`:2345`/`:2473`/`:3079` vs `:3090`/`:3641`/`:4184`/`:4661`）；Codex 三级 fallback `:3322`；`#beginTurn` 可从 readline 同步回调进 `:3063`；`session.close()` 是真漏斗（五处类方法 + `openSession` 失败双路 + `cleanupSessions` 绕过 `closeSession()`）；三条退出路径各走各的。

**与既有决策无冲突**：不回灌 `.log`（与 2026-07-18 日志体积根因修复同向）；`turn:collected` 是 v0.10.0 收口纪律的可视化；`contextUsage` 口径照抄正确版；不新增 CLI 子命令。加 `vizDir` 是 additive——`repro-*` 全套无 `deepStrictEqual`/`Object.keys` 精确形状断言。

---

## 2. 插桩点

⚠️ **行号只作辅助**（已发现偏差：codex `#beginTurn` 在 `:3129`、kimi `#settleTurn` 在 `:4586`）。**施工一律按「函数名 + 邻近唯一语句」定位。**

### 2.1 派发边界 → `turn:dispatched`

| 后端 | 位置 | `boundary` | 强度 |
|---|---|---|---|
| OMP | `#handleLine` **response 成功分支**，`pending.resolve()` **之前** | `rpc_ack` | 协议级 |
| Codex | `#beginTurn`（本体已幂等：`if (!this.turn \|\| this.turn.begun) return`） | `turn_start_ack` / `turn_started_notification` | 协议级 |
| Claude | `#beginTurn`（`#writeUser` 之后） | `pipe_enqueued` | **仅 transport** |
| Cursor | `#beginTurn(turnId, child)` | `os_spawned` | **仅 transport** |
| Kimi | `#beginTurn(turnId, child)` | `os_spawned` | **仅 transport** |

Claude 的 `#write` 是**无 callback 的裸 `stdin.write`**，只证明进了 Node/OS 管道；Cursor/Kimi 等的是 Node child 的 `"spawn"` 事件，只证明进程起来了。**UI 只能写「已派发，等待后端输出」，不能写「后端已接受」。**

可选记 `firstBackendEventAt` 区分「已派发但完全沉默」（最该被看见的卡死形态）与「已开始输出」——**只是诊断字段，绝不作轮次出现的门槛**。

### 2.2 结算边界（三类，**处理方式各不相同**）

| 类 | 后端 | 位置 | 处理 |
|---|---|---|---|
| **A 精确结算** | Codex/Claude/Cursor/Kimi | `#settleTurn`——**四个本体都幂等**（`const turn = this.turn; if (!turn) return;`），钩子挂 guard 之后 | `settleOnce()`，抓正文 + 准确 outcome |
| | OMP | `agent_end` / `abort` | `settleOnce()`；`agent_end` 若只有 ambiguous 则先 adopt 再 settle；abort 只对已 dispatched/adopted 的轮次结算 |
| **A′ 不是结算** | OMP | **`send catch`** | ⚠️ **绝不调 `settleOnce()`**。见下 |
| **B 终态短路** | OMP | stdin error / process error·close / `#markUnresponsive` / `close` | **全都不碰 `turnInFlight`**，靠 `sessionSettled()` 对 failed/closed 短路 `:5190`。由 poller + close finalizer 兜底 |
| **C 仅状态变化** | OMP | `state()` 能把状态改 idle 而**不清** `turnInFlight` | **绝不能当结算信号** |

⚠️ **A′ 是 v2 写错的地方**：OMP 的 dispatch 点是**成功 ACK**，而进入 `send catch` 时**通常还没 dispatch 过**（`success:false` 走 response 分支 reject、ACK 超时走同一个 catch）。在这里调 `settleOnce()` 会**把一个 ACK 超时立刻做成"已结算轮次"，恰好抹掉"后端可能仍在跑"这个歧义**——那正是要保留的信息。正确处置见 §4 规则 4。

### 2.3 其余

| 事件 | 位置 |
|---|---|
| viz 初始化 | **只能在 `serveMcp()` 内**——否则 `doctor`/`cleanup`/`help`/测试 import 都会凭空建目录 |
| 会话开 | `await session.start()` **成功后立即**（不等 initial turn） |
| 会话开失败 | 两分支各带 `phase:"start"\|"initialTurn"` |
| 状态迁移 | `setSessionStatus()`（唯一漏斗），**现场重算 `deriveHealth`** |
| 会话关 | 五处 `close()` 类方法，**按 sessionId 幂等**（open 失败分支先 close 再 openFailed，顺序定死：**openFailed 优先，抑制该 sessionId 的 closed**） |
| 收口 | **`callTool()` 统一覆盖 open/send/result/wait 四个交付面**，不在内部 `result()` 记 |

---

## 3. 数据面：双槽快照

```
<VIZ_DIR>/
  meta.json                     ← runId / pid / 桥版本 / degraded
  owner                         ← pid + 进程起始时间
  state.0.json  state.1.json    ← 双槽,各带 schemaVersion + runId + generation
  turns/<sessionId>/
    t1.in.md  t1.out.md         ← 不可变正文,写一次
    t3.progress.json            ← 仅活跃轮次,覆盖写,结算后删除
```

### 3.1 双槽而不是原子写

DESIGN §5.3 已论证：Windows 上 temp+rename 会因 Defender 让 `MoveFileEx(REPLACE_EXISTING)` 返 EPERM → 写失败被吞 → **页面把健康会话报成卡住**。对快照同样成立，**不能用 rename**。

1. writer **严格串行，永不重叠写**
2. 始终覆盖**较旧**的槽；写成功后下次才切另一槽
3. 每槽带单调 `generation`
4. viewer 两槽都试解析，取**合法且 generation 最大**的

⚠️ **撕裂读频率无法给出可信单值**（writer 不存在、实测受 Defender 状态影响，任何百分比都是伪精确）。双槽的价值是让这个数字**不必知道**：最坏退化为"读到上一代"，而不是"长期不可读"。

### 3.2 `generation` 是 **run-local**，绝不 resume 旧目录

- 每次 MCP run 重新 `mkdtemp` → 新 runId、新目录 → **`generation` 从 1 开始**
- 上一进程 SIGKILL 留下的两槽只供 viewer 回看，随后由 owner/gone 与 `cleanup` 处理
- **若因配置错误让新 writer 指向已存在的旧目录 → 拒绝初始化 + degraded**，绝不重置 generation 覆盖旧 run

**「合法槽」四条校验**：`runId` 与同目录 `meta.json` 一致 · `generation` 是安全正整数 · `schemaVersion` 受支持 · 必填结构完整。**高 generation 但 runId 不符者不得胜出。**

### 3.3 只在里程碑写，不按 1 Hz

实测量级：20 会话 × 15 轮 + 每活跃会话 400 中文字符尾巴 ≈ **126,931 字节**，序列化 ≈ 0.26 ms。**1 Hz 全量覆盖 ≈ 436 MiB/小时**，直接违反约束 2。

里程碑 = session open/status/close · turn dispatch/settle/collect · run 状态变化。

**400 字实时尾巴仍走 per-turn progress sidecar**（覆盖写、不用 rename、带 `generation` 稿次、结算后删除）。并进全局快照会让**一个会话的进度更新重写其他 19 个会话和全部历史**。

### 3.4 迟到 progress 不能让已结算轮次回退

前端**只在「该 turn 在快照里仍是 running 且身份匹配」时才合并 progress**。快照一旦标 settled，迟到 sidecar 永远无法让它回退；viewer 收到 settled 立即停轮询该 sidecar。比全局 `seq` 更直接。

### 3.5 提交顺序 + 队列拒绝的控制面保底

`generation` 是发布屏障：**同步抓正文 → 队列写 `t<N>.out.md` → 写成功回调后才改 settled 并填 `outputRef` → 才发下一代快照**。

⚠️ **但队列可能拒绝**。若快照写与正文写争同一个满队列，会出现"ledger 永久停在 settling"或"内存 settled 但 viewer 永远看不到"，**连 `degraded` 自己都排不进去**。所以：

1. 正文入队失败 → **同步**完成 `settling → settled`，`outputRef:null` + `bodyKind:"none"` + `recordingError:"queue_full"`
2. **立即释放抓住的正文字符串**，不再占字节预算
3. **快照走单一 coalesced dirty slot**，不与正文 job 争普通队列容量；当前写完成后总会尝试发布最新 ledger
4. 快照写失败 → 保留 `dirty=true` 后续重试，**绝不把一次失败当作已发布**
5. **`settleOnce()` 的共享 Promise 必须在降级状态确定后结束**，不能因队列拒绝永久 pending

**输入同理**：dispatch 时输入文件还没写完，**不能立刻公布可读 `inputRef`**。先 `inputState:"pending"` 无 ref；写成功后再发布 ref；入队被拒 → `inputState:"missing"` + degraded。**任何情况下都不出现悬空引用。**

### 3.6 已知弱点 + **v1 不做有损裁剪**

快照含完整历史 → 里程碑写入累计成本趋向 **O(turn²)**。

实测单次快照体积（按 §6 完整 settled+collected 结构序列化）：**1×1000 轮 = 815,252 字节 ≈ 0.78 MiB**（compact），pretty 约 1.24 MiB，**约 815 字节/轮**。长路径与 300 字错误会上浮，1000 轮仍在 1~2 MiB。

⚠️ **所以 v1 明确不做有损裁剪。** 尤其**不许**把已 settled/collected 轮次的 ref 与元信息摘要化——那会直接破坏"完整会话史"这个立身之本。将来真到万轮规模，正确退路是 **schema v2 的 per-session 分片**，不是偷偷丢历史。

**注意区分**：单次体积可接受 ≠ O(turn²) 累计写入消失。§9 因此含 20×15 与 1×1000 两个固定用例 + 一条确定性体积断言（compact < 2 MiB）。

---

## 4. VizLedger 状态机

```
attempted ──dispatch──> dispatched ──settleOnce──> settling ──写完/降级──> settled
    │                        ↑
    ├──确定拒绝──> rejected（销毁,不产生 turnNo,不发任何事件）
    └──无法判断──> ambiguous ──单个可认领时被后到终结 adopt──┘
                        └──多个/无法认领──> unresolved（销毁 + degraded）
```

**公开快照只暴露 `dispatched` 与 `settled`。** `attempted`/`rejected`/`ambiguous`/`settling`/`unresolved` 留在 ledger 内部，避免 UI 渲染半提交状态。

**六条硬规则：**

1. **`turnNo` 只在一次原子 `acceptOrAdopt()` 里分配。** 两个入口分别分配会绕过任何去重键。
2. **`settleOnce()` 必须在任何 await / 文件写之前，同步把 `dispatched → settling`**，并返回同一个 Promise。这是 OMP 那几处不幂等 hook 的唯一护栏（idle 时 abort、重复/迟到 `agent_end` 都会再触发）。
3. **去重靠 ledger 状态，不靠 writer 里的 Set。** `(eventType, sessionId, turnNo)` 只是标识，解决不了 check-then-queue 竞态。
4. **`rejected` 与 `ambiguous` 严格分开，且判据必须结构化——不许匹配错误字符串。**

   **确定拒绝（`rejected`，立即销毁，共 7 种）：**
   | # | 形态 | 位置 |
   |---|---|---|
   | 1 | message 为空 | `sendMessage` 入口 |
   | 2 | busy session（`already has a running turn`） | OMP / Codex / Claude 各自 send 开头 |
   | 3 | OMP 后端显式 `success:false` | `#handleLine` response 分支 |
   | 4 | Codex `turn/start` **明确 error response** | `send()` catch，**须与超时区分** |
   | 5 | Claude `#writeUser` stdin 写失败 | `#write` throw |
   | 6 | Cursor spawn 失败 | spawn 前/中失败 |
   | 7 | Kimi spawn 失败 | 同上 |

   **歧义（`ambiguous`，保留待认领，共 3 种）：**
   | # | 形态 | 为什么 |
   |---|---|---|
   | 1 | **OMP ACK 超时** | 超时 ≠ 后端没接受，它可能已经在跑 |
   | 2 | OMP 写入后断链 | 同上 |
   | 3 | **Codex `turn/start` 超时** | 源码注释明写「the app-server may yet return a turn id and **run that turn untracked**」；超时后还会替换 pending handler，晚到 response 带 turn id 就主动 interrupt |

   ⚠️ Codex 的**明确 error 与超时共用同一个 catch**，所以必须由 viz 侧携带结构化 timeout 标记，**不能靠 `err.message` 匹配**。

5. **认领只看 `ambiguous`**，绝不按 sessionId 从所有失败 attempt 里捞。**同一 session 有多个 ambiguous 时禁止认领**（仅凭 sessionId 无法知道 `agent_end` 属于哪个 prompt），一律转 `unresolved` + degraded，**不许永远挂在 ledger 上**。
6. **Codex 晚到的成功 response / `turn/started` 通知可以认领**那个超时的 attempt，随后按实际 interrupt/completion 收口。

### 4.1 OMP 的 `pendingRpc`（**不动核心 `this.pending`**）

`request(type, extra, vizAttemptId = null)` —— 第三个参数**纯 observer 用途**，核心 `this.pending` 形状保持 `{resolve, reject}` 不变。映射存 `VizLedger.pendingRpc`：`(sessionId, requestId) → vizAttemptId`。

**顺序（`#handleLine` 的 response 成功分支）：**

```
找到 pending prompt response
→ success ⇒ viz ledger 同步 accept、分配 turnNo、发 turn:dispatched
→ pending.resolve(message)          ← 核心行为一个字节没变
→ 原 send() 的 await 续体照旧执行核心 stamp
```

- `turnId` 用 **viz attempt 自己的稳定 ID**；`backendTurnId` 作可选别名，后续拿到再绑。**绝不等 `currentTurnId`**——它要到 await 恢复后才生成。
- ⚠️ **必须支持 ACK 之前到达的 lifecycle/progress/terminal**：暂存在 attempt 上，ACK 后分配 turnNo 立即归并。否则出现「已结束却永远不 settle」的轮次。
- **`pendingRpc` 必须在五类出口清理**：success · `success:false` · timeout · stdin/process error · close。timeout/断链清理时**把 attempt 转 `ambiguous`**，不留永久映射。
- ACK 已超时、核心 pending 已删除 ⇒ **迟到 response 不能重新走正常 accept**，只能作为 `ambiguous` 的证据。

### 4.2 退出期：**同步封 ledger，但不同步落盘**

`cleanupAndExit()` 同步关完所有 session 就 `process.exit()`，`runCli().catch` 同样。**没有下一拍。**

⚠️ **v2 把"同步封账"写成了"同步落盘"，这是错的**，两个理由：

- 仓库自己的教训：同步 OS 操作放进异步路径**照样冻事件循环**；同步文件写**没有可执行的超时**，Defender/文件系统一卡就把退出本身拖死
- **正常退出马上删除整个 `VIZ_DIR`**——写完即删的最终快照**没有可靠消费者**，与"clean exit 的可靠终态是 owner/gone"自相矛盾

**正确处置：**

| 场景 | 做什么 |
|---|---|
| `session.close()` 且桥继续运行 | 同步改 ledger 状态；异步 dirty snapshot |
| run 退出 | **只做 O(1) 的 ledger seal + 停止接收新任务**，不同步写大快照 |
| `process.on("exit")` | **不做任何 snapshot I/O** |
| 退出时存在 `settling` 正文 job | **不等待**；run gone 是最终裁决 |
| viewer 侧 | 看到 owner gone / 目录消失后，把仍为 dispatched 的公开轮次**合成**为 abandoned |

**finalizer 必须覆盖三种内部态**（v2 只写了第一种）：`dispatched` → abandoned · 单个可认领 `ambiguous` → adopt 后 abandoned · `settling` → 正常 close 复用原 settlement Promise，run exit 由 gone 终结。

**poller 只是活进程期的漏钩兜底，不承担退出期正确性。**

---

## 5. `turn:collected`

`wait` 有且只有两条绕过 `buildSessionResult` 的路径（源码注释自标「结果构造函数**不是唯一漏斗**」）：

| 路径 | `turnSettled` | `lastTurn` | `charCount` |
|---|---|---|---|
| gone（会话被并发关掉） | `true` | **无** | 无 |
| `result()` 抛错的 base fallback | `settledNow` | 有 | **`null`** |

**记录条件（四条全满足）：**

1. `turnSettled === true`
2. `lastTurn.id` 非空
3. **确实成功构造过结果**：`charCount`/`byteCount` 是**数字**（`0` 是合法空答案，`null` 才是 fallback）
4. **provenance 同源**：backendTurnId 取自**同一次 `buildSessionResult()`**，不能在 await 之后从 session 现读 `lastTurn`

### 5.1 ID 映射（**v2 在这里自相矛盾，v3 修正**）

v2 §4.1 说公开 `turnId` = viz attempt ID，§5 条件 4 又说直接用 `r.session.lastTurn.id` 当 `turnId`——后者是**桥的 backend turn id，不是 viz ID**。正确关系：

```
r.session.lastTurn.id
  → 当作 backendTurnId 查 VizLedger
  → 找到 ledger turn
  → collected 标记写到该 turn 的 vizTurnId / turnNo
```

### 5.2 provenance 通道

条件 4 在 `callTool()` 里**当前不可实现**：`wait` 明确丢弃 `r.session` 后重新读 `lastTurnOf(session)`。所以需要一条**不改变公开返回值**的私有通道：`WeakMap<returnedResult, {backendTurnId}>`，或 non-enumerable `Symbol` 元数据，在 `callTool()` 序列化前取出。

**必须覆盖四种返回形状**：`open_session.wait:true` → `value.initial` · `send_message.wait:true` → 顶层 · `result` → 顶层 · `wait` → `completed[]`/`settled[]` 中每个最终被稳定性检查接受的元素。

**同一轮重复 result/wait 只记第一次 collection**（定死，不留给实现者）。

---

## 6. 快照 schema（`skills/agent-bridge/viz/STATE.md`，S1 同期落地）

⚠️ **这是双槽改造引入的最大合同缺口**——PLAN 删掉了 DESIGN 的事件信封与事件表，必须给出等价的 state 结构，否则实现者要自己猜十来个决定。

```jsonc
{
  "schemaVersion": 1,
  "runId": "mcp-xxxx",              // 必须与 meta.json 一致,否则该槽非法
  "generation": 7,                  // run-local 单调正整数,从 1 开始
  "updatedAt": "2026-07-27T…",
  "run": {
    "pid": 1234, "bridgeVersion": "0.10.0", "startedAt": "…",
    "status": "running" | "terminated",
    "terminatedAt": null, "reason": null, "exitCode": null,   // status=terminated 时必填
    "degraded": false,              // 记录不完整 → UI 显示"观测数据可能过期/不完整"
    "recordingErrors": ["queue_full"]   // 去重原因码,**最多 16 条**;枚举见 §6.1
  },
  "sessions": [                     // 数组,按 **session attempt 创建顺序**(才容纳得下 openFailed)
    {
      "sessionId": "codex-…", "name": null,
      "agent": "codex", "model": null, "effort": "xhigh",
      "access": "read", "cwd": "D:\\…", "returnMode": "full",
      "logFile": "C:\\…\\codex-….log",   // UIREQ §7.2 的逃生门,必须给
      // injectionMode 三档,**照抄源码枚举**:system(omp/claude 真 system) / developer(codex
      // thread developerInstructions) / first-turn-user-prefix(cursor/kimi 软注入)
      "appendSystemPrompt": null | { "file": "…", "bytes": 1820,
                                     "injectionMode": "system" | "developer" | "first-turn-user-prefix" },
      "backendPid": 16116 | null,        // **可空**:五后端的 proc?.pid ?? null,形状 B 轮间本来就没有
      "status": "running" | "starting" | "idle" | "failed" | "closed",
      "health": "healthy" | "degraded" | "dead",
      "isStreaming": true,
      // OMP 会额外返回 isCompacting / autoCompactionEnabled,必须透传
      "contextUsage": null | { "tokens": 169601, "live": false,
                               "isCompacting": true, "autoCompactionEnabled": false },
      "createdAt": "…", "updatedAt": "…",
      "openFailed": null | { "phase": "start" | "initialTurn", "error": "…≤300字" },
      "closed": null | { "reason": "…", "forced": false, "at": "…" },
      "turns": [                             // **按 turnNo 升序**
        {
          "turnNo": 3,                       // viz 自己的编号,从 1
          "vizTurnId": "vt-…",               // viz 稳定 ID,**一个 run 内永不复用**
          "backendTurnId": "019fa…" | null,  // 拿到才绑
          "backendTurnCount": 3 | null,      // 防编号分叉,UI 不显示但复制时带上
          "state": "dispatched" | "settled", // 公开只有这两个
          "boundary": "rpc_ack" | "turn_start_ack" | "turn_started_notification"
                    | "pipe_enqueued" | "os_spawned"
                    | "terminal_adopted",    // ← ambiguous 被后到终结认领(无 ACK 可依)
          "attemptedAt": "…",                // 原 prompt 派发时刻
          "dispatchedAt": "…",               // **公开/认领时刻**(terminal_adopted 时晚于 attemptedAt)
          "settledAt": null,
          "firstBackendEventAt": "…" | null, // 诊断用,不作门槛;**允许早于 dispatchedAt**(OMP ACK 前可先来 lifecycle)
          "source": "initial_prompt" | "send_message", "blocking": false, "hasSchema": false,
          "input":  { "state": "pending" | "ready" | "missing",
                      "ref": "turns/<sid>/t3.in.md" | null,
                      "chars": 1240, "bytes": 3720,      // 实际保存的
                      "truncated": false, "originalBytes": 4820,
                      "error": null | "queue_full" | "write_failed" },
          "output": { "state": "pending" | "ready" | "missing",
                      "ref": "turns/<sid>/t3.out.md" | null,
                      "chars": null, "bytes": null,      // **dispatched 阶段恒 null**,settled 后才是数字
                      "error": null | "queue_full" | "queue_item_too_large" | "write_failed" },
          "outcome": null | "completed" | "failed" | "aborted" | "abandoned",
          "bodyKind": null | "final" | "partial" | "none",
          "generationCount": 2,              // 稿次,与 progress sidecar 同源
          "collected": null | { "at": "…",
                                "via": "open_session" | "send_message" | "result" | "wait",
                                "returnedChars": 8932,   // **实际内联返回的字符数**;returnMode:"ref" 时可为 0,
                                "truncated": false },    //   不等于正文 chars
          "error": null | "…≤300字",
          "durationMs": 252000 | null
        }
      ]
    }
  ]
}
```

**未知字段一律不允许**——实现者**不许直接 spread `session.summary()`**，必须逐字段白名单映射（否则后端新增字段会静默流进快照，绕过 §7.1 的白名单纪律）。

### 6.1 `recordingErrors` 原因码（封闭枚举，最多 16 条去重）

`queue_full` · `queue_item_too_large` · `write_failed` · `snapshot_write_failed` · `dir_conflict`（新 writer 指向已存在旧目录）。

**观测失败只描述"我们没记下来"，绝不改变后端的 `outcome`。**

### 6.2 合法组合矩阵（**必须实现成语义校验函数**）

⚠️ 光靠 JSON Schema 的字段类型表达不了交叉约束。五个状态字段会产生大量自相矛盾组合，必须写死：

| `state` | `outcome` | `settledAt`/`durationMs` | `bodyKind` | `output.state` | `input.state` | `collected` |
|---|---|---|---|---|---|---|
| `dispatched` | 必须 `null` | 必须 `null` | 必须 `null` | 必须 `pending` | `pending`/`ready`/`missing` | 必须 `null` |
| `settled` | **必须非空** | **必须有值** | **必须非空** | `ready` 或 `missing`，**禁止 `pending`** | `ready`/`missing`，**禁止 `pending`** | `null` 或首次收集记录 |

`outcome × bodyKind`：

| | `final` | `partial` | `none` |
|---|---|---|---|
| `completed` | ✅ 绝大多数 | ✅ 少见（OMP 降级） | ⚠️ **仅当该轮 `output.error` 非空时合法** |
| `failed` | ❌ | ✅ | ✅ 常见 |
| `aborted` | ❌ | ✅ | ✅ |
| `abandoned` | ❌ | ✅ 偶尔 | ✅ 常见 |

⚠️ **`completed + none` 是 v3 新出现的例外**（后端正常完成，但观测侧写失败）。**不能照搬 UIREQ §6.4 的旧矩阵判它非法**（那份矩阵写于观测失败这个概念存在之前），**也不能无条件允许**——否则实现者会把"正常完成但没记下正文"当成普通情况混过去。

**六条蕴含式：**

- `bodyKind ∈ {final, partial}` ⟺ `output.state === "ready"` 且 `output.ref` 非空
- `bodyKind === "none"` ⟺ `output.state === "missing"` 且 `output.ref === null`
- `collected !== null` ⟹ `state === "settled"`
- **任何 `state` 下都不得出现悬空 ref**（ref 非空 ⟹ 该文件存在且可读）
- **`input.error`/`output.error` 非空 ⟹ 对应的 `state === "missing"`**
- **`state ∈ {pending, ready}` ⟹ 对应的 `error === null`**

> 后两条是 codex 第五轮补的：没有它们，`{state:"ready", error:"queue_full"}` 这种**不可能组合仍能通过 `validateState()`**。

**观测失败的连带写入**：任何 `input.error`/`output.error` 被置位时，**必须同时**置 `run.degraded = true` 并把原因码并进 `run.recordingErrors`（去重、上限 16）。三处不同步就是"页面看起来完整实则缺页"。

### 6.3 `progress.json`（sidecar）

`{ "vizTurnId", "generationCount", "updatedAt", "charCount", "tail" }`

`vizTurnId` 做身份匹配。**成立的前提是四条**：`vizTurnId` run 内永不复用 · viewer 只在当前快照里该 turn 为 `dispatched` 时才合并 · sidecar 的 `vizTurnId` 必须等于当前 turn · 同一 sidecar 路径的读不并发（防旧 read 晚于新 read 返回）。新 run 用新目录，所以不需要额外 `runId`。

---

## 7. 模块结构：独立 `scripts/viz-writer.mjs`

三轮都选 B。+900 行塞进 6004 行 core 会让 writer/ledger/队列/cleanup **无法直接单测**，而 §9 明确要求零消耗回归。

**两条硬规则：**

- **零副作用**：只有 `createVizRun()` 被调用才 `mkdtemp`；模块顶层不做任何事
- **不为复用 helper 去 import 主文件**——主文件底部立即执行 `runCli()`，import 它就会启动 CLI。writer 自包含，或由主文件注入诊断 callback

---

## 8. 开关与隐私

**`AGENT_BRIDGE_VIZ` 默认关，`=on` 显式开**（用户拍板，覆盖 DESIGN §10）。

理由：桥今天的诊断日志**刻意不落 prompt 全文**（`LOG_BODY_KEYS` elide），viz 会把它落盘——这让"本机磁盘上存在全部委托原文"从**不发生**变成**发生**。临时目录只解决持久化；run 存活期间 tmpdir 里就是一份全量明文，本机任何进程可读（tmpdir 无 ACL 收紧）。

**代价必须写进 SKILL.md**：出问题那个 run 当时没开，就**没有记录**。所以要提示用户在准备重度委托 / 多 agent 编排**之前**主动打开，而不是出事后才想起来。

---

## 9. 分期（内部里程碑，S1–S5 均不对用户发布）

> S1 独立"上线"没有意义：没有页面它不是观测台，R1/R2 今天本来就能由 `agent_bridge_status` 大致回答。五期是**开发拆分与 merge 节奏**，不是发布节奏。

### S1 —— writer 地基 + STATE.md + 隐私说明

`viz-writer.mjs`（双槽 + 串行 writer + coalesced dirty slot + 有界队列 + 开关 + error 300 字硬顶 + degraded）· `STATE.md`（§6 全文）· SKILL.md 隐私一节 · `vizCleanup()` 挂三处 · `cleanup` CLI 孤儿回收

**机器验收：**
- import `viz-writer.mjs` 前后 **tmpdir 里 `agent-bridge-viz-*` 的集合相等**（证明零副作用）。⚠️ **只比这个 glob，不做整个 tmpdir 深比较**——机器上无关临时文件会让它假红，破坏自动化稳定性
- `doctor`/`cleanup`/`help` 各跑一次，tmpdir 零新增
- 双槽：新槽损坏→回退旧槽 · 两槽合法→取 generation 大 · **高 generation 但 runId 错→不得胜出** · schemaVersion 不支持→非法
- **fake write adapter 断言最大并发写数严格 === 1**
- `MAX_PENDING_JOBS` / `MAX_PENDING_BYTES` 有明确常量；单项超限有明确策略
- **队列满 → `state="settled"` + `bodyKind="none"` + `output.error="queue_full"` + `run.degraded=true` + `run.recordingErrors` 含 `queue_full`，且最终能进入下一代快照**
  > ⚠️ 字段名是 **`output.error`**，schema 里**没有** turn 级的 `recordingError` 字段（v3 写过、v4 已删）。断言写错字段名 = 断言了一个永远不存在的东西 = 假绿。
- 快照写失败 → 保留上一代 + `dirty=true` 重试
- 新 run `generation===1`；指向已存在旧目录 → **拒绝初始化 + degraded**
- ownerless 60s 宽限**用可注入的 fake clock / 可配置测试宽限**，不真 sleep 60 秒
- 三条退出路径各造一次，断言目录被删；SIGKILL 后 `cleanup` 能回收
- `AGENT_BRIDGE_VIZ` 未设时 tmpdir 零产出（**这是默认路径**）

### S2 —— 生命周期

`run:*` · `session:opened`（start 成功即发）· `session:openFailed`（带 `phase`）· `session:status`（现场重算 health）· `session:closed`（五处类方法，按 sessionId 幂等）· `vizDir` 进 `status`/`open_session` 返回值

**机器验收：**
- 每个生命周期节点断言快照。⚠️ **「比对 §6 schema」本身不可执行**——§6 是 JSONC 示例不是校验器。S1 必须产出**两样东西**：①一份 JSON Schema（字段类型/必填/枚举）②一个 `validateState()` 语义校验函数（§6.2 的交叉约束）。S2 的断言 = 跑这两个 + 对**归一化后**的快照（把 `updatedAt`/`pid`/`generation`/各种 id 替换成占位符）做 `deepStrictEqual`
- open start 失败 / initial turn 失败**各自**断言最终 state 与 `phase`
- **openFailed 抑制同 sessionId 的 closed**（顺序断言）
- 重复 close **不增加 generation**、不重复改同一 session
- `session:status` 的 health 是**现场值**不是缓存值
- `repro-*` 全套全绿

### S3a —— 纯 VizLedger 状态转移（不碰桥）

**机器验收（全部对 ledger 单测，零后端）：**
- `settleOnce()` 并发调用**只发生一次转移**且返回同一 Promise
- `acceptOrAdopt()` 原子性：并发只分配一个 turnNo
- 7 种 rejected 各自**不产生 turnNo、不产生任何公开状态**
- 3 种 ambiguous 各自保留待认领
- 单 ambiguous + terminal → **adopt 恰好一次**
- 多 ambiguous + terminal → **全部不认领 + unresolved + degraded**
- 队列拒绝 → `settleOnce()` 的 Promise **确实结束**，不永久 pending
- close finalizer 对 `dispatched` / 单个可认领 `ambiguous` / `settling` **三态各有确定结果**

### S3b —— 五后端 dispatch/settle 插桩

⚠️ **B1 的守门测试必须先修基建，否则它是空的。** 现有 `fake-omp.mjs` 的 `say()` 是 `process.stdout.write(JSON.stringify(obj) + "\n")`——**一行一个 write**，而且 `agent_start` 后还跟 `setTimeout`。OS 可能合并也可能不合并这些 write，**绿灯证明不了走过同步 burst 路径**。

**两条路，二选一，不许含糊过去：**

1. **首选**——新增纯单测 seam：用 `PassThrough.push("response\nagent_start\nagent_end\n")` **一次注入**三行，直接驱动 `#handleLine`。确定性 100%。
2. 若坚持进程级假后端：加专用 mode，**一次 `stdout.write()` 写三行**，并让测试**同时断言父进程收到的同一个 raw `data` chunk 确实包含三行**。断言不到就**判失败**——宁可红，不许悄悄退化成"逐 chunk 也算过"。

**机器验收：**
- **OMP「response + agent_start + agent_end 同一同步 burst」**（按上面二选一实现，附带 chunk 断言）
- ACK 之前到达的 lifecycle/terminal **被暂存并在 ACK 后正确归并**
- OMP `success:false` → `rejected`（**不是** settled）
- OMP ACK timeout → `ambiguous`，**不立即 settled**
- Codex 明确 RPC error → `rejected`；Codex `turn/start` timeout → `ambiguous`。**两者共用同一个 catch，必须靠结构化标记区分，测试要断言不依赖 `err.message` 文本**
- Codex 晚到 success / `turn/started` 通知 **能认领** timeout attempt。⚠️ **认领后的 `boundary` 按证据钉死**：晚到 success response → `turn_start_ack`；晚到 `turn/started` 通知 → `turn_started_notification`。**不许误用 `terminal_adopted`**——那一档只留给「没有任何 ACK/通知、纯靠后到的终结事件认领」的 OMP 形态
- `boundary === "terminal_adopted"` 时断言 `dispatchedAt > attemptedAt`
- `pendingRpc` 在五类出口**都被清理**（断言映射表最终为空）
- **OMP 各终结路径的 outcome 映射逐条写死**（不许"产生预期 outcome"这种话）：

  | 路径 | `outcome` |
  |---|---|
  | 正常 `agent_end` | `completed` |
  | 带错误的 `agent_end` / stdin error / process error·close / `#markUnresponsive` | `failed` |
  | 成功 abort | `aborted` |
  | session close 截断在途轮次 | `abandoned` |

### S3c —— poller + progress + close/gone

**机器验收：**
- **故意不挂某后端的精确 hook，断言 poller 仍补出结算**（双层架构的直接证明）
- precise hook 与 poller **同拍时只产生一个 settlement**
- 退出期 dispatched turn 收口为 `abandoned`；**`process.on("exit")` 无 snapshot I/O**（断言无文件写调用）
- 迟到 progress **不让已结算轮次回退**。⚠️ **测试形状必须是「把带旧 `vizTurnId` 的内容写进当前轮正在轮询的那个 sidecar 路径」**，断言仍被拒绝——写在**旧路径**上是空绿（viewer 本来就不读那个文件，必过）
- 结算后 sidecar 被删除

### S4 —— 正文

五后端 canonical 源（Codex 三级 fallback；**OMP 宽限 250ms/硬顶 2s + 零 RPC + `partial` 降级**）+ `bodyKind` + §3.5 提交顺序

**机器验收：**
- 五后端正文与 canonical 源**逐字节相等**
- OMP 造「`agent_end` 先于末条 `message_update`」→ 宽限救回尾部
- OMP 造「宽限内进了新子轮」→ 标 `partial`，**不冒充 final**
- **专项断言 viz 开启后 OMP 的 `unresponsiveSince`/`dead`/`status` 与关闭时逐字段一致**（X9 守门）
- **五种**失败形态都无悬空 ref：body enqueue 被拒 · body write callback 报错 · snapshot write 失败 · **input enqueue 失败** · **input write callback 报错**（v3 漏了最后一条）
- 单个正文大于 queue byte cap → **精确断言结果**：`state="settled"` + `bodyKind="none"` + `output.ref=null` + `output.error="queue_item_too_large"`（不许写"明确降级"这种话）
- run exit 恰好发生在 `settling` 中间 → **子进程在 10 秒内以预期退出码退出**（不许写"不挂死"）

### S5 —— collected + viewer

`turn:collected`（§5）· `viz/serve.mjs`（拷圆桌 + 双槽读 + owner 检查 + sidecar 轮询）· `viz/index.html` · `viz/sample/` · `test-viz.mjs`

**机器验收：**
- collected **四种工具返回形状逐一测试**（open/send/result/wait）
- gone fallback · base fallback · 空答案 `charCount:0` · 稳定性检查失败 · 下一轮抢跑 —— 各自断言是否记 collected
- backendTurnId → vizTurnId **映射正确**
- 同一轮重复 result/wait **只记第一次**
- viewer：最新槽损坏→回退旧槽 · SSE 重连**只发当前态** · 迟到 progress · owner gone · **路径穿越与 symlink 拒绝**
- 长历史**固定两个用例：20 会话×15 轮、1 会话×1000 轮**。判据：不丢 session/turn · JSON 可解析 · **`validateState()` 全过（断言不存在 §6.2 矩阵外的组合）** · **ref 非空数量等于预期值，且逐字节核对其中内容**
  > ⚠️ 只写"所有 ref 可读"是**假绿口子**——实现把 ref 全设成 `null` 也能过。必须同时钉住"该有多少个非空 ref"。
- **1×1000 的确定性体积断言**：compact 快照 < 2 MiB（实测基线 815,252 字节）
- **`reconcileUiState` 的判别性测试（harness 在此定死，不留给实施者选）**

  仓库无 `package.json`、不引任何依赖，所以**不做真浏览器自动化**。改用这个形状：

  1. **`reconcile()` 必须住在独立的 `skills/agent-bridge/viz/reconcile.mjs`**，由页面与测试**共同 import**。
     ⚠️ 不能写在 `index.html` 里又要求 Node 直接 import——那是自相矛盾。
     > 这是对 UIREQ §10「单个 HTML 文件」的一处**有意的最小偏离**：变成 `index.html` + `reconcile.mjs` 两个文件。
     > 该约束的实质目的（**零外部依赖、无构建步骤、离线可用**）完全保留——`reconcile.mjs` 是同目录本地模块，
     > `serve.mjs` 本来就从自己目录供文件。**必须在 S5 交付说明里写明这次偏离及理由**，不许默默改。
  2. 纯决策函数签名：`reconcile(prevState, nextSnapshot, uiState) → {keep[], patch[], replace[], scrollAnchor, selection}`；`index.html` 只留**薄 DOM 应用层**。
  3. `test-viz.mjs` 里写**最小 DOM shim**，只需模型化 `id` / 子节点身份 / `scrollTop` / `open` 四样，喂两代快照，跑四条断言：

     | | 断言 |
     |---|---|
     | **A1** | 选中项 id 不变 |
     | **A2** | 已展开轮次仍 `open` |
     | **A3** | `scrollTop` 不被重置 |
     | **A4** | 未变化的 turn 节点**对象身份未变**（复用而非重建） |

  4. ⚠️ **自动化负对照**（不是"我改坏看过它红了"的文字记录——那本身可以假绿）：
     `test-viz.mjs` **在同一次运行里跑两遍同一套断言**：

     | 注入的实现 | A1 | A2 | A3 | A4 |
     |---|---|---|---|---|
     | 真实 `reconcile` | 过 | 过 | 过 | 过 |
     | 朴素全量替换（`replaceAllChildren` 语义） | **必须过** | 不限定 | 不限定 | **必须失败** |

     **⚠️ 这张表必须写死在测试里，不许实施者跑完看结果再反向定义预期**——那是把假绿换个地方藏。

     **为什么只有 A4 是判别项**（过度指定会走向另一个极端——**制造假红**）：

     - **A1 仍应过**：选中态通常存在 JS 变量里、重建后可重新套 class。把它列为"应失败"会诱导实施者把选中态搬进 DOM ——**为迎合测试而改坏设计**。
     - **A2 / A3 不限定**：`open` 同样可以从 `uiState` 重新套回；而滚动容器本身没被替换时，换掉子节点也**不必然**把 `scrollTop` 归零。把它们钉成"必失败"，等于逼实施者写一个**故意比必要更差**的朴素实现去凑预期——那是伪造判别力。
     - **A4 必然失败**：全量替换就是重建节点，对象身份不可能保住。**这是唯一能真正区分"复用"与"重建"的断言。**

     **任一遍不符合上表 ⇒ 测试判红**（不是"两遍都不符才判红"）。**没有这个自动负对照，shim 测试不算数。**

  **如实写明局限**：shim 不等于真浏览器，它只能证明"复用/重建的决策对了"，证明不了真实布局与滚动的像素行为。后者留人工在 `viz/sample/` 上看一眼——**这一点要写进 S5 的交付说明，不许含糊成"已通过 DOM 测试"**。

**viewer 净账（如实）**：`serve.mjs` 删 `StringDecoder`/`MAX_EVENTS`/`MAX_LINE_BYTES`/`resetTail`/`identity`/`pushLine`/字节偏移 `poll`/SSE replay ≈ 54 行，新增 `readSlot`/`readLatestState`/`pollState`/`sendCurrentState` ≈ 35~40 行，**净省 10~20 行**；前端省掉 `applyEvent`/`ensureSession`/`ensureTurn`/`reduce*`/`dedupeSeq` 一整套 reducer，净省 30~60 行 + 3~4 个状态转换。**不是"215 行全部报废"，是小幅净省**——收益主要在心智负担而非行数。

⚠️ 前端**不能每秒 `innerHTML=` 全量重画**（会丢折叠与滚动位置），需要 `reconcileUiState`。这是快照方案的必要成本。

---

## 10. 复审记录

**v1 → v3，codex 三轮，我逐条复核源码后接受，无一条被我拒绝。**

**第一轮（CHANGES-REQUIRED）** 3 BLOCKER + 8 MAJOR + 3 MINOR：OMP 可能**先 settle 后 accept**（response 只 `resolve` 是微任务，同批次后续行同步进 `#applyEvent`）· v1 把 accept 前**所有**失败标 orphan **反造幽灵轮次** · 进程退出同步 close→exit **poller 没有下一拍** · 四个 `#beginTurn` 并非都在"后端已接受"之后 · OMP 三处 flag-clear 对"结算"完全不穷尽 · OMP 三处 hook 不幂等 · `(sessionId, turnNo)` 不是去重协议 · collected 会把 base fallback 误记 · S1 独立上线无意义 + 三处顺序倒置 · open 失败会先 closed 后 openFailed · 异步 writer 与同步退出缺提交协议 · 行号偏差 · 默认开关自相矛盾。

**第二轮（我要求它攻击自己的 snapshot 提议）**：它**撤回了"单个 `state.json` 每秒全量覆盖"**，改为里程碑触发 + 双槽 + 保留 sidecar，给出真实量级（126,931 字节 / 0.26 ms / 1 Hz ≈ 436 MiB/小时），**拒绝给撕裂读的伪精确百分比**（writer 不存在、只读跑不了碰撞测试），并把 viewer 净账从"215 行全部作废"**主动修正**为"净省 10~20 行"。Q2 确认 B1 不必改状态机，并给出比我更干净的做法（不往核心 `this.pending` 加字段，改用 `VizLedger.pendingRpc`）。Q3 选"改名 `turn:dispatched` + `boundary` 证据"。

**第三轮（对 v2 的验证）** 又是 CHANGES-REQUIRED，找到的是**我自己文档内部的矛盾**：

| 发现 | 修在 |
|---|---|
| OMP `send catch` **不能**走 `settleOnce()`——那会把 ACK 超时立刻做成已结算轮次，抹掉歧义 | §2.2 A′ + §4 规则 4 |
| **Codex `turn/start` 超时也是 ambiguous**（源码注释明写"may yet run that turn untracked"），且与明确 error 共用 catch、不能靠字符串区分 | §4 规则 4 歧义表 |
| `pendingRpc` 生命周期没写完（五类出口清理、迟到 response 处置、多歧义收场） | §4.1 |
| **collected 的 ID 自相矛盾**：§4.1 说 turnId=viz ID，§5 又说用 `lastTurn.id`；且 provenance 在 `callTool()` 当前不可实现 | §5.1 + §5.2 |
| 队列拒绝需要**控制面保底**，否则 degraded 自己都排不进去 | §3.5 |
| 退出期**同步封 ledger 但不同步落盘**——同步写无超时会拖死退出，且写完即删没有消费者 | §4.2 |
| `generation` 必须 run-local + **绝不 resume 旧目录** | §3.2 |
| **缺快照 schema**——删了事件表却没给等价结构，实现者要自己猜十来个决定 | §6 新增 |
| S3 太大，拆 S3a/S3b/S3c | §9 |
| 各期验收需机器可判（fake clock、深比较、并发写数断言、固定压力数字、DOM 断言） | §9 全面重写 |

**第四轮（专查全新的 §6 schema 与 §9 合同）** —— 又是 CHANGES-REQUIRED，但产量已从"推翻结构"降到"schema 细节 + 测试假绿"：

| 发现 | 修在 |
|---|---|
| **S3b 的 B1 守门测试是空的**——`fake-omp.mjs` 的 `say()` 一行一个 `write`、`agent_start` 后还跟 `setTimeout`，**造不出同步 burst**，绿灯证明不了任何事 | §9 S3b 二选一 + chunk 断言 |
| schema **缺合法组合矩阵**，五个状态字段会产生大量自相矛盾组合 | §6.2 两张表 + 四条蕴含式 |
| `completed + none` 是 v3 **新出现**的例外（观测写失败），**不能照搬 UIREQ 旧矩阵判非法，也不能无条件允许** | §6.2 |
| `boundary` 缺 `terminal_adopted`（ambiguous 被认领时五个枚举都不真实）；需区分 `attemptedAt`/`dispatchedAt` | §6 schema |
| 缺字段：`run.terminatedAt/reason/exitCode`、`logFile`、`appendSystemPrompt` 非空形状、`contextUsage` 的 OMP 两字段、`input.bytes`、`output` 计数在 dispatched 期恒 null、`recordingErrors` 上限与枚举、`collected.via` 完整枚举 | §6 + §6.1 |
| `sessions` 排序应为「attempt 创建顺序」（才容纳 openFailed）；`turns` 按 `turnNo` 升序；`vizTurnId` run 内不复用；**未知字段一律不允许**（禁止 spread `summary()`） | §6 |
| **1×1000 实测 815,252 字节 ≈ 0.78 MiB**，**不需要裁剪**；且明确**反对**裁剪旧轮次——那会破坏"完整会话史"，万轮的正确退路是 schema v2 分片 | §3.6 |
| 假绿口子：S5「所有 ref 可读」在 ref 全 null 时空绿；S3c 迟到 progress 必须写进**当前**路径；S1 tmpdir 深比较易假红 | §9 各期 |
| "人看了才知道"的验收：S2 的 `deepStrictEqual schema`（schema 还不是校验器）、S3b 的"预期 outcome"（无映射表）、S4 的"明确降级"/"不挂死"、S5 的 DOM harness 未指定 | §9 全部具体化 |
| S4 漏了 `input write callback` 失败 | §9 S4 五种 |

**第五 / 六轮（确认 v4 补丁）** —— 又抓出 8 处，全是"合同不唯一"或"假绿/假红"：

| 发现 | 修在 |
|---|---|
| `injectionMode` 枚举写错——源码实际是 `system` / `developer` / `first-turn-user-prefix` | §6 |
| `backendPid` 必须可空（五后端 `proc?.pid ?? null`，形状 B 轮间本就没有） | §6 |
| §9/S1 断言了一个**不存在的字段** `recordingError`（v4 已删 turn 级），应为 `output.error` + `run.degraded` + `run.recordingErrors` 三处同步 | §9 S1 |
| §6.2 缺 error×state 约束，`{state:"ready", error:"queue_full"}` 这种**不可能组合仍能通过校验** | §6.2 第 5/6 条 |
| S3b 未钉死**迟到 Codex 证据**的 boundary：晚到 success → `turn_start_ack`、晚到通知 → `turn_started_notification`，**不许误用 `terminal_adopted`** | §9 S3b |
| `reconcile()` 不能既写在 `index.html` 里又要求 Node import——自相矛盾；抽成 `reconcile.mjs`（对 UIREQ §10「单文件」的有意最小偏离，须在交付说明写明） | §9 S5 |
| "改坏→看红→改回"的**文字记录本身可以假绿**；改成同一次运行里跑两遍的**自动负对照** | §9 S5 |
| 负对照表**过度指定 = 制造假红**：全量替换下只有 **A4 必然失败**，A2 可从 `uiState` 套回、A3 的滚动容器没被换不必然归零；逼实施者写"故意更差的朴素实现"去凑预期就是伪造判别力 | §9 S5 表 |

**第六轮结论：APPROVE。**

**六轮的产量曲线**：结构性 BLOCKER（3）→ 自我修正（撤回 1Hz 全量覆盖）→ 文档内部矛盾（8）→ schema 与假绿（10）→ 合同不唯一（6）→ 假红（1）→ APPROVE。**没有一轮是"上轮全绿"**——每轮只是问到了不同的问题。
