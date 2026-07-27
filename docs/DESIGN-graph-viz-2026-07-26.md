# agent-bridge-graph 可视化 —— 方案设计

**日期** 2026-07-26 · **状态** 提案，待评审 · **关联** `skills/agent-bridge-graph/`、`skills/agent-bridge-roundtable/EVENTS.md`、`skills/agent-bridge-loop/EVENTS.md`

---

## 0. 结论摘要

沿用圆桌 / loop 已经跑通两轮的同一套形态：**`EVENTS.md` 定 schema → `transcript.jsonl` 事件流 → 预置零依赖 `serve.mjs`（SSE，先回放后 tail）→ 单文件 `index.html`**。不发明第三套机制。

graph 与那两个有**两处结构性不同**，是本方案的全部实质内容：

| | 圆桌 / loop | graph |
|---|---|---|
| 事件由谁写 | **主 agent 手写**（靠纪律，会忘） | **`node-core.mjs` 自己写**（是代码，忘不了、零 token） |
| 拓扑从哪来 | 流程写死在 SKILL 里 | **没有声明的拓扑**——skill 明确拒绝 plan/DAG 格式 |

第二条是这个方案唯一真正的设计问题，见 §4。答案是：**图不是被声明出来的，是被观测出来的**——执行路径上没有任何代码读拓扑，viz 只是把已经发生的事画成图。这样既满足"看整个图什么样"，又不违反 skill 的既定边界（不做流程引擎）。

同时发现**三个产品缺口**，不补就交付不了你要的功能，见 §2。

---

## 1. 需求拆解

你的原话拆成五条可验收的：

| # | 需求 | 现有数据够不够 |
|---|---|---|
| R1 | 看整个 graph 图是什么样的 | ❌ 无拓扑来源（§4） |
| R2 | 有哪些节点 | ✅ receipt 文件名即节点 id |
| R3 | 哪些节点**正在运行** | ❌ receipt 只在节点**结束**时才写 |
| R4 | 点开节点看**输入** | ❌ prompt 从未落盘（只进了 specHash） |
| R5 | 点开节点看**输出**，给人看，按不同轮次区分 | ⚠️ 产出在，但**重说会覆盖上一轮**（§2.2） |

R3 单独否决了"viz 直接轮询 `nodes/` 目录"这个最省的方案——没有事件流就看不见在跑的节点，而那是你的核心诉求。详见 §7。

---

## 2. 必须先补的三个产品缺口

这三条都在 `skills/agent-bridge-graph/tools/node-core.mjs`，是**产品改动**，不是 viz 改动。

### 2.1 输入从未落盘（R4 阻塞）

`receipt` 里有 `specHash`，但**没有 prompt 原文**，也没有角色文件内容。指纹能证明"输入没变过"，但**读不回来给人看**。

**改法**：节点开跑时写 `nodes/<id>.input.md`——完整 prompt + 角色文件内容 + 会影响结局的 spec 字段（agent/model/effort/access/cwd/timeoutMs/reask/schema/outputShape）。事件里只留 `inputRef`，大文本不进 JSONL。

### 2.2 重说会覆盖上一轮产出（R5 阻塞）

`node-core.mjs:552` 把 `artifactPath` 定成每节点**一个固定文件**，而 `:893` 的 `copyBytes(settled.textRef, artifactPath)` 在**尝试循环内部**。于是 `reask:1` 打回重说后，第二次的产出**直接盖掉第一次**——第一次长什么样、为什么被判不合格，事后无从查证。

「按不同轮次区分」这条需求，用现在的数据**做不出来**。

**改法**：每次尝试各写 `nodes/<id>.a<N>.md`；`nodes/<id>.md` 保持现状语义（= 最终采纳的那份），由最后一次尝试复制而来。回执增加 `attempts: [{ n, artifactRef, status, rejectedReason?, durationMs, charCount }]`。

> 顺带的价值：这也是**审计**缺口，不只是 viz 缺口。「打回重说」是 graph 少数几个自动决策之一，决策依据（第一次到底差在哪）却被自己覆盖了。

### 2.3 活进度被丢弃（R3 阻塞）

内层 wait 切片超时时，`node-core.mjs:834-837` 拿到了 `pendingSnapshots[0]`——里面有 `charCount` / `tail` / `status` / `lastEvent` / `contextUsage`——但**只取了 `contextUsage`，其余直接扔掉**。

**改法**：把这份快照发成 `node:progress` 事件（节流：至多每 5 秒一条，`tail` 截 240 字）。这条改动零额外 RPC——数据已经在手里了。

---

## 3. 数据面：`transcript.jsonl`

**真理源** = `<out-dir>/transcript.jsonl`，append-only，**单 writer = `node-core.mjs` 自己**。

