# 委托会话史观测台 —— wire 合同

**版本** schemaVersion `1` · **日期** 2026-07-29 · **状态** 生效

> **这份文件是 wire 的唯一真理源。**
> `docs/PLAN-agent-bridge-session-viz-impl-2026-07-27.md` §6 的那段 JSONC 是它的草稿；
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
  "logFile": "C:\\…\\codex-….log",  // 逃生门:页面要给出这个路径让人自己去开
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
  "source": "send_message",         // initial_prompt | send_message
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

### 4.8 `collected`

```jsonc
{ "at": "…", "via": "wait", "returnedChars": 8932, "truncated": false }
```

- `via` 枚举：`open_session` / `send_message` / `result` / `wait`。
- `returnedChars` 是**实际内联返回的字符数**。`returnMode:"ref"` 时可以是 `0`，
  **不等于正文的 `chars`**。
- **同一轮重复 result/wait 只记第一次 collection。**

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
| 端点 | `GET /events`（SSE）· `GET /file?ref=`（资产）· `GET /`（页面）。**没有第四个** |
| 响应头 | `text/event-stream` · `Cache-Control: no-cache` · `Connection: keep-alive` · `X-Accel-Buffering: no` |
| 帧类型 | `hello` · `state` · `progress` · `control` · `viz:overflow` |
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

### ⚠️ viewer 是搬运工，不是第二个 writer

**`state` 帧必须是槽文件里那份快照的原样透传**——不重新序列化、不补字段、不把 sidecar 合进去。

理由不是洁癖：viewer 一旦改写快照，页面收到的就**不再是「那份快照」**，
而合同对「那份快照 + viewer 的一些加工」这个东西**没有任何定义**——
`contract-invariants.mjs` 验的是前者，页面吃的是后者，中间这道缝正是漂移的产地。
（这个仓库刚在 graph 观测台上按这个形状栽过，见 `docs/DRIFT-events-contract-vs-producer-2026-07-28.md`。）

所以实时预览走**独立的 `progress` 帧**，**由页面在渲染时合并**，
并且必须当场执行 §5 的四条前提（尤其「快照里该 turn 仍是 `dispatched`」这一条）。

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

**`AGENT_BRIDGE_VIZ` 默认关，`=on` 显式开。**

理由：桥今天的诊断日志**刻意不落 prompt 全文**，viz 会把它落盘——这让
「本机磁盘上存在全部委托原文」从**不发生**变成**发生**。临时目录只解决持久化；
run 存活期间 tmpdir 里就是一份全量明文，本机任何进程可读。

**代价必须如实说**：出问题那个 run 当时没开，就**没有记录**。
所以要在准备重度委托 / 多 agent 编排**之前**主动打开，而不是出事后才想起来。

**零副作用**：只有 `createVizRun()` 被调用才 `mkdtemp`；模块顶层不做任何事。
`doctor` / `cleanup` / `help` / 测试 import 都不许凭空建目录。

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

这不是理论风险：graph 观测台最狠的几个 bug 全是被 `viz/contract-invariants.mjs` 抓到的，
而它之所以抓得到，正因为它是**照着合同散文另写一遍、刻意不 import 生产端**的第二实现
（见 `docs/DRIFT-events-contract-vs-producer-2026-07-28.md`）。

**四条硬规则：**

1. **本文是唯一 wire 真理源。** PLAN §6 的 JSONC 只是草稿。
2. 生产侧的 schema / 有界化器 与 `skills/agent-bridge/viz/contract-invariants.mjs`
   **必须独立实现、互不 import**（**包括不共用常量表与枚举字面量**）。
3. **冻结样例按本文手工构造**，不是把 writer 的输出录下来当样例——
   录出来的样例只会把 writer 当时的 bug 一起冻住。
4. 独立不变量**同时**跑在冻结样例与**真实桥运行**产出的快照上。
   只跑前者证明不了生产路径。
