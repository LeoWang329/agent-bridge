# agent-bridge-graph:多轮对话（可选的记忆）—— 方案设计

**日期** 2026-07-28 · **状态** 提案，待评审
**关联** `skills/agent-bridge-graph/tools/node-core.mjs`、`docs/DESIGN-graph-viz-2026-07-26.md`（viz 的「轮」事件依赖本文档）

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
    // ← 这中间主 agent 可以去干别的(比如跑一个 codex 复审节点)
    const r2 = await turn({ key: "fix", prompt: FIX, timeoutMs: 2_400_000 });
    //   r2 记得 r1 说过什么
    return { rounds: 2 };
  },
);
```

### 三个代价，都要写进 SKILL

| 代价 | 说明 |
|---|---|
| **一段对话 = 一条分支** | N 轮共享一棵 worktree，收尾时提交**一次**。这对"反复修同一份东西"更干净，但它不能再当 N 个独立可合并的产出用 |
| **并发名额被整段持有** | 对话活着就占一个 slot，**包括你在轮与轮之间去干别的那段时间**。默认 4 个名额，心里有数 |
| **复用要按 lineage 判** | `specHash` 不够了——第 2 轮的结果取决于第 1 轮说过什么。见 §4 |

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
prepareRun(bridge, spec)                    → run   // ①②
runTurn(run, { key, prompt, timeoutMs, outputShape, schema, reask })  → turnResult  // ③
finalizeRun(run, status, extra)             → receipt  // ④
```

- `runNode(bridge, spec)` = `prepare` → `runTurn` ×1 → `finalize`（**外部行为一个字不变**）
- `conversation(bridge, spec, fn)` = `prepare` → 把 `turn` 交给 `fn` → `finalize`

⚠️ **绝不允许把 ③ 复制一份给 conversation 用。** "同一件事两处各写一遍，迟早漂成两种行为"——这个仓库在 `artifactSha256` / `diffPath` / `committed` 上已经栽过**三次**，都是同一个形状。

### 抽取时几处必须小心

| 现状 | 抽取后 |
|---|---|
| `deadline` 是**节点级**的（`startClock()` 在拿到闸之后起算） | **移进 turn**：每轮各自 `timeoutMs`，各自 `startClock`。`prepare`/`finalize` 本来就不受它约束（`finalizeWorktree` 有注释明说） |
| `finish()` 同时干"结束这一轮"和"结束这个节点" | 拆开。**turn 结束不关会话、不收工作区**；节点结束才收 |
| `finishTimeout()` abort 之后直接 `finish("timeout")` | abort 之后**只结束这一轮**（桥的语义就是"会话仍可复用"），把 `timeout` 记进该轮结果；要不要继续下一轮由回调决定 |
| `saveScene()` 取的是**会话级**现场 | 留在 `finalize`，`tag` 用**第一个非 ok 的轮**的 status |
| `receipt.durationMs` 节点级 | 保留（= 整段对话），另加 `turns[].durationMs` |

---

## 3. 回执形状

对话的回执**仍然是一张** `nodes/<id>.receipt.json`，多一个 `turns[]`：

```jsonc
{
  "receiptVersion": 2,
  "id": "events-md", "kind": "conversation",   // ← runNode 产出的是 "node"
  "specHash": "…", "lineageHash": "…",         // ← 见 §4
  "status": "ok",                               // 全轮都 ok 才是 ok;否则 = **第一个**非 ok 的轮的 status
  "turns": [
    { "key": "draft", "status": "ok", "artifactPath": "<outDir>/nodes/events-md.t-draft.md",
      "artifactSha256": "…", "promptSha256": "…", "charCount": 1234, "byteCount": 1400,
      "reaskCount": 0, "durationMs": 84000, "startedAt": "…", "endedAt": "…",
      "contextUsage": { "tokens": 51234 }, "error": null },
    { "key": "fix",   "status": "ok", "…": "…" }
  ],
  "workspace": { "outcome": "delivered", "branch": "graph/<runKey>/events-md", "…": "…" },
  "scene": null, "diagnostics": [], "sessionId": "claude-…", "closeConfirmed": true
}
```

- **每轮一个产出文件** `nodes/<id>.t-<key>.md`（`key` 只许 `[A-Za-z0-9._-]`，同一段对话内唯一）
- **`turn()` 不抛异常**（同 `runNode`）：失败进 `turnResult.status`，继续与否由回调决定。只有**用法错**才抛
- 节点级 `status` = 全 ok 则 `ok`，否则**第一个**非 ok 的轮的 status。⚠️ 不取"最后一轮"——那会让"第 2 轮挂了、第 3 轮碰巧成了"报成功

---

## 4. 复用：`lineageHash`

`specHash` 覆盖不了对话：第 2 轮的结果取决于第 1 轮说过什么、以及它答了什么。

**定死**（这是"凡是会改变执行结局的都要进指纹"这条既有判据的直接推论）：

```
lineageHash(k) = H( specHash,
                    [ {key₁, promptSha256₁, artifactSha256₁},
                      …,
                      {key_k, promptSha256_k, artifactSha256_k} ] )
```

