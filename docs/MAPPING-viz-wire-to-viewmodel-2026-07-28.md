# viz 映射表：wire 词表 → 页面 view-model

**日期** 2026-07-28 · **状态** 施工中 · **真理源** 本文件是 reducer（施工清单 #19）的唯一依据

---

## 0. 这份文件解决什么

页面（`skills/agent-bridge-graph/viz/index.html`）由 UI 设计师照 `docs/UI-REQUIREMENTS-graph-viz-2026-07-26.md` 产出，
事件流合同是 `docs/EVENTS-graph.md`。**两者不是同一套词表**，reducer 夹在中间。

**这份文件规定 reducer 怎么翻译，不规定页面长什么样，也不规定事件里有什么。**
三者冲突时：docs/EVENTS-graph.md 定 wire、UIREQ 定语义要求、本文件定翻译。**页面的内部词表可以改，wire 不能。**

### 0.1 交付物存档

| | |
|---|---|
| 原件 | `graphviz.zip` / `graph-observatory.html`，2026-07-28 交付 |
| SHA-256 | `82a721dcd4b9a93ce67ff3a6ff197e0c2368fb70614fb8f31c42802dc3813b85` |
| 落地为 | `skills/agent-bridge-graph/viz/index.html`（**逐字节相同**，改动从 #19 开始） |

⚠️ **记这个指纹是为了日后能分辨「设计师原本就这么写的」与「我们改的」。** 页面被改过之后，
这个指纹是唯一能回到原始交付的凭据。

---

## 1. ⚠️ 结构性落差：页面没有「轮」这一层

**根因不是设计师做错了。** UIREQ 是 2026-07-26 交出去的，`conversation()` / 轮这一层是 **2026-07-28** 才落地的
（`docs/DESIGN-graph-conversation-2026-07-28.md`）。**页面照着一份 conversation 之前的合同实现，完全正确。**

| | docs/EVENTS-graph.md（wire） | 页面（view-model 现状） |
|---|---|---|
| 层级 | 节点 ⊃ **轮** ⊃ 尝试 | 节点 ⊃ 尝试 |
| `scene` 挂在哪 | **轮上**（`node:turn-settled.scene`；`node:settled` **没有**这个槽） | 节点上（`n.scene`） |
| `attempts[]` 挂在哪 | **轮上**（`turns[].attempts`） | 节点上（`n.attempts`） |

**这个落差有三处衍生缺口**（都在下面各自的表里）：`node:rejected` 缺两档 phase、`node:settled` 缺一档 status、
`sceneBlock()` 读错了层。

### 1.1 怎么补（#19 的做法）

设计师在 `index.html:1949` 自己留了话：

> 只有 1 次尝试时不显示任何分段控件。分段由数组生成，段数没有上限——
> **将来在「环节 → 轮 → 尝试」里，轮这一层用同一个规则再套一层即可。**

所以 `attemptsBlock()` 的分段控件是**数组驱动、段数无上限**的，套第二层是加一层不是重写。三条改动：

1. **加一层轮的分段控件**，外层选轮、内层选尝试；单轮节点**不显示外层控件**（与单次尝试不显示内层控件同一规则）。
   ⚠️ 但**数据结构上单轮节点也必须有 `turns:[{key:"main",…}]`**——docs/EVENTS-graph.md §10.9 第 7 条明写「不给单轮节点留没有 turn 的旧路径」，
   **两套解析迟早只有一套被改**。「单轮不显示外层控件」是**渲染层**的事，不是数据层。
2. **`scene` 从节点级挪到轮级**：`sceneBlock(n)` → `sceneBlock(turn)`。一段对话可能有多份现场（§3.2）。
3. **`attempts` 从 `n.attempts` 挪到 `n.turns[i].attempts`**。

### 1.2 顺带要实现的派生量（docs/EVENTS-graph.md §10.8，**页面自己算，事件里没有**）

| 想显示的 | 怎么算 |
|---|---|
| 节点第一次开跑 | **第一条** `node:started` 的 `ts`（那一轮**可能是没能开始的轮**，它照样起过钟、烧过墙上时间） |
| 聊了几轮 | 跑完的：`node:settled.turns.length`；跑到一半的：**已见 `node:turn` 数 − 已见 `node:turn-settled{status:"not-started"}` 数** |
| 有没有轮没能开始 | 看有没有 `node:turn-settled{status:"not-started"}`。⚠️ **它们不在 `turns[]` 里**，要显示只能从事件流拿 |
| 哪一轮封了口 | **先过闸**：`node:observed.prompt.state === "not-applicable"` ⟺ 这是对话。不是对话**一律不显示**。是对话时取 `turns[]` 里第一个 `sessionReusable === false` 的轮 |
| 这一轮打回重说过吗 | 该轮 `attempts` 里有没有 `.n === 2` |
| 总共尝试几次 | `Σ turns[].attempts.length`（≤40） |
| 轮之间等了多久 | `node:turn(kᵢ₊₁).ts − node:turn-settled(kᵢ).ts`。⚠️ **不属于任何一轮、不烧任何一轮预算**，**不许画进任何一轮的耗时条** |

