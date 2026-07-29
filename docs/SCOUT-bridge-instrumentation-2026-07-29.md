# 桥插桩施工图（S2 + S3b + S3c + S4）

**日期** 2026-07-29 · **状态** 待施工 · **来源** agent-bridge-graph 三路并行侦察

> **这份不是设计，是坐标。** 三个互不知情的 agent 各读 `scripts/agent-bridge.mjs` 的一部分，
> 只报「插在哪、为什么是这里、换个位置会错在哪、有什么风险」,**不落刀**。
> 行号一律不作数(PLAN 已实测到偏差),定位一律按**函数名 + 邻近唯一语句**。
> 每条 anchorStatement 都经报告方核过「在该函数内出现恰好一次」。

真理源仍是 `skills/agent-bridge/viz/STATE.md`;本文与它冲突时以 STATE.md 为准。

---

## 0. 侦察直接推翻的 PLAN 条目

这些不是"再想深一层",是**照源码看 PLAN 写错了**:

| PLAN 原文 | 源码实况 | 后果 |
|---|---|---|
| §2.2「class A:Codex/Claude 挂 `#settleTurn` 即可」 | codex 的 `abort()` **完全绕过** `#settleTurn`(源码自带注释写死了这件事),`#rejectAll` 也绕过 | 只挂那一处 ⇒ 每个被 abort 的 codex 轮次都停在 dispatched,直到关会话才被合成 `abandoned` —— **用户明明中断了,页面显示"未收场"** |
| §2.1「Codex dispatch 挂 `#beginTurn`」 | `#beginTurn` 函数体**无法知道证据来源**;且 `turn/start` 超时后 `this.turn` 已置 null,晚到的 `turn/started` **根本进不来** | ⇒ STATE §4.6 要求的 `turn_start_ack` / `turn_started_notification` 分不开;「晚到通知认领 ambiguous」**结构上不可达**。改挂两个调用点 |
| §4 规则 4「Codex 超时须由 viz 侧携带结构化 timeout 标记」 | **判据已经在源码里,而且桥自己正在用**:`this.pending.has(startReqId)` —— 明确 error 与 stdin 死都会先 delete,只有超时不会 | 不必新加标记。与桥的拦截判据**共用同一个表达式,结构上不可能漂** |
| §2.2「OMP 终态短路靠 poller 兜底」 | 仓里**没有** viz poller;而 `finalizeSession` 把在途轮次收成 `abandoned` | 退出期没有下一拍 ⇒ `abandoned` 顶替 `failed`。已加 `markSessionTerminal()` 让调用方**当场说清是哪一种** |
| §4 表「空 message 在 `sendMessage` 入口拒」 | 当前 `sendMessage` 只查字段是否存在;空字符串要到 OMP send 首行才拒,空 `initial_prompt` 因 falsy 直接跳过 | 这条拒绝坐标**已漂移** |
| §4.1「pendingRpc 五类出口」 | 实际至少八个物理出口(含 `#markUnresponsive` 批量清理);stdin 的 `close` 事件当前只写日志、不是清理出口 | 已加 `rpcDrainSession()` 收口批量场景 |

## 1. 已经据此改掉的 writer API 缺口

侦察指出「按 PLAN 直接接线会绕过 recorder 的安全边界,或根本接不上」,四条已修(回归 N1~N6):

- `activeAttempt(sessionId)` —— 通知处理器/事件分发/abort **没有 send() 的闭包**,而 pendingRpc 在 ACK 后就删了
- `rpcRegister/rpcTake/rpcDrainSession` —— 原来只暴露裸 Map,而 **disabled recorder 的 `_ledger` 是 null**,照那样接线"关掉观测"会当场崩桥
- `markSessionTerminal(sessionId, {outcome})` —— 区分「后端崩了(failed)」与「会话被关(abandoned)」
- `settleOnce` 的正文接受**函数**(两阶段) —— 同步的是状态转移、不是正文;OMP 的 250ms 宽限因此可行,硬顶 2s

## 2. 插桩坐标

### scout-omp（20 处）

#### `send` — OMP / lifecycle / 紧接其前

```js
    if (this.turnInFlight) throw new Error(`OMP session ${this.id} already has a running turn; wait for it to finish.`);
```

**为什么是这里**：在这里创建本轮 observer attempt；若 guard 命中，须在同一分支先 reject 再抛错。放到 guard 后会漏掉 busy 这种确定拒绝；更早则会给 closed/dead/process-not-running 等前置失败制造无意义 attempt。attemptId 随后只以 observer 参数传给 prompt RPC。

**风险**：这一行需改成块语句；若创建 attempt 后忘记在 busy 分支 reject，会留下不可见的 attempted。不得 await，也不要把 attemptId 塞进核心 this.pending。

#### `request` — OMP / lifecycle / 紧接其前

```js
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
```

**为什么是这里**：核心 this.pending 已在上方注册，此处再把 `(sessionId, requestId) → vizAttemptId` 放进 pendingRpc；只对带第三参数的 prompt RPC 建映射。放到 write 后会留下写入/断链窗口；放到核心 pending 注册前则会出现 observer 有映射、核心无请求。

**风险**：当前 recorder 没有安全的 pendingRpc API，直接碰 `_ledger.pendingRpc` 会绕过 #safe，且 disabled recorder 的 `_ledger` 是 null。不得改变 `{resolve,reject}` 形状或等待 recorder。

#### `#handleLine` — OMP / dispatch / 紧接其后

```js
      this.unresponsiveSince = null;
```

**为什么是这里**：先保持核心语义：任何按时 response——包括 success:false——都证明后端响应正常并清掉静默期。随后取出并删除 pendingRpc；仅当映射存在且 `message.success !== false` 时同步 `dispatch(...,{boundary:"rpc_ack"})`，然后才让现有 `pending.resolve(message)` 执行。不能放到 send() 的 await 之后：resolve 只排微任务，同一 stdout chunk 的后续行会先由 readline 同步进入 #applyEvent，可能先到 agent_start/agent_end。

**风险**：dispatch 会同步归并 ACK 前缓存的 terminal，并可能立即触发 settleOnce；这是预期重入。任何 observer 异常若越过 recorder 的安全边界，都会阻断核心 resolve，改变桥行为。

#### `#handleLine` — OMP / reject / 紧接其后

```js
      this.unresponsiveSince = null;
```

**为什么是这里**：与 dispatch 共用物理插点：删除 pendingRpc 后，`message.success === false` 是结构化的确定拒绝，应先 `reject(attemptId, message.error)`，再执行源码现有 pending.reject。放到 send catch 才判断会把明确拒绝和 timeout/断链混在一起。

**风险**：success:false 也必须保留源码的 unresponsiveSince 清零；不能只在成功 ACK 时清。reject 不能调用 settleOnce，也不能依赖错误字符串分类。

#### `request` — OMP / ambiguous / 紧接其后

```js
          this.pending.delete(id);
```

**为什么是这里**：这是 ACK timeout 的唯一结构化判据。删除对应 pendingRpc 并把 attempt 转 ambiguous，然后才执行核心 pending.reject。放到 send catch 会丢失 timeout 类型，且容易把“后端可能仍在跑”错误结算。

**风险**：X9 高风险点：不要清或重置会话级 unresponsiveSince，也不要改变后续首次超时打点与阈值判断。observer 调用必须不抛，否则会阻断核心 reject 和 #markUnresponsive。

#### `send` — OMP / lifecycle / 紧接其后

```js
        setSessionStatus(this, "idle", false, { source: "prompt_error" });
```

**为什么是这里**：这是负坐标：这里只允许记录核心状态变化，禁止任何 turn settlement。success:false 已在 #handleLine reject；timeout 已在 request timer 标 ambiguous；stdin/process 断链由相应 handler 标 ambiguous。这里现有的 turnInFlight=false/idle 仅表示桥允许继续使用会话，不证明后端没接受 prompt。

**风险**：在这里调用 settleOnce 会把 ACK timeout 立即伪装成已结算轮次；把 idle 当完成也会抹掉后端仍可能运行的歧义。

#### `#applyEvent` — OMP / lifecycle / 紧接其前

```js
    if (message.type === "agent_start" || message.type === "turn_start") {
```

**为什么是这里**：在顶部 `if (this.dead) return` 之后、任何事件分支返回之前记录 firstBackendEvent。这样 ACK 前 lifecycle 可缓存到 attempt，ACK 后可归并；放到 #handleLine 调 #applyEvent 之前会把 dead session 的缓冲尾行也记成有效后端活动。

**风险**：pendingRpc 在 ACK 后已清理，所以这里必须有独立的 session-level active attempt 关联；当前文档/API没有定义它。不得因找不到关联而扫描或修改核心 this.pending。

#### `#applyEvent` — OMP / progress / 紧接其前

```js
    if (message.type === "error" || message.type === "extension_error") {
```

**为什么是这里**：此时 message_update 的 delta/text 两条更新路径都已完成，可用更新后的 lastAssistantText 记录 charCount/tail；放在更新前会永远落后一条，挂到单一赋值语句后则会漏掉另一种 update 形状。调用必须以 `message.type === "message_update"` 且文本确有变化为 guard。

**风险**：OMP message_update 很热；当前 progress() 每次都进入普通有界写队列且不按路径合并，逐 token 插会挤爆队列并反过来使最终正文 queue_full。必须节流/合并，且不得 await。lastAssistantText 还受 clampText 限制，不能未经定义就当完整累计正文。

#### `#applyEvent` — OMP / settle / 紧接其后

```js
      this.turnEndedAt = nowIso();
```

**为什么是这里**：到这里已通过 unattributed-agent_end guard、已解析 endedInError，并且 turn_end 分支早已 return，所以只剩可归属的 agent_end。先对单个 ambiguous 调 adoptByTerminal，再对得到的/当前 dispatched attempt 调 settleOnce；随后才让核心清 turnInFlight 并置 idle。更早会把 turn_end 或外来 agent_end 当整轮结束，更晚则可能被状态观察者先看成 idle。

**风险**：OMP terminal 无 request id，abort 后迟到 agent_end 仍可能跨轮误归属；settleOnce 只能解决同 attempt 重复，不能解决跨 attempt 归属。另有 API 冲突：当前 settleOnce 立即接收 body，无法同时实现 PLAN 要求的 250ms 尾部宽限。

#### `abort` — OMP / settle / 紧接其后

```js
    await this.request("abort");
```

**为什么是这里**：只有 abort RPC 成功后才是精确 aborted 边界，而且此时核心尚未清 turnInFlight/turn clock。只对调用前已关联且 ledger 已 dispatched/adopted 的 attempt 调 settleOnce；idle abort 不得结算上一轮。

**风险**：abort 本身可在 idle 重复调用，也可能与 agent_end 同拍；必须在 await 前保存 observer 身份/状态，并依靠 ledger 幂等。abort RPC 不得注册成新的 prompt pendingRpc，否则其 ACK 会误触发 dispatch。

#### `start` — OMP / ambiguous / 紧接其后

```js
        setSessionStatus(this, "failed", false, { source: "stdin_error", error: err.message });
```

**为什么是这里**：在核心状态已转 failed、但 ready/pending promises 尚未 reject 前，按 session 批量删除 pendingRpc，并把仍处于 pre-ACK 的 prompt attempt 转 ambiguous。这里是终态短路，不直接 settle，也不碰 turnInFlight；已 dispatched 轮次交给 live reconciler，退出则由 close finalizer。

**风险**：X9：不要清 unresponsiveSince。stdin error 后通常还会跟 process close，清理必须幂等且只能作用于当前 session。observer 不能抛，否则会阻断核心 pending 拒绝。

#### `start` — OMP / ambiguous / 紧接其后

```js
      setSessionStatus(this, "failed", false, { source: "process_error", error: err.message });
```

**为什么是这里**：与 stdin error 同理：先让核心落到 failed，再在核心 pending.reject/clear 前清 observer 映射并将未 ACK prompt 标 ambiguous。process error 不证明 prompt 未被后端接受。

**风险**：可能随后再收到 process close；必须幂等。不清 turnInFlight，不调用 settleOnce，不触碰 unresponsiveSince。

#### `start` — OMP / ambiguous / 紧接其前

```js
      this.readyReject?.(new Error(this.lastError || "OMP RPC exited before ready."));
```

**为什么是这里**：正常非 `status === "closed"` 的 process close 到这里时，核心 closed/failed 状态已写完，但 pending 尚未拒绝；这是清理该 session 剩余 pendingRpc 的最后窗口。显式 close 的早退分支应由 close() 自己先清理。

**风险**：process error 与 process close 会连续触发，必须幂等。code 0 也不能把 pre-ACK attempt 当确定拒绝；不得清共享 unresponsiveSince。

#### `#markUnresponsive` — OMP / ambiguous / 紧接其后

```js
    setSessionStatus(this, "failed", false, { source: "rpc_timeout" });
```

