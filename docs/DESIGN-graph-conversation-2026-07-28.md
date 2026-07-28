# agent-bridge-graph:多轮对话（可选的记忆）—— 方案设计

**日期** 2026-07-28 · **修订 v4** · **状态** ✅ **可施工**（复审第 3 轮为止，用户 2026-07-28 裁定截止；本轮 4 BLOCKER + 3 MAJOR 已逐条落地，见 §9）
**关联** `skills/agent-bridge-graph/tools/node-core.mjs`、`docs/DESIGN-graph-viz-2026-07-26.md`（viz 的「轮」事件依赖本文档）

> **v4** 修的是 v3 自己造出来的回归。三轮下来最该记住的一条：
> **每一轮"修好"的动作本身都在制造下一轮的 BLOCKER。** v3 的 4 条 BLOCKER 里有 2 条（执行闸的持有区间、回放反写回执）是 v2→v3 那次修订新引入的，
> 与 viz 那 13 轮里的形状一模一样——**"改一处 ≠ 改干净一处"**。
> 因此 v4 的每一处判据都尽量**直接引用源码里已经存在的那条**（`STATUS_EXIT` 的序、`closeConfirmed` 的三条授权、`if (workspace)` 的外层守卫），
> 而不是重新发明一条读起来更顺的。

---

## 0. 为什么要有它

现在 `runNode` = 开会话 → 发一条 → 关会话，**节点之间没有记忆**。这不是疏漏：回执的 `specHash` 承诺"同样的输入 → 同样的执行"，节点若能记住上一轮，结果就取决于**看不见的会话状态**，指纹当场变成谎言。

**但"所以不该有记忆"是把属性讲成了教条。** 要不要留记忆是**编排者的判断**：

- 复审 → 修订 → 再复审：修订方记得自己上一轮为什么那样写，就不会把刻意的决定"修"回去。
- 同一个复核者连问几轮：它记得前面问过什么，不必每轮重述全部前情。

今天要这个只有一条路：`bridge.callTool("agent_bridge_open_session", …)` 自己开会话——**于是回执、指纹、worktree 隔离全都没有了**。真正的缺陷是**记忆与保证只能二选一**。

⚠️ **这不是把 `runNode` 改成有记忆。** `runNode` 的语义一个字不动，记忆是**显式选进来**的另一条路径。

---

## 1. 一条硬约束决定了 API 形状

**会话的 `cwd` 在 `open_session` 那一刻钉死。** 而 write 节点的 cwd 是它自己的 worktree，worktree 在节点收尾时被提交并删除。

所以"跨节点保留会话"对 write 意味着：**第二轮开口时，后端的工作目录已经不存在了。**

⚠️ 因此记忆**必须有作用域**，不能是一个裸的 `keepSession: true` 标志——那个标志会把"谁负责关会话、谁负责收工作区"推给调用方，而 `withBridge` 存在的全部意义就是不让人管这个。

**定死：一段对话 = 一个 `id` + 一个会话 + 一棵 worktree + 一条分支 + N 轮，作用域退出时统一收尾。**

```js
await bridge.conversation(
  { id: "events-md", agent: "claude", access: "write", cwd: REPO, outDir, effort: "xhigh" },
  //                                    ↑ 顶层**没有** timeoutMs，见 §2.1
  async (turn) => {
    const r1 = await turn({ key: "draft", prompt: FIRST, timeoutMs: 2_400_000 });
    if (!r1.sessionReusable) return;                     // ← 见 §3

    // 两轮之间跑一个**别的**节点（换引擎复审）—— 这是头号用法,必须不自锁(§1.1)
    const rev = await bridge.runNode({ id: "review-1", agent: "codex", access: "read", … });

    const r2 = await turn({ key: "fix", prompt: fixPrompt(rev), timeoutMs: 2_400_000 });
    //   r2 记得 r1 说过什么
  },
);
```

### 三个代价，都要写进 SKILL

| 代价 | 说明 |
|---|---|
| **一段对话 = 一条分支** | N 轮共享一棵 worktree，收尾时提交**一次**。这对"反复修同一份东西"更干净，但它不能再当 N 个独立可合并的产出用 |
| **对话名额被整段持有** | 见 §1.1。执行名额只在轮期间占，但**对话名额**（会话活着这件事）从首轮一直占到收尾 |
| **复用是整段的，且要重放** | 见 §4 |

### 1.1 名额要拆成两把闸（v4 修正取得时机与持有区间）

v2 写的是"对话活着就占一个 slot"，而 §4 又写"回调里的 `runNode` 各自撞自己的闸"。**这两句放一起就是死锁**：

```
conversation 持有 slot → 回调 await runNode → runNode 等 slot → 回调不返回 → conversation 不释放 slot
```

`maxConcurrent = 1` 时必然死锁；`maxConcurrent = N` 时 N 段对话同时进嵌套节点也全部死锁。
更坏的是**回放路径不持真实名额**，于是同一段编排 live 卡死、replay 通过——最难查的那种不一致。

⚠️ **不能靠"禁止回调里跑别的节点"绕过去。** 那条禁令会杀掉这功能的头号用法：复审必须发生在两轮**之间**（第 2 轮的提问就是照着复审意见写的）。禁掉嵌套，这个 API 就只剩"同一个 agent 自言自语"。

**定死：两把独立的闸，语义不同、不许合并。**

| 闸 | 界什么 | 谁取、什么时候取 | 什么时候放 |
|---|---|---|---|
| **执行闸** `_gate`（今天这把，默认 4） | 同时有几轮**正在烧后端** | 每一轮 admit 时 | 见下面的**两种 lease** |
| **对话闸** `_scopeGate`（新，默认同值） | 同时有几段对话**持着活会话** | **第一个 live turn**（不是 prepare），顺序 **`scope → exec`** | 整段收尾时 |

**执行闸有两种 lease，不许统一（v4 修，BLOCKER）：**

| 调用方 | 持有到 |
|---|---|
| **`runNode`（N=1）** | **close_session + finalizeWorktree + 写回执全部结束之后**——就是今天 `finally` 里那一句（`node-core.mjs:1715`），**一个字不改** |
| **`conversation` 的每一轮** | **该轮自己的收尾做完**（产出复制 + 算 SHA +（非 ok 时）冻结现场）之后即释放；回调期间不持有 |

⚠️ **共享 `runTurn` 不等于两个调用方必须在同一时刻放闸。** v3 把执行闸统一写成"持有到该轮结束"，而 §2.3 又规定 turn 结束不关会话、不收工作区——**于是 `runNode` 会在 close/finalize 还在跑的时候就放闸**。反例：`maxConcurrent = 2`、同时起 5 个慢 `runNode`，前两个一结束轮就放闸，后面立刻开新会话，桥里同时能有 3~4 个 session——**当场打红 W8**（`repro-graph-worktree.mjs:337` 实测活会话数不超上限）。

**对话闸必须懒取（v4 修，MAJOR）：**

- 放在 `prepare` 里取是错的：那时**还没有任何会话**。反例：`scopeGate = 1`，对话 A 的回调在第一次 `turn()` 之前先去等一个长外部任务——它一个 session 都没有，却占着唯一的名额，对话 B 永远进不来。
- **回放路径与零轮一律不取**（它们不开会话，没有要界的资源）。
- 顺序恒为 `scope → exec`，且 scope 一旦拿到就持有到收尾 ⇒ 不存在"持 exec 等 scope"，依赖图无环。