信封与两个既有 skill 完全一致（`v` / `seq` / `ts` / `event` / `payload`），额外带 `graphId`。所有 `*Ref` 一律是**相对 out-dir 的相对路径**，`/file?ref=` 只接受这种，拒绝绝对路径与 `..`。

### 事件表

| `event` | 关键 `payload` | 表达什么 |
|---|---|---|
| `run:started` | `graphId`,`outDir`,`cwd`,`label?`,`vizEnabled` | `withBridge` 开场 |
| `viz:started` / `viz:stopped` | `url`,`pid`,`port` / `reason` | 同两个既有 skill |
| `node:started` | `id`,`agent`,`model`,`effort`,`access`,`group?`,`declaredDeps[]`,`inferredDeps[]`,`inputRef`,`specHash`,`timeoutMs`,`reask` | 一个节点开跑 |
| `node:attempt` | `id`,`n`,`rejectedReason?` | 第 n 次尝试开始；`n>1` 时带上一次被打回的原因 |
| `node:progress` | `id`,`n`,`charCount`,`tail`,`status`,`lastEvent`,`contextUsage` | 活进度（节流 ≥5s） |
| `node:settled` | `id`,`status`,`artifactRef`,`attempts[]`,`charCount`,`byteCount`,`durationMs`,`reaskCount`,`contextUsage`,`error?`,`diagnostics[]`,`sceneRef?`,`receiptRef` | 节点收场 |
| `node:reused` | `id`,`specHash`,`receiptRef`,`artifactRef` | 指纹一致复用，**没真跑** |
| `run:final` | `counts:{ok,contract_error,backend_failed,timeout,unknown,reused}`,`durationMs`,`halt?` | 收场汇总 |
| `run:terminated` | `reason:"done"\|"error"\|"user"` | 终态，viz 据此进入自灭倒计时 |

`node:settled.status` 沿用既有五档 + 复用：`ok` / `contract_error` / `backend_failed` / `timeout` / `unknown` / `reused`。**不新增状态词**——`STATUS_EXIT` 已经把这套语义钉死了，viz 跟着它走。

### 并发与写入安全

- 一个 out-dir = 一次运行 = **单进程**。这不是新约束：现有 `<id>.lock` 文件（`:583`）已经是这个前提。跨进程并发写同一 out-dir 不支持，且已有锁会当场拒绝。
- 同进程内多节点并发是常态（`Promise.all` 扇出），但 JS 单线程，`seq` 自增无竞态。
- 每行 `fs.appendFileSync` 一次写完（单行 < 4KB，`tail` 已截断）。
- **半行容错**：writer 崩溃可能留下无换行结尾的半行，回放/tail 都必须缓冲到下一个 `\n` 再解析——三份 EVENTS.md 同一条纪律。

---

## 4. 拓扑从哪来（本方案的核心问题）

skill 的 §不做 明写：**不做通用流程引擎（plan/DAG 格式、依赖解析、调度器）**。所以不存在一份"图"可供读取——拓扑只活在使用者那段 JS 里。

不能为了画图去引入 plan 格式，那等于推翻 skill 的定位。三档来源，**同时支持、视觉上必须可区分**：

| 档 | 来源 | 可靠性 | 画法 |
|---|---|---|---|
| **A 声明** | spec 上可选 `deps: ["audit-1","audit-2"]` | 精确 | **实线箭头** |
| **B 推断** | 扫 prompt 里是否出现同 out-dir 下 `nodes/<otherId>.md` | 启发式，会漏也会多 | **虚线箭头** + 悬浮标"推断" |
| **C 兜底** | 只有时间：`startedAt`/`endedAt` 重叠关系 | 无边，只有先后与并行 | **泳道时间轴**，不画箭头 |

B 档能成立，是因为 skill 的组合纪律第 3 条本来就要求「**结果靠文件路径传**，别把正文贴进下一个提问」。使用者照做，路径就在 prompt 里，机械可查。

**关键约束：`deps` 是纯注解，执行路径上没有任何代码读它。** 不解析、不排序、不调度、不校验成环。它只是写进事件、给 viz 画箭头。这样"不做流程引擎"这条边界完好——**图是被观测出来的，不是被声明出来的**。

**不许把 A 和 B 画成一样。** 推断出的依赖有假阳/假阴，混在一起画就是把猜测冒充事实。

`group?` 字段同理：使用者自己那段 JS 若有轮次循环（`for (round of 1..3)`），可传 `group:"round-2"`，viz 按它分组。不传就不分组。

---

## 5. 服务面

`skills/agent-bridge-graph/viz/serve.mjs` —— **直接拷圆桌那份**（10.9 KB，零依赖零构建，仅 Node 内建），语义相同：

