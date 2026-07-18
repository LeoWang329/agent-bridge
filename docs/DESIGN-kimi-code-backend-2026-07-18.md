# DESIGN — Kimi Code CLI 作为 agent-bridge 第 5 后端（`kimi`）

状态：**v4 — 已实现并双评修订（core + hermetic）。** 日期 2026-07-18。作者：主 agent（Claude Opus）。
真理源：本文件。落地 commit `d88c633`（初版）+ 复审修订（本轮）。

> **v4 实现 + 代码复审修订（实现后另一独立引擎 Codex 复审 diff，R1 = 0B/6M/2m 全修 → R2 收敛：5 项闭合，余 M1-argv0/M5-真覆盖/1 Minor 已修 = 下条）**：
> - [M1] §5.1 matcher 纯正则不懂引号 → 引号内的 ` -p ` 造成假阳性（cleanup 杀进程的安全边界）。**改为引号感知的 token 扫描**（`tokenizeWindowsCommandLine`，遵 CommandLineToArgvW 反斜杠/引号规则）。**R2 追加**：argv0 有 CommandLineToArgvW **特殊规则**（首 token 未加引号时其内 `"`/`\` 字面、命令行前导空白则 argv0 为空串），通用规则会误剥引号致 `C:\Tmp\ki"mi.exe"` 假命中 → 拆出 `parseWindowsArgv0` 专解 argv0，再对其后用通用规则 tokenize。见 §5.1。
> - [M2] §5.9 `resolveKimiBin()` 可能返回相对路径（相对 KIMI_BIN 或 `.` PATH 项在 MCP-server cwd 校验，但 send() 以会话 cwd spawn）→ 验 A 起 B / ENOENT。**三类候选一律 `path.resolve()` 绝对化后再校验/返回**。见 §5.9。
> - [M3] send() 的 spawn-await 窗口内并发 `abort()`（`this.turn`/`this.proc` 已置、`turnChild` 未置）设 `userAborted=true` 后，`#beginTurn` 原会重置 `userAborted=false` → abort 丢失、被杀 child 误结算为 nonzero 失败。**改：`userAborted` 只在 send() 同步占位（首个 await 前）重置一次、`#beginTurn` 不再重置、releaseUnbegun 清除、begin 后若 userAborted 则显式 kill 该 child**，使其 close 经唯一结算点 `#settleTurn` 结算为 aborted/idle。见 §2.1/§5.2。
> - [M4] hermetic 负例原走手抄 replica（正因此放过 M1）→ 改走**真实注册表 matcher**：新增只读诊断入口 `agent-bridge diag match <role>`（stdin JSON 命令行数组 → 真 `roleMatchesCommand` 布尔数组）+ `diag health`（真 `deriveHealth`）。repro-kimi S17 用它断言全矩阵（含活进程无法复现的 argv0 边缘形状），再叠加真 `cleanup` 对活进程「reap 真 turn / 不杀引号内 `-p`」。
> - [M5] 补设计 §8 场景（R1+R2）：S18 pre-begin abort 竞态 / S19 真 spawn ENOENT+重解析+可复用 / **S24 `send(wait:true)` timeout→abort** / **S25 pre-begin close（spawn-await 窗口内并发 close，断言干净结算不双结算不复活）** / **S26 真 late stale-close（ENOENT-retry 令新 child 已 begin、旧 child close 迟到，`this.proc===child` 身份门不污染新轮）** / S23 closed→gone + `deriveHealth(closed)="dead"` / S20 cmdline 上限+NUL 真拒。（**R2 澄清**：单会话对象内「新轮已 begin 而旧 child close 未到」仅经 ENOENT-retry 可达=S26；原 S7 不制造迟到 close，已改述为诚实的 abort+reuse。）
> - [Min1] repro-kimi S21：`role:"user"` echo 行含 secret marker → 断言 log/events 均无泄漏。
> - [Min2] open_session 字段级描述（access/write/effort/append_system_prompt_file）补 kimi 的 soft-read / effort ignored / first-turn-prefix 语义。
> - [Minor-R2] 文档状态自相矛盾（顶部 v4「已实现」vs §16 旧 R3b banner「尚未实现」）→ R3b 那句改注为设计期历史记录。
> 复审同时确认：`deriveHealth`/`spawnPlan` 字节级未动、状态机/#canRun/resolver-lazy/三处主动决定 sound、C# forwarder stub 走真实路径、无空断言（R2 复评 M2/M3/M4/Min1/Min2 闭合、M6 rollout 延期不扣分）。
>
> **R3 复评（判 M1 完全闭合；生产 Session 逻辑确认扎实，余项 = 测试严谨性 + 1 hermetic bug + diag 小加固，均已修）**：
> - [R3-Major hermetic 泄漏] 原 S26 靠「删缓存 bin → ENOENT-retry 走 PATH 兜底」制造第二个 child，但把 stub 目录**追加**到 `PATH` 尾——宿主已装真 kimi.exe 在 PATH 前段时 `resolveKimiBin` 会解析到**真 kimi** → 非 hermetic。**改**：S26 弃用 ENOENT-retry 机制，改 `KIMI_BIN=stub`（无 PATH/默认路径解析，真 kimi 无从泄漏）+ 生产侧 **env-gated 测试钩子 `AGENT_BRIDGE_KIMI_TEST_STALE_CLOSE`**（默认 no-op；置位时在 `#beginTurn` 后同步驱动一个 `dummy child !== this.proc` 的迟到 close 过 `#onChildClose`），确定性复现「旧 child close 迟到于新轮已 begin」这一调度依赖时序。见 §5.2/§8-S26。
> - [R3-Major S25 未证不可假通过] 原 S25 只 `fire` send+close 再等状态「会话已消失」——post-begin close 也能令会话消失（走 abort），故旧断言在错误时序下会**假通过**。**改**：`fireBoth`（**单次 stdin write** 两条 RPC → readline 同 tick 顺序派发 → send 同步跑到 spawn-await 才读 close 行，pre-begin **确定性**）+ 断言 send 响应命中 `"was closed during send"` 分支（post-begin 会返回 accepted 后 abort = 不同分支，错误时序无法静默通过）。S18 同法（`fireBoth` 令 send+abort 确定性 pre-begin）。
> - [R3-Major S26 未证不可假通过] 迟到 close 经身份门 `this.proc===child` 被忽略：断言 **pid 保留**（this.proc 未被置空）+ 活轮**未结算**（status 仍 running、非 failed）+ 活进程仍存活 + log 录得被忽略的 `kimi exited code=-4058`。**去掉身份门**则注入 close 会置空 this.proc → 活 child 自身 close 后续被丢（`this.proc!==child`）→ 轮**挂死** → wait 超时失败，故非目标时序无法假通过。
> - [R3-Minor diag 无界同步读 stdin] `diag` 原先无脑 `readFileSync(0)`。**改**：先校验子命令/role 再读；`fs.readSync` 循环限 `DIAG_MAX_BYTES=1 MiB`、JSON 解析出错显式报错、`match` 数组 ≤1000 且逐元素为 string 且 ≤100000 字符、`health` 须为对象 → 有界诊断契约，绝非无界 stdin sink。（`deriveHealth`/`roleMatchesCommand` 仅被**调用**，定义字节未动。）
> R3 三套 hermetic 回归全绿（repro-kimi 26/26 稳定 K≥3、repro-health、repro-cursor），`deriveHealth`/`spawnPlan` 仍字节未动（diff 内仅出现调用点）。M6 §9 rollout 仍延期。