⚠️ **`_scopeGate` 不是"全局活会话上限"，别这么写进 SKILL。** 4 段对话停在轮间 + 4 个独立 `runNode` 在跑 = 桥里 **8** 个会话。真实上限是 **`scope + exec`**。这不成环也不饿死执行闸（信号量是 FIFO 直接交接），但**上限的口径必须如实说**。

**为什么必须是两把而不是一把开大**：它们界的是两种不同的资源——执行闸界同时烧后端的并发，对话闸界**跨轮活着的会话**。合成一把，要么嵌套死锁，要么活会话数无上限（开 20 段对话 = 20 个常驻后端）。

---

## 2. 重构：把「一轮」从「一个节点」里抽出来

`runNode` 现在是一个 650 行的函数，把**四件事**缝在一起：

```
① 准备   normalizeSpec → 进程内防撞 → 锁文件 → 仓库体检+脏树查 → 幂等/复用闸
② 入场   并发闸 → 起钟 → 脏树复查 → worktree → open_session
③ 一轮   send → wait 切片 → 弱检查/schema → 不合格则 reask(≤1) → 复制产出 → 算 SHA
④ 收尾   saveScene → close_session → finalizeWorktree → 原子写回执
```

`conversation` 要的是 **① ②③ ③ ③…④**（②只发生一次，挂在第一轮上）。所以：

```js
prepareRun(bridge, spec)                                             → run   // = ①
runTurn(run, { key, prompt, timeoutMs, outputShape, schema, reask }) → turnResult  // = ②(仅首轮) + ③
finalizeRun(run, extra)                                              → receipt // = ④
```

- `runNode(bridge, spec)` = `prepare` → `runTurn` ×1 → `finalize`（**外部行为一个字不变**）
- `conversation(bridge, spec, fn)` = `prepare` → 把 `turn` 交给 `fn` → `finalize`

⚠️ **绝不允许把 ③ 复制一份给 conversation 用。** "同一件事两处各写一遍，迟早漂成两种行为"——这个仓库在 `artifactSha256` / `diffPath` / `committed` 上已经栽过**三次**，都是同一个形状。

### 2.1 时钟：**每一轮在自己被 admit 时起钟；②挂在第一轮上**

v2 定的是"`startClock()` 在拿到并发闸那一刻起算，第一轮继承这口钟"。**这在对话里无法实现**：顶层 spec 没有 `timeoutMs`，那个数字要到第一次 `turn({timeoutMs})` 才出现；而 v2 又把拿闸/建 worktree/开会话放在 `prepare`——**拿闸的那一刻，实现根本不知道预算是多少**。

连带的第二个洞：prepare 期间预算耗尽或 open 失败**无处归类**。不调回调就与"零轮报 `UsageError`"打架；先开会话再进第一轮，T9 断言的 `sessionId === null` 当场失守。

**定死一条规矩，两条路共用：**

> **入场（②）延到第一次 `turn()` 被调用时才发生。** 每一轮的顺序是：
> **（首轮）拿对话闸 → 拿执行闸（排队不计入预算）→ 用本轮 `timeoutMs` 起钟 →（首轮）脏树复查 → worktree → open_session → send**。

- `runNode` = 只有第一轮，且那一轮的 `timeoutMs` 就是 `spec.timeoutMs` ⇒ **与今天逐字节相同的因果顺序**（源码 `1296-1313`：拿闸 → `startClock()` → 脏树复查 → `createWorktree` → 开会话）。不需要任何兼容分支。
- setup 花在第一轮的预算里 ⇒ **与 `runNode` 今天的口径完全一致**：setup 花光预算，第一轮就超时。这是现在的行为，不是新规则。
- `prepare` 里只剩**不需要预算的本地动作**：`normalizeSpec` / 建目录 / 进程内防撞键 / 锁文件 / 仓库体检 + 第一次脏树查 / 幂等闸或回放闸 / 嵌套检查。这些今天也全在并发闸之前（源码 `1149-1294`）。**对话闸不在这里取**（§1.1）。
- **零轮 ⇒ 从没拿过任何闸、没建 worktree、没开会话**。收尾因此是平凡的（§7）。
- ⚠️ **顶层 spec 传 `timeoutMs` 一律 `UsageError`**。多一个顶层预算就多一处"两个预算谁管谁"的解释。**同理不引入 `setupTimeoutMs`。**

**T9 为什么仍然成立（完整链条，v4 补）**：拿执行闸 → 起钟 → 脏树复查与 `createWorktree` 消耗预算 → 走到 `open_session` **之前**还有一道 `remaining() <= 0` 检查（源码 `1500`），它在 `openOutcome` 被改成 `"unknown"`（`1504`）**之前**就 `return finish("timeout")`。于是预算耗尽时：`sessionId === null`、`openOutcome === "not-attempted"`，**而且那棵 worktree 因此可以安全删除**（§7 的三条授权之一）。懒入场不动这条链上的任何一环。

### 2.2 `main` 轮到旧回执顶层字段的兼容投影

抽取之后 `runNode` 的那一轮内部叫 `key: "main"`。**投影只覆盖内容字段，不覆盖生命周期字段**——v2 那句"顶层字段投影自 `main` 轮"写过头了，它会把 `finalizeWorktree` 的**降级权**一起投影掉（§2.4）。

| 顶层字段 | 来源 |
|---|---|
| `artifactPath` | `main` 轮的产出，**路径仍是 `nodes/<id>.md`**（不是 `nodes/<id>.t-main.md`） |
| `abortConfirmed` / `reaskCount` / `charCount` / `byteCount` / `artifactSha256` / `contextUsage` | `main` 轮的同名字段 |
| `scene` | `main` 轮的 scene，**目录仍是 `nodes/<id>.scene`** |
| `status` / `error` / `diagnostics` / `workspace` / `durationMs` / `endedAt` | **节点级，不是投影**。由 §2.4 的优先级决定，收尾仍有最终改写权 |

⚠️ **`runNode` 的回执里不出现 `turns[]`、也不出现 `kind`**——它就是今天那张回执。`turns[]` 只属于 `kind:"conversation"` 的回执（§5）。**新字段一律不许渗进旧形状**，那是既有调用方与 `reuseIfSame` 的合同。

### 2.3 抽取时其余几处必须小心

| 现状 | 抽取后 |
|---|---|
| `finish()` 同时干"结束这一轮"和"结束这个节点" | 拆开。**turn 结束不关会话、不收工作区**；节点结束才收 |
| `finishTimeout()` abort 之后直接 `finish("timeout")` | abort 之后**只结束这一轮**，并据 `abortConfirmed` 决定会话还能不能用（§3） |
| `saveScene()` 是会话级、且延后取 | **改成 turn-scoped，且立刻取**（§3.3） |
| 拿闸 / 起钟 / worktree / open 在 `runNode` 函数体里线性排开 | 搬进 `runTurn` 的**首轮入场**分支（§2.1） |
| `finally` 里 `bridge._gate.release()` 一处管所有 | **两种 lease**（§1.1）：`runNode` 保持在最外层 `finally`，对话按轮放 |

### 2.4 顶层状态的优先级：轮不是唯一的输入

