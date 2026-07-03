# PLAN — append-system-prompt 注入 + exit journal(任务A) + broadcast

**日期:** 2026-07-03
**状态:** 已调研 + 可行性定论,**待实施**。三方(deepseek/codex/claude via agent-bridge)独立评审 + 主 agent 对照源码/协议 schema/机器事实交叉核验。
**关联:** [INVESTIGATION-mcp-cleanexit-heavy-delegation-2026-07-02.md](INVESTIGATION-mcp-cleanexit-heavy-delegation-2026-07-02.md)、参考实现 `D:\cc\synod`(fork 自 agent-bridge 0.5.1,已实现并测试 systemPrompt 注入)。

---

## 机器事实(决定设计方向,已实测)

| bin | 解析到 | 类型 | 含义 |
|---|---|---|---|
| `omp` | `C:\Users\leo.wang\.bun\bin\omp.exe` | 原生 EXE | Node 直 spawn,干净 argv,**内联/传参都安全**(不过 cmd.exe) |
| `claude` | `C:\Users\leo.wang\.local\bin\claude.exe` | 原生 EXE | 同上 |
| `codex` | `...\npm\codex.ps1` | 脚本 | 但 codex 内容走 JSON-RPC stdin,不碰 argv,不受 shim 类型影响 |

> Claude 评审提出的"Windows `.cmd` 经 cmd.exe 二次解析 → 内联自由文本被元字符破坏/注入"风险,**在本机对 omp/claude 不成立**(二者是原生 .exe)。但为跨机器健壮(他人可能是 .cmd shim),argv 通道优先传**文件路径**仍是更稳的选择。

---

## 特性 1(主):`open_session` 支持指定 md 文件作为 append system prompt

> **状态:已实施 + e2e 11/11 + codex&deepseek 双评 APPROVE(2026-07-03,未提交)。** 三后端注入全部运行时验证。关键坑:omp 注入成功(get_state 证内容进 `systemPrompt[2]`)但**默认模型遵从波动**,能干模型(deepseek)稳定 honor → 已在 schema 描述与代码注释注明。测试 `docs/repro-mcp-hang/e2e-append-system.mjs`。

### 目标
拉起后端 agent 时,可指定一个 md/文本文件,把其内容作为**持久的追加系统指令**注入,覆盖 omp/codex/claude 三后端。用途:可复用的"角色/指令库"文件(如 `~/prompts/reviewer.md`)。

### 三后端注入配方(已定论 + 证据)

| 后端 | 通道 | 具体注入 | 语义 | 证据 |
|---|---|---|---|---|
| **omp** | argv | spawn args 加 `--append-system-prompt`,值为**文件**(见下"待实测")| 真 system append(叠加在已 `--no-rules` 的系统提示上)| omp help "Append text or **file contents**";synod `backend.mjs:522` 内联;codex-agent 读 omp 源码称 flag value "先当文件读、读不到当内联" |
| **claude** | argv | `#buildArgs` 加 `--append-system-prompt-file <绝对路径>` | 真 system append(非 replace)| help 明列 `--append-system-prompt[-file]`;codex-agent 负测 `--append-system-prompt-file <不存在>` 报 "Append system prompt file not found" 证实 file 变体真实 |
| **codex** | JSON-RPC(stdin,安全)| 现有 `thread/start`(agent-bridge.mjs:1986)params 加 `developerInstructions: <内容字符串>` | 真 developer 指令层(叠加在 codex base 之上,≈append)| **协议 schema 实证**:`codex app-server generate-json-schema --experimental` 输出的 thread/start params 含 `developerInstructions`(string\|null)与 `baseInstructions`(string\|null,=replace,勿用);synod `backend.mjs:1139` 已 ship 此字段 |

**codex 定论要点:** 这是本轮"codex有,仔细看看"的答案。codex **有原生通道**——不是 CLI flag,而是 app-server 协议 `thread/start` 的 `developerInstructions` 参数。它:
- schema 合法(本机 codex 0.142.3 确认)+ synod 已上线;
- 内容走 JSON-RPC over stdin,**任意内容安全**(无 argv 长度/元字符问题)——所以"最难(无 flag)的 codex"反而是"传任意内容最安全"的后端;
- 是 codex 的 **developer 指令层**(叠加,非替换);`baseInstructions` 才是替换,**勿用**。
- 备选:`-c developer_instructions=<toml>`(config 键,codex-agent 实机验证被接受,但内容进 argv 需 TOML 转义、有长度风险)——劣于 JSON-RPC,仅作备选。
- 旧版 codex 若不识别 `developerInstructions` → 降级为"prepend 到第一条 user 消息"(user-context,语义弱),并在 summary 标 `injectionMode: "user_first_turn_fallback"`。

