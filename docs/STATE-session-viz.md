# 委托会话史观测台 —— wire 合同

**版本** schemaVersion `1` · **日期** 2026-07-29 · **状态** 生效

> **这份文件是 wire 的唯一真理源。**
> （早期的实施计划已随落地删除，本文件是唯一现存的 wire 定义。）
> 两处不一致时**改 PLAN，不改本文**。
>
> **写给谁看**：写 writer 的人、写 viewer 的人、写校验器的人。
> ⚠️ **写校验器的人必须只读这一份**——不许读 writer 的源码、不许 import 生产侧任何模块、
> 不许共用它的常量表与枚举字面量。理由见 §11。

---

## 0. 一句话

一个 MCP run 期间，桥把「开了哪些委托会话、每个会话跑了哪几轮、每轮问了什么答了什么、
有没有被取走」**以当前状态快照的形式**写进一个临时目录；一个只读的本地页面把它渲染出来。

**它是快照，不是事件流。** 页面永远渲染「此刻的全量状态」，从不按序回放。
所以 wire 上没有 `seq`、没有 append-only 日志、没有事件信封。

---

## 1. 目录布局

```
<VIZ_DIR>/                          ← 一次 run 一个,mkdtemp 建,run 正常结束时整个删掉
  meta.json                         ← **只有不可变身份字段**,写一次就再也不动
  owner                             ← pid + 进程起始时间(存活探测用)
  state.0.json                      ← 双槽之一
  state.1.json                      ← 双槽之二
  turns/<sessionId>/
    t1.in.md                        ← 不可变正文,写一次
    t1.out.md                       ← 不可变正文,写一次
    t3.progress.json                ← 仅活跃轮次,覆盖写,结算后删除
```

