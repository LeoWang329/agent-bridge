# agent-bridge-graph 可视化 —— 方案设计

**日期** 2026-07-26 · **修订 v14** 2026-07-27 · **状态** ✅ **codex 第 13 轮 APPROVE，可施工**
**关联** `skills/agent-bridge-graph/`、`skills/agent-bridge-roundtable/EVENTS.md`、`docs/PLAN-agent-bridge-session-viz-impl-2026-07-27.md`

> **修订史与逐轮复审记录** 移到 `docs/REVIEW-LOG-graph-viz-2026-07-26.md`。
> **一句话**：这份提案经过 **13 轮** codex 对抗复审（第 13 轮 APPROVE），每一轮都是 CHANGES-REQUIRED、每一轮的发现都成立；最近五轮**每轮还能删掉三四样机制**。这份文档只留**现行合同**与「为什么是这样」，**不再留考古**——历史越堆越厚会开始污染活跃条款（最近一轮就抓到一条：正文里当规模依据的那句话，早被后来加的进度事件证伪了）。
>
> ⚠️ **所有行号引用一律作废**——`node-core.mjs` 在 07-26 当天净增 776 行。全文按「函数名 + 邻近唯一语句」定位。

---

## 0. 结论摘要

沿用圆桌 / loop 的形态：**`EVENTS.md` 定 schema → 事件流 JSONL → 零依赖 `serve.mjs`（SSE）→ 单文件 `index.html`**。

graph 与那两个的**三处结构性不同**：

| | 圆桌 / loop | graph |
|---|---|---|
| 事件由谁写 | 主 agent 手写（靠纪律，会忘） | **`node-core.mjs` 自己写**（是代码，忘不了、零 token） |
| 拓扑从哪来 | 流程写死在 SKILL 里 | **没有必需、也没有可执行的拓扑**——skill 明确拒绝 plan/DAG 格式；`deps` 只是可选注解（§4） |
| 节点交付什么 | 一段文本 | read 交文本；**write 交文本 + 一份 workspace**（§2A） |

事件流是**每个 graph 一份**，落在 `<out-dir>/nodes/.runs/<graphId>/transcript.jsonl`（§3.1③），不是 outDir 根部固定的那份 `transcript.jsonl`。

---

## 1. 需求拆解

| # | 需求 | 现状 |
|---|---|---|
| R1 | 看整个 graph 图是什么样的 | ❌ 无拓扑来源（§4） |
| R2 | 有哪些节点 | ⚠️ 磁盘上有 `<id>.lock`（含 pid+时间），但**没有 receipt、没有事件**——viz 看不见 |
| R3 | 哪些节点**正在运行** | ❌ receipt 只在节点**结束**时才写 |
| R4 | 点开节点看**输入** | ❌ prompt 从未落盘（只被读去算 hash） |
| R5 | 点开节点看**输出**，按轮次区分 | ⚠️ 产出在，但**重说会覆盖上一轮**（§2.2） |
| R6 | 写节点**改了什么** | ❌ v1 完全没有这条需求（§2A） |

---

## 2. 必须先补的产品缺口

均在 `node-core.mjs`，是**产品改动**，不是 viz 改动。

**哪些改动与 viz 开关无关，必须先分清**：

| 改动 | viz 关时也做吗 | 为什么 |
|---|---|---|
| §2.1 冻结输入 | **做**（只冻结，不落盘） | 修的是 `specHash` 与实际派发内容可能不是同一份（真 bug，见下） |
| §2.2 每尝试独立产出 + `attempts[]` | **做** | 第一次尝试的产出被第二次覆盖是**数据丢失**，且它正是「打回重说」这个自动决策的唯一依据 |
| §2.3 `node:progress` | 仅 viz | 纯事件 |
| §2.4 `node:observed` / `node:queued` | 仅 viz | 纯事件 |
| §3.1 graph 归档 | 仅 viz | 观测层产物 |

### 2A. 写节点多出一份 workspace 交付物（R6）

⚠️ **早先的稿子的说法"写节点交付的不是文字，是分支+diff"是错的。** 写节点**同样必须**取得非空文字产出、算 SHA、据此做契约校验与复用（`copyBytes(settled.textRef, artifactPath)` 那条路径对 read/write 一视同仁）。

**正确说法：写节点 = 读节点 + 一份 workspace 交付物。**

回执里的 `workspace`（**以下是逐字段核过的真实形状**）：

```
workspace: {
  mode: "worktree",
  path, branch, baseCommit, headCommit,
  filesChanged: [{ status, path }],   // ← 对象数组,不是字符串;重命名编码成 "旧 → 新"
  diffPath,                            // ← **绝对路径**(见下)
  diffSha256, committed, changesKnown, removed,
  outcome: "delivered" | "no-changes" | "unknown"
}
```

⚠️ **`workspace` 里没有 `notes[]`。** `finish()` 里 `const { notes, ...rest } = fin` 把它拆出来并进了顶层 `receipt.diagnostics[]`。

⚠️ **`diffPath` 在回执里是绝对路径**，而本方案要求所有事件 ref 相对 out-dir（§3.2）。**光在文档里说"事件里另起名 `diffRef`"是不够的**（早先的稿子就停在这句上，结果两张表里都没有这个字段的位置）——**定死落点**：

- **回执增加三个相对 ref 字段**：`artifactRef` / `diffRef` / `sceneRef`，与现有的绝对 `*Path` **并存**（绝对路径给本机程序用，相对 ref 给页面用）
- 事件只带 ref，不带 Path

**`outcome` 是唯一权威结论**，源码注释写得很直白：「调用方一律只看它，不各自拿 `committed`/`filesChanged` 再推一遍 —— 三处各推一遍，迟早推出三种结论」。**viz 必须照办。**

### 2.1 输入从未落盘（R4）+ 冻结的分通道口径（**重写**）

prompt 与角色文件只被读去算 `specHash`，**没有进回执**。指纹能证明"输入没变过"，但**读不回来给人看**。

而且这里还藏着一个**与 viz 无关的真 bug**：`computeSpecHash()` 在 `normalizeSpec` 阶段读文件算指纹，而**实际派发是把原路径交给桥**（`message_file` / `append_system_prompt_file`），由桥在**排队之后**才去读。扇出时节点可能在闸上等几分钟——这中间文件被改，回执里的指纹就在描述一份**没有被真正派发过**的输入。指纹是复用判据，这等于给复用闸喂了假凭据。

**改法（三步，顺序不能换）：**

1. **`normalizeSpec` 阶段读进内存并冻结**（prompt 正文、role 正文各一份），`specHash` 算的就是这两份。
2. **派发用冻结内容，不用原路径**：
   - ⚠️ **prompt 与 role 是两条不同的通道**——role 走 `open_session` 的 `append_system_prompt_file`（→ system 侧），prompt 走 `send_message` 的 `message_file` / `message`（→ user 侧）。**绝不能把两者拼成一份 `input.md` 再派发**，那会把 system/user 边界抹掉，改变模型看到的东西。早先的稿子写「落一份 `input.md` 并让实际派发也使用这份快照」是错的。
   - prompt：冻结正文 ≤ 256 KiB 时直接走 `message`（内存直传，不落盘）；超过则写进**本次 run 的临时目录**（`os.tmpdir()` 下，`withBridge` 收尾时整个删掉）再走 `message_file`。
   - role：桥没有内联 system 参数，**必须给路径** → 一律复制到同一个 run 临时目录，派发那份副本。
3. **只有开了 viz 才把冻结内容持久化**到 graph 归档（§3.1）：`prompt.md`、`role.md`、`input.json`（会影响结局的 spec 字段清单）。

**为什么临时目录而不是直接落 `nodes/`**：落 `nodes/` 就意味着**viz 关着也在磁盘上留一份全量 prompt 明文**——那会把 §7 的隐私口径（"开 viz = 落明文"）偷偷废掉。

⚠️ **但这份承诺只能说到这个份上**：临时目录由 `withBridge` 的收尾删除，而 §3.4 已经确认**强杀不走收尾**。所以准确措辞是——

> **viz 关闭时不建立持久归档；正常收场与受控失败都会删掉临时副本；被强杀时临时目录可能残留。**

不能写成"随 run 消失"。要更强的保证，只有两条路：给桥加 inline system 通道（就不必落 role 文件），或加一套陈旧临时目录的清理协议。**v1 两条都不做**，如实写明即可——`os.tmpdir()` 下的残留至少不在仓库里、不进 git、系统会清。

### 2.2 重说会覆盖上一轮产出（R5）+ `attempts[]` 合同（**重写**）

`artifactPath` 是固定的 `nodes/<id>.md`，而 `copyBytes(settled.textRef, artifactPath)` 在**尝试循环内部**。`reask:1` 打回重说后，第二次**直接盖掉第一次**。

**「按不同轮次区分」用现在的数据做不出来。** 而且这是**数据丢失**：第一次差在哪，是「打回重说」这个 graph 少数几个自动决策之一的**唯一依据**，被自己覆盖了。

**改法**：每次尝试各写 `nodes/<id>.a<N>.md`（**viz 开关无关，一律写**）。回执增加：

```
attempts: [{
  n,                 // **1-based**,对外一致
  inputSha256,       // **总是有** —— 该次实际派发的 user 侧内容的指纹(64 位小写 hex)
  inputRef,          // string | null —— **viz 关时为 null**(见下)
  artifactRef,       // string | null —— **可能没有**
  artifactSha256,    // string | null —— 与 artifactRef 同生同灭(64 位小写 hex)
  status,            // "accepted" | "rejected" | "no-output" | "failed"
  rejectedReason,    // string | null (status==="rejected" 时必有)
  durationMs,        // number | null
  charCount          // number | null
}]
```

⚠️ **`artifactSha256` 不是可选的**。没有它，"复用命中时归档下来的都是刚验证过的"这句话**只对最终产出成立**：现有复用闸验的是顶层 `artifactSha256` 与 write 的 `diffSha256`，**没有人验过 `<id>.a1.md`**。于是——

1. viz 关着时某节点产生 `x.a1.md`（被打回）与 `x.a2.md`（最终采纳）
2. 有人改了 `x.a1.md`
3. 后一波开着 viz 命中复用，顶层产出与 diff 全部验过
4. **归档把那份被改过的 `a1` 复制成了"不可变历史"**

**定死**：每次成功复制 attempt 产出就算一次 SHA；复用时**对每个非空 `artifactRef` 逐个验**（预期路径 + 文件存在 + SHA 一致）。缺 SHA 或对不上 → **不复用**。这与顶层那道闸是同一个道理，源码注释也早写过：写成 `if (prev.artifactSha256)` 会让"字段缺失"静默跳过校验——**这一族缺陷这是第四次出现，不能再犯**。

#### `status` 四档的判定表（早先的稿子只给了枚举，没给映射）

| 值 | 什么时候 |
|---|---|
| `accepted` | 拿到产出**且**契约校验通过 |
| `rejected` | 拿到产出但契约不通过（`rejectedReason` 必填） |
| `no-output` | **已经确认产出是零字节**——注意是"确认为空"，不是"没拿到" |
| `failed` | 这次尝试开始之后发生**后端 / RPC / 本地处理**失败：send 被拒收、wait 断管、超时、**拿不到或读不了 `textRef`**、拿到文本但本地复制失败 |

⚠️ **`open_session` 失败不在这张表里**——那时尝试循环还没进，`attempts: []`。

⚠️ **"拿不到 `textRef`" 必须归 `failed` 而不是 `no-output`**：拿不到**不等于**对方没说话——运行时根本无法证明"它确实什么都没输出"，只能证明"我取不回来"。把取不回来说成"它没输出"，是这个页面替系统撒的一个谎。对应的节点总结局是 `unknown`。

#### ⚠️ 零字节产出：这里藏着一个既有的首跑/复用不一致（产品缺口）

核过源码：**首跑**时空字符串是能被复制下来的，没有契约要求时甚至会判 `ok`；而**复用闸**明确拒绝空产出（`st.size === 0` 直接报"产出文件缺失或为空"）。于是同一个结果**第一次说成功、第二次说不能用**——「第一次骗你、第二次才告诉你」，与源码自己批评过的那种残回执是同一族。

**定死（两边判据必须一致）**：零字节产出 → 该 attempt 记 `no-output` → **允许打回重说**；重说之后仍是零字节 → 节点判 `contract_error`（不是 `ok`）。

⚠️ 这是一处**产品行为变更**，必须与 `RECEIPT_VERSION` 升版一起写进 SKILL 的升级说明。

⚠️ **`artifactRef`/`durationMs`/`charCount` 必须允许为 null**：尝试可能死在 `send_message` 或等待阶段，压根没有产出可复制。早先的稿子把它们写成必填，是拿"顺利跑完"的形状当了全部形状。

⚠️ **`attempts[]` 的边界要说准**：尝试循环是在**拿到 session 之后**才进入的。所以 `open_session` 失败时**没有任何 attempt**（`attempts: []`），而不是"一条 failed 的尝试"。早先的稿子那句"尝试可能死在 open_session"是错的。

⚠️ **`inputRef` 必须可空，`inputSha256` 必须恒有**（见下）。早先的稿子同时要求「回执一律带 `attempts[]`（viz 关也写）」与「只有开 viz 才持久化输入」——**这两条互斥**：viz 关着时首轮 prompt 只在内存里、重说的输入是运行时拼出来的字符串、run 临时目录收尾就删，回执里那个"永久 `inputRef`"根本无处可指。

**取指纹这条路**：`inputSha256` 恒有（存成 64 位小写 hex，回执里就是 64 字节的字符串）；它保住了审计的实质——**给定一段文本，能证明它就是（或不是）当时派发的那份**——而不需要把明文留在磁盘上。明文归 viz 归档，与 viz 开关严格挂钩。

#### ⚠️ 那 UI 那句"两次原文都要能看"怎么办

复用一张**原运行没开 viz** 的回执时：第一轮 prompt 还能从本次的冻结快照恢复（同一份 specHash，内容相同），**但第二轮的输入只剩 `inputSha256` 与打回原因**——SHA 不可逆，归档层没有文件可拷，而文档又明令禁止 viewer 拿新版模板去重构旧输入。

**定死一条"可验证的重建"规则**：

1. **归档器**（不是 viewer）可以按当时的模板**构造一个候选重说输入**
2. **只有候选的 SHA 与回执里的 `inputSha256` 逐字节一致时**，才落盘并生成 `inputRef`
3. 对不上 → `inputRef` 保持 `null`，页面显示「**原运行未归档输入原文，仅保留指纹**」——**既不造内容，也不给死链接**

**为什么这不算"伪造历史"**：判据不是"模板看起来一样"，而是**指纹逐字节对上**。对不上就诚实地说没有。这条与"禁止 viewer 用新模板重构"并不矛盾——被禁的是**无校验的重构**。

⚠️ **`status` 必须是封闭枚举**，否则页面分不出「跑完了但格式不合格」（`rejected`）与「根本没吐东西」（`no-output`）。

⚠️ **`inputRef` 必须逐次保存，不能只存一次。** 第二次的输入不是 prompt——源码里它是**当场拼出来的一句话**（"上一条回复不符合约定的输出格式：<原因>…"）。**不能让将来的 viewer 用新版模板去临时重构旧输入**，那是伪造历史。

⚠️ **`nodes/<id>.md` 的语义要说准**：早先的稿子写「= 最终采纳的那份」不准确。它是**最后一次成功复制到本地的产出**——`contract_error` 收场时，那份是**被判不合格的**输出。页面不能把它标成"采纳"。

#### 回执要升版本，代价写明白

当前 `RECEIPT_VERSION = 1`，而复用闸是**严格等值比较**（`prev.receiptVersion !== RECEIPT_VERSION` 直接拒）。加了 `attempts[]` 与三个 ref 字段之后**必须升到 2**：不升的话，一张缺 `attempts` 的旧回执会被当成"支持新 UI 的回执"，页面只能显示空——又是一次「字段缺失＝静默降级」，这个仓库已经栽过三次。

**代价**：升版本会让**所有既有 out-dir 里的回执全部失去复用资格**（`reuseIfSame` 一律报"版本对不上"），必须重跑。这是真金白银的成本，**必须写进 SKILL.md 的升级说明**，不能让人在下一次分波时才发现。

### 2.3 活进度被丢弃（R3）

内层 wait 切片超时时（`runNode` 里读 `w.pendingSnapshots?.[0]` 那处），快照里有 `charCount` / `tail` / `status` / `lastEvent` / `contextUsage`，但**只取了 `contextUsage`**。

