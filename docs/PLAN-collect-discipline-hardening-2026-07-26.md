# 收口纪律加固（consumer 忘记 `wait` 的根治）

状态：**待实施（v3，已过两轮施工说明书复审，裁决 APPROVE WITH CHANGES 且必改项已全部落入）**。日期 2026-07-26。作者：主 agent（Claude Opus 5）。

复核链：
1. **诊断复核**（codex xhigh 只读，14.5k 字）：纠正主 agent 4 处事实错误、补出 5 条遗漏根因。
2. **施工说明书复审 R1**（codex xhigh 只读，13.5k 字）：判 **NEEDS WORK**，10 个 blocker → v2 逐条闭合。
3. **施工说明书复审 R2**（codex xhigh 只读）：判 **APPROVE WITH CHANGES**——R1 的 10 项判定为 4 CLOSED / 6 PARTIAL，另给 5 条可直接落地的终稿措辞 + 5 项遗漏 → **v3 全部落入**。见 §8。
4. 文档内每条断言均由主 agent 用 `grep -n` 二次坐实（含对两轮复审结论本身的复核——每个 blocker 都实查过才接受；R2 指出的 `cleanupSessions` 路径、OMP `isSettled` 语义、`repro-turnstate` 假绿、`e2e-real` 的 finally、`slowturn`=2500ms、`BRIDGE_VERSION`=0.9.0 均已实证）。

> **本文档是给实施 agent 的施工说明书。** 读完应当不需要再做调研就能动手。
> **只改本文列出的东西。** 每条变更都写了"不要做什么"，那些是复核里被明确否掉的方案。

---

## 0. 五条施工纪律（先读，避免踩已知的坑）

1. **本文一律用「符号 / 可复现检索串」定位，不写行号。** 编辑过程中行号会漂移；且本仓有过工具行号偏移的实例（主 agent 首轮用检索工具拿到的 `scripts/agent-bridge.mjs` 行号在 ~1200 行之后**系统性少 3**，被复核纠正）。**每次定位都重新 `grep -n`。**
2. **`docs/repro-mcp-hang/repro-kimi.mjs` 含 NUL 字节**，`grep` 会判定 binary 并跳过。查它必须加 `-a`。（本仓在 NUL 字节上踩过两次。）建议**所有** grep 都带 `-a`。
3. **`docs/repro-mcp-hang/probe-doctor-timeout.mjs` 是既有的红**，与本次无关。不要修，也不要因此判定自己改坏了。
4. **警惕"唯一 / 全部 / 唯二"这类断言。** v1 说明书在四处这样的断言上出错（唯一漏斗、唯二调用点、五后端同语义、graph 收尾顺序）。本文已改为给**可复现的扫描命令**而不是写死清单——施工时请**重跑那些命令**，不要信任本文的枚举结果。
5. **本次有两条既有回归测试的合同会被改变**（`repro-cursor` S12、`repro-kimi` S10/S25）。它们不是被你改坏的，是 C6 的必然后果，见 C6。

---

## 1. 前因

### 1.1 用户观察到的现象

> 「为什么现在 agent 使用 agent-bridge 的时候经常会忘记使用等待结果返回」

即：各 MCP host 里的主 agent 用 agent-bridge 派活时，`agent_bridge_send_message`（默认非阻塞）拿到 ack 后**不收口**——不调 `agent_bridge_wait`，直接往下走或直接 `close_session`，那一轮产出被丢弃或被半成品冒充。

### 1.2 第一反应（被证伪）

「提示词没写」不成立：

- `skills/agent-bridge/SKILL.md` 里 22 行含 `wait`（子串 31 次）：TL;DR 流程、标准工作流三步含循环、并行收口、工具速查、典型场景都写了。
- `agent-bridge-dev` / `-roundtable` / `-loop` 三个 skill 各自在开头重申收口纪律。
- 稳定安装 clone（`C:\Users\leo.wang\tools\agent-bridge`）与开发 clone 的主 skill **SHA-256 一致**（dev/loop 亦字节一致；roundtable 文本一致、仅 LF/CRLF 差异）——不是版本落后。

### 1.3 真正的根因

**问题不在"没写"，在"写在会掉的那份里，而桥本体在 agent 做决定的那一刻不提醒"。**

| # | 根因 | 性质 |
|---|---|---|
| R1 | **ack 没有"结果尚未交付"的语义**。六处非阻塞返回都是 `{accepted, sessionId, status, turnId}`。`accepted:true` 读起来像"这件事成了"；`status` 虽在（常规是 `"running"`）但**不等价于"结果已交付给调用方"**，且极快完成/失败时 `status` 会是 `idle`/`failed` 却**仍然只返回 ack**。 | 机制 |
| R2 | **桥没有任何主动唤醒机制，而 agent 的先验恰好相反**。MCP server 只声明 `capabilities:{tools:{}}`，只对请求写 `rpcResult/rpcError`，没有 progress / logging / task-completion notification。而在 Claude Code 这类宿主里，**在飞的**长工具调用超时会被转后台 + 事后通知（本次讨论实测：多次 `wait(300000)` 全部在 ~120s 被转后台并通过 task-notification 唤醒主 agent）。于是"长调用会自己回来找我"这个**被真实经验反复强化的正确直觉**，泛化到"桥会回来找我"时**恰好是错的**——通知的前提是**有一个 wait 在飞**；没 wait 就没通知，主 agent 的回合一结束，那轮产出就无人接收。 | 机制 + 认知 |
| R3 | **`send_message.timeout_ms` 在默认 `wait:false` 下是静默无效参数**。schema 允许传、dispatcher 也照传给后端，但各后端只在 `if (options.wait)` 分支里读它。消费方发 `{wait:false, timeout_ms:300000}` 很可能**以为自己安排了"五分钟后收结果"**，实际只拿到 ack，之后什么都不会自动发生。**这是"忘记收口"最具体、最可信的误解模型。** | 机制 |
| R4 | **收口义务从未被写成禁令**。唯一的规范清单「安全规则」里有"完成后一定要 `close_session`"，**没有**"必须先收口"。全文 7 个 ⚠️ 里只有 2 个与 wait 有关，且这两个恰好都是**"别怎么等"**（必须传 `timeout_ms`、别传 `wait:true`），没有一个是"必须收"。 | 文档 |
| R5 | **唯一常驻上下文的那份（MCP tool schema）写得最弱**。skill 只在触发时加载、frontmatter description 里根本没提 wait——不支持 skill、没触发 skill、或只加载 metadata 的宿主，看到的只有弱 schema。而 `wait` 的 description 没写超时返回形状、没写超时不中断 turn、没写必须续等、没写默认 30 分钟。 | 文档 |
| R6 | **`close_session` 没有 running guard，且会摧毁证据**：`closeOne` 无条件 `session.close()`；OMP 的 close 做 `terminateProcessTree(pid)` + `fs.rmSync(this.answerFile)`。而文档只强调"完成后一定 close"，没有"close 前必须证明无未收集 turn"。**这把可恢复的遗漏变成永久丢失。** | 机制（后果最重） |
| R7 | **`open_session(initial_prompt)` 是更隐蔽的 ack 路径**：返回 `{session:{…}, initial:{accepted:true,…}}`。外层调用成功、对象又很完整，极易被当成"开会话并完成首轮"；而 open 的工具描述**完全没警告首轮默认异步**。 | 机制（隐蔽性最高） |
| R8 | **"已经 wait 过一次"也会半途而废**：timeout 返回和 `mode:"any"` 成功返回**都把剩余 id 放进 `pending`，都没有任何"必须继续"的信号**。所以"忘记收口"实际包含"wait 了一次、把正常返回误当全部完成"。 | 机制（扩大了问题定义） |

**另一条污染面**：中途 `result` 的半成品比想象的更像真货——结果构造函数不检查 settled 就包装传入文本（五个后端都各自维护实时 buffer）；`textRef` 在 running 时指向片段，但 schema 与 SKILL.md 都称它"完整未截断全文"；structured-output turn 跑一半时会**立刻 `JSON.parse` 半截 JSON**，产出 `schemaError` 却没有 partial 标记，容易被当成最终失败。完成状态只藏在 `session.status`，顶层没有任何完成度字段。

### 1.4 一条反向印证（经验推断，非仓内可证）

凡是把收口**固化进代码或逐步骤模板**的地方就没人忘：`skills/agent-bridge-graph/tools/node-core.mjs` 校验 ack 后进入短切片 wait 循环、总预算耗尽才 abort；loop/roundtable 在流程里写死 `wait(mode:"any", timeout_ms:300000)`。遗忘只发生在**裸用 agent-bridge skill、靠自觉**的场景。**注意：仓库不能证明真实遗忘率为零，这只是观察。**