- `<sessionId>` 直接做目录名。它由桥生成，形如 `codex-mfx8q2-a7c319`，字符集是
  `[A-Za-z0-9._-]`。**writer 必须在建目录前校验这一点**并拒绝任何含 `/`、`\`、`..` 的 id。
- `t<N>` 里的 `N` 是 §4 的 `turnNo`（从 1 起的正整数）。

### 1.1 `owner`

```jsonc
{ "pid": 1234, "processStartedAt": "2026-07-29T02:11:04.221Z" }
```

⚠️ 键名与 `meta.json` **保持一致**（都是 `processStartedAt`）。
不写死的话，读的人只能猜——一个独立实现按 `startedAt` 猜、写的人用了别的名字，
两边都"对"，中间那道缝谁也看不见。

### 1.2 viewer 怎么起

```
VIZ_DIR=<目录> node serve.mjs [端口]
node serve.mjs <目录> [端口]
```

两种都必须认。位置参数**先判是不是合法端口（0~65535 的整数）再判是不是目录**；
端口不合法要给人话，**不许让它落进 `listen()` 变成 `ERR_SOCKET_BAD_PORT`**——
看到那条报错的人根本猜不到自己是把目录传到端口位上了。
端口省略或为 `0` 时用随机空闲端口，实际端口打印在 stdout 的启动行里。

### 1.3 `meta.json`

```jsonc
{
  "runId": "mcp-3f9a2c7e",          // 本次 run 的稳定 ID
  "pid": 1234,
  "processStartedAt": "2026-07-29T02:11:04.221Z",
  "bridgeVersion": "0.10.0",
  "createdAt": "2026-07-29T02:11:04.230Z"
}
```

⚠️ **`meta.json` 里不许有 `degraded`，也不许有任何会变的字段。** 见 §6.1。

---

## 2. 双槽快照协议

Windows 上 `temp + rename` 会因 Defender 让 `MoveFileEx(REPLACE_EXISTING)` 返 `EPERM`，
写失败被吞 → 页面把健康会话报成卡住。**所以不许用 rename。** 改双槽：

**writer 侧四条：**

1. writer **严格串行，永不重叠写**（同一时刻在途的快照写有且只有一个）。
2. 始终覆盖**较旧**的那个槽；写成功之后，下一次才切到另一个槽。
3. 每槽自带单调递增的 `generation`。
4. 快照写失败 → **保留 `dirty=true` 供后续重试，绝不把一次失败当作已发布**。

**viewer 侧：两槽都试着解析，取「合法且 `generation` 最大」的那个。**

### 2.1 「合法槽」四条校验（缺一不可）

| # | 校验 |
|---|---|
| 1 | `runId` 与同目录 `meta.json` 的 `runId` **完全相等** |
| 2 | `generation` 是**有限的安全正整数**（≥ 1） |
| 3 | `schemaVersion` 在受支持集合内（当前只有 `1`） |
| 4 | 必填结构完整（§4 的必填字段全在、类型对） |

⚠️ **`generation` 更高但 `runId` 不符者不得胜出。** 上一个 run 被 SIGKILL 留下的槽
`generation` 可能远大于新 run，按 generation 排序会让 viewer 显示上一个 run 的内容。

⚠️ **这一条只有拿 `meta.json` 才比得出来，所以它是目录级检查、不是快照级检查。**
一份快照单独拿在手里，永远看不出自己的 `runId` 是不是对的。
**测试若只调快照级校验，这道闸永远不会红**——它必须由「材料化成一个目录再走目录级校验」的
用例来考。（这个仓库刚在 graph 上栽过同一形状：一道闸要考得出来，
得让它成为那条用例**唯一可能变红的原因**。）

**两槽 `generation` 相等**：健康的 run 里到不了（写成功才推进代次与槽位，两槽必然差 1 以上）。
真出现就是**双方都不可信**，按违规报告，不许静默择一。

### 2.2 `generation` 是 run-local，绝不 resume 旧目录

- 每次 MCP run 重新 `mkdtemp` → 新 `runId`、新目录 → **`generation` 从 1 开始**。
- 上一进程 SIGKILL 留下的目录只供 viewer 回看，随后由 owner 存活探测与 `cleanup` 处理。
- ⚠️ **`createVizRun()` 的签名里不许有目录参数。** 唯一入口自己 `mkdtemp`，
  公开面上没有任何办法让 writer 指向别的目录——所以「指向了已存在的旧目录」这个状态
  **结构上不可达**，不需要为它写检查、写原因码、写验收。
  初始化失败一律返回 disabled recorder + 记一次诊断。

### 2.3 只在里程碑写，不按固定频率

**里程碑** = session open / status 变化 / close · turn dispatch / settle / collect · run 状态变化。

（依据：20 会话 × 15 轮 + 每活跃会话 400 字尾巴 ≈ 126,931 字节、序列化 ≈ 0.26 ms；
按 1 Hz 全量覆盖 ≈ 436 MiB/小时，不可接受。）

**400 字实时尾巴不进全量快照**，走 §5 的 per-turn sidecar——否则一个会话的进度更新
会重写其余 19 个会话和全部历史。

---

## 3. 计量口径

⚠️ **不定死就一定会各写各的。**

| 字段 | 单位 |
|---|---|
| `chars` · `returnedChars` · `progress.charCount` | **JS 字符串长度（UTF-16 code unit）** |
| `bytes` · `originalBytes` · `previewBytes` | **UTF-8 字节** |

**所有**计数、`generation`、`generationCount`、`pid`、`durationMs`、`turnNo`
一律是**有限的非负安全整数**（`Number.isSafeInteger` 且 `>= 0`）。

**时间戳**一律是 `Date.prototype.toISOString()` 的输出：UTC、带毫秒、以 `Z` 结尾
（`2026-07-29T02:14:31.882Z`）。**不许**本地时区、不许省毫秒、不许用 epoch 数字。
（页面要显示本地时刻，那是页面自己转，wire 上只走一种。）

**错误文本**（`error` / `openFailed.error` / `closed.reason`）的 300 字硬顶，
**单位同样是 UTF-16 code unit**，超了直接截断。

⚠️ **`NaN` / `Infinity` 经 `JSON.stringify` 会静默变成 `null`**，而 `null` 在本 schema 里
到处都是合法值——于是一个算错的数字会**伪装成「这项没有」**。
校验必须**显式拒绝非有限值**，不能只靠「是不是 number」。

⚠️ **400 字尾巴取末 400 个 code unit 之后，若首字符是落单的低代理（`\uDC00`–`\uDFFF`）
就丢掉它**；若末字符是落单的高代理（`\uD800`–`\uDBFF`）也丢掉。
直接 `.slice(-400)` 会从代理对中间切开，页面上就是一个 `U+FFFD`。

---

## 4. 快照 schema

```jsonc
{
  "schemaVersion": 1,
  "runId": "mcp-3f9a2c7e",          // 必须与 meta.json 一致,否则该槽非法
  "generation": 7,                  // run-local 单调正整数,从 1 开始
  "updatedAt": "2026-07-29T02:14:31.882Z",
  "run": {
    "pid": 1234,
    "bridgeVersion": "0.10.0",
    "startedAt": "2026-07-29T02:11:04.221Z",
    "status": "running",            // **只有这一个取值**,见下方警告
    "degraded": false,
    "recordingErrors": []           // 去重原因码,最多 16 条;枚举见 §4.1
  },
  "sessions": [ /* §4.2 */ ]
}
```

### ⚠️ `run.status` 只有 `"running"` 一档

原来还设计过一档 `"terminated"`。**它不可达**：run 退出时只做 O(1) 的 ledger 封账、
**不写快照**，`process.on("exit")` **零 snapshot I/O**；而正常退出还会**立刻把整个
`<VIZ_DIR>` 删掉**——就算写了也没有消费者。

留着它的唯一后果是：**机器测试能直接构造出这个状态并全绿，而生产路径永远发不出来。**

**run 的终态不是快照里的一个字段，是传输层的一帧**（§6 的 `control{kind:"run-gone"}`）：
viewer 靠 owner 探测确认死亡后广播，页面据此把仍为 `dispatched` 的轮次**合成**为 `abandoned`。

### 4.1 `recordingErrors` 原因码（封闭枚举）

`queue_full` · `queue_item_too_large` · `write_failed` · `snapshot_write_failed`

- 去重，**最多 16 条**（满了就丢弃新的，不挤掉旧的）。

  ⚠️ 枚举只有 4 个值、又要去重，所以这个上限在 v1 **到不了**。
  它是给「以后加原因码」留的前瞻性护栏，不是一条活约束。
  **因此不许写一条"构造 17 条原因码"的测试**——那会造出一个只有测试能构造出来的绿灯，
  正是这份文档在别处反复要消灭的东西。
- **观测失败只描述「我们没记下来」，绝不改变后端的 `outcome`。**

### 4.2 session 对象

```jsonc
{
  "sessionId": "codex-mfx8q2-a7c319",
  "name": null,                     // 会话别名,常为 null
  "agent": "codex",                 // omp | codex | claude | cursor | kimi
  "model": null,                    // 自由字符串或 null(用引擎默认)
  "effort": "xhigh",                // minimal|low|medium|high|xhigh 或 null
  "access": "read",                 // read | write
  "cwd": "D:\\cc\\agent-bridge",
  "returnMode": "full",             // full | ref
  "logFile": "C:\\…\\codex-….log",  // **可空**;逃生门:页面要给出这个路径让人自己去开
  "appendSystemPrompt": null,       // 或 §4.3 的对象
  "backendPid": 16116,              // **可空**:形状 B(cursor/kimi)轮间本来就没有进程
  "status": "running",              // starting | running | idle | failed | closed
  "health": "healthy",              // healthy | degraded | dead
  "isStreaming": true,
  "contextUsage": null,             // 或 §4.4 的对象
  "createdAt": "…", "updatedAt": "…",
  "openFailed": null,               // 或 { "phase": "start"|"initialTurn", "error": "…≤300字" }
  "closed": null,                   // 或 { "reason": "…", "forced": false, "at": "…" }
  "turns": [ /* §4.5,按 turnNo 升序 */ ]
}
```

**`sessions` 数组按 session attempt 的创建顺序排**——不是按 sessionId 字典序，也不是按
`updatedAt`。理由：启动失败的会话也要占一个位置（页面要把它渲染成一张「生下来就死了」
的卡片），按创建顺序才容纳得下。

⚠️ **未知字段一律不允许。** 实现者**不许直接 spread `session.summary()`**，
必须逐字段白名单映射——否则后端将来新增字段会静默流进快照，绕过白名单纪律。
校验器要显式拒绝 schema 之外的键。

⚠️ **`logFile` 可空。** 桥那边这个路径在 session 对象构造时就定下来了（早于 spawn），
所以生产路径上它**应当**总是有值——但合同不能因此写成"必须非空"：
recorder 是一个公开 API，调用方没给的时候，writer 只剩两条路——
**编一个路径**（撒谎），或者**丢掉这张卡片**（把一次真实发生的会话从记录里抹掉）。
两条都比"承认这次没有日志可指"更坏。页面据此只是不显示那个逃生门链接。
（同 `backendPid`：可空是因为**确实存在没有值的时刻**，不是因为懒得填。）

⚠️ **`status: "closed"` 有两种，靠 `closed` 对象区分——不是靠 `status`。**

| 情形 | `status` | `closed` 对象 | 会话还在不在 | 产出还救得回吗 |
|---|---|---|---|---|
| 桥主动关（`close_session` / 批量清场 / 退出） | `closed` | **非空** | 已从 `sessions` 移除 | **不能**，已随之销毁 |
| 后端进程自己退出（`process_close`，含 code 0） | `closed` | **保持 `null`** | **仍在** `sessions` 里 | 能，`result()` 照样取得回 |

合同里没有第三种。**只看 `status` 会把两者混成一句"已关闭"**，而它们对用户意味着
完全相反的事：前者是"这段记录到此为止了"，后者是"后端没了，但你还能把结果取走"。
所以 `sessionClosed()` 只挂在五个类的 `close()` 上；`process_close` 只经由状态钩子
体现为 `status: "closed"`。**绝不能在状态钩子里挂 `sessionClosed()`**——那会让
`finalizeSession` 把一批**还救得回来**的轮次说成 `abandoned`。

⚠️ **后端崩掉时，已经流出来的那截正文必须交给 `markSessionTerminal()` 带走。**
sidecar（§5）在结算那一刻就被删掉，后端又已经死了，观测侧还不许发 RPC ——
**这是最后一次机会**，不在这儿交出去就永远没有了。而「后端崩之前它说到哪儿」
往往正是排障要看的第一样东西。

同时：**那段正文只归 `activeAttempt` 那一轮**。`markSessionTerminal` 会遍历该会话所有
`dispatched` 轮次，一视同仁地写下去就是**把一轮的产出复制到另一轮头上**——
丢掉只是缺数据，复制是假数据，**后者更难发现也更致命**。

⚠️ **同一会话有多个 `ambiguous` 时，三条终结路径必须走同一处处置。**
`ambiguous` 的意思是「这一轮到底有没有被后端收下，说不清」。多于一个时，仅凭 sessionId
无法判断某个终结事件属于哪个 prompt，所以**一律**转 `unresolved`（从账上销掉，不是只改状态）
并置 `run.degraded` + 记 `write_failed`。

三条路径都会遇到它：后到的终结事件（`adoptByTerminal`）、后端进程死亡
（`markSessionTerminal`）、会话关闭（`finalizeSession`）。
**这三处必须共用一段实现，不许各写一遍**——曾经就是各写一遍，其中一处整段漏掉，
另外两处写法还不一致（一处从 attempts 表删除、一处只改状态，后者会让表随运行时长一直涨、
且过期 attemptId 仍能解析）。漏掉的那处造成的现象是：**页面上一个失败会话、里面一个轮次
都没有，两次委托凭空消失，而 `degraded` 不亮——页面连「本次记录不完整」都不会说。**
`ambiguous` 是不对外公开的内部态，所以「丢了」在页面上完全看不出来，只能靠这条纪律拦住。

### 4.3 `appendSystemPrompt`

```jsonc
{ "file": "D:\\…\\role.md", "bytes": 1820, "injectionMode": "system" }
```

`injectionMode` 三档，**照抄源码枚举，不许自创**：

| 值 | 哪些后端 |
|---|---|
| `system` | omp / claude（真 system prompt） |
| `developer` | codex（thread `developerInstructions`） |
| `first-turn-user-prefix` | cursor / kimi（软注入，只是首轮用户消息前缀） |

### 4.4 `contextUsage`

```jsonc
{ "tokens": 169601, "live": false, "isCompacting": true, "autoCompactionEnabled": false }
```

- `tokens`：**绝对** token 数。**刻意不吐 contextWindow / 百分比**。
- `live`：`true` = 实时读数（OMP）；`false` = 上一轮结束的快照（codex/claude）。
- `isCompacting` / `autoCompactionEnabled`：**仅 OMP 会给**，其余后端不出现这两个键。
- **`null` 表示未知，不表示 0。** cursor / kimi **恒为 `null`**。
  页面必须显示成「未知 / 不适用」，**绝不能显示成 0 或空进度条**。

### 4.5 turn 对象

```jsonc
{
  "turnNo": 3,                      // viz 自己的编号,从 1,同 session 内单调
  "vizTurnId": "vt-8c1f…",          // viz 稳定 ID,**一个 run 内永不复用**
  "backendTurnId": "019fa…",        // 或 null(拿到才绑)
  "backendTurnCount": 3,            // 或 null。防编号分叉,UI 不显示但复制时带上
  "state": "dispatched",            // **公开只有 dispatched | settled 两档**
  "boundary": "rpc_ack",            // §4.6
  "attemptedAt": "…",               // 原 prompt 派发时刻
  "dispatchedAt": "…",              // **公开/认领时刻**
  "settledAt": null,
  "firstBackendEventAt": null,      // 诊断用,**不作轮次出现的门槛**;允许早于 dispatchedAt
  "source": "send_message",         // initial_prompt | send_message | user_followup
  "blocking": false,
  "hasSchema": false,
  "input":  { /* §4.7 */ },
  "output": { /* §4.7 */ },
  "outcome": null,                  // null | completed | failed | aborted | abandoned
  "bodyKind": null,                 // null | final | partial | none
  "generationCount": 2,             // 稿次,与 progress sidecar 同源。「第 N 稿」徽章的唯一数据源
  "collected": null,                // 或 §4.8
  "error": null,                    // 或 ≤300 字的字符串
  "durationMs": null
}
```

**`source` 的三档**：`initial_prompt`（开会话时的首轮）、`send_message`（主 agent 通过
`agent_bridge_send_message` 发的）、`user_followup`（用户在观测台页面上对一个已经闲下来的会话
追问的——见 `docs/DESIGN-session-viz-send-lock-2026-08-04.md`）。

⚠️ `initial_prompt` 曾经在生产里**长期空缺**：开会话那条路没走 `sendTurn()` 这个漏斗，
首轮全落到默认值 `send_message` 上，而校验器只管"值在不在枚举里"，查不出"有一档从来没出现过"。
现已改为一律走漏斗（见 §12.7 那条纪律）。
`user_followup` 只能由桥内部的 `sendFollowupFromViz` 产生，不对任何 MCP 工具暴露，
调用方无法自己声称自己是 `user_followup`。

**`turns` 按 `turnNo` 升序。**

### 4.6 `boundary` 枚举 —— 「凭什么说它被派发了」

| 值 | 证据强度 | 哪些后端 |
|---|---|---|
| `rpc_ack` | **协议级** | OMP：RPC response 成功分支 |
| `turn_start_ack` | **协议级** | Codex：`turn/start` 的成功 response |
| `turn_started_notification` | **协议级** | Codex：`turn/started` 通知 |
| `pipe_enqueued` | **仅 transport** | Claude：裸 `stdin.write`，只证明进了 Node/OS 管道 |
| `os_spawned` | **仅 transport** | Cursor / Kimi：child 的 `"spawn"` 事件，只证明进程起来了 |
| `terminal_adopted` | **无 ACK** | 歧义 attempt 被后到的终结事件认领 |

⚠️ **页面对后三档只能写「已派发，等待后端输出」，不能写「后端已接受」。**

⚠️ **`terminal_adopted` 只留给「没有任何 ACK/通知、纯靠后到的终结事件认领」的形态。**
Codex 晚到的成功 response → `turn_start_ack`；晚到的 `turn/started` 通知 →
`turn_started_notification`。**不许误用 `terminal_adopted`。**

**`boundary === "terminal_adopted"` ⟹ `dispatchedAt >= attemptedAt`。**

⚠️ 这里**刻意是 `>=` 而不是 `>`**。这一条真正要挡住的是
「实现把 `dispatchedAt` 直接抄成 `attemptedAt`」——即假装轮次在尝试的那一刻就公开了、
把中间那段歧义期抹平。但**严格大于**要求的是**毫秒时钟分辨率**，
而那是实现控制不了的东西：本地极快的后端、hermetic 测试里的假后端，
都可能在同一毫秒内完成「尝试 → 后到终结事件 → 认领」。

**合同不该要求实现保证不了的事**，否则它就是一颗随机红的雷。
牙齿挪进测试：回归里**造一个真实的时间间隔**再断言严格 `>`——
抄 `attemptedAt` 的实现照样过不去，而正常实现不会因为时钟粒度被判红。

### 4.7 `input` / `output`

```jsonc
"input":  { "state": "ready", "ref": "turns/<sid>/t3.in.md",
            "sha256": "…64位小写hex…",
            "chars": 1240, "bytes": 3720,
            "truncated": false, "originalBytes": 3720,
            "error": null }