**改法**：发 `node:progress`（节流 ≥5s，`tail` 截 240 字）。**零额外 RPC**——数据已在手里。

### 2.4 排队中的节点在事件流里不存在（R2）

并发闸 `bridge._gate.acquire()` 在 `runNode` 的**公共路径**上（不在 access 分支里），`maxConcurrent` **默认 4**——**read 与 write 一视同仁都排队**。

⚠️ **早先的稿子说"排队节点在磁盘上完全不存在"是错的**：`<id>.lock` 在 acquire **之前**就创建了（含 pid + 时间）。准确说法是：**磁盘上有锁，但没有 receipt、也没有任何事件**，所以 viz 看不见。

扇出 8 个节点、名额 4 个时，有 4 个卡在闸上**在页面上凭空消失**。50 个 fresh 节点时可以有 **46 个同时排队**。

**改法**见 §6 的插桩顺序。三条容易搞错的：

- **复用命中的节点在闸之前就 `return` 了** → `node:settled{execution:"reused"}` **不该有 `node:queued` 前导**
- **`startClock()` 在 `acquire()` 之后**，注释写明「预算从真正开跑这一刻起算，**不含排队时间**」→ 排队中的节点**没有在消耗超时预算**，页面不能暗示它在倒计时
- **排队与"派给 AI"是两件事**：`open_session` / `send_message` 都在 acquire **之后**。排队中的节点**一个字都还没发给后端**

---

## 3. 数据面

### 3.1 一个 viz graph = 一个 `withBridge` + 一个 canonical outDir（**定案，可执行版**）

⚠️ **早先的稿子写「一个 out-dir = 一次运行 = 单进程。这不是新约束：`<id>.lock` 已经是这个前提」——是错的。** 锁只防**同名节点**；两个进程用不同 id 在同一 outDir 里跑完全合法。而 SKILL.md「写法三：分波」**明确要求不同波复用同一个 outDir**。

⚠️ **早先的稿子选了合同 A，但只写了"绑定第一个见到的 outDir"这一句，落不了地**：`startBridge()` 在跑用户回调**之前**就把桥起来了，而 outDir 直到 `runNode()` 的 `normalizeSpec()` 才第一次出现。「第一个见到的」是个没有时刻的说法。

**早先的稿子把合同 A 拆成四条可执行的规则：**

**① 绑定时刻定死在 `withBridge` 入口。**

`viz:true` 时 `outDir` **必填**（缺就 `UsageError`）。在**起 viewer 之前、建 transcript 之前、调用户回调之前**做完：`ensureDir` → `realpathSafe` → 记为 canonical outDir。

`realpathSafe()` 源码里已经有了（`runKey` 就用它算的），**必须复用**：只 `path.resolve` 挡不住符号链接、Windows 8.3 短路径这类**指向同一目录的不同写法**——那会让"同一个 outDir"这条合同在别名下静默失效。

**② `runNode` 的比较排在所有落盘之前。**

`normalizeSpec` 之后立刻比 canonical outDir，不同则 `UsageError`。**必须早于** `ensureDir(nodes)`、早于快照写入、早于创建 `<id>.lock`——否则拒绝之前已经在别人的目录里留了垃圾。

**③ `graphId` 每次 viz-enabled `withBridge` 调用生成一次 `crypto.randomUUID()`，transcript 用 `wx` 创建。**

**不从 pid / 时间 / outDir 推导**——那三样都会重复（pid 复用、同秒启动、同一 outDir 跑两波），而重复的 graphId 意味着两个 run 的事件混进一个文件。`wx` 撞了就重生成（实际不会发生，但这条闸是免费的）。

⚠️ **transcript 的路径是 `<out-dir>/nodes/.runs/<graphId>/transcript.jsonl`**（全文一律用这个写法；早先草稿里的 `transcript-<graphId>.jsonl` 已作废）。**它不在 outDir 根部。** 理由与 §3.1a 归档完全相同（脏树闸），而且 transcript 这条**更早爆**：它在**用户回调之前**就被创建，于是**第一个** write 节点的脏树闸就会把它当成用户的未提交改动拦下。

**这条不变式适用于 viz 写出的每一个字节**——transcript 与归档，一律在 `nodes/.runs/` 之下。（viewer **不再写任何状态文件**：pid 没有消费者已删，`viz.state.json` 同理——viewer 的状态活在它自己进程里，写出来只会多一个没人读的文件和一条脏树风险。）**没有例外**：只要有一个文件漏在外面，效果与全都漏在外面一样（脏树闸只需要一条脏条目就会拦）。

**④ 不要共享 writer 锁。**（与 codex 建议的分歧点，理由写明）

codex 建议加一把 `<out-dir>/viz.writer.lock`，配 ownerToken / 陈旧锁 fail-closed / viewer 代删。**这套机制在这里是多余的**：

- 每个 graph 写的是**自己那份 `.runs/<graphId>/transcript.jsonl`**，目录名带随机 UUID，**没有任何代码路径会去 append 一份已存在的 transcript**。单 writer 是**结构上成立的**，不是靠互斥换来的。
- graph 归档同样是 `graphId` 作用域，天然不共享。
- 剩下唯一共享的是 `nodes/` canonical 区，而那里**已经有** `<id>.lock` 管着同名撞车——viz 不改变这件事。

**加一把锁反而要还债**：陈旧锁怎么办？今天现场刚留下过一个 `S1-impl.lock`，正是这个失败模式。节点锁留陈旧锁值得 fail-closed（**它保护的是可能还没保住的代码**）；viz 的 writer 锁**什么都不保护**，为它逼人去手删文件是纯骚扰。**不存在的竞态不需要机制。**

**代价（合同 A 本身的，仍然成立）**：分波流程在页面上是**几张分开的图**，看不到跨波全貌。接受它，是因为分波之间本来就横着一个**主 agent 的人工决策点**（SKILL.md §写法三的全部意义就是"中途拿主意"），天然是"另一次运行"；而方案 B 的续写接管协议**恰恰是最容易出竞态的地方**，这个仓库在交接类竞态上已经栽过。

### 3.1a graph 归档：独立 transcript 还不够（**新增，BLOCKER**）

⚠️ **早先的稿子只把 transcript 分开了，没把 transcript 指向的东西分开。**

产物路径是**固定**的：`nodes/<id>.md`、`nodes/<id>.receipt.json`、`nodes/<id>.diff`，早先的稿子新加的 `input`/`attempt` 也是固定名。而分波允许同一个 id 被 `force:true` 重做——**后波一覆盖，前波那张页面上的"输入/产出/diff"就全变了，而页面自己浑然不觉**。这不是缺信息，是**伪造历史**，比缺失更糟。

**改法：canonical 区不动，另建 graph 作用域的不可变归档。**

```
<out-dir>/nodes/                                  ← canonical 区(执行与复用,行为完全不变)
<out-dir>/nodes/.runs/<graphId>/                  ← 本次 graph 的全部 viz 产物,只有开 viz 才有
        ├── transcript.jsonl    事件流(§3.1③)
        └── <seq>-<id>/         每个节点一份不可变归档(事件里**没有**字段指向这个目录,见下)
            ├── input.json          冻结的 spec 字段(**只是快照,不兼任资产目录** —— 见下)
            ├── prompt.md           冻结的 user 侧原文(**同时就是 attempt 1 的输入**,见下)
            ├── role.md             冻结的 system 侧原文(有才写)
            ├── attempt-<n>.input.md    **n ≥ 2 才有**(attempt 1 的输入就是上面的 prompt.md)
            ├── attempt-<n>.output.md   每轮都有
            ├── receipt.json        finish() 返回的那份(见 §3.3 为什么不是拷 canonical 的)
            ├── change.diff         write 节点才有
            └── scene/              非正常收场才有:session.log / answer.txt / status.json
```

⚠️ **目录里有什么，不靠 manifest 文件，也不靠一个目录 ref，全靠事件**（见下）。

#### 可选资产怎么被发现：不引入 manifest（与 codex 的第三处分歧）

问题是真的：viewer 不能靠"试着取 `role.md`、404 就当没有"来发现可选文件——**404 分不出「本来就没有」「还没写」「写失败了」「被删了」**，而这四种的处置完全不同。

codex 建议加一份 manifest（版本 / `complete` / 每个资产标 `pending|present|not-applicable|unavailable` / 先落资产再原子换 manifest / manifest 自身写失败又要另一套语义）。**早先的稿子不加**，理由：

- **事件流已经能表达这四种状态，而且是同一份真理源**：每个资产由**产生它的那条事件**announce（`node:observed` 带 `spec`/`prompt`/`role`，`node:attempt` 带该轮 input、`node:attempt-settled` 带该轮 output，`node:settled` 带 `receipt`/`artifact`/`diff`/`scene` 与兜底的 `attempts[]`）。⚠️ **事件层一律只讲 `AssetState`，不出现 `*Ref` 这种可空字符串**——`*Ref` 只活在回执与 canonical 合同里。
  - `present` → ref 非空（带 `sha256` 与 `byteCount`）
  - `not-applicable` → `state: "not-applicable"`
  - `unavailable` → `state: "unavailable"` + `code`
  - `pending` → 那条事件还没出现，而节点仍在运行——这是节点状态本身，不需要单独记
- **加 manifest 就得再答一遍"manifest 自己写失败怎么办"**——codex 自己也列了这条。**用一个新文件去解释旧文件的缺失，只是把同一个问题挪了一层**。
- v1 **不支持重开旧 run 的页面**（§3.4③），所以"脱离事件流去目录里认资产"这个场景本身不存在。真要人肉翻目录时，归档里的 `receipt.json` 已经写明这个节点产出过什么。

**代价是这四态必须在 schema 里封闭，不能靠"ref 为 null + 另一个字段里有没有提到它"这种隐式判据**（—早先的稿子用的正是那种隐式判据，而它有三个洞：`node:attempt` 的 input 没有自己的错误位、`archive-root` 失败时子资产会被误读成"本来就没有"、SHA/byteCount 只在总则里说了却没进 schema）。

**每个可点击资产在事件里都是一个判别联合，不是一个可空字符串：**

```js
{ state: "present", ref, sha256, byteCount }
{ state: "not-applicable" }                    // 本来就没有(没配 role、read 节点没 diff)
{ state: "unavailable", code }                 // 期望能给出,但给不出(原因看 code)
```

`pending` 不需要编码——那条事件还没出现、而节点仍在跑，本身就是这个意思。

⚠️ **`unavailable` 的含义是"给不出"，不是"出错了"**：下面的 `code` 里有一条 `fingerprint-only` **完全不是故障**，是用户当初选了 viz-off。早先的稿子把这一档写成"该写没写成"，等于给一次正确运行扣了故障的帽子。**这一档只表示「页面想给你打开、但打不开」，是不是故障由 `code` 分辨。**

**`code` 是一个开放的字符串，不是封闭枚举**（早先的稿子写的是"封闭枚举"，已改）——下面这张表是**目前已知需要各自文案**的取值，**以后会加**。消费方（UI）必须能显示一个没见过的 code：原样显示 + 通用兜底文案，**不得崩、不得静默降级成 `not-applicable`、也不得归到某条已知原因上**。

| `code` | 什么意思 |
|---|---|
| `archive-root-failed` | **这个节点自己的归档子目录**（`<seq>-<id>/`）建不起来，于是它的东西一样都没落下。⚠️ **不是 graph 归档根**——那个建不起来属于初始化失败，在用户回调之前就 fail-fast 了（§3.1a），根本走不到逐资产这一层 |
| `write-failed` | 该资产自己写盘失败 |
| `source-missing` | 源头就没有可拷的东西（如 `textRef` 取不回来） |
| `sha-failed` | 拷下来了但算不出指纹（**不能当 present**，指纹是复用与防篡改的判据） |
| `fingerprint-only` | ⚠️ **不是记录失败**：复用一张 viz-off 的旧回执，输入原文当初就没落盘，只剩指纹（§2.2）。**必须与上面几种分开**，因为它没有任何"出错了"的含义 |
| `unknown` | 兜底：**确实拿不到，但连原因都没分辨出来**。⚠️ 它是「已知的未知」，**不是**"没见过的 code 的落点"——生产方遇到分辨不出的失败才写它；消费方遇到没见过的 code 要照上面那条**原样显示**，而不是先偷偷改写成 `unknown` 再显示 |

⚠️ **还有一种状态不在这套联合里**：`recording-failed` 发生在某个资产的生产事件**之前**时，那个资产**根本没有 AssetState**——既不能说 `not-applicable`（不知道适不适用），也不能说 `unavailable`（不知道有没有尝试过），owner 都结束了更不能一直显示"等待中"。

**这是 viewer 的一个派生态，不进 schema**（因为它的本质就是"该出现的事件没出现"）：**「记录从第 N 条起不完整，这一项的状态未知」**。⚠️ **全局的记录损坏必须盖过逐资产的推断**——否则页面会拿"没看到事件"去推"本来就没有"，正是这套设计一直在防的那件事。

⚠️ **`archive-root` 失败时，该节点每个「本次本来就该归档」的资产都要各自标 `unavailable`**，不能只在根上标一次——否则按逐资产规则，它们会被读成"本来就没有"。

⚠️ **但先天不适用的槽位仍然是 `not-applicable`**：没配 role 的节点、read 节点的 diff、正常收场因而没有 scene——这些**本来就不该有**，把它们也标成 `unavailable` 就是把"从来不适用"谎报成"本该拿得到、现在拿不到"。早先的稿子那句"每个资产"过宽，连带把验收写成了会逼正确实现变差的假红。

#### ⚠️ `scene` 是目录，不能套同一个资产联合

`saveScene()` 建的是一个**目录**，里面**分别**尝试写 `session.log` / `answer.txt` / `status.json`，最后记 `{dir, tag, savedAt, files}`；而参考实现的 `/file` **明确拒绝目录**、只放行普通文件。所以 `scene: {state, ref, sha256, byteCount}` 这个形状根本落不了地：目录没有有意义的 sha 与字节数，`scene.ref` 也点不开，而 viewer 若自己去拼那三个文件名，就**又退回到 404 探测**——正是这套设计要消灭的东西。

**scene 定义成容器：**

```js
scene:
  { state: "not-applicable" } |            // 正常收场,压根没保现场
  { state: "unavailable", code } |         // 该保没保成(含 archive-root 失败)
  { state: "present", files: {
      sessionLog: AssetState,              // 三个子文件各自是完整的资产联合
      answer:     AssetState,              // ——三件套本来就可能只拿到一两件
      status:     AssetState,
  }}
```

⚠️ **`archiveRef` 整个删掉**：它不可点击，而每个文件都已经带着自己的 ref，viewer 根本不需要一个目录入口。留着它就是在只讲 `AssetState` 的事件层里再塞一个 `*Ref`——**第二套合同**。归档的物理布局仍如上图，只是不再有事件字段指向那个目录。

⚠️ **写成自由文本就前功尽弃**：那时 null 又变回"不知道为什么没有"，和 404 一样含糊。**是这套判别联合、而不是一份 manifest，把"没有"与"没写成"分开的。**

#### ⚠️ attempt 产出必须由事件自己兜住

早先的稿子声称"`node:attempt` 带该轮输入输出 ref"，但事件表里它**只有 input**。于是有一条确定会断的路：

1. attempt 1 的产出**成功归档**
2. attempt 2 完成
3. **`receipt.json` 归档失败** → `node:settled.receipt.state = "unavailable"`
4. 而内联兜底**刻意不含 `attempts[]`**（怕无上限）
5. → 页面**发现不了那份确实存在的 attempt 1 产出**，只能猜文件名

**定死两条：**