> **最终复审结论**：Codex（gpt-5 系，reviewer 角色，read 档）三轮 → APPROVE。R1（2 blocker+5 major+2 minor）→ R2（M1/M5/Min1/Min2 闭合；余 1 blocker+5 major：doctor lazy-resolve/matcher/turnProtocolError/summary 泄露/statSync/artifact）→ R3（余项闭合，仅 matcher 1 major：`-p` 搜索范围）→ **R3b：APPROVE**。纯文档+代码核对（评审者 read 沙箱无法跑 kimi，§2 实测事实由作者本机真跑提供）。**（此为设计期结论的历史记录；实现 + 实现后代码复审见顶部 v4 banner。）**

> **v3.1（Codex R3 = NEEDS_FIXES，仅剩 1 major，已修）**：R3 判 R2 六项闭合 5 项；唯一残留 = §5.1 matcher 的 `-p` 仍从整串开头搜（安装路径含 ` -p ` 会落在 argv0 内致真 bridge 进程漏匹配，且未验 -p 后有 prompt）→ 改为在 `rest = s.slice(argv0)` 上搜 `/(?:^|\s)-p\s+(?=\S)/`。

> **v3 复审修订（Codex R2 = NEEDS_FIXES，1 blocker + 5 major，均已折入；R2 判定 M1/M5/Min1/Min2 已闭合）**：
> - [R2-B1] `AGENTS.kimi.bin` 与 doctor 矛盾（注册表初始化跑 resolver 会在模块加载抛、doctor 无从报 missing）→ §5.9 **绝不在注册表初始化跑 resolver**；`bin` 保持名义 `"kimi.exe"`；解析一律 lazy（doctor 内 try/catch→unavailable、start() 缓存 `resolvedBin`）。
> - [R2-M1] matcher 漏洞（`i<0` 仍匹配整串、argv0 正则未要求闭引号后空白、空串 split 抛）→ §5.1 重写：`i<0` 直接 false、argv0 加 `(?=\s|$)` + `m[1]??m[2]` 判空、head 取 argv0 末尾之后到 -p 之前。
> - [R2-M2] 缺协议错误锁存 → §2.1/§5.2 加 `turnProtocolError`（每轮重置、只增不减）；成功 = `exit0 && turnHadMeta && !turnProtocolError`。
> - [R2-M3] summary 泄露 system 原文 → §5.2 改用 `appendSystemPromptSummary(this,"first-turn-user-prefix")`(:759)，只吐 `{file,bytes,injectionMode}`。
> - [R2-M4] `existsSync` 不足以拒目录 → §5.9 三路径均 `statSync(p).isFile()`。
> - [R2-M5] "失败文本留 answer artifact" 落不了地（openSession(initial_prompt) 失败→通用 catch→close 删 answer 文件）→ §2.1 改述"保留于 session 内存（lastAssistantText/finalAnswer）、已打开会话可 result() 取，不承诺 artifact 持久化"。

> **来源**：本设计建立在 2026-07-18 的联合可行性调研之上（主 agent 直接实测 kimi-code 0.27.0 + Codex 独立架构复核，两方收敛）。所有"实测"标注均为主 agent 在本机（用户已登录 Kimi Code）真跑 `kimi` 得到，非推测。参照后端 = `cursor`（形状 B），真理源 `docs/DESIGN-cursor-agent-backend-2026-07-15.md`。

> **v2 复审修订（Codex R1 = NEEDS_FIXES，2 blocker + 5 major + 2 minor，均已折入）**：
> - [B1] native-only 未真保证 → §5.9 `resolveKimiBin()` **只认存在的原生 `kimi.exe`**，绝不接受 `.cmd/.bat` shim；`start()` 预解析、找不到即抛（不把无二进制的 fresh idle 报 healthy）。§5.5 呼应 fail-closed。
> - [B2] 成功判定 + session id 连续性未闭合 → §2.1 定死：成功必须 `exit0` **且**见合法 terminal `session.resume_hint`；首轮只认锚定 `session_<uuid>`、续轮 id 必须与 `chatId` 全等且**绝不覆盖**；无 meta / 非法 / 不一致 = 协议错误（累积文本留诊断，该轮判失败）；meta 合法时空 assistant 文本可接受。
> - [M1] `turnCount===0` 代理"可复用"有洞 → §5.2 引入**单一谓词 `#canRun()`**，`isReusable()` 与 `send()` 共用；三种态（spawn 前失败 / 首轮 abort / 协议错误）明确能否再开 fresh。
> - [M2] matcher 未锚 argv0 → §5.1 改为**解析命令行首 token、要求 basename 严格 `kimi.exe`**，再验 `-p` 前的 `--output-format stream-json`（支持任意安装目录、不被 model/cwd 参数误导）。
> - [M3] 必备字段清单不全 → §5.2 补 `turnChild / userAborted / turnHadMeta / appendSystemPrompt / appendSystemPending / name / returnMode` + 精确 summary shape。
> - [M4] "零共享改动"表述矛盾 → 全文改为 **"`deriveHealth`/`spawnPlan` 零改动"**；§9 补齐 doctor + open_session 公开描述（:186）等公共契约文案。
> - [M5] §6 多项开放调查会致范围漂移 → §3/§6 把 append-system / effort / write 语义 / 成功判定 / matcher **锁为 v1 决定**，只留"发布门槛验证"（多轮 resume / 真 abort）。
> - [Min1] §0 "无数据留存顾虑" 无依据 → 删除；改述"无 bridge 侧 create-chat、session 状态本地"（推理仍走 Moonshot 云端 API）。
> - [Min2] 单次 read e2e 证明不了不可写 → §8 改述"观察 read 策略被遵从且本次未写盘"，保留 soft/非安全边界表述。