"output": { "state": "ready", "ref": "turns/<sid>/t3.out.md",
            "sha256": "…64位小写hex…",
            "chars": 8932, "bytes": 27104,
            "previewBytes": null, "previewSha256": null,
            "error": null }
```

| 字段 | 说明 |
|---|---|
| `state` | `pending` / `ready` / `missing` |
| `ref` | **相对 `<VIZ_DIR>` 的 POSIX 风格相对路径**。`state === "ready"` ⟺ `ref` 非空（**两个方向都成立**，`input` / `output` 同此） |
| `sha256` | **`state === "ready"` 时必有**，64 位小写 hex；否则 `null` |
| `chars` / `bytes` | 实际保存的量。**`output` 在 `state === "dispatched"` 阶段恒 `null`** |
| `truncated` / `originalBytes` | 仅 `input` 有。超长输入被截断保存时必须如实标出。**`truncated === false` ⟹ `bytes === originalBytes`**（不截断就没有"原始比保存大"这回事；页面正是靠这两个数说出「已截断 · 原始 12.3 MB / 保存 4 MB」，写不一致就等于凭空告诉用户拿到的是残件） |
| `previewBytes` / `previewSha256` | 仅 `output` 有。正文超过 `VIZ_FILE_MAX_MB` 时，另记预览段的长度与指纹；服务端只返回该 UTF-8 **完整边界**前缀 |
| `error` | `input`：`null`/`queue_full`/`write_failed`；`output`：`null`/`queue_full`/`queue_item_too_large`/`write_failed` |

⚠️ **`sha256` 的用处是内容对证。** 页面上「这就是记录里的那一份」这句话，
没有它就**没有任何东西**能支撑。viewer 的 `/file` 必须拿响应体**实时算出的** SHA-256
（走 `X-Viz-Sha256` 响应头）与状态里记的指纹当场对证；不一致就在页面上标出
**「文件被改动」**，而不是照常展示。

⚠️ **任何 `state` 下都不得出现悬空 ref**：`ref` 非 `null` ⟹ 该文件存在且可读。
dispatch 时输入文件还没写完 → 先 `state:"pending"` 且 `ref:null`，写成功后才发布 ref。

⚠️ **`input` 记的是调用方交上来的原始 message，不是实际发给模型的 argv。**
两种读法都说得通，这里选前者，理由：§0 要回答的是「**这一轮问了什么**」。
后端各自往前面拼的东西——首轮 system 前缀、只读策略前缀——要么已经在会话级
`appendSystemPrompt` 里单独呈现（连注入档位一起），要么是与轮次无关的常量。
把它们混进每一轮的输入，页面上就是同一段前缀在每张卡片里重复几十遍，
而真正区分这一轮的那句话被埋在下面。
**代价如实记**：因此 `input` 不等于「实际发给模型的字节」；要查那个，看 `logFile`。

### 4.8 `collected`

```jsonc
{ "at": "…", "via": "wait", "returnedChars": 8932, "truncated": false }
```

- `via` 枚举：`open_session` / `send_message` / `result` / `wait`。
- `returnedChars` 是**实际内联返回的字符数**。`returnMode:"ref"` 时可以是 `0`，
  **不等于正文的 `chars`**。
- **同一轮重复 result/wait 只记第一次 collection。**

⚠️ **`settling` 期到达的收口必须暂存，不许丢。**
合同要求 `collected !== null ⟹ state === "settled"`，但那说的是**快照里**的样子，
不是"晚于我们自己写完才算数"。真实时序恰恰相反：结算时正文可能还在宽限期里
（OMP 要等最后一条 `message_update`，最多 2s），而调用方的 `wait` 早就返回、
正文早就交到它手上了。丢掉这一条 ⇒ **一次已经取走的交付被记成「从未被取走」**，
页面挂出"未取结果"的假警报——而那个标记的全部价值就在于它不说假话。
**收口是外部事实；不该因为我们自己的写还在途就当它没发生过。**

⚠️ **两条绕过 `buildSessionResult` 的 wait 路径不带溯源**（会话被并发关掉的 gone 分支、
`result()` 抛错的 base fallback），所以它们不产生 `collected`，页面上表现为
「已结算、从未取走」。**这不是假警报**：那两条路上调用方确实没拿到正文。

---

## 4.9 合法组合矩阵（**必须实现成语义校验函数**）

⚠️ JSON Schema 的字段类型表达不了交叉约束。五个状态字段会产生大量自相矛盾的组合，
必须写死。

| `state` | `outcome` | `settledAt` / `durationMs` | `bodyKind` | `output.state` | `input.state` | `collected` |
|---|---|---|---|---|---|---|
| `dispatched` | 必须 `null` | 必须 `null` | 必须 `null` | 必须 `pending` | `pending`/`ready`/`missing` | 必须 `null` |
| `settled` | **必须非空** | **必须有值** | **必须非空** | `ready` 或 `missing`，**禁止 `pending`** | `ready`/`missing`，**禁止 `pending`** | `null` 或首次收集记录 |

**`outcome` × `bodyKind`：**

| | `final` | `partial` | `none` |
|---|---|---|---|
| `completed` | ✅ 绝大多数 | ✅ 少见（OMP 降级） | ⚠️ **仅当该轮 `output.error` 非空时合法** |
| `failed` | ❌ | ✅ | ✅ 常见 |
| `aborted` | ❌ | ✅ | ✅ |
| `abandoned` | ❌ | ✅ 偶尔 | ✅ 常见 |

⚠️ **`completed + none` 是「后端正常完成，但观测侧写失败」这一种情况**。
既不能一律判非法（那会把真实发生的事判红），**也不能无条件允许**——否则实现者会把
「正常完成但没记下正文」当成普通情况混过去。**判据就是 `output.error` 非空。**

⚠️ **`final` 的含义是「这份落盘正文就是后端的最终答复，完整」**，不是「这一轮成功了」。
两个独立原因会把它降成 `partial`：

1. **收场不是 `completed`**（上表已覆盖）——被打断／失败时，手上那截按定义不是最终答复。
   ⚠️ 桥侧映射 `outcome` 时**必须看后端的 `status`，不能只看有没有 `err`**：用户主动
   abort 走的是 `settleTurn(null, "aborted")`（codex 叫 `"interrupted"`），`err` 是空的。
   只按 `err` 判，一次中断会被记成 `completed + final`，而桥对外报的是 aborted——
   **viz 与桥的口径打架一次，这块表就没人信了**；无正文时更会凭空点亮 `degraded`。
2. **正文撞上了桥的 `MAX_TEXT` 截断上限**。五个后端的 `lastAssistantText` 都过 `clampText`，
   而 `clampText` **砍的是开头**、砍完恰好剩 `MAX_TEXT` 个字符 —— 所以 `length >= MAX_TEXT`
   就是「这是残件」的唯一可判信号。桥自己的 `result()` 能再走一次后端调用取全文，
   **观测侧不许**（§7 X9：观测一次 RPC 都不发）。补不回来就老实标 `partial`，
   而不是拿着残件宣称「这就是最终答复」还附上 sha256。**能记多少是能力问题，标错是诚信问题。**

⚠️ 由此产生一条 recorder 侧的合同：**`settleOnce` 的 `bodyKind` 允许是函数**，入参是最终
到手的正文。理由与「正文可以晚交」同源——OMP 的正文晚 250ms 才交（等最后一条
`message_update`），那么「这份正文算不算最终答复」也只能等正文到手再判：宽限期里流进来的
字可能恰好把它推过上限。结算那一瞬间先把 `bodyKind` 定死，就会拿一份已经被砍掉开头的
残件宣称 `final`。函数抛错按「没标」处理，**绝不因此改动 `outcome`**。

**六条蕴含式：**

1. `bodyKind ∈ {final, partial}` ⟺ `output.state === "ready"` 且 `output.ref` 非空
2. `bodyKind === "none"` ⟺ `output.state === "missing"` 且 `output.ref === null`
3. `collected !== null` ⟹ `state === "settled"`
4. 任何 `state` 下，`ref` 非 `null` ⟹ **该文件存在且可读**（不得有悬空 ref）
5. `input.error` / `output.error` 非空 ⟹ 对应的 `state === "missing"`
6. 对应的 `state ∈ {pending, ready}` ⟹ 该 `error === null`

> 第 5、6 条缺了的话，`{state:"ready", error:"queue_full"}` 这种**不可能组合仍能通过校验**。

**观测失败的连带写入（三处必须同步）：** 任何 `input.error` / `output.error` 被置位时，
**必须同时**：

- 置 `run.degraded = true`
- 把原因码并进 `run.recordingErrors`（去重，上限 16）

三处不同步就是「页面看起来完整、实则缺页」。

---

## 5. `progress.json`（sidecar）

```jsonc
{ "vizTurnId": "vt-8c1f…", "generationCount": 2,
  "updatedAt": "…", "charCount": 3182, "tail": "…约 400 code unit…" }