⚠️ **一条都不许"补成 wire 字段"**（§10.9 第 9 条）。

---

## 2. 节点状态：`node:settled.status` → 页面 `STATUS`

**wire 是封闭六档**（§5.8）；页面的 `STATUS` 有 11 项，因为它**同时**编码了「还没有终态」与「viewer 合成态」。

| wire | 页面 key | 缺口 |
|---|---|---|
| `ok` | `ok` | — |
| `contract_error` | `contract_error` | — |
| `backend_failed` | `backend_failed` | — |
| `timeout` | `timeout` | — |
| `unknown` | `unknown` | — |
| **`callback_error`** | **（无）** | 🔴 **缺一档**，见 2.1 |

**页面这五项不是 wire status，是 reducer 派生的：**

| 页面 key | 派生规则 |
|---|---|
| `discovered` | 见过 `node:observed`，**没见过** `node:turn` |
| `queued` | 见过 `node:turn`，**没见过**对应的 `node:started`（§10.3 第 2 条：这一轮在等名额，**一个字都还没发给 AI**） |
| `running` | 见过 `node:started`，还没有终态 |
| `rejected` | 见过 `node:rejected`（**终态**） |
| `abandoned` | **viewer 合成**：EOF / owner 丢失，且该节点没有终态。六种子形态见 §5 |
| `unlogged` | `recording-failed` 之后，该节点状态未知。⚠️ **全局记录损坏必须盖过逐节点推断**（§3.1） |

⚠️ **`execution: "fresh" | "reused"` 不是 status，是正交标记**（§5.8）——复用返回的是旧回执的 `status:"ok"`。
页面已经做对了：`n.reused` 是独立布尔，与 `n.status` 并存。

### 2.1 🔴 缺口：`callback_error`

**语义**（§5.10）：轮都好好的，**编排那段 JS 自己炸了**。它是**唯一一个「既有 `node:settled`、又向调用方抛了异常」的结局**——
节点收尾照常走完（关会话、收工作区、写回执），然后原样重抛。

**所以页面上它是一个有终态、有回执、有产出的节点**，不是失败态的变体。文案必须说清「**AI 那边跑完了，是你的编排代码抛了异常**」。

⚠️ **两件事不许互相推断**：`run:final.result` 是不是 `failed`，取决于编排有没有把它接住。
⚠️ **它必须进 `run:final.counts` 的恒等式**——漏掉它，每个 callback_error 节点都会让等式差 1，**一次正常记录被判成"记录不完整"**。

---

## 3. 运行状态：§10.1 四档判定 → 页面 `RUNSTATE`

**判定按顺序取第一个匹配**（§10.1），reducer 不许换序：

| # | 条件 | 页面 `RUNSTATE` |
|---|---|---|
| 1 | transcript 里有 `run:final` | `ended`（`result==="completed"`）/ `ended_failed`（`result==="failed"`） |
| 2 | `recording-failed` + `owner-final` | `log_broken_ended` |
| 3 | `recording-failed` + EOF，**没有** `owner-final` | `log_broken_unknown` |
| 4 | 以上都没有、EOF 前也没 final | `no_finish` |

页面另外两项是**纯客户端态**，不由事件决定：`waiting`（还没收到任何事件）、`replaying`（正在回放历史）。

⚠️ **第 2、3 档不得共用同一句文案**（页面已做对，两条 banner 分开）。
⚠️ **第 4 档措辞要留余地**：绝大多数是强杀，但**两条通道同时坏掉**时 owner 其实可能有序收了场。**页面不能替它下"进程一定被杀了"的结论。**
⚠️ **`recording-failed` 之后不许把缺失的节点逐个合成 `abandoned`**——那些节点很可能好好跑完了，只是没人记下来。
**把记录故障摊派成一堆节点事故，是这个页面能犯的最有误导性的错误之一。**（页面的 `unlogged` 档就是为此存在的。）
⚠️ **「历史读取失败」是另一回事**：`recording-failed` 是**我们写不下去**，history-read-failure 是**我们读不回来**。
后者**绝不能**显示成「运行被掐断」——出问题的是读历史这一侧，owner 可能好端端在跑。**此时禁止据缺失事件推断任何节点或资产不存在。**