- 每轮完成后累进一次，**写进该轮的 `turns[k]`**，最后一轮的值同时写进顶层 `lineageHash`
- `reuseIfSame` 复用一段对话，要过的闸：**回执版本对得上 → `kind === "conversation"` → `specHash` 一致 → `turns[]` 的 key 序列一致 → 每轮 `promptSha256` 一致 → 每轮产出文件存在且 SHA 与回执一致 → 顶层 `status === "ok"`**；write 还要再过既有那几道（主树干净、`baseCommit` 没变、按 `outcome` 分派）
- ⚠️ **少一项就拒绝，不是跳过**。`turns` 缺字段恰恰说明上次收尾出过问题。**"字段缺失＝静默跳过校验"这个坑本仓踩过三次**，这里按 `kind` 字面量分派，结构上就没有"跳过"这条路

⚠️ **不做「部分复用」**（前 k 轮复用、从第 k+1 轮接着聊）：那需要把后端会话的历史状态也恢复出来，而我们没有任何机制能保证"重放前 k 轮的文本 = 后端当时的内部状态"。**复用的粒度就是整段对话。** 想要更细的粒度，就把对话切小。

---

## 5. 与 viz 事件的关系（**为什么 EVENTS.md 要等这份**）

事件模型里现在一个节点只有一条命：`node:observed …→ node:settled`；而 `node:attempt` 指的是**格式打回重说**（≤1 次），**不是"轮"**。

对话引入的是**第三层**：

```
节点(node)  ──┬── 轮(turn) ──┬── 尝试(attempt)   ← 格式不合格打回重说,≤1
              │              └── 尝试
              └── 轮 ──┬── 尝试
                       └── 尝试
```

所以 EVENTS.md v1 必须直接包含：

- `node:turn` / `node:turn-settled`（**与 `node:attempt` 平级但更外层**）
- `node:attempt` 的归属从"节点"改成"轮"：payload 里带 `turnKey`
- `node:settled.turns[]`（与回执同形，恒有；单轮节点就是长度 1 的数组）
- 归档布局多一层：`<seq>-<id>/turns/<key>/`，attempt 的输入输出落在里面

⚠️ **单轮节点不是特例，是 N=1**。别为它留一条"没有 turn 的旧路径"——两条路径迟早漂。`runNode` 产出的事件流里同样有 `node:turn{key:"main"}`。

---

## 6. 明确不做

- **不做部分复用**（§4）
- **不做跨 `withBridge` 的对话**：会话活在桥进程里，桥没了对话就没了。分波要延续对话 → 复用整段（§4）
- **不做 `runNode` 的 `keepSession` 标志**（§1：谁收尾说不清）
- **不做一段对话内换 agent/model/access/cwd**：全是 `open_session` 的参数，钉死在开会话那一刻。要换 → 另起一段对话
- **不做轮与轮之间的并发**：同一会话并发 `send` 会被后端拒（codex 报 `already has a running turn`）或搅乱上下文。`turn()` 串行，**并发要开多段对话**

---

## 7. 验收（断言必须判别）

- **记忆真的在**：两轮，第 1 轮告诉它一个只有它知道的 nonce，第 2 轮问它那个 nonce。⚠️ **必须用 nonce，不能用"它答得像记得"** —— 后者靠模型脑补也能过
- **`runNode` 行为零变化**：`repro-graph-node.mjs`（61 断言）与 `repro-graph-worktree.mjs` **全绿**，且不许为了让它们过而改断言
- **一轮失败不吞后续**：第 1 轮 `contract_error`，回调选择继续 → 第 2 轮照常跑；断言节点级 status 是**第一个**非 ok 的那个，不是最后一轮的
- **turn 不抛异常**：制造后端失败，断言 `turnResult.status` 有值且回调仍在继续跑
- **用法错要抛**：`key` 重复 / `key` 非法字符 / 对话内换 agent / 在 `fn` 返回后再调 `turn()` —— 全部 `UsageError`
- **作用域退出一定收尾**：回调抛异常时，断言**会话已关、worktree 已收、回执已落盘**，且**原始异常原样抛出**（不被收尾的诊断盖掉）
- **write 一段一条分支**：三轮各改一个文件，断言**只有一条分支**、三处改动都在里面、`outcome === "delivered"`
- **lineage 复用**：同样的 key/prompt 序列 → 复用；**改掉第 1 轮的 prompt** → 拒绝（不是"只重跑第 1 轮"）；**改掉第 2 轮的 prompt** → 同样拒绝整段
- **产出被换过**：改掉 `nodes/<id>.t-draft.md` 再复用 → 当场拒绝
- **零残留**：对话跑完（含异常路径）断言桥 pid 与后端进程都已死
- ⚠️ **`turn()` 在 `fn` 返回之后仍被调用**（比如回调里 `setTimeout` 了一下）→ 必须是 rejected Promise，**且不产生任何文件**。这与 viz 那条"封 admission 之后的迟到调用"是同一类