---

## 2. 设计原则

1. **把"推荐用法"变成"默认行为"。** 现在的默认（`mode:"all"` + 30 分钟）恰好都不是 skill 推荐的（`mode:"any"` + 短超时）。改完后一个裸 `wait({session_ids})` 就是推荐调用。
2. **提示要落在决策点上。** 工具返回值**更靠近**决策点，通常比远端 skill 文档更可靠。（不要写成"绝不会被压缩"——桥无法保证所有宿主永不压缩旧 tool result，这不是仓内可证事实。）
3. **说"你必须"，不说"建议你"。** `nextStep` 这类命名像建议、可被模型跳过；用 `mustCollectResult` 这种带义务语义的名字 + 结构化的下一步调用参数。
4. **诚实标注状态，而不是拒绝提供数据。** 中途 `result` 不该被禁，该被标注。
5. **不为省 token 缩水提示，但也不塞散文。** 结构化字段几十 token 即可，别在返回里附整段 warning prose。
6. **装饰器绝不能说谎。** v1 最严重的设计错误就是让一个装饰器同时描述"纯 ack"和"已带部分结果的 wait 返回"——后者顶层写 `resultIncluded:false` 是假话。**每个字段在它出现的每一条路径上都必须为真。**

---

## 3. 变更清单

**C2 / C3 是用户点名追加的需求，目标值不可改动**；本文只负责让它们安全落地。

### C1（P0）ack 与未完成收集加"必须收口"信号

**为什么**：R1 + R7 + R8。这是唯一落在决策点上的修法。

#### C1.1 两个装饰器，不是一个

**这是 v1 被否掉的设计。** ack 与 wait 返回的语义**不同**：ack 里确实什么结果都没有；而 `wait` 的 `mode:"any"` 返回带着 `completed`、超时返回带着 `settled[]`——**那里已经交付了结果**，顶层再写 `resultIncluded:false` 是假话。

放在结果构造函数附近，新增两个：

```js
// A non-blocking ack means "the turn was accepted", NOT "you have its result". Say so in the tool
// result itself: it sits at the decision point, unlike the skill doc which may not even be loaded.
// `resultIncluded:false` is honest for BOTH ack cases — the turn is still running, AND the fast-settle
// branch where the result exists but was not delivered in this payload.
function decorateUncollectedAck(payload, sessionIds) {
  return {
    ...payload,
    resultIncluded: false,
    mustCollectResult: true,
    requiredAction: {
      tool: "agent_bridge_wait",
      arguments: { session_ids: sessionIds },
      repeatWhile: "the response still has a non-empty pending[]",
    },
  };
}

// A wait response that leaves ids in `pending` DID deliver results for the others (completed / settled[]),
// so it must NOT claim resultIncluded:false. It only claims the COLLECTION is unfinished. `mode` is echoed
// into the retry arguments on purpose: a caller who asked for mode:"all" must not be handed bare arguments
// that silently mean mode:"any" (the new default).
function decorateIncompleteCollection(payload, pendingIds, mode) {
  return {
    ...payload,
    collectionComplete: false,
    mustCollectResult: true,
    requiredAction: {
      tool: "agent_bridge_wait",
      arguments: { session_ids: pendingIds, mode },
      repeatWhile: "the response still has a non-empty pending[]",
    },
  };
}
```

#### C1.2 调用点与精确条件

| 位置（符号） | 用哪个装饰器 | 条件（**必须完整照抄**） |
|---|---|---|
| `sendMessage()` 的返回 | `decorateUncollectedAck(ack, [session.id])` | `!params.wait && ack?.accepted === true` |
| `openSession()` 的返回 | `decorateUncollectedAck(out, [session.id])`，**装饰外层** | `params.initial_prompt && !params.wait && initial?.accepted === true` |
| `waitSessions()` 的 `mode:"any"` 返回 | `decorateIncompleteCollection(payload, pending, mode)` | `pending.length > 0` |
| `waitSessions()` 的超时返回 | `decorateIncompleteCollection(payload, pending, mode)` | `pending.length > 0` |

`openSession` 的返回形状写死为（**只装饰外层，`initial` 不重复携带**）：

```js
const out = { session: session.summary(), initial };
if (params.initial_prompt && !params.wait && initial?.accepted === true) {
  return decorateUncollectedAck(out, [session.id]);
}
return out;
```

**不要**装饰：`wait:true` 已内联返回结果的路径、`accepted:false` 分支（codex `send` 里 abort/close 抢跑那条 —— 这就是为什么条件里必须有 `accepted === true`，v1 的表格漏了它，照写会违反同文的禁令）、`mode:"all"` 全部完成的 `{mode, results}`、`result()` 的终态返回。

#### C1.3 三个必须理解的语义点

1. **`repeatWhile` 的条件只能是 `pending.length > 0`，绝不能是 `timedOut:true`。**
   超时分支可以合法地返回 `{ timedOut:true, settled:[…全部…], pending:[] }`——deadline 已过但所有候选二次确认后都已终态。而 `waitSessions` 开头就是"`session_ids` 非空"的硬校验（`throw new Error("session_ids is required …")`），**照着 `timedOut` 续等会把空数组传进去直接报错。** C1/C4/C7 里所有"timedOut 就必须再等"的表述都必须写成"pending 非空才继续"。
2. **六处 ack 里有一处的结果其实已经 ready。** codex 后端有一条"turn 在 `turn/start` continuation 恢复前就已结算"的快速分支。那里结果**已生成、只是没放进 ack**。所以字段名必须是 `resultIncluded:false` / `mustCollectResult:true`（"你还没拿到"），**不能**叫 `resultPending`（"还在跑"）——后者在这一处是假话。
3. **ack 的 `requiredAction.arguments` 只带 `session_ids`；wait 的必须additionally带 `mode`。** ack 没有"调用方原本的 mode"这个概念，且 C2/C3 后省略即推荐值；而 wait 的调用方可能显式传了 `mode:"all"`，把裸参数回显给他会**静默改变语义与返回形状**。

#### C1.4 兼容性

用这条命令重新扫全部消费方（**不要信任任何写死的清单**）：

```bash
rg -l -a "agent_bridge_(open_session|send_message|wait|result)" . --glob "*.mjs" --glob "*.js"
```

已知结论（v2 复核后）：

- 仓内**没有 `tests/` 目录**；测试主要是 `docs/repro-mcp-hang/*.mjs`，但**不止**——另有 `skills/agent-bridge-loop/viz/test-viz.mjs`（它只解析 transcript event，不消费 MCP 返回，本次**无需跑**）。
- **全量扫描未发现按精确 key 集 / key-count 解析返回的消费方**：repro 系列只断言 `accepted === true` 或个别字段；`repro-wait-shape.mjs` 明确写了 "Subset check on purpose (not exact key-count)"；graph 按字段名读取。
- 该文件的 `FORBIDDEN` 只禁 `session` 与 `recentEvents` 出现在 wait 顶层（上下文卫生）。新字段必须**轻**。
- 所有 `additionalProperties:false` 都在**输入** schema；当前工具**没有 `outputSchema`**。
- 残余风险无法从本仓排除：仓外若有严格 DTO / 快照测试。JSON 增加可选字段通常低风险。

---

### C2（P0，用户追加，**破坏性**）`agent_bridge_wait` 的 `mode` 默认 `all` → `any`

**为什么**：`mode:"any"` 是 skill 一直推荐的值，却不是默认值。改完后默认=推荐；且 `any` 的返回形状**天然带 `pending`**，正好是 C1 挂 `requiredAction` 的位置——两条变更相互增强。

**改哪里**（两处必须同改）：

1. 运行时：`waitSessions` 里 `const mode = params.mode === "any" ? "any" : "all";` → **反转为** `params.mode === "all" ? "all" : "any"`。保持"未知值 → 默认值"的既有语气（现在任何非 `"any"` 落到 `all`，改后任何非 `"all"` 落到 `any`）。
2. schema：`agent_bridge_wait` 的 `mode` 属性 `default: "all"` → `"any"`，description 同步（见 C4）。

#### ⚠️ C2 的陷阱：这是**返回形状**的破坏性变更

| | 改前（默认 all） | 改后（默认 any） |
|---|---|---|
| 顶层 | `{ mode, results }` | `{ mode, completed, pending, pendingSnapshots }` |
| 取结果 | `results[0].text` | `completed.text` |

**单会话时尤其隐蔽**：只有一个 session 时 `any` 与 `all` 的**返回时机几乎一样**，差别**纯在形状**。任何"省略 mode + 读 `results[0]`"的消费方会静默拿到 `undefined`。