---

## 4. `node:rejected.phase` → 页面 `REJECT`

**wire 是封闭六档**（§5.3）；页面有四条。

| wire `phase` | 页面 `REJECT` key | 缺口 |
|---|---|---|
| `lock` | `dup_id` | — |
| `preflight` | `dirty_repo` | — |
| `reuse-check` | `reuse_mismatch` | — |
| `workspace-setup` | `worktree_failed` | — |
| **`turn-validation`** | **（无）** | 🔴 见 4.1 |
| **`zero-turn`** | **（无）** | 🔴 见 4.1 |

⚠️ **页面必须逐个区分六种 phase 并给出各自的处置提示。把六种渲染成同一句「被拒绝了」是假绿。**

### 4.1 🔴 缺口：`turn-validation` 与 `zero-turn`

两者**只可能出现在对话节点上**（`runNode` 没有回调，它那一轮在 `normalizeSpec` 就校验完了，而那条路**一个事件都不发**）。

| phase | 判据（**写死**） | 处置提示 |
|---|---|---|
| `zero-turn` | `turnCalls === 0` | 去看**编排那段 JS 为什么一轮都没起** |
| `turn-validation` | `turnCalls > 0` 且 `turns[]` 为空 | 去看**那次 `turn()` 是怎么调的** |

⚠️ **`turn-validation` 这个枚举名比它的实际语义窄，别照名字理解。** 它涵盖两类：
①**参数不合法**（`key` 非法/重复、`prompt` 与 `promptFile` 没二选一、`timeoutMs` 缺或 ≤0、`schema` 给了非 codex 后端…）；
②**用法/状态不允许**（上一轮没结束就并发 `turn()`、`fn` 已返回才来、这段对话已被毒化、超过 20 轮）。
**所以处置提示不许写成"参数写错了"**——要写「去看那次 `turn()` 是怎么调的（**可能是参数写错，也可能是并发/来晚/毒化后/超 20 轮**）」。

⚠️ **`phase` 与 `error` 是两个独立的事实，渲染时不许互相推断。**
已知的一条混合路径：回调**吞掉**了入场被拒的异常、随后**自己**抛了一个与那次 `turn()` 毫无关系的异常。那时
`phase` 仍是 `turn-validation`（判据只看计数），而 `error` 是**回调那个无关异常**的消息（根因优先）。
**照抄 `error`、按 `phase` 归类，两件事分开做。**
⚠️ 于是 `REJECT` 表里这两条**不能像现有四条那样写死标题**——现有四条的 `t`（标题）是安全的，
因为它们的 `error` 与 phase 同源；这两条必须**照抄 `error` 正文**、别自己起标题。

⚠️ **`node:rejected` 只在「一轮都没跑起来」时出现。** 只要有**一轮真跑起来过**，节点就一定写回执、一定以 `node:settled` 收场——
哪怕后面某次 `turn()` 又抛了校验错、哪怕回调自己炸了（那时是 `status:"callback_error"`）。
**同一个 `UsageError`，落在哪一层取决于「这个节点有没有回执」。**

---

## 5. `abandoned` 六种子形态（§10.3）→ 页面

`abandoned` 的正确含义是「**观测者没有看到终态**」，**不是**「结果永远拿不到了」——
worktree、分支、锁、已复制的 attempt 产出**都还在**，缺的只是权威终态回执。

**判据按「该节点最后一条事件」取：**

| 最后停在 | 页面必须说 |
|---|---|
| `node:observed` | 「本地准备中，还没派发」 |
| `node:turn`（没 `node:started`） | 「**这一轮**在等名额，**一个字都还没发给 AI**」 |
| `node:started`/`attempt*`/`progress`/`turn-settled`(≠not-started) | 「执行结果不明」+ **只列确实落了盘的 ref** |
| `node:started`（write，**没见过 intent**） | 「正在做建工作副本前的检查——**还没开始创建，不会有工作副本**」 |
| 见过 `workspace-intent`、**没见过 `-created`** | 「工作副本**可能**已开始创建，**位置未确认**」+ **最后一条 intent 的路径** |
| 见过 `workspace-created` | 「执行与代码去向都不明」+ 路径 + 分支 + **禁止自动重跑** |

⚠️ **第 4、5 格文案必须相反，不能合并**：第 5 格说"可能有，去看看"，第 4 格说"没有"。
**把第 4 格并进第 5 格，就是让用户去找一个可以证明不存在的目录**；扑空一次，第 6 格那句最不该被怀疑的话就跟着掉价。