**为什么是这里**：触发 #markUnresponsive 的那个 request 已在 timeout 点删除映射；这里负责按 session 清理其余并发 pendingRpc，将其中 prompt attempts 标 ambiguous，再让核心批量 reject pending。它仍是终态短路，不是精确 turn settlement。

**风险**：X9 最高风险点：silentMs 已从共享 unresponsiveSince 算出，插桩绝不能按 RPC 重置、复用或提前清它，也不能多次调用 #markUnresponsive。随后 process close 会再次走清理，必须幂等。

#### `close` — OMP / lifecycle / 紧接其后

```js
    setSessionStatus(this, "closed", false, { source: "close" });
```

**为什么是这里**：先把该 session 的 pendingRpc 转 ambiguous并删除，再同步调用 sessionClosed/finalizeSession；顺序不能反，否则 finalize 看不到刚转成 ambiguous 的 attempt。这里必须在核心 pending 拒绝和进程终止前完成，因为 cleanupAndExit 后没有下一拍。close 不清核心 turnInFlight；dispatched 被收为 abandoned，settling 复用原 promise。

**风险**：显式 close、cleanup close、随后 process close 会重入；必须按 session 幂等。只同步改 ledger，不等待正文/快照 I/O。X9：清 observer 映射不能顺手清 unresponsiveSince。

#### `state` — OMP / lifecycle / 紧接其后

```js
      setSessionStatus(this, streaming ? "running" : "idle", streaming, { source: "state" });
```

**为什么是这里**：这里只记录 session 状态/health/contextUsage；绝不生成 settle。源码确实可能在 turnInFlight 仍为 true 时把 status 改成 idle，因此真正判定必须复用 sessionSettled，而不能观察这个状态迁移。

**风险**：把此点当结算信号会在 pre-stream idle 或 OMP 陈旧 isStreaming 读数下提前收轮。状态 hook 不得清 active attempt 或 turnInFlight。

#### `setSessionStatus` — OMP / lifecycle / 紧接其后

```js
  session.updatedAt = nowIso();
```

**为什么是这里**：这是所有 OMP status 迁移的唯一漏斗。此时 status/isStreaming/updatedAt 都已更新，可现场重算 deriveHealth，再调用 recorder.sessionStatus；放在赋值前会记录旧状态，分散到各 handler 会漏 state()/ready/agent_start/agent_end。

**风险**：该函数在轮询中很热；recorder 必须自行判定无变化不发新 generation。不得 await、不得反调 setSessionStatus，也不得在这里做 turn settle。

#### `sessionSettled` — OMP / settle / 紧接其前

```js
  if (session.status === "failed" || session.status === "closed") return true;
```

**为什么是这里**：这是终态短路的语义锚：live reconciler 必须复用这一判据，而不是只看 status idle。failed/closed 即使 turnInFlight 未清也算可收口；live 状态则继续委托 OMP isSettled 的 `idle && !turnInFlight`。真正 outcome 仍须结合终态来源，不能只凭这个布尔值。

**风险**：该函数被高频、重复调用；若在这里直接做有副作用的 I/O，会造成重入和性能回归。最多调用同步幂等的 ledger reconciliation，且不能 await。

#### `serveMcp` — OMP / settle / 紧接其后

```js
  installProcessHandlers();
```

**为什么是这里**：若实现 PLAN 所说 live poller，应只在 MCP 服务路径启动，并复用 sessionSettled；不能挂在 import/doctor/cleanup，也不能只塞进 waitSessions——用户未调用 wait 时终态仍需被兜底。它负责把漏掉的正常 completion 或 failed/closed 终态映射到 settleOnce。

**风险**：X9：poller 只能读内存状态，不能为了观测调用 refreshStatus()/state()/request()，否则会新增 RPC timeout、改变 unresponsiveSince/dead/status。timer 要 unref，reconciliation 要幂等且不得 await recorder。

#### `cleanupAndExit` — OMP / lifecycle / 紧接其后

```js
  cleanupSessions({ removePidRecord: false });
```

**为什么是这里**：先让所有 OMP close hook 同步 finalize ledger，再立即 sealAndStop；若 seal 放在 cleanupSessions 前，sessionClosed/finalizer 会被封账挡掉；若等 process.exit/下一拍则永远不会执行。此处只封 ledger/停接新任务，不等待或强刷快照。

**风险**：只能是 O(1)、无 await、无同步大快照。当前还有 runCli().catch 与 process exit 的旁路，集成时必须保证它们不会绕过同一 seal 语义。

**该节点的 notes**

> 结论：文档对最关键的 dispatch 时序是对的；response 成功分支必须在 pending.resolve 前同步 dispatch。源码也确认 agent_end/abort 是精确边界，stdin error、process error/close、#markUnresponsive、close 都不清 turnInFlight，而 state() 会改 idle 但不清该 flag。
> 
> 文档/源码或文档/API 不一致：
> 1. PLAN 把“空 message”写在 sendMessage 入口，但当前 sendMessage 只检查字段是否存在；直接空字符串实际到 OMP send 的首行才拒绝，空 initial_prompt 则因 falsy 直接跳过。这一拒绝坐标已漂移。
> 2. PLAN 的 pendingRpc“五类出口”压缩了多个物理出口：源码实际至少是 response success、success:false、单 RPC timeout、stdin error、process error、process close、#markUnresponsive 批量清理、session close。尤其 #markUnresponsive 的剩余映射清理在 §4.1 清单中没有单独写出；stdin 的 close 事件目前只写日志，不是清理出口。
> 3. viz-writer 只有 `_ledger.pendingRpc` 原始 Map，没有安全的 register/take/drain 方法；disabled recorder 的 `_ledger` 还是 null。按 PLAN 直接接线会绕过 recorder 的“观测绝不影响桥”安全边界。
> 4. pendingRpc 在 ACK 后必须删除，但 firstBackendEvent/progress/agent_end/abort 仍需要 attemptId。当前 PLAN 与 recorder API 都没定义“session 当前 observer attempt”的承载或查询接口；只靠 pendingRpc 不够。
> 5. PLAN 一方面规定 stdin/process/#markUnresponsive 不做精确 settle、靠 poller；另一方面验收表要求这些路径 outcome=failed。当前源码没有 viz poller，而 VizRecorder.finalizeSession 会把仍 dispatched 的轮次收成 abandoned。若终态后马上退出，确实没有下一拍，failed 可能退化成 abandoned；文档缺少可执行的 reconciliation/outcome 规则。process close code=0 在核心还会落成 status=closed，进一步要求按 source 区分，不能只看 status。
> 6. PLAN S4 要求 OMP 在 agent_end 后宽限 250ms、硬顶 2s、零 RPC，以救回迟到 message_update；但当前 settleOnce(result) 必须立即拿到 body 并同步进入 settling，progress() 此后也不再接受更新。现 API 无法同时满足同步幂等结算与延迟正文抓取，需要两阶段正文 API/body supplier，或另设同步 claim 后异步完成的机制。
> 7. progress() 每次走普通有界 writer 队列且不按路径 coalesce；若直接挂在每条 OMP message_update 上，会有观测反压核心结果写入的风险。PLAN 没钉节流频率。
> 8. STATE 的 terminal_adopted 文案像“后到的后端终结事件”，但 finalizeSession 会把本地 session close 时唯一 ambiguous 也 adopt 后 abandoned；这是现有测试明确认可的行为，但证据语义仍建议文档明确。
> 
> X9 核查：unresponsiveSince 的核心写点只有构造初始化、#handleLine 对按时 response 清零、request timer 对静默期首次打点；#markUnresponsive 只读取它计算 silentMs。最高风险就是 response 插点、timeout 插点、各批量 pendingRpc drain、以及 live poller：绝不能按 RPC 清零、在迟到 response 上清零、或让 poller额外发 get_state RPC。success:false 也是按时 response，必须保留现有清零行为。
> 
> 不确定项：终态 failed 的 poller具体函数/周期、active attempt API、pendingRpc 复合 key 编码、OMP 250ms 正文两阶段接口目前都未在两份文档或 recorder API 中钉死，因此这里只能给可靠源码边界，不能声称这些接线细节已有唯一实现。
> 
> 已只读核验：上述每个 anchorStatement 在其 functionName 内出现恰好一次；未修改任何文件。工作树中 scripts/viz-writer.mjs 与 skills/agent-bridge/viz/STATE.md 原本就是 untracked，本次未触碰。
> 
> 

---

### scout-codex-claude（21 处）

#### `send` — codex / dispatch / immediately_before

```js
const startReqId = this.nextId;
```

**为什么是这里**：这是 `viz.attempt()`（记「打算发」，不分配 turnNo）的唯一正确位置：它在四道确定拒绝闸（message 空 / status closed / proc 死 / `already has a running turn`）**之后**、在 `turn/start` 真正下发**之前**。放在闸之前，PLAN §4 表里 #1#2 两类就必须「先建 attempt 再 reject」——多一次可见状态转移却零可观测收益（rejected 本来就永不公开）。放在 `#request` 之后就来不及了：同一次 stdout flush 可能在 await 恢复前就把 `turn/started`+deltas+`turn/completed` 全送到，那时 ledger 里还没有 attempt，事件无处暂存。attemptId 必须同时挂到局部变量（给 catch 与晚到 response 闭包用）和 session 字段（给 `#onNotification` 用，它没有 send() 的闭包）。

**风险**：session 级字段只有一个槽：`turn/start` 超时后 `this.turn` 被置 null、会话立刻可再 send，新 attempt 会覆盖上一个仍 ambiguous 的 id → 那个 attempt 只能等 close 时被 ledger 判 tooMany → unresolved + degraded。这是 STATE §设计内的降级，但要在实现里写明，别以为是 bug。另：`source` 目前无法区分 initial_prompt / send_message——openSession 和 send_message 走的是同一个 `send()`，`options` 里没有任何标记。

#### `#beginTurn` — codex / dispatch / immediately_after

```js
if (!this.turn || this.turn.begun) return;
```

**为什么是这里**：直接回答问题①：**本体确实已经幂等**（`turn.begun` 一次性闸，源码注释也明写 idempotent per turn），所以若要挂在这里，**必须挂 guard 之后**——挂之前会让 `turn/started` 与 send() 续体各触发一次 dispatch。**但我不建议挂这里**，两条硬理由：(a) `#beginTurn` 有两个调用者，函数体内**无法知道证据来源**，而 STATE §4.6 要求 `turn_start_ack` 与 `turn_started_notification` 按证据分开钉死；加参数就等于改签名、改两个调用点，收益还不如直接挂调用点。(b) 更致命：`turn/start` 超时后 `this.turn` 已被置 null，晚到的 `turn/started` 走到 `if (this.turn) this.#beginTurn(...)` 根本进不来，即使进来也被 `!this.turn` 挡住 → **问题③要求的「晚到通知认领 ambiguous」在这里结构上不可达**。

**风险**：若仍选择挂这里：boundary 只能写死一个值（必然与证据不符），且 recorder 的 `dispatch()` 对已 dispatched 的 attempt 返回 null（`acceptOrAdopt` 早退回裸 attempt，`dispatch` 取 `.attempt` 得 undefined），二次调用是静默 no-op——好处是不会覆盖 boundary，坏处是错误的 boundary 一旦先写进去就永久固化。

#### `send` — codex / dispatch / immediately_after

```js
this.#beginTurn(startedTurnId);
```

**为什么是这里**：`turn/start` 成功 response 的续体——协议级证据，boundary = `turn_start_ack`，同时 `backendTurnId: startedTurnId`（codex 的 `lastTurnId` 就是它，`collected()` 靠这个 id 反查 attempt，不绑就永远收不了口）。挂在 `#beginTurn` **之后**而不是之前：`#beginTurn` 才是桥认定「这一轮开始了」的时刻（它重置 finalAnswer/lastAssistantText 并 commit `_requestedSchema`），在它之前 dispatch 会让 viz 的 dispatchedAt 早于桥自己的 turnStartedAt，两个时钟对不上。**换个位置会错在哪**：挂在 `await withTimeout(...)` 之前 = 把超时也当成已派发，直接抹掉 STATE 要保留的歧义；挂在 `options.wait` 分支里 = 非阻塞 send 永远不产生轮次。谁先跑谁定 boundary（同 flush 时 `turn/started` 会先到并写 `turn_started_notification`），这正是证据强度的如实记录。

**风险**：这里是 await 恢复后的异步续体，同一 flush 的 deltas/terminal 可能已先行到达；recorder 已按「终结先于 ACK → 暂存 buffered → dispatch 时归并」处理，所以顺序倒置不会丢轮次——前提是 settle 钩子调的是 `settleOnce()` 而不是自己拼状态。

#### `send` — codex / dispatch / immediately_before

```js
if (myTurn.settled.err && !this._requestedSchema) throw myTurn.settled.err;
```