```

**覆盖写、不用 rename、结算后删除。**

`vizTurnId` 做身份匹配。**成立的前提是四条，缺一不可：**

1. `vizTurnId` 在一个 run 内**永不复用**
2. viewer **只在当前快照里该 turn 仍是 `dispatched` 时才合并 progress**
3. sidecar 里的 `vizTurnId` 必须**等于**当前 turn 的 `vizTurnId`
4. 同一 sidecar 路径的读**不并发**（防旧 read 晚于新 read 返回）

⚠️ **快照一旦标 `settled`，迟到的 sidecar 永远无法让它回退**；
viewer 收到 `settled` 立即停止轮询该 sidecar。

新 run 用新目录，所以 sidecar 里不需要额外的 `runId`。

---

## 6. 传输层合同

| 项 | 内容 |
|---|---|
| 端点 | 读：`GET /events`（SSE）· `GET /file?ref=`（资产）· `GET /`（页面）。写：**只有** `POST /send`（追问，合同见 §12.6）。**没有第五个** |
| 响应头 | `text/event-stream` · `Cache-Control: no-cache` · `Connection: keep-alive` · `X-Accel-Buffering: no` |
| 帧类型 | `hello` · `state` · `progress` · `control` · `viz:overflow` · `send-result`（§12） |
| 边界 | `\n\n`；每帧 `event:` + `data:` 两行 |
| 心跳 | 定期注释行（`:hb\n\n`），防中间件掐死空闲连接。**不计入背压预算** |
| 背压 | **每客户端只保留一份可合并的最新 `state`**（新的覆盖旧的，**不排队**），并遵守 `write()` 的 `drain` |
| 重连 | 连上先发 `hello`，再发**当前** `state`。**不回放历史**（快照本来就是全量当前态） |

**帧定义：**

| `event:` | `data:` |
|---|---|
| `hello` | `{ "protocolVersion": 1, "runId": "mcp-…", "schemaVersion": 1, "vizDir": "C:\\…" }` |
| `state` | 一份完整快照（§4），**原样透传** |
| `progress` | `{ "sessionId": "…", …§5 sidecar 的全部字段 }` |
| `control` | `{ "kind": "run-gone" }` 或 `{ "kind": "history-read-failure" }` |
| `viz:overflow` | `{ "droppedFrames": N }` —— 背压合并掉了几代 |
| `send-result` | 追问的回执，**§12**。`{ "sessionId": "…", "reqId": "…", "ok": bool, "result"?: {…}, "error"?: "…", "respondedAt": "…" }` |

### ⚠️ viewer 是搬运工，不是第二个 writer

**`state` 帧必须是槽文件里那份快照的原样透传**——不重新序列化、不补字段、不把 sidecar 合进去。

理由不是洁癖：viewer 一旦改写快照，页面收到的就**不再是「那份快照」**，
而合同对「那份快照 + viewer 的一些加工」这个东西**没有任何定义**——
`tests/contract-invariants-session.mjs` 验的是前者，页面吃的是后者，中间这道缝正是漂移的产地。
（这个仓库刚在 graph 观测台上按这个形状栽过，见 `docs/DRIFT-events-contract-vs-producer-2026-07-28.md`。）

所以实时预览走**独立的 `progress` 帧**，**由页面在渲染时合并**，
并且必须当场执行 §5 的四条前提（尤其「快照里该 turn 仍是 `dispatched`」这一条）。

> **这条纪律管的是 `state`，不是整个 `VIZ_DIR`。** §12 的追问功能让 viewer 往
> `inbox/` 写文件——那是**另一个命名空间的另一种东西（请求，不是状态）**，
> 两边的写者各自唯一，不构成"第二个 writer"。判据是：**viewer 永远不写 `state.*.json`、
> 不写 `turns/`、不改任何快照字节**。写请求 ≠ 改状态。

### 6.1 `degraded` 只有一个真理源

**「本次记录不完整」这件事只写在最新合法快照的 `run.degraded` / `run.recordingErrors` 上。**

`meta.json` 里**不许再有 `degraded`**。理由不是「少写一个字段」，而是
**同一个事实有两份可写的副本，就一定会漂**——这个仓库刚在 graph 观测台上按这个形状栽过
（见 `docs/DRIFT-events-contract-vs-producer-2026-07-28.md`）：一处更新了另一处没有，
页面显示哪一份取决于它先读了谁。

### 6.2 三种「看不到内容」必须严格区分

⚠️ 混成一句话，页面就会做错事。

| 情形 | 帧 | 页面该说什么 | 页面绝不能做什么 |
|---|---|---|---|
| 桥没记下来 | `state` 里 `run.degraded=true` | 「本次记录不完整」提示条，**不打断阅读** | — |
| **两槽都读不出来、而 owner 还活着** | `control{kind:"history-read-failure"}` | 「暂时读不到记录，正在重试」 | **不许**冒充 `run.degraded`；**不许**假装断连；**不许**当成 owner gone（那会让页面进「已清除」终态，而记录其实还在） |
| run 结束、记录已删 | `control{kind:"run-gone"}` | 「该运行已结束，实时记录已随之清除」，语气是**正常收尾不是报错** | 不许报错红 |
| SSE 连接断了 | （连接层面） | 「连接中断，正在重连」+ 自动重连 | **不许静默停止更新** |

⚠️ 第二行成立有个前提：**「还没写过快照」这个状态在实践中不存在**。
所以 `VizRecorder` 的构造函数出生就发一份空快照（0 个会话）。
不发的话，「刚开的服、一个会话都还没开」和「快照写了但读不出来」在 viewer 眼里
长得一模一样（两个槽都不存在 ⇒ `readLatestState()` 一律返 null），
于是**刚开服的第一眼**就是「暂时读不到记录」+「以下为断连前的最后状态」——一个假故障。
修在**写的那一侧**，是为了不在这张表里加第四种状态：状态越多，读的人越要靠猜。

### 6.3 `/file` 的放行判据（顺序不能换）

1. `ref` **词法校验**：只允许 `[A-Za-z0-9._/-]`，不许出现 `..` 段，不许以 `/` 开头，
   不许含 `\`。不合格 → **400**。
2. 解析成绝对路径后，判定它**是否在 `<VIZ_DIR>` 之下**（用 `path.relative` 判，
   不是字符串前缀比较）。越界 → **403**。
3. `realpath` 之后**再判一次**（挡 symlink 逃逸）。越界 → **403**。
4. 目标必须是**普通文件**，不是目录。→ **403**。
5. 响应头 `X-Content-Type-Options: nosniff`。
6. **响应体实时算 SHA-256**，走 `X-Viz-Sha256` 响应头返回。
7. **短开短关**：不在整个传输期握着文件句柄不放（会挡住临时目录删除）。

### 6.4 owner 存活期间**绝不退出**

viewer 进程**不许**有「无客户端满 N 分钟自灭」这种逻辑——那会让「提前起服务、
晚点再看」的链接失效。只有 owner gone **且**没有客户端之后，才进宽限期。

---

## 7. 开关与隐私

**`AGENT_BRIDGE_VIZ` 默认开，`=off` 关。**
（2026-07-31 用户拍板，**覆盖 2026-07-27 的「默认关」**。下面连同当时的理由一起记，
因为那个理由本身没有错，错的是它没能解决问题。）

**当初为什么默认关**：桥的诊断日志**刻意不落 prompt 全文**，viz 会把它落盘——这让
「本机磁盘上存在全部委托原文」从**不发生**变成**发生**。临时目录只解决长期留存；
run 存活期间 tmpdir 里就是一份全量明文，本机任何进程可读。**这条依然成立。**

**为什么还是翻回默认开**：因为「要不要记」这个决定的**时点**不对。记录只在 run
存活期间存在，出事那次没开就永远查不了——于是默认关等于把这个决定推给一个
**当时还没有信息**的人：他要在什么都还没发生的时候，预判自己以后会不会需要它。
而「重度委托之前先打开」这句提示，实践中就是不会被想起来。
默认开则把决定挪到**有信息**的一侧：明知这次要跑敏感内容，才去关。

**判定表刻意不对称**：

| `AGENT_BRIDGE_VIZ` | 结果 |
|---|---|
| 未设 / 空串 | **开**（默认路径） |
| `on` / `1` / `true` / `yes`（大小写无关） | 开 |
| **其余任何值** | **关** |

最后一行是关键：`off` 打错成 `offf`、`flase` 时倒向**关**。一个隐私开关拼错的两个方向
代价不对称——少记一次只是查不了，多记一次是内容已经落了盘。

**关掉是真的一步都不走**：连 `mkdtemp` 都不调，既是隐私开关也是排障隔离手段。

**零副作用**：只有 `createVizRun()` 被调用才 `mkdtemp`；模块顶层不做任何事。
`doctor` / `cleanup` / `help` / 测试 import 都不许凭空建目录。

**孤儿回收挂到了开服路径上**（`serveMcp()` 里 `createVizRun()` 之前调一次 `vizCleanup()`）。
默认关的时候孤儿目录是罕见事，靠人手跑 `cleanup` CLI 够了；默认开之后，**每一次不干净的
退出都会留下一份带全部委托原文的目录**，没人扫就一直躺在 tmpdir 里。

---

## 8. 提交顺序（`generation` 是发布屏障）

```
同步抓正文
  → 队列写 t<N>.out.md
  → 写成功回调之后 才改 settled 并填 outputRef
  → 才发下一代快照
