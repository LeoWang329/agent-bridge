# 基础桥「委托会话史」可视化 —— 方案设计

**日期** 2026-07-26（v5 修订 2026-07-29）· **状态** 提案 · **修订** v5（codex 两轮 + claude 交叉 + 第四轮"对着已建成系统"复审，见 §13）

> **v5 的六处改动全部来自同一个新事实**：07-28~29 合入了 `skills/agent-bridge-graph/` 的 graph 观测台——
> 一套**已经跑通、过了七轮复审和真后端 e2e** 的同类系统。本文若干条结论在它面前要么有了更好的现成答案，
> 要么被直接推翻。**改动清单**：§4.3 复盘口径（默认已翻转成关）· §8.1 静默观测缺失 · §8.6 `degraded` 单一真理源 ·
> §9 服务端基线换成 graph 那份 + 删掉"无客户端十分钟自灭" · §10 默认关 · §12 不干扰验收改故障注入。
**范围** `skills/agent-bridge/`（基础桥本体），**不是** graph / roundtable / loop 的可视化
**关联** `scripts/agent-bridge.mjs`、`docs/DESIGN-agent-bridge-roundtable-viz-2026-07-04.md`（形态先例）

---

## 0. 结论摘要

你要的是：**当前主 agent 通过桥拉起了哪些 agent、谁还活着、点进去看它每一轮的输入和输出，按轮次区分**。

**这件事今天做不出来，不是因为没有页面，是因为桥没有在记会话史。**

- **prompt 没有可靠落盘。** 诊断日志里 `text` / `delta` / `output` 被 `redactForLog` 抹成 `<elided 1823c>`（`:1423`/`:1447`）。少数路径仍会留下 prompt 头部（codex/claude 出站消息记前 600 字符，`:2960`/`:3580`），但那是**片段、不成体系、不带轮次**。
- **输出只有"最近一次成功持久化的 result 快照"。** `answer.txt` 只在 `buildSessionResult()` 被调用、文本非空、`persist !== false` 时才写（`:1323`）；没被收集的轮次可能一次都没写过，中途 `result()` 会用半截覆盖它。五个后端 `close()` 都删它。
- **没有轮次历史。** 各后端有 `turnCount`，但上一轮的正文与输入桥自己不留。

方案 = **桥自己记会话史**（改 `scripts/agent-bridge.mjs`）+ **一个只读观测台**（复用圆桌 `serve.mjs` + 单文件 `index.html`，第三次复用同一形态）。

**四条已定的约束（用户拍板）：**

1. 写进一个**随机命名的临时目录**，随主 agent 生灭、退出即删（§4）。
2. **只放给人看的干净内容**，不许塞大段 log（§7）。
3. **绝不干扰桥的运行**（§8）。
4. 流式累积的内容，UI 也要能流式显示（§6.4）。

**三轮复审改掉的东西**（详见 §13）：

- **v2**：放弃"边流边追加"——五个后端里四个的运行中 buffer 与终态正文**没有前缀关系**（§6.1）。改为运行中只发轻量进度、终态一次写完整正文。
- **v3**：两阶段 turn 协议（"拿到 prompt"≠"turn 已开始"，§3.3）；进度改走 sidecar（v2 把尾巴按 1 Hz 追加进 transcript ≈ 360 万字符/轮，正好违反约束 2）。
- **v4**：**OMP 不发那次 RPC**（v3 打算破例，实测会触发 `#markUnresponsive()` **杀掉健康会话**，§6.2）；**终结事件改用"精确 hook + 通用兜底"双层**，不再赌枚举完备（§3.1）；**范围砍到 v0**（§11）。

---

## 1. 需求拆解

| # | 需求 | 现有数据够不够 |
|---|---|---|
| R1 | 看当前主 agent 拉起了哪些 agent | ⚠️ 会话表只在**进程内存**里。pid 记录有 `agent`/`cwd` 但缺 `model`/`access`，形状 B 轮间还没有记录 |
| R2 | 哪些还活着 | ⚠️ 同上；且 **不能用 pid 判**——cursor/kimi 轮间不持有进程，按 pid 判会把健康的空闲会话误判成死的 |
| R3 | 点开看**输入** | ❌ 无可靠来源 |
| R4 | 点开看**输出** | ❌ 只有最近一次成功持久化的快照，close 即删 |
| R5 | **按轮次区分** | ❌ 有 `turnCount`，无历史正文 |

---

## 2. 现状盘点

| 落盘物 | 位置 | 内容 | 对本需求 |
|---|---|---|---|
| 诊断日志 | `logs/<runId>/<sid>.log` | 事件骨架；已知正文键被 elide，**未知键仍留前 512 字符**（`ARCHITECTURE.md:35`），单行硬顶 4 KB | **不是可靠全文源** |
| result 快照 | `logs/<runId>/<sid>.answer.txt` | 最近一次成功持久化的 result | 非每轮、可能半截、close 即删 |
| pid 记录 | `pids/<sid>.json` | role/pid/argv/**agent/cwd**/owner | 缺 model/access；形状 B 轮间无记录 |
| 会话对象 | **仅内存** | 全套元信息 + events(≤300) + turnCount + contextUsage | 进程一退全没 |

**诊断日志和会话史是两种东西**——读者不同、内容不同、体积策略不同。把正文塞回 `.log` 就是直接推翻 2026-07-18 那次日志体积根因修复。

---

## 3. 决策一：谁来写

**桥自己写。** 主 agent 手写那条路不通：基础桥没有编排脚本这个位置，而且**它手上的数据本来就是被削过的**——`return_mode:"ref"` 让它拿到 `text:null`，`max_chars` 让它只拿到头部，流式过程它根本看不见。

桥是唯一同时握有 prompt 原文、后端流式输出、turn 边界、状态迁移的角色，且是代码：忘不了、零 token。

### 3.1 终结侧：精确 hook + 通用兜底（v4 改）

**v3 的做法是逐条枚举所有绕过 `#settleTurn` 的路径，然后逐个挂钩。整套安全论证押在"这张表是穷尽的"上——而它已经被证明不穷尽。**

已确认的绕过路径（六类）：

| 绕过路径 | 位置 |
|---|---|
| OMP `abort()` 直接清 `turnInFlight`，不经 `agent_end` | `:2660` |
| Codex `abort()` 源码注释明写 "bypasses #settleTurn"；崩溃走 `#rejectAll` | `:3340` |
| Claude 进程/stdin 失败走 `#failTurn` | `:3799` |
| Cursor / Kimi abort-timeout 手工复制结算字段 | `:4335` / `:4856` |
| Cursor / Kimi `close()` 直接 reject 在途 turn | `:4400` / `:4908` |
| 进程级 `cleanupSessions() → session.close()` | `:5865` |

**而 v3 自己就漏了一条同源的**：它把 `session:closed` 挂在 `closeSession()` 上，但 `session.close()` 有**四个**直接调用点绕过它——`openSession` 的两条失败路径（`:5062`、`:5094`）与 `cleanupSessions`（`:5868`）。同一份文档里，同一个事实用了一次、漏用了一次。**这说明"人工枚举 + 验收矩阵"这个方法在 6000 行文件上不可靠。**

**v4 改成双层：**

| 层 | 干什么 | 挂在哪 |
|---|---|---|
| **精确 hook** | 抓正文 + 判定准确的 `outcome`（这个必须在现场同步做） | 各后端既有的结算/异常路径 |
| **通用兜底 poller** | **保证事件一定发出来** | §5.3 那个已经要跑的 ~1 Hz tick：`ledger.activeTurn(sid) && sessionSettled(session)` 为真就补发 `turn:settled` |