**为什么是这里**：**这一支不补钩子就会漏掉整轮**。`this.turn !== myTurn && myTurn.settled` = response 和整个 turn 生命周期在同一 flush 里跑完。常态下 `turn/started` 已经 dispatch 过，这里是 no-op；但只要 app-server 那一轮**没发 `turn/started`**（或它被 staleTurn 挡掉），`#settleTurn` 的钩子只会把 terminal **暂存**在一个仍是 `attempted` 的 attempt 上（recorder 明确不在 attempted 上 settle，那会造无 turnNo 的幽灵轮次），而本分支在到达上面那个 ack 钩子之前就 `return` 了 → 缓冲的终结永远不归并 → **一轮既不出现也不结算**。这里我们手上正握着一个成功的 `turn/start` response，所以 boundary 如实是 `turn_start_ack`；dispatch 会立刻把 buffered.terminal 归并并触发 settle。

**风险**：重复 dispatch 是安全 no-op；但 boundary 若在这里写成 `terminal_adopted` 就直接违反 STATE §4.6 的禁令（我们有 ACK，不是「纯靠后到终结事件认领」）。

#### `send` — codex / dispatch / immediately_before

```js
return { accepted: false, sessionId: this.id, status: this.status, turnId: startedTurnId };
```

**为什么是这里**：同上的镜像分支：abort()/close() 在 `turn/start` 在途时抢走了 turn，续体拿到成功 response 后主动 interrupt。与上一支一样，若不在这里 dispatch，attempt 会停在 `attempted`（abort 钩子的 settleOnce 只会 buffer），整轮不可见。证据仍是成功 response → `turn_start_ack`，随后按实际结局 settle（`aborted`）。

**风险**：`startedTurnId` 可能为 null（成功但无 turn id）——此时仍应 dispatch（我们确实收到成功 response），只是 `backendTurnId` 留 null，`collected()` 也就查不到它；这轮注定只有 `abandoned/aborted` 结局，可接受。另：与 abort() 钩子有先后竞争，两边都必须走 `settleOnce()` 才能靠 ledger 状态去重。

#### `#onNotification` — codex / dispatch / immediately_after

```js
this.currentTurnId = params.turn?.id || this.currentTurnId;
```

**为什么是这里**：问题③的后半：**晚到的 `turn/started` 通知认领超时 attempt，boundary 必须是 `turn_started_notification`**。关键在于位置要落在 `if (this.turn) this.#beginTurn(...)` 这道 guard **之外**——这一行是 `turn/started` case 里唯一无条件执行的语句。超时后 `this.turn === null`，而 `staleTurn` 判据里 `this.currentTurnId` 也是 null（上一轮 `#settleTurn` 清过）、`ignoredTurnIds` 尚未包含该 id（晚到 response 还没来），所以 case 体确实会执行到这一行——这是晚到通知唯一能被观测到的点。一次 `viz.dispatch(attemptId, {boundary:"turn_started_notification", backendTurnId: params.turn?.id})` 同时覆盖两种形态：正常在途 attempt（`attempted`→dispatched）与超时 attempt（`ambiguous`→dispatched），因为 `acceptOrAdopt` 两种入态都收。**绝不能改用 `adoptByTerminal()`**——那个 API 把 boundary 写死成 `terminal_adopted`，而我们这里有协议级通知作证据。

**风险**：attemptId 必须从 session 字段取（通知处理器没有 send() 的闭包）；多个 ambiguous 并存时该字段只指向最后一个，会认领错——需按「同 session 只允许一个待认领」自律，或在 catch 里发现已有 ambiguous 时主动放弃认领。若晚到 response 先于通知到达，`#ignoreTurn` 会让本通知变 staleTurn 提前 return，认领改由 response 侧完成——两条路互斥，谁先到谁定 boundary，正确。

#### `send` — codex / ambiguous / immediately_after

```js
if (this.pending.has(startReqId)) {
```

**为什么是这里**：问题②的答案：**明确 error 与超时确实共用这一个 catch**（`withTimeout` 只 `reject(new Error(message))`，是个裸 Error，没有任何 timeout 标记），所以绝不能匹配 `err.message`。但**结构化判据已经在源码里，而且桥自己正在用**：`this.pending.has(startReqId)`。三条入 catch 的路径各自留下不同的结构痕迹——(a) 明确 error response：`#handleLine` 先 `this.pending.delete(msg.id)` 再 reject（且 err 带 `rpc` 属性）→ has=false；(b) `#write` 抛（stdin 已死）：`#request` 的 catch 里 `this.pending.delete(id)` → has=false；(c) **超时**：没有任何人删过它 → has=true。所以在这个 `if` 体内（即桥安装「晚到 response 拦截器」的同一处）标 `viz.ambiguous(attemptId, err)` 并把 attemptId 存进 session 字段，判据与桥的拦截判据**共用同一个表达式，结构上不可能漂**。挂在别处（比如 catch 开头按 err 文本分流）就是 PLAN 明令禁止的字符串匹配。

**风险**：顺序敏感：必须在这个 `if` 体内、且**不要动** `this.pending` 的内容；若把 viz 判据写成独立的第二次 `has()` 调用并放到替换 handler 之后，读到的就是替换后的条目（仍是 true，暂时无害，但语义已换主），后人改动时极易走样。另注意：路径 (b) 会被判成 rejected——正确（字节根本没进管道）。

#### `send` — codex / reject / immediately_before

```js
throw err instanceof Error ? err : new Error(this.lastError);
```

**为什么是这里**：上一条的 else 侧：`this.pending.has(startReqId) === false` ⟹ 后端给了明确 error response，或 stdin 写失败——两者都**确定没有一轮在跑**，按 STATE 走 `viz.reject(attemptId, err)`，立即销毁、不产生 turnNo、不发任何公开状态。放在这条 throw 之前是因为它是该 catch 唯一出口，前面 `if (this.turn === myTurn)` 的清理不影响判据。**换成在 catch 开头一律 reject 会错在哪**：把超时也做成「确定没跑」，恰好抹掉源码注释里那句「the app-server may yet return a turn id and run that turn untracked」——那正是 ambiguous 这一档存在的全部意义。

**风险**：`reject()` 只接受 `state === "attempted"`；若此前 `#rejectAll`（进程崩）已经给该 attempt 暂存过 terminal，state 仍是 attempted，reject 照常生效并连 buffered 一起销毁——正确。但如果实现里不小心先调了 dispatch，reject 就会静默失败，留下一个永不结算的公开轮次。

#### `send` — codex / dispatch / immediately_before

```js
this.#ignoreTurn(lateId);
```

**为什么是这里**：问题③的前半：**晚到的成功 response 认领超时 attempt，boundary = `turn_start_ack`**（我们拿到的是 `turn/start` 的成功 response，协议级证据，**不是** `terminal_adopted`）。这个替换 handler 是闭包，天然握着 send() 的 attemptId，不需要 session 字段。位置选在 `#ignoreTurn(lateId)` 之前只是为了在「桥决定忽略这一轮」之前先把它记进账；之后紧接着桥会发 `turn/interrupt`，而该 turn 的所有后续通知都会被 `ignoredTurnIds` 判 stale → **永远不会有终结事件来 settle 它**，所以这里 dispatch 之后必须**紧接着**用 `settleOnce(attemptId, {outcome:"aborted", body:null, bodyKind:"none"})` 主动收口，否则这一轮会一直挂在 `dispatched` 直到会话关闭才被合成 abandoned。

**风险**：`lateId` 为空（成功 response 但无 turn id）时本分支整个不执行 → attempt 永远停在 ambiguous → 关会话时被 `finalizeSession` 以 `terminal_adopted` 收成 abandoned。这是 recorder 的 API 缺口（没有「把 ambiguous 判成从未发生」的出口），见 notes。

#### `#settleTurn` — codex / settle / immediately_before

```js
turn.settled = { err: err || null, status: status ?? null };
```

**为什么是这里**：CodexAppServerSession 的 `#settleTurn`。问题⑤：**本体幂等已证实**——`const turn = this.turn; if (!turn) return;`，且它立刻 `this.turn = null`，重复/迟到的 `turn/completed`、`error` 都会在 guard 上早退。钩子挂 guard **之后**（即这一行之前，两者之间只隔一段注释），理由有二：(1) guard 之前会给已经结束的轮次再触发一次 settle；(2) **更重要的是正文口径**——canonical 正文是 `result()` 用的三级 fallback `this.finalAnswer || this.lastAgentMessage || this.lastAssistantText || ""`，而本函数第 3299 行成功分支会执行 `this.lastAssistantText = clampText(...)`，`clampText` 是**保尾截头**（`slice(value.length - max)`）。挂在函数末尾或 resolve 之后再读，只要 finalAnswer/lastAgentMessage 为空（纯 delta 流、没有 item/completed 的轮次），拿到的就是被砍掉开头的残件，而快照里还会照常算 sha256 宣称「这就是记录里的那一份」。所以必须在这一行之前**同步抓正文**，用三级 fallback 原样取，不要读 clamp 后的值。outcome 映射：`err` 为空 → completed；否则 failed（`status === "interrupted"` 时 err 也为空，按 completed 或按 aborted 由实现定，见 notes）。

**风险**：`#settleTurn` 可从 readline 同步回调直接进入，所以钩子必须是**纯同步**的 `settleOnce()`（recorder 已保证 `dispatched → settling` 同步转移，await 一律在其后）；插任何 await 就等于交出唯一护栏。另：此时 attempt 可能仍是 `attempted`（`turn/started` 缺失的极端情形），`settleOnce` 会 buffer 而不是 settle——这正是上面两条 send() 补丁存在的理由。

#### `abort` — codex / settle / immediately_before

```js
turn?.resolve?.();
```

**为什么是这里**：**codex 的 abort 完全绕过 `#settleTurn`**——源码自己在第 3496 行注释里写死了这件事（"abort() nulls this.turn and bypasses #settleTurn — T9"）：它手动 `const turn = this.turn; this.turn = null;` 然后 `turn?.resolve?.()`。所以 PLAN §2.2「class A：Codex/Claude 挂 `#settleTurn` 即可」对 codex **不成立**：只挂那一处，任何被 abort 的轮次都会永远停在 `dispatched`，直到关会话才被合成 `abandoned`，页面上就是「用户明明中断了，却显示为被遗弃」。挂在 `turn?.resolve?.()` 之前，是为了让 viz 的收口先于 send() 续体恢复（续体可能立刻走 `result()` → 收口面 `collected`），outcome = `aborted`，正文取三级 fallback（通常是部分文本 → bodyKind `partial`，空则 `none`）。

**风险**：abort() 里 `this.turn` 可能本来就是 null（idle 时 abort）——此时 attempt 早已 settled，`settleOnce` 走 ledger 状态早退，无副作用。与 send() 的「被抢走的 turn」分支存在时序交叉：两边都调 `settleOnce()`，靠 ledger 去重，**不要**任何一边自己判 `if (已 settled)`。

#### `#rejectAll` — codex / settle / immediately_before

```js
for (const pending of this.pending.values()) pending.reject(err);
```

**为什么是这里**：第三条绕过 `#settleTurn` 的路径：stdin error / proc error / proc close / `close()` 四个入口全汇到 `#rejectAll`，它同样是手动 `this.turn = null` + `turn?.reject?.(err)`。不挂这里，后端进程崩掉时在途轮次就没有任何结算信号（桥不会再有别的事件），只能等关会话兜底。挂在这一行**之前**是因为此刻 `this.turn` 尚未被清、`turnEndedAt` 刚补完，状态最完整。outcome = `failed`，error = err.message，正文取三级 fallback（多半是部分流式文本 → `partial`）。

**风险**：`close()` 也走这条路（`#rejectAll(new Error("session closed"))`），会把一次正常关闭记成 `failed`。**处置办法不是按 err.message 文本分流**（这仓库明令禁止），而是让 `close()` 的 `sessionClosed` 钩子排在 `#rejectAll` 之前——见下面 close() 那条：`finalizeSession` 会先把该轮收成 `abandoned`，随后 `#rejectAll` 的 `settleOnce` 因 ledger 已非 dispatched 而自然早退。顺序是唯一判据，别加第二个真理源。

#### `#onNotification` — codex / progress / immediately_after

```js
if (typeof params.delta === "string") this.lastAssistantText = clampText(this.lastAssistantText + params.delta);
```

**为什么是这里**：codex 唯一的流式正文累加点，且已过 `staleTurn` 闸（被忽略轮次的尾巴不会污染当前轮）。这里同时喂两件事：`firstBackendEvent(attemptId)`（诊断字段，区分「已派发但完全沉默」与「已开始输出」）和 `progress(attemptId, {charCount, tail})`。**不要**改用 `#handleLine` 里的 `this.updatedAt = nowIso();` 当 firstBackendEvent 漏斗——那一行对 `turn/start` 的 response 行本身也会触发，等于把 ACK 当成「后端已开始输出」，恰好毁掉这个字段唯一的用处。`generationCount`（第 N 稿）建议在 `item/completed` 的 `if (item.phase === "final_answer") this.finalAnswer = item.text;` 处 +1。

