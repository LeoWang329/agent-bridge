# agent-bridge-graph 可视化 —— 方案设计

**日期** 2026-07-26 · **修订 v2** 2026-07-27 · **状态** 提案，待评审
**关联** `skills/agent-bridge-graph/`、`skills/agent-bridge-roundtable/EVENTS.md`、`skills/agent-bridge-loop/EVENTS.md`、`docs/PLAN-agent-bridge-session-viz-impl-2026-07-27.md`

> **v2 修订说明**：v1 写于 2026-07-26，而 `access:"write"`（worktree 隔离实施）**同日晚些时候才合入**（`d9effff`）。v1 因此把节点一律当成「输入 → 产出（一段文本）」，**完全没有覆盖写节点**——它的交付物是**分支 + diff**，不是文本。
> 同时，2026-07-27 对「委托会话史可视化」的六轮复审产出了四条直接适用于本方案的结论（§10）。
> **⚠️ v1 的所有行号引用已全部作废**——`node-core.mjs` 当日净增 776 行，实测偏移 500~800 行。v2 一律按「函数名 + 邻近唯一语句」定位。

---

## 0. 结论摘要

沿用圆桌 / loop 已跑通两轮的形态：**`EVENTS.md` 定 schema → `transcript.jsonl` 事件流 → 零依赖 `serve.mjs`（SSE，先回放后 tail）→ 单文件 `index.html`**。

graph 与那两个有**两处结构性不同**：

| | 圆桌 / loop | graph |
|---|---|---|
| 事件由谁写 | **主 agent 手写**（靠纪律，会忘） | **`node-core.mjs` 自己写**（是代码，忘不了、零 token） |
| 拓扑从哪来 | 流程写死在 SKILL 里 | **没有声明的拓扑**——skill 明确拒绝 plan/DAG 格式 |

第二条是 v1 的核心设计问题，答案仍然成立：**图不是被声明出来的，是被观测出来的**（§4）。

**v2 新增的第三处不同**：

| | 圆桌 / loop | graph（v2） |
|---|---|---|
| 节点交付什么 | 一段文本 | **read 节点交文本；write 节点交分支 + diff** |

这一条推翻了 v1 的数据模型假设，是 v2 的主要内容（§2A、§3、§5）。

**必须先补的产品缺口现在是四个**（v1 是三个），见 §2。

---

## 1. 需求拆解

| # | 需求 | 现有数据够不够 |
|---|---|---|
| R1 | 看整个 graph 图是什么样的 | ❌ 无拓扑来源（§4） |
| R2 | 有哪些节点 | ⚠️ receipt 文件名即节点 id，**但卡在并发闸上的节点在磁盘上完全不存在**（§2.4） |
| R3 | 哪些节点**正在运行** | ❌ receipt 只在节点**结束**时才写 |
| R4 | 点开节点看**输入** | ❌ prompt 从未落盘（只进了 specHash） |
| R5 | 点开节点看**输出**，按不同轮次区分 | ⚠️ 产出在，但**重说会覆盖上一轮**（§2.2） |
| **R6** | **写节点改了什么** | ❌ **v1 完全没有这条需求**（§2A） |

R3 单独否决了"viz 直接轮询 `nodes/` 目录"这个最省的方案，详见 §7。

---

## 2. 必须先补的产品缺口

这些都在 `skills/agent-bridge-graph/tools/node-core.mjs`，是**产品改动**，不是 viz 改动。

### 2A. 写节点的交付物完全不在数据模型里（R6 阻塞，**v2 新增**）

`access:"write"` 的节点跑在自己的 git worktree 里，收尾时提交到分支、导出 diff、删掉工作树。回执里的 `workspace` 是完整一族字段：

```
workspace: { mode, path, branch, baseCommit, headCommit,
             filesChanged[], diffPath, diffSha256,
             committed, removed, changesKnown, outcome, notes[] }
```

**其中 `outcome` 是唯一权威结论**（三档 `delivered` / `no-changes` / `unknown`），源码注释写得很直白：「调用方一律只看它，不各自拿 `committed`/`filesChanged` 再推一遍 —— 三处各推一遍，迟早推出三种结论」。