- **`node:attempt`**（尝试开始时）公布本轮 input 的资产状态与 `inputSha256`
- **`node:attempt-settled`**（该轮**收场时立刻发**）公布本轮 output 的资产状态与该轮 `status`

  ⚠️ **四种 status 都要发，不只"有产出"那种**（早先的稿子写成"产出归档完成后"，把 `no-output` / `failed` 两种漏在外面）。**位置定死：在决定要不要打回重说、或进入 `finish()` **之前**；每个已经进入 `attempts[]` 的尝试，非强杀情况下**恰好发一条**。

  ⚠️ **attempt 条目本身的创建时机也要锚死**：尝试循环顶部**先查剩余预算**，预算耗尽时源码明说"还没来得及发第 N 轮"。所以 attempt 要在**那道检查通过之后、`send_message` 紧之前**建立——**一进 while 就写 `attempts[]` 会凭空造出一次从未发送的假尝试**。

  | 该轮 `status` | `output` 资产状态 |
  |---|---|
  | `accepted` / `rejected` | `present`（拿到了产出并归档成功）或 `unavailable`（归档失败） |
  | `no-output` | **`present`（`byteCount: 0` + 空内容的 SHA）**，归档失败才是 `unavailable` |
  | `failed` | **`present` 或 `unavailable`** —— 见下，**不能一律写死成 `unavailable`**，更不能说成 not-applicable |

  ⚠️ **`no-output` 不是 `not-applicable`**：文档自己规定了**每次尝试一律写 `nodes/<id>.a<N>.md`**，而 `copyBytes()` 对零字节文件照常成功、空文件的 SHA 也算得出来。**磁盘上确实躺着一份审计原件**，事件却说"不适用"，就是在否认一份存在的证据。

  **两个维度不能合并**：`status` 说的是**这一轮尝试的结局**；`AssetState` 说的是**证据有没有被成功归档**。

  ⚠️ **`failed` 同理，早先的稿子只修了一半**：源码里存在"**文件已经复制成功、后续本地处理才失败**"这个窗口——

  ```js
  if (settled.textRef && copyBytes(settled.textRef, artifactPath)) {
    try { text = fs.readFileSync(artifactPath, "utf8"); }
    catch (e) { receipt.diagnostics.push(`产出已复制但读不回来:${e.message}`); }
  }
  ...
  if (text === null) return await finish("unknown", …)
  ```

  **`copyBytes` 已经成功，盘上确实有那份产出**，只是这一轮读不回来所以判失败。把 output 写死成 `unavailable`，就是把一份**已经保住的证据**说成没保住——和 `no-output` 那个错误是同一个：**为了让矩阵好看，隐藏一份真实存在的文件**。
- **`node:settled` 恒带一份有界的 `attempts[]` 资产摘要**（每项：`n` / **`inputSha256`** / input 状态 / output 状态 / `status` / `rejectedReason?`），作为**兜底**

  ⚠️ **`inputSha256` 恒有，这一条是必须的，不是对称美**：**复用命中的节点不发任何 attempt 事件**（源码在幂等闸后直接 `return { ...prev, reused: true }`，§6 插桩表也只让它发 `node:settled`）。于是有一条完整的丢失路径：

  1. 原运行 **viz-off** → 重说的输入原文当初没落盘，只有指纹
  2. 本次**复用**命中 → `input.state = "unavailable", code = "fingerprint-only"`
  3. 归档那份 `receipt.json` **也写失败** → 页面打不开回执

  此时既没有 `node:attempt`（复用不发），`unavailable` 联合里又只有 `code`、没有 SHA——UIREQ §6.2 要求显示的「**仅保留指纹**」**连那串指纹都拿不出来**。而指纹恰恰是那一段仅存的审计价值。

⚠️ **`node:attempt-settled` 不是冗余**：只靠终态里的 `attempts[]` 仍有一条断路——attempt 1 的产出**已经归档好了**、attempt 2 正在跑、这时 owner 被强杀，于是**永远不会有 `node:settled`**，那份确实存在的产出**从没被任何事件公布过**。而 UIREQ 要求"两次的输入输出都要能看"。**每轮产出一落盘就宣布**，这条路才闭合。

⚠️ **这不违反"事件不复制大字段"**：源码限死 `reask ∈ {0,1}`，所以 `attempts` **最多两项**，且每项只有指纹与状态、不含正文。"怕无上限"在这里不成立。

**viz 写出的东西全在这一棵子树里**，一个字节都不落在外面——理由见下。

⚠️ **归档为什么必须放在 `nodes/` 底下、不能放 `<out-dir>/runs/`**（核过的精确形态）：

脏树闸 `dirtyEntries` 的排除判据是 **「`??`（未跟踪）且路径前缀等于 `outDir/nodes`」**，逐字节精确，不多排。源码注释写明为什么不能排整个 outDir：outDir 是调用方给的任意目录，传成 `repo/src` 就会把真实源码改动一起吞掉，"一道安全闸被它自己的排除项悄悄关掉"。

于是：**只要 outDir 在仓库里、且没有被 gitignore**，归档落在 `nodes/` 之外就会以 `?? <outDir>/runs/…` 的形式被算成脏——**我们自己写的观测归档把主树弄脏，然后被我们自己的脏树闸拦下**，后续每个 write 节点全部开不了工。纯自伤。

（本仓 `.graph/` 恰好在 `.gitignore` 里，所以**在这里试不出来**——这正是它危险的地方：它只在别人的仓库上炸。而那道排除逻辑本身的存在就证明"outDir 未被忽略"是被认真对待的场景。）

放 `nodes/` 底下则保住了源码那句不变式：**本工具只往 `outDir/nodes` 下写**，排除范围正好等于这个事实。

**核过的兼容性**：`nodes/` 下没有任何 `readdir` 扫描——所有访问都是精确文件名（`<id>.md` / `.receipt.json` / `.diff` / `.lock` / `.scene`）。新增一棵 `.runs/` 子树对复用闸、锁、`assertCleanBase` 的 `relOut` 计算**全都是惰性的**。

⚠️ **`<seq>-<id>` 的 `seq` 是该节点在本 graph 内的序号**（同步递增，`runNode` 一进来就分配）。不能只用 `<id>`：同一个 `withBridge` 里用 `force` 顺序重跑同一个 id 是合法的（源码只禁止**同时活跃**的同名 id——`active.delete(activeKey)` 在 `finally` 里），只用 id 会自己覆盖自己。

#### ⚠️ `nodeSeq` 必须同时进事件，不能只进路径

早先的稿子只把 seq 用在归档路径上，**事件里仍然只有 `id`**——于是同一个 graph 里出现两组 `id=x` 的事件时，页面分不清哪条属于哪一次。具体会错成什么样：

1. 第一次 `id=x` 正在 running
2. 第二次 `id=x` 发出 `node:observed`，随即因撞锁发 `node:rejected`
3. 页面看到 `id=x` 的 rejected，**把正在跑的那一次标成了被拒绝**

**定死**：`runNode` 一进来就分配同步递增的 `nodeSeq`，**所有 `node:*` 事件必须带 `nodeSeq`**；`id` 从此只是**逻辑名与显示标签**，不再是页面的主键。

**页面的唯一键是 `(graphId, nodeSeq)`**，写法上记作 `nodeRunId = "<graphId>:<nodeSeq>"`。⚠️ **但它不是 wire 字段**：`graphId` 已经在**每一条信封**里，`nodeSeq` 在事件里，再传一个由这两者拼出来的字符串，就是**同一个身份的第三份副本**——而副本能和它的来源打架。**由客户端拼**。

（另一条路是"禁止一个 graph 内重复 id"，但那会推翻 §3.1a 已经接受的合法形态，而且是产品行为变更——不做。）

#### ⚠️ 归档必须是**传递闭包**

早先的稿子只说"拷产出与回执"，这不够。复用命中时源码返回的是 `{...prev, reused:true}`——**旧回执里那些 ref 原封不动**，指向 canonical 区或**上一个 graph 的归档**。于是后波一 `force`、或旧归档被清，这张新图照样变质，等于白做。

**规则（三条，缺一不可）：**

⚠️ **attempt 1 的输入不另存一份**：源码在第一轮发的就是 `spec.promptFile` 的内容或 `spec.prompt` **原文，不做任何加工**（reask 文案从第二轮才出现）。所以 **`attempts[0].input.ref` 直接指向归档里那份 `prompt.md`**，**`attempts[0].inputSha256` 必然等于 `prompt` 资产的 `sha256`**。存第二份相同字节没有任何新信息，而两份相同字节的东西**迟早会被改成不同**。

**这条不是约定，是可验的断言**：验收要断言这两个 SHA 相等、且归档里**没有** attempt-1 的独立输入文件。真有一天源码开始加工首轮输入，这条断言会当场变红——那正是我们想要的。

1. **写进归档的回执，其内部所有相对 ref 一律重写**到当前 `<graphId>/<seq>-<id>/`——顶层 `artifactRef`/`diffRef`/`sceneRef`，以及 `attempts[].inputRef`/`attempts[].artifactRef`。
2. **凡是页面能点到的 ref，目标必须在当前 graph 的归档里**：不得跨 graph，不得指 canonical。`scene/`（会话日志、answer、status）与全部 attempt 的输入输出、diff 都在闭包内。
3. **先原子写成功，再发引用它的事件。** 顺序反了就会有一段时间事件指着一个还不存在的文件——页面读到 404 会当成"文件丢了"。

#### 归档写失败算什么（早先的稿子完全没写）

只封闭了最终 `receipt.json` 写失败是不够的，`input.json` / attempt / diff / scene 任何一步都可能失败。**分两档，判据是"它会不会改变执行结局"：**

| 何时失败 | 怎么办 |
|---|---|
| **viz 初始化**（建归档根、建 transcript、起 viewer） | **fail-fast，在用户回调之前**。这时候还什么都没跑，报错停下最便宜 |
| **初始化之后的任何观测写入**（归档 / 事件） | ⚠️ **绝不改变节点的业务结局**。把该资产标成 `unavailable` + `code`（**绝不发死 ref**）|

**为什么这条界线要划死**：viz 是观测层。让它有权把一个已经交付了代码的节点判成失败，就是让温度计决定病人的死活。⚠️ 而这在这份源码里是**一句话就会发生的事**：`runNode` 有一个通用 catch，观测层随便抛一个异常上去，就会被分类成业务上的 `unknown`。

**由此推出三条硬性要求：**

1. **初始化成功之后，所有 emitter 与归档写入必须是 non-throwing 的**——内部自己 try/catch，对外只返回"写没写成"。
2. **事件层的每个资产都是 `AssetState` 判别联合**（见上），**不是可空字符串**——"写没写成"由 `state` 说，不由"ref 是不是 null"猜。**事件里不存在任何 `*Ref` 字段**（回执里的 `*Ref` 是另一份合同，不受此约束）。
3. ⚠️ **输入三件套的资产状态由 `node:observed` 承担**：它发生在拿锁之前，而节点接下来完全可能直接走 `node:rejected`——**那条路上没有 `node:settled` 可挂**。早先的稿子曾把记录失败只挂在 settled 上，路就断了；早先的稿子一度让 `node:rejected` 也重复带一份，****现在删掉了那份重复**（observed 必先于 rejected，且不可丢）。

#### transcript writer 自己坏了怎么办

事件 writer 的 `writeSync` 也会失败（EIO、磁盘满）。两种处理**都错**：

- **让异常穿上去** → 被 `runNode` 的通用 catch 变成业务 `unknown`（见上）
- **静默吞掉** → 终态或 `run:final` 凭空消失 → viewer 合成**假 `abandoned`**

**定死**：writer 坏掉后不再抛、也不再假装在写，而是**通过已有的生命管道发一条有界的控制消息**。

⚠️ **但只发一条 `recording-failed` 只解决了一半**：writer 一旦坏了，`run:final` 就再也写不进 transcript 了；于是「**坏了之后正常收场**」与「**坏了之后又被强杀**」在 viewer 眼里长得一模一样（都是 `recording-failed` + EOF + 没有 final）。

**最小控制协议（生命管道上只有两种消息）：**

| 消息 | 何时发 | 内容 |
|---|---|---|
| `recording-failed` | writer **首次**损坏 | `{ atSeq, lastGoodOffset, error }`（`error` 走 `boundedSummary`） |
| `owner-final` | transcript 已坏、但父进程**完成了受控收尾** | `{ result, endedAt }` |

⚠️ **`lastGoodOffset` 不是装饰，它是两条通道之间唯一的排序依据**：控制消息走 IPC（**立刻到**），而正常事件靠 viewer 每 500ms tail 文件（**慢一拍**）。于是有一条必现的错误时序：

1. writer 成功写入 `seq=11 node:settled`（**字节已经在盘上**）
2. viewer 的下一次 poll 还没发生，它**根本不知道有 seq 11**
3. writer 写 `seq=12 run:final` 失败 → IPC 立刻送来 `recording-failed{atSeq:12}` + `owner-final`
4. viewer 此刻缓冲区是空的（它没观察到 seq 11），于是**直接公布控制状态**
5. 下一次 poll 才读到 seq 11 —— **终态控制消息又排到了更早的正常事件前面**

早先的稿子只解决了"已经进到客户端缓冲里的事件"与控制槽的顺序，**这条跨通道的路它管不着**：缓冲区只能缓存 viewer **已经观察到**的东西。对已经 live 的客户端**必现**，对正在回放的客户端也会发生。

**定死（writer 侧，两条）：**

1. **`lastGoodOffset` = "最后一个完整换行之后"的排他字节偏移**，**只在一整行（含 `
`）的全部字节都写完时一次性推进**。它由**累加已写字节**维护。
2. ⚠️ **短写之后，物理 EOF 会比它大，但绝不许推进它；失败时更不许拿 `stat().size` 去重算**——那正好会把半行算进"可信边界"，而这套设计前面所有关于"末尾半行"的处理都建立在"可信边界只到完整行"上。

**定死（viewer 侧，四条）：**

1. **全局只有一个 tail reader**。它独占 `bytesRead` / `pendingBuf` / decoder 这三样状态（参考实现 `serve.mjs` 的 `poll()` 就是这么写的，别再起第二个）。
2. 收到 `recording-failed` **不是另起一个 reader 去 drain**，而是**把那个唯一 reader 的 `targetOffset` 提到 `lastGoodOffset` 并 await 它**。⚠️ **两个 reader 同时从旧偏移读，会重复广播、会把 decoder 的多字节字符拼坏**——这是确定的竞态，不是理论风险。
3. 已经预读进来、位置 **> `lastGoodOffset`** 的字节**全部丢弃，永不解析**（那正是那半行）。
4. **drain 自己失败也必须有出口**：进入「历史读取失败」态，**然后照样公开 `recordingFailure` / `ownerFinal`**。⚠️ **不能因为 drain 失败就永远不公开控制槽**——那样页面会一直假装"还在运行中"，而这是这份文档从头到尾在防的那类谎。

之后才公开 `recordingFailure` 槽（`owner-final` 排在它后面）。

⚠️ **新连接在 drain 期间接进来是允许的**：它照走回放五步，但**已知损坏时它的 `cutOffset` 取 `min(最后完整换行, lastGoodOffset)`**，之后与所有客户端共用同一套队列与过滤合同（`seq < atSeq`）。

**为什么不选"writer 每写一条就 IPC 报一次 `transcript-advanced{endOffset}`"**：那等于把整条事件流在控制通道上再走一遍——**第二个真理源**，还把控制通道从"两条消息"变成高频流。损坏是**一次性**事件，只在那一刻需要一个偏移量，没必要为它维持一条常流。

**viewer 的判定优先级（四档，按顺序取第一个匹配）：**

1. transcript 里有 `run:final` → 按 transcript 说的算
2. `recording-failed` + `owner-final` → **受控结束，但观测记录损坏**
3. `recording-failed` + EOF，**没有** `owner-final` → **观测损坏，且 owner 也丢了**
4. 以上都没有、EOF 前也没 final → 「**未观测到正常收尾**」

⚠️ **第 4 档的措辞要留余地**：它**绝大多数**情况确实是强杀，但**两条通道同时坏掉**（transcript writer 坏了 **且** 控制管道也没送出 `recording-failed`）时，owner 其实可能有序收了场。这是一个**消不掉**的双故障——不必为它加机制（再加一条通道只是把问题挪到第三条上），但页面**不能替它下"进程一定被杀了"的结论**。

#### 控制通道本身的合同（早先的稿子只定义了两条消息，没定义怎么传、怎么回放）