**缓解**：三个返回点**都已回显 `mode` 字段**，消费方可据此判别形状。这是既有设计，别删。

**受影响的调用点**——用这条命令重扫，不要信任枚举：

```bash
rg -n -a "agent_bridge_wait" . --glob "*.mjs" --glob "*.js" | rg -v "mode:"
```

当前结果：**唯二的现有可执行调用**省略了 `mode`——`repro-kill.mjs`、`repro-pipebreak.mjs`。两者都只断言"调用是否按时返回"（`resp === undefined` 判 hang），**不读返回形状**，所以形状翻转不会让它们变红。**但仍必须处理：把这两处显式写成 `mode:"all"`**，让它们继续覆盖原路径；`any` 路径交给新测试与既有 `repro-waitany.mjs`。

> 注意措辞：这是"唯二现有**可执行**调用"，不是"仓内唯二调用点"——`.md` 里还有依赖默认值的示例（包括本文自己的 `wait({session_ids})`）。

---

### C3（P0，用户追加）`agent_bridge_wait` 省略 `timeout_ms` 时的默认：30 分钟 → 10 分钟

**为什么**：R4/R5 的副作用是 skill 不得不反复喊"必须传 `timeout_ms`，不传死等 30 分钟"。默认改成合理短值后，"不传"从陷阱变成正常用法。

#### ⚠️ C3 的陷阱：**绝对不能直接改 `DEFAULT_WAIT_TIMEOUT_MS`**

```bash
rg -n -a "DEFAULT_WAIT_TIMEOUT_MS" scripts/agent-bridge.mjs
```

**7 个文本命中 = 1 个声明 + 6 个读取点。** 6 个读取点里只有 **1 个**是本次要改的：

| 读取点（符号） | 语义 | 本次是否改 |
|---|---|---|
| `waitSessions` 里 `parseNumber(params.timeout_ms, DEFAULT_WAIT_TIMEOUT_MS)` | `wait` 工具省略 `timeout_ms` | ✅ **只改这一个** |
| OMP `send`：`await this.waitIdle(options.timeout_ms \|\| DEFAULT_WAIT_TIMEOUT_MS)` | `wait:true` 内联阻塞 | ❌ |
| codex `send` 里 `options.timeout_ms \|\| DEFAULT_WAIT_TIMEOUT_MS`（`"Timed out waiting for Codex turn."`） | 同上 | ❌ |
| claude（`"Timed out waiting for Claude turn."`） | 同上 | ❌ |
| cursor（`"Timed out waiting for Cursor turn."`） | 同上 | ❌ |
| kimi（`"Timed out waiting for Kimi turn."`） | 同上 | ❌ |

**为什么后五个不能一起改**：那五条是 `wait:true` 的内联阻塞路径，**超时都会进入破坏性的 abort / interrupt / tree-kill 路径**，turn 不再保证可供后续 wait。把它们从 30 分钟砍到 10 分钟，等于**开始摧毁合法的长 turn**。

> **精确措辞（v1 在此写强了）**：五条路径超时都会**触发** abort，但**远端是否真的停止是 best-effort**——OMP 吞掉 abort 错误；codex 的 `turn/interrupt` 错误被吞后只清本地 `this.turn`；claude 在 control interrupt 或终态结果不到时会 fallback 本地强制 settle；cursor/kimi 是 tree-kill，settle 不到时把会话 poison 成 `failed`。所以正确表述是"**进入破坏性 abort 路径，turn 不再可供后续收口；远端停止为 best-effort**"，不是"保证已 abort"。
>
> **实测证据**：本次两轮复核的 codex turn 分别跑了 `durationMs: 933671`（≈15.6 分钟）与 `972985`（≈16.2 分钟）。在现行 30 分钟内联默认下安然完成；若内联默认被砍到 10 分钟，两轮都会被中途摧毁。

**正确做法**：新增独立常量，只给 `waitSessions` 用。

```js
// The `wait` TOOL's default join window when the caller omits timeout_ms. Deliberately SHORT and
// deliberately NOT DEFAULT_WAIT_TIMEOUT_MS: a wait-tool timeout is NON-destructive (it returns
// {timedOut, settled, pending} and leaves the turn running), whereas the wait:true INLINE paths that
// read DEFAULT_WAIT_TIMEOUT_MS enter a destructive abort/interrupt/tree-kill path on timeout —
// shortening those would destroy legitimately long turns (real cross-review turns in this repo ran
// 15.6 and 16.2 minutes). Keep the two clocks separate.
const DEFAULT_JOIN_TIMEOUT_MS = envNum("AGENT_BRIDGE_JOIN_TIMEOUT_MS", 10 * 60 * 1000);
```

- 放在 `DEFAULT_WAIT_TIMEOUT_MS` 紧邻处，并给后者补一行注释指向前者（说明两个时钟为何不同）。
- **走 `envNum`**（仓内既有惯例）。这不只是灵活性：**C3 的测试需要它**——没人能在 hermetic 测试里等 10 分钟，测试靠 `AGENT_BRIDGE_JOIN_TIMEOUT_MS=800` 把默认压到亚秒。
- **补输入边界，但只对本常量做，不要全局收紧 `envNum()`**：`envNum` 只处理"空白/非数值 → 回退默认 + stderr 警告"，**接受负数、0、小数**。本常量是 duration，必须明确：拒绝负数与非安全整数（回退默认并警告），`0` 的语义要么明确定义为"立即超时"要么一并拒绝——**在实现里写死，不要留给读者猜**，并为负数/小数/0 各加一个 stderr 断言测试。
  > ⚠️ **绝不要为此改 `envNum()` 本身**：仓内其它 env 明确把 `0` 当"关闭该功能"（见 `envByteCap` 的 `0` 语义与相关注释），全局收紧会改掉它们的行为。校验只加在 `AGENT_BRIDGE_JOIN_TIMEOUT_MS` 这一处。
- **把 schema 的 `timeout_ms.default` 设成实际的 `DEFAULT_JOIN_TIMEOUT_MS` 值**，这样 `tools/list` 就能被断言（见 §4 测试 T2/T3）——否则测试只能证明 env 覆盖生效，证明不了默认值真是 600000。

**连带文档修正**：见 C7.4 的全量 grep 清单（不止四个 skill）。

---

### C4（P0）修 MCP tool schema 文案

**为什么**：R5。覆盖"不加载 skill 的宿主"的唯一手段，成本最低。

1. **`agent_bridge_open_session` 顶层 description** — 追加：带 `initial_prompt` 且不传 `wait` 时**首轮是异步的**，返回里的 `initial` 只是 ack，必须用 `agent_bridge_wait` 收口。
2. **`open_session.wait` / `.timeout_ms`** — 默认 `false` = 首轮不等；`timeout_ms` 仅在 `wait:true` 时生效。
3. **`send_message.timeout_ms`** — 当前只有 "Optional wait timeout in milliseconds."。必须写明：**`wait:false`（默认）时本参数被忽略**——桥不会因此在将来某刻把结果推给你；要限时收口请用 `agent_bridge_wait`。（R3，最具体的误解源。）
4. **`agent_bridge_wait` 顶层 description** — 补三件事：① 超时**不是失败、不中断 turn**，返回 `{timedOut, settled, pending, pendingSnapshots}`；② **`pending` 非空时必须再次调用**（把 `pending` 原样当下一轮 `session_ids`）——**不要写"timedOut 就必须再等"**，见 C1.3；③ 三种返回形状的差异。
5. **`agent_bridge_wait.timeout_ms` / `.mode`** — 写明新默认值（`timeout_ms` 默认 10 分钟、可用 `AGENT_BRIDGE_JOIN_TIMEOUT_MS` 覆盖，且 `default` 字段要如实暴露；`mode` 默认 `any`）与两种 mode 的返回形状。
6. **`agent_bridge_wait.session_ids`** — 当前写 "…pass only the still-running ids on each call"，**这是既有的错**：`mode:"any"` 的 `pending` 会包含**同一 poll tick 里已 settle 但尚未交付**的 id（代码注释自己说明了这点，且 `CONSUMER_FEEDBACK.md` 已登记此待办）。改为 "remaining / unreturned ids"。
7. **`agent_bridge_result` description** — 写明 turn **未结束**时返回的是**当前快照（部分文本）**，不是最终答案，判据是新增的状态字段。
   > ⚠️ **这一条必须与 C5 同批提交**，不能留在 B1——否则文案先告诉客户端去读一个还不存在的字段。

---

### C5（P1）`result` 标注 turn 完成度，且 running 时不产最终 `json`/`schemaError`

**为什么**：1.3 末尾那条污染面。中途快照现在长得跟终态一模一样。