v2 的 §5 把顶层状态定成"全轮 ok / 否则第一个非 ok 轮"，**漏了三类结局**，而其中一类今天就是关键语义：

- 源码 `1458-1469`：`workspace.outcome` 不是 `delivered`/`no-changes` 时把 `status` 降成 `unknown`——理由写在那儿：`backend_failed`/`timeout` 在本工具的契约里是"可以安全换个人重跑"，而重跑常带 `force`，`force` 会删掉那棵**正因为说不清才被保留**的工作树。
- 源码 `1478`：回执落盘失败也降 `unknown`。
- **全轮 ok 但回调自己抛异常**：按 v2 会落一张 `status:"ok"` 的回执，还能过复用闸——等于把一次崩掉的编排当成功缓存起来。

**定死优先级（从低到高，后者改写前者）：**

| # | 判据 | 结果 |
|---|---|---|
| 1 | 全部轮 `ok` | `ok` |
| 2 | 有非 ok 的轮 | **各轮里最严重的那一个**（严重度序见下） |
| 3 | 回调抛了异常，**且**此刻 status 仍是 `ok` | `callback_error`（对话独有；`runNode` 不可能产生它） |
| 4 | **`access === "write"` 且 worktree 确实建起来了**，而 `workspace.outcome` 不是 `delivered`/`no-changes` | `unknown` |
| 5 | 回执写入失败 | `unknown`（沿用源码 `1478`） |

**第 2 级用「最严重」而不是「第一个非 ok」（v4 修，MAJOR）。** 严重度序**直接取仓里已有的 `STATUS_EXIT`**（`node-core.mjs:1723-1729`），不另发明：

```
ok(0) < contract_error(2) < backend_failed(3) < timeout(4) < unknown(6)
```

- "第一个非 ok"会被**后面更坏的轮**遮住。反例：第 1 轮 `contract_error`（`sessionReusable:true`）、第 2 轮 timeout 且 `abortConfirmed:false`（毒化）、回调正常返回 ⇒ 顶层报 `contract_error`，而 `contract_error` 按现有语义是"后端好好的，改改 prompt 就能重跑"——**实际上第 2 轮可能还在后台跑**。
- "最后一轮"会被**前面更坏的轮**遮住（"第 2 轮挂了、第 3 轮碰巧成了"报成功）。
- **取最严重的一次把两个方向一起修掉**，且 **N=1 时与今天恒等**（只有一轮，最严重的就是它）⇒ `runNode` 零变化。
- 哪一轮出的事不靠顶层 status 讲：`turns[]` 每轮都带自己的 status，毒化那轮另有 `poisonedAfter`。

**第 4 级必须带 `write` + `workspace` 两个前提（v4 修，BLOCKER）。** v3 只写"`workspace.outcome` 不是 delivered/no-changes"，**read 档的 `workspace` 恒为 `null`**，于是 `null.outcome` 也不属于那两个合法值——**每一个成功的 read 对话都会被降成 `unknown`**。源码那段本来就在 `if (workspace && !workspaceFinalized)` 里面（`1429` / `1705`），前提不能丢。

**其余两条：**

- 第 3 条**只在 status 还是 `ok` 时**生效：轮先挂了、回调因此抛（`r1.text.trim()` 之类）时，轮的 status 更接近根因，不许被 `callback_error` 盖掉。
  ⚠️ **但回调异常这件事不许因此消失**：第 2 级生效时，回调异常的 `name + message` **必须进 `diagnostics`**。否则进程一退，canonical 回执里就再也没有"回调也炸了"这个事实。
- `callback_error` ≠ `ok` ⇒ **复用闸自然拒绝它**，不需要额外规则。
- ⚠️ **顶层 status 怎么变，都不改变"原始异常原样重抛"**（§7）。回执是记录，异常是控制流，两回事。

---

## 3. 会话还能不能接着用：串行闸、`sessionReusable` 与「毒化」

### 3.1 同一时刻只许有一轮

`Promise.all([turn(a), turn(b)])` 会让两轮在第一轮还没产出任何结论之前**同时通过毒化 guard**，随后两边向同一个 session `send`——正是要消灭的东西。§8 只写"不做并发"是**调用纪律，不是判据**。

**定死：`turn()` 的第一件事是同步的串行闸。**

> 该段对话已有一轮在途 ⇒ 立刻 `UsageError`，**且这一步排在任何 `await` 之前**——占 key、建产出文件、发事件、拿闸、起钟、发消息，一件都还没发生。

JS 单线程，async 函数体在第一个 `await` 之前是同步执行的，所以这道闸是原子的。**两条实现约束跟着写死**（不写死就会在某次重构里悄悄失效）：

- "查 + 置位"必须**字面上**排在任何可能返回 Promise 的 helper 之前——包括参数校验。**一旦哪天把校验改成 `await validate(...)` 放到前面，这条保证当场作废。**
- 置位在 `finally` 里清，不能只在成功路径清。

**判据放在工具里，不是写在 SKILL 里请人自觉。**

### 3.2 `sessionReusable` 与毒化

v1 写的是"abort 之后只结束这一轮，是否继续由回调决定"。**这是错的**：源码自己承认 `abortConfirmed:false` 时**那一轮可能仍在后台运行**；这时再 `send`，就是往同一个会话里并发发消息——codex 会报 `already has a running turn`，OMP 会排队搅乱上下文。`failed` / `closed` / `gone` 更是连会话都没了。

**定死：`turnResult` 恒带 `sessionReusable: boolean`，且由工具强制执行，不靠回调自觉。**

| 该轮结局 | `sessionReusable` | 理由 |
|---|---|---|
| `ok` | `true` | — |
| `contract_error`（格式打回后仍不合格） | `true` | 后端好好的，只是答得不合格 |
| `timeout` 且 `abortConfirmed === true` | `true` | **桥明确回报打断了**，那一轮确实停了 |
| `timeout` 且 `abortConfirmed !== true` | **`false`** | ⚠️ 那一轮**可能还在后台跑** |
| `backend_failed`（`failed`/`closed`/`gone`） | **`false`** | 会话已经没了 |
| `unknown` | **`false`** | 不知道后端干没干，正是最不能再叠一轮的情况 |

**`sessionReusable === false` ⇒ 整段对话立刻「毒化」：**

- 后续任何 `turn()` 返回 **rejected Promise**（`UsageError`），拒的位置**与 §3.1 的串行闸同一处**——同样在任何副作用之前
- 毒化之后 `fn` 继续跑完（它可能还要做别的），作用域退出时照常收尾
- 回执里 `poisonedAfter` = 毒化那一轮的 `key`。⚠️ 它**不是**顶层 status 的替代品——status 已经按 §2.4 第 2 级取到了那一轮（毒化的三种结局 `timeout`/`backend_failed`/`unknown` 严重度都不低），`poisonedAfter` 只回答"是哪一轮"

### 3.3 现场必须**当轮**冻结，不能延到整段收尾

v1 说"最后保存第一个非 ok 轮的现场"。**那会保存错轮的现场**：桥的 `answerFile` / `textRef` 是**会话级的单一路径**，每轮结果覆盖同一个文件。第 1 轮超时、第 2 轮继续跑完之后再去取，拿到的 `answer.txt` / `status.json` **属于第 2 轮**，却被标成"第 1 轮失败的现场"。