`sessionSettled()` 是桥自己给 `wait` 用的权威判据（`:5190`），**天然覆盖所有绕过路径，包括没人枚举出来的那些**。

漏挂一个 hook 的后果因此从"页面永远卡在运行中"降级为"这一轮 `bodyKind:none` + 粗分类 outcome"。**验收矩阵也随之从正确性依赖变成质量检查。**

`session:closed` 同理：**挂 `session.close()` 这个类方法**（真漏斗——五处 `setSessionStatus(this,"closed")` 就是证明），不挂 `closeSession()` 工具函数。

### 3.2 起始侧是 prompt 的单一漏斗，但**不是** turn 的诞生点

prompt 只有两个入口：`openSession()` 的 `initial_prompt`（`:5083`）与 `sendMessage()`（`:5162`），都汇进 `session.send()`。**没有第三个**。`setSessionStatus()` 也确实是状态写入的唯一漏斗。

⚠️ 但**"拿到 prompt"≠"turn 已经开始"**。在那两个点直接发 `turn:started` 会同时犯两个错：

- **拿不到 `turnId`**：OMP 要等 prompt ACK 之后才铸（`:2585`）、Codex 要等 `turn/start` 响应或通知（`:3245`）、Cursor/Kimi 要 spawn 成功（`:4280`/`:4786`）。
- **会造幽灵轮次**：空 prompt、busy session、Codex `turn/start` 失败（`:3214` 明确保留旧 turn、不加计数）、Claude 写 stdin 失败、Cursor/Kimi spawn 失败——都在**没有 turn 真正开始**时抛错。

### 3.3 两阶段 turn 协议

| 阶段 | 谁做 | 做什么 |
|---|---|---|
| **attempt** | 外层两个 `send()` 调用点 | 建**未公开**的 attempt，把 prompt 字符串握在内存里。**不发事件、不分配 `turnNo`、不落盘** |
| **accepted** | 各后端在自己既有的 accept / `#beginTurn` 边界 | `vizTurnAccepted(attempt)` → 分配 `turnNo`、绑 `turnId`、**排队异步落盘输入**、发 `turn:started` |
| **丢弃** | accept 之前失败 | 内部丢弃 attempt，**不发任何事件**。主 agent 当场就以异常形式收到了这个错误，页面上多一条红条目只是噪音 |

**三条实现纪律：**

1. ⚠️ **输入落盘必须异步。** Codex 的 `#beginTurn` 可以从 `#handleNotification` 里被调用（`:3069`，源码注释明写 `turn/started` 通知会先于 `send()` 的 await 续体到达）——那是 readline 的**同步回调**。在那里做一次最大 4 MB 的 `writeFileSync` 会冻住事件循环、后端 stdout 不排空。排进 §8.5 的 run 级串行队列即可；prompt 字符串在 attempt 里握着，不存在被覆盖的风险，晚几十毫秒无所谓。
2. ⚠️ **attempt 有第三态：既没 accept 也没被拒。** OMP 的 accept 边界是 `await request("prompt")` 返回（`:2571`），这个 RPC 有 10 s 超时——**超时 ≠ 后端没接受**，它可能已经在跑，只是 ack 慢。所以 **attempt 在失败时不立即销毁，标记 `orphaned` 保留**；后到的结算能凭 `sessionId` 认领回来，补发 `turn:started` + `turn:settled`。**绝不允许"active turn 为空就猜一个 turnNo"。**
3. **accept 之前到达的流一律丢弃**（OMP 的 `message_update`/`turn_start` 可能早于 ack 续体）。此时还没有 `turnNo`，没有文件名可写。写明是"丢弃"，不要让实现者临场决定缓存。

### 3.4 插桩点

| 事件 | 位置 |
|---|---|
| 会话开 / 开失败 | `openSession()`（失败分支里 `session` 对象已构造，`summary()` 可用） |
| 会话关 | **`session.close()` 类方法**（§3.1） |
| 状态迁移 | `setSessionStatus()`（唯一漏斗），**当场重算 `deriveHealth(session)`**，不读缓存 |
| turn 接受 | 五后端各自的 accept / `#beginTurn` 边界（§3.3） |
| turn 结算 | 精确 hook + poller 兜底（§3.1） |
| 活进度 | 五后端既有的流式回调（节流后写 sidecar） |
| 结果被取走 | `buildSessionResult()` 的调用方（§5.4） |

---

## 4. 决策二：随机临时目录，随主 agent 生灭

### 4.1 位置与命名

```js
VIZ_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-viz-"));
// → C:\Users\<u>\AppData\Local\Temp\agent-bridge-viz-Xk9mQ2\
```

**为什么用 `mkdtemp` 而不是自己拼随机名再 `mkdir`：** 临时目录是共享目录，"先算名字再创建"中间有窗口可能被抢先占位或换成符号链接。`mkdtemp` 是原子创建 + 唯一 + 权限正确的标准 API，正好满足"名称不固定"。

**前缀固定、后缀随机。** 前缀只是人工排查的抓手；**主路径是桥把 `vizDir` 写进 MCP 工具返回值**（§10），主 agent 直接传给 viewer，不靠猜、不靠扫。

```
<VIZ_DIR>/
  meta.json            ← runId / pid / 进程起始时间 / 桥版本 / 客户端 cwd / degraded 标记
  owner                ← pid + 进程起始时间
  transcript.jsonl     ← 事件流(单 writer = 本进程，只有骨架)
  turns/<sessionId>/
    t1.in.md   t1.out.md            ← 输入 accept 后异步写；输出终态一次写
    t3.progress.json                ← 仅活跃轮次存在，结算后**删除**
```

### 4.2 四道删除

| # | 触发 | 做法 |
|---|---|---|
| 1 | 正常退出（stdin 关闭 / SIGTERM / SIGINT / stdout EPIPE / 未捕获异常） | `cleanupAndExit` 调幂等的 `vizCleanup()` |
| 2 | **主 agent 被退出** | 父进程看门狗（15 s）→ 走 `cleanupAndExit` → 同 #1 |
| 3 | **顶层 `runCli(...).catch`**（`:6000` 直接 `cleanupSessions(); process.exit(1)`，**不走 `cleanupAndExit`**）+ 同步 `exit` handler（`:5971`） | 同一个 `vizCleanup()` 也挂上 |
| 4 | SIGKILL / 强杀 / 断电 | 上面都不执行。兜底：**`cleanup` CLI** 扫 `tmpdir/agent-bridge-viz-*`，`owner` 已死的整个删（**不放进 MCP 热路径**，§8.4）；**viewer 对自己这一个 run 做周期 owner 检查**（§9） |

⚠️ **`vizCleanup()` 必须幂等**——三条路径可能重入。

⚠️ **ownerless 宽限不能省。** 两个 MCP 同时启动时，A 刚 `mkdtemp` 还没写 `owner`，B 的扫描不能删它。`reclaimStaleLogs` 对 ownerless 目录已有 60 秒年龄保护（`:1865`），照抄。

⚠️ **`owner` 记 pid + 进程起始时间**，不只是 pid。（现有 `ownerStillRunning` 在探针不确定时**倾向保留**（`:1675`），所以 pid 复用最坏是多留一阵，**不会误删别人的活目录**——复审核实过。）

⚠️ **与 `logs/<runId>/` 的区别：崩溃时不保留。** 那个目录 `code !== 0` 时刻意留作现场；viz 目录**任何退出码都删**——现场证据在 `logs/` 与 `exit-journal.jsonl` 里，一份就够。