**风险**：⚠️ **recorder 的 `progress()` 每调一次就入队一次文件写，内部零节流**，而 delta 是每 token 级频率；直接挂会瞬间打满 `MAX_PENDING_JOBS=64` → `queue_full` → `run.degraded=true` + `recordingErrors`，把一个健康会话报成「记录不完整」。**必须在桥侧节流**（如距上次 ≥250ms 才写，并在 settle 前补最后一次）。另：`lastAssistantText` 已被 `clampText` 保尾截头，`charCount` 若取它的 `.length` 在超长轮次会失真——尾巴本来就只要末 400 code unit，但 charCount 要如实说明它是「已 clamp 的长度」还是累计长度，两者别混。

#### `close` — codex / lifecycle / immediately_before

```js
setSessionStatus(this, "closed", false, { source: "close" });
```

**为什么是这里**：CodexAppServerSession.close()。放在**第一行之前**是刻意的：`sessionClosed()` 内部会调 `finalizeSession()`，把仍是 `dispatched` 的轮次收成 `abandoned`、把单个可认领的 ambiguous 先 adopt 再收口；只有排在 `#rejectAll` 之前，这个语义才拿得到，否则 `#rejectAll` 的钩子会抢先把它写成 `failed("session closed")`。**用先后顺序而不是错误文本来区分「关会话」与「后端崩了」**，是这两个钩子能共存的唯一干净办法。

**风险**：open 失败路径会先 close 再 `sessionOpenFailed`，recorder 已用 `suppressClosed` 定死优先级，这里不需要额外判断。若将来有人把 `close()` 的钩子挪到函数末尾，`#rejectAll` 就会反超，页面上所有正常关闭都变成 failed——这是个纯顺序依赖，值得在代码里写一行注释钉住。

#### `send` — claude / dispatch / immediately_after

```js
const turnId = `${this.id}-t${this.turnCount + 1}`;
```

**为什么是这里**：ClaudeCodeSession 的 `viz.attempt()` 位置：同样在三道确定拒绝闸（closed / proc 死 / busy）之后、真正写 stdin 之前。挂在 turnId 之后是为了让 attempt 一开始就能带上这个 id（claude 的 `lastTurn.id` 就是这个桥自造的字符串，`collected()` 反查靠它）。挂在 `#writeUser` 之后就晚了——写失败那一支要 `reject`，得先有 attempt 才有东西可 reject。

**风险**：`turnId` 是**桥自造**的 `${id}-t${turnCount+1}`，而 `turnCount` 只在 `#settleTurn` 里 +1；`#failTurn`（stdin error / proc error / proc close）清掉 turn 时**不加**，且 `send()` 并不拒绝 `status === "failed"` 的会话，所以理论上同一 turnId 可被复用两次 → `byBackendTurnId` 被后者覆盖，前一轮的 `collected` 静默丢失。概率低，但表现出来会被当成 viz 的 bug，值得在实现里显式判重。

#### `send` — claude / reject / immediately_after

```js
const e = err instanceof Error ? err : new Error(String(err));
```

**为什么是这里**：`#writeUser` 只在 stdin 已死时抛（`#write` 的三重判据：无 stdin / destroyed / exitCode 或 signalCode 非 null），**字节从未进管道**，源码注释也明写「The message never reached claude, so no turn actually started」——这是 PLAN §4 表里 #5 那类**确定拒绝**，`viz.reject(attemptId, e)` 立即销毁。这里不需要任何 timeout/ambiguous 之分：claude 侧没有「可能已经在跑」的第三态，因为判据是同步的进程存活，不是等待。

**风险**：必须挂在 `if (this.turn === myTurn)` 这段清理里或它之前，别挂到 `throw e;` 之后（够不到）。若误用 `ambiguous`，这一轮会一直挂在 ledger 上等一个永不会来的终结事件，关会话时才被 adopt 成 `terminal_adopted`+abandoned——凭空造出一条「派发过」的假记录。

#### `send` — claude / dispatch / immediately_after

```js
this.#beginTurn(turnId);
```

**为什么是这里**：问题④的答案：**`#write` 确实是无 callback 的裸 `stdin.write`**（`stdin.write(...)` 返回值都没接，背压未处理，没有 write callback，没有 flush 确认），所以这里能证明的**只有「字节交给了 Node/OS 管道」**——boundary 必须是 `pipe_enqueued`，页面只能写「已派发，等待后端输出」，**不能写「后端已接受」**。claude 全程没有任何协议级 ACK（stdout 在首条用户消息前完全沉默，源码注释明说「No stdout handshake」），所以不存在更强证据可等。挂在 `#beginTurn` 之后而不是 `#writeUser` 之后：`#beginTurn` 是桥认定「turn 已开始」的点，它之前的 catch 分支专门保证「写失败不污染上一轮」；夹在两者中间 dispatch 会让 viz 的时间戳早于桥的 turnStartedAt。**换到 `options.wait` 分支里会错在哪**：非阻塞 send 就永远不产生轮次。

**风险**：claude 的 `#beginTurn` **本体不幂等**（无 `begun` 闸，无条件重置 currentTurnId/turnStartedAt/finalAnswer），与 codex 不同——但它只有这一个调用点，所以不构成问题；不要照抄 codex 的「guard 之后」直觉去找 guard，这里没有。真正的风险是 `pipe_enqueued` 被后续实现者「顺手升级」成更强的 boundary：管道满时 `stdin.write` 返回 false 而代码照常往下走，字节可能仍在 Node 的内部缓冲里。

#### `#settleTurn` — claude / settle / immediately_before

```js
turn.settled = { err: err || null, status: status ?? null };
```

**为什么是这里**：ClaudeCodeSession 的 `#settleTurn`。问题⑤：**本体幂等**，同样是 `const turn = this.turn; if (!turn) return;` + 立刻 `this.turn = null`，钩子挂 guard 之后（即这一行之前）。claude 这边它的覆盖面比 codex 好：正常完成、`is_error`/非 success、interrupt 后的 `result`、abort 的强制收口（`this.#settleTurn(null, "aborted")`）**四条路全从这里过**，所以 abort() 不需要单独钩子。正文 canonical 源 = `result()` 用的 `this.finalAnswer || this.lastAssistantText || ""`（两级，不是 codex 的三级）；`#handleResult` 在调用本函数**之前**就已经把 `finalAnswer = text` 写好，而本函数自身不碰任何文本累加器，所以在这里读是准确的。outcome 由 `status` 决定：`"aborted"` → aborted；`err` 非空 → failed；否则 completed。

**风险**：`lastAssistantText` 经 `clampText` 保尾截头，只有在 finalAnswer 为空（失败/中断轮次）时才会被用到——此时正文本来就是残件，`bodyKind` 必须如实是 `partial` 而不是 `final`，否则 STATE §4.9 的 `failed × final` 非法组合就会被生产出来。另：被 `pendingAbortedResults` 吞掉的迟到 result 根本不进这里（`#handleResult` 提前 return），正确——那一轮早已 settle 过。

#### `#failTurn` — claude / settle / immediately_before

```js
for (const p of this.controlPending.values()) p.reject(err);
```

**为什么是这里**：claude 版的 `#rejectAll`：stdin error / proc error / proc close / `close()` 四处都调它，而它**不走 `#settleTurn`**（手动 `const turn = this.turn; this.turn = null; turn?.reject?.(err)`，不 bump turnCount、不 stamp turnEndedAt）。所以 PLAN §2.2「class A：`#settleTurn` 是结算边界」对 claude 也只覆盖了正常路径，进程崩掉的在途轮次没有任何结算信号。挂在这一行之前，此刻 `this.turn` 仍在、`turnEndedAt` 刚补完。outcome = `failed`。

**风险**：与 codex `#rejectAll` 同形：`close()` 也走这里，靠「close 的 lifecycle 钩子排在前面」来让 `abandoned` 先落定，**不要**按 err.message 分流。另：`#failTurn` 也会在完全没有 turn 时被调用（start() 的错误处理器），`settleOnce` 对不存在的 attemptId 直接早退，无副作用。

#### `#handleLine` — claude / progress / immediately_after

```js
if (text) this.lastAssistantText = clampText(text);
```

**为什么是这里**：claude 的正文观测点。这里同时喂 `firstBackendEvent(attemptId)` 与 `progress(...)`：assistant 消息是第一个能证明「后端真的在干活」的信号（`system/init` 只证明进程起来了）。**不要**挂到 `#handleLine` 顶部的 `this.updatedAt = nowIso();`——那对 `control_response`、`system` 等非产出行也触发。`generationCount`（第 N 稿）在这里 +1 是最自然的口径：每条 assistant 消息 = 一次真实 API 调用。

**风险**：⚠️ **口径差异**：claude 的 assistant 消息带的是**整段文本**，这一行是 `= clampText(text)` **覆盖**，不是 codex 那样的 `+= delta` **累加**。所以直接拿 `lastAssistantText.length` 当 `charCount`，语义是「最后一条 assistant 消息的长度」，不是「本轮累计产出」——两家后端会各写各的，页面上同一个进度条会表达两个意思。要么在桥侧另存累计计数，要么在 STATE 里把 `charCount` 明确定义成「当前尾巴所属片段的长度」。另：同 codex，`progress()` 无内置节流，必须桥侧限频。

#### `close` — claude / lifecycle / immediately_before

```js
setSessionStatus(this, "closed", false, { source: "close" });
```

**为什么是这里**：与 codex close() 完全同形：必须排在 `this.#failTurn(new Error("session closed"))` **之前**，`sessionClosed()` → `finalizeSession()` 才能把在途轮次收成 `abandoned`，而不是被 `#failTurn` 抢先写成 `failed("session closed")`。这是两个结算钩子共存的唯一无字符串判据。

**风险**：同 codex：纯顺序依赖，挪到函数末尾就会静默反转语义。close() 里还有 `this.pendingAbortedResults = 0;`——若之后还有迟到 result 到来，`#handleResult` 会当成真结果处理，但那时 `this.turn` 已 null，`#settleTurn` guard 早退，viz 不受影响。

**该节点的 notes**