- **传输**：优先用 Node 的 **IPC 通道**（`fork` 自带，天然是消息边界）。若改用字节流，则**必须是 UTF-8 NDJSON 并缓冲到完整换行再解析**——半条消息与粘包在这里和 transcript 的半行是同一类问题。
- **viewer 侧存两槽状态**：`recordingFailure` 与 `ownerFinal`，各只记第一条。
- ⚠️ **每个新 SSE 客户端的下发顺序固定**：先 transcript 回放 → **再补发当前控制状态** → 才进 live。**少了中间这一步，刷新一次页面就把"记录已损坏"忘了**，于是又变回假 `abandoned`。

  ⚠️ **光规定顺序还不够，切换本身要无缝**：参考实现之所以没有这个问题，是因为它**同步**遍历内存数组、随后**同步** `clients.add(res)`——中间没有让出事件循环。改成从文件回放后，只要读是异步的就必然三选一地出错：回放完才注册 live → **回放期间的新事件全丢**；先注册 live → **新事件插到历史前面**；控制槽在回放期间变化 → **补发的是旧值或者乱序**。

  ⚠️ **不能同步整文件读**（—早先的稿子选了这条，是错的）：文档只封了**每行**与内存窗口，**从没封过 transcript 的总行数或总字节**。`timeoutMs` 没有上限、`withBridge` 的回调是任意 JS（想循环产生多少节点都行）、`maxConcurrent` 只限并发不限累计，而 `MAX_EVENTS` 只淘汰**内存数组**、**根本不截断磁盘文件**。源码自己就写着整文件 `readFileSync` 会冻住事件循环。

  **定死（每客户端 replay buffer，五步）：**

  1. 捕获最后一个完整换行的 `cutOffset`
  2. 把该客户端登记为 `replaying`，并开始缓存所有 `endOffset > cutOffset` 的 live 事件。⚠️ **第 1、2 步之间不得让出事件循环**（不能有 `await`）——"立刻"这个词不足以约束实现，写成禁止让出才是可核对的
  3. **异步流式**读 `[0, cutOffset)` 下发，**遵守 SSE 背压**（`res.write()` 返回 false 就等 `drain`；参考实现没做这件事，大文件下会把阻塞放大成内存压力）
  4. 回放结束 → **先按 `seq` 去重冲刷缓存** → **再补发当前控制槽**
  5. 在**同一个事件循环 turn 内**转 live

  ⚠️ **第 4 步的两件事顺序不能反**（—早先的稿子写的是"先控制槽再冲刷"，错了）。反例是确定的：捕获时到 `seq=10`；回放期间 `seq=11 node:settled` 写成功并进了缓存；写 `seq=12 run:final` 时磁盘故障 → viewer 收到 `recording-failed{atSeq:12}` 与 `owner-final`。按早先的稿子的顺序，客户端**先**看到"记录损坏、运行已结束"，**然后**才看到更早的 `seq=11`——如果 UI 在 `owner-final` 之后冻结了 reducer，那条终态直接被丢掉。

  **配套两条：**

  - 若已有 `recordingFailure.atSeq = N`，冲刷出去的事件必须满足 **`seq < N`**（记录都从 N 断了，之后的东西不该以"正常事件"的身份出现）
  - 冲刷过程会因背压 `await drain`，期间控制槽还可能再变 → 用一个 **`controlRevision` 版本号**：循环到「队列空 **且** 当前控制版本已发出」为止，再切 live。控制槽固定按 **`recordingFailure` → `ownerFinal`** 的顺序发。

    ⚠️ **`controlRevision` 是 viewer 进程内部的计数器，不是 wire 字段**——它既不进 transcript，也不进 SSE，更不在控制消息里。写清这一点是因为上一版没写，而"文档里出现的名字"很容易被实现成"协议里的字段"。

  ⚠️ **每客户端缓存超限时：断开连接、让它重连**——**绝不静默丢事件**（静默丢在这套设计里永远等价于"伪装成本来就没有"）。

  **上限必须是一个数，而且是字节**：**按下发给该客户端的 SSE 帧的 UTF-8 字节计，每客户端 32 MiB**。⚠️ **不能按"条数"计**——单行上限是 1 MiB，一万条就能到 10 GiB，条数上限等于没有上限。**心跳不计入**（它不排队，队列非空时本来就不该发心跳）；**事件与控制消息都计入**。超限的动作是 `res.end()` 断开，**并在断开前发一条 `event: viz:overflow` 的具名 SSE 事件**（有界 data），让页面能把这次断开显示成"数据太快，正在重连"而不是"服务停了"。

  ⚠️ **不能用 SSE 注释帧**：注释以 `:` 开头，**规范上就是保活用的、浏览器根本不把它交给页面**（参考实现的 `: hb` 正是这个用法，而前端只挂了 `onmessage`）。写成注释等于承诺了一件页面收不到的事，配套验收也会假绿。**队列上限之外要预留这一帧的余量**，否则"超限时发一帧"自己就发不出去。

  ⚠️ **重连之后是一次全量回放，所以浏览器侧必须按 `seq` 去重**——参考实现 `viz/index.html` 已经有这段逻辑，照抄，别丢。否则一次超限断开会让页面把所有历史事件**重算一遍**（计数翻倍、时间轴重影）。

  **回放自身的失败也要有归宿**：`open` / `stat` / 流式读**任何一步失败**，或读到**非末尾位置的坏行**（末尾半行是正常的，见 §3.2），都进入一个 **viewer 本地状态「历史读取失败」**：页面整体标注、**并且禁止据缺失事件推断任何节点或资产不存在**。

  ⚠️ **它绝不能被显示成「运行被掐断」**——那是关于 owner 的结论，而这里出问题的是**读历史的这一侧**，owner 可能好端端地在跑。这与 `recording-failed`（写坏了）也不是一回事：一个是我们写不下去，一个是我们读不回来。

  ⚠️ **顺带删掉一样东西**：一旦回放从文件走，全局那个 `events[MAX_EVENTS]` 历史数组**就不再是正确性组件**，直接删掉，别留着当第二个真理源。

  ⚠️ **但"live 直接广播"不等于"live 不用管背压"**：live 客户端的 `res.write()` 一样会返回 false。**每个客户端都有一条 outbound 队列**（回放中的缓存与 live 的积压是同一条），**同一个上限**，超限同样是**断开让它重连**。否则"慢客户端"那条验收根本没有可实现的合同去对。
- ⚠️ **`run:final` 自己写失败也算 recorder 首次损坏**：此时要先发 `recording-failed`，**受控清场做完之后、关管道之前必须补发 `owner-final`**。

  早先的稿子的收尾第 6 步写的是"写 final → 关 writer → 关管道"，**没有 writer 已坏时的分支**——照那个顺序走，final 写挂了就直接关管道，viewer 只能看到 `recording-failed` + EOF，把一次**有序收场**误判成第 3 档的"owner 也丢了"。
- **`owner-final` 必须完整写出之后再关管道**：完整消息先于 EOF。

⚠️ **writer 坏掉之后，viewer 必须整体标注「从 seq N 起记录不完整」，而不是把缺失的节点事件逐个合成 `abandoned`**——那些节点很可能好好地跑完了，只是没人记下来。把记录故障摊派成一堆节点事故，是这个页面能犯的最有误导性的错误之一。

**复用命中的节点也归档**（把复用来的产出与回执各拷一份）。这正是不可变归档的意义：将来 canonical 那份被后波覆盖了，这张图里显示的仍是当时真正被复用的内容。

⚠️ **归档时机在复用闸之后，这一点必须守住**——那道闸不是走过场：它逐项坐实了产出 sha、diff sha、基线 commit，**并且 `git rev-parse` 验过那条分支现在还在、还指着回执记的那个 commit**。所以复用命中时归档下来的东西，是**当时刚被验证过**的，不是从一张旧回执上抄来的传闻。反过来说，若把归档挪到闸之前，页面就会开始展示一批没人验证过的坐标。

**事件里的 ref 一律指归档**，不指 canonical。canonical 路径仍在回执里（绝对 `*Path`），给本机程序用。

### 3.2 信封

`{ v, seq, ts, graphId, event, payload }`，append-only，**单 writer（由 §3.1 的结构保证，不靠锁）**。

- 所有 `*Ref` 一律**相对 out-dir**
- **半行容错**：writer 崩溃可能留下无换行结尾的半行，回放与 tail 都必须缓冲到下一个 `\n` 再解析

#### ⚠️ 单 writer ≠ 有序

"只有一个 writer 对象"**不等于**异步 append 自动按 `seq` 落盘：A 分到 `seq=10` 发起异步写后让出，B 分到 `seq=11` 却先写完——transcript 里就是 11 在 10 前面。并发节点是常态（默认 4 个名额），所以这不是理论问题。

**定死**：writer 用**一个长期打开的 fd + 同步 `writeSync`**，或把所有 append 串到一条 Promise 链上。**这与共享文件锁无关**，不引入任何陈旧锁问题。

#### ⚠️ 大小必须真的封闭

早先的稿子只做到了**字段名封闭**，字节数并没有。至今没有上限的字段至少有：`node:rejected.error`、`errorSummary`（只写了"截断"，没写截到多少）、`contextUsage`、`declaredDeps[]`/`inferredDeps[]`、`group`/`id`。源码的 `requireString()` 只验非空、**不限长**。

**这不是洁癖**：圆桌那份 serve 对超过 **1 MiB 的行直接静默丢弃**（`pushLine` 里一个 `return`）。丢的若是 `node:settled` 或 `run:final`，页面就会合成一个**假的 `abandoned`**——一条"事件太长"最后表现成"运行被掐断"。

**定死四条（都是 MUST，不是"建议"）：**

1. **每个自由字符串与数组给出上限**：`error` / `errorSummary` 各 **2 KiB**；**`rejectedReason`（事件里与 `attempts[]` 里两处）1 KiB**——它由 `weakCheck` 拼出来，里面能塞进任意长的 `requiredKeys`；资产的 `code` **200 字节**（一个短码，不是错误正文）；`tail` **240 字**；`id`（只出现在 `node:observed`）/ `group` / **`model` / `effort`**（源码只 `requireString()`，不限长）/ 每个 dep 字符串各 **200 字节**；`declaredDeps` / `inferredDeps` 各 **200 项**；**`ref` 512 字节**（相对路径，形状由我们自己构造）；`sha256` 固定 64 位小写 hex；`byteCount` 非负整数；**`contextUsage` 只取白名单字段**（`tokens` / `live` / `isCompacting` / `autoCompactionEnabled`）——它现在是后端原样给的对象，形状没有任何约束；`run:final.counts` 是**固定键集**的计数对象。

   ⚠️ **早先的稿子漏掉的一批路径类字段一并封上**：`run:started.outDir`、`node:observed.cwd`、`node:workspace-*.path` / `branch` / `baseCommit`、`workspaceSummary` 里同名的几项——**各 512 字节**（与 `ref` 同一档）。`node:progress.lastEvent` **只取白名单字段**（`at` / `type`，`type` 200 字节），理由与 `contextUsage` 完全一样：**它是后端原样给的对象**。**`halt` 已从事件里删掉**（见 §3.3），所以"任意 JS 返回值怎么序列化"这个合同**整条不需要**了。

2. **超限走同一个 `boundedSummary()`**——⚠️ **但只对「人类文本」字段**：形状固定：

   ```
   { name, code, totalBytes, sha256, head, tail, omittedBytes }
   ```

   ⚠️ **必须同时留头和尾**：只截头是这类实现最常见的错——**报错的根因往往在最后一行**（`... caused by: EACCES`），只留开头等于把最有用的那段丢掉。`sha256` 让"页面上这段"与"真实那段"可对证。

   ⚠️ **"超限一律换成 `boundedSummary`"这句话本身有个洞**：它套到 `id` / `ref` / `code` / `sha256` / `path` / `branch` 这类**结构字段**上，会让一个字符串**突然变成一个对象**——页面拿着 `ref` 去拼链接，结果拿到 `{name, code, head, tail…}`。**那是当场违反事件 schema，也就是第 3 条那条不变式所要守的东西**。

   **定死**：只有**显式声明为 `string | BoundedSummary`** 的字段才允许降级——**目前只有三个**：`error` / `errorSummary` / `rejectedReason`。⚠️ **`tail` 不在其中**——它本来就被定义成"末 240 字的字符串"，天生有界，再给它一条降级路径是凭空多一个形状。**结构字段永远保持原类型**：超出上限说明上游给了一个不合合同的值（比如 600 字节的分支名），**那属于 recorder 层的失败，走 `recording-failed`，不许悄悄换类型**。
3. writer 落盘前**再量一次整行 UTF-8 字节**。

   ⚠️ **只有 `node:progress` 可以整条丢**（丢一条无所谓，下一条 5 秒后就来）。

   ⚠️ **其余事件的规则是一条不变式，不是一张"哪些字段重要"的清单**（**并因此删掉早先的稿子刚加的逐事件 MUST 列**）：

   > **除 `node:progress` 外：字段级有界化之后，schema 里实际存在的字段一个都不能少；只有语义上标 `?` 的字段可以缺席。若一条完整的、已经有界化的事件仍然超过行上限，说明是 §3.2 的上限本身定失算了——这时转 `recording-failed`，而不是砍字段。**

   ⚠️ **这条不变式要成立，"schema"必须是唯一且完整的一份**：现在它散在 §3.2 信封 / §3.1a 的 `AssetState` 与控制消息 / §3.3 事件表 / `node:settled` 的独立代码块 / 以及"所有 node 事件隐含带 `nodeSeq`"这条表外规则里。**施工时必须先把它们合成一份 `EVENTS.md`**（写成完整判别联合，照 `skills/agent-bridge-roundtable/EVENTS.md` 的体例），**那一份才是规范**；本文档从那时起只解释"为什么"，不再当字段清单用。**否则这条不变式又会退化成早先的稿子那个"两个真理源"**。

   **为什么必须是不变式而不是清单**：早先的稿子只写了笼统的"保住骨架"，早先的稿子改成逐事件列 MUST——**结果第二轮就又漏了** `execution`（复用标记）、`outcome`（write 的权威结论）、`counts`、`inputSha256`、`rejectedReason`，还给 `run:final` 列了它根本没有的 `nodeRunId`/`id`。**"每轮重新猜哪些小字段可以牺牲"这件事本身就是缺陷源**。§3.2 已经给每个字段、每个数组、每个资产、`attempts[]` 都定了上限，所以"完整事件"天然有界，不需要再挑一遍。——早先的稿子写成"非终态事件超限可以整条丢"是错的：`node:observed` 带着 spec/prompt/role 三份资产状态，`node:attempt` 带着本轮 input，`node:queued`/`node:started`/`node:workspace-*` 决定了中断时落在六档 `abandoned` 的哪一档。**这些一旦没进 transcript，"从文件完整回放"也回放不出来**——那正是无 manifest 方案的地基。

   ⚠️ **连有界骨架都还超限**（病态输入）→ **转 `recording-failed`**，**绝不静默丢行**。静默丢是这套设计里最坏的失败方式：它会伪装成"本来就没有"。

#### ⚠️ 回放窗口：不许静默残图

圆桌那份 serve 在内存里只留 `MAX_EVENTS = 20000` 行，超了就 `shift()` 掉最老的，而**新连接回放的正是这个内存数组**。

按 UIREQ 的极端规模粗算（8 个活跃节点 × 2 小时 × 每 5 秒一条进度 ≈ 11,520 条，加生命周期事件）目前**大体够用**——但"够用"不是保证，而且这些都是**正常场景**：很晚才第一次打开页面、刷新、关掉标签页又在 60 秒 grace 内重新打开、SSE 断线期间新增超窗。

**一旦越窗，缺失的 `run:started` / `node:observed` 绝不能被读成"本来就没有"**——那正是这套无 manifest 方案赖以成立的前提被悄悄抽掉。

**定死（取推荐路）**：**新 SSE 连接直接从 transcript 文件完整回放**（协议见 §3.1a），**全局内存历史数组直接删掉**——它不再承担任何正确性职责。这样"可完整回放"是结构上成立的，不靠估算。

（次选：协议里显式发 `replay-truncated{firstSeq}`，页面整体标"历史回放不完整"，并**禁止**据缺失事件推断资产或节点不存在。选它就得把这条禁令写进 UIREQ。）
4. **两条容易被砍错的**：①**资产的 `ref` 必须和 `state` 一起在**（`{state:"present"}` 却没有 `ref`，页面知道"东西在"却**点不开**，等于没有）；②**`scene` 容器保的是整个 `files` map**（它本身没有 ref/sha——三个子文件各自有）。

#### ⚠️ `/file` 的范围必须收到 graph 归档，而不是 out-dir

早先的稿子只说"相对 out-dir、拒绝绝对路径与 `..`"。**这在这里不够**：圆桌那份 serve 之所以安全，是因为它的 root 本身就是一个专用 run 目录；而 graph 的 outDir 是**调用方给的任意目录**，完全可能是仓库根或 `repo/src`——那时 `/file?ref=.env` 是一个"没有绝对路径、没有 `..`、确实在 out-dir 内"的合法请求，**照样把 `.env` 送出去**。