**viz 必须照这条纪律办：只读 `outcome`，绝不自己从 `committed` 重新推断交付与否。**

三个连带后果：

1. **`outcome` 与 `status` 是两个正交维度**，且**会互相作用**——`finish()` 在 outcome 既非 `delivered` 也非 `no-changes` 时，**把顶层 status 强制降级为 `unknown`**。所以页面上要表达的是**组合**，不是六档之一。合法组合矩阵见 §5.1。
2. **`no-changes` 是一种合法成功结局**：跑完了、成功了、**一个字都没改**。它既不是 ok（没有产出可看）也不是失败。
3. **`outcome:"unknown"` 时 worktree 被原样保留在磁盘上**，回执 `notes[]` 里带着路径与可执行命令。这是全页最该突出的状态之一——**有现场、且明令不许自动重跑**。

**改法**：`node:settled` 事件带上整个 `workspace`（`diffPath` 只放相对 ref，不放正文）。

### 2.1 输入从未落盘（R4 阻塞）

`receipt` 里有 `specHash`，但**没有 prompt 原文**，也没有角色文件内容。指纹能证明"输入没变过"，但**读不回来给人看**。

**改法**：节点开跑时写 `nodes/<id>.input.md`——完整 prompt + 角色文件内容 + 会影响结局的 spec 字段。事件里只留 `inputRef`，大文本不进 JSONL。

⚠️ **隐私口径**（v2 新增，见 §6）：这份文件落在 **`<out-dir>`，也就是仓库里的 `.graph/`，不是临时目录**。

### 2.2 重说会覆盖上一轮产出（R5 阻塞）

`artifactPath`（在 `runNode` 里定义为 `nodes/<id>.md`）是每节点**一个固定文件**，而 `copyBytes(settled.textRef, artifactPath)` 在**尝试循环内部**。于是 `reask:1` 打回重说后，第二次的产出**直接盖掉第一次**——第一次长什么样、为什么被判不合格，事后无从查证。

「按不同轮次区分」这条需求，用现在的数据**做不出来**。

**改法**：每次尝试各写 `nodes/<id>.a<N>.md`；`nodes/<id>.md` 保持现状语义（= 最终采纳的那份）。回执增加 `attempts: [{ n, artifactRef, status, rejectedReason?, durationMs, charCount }]`。

> 这也是**审计**缺口，不只是 viz 缺口。「打回重说」是 graph 少数几个自动决策之一，决策依据（第一次到底差在哪）却被自己覆盖了。

### 2.3 活进度被丢弃（R3 阻塞）

内层 wait 切片超时时（`runNode` 里读 `w.pendingSnapshots?.[0]` 那处），快照里有 `charCount` / `tail` / `status` / `lastEvent` / `contextUsage`，但**只取了 `contextUsage`，其余直接扔掉**。

**改法**：发成 `node:progress` 事件（节流：至多每 5 秒一条，`tail` 截 240 字）。**零额外 RPC**——数据已经在手里了。

### 2.4 卡在并发闸上的节点凭空消失（R2 阻塞，**v2 新增**）

`withBridge` 有并发闸（`bridge._gate.acquire()`），`maxConcurrent` **默认 4**。扇出 8 个节点时，有 4 个卡在 `acquire()` 上——它们**既没 started 也没 settled，在磁盘上和事件流里都不存在**。

页面上就是**凭空消失**：用户看到 8 个节点里只有 4 个，剩下 4 个不知去向，会误判成"卡住了"或"漏派了"。

**改法**：`acquire()` 之前发 `node:queued`（`id`,`agent`,`access`,`waitingSince`），拿到名额时发 `node:started`。**这两个事件之间的时长就是排队时长**，本身也是有用的诊断信号（"你的闸开太小了"）。

---

## 3. 数据面：`transcript.jsonl`

**真理源** = `<out-dir>/transcript.jsonl`，append-only，**单 writer = `node-core.mjs` 自己**。