**定死：某一轮非 `ok` 时，在下一次 `send` 之前立刻冻结它自己的现场**（也就是在该轮释放执行闸之前，§1.1）。

- 对话：`nodes/<id>.t-<key>.scene/`（turn-scoped）
- `runNode`（N=1）：**仍投影到 `nodes/<id>.scene`**，保证 T2/T3 逐字节不变
- 整段 finalize 只负责：关会话 → 收工作区 → 写回执。**不再补取现场**

---

## 4. 复用：replay validation

v1 的 `lineageHash` 在 callback 式 API 下**没有可执行判据**：调 `fn` 之前不知道轮序列，调了才知道——而"调"本身就把副作用跑了一遍。

**定死：走 replay validation。**

> `reuseIfSame` 且已有一张合格的旧回执时：**不拿任何闸、不建会话、不建 worktree**。回调照常执行，每个 `turn()` **不发任何消息**，而是拿本轮参数与旧回执里对应的那一轮**逐项比对**，一致就直接返回旧的 `turnResult`。`fn` 返回时要求**恰好消费完全部轮次**——多一轮、少一轮、顺序不同，全部拒绝整段。

**每轮的指纹必须覆盖**：

```
turnSpecHash = H(key, prompt 正文, timeoutMs, schema, outputShape, reask)
```

**复用闸（逐项，缺一即 `UsageError`）：**

回执存在且 `receiptVersion` 对得上 → `kind === "conversation"` → `specHash` 一致 → 顶层 `status === "ok"` →（write 再加：主树干净、`baseCommit` 未变、按 `workspace.outcome` **字面量**分派，沿用 `runNode` 那套一字不改）→ 进回放：每轮 `turnSpecHash` 一致、该轮产出文件存在且 SHA 与回执一致、**该轮每一条非空 attempt 产出的路径与 SHA 也逐项一致**（§6）→ `fn` 返回后恰好消费完全部轮次。

- ⚠️ **`kind` 这道闸只属于 `conversation()`。** `runNode()` 的复用闸**不许开始查 `kind`**——历史回执没有这个键，加上去等于把所有旧回执一次判死。**按调用的是哪个 API 分派，不按回执里有没有某个字段分派。**
- ⚠️ **少一项就拒绝，不是跳过。** 按 `kind` 的字面量分派，结构上就没有"跳过"这条路——**"字段缺失＝静默跳过校验"这个坑本仓踩过三次**。
- ⚠️ **删掉 v2 的 `conversationHash`**：它完全由 `specHash` + 逐轮 `turnSpecHash` + 逐轮 SHA + 轮序列派生，而这几样上面每一样都已经逐项强制校验过。留着它只是让被验的一方多出示一张自己算的成绩单。**没有独立消费者的字段，本仓已经栽过好几次**（`pid` / `archiveRef` / `halt` / `BoundedSummary.name`）。

**不匹配之后怎么办：响亮失败，不静默转 live。**

任一闸不过 → `UsageError`。**不会"那就重新跑一遍"**——这不是新规矩，**这就是 `runNode` 今天的口径**（源码 `1162-1293`：版本不对、`specHash` 变了、上次不是 ok、产出被换过、基线漂了、分支没了……每一条都是 `throw new UsageError`，从来没有一条回退去重跑）。

在分波（`templates/wave.mjs`）里怎么用，写进 SKILL：

| 情况 | 怎么写 |
|---|---|
| 语义没变的旧对话 | 稳定 `id` + `reuseIfSame` |
| prompt / 轮序列改了 | **换新 `id`** |
| 明确要覆盖上次那一次执行 | 用 `force`，**且不要同时传 `reuseIfSame`** |

**回放的副作用边界：**

- 工具在回放期间**承诺**的只有：不拿任何闸、不建 worktree、不开会话、不发任何消息、**不动 canonical 回执**（§7）。
- 回调里**其它**东西的副作用（嵌套 `runNode`、直接写文件、发网络请求）**工具管不了**，而"恰好消费完全部轮次"只能在末尾才判得出来——那时嵌套节点早跑完了。
- ⚠️ **"拒绝整段"的意思只有一个：这一段对话不接受复用。它不是回滚，也不是事务。**
- 因此定死一条使用纪律并写进 SKILL：**回放模式下的回调必须是可重放的**——嵌套节点一律带 `reuseIfSame`（它自己会命中自己的复用闸），**绝不用 `force:true`**（那会真删真跑）。
- "恰好消费完"这一检查发生在**封 admission、排空在途轮之后**（§7①②）；回调若已经抛过异常，仍以**原始异常**为准，这条检查不许把它换掉。

⚠️ **不做部分复用**（前 k 轮复用、从第 k+1 轮接着聊）：那需要把后端会话的**内部状态**恢复出来，而"重放前 k 轮的文本"**不等于**"后端当时的内部状态"（模型侧的上下文、压缩、工具调用历史都不在我们手里）。**复用粒度就是整段。** 想要更细的粒度，就把对话切小。

---

## 5. 回执形状

对话的回执**仍然是一张** `nodes/<id>.receipt.json`：

```jsonc
{
  "receiptVersion": 2,
  "kind": "conversation",              // ← runNode 的回执**没有这个键**(§2.2)
  "id": "events-md", "specHash": "…",
  "status": "ok",                      // 按 §2.4 的优先级定,**不是**轮的纯投影
  "poisonedAfter": null,               // 毒化时 = 那一轮的 key
  "turns": [
    { "key": "draft", "status": "ok", "sessionReusable": true,
      "turnSpecHash": "…", "artifactPath": "<outDir>/nodes/events-md.t-draft.md",
      "artifactSha256": "…", "charCount": 1234, "byteCount": 1400,
      "reaskCount": 0, "durationMs": 84000,
      "startedAt": "…", "endedAt": "…", "contextUsage": { "tokens": 51234 },
      "abortConfirmed": null, "scene": null, "error": null,
      \ 每次尝试各一条,形状与 viz 施工第 5 项在节点级加的那份完全相同:
      "attempts": [ { "n": 1, "inputSha256": "…", "inputRef": null,
                      "artifactPath": "…", "artifactSha256": "…",
                      "status": "accepted", "rejectedReason": null } ] },
    { "key": "fix", "…": "…" }
  ],
  "workspace": { "outcome": "delivered", "branch": "graph/<runKey>/events-md", "…": "…" },
  "diagnostics": [], "sessionId": "claude-…", "closeConfirmed": true,
  "durationMs": 178000, "startedAt": "…", "endedAt": "…", "access": "write"
}
```

