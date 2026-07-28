# agent-bridge-graph:多轮对话（可选的记忆）—— 方案设计

**日期** 2026-07-28 · **修订 v3** · **状态** 提案，待评审
**关联** `skills/agent-bridge-graph/tools/node-core.mjs`、`docs/DESIGN-graph-viz-2026-07-26.md`（viz 的「轮」事件依赖本文档）

> **v3**：codex 复审 v2 判 CHANGES-REQUIRED（4 BLOCKER + 2 MAJOR）。四条 BLOCKER 全部成立，逐条落点见 §9。
> 其中两条打穿了 v2 的隐藏假设：
> ① **"拿闸时起钟"在对话里根本无法实现**——顶层 spec 没有 `timeoutMs`，那个数字要到第一次 `turn()` 才出现。
> ② **"整段持有一个并发名额"会自锁**——回调里再跑一个 `runNode` 就是等自己手里那把闸。而"回调里跑别的节点"恰恰是这功能的头号用法（复审在两轮之间）。
> MAJOR 里 `rejectedReason` 那条**结论认、理由驳**（§9）。

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
| **对话名额被整段持有** | 见 §1.1。执行名额只在轮期间占，但**对话名额**（会话活着这件事）整段占 |
| **复用是整段的，且要重放** | 见 §4 |

### 1.1 名额要拆成两把闸（v3 定，BLOCKER）

v2 写的是"对话活着就占一个 slot"，而 §4 又写"回调里的 `runNode` 各自撞自己的闸"。**这两句放一起就是死锁**：

```
conversation 持有 slot → 回调 await runNode → runNode 等 slot → 回调不返回 → conversation 不释放 slot
```

`maxConcurrent = 1` 时必然死锁；`maxConcurrent = N` 时 N 段对话同时进嵌套节点也全部死锁。
更坏的是**回放路径不持真实名额**，于是同一段编排 live 卡死、replay 通过——最难查的那种不一致。

⚠️ **不能靠"禁止回调里跑别的节点"绕过去。** 那条禁令会杀掉这功能的头号用法：复审必须发生在两轮**之间**（第 2 轮的提问就是照着复审意见写的）。禁掉嵌套，这个 API 就只剩"同一个 agent 自言自语"。

**定死：两把独立的闸，语义不同、不许合并。**

| 闸 | 界什么 | 谁持有、持有多久 |
|---|---|---|
| **执行闸** `_gate`（今天这把，默认 4） | 同时有几轮**正在烧后端** | 每一轮从 admit 到该轮结束。`runNode` = N=1 ⇒ **与今天逐字节相同** |
| **对话闸** `_scopeGate`（新，默认同值） | 同时有几个**会话活着** | 一段对话从 prepare 到收尾 |

- 回调运行期间（轮与轮之间）对话**不持执行闸** ⇒ 嵌套 `runNode` 拿得到，不自锁。
- 嵌套 `runNode` 只要执行闸，不要对话闸 ⇒ 依赖图无环。
- ⚠️ **嵌套 `conversation()` 一律 `UsageError`**：它要对话闸，那才会成环。这条**在 live 与 replay 两条路上判据完全一致**，不许一边禁一边放。
- 为什么必须是两把而不是一把开大：它们界的是两种不同的资源——执行闸界 CPU/后端并发，对话闸界**同时活着的后端会话数**。合成一把，要么嵌套死锁，要么活会话数无上限（开 20 段对话 = 20 个常驻后端）。

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

### 2.1 时钟：**每一轮在自己被 admit 时起钟；②挂在第一轮上**（v3 重写，BLOCKER）

v2 定的是"`startClock()` 在拿到并发闸那一刻起算，第一轮继承这口钟"。**这在对话里无法实现**：顶层 spec 没有 `timeoutMs`，那个数字要到第一次 `turn({timeoutMs})` 才出现；而 v2 又把拿闸/建 worktree/开会话放在 `prepare`——**拿闸的那一刻，实现根本不知道预算是多少**。

连带的第二个洞：prepare 期间预算耗尽或 open 失败**无处归类**。不调回调就与"零轮报 `UsageError`"打架；先开会话再进第一轮，T9 断言的 `sessionId === null` 当场失守。

**定死一条规矩，两条路共用：**

> **入场（②）延到第一次 `turn()` 被调用时才发生。** 每一轮的顺序是：
> **拿执行闸（排队不计入预算）→ 用本轮 `timeoutMs` 起钟 → （仅首轮）脏树复查 → worktree → open_session → send**。