**定死**：ref 仍写成相对 out-dir 的形式（事件里好读），但**服务端只接受 `nodes/.runs/<当前 graphId>/` 前缀**，并在词法检查之后再用 `realpath` 确认真实目标仍在当前 graph 的归档根内（挡符号链接逃逸，圆桌那份已有这层，照抄）。

Markdown 渲染沿用圆桌页那条「**先转义、再套受控标签**」的规则，不要另起炉灶。

### 3.3 事件表（**v4：补终态、补可空、去伪字段**）

**原则：事件只装「发生了什么 + 去哪儿找」，不复制大字段。** 真理源已经在磁盘上，复制进事件就是制造第二个真理源。**但"真理源可能不存在"这件事本身必须能被表达**——这正是早先的稿子漏掉的（见 `node:settled`）。

⚠️ **每一条 `node:*` 事件都必须带 `nodeSeq`**（见 §3.1a）。**页面的主键是 `(graphId, nodeSeq)`，`id` 不是**（`graphId` 在信封里）——下表为省版面不逐行重复列出 `nodeSeq`。

⚠️ **逻辑名 `id` 只出现在 `node:observed` 一处**，后续事件不再重复带它：`node:observed` 保证先发、不可丢、且能完整回放，客户端拿 `nodeSeq` 一查就知道这是谁。**再带一份就是同一事实的第二个副本**——与删掉 `nodeRunId`、`graphId`、`startedAt`、`waitingSince` 是同一条理由。

| `event` | `payload` | 表达什么 |
|---|---|---|
| `run:started` | `outDir`,`maxConcurrent` | 开场。⚠️ **不带 `graphId`（信封里有）、不带 `startedAt`（就是信封的 `ts`）**——**同一事实的第二份副本，能和它的来源打架**。也不带 `launcherCwd` 与 `label`：两者在 UIREQ、R1–R6 和现有 `withBridge` API 里**都没有消费者**（节点 `cwd` 已由 `normalizeSpec()` 转成绝对路径，不需要谁去解析相对路径）|
| `node:observed` | `id`,`nodeSeq`,`agent`,`model`,`effort`,`access`,`cwd`,`group?`,`declaredDeps[]`,`inferredDeps[]`,`spec:{…}`,`prompt:{…}`,`role:{…}` | **R2 的落点**；此刻连节点锁都还没拿。**三份输入快照各是一个资产判别联合**（§3.1a）|
| `node:rejected` | `phase`,`error` | **本地闸拒绝/准备失败**（见下）。⚠️ **不重复带 spec/prompt/role**：插桩顺序保证 `node:observed` 一定在它之前，而 observed 不可丢、可完整回放；writer 若已经坏了，这条 rejected 本身也写不进去 |
| `node:queued` | （只有 `nodeSeq`）| 紧贴 `acquire()` 之前。复用命中的节点不发。⚠️ **不带 `waitingSince`**：它就是这条事件信封里的 `ts`|
| `node:started` | `queuedMs` | 拿到名额、开跑（`startClock()` 之后）|
| `node:workspace-intent` | `path`,`branch`,`baseCommit` | **write 独有**：即将建 worktree。**"未确认"**|
| `node:workspace-created` | `path`,`branch`,`baseCommit` | **write 独有**：`git worktree add` 成功。**已确认**|
| `node:attempt` | `n`,`input:{state,…}`,`inputSha256` | 第 n 次尝试**开始**（n **1-based**）。`input` 是资产判别联合。⚠️ **没有 `rejectedReason`**——尝试刚开始，那个值还不存在|
| `node:attempt-settled` | `n`,`output:{state,…}`,`status`,`rejectedReason?`,`durationMs\|null`,`charCount\|null` | 第 n 次尝试**收场**（四种 status 都发，不只"有产出"那种）。⚠️ 强杀时它是 attempt 产出**唯一**的公布渠道（§3.1a）|
| `node:progress` | `n`,`charCount`,`tail`,`status`,`lastEvent`,`contextUsage` | 活进度（节流 ≥5s） |
| `node:settled` | 见下 | 收场 |
| `run:final` | `result`,`counts`,`durationMs` | 收场汇总。**`result: "completed" \| "failed"`**（判据见 §3.4①，**不看节点回执**）。`counts` 是固定键集：`observed` / `rejected` / `reused` / `ok` / `contract_error` / `backend_failed` / `timeout` / `unknown`。⚠️ **`reused` 是 `ok` 的子集，不是并列的桶**（复用返回的就是一张 `status:"ok"` 的旧回执）——**八项加起来不等于总数**，页面别去求和 |

**去掉的**：`run:terminated`（与 `run:final` 重复）· `node:started.n`（此刻第一次 attempt 还没开始，带 `n` 是假信息）。

****又去掉两样：**

- **`viz:started` 不进 transcript**。页面**能收到这条事件**本身就已经证明 viewer 起来了，而 `url`/`port` 是**启动器要打印给人看的信息**，不是这张图的历史，也不服务 R1–R6。
- **`run:started.pid` 删掉**。文档自己规定了判活逻辑**不许读 pid**（§3.4③），也不支持重启 viewer，UI 也没有任何地方消费它。留着一个**没有消费者的 pid**，只会让后来的人拿它去判活——而那正是这份文档明令禁止的。**同理，若沿用圆桌 serve 的代码，把它写 `viz.pid` 那段也删掉**，别在归档里留一个没人用的 pid 文件。

⚠️ **`viz:stopped` 整个删掉**（v13；早先的稿子只把它从 transcript 里挪出去，仍留作 SSE 事件）。两条理由：

- **进 transcript 会破坏单 writer**：writer（父）正常收场时已经关了，而 viewer 还要在看门狗窗口里继续服务——让 viewer 去 append，就毁掉了 §3.2 全部保证的地基。
- **留作 SSE 事件则没有收件人**：正常自灭发生在**已经没有客户端**的时候（有人在看就不该自灭）；异常停服浏览器有 `EventSource.onerror`，本来就收得到。**一条永远发给空气的消息，不如没有。**

⚠️ **但"改由 SSE 首帧下发截止时刻"也是错的，一并撤回**：客户端一接入就会取消计时（下面那条状态机），**所以有人在看的时候根本不存在一个真实的截止时刻可发**。倒计时这个需求本身与自灭判据互斥——**删掉它**（UIREQ §8 同步改）。

#### ⚠️ viewer 的自灭状态机（**唯一合同**，定死）

这是全文档最后一处会逼实现者去猜的地方，所以把它一次写死。

**先定一个谓词**（把"owner 结束了没有"收成一处，不再有第二种判据）：

```
ownerEnded = 见过 run:final          （transcript）
          OR 见过 owner-final        （控制通道）
          OR 生命管道 EOF 且最终 drain **已结束**
             （成功结束,或者失败并已转成 historyReadFailure —— 两者都算结束）
```

**实现上只要一条**：drain 的 resolve 与 reject **汇入同一条收尾路径**——reject 先置 `historyReadFailure`，然后**照样**重算 `ownerEnded` 并起 grace。**不需要在状态机里新增迁移。**

⚠️ **第三条里"已结束"不能读成"成功完成"**：drain 是允许失败的（§3.1a），失败后转「历史读取失败」并照常公开控制槽。若这里要求"成功"，就会出现一个**死角**——生命管道 EOF、没有 `run:final`、没有 `owner-final`、最终 drain 又失败了：`ownerEnded` 永远为 false，于是按第一条政策 **viewer 永不退出**。**一个读历史失败的进程赖着不走，这是纯粹的资源泄漏，还谁都不报错。**

⚠️ **`ownerEnded` 必须涵盖这三条**：早先的稿子抄圆桌那份只认 `run:terminated`（graph 里对应 `run:final`），可 §3.4 的四档收场里**有三档没有 `run:final`**——writer 坏掉后受控收尾、坏掉后被强杀、以及普通强杀。只认 transcript 那一条，这三种情况就只能靠兜底超时退出。

**政策四条：**

| 条件 | 行为 |
|---|---|
| `ownerEnded === false` | **绝不退出**——哪怕一直没人打开页面。⚠️ **必须删掉参考实现那个"无客户端 10 分钟就退**出"的兜底：它不要求 run 已结束，于是**两小时的运行只要前十分钟没人看，viewer 就在半途消失了**，而 v1 又不支持重开旧 run——"事后复盘"这个承诺当场作废。防孤儿由父进程生命管道负责，不需要这个定时器 |
| `ownerEnded && clients.size === 0` | 起 **60 秒** grace 计时 |
| 任一客户端接入（**包括还在 `replaying` 的**） | **同步**取消 grace |
| 最后一个客户端断开 | 从**断开那一刻**重新起 60 秒 |

⚠️ **"同步取消"这四个字是有分量的**：取消动作必须与"把客户端登记进 `clients`"处在**同一个同步段**里（这与回放五步第 1、2 步"不得让出事件循环"是同一条纪律）。Node 单线程下因此**不存在**"已经接受了客户端、旧计时器又把它杀掉"的中间态——两种时序都干净：

1. **请求处理器先跑** → 登记 + 清计时器，服务继续活
2. **计时器先跑** → 服务先退出，那个连接压根没建起来，浏览器直接拿到 `EventSource.onerror`

**代价写明**：有人开着页面就不自灭，所以**一个忘了关的标签页会让 viewer 一直活着**。v1 接受——它是个空闲的小进程，而加"硬上限"就得回答"正在看的人怎么办"，那是拿一个真实的误伤去换一个不痛的浪费。

**验收五条**：①长运行、全程无人连接 → **不提前退出**；②四种 owner 收场**都**能进入 grace；③grace 中途接入客户端 → 取消，且不再退出；④计时器与连接**分别抢先**各测一次，结果符合上面两种时序；⑤**EOF + 最终 drain 失败** → 断言页面公开了「历史读取失败」**并且照样进入了 grace**（不是永远不退）。

#### `node:rejected` —— 最初的稿子完全没有的一整类终态

`node:observed` 之后、真正开跑之前，有三处会**抛 `UsageError` 直接出去**，源码明确原样重抛、**不写回执**：

| `phase` | 什么情况 |
|---|---|
| `"lock"` | `<id>.lock` 已存在（id 撞了，或上次异常退出留下陈旧锁） |
| `"preflight"` | write 的仓库体检 / 脏树闸不通过 |
| `"reuse-check"` | 回执已存在但指纹不符 / 上次不是 ok / 产出缺失或指纹对不上 |
| `"workspace-setup"` | 分支或目录已存在且没给 force、`git worktree add` 失败 |

这四种**都不是 `unknown`，也不是 `abandoned`**——它们是**明确的、本地的、还没派活的拒绝**，脚本那边拿到的是一个抛出来的异常。没有这条事件，页面上那个节点会永远停在「已发现」，最后被合成成 `abandoned`（"结局不明、现场可能还在"）——**把一次干净利落的拒绝显示成一场事故**。

#### `node:settled` 的形状（**资产联合 + 受限兜底**）

```
{
  nodeSeq, status, execution: "fresh" | "reused", durationMs,
  outcome?,                 // write 节点才有
  // 每个可点击资产都是 §3.1a 的判别联合,**不是可空字符串**:
  receipt:  { state, ref?, sha256?, byteCount?, code? },
  artifact: { … },   // 顶层产出
  diff:     { … },   // write 节点;read 节点是 not-applicable
  scene:    { … },   // 只有非正常收场才 present
  // **恒有**,最多两项(源码限死 reask ∈ {0,1});只带指纹与状态,不含正文:
  attempts: [{ n, inputSha256, input: {…}, output: {…}, status, rejectedReason? }],
  // 以下**只在 receipt.state !== "present" 时**出现,且字段封闭:
  workspaceSummary?: { path, branch, baseCommit, headCommit, removed, changesKnown },
                            // ⚠️ **没有 diffRef** —— diff 只有顶层那一个真理源
  errorSummary?             // boundedSummary
}
```

⚠️ ****不再有独立的 `recordingError` 字段****：每个资产自己带 `state` 与 `code`，"哪一样没记下来"是逐资产读出来的。这同时解掉了早先的稿子的一个自相矛盾——`recordingError` 被要求"永远是 `[{what,code}]`"，可 §3.2 又规定超 2 KiB 就整体换成 `boundedSummary()` 对象，**一换页面就再也分不出 unavailable 与 not-applicable**。判别联合天然有界（每项就是一个枚举加一个短 code），冲突不复存在。

⚠️ **为什么必须可空**：§5.1 特意保留的 `unknown + delivered/no-changes`，其中一种触发方式**正是回执落盘失败**。`finish()` 的最后一步才 `writeAtomic(receiptPath, …)`，失败时它只把**内存里**的对象改成 `unknown` 并记下原因，**不会再写一次**；而 `writeAtomic` 在 rename 失败时会把临时文件删掉，**也不能指望从 tmp 捞**。此时磁盘上要么没有本次回执，要么留着**上一版的旧回执**——让事件硬指一个"回执一定在"的 ref，等于把页面导向一份不属于这次运行的文件。

⚠️ **两级兜底，顺序固定**：
1. 归档那份 `receipt.json` 由 viz 层**从 `finish()` 返回的内存对象**另写一次（**不是拷贝 canonical 文件**）——canonical 写失败时，这一次往往仍然成功，页面照样有完整回执。
2. 归档也写失败，才走上面那个**字段封闭**的内联兜底。**刻意不含 `filesChanged` 与 `diagnostics`**：两者都无上限，内联进事件就是把事件流变成第二个真理源。兜底的职责是"让人能找到现场"，不是"复刻回执"。

⚠️ **复用节点的 `durationMs` 是「原来那次执行」的耗时，不是这次复用检查的耗时**：源码复用命中时直接返回旧回执，里面的 `durationMs` 原样带过来。事件里照原样传（它是历史事实），**但页面必须标成"原执行耗时"**——否则一次 200ms 的复用会显示成"跑了 40 分钟"。

`status` 的取值是**源码里的五档**：`ok` / `contract_error` / `backend_failed` / `timeout` / `unknown`。⚠️ 页面上会出现的第六档 `abandoned` **不是这里的 status**，是 viewer 合成的（§3.4）；`reused` 也不是 status，是正交的 `execution` 标记——复用返回的是旧回执的 `status:"ok"` 加 `reused:true`。

### 3.4 中断怎么判、怎么恢复（**重写**）

⚠️ **`withBridge` 没有任何信号处理**（`node-core.mjs` 里 `process.on(` 一次都没出现），它只有 `try { fn } finally { bridge.close() }`。`finally` 覆盖**正常返回**与**抛异常**，但 **Ctrl-C / SIGTERM / kill 时不跑**。

所以「收场时会写终态」这个承诺**对强制终止无效**，而本方案又明确支持事后复盘，**页面卡在运行中是常见路径**。

**① 收尾协议要整条定死（早先的稿子的"先发 final 再关管道"仍会造假终态）。**

早先的稿子只让"正常收场"发 final，于是**用户回调抛异常**这条路（`finally` 照常跑、桥照常关）会因为没有 final 被 viewer 判成"强杀"——把一次有序的失败显示成事故。早先的稿子改成"先发 final 再关管道"，**还是不够**，三个具体竞态：

1. 回调成功 → 写了 `result:"completed"` → **`bridge.close()` 才失败**。调用方拿到的是 rejection，页面却写着成功。
2. `Promise.all` 里 A 抛 `UsageError`、**B 还在跑**。回调立刻 reject，final 就发了，而 B 的 `node:settled` 还没写——页面永远缺 B 的终态。
3. 父进程 append 完 final **立刻**关管道。而 viewer 是**每 500ms 轮询**读增量的（圆桌那份的 `POLL_MS`）：**EOF 可以先到**，此时 viewer 还没读到 final → 合成一个**假 `abandoned`**。

**定死收尾顺序（十二步，不能换）：**