- **每轮一个产出文件** `nodes/<id>.t-<key>.md`；`key` 只许 `[A-Za-z0-9._-]`、≤200 字节、段内唯一
- **`turn()` 不抛异常**（同 `runNode`）：失败进 `turnResult.status`。只有**用法错**（串行闸、毒化后仍调、`key` 非法/重复、超 `maxTurns`、`fn` 返回后迟到调用）才抛
- 顶层 `status` 见 §2.4；`error` 在 `callback_error` 时装回调异常的 `name + message`（**不新开字段**）
- **轮级不设 `rejectedReason`**：契约打回的原因就在 `attempts[].rejectedReason` 里，轮级再放一份是第二个副本（§9）
- **`attempts[]` 归 viz 施工第 5 项一次加两级**（v4 定，实施时改口径）：codex 说得对——viz 的回放兜底**唯一**能拿到 attempt 证据的地方就是终态里这份摘要（复用命中时**不发任何 attempt 事件**，viz 设计 §1120）。
  但**现在就在轮级单独加一份是错的**：节点级那份还不存在（viz 施工清单第 5 项，viz 设计 §1078，`RECEIPT_VERSION` 升到 2 就是因为它），现在先造一个轮级的，等 viz 那份落地时就是**两份各自演化的形状**——本仓栽过三次的那个坑。
  ⚠️ **而且抽取之后它已经是一处改动了**：attempt 循环只剩 `runTurn` 一个地方，那里把 `attempts[]` 写进 `turnRec` 就同时满足两级——`runNode` 的 `turnRec` **就是回执本身**（顶层 `attempts[]`），对话的 `turnRec` 是 `turns[]` 里那一条（`turns[].attempts[]`）。**一次写，两级都有，不可能漂。**
  所以本方案**不加**，改成把这条依赖写死：viz 第 5 项落地时必须一并覆盖两级，验收里加"对话的每一轮都有自己的 `attempts[]`"。
- **`maxTurns = 20`**，超过当场 `UsageError`。理由：`node:settled` 要内联一份有界的轮摘要（§6），而 N 无上限就顶穿事件的行上限。20 对"复审→修订"这类用法足够宽（实测 2~6 轮），**而且超了是响亮报错、不是静默截断**
- v1 **不给 CLI 暴露对话**（`node-turn.mjs` 只跑单节点），所以不新增退出码

---

## 6. 与 viz 事件的关系（**为什么 EVENTS.md 要等这份**）

事件模型里现在一个节点只有一条命：`node:observed …→ node:settled`；而 `node:attempt` 指的是**格式打回重说**（≤1 次），**不是"轮"**。

对话引入的是**第三层**：

```
节点(node) ──┬── 轮(turn) ──┬── 尝试(attempt)   ← 格式不合格打回重说,≤1
             │              └── 尝试
             └── 轮 ──┬── 尝试
                      └── 尝试
```

EVENTS.md v1 必须直接包含：

- `node:turn` / `node:turn-settled`（与 `node:attempt` 平级但更外层）
- 顺序**严格**：`node:turn → node:attempt → node:attempt-settled → node:turn-settled`
- `node:attempt` / `node:progress` 都带 **`turnKey`**；**attempt 编号在每一轮内重置**（`n` 是"本轮第几次尝试"）
- 归档多一层：`<seq>-<id>/turns/<key>/`
- ⚠️ **`node:settled` 里内联的是有界的 `TurnSummary`，不是回执同形对象**：viz 的既有原则是"事件只装发生了什么 + 去哪儿找，不复制 canonical 回执"。
  `TurnSummary` = `{ key, status, sessionReusable, output: AssetState, turnSpecHash, charCount|null, durationMs, attempts[] }`。
  `attempts[]` 就是 viz 现有的那份兜底摘要（含 attempt 级的 `rejectedReason?`）**搬到轮下面**，每轮 ≤2 项 ⇒ 全节点 ≤40 项，仍然有界。它的持久来源是 §5 的 `turns[].attempts[]`。
  ⚠️ **轮级不再另设 `rejectedReason`**——它就是本轮最后一次 attempt 的那个值，第二个副本（§9）
- ⚠️ **复用命中只发 `node:settled{execution:"reused"}` 的历史摘要**，**不伪造**本次并未发生的 `node:turn` 开始事件——页面上"这一轮什么时候开始的"必须是真的发生过

⚠️ **单轮节点不是特例，是 N=1**。别为它留一条"没有 turn 的旧路径"——两条路径迟早漂。`runNode` 产出的事件流里同样有 `node:turn{key:"main"}`。

---

## 7. 作用域的所有权与收尾协议

`conversation()` 拥有：对话闸名额、会话、worktree、锁文件、进程内防撞键、产出目录。（执行闸名额按轮持有，见 §1.1。）

### 7.1 live 路径：八步，每步各自 try/catch，前一步失败绝不跳过后面的步骤

| # | 动作 | 它自己失败了怎么办 |
|---|---|---|
| ① | **封 admission**（同步置位；之后任何 `turn()` 立刻 rejected） | 不会失败 |
| ② | **排空在途轮**：等那一轮自然结束 | 记 diagnostics，继续 |
| ③ | **关会话** | `closeConfirmed=false` + diagnostics，继续 |
| ④ | **按 `outcome` 收工作区**（只有 write 且树建起来了才有这一步） | 记 diagnostics + 按 §2.4 第 4 条降 `unknown`，继续 |
| ⑤ | **定顶层 status**（§2.4）+ `endedAt` / `durationMs` | 不会失败 |
| ⑥ | **原子写回执** | 按 §2.4 第 5 条降 `unknown`，继续 |
| ⑦ | **无条件释放**：执行闸（若仍持有）→ 对话闸（若取过）→ 进程内防撞键 → 锁文件 | 各自 try/catch。**一件都不许漏**——漏了下一段对话永远起不来 |
| ⑧ | **若回调抛过异常：原样重抛那个异常对象** | ③④⑥ 的抱怨一律只进 `diagnostics`，**绝不替换它** |

**第④步删不删树，判据是源码那三条，不是"关没关成"（v4 修，BLOCKER）：**

```
可以删 ⟺ closeConfirmed === true
        || openOutcome === "not-attempted"
        || openOutcome === "refused"
```

（源码 `1431-1439`。）v3 写成"关不掉可能意味着后端还活着 ⇒ 保留"是**错的**，它会改掉现有 `runNode` 行为并留下残骸：

- write 节点建好 worktree 后预算耗尽、**还没发出 `open_session`**（`openOutcome === "not-attempted"`，正是 T9 那条路）：没有任何后端可能写这棵树，**必须删**。
- `open_session` 被桥**明确回报**起不来（`openOutcome === "refused"`）：同样是空树空分支，**必须删**——否则每次后端没装好都攒一棵。

第②步那一轮**会终止**：桥的每次 RPC 都有客户端计时器、`wait` 用有限切片，超时后进 abort/finalize（前提只是 event loop 与 OS 还能调度）。**不需要为它新增机制。**

### 7.2 replay 路径：只读收尾，**绝不碰 canonical 回执**（v4 补，BLOCKER）

v3 让两条路共用同一套八步，于是回放会去写回执——**那是在毁掉自己刚刚验证过的那份缓存**：

- 反例一：回放正常命中，⑤⑥ 把 `endedAt`/`durationMs` 改成**本次验证**的时间，历史执行的耗时就此丢失。
- 反例二：旧回执是 `ok`、每一轮都对得上，但回调最后抛了个新异常 ⇒ 八步会把这张成功回执改写成 `callback_error`。**一次回放期的编排 bug，永久毁掉一份有效缓存。**
- 现有 `runNode` 命中复用是 `return { ...prev, reused: true }`（源码 `1293`），**一个字节都不写**。

**定死 replay 的四步：**

> ① 封 admission → ② 排空在途轮 → ③ 验证「恰好消费完全部轮次」→ ④ 释放**本次**取得的东西（进程内防撞键、锁文件；**闸没取过，会话不存在，工作区没建过，一律不动**）
> ⇒ 返回 `{ ...prev, reused: true }`，或（回调抛过异常时）重抛原始异常。
> **不关会话、不 finalize 工作区、不写回执、不改 `endedAt`。**