```

**但队列可能拒绝。** 若快照写与正文写争同一个满队列，会出现「永久停在 settling」
或「内存里 settled 但 viewer 永远看不到」——**连 `degraded` 自己都排不进去**。所以：

1. 正文入队失败 → **同步**完成 `settling → settled`，`output.ref:null` +
   `bodyKind:"none"` + `output.error:"queue_full"`
2. **立即释放抓住的正文字符串**，不再占字节预算
3. **快照走单一 coalesced dirty slot**，不与正文 job 争普通队列容量；
   当前写完成后总会尝试发布最新 ledger
4. 快照写失败 → 保留 `dirty=true` 后续重试
5. **`settleOnce()` 的共享 Promise 必须在降级状态确定后结束**，不能因队列拒绝永久 pending

**输入同理**：dispatch 时输入文件还没写完，**不能立刻公布可读 `inputRef`**。

---

## 9. 退出期

`cleanupAndExit()` 同步关完所有 session 就 `process.exit()`。**没有下一拍。**

| 场景 | 做什么 |
|---|---|
| `session.close()` 且桥继续运行 | 同步改 ledger 状态；异步 dirty snapshot |
| run 退出 | **只做 O(1) 的 ledger seal + 停止接收新任务**，不同步写大快照 |
| `process.on("exit")` | **不做任何 snapshot I/O** |
| 退出时存在 `settling` 正文 job | **不等待**；run gone 是最终裁决 |
| viewer 侧 | 看到 owner gone / 目录消失后，把仍为 `dispatched` 的公开轮次**合成**为 `abandoned` |

⚠️ **「同步封账」不等于「同步落盘」。** 同步 OS 操作放进异步路径**照样冻事件循环**；
同步文件写**没有可执行的超时**，Defender 或文件系统一卡就把退出本身拖死。
而且正常退出马上删除整个 `<VIZ_DIR>`——写完即删的最终快照**没有可靠消费者**。

---

## 10. 不做有损裁剪

快照含完整历史 → 里程碑写入累计成本趋向 **O(turn²)**。

实测：**1 会话 × 1000 轮 = 815,252 字节 ≈ 0.78 MiB**（compact），约 815 字节/轮。

⚠️ **v1 明确不做有损裁剪。** 尤其**不许**把已 settled/collected 轮次的 ref 与元信息
摘要化——那会直接破坏「完整会话史」这个立身之本。
真到万轮规模，正确退路是 **schema v2 的 per-session 分片**，不是偷偷丢历史。

---

## 11. 校验器必须是第二实现

⚠️ **同一个人写规格、写生产者、再写校验器，校验器只能证明「生产者和它自己一致」。**

这不是理论风险：graph 观测台最狠的几个 bug 全是被 `tests/contract-invariants-session.mjs` 抓到的，
而它之所以抓得到，正因为它是**照着合同散文另写一遍、刻意不 import 生产端**的第二实现
（见 `docs/DRIFT-events-contract-vs-producer-2026-07-28.md`）。

**四条硬规则：**

1. **本文是唯一 wire 真理源。** PLAN §6 的 JSONC 只是草稿。
2. 生产侧的 schema / 有界化器 与 `tests/contract-invariants-session.mjs`
   **必须独立实现、互不 import**（**包括不共用常量表与枚举字面量**）。
3. **冻结样例按本文手工构造**，不是把 writer 的输出录下来当样例——
   录出来的样例只会把 writer 当时的 bug 一起冻住。
4. 独立不变量**同时**跑在冻结样例与**真实桥运行**产出的快照上。
   只跑前者证明不了生产路径。

---

## 12. 追问信箱（`inbox/` · `outbox/`）—— viewer → 桥的唯一写通道

设计背景与取舍见 `docs/DESIGN-session-viz-send-lock-2026-08-04.md`；**wire 以本节为准。**

用户在观测台页面上对一个**已经闲下来**的委托会话继续追问。页面（`viz/serve.mjs`）与真正拥有
发送能力的桥进程是**两个独立的系统进程**，中间靠 `VIZ_DIR` 下这两个目录传递。

### 12.1 目录布局与所有权

```
VIZ_DIR/
  inbox/<sessionId>/req-<reqId>.json          ← serve.mjs 写；桥读并认领
  inbox/<sessionId>/.claimed-req-<reqId>.json ← 桥认领后的中间态（见 12.3）
  outbox/<sessionId>/resp-<reqId>.json        ← 桥写；serve.mjs 读完即删
