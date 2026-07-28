# tools/ — flag 级用法

两个文件:`node-core.mjs`(**主角**,可 `import`)与 `node-turn.mjs`(命令行薄壳)。零依赖,仅 Node 内建。

## node-core.mjs(写脚本用这个)

```js
import { withBridge, runNode, normalizeSpec, UsageError, STATUS_EXIT } from "./node-core.mjs";
```

| 导出 | 干什么 |
|---|---|
| `withBridge(fn, opts?)` | 起**一个**私有桥进程 → 跑你的编排 → **收尾一定会跑**(异常路径也跑;能安全回收的都收干净,唯一的例外见下方收尾说明)。日常用这个 |
| `startBridge(opts?)` | 手动起桥(**你自己负责 `close()`**)。除非有特殊生命周期需求,否则用 `withBridge` |
| `bridge.runNode(spec)` | 跑一个环节,返回回执。等价于 `runNode(bridge, spec)` |
| `bridge.conversation(spec, fn)` | 跑**一段多轮对话**(有记忆),返回回执。见下 |
| `bridge.doctor()` | 后端体检(只查版本号,不验登录) |
| `bridge.callTool(name, args, timeoutMs?)` | 逃生舱:直接调任意 `agent_bridge_*` MCP 工具 |
| `normalizeSpec(spec, {kind}?)` | 只校验+算指纹,不执行(想先验参数时用);`kind:"conversation"` 走对话档 |
| `prepareRun` / `runTurn` / `finalizeRun` / `releaseRun` | `runNode` 与 `conversation` 共用的四段。**一般不直接用**,导出是为了让两条路只有一份实现 |
| `UsageError` | 用法错的类型(与「环节失败」区分:后者进回执不抛) |
| `STATUS_EXIT` | `status` → 退出码的映射表,**也是对话顶层结局的严重度序** |

`opts`:`{ bridgePath?, env?, initTimeoutMs?, onStderr?, maxConcurrent?, maxConversations? }`。

### `bridge.conversation(spec, fn)`

`runNode` 是「开会话 → 发一条 → 关会话」,**没有记忆**;`conversation` 把记忆圈进一个作用域。
**`runNode` 就是它的 N=1**,两条路共用 `prepareRun / runTurn / finalizeRun`。

```js
const receipt = await bridge.conversation(
  { id, agent, cwd, outDir, access?, model?, effort?, roleFile?,
    force?, reuseIfSame?, baseRef?, allowDirtyBase? },   // ← 顶层**不接受** timeoutMs / prompt /
  async (turn) => {                                      //    schema / outputShape / reask(当场报错)
    const r = await turn({ key, prompt | promptFile, timeoutMs,
                           schema?, outputShape?, reask? });
    // r: { key, status, sessionReusable, turnSpecHash, artifactPath, artifactSha256,
    //      charCount, byteCount, reaskCount, durationMs, startedAt, endedAt,
    //      contextUsage, abortConfirmed, scene, error, diagnostics }
  },
);
```

| 规矩 | 由什么保证 |
|---|---|
| `turn()` **不为失败抛异常**(同 `runNode`),失败进 `status` | — |
| **轮与轮不许并发** | `turn()` 入口一道**同步**串行闸,第二个当场 `UsageError` |
| `sessionReusable === false` ⇒ 整段**毒化**,后续 `turn()` 一律拒 | 判据在工具里,不靠回调自觉;拒的位置在占 key / 建文件 / 发消息**之前** |
| 顶层 `status` = **各轮里最严重的那一个**(序见 `STATUS_EXIT`) | 不取"第一个非 ok"(会被后面更坏的轮遮住),也不取"最后一轮" |
| 全轮 ok 但**回调自己抛了** ⇒ `callback_error`,不许被复用 | 判据是"抛没抛",`throw null` 也算 |
| 回调里可以跑 `runNode`;**不能对同一座桥再开 `conversation`** | 执行闸按**轮**持有(回调期间不持有);对话闸整段持有,嵌套会成环 |
| **最多 20 轮**;超了响亮报错 | `node:settled` 要内联一份有界的轮摘要 |
| `reuseIfSame` 是**整段**复用:轮序列要一模一样 | 不匹配一律 `UsageError`,**不会自动重跑**(与 `runNode` 复用闸同一口径) |