信封与两个既有 skill 一致（`v` / `seq` / `ts` / `event` / `payload`），额外带 `graphId`。所有 `*Ref` 一律是**相对 out-dir 的相对路径**，`/file?ref=` 只接受这种，拒绝绝对路径与 `..`。

### 事件表

| `event` | 关键 `payload` | 表达什么 |
|---|---|---|
| `run:started` | `graphId`,`outDir`,`cwd`,`label?`,`maxConcurrent`,`vizEnabled` | `withBridge` 开场 |
| `viz:started` / `viz:stopped` | `url`,`pid`,`port` / `reason` | 同两个既有 skill |
| **`node:queued`** | `id`,`agent`,`access`,`waitingSince` | **等并发闸**（§2.4） |
| `node:started` | `id`,`agent`,`model`,`effort`,`access`,`group?`,`declaredDeps[]`,`inferredDeps[]`,`inputRef`,`specHash`,`timeoutMs`,`reask`,`queuedMs` | 拿到名额、开跑 |
| `node:attempt` | `id`,`n`,`rejectedReason?` | 第 n 次尝试开始；`n>1` 时带上一次被打回的原因 |
| `node:progress` | `id`,`n`,`charCount`,`tail`,`status`,`lastEvent`,`contextUsage` | 活进度（节流 ≥5s） |
| `node:settled` | `id`,`status`,`artifactRef`,`attempts[]`,`charCount`,`byteCount`,`durationMs`,`reaskCount`,`contextUsage`,**`workspace`**,`error?`,`diagnostics[]`,`sceneRef?`,`receiptRef` | 节点收场 |
| `node:reused` | `id`,`specHash`,`receiptRef`,`artifactRef`,`workspace?` | 指纹一致复用，**没真跑** |
| `run:final` | `counts:{…}`,`durationMs`,`halt?` | 收场汇总 |
| `run:terminated` | `reason:"done"\|"error"\|"user"` | 终态 |

`node:settled.status` 沿用既有五档 + 复用：`ok` / `contract_error` / `backend_failed` / `timeout` / `unknown` / `reused`。**不新增状态词**。

### ⚠️ `run:terminated` 是 best-effort，viewer 绝不能依赖它（v2 新增，见 §10 ①）

**`withBridge` 没有任何信号处理**（`node-core.mjs` 里 `process.on(` 一次都没出现）。它的形状是：

```js
const bridge = await startBridge(opts);
try { return await fn(bridge); }
finally { await bridge.close(); }
```

`finally` 覆盖**正常返回**与**抛异常**，但 **Ctrl-C / SIGTERM / kill 时根本不跑**——Node 默认信号处置直接终止、不做栈展开。

所以 `run:final` / `run:terminated` / 显式 kill viz.pid **全都不会发生**。而本方案又明确支持"脚本退出后事后复盘"（§6），**页面卡在"运行中"是常见路径，不是边缘情况**。

**处置（照搬会话史可视化那份的结论）：**

- **viewer 侧合成终态**：周期检查 writer 是否还活着（`run:started` 里带 `pid` + 进程起始时间）。确认已死 → 把仍是 `queued`/`running` 的节点**合成**为 `abandoned`，顶栏标「运行已中断（未正常收场）」。
- **不要**去给 `withBridge` 加信号处理器来"修"这个：信号处理器里做 `await`（worktree 收尾要跑 git）本身有坑，而这个仓库刚在"退出期不能同步落盘"上栽过。**让 viewer 承担终态推断，比让退出路径变复杂更安全。**
- 顺带记录一个已知副作用（不属于 viz，但同源）：信号中断时，节点锁 `nodes/<id>.lock`、worktree、分支**都会留下**，需人工清理。

### 并发与写入安全

- 一个 out-dir = 一次运行 = **单进程**。这不是新约束：`<id>.lock` 已经是这个前提。
- 同进程内多节点并发是常态，但 JS 单线程，`seq` 自增无竞态。
- 每行 `fs.appendFileSync` 一次写完（单行 < 4KB，`tail` 已截断）。
- **半行容错**：writer 崩溃可能留下无换行结尾的半行，回放/tail 都必须缓冲到下一个 `\n` 再解析。