> 【与两份文档不一致的地方，按重要性排序】
> 
> (1) **PLAN §2.2「class A：Codex/Claude/Cursor/Kimi 四个 `#settleTurn` 本体都幂等，钩子挂 guard 之后」——幂等这半句我逐字核实成立，但「`#settleTurn` 是结算边界」这半句对 codex/claude 都不完整。** codex 有三条绕过它的路：`abort()`（源码第 3496 行注释自己写死「abort() nulls this.turn and bypasses #settleTurn — T9」）、`#rejectAll`（stdin/proc error/proc close/close 四入口）；claude 有一条：`#failTurn`（同样四入口）。只挂 `#settleTurn`，被中断的轮次和后端崩溃时的在途轮次都会永远停在 `dispatched`，只能等关会话被合成 `abandoned`。上面为此补了三个 settle 站点。
> 
> (2) **PLAN §2.1「Codex 的 dispatch 挂 `#beginTurn`」在两个方向上都不可行。** 一是 `#beginTurn` 有两个调用者却无法区分证据来源，而 STATE §4.6 要求 `turn_start_ack` 与 `turn_started_notification` 严格分开；二是 `turn/start` 超时后 `this.turn` 已置 null，`#beginTurn` 的第一道 guard 就把晚到的 `turn/started` 挡在门外——PLAN §4 规则 6 要求的「晚到通知认领超时 attempt」在 `#beginTurn` 里**结构上不可达**。必须改挂两个调用点 + `turn/started` case 里那行无条件的 `this.currentTurnId = ...`。
> 
> (3) **PLAN §4 规则 4 说「Codex 明确 error 与超时共用同一 catch，必须由 viz 侧携带结构化 timeout 标记」——共用 catch 属实（`withTimeout` 只 reject 一个裸 `new Error(message)`，无任何 tag），但结论可以更省：判据已经存在，就是 `this.pending.has(startReqId)`，而且桥自己正拿它决定要不要装晚到 response 拦截器。** 三条路径的结构痕迹互不重叠：明确 error → `#handleLine` 先 delete（且 err 带 `rpc` 属性）；`#write` 抛（stdin 死）→ `#request` catch 里 delete；超时 → 无人 delete。所以不需要新增任何标记或改 `withTimeout`，只要把 viz 的分流写进那个**已有的 `if`**，判据就与桥共用同一个表达式、结构上不可能漂。顺带：**该 catch 里其实有三类而不是两类**，PLAN 只列了「明确 error」与「超时」，漏了 stdin 写失败（它属于确定拒绝，字节根本没进管道）。
> 
> (4) **STATE §4.6 把 `pipe_enqueued` 描述成「Claude：裸 stdin.write」——属实，但 codex 的 `#write` 是**同一份代码形状**（同样是无 callback 的 `stdin.write`，返回值都不接）。** codex 之所以配得上 `turn_start_ack`，靠的完全是之后那个 JSON-RPC response，不是传输层更强。实现者别据此以为 codex 的写是「确认过的写」。
> 
> (5) **`recordingErrors` 与队列的一个实操陷阱：`viz-writer.mjs` 的 `progress()` 每调一次就 `enqueue` 一次文件写，内部零节流**，而 codex 的 `item/agentMessage/delta` 是每 token 级频率。直接挂会打满 `MAX_PENDING_JOBS = 64` → `queue_full` → `run.degraded = true`，把健康会话报成「本次记录不完整」。STATE §2.3 只说了「400 字尾巴走 sidecar 不进全量快照」，没说**写 sidecar 本身也要限频**。必须在桥侧节流。
> 
> (6) **两家的 `charCount` 口径天生不同**：codex 是 `lastAssistantText += delta` 累加，claude 是 `lastAssistantText = clampText(text)` 整条覆盖。同一个字段在两个后端表达两件事，STATE §5 没有定死。
> 
> (7) **正文 canonical 源的实测**：codex 是三级 `this.finalAnswer || this.lastAgentMessage || this.lastAssistantText || ""`（`result()` 里的原话），claude 是两级 `this.finalAnswer || this.lastAssistantText || ""`。⚠️ codex 的 `#settleTurn` 成功分支会执行 `this.lastAssistantText = clampText(...)`，而 `clampText` 是**保尾截头**（`slice(value.length - max)`）——所以正文必须在那一行**之前**抓，否则纯 delta 流的轮次会得到一个被砍掉开头的残件，而快照还会照常给它算 sha256、宣称「这就是记录里的那一份」。
> 
> 【我不确定 / 需要拍板的点】
> 
> (a) **`collected()` 与 `settleOnce()` 之间有一个真实竞态。** recorder 的 `collected()` 要求 `a.state === "settled"`，但 `settleOnce()` 只同步把状态推到 `settling`，要等正文文件写的 `onDone` 回调才变 `settled`（真实磁盘 I/O，毫秒级）。而 `send(wait:true)` / `wait` 的收口在 `callTool` 层，很可能先跑完 → `collected` 被**静默丢弃**，页面上永远显示「未取走」。要么让收口点 await 那个 settle Promise，要么让 recorder 在 `settling` 上缓冲 collection。这处在 `callTool`（超出我这次的 codex/claude 范围），但根因在这两家的 settle 站点，先记下来。
> 
> (b) **recorder 缺一个「把 ambiguous 判成从未发生」的出口。** `reject()` 只收 `state === "attempted"`。codex 晚到 response 但 `result.turn.id` 为空（后端明确说「我没起 turn」）时，attempt 只能一直挂着，等关会话被 `finalizeSession` 以 `terminal_adopted` 收成 abandoned——凭空多出一条「派发过」的记录。是补 API 还是接受这个降级，需要拍板。
> 
> (c) **`adoptByTerminal(sessionId)` 把 boundary 写死成 `terminal_adopted`**，而 codex 的两处认领必须是 `turn_start_ack` / `turn_started_notification`，所以只能走 `dispatch(attemptId, {boundary})`；但这要求桥自己记住那个 ambiguous 的 attemptId（recorder 没有公开「哪个可认领」的查询，`claimableAmbiguous` 在 `_ledger` 内部）。session 上只有一个槽 → 超时后再 send 会覆盖，旧的只能等 tooMany → unresolved + degraded。是否要在桥侧存成数组，取决于你们认不认这个降级。
> 
> (d) **`source: "initial_prompt" | "send_message"` 现在无法区分**：openSession 的首轮和后续 send_message 走的是同一个 `send()`，`options` 里没有任何标记。要么给 `send(options)` 加一个 viz-only 字段，要么这个字段在 codex/claude 上恒为 `send_message`。
> 
> (e) **codex `turn/completed` 且 `status === "interrupted"` 时 `err` 为 null**（源码把 interrupted 当成功分支），所以在 `#settleTurn` 里只看 `err` 会把它记成 `completed`。是否要按 `status` 单独映射成 `aborted`，我倾向要，但这属于口径选择，不是源码事实。
> 
> (f) 我只读了源码，**没有实际运行验证**「晚到 `turn/started` 通知在超时后确实能走到 `this.currentTurnId = params.turn?.id || this.currentTurnId;`」这条路径。我按 staleTurn 判据推演成立（`ignoredTurnIds` 尚未含该 id、`this.currentTurnId` 已被上一轮 `#settleTurn` 清成 null），但这依赖「上一轮是正常 settle 的」这个前提；如果上一轮是被 abort 的，`currentTurnId` 也被清了，结论不变——不过这条值得用 repro 实测钉一次。

---

### scout-cursor-kimi-lifecycle（32 处）

#### `CursorAgentSession.send` — cursor / dispatch / 紧接其后

```js
const myTurn = this.turn;
```

**为什么是这里**：这是 attempt() 的落点（不是 dispatch）。此刻三道拒绝闸（空 message / this.turn 已占 / this.proc 未死 / 无 chatId）已全部通过，turn 已被**同步**占住，`myTurn` 已固化——攻击面最小的一刻。放更早（send 第一行）会给「已被 busy 闸拒掉」的调用也造 attempt，那类调用在 PLAN §4 里属于 rejected，造了又立刻销毁是纯噪音；放更晚（compose/spawn 之后）则 `releaseUnbegun` 覆盖的三条前置失败路径就没有 attempt 可 reject，spawn 失败在台账上会**完全不存在**，而 STATE §4.6 的 reject 档正是为它们设的。也必须早于 `const releaseUnbegun = err => {`（闭包要引用 attemptId，否则 TDZ）。同时在这里把 id 存到 `this.vizAttemptId`，`#handleLine`/`#settleTurn` 才拿得到（它们看不见 send 的局部变量）。

**风险**：新增实例字段 `this.vizAttemptId`：已核实全仓无 `...session` / `Object.keys(session)` / `JSON.stringify(session)`，`summary()` 是逐字段白名单，退出日志也是显式取字段，所以不会漏进任何对外形状。`attempt()` 过了 `#safe`、纯同步、无 IO，返回 null（会话不在 ledger）时后续所有调用都 no-op——但要记得 `viz?.` 空守，模块顶层 recorder 可能是 null。

#### `CursorAgentSession.send 内的 releaseUnbegun` — cursor / reject / 紧接其后

```js
const releaseUnbegun = err => {
```

**为什么是这里**：cursor 全部「确定拒绝」都收敛在这一个闭包上，共三条调用路径：①`resolveCursorLauncher()`/`#buildTurnArgs`/`#assertCmdlineWithinLimit` 抛（NUL、命令行超 24K）；②`spawn()` **同步**抛（E2BIG）；③`if (!child) { releaseUnbegun(lastErr ...) }`（含 ENOENT 重试耗尽）。三条的共同事实是**没有任何进程跑起来过**，所以是 STATE §4.6 意义上的确定拒绝而非歧义——挂在这里，判据是结构化的控制流，不需要匹配 err.message（PLAN §4 规则 4 的硬要求）。若改为在三个 throw 点各挂一次，就是一张会漏的清单（这个仓库反复栽的形状）；若挂在 send 的外层 try/catch，会把「已 begun 之后 wait 超时」那类也吞进来，把一个真实运行过的轮次说成从未派发。

**风险**：必须**无条件**调用 `reject()`，不能塞进闭包里那个 `if (this.turn === myTurn)`——抢跑关闭时该分支不执行，attempt 就会永远挂在 ledger 的 `attempted` 态（finalizeSession 只回收 dispatched/ambiguous，见 notes D12）。`reject()` 同步、非抛、且**不 markDirty**（它从未公开过），所以对桥零影响；唯一要防的是漏了 `viz?.`。

#### `CursorAgentSession.send` — cursor / ambiguous / 紧接其后

```js
if (this.status === "closed" || this.turn !== myTurn) {
```

**为什么是这里**：这是**唯一**一条「进程确实起来了（spawn 事件已 resolve），但桥故意不 begin 这一轮」的路径——流水线化的 close() 在 spawn-await 窗口里抢跑。它既不能记 reject（cursor 的 prompt 是发往云端 chat 的，子进程可能在被 SIGKILL 之前就已经把这一轮提交给了服务端，说「确定拒绝」是假话），也不能记 dispatch（桥没 begin，`#onChildClose` 因 `this.turnChild !== child` 直接 return，永远不会有结算事件来收它，公开出去就是一个永挂 dispatched 的幽灵轮次）。ambiguous 正是为「不要把『后端可能仍在跑』抹掉」设的那一档，随后由 sessionClosed→finalizeSession 单个认领成 terminal_adopted → abandoned，页面上恰好是「有过这么一轮，被关闭放弃了」。

**风险**：**次序陷阱**：走到这里时 close() 已经跑完，`recorder.sessionClosed()` 也就已经跑完 finalizeSession 并置了 `s.closed`；writer 的 `sessionClosed` 对同一 sessionId 幂等（`if (s.closed) return`），所以之后再 ambiguous 就**永远没人认领**，静静留在 ledger 里。处置：在这条分支里 ambiguous 之后显式再调一次 `recorder.finalizeSession(this.id)`（它是公开方法、`#safe` 包裹、对 settled 轮次无副作用）。若不想承担这个复杂度，退而求其次记 reject——代价是云端可能真跑了的那一轮在台账上不存在。

#### `CursorAgentSession.send` — cursor / dispatch / 紧接其后

```js
this.#beginTurn(turnId, child);
```

**为什么是这里**：形状 B 唯一可用的证据是 child 的 "spawn" 事件（`candidate.once("spawn", resolve)`），所以 boundary 只能是 `os_spawned`——它只证明进程起来了，不证明 cursor 接受了这个 prompt（STATE §4.6：页面对它只能写「已派发，等待后端输出」）。但**公开时刻不能取在 spawn-await 刚 resolve 的那一行**：它和 `#beginTurn` 之间隔着抢跑关闭闸门，在那里 dispatch 会给一个桥自己都不认的轮次分配 turnNo，而且再没有任何结算路径能收它。放在 `#beginTurn` 之后，`turnId`（=`${this.id}-t${n}`，也就是 `lastTurnOf().id`）已经落定，可以顺手 `bindBackendTurnId` —— 这是后面 collected 唯一的映射键。放在 `#beginTurn` 内部也可以，但那样必须把 attemptId 挂到 this 上或改私有方法签名，收益为零。dispatchedAt 因此比真实 spawn 晚一个微任务，可忽略。

**风险**：`dispatch()` 全程同步、无 await（原子分配 turnNo 靠的就是这一点），并且会把 ACK 前暂存的 firstBackendEvent/terminal 立刻归并——若归并到 terminal，它内部会直接调 `settleOnce()` 并返回一个 Promise 链，**这个 Promise 绝不能落地不管**：`installProcessHandlers` 把 unhandledRejection 当致命（`cleanupAndExit(1)`）。`dispatch()` 本身过了 `#safe` 不会抛，但它内部调用的 `settleOnce()` 没过（见 notes D10），所以整句仍要 try/catch 包住。另：正文入队发生在这里（pendingInput→`#writeInput`），一次 send 因此多一次异步 fs 写，不阻塞。

#### `CursorAgentSession.#handleLine` — cursor / progress / 紧接其后

```js
if (!line.trim()) return;
```

**为什么是这里**：`firstBackendEvent(this.vizAttemptId)` 的落点。必须在 `if (this.proc !== child) return;`（陈旧子进程闸）**之后**——否则一个被顶替的旧 child 的迟到输出会被记成本轮「后端已开口」，而那正是这个字段要区分的两种卡死形态之一（已派发但完全沉默 vs 已开始输出）会被污染。也必须在空行过滤之后，否则一个空 flush 就把「沉默」抹掉了。放在 `switch` 里某个具体 case 则会漏掉 raw/未知类型行，同样把沉默说成有输出。

**风险**：`firstBackendEvent()` 只在首次置位、`#safe` 包裹、不 markDirty，重入完全安全。它对未 dispatch 的 attempt 会暂存进 `a.buffered`——cursor 里这一步理论上到不了（dispatch 与 wireChild 之间没有 await 让 stdout 先跑），但保留这条语义没有代价。唯一注意：`this.vizAttemptId` 在 `#settleTurn` 里清空后仍可能有迟到行进来，此时 id 为 null，所有 recorder 方法都 no-op。

#### `CursorAgentSession.#handleLine` — cursor / progress / 紧接其后

```js
if (text) this.lastAssistantText = clampText((this.lastAssistantText || "") + text);
```

**为什么是这里**：这是 cursor 侧唯一的「答案又长了」的位置。cursor 不开 `--stream-partial-output`，每个 assistant 事件是一个相对完整的块，频率天然低（一轮个位数到几十次），所以直接挂在这里是安全的。放在 `case "result"`（`#handleResult`）里就太晚了——result 是终结事件，那时进程马上要退出，实时尾巴的全部价值（看着它在写）就没了；放在 switch 之前又会把 thinking/tool_call 也算成正文增长。charCount 只能取 `this.lastAssistantText.length`（已被 clampText 截过），页面上要按「尾巴」读而不是按「全文长度」读。