#### C5.1 字段语义：**不要用 `complete`/`partial`**

v1 的方案（`complete`/`partial` 取自 `sessionSettled`）**语义是错的**：`sessionSettled` 把 `failed` / `closed` / **aborted** / never-prompted 全算 settled。尤其 codex `abort()` 的现有注释明确说后续 `result()` 可能返回 partial text，而 abort 后 `sessionSettled()` 已为 true —— 于是会得到 `complete:true, partial:false`，但正文其实是被中断的片段。**那是新的谎言，比没有字段更糟。**

**本轮采用**（诚实且能直接实现）：

```js
turnSettled: sessionSettled(session),
inProgress: !sessionSettled(session),   // 冗余但醒目，故意的
```

**字段语义（必须照此写进 schema 与 skill，不要自行改述）**：

> `turnSettled` 严格表示共享判定 `sessionSettled(session)` 当前是否会把该会话视为可交付；`inProgress` 是它的逻辑反值。二者**不表示** turn 成功、正文完整或远端进程确定停止。`session.summary().status` 仍表示生命周期状态，因此 `failed`/`closed` + `turnSettled:true` 是**合法组合**。OMP 的状态不一致场景也以该共享判定为准。

`sessionSettled` 在结果构造函数里**技术上可用**：它是后置 function declaration（JS 提升）、同步。

> ⚠️ **不要把它描述成"当前没有在途 turn"**——那写强了。OMP 的 `isSettled()` 是 `this.status === "idle" && !this.turnInFlight`，所以 `FAKE_OMP_MODE=turnstate` 能造出 `status:"running"` + `turnInFlight:false` 的组合，此时 `sessionSettled()` **仍为 false**，尽管没有在途 turn。它是**共享的 wait 可交付判定**，不是真实远端执行状态。定位：`function sessionSettled`、OMP 的 `isSettled()`、`repro-turnstate.mjs` 的 Phase 2。

**如果坚持要 `complete`/`partial`**，则必须先新增一个跨五后端统一的 `lastTurnOutcome`，至少区分 `completed / failed / aborted / running / none`——**不能只靠 settled**。那是更大的工程，本轮不做。

#### C5.2 各返回形状的语义必须写死

| 形状 | 是否经结果构造函数 | 标注 |
|---|---|---|
| `result()` 的返回 | 是 | 按当前 settled 状态标 |
| `send(wait:true)` 的返回 | 是 | 终态 |
| `wait` 的 `results[]` / `completed` / 超时的 `settled[]` | 是 | **都是经 `stable()` 二次确认的终态候选** → `turnSettled:true` |
| `wait` 的 `pendingSnapshots[]` | **否**（走独立的 `snapshot()`） | **不要机械继承这两个字段**；且 `pending` 不等于 still-running（见 C4.6），其 `status` 甚至可能是 `idle`/`failed` |

> v1 把这里写成"summarize 已终态或超时快照"是错的：`summarize()` 只处理终态候选；超时中的 pending 走独立 `snapshot()`。

#### C5.3 结果构造函数**不是唯一漏斗**

```bash
rg -n -a "buildSessionResult\(" scripts/agent-bridge.mjs
```

有 **6 个直接调用点**（OMP `result()` 的两个分支 + codex/claude/cursor/kimi 各一）。**还有两条绕过它的路径**：concurrent-close 的 `gone` 结果、`result()` 报错后的 `base` fallback。

**这两条不得选择性省略字段**（v2 留了"或明确它们不带"这个选择项，会直接违反 C5.2 与 T18——已删除该选项）：

```js
// gone（concurrent-close）
{ /* …既有字段… */ gone: true, turnSettled: true, inProgress: false }

// base（result() 报错后的 fallback）
const settledNow = sessionSettled(session);
const base = {
  /* …既有字段… */
  turnSettled: settledNow,
  inProgress: !settledNow,
};
```

由此 **`results[]`、`completed`、`settled[]` 的每个元素都携带这两个字段；只有 `pendingSnapshots[]` 明确不带。**

#### C5.4 structured output

running 时**不产** `json`/`schemaError`（现在会立刻 parse 半截 JSON），改为 `json: null` + `schemaPending: true`。

**不要做**：running 时**拒绝** `result`（除非显式 `allow_partial:true`）。中途快照本身有用（SKILL.md 主动推荐用它看进展）；诚实标注优于拒绝服务。

---

### C6（P1）**对在途 turn 默认拒绝关闭**（`force:true` 才允许）

> **标题已按复审改名。** v1 叫"对未收口默认拒绝"是**名不副实**：本方案只能拒绝"未终态"，**拒绝不了"已终态但结果从未被取走"**——快速完成后直接 close 仍会删掉未读结果。真正的"未收口"需要一个 collected 标志（由 `result()`/`waitSessions` 置位），侵入性更大，**不在本轮**。不要宣称本轮解决了 R6 的全部。

**改哪里（四处必须贯通，漏一处 `force` 就静默失效）**：

1. **schema**：`agent_bridge_close_session` 增加 `force: {type:"boolean", default:false}`，description 写明：关闭一个**仍在跑**的会话会**永久丢失**该轮产出（OMP 的 close 会 `terminateProcessTree` 并 `fs.rmSync(answerFile)`），所以默认拒绝。
2. **`callTool` 的 dispatch**：现在是 `closeSession(args?.session_id)` —— **`force` 会被静默丢掉**。改为：
   ```js
   return mcpText(closeSession(args?.session_id, { force: args?.force === true }));
   ```
3. **`closeSession(sessionId, { force = false } = {})`**：签名要接得住。
4. **`closeOne(session)`** 保持无条件（内部原语，被批量路径与拆除路径复用）；闸门加在 `closeSession` 层。

#### C6.1 批量关也必须受 guard（v1 的"只拦单关"是可绕过的假闸门）

v1 建议"guard 只作用于单 id 关、批量关照常执行"。**这是自相矛盾的**：agent 单关被拒后改调 `{}` 就能关掉全部；graph 自己最终也会 bulk close。那样 guard 只制造一次错误提示，保证不了任何东西。

**改为**（返回契约已写死，不留选择项）：

- 单关与批量关**都**做 guard。
- **两者都返回结构化的普通工具结果，不抛异常**——抛异常会让调用方拿不到结构化的 `runningSessionIds`。

  ```js
  // 单关被挡
  { closed: false, sessionId, blocked: true, runningSessionIds: [sessionId] }

  // 批量原子被挡
  { closedAll: false, count: 0, sessionIds: ids, failed: [], blocked: true, runningSessionIds }
  ```

- **被挡的分支不得调用 `closeOne()`、不得 `prune()`。** 批量是**原子**的：发现任何未 settle 就一个都不关。
- `force:true` 绕过 guard 后**保持现有成功返回合同**（单关返回 `closed`；批量返回 `{closedAll, count, sessionIds, failed}`）。
- **进程退出清理保持现有 `cleanupSessions()` → `session.close(options)` 路径。**
  > ⚠️ v2 写的"崩溃 teardown 走内部 `closeOne`"是**错的**：实查 `cleanupSessions()` 是遍历 `sessions.values()` 直接调 `session.close(options)`、再 `sessions.clear()`，**既不经 `closeOne` 也不经 `closeSession`**。**不要改动它，也不要把它改走受 guard 的公开 `closeSession`。**
- **graph 的最终私有服务器清场固定改为 `agent_bridge_close_session({ force: true })`**（不留"要么…要么…"）。

#### C6.2 必须一并修改的既有回归（v1 漏了）

C6 会**改变两个既有测试的合同**，它们当前明确要求 running-close 成功：

| 测试 | 当前合同 | 改法 |
|---|---|---|
| `docs/repro-mcp-hang/repro-cursor.mjs` S12 | "close during an in-flight turn → process tree-killed, pid record gone"，直接 `close_session({session_id})` 并要求 pid 被 tree-kill | 加 `force: true`（那正是 force 存在的意义），或改测"默认拒绝 + force 后仍命中原底层路径" |
| `docs/repro-mcp-hang/repro-kimi.mjs` S10 | 同上（tree-kill + pid 记录清理） | 同上 |
| `docs/repro-mcp-hang/repro-kimi.mjs` S25 | 用 running-close 命中 send 的 pre-begin close race（"was closed during send"） | 同上——这条尤其要小心，它是**非假绿设计**的证明性测试，改动后必须确认仍真的命中那条分支 |
| `docs/repro-mcp-hang/repro-turnstate.mjs` 结尾清理 | 会话**故意停在 `status:"running"`**，然后 `close_session({session_id})` + `await waitResp(closeId, 5000)`，**完全不检查响应** → 加了 guard 后会被静默挡住而测试照样 PASS（**假绿**） | 改为 `force: true` **并断言 `closed === true`** |
| `docs/repro-mcp-hang/e2e-real.mjs` 两处 `finally` 清场 | `if (wId) { try { await call(...) } catch {} }` 与 `if (cwId) { … catch {} }`——职责是"即使前面异常也强制清场"，而 `catch {}` 会吞掉被挡 | 两处都传 `force: true` |
| `docs/repro-mcp-hang/e2e-real.mjs` 的收尾批量关 | `call("agent_bridge_close_session", {})`——若此时还有 running 会话，C6.1 的原子 preflight 会一个都不关 | 传 `force: true`，或在其前确保全部已收口 |