---

## 4. 拓扑从哪来（本方案的核心问题）

skill 明写**不做通用流程引擎**。所以不存在一份"图"可供读取——拓扑只活在使用者那段 JS 里。

不能为了画图去引入 plan 格式，那等于推翻 skill 的定位。三档来源，**同时支持、视觉上必须可区分**：

| 档 | 来源 | 可靠性 | 画法 |
|---|---|---|---|
| **A 声明** | spec 上可选 `deps: ["audit-1","audit-2"]` | 精确 | **实线箭头** |
| **B 推断** | 扫 prompt 里是否出现同 out-dir 下 `nodes/<otherId>.md` | 启发式，会漏也会多 | **虚线箭头** + 悬浮标"推断" |
| **C 兜底** | 只有时间：`startedAt`/`endedAt` 重叠关系 | 无边，只有先后与并行 | **泳道时间轴**，不画箭头 |

B 档能成立，是因为 skill 的组合纪律第 3 条本来就要求「**结果靠文件路径传**」。使用者照做，路径就在 prompt 里，机械可查。

**关键约束：`deps` 是纯注解，执行路径上没有任何代码读它。** 不解析、不排序、不调度、不校验成环。它只是写进事件、给 viz 画箭头。这样"不做流程引擎"这条边界完好——**图是被观测出来的，不是被声明出来的**。

**不许把 A 和 B 画成一样。** 推断出的依赖有假阳/假阴，混在一起画就是把猜测冒充事实。

⚠️ **v2 补充：并发闸会制造"看起来是依赖，其实只是排队"的假象。** C 档兜底（纯时间先后）在闸被打满时**必然产生虚假的先后关系**——B 在 A 之后跑，不是因为 B 依赖 A，是因为闸只有 4 个名额。所以：

- **C 档时间轴上必须标出排队区间**（`node:queued` → `node:started`），与真正的执行时长视觉区分
- **绝不能把 C 档的时间先后渲染成任何形式的箭头**

`group?` 字段同理：使用者自己那段 JS 若有轮次循环，可传 `group:"round-2"`，viz 按它分组。不传就不分组。

---

## 5. 状态模型（v2 新增）

### 5.1 `status × outcome` 合法组合矩阵

read 节点恒 `workspace: null`，只看 status 六档。**write 节点必须看组合**：

| `status` | `outcome` | 含义 | 页面该说什么 |
|---|---|---|---|
| `ok` | `delivered` | 改动已提交到分支，交付物齐全 | 「已交付」+ 分支名 + 改动文件数 + diff 入口 |
| `ok` | `no-changes` | 确知一个字没动（HEAD 仍在基线、索引为空） | 「无改动」——**不是失败，也没有 diff 可看** |
| `unknown` | `unknown` | 探测失败／提交失败／交付物残缺／agent 自己动了 git | ⚠️ **「工作区已保留」+ 路径 + 命令 + 「不要自动重跑」** |
| `contract_error`<br>`backend_failed`<br>`timeout` | 任意 | 节点本身失败 | 按 §4 六档；**若 `outcome ≠ delivered`，改动可能只在保留的工作区里，不在分支上** |

**三条不变式**（实现与测试都要照此断言）：

- `outcome === "delivered"` ⟹ `branch` / `headCommit`(40 hex) / `diffPath` / `diffSha256`(64 hex) **四样齐全**
- `outcome !== "delivered" && outcome !== "no-changes"` ⟹ 顶层 `status === "unknown"`（`finish()` 强制降级）
- `workspace.removed === false` ⟹ **工作区还在磁盘上**，页面必须给出 `workspace.path`

⚠️ **`filesChanged.length === 0` 但 `outcome === "delivered"` 是合法的**（agent 建了空提交，或提交完又 revert）——分支上只有历史、没有内容变化，diff 是 0 字节。**页面不能把 0 字节 diff 当成失败。**

### 5.2 节点生命周期状态