```

**每个目录单写者单读者**，不会撞车：

| 目录 | 谁写 | 谁读 | 谁删 |
|---|---|---|---|
| `inbox/` | `viz/serve.mjs` | 桥（`scripts/viz-inbox.mjs`） | 桥 |
| `outbox/` | 桥 | `viz/serve.mjs` | `viz/serve.mjs` |

- `<sessionId>` 与 `<reqId>` 必须满足 `^[A-Za-z0-9._-]+$` 且不得为 `.` / `..`（两侧各自校验，**不互相信任**）。
- 两侧落盘一律 **写临时文件 + rename**，消费者永远读不到半截 JSON。
  临时文件用 `.` 前缀，天然落在 `req-*.json` / `resp-*.json` 的扫描范围之外。
- **`.claimed-` 前缀的文件不得被当成新请求**——扫描器只认 `^req-(.+)\.json$`。

### 12.2 报文

**请求**（`req-<reqId>.json`），≤ **64 KiB**：

```jsonc
{ "message": "用户打的那句话" }   // 必填、非空白；其余键一律忽略
```

请求正文里 `reqId` **只在文件名里**，不进正文——两处各存一份就会漂。

**64 KiB 量的是 UTF-8 字节数**，不是 `String.length`（那是 UTF-16 码元数，中文会低估约三倍）。
HTTP 那一层（`readBodyCapped`）本来就按字节量，两侧口径必须一致，否则同一个上限在两条路上是两个值。

**回执**（`resp-<reqId>.json`）：

```jsonc
{ "reqId": "…", "ok": true,  "result": { "accepted": true, "turnId": "…" }, "respondedAt": "ISO" }
{ "reqId": "…", "ok": false, "error": "人话原因",                            "respondedAt": "ISO" }
```

`reqId`（必填）必须**等于文件名里那个**；`ok` 必填且是布尔。

`serve.mjs` 转成 SSE `send-result` 帧时按 §12.1「两侧互不信任」**逐字段重新构造**，不是展开透传：

- **目录名与文件名里的 `reqId` 都要自己验一遍安全 segment**（`^[A-Za-z0-9._-]+$`，且不是 `.` / `..`）。
  写方验过不代表读方可以不验：这两个值是**文件系统**给的，不是桥递过来的；
- `sessionId` **只认目录名**，正文里就算带了也不采信；
- `reqId` 跟文件名对不上 ⇒ **整份丢掉**（这份文件跟它的名字不是一回事，按错的 reqId 认领更糟）；
- `ok` **必须是布尔**（判据是类型，不是"字段在不在"——字符串 `"false"` 是 truthy）⇒ 否则丢掉；
  `error` / `respondedAt` 非字符串则填 `null`。

**回执的身份是 `(sessionId, reqId)` 这一对，不是 `reqId` 单独一个。** 页面缓冲早到回执时必须按这一对
做键，认领时两个都要核对——否则会话 B 的回执会顶掉会话 A 正在等的同 reqId 那条，
A 随后把 B 的成败当成自己的，还会把 A 正在打的字清掉。

⚠️ 写成 `{ sessionId, ...body }` 是**错的**：展开在后，正文里的 `sessionId` 会盖掉目录来源，
一份 `outbox/A/resp-r.json` 只要正文写 `{"sessionId":"B"}` 就会被广播成 B 的回执。

### 12.3 至多一次：认领靠 rename，且认领失败一次都不许执行

⚠️ **这是本节最要紧的一条。** 追问是一条能让 agent 去改文件的指令，
「偶尔执行两次」不可接受。

```
rename(req-X.json → .claimed-req-X.json)
  ├─ 成功 ⇒ 独占：原名已不在扫描范围，绝不会被重读 → 执行 handler → 写回执 → 删认领件
  └─ 失败 ⇒ 没拿到（被锁 / 被抢 / IO 错）→ **立刻返回，一个字都不执行**，留待下一拍