⚠️ **Windows 删除竞态。** viewer 可能持有句柄导致 `rmSync` 失败。对策：viewer 只做短开短关（§9）、残留交给第 4 道。
（措辞更正：`force:true` **只忽略"目标不存在"**，不会吞掉 Windows 的 `EPERM`/`EBUSY`——真正吞错的是外层 `try/catch`。）
**所以对外文案是"正常路径立即删；硬杀或删除失败依赖后续回收"，不是"退出即删"这种承诺。**

### 4.3 代价，讲清楚

**客户端一退，这批记录就没了，无法隔天复盘。** 缓解在于场景本身：复盘几乎总在同一个主 agent 会话内发生（「它说改完了但结果不对」→ 回头看），这时目录还在。要留档就在页面上复制原文。

⚠️ **v5 更正：上面这段缓解论证是在「默认开」的前提下写的，而默认已经翻转成关（`PLAN §8`，用户 2026-07-27 拍板）。**
翻转之后「这时目录还在」**就不够了**——还得**这个 run 开跑之前就已经启用**。
准确口径只有一句：**只承诺「启用之后、同一个 run 之内」回看原文；那次没开就没有记录。**
所以 SKILL.md 要提示用户在**准备重度委托 / 多 agent 编排之前**主动打开，而不是出事之后才想起来。
（`PLAN §8` 本来就是这么写的，是本文这两处没跟上。）

⚠️ **一条容易说反的：viz 不是比 `answerFile` 活得更短。** 一个 session 被 `close_session` 时 `answerFile` **立即删除**，而 viz 把该 session 的全部正文**留到整个 run 结束**。对已关闭的会话，viz 留存明显更久。这与"随主 agent 生灭"的边界不冲突，但**是一处真实的新增暴露面，不该被"临时目录"四个字粉饰**。默认仍为开；`AGENT_BRIDGE_VIZ=off` 一键关。

---

## 5. 数据面

### 5.1 信封

`{ v, seq, ts, event, payload }`，append-only，**单 run 级串行 appender**。所有 `*Ref` 是相对 `VIZ_DIR` 的相对路径，`/file?ref=` 只接受这种，拒绝绝对路径与 `..`。

**半行容错：** 进程可能写到一半被 SIGKILL，末行可能没有 `\n`。回放与 tail 都必须缓冲到下一个换行再解析。

### 5.2 事件表

> ⚠️ **这张表已被 `PLAN §3`/`§6` 的双槽快照取代**（`PLAN §0` 明写"数据面换双槽快照"）。
> 留在这里只作**字段来源的说明**（每一项数据从桥的哪个位置取），
> **不要拿它当 wire 合同** —— 合同是 `docs/STATE-session-viz.md`。尤其：`run:terminated` **不再是一条记录里的事件**，
> run 终态走传输层的 `control{kind:"run-gone"}`（`PLAN §6.4`）。

| `event` | 关键 `payload` | 表达什么 |
|---|---|---|
| `run:started` | `runId`,`pid`,`bridgeVersion`,`startedAt` | 一个主 agent 上线 |
| `session:opened` | `session.summary()` 全套（`sessionId`,`name`,`agent`,`model`,`effort`,`access`,`cwd`,`returnMode`,`appendSystemPrompt`,`backendPid`,`contextUsage`…） | 拉起一个 agent |
| `session:openFailed` | **`{...session.summary(), error}`**——与 `opened` 同形状 | 起不来的会话。**今天完全不可见**（没进 registry，事后无迹可寻）。失败分支里 `session` 对象已构造（`:5060`），`summary()` 白送 |
| `session:status` | `sessionId`,`status`,`health`,`isStreaming`,**`contextUsage`** | 状态迁移。`contextUsage` 挂这里而不是只挂结算——UI 要的是**会话级常驻**读数，而"正在跑一大轮"恰恰是它涨得最快的时候 |
| `session:closed` | `sessionId`,`reason`,`forced`,`turnsTotal`,`uncollectedTurns[]` | 会话关闭（挂 `session.close()`） |
| `turn:started` | `sessionId`,`turnNo`,`turnId`,**`backendTurnCount`**,`inputRef`,`inputChars`,`inputTruncated`,`inputOriginalBytes`,`source`,`blocking`,`hasSchema` | 一轮**被后端接受**（§3.3） |
| `turn:settled` | `sessionId`,`turnNo`,`outcome`,`bodyKind`,`outputRef?`,`charCount`,`byteCount`,`durationMs`,`contextUsage`,`error?` | 一轮收场，正文此时才落盘 |
| `turn:collected` | `sessionId`,`turnNo`,`via`,`returnedChars`,`truncated` | 主 agent 真的把**终态**结果取走了（§5.4） |
| `run:terminated` | `code`,`reason`,`uptimeSec`,`sessionsOpen` | 主 agent 下线 |

**枚举不新造**：`status` 沿用 `starting`/`running`/`idle`/`failed`/`closed`，`health` 沿用 `deriveHealth` 三档。

⚠️ **`backendTurnCount` 是为了防编号分叉**：viz 的 `turnNo` 与桥的 `turnCount` 会不一致（codex `#settleTurn` 无条件 `turnCount += 1`，包括某些 viz 不计的形态）。用户在页面上说"第 3 轮出问题"，主 agent 得对得上号。UI 只显示 `turnNo`，但复制时带上 `turnId`。

⚠️ **所有 `error` 字段统一硬顶 300 字符 + 尾部标注。** 这是唯一没上限的机器内容通道：codex 那边是 `clampText(JSON.stringify(params.error), 4000)`（`:3110`）——4000 字符的原始 JSON。不封顶就等于把"事件正文"换成"错误正文"重新塞进来，直接违反约束 2。原文去 `logs/<runId>/<sid>.log`（§7.3 逃生门已经在了）。

#### `outcome` 映射矩阵（写死，不让实现者自己归类）

| `outcome` | 判据 |
|---|---|
| `completed` | 后端语义上成功 |
| `failed` | 后端报错、协议错误、意外进程退出、**abort 超时**（Cursor/Kimi 的 abort-timeout 在源码里就是按失败处理并置 `lastTurnError=true`，`:4342`/`:4862`） |
| `aborted` | 显式 abort **且确实完成了中断** |
| `abandoned` | 已接受的 turn 被 session close / 进程级 cleanup 截断，**且未取得后端终态**（含 poller 兜底补发的那些） |

#### `bodyKind`：非成功轮次到底有没有正文

`final`（权威全文）/ `partial`（只有可能不完整的片段）/ `none`（什么都没有）。

**必须有这个字段**，因为五个后端被打断时留下的东西不一样：Claude 的 abort 在读到 `msg.result` 之前就结算了（`:3680`）、Codex/Cursor 中途只有已 clamp 的预览、只有 Kimi 和 OMP 的 viz 缓冲可能留有未截断片段。**没有它，设计师会画出一个五后端都能看完整中断片段的界面，而实现只能兑现一部分。**

### 5.3 进度走 sidecar，不进 transcript

⚠️ **v2 把 2000 字尾巴按 1 Hz 追加进 `transcript.jsonl` —— 2000 × 1 Hz × 30 min ≈ 360 万字符/轮**，20 个并行会话几十 MB，且绝大部分是彼此重叠的滑动窗口。这正好违反约束 2。

**改法：每个活跃 turn 一个 `turns/<sid>/t<N>.progress.json`，覆盖写，不追加。**