`queued` → `running` → 六档终态之一，外加 viewer 合成的 `abandoned`（§3）。

`queued` 是 v2 新增的**可见状态**，不是内部细节——用户必须能区分「在排队」和「在跑」，否则会把闸的正常限流误读成卡死。

---

## 6. 服务面、启动与生命周期

`skills/agent-bridge-graph/viz/serve.mjs` —— **直接拷圆桌那份**（零依赖零构建，仅 Node 内建），语义相同：`GET /events`（SSE，先回放后 tail）、`GET /file?ref=`（相对路径，拒绝绝对路径与 `..`）、`GET /`。端口 7345，占用则回退；自灭看门狗。

```js
const out = await withBridge(async (bridge) => { … }, { viz: true, outDir });
```

- `withBridge` 起服务、append `viz:started`；**收场事件是 best-effort，见 §3 的警告**。
- **默认关**。开跑前用 `AskUserQuestion` **问一次**「要开可视化吗？（默认否）」，别反复叨扰。
- 脚本退出后 viz 仍活一段时间（看门狗窗口），**支持事后复盘**。

### ⚠️ 为什么默认关：隐私口径（v2 新增）

开了 viz，`nodes/<id>.input.md` 就会把**全部委托 prompt 原文**落盘。两点必须说清楚：

1. **它落在 `<out-dir>`，也就是仓库里的 `.graph/`——不是临时目录。** `.graph/` 只是 gitignored，**不等于不存在**：它会一直留在磁盘上，直到人手动删。
2. 这比「委托会话史可视化」那份**更持久**——那份写临时目录、随主 agent 退出即删；**这份不删**。

所以 SKILL.md 必须写明：**开 viz = 在仓库目录里留下一份全量 prompt 明文**，并给出清理办法（`rm -rf .graph/<run>`）。

---

## 7. 被否决的更省方案

**方案 X：不做事件流，viz 直接轮询 `nodes/` 目录读 receipt。**

否决理由：**receipt 只在节点结束时写**，所以正在跑的节点**在磁盘上完全不存在**（v2 补充：卡在闸上的节点更是连开始都没有）。R2/R3 是核心诉求，方案 X 直接做不到。

退一步的变体（开跑时先写 `<id>.status.json` 边跑边更新，viz 轮询目录）能救 R3，但那就是"用一堆小文件手搓一个事件流"，还得自己处理半写文件。

### ⚠️ v2：这条论证的比较对象变了

v1 的结论是「**第三次复用一个已验证的形态**，比维护第三种机制便宜」。

2026-07-27 之后，仓库里会有**两个**已验证形态——圆桌/loop 的事件流，与会话史可视化的**双槽快照**（`state.0.json`/`state.1.json` + 里程碑触发 + 独立 progress sidecar）。而后者恰好**更贴"渲染当前状态"这件事**（那份复审的核心论证是：UI 只渲染当前状态、从不按序回放，事件流是照抄圆桌的**路径依赖**）。

**v2 的判断：graph 仍走事件流，但理由要换。**

- 快照方案的收益（免掉 seq / 半行 / 回放 / 迟到合并）在 graph 上**小得多**：graph 没有 1Hz 进度洪流（`node:progress` 节流到 5s），50 节点也没有 O(n²) 写放大。
- graph 的事件量极小（每节点个位数事件），而**事件流天然记得住"发生过什么"**——`node:attempt` 的打回原因、排队时长这类**过程信息**，快照会丢。
- 但**必须如实写明代价**：仓库将同时存在两套 viz 数据面。这是真实的维护负担，不该假装不存在。**若将来两者要合并，往快照方向收敛更合理**（三个页面里有两个只渲染当前态）。

---

## 8. 施工清单