- `runNode` = 只有第一轮，且那一轮的 `timeoutMs` 就是 `spec.timeoutMs` ⇒ **与今天逐字节相同的因果顺序**（源码 `1296-1313`：拿闸 → `startClock()` → 脏树复查 → `createWorktree` → 开会话）。不需要任何兼容分支。
- setup 花在第一轮的预算里 ⇒ **与 `runNode` 今天的口径完全一致**：setup 花光预算，第一轮就超时。这是现在的行为，不是新规则。T9 原样成立（预算耗尽时还没走到 `open_session`）。
- `prepare` 里只剩**不需要预算的本地动作**：`normalizeSpec` / 建目录 / 进程内防撞键 / 锁文件 / 仓库体检 + 第一次脏树查 / 幂等闸或回放闸 / 拿**对话闸**。这些今天也全在并发闸之前（源码 `1149-1294`）。
- **零轮 ⇒ 从没拿过执行闸、没建 worktree、没开会话**。收尾因此是平凡的（§7）。
- ⚠️ **顶层 spec 传 `timeoutMs` 一律 `UsageError`**。多一个顶层预算就多一处"两个预算谁管谁"的解释，而上面这条规矩已经够用。**同理不引入 `setupTimeoutMs`。**

### 2.2 `main` 轮到旧回执顶层字段的兼容投影（v3 收窄，BLOCKER）

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
| `saveScene()` 是会话级、且延后取 | **改成 turn-scoped，且立刻取**（§3.2） |
| 拿闸 / 起钟 / worktree / open 在 `runNode` 函数体里线性排开 | 搬进 `runTurn` 的**首轮入场**分支（§2.1） |

### 2.4 顶层状态的优先级：轮不是唯一的输入（v3 新增，BLOCKER）

v2 的 §5 把顶层状态定成"全轮 ok / 否则第一个非 ok 轮"，**漏了三类结局**，而其中一类今天就是关键语义：

- 源码 `1458-1469`：`workspace.outcome` 不是 `delivered`/`no-changes` 时，**无条件**把 `status` 降成 `unknown`——理由写在那儿：`backend_failed`/`timeout` 在本工具的契约里是"可以安全换个人重跑"，而重跑常带 `force`，`force` 会删掉那棵**正因为说不清才被保留**的工作树。
- 源码 `1478`：回执落盘失败也降 `unknown`。
- **全轮 ok 但回调自己抛异常**：按 v2 会落一张 `status:"ok"` 的回执，还能过复用闸——等于把一次崩掉的编排当成功缓存起来。

**定死优先级（从低到高，后者改写前者）：**

| # | 判据 | 结果 |
|---|---|---|
| 1 | 全部轮 `ok` | `ok` |
| 2 | 有非 ok 的轮 | **第一个**非 ok 轮的 status（不取最后一轮：那会让"第 2 轮挂了、第 3 轮碰巧成了"报成功） |
| 3 | 回调抛了异常，**且**此刻 status 仍是 `ok` | `callback_error`（对话独有；`runNode` 不可能产生它） |
| 4 | `workspace.outcome` 不是 `delivered`/`no-changes` | `unknown`（沿用源码 `1458` 那段，一字不改） |
| 5 | 回执写入失败 | `unknown`（沿用源码 `1478`） |

- 第 3 条**只在 status 还是 `ok` 时**生效：轮先挂了、回调因此抛（`r1.text.trim()` 之类）时，轮的 status 更接近根因，不许被 `callback_error` 盖掉。
- `callback_error` ≠ `ok` ⇒ **复用闸自然拒绝它**，不需要额外规则。
- ⚠️ **顶层 status 怎么变，都不改变"原始异常原样重抛"**（§7）。回执是记录，异常是控制流，两回事。

---

## 3. 会话还能不能接着用：串行闸、`sessionReusable` 与「毒化」

### 3.1 同一时刻只许有一轮（v3 新增，BLOCKER）

`Promise.all([turn(a), turn(b)])` 会让两轮在第一轮还没产出任何结论之前**同时通过毒化 guard**，随后两边向同一个 session `send`——正是要消灭的东西。§8 只写"不做并发"是**调用纪律，不是判据**。

**定死：`turn()` 的第一件事是同步的串行闸。**

> 该段对话已有一轮在途 ⇒ 立刻 `UsageError`，**且这一步排在任何 `await` 之前**——占 key、建产出文件、发事件、拿闸、起钟、发消息，一件都还没发生。