**两把闸**:`maxConcurrent`(默认 4)界"同时有几轮在烧后端";`maxConversations`(默认同值)界
"同时有几段对话持着活会话"。⚠️ **总活会话上限是两者之和**,不是其中之一。
桥本体默认按本文件相对位置找(`../../../scripts/agent-bridge.mjs`),
装在别处或走软链时用环境变量 **`AGENT_BRIDGE_MJS`** 指绝对路径。

> **收尾会花几秒,这是故意的,不是卡住。** `close()` 在关桥前要把桥的**强杀窗口**等完:
> 桥对关掉的会话是"先 SIGTERM、3 秒后再 KILL 整棵树",我们要是抢在那之前让桥退出,
> 没到点的 KILL 定时器会随进程一起消失,**抗 TERM 的后端就此逃生继续烧钱**。
> 等待量按"最后一次关会话到现在过了多久"算——刚关完就等满 4 秒,早就关完了则一秒不等。
> 一次 `withBridge` 只付一次这个成本(不是每个节点),对动辄几分钟的图跑是噪声。

> **桥要是自己死了(bulk close 都失败),收尾分两种走法,分界线是「此刻还能不能相信 `child.pid`」:**
> 桥还活着就按 pid 杀整棵树(我们攥着句柄,这个号码一定还是它);
> **桥已经退出就绝不碰那个号码**——它只是个历史数字,操作系统可能已经分给别的进程,
> 凭它 `taskkill /T /F` 会误杀一棵陌生的进程树。这种情况只跑桥自带的 `cleanup`,
> 它对每条 pid 记录**先做身份校验**(环境 marker / 进程启动时间对得上)再动手。
>
> 已知代价(如实记):`omp`/`codex`/`claude` 三家在关会话时会**先删 pid 记录、再等后端真正退出**,
> 桥要是恰好死在那条缝里,`cleanup` 就没有可校验的目标 → 可能漏收一个后端。
> 这是桥本身的口径问题(该像 `cursor`/`kimi` 那样等真 `close` 事件再删记录),
> 不在本 skill 的修复范围。**漏收一个自己会超时退出的后端,远好过杀错一棵陌生的树。**

### 任务单(spec)字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 环节编号,只能用 `[A-Za-z0-9._-]`(要拿来做文件名);同 `outDir` 内唯一 |
| `agent` | ✅ | `omp` / `codex` / `claude` / `cursor` / `kimi` |
| `cwd` | ✅ | 委托 agent 的工作目录(绝对路径,必须存在) |
| `outDir` | ✅ | 产出与回执落盘的目录 |
| `timeoutMs` | ✅ | **这一个环节的总上限**。内核内部按 ≤5 分钟切片反复 `wait`,不是单次请求就等这么久 |
| `prompt` / `promptFile` | ✅ 二选一 | 提问正文,或一个文件路径 |
| `model` | | 后端认的型号名(omp 要 `provider/名` 全限定;cursor 要带档位后缀) |
| `effort` | | 思考强度(**kimi/cursor 会忽略**) |
| `roleFile` | | 角色设定文件(注入为追加 system;cursor/kimi 是软注入,首轮用户前缀) |
| `access` | | `"read"`(默认)或 `"write"`。**`write` 恒定跑在自己的 git worktree 里**,`cwd` 传仓库根目录即可 |
| `baseRef` | | **仅 write**(默认 `"HEAD"`):worktree 基于哪个提交。read 环节传它当场报错 |
| `allowDirtyBase` | | **仅 write**(默认 `false`):主树有未提交改动时是否放行。默认拒绝并列出节点看不到哪些文件 |
| `schema` | | 强制输出格式,**仅 codex**;传给别人当场报错 |
| `outputShape` | | 弱检查,如 `{ requiredKeys: ["findings"] }`——只查能否 parse + 顶层键在不在 |
| `reask` | | `0` 或 `1`(默认 1):格式不合格时打回重说几次。**全系统唯一的 retry** |
| `force` | | 覆盖已存在的回执;write 环节还会覆盖同名分支/残留 worktree |
| `reuseIfSame` | | 回执已存在且**指纹一致**就复用;指纹变了报错 |