---

## 0. 一句话

给 agent-bridge 加第 5 后端 `kimi`（Kimi Code CLI，原生二进制 `kimi`），走 **cursor 同款形状 B**（逻辑 session 常驻 + OS 进程按轮短驻 + session id resume），但**比 cursor 更简单**：单个稳定原生 `.exe`、**无 bridge 侧 create-chat**（session id 由 kimi 本地 mint）、session 状态本地保存、**且 `deriveHealth`/`spawnPlan` 零改动**（cursor 已把 `deriveHealth` 的 `isReusable()` 钩子铺好，kimi 只需自带 `isReusable()`）。
> 隐私口径：推理仍走 Moonshot 云端 API（prompt 会发往远端），**不宣称"无数据留存"**；相较 cursor 的优势仅在"无独立云端 chat 存储、无 create-chat 往返、session 状态在本地"。

---

## 1. 动机与非目标

- **动机**：Kimi Code（Moonshot K2/K3 系）是又一条可委托的引擎线；用户已本机安装登录，接入后可作独立第二意见 / 覆盖面补充。
- **非目标**：不追求默认/首选引擎；不实现 `kimi acp`（ACP over stdio，见附录 A）；不实现 `kimi server`（REST/WS/webUI）；v1 不做 contextUsage（虽本地可读，见 §5.7）。
- **平台范围（v1）**：**仅 Windows**，与现有 cursor v1 对齐、降低首版面。kimi 原生二进制有 win/linux/mac 三平台构建，POSIX 支持是低成本后续（附录 B），v1 不并入。

---

## 2. 登录后实测得到的硬约束（spike，Windows headless `-p`）

> 全部来自 2026-07-18 真跑（用户已登录）。kimi-code 版本 **0.27.0**，二进制 `%USERPROFILE%\.kimi-code\bin\kimi.exe`（native 安装器 `irm https://code.kimi.com/kimi-code/install.ps1 | iex` 装的，非 Python `kimi-cli`）。

1. **`-p/--prompt <prompt>` 一次性**：喂一条 prompt → 跑完 → 打印 → **进程退出**。无多轮 stdin 协议。续聊靠 session id：`-S/--session <id>`（或 meta 提示的 `-r <id>` 别名 / `-c/--continue` 续本 cwd 上一会话）。→ 形状 B（§4）。实测两轮 `-S <id>` resume 记忆延续正确。
2. **prompt 走 argv 的 `-p` 值**（**非** cursor 的 flag+位置参数）：`-p` 吃**下一个 argv token** 作为 prompt。实测 prompt 以 `--`/`-` 开头、含 `& | < > ^ \` "` 均被正确当 prompt（native 直起无 shell、commander 的 option-argument 语义）→ **无需 `--` 分隔符**（比 cursor §5.5 简单）——**前提是真走 native 直起**（§5.5/§5.9）。
3. **无 headless 只读/plan 模式**：`--plan` 与 `--yolo` **都不能**与 `-p` 同用（`error: Cannot combine --prompt with --plan/--yolo`）。→ read 档只能软约束（§5.4）。
4. **`-p` 默认放行工具**：不带任何审批 flag，`-p` 直接自动执行工具（实测让它跑 shell `echo`，无审批提示、不卡、exit 0）。此默认**不等于** full YOLO（`--yolo` 是另一档）——写档以"能跑可写 Bash"为准，**不宣称所有工具无条件开放**，是否受用户 config/static deny 约束不影响 v1 写档成立（§5.4）。
5. **stream-json stdout 无 token 用量**：逐行 NDJSON 里没有 usage 字段。→ `contextUsage` v1 = `null`（§5.7）。**但**用量数据本地有：`~/.kimi-code/sessions/wd_<cwd哈希>/session_<uuid>/agents/main/wire.jsonl` 的 `usage.record`（`{inputOther, output, inputCacheRead, inputCacheCreation}`）——留作后续精化。
6. **kimi 每轮必写自己的 state 目录** `~/.kimi-code/sessions/...`（连 headless `-p` 也是）。→ 任何 OS 级只读沙箱都会让 kimi EPERM（调研时 codex read 沙箱即因此失败）；kimi 的 read 档无法是硬只读，只能软。
7. **模型**：默认 `kimi-code/k3`；config.toml 别名 `kimi-code/{k3, kimi-for-coding, kimi-for-coding-highspeed}`（均 262144 ctx）；`-m <alias>` 选。effort 是 config/模型级（k3 支持 `low/high/max`，默认 `max`），headless **无 per-invocation flag**（§3 锁为 v1 忽略）。

### 2.1 stream-json 事件 schema + 终止/身份状态机（parser 地面真值 + v2 定死）

一行一个 JSON，**OpenAI chat-completions 风格**（`role` 字段，**非** claude/cursor 的 Anthropic `type`+`message.content[]` blocks）。实测事件：

| 行 shape | 关键字段 | parser 动作 |
|---|---|---|
| `{"role":"assistant","content":"..."}` | content=文本片段/块 | 累积到 `lastAssistantText` / `finalAnswer` |
| `{"role":"assistant","tool_calls":[{"type":"function","id":"tool_x","function":{"name":"Bash","arguments":"{...}"}}]}` | 工具调用 | 压 events（过滤高频） |
| `{"role":"tool","tool_call_id":"tool_x","content":"...\n"}` | 工具结果 | 压 events；不落敏感全文 |
| `{"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>",...}` | **每轮最后一行恒有**；session_id | 校验并记 `chatId`（见状态机）；置 `turnHadMeta=true` |

