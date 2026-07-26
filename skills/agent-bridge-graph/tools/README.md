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
| `bridge.doctor()` | 后端体检(只查版本号,不验登录) |
| `bridge.callTool(name, args, timeoutMs?)` | 逃生舱:直接调任意 `agent_bridge_*` MCP 工具 |
| `normalizeSpec(spec)` | 只校验+算指纹,不执行(想先验参数时用) |
| `UsageError` | 用法错的类型(与「环节失败」区分:后者进回执不抛) |
| `STATUS_EXIT` | `status` → 退出码的映射表 |

`opts`:`{ bridgePath?, env?, initTimeoutMs?, onStderr? }`。
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
| `access` | | v1 **只能是 `"read"`**,传别的当场报错 |
| `schema` | | 强制输出格式,**仅 codex**;传给别人当场报错 |
| `outputShape` | | 弱检查,如 `{ requiredKeys: ["findings"] }`——只查能否 parse + 顶层键在不在 |
| `reask` | | `0` 或 `1`(默认 1):格式不合格时打回重说几次。**全系统唯一的 retry** |
| `force` | | 覆盖已存在的回执 |
| `reuseIfSame` | | 回执已存在且**指纹一致**就复用;指纹变了报错 |

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
  "closeConfirmed": true                        // 关会话是否被桥确认(不是"没抛异常就算成")
}
```

**指纹(`specHash`)算的是**:agent / model / effort / access / cwd / 提问原文 / 角色文件内容 /
`schema` / `outputShape` / **`timeoutMs`** / **`reask`** —— 凡是会改变执行结局的都算在内
(否则"上次 1 秒超时、这次给 60 秒"会被当成同一个任务直接复用旧失败)。键序无关。

**复用(`reuseIfSame`)的闸门**:回执版本对得上 → 指纹一致 → 上次是 `ok` → 产出路径就是本次算出的那个
→ 产出存在且非空 → 内容 SHA-256 与回执一致。任一不满足都拒绝复用并说明原因。

**`runNode` 只为用法错抛异常**(`UsageError`);环节失败一律进 `status`,因为"挂了怎么办"是策略、归调用方。

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