```json
{ "seq": 128, "generation": 2, "updatedAt": "…", "charCount": 3241, "tail": "…(400 字)…" }
```

四条设计决定：

1. **尾巴 400 字，不是 2000。** 2000 字在页面上就是一大块滚动文本，正好诱导设计师做出"看起来在稳定累积的文稿"——而那恰恰是 §6.4 反复警告不要做的。400 字 ≈ 三四行，天然读作"它现在正在写这句"。
2. **`generation`：每次后端清空自己的 buffer 就 +1。** 这是让 UI 能说出「**已重新组织答案（第 2 稿）**」的唯一数据来源。信号各后端全都现成：OMP 的 `turnGeneration`（`:2345`）、codex 的 phase 切换、Claude 每个顶层 assistant 块、Cursor 的 `result` 替换、Kimi 从不重置。**没有它，UI 只能靠"字数突然变小"去猜，而字数下降本来就是正常的**——等于要求设计师表达一个页面拿不到的信号。
3. ⚠️ **不用原子写（temp + rename）。** 反直觉但重要：progress 是**可丢弃、每秒重写的纯预览**，不需要原子性。而在 Windows 上每秒 create+rename+unlink × N 会话，Defender 打开 temp 文件就可能让 `MoveFileEx(REPLACE_EXISTING)` 返回 EPERM——rename 失败被 best-effort 吞掉 → 进度停更 → **页面把一个健康会话报成卡住**（UI 判活恰恰看"预览有没有在变"）。直接覆盖写，reader 拿到半截 JSON 就 `catch` 掉、下一 tick 再读。少一半文件操作、零 rename 竞态、代码更短。
   （原子写那条纪律是为 `pids/*.json` 那种"读者会因解析失败而删记录"的场景立的，套到这里是路径依赖。）
4. ⚠️ **`seq` 的语义定死为"产生这条快照时的 transcript seq"，前端必须丢弃 `seq ≤ 该轮 turn:settled 的 seq` 的 progress。** 否则会出现：`turn:settled` 先到、页面显示"✅ 已完成 + 完整正文"，然后一条迟到的 progress 把它**打回"正在生成"**。viewer 还要在收到 `turn:settled` 后立刻停止轮询该 sidecar 并广播 `progress:end`。这条必须进 `EVENTS.md`，否则实现者不会想到。

**结算后删除该 sidecar**（不是"忽略"——跑 20 轮的会话会留 20 个文件，viewer 每 tick 都得 readdir 出来再筛）。

`transcript.jsonl` 只记里程碑，**永远只增长有界的骨架**（v0 砍掉 `turn:activity` 之后这句话才真正成立，§11）。

### 5.4 收口审计（口径收紧）

`turn:collected` 直指桥 v0.10.0 硬化过的收口 invariant：**每个 accepted 的 turn 都必须被收口**。页面能一眼指出「这轮跑完了但没人来取」。

⚠️ **但它不是"白捡"。** `agent_bridge_result` 可以在 turn 运行中调用，`buildSessionResult()` 会把半截文本包装出来（只标 `turnSettled:false`，`:1313`），而且源码明写它不是唯一漏斗、wait 有兜底形状（`:5250`）。仅凭"调用过 `result()`"就记 collected，等于把「看过一次半成品」算成收口。

**正确口径：只有真正返回给 MCP 调用方的 payload 满足 `turnSettled:true`、且能关联到确切 `turnId` 时才记**，按 `(sessionId, turnId)` 去重。
（可行性已核实：`buildSessionResult` 返回的 `summary().lastTurn.id` 对五后端都有值，OMP 的是 ack 之后铸的 `makeId("turn")`（`:2585`），正好是 accept 边界。）

---

## 6. 决策三：运行中只发进度，终态一次写正文

### 6.1 "边流边追加"被源码证伪

v1 的前提是"文件只增长、任意时刻都是最终全文的合法前缀"。**五个后端里四个不成立**：

| 后端 | 运行中 buffer 的真实语义 | 与终态正文的关系 |
|---|---|---|
| **OMP** | 每个内部 `turn_start` 就 `lastAssistantText = ""`（`:2344`），而**一次 `send()` 内多次 turn_start 是工具轮的正常形态**（`fake-omp.mjs:274` 就是照这个 fixture 造的） | 中间片段**不是**最终答案的前缀 |
| **Codex** | delta 无 phase 过滤地累加（`:3074`） | 结算时用 `item.completed` 里 `phase==="final_answer"` 的文本**整体替换**（`:3088`/`:3168`） |
| **Claude** | 每个顶层 `assistant` 是一次 API call 的完整块，**直接覆盖**（`:3641`） | 连续几个块**互不为前缀**，最终正文来自 `result` |
| **Cursor** | 累加作"进度尾巴"（`:4154`） | 最终 `result` **整体替换**（`:4183`） |
| **Kimi** | `finalAnswer += msg.content`（`:4660`） | **真单调累加**（唯一一个） |

所以"整体重写是罕见的自检触发"是错的：**它是正常工具调用路径上的常态**。

### 6.2 正文来源：各后端的 canonical 源

| 后端 | canonical 源 | 未截断？ |
|---|---|---|
| Codex | **`finalAnswer \|\| lastAgentMessage \|\| lastAssistantText`**（照抄 `:3319` 现有表达式） | 前两项是；落到第三项 → `bodyKind` 降级 |
| Claude | `#handleResult` 的 `msg.result` 原文 | ✅ |
| Cursor | `result` 的 `msg.result` 原文 | ✅ |
| Kimi | 累加出的 `finalAnswer` 原文 | ✅ |
| OMP | viz 自维护缓冲 + 宽限（见下） | 尽力，拿不准标 `partial` |

⚠️ **Codex 不能只取 `finalAnswer`。** 它只在 `phase === "final_answer"` 时赋值（`:3088`），而任意 agentMessage 都会写进同样未截断的 `lastAgentMessage`；现有结果路径刻意用的是三级 fallback。只取第一项会在某些路径下**把本来能交付的成功正文写成空文件**。

#### OMP：不发 RPC，宽限 + 诚实降级（v4 定案）

v3 曾打算"允许 OMP 终态多发一次 `get_last_assistant_text`"。**这个方案必须撤销——它能让 viz 杀掉一个健康的会话。**

已核实的链条（`:2484` → `:2529`）：

```
request() 超时(OMP_RPC_TIMEOUT_MS 默认 10s)
  → pending.reject + unresponsiveSince ??= now      // 会话级共享，只有收到响应才清
  → 累计 ~20s 无响应 → #markUnresponsive()
      → dead = true + setSessionStatus("failed") + 拒掉所有在途
      → terminateProcessTree(pid) + scheduleForceKill(pid, 3000)
```

**两次这样的超时跨越 20 秒，桥就会把一个刚正常发完 `agent_end`、只是回 helper 命令慢的后端标成死的，并 kill 掉整棵进程树。**

- 这不是"影响性能"，是**直接推翻约束 3**。
- §8.1「失败绝不冒泡」防的是**异常**，防不住**状态副作用**——这里没有任何异常逃逸，但会话死了。
- 而且这是 viz 独有的**新**暴露：桥今天也发这个 RPC，但只在调用方主动 `result()`/`wait` 时；`wait:false` + 稍后收集这条主路径（skill 里最常用的形态）在 `agent_end` 之后**一次 RPC 都不发**。

**v4 的做法（零 RPC、零核心改动）：**