**终止 + 身份状态机（v2 定死，[B2]）**——`result` 事件在 kimi **不存在**，终答=累积 `assistant.content`，身份靠 meta：

- parser 每行判定（`turnProtocolError` 每轮 begin 时重置为 false、**只增不减**，[R2-M2]）：
  - 见合法 `meta`（`type==="session.resume_hint"` 且 `session_id` 匹配锚定 `^session_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`）：
    - **首轮**（`this.chatId == null`）：`this.chatId = session_id`；`turnHadMeta = true`。
    - **续轮**（`this.chatId != null`）：若 `session_id !== this.chatId` → `turnProtocolError = true`（**绝不覆盖 chatId**）；否则 `turnHadMeta = true`。
  - 见 `meta` 但 `type`/`session_id` 非法（不匹配锚定）→ `turnProtocolError = true`。
- 进程 `close`（stdout EOF + exit）= **唯一资源结算边界**，`#settleTurn` 判定：
  1. `userAborted` → 结算 aborted（清 lastTurnError）。
  2. `exitCode !== 0`（或 signal）→ **失败**。
  3. `!turnHadMeta || turnProtocolError` → **协议错误 = 失败**（首轮无 meta = 拿不到 resume id = 会话残废，不能静默成功；续轮 id 不一致同理）。累积 assistant 文本**保留在 session 内存**（`lastAssistantText`/`finalAnswer`）、已打开会话可 `result()` 取——**不承诺 answer artifact 持久化**（[R2-M5]：artifact 仅 `buildSessionResult` 调用时才写；等待中失败直接 reject，若 `openSession(initial_prompt)` 则通用 catch 随即 close、cursor 骨架的 close 会删 answer 文件）。
  4. 否则（`exitCode===0 && turnHadMeta && !turnProtocolError`）→ **成功**（`meta` 合法时**空 assistant 文本可接受**，与 cursor 接受空 `result` 一致）。
- **abort / timeout / error 同样只在 child `close` 后清 turn/proc**（同 cursor，防新轮在旧 child 退出前启动）。
- **单一幂等 `#settleTurn`**：竞争下 promise 只 resolve/reject 一次；close handler 先判 `this.proc === child`。
- **pre-begin abort 竞态（[M3]）**：MCP 请求并发派发；`send()` 在 `await spawn` 期间 `this.turn`/`this.proc` 已置而 `turnChild` 未置——此窗口内并发 `abort()` 会设 `userAborted=true` 并 kill child。规则：`userAborted` **只在 `send()` 同步占位（首个 await 前）重置一次**、`#beginTurn` **不得重置**（否则丢 abort → 被杀 child 误判 nonzero 失败）、`releaseUnbegun` 清除、`#beginTurn` 后若 `userAborted` 仍真则**显式 kill 该 begun child**——该 child 的 `close` 仍经唯一 `#settleTurn` 结算为 aborted/idle。回归：repro-kimi S18（发 send 后立刻 fire abort，确定性命中窗口，断言结算为 aborted/idle 而非 phantom-failed）。

---

## 3. 设计决定（调研收敛 + 用户已拍板 + v2 锁定，[M5]）

1. **形状 B，不走 ACP**（附录 A）。
2. **read 走软约束**（用户 2026-07-18 明确认可）：headless 无只读模式（§2.3），read/write 同一条 `-p`，read 靠每轮 prompt 前置 bridge-owned "仅只读调查、勿改文件" 策略（user-layer policy，**诚实标注 soft、非 OS 级只读**），与 cursor §6.2(b) 一致。
3. **write 直接 `-p`**（默认放行工具，含可写 Bash）；不宣称所有工具无条件开放，以 Bash 写盘验收（§2.4）。
4. **`contextUsage` v1 = `null`**（stdout 无用量）；桥永不对 kimi "按 token 关旧开新"（编排层假设，不硬编码，§5.7）。wire.jsonl 用量列后续精化。
5. **`deriveHealth`/`spawnPlan` 零改动**（§5.3）；doctor + open_session/doctor 公开描述为加法式改动（§9）。
6. **append_system_prompt_file → 锁为首轮用户前缀软注入**（§5.10；kimi headless 无原生 system flag，见 §2 help）。
7. **effort → 锁为 v1 忽略 + summary 回显 `null`**（§5.10；headless 无 per-invocation flag）。
8. **成功判定 + matcher → 按 §2.1 / §5.1 定死**，不留开放（[B2]/[M2]）。

---

## 4. 架构：形状 B（逻辑 session 常驻 + OS 进程按轮短驻）

- **逻辑 session** 在 bridge 内常驻，身份 = `chatId`（= kimi 的 `session_<uuid>`，**本地** id）。
- **OS 进程按轮短驻**：`send()` 每轮 spawn 一个 `kimi --output-format stream-json [-S <chatId>] [-m <model>] -p <prompt>`，跑完退出；轮间 `this.proc=null`。
- **与 cursor 的形状差异**：**无 create-chat**——cursor 在 `start()` 用云端 create-chat 预分配 chatId；kimi 的 id 是**首轮 `-p` 后由 kimi 本地 mint、从 meta 行捕获**。故 kimi `start()` 是本地 no-op（但**必须**先 `resolveKimiBin()` 验二进制存在，失败即抛，§5.9），首轮 `send()` 不带 `-S`，从 meta 捕 id 后后续轮带 `-S <id>`。

---

## 5. 具体实现

> 全部落在 `scripts/agent-bridge.mjs`（单文件）。行号为 2026-07-18 当前值。

### 5.1 AGENTS 注册表新增（`const AGENTS` :111，接在 cursor :139 之后）