### `withBridge` / `startBridge` 的选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `maxConcurrent` | `4` | 同时在跑的环节上限。**超限的 `runNode` 自动排队**(不报错、不用改写法),别自己再搓限流。计时**从拿到闸之后**才起算,排队不算进 `timeoutMs` |
| `env` | — | 附加环境变量(传给桥进程) |
| `bridgePath` | 自动定位 | 桥脚本路径 |

### 回执(runNode 的返回值)

```jsonc
{
  "receiptVersion": 1,
  "id": "audit-auth", "specHash": "9f2c…",     // 输入指纹:防止把上一版任务的结果当成这一版
  "agent": "codex", "model": null, "effort": null,
  "status": "ok",                               // ok|contract_error|backend_failed|timeout|unknown
  "artifactPath": "<outDir>/nodes/audit-auth.md",
  "charCount": 1234, "byteCount": 1400,
  "contextUsage": { "tokens": 51234 },          // cursor/kimi 恒 null(是"未知",不是 0)
  "artifactSha256": "e3b0c…",                   // 产出内容指纹:复用前比对,防"文件被换过"
  "reaskCount": 0, "durationMs": 84000,
  "startedAt": "…", "endedAt": "…",
  "diagnostics": [], "error": null,
  "scene": null,                                // 非正常收场才有:{dir, files:[session.log, answer.txt, status.json]}
  "sessionId": "codex-…",
  "abortConfirmed": null,                       // 超时路径才有:桥**确实回报**打断了才是 true
  "closeConfirmed": true,                       // 关会话是否被桥确认(不是"没抛异常就算成")
  "access": "read",
  "workspace": null                             // read 恒为 null;write 见下
}
```

write 环节的 `workspace` 块:

```jsonc
"workspace": {
  "mode": "worktree",
  "path": "<repo>/.graph/wt/<runKey>/<id>",     // 已删除,仅供追溯
  "branch": "graph/<runKey>/<id>",              // **保留**给你合并;没有改动时为 null(空分支已清掉)
  "outcome": "delivered",                       // ← **唯一权威结论**,见下
  "baseCommit": "a3f9…", "headCommit": "7c21…",
  "changesKnown": true,                         // 我们**确知**这棵树里有没有改动;false = git 探测失败
  "committed": true,
  "filesChanged": [{ "status": "M", "path": "src/auth.ts" }],   // 基线→HEAD 的**全部**改动
  "diffPath": "<outDir>/nodes/<id>.diff",
  "diffSha256": "b1946a…",                      // diff 的内容指纹,复用前比对
  "removed": true                               // worktree 是否已删掉
}
```

`runKey` = **outDir 的目录名 + 它全路径的 8 位指纹**。只用目录名的话,`…/a/run-1` 与 `…/b/run-1`
会算出同一条分支和同一棵工作树:默认会撞出报错(还算安全),但只要一边带 `force:true`,
就会把另一边**正在写**的树连同分支一起删掉。

**`outcome` 是唯一权威结论**,调用方一律只看它,别自己拿 `committed` + `filesChanged` 再推一遍
（同一件事在两处各推一次,迟早推出两种结论）:

| `outcome` | 含义 | 环节状态 |
|---|---|---|
| `delivered` | 改动已提交到本环节分支,且 head / 改动清单 / diff / diff 摘要**四样齐全** | 可以是 `ok` |
| `no-changes` | **确知**一个字都没改(索引为空 **且** HEAD 仍在基线上) | 可以是 `ok` |
| `unknown` | 其余一切:git 探测失败、提交失败、交付物残缺、agent 自己把 HEAD 切走了 | 降级为 `unknown` |

**worktree 只在两个前提都满足时才删**:①`outcome` 明确(`delivered` 或 `no-changes`)②**后端确定不会再写**
(关会话被确认，或桥**明确回报**会话没建起来)。缺任一就**保留目录**并在 `diagnostics` 里说明
——留着只是脏，删错了是丢代码。`no-changes` 还会顺手删掉那条指向基线的空分支；`delivered` **保留分支**。