**风险**：`progress()` 每次都往**普通 job 队列**塞一条 sidecar 写，和 t<N>.in.md / t<N>.out.md **共用** MAX_PENDING_JOBS=64 / 64MiB 预算，而且 `progress()` **不检查 enqueue 返回值**——队列满时静默丢弃，连 degraded 都不记（notes D8）。cursor 频率低所以风险可控，但 kimi 那边是逐块流式，同一段代码会把正文写挤成 queue_full，把一次成功的委托记成 `output.error`。建议两家统一在调用侧节流（≥250ms 或增量≥N 字符）。

#### `CursorAgentSession.#settleTurn` — cursor / settle / 紧接其前

```js
turn.settled = { err: err || null, status: status ?? null };
```

**为什么是这里**：必须落在幂等闸 `const turn = this.turn; if (!turn) return;` 之后、任何状态清理之前。之后：`this.turn=null` / `turnCount+=1` / `setSessionStatus(...)` / `turn.resolve|reject()` 一路把本轮身份抹掉，正文来源 `this.finalAnswer || this.lastAssistantText` 也会被下一轮的 `#beginTurn` 清空——STATE §8「同步抓正文」在这里就是字面意思：hook 全程同步、`#doSettle` 的 Promise executor 也是同步执行，所以正文在同一 tick 被抓走并入队，中间插不进第二轮。outcome 映射照抄本函数的四个调用点：`(null,"success")`→completed、`(null,"aborted")`→aborted、`(err,"no_result"|"error"|"exit_nonzero")`→failed。放在 `setSessionStatus` 之后会让快照先看到 status 变化再看到轮次结算，页面上出现一瞬间「会话已 idle 但那一轮还在跑」。

**风险**：`settleOnce()` 是**唯一没有过 `#safe` 的公开方法**，且返回 Promise。这里是同步方法，绝不能 await（await 会把 `turn.resolve()` 推迟到下一拍，wait/abort 的时序全变——这是最典型的 X9 越界）。必须 `try { viz?.settleOnce(...)?.catch(()=>{}) } catch {}`：漏了 catch，一个 recorder 内部异常会让 `turn.reject/resolve` 永不执行，调用方的 wait 永久挂住；漏了 `.catch`，一个 rejected 浮空 Promise 会触发 unhandledRejection → `cleanupAndExit(1)` 直接杀掉整个桥。

#### `CursorAgentSession.abort` — cursor / settle / 紧接其后

```js
const err = new Error("cursor abort: turn process did not terminate; session blocked until it exits");
```

**为什么是这里**：**PLAN §2.2 漏了这一档**：源码注释说 `#settleTurn` 是「The ONE idempotent settlement point」，但 abort 超时的毒化分支是**手工结算**——它自己 `this.turn=null` / `turnCount+=1` / `setSessionStatus(failed)` / `turn.reject(err)`，完全绕开 `#settleTurn`。只挂 `#settleTurn` 的话，这一轮在 viz 上会永远停在 dispatched，直到会话被 close 才被 finalizeSession 收成 abandoned——而它其实早就结束了，页面会长时间显示一个假的「仍在运行」。锚点选在 err 构造之后，是因为要把这句话如实写进 turn.error。

**风险**：outcome 取值是个判断题：桥自己把它报成 failed（status=failed、lastTurnError=true），而起因是用户 abort。我选 `failed` —— viz 绝不能和桥的对外口径互相打架（用户看 status 是 failed，看 viz 是 aborted，会直接不信这块表）。同 `#settleTurn`：同步、try/catch + `.catch(()=>{})`。这里 `this.proc` 仍被故意保留（毒化态），recorder 不要碰任何进程状态。

#### `CursorAgentSession.close` — cursor / lifecycle / 紧接其前

```js
setSessionStatus(this, "closed", false, { source: "close" });
```

**为什么是这里**：五处类 `close()` 之一。放**第一行之前**而不是 `return` 之前：close() 后半段有 `terminateProcessTree` / `scheduleForceKill` / `fs.rmSync(answerFile)` 若干可抛点，虽然外层有 catch，但一旦抛出，挂在末尾的 hook 就整个跳过——会话在 viz 上永远不会被标记关闭，finalizeSession 也永远不跑，那一轮永挂 dispatched。放最前面则「关闭」这件事一定被记下。注意 cursor 的 close **不走** `#settleTurn`（它直接 `turn.reject` 以免 bump turnCount），所以在途轮次的收口只能靠 `sessionClosed()` 内部的 finalizeSession 收成 abandoned——这正是它该有的样子。

**风险**：`sessionClosed()` 内部会调 `finalizeSession()` → 对 dispatched 轮次调 `settleOnce()` → 返回 Promise（同样要 `.catch`）。`sessionClosed` 按 sessionId 幂等（`if (s.closed) return`），所以 closeOne / cleanupSessions / openSession 失败路重复调用是安全的。`closed.forced` 与 `closed.reason` 在类 `close()` 里**拿不到**：force 只存在于 `closeSession()`，options 里只有 removePidRecord（notes D7）。

#### `KimiCodeSession.send` — kimi / dispatch / 紧接其后

```js
const myTurn = this.turn;
```

**为什么是这里**：与 cursor 同构：attempt() 的落点，在四道拒绝闸（空 message / closed / this.turn 占用 / this.proc 未死 / `#canRun()` 无可 resume 的 chatId）之后、turn 已同步占住之时。kimi 这里还多一件事——紧接着的 `this.userAborted = false;` 是本轮的同步复位点，attempt 落在它前后都行，但必须早于 `const releaseUnbegun = err => {`。

**风险**：同 cursor：新增 `this.vizAttemptId` 实例字段（已核实无任何 spread/keys 枚举会带出它）。attempt() 同步、`#safe` 包裹、无 IO。

#### `KimiCodeSession.send 内的 releaseUnbegun` — kimi / reject / 紧接其后

```js
const releaseUnbegun = err => {
```

**为什么是这里**：kimi 的确定拒绝同样三条全收敛在这里：`resolveKimiBin()` 抛 / `#assertCmdlineWithinLimit` 抛（NUL、命令行超限）/ `spawn()` 同步抛 / `if (!child) {...}`（ENOENT 重试后仍失败）。共同事实是没有进程跑起来过，且 kimi 比 cursor 更干净——它是**本地**执行，没有云端会话，也没有 chatId（首轮的 session id 要等 meta 行才铸出来），所以「没跑起来 = 什么都没发生」是严格成立的。

**风险**：同 cursor：reject 要无条件调，别塞进 `if (this.turn === myTurn)`。另注意 kimi 的 releaseUnbegun 还多一句 `this.userAborted = false;`（防 abort 泄漏到下一轮）——recorder 调用不要插在它和 `if (this.turn === myTurn)` 之间制造视觉噪音，放函数第一行最干净。

#### `KimiCodeSession.send` — kimi / ambiguous / 紧接其后

```js
if (this.status === "closed" || this.turn !== myTurn) {
```

**为什么是这里**：同 cursor 的抢跑关闭窗口：进程起来了但桥不 begin 这一轮。kimi 侧的歧义**比 cursor 弱**（纯本地、无云端提交、首轮 id 未铸出），所以这里 reject 也说得过去；但两家保持同一处置更省心，而且续轮（已有 chatId、`-S` resume）的子进程确实可能已经在本地会话里落了一笔。

**风险**：同 cursor 的次序陷阱：close() 先跑完 → sessionClosed 已 finalize 且幂等锁死 → 之后的 ambiguous 无人认领。处置一致：ambiguous 之后显式补一次 `recorder.finalizeSession(this.id)`。

#### `KimiCodeSession.send` — kimi / dispatch / 紧接其后

```js
this.#beginTurn(turnId, child);
```

**为什么是这里**：boundary 同样只能是 `os_spawned`（`candidate.once("spawn", resolve)`）。位置理由与 cursor 完全相同：必须晚于抢跑关闭闸门。kimi 这里还有一个额外理由——`#beginTurn` 之后紧跟着两段会动进程的代码：[review M3] 的「abort 落在 spawn 窗口里就补一刀 terminateProcessTree」，以及 `AGENT_BRIDGE_KIMI_TEST_STALE_CLOSE` 的测试钩子（它会**合成调用** `#onChildClose({staleTestChild:true}, -4058, null)`）。dispatch 必须排在这两者**之前**，否则那个测试钩子模拟出的 stale close 与真 abort 补刀会先于 dispatch 触达结算路径，出现「先 settle 后 dispatch」。

**风险**：同 cursor：dispatch 同步、可能内联触发 settleOnce → 整句 try/catch + `.catch(()=>{})`。`backendTurnId` 绑 `turnId`（=`lastTurnOf().id`），这是 collected 的唯一映射键。注意那个测试钩子传的是一个**假 child 对象**，`#onChildClose` 靠 `this.proc !== child` 挡掉——recorder 不要在 `#onChildClose` 顶部挂任何东西，否则这条合成调用会被记成真事件。

#### `KimiCodeSession.#handleLine` — kimi / progress / 紧接其后

```js
if (!line.trim()) return;
```

**为什么是这里**：`firstBackendEvent(this.vizAttemptId)`。与 cursor 同理：必须在陈旧 child 闸 `if (this.proc !== child) return;` 之后。kimi 尤其需要这个字段——它没有 `result` 事件，终结完全靠子进程 close + 一条 meta 行，所以「已派发但完全沉默」与「在写但没写完」在别处几乎分不出来。

**风险**：无重入风险；`firstBackendEvent` 只首次置位。

#### `KimiCodeSession.#handleLine` — kimi / progress / 紧接其后

```js
this.lastAssistantText = clampText(this.finalAnswer);      // clamped tail for the progress view
```

**为什么是这里**：kimi 的答案是**累加**出来的（`this.finalAnswer += msg.content`），没有 result 事件，所以这里是唯一能观测到答案增长的位置，也是唯一能同时拿到真实全长（`this.finalAnswer.length`，未截断）和尾巴（`this.lastAssistantText`，已 clampText）的位置——charCount 用 finalAnswer.length 才是诚实的计数，用 lastAssistantText.length 会在长答案上封顶撒谎。放在 `case "meta"` 或 `#onChildClose` 都太晚（那时轮次已终结，sidecar 马上要被删）。锚点包含行尾对齐注释，照抄时注意 `);` 与 `//` 之间是 6 个空格。

**风险**：**这是本次插桩最实的性能/正确性风险**：kimi 的 assistant 是逐块流式，一轮可能触发几百上千次，而 `progress()` 每次都往普通 job 队列塞一条写、且**忽略 enqueue 的返回值**（满了静默丢，连 degraded 都不记）。它与 t<N>.in.md / t<N>.out.md 共用 64 条 / 64MiB 预算——真正的危害不是丢几条进度，而是把**正文写**挤成 queue_full，让一次完全成功的委托在快照里变成 `output.error:"queue_full"` + `bodyKind:"none"`。必须在调用侧节流（时间窗 ≥250ms 或字符增量阈值），或给 sidecar 一个与快照同款的合并槽。

#### `KimiCodeSession.#settleTurn` — kimi / settle / 紧接其前

```js
turn.settled = { err: err || null, status: status ?? null };
```

**为什么是这里**：与 cursor 同构：幂等闸之后、状态清理之前，同步抓正文（`this.finalAnswer`，`#beginTurn` 会在下一轮把它清空）。outcome 照抄 `#onChildClose` 的四个调用点：`(null,"aborted")`→aborted、`(err,"exit_nonzero")`/`(err,"protocol_error")`→failed、`(null,"success")`→completed。注意 kimi 的 `protocol_error`（exit 0 但没拿到合法 meta）是**失败**：那一轮的正文可能是完整的，但会话已经不可 resume——outcome 记 failed、body 仍记下来（STATE §4.9 允许 failed+partial），别因为 failed 就把正文丢掉。

**风险**：同 cursor：同步、绝不 await、try/catch + `.catch(()=>{})`。

#### `KimiCodeSession.abort` — kimi / settle / 紧接其后

```js
const err = new Error("kimi abort: turn process did not terminate; session blocked until it exits");
```

**为什么是这里**：与 cursor 同一个被 PLAN 漏掉的第二结算点：abort 超时毒化分支手工结算、绕过 `#settleTurn`。不挂这里，这一轮在 viz 上会一直显示 dispatched 直到会话关闭。

**风险**：outcome 取 `failed`（与桥自身的 status=failed / lastTurnError=true 口径一致，避免两块表互相打架）。同步 + try/catch + `.catch`。

#### `KimiCodeSession.close` — kimi / lifecycle / 紧接其前

```js
setSessionStatus(this, "closed", false, { source: "close" });
```

**为什么是这里**：五处类 `close()` 之一，理由与 cursor 完全相同：放函数最前面才能保证后半段任何抛出都不会让「关闭」这件事丢失；kimi 的 close 同样**不走** `#settleTurn`，在途轮次靠 sessionClosed→finalizeSession 收成 abandoned。

**风险**：同 cursor：finalizeSession 内部会调 settleOnce（Promise，要 `.catch`）；forced/reason 在类内拿不到。