#### C6.3 graph 的实际收尾顺序（v1 写得不准）

实查后的顺序是：

- 正常 / 普通错误：`saveScene`（仅非 ok）→ `closeSession`
- 总预算超时：`abort` → `finish` → `saveScene` → `closeSession`
- bridge 最终退出：另有一次**无 id 的批量 close**

**结论：按"只拦单关"的 v1 方案，`repro-graph-node` 大概率不会红**——成功与合同错误路径都已 settled，超时路径在 close 前 abort。**但这恰恰说明"repro-graph-node 绿"不能证明 C6 的保护有效**（未知且仍在跑的路径可能单关被拒，而测试没有要求该路径 `closeConfirmed:true`，随后 bulk close 还会绕过）。采用 C6.1 的"批量也 guard"后，**必须重新评估 graph 的最终 bulk close**：它要么显式传 `force`，要么改走内部 shutdown 原语。

---

### C7 文档同步

#### 7.1 `skills/agent-bridge/SKILL.md`

| 位置 | 改什么 |
|---|---|
| 「核心机制」段 | **新增**（R2 的纠正句，目前完全缺失）：桥**没有任何主动通知 / 唤醒机制**。一轮委托完成不会通知任何人；只有你自己调 `agent_bridge_wait` 才能拿到结果。宿主把在飞的长调用转后台并事后通知是**宿主**行为、前提是**有一个 wait 在飞**——没 wait 就没通知，你的回合一结束，那轮产出就无人接收。 |
| 「安全规则」清单 | **新增 invariant**（不要写成"一次 send 一次 wait"——`mode:"all"` 可一次收多个、`wait:true` 已内联收）：<br>**每个 accepted 的 turn，在你结束主任务或 `close_session` 之前，必须通过 `agent_bridge_wait` 收集到终态结果，或由你显式 `agent_bridge_abort` 放弃；返回里 `pending` 非空时必须继续 wait。未满足时不得向用户报告委托完成。** |
| 同上 | "不收口=结果作废"这种绝对说法**不要写**：session 还活着时结果仍可取。正确表述："**委托未完成；`close_session` 或宿主退出后可能永久丢失**"。 |
| TL;DR ⚠️ / 工作流第 2 步 / 「为什么不死等」/ 工具速查表 | 四处"不传默认死等 30 分钟"→ 新默认（10 分钟，超时返回 `timedOut` 且**不中断 turn**）。⚠️ 的重心从"必须传 `timeout_ms`"转为"必须**收口**"。 |
| 「并行委托」的三种返回形状表 | `mode` 默认已是 `any`；说明省略 `mode` 拿到的是 `{completed, pending, pendingSnapshots}`。**并修正"pending = 还在跑的 id"这个既有错误**（见 C4.6）。 |
| 返回值要点的 `textRef` | 补 caveat：turn 未结束时 `textRef` 指向**当前片段**。**（随 C5 同批）** |
| 工具速查表的 `agent_bridge_result` 行 | 保留"看中途产出"的用途，补一句：中途取到的是快照，按状态字段判别，不能当最终结果。**（随 C5 同批）** |
| 新增「宿主交互」小段 | 部分宿主对单次 MCP 调用有自己的上限（实测 Claude Code ≈120s 会把在飞调用转后台 + 事后通知）。所以**别把 `timeout_ms` 设得很长来"一次等完"**——短切片 + 循环在所有宿主上行为一致。 |

#### 7.2 三个场景 skill

`agent-bridge-dev` / `-loop` / `-roundtable` 开头都有"必须传 `timeout_ms`，不传默认死等 30 分钟"，按 C3 改。流程里写死的 `wait(mode:"any", timeout_ms:300000)` **可保留**（显式值仍有效、且是好实践），补一句"省略即为该默认"。

#### 7.3 `skills/agent-bridge-graph/tools/node-core.mjs`

显式传 `mode:"all"` 与 `timeout_ms:<slice>`，**不受 C2/C3 影响**。但 C6.1 落地后必须按 C6.3 处理它的最终 bulk close。

#### 7.4 全量文档 grep（v1 漏了源码注释、README 与测试注释）

**验收前跑这条**（中英都要，不能只搜中文）：

```bash
rg -n -a -i "30 分钟|30-min|1800000|DEFAULT_WAIT_TIMEOUT_MS|always pass.*timeout|死等|still-running ids" .
```

已知必改的非 skill 位置：

- `README.md` 的 "always pass a timeout_ms"
- `scripts/agent-bridge.mjs` 顶部 OMP 注释里的 "caller's own default 30-min wait deadline"
- `docs/repro-mcp-hang/repro-waitany.mjs` 注释里的 "default 30-min dead wait"
- `docs/CONSUMER_FEEDBACK.md` / `docs/ARCHITECTURE.md`：这些是**历史记录**，**追加"现版本已改为 X"，不要篡改历史语境**
- `docs/ARCHITECTURE.md` 变更历史追加本次条目（沿用既有版本条目风格）

#### 7.5 C6 必然改变的 close 合同文档（v2 漏了这一整组）

凡是写着"close 一定立即杀活跃 turn / 无 id 一定清空全部"的旧合同，都要按 C6 改：

- `README.md` 的 bulk-close 描述
- `skills/agent-bridge/SKILL.md` 的 **close 返回值表**与「兜底清场」条目（后者现在写的是"确认无其他活任务后，`close_session` 不传 `session_id` 可一次清空"——加了原子 preflight 后**不再无条件成立**）
- `docs/INSTALLATION.md` 里关于活跃 Cursor / Kimi 会话 close 行为的描述
- `docs/DEVELOPMENT.md` 的 fire-and-forget 合同

用这条扫：

```bash
rg -n -a -i "close.*活跃|兜底清场|closedAll|close ALL|clear.*all session|fire-and-forget" . -g "*.md"
```

---

### C8（P2，可选）`initialize` 返回 `instructions`

MCP `initialize` 当前只返回 `{protocolVersion, capabilities:{tools:{}}, serverInfo}`，**没有可选的 `instructions`**。那是**不依赖 skill 加载**的常驻提示位，成本极低。放一句最短的收口 invariant。**已知局限**：宿主是否把它交给模型不统一，只能是补充，不能替代 C1/C4。

---

### C9 明确**不做**的四件事

| 不做 | 为什么 |
|---|---|
| ack 标 `isError:true` | MCP 的 `isError` 表示**工具调用失败**。后台工作被接受不是失败。标错会导致宿主或模型**重试 send**，进而重复任务或撞 `already has a running turn`。 |
| 反转 `send_message.wait` 默认为 `true` | 当前 `wait:true` 阻塞到默认上限**且超时进入破坏性 abort**，与现有稳定性设计正面冲突（非阻塞 + 短超时轮询是 0.5.1/0.5.7 反复调整后定下的结论，见 `docs/ARCHITECTURE.md`）。 |
| 新增 `agent_bridge_run`（服务端封装 send + wait 循环） | 方向可行但代价是长 MCP 请求（正撞宿主上限）+ 重复 API 面。本次不做。 |
| 升级到 MCP 2025-11-25 Tasks | 长期最正统（task handle / `tasks/get` / `tasks/result` / 可选状态通知），但需服务器升协议 + 宿主声明支持，且通知仍不能是唯一机制。本次只调研留档。 |

---

## 4. 测试方案

### 4.1 惯例

- 测试在 `docs/repro-mcp-hang/`，命名 `repro-*.mjs`，`node docs/repro-mcp-hang/<name>.mjs` 直接跑。
- **hermetic = 假后端桩，零真实 token**：`fake-omp.mjs`（`OMP_BIN` + `FAKE_OMP_MODE`）、`fake-codex.*`、`fake-claude.*`、`fake-cursor-index.js`、`fake-kimi.js`、`fake-omp-stubborn.*`、`hang-bin.*`。
- **模板：`repro-wait-shape.mjs`**——它 spawn `node scripts/agent-bridge.mjs mcp`，手写 JSON-RPC over stdin/stdout，`parse(resp)` 取 `result.content[0].text` 再 `JSON.parse`。**新测试直接照抄其 harness。**
- 断言风格：`fail(msg)` 打 `>>> FAIL:` 并 `exit(1)`；成功打 `>>> PASS:`。