**三后端都是真 system/developer 层注入(非 user-context hack)** → 语义基本一致,无需"三方语义不一致"的重度告警(仅旧版 codex 降级时才有)。

### API 设计
- **新增 `open_session` 参数:** `append_system_prompt_file`(string,绝对路径)。命名对齐 CLI flag,"append" 诚实表达追加非替换。**只收文件路径,不收内联字符串**(用户诉求就是"指定 md 文件";字符串形态在 argv 下不安全)。
- **校验(spawn 前 fail-fast,与 name/schema 同层):** 非空 string;`path.isAbsolute`;`realpathSync.native`;`statSync.isFile`;可读;`≤ 上限`;空内容拒绝。失败即 throw,**不创建 session、不留孤儿进程**。
  - **大小上限:64 KiB**(系统提示应精简;env `AGENT_BRIDGE_APPEND_SYSTEM_MAX_BYTES` 可覆盖)。
  - **不做 cwd 包含校验**(与 `message_file` 的关键区别):指令库天然在项目外,强制 cwd 内会毁掉用例。信任边界 = operator(主 agent),与 message_file 内容同级。绝对路径 + regular-file + 大小 cap 已足够。
- **数据流:** openSession 读一次内容 → (可选)快照到 `<RUN_LOG_DIR>/<id>.appendsys.md` 冻结内容防 TOCTOU + 保证干净路径 → 各 Session 按需取(claude/omp 取路径,codex 取内容)。close 时清理快照。
- **可见性:** `summary()`/`status` 加 `appendSystemPrompt: { file, bytes, injectionMode } | null`,`injectionMode ∈ {"system"(omp/claude), "developer"(codex), "user_first_turn_fallback"(旧codex)}`。**内容不回显**(上下文卫生)。`doctor` 不改(它是后端可用性)。

### 改动点(全在 `scripts/agent-bridge.mjs` + SKILL.md)
- TOOLS `open_session` inputSchema:加 `append_system_prompt_file`。
- `openSession()`(~2938):加校验 + 读取 + (可选)快照,挂到 params。
- `OmpRpcSession`:构造存字段;`start()` args(~1359,`--no-rules` 后)push `--append-system-prompt`。
- `ClaudeCodeSession`:构造存字段;`#buildArgs()`(~2544)push `--append-system-prompt-file <path>`。
- `CodexAppServerSession`:构造存字段;`start()` 的 `thread/start` params(~1986)条件加 `developerInstructions`。
- 三个 `summary()`:加 `appendSystemPrompt`。
- SKILL.md:参数说明 + 三后端机制/语义。

### omp flag 形态 —— 已实测定论(2026-07-03)
`omp -p --append-system-prompt=<value>` 三形态实测(banana.md 覆盖测试):
1. **纯绝对路径 `--append-system-prompt=<abspath>` → 回 BANANA**:omp **直接把路径当文件读**。✅ **采用这个**(路径短、无 argv 长度/元字符问题;与 claude 的 `-file` 一致)。
2. `@path` → 回 "Paris":**@path 不读文件**(@ 只用于消息参数,不用于此 flag)。❌ 弃。
3. 内联内容 → 回 BANANA:也行(synod 做法),但大文件撞 argv 长度,不如纯路径。
结论:omp 传**纯绝对路径**,让 omp 自己读。三后端全部 de-risk 完毕,无剩余未知数。

### 风险
- ~~[中] omp flag 形态未证实~~ **已实测定论(2026-07-03)**:纯绝对路径 `--append-system-prompt=<abspath>` 读文件成功(BANANA),`@path` 不读(Paris),内联也行。采用纯路径。
- [中] claude `--append-system-prompt-file` 版本依赖(较新加入)→ 文档钉最低版本;Windows 无内联退路。
- ~~[中] codex `developerInstructions` 运行时是否真注入~~ **已 RUNTIME 验证(2026-07-03)**:env 门控临时注入 + 真 codex 0.142.3 探针,`developerInstructions="只回 BANANA"` → 模型回 `BANANA` 而非 `Paris`,确认真 honor(探针已撤,产品零残留)。旧版 codex 若无此字段仍降级 prepend。
- [低] TOCTOU → 开局快照冻结。argv 长度 → 三通道(path/JSON-RPC)绕开 + 64KiB cap。
- [低] 内容 prompt-injection → operator 自供,信任边界内(同 message_file)。