1. 捕获回调的返回值 / **原始异常**
2. **封住 admission**：`acceptingNodes = false`，此后的 `runNode` 一律**返回一个 rejected Promise**（**不是同步 throw**——`runNode` 对外一贯是 Promise API，中途改成同步抛会让 `Promise.all` 之外的调用方拿到两种错法），且**不进事件流**（它不属于这次 run）
3. 快照 in-flight 集合做 `allSettled`，**循环直到集合为空**——正在 preflight 的、卡在闸上的、正在跑的，一个都不落
4. **然后**才 `bridge.close()` 做最终兜底清场
5. 定 `result`（见下，**只看三样，不看节点回执**）
6. **写 `run:final` 并确认落盘**
7. ⚠️ **如果第 6 步失败（或 writer 早已损坏）**：发 `recording-failed`（若还没发过），并**准备好 `owner-final`**——这一步早先的稿子整个漏了，见 §3.1a
8. 关事件 writer。`close()` **对外 non-throwing**，错误累积进诊断；**第 9～11 步照走**。

   ⚠️ **它不再宣布 recording failure**：viewer 的判定优先级第 1 档是"transcript 里有 `run:final` 就按它算"——所以"close 失败也转 `recording-failed`"这条分支**永远显示不出来**，对应验收还是假绿。

   ⚠️ **也不需要引入一个单独的 flush 概念**：writer 本来就限定为 `writeSync` 或有序 Promise 链，那么**最简单的 API 合同就是「`append()` 只在这一行的字节全部写完之后才 resolve」**——于是第 6 步 `await append(final)` 成功**就是**"确认落盘"，没有第二个动作可失败。关 fd 失败只是清理诊断。

   ⚠️ **"写调用完成"必须写成"整行字节写完"**：`fs.writeSync` 与异步 `write` **都可能短写**（返回值小于要写的字节数）。若 writer 调一次就 resolve，**磁盘上留下的可能是半行**，而我们却把 `run:final` 判成已确认——viewer 那边这半行会被当成"末尾半行"缓冲掉，于是**一次"已确认"的收场在页面上表现为运行被掐断**。

   **`append()` 的合同定死四条：**
   1. **循环补齐**，直到该行（含换行符）的全部 UTF-8 字节写完才 resolve
   2. **返回 0 / 抛错 / 中途失败** → 视为 recorder 损坏（走 `recording-failed`，并带上损坏前的 `lastGoodOffset`）
   3. Promise 链的 resolve 点是**底层 write 的回调/Promise 完成**，**不是**"加入队列"、也**不是** `stream.write()` 的返回
   4. **不做 `fsync`**：R1–R6 不要求抗断电或内核崩溃，而普通强杀发生在 `write` 返回**之后**，已交给内核页缓存的数据不会随进程一起消失。**这一条是刻意的边界，不是遗漏**
9. ⚠️ **writer 已损坏时：把 `owner-final{result, endedAt}` 完整写进生命管道**
10. **关生命管道**（`owner-final` 必须先于 EOF 完整送达）
11. 删 run 临时目录。⚠️ **它排在 `owner-final` 与关管道之后是有意的**：`owner-final` 的语义是「**桥与记录器的生命周期已经结束**」，而临时目录清理属于其后的 **best-effort 隐私收尾**，清不掉也不改变任何结论（§2.1 已写明强杀时它可能残留）
12. 按下表处置异常

⚠️ **第 6～10 步是四个顺序敏感的动作，不能合并成一行**（早先的稿子就把它们挤成了一步，结果第 7、9 步双双漏掉）。

#### in-flight 集合从哪来（v5/早先的稿子都只说"排空"没说谁持有）

⚠️ **`withBridge` 现在根本拿不到那些 promise**：`bridge.runNode` 只是 `(spec) => runNode(bridge, spec)` 的直接转发，返回值交给调用方就没了。`ACTIVE_NODES` 存的是**防撞用的 key 字符串**，不是 promise，生命周期与用途都不同——**不要复用它**。

**定死：**

1. 每个 bridge 挂两样：`acceptingNodes: boolean` 与 `inFlightNodePromises: Set<Promise>`
2. **登记必须发生在公共入口**。⚠️ `runNode(bridge, spec)` 是**导出的公开 API**（README 明写它与 `bridge.runNode(spec)` 等价，`node-turn.mjs` 自己走的就是这条），**只在 `bridge.runNode` 包装器里登记会被绕过**。做法：把实现改名 `runNodeImpl()`，导出的 `runNode()` 与 `bridge.runNode` **都**走同一个登记外壳
3. promise 创建后**同步**入集合，然后**原样返回同一个 promise**
4. 移除用 `p.then(ok, err)` 而**不是 `p.finally()`**——`finally()` 派生出的新 promise 在 p 被拒时也会拒，没人接就是一条未处理拒绝

#### `result` 只由三样决定（**这是早先的稿子的越界**）

⚠️ **早先的稿子写的"回调成功、但排空发现有节点异常收场 → `failed`"是错的**，而且错在原则上：`runNode` 对失败节点是**正常 resolve 一张带 status 的回执**，"一个环节挂了怎么办"按 SKILL 的明文规定**是调用方的策略**（继续、换引擎、降级、停）。让收尾去看回执再判整个 run 失败，就是**把只读观测台变成了隐式的流程裁判**——`allSettled` 甚至根本看不出那个 `contract_error` 是不是回调**有意接住并处理掉**的。

| 情况 | `result` | 调用方拿到什么 |
|---|---|---|
| 回调抛了 | `failed` | **原始异常，原样重抛**；排空/close 的错误另附诊断，**绝不盖掉死因** |
| 回调正常返回、close 也成功 | **`completed`** | 正常返回 |
| 回调正常返回、**排空期间看到 failed / unknown 回执** | **仍是 `completed`** | 正常返回——**节点结局不是 run 结局** |
| 回调正常返回、**只有 `close()` 失败** | `failed` | 抛 close 的错（沿用现有 `finally { await bridge.close() }` 的语义，不改行为） |

⚠️ **第三行是早先的稿子删掉的一处自相矛盾**：早先的稿子的主表已经改对了，但这张表里还留着"排空发现节点异常 → failed"那一行——**同一份文档给了两个相反的结论**，实现者只能挑一个。`runNode` 对五档业务结局一律**正常 resolve**，只有用法错才抛；观测台没有资格改判。

**`{halt: …}` 在 v1 里只是一句汇总说明，仍属正常返回**（`result = completed`）。想让整个 run 判失败，**调用方就抛异常**——不给 halt 附加任何流程语义，也绝不从回执状态倒推。

⚠️ **正因为它没有任何流程语义，`halt` 也不进事件**：UI 从来没有消费它的地方，而把它塞进 `run:final` 就得为"回调返回任意 JS"背上一整套序列化与摘要合同。**它是调用方自己那段 JS 的返回值，留在那里就够了。**

**排空只是生命周期屏障**（保证 final 之前每个节点都有终态），**不参与业务判定**。

⚠️ **第 3 步与第 4 步的顺序不能反**（早先的稿子写的是"先 close 再排空"，错了）。**先 close 会亲手制造一个更坏的竞态：**

1. `Promise.all` 里 A 抛 `UsageError`，B 正在跑，C 卡在闸上
2. `withBridge` 调 `bridge.close()`，批量关会话开始扫
3. B 因为桥被关而结束，在 `finally` 里**释放名额**
4. **C 被唤醒**——信号量只有 `resolve` 队列，**没有取消语义**
5. C 接着做二次脏树检查、**建 worktree**、**发 `open_session`**——而 `request()` 只检查 `state.exited`，**根本不看 `state.closed`**，所以这个请求真的会发出去，且发生在批量关会话**已经扫过之后**
6. 最后 teardown 把 C 杀掉：留下一个 `unknown`、一棵残留 worktree，可能连现场都没有

**先排空则完全没有这个窗口**：C 要么正常跑完，要么在自己的预算内收场。代价是收尾可能变慢，换来的是"清场过程中不会有人开新工作"。

⚠️ **有界性的说法要说准**：不能只归因于"`timeoutMs` 必填"——它是**拿到名额之后**才起算的，排队不消耗它；git 体检与 worktree 操作另有各自的固定预算，还有一些同步文件操作压根不受 `timeoutMs` 管。准确说法是：**在 admission 已封、节点数有限、且每一类外部操作都各自有时限的前提下，排空存在运行时上界**。

⚠️ **而且先排空还顺带保住了现场**：`saveScene()` 要调 `agent_bridge_result` / `status`，`closeSession()` 要调 `close_session`——**这些都得桥活着**。桥先没了，那些节点的现场就一并没了。

⚠️ **不引入 gate 取消器、不做主动 quiesce**：那是把调度器的一部分搬进来，而 skill 明写不做调度。若将来产品确实要 fail-fast，才需要新增 `quiesce`（取消闸队列 + 阻止新 open + 在桥仍活着时 abort 活跃节点 + 排空后再 close）——**但绝不能拿现有的 `close()` 冒充 quiesce**，它不是。

**异常优先级**：见上面那张唯一的表。

⚠️ **这里原本还有第二张表**，内容与上表**相反**——早先的稿子只删掉了其中一处，第七轮复审又把这一处揪了出来。**同一份文档里第二次出现"两张表打架"，本身就是个信号**：`result` 的判据**只能有一处定义**，任何"顺手再列一遍"的复述都会漂。所以这里不再复述，只指回去。

**viewer 侧配套**：EOF 处理器**必须先同步把 transcript 读到最后一个完整换行**，再判断有没有 final。少了这一步，第 3 个竞态在慢盘上就是必现。

**② 判活只用一条生命管道，且必须是 per-`withBridge`。**

viz 服务是 `withBridge` 起的**子进程**，持有一条到父进程的管道。**管道 EOF 且没见过 `run:final` ⇒ 判定中断。**

⚠️ **这条管道必须由 `withBridge` 自己在收尾时显式关闭**，不能等整个 Node 进程退出——同一个脚本顺序跑多波时，第一波的 viewer 会**永远等不到 EOF**，页面永远显示"运行中"。

⚠️ **不用 pid 探活**：pid 会复用，跨平台查进程起始时间很麻烦。****pid 干脆一个字都不记****（§3.3）——"只为给人看"的字段，最后总会被人拿去判活。判活只有一条：**管道在 ⟺ owner 在**。

**③ v1 不支持"另起一个 viewer 去看旧 transcript"。**

早先的稿子写了个「owner 文件 fallback，供重启 viewer 后判活」——但 viewer 只由 `withBridge` 拉起，**没有任何入口能单独启动它**。既然不存在"viewer 重启"，那个 fallback 就是在为不存在的场景设计一套判不准的算法（codex 也指出：光靠 `{pid,startedAt}` 判不出来）。**删掉。** 页面存在 ⟺ 管道存在，判活因此是确定的。

事后复盘的窗口 = viewer 还活着的这段时间（§3.3 的自灭状态机：**有人看就不退**，最后一个页面关掉 60 秒后退）；之后页面消失，但**归档全在磁盘上**（§3.1a）。这条限制写进 SKILL。

**④ 中断后 viewer 怎么标（`abandoned` 的准确语义）。**

⚠️ **早先的稿子写「这些环节的结果永远拿不到了」是事实错误**，对写节点尤其错——worktree、分支、锁、已复制的 attempt 产出**都还在**，缺的只是**权威终态回执**。

`abandoned` 的正确含义是「**观测者没有看到终态**」。早先的稿子分了三种，**不够**——它漏了 `observed`，也把"worktree 到底建没建成"混成了一件事：

| 中断时停在 | 页面给什么 | 为什么必须单列 |
|---|---|---|
| `observed` | 「本地准备中，还没派发」 | 早先的状态表里没有它，但 §5.5 的生命周期里有——文档自己是断的 |
| `queued` | 「在等名额，一个字都还没发给 AI」 | 排队 ≠ 已派发 |
| `running`（read） | 「执行结果不明」+ **只列确实落了盘的 ref** | ⚠️ `saveScene()` 只在 `finish()` 里跑，**强杀路径根本进不去** → 现场三件套**可能压根不存在**。早先的稿子无条件承诺"现场文件入口"是空头支票 |
| `running`（write，**还没发 intent**） | 「正在做建工作副本前的检查——**还没开始创建，不会有工作副本**」 | 见下 |
| `running`（write，**见过 intent、没见过 created**） | 「工作副本可能已经开始创建，**位置未确认**」+ 路径 | `git worktree add` 可能**建了分支、写了登记才失败**（源码自己承认，并做 best-effort 清理）；强杀时那次清理也没跑 |
| `running`（write，**见过 created**） | 「执行与代码去向都不明」+ **路径 + 分支 + 禁止自动重跑** | 唯一能确定给出坐标的一档 |

⚠️ **第四格是 第三轮复审时补的（抓出）**：`node:started` 发在 acquire 之后，而 worktree 前面还夹着**二次脏树检查 + 算分支名**（都是 git 调用，在大仓上不快）。这段窗口里 `git worktree add` **一次都还没被调用**，所以磁盘上**确定不会有**我们建的工作副本。

**它与第五格的文案必须相反**，不能合并：第五格说"可能有，去看看"，第四格说"没有"。**把第四格并进第五格，就是让用户去找一个可以证明不存在的目录**——这与"少警告"是同一类错误，只是方向相反。用户一旦扑空一次，第六格那句最不该被怀疑的话就跟着掉价。

这也是 `node:workspace-intent` 与 `node:workspace-created` 分成两条事件的全部理由：**intent 说"该去哪儿找"，created 才有资格说"它确实在那儿"**，而在 intent 之前，正确答案是"别找了"。

---

## 4. 拓扑从哪来

skill 明写**不做通用流程引擎**（无 plan/DAG 格式、无依赖解析、无调度器）。拓扑只活在使用者那段 JS 里。三档来源，**必须视觉可区分**：

| 档 | 来源 | 可靠性 | 画法 |
|---|---|---|---|
| **A 显式声明（未执行验证）** | spec 上可选 `deps: [...]` | **调用方的声明，系统既不校验也不执行** | 实线箭头 + tooltip「仅展示，不影响调度」 |
| **B 推断** | 扫 prompt 里是否出现同 out-dir 下 `nodes/<otherId>.md` | 启发式，会漏也会多 | 虚线箭头 + 悬浮标"推断" |

⚠️ **两档的端点都是逻辑 `id`，而 `id` 会重复——这条必须有解析规则。**

同一个 graph 里顺序重跑同一个 id 是合法的（源码只禁并发，`active` 键在 `finally` 里删）。于是 `deps: ["x"]` 或 prompt 里那句 `nodes/x.md`，在页面上**指向两张卡**，实现者只能靠猜。

**定死（最短规则，且不把 `nodeRunId` 加回 wire）：**

| 目标 `id` 在本 graph 出现的次数 | 怎么画 |
|---|---|
| **恰好 1 次** | 连向那个 `nodeSeq` |
| **0 次或 ≥2 次** | **不画实例边**，改标一句「依赖指向逻辑名 `x`，但实例不唯一」 |

⚠️ **为什么不取"最近的那一次"**：那是一次没有依据的推断。B 档那条边本来就来自"prompt 里提到了 `nodes/x.md`"，而那个文件被重跑**覆盖**过——这个节点当时读到的到底是哪一版，**我们没有观测**。这套页面的全部价值就在于不把"我没看到"说成"我知道"。

**验收**：同 id 顺序重跑两次 + 第三个节点声明依赖 `x`，断言**没有**连到其中任何一张，且给出了歧义提示。
| **C 兜底** | 只有时间先后与并行关系 | 无因果 | 泳道时间轴，**不画箭头** |

⚠️ **A 档不能叫"精确/确定"**。`deps` 是**纯注解，执行路径上没有任何代码读它**——用户完全可以声明「B 依赖 A」却在 `Promise.all` 里同时启动两者。

**因此**：若时间轴显示 B 早于 A 完成，而 A→B 有声明边，页面应给**一致性警告**。这比假装那条边成立诚实得多。

**不许把 A 和 B 画成一样。** 推断有假阳/假阴，混在一起就是把猜测冒充事实。

⚠️ **并发闸会伪造出"先后关系"**：B 在 A 之后跑，很可能只是没名额了。所以 C 档时间轴**必须把排队区间与执行区间画成两段**，且**纯时间先后绝不能渲染成任何箭头**。

`group?` 同理：使用者的 JS 若有轮次循环，可传 `group:"round-2"`，viz 按它分组；不传就不分组。

---

## 5. 状态模型

read 节点恒 `workspace: null`，只看 status。**write 节点必须看 `status × outcome` 的组合。**

### 5.1 真实的合法组合

| `outcome` | 合法的顶层 `status` |
|---|---|
| `delivered` | `ok` · `contract_error` · `backend_failed` · `timeout` · **`unknown`** |
| `no-changes` | 同上 |
| `unknown` | **只能是 `unknown`** |