```

**不许用「删除 + 吞掉失败」当认领**：Windows 上 Defender 扫一下就能让删除失败，
而文件还躺在原地——下一拍再读到、**再执行一遍**；持续失败就是每 400ms 重放一次。
（这条是被真实变异测试逼出来的：把认领改回删除版，端到端用例当场重放 3 次。）

**失败方向必须倒向「这次不办」，而不是「可能办两次」。**

### 12.4 故障语义（都要如实说，不许猜）

| 情形 | 后果 | 谁负责说出来 |
|---|---|---|
| 认领失败 | 什么都没发生，请求留在 `inbox/` 等下一拍 | 无（对用户不可见，下一拍会成功） |
| 桥在认领后、写回执前崩了 | 磁盘上留下 `.claimed-*`，即「接下了但不知道办没办完」的现场 | 人工排查 |
| 回执写出但无人在听 | `serve.mjs` 读完即删，**通知丢失**；但那一轮照样会作为新 turn 出现在快照里 | 页面超时兜底 |
| 页面等不到回执 | **有界超时后必须说「结果未知，可能已经发出去了」** | 页面 |

⚠️ **页面超时的话术不许说「没发出去」或「可以重试」**——那条请求很可能已经真的送达 agent，
劝人重发就是劝人发两遍。正确说法是「先看轮次里有没有多出这一问，再决定」。

#### ⚠️ `ok:false` 只说明「没建立起成功结果」，**不说明 prompt 没送达**

真实路径：OMP 已经收下了 prompt，但 ACK 超时 ⇒ handler 抛错 ⇒ 信箱写 `{ok:false}`。
所以 `ok:false` 与「页面等不到回执」属于**同一类不确定**，客户端要按同样的保守方式处理，
不许据此断定「没发出去、可以重发」。（没有结构化的 certainty 字段，就一律按不确定对待。）

这条对**测试**同样成立，而且是被反复实测出来的：
**「追问被拒绝」这类回执断言，在「先真的发出去、再抛出预期的拒绝错误」的变异下永远是绿的。**
所以负向用例里回执断言只能当辅助，真正钉死「那个动作没发生」的判据必须是
**后端被派了几次活**（本仓由 fake-omp 的单调 prompt 计数提供）。
同理，「被保护的答案还在」也偏弱——后端每轮吐一样的正文、或正文是累加而非覆盖时，它照样成立。

### 12.5 桥侧的权威闸门

**页面上的置灰只是提前告知，不是拦截。** 真正的判据在桥进程里（`sendFollowupFromViz`），
因为页面看到的快照有轮询延迟。

判据的**默认方向必须是拒绝**——必须能证明「没有东西会被毁」才放行：

| 状态 | 处置 |
|---|---|
| 从来没有过轮次 | **拒**（这不是"追问"，而且可能抢在主 agent 首轮之前） |
| 末轮已被取走（`DISCHARGED` 匹配末轮 id），**且末轮之后没有再发生过「可能送达」的尝试**（`lastTurnEpoch === sendEpoch`） | 放行 |
| 其余一切（含说不清） | **拒** |
| 桥没把这一发接受成一轮（`accepted !== true`） | **当失败上报**，不许写成 `ok:true` |

#### 代际（`sendEpoch`）—— 只比 turn id 挡不住的那条路

`lastTurnId` **只在后端确认收下 prompt 之后才铸**。而「可能已经送达、却没铸出 id」是一个**真实存在**
的状态，至少两条路径能到：

- **OMP 的 RPC ACK 超时** —— 桥自己在代码里写着「不证明后端没收下那条 prompt」，随后却把
  `turnInFlight` 清掉、status 放回 `idle`；
- **codex 的 `#beginTurn(turnId)`** —— `turnId` 为空时只标 `begun`，**不动** `lastTurnId`。

两条都留下同一个局面：**后端很可能正跑着一轮真的轮次，而 `lastTurnId` 还是上一轮的 id**，
于是它跟上一轮的 discharge 证明严丝合缝地对上——只比 `turnId` 的话闸门会放行，那一轮的答案被覆盖。