#### ⚠️ 桩的选择（v1 选错了）

- **`fake-omp-stubborn` 不能用于"turn 停在中间"**：它在约 60ms 就 `say({type:"agent_end"})`，turn 会正常 settle；它只是**抗 EOF / 抗 SIGTERM、进程不肯退出**，用于进程回收/强杀测试。
- **正确的 running 桩**：
  | 需要 | 用什么 |
  |---|---|
  | OMP turn 长时间在跑 | `FAKE_OMP_MODE=slowturn`（已存在） |
  | OMP running 中途**已有部分文本**（S10 需要 `textRef` 非 null） | **新增 `partialslow` 模式**：先吐 partial delta，再延迟 `agent_end`。`slowturn` 在终态前不输出 delta，mid-result 的 `textRef` 为 null。 |
  | codex running + structured output | **新增 `fake-codex` 的 `schemaslowpartial`**：先发 `turn/started` + `item/agentMessage/delta`，延迟 `turn/completed` |
  | codex 快速结算 ack（C1.3 第 2 点那条分支） | **新增 `fake-codex` 的 same-flush 模式**——规格见下，只写模式名会假绿 |
  | claude running | 现有 fake-claude 的首轮 withholding |
  | cursor / kimi running | 分别用 `abort` / `hang` 模式 |

**same-flush 模式的精确规格**（不照此写就是假绿）：

收到 `turn/start` 后，用**一次** `stdout.write()`（长度小于管道原子写入尺寸）连续写出**四条同 turn-id 的 NDJSON**：

```
turn/start 的 RPC response  →  turn/started  →  assistant item/delta  →  turn/completed
```

**中间不得 `setTimeout` / `setImmediate` / 任何让出事件循环的操作。** 桥的按行处理会在 `await` continuation 恢复**之前**同步吃完这一整批，从而使 `myTurn.settled` 已被置位——这正是要命中的分支。定位：codex `send()` 里 `if (this.turn !== myTurn) { if (myTurn.settled) … }`，以及 `#handleLine` 的 `turn/started` 注释。

> 现有 `fake-codex.mjs` 的注释写着 "Notifications are emitted ~50ms after the turn/start RESPONSE so the normal async path runs" ——它**故意**延迟来走常规路径。same-flush 就是把这条反过来，所以这个时序是**确定可控**的，不靠运气。

### 4.2 新增 `repro-collect-discipline.mjs`

**C1 / C2 / C3 的核心契约**：

| # | 场景 | 断言 |
|---|---|---|
| T1 | `send_message`（默认 `wait:false`） | ack 含 `mustCollectResult:true`、`resultIncluded:false`、`requiredAction.tool === "agent_bridge_wait"`、`arguments.session_ids` 含该 id、**无 `mode`** |
| T2 | `tools/list`（无 env 覆盖，**独立新 MCP server 进程**） | `agent_bridge_wait.timeout_ms.default === 600000`、`mode.default === "any"` |
| T3 | `tools/list`（`AGENT_BRIDGE_JOIN_TIMEOUT_MS=800`，**另一个独立新 MCP server 进程**） | `timeout_ms.default === 800`（证明 schema 如实暴露实际默认） |

> ⚠️ **T2/T3 必须各 spawn 一个新 MCP server。** `DEFAULT_JOIN_TIMEOUT_MS` 在**模块加载时**读 env，`TOOLS` 也在**模块级**构造——只改父测试进程的 env 然后复用同一个 server 会假绿。定位：`const TOOLS = [`、`const DEFAULT_WAIT_TIMEOUT_MS`。
| T4 | `send_message` 传 `wait:true` | 返回是结果，**不含** `mustCollectResult` / `requiredAction` / `resultIncluded` |
| T5 | codex 快速结算分支（same-flush 桩）非阻塞 send | **仍**加 ack 装饰（C1.3 点名的特殊事实）；**并且必须断言 `ack.status === "idle"`**——只断言"ack 被装饰"会在普通异步路径上假绿（那条路径 `status` 是 `running`） |
| T6 | codex `accepted:false` 分支（send 期间 close 抢跑） | **不**装饰 |
| T7 | `open_session` 带 `initial_prompt`、不传 `wait` | **外层**含装饰；`initial` 本身**不重复携带**；`initial.accepted === true` |
| T8 | `open_session` + `initial_prompt` + `wait:true` | 外层与 `initial` 都不含 |
| T9 | 省略 `mode` 调 `wait`（**两个错峰 slowturn 会话**） | 返回 `mode === "any"`；**第一个完成时就返回**、另一个仍 running（单会话只能证明 shape，证明不了"没有等齐后伪装成 any"）；`pending` 非空 → 含 `collectionComplete:false` + `requiredAction.arguments.mode === "any"` |
| T10 | 显式 `mode:"all"` | 仍返回 `{mode:"all", results:[…]}`（回归保护） |
| T11 | 显式 `mode:"all"` 且超时 | `requiredAction.arguments.mode === "all"`（**不能**被默认值污染成 any）、`session_ids` 等于 `pending` 而非原始全集 |
| T12 | `timedOut:true` 但 `pending:[]`（总结跨 deadline、最终全部 stable） | **不含** `requiredAction`、不要求再 wait |
| T13 | 省略 `timeout_ms`，`AGENT_BRIDGE_JOIN_TIMEOUT_MS=800` + `slowturn` | ~800ms 返回 `timedOut:true`；session **仍 running**（证明 join 超时不中断 turn）；再 wait 拿到 `SLOW_DONE` |
| T14 | **内联时钟未被污染**（关键） | 同一 `AGENT_BRIDGE_JOIN_TIMEOUT_MS=800` 下，`send_message(wait:true)` **省略** `timeout_ms` + `slowturn` → **正常完成**而不是 800ms 被 abort。断言窗口写 `elapsed >= 2000 && elapsed < 6000` **并**检查正文含 `SLOW_DONE`（`slowturn` 实测是 `setTimeout(…, 2500)`；**不要卡在"约 2.5 秒"的窄窗口**）。<br>⚠️ **这条只直接覆盖 OMP**。其余四后端**不得声称被运行时证明**——它们由验收 grep 确认仍读取 `DEFAULT_WAIT_TIMEOUT_MS` 即可。 |
| T15 | 多会话 `mode:"any"` 循环 | 把 `pending` 原样喂回去直到空；最后一次不含 `mustCollectResult` |

**C5**：

| # | 场景 | 断言 |
|---|---|---|
| T16 | turn 跑一半调 `result`（`partialslow`） | `inProgress:true` / `turnSettled:false`；`textRef` 存在且内容是片段 |
| T17 | turn 结束后调 `result` | `turnSettled:true` / `inProgress:false` |
| T18 | `wait` 的 `results[]` / `completed` / 超时 `settled[]` | 全部 `turnSettled:true`（**不能**因 C5 把终态结果误标 in-progress） |
| T19 | `pendingSnapshots[]` | **不带** `turnSettled`/`inProgress`（它不经结果构造函数）；且允许 `status` 为 `idle`/`failed`（pending ≠ still-running） |
| T20 | abort / failed / never-prompted 三态调 `result` | 明确锁定字段含义。**这是 C5 最容易出错的地方**：abort 后 `sessionSettled()` 为 true 但正文是片段——所以本轮**不用** `complete/partial`，字段只承诺 C5.1 定义的那件事（共享 wait 可交付判定），**不承诺**成功或正文完整。断言 `failed` + `turnSettled:true` 是合法组合、不被当成错误。 |
| T21 | 五后端 `isSettled` 矩阵 | 五个实现各自的 running / terminal 两态都断言（shared builder 的测试**不能**替代 backend-specific settled 测试） |
| T22 | codex + `schema`，turn 跑一半调 `result`（`schemaslowpartial`） | `json === null` 且 `schemaPending:true`；**不产** `schemaError` |
| T23 | `return_mode:"ref"` / `max_chars` × running | ① `inProgress` 标记不因 `text:null` 丢失；② `textRef` 当时只含当前片段；③ turn 完成后同一路径被最终全文覆盖；④ `schemaError.rawText` 不通过 ref/max_chars 泄漏全文 |

**C6**：