JS 单线程，函数入口处的"查+置位"之间没有让出点，所以这道闸是原子的。**判据放在工具里，不是写在 SKILL 里请人自觉。**

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
- 回执里 `poisonedAfter` = 毒化那一轮的 `key`

### 3.3 现场必须**当轮**冻结，不能延到整段收尾

v1 说"最后保存第一个非 ok 轮的现场"。**那会保存错轮的现场**：桥的 `answerFile` / `textRef` 是**会话级的单一路径**，每轮结果覆盖同一个文件。第 1 轮超时、第 2 轮继续跑完之后再去取，拿到的 `answer.txt` / `status.json` **属于第 2 轮**，却被标成"第 1 轮失败的现场"。

**定死：某一轮非 `ok` 时，在下一次 `send` 之前立刻冻结它自己的现场。**

- 对话：`nodes/<id>.t-<key>.scene/`（turn-scoped）
- `runNode`（N=1）：**仍投影到 `nodes/<id>.scene`**，保证 T2/T3 逐字节不变
- 整段 finalize 只负责：关会话 → 收工作区 → 写回执。**不再补取现场**

---

## 4. 复用：replay validation

v1 的 `lineageHash` 在 callback 式 API 下**没有可执行判据**：调 `fn` 之前不知道轮序列，调了才知道——而"调"本身就把副作用跑了一遍。

**定死：走 replay validation。**

> `reuseIfSame` 且已有一张合格的旧回执时：**不拿执行闸、不建会话、不建 worktree**。回调照常执行，每个 `turn()` **不发任何消息**，而是拿本轮参数与旧回执里对应的那一轮**逐项比对**，一致就直接返回旧的 `turnResult`。`fn` 返回时要求**恰好消费完全部轮次**——多一轮、少一轮、顺序不同，全部拒绝整段。

**每轮的指纹必须覆盖**：

```
turnSpecHash = H(key, prompt 正文, timeoutMs, schema, outputShape, reask)
```

**复用闸（逐项，缺一即 `UsageError`）：**

回执存在且 `receiptVersion` 对得上 → `kind === "conversation"` → `specHash` 一致 → 顶层 `status === "ok"` →（write 再加：主树干净、`baseCommit` 未变、按 `workspace.outcome` **字面量**分派，沿用 `runNode` 那套一字不改）→ 进回放：每轮 `turnSpecHash` 一致、该轮产出文件存在且 SHA 与回执一致 → `fn` 返回后恰好消费完全部轮次。

- ⚠️ **`kind` 这道闸只属于 `conversation()`。** `runNode()` 的复用闸**不许开始查 `kind`**——历史回执没有这个键，加上去等于把所有旧回执一次判死。**按调用的是哪个 API 分派，不按回执里有没有某个字段分派。**
- ⚠️ **少一项就拒绝，不是跳过。** 按 `kind` 的字面量分派，结构上就没有"跳过"这条路——**"字段缺失＝静默跳过校验"这个坑本仓踩过三次**。
- ⚠️ **删掉 v2 的 `conversationHash`**：它完全由 `specHash` + 逐轮 `turnSpecHash` + 逐轮 `artifactSha256` + 轮序列派生，而这四样上面每一样都已经逐项强制校验过。留着它只是让被验的一方多出示一张自己算的成绩单。**没有独立消费者的字段，本仓已经栽过好几次**（`pid` / `archiveRef` / `halt` / `BoundedSummary.name`）。同理 v1 那个逐轮累计的 `lineageHash(k)` 也早已删掉。

**不匹配之后怎么办：响亮失败，不静默转 live。**

任一闸不过 → `UsageError`。**不会"那就重新跑一遍"**——这不是新规矩，**这就是 `runNode` 今天的口径**（源码 `1162-1293`：版本不对、`specHash` 变了、上次不是 ok、产出被换过、基线漂了、分支没了……每一条都是 `throw new UsageError`，从来没有一条是回退去重跑）。要重跑请加 `force`，或换个 `id`。

**回放的副作用边界（v3 补，MAJOR）：**

- 工具在回放期间**承诺**的只有：不拿执行闸、不建 worktree、不开会话、不发任何消息。
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
      "abortConfirmed": null, "scene": null, "error": null },
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
- **轮级不设 `rejectedReason`**：契约打回的原因就是那一轮的 `error`，再放一份是第二个副本（§9）
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
  其中 `attempts[]` 就是 viz 现有的那份兜底摘要（含 attempt 级的 `rejectedReason?`）**搬到轮下面**，每轮 ≤2 项 ⇒ 全节点 ≤40 项，仍然有界。
  ⚠️ **轮级不再另设 `rejectedReason`**——它就是本轮最后一次 attempt 的那个值，第二个副本（§9）