#### `serveMcp` — — / lifecycle / 紧接其前

```js
installProcessHandlers();
```

**为什么是这里**：viz 初始化**只能**在这里：`createVizRun()` 一被调用就 `mkdtempSync` 建目录，而 `doctor` / `cleanup` / `diag` / `help` / 任何测试 `import` 都走不到 `serveMcp()`——放模块顶层或 `runCli()` 开头，这五条路径都会凭空建一个临时目录（STATE §7「零副作用」硬要求）。选在 `installProcessHandlers()` **之前**：RUN_LOG_DIR 与 ensureDirs 已就绪（会话的 logFile 路径要写进快照），而三个退出处理器一装上就可能触发 `cleanupAndExit`，那时 recorder 必须已经存在，否则退出路径拿到一个 undefined。

**风险**：`createVizRun()` 做三次**同步** IO（mkdtempSync + 两次 writeFileSync）。这是启动期一次性开销、且整体 try/catch 兜底（失败返回 disabled recorder + 一条诊断），可以接受；但要清楚在 Defender 抖动的机器上它确实会阻塞事件循环若干毫秒——这是本设计里唯一一处主动的同步 IO。另：viz-writer **没有导出** disabledRecorder，也没有 no-op 单例（notes D9），所以模块顶层只能 `let viz = null`，全部约 30 个调用点用 `viz?.` 空守。

#### `openSession` — — / lifecycle / 紧接其后

```js
sessions.set(session.id, session);
```

**为什么是这里**：⚠️ **这里我和 PLAN §2.3 不一致，且我认为 PLAN 错了。** PLAN 说「会话开：`await session.start()` 成功后立即」。但 writer 的 `sessionOpenFailed()` 第一句就是 `const s = this.#ledger.session(sessionId); if (!s) return;`——会话若没先 `sessionOpened` 过，**`phase:"start"` 这条失败分支永远记不下任何东西**，而 STATE §4.2 明写「启动失败的会话也要占一个位置（页面要把它渲染成一张『生下来就死了』的卡片）」，§4.2 还要求 sessions 数组按**创建顺序**排。所以必须在 `await session.start()` **之前**登记。选这一行：`session.name` / `session.returnMode` 已赋值、`access`/`cwd`/`model`/`appendSystemPrompt` 构造期就有，白名单要的字段全齐；`backendPid` 此刻为 null（合法，§4.2 明说形状 B 轮间本来就没有进程）。附带收益：start() 期间那些 `setSessionStatus(this,"idle"|"failed",...)` 会被 status 钩子实时收到——cursor 的 `#createChat` 可能耗几十秒，页面在这段时间能显示一张 starting 卡片而不是一片空白。

**风险**：要用逐字段白名单构造 info（`agent/model/effort/access/cwd/returnMode/logFile/appendSystemPrompt{file,bytes,injectionMode}/name`），**绝不能 spread `session.summary()`**（STATE §4.2 明令）。`sessionOpened` 里的 `SAFE_ID` 校验对 `makeId()` 产出的 `cursor-mfx8q2-a7c319` 天然通过。构造函数抛（assertCwd 失败）时走不到这行，也就没有卡片——正确，那时连 session 对象都不存在。

#### `openSession` — — / lifecycle / 紧接其前

```js
if (params.model) {
```

**为什么是这里**：`phase:"start"` 分支。这一点位在 `sessions.delete()` 与 `session.close({removePidRecord:false})` 之后、两条 throw（带 model 提示的那条 / 裸 `throw err`）之前——是**两条 throw 的唯一公共祖先**，挂在任一条 throw 之前都会漏掉另一条。顺序也正好符合 writer 的硬要求：close 先跑（sessionClosed 记了 closed），openFailed 后跑并把 `s.closed` 抹掉、置 `suppressClosed`——「为什么起不来」压过「已关闭」，这正是 §4.2 想让页面显示的那句话。

**风险**：错误文本会被 boundError 截到 300 code unit，够用。若把 hook 放到 `session.close()` **之前**，closed 会反过来覆盖 openFailed（writer 只做单向抑制），页面上就只剩一句「已关闭」。

#### `openSession` — — / lifecycle / 紧接其后（即紧接其所在 `} catch {}` 之后、`throw err;` 之前）

```js
        session.close({ removePidRecord: false });
```

**为什么是这里**：`phase:"initialTurn"` 分支——会话起来了但首轮失败（wait:true 超时会顺带 abort 掉那一轮，或后端直接拒绝 prompt）。两个 phase 必须分开，因为它们对用户意味着完全不同的事：start 失败是「这个后端根本没起来」，initialTurn 失败是「后端活着但第一句话没跑通」。锚点用的是**8 个空格缩进**那一处（catch 内层 try 里的），与 start 分支那处 6 空格的同名语句靠缩进区分——照抄时缩进是锚点的一部分。

**风险**：同上：必须在 close 之后，让 openFailed 抑制 closed。这条路径上 initial turn 的 viz 轮次通常已经 dispatched，close→finalizeSession 会先把它收成 abandoned，然后 openFailed 把会话标 failed——顺序自洽。

#### `setSessionStatus` — — / lifecycle / 紧接其后

```js
  session.updatedAt = nowIso();
```

**为什么是这里**：**是唯一漏斗**：全仓 `.status =` 的写点只有两类——`setSessionStatus` 内部这一处，以及五个构造函数里的 `this.status = "starting"`（那时会话还没登记，由 `sessionOpened` 的初值覆盖）。56 个调用点全部经过这里。放在 `session.updatedAt = nowIso();` 之后、`if (changed || extra.force)` 之前是刻意的：无条件上报，把「变没变」的判断交给 writer 的 `sessionStatus()`（它逐字段比较，无变化就**不推进 generation**）——两边各判一次会分叉出第二个真理源。**`deriveHealth` 的拿法**：它就是同文件模块作用域的函数声明（已提升），直接 `deriveHealth(session)` 现场重算即可，零 IO——它只读 `status` / `dead` / `proc.exitCode|signalCode`，或调后端自带的 `isReusable()`（cursor 判 chatId、kimi 判 `#canRun()`，都是纯内存判断）。**绝不能缓存或从 summary() 里取**：形状 B 的会话轮间 `proc === null`，用 proc 存活性会把健康的 idle 判成 dead，这正是 `isReusable()` 钩子存在的原因。

**风险**：①这条钩子在热路径上（OMP 每个子轮次都会翻 running/idle），每次真变化都触发一次**全量历史**快照序列化（STATE §10 承认的 O(turn²)），高轮次会话上要留意；②`contextUsage` 建议一并带上（`session.contextUsage()` 五后端都是纯内存读，cursor/kimi 恒 null），但 writer 会对它做一次 `JSON.stringify` 比较，等于每次状态翻转多一次小序列化——可接受；③**绝不能在这里挂 `sessionClosed()`**：后端进程自己以 code 0 退出时也会走 `setSessionStatus(this,"closed",{source:"process_close"})`，但那时会话仍留在 `sessions` 里、`result()` 照样取得回（`uncollectedTurns` 的注释明写这一点），把它记成 closed + finalizeSession 会把一批**还救得回来**的轮次说成 abandoned。

#### `OmpRpcSession.close` — omp / lifecycle / 紧接其前

```js
setSessionStatus(this, "closed", false, { source: "close" });
```

**为什么是这里**：五处 close 之二。**`session.close()` 才是真漏斗，`closeSession()` 不是**：`cleanupSessions()`（退出路径与 `process.on("exit")` 都走它）直接 `session.close(options)`，**同时绕过 `closeSession()` 和 `closeOne()`**（它自己 `sessions.clear()`，连 DISCHARGED/logBytesWritten 都不清）——挂在 closeSession/closeOne 上会漏掉**整条关机路径**，也就是天天发生的那一条。omp 的这一行前面还有 `this.dead = true;` 与 turnEndedAt 补写，插在它之前意味着 recorder 看到的是关闭动作的起点，足够。

**风险**：omp/codex/claude 的 close 里 `#rejectAll` / `#failTurn` 可能触发它们自己的结算钩子（不在本次范围），要确认 sessionClosed 与那些钩子的先后不产生「先 closed 后 settle」——sessionClosed 内部的 finalizeSession 对已 settled 的轮次是 no-op，对 settling 的复用原 Promise，所以两种顺序都安全。

#### `CodexAppServerSession.close` — codex / lifecycle / 紧接其前

```js
setSessionStatus(this, "closed", false, { source: "close" });
```

**为什么是这里**：五处 close 之三，同上。这一行就是 codex close 的第一句，插在它之前 = 函数第一件事。

**风险**：同上。

#### `ClaudeCodeSession.close` — claude / lifecycle / 紧接其前

```js
setSessionStatus(this, "closed", false, { source: "close" });
```

**为什么是这里**：五处 close 之四，同上。

**风险**：同上。

#### `buildSessionResult` — — / lifecycle / 就地扩展该对象字面量（不新增语句）

```js
result[DELIVERED_TURN] = { sessionId: session.id, turnId: deliveredTurnId };
```

**为什么是这里**：**PLAN §5.2 已经过时**：它说 provenance 通道「当前不可实现」、要新建一条 WeakMap 或 non-enumerable Symbol——仓库里**早就有**这条通道 `DELIVERED_TURN`，而且注释明写 WeakMap 被测试证伪（`wait` 的 `summarize()` 返回 `{...extra,...base}`，重建对象后 WeakMap 键就没了），必须是**可枚举** Symbol（spread 自动带上，`JSON.stringify` 完全忽略，绝不漏到线上）——PLAN 建议的 non-enumerable 正好是错的那一种。所以不要新造通道，只需把 `returnedChars`（= `displayText ? displayText.length : 0`，`return_mode:"ref"` 时合法地为 0）和 `truncated` 两个字段加进这个已有的 Symbol 载荷。它挂在 `settledNow && deliveredTurnId` 的判据下，恰好等于 PLAN §5 记录条件的前两条，且天然满足第四条（provenance 与构造同源，不会在 await 之后从 session 现读 lastTurn）。

**风险**：零线上影响：Symbol 键不进 JSON。唯一要守住的纪律是**别在这里记 collected**——注释已经写死「构造处登记、返回处记账」：`result()` 允许中途取半截，`wait` 的稳定性复核还会**丢弃**已构造好的结果，在构造处记就会把没交付的记成已交付。

#### `collectDeliveries` — — / lifecycle / 紧接其后

```js
if (prov) dischargeTurn(prov.sessionId, prov.turnId, "collected");
```

**为什么是这里**：收口的唯一落点。`callTool()` 里 `collectDeliveries(payload)` 是**返回给调用方之前**的最后一道，且是**通用递归**而不是「已知返回形状清单」——open_session.initial / send_message 顶层 / result 顶层 / wait.completed / wait.settled[] 五种交付面一次覆盖（PLAN 要求的四个交付面全在内），新增工具或改返回形状都不会静默失效。挂在 `dischargeTurn` 这一行旁边意味着 viz 的 collected 与桥自己的台账**同一时刻、同一判据**——分开判就是第二个真理源。`via` 从 `callTool` 的 `name` 推（open_session/send_message/result/wait，正好是 §4.8 的枚举），需要给 `collectDeliveries` 加第三个参数并在 `callTool` 里传入。

**风险**：`collected()` 同步、`#safe` 包裹、writer 侧按 backendTurnId 查表并且只记第一次（重复 result/wait 自动幂等），映射键靠 dispatch 时 `bindBackendTurnId(turnId)` 建立——cursor/kimi 的 `turnId` 就是 `lastTurnOf().id`，对得上。给 `collectDeliveries` 加参数要注意递归调用也得透传，否则深层元素的 via 变成 undefined。注意 `dischargeTurn` 还有第二个调用者 `abortSession`（how="aborted"），**那里不要挂 collected**——放弃不是交付。

#### `cleanupAndExit` — — / lifecycle / 紧接其前

```js
process.exit(code);
```

**为什么是这里**：退出路径之一（信号 / stdin EOF / 父进程消失 / uncaughtException / stdout EPIPE 全汇到这里）。必须在 `cleanupSessions()` **之后**、`process.exit()` 之前：cleanupSessions 会逐个 `session.close()`，那批 sessionClosed + finalizeSession 得先跑完（它们只改内存 ledger，O(1)），然后才封账。做什么严格照 STATE §9：`sealAndStop()`（O(1)，停止接收新任务，**不写快照**），随后仅当 `code === 0` 才 `cleanup()` 删目录——与本函数既有的「clean exit 删 RUN_LOG_DIR、crash 留着给人查」规则完全同构。

**风险**：⚠️ `cleanup()` 里是 `rmSync(dir, {recursive:true})`——**同步递归删**一个可能装着几百份 prompt/answer 全文的目录。这个仓库的教训是「同步 OS 操作放进异步路径照样冻事件循环」，而这里就在 `process.exit()` 前一行，Defender 抖动时会实打实拖长退出。可接受（既有的 `fs.rmSync(RUN_LOG_DIR)` 同款风险，且退出已经没有下一拍），但要清楚这是本设计的第二处主动同步 IO。**绝不能**在这里写最终快照（§9 明令：写完即删，没有可靠消费者；run gone 才是最终裁决）。