---

## 任务 A(已批准实施):exit journal + 文档纪律

来自 INVESTIGATION-mcp-cleanexit 的评审结论(deepseek+codex 两轮 APPROVE),优先级:

- **R1(P0,做):持久 exit journal。** 每次 `cleanupAndExit`(code 0 和 1)在删 run dir **之前**,向一个独立于 run dir 的 append-only JSONL 追加一行退出摘要,堵住"优雅退出连 `bridge.log` 一起删 → 退出原因不可追溯"的取证盲点。
  - **路径修正(两 agent + 源码核验):** 用 `${STATE_ROOT}/exit-journal.jsonl`,**不要**硬编码 `~/.agent-bridge`——`agent-bridge.mjs:48` 是 `STATE_ROOT = process.env.AGENT_BRIDGE_STATE_DIR || ~/.agent-bridge`,硬编码会逃出自定义 state dir。不在 `LOG_DIR/mcp-*` 下 → 不与 `reclaimStaleLogs` 冲突(已核验)。
  - 字段:`{ts, runId, code, reason, pid, ppid, uptimeSec, activeRequests, sessions:[{id,status,backendPid}]}`。
  - 保留:默认 30 天 / 5–10MB cap,env 可调;单行 ~200B,初期可不轮转。
  - 删除点已核验:`agent-bridge.mjs:3607` `if (code === 0 && RUN_LOG_DIR !== LOG_DIR) fs.rmSync(RUN_LOG_DIR)`;journal append 须在此**之前**。
- **§2 措辞放软:** "run dir 没了 → 必然 code 0" 略强。硬 kill/OOM 未写 `shutdown code!=0` 也可能被 `reclaimStaleLogs` 扫掉 → 同样"目录没了"。更准:证据最支持 clean-exit/P2,但不能完全排除硬 kill-后-被清扫。(exit journal 恰好也能区分:有 code=0 行 vs 完全无行。)
- **R3(P1,文档):** SKILL.md 加客户端纪律——短 `timeout_ms` + 轮询(**"短 poll + 循环",不是缩短任务**;本轮 deepseek 单轮就 235s,一刀切 120s 总超时会误伤)、别与被委托 agent 同时榨满机器、定期 cleanup。
- **R4(P2,文档):** README/SKILL 加"桥不可用时的 codex CLI 兜底"一节。
- **R2(缓):** 长 wait keepalive 心跳——unsolicited stdout notification 在挑剔/正在 teardown 的 host 上可能自成新故障;R3 已基本消除触发条件。暂不做。

---

## 特性 2(可选,低优先):`broadcast_message` — 一套指令发多个模型

现有编排(开 N 会话 + 循环 send + `wait mode:all`)**已功能覆盖**——不是能力缺口。gap 是人机工程/防 prompt 漂移/部分失败透明度(均不大)。两 agent 一致推荐:新增独立 `broadcast_message` tool(不改 `send_message` 语义),MVP 只面向 read/review 会话(write 目标默认拒绝),返回 `{accepted, failed, acceptedSessionIds}`,不支持 `wait:true`(用现有 `wait` 收口)。低复杂度、低风险,不紧急。

---

## 证据索引
- 机器 bin 类型:`Get-Command omp,claude,codex`(omp.exe / claude.exe 原生;codex.ps1)。
- codex 协议 schema:`codex app-server generate-json-schema --experimental --out <DIR>` → `codex_app_server_protocol.v2.schemas.json` 中 thread/start params 含 `developerInstructions`、`baseInstructions`。
- synod 参考实现:`D:\cc\synod\src\backend.mjs:517-523`(omp 内联)、`:1134-1140`(codex `developerInstructions`);测试 `D:\cc\synod\test\backend.systemprompt.test.mjs`(注:用 fake codex,证"发送"不证"honor")。
- agent-bridge 注入点:omp `:1359`、claude `:2544` `#buildArgs`、codex `thread/start` `:1986`;exit 删除 `:3607`;`STATE_ROOT` `:48`。