1. viz 侧自维护一个不截断的"当前子轮"缓冲，**必须复刻两种语义**——`message_update` 既可能给 `text_delta` 增量、也可能给全量 `text` 替换（`:2470`）；在 `agent_start` 与 `turn_start` **都**清空。
2. `agent_end` 到达后**不立即快照**，给一个短宽限（默认 250 ms，`AGENT_BRIDGE_VIZ_OMP_GRACE_MS`）让扩展队列排空。
   （必要性：源码注释明写生命周期事件**没有跨事件串行**，而**队列路径只服务 `message_update`**（`:2383`）——最后一段正文可能仍在队列里而 `agent_end` 已先到。）
3. 宽限期内若缓冲还在增长就顺延，**但有硬上限**（默认 2 s），到点必须落盘发事件。
4. **宽限期结束时缓冲仍在变、或期间发生过 `turn_start`（说明进了下一个子轮）→ `bodyKind: "partial"`**，页面如实标注"可能不完整"。**绝不把可能缺尾的文本冒充 `final`。**

**代价说清楚**：OMP 的正文是五个后端里唯一"尽力而为"的。这是为了不碰桥的健康状态机而付的价，我认为值——**一个偶尔标注"可能不完整"的记录，远好过一个偶尔杀掉用户会话的观测台。**

### 6.3 这个模型换来的好处

1. **前缀不变式、`turn:outputReset`、`/file?from=` 增量协议全部不需要了。** 增量拉取与 reset 事件跨通道竞态的问题随之消失——文件写一次、读一次。
2. **写入频率骤降**到每会话 ~1 Hz 的 sidecar 覆盖写。
3. **更诚实**：Claude/Codex/Cursor 的中间态本来就会被整体改写，把它当"正在写的正文"逐字展示本身就是在骗人。

### 6.4 对"流式展示"这条需求的影响（如实说）

约束 4 是「如果写入的是流式累积的内容，UI 也流式显示」。**进度尾巴就是流式累积的**，UI 照常做滚动流式观感 + `generation` 徽章；**但完整正文不再逐字落盘，而是在收场时一次呈现**。

真要"完整正文实时流"，数据模型必须换成带 `revision` 的 snapshot/replace 协议。**本轮不做**——收益（正文早看几十秒）远小于成本（版本协议 + 五后端语义对齐 + 页面上文字反复被改写的观感）。

---

## 7. 决策四：只放给人看的干净内容

### 7.1 白名单，不是黑名单

**只有两类内容允许进入 `VIZ_DIR`，其余一切默认丢弃：**

① prompt 原文（`t<N>.in.md`）；② 该轮 assistant 正文（`t<N>.out.md`）。

加上 transcript 里**有硬顶的结构化字段**（含 `error` ≤ 300 字符，§5.2）与 progress sidecar 的 400 字尾巴。**没有第三类。**

**为什么必须是白名单：** 这个仓库在日志体积上栽过两次"加类型排除清单"的跟头，根因修复的结论是**在唯一漏斗封顶，而不是维护越来越长的排除表**。writer 遇到不认识的事件，**丢掉**，不是"先记着万一有用"。

⚠️ **不能"直接复用 `redactForLog`"**——它是 denylist + 未知字符串截断（未知键仍留前 512 字符），直接复用会当场违反"其余一律丢弃"。

### 7.2 逃生门指向既有日志，不在 viz 里再存一份

想看它中间到底读了什么文件、跑了什么命令的人，页面给出 `logs/<runId>/<sid>.log` 的**路径**（文件还在时可一键打开），**不把它拷进 `VIZ_DIR`**。两边的体积策略互不污染。

**v0 不做"过程条目"**（原因见 §11）——所以这个逃生门是"它到底动了什么"的唯一去处，SKILL.md 与页面上都要说清楚。

**页面只渲染，绝不改写产出**：`turns/*.md` 是桥的字节直传原件。

---

## 8. 决策五：绝不干扰桥的运行

### 8.1 全程 best-effort，失败绝不冒泡

每个 viz 写入点包在 `try/catch` 里吞错。既有先例：`writePidRecord` 与 `appendLog` 都是这么做的。

⚠️ **但这只防异常，不防状态副作用**（§6.2 那条 BLOCKER 就是活教训）。任何 viz 调用只要**可能改到会话字段、健康判定、进程生命周期**，就不是"包个 try/catch"能救的——那种设计本身就不能要。

⚠️ **v5 补一条推论：吞异常的另一面是「静默观测缺失」。**

"观测永不改变业务结局"这条纪律是对的，但它意味着——**凡是要走到 schema / 形状校验那一层才失败的东西，
都会变成一次悄无声息的记录丢失**：业务照常返回成功，页面却永远等不到那条记录，而**没有任何人会知道**。
graph 观测台就是在这个形状上栽的（见 `docs/DRIFT-events-contract-vs-producer-2026-07-28.md`）。

**所以校验必须前移到入口**：一条记录能不能成立，要在**它被构造出来的那一刻**判掉，
而不是拖到写盘或序列化时才失败。任何被吞掉的失败**必须**同时置 `run.degraded` 并把原因码
并进 `run.recordingErrors`（`PLAN §6.1.1`）——**吞掉异常可以，吞掉"我丢了一条"不行。**

### 8.2 零新增 RPC、零额外后端交互（**无例外**）

所有数据来自**已经在手**的流与状态迁移。不多问后端一次、不多起进程、不多开 RPC。

v3 曾为 OMP 开过一个口子，v4 撤销（§6.2）。**这条现在没有例外，将来也不要开**——那个口子的代价是能杀掉用户的会话。

### 8.3 不碰任何既有文件与状态机

只写 `VIZ_DIR`。不改 `.log` / `.answer.txt` / pid 记录 / 任何会话字段 / turn 状态机 / `sessionSettled`·`wait`·`deriveHealth` 的判定。对外唯一新增是 `vizDir` 一个返回字段（纯 additive）。

（`sessionSettled()` 在 §3.1 的 poller 里只被**读取**，不被修改。）

### 8.4 孤儿清理不放进 MCP 热路径

`ownerStillRunning()` 会进同步进程探测，Windows 下可能同步拉起 PowerShell/CIM，源码专门警告过这会**冻住整个事件循环**（`:1732`）。而 `setImmediate` 只是下一轮事件循环，**不保证 `initialize` 响应已发出**。

**MCP server 启动时根本不扫。** 跨 run 的孤儿回收归 `cleanup` CLI；viewer 只对**自己这一个 run** 做周期 owner 检查（§9）。

### 8.5 写入：单 appender + 有界队列

1. **`transcript.jsonl` 只有一个 run 级串行 appender。** 所有事件排一条队，`seq` 与磁盘顺序永远一致。
2. **进度 sidecar 各写各的**（覆盖写），不参与那条队列。
3. **正文的提交顺序**：终态 hook **同步把正文字符串抓在手上** → 排队写文件 → **写完才 append `turn:settled`**。反过来会让页面拿到 `outputRef` 就去读、读到 404 或半个文件。
   （OMP 例外：正文要等 §6.2 的宽限，所以是"宽限结束 → 抓串 → 写 → 发事件"，宽限有硬上限所以不会无限拖。这一条必须写进 `EVENTS.md`，别让实现者临场发挥。）
4. **输入落盘同样走这条队列**（§3.3 纪律 1）。
5. **run 级上界**：并发写数 + 累计字节都要有顶，不能只说"每轮一个待写项"——20 个会话同时收场就是 20 份大文件同时落盘。

viz 事件**允许晚于**桥自己的 turn promise，不必阻塞桥。

### 8.6 降级要可见