- ⚠️ **复用命中只发 `node:settled{execution:"reused"}` 的历史摘要**，**不伪造**本次并未发生的 `node:turn` 开始事件——页面上"这一轮什么时候开始的"必须是真的发生过

⚠️ **单轮节点不是特例，是 N=1**。别为它留一条"没有 turn 的旧路径"——两条路径迟早漂。`runNode` 产出的事件流里同样有 `node:turn{key:"main"}`。

---

## 7. 作用域的所有权与收尾协议（v3 重写，BLOCKER）

`conversation()` 拥有：对话闸名额、会话、worktree、锁文件、进程内防撞键、产出目录。（执行闸名额**不由它持有**，见 §1.1。）

**收尾是一条固定的八步，每一步各自 try/catch，前一步失败绝不跳过后面的步骤：**

| # | 动作 | 它自己失败了怎么办 |
|---|---|---|
| ① | **封 admission**（同步置位；之后任何 `turn()` 立刻 rejected） | 不会失败 |
| ② | **排空在途轮**：等那一轮自然结束（它有自己的钟，必然终止） | 记 diagnostics，继续 |
| ③ | **关会话** | `closeConfirmed=false` + diagnostics，继续。⚠️ 关不掉可能意味着后端还活着，于是④必须保留 worktree |
| ④ | **按 `outcome` 收工作区** | 记 diagnostics + 按 §2.4 第 4 条降 `unknown`，继续。收不掉 ⇒ 树与分支留在盘上（这是**故意**的，路径进 diagnostics） |
| ⑤ | **定顶层 status**（§2.4）+ `endedAt` / `durationMs` | 不会失败 |
| ⑥ | **原子写回执** | 按 §2.4 第 5 条降 `unknown`，继续。⚠️ 写不下去 = 这次没有 canonical 回执，下次无法据它做幂等判断 |
| ⑦ | **无条件释放**：执行闸（若仍持有）→ 对话闸 → 进程内防撞键 → 锁文件 | 各自 try/catch。**这一步一件都不许漏**——漏了下一段对话永远起不来 |
| ⑧ | **若回调抛过异常：原样重抛那个异常对象** | ③④⑥ 的抱怨一律只进 `diagnostics`，**绝不替换它** |

**四条路都走这八步：**

- **① 回调正常返回** —— 八步走完，返回回执。
- **② 回调抛异常** —— 八步走完，第⑧步重抛**原始异常**。
- **③ `fn` 返回之后迟到的 `turn()`**（回调里 `setTimeout` 了一下之类）—— 第①步已经封了，返回 rejected Promise，**不产生任何事件、文件、消息**。
- **④ 进程被强杀** —— **不承诺统一收尾**：JS 的 `finally` 不运行。会话与后端只能靠桥的 EOF / OS 兜底，**worktree 与 `.lock` 可能残留、终态回执不会产生**。这条**如实写进 SKILL**，并给出人工恢复办法（`git worktree remove --force` + 删锁文件）。**不为它做持久 lease / crash recovery**——那是另一个量级的机制，而这条边界 viz 设计里已经接受过一次。

**零轮**（`fn` 一次 `turn()` 都没调）：

- 因为入场是懒的（§2.1），此时**从没拿过执行闸、没建 worktree、没开过会话**，③④ 是空操作。
- **回调正常返回** ⇒ 收完资源后报 `UsageError`。**不写空回执**（一张 `turns: []` 的回执会让复用闸面对一个没有任何判据的对象）。
- **回调抛了异常** ⇒ **抛回调那个异常，不是零轮的 `UsageError`**。⚠️ v2 这两条规则直接打架；根因说清楚就不再冲突：**零轮检查是"你什么都没干"的兜底诊断，而回调已经抛出的异常才是根因，兜底不许盖根因。**

⚠️ **一个如实写明的既有缺口**：调用方**忘了 `await`** `conversation()` 本身时，`withBridge` 会在它跑完之前关桥。这与今天忘了 await `runNode` 是**同一个**缺口——`withBridge` 目前没有 in-flight 登记表（那是 viz 施工第 3 步要加的东西）。**本方案不假装解决它**，只保证 `conversation()` 自己 resolve 之前把它拥有的东西全收完。

---

