# agent-bridge-graph:多轮对话（可选的记忆）—— 方案设计

**日期** 2026-07-28 · **修订 v2** · **状态** 提案，待评审
**关联** `skills/agent-bridge-graph/tools/node-core.mjs`、`docs/DESIGN-graph-viz-2026-07-26.md`（viz 的「轮」事件依赖本文档）

> **v2**：codex 复审 v1 判 CHANGES-REQUIRED（4 BLOCKER + 3 MAJOR），全部成立。
> 其中一条把 v1 一个隐藏假设打穿了：**超时之后不能无条件把会话交回去接着聊**——`abortConfirmed:false` 时上一轮**可能还在后台跑**，再 `send` 就是同一会话并发。
> 另有一条抓出的是**仓库既有缺陷而非本方案的**：回归里"v1 拒绝 `access:write`"是假绿。已单独修掉并冻住基线（`cb28aec` / `bc94972`，74/74 + 149/149）。逐条落点见 §9。

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
  async (turn) => {
    const r1 = await turn({ key: "draft", prompt: FIRST, timeoutMs: 2_400_000 });
    if (!r1.sessionReusable) return;                     // ← 见 §3
    const r2 = await turn({ key: "fix", prompt: FIX, timeoutMs: 2_400_000 });
    //   r2 记得 r1 说过什么
  },
);
```

### 三个代价，都要写进 SKILL

| 代价 | 说明 |
|---|---|
| **一段对话 = 一条分支** | N 轮共享一棵 worktree，收尾时提交**一次**。这对"反复修同一份东西"更干净，但它不能再当 N 个独立可合并的产出用 |
| **并发名额被整段持有** | 对话活着就占一个 slot，**包括你在轮与轮之间去干别的那段时间**。默认 4 个名额，心里有数 |
| **复用是整段的，且要重放** | 见 §4 |

---

## 2. 重构：把「一轮」从「一个节点」里抽出来

`runNode` 现在是一个 650 行的函数，把**四件事**缝在一起：

```
① 准备   normalizeSpec → 进程内防撞 → 锁文件 → 幂等/复用闸 → 并发闸 → (write)脏树+worktree
② 开会话 open_session(cwd = worktree ?? spec.cwd)
③ 一轮   send → wait 切片 → 弱检查/schema → 不合格则 reask(≤1) → 复制产出 → 算 SHA
④ 收尾   saveScene → close_session → finalizeWorktree → 原子写回执
```

`conversation` 要的是 **①②③③③…④**。所以把 ③ 抽出来：

```js
prepareRun(bridge, spec)                                             → run
runTurn(run, { key, prompt, timeoutMs, outputShape, schema, reask }) → turnResult
finalizeRun(run, status, extra)                                      → receipt
```

- `runNode(bridge, spec)` = `prepare` → `runTurn` ×1 → `finalize`（**外部行为一个字不变**）
- `conversation(bridge, spec, fn)` = `prepare` → 把 `turn` 交给 `fn` → `finalize`

⚠️ **绝不允许把 ③ 复制一份给 conversation 用。** "同一件事两处各写一遍，迟早漂成两种行为"——这个仓库在 `artifactSha256` / `diffPath` / `committed` 上已经栽过**三次**，都是同一个形状。

### 2.1 时钟：**只有一条规矩，`runNode` 是它的 N=1**（v2 定，BLOCKER）

v1 说"把时钟移进 turn"，那会改掉现有语义并**当场打红 T9**：现在 `startClock()` 在**拿到并发闸之后、建 worktree 与开会话之前**起算，所以 worktree/open/send/wait/reask **共用同一个总预算**。移走之后，一个 `timeoutMs: 1` 的节点会先把会话开起来再开始计时，而 T9 断言的正是"预算耗尽时**不该**已经有 sessionId"。

**定死一条规矩，两条路共用：**

> `startClock()` 在拿到并发闸那一刻起算。**第一轮继承这口钟**（于是 worktree 与 open_session 都花在第一轮的预算里）；**第二轮起，每轮在自己的 `turn()` 被调用时另起一口钟**，各自 `timeoutMs`。

- `runNode` = 只有第一轮 ⇒ **行为与今天逐字节相同**，不需要任何兼容分支。
- 对话的 setup 成本落在第一轮，**与 `runNode` 今天的口径完全一致**：setup 花光了预算，第一轮就超时——这正是现在的行为，不是新规则。
- ⚠️ **不引入 `setupTimeoutMs` 这类新旋钮**：多一个旋钮就多一处"两个预算谁管谁"的解释，而上面这条规矩已经够用。

### 2.2 `main` 轮到旧回执顶层字段的兼容投影（v2 补，BLOCKER）

抽取之后 `runNode` 的那一轮内部叫 `key: "main"`，但**回执的顶层字段一个都不许变形**，否则 T2/T3 与既有调用方全要改：

| 顶层字段 | 投影自 |
|---|---|
| `artifactPath` | `main` 轮的产出，**路径仍是 `nodes/<id>.md`**（不是 `nodes/<id>.t-main.md`） |
| `abortConfirmed` / `reaskCount` / `charCount` / `byteCount` / `artifactSha256` / `contextUsage` / `error` | `main` 轮的同名字段 |
| `scene` | `main` 轮的 scene，**目录仍是 `nodes/<id>.scene`** |
| `durationMs` | 整个节点（含 setup），与今天一致 |

⚠️ **`runNode` 的回执里不出现 `turns[]`、也不出现 `kind`**——它就是今天那张回执。`turns[]` 只属于 `kind:"conversation"` 的回执（§5）。**新字段一律不许渗进旧形状**，那是既有调用方与 `reuseIfSame` 的合同。

### 2.3 抽取时其余几处必须小心

| 现状 | 抽取后 |
|---|---|
| `finish()` 同时干"结束这一轮"和"结束这个节点" | 拆开。**turn 结束不关会话、不收工作区**；节点结束才收 |
| `finishTimeout()` abort 之后直接 `finish("timeout")` | abort 之后**只结束这一轮**，并据 `abortConfirmed` 决定会话还能不能用（§3） |
| `saveScene()` 是会话级、且延后取 | **改成 turn-scoped，且立刻取**（§3.2） |

---

## 3. 会话还能不能接着用：`sessionReusable` 与「毒化」（v2 新增，BLOCKER）

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

- 后续任何 `turn()` 返回 **rejected Promise**（`UsageError`），且**在占用 key、建产出文件、发任何消息之前**就拒
- ⚠️ **不是"回调应该自觉别调"**——判据放在工具里，因为回调是任意 JS，而这条一旦破了是**两个 turn 在同一会话里并发**，后果远超"回调写得不好"
- 毒化之后 `fn` 继续跑完（它可能还要做别的），作用域退出时照常收尾

### 3.2 现场必须**当轮**冻结，不能延到整段收尾（v2 修，MAJOR）

v1 说"最后保存第一个非 ok 轮的现场"。**那会保存错轮的现场**：桥的 `answerFile` / `textRef` 是**会话级的单一路径**，每轮结果覆盖同一个文件。第 1 轮超时、第 2 轮继续跑完之后再去取，拿到的 `answer.txt` / `status.json` **属于第 2 轮**，却被标成"第 1 轮失败的现场"。

**定死：某一轮非 `ok` 时，在**下一次 `send` 之前**立刻冻结它自己的现场。**

- 对话：`nodes/<id>.t-<key>.scene/`（turn-scoped）
- `runNode`（N=1）：**仍投影到 `nodes/<id>.scene`**，保证 T2/T3 逐字节不变
- 整段 finalize 只负责：关会话 → 收工作区 → 写回执。**不再补取现场**

---

## 4. 复用：replay validation（v2 重写，BLOCKER）

v1 的 `lineageHash` 在 callback 式 API 下**没有可执行判据**：调 `fn` 之前不知道轮序列，调了才知道——而"调"本身就把副作用跑了一遍。v1 的哈希还漏了 `timeoutMs` / `schema` / `outputShape` / `reask`，且复用闸从没重算校验过那个哈希。

**定死：走 replay validation。**

> `reuseIfSame` 且已有一张合格的旧回执时：**不建会话、不建 worktree**。回调照常执行，每个 `turn()` **不发任何消息**，而是拿本轮参数与旧回执里对应的那一轮**逐项比对**，一致就直接返回旧的 `turnResult`。`fn` 返回时要求**恰好消费完全部轮次**——多一轮、少一轮、顺序不同，全部拒绝整段。

**为什么这条成立**：分波模式本来就是"**整段编排 JS 每一波重跑一遍**，每个节点各自撞自己的复用闸"（`templates/wave.mjs` 的全部机制）。conversation 的回调再跑一遍，与既有心智模型完全一致——回调里若还有别的 `runNode`，它们也各自撞自己的闸。

**每轮的指纹必须覆盖**（v1 漏了后四项）：

```
turnSpecHash = H(key, prompt 正文, timeoutMs, schema, outputShape, reask)
```

**整段的指纹**：

```
conversationHash = H(specHash, [ {turnSpecHash₁, artifactSha256₁}, …, {turnSpecHash_N, artifactSha256_N} ])
```

- 复用时**重算一遍并与回执里记的比对**——⚠️ 不能只信回执里那个数，那等于让被验的一方自己出示成绩单
- ⚠️ **删掉 v1 那个逐轮累计的 `lineageHash(k)`**：既然不做部分复用，它**没有任何消费者**。这套设计已经因为"没有消费者的字段"栽过好几次（`pid` / `archiveRef` / `halt` / `BoundedSummary.name`）

**复用还要过的闸**（与 `runNode` 同源，缺一不可）：回执版本对得上 → `kind === "conversation"` → `specHash` 一致 → 轮序列与每轮 `turnSpecHash` 一致 → 每轮产出文件存在且 SHA 与回执一致 → `conversationHash` 重算一致 → 顶层 `status === "ok"`；write 再加：主树干净、`baseCommit` 没变、按 `outcome` 分派。

⚠️ **少一项就拒绝，不是跳过。** 按 `kind` 的字面量分派，结构上就没有"跳过"这条路——**"字段缺失＝静默跳过校验"这个坑本仓踩过三次**。

⚠️ **不做部分复用**（前 k 轮复用、从第 k+1 轮接着聊）：那需要把后端会话的**内部状态**恢复出来，而"重放前 k 轮的文本"**不等于**"后端当时的内部状态"（模型侧的上下文、压缩、工具调用历史都不在我们手里）。**复用粒度就是整段。** 想要更细的粒度，就把对话切小。

---

## 5. 回执形状

对话的回执**仍然是一张** `nodes/<id>.receipt.json`：

```jsonc
{
  "receiptVersion": 2,
  "kind": "conversation",              // ← runNode 的回执**没有这个键**(§2.2)
  "id": "events-md", "specHash": "…", "conversationHash": "…",
  "status": "ok",                      // 全轮 ok 才是 ok;否则 = **第一个**非 ok 的轮的 status
  "poisonedAfter": null,               // 毒化时 = 那一轮的 key
  "turns": [
    { "key": "draft", "status": "ok", "sessionReusable": true,
      "turnSpecHash": "…", "artifactPath": "<outDir>/nodes/events-md.t-draft.md",
      "artifactSha256": "…", "charCount": 1234, "byteCount": 1400,
      "reaskCount": 0, "rejectedReason": null, "durationMs": 84000,
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
- **`turn()` 不抛异常**（同 `runNode`）：失败进 `turnResult.status`。只有**用法错**与**毒化后仍调用**才抛
- 节点级 `status` = 全 ok 则 `ok`，否则**第一个**非 ok 的轮的 status。⚠️ 不取"最后一轮"——那会让"第 2 轮挂了、第 3 轮碰巧成了"报成功
- **`maxTurns = 20`**，超过当场 `UsageError`。理由：`node:settled` 要内联一份有界的轮摘要（§6），而 N 无上限就顶穿事件的行上限。20 对"复审→修订"这类用法足够宽（实测 2~6 轮），**而且超了是响亮报错、不是静默截断**

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
- ⚠️ **`node:settled` 里内联的是有界的 `TurnSummary`，不是回执同形对象**（v2 修，MAJOR）：viz 的既有原则是"事件只装发生了什么 + 去哪儿找，不复制 canonical 回执"，而 N 又有上限但不小。`TurnSummary` = `{ key, status, sessionReusable, output: AssetState, turnSpecHash, charCount|null, durationMs, reaskCount, rejectedReason? }`，每项天然有界
- ⚠️ **复用命中只发 `node:settled{execution:"reused"}` 的历史摘要**，**不伪造**本次并未发生的 `node:turn` 开始事件——页面上"这一轮什么时候开始的"必须是真的发生过

⚠️ **单轮节点不是特例，是 N=1**。别为它留一条"没有 turn 的旧路径"——两条路径迟早漂。`runNode` 产出的事件流里同样有 `node:turn{key:"main"}`。

---

## 7. 作用域的所有权与收尾协议（v2 补，MAJOR）

`conversation()` 拥有：会话、worktree、锁文件、并发名额、产出目录。**四条路都要收干净：**

**① 回调正常返回**
封 turn admission → 排空**已经进入但还没 await 完**的 turn → 关会话 → 按 `outcome` 收工作区 → 写回执 → 释放并发闸 / 进程内防撞键 / 锁文件。

**② 回调抛异常**
**同① 的全部动作**，然后**原样重抛回调的原始异常**。⚠️ **收尾过程中产生的诊断不许盖掉它**——回调的异常才是根因，收尾的抱怨是次要信息，进 `diagnostics`。

**③ `fn` 返回之后迟到的 `turn()`**（回调里 `setTimeout` 了一下之类）
返回 **rejected Promise**。⚠️ **admission guard 必须排在占用 key、建产出目录、发事件、发消息之前**——与 viz 那条"封 admission 之后的迟到调用不产生任何事件"是同一类要求。

**④ 进程被强杀**
**不承诺统一收尾**：JS 的 `finally` 不运行。会话与后端只能靠桥的 EOF / OS 兜底，**worktree 与 `.lock` 可能残留、终态回执不会产生**。⚠️ 这条**如实写进 SKILL**，并给出人工恢复办法（`git worktree remove --force` + 删锁文件）。**不为它做持久 lease / crash recovery**——那是另一个量级的机制，而这条边界 viz 设计里已经接受过一次。

**零轮**：`fn` 一次 `turn()` 都没调 → 收完全部资源之后报 `UsageError`。**不写空回执**（一张 `turns: []` 的回执会让复用闸面对一个没有任何判据的对象）。

⚠️ **一个如实写明的既有缺口**：调用方**忘了 `await`** `conversation()` 本身时，`withBridge` 会在它跑完之前关桥。这与今天忘了 await `runNode` 是**同一个**缺口——`withBridge` 目前没有 in-flight 登记表（那是 viz 施工第 3 步要加的东西）。**本方案不假装解决它**，只保证 `conversation()` 自己 resolve 之前把它拥有的东西全收完。

---

## 8. 明确不做

- **不做部分复用**（§4）
- **不做跨 `withBridge` 的对话**：会话活在桥进程里，桥没了对话就没了。分波要延续 → 复用整段（§4）
- **不做 `runNode` 的 `keepSession` 标志**（§1：谁收尾说不清）
- **不做一段对话内换 agent / model / access / cwd**：全是 `open_session` 的参数，钉死在开会话那一刻。要换 → 另起一段对话
- **不做轮与轮之间的并发**：同一会话并发 `send` 会被后端拒或搅乱上下文。`turn()` 串行，**并发要开多段对话**
- **不做强杀后的自动恢复**（§7④）
- **不引入 `setupTimeoutMs`**（§2.1）

---

## 9. codex 复审 v1 的落点（4 BLOCKER + 3 MAJOR，全部成立）

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | 把时钟移进 turn 会改掉 `timeoutMs` 语义并**打红 T9**（现在 setup 就在预算里） | §2.1：一条规矩，第一轮继承闸后那口钟，`runNode` 是它的 N=1 |
| **BLOCKER** | `lineageHash` 在 callback API 下没有可执行判据；且漏了 `timeoutMs`/`schema`/`outputShape`/`reask`，复用闸从没重算过它 | §4 改为 replay validation + 补齐指纹 + 重算校验 + 删掉没有消费者的逐轮哈希 |
| **BLOCKER** | **超时/后端死亡后不能无条件把会话交回回调**：`abortConfirmed:false` 时上一轮可能还在后台跑，再 `send` 就是同一会话并发 | §3 新增 `sessionReusable` + 毒化，判据放在工具里而非靠回调自觉 |
| **BLOCKER** | §7 的"原断言不动且全绿"在干净树上不成立——T7 那条"v1 拒绝 `access:write`"是**假绿**（靠脏树闸抛错通过） | **仓库既有缺陷**，已单独修掉并冻住基线：`cb28aec`（换成 read 传 write 专属参数的真用法错）+ `bc94972`（并发判据改自校准比值）。现基线 74/74 + 149/149 |
| MAJOR | `saveScene` 延到整段 finalize 会**保存错轮的现场**（桥的 `textRef` 是会话级单一路径） | §3.2：非 ok 的轮在下一次 `send` 之前立刻冻结；`runNode` 的 N=1 仍投影到 `<id>.scene` |
| MAJOR | 作用域所有权与收尾协议没定死（四条路、迟到 turn、零轮、强杀边界、in-flight 登记） | §7 全部写死；in-flight 那条**如实写成既有缺口**，不假装解决 |
| MAJOR | `node:settled.turns[]` 与回执同形会破 1 MiB 行上限与"完整事件不可丢"不变式 | §6 改成有界 `TurnSummary` + §5 `maxTurns = 20` + 严格顺序 + `turnKey` + 轮内重置 attempt 编号 |

---

## 10. 验收（断言必须判别）

- **记忆真的在**：两轮，第 1 轮告诉它一个只有它知道的 nonce，第 2 轮问它那个 nonce。⚠️ **必须用 nonce**——"它答得像记得"靠脑补也能过
- **`runNode` 行为零变化**：`repro-graph-node.mjs`（74）与 `repro-graph-worktree.mjs`（149）**全绿**，且**不许改断言来将就**（基线已冻在 `bc94972`）
- **时钟语义没变**：T9 原样通过（`timeoutMs` 极小的节点，预算耗尽时**不该**已经有 sessionId）
- **一轮失败不吞后续**：第 1 轮 `contract_error`（`sessionReusable:true`），回调选择继续 → 第 2 轮照常跑；断言节点级 status 是**第一个**非 ok 的那个，不是最后一轮的
- **毒化**：造 `abortConfirmed:false` 的超时 → 断言 `sessionReusable === false`，且随后 `turn()` 是 rejected，**并且没有产生任何文件、没有发出任何消息**（后者要真查，不能只看返回值）
- **现场归属**：第 1 轮超时、第 2 轮继续并成功 → 断言存下来的 `answer.txt` 内容属于**第 1 轮**（这条正是复审 MAJOR 1 指出的会保存错轮）
- **`turn()` 不抛异常**：制造后端失败，断言 `turnResult.status` 有值且回调仍在继续跑
- **用法错要抛**：`key` 重复 / `key` 非法字符 / 段内换 agent / `fn` 返回后再调 `turn()` / 一轮都不调 —— 全部 `UsageError`
- **作用域退出一定收尾**：回调抛异常时断言**会话已关、worktree 已收、回执已落盘**，且**原始异常原样抛出**没被收尾诊断盖掉
- **write 一段一条分支**：三轮各改一个文件，断言**只有一条分支**、三处改动都在里面、`outcome === "delivered"`
- **replay 复用**：同 key/prompt 序列 → 复用且**不开会话**（真查有没有 open_session）；改第 1 轮 prompt → 拒**整段**；改第 2 轮 prompt → 同样拒整段；少一轮/多一轮 → 拒；产出文件被换过 → 当场拒
- **`conversationHash` 真的被重算**：手改回执里的 `conversationHash` 但内容不动 → 必须拒（证明不是只信回执里那个数）
- **零残留**：对话跑完（含异常路径）断言桥 pid 与后端进程都已死