写失败时向 `bridge.log` 记**一行**（同一 run 只记一次），页面显示"本次记录不完整"。**一份看起来完整实则缺页的历史比没有更危险。**

⚠️ **v5 更正：不要在 `meta.json` 里标 `degraded`。** 原文让 `meta.json` 与快照 `run.degraded` 各存一份同一个事实——
**同一个事实有两份可写的副本就一定会漂**，而页面显示哪一份取决于它先读了谁。
唯一真理源是**最新合法快照的 `run.degraded` / `run.recordingErrors`**（`PLAN §6.1.1`）；
`meta.json` 只放**写一次就再也不动**的身份字段。

### 8.7 一键关停

`AGENT_BRIDGE_VIZ=off` 时整套路径不执行（连 `mkdtemp` 都不调）。既是隐私/体量开关，也是**排障隔离手段**。

---

## 9. 服务面与页面

`skills/agent-bridge/viz/serve.mjs` —— ⚠️ **v5 改基线：不要拷圆桌那份。**

写这一节的时候仓库里没有别的选择。现在有了：`skills/agent-bridge-graph/viz/serve.mjs` 是**已经改好、
过了七轮复审与真后端 e2e** 的那一份，下面要求的五处改动它**已经做完**，还多做了几样
（ref 词法校验 → 400、越界 → 403、目录与 symlink 逃逸拒绝、`nosniff`、**响应体实时 SHA-256 头**）。
而**圆桌那份正是下面第 3 条点名要修的病人**（`createReadStream` 整个传输期握着句柄）。
**照抄一个已知有病的、再把病重新治一遍，是纯返工。**
做法见 `PLAN §9 S5`：抽出 graph 那份里的纯函数复用，不复制粘贴第四份。

（以下五条保留，作为**验收清单**——用来核对新基线是否都覆盖到了，而不是照着从头实现一遍。）

1. **单 run**：`node serve.mjs <viz-dir>`。**不扫 tmpdir、没有 `/runs`、没有列表页**（§11）。
2. **进度 sidecar 轮询转 SSE**：每秒读活跃轮次的 `t<N>.progress.json`（半截 JSON 就 catch 跳过）；收到 `turn:settled` 后**立刻停止轮询该 sidecar 并广播 `progress:end`**（§5.3 第 4 条）。
3. **`GET /file?ref=` 短开短关**：`readFileSync` + `res.end()`，**不用 `createReadStream`**（圆桌那份整个传输期间都握着句柄，`serve.mjs:182`，会挡住 §4.2 的删除）。超过 `VIZ_FILE_MAX_MB`（默认 8）只返回前 8 MB + 一句提示 + 文件绝对路径。**不做 offset/limit 分段协议**（§11）。
4. **删掉 `viz.pid` 那套行为**（圆桌版会在 run 目录里写/删这个文件，`serve.mjs:133`/`:204`）——与"不往活着的 run 目录里写东西"冲突。
5. **周期 owner 存活检查**：viewer 开着时 MCP 被 SIGKILL 的话，既没有 `run:terminated`（进程没机会发）、目录也还在（所以没有 `run:gone`），页面会**永远停在"运行中"**。所以要周期查 `owner`，确认死亡 → 标 terminated、广播、删除该目录。

**自灭**：**只有** owner 已结束（`run:gone`）**且**最后一个客户端断开之后，再等 60 s 退出。

⚠️ **v5 删掉了「或始终无客户端满 10 分钟」这条兜底。** 它**不要求 run 已经结束**——
于是一次两小时的运行，只要前十分钟没人打开页面，viewer 就在半途自己消失了；
而"先起 viewer、过一会儿再看"恰恰是最自然的用法。
（graph 观测台已经明令禁止这条，`skills/agent-bridge-graph/viz/serve.mjs` 的 `armGrace()` 里有同样的注释。）

⚠️ **准确的读写边界**（不能笼统说"服务端绝不写 `VIZ_DIR`"）：
- **绝不写 transcript / 正文 / 进度**（真理源单 writer = 桥进程）；
- **绝不往活着的 run 目录里写任何文件**（含 `viz.pid`）；
- **会删除已确认死亡的 run 的整个目录**——这是 §4.2 第四道，是它的职责。

在**会话控制**上仍完全只读（不 send / 不 abort / 不 close）。

`viz/index.html` —— 单文件零依赖，见 UI 需求文档。**只绑 `127.0.0.1`，无鉴权**（同圆桌 / loop）。这个页面是本机全部委托 prompt、产出、工作区路径的聚合视图，**绑回环这条不能松**。

（Markdown 渲染不用重造：`skills/agent-bridge-roundtable/viz/index.html:833` 已有 `mdToHtml()`。）

---

## 10. 启动方式与开关

**桥不起 HTTP 服务**，也**不新增 CLI 子命令**。

v0.7 明确把 core 的 UI/HTTP/SSE 移除、CLI 瘦到 MCP + 诊断/清理（`ARCHITECTURE.md:47`），`DEVELOPMENT.md:56` 仍写着 CLI 只暴露 MCP/doctor/cleanup。独立 viewer 不违反这条，但**把它塞回 6000 行 core router 还宣称"承诺未变"，不成立**。

```
node skills/agent-bridge/viz/serve.mjs <viz-dir> [--port 7346]
```

（顺带更正：现有 CLI 不止三条，源码还有 `serve-mcp` 别名与 `diag`（`runCli` `:5603`）。准确说法是"三个面向用户的主命令"。）

**`vizDir` 怎么到 viewer 手上**：桥把绝对路径放进 `agent_bridge_status`（列全部那个形态）与 `agent_bridge_open_session` 的返回值。主 agent 本来就是拿着 shell 起 viewer 的那个人。**不靠扫描。**

**记录开关：默认开 → ~~v5 改为默认关~~ → 2026-07-31 又翻回「默认开，`AGENT_BRIDGE_VIZ=off` 关」**（用户拍板，真理源是 `docs/STATE-session-viz.md §7`）。
07-27 改成默认关的理由是隐私，那条**至今成立**：桥的诊断日志**刻意不落 prompt 全文**，viz 会把它落盘——这让"本机磁盘上存在全部委托原文"从**不发生**变成**发生**。
翻回来的理由是它没解决问题：记录只在 run 存活期间存在，**出事那次没开就永远查不了**，而默认关等于把"要不要记"推给一个**当时还没有信息**的人——他要在什么都没发生时预判以后会不会需要。默认开把决定挪到有信息的一侧（明知敏感才去关），并配了不对称判定（认不出的值一律当关）与开服时的孤儿目录回收。

**体量上界**（不设 pruner，所以要能估）：
- ⚠️ 输入侧**没有统一上限**——1 MiB 只约束 `message_file`（`:5141`），inline `message` / `initial_prompt` 不受它管。所以 viz 自设 `AGENT_BRIDGE_VIZ_INPUT_MAX_MB`（默认 4），超限截断并在文件尾标注。
  ⚠️ **截断必须进契约**：`turn:started` 带 `inputTruncated` / `inputOriginalBytes`，UI 显示「已截断（原始 12.3 MB / 保存 4 MB）」。否则"复制输入原文"会把截断件当原文交出去。
- 输出侧刻意不套 `clampText` 的 40 万字，所以**单轮正文可以超过 40 万字**。
- 常见场景个位数 MB；随 run 结束一次性消失。

**隐私口径**（写进 SKILL.md）：见 §4.3——对已 close 的会话 viz 留得**更久**。另外这与"内容是否出境"无关：**cursor 的内容本来就进 Cursor 云且无 delete-chat**、**kimi 的推理走 Moonshot 云 API**。