## 8. 明确不做

- **不做部分复用**（§4）
- **回放拒绝之后不自动转 live 重跑**（§4：与 `runNode` 复用闸同一口径，响亮失败）
- **不做跨 `withBridge` 的对话**：会话活在桥进程里，桥没了对话就没了。分波要延续 → 复用整段（§4）
- **不做 `runNode` 的 `keepSession` 标志**（§1：谁收尾说不清）
- **不做一段对话内换 agent / model / access / cwd**：全是 `open_session` 的参数，钉死在开会话那一刻。要换 → 另起一段对话
- **不做轮与轮之间的并发**：由 §3.1 的串行闸**强制**，不是纪律
- **不做嵌套 `conversation()`**（§1.1：会在对话闸上成环）。嵌套 `runNode` **支持**，那是头号用法
- **不做强杀后的自动恢复**（§7④）
- **顶层不接受 `timeoutMs`，也不引入 `setupTimeoutMs`**（§2.1）

---

## 9. codex 复审 v2 的落点（4 BLOCKER + 2 MAJOR）

| 级别 | 发现 | 裁定 | 修在 |
|---|---|---|---|
| **BLOCKER** | "拿闸时起钟"在对话里无法实现：顶层 spec 没有 `timeoutMs`，而拿闸/worktree/open 都在 `prepare` 里 | **认** | §2.1 改成**懒入场**：拿闸/起钟/worktree/open 全延到第一次 `turn()`。`runNode` 因 N=1 而因果顺序逐字节不变（源码 `1296-1313`） |
| **BLOCKER** | 状态模型只定义了轮的结局，漏了 prepare / callback / finalize；`finalizeWorktree` 的降级权被"顶层投影自 main 轮"抹掉 | **认**（源码 `1458` / `1478` 确认降级是无条件的） | §2.4 五级优先级 + §2.2 把投影收窄到内容字段 + §7 逐步隔离的八步收尾 |
| **BLOCKER** | 对话整段持名额 + 回调里嵌套 `runNode` = 自锁；且 replay 不持真名额 ⇒ live/replay 不一致 | **认问题；驳 remedy** —— codex 给的两个选项是"禁止嵌套"或"重设名额所有权"，**禁止嵌套会杀掉头号用法**（复审必须发生在两轮之间） | §1.1 拆成**执行闸 + 对话闸**两把：轮期间才占执行闸 ⇒ 嵌套 `runNode` 拿得到；嵌套 `conversation` 禁掉（它才成环），live/replay 判据一致 |
| **BLOCKER** | 毒化 guard 挡不住 `Promise.all([turn(a), turn(b)])` 的并发 admission | **认** | §3.1 在 `turn()` 入口加**同步**串行闸，排在任何 `await` 与任何副作用之前 |
| MAJOR | replay rejection 不是事务：回调副作用可在判失败前发生，无法回滚 | **认，并收窄** | §4 写死"拒绝＝不接受复用，不是回滚"+ 回放回调必须可重放（嵌套用 `reuseIfSame`、禁 `force`）+ 恰好消费检查排在封 admission、排空之后 + 原始异常优先 |
| MAJOR | 删 `conversationHash` 与 `rejectedReason` | `conversationHash` **认**（确实完全派生、无独立消费者）；`rejectedReason` **结论认、理由驳** | §4 删 `conversationHash`；§5/§6 删**轮级**的 `rejectedReason` |

**驳回的那半条，理由写清楚：** codex 说 `rejectedReason` "没有生产路径，因为用法错/毒化/超 `maxTurns` 都在 admission 前抛异常，不会进 `turns[]`"。**这是把它读成了"这一轮被拒绝的原因"。** 它实际是 **attempt 级的「产出被契约打回的原因」**（viz 设计 §3.3 `node:attempt-settled` 的 `rejectedReason?`，对应源码里那个 `bad` 字符串），生产路径就是 `contract_error`，一直都在。
——但**删的结论仍然成立，换一条理由**：在**轮**这一级它与 `turns[].error` 是同一个字符串的第二份副本。所以删轮级的、**保留 attempt 级的**（后者搬到 `TurnSummary.attempts[]` 下面）。

**codex 另外两条附注，都采纳：**

- 收尾顺序必须保持 `abort（若需要）→ 当轮 scene → close_session → finalizeWorktree → 顶层 duration/status → 回执` —— 与源码 `1418-1482` 一致，§7 的八步就是它。
- **legacy `runNode` 的复用仍按 API 模式分派，不能因为回执缺 `kind` 就被对话的闸误拒** —— 已写进 §4 的加粗警告。