### 7.3 四条路 + 两个边界

- **① 回调正常返回** —— 走 7.1 或 7.2，返回回执。
- **② 回调抛异常** —— 同上走完，最后重抛**原始异常**。
- **③ `fn` 返回之后迟到的 `turn()`**（回调里 `setTimeout` 了一下之类）—— 第①步已经封了，返回 rejected Promise，**不产生任何事件、文件、消息**。
- **④ 进程被强杀** —— **不承诺统一收尾**：JS 的 `finally` 不运行。会话与后端只能靠桥的 EOF / OS 兜底，**worktree 与 `.lock` 可能残留、终态回执不会产生**。这条**如实写进 SKILL**，并给出人工恢复办法（`git worktree remove --force` + 删锁文件）。**不为它做持久 lease / crash recovery**——那是另一个量级的机制，而这条边界 viz 设计里已经接受过一次。

**零轮**（`fn` 一次 `turn()` 都没调）：

- 因为入场是懒的（§2.1），此时**从没拿过任何闸、没建 worktree、没开过会话**，③④ 是空操作。
- **回调正常返回** ⇒ 收完资源后报 `UsageError`。**不写空回执**（一张 `turns: []` 的回执会让复用闸面对一个没有任何判据的对象）。
- **回调抛了异常** ⇒ **抛回调那个异常，不是零轮的 `UsageError`**。⚠️ v2 这两条规则直接打架；根因说清楚就不再冲突：**零轮检查是"你什么都没干"的兜底诊断，而回调已经抛出的异常才是根因，兜底不许盖根因。**

⚠️ **一个如实写明的既有缺口**：调用方**忘了 `await`** `conversation()` 本身时，`withBridge` 会在它跑完之前关桥。这与今天忘了 await `runNode` 是**同一个**缺口——`withBridge` 目前没有 in-flight 登记表（那是 viz 施工第 3 步要加的东西）。**本方案不假装解决它**，只保证 `conversation()` 自己 resolve 之前把它拥有的东西全收完。

---

## 8. 明确不做

- **不做部分复用**（§4）
- **回放拒绝之后不自动转 live 重跑**（§4：与 `runNode` 复用闸同一口径，响亮失败）
- **回放不写回执**（§7.2）
- **不做跨 `withBridge` 的对话**：会话活在桥进程里，桥没了对话就没了。分波要延续 → 复用整段（§4）
- **不做 `runNode` 的 `keepSession` 标志**（§1：谁收尾说不清）
- **不做一段对话内换 agent / model / access / cwd**：全是 `open_session` 的参数，钉死在开会话那一刻。要换 → 另起一段对话
- **不做轮与轮之间的并发**：由 §3.1 的串行闸**强制**，不是纪律
- **不做嵌套 `conversation()`**（§1.1：会在对话闸上成环）。嵌套 `runNode` **支持**，那是头号用法
- **不做强杀后的自动恢复**（§7.3④）
- **顶层不接受 `timeoutMs`，也不引入 `setupTimeoutMs`**（§2.1）
- **不由本方案给 `runNode` 的回执加 `attempts[]`**（那是 viz 施工第 5 项，§5）

---

## 9. codex 复审第 3 轮的落点（4 BLOCKER + 3 MAJOR）

**用户 2026-07-28 裁定：复审到本轮为止。** 下面是逐条裁定，成立的已全部落地。

| 级别 | 发现 | 裁定 | 修在 |
|---|---|---|---|
| **BLOCKER** | v3 把执行闸统一成"持有到该轮结束"，而 `runNode` 的 close/finalize/写回执在轮之后 ⇒ 活会话数会超上限，**打红 W8** | **认**（`node-core.mjs:1715` 今天在最外层 `finally` 放闸；`repro-graph-worktree.mjs:337` 实测断言）。**这是 v3 新造的回归** | §1.1 **两种 lease**：`runNode` 保持最外层，对话按轮放 |
| **BLOCKER** | §2.4 第 4 级没有 `write` / `workspace` 前提 ⇒ **每个成功的 read 对话都被降成 `unknown`** | **认**（源码那段本来就在 `if (workspace)` 里，`1429`/`1705`） | §2.4 第 4 级补两个前提 |
| **BLOCKER** | §7"关不掉就保留 worktree"不精确 ⇒ `not-attempted` / `refused` 两条路会留残骸，改变 `runNode` 行为 | **认**（授权是 `closeConfirmed \|\| not-attempted \|\| refused`，`1431-1439`） | §7.1 直接引用源码那三条；§2.1 把 T9 的完整链条写全（含 `1500` 那道 pre-open 检查） |
| **BLOCKER** | 八步收尾没分出 replay 路径 ⇒ 回放会反写、甚至把 `ok` 毁成 `callback_error` | **认**（`runNode` 命中复用是 `return {...prev, reused:true}`，`1293`，一个字节不写）。**也是 v3 新造的回归** | §7.2 replay 专用四步只读收尾 |
| MAJOR | `poisonedAfter` 会被"第一个非 ok"遮住，顶层 status 不再表达重跑安全性 | **认问题，改 remedy**——codex 的两个选项（毒化结局不可被遮 / 消费者先查 `poisonedAfter`）前者会把 `runNode` 的 `timeout` 改成 `unknown`、后者要求所有下游改代码 | §2.4 第 2 级改成**取最严重的一轮**，严重度序**直接用仓里的 `STATUS_EXIT`**（`1723-1729`）。N=1 恒等 ⇒ `runNode` 零变化，且"前遮后""后遮前"一起修掉。另补：第 2 级生效时回调异常仍须进 `diagnostics` |
| MAJOR | `_scopeGate` 在 prepare 取（那时还没会话）；且它不是全局活会话上限 | **认** | §1.1 改成**首个 live turn 才取**、顺序 `scope → exec`、回放/零轮不取；并如实写明总上限 = `scope + exec` |
| MAJOR | `TurnSummary.attempts[]` 有消费者但回执里没有持久生产源 | **认问题，改落点**——现在只加轮级那一份，会和 viz 第 5 项将来加的节点级那份变成两个各自演化的形状 | §5：**归 viz 施工第 5 项一次加两级**。抽取之后 attempt 循环只剩 `runTurn` 一处，写进 `turnRec` 就同时覆盖 `runNode` 的顶层与对话的 `turns[]`——一次写、两级都有、不可能漂 |

**第 2 轮里我驳回的三处，本轮 codex 的复核结果：**

- **拆两把闸（驳"禁止嵌套 runNode"）** → 确认方向正确、依赖图无环、FIFO 交接不会饿死；问题只在取得时机与持有区间（已修）。
- **`rejectedReason` 的理由** → **codex 承认上一轮理由错了**，我读对了：它是 attempt 级"产出为何被契约拒绝"，生产者就是 reask 分支那个 `bad`（`1658`）。只补一条表述：它与 `turn.error` 语义重复但**不保证字节相同**（预算耗尽时 `error` 还会追加"没能打回重说"后缀）——不影响删轮级副本。
- **回放拒绝不转 live** → 确认与既有 `runNode` 完全一致，代价应当接受，并给出了分波三条写法（已写进 §4）。