---

## 11. 范围：v0 砍掉了什么，为什么

**用户拍板砍到 v0。** 判据不是"能不能做"，而是**回看原始需求**：你要的是「看有哪些 agent、谁还活着、每轮的输入输出、按轮次区分」。下面四项**都是我自己加的，不在你的需求里**。

| 砍掉 | 理由 |
|---|---|
| **`turn:activity` 过程条目 + 五后端 extractor** | 整份清单里唯一"× 5 且每份都要读懂后端事件语义"的项，约占总工程量 30%。而**最有诊断价值的部分（改了哪些文件、跑了什么命令、退出码）恰恰最可能降级成"调用了 Bash"**——五后端没有统一的结构化来源。想知道"它到底动了什么"，§7.2 的逃生门本来就指向完整诊断日志。**顺带：砍掉它，§5.3 那句"transcript 永远只增长有界骨架"才真正成立**（activity 条数本来是无上限的）。 |
| **多 run 列表页 + `GET /runs` + tmpdir 扫描** | UI 文档自己写着"常见情况只有 1 条"、"只有一个 run 时应该直接进详情页"。而 §10 已经确立主路径不靠扫描。砍掉后同时消失：一整个页面的设计与实现、viewer 去翻别人 tmpdir 的行为（顺带缩小暴露面）、run 级汇总统计的需求。 |
| **`/file?ref=&offset=&limit=` 分段读协议** | "不持长句柄"只需要把 `createReadStream` 换成短开短关，不需要分段协议。真正超过几 MB 的正文是极端情况，截断 + 给出文件绝对路径就够。分段协议的成本（服务端 + 前端"继续加载"交互 + 边界 bug）不成比例。 |
| **`turn:rejected` 事件** | attempt 机制**必须留**（它解决幽灵轮次这个真问题），但把拒绝**做成面向用户的事件**价值很低——空 prompt / busy session / spawn 失败，主 agent 当场就以异常收到了，页面上多一条红条目只是噪音。内部丢弃即可，少一个事件类型、少一格 UI 态、少一行验收。 |

**缩水两项**：进度尾巴 2000 → 400 字（配 `generation` 徽章，表达力更强、体量降 5 倍）；结算覆盖矩阵从**正确性前提**降为**质量目标**（靠 §3.1 的 poller 兜底）。

**一条都不砍的**：两阶段 turn 协议、随机临时目录 + 四道删除、白名单纪律、单 writer + 保序、`bodyKind` 三档诚实标注、绑回环、`AGENT_BRIDGE_VIZ=off`。

**砍完仍然回答得了**：拉起了哪些（含启动失败的）、谁还活着（四档 + 权限三档）、每轮问了什么答了什么（逐字节原件、按轮次分）、正在跑的那轮在写什么（400 字尾巴 + generation）、哪轮没人来取。

**被砍的都是纯增量**：事件表不变、UI 版面不变——加一个 extractor 加一类条目，v1 随时能补，不推翻任何结构。

### 被否决的方案

- **X1 不改桥、页面直接读 `logs/`**：内容不完整、不一致、无轮次真源。做不出任何一条完整形态。
- **X2 主 agent 手写事件**（圆桌/loop 模式）：靠纪律会忘、花 token、**它手上没有全文**、流式过程看不见。
- **X3 读各后端自己的历史**（`~/.claude/projects/`、`~/.codex/sessions/`、kimi 本地、cursor 云端）：五种格式各自演进、cursor 读不到、**无法与桥的 `sessionId` 关联**、缺全部桥视角元信息。可作详情页外链。
- **X4 桥内常驻 HTTP / 给 core 加 viz 子命令**：见 §10。
- **X5 持久化到 `~/.agent-bridge/history/` 保留 7 天**：用户否决。临时目录去掉了整个 pruner 组件。
- **X6 固定路径**：多客户端同时在线是常态，会互踩；可预测的共享临时路径是被抢先占位的入口。
- **X7 随机目录 + 固定名索引文件**：索引文件本身就是固定路径的持久残留。
- **X8 正文边流边追加**：§6.1，不变式不成立。
- **X9 OMP 终态多发一次 RPC**：§6.2，会杀掉健康会话。

---

## 12. 施工清单（v0，9 项）

| # | 改动 | 位置 | 依赖 |
|---|---|---|---|
| 1 | viz writer 模块（`mkdtemp` + `meta.json`/`owner` + run 级串行 appender + `seq` + 半行安全 + 有界写队列 + `AGENT_BRIDGE_VIZ` 开关 + 全局 error 300 字硬顶） | 新增内部模块 | — |
| 2 | 幂等 `vizCleanup()` 挂三处（`cleanupAndExit` `:5920` / 同步 `exit` handler `:5971` / 顶层 `runCli().catch` `:6000`）；`cleanup` CLI 加 viz 孤儿回收（含 ownerless 60 s 宽限、owner 记 pid+起始时间） | `:5920`/`:5971`/`:6000`/`cleanup` | 1 |
| 3 | `run:started` / `run:terminated` / `session:opened` / `session:openFailed`(`{...summary(),error}`) / `session:status`(含 `contextUsage`，现场重算 `deriveHealth`) / **`session:closed` 挂 `session.close()` 类方法** | `serveMcp` / `openSession` / `setSessionStatus` / `session.close()` | 1 |
| 4 | **两阶段 turn 协议**（§3.3）：外层建 attempt；五后端在 accept 边界调 `vizTurnAccepted()` 分配 `turnNo`+绑 `turnId`+**异步**落盘输入+发 `turn:started`；失败内部丢弃并标 `orphaned` 待认领 | 两个 `send()` 点 + 五后端 accept 边界 | 1 |
| 5 | **结算双层**：五后端精确 hook（抓正文 + 准确 outcome）+ **`sessionSettled()` 通用兜底 poller**（骑在进度 tick 上）；幂等去重按 `(sessionId, turnNo)`，`turnNo` 一律取自 ledger | 五后端 + poller | 4 |
| 6 | 正文落盘：各后端 canonical 源（§6.2；Codex 三级 fallback；**OMP 宽限 + 无 RPC + `partial` 降级**）+ `bodyKind` 判定 + 同步抓串 → 队列写 → 才发事件 | 五后端 | 5 |
| 7 | 进度 sidecar（400 字尾巴 + `generation` + `seq`，**覆盖写不用 rename**，结算后删除） | 五后端流式回调 | 4 |
| 8 | `turn:collected`（§5.4 口径）+ `vizDir` 进 `status`/`open_session` 返回值 | `buildSessionResult` 调用方 + 两个工具 | 4 |
| 9 | **`docs/STATE-session-viz.md`**（v5：唯一 wire 真理源，取代原来的 `EVENTS.md`，含传输章）+ **`contract-invariants.mjs`**（第二实现，不 import 生产端）+ `viz/serve.mjs`（**v5：基线换成 graph 那份**，§9）+ `viz/index.html` + `viz/sample/` + `test-viz.mjs` + SKILL.md 一节 | `skills/agent-bridge/` | 1-8 |

**验收：**