**关于"本轮没能独立复跑 74/74 + 149/149"**：codex 的只读沙箱禁掉了测试用的 `mkdtemp`，在任何断言执行前就 `EPERM` 终止。**这两套回归是我在本机跑过的**（基线冻在 `cb28aec` + `bc94972`）；复审侧只静态核到三份 `.mjs` 过 `node --check`、工作树干净。这条差异如实记在这里，不当成"已被第三方验证"。

---

## 10. 验收（断言必须判别）

**记忆本身**

- **记忆真的在**：两轮，第 1 轮告诉它一个只有它知道的 nonce，第 2 轮问它那个 nonce。⚠️ **必须用 nonce**——"它答得像记得"靠脑补也能过

**`runNode` 零变化**

- `repro-graph-node.mjs`（74）与 `repro-graph-worktree.mjs`（149）**全绿**，且**不许改断言来将就**（基线已冻在 `bc94972`）
- **时钟语义没变**：T9 原样通过（`timeoutMs` 极小的节点，预算耗尽时**不该**已经有 sessionId）
- **旧回执仍能复用**：一张**没有 `kind` 键**的历史回执 + `reuseIfSame` → `runNode` 照常命中复用（防止 `kind` 闸渗进旧路径）

**名额与并发**

- **嵌套不自锁**：`maxConcurrent = 1`，对话回调里跑一个 `runNode` → **必须能跑完**（这条一旦回归就是死锁，测试要带自己的超时，不能靠跑挂）
- **嵌套 `conversation` 当场拒**：live 与 replay 两条路**都**抛 `UsageError`
- **对话闸真的在界会话数**：对话闸设 1 时，第二段对话在第一段收尾前拿不到名额
- **并发 turn 当场拒**：`Promise.all([turn(a), turn(b)])` → 第二个 rejected，**且没有发出任何消息、没有建任何文件**（要真查盘和真查调用，不能只看返回值）

**状态与收尾**

- **一轮失败不吞后续**：第 1 轮 `contract_error`（`sessionReusable:true`），回调选择继续 → 第 2 轮照常跑；断言节点级 status 是**第一个**非 ok 的那个
- **全轮 ok + 回调抛异常** → 顶层 status 是 `callback_error`（**不是 ok**），且随后用 `reuseIfSame` **拒绝复用它**
- **轮先挂 + 回调再抛** → 顶层 status 是那一轮的 status，**不是** `callback_error`
- **零轮 + 回调正常返回** → `UsageError`，且**没有开过会话、没建过 worktree**（懒入场的直接证据）
- **零轮 + 回调抛异常** → 抛的是**回调那个异常对象**，不是零轮的 `UsageError`
- **收尾失败不吞名额**：造一个关会话失败 + 收工作区失败 → 断言**执行闸、对话闸、锁文件、防撞键全部已释放**（下一段对话起得来），且原始异常没被诊断盖掉
- **`workspace.outcome` 不明 → 顶层降 `unknown`**：即便全轮 ok
- **毒化**：造 `abortConfirmed:false` 的超时 → 断言 `sessionReusable === false`，随后 `turn()` rejected，**且没有产生任何文件、没有发出任何消息**
- **现场归属**：第 1 轮超时、第 2 轮继续并成功 → 断言存下来的 `answer.txt` 内容属于**第 1 轮**
- **`turn()` 不抛异常**：制造后端失败，断言 `turnResult.status` 有值且回调仍在继续跑
- **用法错要抛**：`key` 重复 / `key` 非法字符 / 顶层传 `timeoutMs` / 段内换 agent / `fn` 返回后再调 `turn()` / 超 `maxTurns` —— 全部 `UsageError`

**write 与复用**

- **write 一段一条分支**：三轮各改一个文件，断言**只有一条分支**、三处改动都在里面、`outcome === "delivered"`
- **replay 复用**：同 key/prompt 序列 → 复用且**不开会话、不拿执行闸、不建 worktree**（真查这三样）；改第 1 轮 prompt → 拒**整段**；改第 2 轮 prompt → 同样拒整段；少一轮/多一轮 → 拒；某一轮产出文件被换过 → 当场拒
- **回放拒绝不自动重跑**：上一条每种拒绝之后，断言**没有开过会话**（证明没有偷偷转 live）

**零残留**

- 对话跑完（含异常路径、含回放路径）断言桥 pid 与后端进程都已死