```js
kimi: {
  label: "Kimi Code",
  env: "KIMI_BIN",
  bin: "kimi.exe",                   // 解析见 §5.9：默认标准安装绝对路径 ~/.kimi-code/bin/kimi.exe，KIMI_BIN 覆盖(须为存在的 kimi.exe)，PATH 仅搜 kimi.exe
  role: "kimi-stream-json",
  versionArgs: ["--version"],
  // bridge-spawn 的 kimi turn 命令行 = <...\kimi.exe> --output-format stream-json [-S session_<uuid>] [-m <model>] -p <prompt>
  // [M1] 纯正则不懂引号：引号内的 ` -p `/`--output-format stream-json` 会假阳性（cleanup 杀进程的安全边界，
  // 假阳性不可接受）。故先按 Windows 引号规则 tokenize，再在 TOKEN 上判定；prompt(=-p 值)永不参与匹配。
  matchesCommand: cmd => {
    const { argv0, rest } = parseWindowsArgv0(String(cmd));  // argv0 有 CommandLineToArgvW 特殊规则（见下）
    if (argv0.split(/[\\/]/).pop().toLowerCase() !== "kimi.exe") return false;  // argv0 basename 严格 = kimi.exe
    const tokens = tokenizeWindowsCommandLine(rest);          // argv0 之后的参数走通用规则（双引号分组 + 反斜杠转义）
    let pIdx = -1;
    for (let i = 0; i < tokens.length - 1; i++) { if (tokens[i] === "-p") { pIdx = i; break; } }  // 独立 -p token 且其后有 prompt token
    if (pIdx < 0) return false;                              // 无顶层 -p <prompt> → 不是我们 spawn 的 turn
    for (let i = 0; i + 1 < pIdx; i++) { if (tokens[i] === "--output-format" && tokens[i + 1] === "stream-json") return true; }  // -p 之前存在连续两 token
    return false;
  },
}
// 顶层新增两 helper（函数声明，hoist，供 matcher 用；见 scripts 实现）：
// tokenizeWindowsCommandLine(s)：通用参数 tokenize（双引号分组 + 2N/2N+1 反斜杠-引号转义）。
// parseWindowsArgv0(s)：[M1-R2] argv0 专解——① 前导空白 ⇒ argv0="" ；② 以 " 开头 ⇒ 取到下一个 "（去引号、内部空白/反斜杠字面）；③ 否则取到首个空白（内部 "、\ 一律字面，不转义）。
```

- **安全边界（[M1]）**：cleanup 的 matcher 是安全边界。**argv0 专解（`parseWindowsArgv0`）+ 其后通用 token 扫描**——无关进程即便含 `foo/kimi`、引号内的 ` -p `、未加引号的内嵌引号 argv0（`C:\Tmp\ki"mi.exe"` basename ≠ kimi.exe）、或前导空白（argv0 为空）都不命中；同时不锁死 `.kimi-code` 目录，故 `KIMI_BIN` 指向的任意安装目录仍可被 cleanup 扫到。回归：repro-kimi S17 经只读 `diag match` 断言全矩阵（含 argv0 边缘）+ 真 `cleanup` 对引号内 `-p` 活进程断言「不得终止」。

### 5.2 `KimiCodeSession` 类（以 `CursorAgentSession` :3208 为骨架）

复用 cursor 形状 B 全套（事件驱动、每轮短进程、turn 状态机、stale-close 防护），删掉 create-chat、换 OpenAI 风格 parser。

**必须实现的成员**（同 cursor 隐式契约；通用路径无条件调用的都列全）：
- `async start()`（**先 `resolveKimiBin()` 验二进制存在、缓存到 `this.resolvedBin`、失败即抛**；再置 idle、proc=null；非 Windows fail-fast。**不做** create-chat）
- `async send(msg,opts)` / `async result(opts)` / `isSettled()` / `refreshStatus()`（同步 no-op）/ `async abort()` / **`close(opts)`（同步）** / `summary()`
- `contextUsage()` → 恒 `null`
- `isReusable()` → 见下 `#canRun()`

**必须持有的字段（精确清单，[M3]，不写"同 cursor"）**：
```
id, agent, cwd, access, write, model, effort(=null 有效值),
status, isStreaming, lastAssistantText, finalAnswer,
lastError, lastStderr, lastTurnError,
events, proc, turnChild, logFile, answerFile, pidFile,
createdAt, updatedAt,
currentTurnId, lastTurnId, turnStartedAt, turnEndedAt, turn, turnCount,
userAborted,                       // 区分用户 abort vs 进程异常（settleTurn 分支）
turnHadMeta,                       // 本轮是否见合法 meta（§2.1 成功判定）
turnProtocolError,                 // [R2-M2] 本轮协议错误锁存：每轮 begin 重置、只增不减；成功=exit0&&turnHadMeta&&!turnProtocolError
chatId,                            // 本地 session_<uuid>；首轮后由 meta 填，续轮校验一致、绝不覆盖
resolvedBin,                       // [R2-B1] start() 缓存的 resolveKimiBin() 绝对路径（native kimi.exe），供 send() 复用
appendSystemPrompt, appendSystemPending,  // 首轮软注入（§5.10）；appendSystemPrompt=内部对象(含 content)，summary 不得直吐(见下)
name, returnMode                   // openSession-owned：name 供别名；returnMode 被 buildSessionResult(:953) 读
```

**`summary()` 精确 shape**（对齐 cursor）：
```js
{
  id, agent, cwd, access, write, model,
  effort: null, status,
  pid: this.proc?.pid ?? null,
  createdAt, updatedAt, lastError,
  lastStderr: this.lastStderr ?? null,
  name: this.name ?? null,
  health: deriveHealth(this),
  contextUsage: null,
  appendSystemPrompt: appendSystemPromptSummary(this, "first-turn-user-prefix"),  // [R2-M3] helper(:759) 只吐 {file,bytes,injectionMode}，绝不泄露 system 原文
  logFile,
  lastTurn: lastTurnOf(this),
  agentSpecific: { chatId: this.chatId, turnCount: this.turnCount },
}
```