⚠️ **`outcome` 不明时,顶层状态一律降级成 `unknown` —— 不限于原本是 `ok` 的情况。**
`backend_failed` / `timeout` 在本工具的契约里是"可以安全换个人重跑"；而重跑通常带 `force`，
`force` 会把**正因为说不清才被保留下来**的那棵工作树连同分支一起删掉。工作区状态不明时还宣称"可安全重跑"，
等于亲手安排了一次数据销毁。原始结局记进 `diagnostics`，信息不丢。

⚠️ **提交之后还要再看一眼。** `--no-verify` 只跳过 pre-commit 和 commit-msg，**挡不住 post-commit**：
钩子可以在我们清点完之后继续改工作树、甚至切走 HEAD，而紧接着就是 `worktree remove --force`。
所以本工具自己的那次 commit 会把 `core.hooksPath` 指到不存在的目录（让"不跑钩子"是完整的），
并在提交后复查「工作区干净」与「HEAD 仍在本环节分支上」，任一不成立就 `unknown` + 保留，**绝不自动再提交一次**。

> ⚠️ 「没拿到 sessionId」**不等于**「后端没起来」:请求可能已经发出、会话真建起来了,只是响应超时或断管。
> 判据用的是 open 这一步的结局(`refused` / `not-attempted` 才算静默),不是 `sessionId === null`。

⚠️ **两个"零改动"的陷阱,都会导致静默丢代码**:
- `changesKnown:false`(git 探测失败)时列出来的改动同样是空 —— 把"不知道"当成"没有",就会把
  已经写出来的代码连同分支一起删掉。
- agent **自己 `git commit`** 过时,`git add -A` 之后暂存区也是空的 —— 所以「零改动」必须**同时**
  证明"索引为空"和"HEAD 还在基线上"。它自己提交过是正常的,交付按**基线→HEAD 的全部**算。

⚠️ **`git add -A` 不是"天然安全"**:agent 在工作树里留下的**一切未被 gitignore 的东西**都会进提交并出现在
diff 里——跑测试产生的 `coverage/`、临时文件、它自己写的 `.env` 都算。这是刻意的（它新建的文件通常正是产物），
但意味着**仓库的 gitignore 不全时会有噪声甚至敏感文件入库**。所以 `filesChanged` 一定要看，合并前自己过一遍 diff。

**指纹(`specHash`)算的是**:agent / model / effort / access / cwd / 提问原文 / 角色文件内容 /
`schema` / `outputShape` / **`timeoutMs`** / **`reask`** / **`baseRef`** —— 凡是会改变执行结局的都算在内
(否则"上次 1 秒超时、这次给 60 秒"会被当成同一个任务直接复用旧失败)。键序无关。
⚠️ `allowDirtyBase` **不进指纹**:它只决定要不要拒绝开跑,跑起来之后不影响结果。

**复用(`reuseIfSame`)的闸门**:回执版本对得上 → 指纹一致 → 上次是 `ok` → 产出路径就是本次算出的那个
→ 产出存在且非空 → 内容 SHA-256 与回执一致。**write 环节还要再过几道**:主工作区干净(同真跑) →
`baseCommit` 没变 → 按 `outcome` 分派:
- `delivered`:先查**字段齐不齐**(`branch`/`headCommit`/`diffPath`/`diffSha256`),再查**对不对**
  (分支名与 diff 路径必须等于本次算出来的那个、分支仍指向回执记的 `headCommit`、diff 文件内容与摘要一致)。
  顺序不能反 —— 先做等值比较的话,缺字段会被报成"不一致",把"上次就没写完"说成"有人动过你的文件"。
- `no-changes`:必须坐实 `changesKnown:true` 且 `filesChanged` 确实为空。
- **其余一切(含缺这个字段)一律拒绝**。

任一不满足都拒绝复用并说明原因。