- `GET /events` —— SSE。先回放已有事件（晚开页面也见历史），再从当前字节偏移 tail 增量。前端按 `seq` 去重，断线重连的全量重放不会重复。
- `GET /file?ref=<相对路径>` —— 懒加载大文本（`inputRef` / `artifactRef` / `receiptRef` / 现场文件）。只接受相对路径，拒绝绝对路径与 `..`。
- `GET /` —— 静态 `index.html`。
- 端口 7345，被占则回退 OS 临时端口；pid 写 `<out-dir>/viz.pid`；自灭看门狗（终态后末个客户端断开宽限 60s / 始终无客户端兜底 10min）。

loop 当初就是"拷自圆桌，语义相同"，这是第三次复用，成本接近零。

---

## 6. 启动与生命周期

```js
const out = await withBridge(async (bridge) => { … }, { viz: true, outDir });
```

- `withBridge` 负责起服务、append `viz:started`、收场时 append `run:final` + `run:terminated` 并**显式 kill** viz.pid（自灭看门狗只是兜底）。
- **默认关**。agent 侧纪律同圆桌：开跑前用 `AskUserQuestion` **问一次**「要开可视化吗？（默认否）」，别反复叨扰。
- 脚本退出后 viz 仍活一段时间（看门狗窗口），**支持事后复盘**——graph 的运行可能只有几分钟，跑完才去看是常态。

---

## 7. 被否决的更省方案

**方案 X：不做事件流，viz 直接轮询 `nodes/` 目录读 receipt。**

- 省掉：EVENTS.md、transcript、seq、半行容错、SSE。
- 否决理由：**receipt 只在节点结束时写**（`finish()` 里），所以正在跑的节点**在磁盘上完全不存在**。R3（哪些节点正在运行）是你的核心诉求，方案 X 直接做不到。
- 退一步的变体（开跑时先写一个 `<id>.status.json`、边跑边更新，viz 轮询目录）能救 R3，但那就是"用一堆小文件手搓一个事件流"，还得自己处理半写文件；而 SSE 那套**已经写好、已经跑过两轮**。省不下来，只是把复杂度换个地方放。

**结论**：走事件流。这不是因为它更强，是因为**第三次复用一个已验证的形态，比维护第三种机制便宜**。

---

## 8. 施工清单

| # | 改动 | 位置 | 依赖 |
|---|---|---|---|
| 1 | 事件 writer（append + seq + 半行安全） | `tools/node-core.mjs` 新增内部模块 | — |
| 2 | 输入落盘 `nodes/<id>.input.md` | `runNode` 开头 | — |
| 3 | 每尝试独立产出 `nodes/<id>.a<N>.md` + 回执 `attempts[]` | `runNode` 尝试循环 | — |
| 4 | `node:progress` 发活进度（节流 5s） | `runNode` wait 切片分支 | 1 |
| 5 | 可选 `deps` 注解 + prompt 路径推断 | `normalizeSpec` / `computeSpecHash` | — |
| 6 | `EVENTS.md` | `skills/agent-bridge-graph/EVENTS.md` | 1-5 |
| 7 | `viz/serve.mjs` | 拷圆桌 | — |
| 8 | `viz/index.html` | 见 UI 需求文档 | 6 |
| 9 | `viz/sample/` 样例数据 + `test-viz.mjs` | 仿 loop | 8 |
| 10 | SKILL.md 增 §可视化 | — | 全部 |

**`deps` 要不要进 `specHash`？不进。** 判据是既有那条：「凡是会**改变执行结局**的字段都要进指纹」。`deps` 是纯注解、执行不读，改它不改结局；进了指纹反而会让"只改了个注解"白白作废整份可复用产出。

**验收**：
- 零消耗回归 `test-viz.mjs`（仿 loop 那份）：喂 `viz/sample/transcript.jsonl` → 断言三档拓扑各自渲染正确、5 种 status 配色、attempt 分轮、空态。
- 真跑一次 `examples/hetero-audit.mjs` 开 viz，人眼验收。
- 现有 `repro-graph-node.mjs` 必须仍全绿（事件 writer 不能改变 runNode 的返回契约）。

---

## 9. 明确不做

- 不做 plan/DAG 声明格式、不做依赖解析与调度（`deps` 只是注解）
- 不做在 viz 里**操作**运行（暂停/重跑/改参数）——只读观测台
- 不做跨 out-dir 的历史聚合 / 多 run 对比
- 不做鉴权（本机 localhost，同圆桌 loop）
- **不改写节点产出**：viz 只负责**渲染**，`nodes/*.md` 永远是桥的字节直传原件，页面必须提供"看原文"