**可复用谓词 `#canRun()`（[M1]：isReusable 与 send 共用同一谓词）**：
```js
#canRun() {
  // 未关 且 (已有可 resume 的 id 或 尚未 settle 过任何轮——空会话可跑首轮)。
  return this.status !== "closed" && (this.chatId != null || this.turnCount === 0);
}
isReusable() { return this.#canRun(); }         // deriveHealth 钩子调用
// send() 起手：if (!this.#canRun()) throw new Error("kimi session has no chat to resume; reopen a new session.");
```
三种态的一致行为（[M1] 明确）：
- **spawn 前失败**（spawn 同步抛）：turn 释放、**turnCount 不 bump**（照 cursor send 顺序，仅 begin 后才 bump）→ `#canRun()` 仍真 → 可重试首轮。
- **首轮 abort（meta 前）**：`#settleTurn` bump turnCount→1、chatId 仍 null → `#canRun()` 假 → **isReusable=dead 且 send 抛**（二者一致）；**v1 限制：首轮 abort 后需 reopen 新会话**（诚实标注，可接受）。
- **协议错误 / 失败轮**：turnCount bump、chatId 视情况；无有效 chatId → `#canRun()` 假 → dead + send 抛，一致。

**关键方法语义**：
- `send()` 顺序照 cursor：①`if(!#canRun())throw` → ②同步占 `this.turn`（堵并发 send）→ ③spawn 短进程 + 挂 listeners（记 `this.turnChild`）→ ④await spawn 成功 → ⑤`#beginTurn`（清本轮 finalAnswer/lastAssistantText/turnHadMeta + turn clock）→ 失败释放 turn、保留上轮结果、不 bump turnCount。
- `#buildTurnArgs`（**实测排布**）：`["--output-format", "stream-json", ...(this.chatId ? ["-S", this.chatId] : []), ...(this.model ? ["-m", this.model] : []), "-p", prompt]`。**prompt 恒在尾部**（-p 值）；无需 `--`（§2.2）。read 档 prompt = `[read 只读策略] + [首轮 append_system 软注入(若 appendSystemPending)] + 用户消息`（§5.4/§5.10）。
- `result()` → `buildSessionResult(this, this.finalAnswer || this.lastAssistantText, opts)`（:934）。
- `abort()` / `close()`：见 §7（复用 terminateProcessTree/scheduleForceKill，不变量同 cursor）。
- `lastTurnError`：成功轮清 false、失败/协议错误轮置 true、用户 abort 清 false。

### 5.3 共享代码改动：`deriveHealth`/`spawnPlan` **零改动**（[M4] 表述修正）

- `deriveHealth`（:910）**已有** `typeof session.isReusable === "function" ? session.isReusable() : (...)` 分支（cursor 引入）+ `starting/running → healthy` early-return（已核实存在）。kimi 定义自己的 `isReusable()` 即走该分支，**deriveHealth 本体零改动**；omp/codex/claude/cursor 行为字节级不变（repro-health 回归应天然过）。
- `spawnPlan`（:480）**零改动**：`resolveKimiBin()` 解析出的原生 `kimi.exe` 走现成 "native exe 直接 spawn（clean argv、不过 shell）" 路径（:483 附近对 `.cmd/.bat` 才经 cmd.exe——§5.9 保证 kimi 永不落到那条）。
- **诚实说明**：doctor（§5.9）与 open_session/doctor 的公开描述文案（§9）**需要加法式改动**——这些是公共契约面，"零改动"仅指 `deriveHealth`/`spawnPlan` 两个核心共享函数。

### 5.4 access 映射（read/write 都同一条 `-p`）

| 档 | kimi flags | 边界性质 |
|---|---|---|
| write | `--output-format stream-json [-S..] [-m..] -p <prompt>`（`-p` 默认放行工具） | 软（Win 无 OS 沙箱），= omp/claude/cursor write@Win |
| read | 同上 + **每轮 prompt 前置 read 策略** | 软 read |

- read 策略（bridge-owned prompt 前缀，同 cursor §5.4(b)）：`"仅只读调查：不要新建/修改/移动/删除任何文件，不要跑写盘的 shell 命令；可读文件、搜索、跑只读命令。只报告发现。"`
- write 档诚实口径（[M5]）：`-p` 默认自动执行工具（含可写 Bash），**但这是 CLI 默认 auto、非 full YOLO**，是否另受用户 config/static deny 约束不改变"写档可写盘"这一验收基线；**不宣称所有工具无条件开放**。
- **不得**宣称 read "真只读"。文案：`kimi read = 软约束（prompt 策略），shell 仍可写；非 OS 级只读`。

### 5.5 prompt 传参：native 直起，`-p` 吃值，无 `--`（fail-closed）

- native 直起无注入（spawnPlan :480 native 路径：clean argv、不过 shell）→ `& % ^ | < >` 无 cmd 语义。**实测** dash-leading / metachar prompt 均安全（§2.2）——**此安全性以"确实走 native `kimi.exe`"为前提**。
- **fail-closed（[B1]）**：携带用户 prompt 的 send **只接受 §5.9 解析出的原生 `kimi.exe`**；`resolveKimiBin()` 绝不返回 `.cmd/.bat` shim（否则 spawnPlan 会经 cmd.exe，metachar 安全边界失效）。解析不到原生 kimi.exe → 明确失败，不回退、不静默。
- **无需 `--` 分隔符**（cursor 需要，因其 prompt 是位置参数；kimi prompt 是 `-p` 的值）。
- **长度上限**：同 cursor，Windows 限完整 command line 的 **UTF-16 code units**（含路径/flags/quoting 膨胀）→ 复用 cursor 的 `#assertCmdlineWithinLimit` 同款守卫；**拒绝含 NUL 的 prompt**。
- **prompt 隐私**：启动日志 `<prompt:redacted>`；pid record 的 `command` **剥掉尾部 `-p <prompt>`**；parser 不回显 user prompt。

### 5.6 stream-json parser
按 §2.1 表 + 状态机实现 `#handleLine`：JSON.parse 每行 → switch on `msg.role`：`assistant`（content 累积文本 / tool_calls 压 event）、`tool`（压 event）、`meta`（校验 + 捕/验 `chatId`、置 `turnHadMeta`）。非文本高频行不逐条落日志。终答 = 累积 assistant content。