所以设两个计数器，都由 `sendTurn()` 那个唯一漏斗维护（不下沉到五个后端）：

| 计数器 | 什么时候动 |
|---|---|
| `sendEpoch` | **每一次**进入 `send()` 之前 +1 —— 判据是「**可能**送达」 |
| `lastTurnEpoch` | 只在**真的铸出了新 `lastTurnId`** 时追平 `sendEpoch` |

两者不等 ⇒ 「末轮之后还有一发下落不明」⇒ 拒。

⚠️ **两侧操作数都必须是会话自己的状态，绝不能有一侧来自「交付那一刻」。**
第一版把代际记进了 `DISCHARGED`（交付时读当时的 `sendEpoch`），看着也是"比了代际"，
实际上是同一个洞的更深一层：歧义轮次**正跑着**的时候，主 agent 中途取一次结果
（`result` 允许中途取快照，拿到的还是旧 id），记账就会写出 `{turnId: 旧id, epoch: 当前代}`——
**证明被洗成当前代际**，闸门当场重新打开。现在交付这个动作碰不到这两个计数器中的任何一个。

- 判据是「**可能**送达」而不是「确实送达」：ACK 超时那类状态的全部意义就是分不清，
  而分不清必须算作送过了——往另一边算就是那个洞本身。
- **代价是方向刻意偏保守**：一次"后端明确拒绝了 prompt"同样会让两个计数器岔开，
  于是追问被拒到**下一轮真的被接受**为止（不是取一次结果就恢复）。
  多拒一次的代价是用户等一会儿，多放一次的代价是那份答案没了。
- **欠账台账（`uncollectedTurns`）必须用同一个判据函数**（`dischargeProofValid`）。
  两边误判的代价落在同一侧且都不可逆：闸门误放行 = 当场覆盖一份答案；
  台账误报「不欠了」= 用户关客户端时把它丢掉。分两套写迟早漂开。

**`source` 也同理**：不能往会话上覆盖一个 `lastTurnSource` 字段，必须跟 turn id **配成对**存
（`{id, source}`），读的时候 id 对不上就返回 `null`，不拿别的轮次的 source 顶上。
记晚了 `wait:true` 的 inline 结果读不到（它在 `send()` 内部就构造好了），
记早了则在「已进 send、还没铸 id」那段窗口里把新 source 配到旧 id 上。

⚠️ **绝不能写成「确认已结算了才去查有没有取走」。** OMP 有一个已知的状态形状
（`FAKE_OMP_MODE=turnstate`）：一轮真跑完之后 `get_state` 仍报 `isStreaming:true`，
status 被翻回 `running`，于是「已结算」判为假、整道闸被跳过；而发送那一侧只看
`turnInFlight`（早已清掉）**照样放行**——未取走的答案当场被覆盖。
这不是理论风险，是变异测试实测出来的：闸门退回该写法后，被保护的答案立刻变成 `null`。

「还在跑」与「跑完没人取」**故意不区分**：本来就分不可靠，而两者的正确处置都是拒绝，
所以拒绝文案必须对两种情况**同时**成立。

### 12.6 `POST /send` —— 唯一的写端点

**这是完整合同**：照着这一节就能独立实现一个客户端，不必读实现。

**请求**：

```
POST /send
Origin: http://127.0.0.1:<实际端口>
X-Viz-Token: <注入在 HTML 里的那个>
Content-Type: application/json

{ "sessionId": "…", "message": "用户打的那句话" }
```

`sessionId` 必须匹配 `^[A-Za-z0-9._-]+$` 且不是 `.` / `..`；`message` 必填、非空白。
其余键一律忽略。**请求体上限 64 KiB，量的是字节**。

**响应**（一律 `application/json`）：

| 码 | 正文 | 含义 |
|---|---|---|
| `202` | `{ "reqId": "…" }` | **只表示已排上队**，不表示发出去了。真正算数的是随后那帧 `send-result` |
| `400` | `{ "error": "…" }` | JSON 坏 / 不是对象 / `sessionId` 缺失或不合法 / `message` 缺失或空白 / 读体失败 |
| `401` | `{ "error": "…" }` | 凭证缺失或不对 |
| `403` | `{ "error": "…" }` | `Origin` 不是本机那个精确值（含缺 `Origin`） |
| `405` | `{ "error": "…" }` | 不是 `POST`（带 `Allow: POST`） |
| `413` | `{ "error": "…" }` | 超 64 KiB。**注意必须把流排空再回 413**，不许 `destroy()`——否则客户端只看到 `ECONNRESET`，看不到这句人话 |
| `415` | `{ "error": "…" }` | `Content-Type` 不是 `application/json` |
| `500` | `{ "error": "…" }` | 落盘失败，或处理时抛了意外异常 |

⚠️ **异常路径也必须回一个响应。** 只 `catch(() => {})` 会让客户端永远挂着——页面那边连"失败"
都算不上，只是 fetch 一直不回。

⚠️ 页面拿到 `202` **不能**当成成功；fetch 抛异常也**不能**当成失败（请求可能已经落进
`inbox/` 了，只是回应没收到），话术按 §12.4 走。

**协议版本仍是 `1`**：`POST /send` 与 `send-result` 帧是 v1 的**兼容扩展**——
老客户端不发也不听，行为不变，所以不动 `protocolVersion`。

**三道锁（缺一不可）**：

| 锁 | 做法 | 挡住什么 |
|---|---|---|
| 凭证 | 启动时 `randomBytes(32)`，**只注入 HTML、不进 URL**；定长比较（**先比 UTF-8 字节长度**再 `timingSafeEqual`，否则非 ASCII 头会让它抛异常而不是拒绝） | 别的站点猜不出 |
| 来源 | `Origin` 必须精确等于 `http://127.0.0.1:<实际端口>` | 凭证泄漏后的伪造来源、不守 CORS 的非浏览器客户端 |
| 请求形状 | 只认 `POST` + `application/json` + 体积上限 | 简单请求偷跑 |

**凭证不进 URL** 是刻意的：URL 会进浏览器历史、会经 `Referer` 泄漏。

**外加**：HTML 响应必须带 `Content-Security-Policy: frame-ancestors 'none'` 与
`X-Frame-Options: DENY`。否则页面能被别的站点套进 iframe——被嵌的仍是 `127.0.0.1` origin，
读得到凭证、自己发的请求也天然满足 Origin 检查，攻击者**一道锁都不用绕**，
只要把真实输入框透明地盖在诱饵下面骗用户亲手点（clickjacking）。

### 12.7 `source` 的三档必须都真的被产出

`initial_prompt`（开会话首轮）/ `send_message`（调用方发的）/ `user_followup`（页面追问的）。

⚠️ **「值合不合法」的校验查不出「有一档从来没出现过」。** `initial_prompt` 就这么
在生产里空缺了很久——开会话那条路漏传 `source`，全落到默认值上，而校验器只管值在不在枚举里。
**新增枚举值必须配一条真跑的用例证明它真的会被产出**，否则等于把同一个毛病复制一遍。

`user_followup` **只能**由 `sendFollowupFromViz` 产生，不对任何 MCP 工具暴露，
调用方无法自称是它。

它同时必须**沿主 agent 那条路透出去**（`lastTurn.source`，以及欠账台账的每一条）：
用户的追问会永久留在该会话上下文里，主 agent 看不见的话，
就会看到委托 agent 突然改主意却无法解释——**在按一个自己看不见的东西做判断**。