- **turn 接受边界**：空 prompt / busy session / Codex `turn/start` 失败 / Claude 写 stdin 失败 / Cursor·Kimi spawn 失败 / **OMP prompt ACK 超时但后端仍在跑** —— 断言不产生幽灵 `turnNo`、不发 `turn:settled`；最后那条断言 orphaned attempt **被后到的结算认领回来**。`wait:true` 断言 `turn:started` 在轮次**开始**时发出。
- **终结兜底**：故意**不挂**某个后端的精确 hook，断言 poller 仍在 ~1 s 内补出 `turn:settled`（`bodyKind:none`）——**这是 §3.1 双层架构的直接证明**。
- **正文保真**：五后端各跑一轮含工具调用的任务，断言 `t<N>.out.md` 与 canonical 源逐字节相等。**OMP 专门造"`agent_end` 先于末条 `message_update` 到达"**，断言宽限救回尾部；再造一次宽限内进了新子轮，断言标 `partial` 而不是冒充 `final`。
- **不干扰（约束 3 的直接回归）**：`repro-*` 全套全绿（尤其 `repro-log-bounds`）；**专项断言 viz 开启后 OMP 的 `unresponsiveSince` / `dead` / `status` 与关闭时逐字段一致**（X9 那条 BLOCKER 的守门测试）；20 个并发流式会话 + Defender 开启，对比 `VIZ=on/off` 的 MCP p95/p99 延迟。
  ⚠️ **v5 更正：p95/p99 那条只能当信息输出，不能当门禁。** 不设阈值的"对比"永远绿（等于没验），
  设了阈值又会被 Defender 与机器负载支配（随机红）——**两头都不成立**。
  真正的机器门禁见 `PLAN §9 S4`：对五个后端**逐一**注入四类写入的 `throw`/`reject`/queue-full/**永不 resolve**，
  断言 MCP 返回值、`outcome`、`status`、后端健康字段、退出码与 `VIZ=off` **逐字段一致**。
- **进度不骗人**：造一次"`turn:settled` 先到、迟到的 progress 后到"，断言页面**不会**把已完成轮次打回"正在生成"；造一次 sidecar 写失败，断言页面标 degraded 而不是显示"卡住"。
- **零消耗回归** `test-viz.mjs`：喂样例 transcript → 断言多轮分离、四档存活、`outcome`×`bodyKind` 各组合、未收口标注、空态、`run:gone` 态。
- `AGENT_BRIDGE_VIZ=off`（以及任何认不出的值）后 `tmpdir` 里一个 `agent-bridge-viz-*` 都不产生；
  **未设时必须产生**（07-31 起那才是默认路径）。

---

## 13. 复审记录

三轮，两个引擎。主 agent 抽查了全部 BLOCKER 与关键 MAJOR 的源码行号，逐条成立。

**第一轮 codex（CHANGES-REQUIRED）** —— 3 BLOCKER + 10 MAJOR：五后端流形态表错了四个（append-only 前缀模型作废）；终结侧不存在单一漏斗（六类绕过路径）；`turn:outputReset` 与 `/file?from=` 无版本关联会跨通道拼接数据。其余：`turn:collected` 会误报、现状描述过强、`answerFile` 生命周期与隐私论证说反、第四条删除路径 + ownerless 宽限、孤儿清理不能进 MCP 热路径、`appendLog` 类推不成立、白名单不能复用 `redactForLog`、输入无统一上限、UI 的"只读"制造错误安全感、不该加 CLI 子命令。

**第二轮 codex 复评 v2（CHANGES-REQUIRED）** —— 确认结构方向正确；2 BLOCKER + 8 MAJOR 全在边界：OMP canonical 源拿不到（`message_update` 独立队列 + `agent_end` 可能先到）；`turnNo`/`turnId` 与"turn 真正被接受"的边界未闭合（幽灵轮次）；Codex canonical 要三级 fallback；`outcome` 映射太宽；非成功轮次正文契约与 UI 矛盾（→ `bodyKind`）；"每轮一个 writer"与单 appender 冲突；**`turn:progress` 追加进 transcript ≈ 360 万字符/轮**；第四道回收不完整；整文件读/懒加载/不持句柄三者不能同时成立；UI 的"字数持续增长可判卡住"不准确。

**第三轮 claude 交叉复审 v3（CHANGES-REQUIRED）** —— 逐条抽查了前两轮结论，**没找到错的**；补上了前两轮没覆盖的视角：

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **v3 给 OMP 开的那次 RPC 会经 `request()` 的 unresponsive 计数器触发 `#markUnresponsive()` → `terminateProcessTree`——viz 能杀掉健康会话** | §6.2 撤销破例、§8.2 恢复无例外 |
| MAJOR | **"逐条枚举终结路径"这个方法本身不可靠**——同一份文档已漏一条（`session:closed` 挂错函数） | §3.1 双层架构 |
| MAJOR | accept 边界上的同步落盘在 stdout 热路径里（Codex `#beginTurn` 可从 readline 回调进） | §3.3 纪律 1 |
| MAJOR | attempt 有第三态（OMP ack 超时 ≠ 后端没接受） | §3.3 纪律 2 |
| MAJOR | sidecar 的**原子写反而**在 Windows 上制造竞态 → 进度停更 → 页面把健康会话报成卡住 | §5.3 决定 3 |
| MAJOR | progress 与 transcript 无序，迟到的 progress 会把已完成轮次**打回"正在生成"** | §5.3 决定 4 |
| MAJOR | `error` 是唯一无上限的机器内容通道（codex 4000 字符原始 JSON） | §5.2 硬顶 300 |
| MAJOR | `session:openFailed` 缺 sessionId，填不满 UI 的会话卡片 | §5.2 用 `summary()` |
| MAJOR | `contextUsage` 只在结算里，而 UI 要的是会话级常驻 | §5.2 挂 `session:status` |
| MAJOR | sidecar 缺 `generation`，UI 最难那节没有数据支撑 | §5.3 决定 2 |
| MINOR | `turnNo` 与 `turnCount` 分叉、accept 前的早期流、sidecar 清理二义 | §5.2 / §3.3 / §5.3 |
| — | **质疑范围本身**：指出"没有更简单且同样完整的路线"是同义反复（"完整"把结论塞进了前提） | §11 砍到 v0 |

三轮都确认成立的：随机临时目录、单 writer、正文不回灌诊断日志、viewer 绑回环、prompt 只有两个入口、`setSessionStatus` 是状态唯一漏斗、`ownerStillRunning` 不会误删活目录、Cursor/Kimi 轮间无进程但健康可复用、`contextUsage` 在两者恒 `null`、`turn:collected` 新口径可实施、正文不设 40 万字上限符合约束 2。

**第四轮 codex（2026-07-29，v4 → v5）—— 换了输入：不再在文档内部找矛盾，而是拿 07-28~29 建成的 graph 观测台回头对。**
本文被改的六处见文首。其中三条不是"想深了一层"，是**被已建成系统的实测结果直接推翻**：

| 发现 | 证据 | 修在 |
|---|---|---|
| "无客户端满十分钟自灭"会让**提前起、晚点看**的 viewer 半途消失 | graph 的 `armGrace()` 明令禁止这条兜底，注释写的就是这个失效场景 | §9 |
| 服务端基线选了**本文自己点名要修的那个病人**（圆桌版持长句柄） | graph 那份已经改好并过真后端 e2e，还多了内容对证 | §9 |
| "全程 try/catch 吞错"会把**形状非法**变成**静默的记录丢失** | graph 上的同款事故，见 `docs/DRIFT-events-contract-vs-producer-2026-07-28.md` | §8.1 |

另三条是内部口径不同步（§4.3/§10 没跟上默认开关的翻转、§8.6 的 `degraded` 第二副本）
与验收方法错误（§12 的 p95/p99 既能假绿也能假红）。**详细清单与 PLAN 侧的 9 条见 `PLAN §10` 第七轮。**