- ❌ 「失败三档 × 任意 outcome」是错的——**失败三档 × `outcome:unknown` 根本不存在**：`finish()` 在 outcome 既非 delivered 也非 no-changes 时**强制把顶层降级为 `unknown`**。源码注释讲明了为什么：`backend_failed`/`timeout` 在本工具契约里意味着"可以安全换个人重跑"，而重跑通常带 `force`，`force` 会**把正因说不清才保留的工作树连同分支一起删掉**——「工作区状态不明时宣称可安全重跑，等于亲手安排了一次数据销毁」。
- ❌ 早先的稿子**漏了 `unknown + delivered/no-changes`**。⚠️ **早先的稿子把这一格的成因写窄了**（只写"回执写盘失败"）。准确说法：**任何走到 `finish("unknown")` 的路径，之后的 worktree 收尾仍可能确认出 delivered / no-changes**。至少三种来源：
  1. `open_session` 返回的形状不认识（拿不到 session id）
  2. `send_message` 的 ack 形状不认识（无法确认任务是否已开始）
  3. 回执落盘失败（`finish()` 的最后一步）

  **这一格不是边角料**：代码可能**已经好好地提交在分支上**，只是这次执行的结局说不清。页面绝不能因为 status 是 unknown 就把分支藏起来。

### 5.2 两个"说不清"必须用不同的话说

| | 含义 | 页面文案 |
|---|---|---|
| `status: "unknown"` | **执行结局**不明 | 「这个环节干没干完，说不清」 |
| `outcome: "unknown"` | **代码交付状态**不明 | 「改动有没有落到分支上，说不清」 |

### 5.3 三条字段强约束

- `delivered` ⟹ `committed=true` · `changesKnown=true` · `filesChanged` 是数组 · `branch`/`headCommit`(40 hex)/`diffPath`/`diffSha256`(64 hex) 四样齐全
  ⚠️ **`filesChanged` 可以是空数组**：agent 建了空提交、或提交完又 revert 时，HEAD 相对基线前进了但净改动为零，diff 是 0 字节——源码把这判为**合法的 delivered**（复用闸那边也不拿 0 字节当失败，两边判据一致）。页面不能写「已交付 = 有一批文件改动」。
- `no-changes` ⟹ `committed=false` · `changesKnown=true` · `filesChanged=[]` · head/diff 为空
- `unknown` ⟹ `removed=false`，但 committed/head/diff 可能是**部分形态**

### 5.4 `outcome` 与"工作区清理状态"是两件事

⚠️ **早先的稿子的不变式「`removed:false` ⟹ outcome 是 unknown」是错的。** `delivered` 与 `no-changes` **都可能 `removed:false`**：关会话未被确认（后端可能还在写，此时删树 = 丢代码）、或 Windows 上删除失败（句柄被占）。

⚠️ **`removed` 的准确读法**：它是**收尾那一刻工具自己的记录**，只有两种读法成立——

- `removed:true` = 收尾时确认删掉了
- `removed:false` = **收尾时没有确认清理**（可能没删、可能删了但没确认）

**推不出"这个目录现在还在磁盘上"**。早先的稿子§5.3 那句"（一定保留现场）"和 UI 的"仍在磁盘上"都把一张快照当成了实时事实。页面文案统一用**「收尾时未确认清理」**。

**UI 必须把这两件事分开显示**：「交付结论」一栏，「工作副本清理状态」另一栏。

### 5.5 节点生命周期

`observed` → （`rejected`）→ `queued` → `running`（write 含"准备工作副本"）→ 五档终态之一，外加 viewer 合成的 `abandoned`（§3.4④，**六种**子形态）。

`queued` 是**可见状态**不是内部细节——用户必须能区分"在排队"与"在跑"，否则会把闸的正常限流误读成卡死。

---

## 6. 插桩顺序

| # | 时刻（**按源码位置定位**） | 事件 / 动作 |
|---|---|---|
| 1 | `normalizeSpec` 返回后 | **冻结 prompt/role 到内存**（§2.1）；**比对 canonical outDir**，不符即拒（§3.1②） |
| 2 | 建 `nodes/` 与归档目录后、**拿锁之前** | **`node:observed`**（带 `spec`/`prompt`/`role` 三个资产状态）+ 写归档的 `input.json`/`prompt.md`/`role.md` |
| 3 | `<id>.lock` 创建失败 | **`node:rejected{phase:"lock"}`** |
| 4 | preflight / 幂等与复用检查抛错 | **`node:rejected{phase:"preflight"\|"reuse-check"}`** |
| 5 | 复用命中 | **`node:settled{execution:"reused"}`**，归档拷一份产出与回执；**不发 `queued`/`started`** |
| 6 | `bridge._gate.acquire()` 之前 | **`node:queued`** |
| 7 | `acquire()` 返回 → `startClock()` | **`node:started{queuedMs}`** |
| 8 | write：二次脏树检查与 `makeBranchName` **都跑完之后**、`git worktree add` **紧之前** | **`node:workspace-intent`**。⚠️ **不能提前发**：提前发就等于对着一段"确定还没建"的窗口喊"可能建了"（§3.4④第四格） |
| 9 | write：`createWorktree` 成功 / 抛错 | **`node:workspace-created`** / **`node:rejected{phase:"workspace-setup"}`** |
| 10 | 每次尝试开始 / 流式推进 / **该轮收场（决定重说或进 `finish()` 之前）** | `node:attempt` / `node:progress` / **`node:attempt-settled`** |
| 11 | `finish()` 返回后 | 写归档 `receipt.json`（**从内存对象写**）→ **`node:settled`**（§3.3） |
| 12 | `withBridge` 的 `finally` | **§3.4① 的十二步收尾**（封 admission → 排空 → close → 定 result → 写 final → **writer 坏了就补 owner-final** → 关管道 → 删临时目录 → 原样重抛） |

⚠️ **第 2 步为什么排在拿锁之前**：锁撞车（`phase:"lock"`）也要能在页面上看见。**归档路径含 `graphId`，与锁无关**，所以在拿锁前写它不会和别的 graph 撞——这是 §3.1a 用 graph 作用域路径换来的额外好处。

⚠️ **第 7 与第 8 之间的口径要定死**：`node:started` 紧跟 acquire 发，「运行中」就包含了"准备 worktree"这段。**绝不能把 worktree 创建时间算进排队时长**，那会让"闸开太小"这个诊断信号失真。本方案选：`queuedMs` 只算闸上的等待，UI 的「运行中」明确含准备阶段（见 UIREQ §4.1）。

---

## 7. 服务面、启动与生命周期

`skills/agent-bridge-graph/viz/serve.mjs`——以圆桌那份为基座（零依赖、仅 Node 内建、SSE 先回放后 tail）。

⚠️ **早先的稿子说"直接拷圆桌，语义相同"不准确。** 圆桌那份只靠看到 `run:terminated` 触发自灭，**没有 owner-death 合成**。graph 版**必须新增**：父进程生命管道、§3.4 的 synthetic `abandoned` 状态机（**六种**子形态）、异步流式回放 + 每客户端队列与背压 + 单 tail reader 的 `lastGoodOffset` 状态机。**不能按纯拷贝估工作量。**

```js
const out = await withBridge(async (bridge) => { … }, { viz: true, outDir });
```

- `viz:true` 时 `outDir` **必填**；`withBridge` 先 canonicalize 并绑定（§3.1①），再起服务。⚠️ **viewer 起来了不进 transcript**（已删 `viz:started`）——URL/port 打印给人看，服务状态走 SSE
- **默认关**。开跑前用 `AskUserQuestion` 问一次「要开可视化吗？（默认否）」，别反复叨扰
- 脚本退出后 viz 仍活着，**只要还有人开着页面就不退**；最后一个页面关掉 60 秒后才退出（状态机见 §3.3）。窗口过后页面消失，**v1 不提供重新打开旧 run 的入口**（§3.4③）

### 为什么默认关：隐私口径

开了 viz，归档里会留下**全部委托 prompt 与角色文件的原文**。

- 它落在 `<out-dir>/nodes/.runs/`。典型位置是仓库里的 `.graph/`，但 outDir 可以是任意目录，包括仓库外。
- 与「委托会话史可视化」那份相比**更持久**：那份写临时目录、随主 agent 退出即删；**这份不删**，一直留到人手动清理。
- ⚠️ **viz 关着时不建立持久归档**——冻结的内容只在内存与 run 临时目录里（§2.1）；**正常收场与受控失败都会删掉它，被强杀时可能残留在 `os.tmpdir()` 下**（§2.1 已说明，这里口径必须一致，不能写成"随 run 消失"）。这是"默认关"能兑现隐私承诺的前提，也是它的边界。

SKILL.md 必须写明：**开 viz = 在 out-dir 里留下一份全量 prompt 明文**，并给出清理办法（**用实际 outDir**，不要写死 `.graph/`）。

---

## 8. 被否决的更省方案

**方案 X：不做事件流，viz 直接轮询 `nodes/` 目录读 receipt。**

否决：**receipt 只在节点结束时写**，正在跑的节点在磁盘上没有 receipt；卡在闸上的更是连开始都没有。R2/R3 直接做不到。

退一步的变体（开跑时写 `<id>.status.json` 边跑边更新、viz 轮询目录）能救 R3，但那是"用一堆小文件手搓事件流"，还得自己处理半写文件、Windows rename 失败、跨文件聚合一致性。

### 关于快照方案

2026-07-27 之后仓库会有**两个**已验证形态：圆桌/loop 的事件流，与会话史可视化的**双槽快照**。

**graph 仍走事件流**，理由：

- graph 没有 1Hz 进度洪流、也没有 O(n²) 写放大（进度 5 秒一条且可整条丢弃）。⚠️ **但"每节点个位数事件"这句话是错的，已删**：8 个活跃节点跑 2 小时、每 5 秒一条进度就是 **~11,520 条**（§3.2 已按这个量级算过）。**规模判断只能引用那个算式，不能再引用这句已经被证伪的话**
- 事件流天然记得住**过程信息**——打回重说的原因、排队时长、workspace 何时创建（以及**是否只到 intent 就死了**）——这些快照会丢，而它们恰恰是诊断价值最高的部分
- **代价如实写明**：仓库将同时存在两套 viz 数据面。这是真实的维护负担。若将来要收敛，**往快照方向收敛更合理**

---

## 9. 施工清单

**前三步的顺序（codex APPROVE 时给的，照这个开工）：**

1. **先建唯一规范 `EVENTS.md`**——事件 schema、`AssetState`、全部字段上限，外加一组校验 fixture。⚠️ 它是后面所有东西的真理源，**不先落它，第 2、3 步就会各自长出一份 schema**。
2. **记录基础层**：graph 作用域（绑定 outDir / `graphId` / `wx` 建 transcript）、顺序 writer、归档闭包、控制通道——**连同故障注入测试一起**。
3. **接进 `node-core.mjs`**：`nodeSeq`、完整插桩顺序、in-flight promise 登记与 admission 封闭、十二步收尾协议。


| # | 改动 | 位置（**按函数名定位**） | viz 关时也生效 |
|---|---|---|---|
| 1 | 事件 writer（append + seq + 半行安全 + **单 fd `writeSync` 串行** + **字段与整行字节上限，终态事件永不丢弃**） | 新增内部模块 | 否 |
| 2 | **canonical outDir 绑定 + `runNode` 前置校验 + `graphId`/transcript `wx` + `nodeSeq` 分配** | `withBridge` / `runNode` 开头 | 否 |
| 3 | **graph 归档写入器**（`nodes/.runs/<graphId>/<seq>-<id>/`，**含 ref 重写与传递闭包校验**、**归档失败不改业务结局**） | 新增内部模块 | 否 |
| 4 | **normalize 阶段冻结 prompt/role（分通道）+ run 临时目录派发** | `normalizeSpec` / 派发处 / `withBridge` finally | **是** |
| 5 | 每尝试独立产出 `nodes/<id>.a<N>.md` + 回执 `attempts[]`（**恒有 `inputSha256`、可空 `inputRef`**、可空产出字段、封闭 status） | `runNode` 的尝试循环 | **是** |
| 6 | 回执增加相对 `artifactRef`/`diffRef`/`sceneRef`（与绝对 `*Path` 并存） | `finish()` | **是** |
| 7 | **`RECEIPT_VERSION` 1 → 2**（含 SKILL 的升级说明：既有回执全部失去复用资格） | 顶部常量 | **是** |
| 8 | `node:observed` / `node:rejected` / `node:queued` / `queuedMs` | 见 §6 表 | 否 |
| 9 | `node:workspace-intent` / `node:workspace-created` | `createWorktree` 前后 | 否 |
| 10 | `node:progress`（节流 5s） | 读 `w.pendingSnapshots?.[0]` 那处 | 否 |
| 11 | `node:settled`（资产联合 + 恒带 `attempts[]` + 封闭兜底） / `node:attempt-settled`（**每轮收场时发，四种 status 都发**） | `finish()` 之后 / 尝试循环内 | 否 |
| 12 | **§3.4① 的十二步收尾**（封 admission → 排空 → close → 定 result → 写 final → **writer 坏了就补 owner-final** → 关管道 → 删临时目录 → 原样重抛） | `withBridge` 的 `finally` | 否 |
| 13 | 可选 `deps` 注解 + prompt 路径推断 | `normalizeSpec` | 否 |
| 14 | `EVENTS.md` | `skills/agent-bridge-graph/EVENTS.md` | — |
| 15 | `viz/serve.mjs`（圆桌为基座 + 生命管道 + synthetic abandoned 六档 + **EOF 前同步 drain** + **`/file` 收窄到当前 graph 归档** + **异步流式回放/每客户端队列/背压** + **单 tail reader + `lastGoodOffset` 状态机** + **事件不得因超长被丢：按 §3.2 那条不变式，不是"只保终态"** + **自灭状态机整条换成 §3.3 那个 `ownerEnded` 谓词，并删掉"无客户端 10 分钟"兜底**） | — | — |
| 16 | `viz/index.html` | 见 UI 需求文档 | — |
| 17 | `viz/sample/` + `test-viz.mjs` | 仿 loop | — |
| 18 | SKILL.md：①**删掉「这一版明确不做」里的"不做可视化"那一项**（⚠️ 只加新章不删旧句，会得到一份同时说"支持"和"不做"的 SKILL）；②"不做通用流程引擎 / 依赖解析 / 调度器"**保留不动**；③新增可视化章（含隐私口径、**回执升版的迁移代价**、**同 outDir 每个 `withBridge` 是独立页面、不提供跨波全貌**） | — | — |

**`deps` 不进 `specHash`**：判据是既有那条「凡是会**改变执行结局**的字段都要进指纹」。`deps` 执行不读，改它不改结局；进了指纹反而会让"只改个注解"白白作废可复用产出。

### 验收（**断言必须判别**）

- **零消耗回归 `test-viz.mjs`**：喂 sample transcript，断言三档拓扑、`status × outcome` 的**合法组合**、attempt 分轮、`observed`/`queued`/`rejected` 态、`reused` 不伪装成 ok、空态。
- ⚠️ **自动负对照**：同一次运行里把渲染器换成「**把推断边也画成实线**」，断言**指定的那几条**断言变红。UIREQ 说「把推断当事实展示是这个页面最容易造成的误导」——**守它的测试必须能判别**。
- **`outcome` 三档各一个 fixture**：`no-changes` 不显示 diff 入口、`unknown` 必须显示工作副本路径与「不要自动重跑」、**`delivered` 但 `removed:false`** 显示"收尾时未确认清理"。
- **`unknown + delivered` 的 fixture**，且**两种成因各一个**（回执写失败 / open 返回形状不认识）——断言两者都照常给出分支与 diff 入口。
- **`delivered` 且 `filesChanged=[]` 的 fixture**：断言页面**不**说"没有改动"（它有 HEAD 前进，只是净改动为零）。
- **`receipt.state = "unavailable"` 的 fixture**：断言页面走内联兜底、且**明说回执缺失的原因**，不是静默留白。
- **`node:rejected` 四个 phase 各一个 fixture**：断言它们**不**被显示成 `abandoned` 或 `unknown`。⚠️ **只断言这一条是判别不了的**——四种全渲染成同一句"被拒绝了"照样能过。必须**逐个断言 phase 本身与该 phase 的处置提示**（撞 id → 提示先分辨是不是有人在跑；workspace-setup → 提示去看残留）。
- **中断 fixture ×6（六种 `abandoned` 一一对应，不能只测 running 那四种）**：①停在 `observed`；②停在 `queued`；③`node:started` 之后、`workspace-intent` 之前 → 断言文案是**"还没开始建"**，且**不给任何路径**；④只到 `workspace-intent` → 断言给预定路径**且标注未确认**；⑤有 `workspace-created` 无 `node:settled` → 断言给路径 + 分支 + 禁止重跑；⑥running-read 且现场三件套不存在 → 断言明说"未捕获现场"，不给死链接。
  ⚠️ ③④两条要**互为负对照**：把 ③ 的渲染换成 ④ 的文案要变红，反之亦然。只断言"都显示了 abandoned"是判别不了的假绿。