| # | 改动 | 位置（按函数名定位，**不用行号**） |
|---|---|---|
| 1 | 事件 writer（append + seq + 半行安全） | `node-core.mjs` 新增内部模块 |
| 2 | 输入落盘 `nodes/<id>.input.md` | `runNode` 开头 |
| 3 | 每尝试独立产出 `nodes/<id>.a<N>.md` + 回执 `attempts[]` | `runNode` 的尝试循环（`copyBytes(settled.textRef, artifactPath)` 那处） |
| 4 | `node:progress` 发活进度（节流 5s） | `runNode` 里读 `w.pendingSnapshots?.[0]` 那处 |
| 5 | **`node:queued` + `queuedMs`** | `bridge._gate.acquire()` 前后 |
| 6 | **`node:settled` 带 `workspace` 全字段** | `finish()` |
| 7 | 可选 `deps` 注解 + prompt 路径推断 | `normalizeSpec` / `computeSpecHash` |
| 8 | `EVENTS.md` | `skills/agent-bridge-graph/EVENTS.md` |
| 9 | `viz/serve.mjs` | 拷圆桌 |
| 10 | `viz/index.html` | 见 UI 需求文档 |
| 11 | `viz/sample/` 样例 + `test-viz.mjs` | 仿 loop |
| 12 | SKILL.md 增 §可视化（**含 §6 的隐私口径**） | — |

**`deps` 要不要进 `specHash`？不进。** 判据是既有那条：「凡是会**改变执行结局**的字段都要进指纹」。`deps` 是纯注解、执行不读，改它不改结局；进了指纹反而会让"只改了个注解"白白作废整份可复用产出。

### 验收（v2 收紧：断言必须判别）

- **零消耗回归 `test-viz.mjs`**：喂 `viz/sample/transcript.jsonl`，断言三档拓扑渲染、六档 status × 三档 outcome 的**合法组合**、attempt 分轮、queued 态、空态。
- ⚠️ **负对照（v2 新增，否则上面的断言证明不了任何事）**：同一次运行里，把渲染器换成「**把推断边也画成实线**」的实现，断言**指定的那几条断言变红**。UIREQ §5 说「把推断当事实展示是这个页面最容易造成的误导」——**守它的测试必须能判别，不能只是跑过**。
- **`outcome` 三档各造一个 fixture**，断言 `no-changes` 不显示 diff 入口、`unknown` 必须显示 `workspace.path` 与「不要自动重跑」。
- **writer 已死的 fixture**：断言仍是 running 的节点被**合成为 abandoned**，而不是永远转圈（§3）。
- 真跑一次 `examples/hetero-audit.mjs` 开 viz，人眼验收。
- 现有 `repro-graph-node.mjs` / `repro-graph-worktree.mjs` 必须**仍全绿**（事件 writer 不能改变 `runNode` 的返回契约）。

---

## 9. 明确不做

- 不做 plan/DAG 声明格式、不做依赖解析与调度（`deps` 只是注解）
- 不做在 viz 里**操作**运行（暂停/重跑/改参数）——只读观测台
- 不做跨 out-dir 的历史聚合 / 多 run 对比
- 不做鉴权（本机 localhost）
- **不改写节点产出**：viz 只负责**渲染**，`nodes/*.md` 永远是桥的字节直传原件，页面必须提供"看原文"
- **不给 `withBridge` 加信号处理器**（§3）——终态推断归 viewer

---

## 10. v2 的四条外部输入

来自 2026-07-27「委托会话史可视化」的六轮复审（`docs/PLAN-agent-bridge-session-viz-impl-2026-07-27.md`）：

| # | 结论 | 落在 |
|---|---|---|
| ① | **退出期没有"下一拍"**——同步 close → exit 的路径上，任何"收场时会写终态"的承诺都是空的；终态推断必须归 viewer | §3 的警告 + §8 验收 |
| ② | 两个正交状态字段**必须给合法组合矩阵**，否则实现者会造出不可能的组合 | §5.1 |
| ③ | **断言不判别就等于没断言**——守关键不变式的测试必须配自动负对照 | §8 验收 |
| ④ | 落 prompt 明文前必须先把隐私口径与默认开关**写死** | §6 |

②③④ 都是在那份计划里被 codex 逐条逼出来的，**同样的坑本方案原样存在**。①是我在 2026-07-27 清理现场时**实测确认**的（`node-core.mjs` 零 `process.on`）。