> write 这几道都不是多余的:
> - **脏树闸也管复用**:否则同一个脏工作区下,真跑会被拒、复用却照样交货,而调用方分不出这两种情况。
>   复用出来的结果同样是对着 HEAD 做的、同样看不见那些未提交改动。
> - **`baseCommit`**:`baseRef` 通常是 `"HEAD"`,今天和上周解析到两个 commit,而指纹里只有字符串
>   `"HEAD"`——一模一样。不比对就会把"对着上周代码改出来的 diff"当成这次的结果。
> - **分支与 diff**:write 环节的**交付物是分支和 diff**,不只是那段文字。只校验文字产出的 sha 就复用,
>   等于宣称"上次那份改动还在"——而分支可能早被 `git branch -D` 掉了,diff 文件可能被换过。
>   这与 `artifactSha256` 是同一个道理,不能只做一半。
> - ⚠️ **字段缺失 = 拒绝,不是跳过**。写成 `if (pw.diffPath) { …校验… }` / `if (pw.committed) { … }`
>   会让"回执里没这个字段"静默绕过校验,而**字段缺失恰恰说明上次收尾出过问题**(diff 没导出成、
>   `rev-parse` 失败),正是最该拦住的那种回执。这个坑本仓踩过**三次**(`artifactSha256`、`diffPath`、
>   `committed`),所以现在改成**按 `outcome` 的字面量分派** —— 缺字段的回执连不上任何一个分支,
>   只能落到"拒绝"那一档,结构上就没有"跳过"这条路。

**`runNode` 只为用法错抛异常**(`UsageError`);环节失败一律进 `status`,因为"挂了怎么办"是策略、归调用方。

⚠️ **一个环节 = 一个会话,跑完就关**(`open_session` → `send_message` → `close_session`)。
**环节之间不复用会话、没有记忆**;环节内唯一的多轮是 `reask`(≤1 次,只为格式不合格打回)。
这是 `specHash` 成立的前提 —— 结果一旦取决于看不见的会话状态,指纹与复用闸就都是谎言。
多轮任务怎么把记忆喂回去,见 `../templates/review-fix-loop.mjs`。

## node-turn.mjs(命令行)

```sh
node node-turn.mjs --id <名> --agent <后端> --cwd <目录> \
  (--prompt <文本> | --prompt-file <文件>) --timeout-ms <毫秒> --out-dir <目录> \
  [--model X] [--effort xhigh] [--role-file F] \
  [--require-keys a,b] [--schema-file F] \
  [--no-reask] [--force] [--reuse-if-same] [--json]
```

`--require-keys a,b` 等价于 `outputShape.requiredKeys`;`--no-reask` 等价于 `reask: 0`;
`--json` 让 stdout 只吐回执 JSON(给脚本吃)。

**退出码**(描述**这一个环节**的结局):

| 码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 程序自己崩了(没预料到的异常) |
| `2` | 输出格式不合格(打回重说后仍不合格) |
| `3` | **桥明确回报**的后端失败:开会话被拒 / 会话 `failed`/`closed`/`gone` |
| `4` | 超时:本环节总预算耗尽(已尝试 `abort`,成没成看回执的 `abortConfirmed`) |
| `5` | 用法或 IO 错(含"回执已存在"、`force` 与 `reuseIfSame` 同传、同 id 并发) |
| `6` | 没预料到的状态——**已停下并保留现场,绝不自动重跑** |

**`3` 与 `6` 的分界是这套工具最要紧的一条语义**,别搞混:

- **`3`(backend_failed)= 桥明确告诉我们"这次不行"** → 调用方可以**安全地换个引擎重跑**这个环节。
- **`6`(unknown)= 我们不知道后端到底干没干**(本地 RPC 超时但预算还有余量、管道断了、返回形状不认识)
  → **绝不能当成可重试**。此时重跑可能把同一个任务干两遍(还可能两个会话同时写同一批文件)。
  分不清的时候,唯一安全的答案就是停下等人。

**`4` 与 `6` 的分界**:本地 RPC 超时**且本环节总预算已耗尽** → 算 `4`(时间是我们自己给完的,该走超时路径);
总预算还有余量却等不到响应 → 算 `6`(桥不该这样,属于没预料到)。

## 回归测试

```sh
node docs/repro-mcp-hang/repro-graph-node.mjs     # 假后端,零消耗,推送前必过(61 项断言)
node skills/agent-bridge-graph/examples/hetero-audit.mjs <目录>   # 真后端 e2e
```