**三样"能不能删"的结论：`callback_error` / `_scopeGate` / `attempts[]` 都不能删**，各自有独立消费者（区分已知编排缺陷 vs 未知后端状态 / 界长寿命会话 / 回放兜底的唯一来源）。

**关于"复审侧没能独立复跑回归"**：codex 的只读沙箱禁掉了测试用的 `mkdtemp`，在任何断言执行前就 `EPERM` 终止。**两套回归是我在本机实跑确认的**：`repro-graph-node.mjs` **74/74**、`repro-graph-worktree.mjs` **149/149**，基线冻在 `cb28aec` + `bc94972`。复审侧只静态核到 HEAD `e512615`、工作树干净、三份 `.mjs` 过 `node --check`。这条差异如实记在这里，不当成"已被第三方验证"。

---

## 10. 验收（断言必须判别）

**记忆本身**

- **记忆真的在**：两轮，第 1 轮告诉它一个只有它知道的 nonce，第 2 轮问它那个 nonce。⚠️ **必须用 nonce**——"它答得像记得"靠脑补也能过

**`runNode` 零变化**

- `repro-graph-node.mjs`（74）与 `repro-graph-worktree.mjs`（149）**全绿**，且**不许改断言来将就**（基线已冻在 `bc94972`）
- **W8 不许松动**：抽取之后重跑，活会话数仍不超 `maxConcurrent`（这条正是 v3 那次回归会打红的）
- **时钟语义没变**：T9 原样通过，且**断言那棵 worktree 被删掉了**（`openOutcome === "not-attempted"` ⇒ 可以删）
- **open 被明确拒绝时不留残骸**：造 `refused` → 断言空 worktree 与空分支都被清掉
- **旧回执仍能复用**：一张**没有 `kind` 键**的历史回执 + `reuseIfSame` → `runNode` 照常命中复用

**名额与并发**

- **嵌套不自锁**：`maxConcurrent = 1`，对话回调里跑一个 `runNode` → **必须能跑完**（测试要带自己的超时，不能靠跑挂）
- **嵌套 `conversation` 当场拒**：live 与 replay 两条路**都**抛 `UsageError`
- **对话闸懒取**：`scopeGate = 1`，对话 A 在第一次 `turn()` 之前先 await 一个可控的 promise → 断言对话 B **能够开始**（v3 那种在 prepare 取的写法这里会挂）
- **回放不占闸**：回放命中期间断言 `scopeGate` 与 `_gate` 的占用数都是 0
- **并发 turn 当场拒**：`Promise.all([turn(a), turn(b)])` → 第二个 rejected，**且没有发出任何消息、没有建任何文件**（要真查盘和真查调用，不能只看返回值）

**状态与收尾**

- **read 档成功就是 `ok`**：`access:"read"` 的单轮成功对话 → 顶层 `ok`（**不是 `unknown`**；这条正是 BLOCKER 2）
- **取最严重的那一轮**：第 1 轮 `contract_error`、第 2 轮 timeout 且 `abortConfirmed:false` → 顶层 **`timeout`**，`poisonedAfter` 指第 2 轮
- **后面的成功不遮前面的失败**：第 2 轮 `backend_failed`、第 3 轮 `ok` → 顶层 `backend_failed`
- **全轮 ok + 回调抛异常** → 顶层 `callback_error`，且随后 `reuseIfSame` **拒绝复用它**
- **轮先挂 + 回调再抛** → 顶层是那一轮的 status，**且回调异常出现在 `diagnostics` 里**
- **零轮 + 回调正常返回** → `UsageError`，且**没有开过会话、没建过 worktree、没取过任何闸**
- **零轮 + 回调抛异常** → 抛的是**回调那个异常对象**，不是零轮的 `UsageError`
- **收尾失败不吞名额**：造关会话失败 + 收工作区失败 → 断言**两把闸、锁文件、防撞键全部已释放**，且原始异常没被诊断盖掉
- **`workspace.outcome` 不明 → 顶层降 `unknown`**：即便全轮 ok
- **毒化**：造 `abortConfirmed:false` 的超时 → 断言 `sessionReusable === false`，随后 `turn()` rejected，**且没有产生任何文件、没有发出任何消息**
- **现场归属**：第 1 轮超时、第 2 轮继续并成功 → 断言存下来的 `answer.txt` 内容属于**第 1 轮**
- **`turn()` 不抛异常**：制造后端失败，断言 `turnResult.status` 有值且回调仍在继续跑
- **用法错要抛**：`key` 重复 / `key` 非法字符 / 顶层传 `timeoutMs` / 段内换 agent / `fn` 返回后再调 `turn()` / 超 `maxTurns` —— 全部 `UsageError`

**write 与复用**

- **write 一段一条分支**：三轮各改一个文件，断言**只有一条分支**、三处改动都在里面、`outcome === "delivered"`
- **回放不写回执**（BLOCKER 4）：先跑一段成功对话记下回执的 `endedAt` / `durationMs` 与文件 mtime → 回放命中 → 断言**三者一字未变**
- **回放期回调抛异常不毁缓存**：回放全部匹配但回调最后抛异常 → 断言异常被重抛，**且盘上那张回执仍是 `ok`、内容与回放前逐字节相同**
- **replay 复用**：同 key/prompt 序列 → 复用且**不开会话、不拿任何闸、不建 worktree**；改第 1 轮 prompt → 拒**整段**；改第 2 轮 prompt → 同样拒整段；少一轮/多一轮 → 拒；某一轮**最终产出**被换过 → 拒
  （**某次 attempt 的产出被换过 → 也要拒**：随 viz 施工第 5 项一起加，见 §5）
- **回放拒绝不自动重跑**：上一条每种拒绝之后，断言**没有开过会话**（证明没有偷偷转 live）

**零残留**

- 对话跑完（含异常路径、含回放路径）断言桥 pid 与后端进程都已死

---

## 11. 施工结论（2026-07-28 落地）

| 提交 | 内容 |
|---|---|
| `7b9fe76` | 抽取 `prepareRun` / `runTurn` / `settleTurn` / `finalizeRun` / `releaseRun`（`runNode` 行为零变化） |
| `6e0d0af` | `conversation()`：读档 + write 档 + replay，含 `repro-graph-conversation.mjs` 与 W26 |
| `3e423b9` | 实现复审的 3 BLOCKER + 4 MAJOR |

**实现复审分两路跑**（重构一路、新功能一路），两边各自都抓到了真问题。
**其中两条是抽取时被改掉的既有行为**——不是新功能的锅，也不是 220 条断言能发现的：