**多轮之后要补的（改措辞，不改档位）：**

1. **已经收场的轮不是"没结果"**：每条 `node:turn-settled` 都是**权威的轮级结局**，照常列出（产出可点开），
   只把**最后那一轮**标成结局不明。⚠️ **把整个节点一律涂成"结果不明"是这里最容易犯的错**——
   6 轮的对话在第 6 轮被强杀，前 5 轮的产出**明明都在盘上、也都公布过**。
2. 最后一条是 `turn-settled{status:"not-started"}` 时，那一轮的结论**是确定的**：说「**上一轮没能开始**」+「接下来做了什么不明」。
   ⚠️ **不许拿"执行结果不明"描述那一轮**——它的结果一点都不含糊：**它没开始**。
3. 第 4~6 格**只看那三条 `node:workspace-*` 的有无，与停在第几轮无关**（工作副本是节点级的，N 轮共享一棵树）。

---

## 6. `AssetState` → 页面 `assetRow` 的 `a.s`

wire 是三态判别联合（§3.1）；页面有六态——**多出来的三态正是 docs/EVENTS-graph.md 规定由 viewer 派生的那三种**，映射干净：

| 页面 `a.s` | 来源 |
|---|---|
| `have` | wire `present`（`ref`/`sha256`/`byteCount` **三样恒有**） |
| `na` | wire `not-applicable` |
| `unavailable` | wire `unavailable`（`code` 恒有） |
| `pending` | **派生**：产生它的那条事件还没出现，而节点仍在跑。⚠️ docs/EVENTS-graph.md §3.1 明写 `pending` **不进 wire**——「那条事件还没出现」本身就是这个意思 |
| `unlogged` | **派生**：`recording-failed` 发生在该资产的生产事件**之前**，这一项**根本没有 AssetState** |
| `gone` | **派生**：记录时 `present`，现在按 ref 取不回来（`/file` 404）。⚠️ 与「本来就没有」是两件事 |

⚠️ **`{state:"present"}` 却没有 `ref`，等于没有**——页面知道"东西在"却点不开。reducer 收到这种必须当**记录损坏**处理，不是当 `have`。

### 6.1 `unavailable.code`：命名映射 + 🔴 一处缺口

**wire 的 `code` 是开放字符串，不是封闭枚举**（§3.1）。页面的 `UNAVAIL` 表用 UPPER_SNAKE，wire 用 kebab：

| wire `code` | 页面 `UNAVAIL` key | 备注 |
|---|---|---|
| `archive-root-failed` | `ARCHIVE_DIR_MISSING` | ⚠️ 是**这个节点自己的**归档子目录，**不是** graph 归档根 |
| `write-failed` | `ITEM_WRITE_FAILED` | — |
| `source-missing` | `NO_SOURCE_TO_COPY` | — |
| `sha-failed` | `DIGEST_FAILED` | 拷下来了但算不出指纹。**不能当 present**：指纹是复用与防篡改的判据 |
| `fingerprint-only` | `SOURCE_RUN_NOT_ARCHIVED` | ⚠️ **不是记录失败**，页面文案已正确写明「这是当时的选择，不是故障」 |
| **`unknown`** | **（无）** | 🔴 见下 |

**reducer 直接用 wire 的 kebab 形式，`UNAVAIL` 表的键改成 kebab** —— 别在 reducer 里做大小写转换：
转换层是"没见过的 code"最容易被静默吃掉的地方，而 §3.1 明令**不得静默降级**。

#### 🔴 缺口：字面量 `unknown` 与「没见过的 code」目前共用同一句文案

docs/EVENTS-graph.md §3.1 对消费方的要求是**五条**：原样显示 + 不得崩 + 不得降级成 `not-applicable` + 不得归到已知原因上 +
**不得先偷偷改写成 `unknown` 再显示——字面量 `unknown` 与"没见过的 code"必须有不同的文案**。

页面 `assetRow()` 的前四条**都做对了**（`known ? … : '原因码不在已知清单里…'`，且 `<code>` 原样显示）。
**第五条没做到**：`unknown` 不在 `UNAVAIL` 表里，于是它掉进"没见过"那条兜底。

**修法**：往 `UNAVAIL` 加一条 `'unknown'` → 「**确实拿不到，但连原因都没分辨出来**——这是"已知的未知"：
生产方尝试过、也知道失败了，只是没能分辨出是哪一类。」——与兜底那句「原因码不在已知清单里，无法进一步解释」语义完全不同。

---

## 7. `outcome` → 页面 `OUTCOME`（仅命名差异）