### 5.7 contextUsage = null（+ 未来 wire.jsonl 精化）
- `contextUsage()` 恒 `null`。桥内透传无非-null 假设（buildSessionResult:967 纯透传）→ 安全。
- **不硬编码**"依赖 kimi 自压缩"；**不伪造** `{tokens:0}`。
- consumer/skill 侧同 cursor：`null≠0`；roundtable/loop 排序须视 `null`=unknown、跳过数值比较；"不按 token 重开"≠"永不重开"。
- **后续精化（非 v1，附录 B）**：读本地 wire.jsonl `usage.record` 累加得 current-context tokens（config `max_context_size=262144`）→ 可给真 contextUsage，优于 cursor。

### 5.8 abort / close
见 §7（Windows 整树 kill + 不变量，复用现有 helper）。

### 5.9 bin 解析 / doctor / pid record
- **`resolveKimiBin()`（native-only，[B1]）** 顺序，**只返回存在的原生 `kimi.exe` 文件**（每条路径都 `statSync(p).isFile()` 校验，[R2-M4]：目录名恰为 `kimi.exe` 不算数）：
  1. `KIMI_BIN` 若设：basename 严格 `kimi.exe` 且 `statSync().isFile()`；否则报错（不接受 `.cmd/.bat`/目录/裸名）。
  2. 标准安装绝对路径 `%USERPROFILE%\.kimi-code\bin\kimi.exe`，`isFile` 即用（**不依赖 PATH**——native 安装器只改 User PATH、新终端才生效，bridge 的 MCP server 进程可能持旧 PATH，调研时 codex 子进程即因 `kimi` 不在其 PATH 而 command-not-found）。
  3. PATH 兜底：**仅搜 `kimi.exe`**（PATHEXT 限定 `.exe`），绝不接受 shim。
  - **返回值必须绝对（[M2]）**：三类候选一律先 `path.resolve()`（对 MCP-server cwd 绝对化）再 `statSync().isFile()` 校验、返回绝对路径。否则相对 `KIMI_BIN` 或 `.` PATH 项会在 server cwd 校验通过、却在 `send()` 的 `spawn({cwd: session.cwd})` 下解释成另一路径（验 A 起 B / ENOENT）。绝对化后 `resolvedBin` 与会话 cwd 无关、稳定。
  - 全部落空 → 抛"未找到原生 kimi.exe"。
- **绝不在 AGENTS 注册表初始化时跑 resolver（[R2-B1]）**：否则 kimi 未安装会在**模块加载阶段**直接抛、doctor 无从报 missing。`AGENTS.kimi.bin` 保持名义值 `"kimi.exe"`（仅供展示/日志）；解析一律 **lazy**：
  - `doctor`：**kimi-aware 分支（照 cursor 的 doctor 分支，非通用分支）**——内部 `try { resolveKimiBin() } catch { → 报 unavailable }`；成功则跑 `<abs kimi.exe> --version`（返 `0.27.0`；kimi 自有二进制，**无** cursor 的 node.exe 冒充陷阱）。**不能走通用分支**（通用分支只搜旧 PATH、绕过标准安装路径解析，正是调研时 codex 撞的坑）。
  - `start()`：`resolveKimiBin()` 成功 → 缓存到 `this.resolvedBin` 供 `send()` 复用；失败即抛（**不把无二进制的 fresh idle 报 healthy**）。`send()` 每轮用 `this.resolvedBin`；若升级/移动致失效，重解析一次（类比 cursor ENOENT 重解析）。
- doctor 工具描述（:380 "OMP, Codex, Claude, Cursor, and Node"）+ open_session 后端概述（:186）+ cleanup CLI 文案同步加 kimi（§9）。
- **无 create-chat 生命周期**（cursor §5.9 那整块 kimi 不需要）。
- pid record turn 级；`command` 不含 prompt（§5.5）。

### 5.10 openSession 门控（:3827）
- `agent` enum 由 `Object.keys(AGENTS)` 自动含 kimi。
- **非 Windows**：v1 open 时 fail-fast。
- `schema`：**拒**（spawn 前；同 cursor/omp/claude，schema=Codex-only 口径）。
- `append_system_prompt_file`：**锁为首轮用户前缀软注入**（[M5]；kimi headless 无原生 system flag）——同 cursor v4.1：`#composePrompt` 组 [会话指令(首轮)]→[read 策略]→[消息]，`appendSystemPending` 仅 turn begin 后清、失败重注；summary `injectionMode:"first-turn-user-prefix"`。遵从看模型，非真 system；与消息共享 argv 上限。openSession 的 system 文件读取/name/returnMode 赋值是通用实现，无需 kimi 分支。
- `effort`：**锁为 v1 忽略**（不报错；summary 回显 `null`，不伪装生效）。
- `model`：`-m <alias>`；sanitizeAgentArg 现允许 `._:/@+-`，故 `kimi-code/k3` 合法。

---

## 6. 发布门槛验证（非架构开放项——实现后必测，[M5]）

> §3 已把 append-system / effort / write 语义 / 成功判定 / matcher 锁为 v1 决定。以下仅为**实现后、发布前**须真跑验证的行为门槛，不是"可能改变架构"的开放决定：

1. **多轮 resume（≥3 轮）稳定性**：`-S <id>` 连续多轮记忆延续、id 不漂。
2. **真 abort 行为**：长跑轮整树 kill → 0 残留进程 + 本地文件态一致 + 同 id resume 无幽灵完成结果（本地 session 风险应低于 cursor 云端，但须回归覆盖）。
3. **`-p` 默认权限确切范围**：确认写档 Bash 写盘成立（不宣称全工具开放）。
4. **argv 上限守卫**：超长 prompt 被 `#assertCmdlineWithinLimit` 明确拒（不静默截断/不 fallback 文件式）。
- **无硬 blocker。**

---

## 7. abort / close 的 Windows 正确实现