| 级别 | 发现 | 为什么全绿也发现不了 |
|---|---|---|
| MAJOR | `open_session` 丢了 `return_mode:"ref"` | 假后端产出都很小，full 与 ref 在测试里没有可观察差别。只能**直接查调用参数**（C18） |
| MAJOR | `finalizeRun` 跑到了原来那个大 catch 外面 ⇒ 收尾抛错变成「抛异常 + 没有回执」 | 收尾在假后端下从不出错。改成**直接考合同**：手搓一个 `closeSession` 必抛的 run 喂给 `finalizeRun`（C18b） |
| **BLOCKER** | 嵌套判据用桥级布尔：**兄弟对话被误判成嵌套**，先结束的又会清零标志放过真嵌套 | C11 两段对话**同 tick** 起，恰好都在标志置位前穿过检查——靠时序侥幸绿。C17 让 A 确定进入回调后再起 B，稳定复现 |
| **BLOCKER** | `promptFile` 的 TOCTOU：指纹按 A 算、发的是**路径**、桥几个 await 之后才读 ⇒ 回放把 B 的答案当 A 的复用 | 测试从不在 in-flight 时改提问文件。**这是 `runNode` 既有的洞**，抽取后两档共用一条路，一并根治 |
| **BLOCKER** | `throw null` ⇒ 落一张可复用的 `ok` 回执 | 判据写成了 `if (callbackError)`；`throw Object.create(null)` 还会让 `String(x)` 二次抛异常、把收尾拦腰打断 |
| MAJOR | `runTurn` 抛用法错时留下一条 `status:"unknown"` 的幽灵轮，污染顶层结局 | — |
| MAJOR | 忘了 await 的第二次 `turn()` 返回的 rejected promise 没人接 ⇒ Node 默认直接退进程 | — |

⚠️ **`promptFile` 那条的修法值得记**：第一版想「复制一份快照再发那个路径」，**行不通**——
桥要求 `message_file` 必须在**会话 cwd 里面**，而 read 档的 cwd 是用户工作区
（往里写盘直接破了只读承诺）、write 档的是 worktree（写进去会混进这次的 diff）。
两边都不能写，所以正确解法是**根本不发路径、发字节**：在算指纹的同一刻把正文读出来，之后一律发这份。

**回归**：`repro-graph-node` 74 + `repro-graph-worktree` 176 + `repro-graph-conversation` 137 = **387**。

### 11.1 EVENTS.md 复审又指回了实现（两条真 bug）

写 `EVENTS.md` 的「轮」那一层时，**文档复审顺着规范指回了运行时**，抓到两条 387 条断言没覆盖的：

| 提交 | 问题 | 根因（**不是措辞**） |
|---|---|---|
| `0da7d38` | 入场失败的轮把 `turnKey` **还了回去** ⇒ 同一个 key 能跑两遍 ⇒ 事件流里两条 `node:turn{turnKey}`，第一条永远等不到终态，页面按 key 建 map 会盖掉它 | **两种失败被当成了一种**：`normalizeTurn` 抛（key 还没登记、一个事件都没发）⇒ 这轮从未存在，key 可再用；`runTurn` 抛（`node:turn` 已发出）⇒ key 必须烧掉 |
| `10c232b` `67739e7` | 收尾把「调过 `turn()` 但被拒了」谎报成「回调一次都没调」，那句话里两处措辞还都是假的（"每次都死在参数校验上"、"原因:(没记到)"） | **`run` 里没有任何东西记得 `turn()` 被调用过**。`turns.length` 记的是"跑起来过几轮"，入场被拒的那几次根本不在里面——拿它反推"编排是不是空转"从一开始就推不出来 |

第二条修了两次才对：先只在 `normalizeTurn` 一处记原因，可 `turnCalls` 是在 `turn()` **最顶上**无条件 +1 的，
四道闸（`sealed`/毒化/并发/超 20 轮）与「开过头才失败」那些次都进了计数却一个字没留下。
**口径选窄了**——要回答的是「最后一次**为什么没进去**」，记的却是「最后一次**校验**错」。
现在凡是「调了 `turn()` 却没进 `turns[]`」的路径一律留痕（`lastTurnFailure`），那句话也不再替它归类。
回归：C6b（吞掉校验错）+ W28b（吞掉脏树错）。

### 11.2 编排这几波的实测量级（排下一条链时照这个给预算）

| 波 | 后端 | 实测 |
|---|---|---|
| write（1104 → 1392 行） | claude write | **38 分钟**（预算 40，只剩 2 分钟余量） |
| fix（九条裁定，1392 → 1529 行） | claude write | **超时**：98 轮 / 104k 输出 token / 39 分钟 API 时间 |
| fix2（收窄到三条，35 行） | claude write | 远低于预算 |

⚠️ **别把一波的 `timeoutMs` 原样套给下一波**。fix 波超时的根因就是我把给 write 波定的 40 分钟
原封不动拿去用了，而它的工作量更大。超时的代价不只是重跑：`outcome=delivered` 但 `artifactPath=null`
——**改动落了盘、自述丢了**，于是"它到底改完没有"只能靠验收去查。

⚠️ **收窄的修订波比宽的更容易收敛**。第一次 fix 给九条，验收判 6 条到位、3 条部分；
第二次只给三条并写明"通过的六条一个字都别碰"，35 行改完。
宽波的典型失败形状是**被点名那处改了、同义的另一处没改**——所以裁定档里每条都要跟一个具体的 `grep` 词。

**留给 viz 施工第 5 项的**：`attempts[]` 一次加两级（§5）。抽取之后 attempt 循环只剩 `runTurn` 一处，
写进 `turnRec` 就同时覆盖 `runNode` 的顶层与对话的 `turns[]`。

**hermetic 考不了的那条**：「记忆真的在」需要真后端 + nonce（假后端没有记忆，让它「记住」只能靠夹具作弊）。
`repro-graph-conversation.mjs` 的头注释里已如实写明，那条属于真 e2e。

### 11.3 「记忆真的在」已补（`e2e-graph-memory.mjs`，五后端 63 条）

三轮对话给两个随机口令、第 3 轮要它把**两个**都背出来（要两个是为了排除「只记得上一轮」），
再加**阴性对照**：同样的问题换成全新单轮节点、同一个 `cwd` 再问一遍，必须答不出来。
结构证据两条：整段对话只落**一个** `sessionId`；`contextUsage.tokens` 逐轮**增长**（cursor/kimi 恒 null，跳过）。

**第一版设计有洞，值得记**：我以为「`outDir` 放在 `cwd` 外面 = agent 够不着」。**错的**——
`read` 档带 shell，agent 能读整个文件系统，而第 3 轮的回答（两个口令）就躺在 `<outDir>/nodes/mem.t-t3.md`。
五家里只有 cursor 真去翻了，**另外四家的绿是运气，不是设计保证**——只跑 claude 就收工的话，
这条测试会一直绿着而什么都没证明。正确的不变式是**对照跑的那一刻口令不能存在于 agent 读得到的任何地方**：
产物先读进内存 → 删掉整个 `outDir` → 扫临时树 + 桥的 `STATE_ROOT` 确认零命中 → 才跑对照。

**顺带量出一条后端行为差异**：口令抹到盘上零命中之后，**cursor 的全新会话在同一个 `cwd` 下仍能召回**
上一段对话的内容；换一个 `cwd` 就召回不到 ⇒ **它的跨会话召回按 workspace 划界**。
两个后果已写进 `agent-bridge` 与 `agent-bridge-graph` 两份 SKILL：
①想靠"关会话再开一个"清上文，对 cursor 无效；②同一工作区里先后跑的 cursor 会话**不是独立的第二意见**。
⚠️ 还有一条只对 cursor 成立的限制：**这条 e2e 证不了它的「记忆来自会话」**——
第 3 轮同样可能是从同工作区历史里捞的。脚本没有把它「放过」，而是记进 `SESSION_ISOLATION` 表 + 反向断言，
cursor 哪天修好隔离会当场变红。