#### `runCli(process.argv.slice(2)).catch 回调（文件末尾）` — — / lifecycle / 紧接其后

```js
  cleanupSessions({ removePidRecord: false });
```

**为什么是这里**：第二条退出路径，它**不经过 `cleanupAndExit`**（自己 stderr + cleanupSessions + `process.exit(1)`），所以必须单独挂——漏了它，一次 CLI 层异常退出会留下一个没封账的 writer 和一个不会被本进程清理的临时目录。只做 `sealAndStop()`，**不删目录**：exit code 是 1，按 cleanupAndExit 的既有规则崩溃现场要留给人查，孤儿目录由下一次 `cleanup` 的 owner-pid 双重校验回收。锚点这一行在文件里有两处同文本（另一处在 cleanupAndExit 里），靠所在函数区分——这一处是文件最末尾那个 arrow 回调里的。

**风险**：这条路径上 `shuttingDown` 标志没被置位，理论上后面还会触发 `process.on("exit")` 的 hook（下一条）——`sealAndStop()` 幂等（`#safe` + 置标志 + writer.stop()），重复调用无害。

#### `installProcessHandlers 里的 process.once("exit") 回调` — — / lifecycle / 紧接其后

```js
if (!shuttingDown) cleanupSessions({ removePidRecord: false });
```

**为什么是这里**：第三条退出路径，兜住前两条都没走到的情况（例如事件循环自然耗尽、或第三方直接 `process.exit`）。STATE §9 对这一格的规定是硬的：**不做任何 snapshot I/O**——所以这里只允许 `sealAndStop()`（纯内存、O(1)），连 `cleanup()` 的同步删目录都不该放（exit 回调里任何耗时同步 IO 都直接拖长进程消失的时间，而且此时已经没有任何机制能给它超时）。放在 `if (!shuttingDown)` 之后而不是包进那个 if 里：无论是否已在 shutdown，封账都该执行且幂等。

**风险**：exit 回调里**只能执行同步代码**，任何异步排队都不会被执行——`sealAndStop()` 正好满足（它做的就是丢弃在途队列）。若误在这里调 `cleanup()`，同步 rmSync 会在最不该阻塞的时刻阻塞。

#### `runCli（case "cleanup"）` — — / lifecycle / 就地扩展该对象字面量（不新增语句）

```js
printCliResult({ childProcesses: await cleanupStalePidRecords(), staleLogs: reclaimStaleLogs() }, args);
```

**为什么是这里**：孤儿 viz 目录的**唯一**回收入口。被 SIGKILL 掉的 run 来不及删自己的临时目录（那里面是全量委托明文，STATE §7 的隐私代价就压在这上面），writer 为此导出了 `vizCleanup()`（按 owner 里的 pid **双重校验**，对不上就当它还活着，宁可漏收不许误删）。不挂在这里，孤儿目录就永远没人清。注意它必须**只**出现在 `cleanup` 子命令里——`vizCleanup` 只读 tmpdir，不建目录，所以不违反零副作用。

**风险**：CLI 返回形状加一个键属于 additive；PLAN §1 核过 `repro-*` 全套没有 `deepStrictEqual` / `Object.keys` 精确形状断言，但这毕竟是对外可见输出，值得跑一遍现有 repro 确认。`vizCleanup()` 内部是同步 readdir + rmSync，在 cleanup 这个一次性 CLI 里完全可接受。

**该节点的 notes**

> 【一、与两份文档不一致的地方（按价值排序）】
> 
> D1（最要紧）PLAN §2.3「会话开：`await session.start()` 成功后立即」与 STATE §4.2 + writer 实现**互相矛盾**。`sessionOpenFailed()` 第一句是 `if (!s) return;`——会话没先 `sessionOpened` 过就记不下任何东西，于是 `phase:"start"` 这条分支**结构上永远是 no-op**；而 STATE §4.2 明写「启动失败的会话也要占一个位置（页面要把它渲染成一张『生下来就死了』的卡片）」，并要求 sessions 按创建顺序排。正解是在 `sessions.set(session.id, session);` 之后、`await session.start()` 之前登记（附带好处：cursor `#createChat` 那几十秒里页面有卡片可看）。
> 
> D2 PLAN §5.2「provenance 通道在 `callTool()` 里当前不可实现，需要 WeakMap 或 non-enumerable Symbol」**已被仓库现实推翻**。`DELIVERED_TURN`（`scripts/agent-bridge.mjs` 的 `collectDeliveries` / `buildSessionResult`）就是这条通道，而且源码注释写得很清楚：WeakMap 版本被测试证伪（`wait` 的 `summarize()` 用 `{...extra,...base}` 重建对象，键当场丢失），必须用**可枚举** Symbol 才能跟着 spread 走——PLAN 建议的 non-enumerable 恰好是错的那一种。落地时只需给这个已有载荷补 `returnedChars`/`truncated`，不要新造通道。
> 
> D3 PLAN §2.2 把 cursor/kimi 的结算写成「`#settleTurn`，四个本体都幂等」——属实，但**漏了第二个结算点**：`abort()` 超时毒化分支（cursor 与 kimi 各一处）是**手工结算**，自己 `this.turn=null` / `turnCount+=1` / `setSessionStatus(failed)` / `turn.reject(err)`，完全绕过 `#settleTurn`。只挂 `#settleTurn` 的话，那一轮在 viz 上会一直显示 dispatched 直到会话关闭。（顺带：源码注释自称「The ONE idempotent settlement point」，这句话本身就不准。）
> 
> D4 writer 与 STATE §4.7 冲突：`#writeInput` 从不写 `truncated` / `originalBytes`，attempt 初始化是 `truncated:false, originalBytes:null` 并且再没人动过。§4.7 的蕴含式是「`truncated === false` ⟹ `bytes === originalBytes`」，而 `null !== bytes`——**任何一次成功记录的 input 都会踩这条**。作为第二实现的 `contract-invariants.mjs` 若严格照散文写，会在真实快照上直接变红。要么 writer 补 `originalBytes = bytes`，要么 STATE 改口径（把 null 定义成「未截断，原始量即 bytes」）。
> 
> D5 有损点（不是违约，但要知情）：`finalizeSession` 收 abandoned 时硬写 `body:null, bodyKind:"none"`，而 §4.9 矩阵允许 `abandoned + partial`。cursor/kimi 被 close 打断时 `finalAnswer` 常常非空，这段已经写出来的正文会被丢掉。
> 
> D6 STATE §4.2 的 status 枚举含 `closed`，但源码里有**两种**截然不同的 closed：`{source:"close"}`（桥主动关，会话已从 `sessions` 移除，产出真没了）和 `{source:"process_close"}`（后端进程自己退出，会话**仍在** `sessions` 里、`result()` 照样取得回——`uncollectedTurns()` 的注释专门为此写过一段）。合同没区分这两者。我的处置是：close 钩子只挂五个类的 `close()`，`process_close` 只经由 status 钩子体现为 `status:"closed"` 而 `closed` 对象保持 null——这样页面能区分「我关的」和「它自己死的」。这是个口径决定，需要你确认。
> 
> D7 `closed.forced` / `closed.reason` 在类 `close()` 里**拿不到**：`force` 只存在于 `closeSession()`，而 `options` 只有 `removePidRecord`。要如实填就得在 4 个调用处（closeOne / cleanupSessions / openSession 两条失败路）给 options 补 `reason`/`forced`——additive，但确实要动核心调用点。
> 
> D8 两份文档都**没有给 progress sidecar 任何频率约束**。kimi 的 assistant 是逐块流式，一轮可能几百上千次；`progress()` 每次都往普通 job 队列塞一条写、并且**忽略 `enqueue` 的返回值**（满了静默丢，连 degraded 都不记）。它与正文写共用 64 条 / 64MiB 预算，真正的危害是把 `t<N>.out.md` 挤成 `queue_full` → 一次完全成功的委托被记成 `output.error` + `bodyKind:"none"`。必须在调用侧节流，或给 sidecar 一个和快照同款的合并槽。
> 
> D9 viz-writer **不导出** `disabledRecorder`，也没有 no-op 单例；模块顶层只能 `let viz = null`，全部调用点用 `viz?.`（约 30 处）。可接受，但值得在 writer 里补一个导出。
> 
> D10（X9 守门的两条硬结论）①`settleOnce()` 是**唯一没有过 `#safe`** 的公开方法，且返回 Promise——它出现在 `dispatch()`（归并暂存终结时）、`#settleTurn`、`finalizeSession` 三条路径上；②`installProcessHandlers` 把 `unhandledRejection` 当**致命**（`cleanupAndExit(1)`）。两条合起来：任何一个漏了 `.catch(()=>{})` 的 recorder Promise 都能**杀掉整个桥**，任何一个漏了 try/catch 的同步 recorder 调用都能让 `turn.resolve/reject` 永不执行、调用方的 wait 永久挂住。所以纪律是死的：**每一处 recorder 调用都 `try { viz?.x(...)?.catch(()=>{}) } catch {}`，并且核心路径上绝不 await recorder 的任何返回值**（`#settleTurn` / `close()` / `#handleLine` 都是同步函数，await 会改变时序，这就是越界）。除此之外，全部主动同步 IO 只有两处，都在生命周期边缘：`createVizRun()`（启动，mkdtempSync + 两次 writeFileSync）与 `cleanup()`（退出，递归 rmSync）——`process.on("exit")` 那一格严格只做 `sealAndStop()`，零 IO。第三处隐性成本是 `#markDirty` 里 `JSON.stringify(全量历史)`，跑在 writer 的 microtask 循环里（不阻塞调用方，但确实占事件循环；STATE §10 实测 1000 轮 ≈ 0.78 MiB/次）。
> 
> D11 行号偏差如约存在：PLAN §2 提到的 codex `#beginTurn :3129`、kimi `#settleTurn :4586`，实测分别在 3260 / 4717；cursor `#beginTurn` 在 4196、kimi 在 4700。本报告全部按函数名 + 邻近唯一语句定位，行号只供参考。
> 
> D12 ledger 的 `attempted` 态**没有回收路径**：`finalizeSession` 只处理 `dispatched` 与 `ambiguous`。一个既没 reject 也没 dispatch 的 attempt 会永远留在 `s.attempts`（不进快照，只是内存里的小对象）。cursor/kimi 里唯一能走到这的是「抢跑关闭」分支——若那里选 reject 就不存在这个洞。
> 
> D13 次序陷阱：`sessionClosed()` 按 sessionId 幂等（`if (s.closed) return`），而「抢跑关闭」分支里的 `ambiguous()` 发生在 close **之后**——那时 finalizeSession 已经跑过，这个 ambiguous 永远没人认领。处置见对应 site 的 risk（补一次显式 `finalizeSession`）。
> 
> 【二、我不确定、需要你拍板的】
> 
> U1 `input` 正文记**原始 message** 还是 `#composePrompt` 之后的**实际 argv prompt**（含首轮 system 前缀 + 只读策略前缀）？我倾向原始 message（§0 说的是「每轮问了什么」，system 前缀已在 session 级 `appendSystemPrompt` 里单独呈现，只读策略是常量）；但「实际发给模型的字节」是另一种同样合理的读法。两份文档都没定。
> 
> U2「抢跑关闭」记 `ambiguous` 还是 `reject`？我推荐 ambiguous——cursor 的 prompt 走的是云端 chat（`--resume <chatId>`），子进程被 SIGKILL 之前可能已经把这一轮提交给了服务端，说「确定拒绝」是假话。kimi 是纯本地、首轮 id 还没铸出来，歧义弱得多，选 reject 也说得通。代价是 ambiguous 要额外处理 D13。
> 
> U3 abort 超时毒化那一档的 outcome 取 `failed` 还是 `aborted`？起因是用户 abort，但桥自己对外报的是 `status:"failed"` + `lastTurnError:true`。我选 `failed`——viz 与桥的口径打架一次，这块表就没人信了。
> 
> U4 cursor `#createChat` 期间那个短命子进程的 pid，要不要写进 `session.backendPid`？我倾向不写（§4.2 的 backendPid 语义是「后端进程」，而 create-chat 只是个一次性分配器；形状 B 本来就允许 null）。
> 
> U5 PLAN §5 列的两条**绕过 `buildSessionResult`** 的 wait 路径（会话被并发关掉的 gone 分支、`result()` 抛错的 base fallback）不会带 `DELIVERED_TURN`，所以 viz 也不会记 collected。这与 PLAN 的「记录条件四条」一致，但意味着这两种交付在页面上表现为「已 settled、从未被取走」。是否可接受，需要确认——如果不可接受，得在那两条路径上单独补 provenance，而那正是「维护一张会漏的清单」的形状。
> 
> （本次只侦察，未修改仓库任何文件。）

---