复用现有 helper（不新造）：`terminateProcessTree`(:1229)、`scheduleForceKill`(:1253)。不变量同 cursor §7：
- abort **不先** `this.proc=null`（force-kill verify 依赖它）；`proc=null` + 删 pid record 由该 child 的 close handler 做。
- close handler 先判 `this.proc === child`（防旧进程迟到事件清新轮）。
- 当前 turn promise 必须结算（否则 `wait()` 永挂）；abort 清 `lastTurnError`、stamp `turnEndedAt`、置 `userAborted`。
- `close({removePidRecord:false})` 遵守（进程级 shutdown 保留顽固子进程记录给下次 cleanup）。
- **本地一致性**：kimi session 是本地文件态，无 cursor 的"云端 chat 幽灵完成"发布门槛（对 kimi 风险更低）；仍在验收保留 abort→resume 回归防行为漂移（§6.2）。

---

## 8. 验收

- **hermetic fake-kimi 套件**（照 fake-cursor/fake-claude 思路，`docs/repro-mcp-hang/fake-kimi.js` + `repro-kimi.mjs`）：spawn 失败（含 resolveKimiBin 找不到二进制）；多行 assistant 累积；meta 后延迟 exit；**exit0 无 meta → 判失败（§2.1）**；续轮 meta id 不一致 → 判失败且不覆盖 chatId；exit 非零；abort（首轮 meta 前 → 需 reopen）；timeout abort；close 迟到；并发 send 被堵；stale close 不影响新 child；health（fresh idle 无 chatId→healthy、idle+chatId→healthy、failed+lastTurnError→degraded、closed→dead、首轮 abort 后 turnCount=1/chatId=null→dead 且 send 抛）；contextUsage=null 四处；cleanup matcher（argv0 非 kimi.exe 不命中、prompt 含 ` -p `/`--output-format stream-json` 不误伤、真 turn 命中）。
- **repro-health 回归**：四旧后端 deriveHealth 行为字节级不变（kimi 零共享改动，应天然过）。
- **真 doctor**：`kimi: ok … 0.27.0`（且 resolveKimiBin 不依赖 PATH）。
- **真 e2e（Windows）**：open(read)→"用 shell 读某文件返随机 nonce"→验 stream-json 有 tool_calls(Bash) + 拿到 nonce + **观察 read 策略被遵从且本次未写盘**（[Min2]：证明遵从，不等于证明不可写，文案保留 soft/非安全边界）；open(write)→"建 inside.txt"→验落盘（写档基线）；含 `& % "` 与多行的 prompt 一条（验 §5.5 不损坏）；两轮 resume（-S 记忆延续）；abort（长跑中断 + 无残留，`agent-bridge cleanup` 复核）。
- **门控/summary 测**：schema 被拒；effort 忽略可观察且诚实；append_system 软注入首轮生效、turn2 不注、summary `injectionMode` 诚实；resolveKimiBin 三路（KIMI_BIN 存在 kimi.exe / 默认路径 / PATH 仅 .exe；shim 被拒）。
- **双评**：Codex（设计已 R1→R2 复审）+ 实现后另一独立引擎复核 diff。
- **dogfood**：用 `kimi` 真委托一个小任务跑通。

---

## 9. 触及文件 / 区域（[M4] 补齐公共契约文案）

- `scripts/agent-bridge.mjs`：
  - `AGENTS`(:111 加 kimi 注册项 + matchesCommand)
  - 新 `KimiCodeSession`(接 CursorAgentSession :3208 后) + late-bind(:3757 附近加 `AGENTS.kimi.Session=`)
  - `resolveKimiBin()`（native-only，lazy；[R2-B1] 绝不在注册表初始化跑）
  - openSession 门控(:3827：非 Windows fail-fast、schema 拒、append_system/effort 处理——多数走通用路径)
  - doctor(:4197：**kimi-aware lazy-resolve 分支**（照 cursor），try/catch→unavailable；非通用分支)
  - **公开描述文案**：open_session 工具描述(:186 后端概述 + access 软边界 + effort + append-system + schema)、doctor 工具描述(:380 "OMP, Codex, Claude, Cursor, and Node"→加 Kimi)、cleanup CLI 文案
  - **不动**：`deriveHealth`(:910)、`spawnPlan`(:480)
- `skills/agent-bridge/SKILL.md`：Agent 与模型段加 kimi（形状 B、本地、read/write 都软、read 非真只读、contextUsage 恒 null、无 create-chat、v1 Windows-only、模型别名 `kimi-code/*`、隐私口径=推理仍走云端）。
- `README.md` / `INSTALLATION*` / `DEVELOPMENT*`：四后端→五后端。
- roundtable / dev / loop 三 skill：backend 列表、read 边界、contextUsage null 排序规则（同 cursor consumer 风险）。
- 本设计文档（真理源）。

---

## 附录 A：为什么形状 B 而非 `kimi acp`

kimi 有 `kimi acp`（Agent Client Protocol over stdio = 持久进程形状 A，类比 codex app-server / omp rpc）。**不选**，因为：agent-bridge 现在**完全不说 ACP**，走这条要新写整个 ACP 客户端层（握手/session/权限/流式协议），工作量远大、风险高；而持久进程对 kimi 无必要收益（形状 B 每轮短进程已满足委托语义）。形状 B 可直接复用现成 `CursorAgentSession` 抽象。ACP 留作以后若要"持久进程 + 标准协议"再评。

## 附录 B：为什么不照抄 claude 后端 / 不并入本次的项

- **不照抄 claude**：claude 长驻 = `--input-format stream-json` + stdin 多轮 + 每轮一 result；kimi `-p` 一次性、无多轮 stdin → 必须形状 B（每轮短进程 + `-S`）。
- **不并入本次**：① POSIX 平台支持（kimi 有 linux/mac 原生构建，低成本后续）；② contextUsage 读 wire.jsonl 精化（§5.7）；③ `kimi acp` 形状 A（附录 A）；④ 文件式 prompt（超 argv 上限直接明确报错，不 fallback）；⑤ 首轮 abort 后的 fresh-restart（v1 需 reopen，§5.2）。

---

## 工作量粗估（两方收敛）

约 cursor 的 **60–75%**，核心 `KimiCodeSession` ~350–450 行 + fake-kimi 回归。省掉：create-chat 生命周期、versioned launcher 解析、deriveHealth 共享改动、云端一致性发布门槛。新增：OpenAI 风格 parser、`#canRun()` 首轮边界、resolveKimiBin(native-only)、meta 身份状态机。