| wire（§5.8） | 页面 |
|---|---|
| `delivered` | `delivered` |
| **`no-changes`** | **`no_change`** |
| `unknown` | `unknown` |

⚠️ **`outcome` 是 write 节点交付结论的唯一权威判据，页面不得自己拿 `committed`/`filesChanged` 再推一遍。**
⚠️ **它是节点级的**：N 轮共享一棵工作树、一条分支，**整段只提交一次**。
⚠️ **read 节点缺席这个字段**（不是 `null`）——reducer 用"缺席"判 read/write，别用 `mode` 字段猜。

**页面已做对的两处**（别在 #19 里改坏）：
- `delivered` 且 `files:[]` + `netEmpty:true` → **不说"没有改动"**（它有 HEAD 前进，只是净改动为零）；
- `no_change` 的 `diff` 是 `na{why:'没有可交付的改动'}`，与 `delivered+空 diff` 的 `have{empty:true}` **分开渲染**。

---

## 8. `durationMs` 的两个陷阱

1. **复用时 `node:settled.durationMs` 是「原来那次执行」的耗时**，不是这次复用检查的耗时。
   **页面必须标成"原执行耗时"**，否则一次 200ms 的复用会显示成"跑了 40 分钟"。
   页面已做对：`origRun` 字段 + 「上面的『原执行耗时』是当初那次跑出来的」那段文案。
2. **`node:settled.durationMs ≥ Σ turns[].durationMs`**，差额是**轮与轮之间回调在干别的事**的时间。
   **不许把差额画进任何一轮的耗时条。**

---

## 9. 拓扑（§10.7）

页面 `edges[]` 的 `kind:'declared'|'inferred'` 直接对应 `declaredDeps` / `inferredDeps`。

⚠️ **UIREQ 说「把推断当事实展示是这个页面最容易造成的误导」**，页面已经做对了三件事，#19 别改坏：
- 推断边**虚线**、声明边**实线**；
- 推断边有 `why`（点开说明"为什么推断出这条边"）；
- 声明边与实际执行顺序不符时给 `warn`（「这条边只是一句声明，系统既不校验也不据此调度」）。

⚠️ **`deps` 不进 `specHash`**——执行不读它，改它不改结局；进了指纹会让"只改个注解"白白作废可复用产出。

---

## 10. 施工时的负合同（§10.9，**别"顺手补回来"**）

1. **viewer 不写任何 pid / state 文件**，判活只有一条合同：**生命管道**。
2. v1 不提供"重开旧 run"的入口。
3. 不做跨波聚合、不做跨 out-dir 聚合与多 run 对比。**一个 `withBridge` = 一个 graph = 一份 transcript。**
4. **页面只读**：不提供暂停、重跑、改参数、合分支。
5. 不给 `withBridge` 加信号处理器（覆盖不了 SIGKILL；中断判定归**管道 EOF**）。
6. viewer 生命周期只依赖那条生命管道——不看进程树、不看端口、不看时钟。
7. **不给单轮节点留"没有 turn 的旧路径"**（见 §1.1 第 1 条）。
8. **不做轮级的复用/重跑**——复用粒度就是整个节点。**页面上不许出现任何按轮重跑的入口。**
9. 不在事件里放派生量（§1.2 那七个）。
10. **不为"没能开始的轮"另造事件类型**，它由 `node:turn-settled{status:"not-started"}` 闭合。

---

## 11. 缺口汇总（#19 的工作清单）

| # | 缺口 | 性质 | 位置 |
|---|---|---|---|
| G1 | **轮这一层完全缺失** | 结构性 | `attemptsBlock` / `sceneBlock` / 场景数据结构 |
| G2 | `scene` 挂在节点上，合同是挂在轮上 | 结构性 | `sceneBlock(n)` |
| G3 | `node:settled.status` 缺 `callback_error` | 缺一档 | `STATUS` 表 |
| G4 | `node:rejected.phase` 缺 `turn-validation` / `zero-turn` | 缺两档 | `REJECT` 表 |
| G5 | 字面量 `unknown` 与没见过的 code 共用文案 | 违 §3.1 硬要求 | `UNAVAIL` 表（一行） |
| G6 | `UNAVAIL` 键是 UPPER_SNAKE，wire 是 kebab | 命名 | `UNAVAIL` 表 |
| G7 | `OUTCOME` 键 `no_change`，wire 是 `no-changes` | 命名 | `OUTCOME` 表 |
| G8 | 静态 `SCENES` 需换成事件流归约 | 本来就是要做的 | §2 场景数据 → reducer |

**G1~G4 的共同根因是同一件事**：UIREQ 早于 conversation() 两天。**不是四个独立 bug。**