| # | 场景 | 断言 |
|---|---|---|
| T24 | 对 running 会话单关（不传 force） | 被拒；**并且**断言 session **仍存在且 running**、后续 `wait` **仍能拿到结果**（只断言错误文本会假绿） |
| T25 | 同上 + `force:true` | 关闭成功；**并且**断言 session 变 unknown、后端 PID 消失（只看 `{closed:true}` 不够） |
| T26 | running 会话先 `abort` 再单关（不传 force） | 先断言 `abort.aborted === true` 且 idle，再 close 成功（证明 guard 认 abort 这条正当出口） |
| T27 | 有 running 会话时批量关（不传 force） | **原子 preflight**：一个都没关、返回 `runningSessionIds`；断言会话列表**未**清空、已采样 PID **仍活** |
| T28 | 同上 + `force:true` | 全部关闭；断言列表清空且已采样 PID 消失 |

### 4.3 必跑的回归（hermetic，零 token）

```
repro-wait-shape   repro-waitany     repro-waitfail    repro-health
repro-schema       repro-io          repro-context-usage
repro-turnstate    repro-multiturn   repro-omp-concurrent
repro-kill         repro-pipebreak   repro-halfdead    repro-badline
repro-graph-node   repro-log-bounds  repro-name        repro-laststderr
repro-cursor       repro-kimi        repro-exit-journal
```

**v2 追加（生命周期相关，C6 会碰到）**：

```
repro-parent-death   repro-reclaim   repro-reap-confirm
repro-watchdog-disarm   repro-pidrecord-atomic
probe-claude-abort-fallback   probe-claude-abort-usage-gate
```

重点：

- **`repro-wait-shape`** = C1/C5 加顶层字段的守门人。做 subset check，**应当仍绿**；红了说明你把字段加进了 `FORBIDDEN` 禁区（`session`/`recentEvents`）或改坏了既有 key 集。
- **`repro-kill` / `repro-pipebreak`** = C2 唯一影响的两个（省略 mode）。按 C2 钉成显式 `mode:"all"` 后必须仍绿。
- **`repro-cursor` S12 / `repro-kimi` S10+S25** = **C6 必然要改的合同**，见 C6.2。改完必须确认仍真的命中原底层路径（尤其 S25 的 pre-begin race）。
- **`repro-graph-node`** = C6 的**弱**守门人：它绿**不能**证明 guard 有效，见 C6.3。
- **明确排除**：`skills/agent-bridge-loop/viz/test-viz.mjs`（只解析 transcript event，不消费 MCP 返回）。

**已知既有红**：`probe-doctor-timeout.mjs`。不要动。

**稳定性**：时序相关的（`repro-turnstate`、`repro-waitany`、T9/T13/T14 的窗口）按本仓惯例**连跑 K≥3** 确认不 flaky。T9 **必须错开两个会话的发送时间或用不同后端**，不能靠时序运气——同模式同时启动很容易同 tick 完成，那会让 early-any 断言假绿。

### 4.4 真 e2e（消耗真实 token，最后跑一次）

`e2e-real.mjs`（omp + codex 并行、`mode:all`/`any` 都覆盖、schema 轮）、`e2e-access-tiers.mjs`、`e2e-append-system.mjs`，外加一次**真 graph 跑**验证 C6 没卡住 finalize。

### 4.5 手工验收（最重要，无法自动化）

**开一个全新 agent 会话**（新上下文、不预先提示收口纪律），让它用 agent-bridge 派一个真任务，观察：拿到 ack 后是否**自发**调 `wait`；是否把 `pending` 喂回去循环到空；是否在收口前就 `close_session`。

这是本次改动的真实目标函数。**hermetic 测试只能证明字段在，证明不了模型行为改善**——"`requiredAction` 会显著改善 LLM 行为"是工程判断，非仓内实验结果。

---

## 5. 实施顺序与验收门

| 批次 | 内容 | 为什么这么切 |
|---|---|---|
| **B1** | C2 + C3 + C4（除 C4.7）+ 对应 C7 文案；把 `repro-kill`/`repro-pipebreak` 钉成显式 `mode:"all"`；测试 T2/T3/T9~T14 | 纯默认值与文案，风险最低；且 **C1 的 requiredAction 依赖新默认**。**C4.7（`result` 的新字段文案）与 `textRef` caveat 必须移出 B1**，否则文案先引用还不存在的字段（v1 的批次倒置）。 |
| **B2** | C1（两个装饰器）+ 测试 T1/T4~T8/T15 | 主菜。B1 落地后写起来最干净。 |
| **B3a** | C5 + C4.7 + 对应 C7 文案 + 测试 T16~T23 | 动结果漏斗，风险高，单独一个提交便于回滚。 |
| **B3b** | C6 + C6.2 的既有回归改动 + 测试 T24~T28 | 动生命周期，风险高且会改既有合同。**与 C5 无必要绑在同一 rollback 单元**，独立提交。 |

C7 的其余文档随各批同步——**不要攒到最后**，尤其 C3 会让四个 skill + README + 两处注释里的"30 分钟"立刻变成错的。C8 可选。

**版本号**：本次含**破坏性的默认返回形状变更**（C2）与 close 合同变更（C6），而 `BRIDGE_VERSION` 目前仍是 `"0.9.0"`。**实施时必须做出并写下决定**——建议升到 `0.10.0`，并在 `docs/ARCHITECTURE.md` 的变更历史里按既有风格记明"默认 shape 破坏性变更"。不要静默保持 0.9.0。

**验收门（全部满足）**：

1. T1–T28 全绿。
2. §4.3 回归全绿（`probe-doctor-timeout` 既有红除外），时序敏感项 K≥3 稳定。
3. §4.4 真 e2e 通过（含一次真 graph 跑）。
4. C7.4 的中英全量 grep + C7.5 的 close 合同 grep 均无残留过期表述。
5. **交 codex 复审**（换一个与实施者不同的引擎，`access:"read"` 新开会话），拿到 APPROVE。
6. §4.5 手工验收：新会话 agent 自发收口。
7. **发布落地**（v3 新增，此前完全缺失）：同步**实际 MCP 安装 clone**（`C:\Users\leo.wang\tools\agent-bridge`）→ **重启宿主 / MCP server** → 从**新进程**的 `tools/list` 实证 `mode.default === "any"` 与 `timeout_ms.default === 600000`。
   > 不做这一步，改动只存在于开发 clone，日常 agent 用的仍是旧 schema——而本次改动的全部价值就在于 schema 与 ack 的措辞。

---

## 6. 关键事实速查（施工时用检索串定位，不写行号）

| 事实 | 可复现检索串 |
|---|---|
| 六处非阻塞 ack，形状全同 | `rg -n -a "accepted: true" scripts/agent-bridge.mjs` |
| "结果已 ready、只是没交付"的那处 | codex `send` 里 `if (myTurn.settled.err && !this._requestedSchema) throw` 之后那个 return |
| `{accepted:false,…}`（abort/close 抢跑） | 同函数下方 `return { accepted: false,` |
| 后端只在 wait 分支读 `timeout_ms` | 各 backend `send()` 里的 `if (options.wait) {` |
| 五条内联超时路径 | `rg -n -a "Timed out waiting for" scripts/agent-bridge.mjs` + OMP 的 `waitIdle` |
| `wait` 的默认 timeout / mode 解析 | `parseNumber(params.timeout_ms, DEFAULT_WAIT_TIMEOUT_MS)` / `params.mode === "any" ? "any" : "all"` |
| wait 三个返回点（都回显 `mode`） | `rg -n -a "return \{ mode," scripts/agent-bridge.mjs` |
| `session_ids` 非空硬校验 | `session_ids is required` |
| `open_session` 的嵌套 ack | `return { session: session.summary(), initial }` |
| 结果构造函数的 6 个直接调用点 | `rg -n -a "buildSessionResult\(" scripts/agent-bridge.mjs` |
| 绕过它的路径 | concurrent-close 的 `gone` 结果、`result()` 报错后的 `base` fallback |
| settled 判定 | `function sessionSettled` + 五个 `isSettled()` |
| 单关 / 批量关 / 内部原语 | `function closeSession` / 其省略 id 分支 / `function closeOne` |
| **`force` 会被丢掉的那行** | `case "agent_bridge_close_session":` 下的 `closeSession(args?.session_id)` |
| OMP close 摧毁 artifact | OMP `close()` 里 `terminateProcessTree(pid)` 与 `fs.rmSync(this.answerFile, { force: true })` |
| MCP 序列化边界 / dispatch | `function mcpText` / `async function callTool` |
| `initialize` 无 `instructions` | `case "initialize":` 的 `rpcResult(...)` |
| send 的非阻塞强制 | `callTool` 的 `case "agent_bridge_send_message"`：`wait: args?.wait ?? false` |
| wait 形状回归的 subset 约定 | `repro-wait-shape.mjs` 的 `const EXPECTED` / `const FORBIDDEN` / "Subset check on purpose" |
| 现有省略 `mode` 的可执行调用 | `rg -n -a "agent_bridge_wait" . -g "*.mjs" -g "*.js" \| rg -v "mode:"` |
| C6 会打红的既有合同 | `repro-cursor.mjs` 的 `S12`、`repro-kimi.mjs` 的 `S10` 与 `S25` |
| 全量消费方扫描 | `rg -l -a "agent_bridge_(open_session\|send_message\|wait\|result)" . -g "*.mjs" -g "*.js"` |
| stubborn 桩其实会 settle | `rg -n -a -C 4 "agent_end" docs/repro-mcp-hang/fake-omp-stubborn.mjs` |
| 可用的 OMP 桩模式 | `rg -n -a "MODE ===" docs/repro-mcp-hang/fake-omp.mjs` |