- **超长终态**：造一条会超 1 MiB 的 `node:settled`，断言①**没有被丢弃**；②**完整 schema 的键集一个不少**（已改：不能再只查"骨架"——现行合同就是"字段级有界化之后一个都不能少"，只查骨架会让实现砍掉 `execution`/`outcome`/`attempts[].inputSha256` 也照样绿）；③被摘要的字段**头尾都留了**（只留头要判红——根因常在最后一行）；④**结构字段没有变成对象**（`ref`/`code`/`sha256`/`path`/`branch` 仍是字符串）。⚠️ **这条里别写 `id`**——`id` 只出现在 `node:observed`，`node:settled` 里根本没有它，写进来会让正确实现被判红；要验 `id` 不被摘要，放到超长 `node:observed` 那条用例里。
- **结构字段超限**：造一个 600 字节的分支名，断言走的是 `recording-failed`，**不是**把 `branch` 换成 `boundedSummary` 对象。
- **短写**：注入一个只写一半字节就返回的底层 write，断言①`append()` **不 resolve 成功**；②整件事被判成 recorder 损坏（`recording-failed` + `owner-final`），**而不是**一次"已确认"的收场。⚠️ 这条与 `writer.close()` 抛错那条**互为负对照**。
- **控制消息越过未 tail 到的事件**（对应 BLOCKER）：**阻塞/暂停 viewer 的文件 poll**，制造"`seq=11` 已写盘但 viewer 没读到、`seq=12` 写失败且 `recording-failed` 已经从 IPC 到达"，断言客户端收到的顺序是 **11 在前、控制状态在后**。⚠️ **live 客户端与 replaying 客户端各测一次**——只测其一必漏（早先的稿子的缓冲区只覆盖 replaying 那条路）。
- **`lastGoodOffset` 的四条**（对应 BLOCKER）：
  ① **半行短写后的偏移**：让 `seq=12` 只写一半就失败，断言 `lastGoodOffset` 停在 `seq=11` 的行尾（**不是**物理 EOF），且那半行**从未被解析或广播**；
  ② **poll 与 drain 重叠**：在普通 poll 正在读时送来 `recording-failed`，断言**没有第二个 reader**、没有重复广播、没有把多字节字符拼坏（用一条含中文的事件来测，UTF-8 边界才会被真的踩到）；
  ③ **drain 期间接入新客户端**：断言它拿到的历史止于 `lastGoodOffset`，且随后与老客户端**收到同一份控制状态**；
  ④ **drain 自己失败**：断言页面进入「历史读取失败」**并且照样公布了控制状态**——⚠️ 这条最容易被实现成"drain 失败就 return"，那样页面会永远显示"运行中"，而且**不会有任何报错**（假绿里最阴的一种）。
- **超限断开的原因页面收得到**：断言 `viz:overflow` 是**具名 SSE 事件**、页面真的拿到了它并据此显示"正在重连"。⚠️ **发成 SSE 注释（`:` 开头）浏览器根本不交给页面**——只断言"断开了又重连上"会让这条假绿。
- **回放期间服务端仍然活着**：回放一个大 transcript 的同时**发第二个 HTTP/SSE 请求**，断言它能被及时响应。⚠️ **少了这条，一个 `readFileSync` 实现照样能过全部其它用例**——"异步流式"这四个字必须有一条用例真的去证。
- **历史读取失败**：让 transcript 在回放中途被删掉/截断，或在**非末尾**位置放一行坏 JSON，断言页面进入「历史读取失败」这个**语义态**（`historyReadFailure = true`），**且不据此产生任何关于 owner 收尾的结论**。⚠️ **不要断言"没有出现某句旧文案"**——那句文案已经不存在了，于是"错误地显示成『未观测到正常收尾』"照样能过。**断言状态，不断言废弃文本。**
- **慢客户端超限断开后重连**：断言①服务端断得掉；②重连后是**全量回放**；③**浏览器按 `seq` 去重**，计数与时间轴**没有翻倍**（参考实现 `viz/index.html` 已有这段去重，别丢）。
- **没见过的 code**：塞一个 `future-code-x`，断言页面**原样显示它**并给通用文案；同一用例里再塞一个字面量 `unknown`，断言**两者文案不同**（若实现把未知码改写成 `unknown`，这条当场红）。
- **复用 + 回执归档失败 + `fingerprint-only`**（对应 BLOCKER）：原运行 viz-off、本次复用命中、且**注入归档 `receipt.json` 写失败**，断言页面**仍然显示得出那串输入指纹**（来自 `node:settled.attempts[].inputSha256`）。⚠️ 复用节点**不发任何 attempt 事件**，所以这条路上 `attempts[]` 是唯一的指纹来源。
- **跨 outDir 拒绝**：开 viz 后用不同 outDir 调 `runNode`，断言当场报错，**且断言那个"外来 outDir"里没有产生任何文件、锁或归档**。
  ⚠️ 早先的稿子写的是"拒绝发生在任何文件被创建之前"——**这条按字面必然假红**：绑定 graph 的 transcript 在回调之前就建好了。断言要瞄准的是**外来目录**，不是"整个进程一个文件都没写"。
- **归档是传递闭包**：跑完 graph A，**故意改掉输入、产出与 diff** 再用 `force` 跑 graph B，然后**递归遍历 A 的每一个 ref**（含 receipt 内嵌的 `artifactRef`/`diffRef`/`sceneRef`/`attempts[].*`），断言：①内容一字未变；②**没有一个 ref 指向 canonical 区或别的 graph**。
  ⚠️ 只检查顶层那一个 ref 是假绿——变质恰恰藏在回执**内部**那些 ref 里。
- **同 id 的三条合同各一个用例**（不能揉成一条，它们校验的是三件事）：
  ① 顺序 + `force` 跑两次 → **两次都有终态**，靠 `nodeSeq` 完全可分；
  ② 顺序、不带 `force` → 第二次是 `node:rejected{phase:"reuse-check"}`；
  ③ **并发**同 id → 第二次是 `node:rejected{phase:"lock"}`，且**第一次不受影响**（这条正是 codex 举的那个错误时序）。
- **原运行 viz-off、后波 viz-on 复用**（write + 触发过 reask），⚠️ **必须拆成两条，否则其中一条是假红**：
  ① **重说模板没变** → 按"指纹对得上才落盘"的规则，**每一轮都应该恢复成功、都有 `inputRef`**（早先的稿子把这条写成"第二轮必须为 null"，与新合同正好相反，是假红）；
  ② **刻意改掉重说模板** → 那一轮 `inputRef` 为 null，页面显示"仅保留指纹"。
  两条都断言**每个 attempt 的 `artifactSha256` 都被验过**。
- **封 admission 之后的迟到调用**：**两条公开路径各测一次**（`bridge.runNode(spec)` 与导出的 `runNode(bridge, spec)`），断言①返回的是**rejected Promise**而不是同步抛；②**没有产生任何事件、归档或 worktree**。
- **归档写失败的两种**（⚠️ **注入点必须是节点自己的归档子目录 `nodes/.runs/<graphId>/<seq>-<id>/`**，不是 graph 归档根 `nodes/.runs/<graphId>/`——后者建不起来属于**初始化失败，应当在回调之前就 fail-fast**，拿它来测"逐资产 unavailable"是注错了层、必然假红）：①**该节点的归档子目录建不起来** → 断言该节点每个**本次本来就该归档**的资产各自标成 `unavailable`（不能只在根上标一次），⚠️ **同时断言先天不适用的槽位仍是 `not-applicable`**（没配 role、read 节点的 diff）——把它们也要求成 `unavailable` 是**会逼正确实现变差的假红**；②中途某个资产写失败 → 断言只有它是 `unavailable`，**同一条事件里其它资产照常 `present`**。
- **writer 坏掉之后的两条分支**：①随后受控收尾 → 断言页面按 `owner-final` 显示「已结束（观测记录损坏）」；②随后被强杀 → 断言显示「观测损坏且 owner 丢失」。**两者不得共用同一句文案**，且都要断言**没有**把缺失的节点逐个合成 `abandoned`。
  ⚠️ **还要各测一次"控制消息发生之后刷新页面"**——只测一直开着的那个页面是假绿：旧状态还留在浏览器内存里，看不出服务端有没有给新连接补发控制状态。
- **`run:final` 自己写失败**：断言仍然发出了 `owner-final`，页面判成「已结束（记录损坏）」而**不是**「owner 丢失」。
- **长历史回放**：制造 **20,001 条**事件后**刷新页面**，断言早期的 `run:started` / `node:observed` **确实拿得到**。
  ⚠️ **这个数字是照着圆桌那份 serve 的 `MAX_EVENTS = 20000` 挑的**，用来证伪"内存窗口足够"这个假设；本设计已经把全局历史数组删了，所以**测试里不要引用任何这样的常量**——直接写死条数，否则实现改个常量就能让用例失去意义。
  ⚠️ **不能写成"或者页面标出历史不完整也算过"**——早先的稿子就是这么写的，那是假绿：既然已经选了"从文件完整回放"，这条用例的职责就是**证明它真的完整**。「历史回放不完整」只是 transcript 本身损坏时的异常兜底，不是本用例的合格线。
- **回放/live 切换**：在回放**进行中**追加一条生命周期事件与一条控制消息，断言**不漏、不乱序、不重复生效**。
  ⚠️ **"进行中"必须用 barrier 或独立进程来保证**——同进程 `setTimeout` 不算：一旦实现里有任何同步读，事件循环被占住，追加只会发生在回放**结束之后**，这条用例就必然假绿。
- **慢客户端背压**：一个读得很慢的 SSE 客户端，断言服务端**遵守 `res.write()` 的背压**（不无限缓冲），且该客户端缓存超限时是**断开让它重连**，不是静默丢事件。
- **强杀在 attempt 2 中途**：断言 attempt 1 的产出**仍能从事件流被发现**（靠 `node:attempt-settled`，此时根本没有 `node:settled`）。
- **scene 三个子文件混合态**：`session.log` present、`answer.txt` unavailable、`status.json` not-applicable，断言三者**各自**显示正确，且 `scene` 本身**不是一个可点击的目录链接**。
- **超长 `node:observed`**：断言它**没有被整条丢掉**，且**逐项检查 `spec`/`prompt`/`role` 三个资产状态都还在**。
  ⚠️ 只断言"事件还在"是假绿——只剩 `{event, seq, nodeSeq}` 也能过，而那三份输入就此永久消失。
- **终态降级后仍可点击**：造一条超限的 `node:settled`（⚠️ **fixture 里要包含一个混合态的 `scene`**，否则正确的容器实现会被判红），断言降级后每个 `present` **叶子文件**资产仍带齐 `ref`/`sha256`/`byteCount`、`scene` 的 `files` map 整体保住——只剩 `state:"present"` 判红。
- **`writer.close()` 抛错**：断言后续的关管道、删临时目录**照样走完**，**没有盖掉回调的原始异常**，且**没有**因此宣布 recording failure（`run:final` 已确认落盘时，页面就该显示"已结束"）。
  ⚠️ **还要有一条对照**：让 `append(final)` 自己 reject（底层写调用失败），断言这次走的是 `recording-failed` + `owner-final`。**两条必须互为负对照**——如果实现把"关 fd 失败"也当成写失败，第一条要变红。
- **回调自己接住了失败节点**：让回调正常返回（内部把一个 `contract_error` 处理掉了），断言 `run:final.result` 仍是 **`completed`**——**观测台不裁决业务成败**。
- **零字节产出**：断言首跑与复用**判据一致**（首跑不再判 ok），且 attempt 记 `no-output`、允许重说、仍空则 `contract_error`。
- **篡改历史 attempt**：改掉 `<id>.a1.md` 再复用，断言**当场拒绝**（不是照样归档）。
- **收尾竞态**：A 抛 `UsageError`、B 正在跑、C×2 卡在闸上 → 断言 `run:final` 之前**每个节点都有终态**，且 **close 之后没有任何新的 worktree 被创建、没有新的 `open_session` 发出**。
- **transcript writer 中途坏掉**：断言语义态 `recordingIntegrity = damaged`（再按有没有 `owner-final` 分成两种收场），且**没有**把缺结局的节点逐个合成 `abandoned`，节点的业务结局**一个都没变**。⚠️ 同上：断言状态，别断言"不含某句旧话"。
- **`/file` 的符号链接逃逸**：在归档目录里放一个指向仓库外的链接，断言被 realpath 复核挡下（**只测词法越界是不够的**）。
  ⚠️ **Windows 上别用 `ln -s`**：没开开发者模式时建符号链接需要提权，测试会因为**环境**而不是因为**实现**变红。用 `New-Item -ItemType Junction`（这台机器上已经验证过 `ln -s` 会退化成拷贝），或者先做一次能力探测、建不出来就跳过并**打印跳过原因**——静默跳过等于假绿。
- **同 outDir 两个 graph 并发**：断言两份 transcript 互不干扰、两套归档互不覆盖。
- **冻结生效**：节点排队期间**改掉 promptFile / roleFile**，断言实际派发的与 `specHash`/`inputSha256` 记的是同一份（即改动**没有**生效）。
- **回执升版**：拿一张 `receiptVersion:1` 的旧回执，断言 `reuseIfSame` **明确拒绝**并说清原因，而不是静默降级。
- **归档写失败**：注入 attempt/diff/scene 任一写失败，断言①节点的业务结局**不变**；②该资产是 `unavailable` 而**不是死链接、也不是 `not-applicable`**；③`code` 说清是哪一步。
- **EOF 与 final 的竞态**：写完 final 立刻关管道，断言 viewer **先 drain 到最后一个完整换行**再判定，不合成假 `abandoned`。
- **`/file` 越界**：把 outDir 设成仓库根，断言 `/file?ref=.env`、`?ref=nodes/<id>.md`（canonical 区）**都被拒**，只有当前 graph 归档下的 ref 能取。
- ⚠️ **viz 的产物不弄脏主树**（这条**必须用临时仓库跑**）：造一个 outDir **在仓库内、且没有被 gitignore** 的场景，开 viz 连跑两个 write 节点，断言**两个都没有被脏树闸拦下**（第一个验 **transcript**——它在回调前就落盘；第二个验归档。⚠️ **别再提"viewer 状态文件"**：viewer 已经不写任何状态文件了，照旧写会逼测试作者要么把正确实现判红、要么把刚删掉的文件加回来）。本仓 `.graph/` 在 `.gitignore` 里，**照着本仓写的测试会永远是绿的**——那正是假绿。
  ⚠️ **必须同时有正对照**，否则"实现错误地把整个 outDir 都排掉了"也是绿的：在 `nodes/` **之外**放一个未跟踪文件、在 `nodes/` **之内**改一个**已跟踪**文件，断言这两种**仍然被拦下**。（第二条正是源码那条注释的精髓：排除只对 `??` 生效。）
- 真跑一次 `examples/hetero-audit.mjs` 开 viz，人眼验收。
- `repro-graph-node.mjs` / `repro-graph-worktree.mjs` **必须仍全绿**（事件 writer 不能改变 `runNode` 的返回契约）。⚠️ 两份 repro 里若有断言旧 `receiptVersion` 的地方，**要一并改**，且改动本身要能说清为什么不是在削弱断言。

---

## 10. 明确不做

- 不做 plan/DAG 声明格式、不做依赖解析与调度（`deps` 只是**未验证的声明**）
- 不做在 viz 里**操作**运行（暂停/重跑/改参数/合分支）——只读观测台
- **不做跨波聚合**（§3.1 合同 A 的代价）
- **不做重新打开旧 run 的页面**（§3.4③）——归档在磁盘上，但 v1 没有 viewer 的独立入口
- 不做跨 out-dir 的历史聚合 / 多 run 对比
- 不做鉴权（本机 localhost）
- **不做共享 writer 锁**（§3.1④）
- **不改写节点产出**：viz 只渲染，`nodes/*.md` 是桥的字节直传原件，页面必须提供"看原文"
- **不给 `withBridge` 加信号处理器**——信号处理器无法可靠等待 git 收尾，也覆盖不了 SIGKILL；中断判定归 §3.4 的管道

---