---

## 7. 未坐实项（不要当成已知事实往下推）

- **`requiredAction` / `mustCollectResult` 真能显著改善 LLM 行为** —— 工程判断，**无仓内实验数据**。§4.5 就是为了补这条。
- **真实遗忘率** —— 用户观察真实，但无量化数据；也不知道各宿主是否加载了 skill、压缩具体丢了哪段。
- **仓外是否有严格 DTO / 快照测试 / 按精确 key-count 解析的客户端** —— 无法从本仓排除。C1/C5 加字段的残余风险在此。
- **各宿主的 MCP 单调用上限** —— 只实测了 Claude Code ≈120s 转后台 + 事后通知这一例（本次多次复现）。别当所有宿主的通行行为。
- **"把收口固化进代码就没人忘"** —— 经验推断，仓库不能证明遗忘率为零。
- **OMP 在首个 `turn_start` 到来前调 `result` 可能读到上一轮 buffer** —— 代码路径存在（OMP 在 `turn_start` 才清 buffer，而 `send` 入口只重置 `turnStarted`），**未构造运行时序复现**。C5 若顺手能覆盖就加断言；不作为验收门。
- **主 skill 的 token 量级** —— 约 14,057 字符 / 24,864 字节 / 201 行，粗估 7k–10k tokens（按 CJK 比例估算，非目标宿主真实 tokenizer 计数）。
- **`repro-graph-node` 绿 ≠ C6 有效** —— 见 C6.3，这是已知的测试覆盖缺口，不是推断。

---

## 8. 复审闭环

### 8.2 R2（v2 → v3）：判 APPROVE WITH CHANGES

R2 对 R1 的 10 项判定：**1/2/5/10 CLOSED；3/4/6/7/8/9 PARTIAL**。v3 逐条补齐：

| R1# | R2 判定 | v3 处置 |
|---|---|---|
| 3 | PARTIAL：`turnSettled` 说成"没有在途 turn"仍写强了（`turnstate` 能造出 `status:"running"` + `turnInFlight:false` 而 `sessionSettled()` 仍 false） | C5.1 换成 R2 的终稿措辞：**严格定义为"共享 wait 可交付判定"**，明说不代表成功/正文完整/远端已停，`failed`+`turnSettled:true` 是合法组合 |
| 4 | PARTIAL：C5.3 的"带字段或明确不带"把合同留给实施者选 | **删除该选择项**，给出 `gone` / `base` 两条绕过路径的确定字段代码；只有 `pendingSnapshots[]` 不带 |
| 6 | PARTIAL：批量 preflight 缺确定返回形状；"teardown 走 `closeOne`"与代码不符；graph 最终 bulk 未写死 | C6.1 写死单关/批量两个 `blocked` 返回形状（**不抛异常**、不 `closeOne`、不 prune）；**改正**为 `cleanupSessions()` → `session.close(options)` 且不得改动；graph 最终清场固定 `force:true` |
| 7 | PARTIAL：same-flush 只写模式名会假绿 | 给出精确规格（一次 `stdout.write()` 四条同 turn-id NDJSON、中间不得让出事件循环）+ T5 追加 `ack.status === "idle"` 断言 |
| 8 | PARTIAL：漏了 `repro-turnstate` 与 `e2e-real` 的清理调用 | C6.2 补三行（turnstate 结尾**假绿**、e2e-real 两个 `finally`、e2e-real 收尾批量关） |
| 9 | PARTIAL：T2/T3 需独立进程；T14 不能声称证明五后端 | T2/T3 标注**各 spawn 新 MCP server**（env 与 `TOOLS` 都是模块级）；T14 改为 `elapsed ∈ [2000,6000)` + 明说只覆盖 OMP |

R2 另补的 5 项遗漏，v3 已加：C7.5（README/SKILL/INSTALLATION/DEVELOPMENT 的 close 旧合同）、`envNum` **只对本常量收紧**（其它 env 把 `0` 当"关闭"）、验收门第 7 条**发布落地**（同步安装 clone + 重启 + 从新进程验 `tools/list`）、`BRIDGE_VERSION` 升版决定（建议 `0.10.0`）、C3 边界的 stderr 断言测试。

### 8.1 R1（v1 → v2）：判 NEEDS WORK，10 个 blocker

| # | Blocker | v2 处置 |
|---|---|---|
| 1 | C1 一个装饰器同时描述纯 ack 与已带结果的 wait 返回 = 说谎；wait 的 requiredAction 必须带原 `mode`；循环条件只看 `pending.length>0` | **重写 C1**：拆成 `decorateUncollectedAck` / `decorateIncompleteCollection`；wait 分支 `arguments:{session_ids:pending, mode}`；`repeatWhile` 改为 pending 非空（并说明 `{timedOut:true,pending:[]}` 可达 + 空数组会被硬校验拒绝）。见 C1.1/C1.3。 |
| 2 | open/send 的装饰条件漏了 `accepted === true`；open 外层形状未定义 | C1.2 给出完整条件与可直接实现的返回代码。 |
| 3 | C5 用 `sessionSettled` 生成 `complete/partial` 语义错误（abort 后 settled=true 但正文是片段） | **改为 `turnSettled`/`inProgress`**；若要 `complete/partial` 须先加跨后端 `lastTurnOutcome`（本轮不做）。见 C5.1、T20。<br>⚠️ v2 当时把它表述为"只承诺没有在途 turn"——**该措辞已在 R2 被判仍写强并修正，现行定义见 C5.1**。 |
| 4 | timeout 的 `settled[]` / `pendingSnapshots[]` 语义未写清；pending ≠ still-running | C5.2 给出四种形状的表；C4.6 修 `session_ids` 的既有错误文案；T19 锁定。 |
| 5 | C6 的 `force` 通路不完整（`callTool` 会丢掉） | C6 列出四处贯通点，含 `closeSession(args?.session_id, { force: args?.force === true })`。 |
| 6 | "单关受 guard、批量关不受"可直接绕过 | **C6.1 改为批量也 guard + 原子 preflight**。<br>⚠️ v2 同时写了"崩溃 teardown 走内部 `closeOne`"——**该断言与代码不符，已在 R2 被纠正**：实际路径是 `cleanupSessions()` → `session.close(options)`，现行说明见 C6.1。 |
| 7 | 测试桩选错（`fake-omp-stubborn` 会在 60ms settle） | §4.1 新增桩选择表；改用 `slowturn`，并要求新增 `partialslow` 与 fake-codex 的 `schemaslowpartial` / same-flush。 |
| 8 | 未列出 C6 必然要改的既有 running-close 回归 | **C6.2** 列出 `repro-cursor` S12、`repro-kimi` S10/S25 及改法。 |
| 9 | 缺 C2 多会话 early-any、C3 默认 600000、join/inline 隔离测试 | 新增 T2/T3（tools/list 断言默认值）、T9（两个错峰会话证明真 early-any）、**T14（内联时钟未被污染）**。 |
| 10 | 批次依赖倒置（C4 文案引用 B3 才有的字段） | §5 把 C4.7 与 `textRef` caveat 移入 B3a；B3 拆成 B3a(C5)/B3b(C6) 两个提交。 |

采纳的 nit：`DEFAULT_WAIT_TIMEOUT_MS` 改称"6 个读取点 + 1 个声明"；五后端 abort 改称"进入破坏性 abort 路径，远端停止为 best-effort"；补 README / 源码注释 / 测试注释的英文 grep；schema 如实暴露 `timeout_ms.default`；"工具返回绝不被压缩"降级为"更靠近决策点、通常更可靠"；"唯一漏斗 / 唯二调用点 / 测试即 repro 系列"全部改为给扫描命令。

**C2 / C3 的目标值未变**（用户决定）：以上修改只保证它们安全落地。
